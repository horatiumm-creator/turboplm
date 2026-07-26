import { Router } from 'express';
import { Lifecycle, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, asyncHandler, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';

const router = Router();
router.use(requireAuth);

const MAX_TREE_DEPTH = 15;

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface PartRef {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

interface RevisionRef {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

interface BomLineAlternateDetail {
  id: number;
  part: PartRef;
  note: string | null;
}

interface BomLineDetail {
  id: number;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  alternates: BomLineAlternateDetail[];
  childPart: PartRef;
  resolvedRevision: RevisionRef | null;
}

interface BomTreeNode {
  line: {
    id: number;
    findNumber: number;
    quantity: number;
    uom: string;
    refDesignators: string | null;
    notes: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    alternates: BomLineAlternateDetail[];
  };
  part: PartRef;
  revision: RevisionRef | null;
  unreleased: boolean;
  cycle: boolean;
  children: BomTreeNode[];
}

interface WhereUsedEntry {
  line: { id: number; findNumber: number; quantity: number; uom: string };
  parentRevision: RevisionRef;
  parentPart: { id: number; partNumber: string; name: string };
}

// ---------------------------------------------------------------------------
// Query shapes + mappers
// ---------------------------------------------------------------------------

const lineInclude = {
  childPart: {
    include: {
      revisions: { select: { id: true, revision: true, lifecycle: true } },
    },
  },
  alternates: {
    include: { alternatePart: true },
    orderBy: { id: 'asc' },
  },
} as const;

type LineWithChild = Prisma.BomLineGetPayload<{ include: typeof lineInclude }>;

function toPartRef(part: {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}): PartRef {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toRevisionRef(rev: { id: number; revision: string; lifecycle: Lifecycle }): RevisionRef {
  return { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle };
}

function toAlternateDetail(alt: {
  id: number;
  note: string | null;
  alternatePart: {
    id: number;
    partNumber: string;
    name: string;
    category: PartCategory;
    uom: string;
  };
}): BomLineAlternateDetail {
  return { id: alt.id, part: toPartRef(alt.alternatePart), note: alt.note };
}

function toBomLineDetail(line: LineWithChild): BomLineDetail {
  const resolved = resolveDisplayRevision(line.childPart.revisions);
  return {
    id: line.id,
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    notes: line.notes,
    effectiveFrom: line.effectiveFrom ? line.effectiveFrom.toISOString() : null,
    effectiveTo: line.effectiveTo ? line.effectiveTo.toISOString() : null,
    alternates: line.alternates.map(toAlternateDetail),
    childPart: toPartRef(line.childPart),
    resolvedRevision: resolved ? toRevisionRef(resolved) : null,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${label} must be a number greater than 0`);
  }
  return value;
}

/** Optional non-empty string; returns undefined when blank/omitted. */
function optionalUom(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'uom must be a string');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Optional nullable text field; blank strings collapse to null. */
function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Rule T4 — effectivity bound: ISO date string or null (null = open bound). */
function parseEffectivityBound(value: unknown, label: string): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be an ISO date string or null`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

/** Rule T4 — effectiveFrom must precede effectiveTo when both are set. */
function assertEffectivityWindow(from: Date | null, to: Date | null): void {
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw new HttpError(400, 'effectiveFrom must be before effectiveTo');
  }
}

/** Rule T4 — optional ?asOf= query value; blank/omitted means no filter. */
function parseAsOfQuery(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'asOf must be an ISO date string');
  if (value.trim() === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'asOf is not a valid date');
  return date;
}

/** Rule T4 — lines effective at asOf: (from null or <= asOf) AND (to null or > asOf). */
function effectivityFilter(asOf: Date | undefined): Prisma.BomLineWhereInput {
  if (!asOf) return {};
  return {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Business-rule helpers
// ---------------------------------------------------------------------------

/** Rule 1 — edit gate: BOM mutations only while the owning revision is IN_WORK. */
function assertEditable(rev: { revision: string; lifecycle: Lifecycle }): void {
  if (rev.lifecycle !== Lifecycle.IN_WORK) {
    throw new HttpError(409, `Revision ${rev.revision} is ${rev.lifecycle} and cannot be modified`);
  }
}

/**
 * Rule 4 — cycle prevention. Conservative BFS over ALL BomLine edges
 * (parentRevision.partId -> childPartId): reject if the parent part is
 * reachable from the new child (or the child IS the parent part).
 */
async function assertNoCycle(
  parentPartId: number,
  childPartId: number,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  const cycleError = () => new HttpError(409, 'Adding this part would create a BOM cycle');
  if (childPartId === parentPartId) throw cycleError();

  const edges = await db.bomLine.findMany({
    select: { childPartId: true, parentRevision: { select: { partId: true } } },
  });
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const from = edge.parentRevision.partId;
    const targets = adjacency.get(from);
    if (targets) targets.push(edge.childPartId);
    else adjacency.set(from, [edge.childPartId]);
  }

  const visited = new Set<number>([childPartId]);
  const queue: number[] = [childPartId];
  for (const current of queue) {
    if (current === parentPartId) throw cycleError();
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
}

/** Rule 8 — auto-assign the next multiple of 10 (start 10). */
async function nextFindNumber(
  parentRevisionId: number,
  db: Prisma.TransactionClient = prisma
): Promise<number> {
  const agg = await db.bomLine.aggregate({
    where: { parentRevisionId },
    _max: { findNumber: true },
  });
  const max = agg._max.findNumber ?? 0;
  return Math.floor(max / 10) * 10 + 10;
}

async function assertFindNumberFree(
  parentRevisionId: number,
  findNumber: number,
  excludeLineId?: number,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  const clash = await db.bomLine.findFirst({
    where: {
      parentRevisionId,
      findNumber,
      ...(excludeLineId !== undefined ? { id: { not: excludeLineId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, 'Find number already used');
}

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom — flat BOM, findNumber asc
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id/bom',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const asOf = parseAsOfQuery(req.query.asOf);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: revisionId, ...effectivityFilter(asOf) },
      orderBy: { findNumber: 'asc' },
      include: lineInclude,
    });
    res.json(lines.map(toBomLineDetail));
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom/tree — recursive expansion via resolved revisions
// ---------------------------------------------------------------------------

async function buildTreeLevel(
  parentRevisionId: number,
  ancestorPartIds: ReadonlySet<number>,
  depth: number,
  asOf: Date | undefined
): Promise<BomTreeNode[]> {
  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId, ...effectivityFilter(asOf) },
    orderBy: { findNumber: 'asc' },
    include: lineInclude,
  });

  const nodes: BomTreeNode[] = [];
  for (const line of lines) {
    const resolved = resolveDisplayRevision(line.childPart.revisions);
    const cycle = ancestorPartIds.has(line.childPartId);
    let children: BomTreeNode[] = [];
    if (!cycle && resolved && depth < MAX_TREE_DEPTH) {
      const branch = new Set(ancestorPartIds);
      branch.add(line.childPartId);
      children = await buildTreeLevel(resolved.id, branch, depth + 1, asOf);
    }
    nodes.push({
      line: {
        id: line.id,
        findNumber: line.findNumber,
        quantity: line.quantity,
        uom: line.uom,
        refDesignators: line.refDesignators,
        notes: line.notes,
        effectiveFrom: line.effectiveFrom ? line.effectiveFrom.toISOString() : null,
        effectiveTo: line.effectiveTo ? line.effectiveTo.toISOString() : null,
        alternates: line.alternates.map(toAlternateDetail),
      },
      part: toPartRef(line.childPart),
      revision: resolved ? toRevisionRef(resolved) : null,
      unreleased: !resolved || resolved.lifecycle !== Lifecycle.RELEASED,
      cycle,
      children,
    });
  }
  return nodes;
}

router.get(
  '/revisions/:id/bom/tree',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const asOf = parseAsOfQuery(req.query.asOf);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      select: { id: true, partId: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const tree = await buildTreeLevel(revision.id, new Set([revision.partId]), 1, asOf);
    res.json(tree);
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom/export.csv — flattened multi-level BOM as CSV
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'Level,Find,Part Number,Part Name,Category,Revision,Lifecycle,Quantity,UoM,RefDes,Notes,Effective From,Effective To';

/**
 * RFC 4180 quoting plus formula neutralization: cells starting with = + - @ or tab
 * are prefixed with a single quote so spreadsheet apps treat them as text
 * (CSV-injection mitigation; numeric columns never start with those characters).
 */
function csvField(value: string): string {
  const neutralized = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

/** Depth-first flatten of the BOM tree into CSV rows with a 1-based Level column. */
function appendCsvRows(rows: string[], nodes: BomTreeNode[], level: number): void {
  for (const node of nodes) {
    const fields = [
      String(level),
      String(node.line.findNumber),
      node.part.partNumber,
      node.part.name,
      node.part.category,
      node.revision ? node.revision.revision : '',
      node.revision ? node.revision.lifecycle : '',
      String(node.line.quantity),
      node.line.uom,
      node.line.refDesignators ?? '',
      node.line.notes ?? '',
      node.line.effectiveFrom ? node.line.effectiveFrom.slice(0, 10) : '',
      node.line.effectiveTo ? node.line.effectiveTo.slice(0, 10) : '',
    ];
    rows.push(fields.map(csvField).join(','));
    appendCsvRows(rows, node.children, level + 1);
  }
}

router.get(
  '/revisions/:id/bom/export.csv',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      select: {
        id: true,
        partId: true,
        revision: true,
        part: { select: { partNumber: true } },
      },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const tree = await buildTreeLevel(revision.id, new Set([revision.partId]), 1, undefined);
    const rows: string[] = [CSV_HEADER];
    appendCsvRows(rows, tree, 1);

    const safePartNumber = revision.part.partNumber.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safePartNumber}_rev${revision.revision}_bom.csv"`
    );
    res.send(rows.join('\r\n') + '\r\n');
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/bom — add a BOM line
// ---------------------------------------------------------------------------

router.post(
  '/revisions/:id/bom',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      select: { id: true, partId: true, revision: true, lifecycle: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    assertEditable(revision);

    const body = bodyOf(req);
    const childPartId = requirePositiveInt(body.childPartId, 'childPartId');
    const quantity = requirePositiveNumber(body.quantity, 'quantity');
    const uom = optionalUom(body.uom);
    const refDesignators =
      body.refDesignators === undefined
        ? null
        : optionalNullableText(body.refDesignators, 'refDesignators');
    const notes = body.notes === undefined ? null : optionalNullableText(body.notes, 'notes');
    const effectiveFrom =
      body.effectiveFrom === undefined
        ? null
        : parseEffectivityBound(body.effectiveFrom, 'effectiveFrom');
    const effectiveTo =
      body.effectiveTo === undefined ? null : parseEffectivityBound(body.effectiveTo, 'effectiveTo');
    assertEffectivityWindow(effectiveFrom, effectiveTo);

    const childPart = await prisma.part.findUnique({
      where: { id: childPartId },
      select: { id: true },
    });
    if (!childPart) throw new HttpError(404, 'Child part not found');

    const requestedFindNumber =
      body.findNumber === undefined || body.findNumber === null
        ? undefined
        : requirePositiveInt(body.findNumber, 'findNumber');

    // Serialize structure edits (advisory xact lock) so two concurrent adds can't
    // both pass the cycle BFS and persist a cycle the check would have rejected.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-bom-structure'))::text`;

      await assertNoCycle(revision.partId, childPartId, tx);

      const duplicate = await tx.bomLine.findFirst({
        where: { parentRevisionId: revision.id, childPartId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Part is already on this BOM');

      let findNumber: number;
      if (requestedFindNumber === undefined) {
        findNumber = await nextFindNumber(revision.id, tx);
      } else {
        findNumber = requestedFindNumber;
        await assertFindNumberFree(revision.id, findNumber, undefined, tx);
      }

      return tx.bomLine.create({
        data: {
          parentRevisionId: revision.id,
          childPartId,
          findNumber,
          quantity,
          ...(uom !== undefined ? { uom } : {}),
          refDesignators,
          notes,
          effectiveFrom,
          effectiveTo,
        },
        include: lineInclude,
      });
    });
    res.status(201).json(toBomLineDetail(created));
  })
);

// ---------------------------------------------------------------------------
// PATCH /bom-lines/:id — update a BOM line
// ---------------------------------------------------------------------------

router.patch(
  '/bom-lines/:id',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        parentRevisionId: true,
        effectiveFrom: true,
        effectiveTo: true,
        parentRevision: { select: { revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    assertEditable(line.parentRevision);

    const body = bodyOf(req);
    const data: {
      quantity?: number;
      uom?: string;
      findNumber?: number;
      refDesignators?: string | null;
      notes?: string | null;
      effectiveFrom?: Date | null;
      effectiveTo?: Date | null;
    } = {};

    if (body.quantity !== undefined) {
      data.quantity = requirePositiveNumber(body.quantity, 'quantity');
    }
    if (body.uom !== undefined) {
      const uom = optionalUom(body.uom);
      if (uom !== undefined) data.uom = uom;
    }
    if (body.findNumber !== undefined) {
      const findNumber = requirePositiveInt(body.findNumber, 'findNumber');
      await assertFindNumberFree(line.parentRevisionId, findNumber, line.id);
      data.findNumber = findNumber;
    }
    if (body.refDesignators !== undefined) {
      data.refDesignators = optionalNullableText(body.refDesignators, 'refDesignators');
    }
    if (body.notes !== undefined) {
      data.notes = optionalNullableText(body.notes, 'notes');
    }
    if (body.effectiveFrom !== undefined) {
      data.effectiveFrom = parseEffectivityBound(body.effectiveFrom, 'effectiveFrom');
    }
    if (body.effectiveTo !== undefined) {
      data.effectiveTo = parseEffectivityBound(body.effectiveTo, 'effectiveTo');
    }
    // Validate the window that would result from applying this patch.
    assertEffectivityWindow(
      data.effectiveFrom !== undefined ? data.effectiveFrom : line.effectiveFrom,
      data.effectiveTo !== undefined ? data.effectiveTo : line.effectiveTo
    );

    const updated = await prisma.bomLine.update({
      where: { id: line.id },
      data,
      include: lineInclude,
    });
    res.json(toBomLineDetail(updated));
  })
);

// ---------------------------------------------------------------------------
// DELETE /bom-lines/:id
// ---------------------------------------------------------------------------

router.delete(
  '/bom-lines/:id',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        parentRevision: { select: { revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    assertEditable(line.parentRevision);

    await prisma.bomLine.delete({ where: { id: line.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// POST /bom-lines/:id/alternates — rule T5, add an alternate part to a line
// ---------------------------------------------------------------------------

router.post(
  '/bom-lines/:id/alternates',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        childPartId: true,
        parentRevision: { select: { revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    assertEditable(line.parentRevision);

    const body = bodyOf(req);
    const partId = requirePositiveInt(body.partId, 'partId');
    const note = body.note === undefined ? null : optionalNullableText(body.note, 'note');

    if (partId === line.childPartId) {
      throw new HttpError(409, 'Alternate cannot be the same as the BOM line part');
    }

    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');

    const duplicate = await prisma.bomLineAlternate.findFirst({
      where: { bomLineId: line.id, alternatePartId: partId },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, 'Part is already an alternate on this BOM line');

    const created = await prisma.bomLineAlternate.create({
      data: { bomLineId: line.id, alternatePartId: partId, note },
      include: { alternatePart: true },
    });
    res.status(201).json(toAlternateDetail(created));
  })
);

// ---------------------------------------------------------------------------
// DELETE /bom-line-alternates/:id — rule T5, same edit gate as the line
// ---------------------------------------------------------------------------

router.delete(
  '/bom-line-alternates/:id',
  asyncHandler(async (req, res) => {
    const alternateId = idParam(req.params.id);
    const alternate = await prisma.bomLineAlternate.findUnique({
      where: { id: alternateId },
      select: {
        id: true,
        bomLine: {
          select: { parentRevision: { select: { revision: true, lifecycle: true } } },
        },
      },
    });
    if (!alternate) throw new HttpError(404, 'Alternate not found');
    assertEditable(alternate.bomLine.parentRevision);

    await prisma.bomLineAlternate.delete({ where: { id: alternate.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// GET /parts/:id/where-used — every BomLine where the part is the child
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id/where-used',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');

    const lines = await prisma.bomLine.findMany({
      where: { childPartId: partId },
      orderBy: { parentRevisionId: 'desc' },
      include: {
        parentRevision: {
          select: {
            id: true,
            revision: true,
            lifecycle: true,
            part: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
    });

    const entries: WhereUsedEntry[] = lines.map((line) => ({
      line: {
        id: line.id,
        findNumber: line.findNumber,
        quantity: line.quantity,
        uom: line.uom,
      },
      parentRevision: toRevisionRef(line.parentRevision),
      parentPart: {
        id: line.parentRevision.part.id,
        partNumber: line.parentRevision.part.partNumber,
        name: line.parentRevision.part.name,
      },
    }));
    res.json(entries);
  })
);

export default router;
