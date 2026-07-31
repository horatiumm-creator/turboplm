import { Request, Router } from 'express';
import { BuildKind, BuildStatus, Lifecycle, NcrStatus, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, REDACTED, visibleIds } from '../lib/acl';

const router = Router();
router.use(requireAuth);

/** The same ceiling every other structural walk in this codebase uses. */
const MAX_DEPTH = 15;

/**
 * Node budget for the backward tree. A lot consumed by two different sub-assemblies
 * legitimately appears under both, so a wide as-built graph materializes into more nodes
 * than it has rows; the budget keeps a read bounded instead of merely improbable.
 */
const MAX_GENEALOGY_NODES = 5000;

/** "Has open nonconformances" means an NCR that still needs action. */
const OPEN_NCR_STATUSES: NcrStatus[] = [NcrStatus.OPEN, NcrStatus.CONTAINED];

/** Float sums need rounding before comparison or 3 × 0.1 reads as a mismatch. */
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

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

/**
 * Rule X4 — a trace crosses items with their own grants, and a recall must stay *numerically*
 * honest whoever runs it: hidden units keep their slot, status, kind and quantities (the counts
 * and the shipped/top-level partition depend on them) and lose their identity — the serial/lot
 * number, and the part they instantiate.
 */
type MaybePartRefDto = PartRefDto | typeof REDACTED;

interface RevisionRefDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

interface BuildUnitRefDto {
  id: number;
  identifier: string;
  kind: BuildKind;
  status: BuildStatus;
  quantity: number;
  part: MaybePartRefDto;
  partRevision: RevisionRefDto;
  builtAt: string | null;
  shippedAt: string | null;
}

/** Compact unit reference for path hops, where the full reference would repeat per entry. */
interface BuildUnitPathRefDto {
  id: number;
  identifier: string;
  kind: BuildKind;
  status: BuildStatus;
  partNumber: string;
  partName: string;
}

interface GenealogyNodeDto {
  unit: BuildUnitRefDto;
  /** The as-built line that consumed this unit into its parent; null on the root. */
  asBuiltLineId: number | null;
  /** How much of this unit the parent consumed; null on the root, which nothing consumed. */
  quantity: number | null;
  substitution: boolean;
  hasOpenNonconformances: boolean;
  openNonconformanceCount: number;
  /** This unit consumed something, but the depth cap or the node budget stopped the walk. */
  truncated: boolean;
  /** Defensive: writes reject cycles, but a read must not hang if one ever exists. */
  cycle: boolean;
  children: GenealogyNodeDto[];
}

interface WhereConsumedStepDto {
  asBuiltLineId: number;
  quantity: number;
  substitution: boolean;
  /** The unit the previous hop was consumed into. */
  unit: BuildUnitPathRefDto;
}

interface WhereConsumedEntryDto {
  unit: BuildUnitRefDto;
  /** Hops from the queried unit; 1 is a direct parent. */
  depth: number;
  /** Nothing consumes this unit — the boundary of the recall. */
  topLevel: boolean;
  /** At the depth cap: it may itself sit inside something outside this trace. */
  truncated: boolean;
  hasOpenNonconformances: boolean;
  openNonconformanceCount: number;
  /** Queried unit → … → this unit, nearest hop first; `path.length === depth`. */
  path: WhereConsumedStepDto[];
}

interface WhereConsumedReportDto {
  /** The unit the question was asked about — the suspect lot or serial. */
  unit: BuildUnitRefDto;
  units: WhereConsumedEntryDto[];
  /** The subset a human has to act on: these left the building. */
  shippedUnits: WhereConsumedEntryDto[];
  /** The subset nothing else consumes — still recallable in house. */
  topLevelUnits: WhereConsumedEntryDto[];
  truncated: boolean;
  counts: {
    total: number;
    shipped: number;
    completed: number;
    inProgress: number;
    scrapped: number;
    topLevel: number;
  };
}

type DeviationStatus = 'QTY_MISMATCH' | 'MISSING' | 'UNPLANNED' | 'SUBSTITUTED' | 'MATCH';

