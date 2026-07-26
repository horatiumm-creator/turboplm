import { Request, Router } from 'express';
import { AttributeDef, AttributeType, PartCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/** The options column stores a JSON.stringify'd string[] ('[]' for non-LIST). */
function parseStoredOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function toAttributeDef(def: AttributeDef): AttributeDefDto {
  return {
    id: def.id,
    category: def.category,
    name: def.name,
    label: def.label,
    type: def.type,
    options: parseStoredOptions(def.options),
    required: def.required,
    sortOrder: def.sortOrder,
  };
}

/** Full attribute list for a part: every def of the category, value or null. */
async function listPartAttributes(
  partId: number,
  category: PartCategory
): Promise<PartAttributeDto[]> {
  const [defs, values] = await Promise.all([
    prisma.attributeDef.findMany({
      where: { category },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    }),
    prisma.partAttributeValue.findMany({ where: { partId } }),
  ]);
  const valueByDefId = new Map(values.map((v) => [v.attributeDefId, v.value]));
  return defs.map((def) => ({
    def: toAttributeDef(def),
    value: valueByDefId.get(def.id) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

const ATTRIBUTE_NAME_RE = /^[a-z][a-z0-9_]*$/;

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !ATTRIBUTE_NAME_RE.test(value)) {
    throw new HttpError(
      400,
      'name must be lowercase letters, digits and underscores (starting with a letter), at most 40 characters'
    );
  }
  return value;
}

function parseLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'label is required');
  }
  return value.trim();
}

function parseCategory(value: unknown): PartCategory {
  if (typeof value !== 'string' || !(Object.values(PartCategory) as string[]).includes(value)) {
    throw new HttpError(400, 'category must be a valid part category');
  }
  return value as PartCategory;
}

function parseAttributeType(value: unknown): AttributeType {
  if (typeof value !== 'string' || !(Object.values(AttributeType) as string[]).includes(value)) {
    throw new HttpError(400, 'type must be one of TEXT, NUMBER, DATE, BOOLEAN, LIST');
  }
  return value as AttributeType;
}

function parseOptionsInput(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'options must be an array of strings');
  const options = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HttpError(400, 'options must be non-empty strings');
    }
    return entry.trim();
  });
  if (new Set(options).size !== options.length) {
    throw new HttpError(400, 'options must be unique');
  }
  return options;
}

function parseBooleanFlag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function parseSortOrder(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
    throw new HttpError(400, 'sortOrder must be an integer');
  }
  return n;
}

/** Rule T7 — validate a (non-null) value against its definition's type. */
function validateValue(def: AttributeDef, value: string): void {
  switch (def.type) {
    case AttributeType.TEXT:
      return;
    case AttributeType.NUMBER:
      if (!Number.isFinite(Number(value))) {
        throw new HttpError(400, `"${def.label}" must be a number`);
      }
      return;
    case AttributeType.DATE:
      if (Number.isNaN(new Date(value).getTime())) {
        throw new HttpError(400, `"${def.label}" must be a valid date`);
      }
      return;
    case AttributeType.BOOLEAN:
      if (value !== 'true' && value !== 'false') {
        throw new HttpError(400, `"${def.label}" must be "true" or "false"`);
      }
      return;
    case AttributeType.LIST: {
      const options = parseStoredOptions(def.options);
      if (!options.includes(value)) {
        throw new HttpError(400, `"${def.label}" must be one of: ${options.join(', ')}`);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// GET /attribute-defs?category — list definitions
// ---------------------------------------------------------------------------

router.get(
  '/attribute-defs',
  asyncHandler(async (req, res) => {
    const categoryRaw = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (
      categoryRaw !== undefined &&
      !(Object.values(PartCategory) as string[]).includes(categoryRaw)
    ) {
      throw new HttpError(400, 'Invalid category filter');
    }
    const defs = await prisma.attributeDef.findMany({
      where: categoryRaw ? { category: categoryRaw as PartCategory } : {},
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });
    res.json(defs.map(toAttributeDef));
  })
);

// ---------------------------------------------------------------------------
// POST /attribute-defs — create (admin, rules T7/T9)
// ---------------------------------------------------------------------------

router.post(
  '/attribute-defs',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = requireBody(req);

    const category = parseCategory(body.category);
    const name = parseName(body.name);
    const label = parseLabel(body.label);
    const type = body.type === undefined ? AttributeType.TEXT : parseAttributeType(body.type);
    // options only apply to LIST — ignored/empty for every other type.
    const options =
      type === AttributeType.LIST && body.options !== undefined
        ? parseOptionsInput(body.options)
        : [];
    if (type === AttributeType.LIST && options.length === 0) {
      throw new HttpError(400, 'options are required for a LIST attribute');
    }
    const required = body.required === undefined ? false : parseBooleanFlag(body.required, 'required');
    const sortOrder = body.sortOrder === undefined ? 0 : parseSortOrder(body.sortOrder);

    const duplicate = await prisma.attributeDef.findUnique({
      where: { category_name: { category, name } },
      select: { id: true },
    });
    if (duplicate) {
      throw new HttpError(409, `Attribute "${name}" already exists for category ${category}`);
    }

    const created = await prisma.attributeDef.create({
      data: { category, name, label, type, options: JSON.stringify(options), required, sortOrder },
    });
    res.status(201).json(toAttributeDef(created));
  })
);

// ---------------------------------------------------------------------------
// PATCH /attribute-defs/:id — update (admin)
// ---------------------------------------------------------------------------

router.patch(
  '/attribute-defs/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const existing = await prisma.attributeDef.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Attribute definition not found');

    const name = body.name === undefined ? existing.name : parseName(body.name);
    const label = body.label === undefined ? existing.label : parseLabel(body.label);
    const type = body.type === undefined ? existing.type : parseAttributeType(body.type);
    const required =
      body.required === undefined
        ? existing.required
        : parseBooleanFlag(body.required, 'required');
    const sortOrder = body.sortOrder === undefined ? existing.sortOrder : parseSortOrder(body.sortOrder);

    let options: string[];
    if (type !== AttributeType.LIST) {
      options = [];
    } else if (body.options !== undefined) {
      options = parseOptionsInput(body.options);
    } else {
      options = parseStoredOptions(existing.options);
    }
    if (type === AttributeType.LIST && options.length === 0) {
      throw new HttpError(400, 'options are required for a LIST attribute');
    }

    if (name !== existing.name) {
      const duplicate = await prisma.attributeDef.findUnique({
        where: { category_name: { category: existing.category, name } },
        select: { id: true },
      });
      if (duplicate) {
        throw new HttpError(409, `Attribute "${name}" already exists for category ${existing.category}`);
      }
    }

    const updated = await prisma.attributeDef.update({
      where: { id },
      data: { name, label, type, options: JSON.stringify(options), required, sortOrder },
    });
    res.json(toAttributeDef(updated));
  })
);

