import { Request, Router } from 'express';
import {
  AttributeType,
  EcnStatus,
  Lifecycle,
  PartCategory,
  Prisma,
  SignedEntityType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import {
  aclFilter,
  assertCanRead,
  assertCanWrite,
  visibleIds,
  REDACTED,
  type AclUser,
} from '../lib/acl';
import { escapeLike, generatePartNumber, nextRevisionLabel, withNumberLock } from '../lib/plm';
import { assertSignaturesComplete } from './signatures';
import { emitEvent } from '../lib/webhooks';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface RevisionRefDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

interface PartSummaryDto extends PartRefDto {
  description: string | null;
  createdAt: string;
  createdBy: UserRefDto;
  latestRevision: RevisionRefDto | null;
  revisionCount: number;
}

interface RevisionSummaryDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
  changeNote: string | null;
  createdAt: string;
  releasedAt: string | null;
  createdBy: UserRefDto;
}

interface AttributeDefDto {
  id: number;
  category: PartCategory;
  name: string;
  label: string;
  type: AttributeType;
  /** Choices for LIST attributes; empty otherwise. */
  options: string[];
  required: boolean;
  sortOrder: number;
}

interface PartAttributeDto {
  def: AttributeDefDto;
  value: string | null;
}

interface PartDetailDto extends PartSummaryDto {
  revisions: RevisionSummaryDto[];
  unitCost: number | null;
  attributes: PartAttributeDto[];
}

interface RevisionDetailDto {
  id: number;
  partId: number;
  revision: string;
  lifecycle: Lifecycle;
  changeNote: string | null;
  createdAt: string;
  releasedAt: string | null;
  createdBy: UserRefDto;
  part: PartRefDto;
  bomLineCount: number;
  hasProcessPlan: boolean;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
}

interface PagedDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Access control helpers (rule X3)
// ---------------------------------------------------------------------------

/**
 * The ACL principal for this request. Separate from `currentUserId` because access control
 * needs the role as well, and the acl module deliberately accepts nothing wider than the two
 * fields it uses.
 */
function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/**
 * `aclFilter` is typed as `object` so one fragment serves all five protected models; these
 * wrappers name the model at the single point that knows which one is being filtered, so a
 * fragment can never be dropped into the wrong `where` unnoticed.
 */
function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

function ecnAcl(user: AclUser): Prisma.EcnWhereInput {
  return aclFilter('ECN', user) as Prisma.EcnWhereInput;
}

/**
 * A PartRevision carries no grants of its own — it inherits its part's — so every revision
 * route resolves the revision *through* the part's read filter.
 *
 * Why not load the revision and then `assertCanRead('PART', partId)`: that answers
 * 'Part not found' for a revision whose part is restricted, while a genuinely missing revision
 * id answers 'Revision not found'. The difference between the two messages is an existence
 * oracle for revision ids, so both cases must fail identically.
 */
async function readableRevisionOrThrow(
  revisionId: number,
  user: AclUser
): Promise<{ id: number; partId: number }> {
  const revision = await prisma.partRevision.findFirst({
    where: { id: revisionId, part: partAcl(user) },
    select: { id: true, partId: true },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');
  return revision;
}

/**
 * Read gate first, then the write gate on the owning part: a 403 is only ever shown to someone
 * who has already been told the revision exists.
 */
async function writableRevisionOrThrow(
  revisionId: number,
  user: AclUser
): Promise<{ id: number; partId: number }> {
  const revision = await readableRevisionOrThrow(revisionId, user);
  await assertCanWrite('PART', revision.partId, user);
  return revision;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

async function fetchPartDetail(id: number) {
  return prisma.part.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true } },
      revisions: {
        orderBy: { id: 'desc' },
        include: { createdBy: { select: { id: true, name: true } } },
      },
      attributeValues: { select: { attributeDefId: true, value: true } },
    },
  });
}

