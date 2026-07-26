import { Request, Router } from 'express';
import { Lifecycle, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';

/**
 * Rule I4 — product variants (150% BOM).
 *
 * A part carries OptionGroups (e.g. "COLOR") with OptionValues; individual BOM
 * lines of that part's revisions are conditioned on option values. Resolving a
 * variant walks ONLY the given revision's own lines (single level: the 150% BOM
 * of this revision becomes the variant BOM of this revision) and keeps a line
 * when it has no conditions at all, or when at least one of its condition
 * values was selected.
 */

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

interface RevisionRefDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

interface OptionValueDetailDto {
  id: number;
  code: string;
  name: string;
  isDefault: boolean;
  /** BOM lines conditioned on this value. */
  lineCount: number;
}

interface OptionGroupDetailDto {
  id: number;
  code: string;
  name: string;
  description: string | null;
  required: boolean;
  multiSelect: boolean;
  values: OptionValueDetailDto[];
}

interface VariantBomLineDto {
  lineId: number;
  findNumber: number;
  part: PartRefDto;
  revision: RevisionRefDto | null;
  quantity: number;
  uom: string;
  /** Option value codes this line is conditioned on; empty = always included. */
  conditions: string[];
}

interface VariantResolutionDto {
  part: PartRefDto;
  revision: RevisionRefDto;
  selections: { groupCode: string; valueCodes: string[] }[];
  included: VariantBomLineDto[];
  excluded: VariantBomLineDto[];
  unconditionalCount: number;
}

// ---------------------------------------------------------------------------
// Query shapes + mappers
// ---------------------------------------------------------------------------

const groupInclude = {
  values: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: { _count: { select: { bomLines: true } } },
  },
} satisfies Prisma.OptionGroupInclude;

type GroupWithValues = Prisma.OptionGroupGetPayload<{ include: typeof groupInclude }>;

function toPartRef(part: {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}): PartRefDto {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toRevisionRef(rev: { id: number; revision: string; lifecycle: Lifecycle }): RevisionRefDto {
  return { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle };
}

function toOptionGroupDetail(group: GroupWithValues): OptionGroupDetailDto {
  return {
    id: group.id,
    code: group.code,
    name: group.name,
    description: group.description,
    required: group.required,
    multiSelect: group.multiSelect,
    values: group.values.map((value) => ({
      id: value.id,
      code: value.code,
      name: value.name,
      isDefault: value.isDefault,
      lineCount: value._count.bomLines,
    })),
  };
}

async function fetchGroups(partId: number): Promise<GroupWithValues[]> {
  return prisma.optionGroup.findMany({
    where: { partId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: groupInclude,
  });
}

async function getGroupDetailOrThrow(groupId: number): Promise<GroupWithValues> {
  const group = await prisma.optionGroup.findUnique({
    where: { id: groupId },
    include: groupInclude,
  });
  if (!group) throw new HttpError(404, 'Option group not found');
  return group;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Z0-9_-]{1,20}$/i;
const MAX_NAME = 100;

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function requiredName(body: Record<string, unknown>, field: string): string {
  const name = requiredString(body, field);
  if (name.length > MAX_NAME) {
    throw new HttpError(400, `${field} must be at most ${MAX_NAME} characters`);
  }
  return name;
}

/** Returns undefined when absent; null allowed; 400 on any other non-string. */
function optionalNullableString(
  body: Record<string, unknown>,
  field: string
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  return value;
}

/** Normalize an optional/nullable description-style value: blank → null. */
function normalizeNullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

/** Option group / value codes: 1..20 chars of letters, digits, "_" or "-". */
function parseCode(body: Record<string, unknown>): string {
  const code = requiredString(body, 'code');
  if (!CODE_RE.test(code)) {
    throw new HttpError(400, 'code must be 1 to 20 characters of letters, digits, "_" or "-"');
  }
  return code;
}

/** Rule 1 — edit gate: option conditions only change while the owner is IN_WORK. */
function assertEditable(rev: { revision: string; lifecycle: Lifecycle }): void {
  if (rev.lifecycle !== Lifecycle.IN_WORK) {
    throw new HttpError(409, `Revision ${rev.revision} is ${rev.lifecycle} and cannot be modified`);
  }
}

// ---------------------------------------------------------------------------
// GET /parts/:id/option-groups
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id/option-groups',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');

    const groups = await fetchGroups(partId);
    res.json(groups.map(toOptionGroupDetail));
  })
);