interface DeviationConsumedDto {
  asBuiltLineId: number;
  unit: BuildUnitRefDto;
  quantity: number;
  substitution: boolean;
  bomLineId: number | null;
}

interface DeviationRowDto {
  part: MaybePartRefDto;
  status: DeviationStatus;
  bomLine: { id: number; findNumber: number; quantity: number; uom: string } | null;
  /** eBOM line quantity × the unit's build quantity — what the whole build should draw. */
  plannedQuantity: number | null;
  builtQuantity: number | null;
  consumed: DeviationConsumedDto[];
  /** Approved alternates used in place of `part`: the evidence behind SUBSTITUTED. */
  substitutes: { part: MaybePartRefDto; quantity: number }[];
  /** Set when this part was recorded against a BOM line it is not an approved alternate
   *  of: the part that line planned, so the two defect rows can be read together. */
  unapprovedSubstitutionFor: MaybePartRefDto | null;
}

interface DeviationReportDto {
  unit: BuildUnitRefDto;
  /** eBOM quantities are per assembly, so a lot of N is expected to draw N × the line. */
  buildQuantity: number;
  hasEbom: boolean;
  rows: DeviationRowDto[];
  counts: {
    match: number;
    qtyMismatch: number;
    missing: number;
    unplanned: number;
    substituted: number;
  };
}

// ---------------------------------------------------------------------------
// Selects + mappers
// ---------------------------------------------------------------------------

const partRefSelect = {
  id: true,
  partNumber: true,
  name: true,
  category: true,
  uom: true,
} satisfies Prisma.PartSelect;

const unitRefSelect = {
  id: true,
  identifier: true,
  kind: true,
  status: true,
  quantity: true,
  builtAt: true,
  shippedAt: true,
  part: { select: partRefSelect },
  partRevision: { select: { id: true, revision: true, lifecycle: true } },
} satisfies Prisma.BuildUnitSelect;

const edgeSelect = {
  id: true,
  parentId: true,
  childId: true,
  quantity: true,
  substitution: true,
} satisfies Prisma.AsBuiltLineSelect;

type PartRefRow = Prisma.PartGetPayload<{ select: typeof partRefSelect }>;
type UnitRefRow = Prisma.BuildUnitGetPayload<{ select: typeof unitRefSelect }>;
type AsBuiltEdge = Prisma.AsBuiltLineGetPayload<{ select: typeof edgeSelect }>;

/** Which parts and units this caller may read — resolved once per trace (rule X4). */
interface TraceVisibility {
  parts: ReadonlySet<number>;
  units: ReadonlySet<number>;
}

async function traceVisibility(
  units: Iterable<UnitRefRow>,
  user: AclUser
): Promise<TraceVisibility> {
  const partIds: number[] = [];
  const unitIds: number[] = [];
  for (const unit of units) {
    unitIds.push(unit.id);
    partIds.push(unit.part.id);
  }
  const [parts, visibleUnits] = await Promise.all([
    visibleIds('PART', partIds, user),
    visibleIds('BUILD_UNIT', unitIds, user),
  ]);
  return { parts, units: visibleUnits };
}

const toPartRef = (part: PartRefRow): PartRefDto => ({
  id: part.id,
  partNumber: part.partNumber,
  name: part.name,
  category: part.category,
  uom: part.uom,
});

const redactedPart = (part: PartRefRow, vis: TraceVisibility): MaybePartRefDto =>
  vis.parts.has(part.id) ? toPartRef(part) : { ...REDACTED };

