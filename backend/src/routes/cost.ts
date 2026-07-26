import { Router } from 'express';
import { Lifecycle, PartCategory } from '@prisma/client';
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

interface CostRollupNodeDto {
  part: PartRefDto;
  quantity: number;
  unitCost: number | null;
  /** unitCost when set, else the sum of children's extended costs (null if unknowable). */
  effectiveUnitCost: number | null;
  extendedCost: number | null;
  missing: boolean;
  children: CostRollupNodeDto[];
}

interface CostRollupDto {
  revision: RevisionRefDto;
  part: PartRefDto;
  totalCost: number | null;
  missingCosts: string[];
  nodes: CostRollupNodeDto[];
}

// ---------------------------------------------------------------------------
// Data access + helpers
// ---------------------------------------------------------------------------

const lineInclude = {
  childPart: {
    include: { revisions: { select: { id: true, revision: true, lifecycle: true } } },
  },
} as const;

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

/** Sum a list of costs; null when any entry is null (unknowable). Empty → 0. */
function sumOrNull(values: (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Roll-up traversal (rule T8) — resolved revisions, depth cap, cycle-stop
// ---------------------------------------------------------------------------

async function buildCostLevel(
  parentRevisionId: number,
  ancestorPartIds: ReadonlySet<number>,
  depth: number,
  missingCosts: Set<string>
): Promise<CostRollupNodeDto[]> {
  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId },
    orderBy: { findNumber: 'asc' },
    include: lineInclude,
  });

  const nodes: CostRollupNodeDto[] = [];
  for (const line of lines) {
    const resolved = resolveDisplayRevision(line.childPart.revisions);
    const cycle = ancestorPartIds.has(line.childPartId);
    let children: CostRollupNodeDto[] = [];
    if (!cycle && resolved && depth < MAX_DEPTH) {
      const branch = new Set(ancestorPartIds);
      branch.add(line.childPartId);
      children = await buildCostLevel(resolved.id, branch, depth + 1, missingCosts);
    }

    const unitCost = line.childPart.unitCost;
    const effectiveUnitCost =
      unitCost !== null
        ? unitCost
        : children.length === 0
          ? null
          : sumOrNull(children.map((child) => child.extendedCost));
    const extendedCost = effectiveUnitCost === null ? null : effectiveUnitCost * line.quantity;

    const missing = unitCost === null && children.length === 0;
    if (missing) missingCosts.add(line.childPart.partNumber);

    nodes.push({
      part: toPartRef(line.childPart),
      quantity: line.quantity,
      unitCost,
      effectiveUnitCost,
      extendedCost,
      missing,
      children,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// GET /revisions/:id/cost-rollup
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id/cost-rollup',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      include: { part: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const missingCosts = new Set<string>();
    const nodes = await buildCostLevel(revision.id, new Set([revision.partId]), 1, missingCosts);

    const result: CostRollupDto = {
      revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
      part: toPartRef(revision.part),
      totalCost: sumOrNull(nodes.map((node) => node.extendedCost)),
      missingCosts: [...missingCosts].sort(),
      nodes,
    };
    res.json(result);
  })
);

export default router;
