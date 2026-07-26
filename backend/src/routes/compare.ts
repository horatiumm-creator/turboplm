import { Router } from 'express';
import { Lifecycle, PartCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';

const router = Router();
router.use(requireAuth);

const MAX_DEPTH = 15;

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

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

type CompareStatus = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';

interface CompareSideDto {
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  revision: RevisionRefDto | null;
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
// Data access
// ---------------------------------------------------------------------------

const lineInclude = {
  childPart: {
    include: { revisions: { select: { id: true, revision: true, lifecycle: true } } },
  },
} as const;

type LineRow = NonNullable<Awaited<ReturnType<typeof fetchLines>>>[number];

async function fetchLines(parentRevisionId: number) {
  return prisma.bomLine.findMany({
    where: { parentRevisionId },
    orderBy: { findNumber: 'asc' },
    include: lineInclude,
  });
}

function toPartRef(part: LineRow['childPart']): PartRefDto {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toSide(
  line: LineRow,
  resolved: { id: number; revision: string; lifecycle: Lifecycle } | null
): CompareSideDto {
  return {
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    notes: line.notes,
    revision: resolved
      ? { id: resolved.id, revision: resolved.revision, lifecycle: resolved.lifecycle }
      : null,
  };
}

/** Expand one side of an ADDED/REMOVED subtree — every descendant gets the same status. */
async function buildOneSided(
  parentRevisionId: number,
  side: 'left' | 'right',
  status: 'ADDED' | 'REMOVED',
  ancestors: ReadonlySet<number>,
  depth: number,
  counts: Record<CompareStatus, number>
): Promise<CompareNodeDto[]> {
  const lines = await fetchLines(parentRevisionId);
  const nodes: CompareNodeDto[] = [];
  for (const line of lines) {
    const resolved = resolveDisplayRevision(line.childPart.revisions);
    const cycle = ancestors.has(line.childPartId);
    counts[status] += 1;
    let children: CompareNodeDto[] = [];
    if (!cycle && resolved && depth < MAX_DEPTH) {
      const branch = new Set(ancestors);
      branch.add(line.childPartId);
      children = await buildOneSided(resolved.id, side, status, branch, depth + 1, counts);
    }
    const sideDto = toSide(line, resolved);
    nodes.push({
      part: toPartRef(line.childPart),
      status,
      changedFields: [],
      left: side === 'left' ? sideDto : null,
      right: side === 'right' ? sideDto : null,
      cycle,
      children,
    });
  }
  return nodes;
}

/** Compare the children of two revisions, aligning by child part id. */
async function buildCompareLevel(
  leftRevisionId: number,
  rightRevisionId: number,
  ancestors: ReadonlySet<number>,
  depth: number,
  counts: Record<CompareStatus, number>
): Promise<CompareNodeDto[]> {
  const [leftLines, rightLines] = await Promise.all([
    fetchLines(leftRevisionId),
    fetchLines(rightRevisionId),
  ]);
  const rightByPart = new Map(rightLines.map((line) => [line.childPartId, line]));
  const nodes: CompareNodeDto[] = [];

  for (const leftLine of leftLines) {
    const rightLine = rightByPart.get(leftLine.childPartId);
    const leftResolved = resolveDisplayRevision(leftLine.childPart.revisions);
    const cycle = ancestors.has(leftLine.childPartId);

    if (!rightLine) {
      // REMOVED — expand the left subtree one-sided.
      counts.REMOVED += 1;
      let children: CompareNodeDto[] = [];
      if (!cycle && leftResolved && depth < MAX_DEPTH) {
        const branch = new Set(ancestors);
        branch.add(leftLine.childPartId);
        children = await buildOneSided(
          leftResolved.id,
          'left',
          'REMOVED',
          branch,
          depth + 1,
          counts
        );
      }
      nodes.push({
        part: toPartRef(leftLine.childPart),
        status: 'REMOVED',
        changedFields: [],
        left: toSide(leftLine, leftResolved),
        right: null,
        cycle,
        children,
      });
      continue;
    }

    rightByPart.delete(leftLine.childPartId);
    const rightResolved = resolveDisplayRevision(rightLine.childPart.revisions);

    const changedFields: string[] = [];
    if (leftLine.quantity !== rightLine.quantity) changedFields.push('quantity');
    if (leftLine.uom !== rightLine.uom) changedFields.push('uom');
    if (leftLine.findNumber !== rightLine.findNumber) changedFields.push('findNumber');
    if ((leftLine.refDesignators ?? null) !== (rightLine.refDesignators ?? null))
      changedFields.push('refDesignators');
    if ((leftLine.notes ?? null) !== (rightLine.notes ?? null)) changedFields.push('notes');
    if ((leftResolved?.id ?? null) !== (rightResolved?.id ?? null)) changedFields.push('revision');

    const status: CompareStatus = changedFields.length > 0 ? 'CHANGED' : 'UNCHANGED';
    counts[status] += 1;

    let children: CompareNodeDto[] = [];
    if (!cycle && depth < MAX_DEPTH) {
      const branch = new Set(ancestors);
      branch.add(leftLine.childPartId);
      if (leftResolved && rightResolved) {
        children = await buildCompareLevel(
          leftResolved.id,
          rightResolved.id,
          branch,
          depth + 1,
          counts
        );
      } else if (leftResolved) {
        children = await buildOneSided(leftResolved.id, 'left', 'REMOVED', branch, depth + 1, counts);
      } else if (rightResolved) {
        children = await buildOneSided(rightResolved.id, 'right', 'ADDED', branch, depth + 1, counts);
      }
    }

    nodes.push({
      part: toPartRef(leftLine.childPart),
      status,
      changedFields,
      left: toSide(leftLine, leftResolved),
      right: toSide(rightLine, rightResolved),
      cycle,
      children,
    });
  }

  // Remaining right lines are ADDED.
  for (const rightLine of rightByPart.values()) {
    const rightResolved = resolveDisplayRevision(rightLine.childPart.revisions);
    const cycle = ancestors.has(rightLine.childPartId);
    counts.ADDED += 1;
    let children: CompareNodeDto[] = [];
    if (!cycle && rightResolved && depth < MAX_DEPTH) {
      const branch = new Set(ancestors);
      branch.add(rightLine.childPartId);
      children = await buildOneSided(rightResolved.id, 'right', 'ADDED', branch, depth + 1, counts);
    }
    nodes.push({
      part: toPartRef(rightLine.childPart),
      status: 'ADDED',
      changedFields: [],
      left: null,
      right: toSide(rightLine, rightResolved),
      cycle,
      children,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// GET /bom-compare?left=&right=
// ---------------------------------------------------------------------------

router.get(
  '/bom-compare',
  asyncHandler(async (req, res) => {
    const left = Number(req.query.left);
    const right = Number(req.query.right);
    if (!Number.isInteger(left) || left <= 0 || !Number.isInteger(right) || right <= 0) {
      throw new HttpError(400, 'left and right revision ids are required');
    }

    const [leftRev, rightRev] = await Promise.all(
      [left, right].map((id) =>
        prisma.partRevision.findUnique({
          where: { id },
          include: { part: true },
        })
      )
    );
    if (!leftRev) throw new HttpError(404, 'Left revision not found');
    if (!rightRev) throw new HttpError(404, 'Right revision not found');

    const counts: Record<CompareStatus, number> = {
      ADDED: 0,
      REMOVED: 0,
      CHANGED: 0,
      UNCHANGED: 0,
    };
    // Seed the ancestor set with both root parts to stop immediate self-cycles.
    const nodes = await buildCompareLevel(
      leftRev.id,
      rightRev.id,
      new Set([leftRev.partId, rightRev.partId]),
      1,
      counts
    );

    const toEnd = (rev: typeof leftRev) => ({
      revision: { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle },
      part: {
        id: rev.part.id,
        partNumber: rev.part.partNumber,
        name: rev.part.name,
        category: rev.part.category,
        uom: rev.part.uom,
      },
    });

    res.json({
      left: toEnd(leftRev),
      right: toEnd(rightRev),
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