const toBuildUnitRef = (unit: UnitRefRow, vis: TraceVisibility): BuildUnitRefDto => {
  const unitVisible = vis.units.has(unit.id);
  // A hidden unit's part is hidden with it, whatever the part's own grants say: "which part
  // this unit instantiates" is the unit's record. The revision label follows the part.
  const partVisible = unitVisible && vis.parts.has(unit.part.id);
  return {
    id: unit.id,
    identifier: unitVisible ? unit.identifier : REDACTED.name,
    kind: unit.kind,
    status: unit.status,
    quantity: unit.quantity,
    part: partVisible ? toPartRef(unit.part) : { ...REDACTED },
    partRevision: {
      id: unit.partRevision.id,
      revision: partVisible ? unit.partRevision.revision : REDACTED.name,
      lifecycle: unit.partRevision.lifecycle,
    },
    builtAt: unit.builtAt ? unit.builtAt.toISOString() : null,
    shippedAt: unit.shippedAt ? unit.shippedAt.toISOString() : null,
  };
};

const toPathRef = (unit: UnitRefRow, vis: TraceVisibility): BuildUnitPathRefDto => {
  const unitVisible = vis.units.has(unit.id);
  const partVisible = unitVisible && vis.parts.has(unit.part.id);
  return {
    id: unit.id,
    identifier: unitVisible ? unit.identifier : REDACTED.name,
    kind: unit.kind,
    status: unit.status,
    partNumber: partVisible ? unit.part.partNumber : REDACTED.partNumber,
    partName: partVisible ? unit.part.name : REDACTED.name,
  };
};

// ---------------------------------------------------------------------------
// Graph loading
// ---------------------------------------------------------------------------

/**
 * Breadth-first as-built edge load: `down` follows parent → child (what went in), `up`
 * follows child → parent (where it ended up). One query per level rather than one per
 * node — a per-node walk on a deep tree is the difference between 15 round trips and
 * hundreds, and the shape of a trace is exactly the shape that provokes that.
 *
 * The returned map is keyed by the unit the edges hang off in the walk direction, so
 * materializing the answer afterwards is pure memory work.
 */
