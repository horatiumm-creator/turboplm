import { Router } from 'express';
import { EcnStatus, Lifecycle, PartCategory, RequirementStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';

/**
 * Rule I5 — programme analytics. Everything is derived from a handful of broad
 * queries (issued in parallel) and aggregated in memory: the data volumes here
 * are small, and one pass beats dozens of round trips.
 */

const router = Router();
router.use(requireAuth);

const DAY_MS = 86400000;
const RELEASED_WINDOW_DAYS = 90;
const THROUGHPUT_MONTHS = 6;
const TOP_COST_DRIVERS = 5;
/** Same depth cap as the cost roll-up (rule T8) in routes/cost.ts. */
const MAX_DEPTH = 15;

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

interface AnalyticsKpisDto {
  changeCycle: {
    releasedLast90: number;
    avgDraftToReleaseDays: number | null;
    avgReviewDays: number | null;
    openByStatus: Record<EcnStatus, number>;
  };
  bomHealth: {
    partsTotal: number;
    partsNeverReleased: number;
    partsMissingCost: number;
    revisionsInWork: number;
    releasedWithUnreleasedChildren: number;
  };
  requirements: { total: number; covered: number; approved: number };
  throughput: { month: string; created: number; released: number }[];
  topCostDrivers: { part: PartRefDto; rolledCost: number }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Mean of a list of millisecond spans, expressed in days to 1 decimal. */
function averageDays(spans: number[]): number | null {
  if (spans.length === 0) return null;
  const mean = spans.reduce((sum, span) => sum + span, 0) / spans.length / DAY_MS;
  return Math.round(mean * 10) / 10;
}

/** Calendar month bucket key, 'YYYY-MM' (UTC, so buckets are server-TZ stable). */
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

type CostInput = {
  parts: { id: number; unitCost: number | null }[];
  /** partId → resolved (latest RELEASED, else latest) revision id. */
  resolvedRevisionByPart: Map<number, number>;
  /** revisionId → its own BOM lines. */
  linesByRevision: Map<number, { childPartId: number; quantity: number }[]>;
};

/** A rolled cost plus whether it was computed without truncating the walk. */
interface RolledCost {
  cost: number | null;
  exact: boolean;
}

/**
 * Rule T8 roll-up, replicated over the in-memory structure (cost.ts keeps its
 * traversal private and is per-revision; this one answers "what does every part
 * roll up to"). Same semantics: a part's rolled cost is its unitCost when set,
 * otherwise the sum of its resolved children's extended costs — null as soon as
 * any contributor is unknown.
 *
 * Depth-capped and cycle-safe: a branch that revisits a part already on the
 * stack, or that exceeds the depth cap, stops there (like the cycle/depth stop
 * in the tree walk, such a node simply has no children). Results are memoized,
 * but only when they were reached without truncation — a truncated value is
 * specific to the branch it was computed on and must not be reused.
 */
function createRollup({
  parts,
  resolvedRevisionByPart,
  linesByRevision,
}: CostInput): (partId: number) => number | null {
  const unitCostByPart = new Map(parts.map((part) => [part.id, part.unitCost]));
  const memo = new Map<number, number | null>();
  const stack = new Set<number>();

  function walk(partId: number, depth: number): RolledCost {
    const cached = memo.get(partId);
    if (cached !== undefined) return { cost: cached, exact: true };

    const unitCost = unitCostByPart.get(partId) ?? null;
    if (unitCost !== null) {
      memo.set(partId, unitCost);
      return { cost: unitCost, exact: true };
    }
    if (stack.has(partId) || depth > MAX_DEPTH) return { cost: null, exact: false };

    const revisionId = resolvedRevisionByPart.get(partId);
    const lines = revisionId === undefined ? [] : (linesByRevision.get(revisionId) ?? []);
    if (lines.length === 0) {
      memo.set(partId, null);
      return { cost: null, exact: true };
    }

    stack.add(partId);
    let total: number | null = 0;
    let exact = true;
    for (const line of lines) {
      const child = walk(line.childPartId, depth + 1);
      if (!child.exact) exact = false;
      if (child.cost === null) total = null;
      else if (total !== null) total += child.cost * line.quantity;
    }
    stack.delete(partId);

    if (exact) memo.set(partId, total);
    return { cost: total, exact };
  }

  return (partId: number) => walk(partId, 1).cost;
}

// ---------------------------------------------------------------------------
// GET /analytics
// ---------------------------------------------------------------------------

router.get(
  '/analytics',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const releasedSince = now.getTime() - RELEASED_WINDOW_DAYS * DAY_MS;

    const [ecns, parts, revisions, bomLines, requirementTotal, requirementApproved, coveredLinks] =
      await Promise.all([
        prisma.ecn.findMany({
          select: { status: true, createdAt: true, approvedAt: true, releasedAt: true },
        }),
        prisma.part.findMany({
          select: {
            id: true,
            partNumber: true,
            name: true,
            category: true,
            uom: true,
            unitCost: true,
          },
        }),
        prisma.partRevision.findMany({ select: { id: true, partId: true, lifecycle: true } }),
        prisma.bomLine.findMany({
          select: { parentRevisionId: true, childPartId: true, quantity: true },
        }),
        prisma.requirement.count(),
        prisma.requirement.count({ where: { status: RequirementStatus.APPROVED } }),
        prisma.requirementLink.findMany({
          where: { partId: { not: null } },
          select: { requirementId: true },
          distinct: ['requirementId'],
        }),
      ]);

    // ---- change cycle + throughput (one pass over the ECNs) ----------------

    // Every EcnStatus key is present, zero-filled.
    const openByStatus: Record<EcnStatus, number> = {
      DRAFT: 0,
      IN_REVIEW: 0,
      APPROVED: 0,
      RELEASED: 0,
      CANCELLED: 0,
    };

    const throughput: { month: string; created: number; released: number }[] = [];
    const bucketByMonth = new Map<string, { month: string; created: number; released: number }>();
    for (let back = THROUGHPUT_MONTHS - 1; back >= 0; back -= 1) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const bucket = { month: monthKey(start), created: 0, released: 0 };
      throughput.push(bucket);
      bucketByMonth.set(bucket.month, bucket);
    }

    let releasedLast90 = 0;
    const draftToReleaseSpans: number[] = [];
    const reviewSpans: number[] = [];

    for (const ecn of ecns) {
      openByStatus[ecn.status] += 1;

      const createdBucket = bucketByMonth.get(monthKey(ecn.createdAt));
      if (createdBucket) createdBucket.created += 1;

      if (ecn.releasedAt) {
        draftToReleaseSpans.push(ecn.releasedAt.getTime() - ecn.createdAt.getTime());
        if (ecn.releasedAt.getTime() >= releasedSince) releasedLast90 += 1;
        const releasedBucket = bucketByMonth.get(monthKey(ecn.releasedAt));
        if (releasedBucket) releasedBucket.released += 1;
      }
      if (ecn.approvedAt) {
        reviewSpans.push(ecn.approvedAt.getTime() - ecn.createdAt.getTime());
      }
    }

    // ---- structure indexes -------------------------------------------------

    const releasedPartIds = new Set<number>();
    const revisionsByPart = new Map<number, { id: number; lifecycle: Lifecycle }[]>();
    let revisionsInWork = 0;

    for (const revision of revisions) {
      if (revision.lifecycle === Lifecycle.IN_WORK) revisionsInWork += 1;
      if (revision.lifecycle === Lifecycle.RELEASED) releasedPartIds.add(revision.partId);
      const siblings = revisionsByPart.get(revision.partId);
      if (siblings) siblings.push(revision);
      else revisionsByPart.set(revision.partId, [revision]);
    }

    // Rule 5 — resolved revision: latest RELEASED, else latest overall.
    const resolvedRevisionByPart = new Map<number, number>();
    for (const [partId, siblings] of revisionsByPart) {
      const resolved = resolveDisplayRevision(siblings);
      if (resolved) resolvedRevisionByPart.set(partId, resolved.id);
    }

    const linesByRevision = new Map<number, { childPartId: number; quantity: number }[]>();
    for (const line of bomLines) {
      const siblings = linesByRevision.get(line.parentRevisionId);
      if (siblings) siblings.push(line);
      else linesByRevision.set(line.parentRevisionId, [line]);
    }

    // ---- BOM health --------------------------------------------------------

    let releasedWithUnreleasedChildren = 0;
    for (const revision of revisions) {
      if (revision.lifecycle !== Lifecycle.RELEASED) continue;
      const lines = linesByRevision.get(revision.id);
      if (!lines) continue;
      if (lines.some((line) => !releasedPartIds.has(line.childPartId))) {
        releasedWithUnreleasedChildren += 1;
      }
    }

    // ---- top cost drivers --------------------------------------------------

    const rolledCostOf = createRollup({ parts, resolvedRevisionByPart, linesByRevision });
    type CostDriver = { part: PartRefDto; rolledCost: number };
    const topCostDrivers = parts
      .map((part) => ({ part: toPartRef(part), rolledCost: rolledCostOf(part.id) }))
      .filter((entry): entry is CostDriver => entry.rolledCost !== null)
      .sort(
        (a, b) => b.rolledCost - a.rolledCost || a.part.partNumber.localeCompare(b.part.partNumber)
      )
      .slice(0, TOP_COST_DRIVERS);

    const payload: AnalyticsKpisDto = {
      changeCycle: {
        releasedLast90,
        avgDraftToReleaseDays: averageDays(draftToReleaseSpans),
        avgReviewDays: averageDays(reviewSpans),
        openByStatus,
      },
      bomHealth: {
        partsTotal: parts.length,
        partsNeverReleased: parts.filter((part) => !releasedPartIds.has(part.id)).length,
        partsMissingCost: parts.filter((part) => part.unitCost === null).length,
        revisionsInWork,
        releasedWithUnreleasedChildren,
      },
      requirements: {
        total: requirementTotal,
        covered: coveredLinks.length,
        approved: requirementApproved,
      },
      throughput,
      topCostDrivers,
    };
    res.json(payload);
  })
);

export default router;
