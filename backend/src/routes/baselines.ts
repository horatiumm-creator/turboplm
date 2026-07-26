import { Request, Router } from 'express';
import { Lifecycle, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';

const router = Router();
router.use(requireAuth);

const MAX_DEPTH = 15;

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

interface BaselineSummaryDto {
  id: number;
  name: string;
  description: string | null;
  part: PartRefDto;
  revision: RevisionRefDto;
  lineCount: number;
  createdBy: UserRefDto;
  createdAt: string;
}

interface BaselineLineNodeDto {
  part: PartRefDto;
  revisionLabel: string;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  children: BaselineLineNodeDto[];
}

interface BaselineDetailDto extends BaselineSummaryDto {
  nodes: BaselineLineNodeDto[];
}

type CompareStatus = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';

/** BomCompareSide in baseline mode: label snapshot only, no live revision/notes. */
interface CompareSideDto {
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: null;
  revision: null;
  revisionLabel: string;
}

interface CompareNodeDto {
  part: PartRefDto;
  status: CompareStatus;
  changedFields: string[];
  left: CompareSideDto | null;
  right: CompareSideDto | null;
  cycle: boolean;
  children: CompareNodeDto[];
}

// ---------------------------------------------------------------------------
// Fetch shapes + mappers
// ---------------------------------------------------------------------------

const baselineSummaryInclude = {
  partRevision: { include: { part: true } },
  createdBy: { select: { id: true, name: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.BaselineInclude;

const baselineLineInclude = { part: true } satisfies Prisma.BaselineLineInclude;

type BaselineSummaryRow = Prisma.BaselineGetPayload<{ include: typeof baselineSummaryInclude }>;
type BaselineLineRow = Prisma.BaselineLineGetPayload<{ include: typeof baselineLineInclude }>;

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

function toBaselineSummary(row: BaselineSummaryRow): BaselineSummaryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    part: toPartRef(row.partRevision.part),
    revision: {
      id: row.partRevision.id,
      revision: row.partRevision.revision,
      lifecycle: row.partRevision.lifecycle,
    },
    lineCount: row._count.lines,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    createdAt: row.createdAt.toISOString(),
  };
}

/** Stored rows sorted (sortOrder asc) → children grouped by parentLineId. */
function groupByParent(lines: BaselineLineRow[]): Map<number | null, BaselineLineRow[]> {
  const byParent = new Map<number | null, BaselineLineRow[]>();
  for (const line of lines) {
    const siblings = byParent.get(line.parentLineId);
    if (siblings) siblings.push(line);
    else byParent.set(line.parentLineId, [line]);
  }
  return byParent;
}

function buildNodes(
  byParent: Map<number | null, BaselineLineRow[]>,
  parentLineId: number | null
): BaselineLineNodeDto[] {
  return (byParent.get(parentLineId) ?? []).map((line) => ({
    part: toPartRef(line.part),
    revisionLabel: line.revisionLabel,
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    children: buildNodes(byParent, line.id),
  }));
}

async function fetchBaselineLines(baselineId: number): Promise<BaselineLineRow[]> {
  return prisma.baselineLine.findMany({
    where: { baselineId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: baselineLineInclude,
  });
}

async function getBaselineDetailOrThrow(id: number): Promise<BaselineDetailDto> {
  const row = await prisma.baseline.findUnique({ where: { id }, include: baselineSummaryInclude });
  if (!row) throw new HttpError(404, 'Baseline not found');
  const lines = await fetchBaselineLines(id);
  return { ...toBaselineSummary(row), nodes: buildNodes(groupByParent(lines), null) };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUser(req: Request): { id: number; role: string } {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user;
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'name is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) throw new HttpError(400, 'name must be at most 120 characters');
  return trimmed;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requirePositiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Live-structure snapshot (rule T6) — same traversal as GET /revisions/:id/bom/tree
// ---------------------------------------------------------------------------

const liveLineInclude = {
  childPart: {
    include: { revisions: { select: { id: true, revision: true, lifecycle: true } } },
  },
} as const;

interface SnapshotNode {
  partId: number;
  revisionLabel: string;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  children: SnapshotNode[];
}

async function buildSnapshotLevel(
  parentRevisionId: number,
  ancestorPartIds: ReadonlySet<number>,
  depth: number
): Promise<SnapshotNode[]> {
  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId },
    orderBy: { findNumber: 'asc' },
    include: liveLineInclude,
  });

  const nodes: SnapshotNode[] = [];
  for (const line of lines) {
    const resolved = resolveDisplayRevision(line.childPart.revisions);
    const cycle = ancestorPartIds.has(line.childPartId);
    let children: SnapshotNode[] = [];
    if (!cycle && resolved && depth < MAX_DEPTH) {
      const branch = new Set(ancestorPartIds);
      branch.add(line.childPartId);
      children = await buildSnapshotLevel(resolved.id, branch, depth + 1);
    }
    nodes.push({
      partId: line.childPartId,
      revisionLabel: resolved ? resolved.revision : '',
      findNumber: line.findNumber,
      quantity: line.quantity,
      uom: line.uom,
      refDesignators: line.refDesignators,
      children,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// GET /baselines — list with search + pagination
// ---------------------------------------------------------------------------

router.get(
  '/baselines',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where: Prisma.BaselineWhereInput = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { partRevision: { part: { partNumber: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.baseline.count({ where }),
      prisma.baseline.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: baselineSummaryInclude,
      }),
    ]);

    res.json({ items: rows.map(toBaselineSummary), total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /baselines — snapshot a revision's resolved structure (rule T6)
// ---------------------------------------------------------------------------

router.post(
  '/baselines',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const user = currentUser(req);

    const partRevisionId = requirePositiveInt(body.partRevisionId, 'partRevisionId');
    const name = requireName(body.name);
    const description =
      body.description === undefined ? null : optionalNullableText(body.description, 'description');

    const revision = await prisma.partRevision.findUnique({
      where: { id: partRevisionId },
      select: { id: true, partId: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    // Walk the live structure (resolved revisions, depth cap, cycle-stop) …
    const snapshot = await buildSnapshotLevel(revision.id, new Set([revision.partId]), 1);

    // … then persist the whole snapshot atomically (parentLineId tree,
    // sortOrder = sibling index).
    const createdId = await prisma.$transaction(async (tx) => {
      const baseline = await tx.baseline.create({
        data: { name, description, partRevisionId: revision.id, createdById: user.id },
        select: { id: true },
      });

      const insertLevel = async (
        nodes: SnapshotNode[],
        parentLineId: number | null
      ): Promise<void> => {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const line = await tx.baselineLine.create({
            data: {
              baselineId: baseline.id,
              parentLineId,
              partId: node.partId,
              revisionLabel: node.revisionLabel,
              findNumber: node.findNumber,
              quantity: node.quantity,
              uom: node.uom,
              refDesignators: node.refDesignators,
              sortOrder: i,
            },
            select: { id: true },
          });
          await insertLevel(node.children, line.id);
        }
      };
      await insertLevel(snapshot, null);
      return baseline.id;
    });

    res.status(201).json(await getBaselineDetailOrThrow(createdId));
  })
);

// ---------------------------------------------------------------------------
// GET /baselines/:id — rebuild nodes from the stored rows
// ---------------------------------------------------------------------------

router.get(
  '/baselines/:id',
  asyncHandler(async (req, res) => {
    res.json(await getBaselineDetailOrThrow(idParam(req.params.id)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /baselines/:id — creator or admin only (rule T9)
// ---------------------------------------------------------------------------

router.delete(
  '/baselines/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = currentUser(req);

    const baseline = await prisma.baseline.findUnique({
      where: { id },
      select: { id: true, createdById: true },
    });
    if (!baseline) throw new HttpError(404, 'Baseline not found');
    if (baseline.createdById !== user.id && user.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the creator or an administrator can delete this baseline');
    }

    await prisma.baseline.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// GET /baseline-compare?left=&right= — align two stored trees by part id
// ---------------------------------------------------------------------------

interface StoredNode {
  line: BaselineLineRow;
  children: StoredNode[];
}

function buildStoredTree(
  byParent: Map<number | null, BaselineLineRow[]>,
  parentLineId: number | null
): StoredNode[] {
  return (byParent.get(parentLineId) ?? []).map((line) => ({
    line,
    children: buildStoredTree(byParent, line.id),
  }));
}

function toSide(line: BaselineLineRow): CompareSideDto {
  return {
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    notes: null,
    revision: null,
    revisionLabel: line.revisionLabel,
  };
}

/** Expand one side of an ADDED/REMOVED subtree — every descendant gets the same status. */
function buildOneSided(
  nodes: StoredNode[],
  side: 'left' | 'right',
  status: 'ADDED' | 'REMOVED',
  ancestors: ReadonlySet<number>,
  counts: Record<CompareStatus, number>
): CompareNodeDto[] {
  return nodes.map((node) => {
    const cycle = ancestors.has(node.line.partId);
    counts[status] += 1;
    let children: CompareNodeDto[] = [];
    if (!cycle) {
      const branch = new Set(ancestors);
      branch.add(node.line.partId);
      children = buildOneSided(node.children, side, status, branch, counts);
    }
    const sideDto = toSide(node.line);
    return {
      part: toPartRef(node.line.part),
      status,
      changedFields: [],
      left: side === 'left' ? sideDto : null,
      right: side === 'right' ? sideDto : null,
      cycle,
      children,
    };
  });
}

/** Compare two stored levels, aligning by part id (same semantics as /bom-compare). */
function buildCompareLevel(
  leftNodes: StoredNode[],
  rightNodes: StoredNode[],
  ancestors: ReadonlySet<number>,
  counts: Record<CompareStatus, number>
): CompareNodeDto[] {
  const rightByPart = new Map(rightNodes.map((node) => [node.line.partId, node]));
  const nodes: CompareNodeDto[] = [];

  for (const leftNode of leftNodes) {
    const partId = leftNode.line.partId;
    const rightNode = rightByPart.get(partId);
    const cycle = ancestors.has(partId);

    if (!rightNode) {
      // REMOVED — expand the left subtree one-sided.
      counts.REMOVED += 1;
      let children: CompareNodeDto[] = [];
      if (!cycle) {
        const branch = new Set(ancestors);
        branch.add(partId);
        children = buildOneSided(leftNode.children, 'left', 'REMOVED', branch, counts);
      }
      nodes.push({
        part: toPartRef(leftNode.line.part),
        status: 'REMOVED',
        changedFields: [],
        left: toSide(leftNode.line),
        right: null,
        cycle,
        children,
      });
      continue;
    }

    rightByPart.delete(partId);

    const changedFields: string[] = [];
    if (leftNode.line.quantity !== rightNode.line.quantity) changedFields.push('quantity');
    if (leftNode.line.uom !== rightNode.line.uom) changedFields.push('uom');
    if (leftNode.line.findNumber !== rightNode.line.findNumber) changedFields.push('findNumber');
    if ((leftNode.line.refDesignators ?? null) !== (rightNode.line.refDesignators ?? null))
      changedFields.push('refDesignators');
    if (leftNode.line.revisionLabel !== rightNode.line.revisionLabel)
      changedFields.push('revision');

    const status: CompareStatus = changedFields.length > 0 ? 'CHANGED' : 'UNCHANGED';
    counts[status] += 1;

    let children: CompareNodeDto[] = [];
    if (!cycle) {
      const branch = new Set(ancestors);
      branch.add(partId);
      children = buildCompareLevel(leftNode.children, rightNode.children, branch, counts);
    }

    nodes.push({
      part: toPartRef(leftNode.line.part),
      status,
      changedFields,
      left: toSide(leftNode.line),
      right: toSide(rightNode.line),
      cycle,
      children,
    });
  }

  // Remaining right nodes are ADDED.
  for (const rightNode of rightByPart.values()) {
    const cycle = ancestors.has(rightNode.line.partId);
    counts.ADDED += 1;
    let children: CompareNodeDto[] = [];
    if (!cycle) {
      const branch = new Set(ancestors);
      branch.add(rightNode.line.partId);
      children = buildOneSided(rightNode.children, 'right', 'ADDED', branch, counts);
    }
    nodes.push({
      part: toPartRef(rightNode.line.part),
      status: 'ADDED',
      changedFields: [],
      left: null,
      right: toSide(rightNode.line),
      cycle,
      children,
    });
  }

  return nodes;
}

router.get(
  '/baseline-compare',
  asyncHandler(async (req, res) => {
    const left = Number(req.query.left);
    const right = Number(req.query.right);
    if (!Number.isInteger(left) || left <= 0 || !Number.isInteger(right) || right <= 0) {
      throw new HttpError(400, 'left and right baseline ids are required');
    }

    const [leftRow, rightRow] = await Promise.all(
      [left, right].map((id) =>
        prisma.baseline.findUnique({ where: { id }, include: baselineSummaryInclude })
      )
    );
    if (!leftRow) throw new HttpError(404, 'Left baseline not found');
    if (!rightRow) throw new HttpError(404, 'Right baseline not found');

    const [leftLines, rightLines] = await Promise.all([
      fetchBaselineLines(leftRow.id),
      fetchBaselineLines(rightRow.id),
    ]);
    const leftTree = buildStoredTree(groupByParent(leftLines), null);
    const rightTree = buildStoredTree(groupByParent(rightLines), null);

    const counts: Record<CompareStatus, number> = {
      ADDED: 0,
      REMOVED: 0,
      CHANGED: 0,
      UNCHANGED: 0,
    };
    // Seed the ancestor set with both root parts to stop immediate self-cycles.
    const nodes = buildCompareLevel(
      leftTree,
      rightTree,
      new Set([leftRow.partRevision.partId, rightRow.partRevision.partId]),
      counts
    );

    res.json({
      left: toBaselineSummary(leftRow),
      right: toBaselineSummary(rightRow),
      summary: {
        added: counts.ADDED,
        removed: counts.REMOVED,
        changed: counts.CHANGED,
        unchanged: counts.UNCHANGED,
      },
      nodes,
    });
  })
);

export default router;