async function loadEdges(
  rootId: number,
  direction: 'down' | 'up'
): Promise<{ byUnit: Map<number, AsBuiltEdge[]>; unitIds: number[] }> {
  const byUnit = new Map<number, AsBuiltEdge[]>();
  const seen = new Set<number>([rootId]);
  let frontier: number[] = [rootId];

  for (let level = 0; level < MAX_DEPTH && frontier.length > 0; level += 1) {
    // Levels are inherently sequential: the next query's filter is this one's result.
    const rows = await prisma.asBuiltLine.findMany({
      where: direction === 'down' ? { parentId: { in: frontier } } : { childId: { in: frontier } },
      select: edgeSelect,
      orderBy: { id: 'asc' },
    });
    const next: number[] = [];
    for (const row of rows) {
      const from = direction === 'down' ? row.parentId : row.childId;
      const to = direction === 'down' ? row.childId : row.parentId;
      const bucket = byUnit.get(from);
      if (bucket) bucket.push(row);
      else byUnit.set(from, [row]);
      // Expanding a unit once is enough: its edges are in the map for every branch that
      // reaches it, and it also stops a cycle from looping the loader forever.
      if (!seen.has(to)) {
        seen.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return { byUnit, unitIds: [...seen] };
}

async function loadUnits(ids: number[]): Promise<Map<number, UnitRefRow>> {
  if (ids.length === 0) return new Map();
  const units = await prisma.buildUnit.findMany({
    where: { id: { in: ids } },
    select: unitRefSelect,
  });
  return new Map(units.map((unit) => [unit.id, unit]));
}

/** Open-NCR counts for a whole trace in one query, instead of one per node. */
async function loadOpenNcrCounts(ids: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (ids.length === 0) return counts;
  const rows = await prisma.nonconformance.findMany({
    where: { buildUnitId: { in: ids }, status: { in: OPEN_NCR_STATUSES } },
    select: { buildUnitId: true },
  });
  for (const row of rows) {
    if (row.buildUnitId === null) continue;
    counts.set(row.buildUnitId, (counts.get(row.buildUnitId) ?? 0) + 1);
  }
  return counts;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

async function findUnitOr404(id: number, user: AclUser): Promise<UnitRefRow> {
  // The read filter doubles as the existence check: a restricted unit 404s identically.
  const unit = await prisma.buildUnit.findFirst({
    where: { id, ...(aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput) },
    select: unitRefSelect,
  });
  if (!unit) throw new HttpError(404, 'Build unit not found');
  return unit;
}

// ---------------------------------------------------------------------------
// GET /build-units/:id/genealogy — backward trace (rule U4)
// ---------------------------------------------------------------------------

interface GenealogyContext {
  byUnit: Map<number, AsBuiltEdge[]>;
  units: Map<number, UnitRefRow>;
  openNcr: Map<number, number>;
  vis: TraceVisibility;
  /** Shared across the whole tree, not per branch: the total is what must stay bounded. */
  budget: { remaining: number };
}

function buildGenealogyNode(
  unitId: number,
  edge: AsBuiltEdge | null,
  depth: number,
  ancestors: ReadonlySet<number>,
  ctx: GenealogyContext
): GenealogyNodeDto {
  const unit = ctx.units.get(unitId);
  if (!unit) throw new HttpError(500, 'Failed to load a unit in the genealogy');

  const openCount = ctx.openNcr.get(unitId) ?? 0;
  const cycle = ancestors.has(unitId);
  const childEdges = ctx.byUnit.get(unitId) ?? [];
  const children: GenealogyNodeDto[] = [];
  let truncated = false;

  // Rule X4 — a hidden unit keeps its node (the parent's record must still show something was
  // consumed here, with quantity and status intact) but the walk does not descend: what a
  // restricted unit is made of is that unit's record, not the parent's. `truncated` says so
  // honestly — there IS more below this node, and the caller may not see it.
  if (!ctx.vis.units.has(unitId)) {
    return {
      unit: toBuildUnitRef(unit, ctx.vis),
      asBuiltLineId: edge ? edge.id : null,
      quantity: edge ? edge.quantity : null,
      substitution: edge ? edge.substitution : false,
      hasOpenNonconformances: openCount > 0,
      openNonconformanceCount: openCount,
      truncated: childEdges.length > 0,
      cycle,
      children: [],
    };
  }

  if (childEdges.length > 0 && !cycle) {
    if (depth >= MAX_DEPTH) {
      truncated = true;
    } else {
      const branch = new Set(ancestors);
      branch.add(unitId);
      const ordered = [...childEdges].sort((a, b) =>
        (ctx.units.get(a.childId)?.identifier ?? '').localeCompare(
          ctx.units.get(b.childId)?.identifier ?? ''
        )
      );
      for (const child of ordered) {
        if (ctx.budget.remaining <= 0) {
          truncated = true;
          break;
        }
        ctx.budget.remaining -= 1;
        children.push(buildGenealogyNode(child.childId, child, depth + 1, branch, ctx));
      }
    }
  }

  return {
    unit: toBuildUnitRef(unit, ctx.vis),
    asBuiltLineId: edge ? edge.id : null,
    quantity: edge ? edge.quantity : null,
    substitution: edge ? edge.substitution : false,
    hasOpenNonconformances: openCount > 0,
    openNonconformanceCount: openCount,
    truncated,
    cycle,
    children,
  };
}

router.get(
  '/build-units/:id/genealogy',
  asyncHandler(async (req, res) => {
    const unitId = idParam(req.params.id);
    const user = aclUser(req);
    await findUnitOr404(unitId, user);

    const { byUnit, unitIds } = await loadEdges(unitId, 'down');
    const [units, openNcr] = await Promise.all([loadUnits(unitIds), loadOpenNcrCounts(unitIds)]);
    const vis = await traceVisibility(units.values(), user);

    const root = buildGenealogyNode(unitId, null, 1, new Set<number>(), {
      byUnit,
      units,
      openNcr,
      vis,
      budget: { remaining: MAX_GENEALOGY_NODES },
    });
    res.json(root);
  })
);

// ---------------------------------------------------------------------------
// GET /build-units/:id/where-consumed — forward trace, the recall query (rule U4)
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<BuildStatus, number> = {
  SHIPPED: 0,
  COMPLETED: 1,
  IN_PROGRESS: 2,
  SCRAPPED: 3,
};

router.get(
  '/build-units/:id/where-consumed',
  asyncHandler(async (req, res) => {
    const unitId = idParam(req.params.id);
    const user = aclUser(req);
    const queried = await findUnitOr404(unitId, user);

    // The walk deliberately continues THROUGH hidden ancestors: a recall that stopped at a
    // restricted assembly would miss the shipped end products above it and report a smaller,
    // wrong blast radius. Hidden hops surface as redacted rows — counted, never named.
    const { byUnit, unitIds } = await loadEdges(unitId, 'up');
    const [units, openNcr] = await Promise.all([loadUnits(unitIds), loadOpenNcrCounts(unitIds)]);
    const vis = await traceVisibility(units.values(), user);

    /**
     * Breadth-first over the loaded edges: one entry per ancestor at its shortest hop
     * count, remembering the line it was first reached by so the chain can be replayed.
     * Reaching a unit once is what bounds the walk — the same unit turning up again via a
     * longer path adds nothing to "what contains this", and a cycle cannot spin.
     */
    const reached = new Map<number, { depth: number; via: AsBuiltEdge }>();
    let frontier: number[] = [unitId];
    let deepestReached = 0;
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: number[] = [];
      for (const childId of frontier) {
        for (const edge of byUnit.get(childId) ?? []) {
          if (edge.parentId === unitId || reached.has(edge.parentId)) continue;
          reached.set(edge.parentId, { depth, via: edge });
          next.push(edge.parentId);
        }
      }
      if (next.length > 0) deepestReached = depth;
      frontier = next;
    }

    const pathTo = (ancestorId: number): WhereConsumedStepDto[] => {
      const steps: WhereConsumedStepDto[] = [];
      let cursor = ancestorId;
      // Bounded by construction — each hop points at a strictly shallower unit — and
      // bounded again by the loop, so a malformed link cannot walk forever.
      for (let hops = 0; hops < MAX_DEPTH; hops += 1) {
        const reach = reached.get(cursor);
        if (!reach) break;
        const hop = units.get(reach.via.parentId);
        if (!hop) throw new HttpError(500, 'Failed to load a unit in the forward trace');
        steps.push({
          asBuiltLineId: reach.via.id,
          quantity: reach.via.quantity,
          substitution: reach.via.substitution,
          unit: toPathRef(hop, vis),
        });
        cursor = reach.via.childId;
      }
      // Collected ancestor-first while walking back down to the queried unit.
      return steps.reverse();
    };

    const entries: WhereConsumedEntryDto[] = [...reached.entries()]
      .map(([ancestorId, reach]) => {
        const unit = units.get(ancestorId);
        if (!unit) throw new HttpError(500, 'Failed to load a unit in the forward trace');
        const openCount = openNcr.get(ancestorId) ?? 0;
        // Edges are loaded for every unit the walk expanded, so an empty bucket below the
        // cap means nothing consumes it. At the cap the walk never asked, so say so
        // rather than claim a top level we did not verify.
        const atCap = reach.depth >= MAX_DEPTH;
        return {
          unit: toBuildUnitRef(unit, vis),
          depth: reach.depth,
          topLevel: !atCap && (byUnit.get(ancestorId) ?? []).length === 0,
          truncated: atCap,
          hasOpenNonconformances: openCount > 0,
          openNonconformanceCount: openCount,
          path: pathTo(ancestorId),
        };
      })
      .sort((a, b) => {
        // Shipped first at each level: in a recall that is the row that costs money.
        const byDepth = a.depth - b.depth;
        if (byDepth !== 0) return byDepth;
        const byStatus = STATUS_RANK[a.unit.status] - STATUS_RANK[b.unit.status];
        return byStatus !== 0 ? byStatus : a.unit.identifier.localeCompare(b.unit.identifier);
      });

    const countStatus = (status: BuildStatus) =>
      entries.filter((entry) => entry.unit.status === status).length;

    const report: WhereConsumedReportDto = {
      unit: toBuildUnitRef(queried, vis),
      units: entries,
      shippedUnits: entries.filter((entry) => entry.unit.status === BuildStatus.SHIPPED),
      topLevelUnits: entries.filter((entry) => entry.topLevel),
      truncated: deepestReached >= MAX_DEPTH,
      counts: {
        total: entries.length,
        shipped: countStatus(BuildStatus.SHIPPED),
        completed: countStatus(BuildStatus.COMPLETED),
        inProgress: countStatus(BuildStatus.IN_PROGRESS),
        scrapped: countStatus(BuildStatus.SCRAPPED),
        topLevel: entries.filter((entry) => entry.topLevel).length,
      },
    };
    res.json(report);
  })
);

// ---------------------------------------------------------------------------
// GET /build-units/:id/deviations — as-built vs as-designed (rule U5)
// ---------------------------------------------------------------------------

/** Defects first — the point of the view is what needs explaining. */
const DEVIATION_ORDER: Record<DeviationStatus, number> = {
  QTY_MISMATCH: 0,
  MISSING: 1,
  UNPLANNED: 2,
  SUBSTITUTED: 3,
  MATCH: 4,
};

router.get(
  '/build-units/:id/deviations',
  asyncHandler(async (req, res) => {
    const unitId = idParam(req.params.id);
    const user = aclUser(req);
    const unit = await findUnitOr404(unitId, user);

    const [bomLines, asBuiltLines] = await Promise.all([
      prisma.bomLine.findMany({
        where: { parentRevisionId: unit.partRevision.id },
        select: {
          id: true,
          findNumber: true,
          quantity: true,
          uom: true,
          childPart: { select: partRefSelect },
          alternates: { select: { alternatePartId: true } },
        },
      }),
      prisma.asBuiltLine.findMany({
        where: { parentId: unitId },
        select: {
          id: true,
          quantity: true,
          substitution: true,
          bomLineId: true,
          child: { select: unitRefSelect },
        },
        orderBy: { id: 'asc' },
      }),
    ]);

    // Rows accumulate under REAL part identities — redaction only happens at the response
    // boundary below. Redacting first would collapse every hidden part onto one key and merge
    // rows that must stay distinct (rule X4: the count of defects is structural truth).
    const vis: TraceVisibility = {
      parts: await visibleIds(
        'PART',
        [
          unit.part.id,
          ...bomLines.map((line) => line.childPart.id),
          ...asBuiltLines.map((line) => line.child.part.id),
        ],
        user
      ),
      units: await visibleIds(
        'BUILD_UNIT',
        [unit.id, ...asBuiltLines.map((line) => line.child.id)],
        user
      ),
    };

    interface Row {
      part: PartRefDto;
      bomLine: { id: number; findNumber: number; quantity: number; uom: string } | null;
      plannedQuantity: number | null;
      builtQuantity: number | null;
      consumed: DeviationConsumedDto[];
      substitutes: Map<number, { part: PartRefDto; quantity: number }>;
      unapprovedSubstitutionFor: PartRefDto | null;
    }
    const rows = new Map<number, Row>();

    // One row per part is safe to key this way: BomLine is unique on (revision, childPart).
    for (const line of bomLines) {
      rows.set(line.childPart.id, {
        part: toPartRef(line.childPart),
        bomLine: {
          id: line.id,
          findNumber: line.findNumber,
          quantity: line.quantity,
          uom: line.uom,
        },
        // A lot of N assemblies should have drawn N × the per-assembly line quantity;
        // for a serial the multiplier is 1, so this only bites where it must.
        plannedQuantity: round6(line.quantity * unit.quantity),
        builtQuantity: null,
        consumed: [],
        substitutes: new Map(),
        unapprovedSubstitutionFor: null,
      });
    }

    const rowFor = (part: PartRefDto): Row => {
      const existing = rows.get(part.id);
      if (existing) return existing;
      const fresh: Row = {
        part,
        bomLine: null,
        plannedQuantity: null,
        builtQuantity: null,
        consumed: [],
        substitutes: new Map(),
        unapprovedSubstitutionFor: null,
      };
      rows.set(part.id, fresh);
      return fresh;
    };

    const lineById = new Map(bomLines.map((line) => [line.id, line]));

    for (const asBuilt of asBuiltLines) {
      const childPart = toPartRef(asBuilt.child.part);
      // A bomLineId from another revision is rejected when the line is recorded, but the
      // referenced line can be deleted afterwards — a line we cannot see reads as unplanned.
      const planned = asBuilt.bomLineId === null ? undefined : lineById.get(asBuilt.bomLineId);
      const swapped = planned !== undefined && planned.childPart.id !== childPart.id;
      const approved =
        swapped && planned.alternates.some((alt) => alt.alternatePartId === childPart.id);

      let row: Row;
      if (approved && planned) {
        // An approved alternate satisfies the planned line, so its quantity counts against
        // that line's row: the plan was met, just not with the first-choice part.
        row = rowFor(toPartRef(planned.childPart));
        const prior = row.substitutes.get(childPart.id);
        if (prior) prior.quantity = round6(prior.quantity + asBuilt.quantity);
        else row.substitutes.set(childPart.id, { part: childPart, quantity: asBuilt.quantity });
      } else {
        row = rowFor(childPart);
        // Recorded against a line this part is not an approved alternate of. That stays a
        // defect on both rows — the planned part reads MISSING, this one UNPLANNED — with
        // the link between them named so the pair reads as one event.
        if (swapped) row.unapprovedSubstitutionFor = toPartRef(planned.childPart);
      }

      row.builtQuantity = round6((row.builtQuantity ?? 0) + asBuilt.quantity);
      row.consumed.push({
        asBuiltLineId: asBuilt.id,
        unit: toBuildUnitRef(asBuilt.child, vis),
        quantity: asBuilt.quantity,
        substitution: asBuilt.substitution,
        bomLineId: asBuilt.bomLineId,
      });
    }

    const classify = (row: Row): DeviationStatus => {
      if (row.plannedQuantity === null) return 'UNPLANNED';
      if (row.builtQuantity === null) return 'MISSING';
      // A shortfall is a defect even when an approved alternate was involved, so quantity
      // is decided before substitution — otherwise a short build hides behind SUBSTITUTED.
      if (Math.abs(row.plannedQuantity - row.builtQuantity) > 1e-6) return 'QTY_MISMATCH';
      return row.substitutes.size > 0 ? 'SUBSTITUTED' : 'MATCH';
    };

    const result: DeviationRowDto[] = [...rows.values()]
      .map((row) => ({
        part: redactedPart(row.part, vis),
        status: classify(row),
        bomLine: row.bomLine,
        plannedQuantity: row.plannedQuantity,
        builtQuantity: row.builtQuantity,
        consumed: row.consumed,
        substitutes: [...row.substitutes.values()]
          .sort((a, b) => a.part.partNumber.localeCompare(b.part.partNumber))
          .map((sub) => ({ part: redactedPart(sub.part, vis), quantity: sub.quantity })),
        unapprovedSubstitutionFor: row.unapprovedSubstitutionFor
          ? redactedPart(row.unapprovedSubstitutionFor, vis)
          : null,
      }))
      .sort((a, b) => {
        const order = DEVIATION_ORDER[a.status] - DEVIATION_ORDER[b.status];
        return order !== 0 ? order : a.part.partNumber.localeCompare(b.part.partNumber);
      });

    const countStatus = (status: DeviationStatus) =>
      result.filter((row) => row.status === status).length;

    const report: DeviationReportDto = {
      unit: toBuildUnitRef(unit, vis),
      buildQuantity: unit.quantity,
      hasEbom: bomLines.length > 0,
      rows: result,
      counts: {
        match: countStatus('MATCH'),
        qtyMismatch: countStatus('QTY_MISMATCH'),
        missing: countStatus('MISSING'),
        unplanned: countStatus('UNPLANNED'),
        substituted: countStatus('SUBSTITUTED'),
      },
    };
    res.json(report);
  })
);

export default router;