// ---------------------------------------------------------------------------
// POST /parts/:id/option-groups
// ---------------------------------------------------------------------------

router.post(
  '/parts/:id/option-groups',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');

    const body = requireBody(req);
    const code = parseCode(body);
    const name = requiredName(body, 'name');
    const description = normalizeNullable(optionalNullableString(body, 'description'));
    const required = optionalBoolean(body, 'required');
    const multiSelect = optionalBoolean(body, 'multiSelect');

    const duplicate = await prisma.optionGroup.findFirst({
      where: { partId, code },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, `Option group ${code} already exists on this part`);

    const agg = await prisma.optionGroup.aggregate({
      where: { partId },
      _max: { sortOrder: true },
    });

    const created = await prisma.optionGroup.create({
      data: {
        partId,
        code,
        name,
        description,
        ...(required !== undefined ? { required } : {}),
        ...(multiSelect !== undefined ? { multiSelect } : {}),
        sortOrder: (agg._max.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });

    res.status(201).json(toOptionGroupDetail(await getGroupDetailOrThrow(created.id)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /option-groups/:id — cascades values and their line conditions
// ---------------------------------------------------------------------------

router.delete(
  '/option-groups/:id',
  asyncHandler(async (req, res) => {
    const groupId = idParam(req.params.id);
    const group = await prisma.optionGroup.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw new HttpError(404, 'Option group not found');

    await prisma.optionGroup.delete({ where: { id: group.id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /option-groups/:id/values — returns the parent group, refreshed
// ---------------------------------------------------------------------------

router.post(
  '/option-groups/:id/values',
  asyncHandler(async (req, res) => {
    const groupId = idParam(req.params.id);
    const group = await prisma.optionGroup.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw new HttpError(404, 'Option group not found');

    const body = requireBody(req);
    const code = parseCode(body);
    const name = requiredName(body, 'name');
    const isDefault = optionalBoolean(body, 'isDefault');

    const duplicate = await prisma.optionValue.findFirst({
      where: { groupId: group.id, code },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, `Option value ${code} already exists in this group`);

    const agg = await prisma.optionValue.aggregate({
      where: { groupId: group.id },
      _max: { sortOrder: true },
    });

    await prisma.optionValue.create({
      data: {
        groupId: group.id,
        code,
        name,
        ...(isDefault !== undefined ? { isDefault } : {}),
        sortOrder: (agg._max.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    });

    res.json(toOptionGroupDetail(await getGroupDetailOrThrow(group.id)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /option-values/:id
// ---------------------------------------------------------------------------

router.delete(
  '/option-values/:id',
  asyncHandler(async (req, res) => {
    const valueId = idParam(req.params.id);
    const value = await prisma.optionValue.findUnique({
      where: { id: valueId },
      select: { id: true },
    });
    if (!value) throw new HttpError(404, 'Option value not found');

    await prisma.optionValue.delete({ where: { id: value.id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// PUT /bom-lines/:id/options — replace a line's option conditions
// ---------------------------------------------------------------------------

router.put(
  '/bom-lines/:id/options',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        parentRevision: { select: { partId: true, revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    assertEditable(line.parentRevision);

    const body = requireBody(req);
    const rawIds: unknown = body.optionValueIds;
    if (!Array.isArray(rawIds)) {
      throw new HttpError(400, 'optionValueIds must be an array of option value ids');
    }
    const optionValueIds = [
      ...new Set(rawIds.map((value: unknown) => requirePositiveInt(value, 'optionValueId'))),
    ].sort((a, b) => a - b);

    if (optionValueIds.length > 0) {
      // Conditions may only reference option groups of the revision's OWN part.
      const values = await prisma.optionValue.findMany({
        where: { id: { in: optionValueIds } },
        select: { id: true, group: { select: { partId: true } } },
      });
      const allowed = new Set(
        values
          .filter((value) => value.group.partId === line.parentRevision.partId)
          .map((value) => value.id)
      );
      const offenders = optionValueIds.filter((id) => !allowed.has(id));
      if (offenders.length > 0) {
        throw new HttpError(
          409,
          `Option values must belong to an option group of this part: ${offenders.join(', ')}`
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.bomLineOption.deleteMany({ where: { bomLineId: line.id } });
      if (optionValueIds.length > 0) {
        await tx.bomLineOption.createMany({
          data: optionValueIds.map((optionValueId) => ({ bomLineId: line.id, optionValueId })),
        });
      }
    });

    res.json({ optionValueIds });
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/resolve-variant — single-level 150% BOM resolution
// ---------------------------------------------------------------------------

router.post(
  '/revisions/:id/resolve-variant',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      include: { part: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const body = requireBody(req);
    const rawSelections: unknown = body.selections;
    if (!Array.isArray(rawSelections)) {
      throw new HttpError(400, 'selections must be an array');
    }

    const groups = await fetchGroups(revision.partId);
    const groupByCode = new Map(groups.map((group) => [group.code, group]));

    // Validate the submitted selections against this part's option model.
    const selectedByGroup = new Map<number, Set<number>>();
    for (const entry of rawSelections as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new HttpError(400, 'Each selection must be an object with groupCode and valueCodes');
      }
      const { groupCode, valueCodes } = entry as { groupCode?: unknown; valueCodes?: unknown };
      if (typeof groupCode !== 'string' || groupCode.trim() === '') {
        throw new HttpError(400, 'groupCode is required and must be a non-empty string');
      }
      const group = groupByCode.get(groupCode.trim());
      if (!group) throw new HttpError(400, `Unknown option group ${groupCode}`);
      if (valueCodes !== undefined && valueCodes !== null && !Array.isArray(valueCodes)) {
        throw new HttpError(400, 'valueCodes must be an array of option value codes');
      }

      const chosen = selectedByGroup.get(group.id) ?? new Set<number>();
      for (const rawCode of Array.isArray(valueCodes) ? valueCodes : []) {
        if (typeof rawCode !== 'string') {
          throw new HttpError(400, 'valueCodes must be an array of option value codes');
        }
        const value = group.values.find((candidate) => candidate.code === rawCode.trim());
        if (!value) {
          throw new HttpError(400, `Unknown option value ${rawCode} for ${group.name}`);
        }
        chosen.add(value.id);
      }
      selectedByGroup.set(group.id, chosen);
    }

    for (const group of groups) {
      const count = selectedByGroup.get(group.id)?.size ?? 0;
      if (group.required && count === 0) {
        throw new HttpError(400, `Select an option for ${group.name}`);
      }
      if (!group.multiSelect && count > 1) {
        throw new HttpError(400, `${group.name} accepts a single option`);
      }
    }

    const selectedValueIds = new Set<number>();
    for (const chosen of selectedByGroup.values()) {
      for (const valueId of chosen) selectedValueIds.add(valueId);
    }

    // Echo the normalized selections in option-model order.
    const selections = groups
      .filter((group) => (selectedByGroup.get(group.id)?.size ?? 0) > 0)
      .map((group) => {
        const chosen = selectedByGroup.get(group.id)!;
        return {
          groupCode: group.code,
          valueCodes: group.values
            .filter((value) => chosen.has(value.id))
            .map((value) => value.code),
        };
      });

    // Single level only: this revision's own lines become the variant BOM.
    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: revision.id },
      orderBy: { findNumber: 'asc' },
      include: {
        childPart: {
          include: { revisions: { select: { id: true, revision: true, lifecycle: true } } },
        },
        optionConditions: {
          orderBy: { optionValueId: 'asc' },
          include: { optionValue: { select: { code: true } } },
        },
      },
    });

    const included: VariantBomLineDto[] = [];
    const excluded: VariantBomLineDto[] = [];
    let unconditionalCount = 0;

    for (const line of lines) {
      const resolved = resolveDisplayRevision(line.childPart.revisions);
      const dto: VariantBomLineDto = {
        lineId: line.id,
        findNumber: line.findNumber,
        part: toPartRef(line.childPart),
        revision: resolved ? toRevisionRef(resolved) : null,
        quantity: line.quantity,
        uom: line.uom,
        conditions: line.optionConditions.map((condition) => condition.optionValue.code),
      };

      if (line.optionConditions.length === 0) {
        unconditionalCount += 1;
        included.push(dto);
      } else if (
        line.optionConditions.some((condition) => selectedValueIds.has(condition.optionValueId))
      ) {
        included.push(dto);
      } else {
        excluded.push(dto);
      }
    }

    const result: VariantResolutionDto = {
      part: toPartRef(revision.part),
      revision: toRevisionRef(revision),
      selections,
      included,
      excluded,
      unconditionalCount,
    };
    res.json(result);
  })
);

export default router;
