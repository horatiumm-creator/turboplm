import { Request, Router } from 'express';
import { EcnStatus, Lifecycle, PartCategory, RequirementStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { resolveDisplayRevision } from '../lib/plm';
import { AclUser, aclFilter } from '../lib/acl';

/**
 * Rule I5 — programme analytics. Everything is derived from a handful of broad
 * queries (issued in parallel) and aggregated in memory: the data volumes here
 * are small, and one pass beats dozens of round trips.
 *
 * Rules X3/X4 make that "handful of broad queries" the exposure: every one of
 * them sweeps a whole table, so an unfiltered query here leaks every restricted
 * item in the database at once, in aggregate. Two different treatments apply and
 * the distinction matters:
 *
 *  - **Counts and averages are scoped.** The KPI *is* the number, so restricting
 *    the population makes it complete for this caller. Annotating it with what
 *    was excluded would republish the existence fact the grant withholds.
 *  - **The cost roll-up is annotated, not scoped.** Here the number is a total of
 *    contributions, so dropping a hidden child would understate it silently — the
 *    failure X4 exists to prevent. A hidden contributor makes the total *unknown*
 *    (exactly as an unpriced child already does under rule T8) and is counted in
 *    `redactedCount`, so an incomplete ranking is never read as complete.
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
  /**
   * Rule X4 — distinct parts that a BOM in scope references but this caller may
   * not see. Non-zero means the structural findings above (the cost ranking and
   * `releasedWithUnreleasedChildren`) had contributors they could not evaluate,
   * so they are lower bounds rather than complete figures. Zero for an ADMIN, and
   * zero on an install where nothing is restricted.
   */
  redactedCount: number;
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
  /** Ids of the parts this caller may read; everything else is a hidden child. */
  visiblePartIds: ReadonlySet<number>;
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
 *
 * Rule X4: a line whose child is hidden from this caller keeps its place in the
 * sum as an *unknown* contribution, which nulls the parent's total exactly as an
 * unpriced child does. It is never skipped. Skipping would produce a smaller
 * number that still looks authoritative — the caller would have no way to tell a
 * cheap assembly from a censored one, and the roll-up would be wrong in the
 * direction nobody checks. Memoizing this is safe because visibility is fixed for
 * the duration of one request.
 */
function createRollup({
  parts,
  resolvedRevisionByPart,
  linesByRevision,
  visiblePartIds,
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
      // A hidden child contributes an unknown cost. Note this must be decided
      // before recursing: the walk would otherwise "price" it at null anyway, but
      // only by accident of its lines being absent, and it would read its unit
      // cost if one were ever loaded.
      if (!visiblePartIds.has(line.childPartId)) {
        total = null;
        continue;
      }
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

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const now = new Date();
    const releasedSince = now.getTime() - RELEASED_WINDOW_DAYS * DAY_MS;

    const [ecns, parts, revisions, bomLines, requirementTotal, requirementApproved, coveredLinks] =
      await Promise.all([
        prisma.ecn.findMany({
          where: { ...aclFilter('ECN', user) },
          select: { status: true, createdAt: true, approvedAt: true, releasedAt: true },
        }),
        // This result set doubles as the visibility oracle for the roll-up below:
        // it is every part this caller may read, so a part id missing from it is
        // hidden (or gone).
        prisma.part.findMany({
          where: { ...aclFilter('PART', user) },
          select: {
            id: true,
            partNumber: true,
            name: true,
            category: true,
            uom: true,
            unitCost: true,
          },
        }),
        prisma.partRevision.findMany({
          where: { part: { ...aclFilter('PART', user) } },
          select: { id: true, partId: true, lifecycle: true },
        }),
        // Filtered by the *parent* only. The child is deliberately left alone:
        // filtering on `childPart` would delete hidden lines from the structure
        // and silently shrink every roll-up that crosses one (rule X4). Lines
        // hanging off a revision of a hidden part are excluded because they are
        // unreachable — the walk only ever enters a revision of a visible part.
        prisma.bomLine.findMany({
          where: { parentRevision: { part: { ...aclFilter('PART', user) } } },
          select: { parentRevisionId: true, childPartId: true, quantity: true },
        }),
        // Requirements are not an ACL-bearing type, so the two totals stand.
        prisma.requirement.count(),
        prisma.requirement.count({ where: { status: RequirementStatus.APPROVED } }),
        // Coverage is asserted through a part, so it inherits the part's
        // visibility: reporting a requirement as covered when the only thing
        // covering it is restricted would confirm that a hidden part implements a
        // named requirement, which is enough to infer what it is.
        prisma.requirementLink.findMany({
          where: { partId: { not: null }, part: { ...aclFilter('PART', user) } },
          select: { requirementId: true },
          distinct: ['requirementId'],
        }),
      ]);

    const visiblePartIds = new Set(parts.map((part) => part.id));

    // Distinct hidden children of lines that ARE in scope — the contributors the
    // structural findings below could not evaluate (rule X4's `redactedCount`).
    // Counted from the lines rather than tallied inside the recursive walk, so it
    // covers the BOM-health pass too and is not distorted by memoization.
    const redactedContributorIds = new Set<number>();
    for (const line of bomLines) {
      if (!visiblePartIds.has(line.childPartId)) redactedContributorIds.add(line.childPartId);
    }

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

    const rolledCostOf = createRollup({
      parts,
      resolvedRevisionByPart,
      linesByRevision,
      visiblePartIds,
    });
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
      redactedCount: redactedContributorIds.size,
    };
    res.json(payload);
  })
);

export default router;
