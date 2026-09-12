/**
 * Materials and mBOM material requirements — rules N2, N3.
 *
 * A `PartMaterial` is what a part is *made from*. It is deliberately none of the three things
 * it could be confused with: a `BomLine` composes parts, an `OperationMaterial` consumes parts
 * at an operation, and a `ManufacturerPart` names who sells a part. None of them can say "this
 * bracket starts as a 40 x 40 x 220 bar of 6061-T6", which is exactly what a buyer needs.
 *
 * The roll-up in rule N3 is the point of the whole module: what do we have to buy to build N of
 * this assembly, and — just as important — which parts do not tell us.
 */
import { Request, Router } from 'express';
import { Lifecycle, MaterialClass, MaterialForm, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { escapeLike, resolveDisplayRevision } from '../lib/plm';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';

const router = Router();
router.use(requireAuth);

/** Same cap the BOM tree walk uses, so the two agree about how deep a product can be. */
const MAX_TREE_DEPTH = 15;

const MATERIAL_CODE_RE = /^[A-Z0-9._-]{2,32}$/i;

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

interface MaterialSummaryDto {
  id: number;
  code: string;
  name: string;
  materialClass: MaterialClass;
  specification: string | null;
  density: number | null;
  stockUom: string;
  unitCost: number | null;
  active: boolean;
  /** How many parts declare this material — the guard against deleting one in use. */
  partCount: number;
  createdAt: string;
}

interface MaterialDetailDto extends MaterialSummaryDto {
  notes: string | null;
  updatedAt: string;
}

interface PartMaterialDto {
  id: number;
  material: MaterialSummaryDto;
  form: MaterialForm;
  netQuantity: number;
  scrapFactor: number;
  /** net x (1 + scrapFactor), rounded — what is actually drawn from stock. */
  grossQuantity: number;
  stockSize: string | null;
  notes: string | null;
}

interface RequirementContributorDto {
  part: PartRefDto | typeof REDACTED;
  /** Times this part appears per one of the top assembly. */
  perAssembly: number;
  /** perAssembly x buildQuantity. */
  totalParts: number;
  netQuantity: number;
  grossQuantity: number;
}

interface MaterialRequirementDto {
  material: MaterialSummaryDto;
  netQuantity: number;
  grossQuantity: number;
  stockUom: string;
  /** gross x unitCost, or null when the material carries no cost. */
  estimatedCost: number | null;
  fromParts: RequirementContributorDto[];
}

interface UnspecifiedPartDto {
  part: PartRefDto | typeof REDACTED;
  perAssembly: number;
  totalParts: number;
}

interface MaterialRequirementsDto {
  revision: { id: number; revision: string; lifecycle: Lifecycle };
  part: PartRefDto;
  buildQuantity: number;
  materials: MaterialRequirementDto[];
  /**
   * Parts that plausibly need a material and declare none. Reporting these matters as much as
   * the totals: a requirements list that quietly omitted them would read as complete when it
   * is not, and someone would order against it.
   */
  unspecified: UnspecifiedPartDto[];
  notes: string[];
  totalEstimatedCost: number | null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim().slice(0, max);
}

/** Absent and explicitly-null both mean "no value"; only a wrong type is an error. */
function optionalText(value: unknown, field: string, max = 1000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  return value.trim().slice(0, max) || null;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, `${field} must be a number >= 0`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a number > 0`);
  }
  return value;
}

/** The same rule the mBOM already applies to operation scrap: 100 % loss is nonsense. */
function scrapFraction(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new HttpError(400, 'scrapFactor must be a number >= 0 and < 1');
  }
  return value;
}

function parseEnum<T extends Record<string, string>>(
  value: unknown,
  values: T,
  field: string,
  fallback?: T[keyof T]
): T[keyof T] {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof value !== 'string' || !Object.values(values).includes(value)) {
    throw new HttpError(400, `${field} must be one of ${Object.values(values).join(', ')}`);
  }
  return value as T[keyof T];
}

/** Float sums need rounding before comparison or display, or 3 x 0.1 reads as 0.30000000000000004. */
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const materialSelect = {
  id: true,
  code: true,
  name: true,
  materialClass: true,
  specification: true,
  density: true,
  stockUom: true,
  unitCost: true,
  active: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { partMaterials: true } },
} satisfies Prisma.MaterialSelect;

type MaterialRow = Prisma.MaterialGetPayload<{ select: typeof materialSelect }>;

function toMaterialSummary(row: MaterialRow): MaterialSummaryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    materialClass: row.materialClass,
    specification: row.specification,
    density: row.density,
    stockUom: row.stockUom,
    unitCost: row.unitCost,
    active: row.active,
    partCount: row._count.partMaterials,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMaterialDetail(row: MaterialRow): MaterialDetailDto {
  return { ...toMaterialSummary(row), notes: row.notes, updatedAt: row.updatedAt.toISOString() };
}

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

const grossOf = (net: number, scrap: number) => round6(net * (1 + scrap));

function toPartMaterial(row: {
  id: number;
  form: MaterialForm;
  netQuantity: number;
  scrapFactor: number;
  stockSize: string | null;
  notes: string | null;
  material: MaterialRow;
}): PartMaterialDto {
  return {
    id: row.id,
    material: toMaterialSummary(row.material),
    form: row.form,
    netQuantity: row.netQuantity,
    scrapFactor: row.scrapFactor,
    grossQuantity: grossOf(row.netQuantity, row.scrapFactor),
    stockSize: row.stockSize,
    notes: row.notes,
  };
}

async function getMaterialOrThrow(id: number): Promise<MaterialRow> {
  const row = await prisma.material.findUnique({ where: { id }, select: materialSelect });
  if (!row) throw new HttpError(404, 'Material not found');
  return row;
}

// ---------------------------------------------------------------------------
// Materials — rule N2
// ---------------------------------------------------------------------------

router.get(
  '/materials',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const materialClass =
      typeof req.query.materialClass === 'string' && req.query.materialClass !== ''
        ? parseEnum(req.query.materialClass, MaterialClass, 'materialClass')
        : undefined;
    const activeRaw = req.query.active;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where: Prisma.MaterialWhereInput = {
      ...(materialClass ? { materialClass } : {}),
      ...(activeRaw === 'true' ? { active: true } : {}),
      ...(activeRaw === 'false' ? { active: false } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: escapeLike(search), mode: 'insensitive' } },
              { name: { contains: escapeLike(search), mode: 'insensitive' } },
              { specification: { contains: escapeLike(search), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.material.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: materialSelect,
      }),
      prisma.material.count({ where }),
    ]);
    res.json({ items: rows.map(toMaterialSummary), total, page, pageSize });
  })
);

router.post(
  '/materials',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = bodyOf(req);
    const code = requireText(body.code, 'code', 32);
    if (!MATERIAL_CODE_RE.test(code)) {
      throw new HttpError(400, 'code must be 2–32 characters: letters, digits, dot, dash or underscore');
    }

    try {
      const created = await prisma.material.create({
        data: {
          code,
          name: requireText(body.name, 'name'),
          materialClass: parseEnum(body.materialClass, MaterialClass, 'materialClass', MaterialClass.METAL),
          specification: optionalText(body.specification, 'specification'),
          density: optionalNumber(body.density, 'density'),
          stockUom: optionalText(body.stockUom, 'stockUom', 16) ?? 'kg',
          unitCost: optionalNumber(body.unitCost, 'unitCost'),
          notes: optionalText(body.notes, 'notes'),
          createdById: userId,
        },
        select: materialSelect,
      });
      res.status(201).json(toMaterialDetail(created));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new HttpError(409, `Material ${code} already exists`);
      }
      throw err;
    }
  })
);

router.get(
  '/materials/:id',
  asyncHandler(async (req, res) => {
    res.json(toMaterialDetail(await getMaterialOrThrow(idParam(req.params.id))));
  })
);

router.patch(
  '/materials/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    await getMaterialOrThrow(id);
    const body = bodyOf(req);

    const data: Prisma.MaterialUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = requireText(body.name, 'name');
    if (body.materialClass !== undefined) {
      data.materialClass = parseEnum(body.materialClass, MaterialClass, 'materialClass');
    }
    if (body.specification !== undefined) {
      data.specification = optionalText(body.specification, 'specification');
    }
    if (body.density !== undefined) data.density = optionalNumber(body.density, 'density');
    if (body.stockUom !== undefined) {
      data.stockUom = optionalText(body.stockUom, 'stockUom', 16) ?? 'kg';
    }
    if (body.unitCost !== undefined) data.unitCost = optionalNumber(body.unitCost, 'unitCost');
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
      data.active = body.active;
    }
    // `code` is deliberately immutable: it identifies the material on every part that
    // references it and on any purchase order already raised against it.

    const updated = await prisma.material.update({ where: { id }, data, select: materialSelect });
    res.json(toMaterialDetail(updated));
  })
);

router.delete(
  '/materials/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const material = await getMaterialOrThrow(id);
    if (material._count.partMaterials > 0) {
      // Deleting would silently strip material from parts whose requirements someone is
      // ordering against. Deactivating keeps the history and stops new use.
      throw new HttpError(
        409,
        `${material.code} is used by ${material._count.partMaterials} part${
          material._count.partMaterials === 1 ? '' : 's'
        } — deactivate it instead`
      );
    }
    await prisma.material.delete({ where: { id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// A part's materials — rule N2
// ---------------------------------------------------------------------------

const partMaterialSelect = {
  id: true,
  form: true,
  netQuantity: true,
  scrapFactor: true,
  stockSize: true,
  notes: true,
  material: { select: materialSelect },
} satisfies Prisma.PartMaterialSelect;

async function partMaterialsOf(partId: number): Promise<PartMaterialDto[]> {
  const rows = await prisma.partMaterial.findMany({
    where: { partId },
    orderBy: [{ material: { name: 'asc' } }, { form: 'asc' }],
    select: partMaterialSelect,
  });
  return rows.map(toPartMaterial);
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

router.get(
  '/parts/:id/materials',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    // A restricted part 404s like a missing one (rule X2).
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(aclUser(req)) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');
    res.json(await partMaterialsOf(partId));
  })
);

router.post(
  '/parts/:id/materials',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const user = aclUser(req);
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');
    // Declaring what a part is made of is writing the part's manufacturing definition.
    await assertCanWrite('PART', partId, user);

    const body = bodyOf(req);
    const materialId = idParam(String(body.materialId ?? ''), 'materialId');
    const material = await getMaterialOrThrow(materialId);
    if (!material.active) throw new HttpError(409, `${material.code} is not an active material`);

    try {
      await prisma.partMaterial.create({
        data: {
          partId,
          materialId,
          form: parseEnum(body.form, MaterialForm, 'form', MaterialForm.BAR),
          netQuantity: positiveNumber(body.netQuantity, 'netQuantity'),
          scrapFactor: scrapFraction(body.scrapFactor),
          stockSize: optionalText(body.stockSize, 'stockSize', 200),
          notes: optionalText(body.notes, 'notes'),
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        // The same alloy in two forms is two legitimate rows; the same alloy and form is not.
        throw new HttpError(409, `${material.code} is already recorded on this part in that form`);
      }
      throw err;
    }
    res.status(201).json(await partMaterialsOf(partId));
  })
);

router.patch(
  '/part-materials/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // As visible as the part it describes; write-gated on that part (rules X2-X3).
    const existing = await prisma.partMaterial.findFirst({
      where: { id, part: partAcl(user) },
      select: { id: true, partId: true },
    });
    if (!existing) throw new HttpError(404, 'Part material not found');
    await assertCanWrite('PART', existing.partId, user);

    const body = bodyOf(req);
    const data: Prisma.PartMaterialUncheckedUpdateInput = {};
    if (body.form !== undefined) data.form = parseEnum(body.form, MaterialForm, 'form');
    if (body.netQuantity !== undefined) {
      data.netQuantity = positiveNumber(body.netQuantity, 'netQuantity');
    }
    if (body.scrapFactor !== undefined) data.scrapFactor = scrapFraction(body.scrapFactor);
    if (body.stockSize !== undefined) data.stockSize = optionalText(body.stockSize, 'stockSize', 200);
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');

    try {
      await prisma.partMaterial.update({ where: { id }, data });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new HttpError(409, 'That material is already recorded on this part in that form');
      }
      throw err;
    }
    res.json(await partMaterialsOf(existing.partId));
  })
);

router.delete(
  '/part-materials/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const existing = await prisma.partMaterial.findFirst({
      where: { id, part: partAcl(user) },
      select: { id: true, partId: true },
    });
    if (!existing) throw new HttpError(404, 'Part material not found');
    await assertCanWrite('PART', existing.partId, user);
    await prisma.partMaterial.delete({ where: { id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Material requirements — rule N3
// ---------------------------------------------------------------------------

/** Parts that plausibly consume raw stock. An assembly's material comes from its children. */
const NEEDS_MATERIAL: PartCategory[] = [PartCategory.MECHANICAL, PartCategory.RAW_MATERIAL];

interface Explosion {
  /** partId -> occurrences per one of the top assembly. */
  quantities: Map<number, number>;
  parts: Map<number, PartRefDto & { category: PartCategory }>;
  notes: string[];
}

/**
 * Explode the BOM under a revision, accumulating how many of each part one top-level assembly
 * needs.
 *
 * Quantities multiply down the tree, so a part four levels deep at quantity 2 under a
 * subassembly used 3 times contributes 6. A part reachable by two routes accumulates both —
 * that is the whole point, and de-duplicating by part id would under-report.
 *
 * Child revisions follow the same resolved-revision rule the BOM tree uses (latest RELEASED,
 * else latest), so requirements agree with what the BOM view shows rather than inventing a
 * second interpretation.
 */
async function explode(revisionId: number): Promise<Explosion> {
  const quantities = new Map<number, number>();
  const parts = new Map<number, PartRefDto & { category: PartCategory }>();
  const notes: string[] = [];

  // Guard against a cycle the write path should already prevent: a read must not hang.
  const walk = async (currentRevisionId: number, multiplier: number, depth: number, seen: Set<number>) => {
    if (depth > MAX_TREE_DEPTH) {
      notes.push(`Structure deeper than ${MAX_TREE_DEPTH} levels was not expanded fully.`);
      return;
    }
    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: currentRevisionId },
      orderBy: { findNumber: 'asc' },
      select: {
        quantity: true,
        childPart: {
          select: {
            id: true,
            partNumber: true,
            name: true,
            category: true,
            uom: true,
            revisions: { select: { id: true, lifecycle: true } },
          },
        },
      },
    });

    for (const line of lines) {
      const child = line.childPart;
      const contribution = multiplier * line.quantity;
      quantities.set(child.id, round6((quantities.get(child.id) ?? 0) + contribution));
      if (!parts.has(child.id)) parts.set(child.id, toPartRef(child));

      const resolved = resolveDisplayRevision(child.revisions);
      if (!resolved || seen.has(resolved.id)) continue;
      await walk(resolved.id, contribution, depth + 1, new Set([...seen, resolved.id]));
    }
  };

  await walk(revisionId, 1, 1, new Set([revisionId]));
  return { quantities, parts, notes };
}

router.get(
  '/revisions/:id/material-requirements',
  asyncHandler(async (req, res) => {
    res.json(await buildRequirements(idParam(req.params.id), req.query.quantity, aclUser(req)));
  })
);

async function buildRequirements(
  revisionId: number,
  quantityRaw: unknown,
  user: AclUser
): Promise<MaterialRequirementsDto> {
  const buildQuantity = quantityRaw === undefined ? 1 : Number(quantityRaw);
  if (!Number.isFinite(buildQuantity) || buildQuantity <= 0) {
    throw new HttpError(400, 'quantity must be a number > 0');
  }

  // Resolved through the part's read filter: a restricted assembly's requirements 404.
  const revision = await prisma.partRevision.findFirst({
    where: { id: revisionId, part: partAcl(user) },
    select: {
      id: true,
      revision: true,
      lifecycle: true,
      part: { select: { id: true, partNumber: true, name: true, category: true, uom: true } },
    },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');

  const { quantities, parts, notes } = await explode(revisionId);
  // The top assembly itself can carry material (potting compound, adhesive), so it counts once.
  quantities.set(revision.part.id, round6((quantities.get(revision.part.id) ?? 0) + 1));
  parts.set(revision.part.id, toPartRef(revision.part));

  const partIds = [...quantities.keys()];
  // Rule X4 — hidden descendants keep their quantities in every material total (a censored
  // stock buy is wrong in the direction nobody checks) and lose their identity in the
  // contributor and gap lists below.
  const visibleParts = await visibleIds('PART', partIds, user);
  const redactedRef = (part: PartRefDto): PartRefDto | typeof REDACTED =>
    visibleParts.has(part.id) ? part : { ...REDACTED };
  const declared = partIds.length
    ? await prisma.partMaterial.findMany({
        where: { partId: { in: partIds } },
        select: { partId: true, netQuantity: true, scrapFactor: true, material: { select: materialSelect } },
      })
    : [];

  const byMaterial = new Map<number, MaterialRequirementDto>();
  const withMaterial = new Set<number>();

  for (const row of declared) {
    withMaterial.add(row.partId);
    const perAssembly = quantities.get(row.partId) ?? 0;
    const totalParts = round6(perAssembly * buildQuantity);
    const net = round6(row.netQuantity * totalParts);
    const gross = round6(grossOf(row.netQuantity, row.scrapFactor) * totalParts);

    let entry = byMaterial.get(row.material.id);
    if (!entry) {
      entry = {
        material: toMaterialSummary(row.material),
        netQuantity: 0,
        grossQuantity: 0,
        stockUom: row.material.stockUom,
        estimatedCost: null,
        fromParts: [],
      };
      byMaterial.set(row.material.id, entry);
    }
    entry.netQuantity = round6(entry.netQuantity + net);
    entry.grossQuantity = round6(entry.grossQuantity + gross);
    const part = parts.get(row.partId);
    if (part) {
      entry.fromParts.push({
        part: redactedRef(part),
        perAssembly,
        totalParts,
        netQuantity: net,
        grossQuantity: gross,
      });
    }
    if (part && part.category === PartCategory.ASSEMBLY && visibleParts.has(part.id)) {
      const note = `${part.partNumber} is an assembly carrying material directly.`;
      if (!notes.includes(note)) notes.push(note);
    }
  }

  const materials = [...byMaterial.values()]
    .map((entry) => ({
      ...entry,
      estimatedCost:
        entry.material.unitCost === null
          ? null
          : round6(entry.grossQuantity * entry.material.unitCost),
      // Biggest contributor first: that is where a surprising total comes from.
      fromParts: entry.fromParts.sort((a, b) => b.grossQuantity - a.grossQuantity),
    }))
    .sort((a, b) => a.material.name.localeCompare(b.material.name));

  const unspecified: UnspecifiedPartDto[] = [...parts.values()]
    .filter((part) => !withMaterial.has(part.id) && NEEDS_MATERIAL.includes(part.category))
    .map((part) => {
      const perAssembly = quantities.get(part.id) ?? 0;
      return {
        part: redactedRef(part),
        perAssembly,
        totalParts: round6(perAssembly * buildQuantity),
      };
    })
    .sort((a, b) => a.part.partNumber.localeCompare(b.part.partNumber));

  const costed = materials.filter((m) => m.estimatedCost !== null);
  return {
    revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
    part: toPartRef(revision.part),
    buildQuantity,
    materials,
    unspecified,
    notes,
    // Null rather than a partial sum when nothing is costed; a partial total is reported as
    // itself, with the uncosted materials visible in the table.
    totalEstimatedCost: costed.length
      ? round6(costed.reduce((sum, m) => sum + (m.estimatedCost ?? 0), 0))
      : null,
  };
}

/** Formula neutralization matching bom.ts: a cell starting with = + - @ becomes text. */
function csvField(value: string): string {
  const neutralized = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

router.get(
  '/revisions/:id/material-requirements/export.csv',
  asyncHandler(async (req, res) => {
    const report = await buildRequirements(idParam(req.params.id), req.query.quantity, aclUser(req));
    const rows = [
      'Material Code,Material,Specification,Form Note,Net,Gross,UoM,Unit Cost,Estimated Cost',
    ];
    for (const entry of report.materials) {
      rows.push(
        [
          entry.material.code,
          entry.material.name,
          entry.material.specification ?? '',
          entry.fromParts.map((p) => p.part.partNumber).join(' '),
          String(entry.netQuantity),
          String(entry.grossQuantity),
          entry.stockUom,
          entry.material.unitCost === null ? '' : String(entry.material.unitCost),
          entry.estimatedCost === null ? '' : String(entry.estimatedCost),
        ].map(csvField).join(',')
      );
    }
    // The gaps ship with the totals: a buyer who cannot see them will assume the list is whole.
    if (report.unspecified.length > 0) {
      rows.push('');
      rows.push('Parts with no material declared,Per assembly,Total');
      for (const gap of report.unspecified) {
        rows.push(
          [`${gap.part.partNumber} ${gap.part.name}`, String(gap.perAssembly), String(gap.totalParts)]
            .map(csvField)
            .join(',')
        );
      }
    }

    const safe = `${report.part.partNumber}_rev${report.revision.revision}`.replace(
      /[^A-Za-z0-9._-]/g,
      '_'
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}_materials.csv"`);
    res.send(rows.join('\r\n') + '\r\n');
  })
);

export default router;