// ---------------------------------------------------------------------------
// DELETE /attribute-defs/:id — delete, cascades values (admin)
// ---------------------------------------------------------------------------

router.delete(
  '/attribute-defs/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const existing = await prisma.attributeDef.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Attribute definition not found');
    await prisma.attributeDef.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// PUT /parts/:id/attributes — set/clear values in one transaction (rule T7)
// ---------------------------------------------------------------------------

router.put(
  '/parts/:id/attributes',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const body = requireBody(req);

    const part = await prisma.part.findUnique({
      where: { id: partId },
      select: { id: true, category: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    const valuesRaw: unknown = body.values;
    if (typeof valuesRaw !== 'object' || valuesRaw === null || Array.isArray(valuesRaw)) {
      throw new HttpError(400, 'values must be an object mapping attribute ids to value or null');
    }

    const entries: { defId: number; value: string | null }[] = [];
    for (const [key, raw] of Object.entries(valuesRaw as Record<string, unknown>)) {
      const defId = Number(key);
      if (!Number.isInteger(defId) || defId <= 0 || defId > 2147483647) {
        throw new HttpError(400, `Invalid attribute definition id: ${key}`);
      }
      if (raw !== null && typeof raw !== 'string') {
        throw new HttpError(400, 'Attribute values must be strings or null');
      }
      // Blank strings clear the value, same as an explicit null.
      const trimmed = raw === null ? null : raw.trim();
      entries.push({ defId, value: trimmed === '' ? null : trimmed });
    }

    const defs = await prisma.attributeDef.findMany({
      where: { id: { in: entries.map((entry) => entry.defId) } },
    });
    const defById = new Map(defs.map((def) => [def.id, def]));
    for (const entry of entries) {
      const def = defById.get(entry.defId);
      if (!def) throw new HttpError(404, `Attribute definition ${entry.defId} not found`);
      if (def.category !== part.category) {
        throw new HttpError(
          400,
          `Attribute "${def.label}" does not apply to ${part.category} parts`
        );
      }
      if (entry.value !== null) validateValue(def, entry.value);
    }

    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        if (entry.value === null) {
          await tx.partAttributeValue.deleteMany({
            where: { partId, attributeDefId: entry.defId },
          });
        } else {
          await tx.partAttributeValue.upsert({
            where: { partId_attributeDefId: { partId, attributeDefId: entry.defId } },
            create: { partId, attributeDefId: entry.defId, value: entry.value },
            update: { value: entry.value },
          });
        }
      }
    });

    res.json(await listPartAttributes(partId, part.category));
  })
);

export default router;