async function getPartDetailOrThrow(id: number) {
  const part = await fetchPartDetail(id);
  if (!part) throw new HttpError(404, 'Part not found');
  return part;
}

async function fetchRevisionDetail(id: number, user: AclUser) {
  return prisma.partRevision.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true } },
      part: true,
      // Counts every line on this revision's BOM, including lines whose child part is
      // restricted. That is deliberate: the BOM itself returns those lines as redacted nodes
      // (rule X4), so a filtered count here would contradict the list it labels.
      _count: { select: { bomLines: true } },
      processPlan: { select: { id: true } },
      ecnItemsTo: {
        // The ECN link is a nested read of a protected type, and an `include` carries no
        // filter of its own — without this a restricted ECN is named on every revision it
        // touches. Filtered rather than redacted because the field is a single reference with
        // no quantity to keep honest: the caller gets their newest visible link, or null.
        where: { ecn: ecnAcl(user) },
        orderBy: { id: 'desc' as const },
        select: { ecn: { select: { id: true, ecnNumber: true, status: true } } },
      },
    },
  });
}

async function getRevisionDetailOrThrow(id: number, user: AclUser) {
  const revision = await fetchRevisionDetail(id, user);
  if (!revision) throw new HttpError(404, 'Revision not found');
  return revision;
}

type PartSummaryRow = {
  id: number;
  partNumber: string;
  name: string;
  description: string | null;
  category: PartCategory;
  uom: string;
  createdAt: Date;
  createdBy: { id: number; name: string };
  /** Must be ordered newest first (highest id first). */
  revisions: { id: number; revision: string; lifecycle: Lifecycle }[];
};

function toPartSummary(part: PartSummaryRow): PartSummaryDto {
  const latest = part.revisions.length > 0 ? part.revisions[0] : null;
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
    description: part.description,
    createdAt: part.createdAt.toISOString(),
    createdBy: { id: part.createdBy.id, name: part.createdBy.name },
    latestRevision: latest
      ? { id: latest.id, revision: latest.revision, lifecycle: latest.lifecycle }
      : null,
    revisionCount: part.revisions.length,
  };
}

type PartDetailRow = NonNullable<Awaited<ReturnType<typeof fetchPartDetail>>>;

/** Parse the stored options JSON into a string[] — only meaningful for LIST defs. */
function parseAttributeOptions(def: { type: AttributeType; options: string | null }): string[] {
  if (def.type !== AttributeType.LIST || !def.options) return [];
  try {
    const parsed: unknown = JSON.parse(def.options);
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

async function toPartDetail(part: PartDetailRow): Promise<PartDetailDto> {
  const defs = await prisma.attributeDef.findMany({
    where: { category: part.category },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
  });
  const valueByDefId = new Map(part.attributeValues.map((v) => [v.attributeDefId, v.value]));
  return {
    ...toPartSummary(part),
    revisions: part.revisions.map((rev) => ({
      id: rev.id,
      revision: rev.revision,
      lifecycle: rev.lifecycle,
      changeNote: rev.changeNote,
      createdAt: rev.createdAt.toISOString(),
      releasedAt: rev.releasedAt ? rev.releasedAt.toISOString() : null,
      createdBy: { id: rev.createdBy.id, name: rev.createdBy.name },
    })),
    unitCost: part.unitCost,
    attributes: defs.map((def) => ({
      def: {
        id: def.id,
        category: def.category,
        name: def.name,
        label: def.label,
        type: def.type,
        options: parseAttributeOptions(def),
        required: def.required,
        sortOrder: def.sortOrder,
      },
      value: valueByDefId.get(def.id) ?? null,
    })),
  };
}

type RevisionDetailRow = NonNullable<Awaited<ReturnType<typeof fetchRevisionDetail>>>;

function toRevisionDetail(rev: RevisionDetailRow): RevisionDetailDto {
  return {
    id: rev.id,
    partId: rev.partId,
    revision: rev.revision,
    lifecycle: rev.lifecycle,
    changeNote: rev.changeNote,
    createdAt: rev.createdAt.toISOString(),
    releasedAt: rev.releasedAt ? rev.releasedAt.toISOString() : null,
    createdBy: { id: rev.createdBy.id, name: rev.createdBy.name },
    part: {
      id: rev.part.id,
      partNumber: rev.part.partNumber,
      name: rev.part.name,
      category: rev.part.category,
      uom: rev.part.uom,
    },
    bomLineCount: rev._count.bomLines,
    hasProcessPlan: rev.processPlan !== null,
    ecn: (() => {
      // A revision can appear on several ECNs over time (e.g. after a cancel);
      // an active ECN wins, otherwise the newest link.
      const links = rev.ecnItemsTo.map((item) => item.ecn);
      const active = links.find(
        (ecn) =>
          ecn.status === EcnStatus.DRAFT ||
          ecn.status === EcnStatus.IN_REVIEW ||
          ecn.status === EcnStatus.APPROVED
      );
      const chosen = active ?? links[0] ?? null;
      return chosen
        ? { id: chosen.id, ecnNumber: chosen.ecnNumber, status: chosen.status }
        : null;
    })(),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

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

/** Returns undefined when absent; 400 when present but not a string. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value;
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

function parseCategory(value: unknown): PartCategory {
  if (typeof value !== 'string' || !(Object.values(PartCategory) as string[]).includes(value)) {
    throw new HttpError(400, 'Invalid category');
  }
  return value as PartCategory;
}

/** Normalize an optional/nullable description-style value: blank → null. */
function normalizeNullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePositiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${label}`);
  return n;
}

/** Returns undefined when absent; null allowed; otherwise a finite number >= 0 (400). */
function parseOptionalUnitCost(body: Record<string, unknown>): number | null | undefined {
  if (!('unitCost' in body)) return undefined;
  const value = body.unitCost;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, 'unitCost must be a non-negative number or null');
  }
  return value;
}

const PART_NUMBER_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// GET /parts — list with filters + pagination (rule 10)
// ---------------------------------------------------------------------------

router.get(
  '/parts',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const page = parsePositiveInt(req.query.page, 'page', 1);
    let pageSize = parsePositiveInt(req.query.pageSize, 'pageSize', 20);
    if (pageSize > 100) pageSize = 100;

    const where: Prisma.PartWhereInput = {};

    const searchRaw = req.query.search;
    if (typeof searchRaw === 'string' && searchRaw.trim() !== '') {
      const q = escapeLike(searchRaw.trim());
      where.OR = [
        { partNumber: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ];
    }

    const categoryRaw = req.query.category;
    if (categoryRaw !== undefined && categoryRaw !== '') {
      where.category = parseCategory(categoryRaw);
    }

    let lifecycleFilter: Lifecycle | undefined;
    const lifecycleRaw = req.query.lifecycle;
    if (lifecycleRaw !== undefined && lifecycleRaw !== '') {
      if (
        typeof lifecycleRaw !== 'string' ||
        !(Object.values(Lifecycle) as string[]).includes(lifecycleRaw)
      ) {
        throw new HttpError(400, 'Invalid lifecycle');
      }
      lifecycleFilter = lifecycleRaw as Lifecycle;
    }

    const parts = await prisma.part.findMany({
      // Nested rather than spread: `where` already carries a top-level `OR` when a search term
      // is given, and the acl fragment must compose with it instead of racing it for a key.
      where: { AND: [where, partAcl(user)] },
      orderBy: { partNumber: 'asc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        revisions: {
          select: { id: true, revision: true, lifecycle: true },
          orderBy: { id: 'desc' },
        },
      },
    });

    // Rule 10: lifecycle filters by the part's LATEST revision lifecycle.
    const filtered = lifecycleFilter
      ? parts.filter((p) => p.revisions.length > 0 && p.revisions[0].lifecycle === lifecycleFilter)
      : parts;

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize).map(toPartSummary);

    const payload: PagedDto<PartSummaryDto> = {
      items,
      total: filtered.length,
      page,
      pageSize,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /parts — create part + revision A (rule 6)
// ---------------------------------------------------------------------------

router.post(
  '/parts',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = requireBody(req);

    const name = requiredString(body, 'name');
    const category = parseCategory(body.category);
    const description = normalizeNullable(optionalNullableString(body, 'description'));

    let uom: string | undefined;
    const uomRaw = optionalString(body, 'uom');
    if (uomRaw !== undefined && uomRaw.trim() !== '') uom = uomRaw.trim();

    const unitCost = parseOptionalUnitCost(body);

    const partNumberRaw = optionalString(body, 'partNumber');
    const autoNumber = partNumberRaw === undefined || partNumberRaw.trim() === '';
    let partNumber = '';
    if (!autoNumber) {
      partNumber = partNumberRaw!.trim();
      if (partNumber.length > 40 || !PART_NUMBER_RE.test(partNumber)) {
        throw new HttpError(
          400,
          'partNumber must be at most 40 characters of letters, digits, ".", "_" or "-"'
        );
      }
      const existing = await prisma.part.findUnique({
        where: { partNumber },
        select: { id: true },
      });
      if (existing) throw new HttpError(409, `Part number ${partNumber} already exists`);
    }

    const createPartRecord = (pn: string, db: Prisma.TransactionClient = prisma) =>
      db.part.create({
        data: {
          partNumber: pn,
          name,
          description,
          category,
          ...(uom !== undefined ? { uom } : {}),
          ...(unitCost !== undefined ? { unitCost } : {}),
          createdById: userId,
          revisions: {
            create: { revision: 'A', lifecycle: Lifecycle.IN_WORK, createdById: userId },
          },
        },
        select: { id: true },
      });

    // Scan-and-insert under the numbering lock so concurrent creates queue instead of all
    // reading the same maximum. The retry stays as a backstop for a number a user typed
    // manually between the scan and the insert.
    const created = autoNumber
      ? await withNumberLock(async (tx) => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await createPartRecord(await generatePartNumber(tx), tx);
            } catch (err) {
              if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
              throw err;
            }
          }
        })
      : await createPartRecord(partNumber);

    const detail = await getPartDetailOrThrow(created.id);
    res.status(201).json(await toPartDetail(detail));
  })
);

// ---------------------------------------------------------------------------
// GET /parts/:id
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanRead('PART', id, aclUser(req));
    const part = await getPartDetailOrThrow(id);
    res.json(await toPartDetail(part));
  })
);

// ---------------------------------------------------------------------------
// PATCH /parts/:id
// ---------------------------------------------------------------------------

router.patch(
  '/parts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // Rule X3 — before any body validation. A 400 naming a field, or the old existence check,
    // would both confirm the part exists to a caller who may not know that. This also replaces
    // that existence check: an unreadable and a missing part both 404 here.
    await assertCanWrite('PART', id, aclUser(req));

    const body = requireBody(req);

    const data: Prisma.PartUpdateInput = {};
    if ('name' in body) data.name = requiredString(body, 'name');
    if ('description' in body) {
      data.description = normalizeNullable(optionalNullableString(body, 'description'));
    }
    if ('category' in body) data.category = parseCategory(body.category);
    if ('uom' in body) data.uom = requiredString(body, 'uom');
    if ('unitCost' in body) data.unitCost = parseOptionalUnitCost(body);

    if (Object.keys(data).length > 0) {
      await prisma.part.update({ where: { id }, data });
    }

    const detail = await getPartDetailOrThrow(id);
    res.json(await toPartDetail(detail));
  })
);

// ---------------------------------------------------------------------------
// DELETE /parts/:id (rule 7)
// ---------------------------------------------------------------------------

router.delete(
  '/parts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // Ahead of the reference counts: those 409s describe how the part is used, which is more
    // than a caller who cannot read it should learn (rule X3). Replaces the existence check —
    // missing and unreadable both 404 with the same message.
    await assertCanWrite('PART', id, aclUser(req));

    const [bomRefs, materialRefs, ecnRefs, baselineRefs, alternateRefs] = await Promise.all([
      prisma.bomLine.count({ where: { childPartId: id } }),
      prisma.operationMaterial.count({ where: { partId: id } }),
      prisma.ecnItem.count({ where: { partId: id } }),
      prisma.baselineLine.count({ where: { partId: id } }),
      prisma.bomLineAlternate.count({ where: { alternatePartId: id } }),
    ]);
    if (bomRefs > 0 || materialRefs > 0) {
      throw new HttpError(409, 'Part is used in a BOM / process plan and cannot be deleted');
    }
    if (alternateRefs > 0) {
      throw new HttpError(409, 'Part is referenced as a BOM alternate and cannot be deleted');
    }
    if (ecnRefs > 0) {
      throw new HttpError(409, 'Part is referenced by an ECN and cannot be deleted');
    }
    if (baselineRefs > 0) {
      throw new HttpError(409, 'Part is referenced by a baseline and cannot be deleted');
    }

    await prisma.part.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /parts/:id/revisions — revise (rule 3)
// ---------------------------------------------------------------------------

router.post(
  '/parts/:id/revisions',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Revising creates a revision of this part, so it is a write on the part.
    await assertCanWrite('PART', id, user);
    const userId = currentUserId(req);

    const part = await prisma.part.findUnique({
      where: { id },
      include: {
        revisions: {
          orderBy: { id: 'desc' },
          take: 1,
          include: {
            bomLines: { include: { alternates: true, optionConditions: true } },
            processPlan: {
              include: {
                operations: {
                  orderBy: { seq: 'asc' },
                  include: { materials: true },
                },
              },
            },
          },
        },
      },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    const latest = part.revisions.length > 0 ? part.revisions[0] : null;
    if (!latest) throw new HttpError(409, 'Part has no revisions to revise');
    if (latest.lifecycle !== Lifecycle.RELEASED && latest.lifecycle !== Lifecycle.OBSOLETE) {
      throw new HttpError(
        409,
        `Cannot revise: latest revision ${latest.revision} is ${latest.lifecycle} (must be RELEASED or OBSOLETE)`
      );
    }

    const label = nextRevisionLabel(latest.revision);

    const newRevisionId = await prisma.$transaction(async (tx) => {
      const rev = await tx.partRevision.create({
        data: {
          partId: part.id,
          revision: label,
          lifecycle: Lifecycle.IN_WORK,
          createdById: userId,
        },
        select: { id: true },
      });

      // The structure is copied wholesale, children the caller cannot read included. Nothing
      // about them is disclosed (the response carries no child identities), and dropping them
      // would silently mutilate the new revision's BOM — the write-side reading of rule X4.
      if (latest.bomLines.length > 0) {
        await tx.bomLine.createMany({
          data: latest.bomLines.map((line) => ({
            parentRevisionId: rev.id,
            childPartId: line.childPartId,
            findNumber: line.findNumber,
            quantity: line.quantity,
            uom: line.uom,
            refDesignators: line.refDesignators,
            notes: line.notes,
            effectiveFrom: line.effectiveFrom,
            effectiveTo: line.effectiveTo,
          })),
        });
        // Copy each line's alternates and variant option conditions onto the
        // matching new line (option groups live on the part, so the value ids
        // stay valid across revisions).
        const newLines = await tx.bomLine.findMany({
          where: { parentRevisionId: rev.id },
          select: { id: true, childPartId: true },
        });
        const newIdByChild = new Map(newLines.map((l) => [l.childPartId, l.id]));
        const altRows = latest.bomLines.flatMap((line) =>
          line.alternates.map((alt) => ({
            bomLineId: newIdByChild.get(line.childPartId)!,
            alternatePartId: alt.alternatePartId,
            note: alt.note,
          }))
        );
        if (altRows.length > 0) await tx.bomLineAlternate.createMany({ data: altRows });
        const optionRows = latest.bomLines.flatMap((line) =>
          line.optionConditions.map((cond) => ({
            bomLineId: newIdByChild.get(line.childPartId)!,
            optionValueId: cond.optionValueId,
          }))
        );
        if (optionRows.length > 0) await tx.bomLineOption.createMany({ data: optionRows });
      }

      if (latest.processPlan) {
        await tx.processPlan.create({
          data: {
            partRevisionId: rev.id,
            name: latest.processPlan.name,
            description: latest.processPlan.description,
            operations: {
              create: latest.processPlan.operations.map((op) => ({
                seq: op.seq,
                name: op.name,
                workCenter: op.workCenter,
                description: op.description,
                setupMinutes: op.setupMinutes,
                runMinutes: op.runMinutes,
                materials: {
                  create: op.materials.map((mat) => ({
                    partId: mat.partId,
                    quantity: mat.quantity,
                    uom: mat.uom,
                    notes: mat.notes,
                  })),
                },
              })),
            },
          },
        });
      }

      return rev.id;
    });

    const detail = await getRevisionDetailOrThrow(newRevisionId, user);
    res.status(201).json(toRevisionDetail(detail));
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await readableRevisionOrThrow(id, user);
    const revision = await getRevisionDetailOrThrow(id, user);
    res.json(toRevisionDetail(revision));
  })
);

// ---------------------------------------------------------------------------
// PATCH /revisions/:id — changeNote (edit gate, rule 1)
// ---------------------------------------------------------------------------

router.patch(
  '/revisions/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Access first, then the body, then the lifecycle gate: the 409 below quotes the
    // revision's label and state, which is already more than an outsider may learn.
    await writableRevisionOrThrow(id, user);

    const body = requireBody(req);

    const revision = await prisma.partRevision.findUnique({
      where: { id },
      select: { id: true, revision: true, lifecycle: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    if (revision.lifecycle !== Lifecycle.IN_WORK) {
      throw new HttpError(
        409,
        `Revision ${revision.revision} is ${revision.lifecycle} and cannot be modified`
      );
    }

    if ('changeNote' in body) {
      const changeNote = normalizeNullable(optionalNullableString(body, 'changeNote'));
      await prisma.partRevision.update({ where: { id }, data: { changeNote } });
    }

    const detail = await getRevisionDetailOrThrow(id, user);
    res.json(toRevisionDetail(detail));
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/transition — lifecycle state machine
// ---------------------------------------------------------------------------

type TransitionAction = 'submit' | 'approve' | 'reject' | 'obsolete';

const TRANSITIONS: Record<TransitionAction, { from: Lifecycle; to: Lifecycle }> = {
  submit: { from: Lifecycle.IN_WORK, to: Lifecycle.IN_REVIEW },
  approve: { from: Lifecycle.IN_REVIEW, to: Lifecycle.RELEASED },
  reject: { from: Lifecycle.IN_REVIEW, to: Lifecycle.IN_WORK },
  obsolete: { from: Lifecycle.RELEASED, to: Lifecycle.OBSOLETE },
};

router.post(
  '/revisions/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — ahead of the action parse: every refusal below quotes the revision's state.
    await writableRevisionOrThrow(id, user);

    const body = requireBody(req);

    const action = body.action;
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(TRANSITIONS, action)) {
      throw new HttpError(400, 'Unknown action (expected submit, approve, reject or obsolete)');
    }
    const transition = TRANSITIONS[action as TransitionAction];

    const revision = await prisma.partRevision.findUnique({
      where: { id },
      select: {
        id: true,
        revision: true,
        lifecycle: true,
        partId: true,
        part: { select: { partNumber: true } },
      },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    // Rule E7 — revisions managed by an active ECN are progressed via the ECN.
    // The lookup itself is deliberately NOT acl-filtered: an ECN the caller cannot see still
    // governs this revision, and filtering it away would let them bypass the gate entirely.
    // Only the message is redacted.
    const managedBy = await prisma.ecnItem.findFirst({
      where: {
        toRevisionId: id,
        ecn: { status: { in: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED] } },
      },
      include: { ecn: { select: { id: true, ecnNumber: true, status: true } } },
    });
    if (managedBy) {
      const visibleEcns = await visibleIds('ECN', [managedBy.ecn.id], user);
      throw new HttpError(
        409,
        visibleEcns.has(managedBy.ecn.id)
          ? `Revision is managed by ${managedBy.ecn.ecnNumber} (${managedBy.ecn.status}) — progress the change through the ECN`
          : 'Revision is managed by a restricted ECN — progress the change through the ECN'
      );
    }

    if (revision.lifecycle !== transition.from) {
      throw new HttpError(
        409,
        `Cannot ${action}: revision ${revision.revision} is ${revision.lifecycle} (requires ${transition.from})`
      );
    }

    // Rule S4 — a revision released on its own needs its signature manifest complete.
    // A revision released *through* an ECN is gated by that ECN's manifest instead, so it
    // is not asked to satisfy both. Checked outside the transaction because voiding stale
    // signatures writes, and this must not sit inside the conditional-update window.
    if (action === 'approve' && !managedBy) {
      await assertSignaturesComplete(SignedEntityType.REVISION, id, 'release');
    }

    await prisma.$transaction(async (tx) => {
      if (action === 'approve') {
        // Rule 2 — release gate: every BOM child part must have a RELEASED revision.
        const lines = await tx.bomLine.findMany({
          where: { parentRevisionId: id },
          include: {
            childPart: {
              select: {
                id: true,
                partNumber: true,
                revisions: { select: { lifecycle: true } },
              },
            },
          },
        });
        const offending = lines.filter(
          (line) => !line.childPart.revisions.some((r) => r.lifecycle === Lifecycle.RELEASED)
        );
        if (offending.length > 0) {
          // The gate must still block on a restricted child — the release would otherwise
          // depend on who is looking — but naming it would leak a part number through an
          // error message. One name per offender, so the count stays honest.
          const visible = await visibleIds(
            'PART',
            offending.map((line) => line.childPart.id),
            user
          );
          const offenders = offending
            .map((line) =>
              visible.has(line.childPart.id) ? line.childPart.partNumber : REDACTED.partNumber
            )
            .sort();
          throw new HttpError(
            409,
            `Cannot release: child parts without a released revision: ${offenders.join(', ')}`
          );
        }
      }

      // Conditional write: only transition from the expected state, so two
      // concurrent conflicting transitions can't both win.
      const result = await tx.partRevision.updateMany({
        where: { id, lifecycle: transition.from },
        data: {
          lifecycle: transition.to,
          ...(action === 'approve' ? { releasedAt: new Date() } : {}),
        },
      });
      if (result.count === 0) {
        throw new HttpError(
          409,
          `Cannot ${action}: revision ${revision.revision} was changed concurrently — reload and try again`
        );
      }

      // Rule I2 — queue outbound webhooks inside the transaction, so deliveries
      // only exist once the release actually commits.
      if (action === 'approve') {
        const payload = {
          partId: revision.partId,
          partNumber: revision.part.partNumber,
          revisionId: revision.id,
          revision: revision.revision,
          lifecycle: Lifecycle.RELEASED,
        };
        await emitEvent(tx, 'revision.released', payload);
        await emitEvent(tx, 'part.released', payload);
      }
    });

    const detail = await getRevisionDetailOrThrow(id, user);
    res.json(toRevisionDetail(detail));
  })
);

export default router;
