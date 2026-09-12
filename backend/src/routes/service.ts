import { Request, Router } from 'express';
import {
  BuildKind,
  BuildStatus,
  EcnStatus,
  Lifecycle,
  NcrStatus,
  PartCategory,
  Prisma,
  ServiceKind,
  ServiceStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';
import { notifyUsers } from '../lib/notify';
import { escapeLike, withNumberLock } from '../lib/plm';

const router = Router();
router.use(requireAuth);

/** Rule G1 — you do not service something that was never finished. */
const SERVICEABLE: BuildStatus[] = [BuildStatus.COMPLETED, BuildStatus.SHIPPED];

/** Rule G1 — a closed or cancelled record is history; its swaps are not editable. */
const SETTLED: ServiceStatus[] = [ServiceStatus.CLOSED, ServiceStatus.CANCELLED];

/** Rule U2's scrap from-set: nothing else may become SCRAPPED, so a swap must not either. */
const SCRAPPABLE: BuildStatus[] = [BuildStatus.IN_PROGRESS, BuildStatus.COMPLETED];

/** Rule U3 — what may be consumed into a parent. Same set units.ts enforces. */
const CONSUMABLE: BuildStatus[] = [BuildStatus.COMPLETED, BuildStatus.SHIPPED];

/** The same ceiling and budget `/genealogy` walks with — see the genealogy section below. */
const MAX_DEPTH = 15;
const MAX_GENEALOGY_NODES = 5000;

/** "Has open nonconformances" means an NCR that still needs action (matches rule U4). */
const OPEN_NCR_STATUSES: NcrStatus[] = [NcrStatus.OPEN, NcrStatus.CONTAINED];

/** Float sums need rounding before comparison or a lot that exactly drains reads as overdrawn. */
const roundQty = (n: number): number => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}
interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}
interface RevisionRefDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

/** The same trimmed unit shape the build-unit endpoints already return. */
interface BuildUnitRefDto {
  id: number;
  kind: BuildKind;
  identifier: string;
  status: BuildStatus;
  quantity: number;
  part: PartRefDto | typeof REDACTED;
}

/**
 * The unit shape carried by a genealogy node. It is NOT `BuildUnitRefDto`: `/genealogy`
 * (rule U4) returns the richer reference, and rule G3 says `current` is byte-for-byte the
 * same node `/genealogy` already produces. The frontend types the field as `BuildUnitRef`,
 * which this is a superset of, so both hold.
 */
interface GenealogyUnitRefDto {
  id: number;
  identifier: string;
  kind: BuildKind;
  status: BuildStatus;
  quantity: number;
  part: PartRefDto | typeof REDACTED;
  partRevision: RevisionRefDto;
  builtAt: string | null;
  shippedAt: string | null;
}

interface GenealogyNodeDto {
  unit: GenealogyUnitRefDto;
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

interface ServicePartSwapDto {
  id: number;
  removedUnit: BuildUnitRefDto | null;
  installedUnit: BuildUnitRefDto | null;
  position: string | null;
  reason: string;
  /** Whether the removed unit was written off. Explicit, never inferred from `reason`. */
  scrapRemoved: boolean;
  performedBy: UserRefDto;
  performedAt: string;
}

interface ServiceRecordSummaryDto {
  id: number;
  serviceNumber: string;
  buildUnit: BuildUnitRefDto;
  kind: ServiceKind;
  status: ServiceStatus;
  title: string;
  reportedAt: string;
  closedAt: string | null;
  technician: UserRefDto | null;
  swapCount: number;
  createdBy: UserRefDto;
  createdAt: string;
}

interface ServiceRecordDetailDto extends ServiceRecordSummaryDto {
  description: string | null;
  ncr: { id: number; ncrNumber: string; status: NcrStatus } | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
  swaps: ServicePartSwapDto[];
}

interface AsMaintainedChangeDto {
  swapId: number;
  serviceRecord: { id: number; serviceNumber: string; kind: ServiceKind; title: string };
  removedUnit: BuildUnitRefDto | null;
  installedUnit: BuildUnitRefDto | null;
  position: string | null;
  reason: string;
  performedBy: UserRefDto;
  performedAt: string;
}

interface AsMaintainedDto {
  unit: BuildUnitRefDto;
  /** Current genealogy — the SAME GenealogyNode shape /genealogy already returns. */
  current: GenealogyNodeDto;
  /** Newest first. */
  changes: AsMaintainedChangeDto[];
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
  kind: true,
  identifier: true,
  status: true,
  quantity: true,
  part: { select: partRefSelect },
} satisfies Prisma.BuildUnitSelect;

const genealogyUnitSelect = {
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

/**
 * `bomLineId` rides along because a swap re-parents the plan as well as the part: the line it
 * creates inherits the line it deleted (see the swap handler), and the genealogy walk simply
 * ignores the extra column.
 */
const asBuiltEdgeSelect = {
  id: true,
  parentId: true,
  childId: true,
  quantity: true,
  bomLineId: true,
  substitution: true,
} satisfies Prisma.AsBuiltLineSelect;

const swapInclude = {
  removedUnit: { select: unitRefSelect },
  installedUnit: { select: unitRefSelect },
  performedBy: { select: { id: true, name: true } },
} satisfies Prisma.ServicePartSwapInclude;

const summaryInclude = {
  buildUnit: { select: unitRefSelect },
  technician: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  _count: { select: { swaps: true } },
} satisfies Prisma.ServiceRecordInclude;

const detailInclude = {
  ...summaryInclude,
  ncr: { select: { id: true, ncrNumber: true, status: true } },
  ecn: { select: { id: true, ecnNumber: true, status: true } },
  swaps: {
    orderBy: [{ performedAt: 'desc' as const }, { id: 'desc' as const }],
    include: swapInclude,
  },
} satisfies Prisma.ServiceRecordInclude;

type PartRefRow = Prisma.PartGetPayload<{ select: typeof partRefSelect }>;
type UnitRefRow = Prisma.BuildUnitGetPayload<{ select: typeof unitRefSelect }>;
type GenealogyUnitRow = Prisma.BuildUnitGetPayload<{ select: typeof genealogyUnitSelect }>;
type AsBuiltEdge = Prisma.AsBuiltLineGetPayload<{ select: typeof asBuiltEdgeSelect }>;
type SwapRow = Prisma.ServicePartSwapGetPayload<{ include: typeof swapInclude }>;
type RecordSummaryRow = Prisma.ServiceRecordGetPayload<{ include: typeof summaryInclude }>;
type RecordDetailRow = Prisma.ServiceRecordGetPayload<{ include: typeof detailInclude }>;

const toPartRef = (part: PartRefRow): PartRefDto => ({
  id: part.id,
  partNumber: part.partNumber,
  name: part.name,
  category: part.category,
  uom: part.uom,
});

interface ServiceVisibility {
  parts: ReadonlySet<number>;
  units: ReadonlySet<number>;
}

/** Rule X4 — a hidden unit keeps its slot (status, quantity) and loses serial and part. */
const toUnitRef = (unit: UnitRefRow, vis: ServiceVisibility): BuildUnitRefDto => {
  const unitVisible = vis.units.has(unit.id);
  const partVisible = unitVisible && vis.parts.has(unit.part.id);
  return {
    id: unit.id,
    kind: unit.kind,
    identifier: unitVisible ? unit.identifier : REDACTED.name,
    status: unit.status,
    quantity: unit.quantity,
    part: partVisible ? toPartRef(unit.part) : { ...REDACTED },
  };
};

const toGenealogyUnitRef = (unit: GenealogyUnitRow, vis: ServiceVisibility): GenealogyUnitRefDto => {
  const unitVisible = vis.units.has(unit.id);
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

const toSwap = (swap: SwapRow, vis: ServiceVisibility): ServicePartSwapDto => ({
  id: swap.id,
  removedUnit: swap.removedUnit ? toUnitRef(swap.removedUnit, vis) : null,
  installedUnit: swap.installedUnit ? toUnitRef(swap.installedUnit, vis) : null,
  position: swap.position,
  reason: swap.reason,
  scrapRemoved: swap.scrapRemoved,
  performedBy: { id: swap.performedBy.id, name: swap.performedBy.name },
  performedAt: swap.performedAt.toISOString(),
});

function toServiceRecordSummary(row: RecordSummaryRow, vis: ServiceVisibility): ServiceRecordSummaryDto {
  return {
    id: row.id,
    serviceNumber: row.serviceNumber,
    buildUnit: toUnitRef(row.buildUnit, vis),
    kind: row.kind,
    status: row.status,
    title: row.title,
    reportedAt: row.reportedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    technician: row.technician ? { id: row.technician.id, name: row.technician.name } : null,
    swapCount: row._count.swaps,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    createdAt: row.createdAt.toISOString(),
  };
}

function toServiceRecordDetail(row: RecordDetailRow, vis: ServiceVisibility): ServiceRecordDetailDto {
  return {
    ...toServiceRecordSummary(row, vis),
    description: row.description,
    ncr: row.ncr ? { id: row.ncr.id, ncrNumber: row.ncr.ncrNumber, status: row.ncr.status } : null,
    ecn: row.ecn ? { id: row.ecn.id, ecnNumber: row.ecn.ecnNumber, status: row.ecn.status } : null,
    swaps: row.swaps.map((swap) => toSwap(swap, vis)),
  };
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function unitAcl(user: AclUser): Prisma.BuildUnitWhereInput {
  return aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput;
}

/**
 * Rule X2 — a service record is *about* one unit: its title, prose and swaps all describe that
 * hardware, so the record is exactly as visible as the unit it services, resolved through the
 * unit's read filter. Parts referenced inside (the units' parts) carry their own grants and are
 * redacted per response.
 */
function visibleRecord(user: AclUser): Prisma.ServiceRecordWhereInput {
  return { buildUnit: unitAcl(user) };
}

async function recordVisibility(
  rows: RecordSummaryRow[] | RecordDetailRow[],
  user: AclUser
): Promise<{ parts: ReadonlySet<number>; units: ReadonlySet<number> }> {
  const partIds: number[] = [];
  const unitIds: number[] = [];
  const addUnit = (unit: UnitRefRow | null) => {
    if (!unit) return;
    unitIds.push(unit.id);
    partIds.push(unit.part.id);
  };
  for (const row of rows) {
    addUnit(row.buildUnit);
    if ('swaps' in row) {
      for (const swap of row.swaps) {
        addUnit(swap.removedUnit);
        addUnit(swap.installedUnit);
      }
    }
  }
  const [parts, units] = await Promise.all([
    visibleIds('PART', partIds, user),
    visibleIds('BUILD_UNIT', unitIds, user),
  ]);
  return { parts, units };
}

async function getRecordOrThrow(id: number, user: AclUser): Promise<ServiceRecordDetailDto> {
  const row = await prisma.serviceRecord.findFirst({
    where: { id, ...visibleRecord(user) },
    include: detailInclude,
  });
  if (!row) throw new HttpError(404, 'Service record not found');
  return toServiceRecordDetail(row, await recordVisibility([row], user));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

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

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalNullableText(value: unknown, label: string, max: number): string | null {
  // Absent and explicitly-null both mean "no value". Without the undefined case, POST — which
  // calls this unconditionally — would reject any request that simply omitted the field.
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

/** An absent id means "not supplied"; an explicit null means "clear it". */
function optionalNullableId(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requirePositiveInt(value, label);
}

function parseEnum<T extends Record<string, string>>(
  value: unknown,
  enumObj: T,
  label: string
): T[keyof T] {
  const values = Object.values(enumObj);
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new HttpError(400, `${label} must be one of ${values.join(', ')}`);
  }
  return value as T[keyof T];
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date string`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}


/** Rule G1 — `SVC-10001` upward, scan-max under the numbering lock like every other generator. */
async function nextServiceNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("serviceNumber" FROM 5)::int) AS max
    FROM "ServiceRecord"
    WHERE "serviceNumber" ~ '^SVC-[0-9]{1,9}$'`;
  return `SVC-${Math.max(Number(rows[0]?.max ?? 0), 10000) + 1}`;
}

async function findUserOr404(id: number, label: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw new HttpError(404, `${label} not found`);
}

async function findNcrOr404(id: number): Promise<void> {
  const ncr = await prisma.nonconformance.findUnique({ where: { id }, select: { id: true } });
  if (!ncr) throw new HttpError(404, 'Nonconformance not found');
}

async function findEcnOr404(id: number, user: AclUser): Promise<void> {
  // A restricted ECN answers like a missing one (rule X2).
  const ecn = await prisma.ecn.findFirst({
    where: { id, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
    select: { id: true },
  });
  if (!ecn) throw new HttpError(404, 'ECN not found');
}

// ---------------------------------------------------------------------------
// As-built graph helpers — shared by the swap (write) and as-maintained (read) paths
// ---------------------------------------------------------------------------

/**
 * Breadth-first downward load of the as-built edges under `rootId`: what is inside this unit,
 * transitively. One query per level rather than one per node, and depth-capped exactly where
 * `/genealogy` caps, so containment and the tree agree about where the graph stops.
 *
 * Every edge returned hangs off a unit reachable from the root, which is what makes the
 * containment test in the swap handler a plain filter: an edge that is present is inside the
 * serviced unit by construction, and one that is outside was never loaded.
 */
async function loadDescendantEdges(
  rootId: number,
  db: Prisma.TransactionClient = prisma
): Promise<{ edges: AsBuiltEdge[]; byParent: Map<number, AsBuiltEdge[]>; unitIds: number[] }> {
  const edges: AsBuiltEdge[] = [];
  const byParent = new Map<number, AsBuiltEdge[]>();
  const seen = new Set<number>([rootId]);
  let frontier: number[] = [rootId];

  for (let level = 0; level < MAX_DEPTH && frontier.length > 0; level += 1) {
    // Levels are inherently sequential: the next query's filter is this one's result.
    const rows = await db.asBuiltLine.findMany({
      where: { parentId: { in: frontier } },
      select: asBuiltEdgeSelect,
      orderBy: { id: 'asc' },
    });
    const next: number[] = [];
    for (const row of rows) {
      edges.push(row);
      const bucket = byParent.get(row.parentId);
      if (bucket) bucket.push(row);
      else byParent.set(row.parentId, [row]);
      // Expanding a unit once is enough: its edges are in the map for every branch that
      // reaches it, and it also stops a cycle from looping the loader forever.
      if (!seen.has(row.childId)) {
        seen.add(row.childId);
        next.push(row.childId);
      }
    }
    frontier = next;
  }
  return { edges, byParent, unitIds: [...seen] };
}

async function loadGenealogyUnits(ids: number[]): Promise<Map<number, GenealogyUnitRow>> {
  if (ids.length === 0) return new Map();
  const units = await prisma.buildUnit.findMany({
    where: { id: { in: ids } },
    select: genealogyUnitSelect,
  });
  return new Map(units.map((unit) => [unit.id, unit]));
}

/** Open-NCR counts for a whole trace in one query, instead of one per node (rule U4). */
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

interface GenealogyContext {
  byParent: Map<number, AsBuiltEdge[]>;
  units: Map<number, GenealogyUnitRow>;
  openNcr: Map<number, number>;
  vis: ServiceVisibility;
  /** Shared across the whole tree, not per branch: the total is what must stay bounded. */
  budget: { remaining: number };
}

/**
 * Rule G3 says `current` is the same `GenealogyNode` `/genealogy` returns. That builder is
 * module-local to `routes/traceability.ts` and this file may not edit it, so the walk is
 * reproduced here field for field — including the identifier ordering, the depth cap, the node
 * budget and the defensive `cycle` flag. If that one ever changes, this must change with it.
 */
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
  const childEdges = ctx.byParent.get(unitId) ?? [];
  const children: GenealogyNodeDto[] = [];
  let truncated = false;

  // Rule X4 — a hidden unit keeps its node, redacted, and the walk does not descend (matching
  // /genealogy in routes/traceability.ts).
  if (!ctx.vis.units.has(unitId)) {
    return {
      unit: toGenealogyUnitRef(unit, ctx.vis),
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
    unit: toGenealogyUnitRef(unit, ctx.vis),
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

/**
 * Rule U3's cycle check, applied to the edge a swap is about to create. Reproduced rather than
 * imported for the same reason as the genealogy walk: `routes/units.ts` keeps it module-local.
 *
 * Callers MUST hold the as-built advisory lock. Without it two concurrent writes each read a
 * graph in which their own edge is absent, both pass, and the pair closes a cycle neither
 * check could see.
 */
async function assertNoGenealogyCycle(
  parentId: number,
  childId: number,
  db: Prisma.TransactionClient
): Promise<void> {
  const cycleError = () =>
    new HttpError(409, 'Recording this consumption would create a genealogy cycle');
  if (childId === parentId) throw cycleError();

  const edges = await db.asBuiltLine.findMany({ select: { parentId: true, childId: true } });
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.parentId);
    if (targets) targets.push(edge.childId);
    else adjacency.set(edge.parentId, [edge.childId]);
  }

  const visited = new Set<number>([childId]);
  const queue: number[] = [childId];
  for (const current of queue) {
    if (current === parentId) throw cycleError();
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
}

/**
 * Rules U3 + G2 — may `unit` be installed into `parentId` at `quantity`?
 *
 * The single-parent rule for a SERIAL and the remaining-balance rule for a LOT are the same
 * invariants the as-built endpoint enforces, and their messages are the same too: a swap and a
 * factory record are the same edge in the same graph, so a caller must not have to learn two
 * vocabularies for one refusal.
 */
async function assertInstallable(
  unit: { id: number; identifier: string; kind: BuildKind; quantity: number },
  parentId: number,
  parentIdentifier: string,
  quantity: number,
  db: Prisma.TransactionClient
): Promise<void> {
  const existing = await db.asBuiltLine.findMany({
    where: { childId: unit.id },
    orderBy: { id: 'asc' },
    select: { parentId: true, quantity: true, parent: { select: { identifier: true } } },
  });
  // One physical object is in one place; a lot is divisible and only bounded by its size.
  if (unit.kind === BuildKind.SERIAL && existing.length > 0) {
    throw new HttpError(
      409,
      `${unit.identifier} is already built into ${existing[0].parent.identifier}`
    );
  }
  if (existing.some((line) => line.parentId === parentId)) {
    throw new HttpError(
      409,
      `${unit.identifier} is already recorded on ${parentIdentifier} — remove that line first`
    );
  }
  const remaining = roundQty(
    unit.quantity - existing.reduce((sum, line) => sum + line.quantity, 0)
  );
  if (roundQty(quantity) > remaining) {
    throw new HttpError(
      409,
      `Cannot consume ${quantity} of ${unit.identifier}: only ${remaining} of ${unit.quantity} remains`
    );
  }
}

/**
 * `substitution` is computed, never supplied (rule U3): the BOM line says what was planned,
 * the unit says what actually went in. A swap inherits the deleted line's `bomLineId`, so a
 * like-for-like replacement stays a planned consumption and the deviation report keeps reading
 * MATCH instead of degrading into a MISSING + UNPLANNED pair for a repair that changed nothing.
 * Inheriting from a line on the SAME parent also preserves U3's rule that a `bomLineId` belongs
 * to the revision its parent was built to — by construction, with nothing to re-validate.
 */
async function computeSubstitution(
  bomLineId: number | null,
  partId: number,
  db: Prisma.TransactionClient
): Promise<boolean> {
  if (bomLineId === null) return false;
  const bomLine = await db.bomLine.findUnique({
    where: { id: bomLineId },
    select: { childPartId: true },
  });
  // The line may have been deleted since the as-built record was made; the FK is SetNull, so
  // treat a vanished plan as no plan rather than failing a repair on it.
  if (!bomLine) return false;
  return bomLine.childPartId !== partId;
}

/** Everyone tracking the record: its author and its technician. `notifyUsers` skips the actor. */
const watchersOf = (record: { createdById: number; technicianId: number | null }): number[] =>
  record.technicianId === null ? [record.createdById] : [record.createdById, record.technicianId];

// ---------------------------------------------------------------------------
// GET /service-records — rule G1
// ---------------------------------------------------------------------------

router.get(
  '/service-records',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const user = aclUser(req);
    // Records of restricted units are omitted outright — the record IS the unit's story.
    const where: Prisma.ServiceRecordWhereInput = { ...visibleRecord(user) };
    if (typeof req.query.buildUnitId === 'string' && req.query.buildUnitId) {
      where.buildUnitId = idParam(req.query.buildUnitId, 'buildUnitId');
    }
    if (typeof req.query.status === 'string' && req.query.status) {
      where.status = parseEnum(req.query.status, ServiceStatus, 'status');
    }
    if (typeof req.query.kind === 'string' && req.query.kind) {
      where.kind = parseEnum(req.query.kind, ServiceKind, 'kind');
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const q = escapeLike(req.query.search.trim());
      where.OR = [
        { serviceNumber: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.serviceRecord.count({ where }),
      prisma.serviceRecord.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: summaryInclude,
      }),
    ]);
    const vis = await recordVisibility(rows, user);
    res.json({ items: rows.map((row) => toServiceRecordSummary(row, vis)), total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /service-records — rule G1
// ---------------------------------------------------------------------------

router.post(
  '/service-records',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = bodyOf(req);
    const buildUnitId = requirePositiveInt(body.buildUnitId, 'buildUnitId');
    const title = requireText(body.title, 'title', 200);
    const description = optionalNullableText(body.description, 'description', 4000);
    // Absent means the schema default, not a rejection.
    const kind =
      body.kind === undefined || body.kind === null
        ? ServiceKind.REPAIR
        : parseEnum(body.kind, ServiceKind, 'kind');
    const reportedAt =
      body.reportedAt === undefined || body.reportedAt === null
        ? new Date()
        : parseDate(body.reportedAt, 'reportedAt');
    const technicianId = optionalNullableId(body.technicianId, 'technicianId') ?? null;
    const ncrId = optionalNullableId(body.ncrId, 'ncrId') ?? null;
    const ecnId = optionalNullableId(body.ecnId, 'ecnId') ?? null;

    const user = aclUser(req);
    const unit = await prisma.buildUnit.findFirst({
      where: { id: buildUnitId, ...unitAcl(user) },
      select: { id: true, identifier: true, status: true },
    });
    if (!unit) throw new HttpError(404, 'Build unit not found');
    // Service rewrites the unit's genealogy and can scrap it — a write to the unit.
    await assertCanWrite('BUILD_UNIT', buildUnitId, user);
    if (!SERVICEABLE.includes(unit.status)) {
      throw new HttpError(
        409,
        `${unit.identifier} is ${unit.status} — only a COMPLETED or SHIPPED unit can be serviced`
      );
    }
    if (technicianId !== null) await findUserOr404(technicianId, 'Technician');
    if (ncrId !== null) await findNcrOr404(ncrId);
    if (ecnId !== null) await findEcnOr404(ecnId, aclUser(req));

    const created = await withNumberLock(async (tx) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const serviceNumber = await nextServiceNumber(tx);
          return await tx.serviceRecord.create({
            data: {
              serviceNumber,
              buildUnitId,
              kind,
              title,
              description,
              reportedAt,
              technicianId,
              ncrId,
              ecnId,
              createdById: userId,
            },
            select: { id: true, serviceNumber: true },
          });
        } catch (err) {
          // The lock makes MAX+1 free by construction; the retry is only a backstop.
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    });

    if (technicianId !== null) {
      await notifyUsers(prisma, [technicianId], userId, {
        type: 'SERVICE_ASSIGNED',
        title: `You are the technician on ${created.serviceNumber}`,
        body: title,
        link: `/service/${created.id}`,
      }).catch((err) => console.error('Service notify failed:', err));
    }

    res.status(201).json(await getRecordOrThrow(created.id, user));
  })
);

// ---------------------------------------------------------------------------
// GET /service-records/:id — rule G1
// ---------------------------------------------------------------------------

router.get(
  '/service-records/:id',
  asyncHandler(async (req, res) => {
    res.json(await getRecordOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /service-records/:id — rule G1 (refused once CLOSED)
// ---------------------------------------------------------------------------

router.patch(
  '/service-records/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const body = bodyOf(req);

    const user = aclUser(req);
    const record = await prisma.serviceRecord.findFirst({
      where: { id, ...visibleRecord(user) },
      select: {
        id: true,
        serviceNumber: true,
        status: true,
        buildUnitId: true,
        title: true,
        createdById: true,
        technicianId: true,
      },
    });
    if (!record) throw new HttpError(404, 'Service record not found');
    await assertCanWrite('BUILD_UNIT', record.buildUnitId, user);
    if (record.status === ServiceStatus.CLOSED) {
      throw new HttpError(409, `${record.serviceNumber} is ${record.status} and cannot be modified`);
    }

    const data: Prisma.ServiceRecordUncheckedUpdateManyInput = {};

    if (body.title !== undefined) data.title = requireText(body.title, 'title', 200);
    if (body.description !== undefined) {
      data.description = optionalNullableText(body.description, 'description', 4000);
    }
    if (body.kind !== undefined) data.kind = parseEnum(body.kind, ServiceKind, 'kind');
    if (body.reportedAt !== undefined) data.reportedAt = parseDate(body.reportedAt, 'reportedAt');

    // The swaps already recorded against this record rewrote *this* unit's as-built graph.
    // Re-pointing the record at another unit would leave those edits attributed to a unit they
    // never touched, so the field is fixed once created.
    if (body.buildUnitId !== undefined && body.buildUnitId !== null) {
      const buildUnitId = requirePositiveInt(body.buildUnitId, 'buildUnitId');
      if (buildUnitId !== record.buildUnitId) {
        throw new HttpError(
          400,
          'buildUnitId cannot be changed — raise a new service record against the other unit'
        );
      }
    }

    let newTechnicianId: number | null = null;
    if (body.technicianId !== undefined) {
      const technicianId = optionalNullableId(body.technicianId, 'technicianId') ?? null;
      if (technicianId !== null && technicianId !== record.technicianId) {
        await findUserOr404(technicianId, 'Technician');
        newTechnicianId = technicianId;
      }
      data.technicianId = technicianId;
    }
    if (body.ncrId !== undefined) {
      const ncrId = optionalNullableId(body.ncrId, 'ncrId') ?? null;
      if (ncrId !== null) await findNcrOr404(ncrId);
      data.ncrId = ncrId;
    }
    if (body.ecnId !== undefined) {
      const ecnId = optionalNullableId(body.ecnId, 'ecnId') ?? null;
      if (ecnId !== null) await findEcnOr404(ecnId, aclUser(req));
      data.ecnId = ecnId;
    }

    if (Object.keys(data).length === 0) {
      res.json(await getRecordOrThrow(id, aclUser(req)));
      return;
    }

    // Conditional on the status this edit was validated against: the record may have been
    // closed since the read above, and a closed record is not editable.
    const result = await prisma.serviceRecord.updateMany({
      where: { id, status: record.status },
      data,
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `${record.serviceNumber} was changed concurrently — reload and try again`
      );
    }

    if (newTechnicianId !== null) {
      await notifyUsers(prisma, [newTechnicianId], userId, {
        type: 'SERVICE_ASSIGNED',
        title: `You are the technician on ${record.serviceNumber}`,
        body: typeof data.title === 'string' ? data.title : record.title,
        link: `/service/${record.id}`,
      }).catch((err) => console.error('Service notify failed:', err));
    }

    res.json(await getRecordOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /service-records/:id/transition — rule G1
// ---------------------------------------------------------------------------

type ServiceAction = 'start' | 'close' | 'cancel' | 'reopen';

const TRANSITIONS: Record<ServiceAction, { from: ServiceStatus[]; to: ServiceStatus }> = {
  start: { from: [ServiceStatus.OPEN], to: ServiceStatus.IN_PROGRESS },
  close: {
    from: [ServiceStatus.OPEN, ServiceStatus.IN_PROGRESS],
    to: ServiceStatus.CLOSED,
  },
  cancel: {
    from: [ServiceStatus.OPEN, ServiceStatus.IN_PROGRESS],
    to: ServiceStatus.CANCELLED,
  },
  reopen: { from: [ServiceStatus.CLOSED, ServiceStatus.CANCELLED], to: ServiceStatus.OPEN },
};

const NOTIFY_TYPE: Record<ServiceAction, string | null> = {
  start: null,
  close: 'SERVICE_CLOSED',
  cancel: 'SERVICE_CANCELLED',
  reopen: 'SERVICE_REOPENED',
};

router.post(
  '/service-records/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const body = bodyOf(req);
    const actions = Object.keys(TRANSITIONS);
    if (typeof body.action !== 'string' || !actions.includes(body.action)) {
      throw new HttpError(400, `action must be one of ${actions.join(', ')}`);
    }
    const action = body.action as ServiceAction;
    const transition = TRANSITIONS[action];

    const record = await prisma.serviceRecord.findFirst({
      where: { id, ...visibleRecord(aclUser(req)) },
      select: {
        id: true,
        serviceNumber: true,
        status: true,
        title: true,
        createdById: true,
        technicianId: true,
        buildUnitId: true,
      },
    });
    if (!record) throw new HttpError(404, 'Service record not found');
    await assertCanWrite('BUILD_UNIT', record.buildUnitId, aclUser(req));
    if (!transition.from.includes(record.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: ${record.serviceNumber} is ${record.status} (requires ${transition.from.join(' or ')})`
      );
    }

    const data: Prisma.ServiceRecordUncheckedUpdateManyInput = { status: transition.to };
    if (action === 'close') data.closedAt = new Date();
    if (action === 'reopen') data.closedAt = null;

    const result = await prisma.serviceRecord.updateMany({
      where: { id, status: record.status },
      data,
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: ${record.serviceNumber} was changed concurrently — reload and try again`
      );
    }

    const type = NOTIFY_TYPE[action];
    if (type) {
      await notifyUsers(prisma, watchersOf(record), userId, {
        type,
        title: `${record.serviceNumber} is now ${transition.to}`,
        body: record.title,
        link: `/service/${record.id}`,
      }).catch((err) => console.error('Service notify failed:', err));
    }

    res.json(await getRecordOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /service-records/:id/swaps — rule G2, the as-maintained delta
// ---------------------------------------------------------------------------

router.post(
  '/service-records/:id/swaps',
  asyncHandler(async (req, res) => {
    const recordId = idParam(req.params.id);
    const userId = currentUserId(req);
    const user = aclUser(req);
    const body = bodyOf(req);
    const removedUnitId = optionalNullableId(body.removedUnitId, 'removedUnitId') ?? null;
    const installedUnitId = optionalNullableId(body.installedUnitId, 'installedUnitId') ?? null;
    const position = optionalNullableText(body.position, 'position', 200);
    const reason = requireText(body.reason, 'reason', 2000);
    // Explicit, never inferred from `reason` (rule G2). Defaults to false: the safe outcome
    // for an irreversible write-off is "no".
    if (body.scrapRemoved !== undefined && typeof body.scrapRemoved !== 'boolean') {
      throw new HttpError(400, 'scrapRemoved must be a boolean');
    }
    const scrapRemoved = body.scrapRemoved === true;

    // A swap that neither removes nor installs anything is not an event.
    if (removedUnitId === null && installedUnitId === null) {
      throw new HttpError(400, 'A swap must remove a unit, install a unit, or both');
    }
    if (removedUnitId !== null && removedUnitId === installedUnitId) {
      throw new HttpError(400, 'removedUnitId and installedUnitId must be different units');
    }

    /**
     * Everything below is read-then-write against the as-built graph — the transitive
     * containment of the removed unit, the cycle check, the single-parent and balance checks —
     * and the graph rewrite itself. All of it runs in ONE transaction holding
     * `pg_advisory_xact_lock(hashtext('turboplm-as-built'))`, the same lock rule U3 takes, so a
     * swap and a factory as-built record serialize against each other. Doing it any other way
     * would let genealogy and service history disagree, and then neither can be trusted.
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;

      const record = await tx.serviceRecord.findFirst({
        where: { id: recordId, ...visibleRecord(user) },
        select: {
          id: true,
          serviceNumber: true,
          status: true,
          title: true,
          createdById: true,
          technicianId: true,
          buildUnit: { select: { id: true, identifier: true } },
        },
      });
      if (!record) throw new HttpError(404, 'Service record not found');
      await assertCanWrite('BUILD_UNIT', record.buildUnit.id, user);
      if (SETTLED.includes(record.status)) {
        throw new HttpError(
          409,
          `${record.serviceNumber} is ${record.status} and cannot be modified`
        );
      }
      const served = record.buildUnit;

      // The serviced unit's current genealogy, depth-capped where /genealogy caps it. Loaded
      // once: the containment test and the parent it resolves both come out of this.
      const { edges } = await loadDescendantEdges(served.id, tx);

      // Where the installed unit goes, and with what plan. A swap deeper in the tree keeps the
      // part at its real position: the replacement is attached to the same sub-assembly the
      // removed part hung off, NOT to the serviced unit. Attaching it to the top would flatten
      // the structure and quietly corrupt every trace through that sub-assembly.
      let targetParentId = served.id;
      let targetParentIdentifier = served.identifier;
      // An install with nothing coming out is an addition, and the frozen swap carries no
      // quantity, so it records one: the removal branch below overrides this with the exact
      // amount the deleted line held.
      let quantity = 1;
      let bomLineId: number | null = null;
      let removedLineId: number | null = null;
      let removed: {
        id: number;
        identifier: string;
        status: BuildStatus;
      } | null = null;

      if (removedUnitId !== null) {
        // A restricted unit answers like a missing one (rule X2).
        const unit = await tx.buildUnit.findFirst({
          where: { id: removedUnitId, ...unitAcl(user) },
          select: { id: true, identifier: true, status: true },
        });
        if (!unit) throw new HttpError(404, 'Removed build unit not found');
        removed = unit;

        /**
         * Rule G2 — containment is TRANSITIVE, not just the direct children. A cell inside a
         * pack inside a vehicle is exactly what gets replaced in the field, and forcing the
         * record to be raised against the pack would keep the event out of the vehicle's
         * service history — which is the record someone actually reads. Every loaded edge
         * hangs off a unit reachable from the serviced unit, so an edge naming this child is
         * proof of containment at any depth; an edge outside the serviced unit was never
         * loaded and cannot match.
         */
        const lines = edges.filter((edge) => edge.childId === removedUnitId);
        if (lines.length === 0) {
          throw new HttpError(409, `${unit.identifier} is not part of ${served.identifier}`);
        }
        /**
         * A LOT can legitimately sit in two sub-assemblies of the same product, and the frozen
         * swap has no field to say which one came out. Rather than guess a position, refuse and
         * name the fix: a record raised against the sub-assembly sees that lot exactly once.
         */
        if (lines.length > 1) {
          throw new HttpError(
            409,
            `${unit.identifier} is recorded in ${lines.length} places inside ${served.identifier} — raise the service record against the sub-assembly it came out of`
          );
        }
        const line = lines[0];
        removedLineId = line.id;
        targetParentId = line.parentId;
        // The whole recorded consumption comes out: the frozen swap carries no quantity, so a
        // partial lot withdrawal is not expressible and must not be silently invented.
        quantity = line.quantity;
        bomLineId = line.bomLineId;

        if (targetParentId !== served.id) {
          const parent = await tx.buildUnit.findUnique({
            where: { id: targetParentId },
            select: { identifier: true },
          });
          if (!parent) throw new HttpError(500, 'Failed to load the as-built parent of the swap');
          targetParentIdentifier = parent.identifier;
        }
      }

      let installed: {
        id: number;
        identifier: string;
        kind: BuildKind;
        status: BuildStatus;
        quantity: number;
        partId: number;
      } | null = null;

      if (installedUnitId !== null) {
        const unit = await tx.buildUnit.findFirst({
          where: { id: installedUnitId, ...unitAcl(user) },
          select: {
            id: true,
            identifier: true,
            kind: true,
            status: true,
            quantity: true,
            partId: true,
          },
        });
        if (!unit) throw new HttpError(404, 'Installed build unit not found');
        // Rule G2 is stricter than U3 here: COMPLETED only. A SHIPPED unit is somebody else's
        // product, and an IN_PROGRESS one is not finished being built.
        if (unit.status !== BuildStatus.COMPLETED) {
          throw new HttpError(409, `${unit.identifier} is ${unit.status} and cannot be installed`);
        }
        installed = unit;
        await assertNoGenealogyCycle(targetParentId, unit.id, tx);
        await assertInstallable(unit, targetParentId, targetParentIdentifier, quantity, tx);
      }

      // ---- the rewrite: delete the old edge, create the new one, both under the lock ----

      if (removedLineId !== null) {
        // A service record's unit is COMPLETED or SHIPPED, so rule U3's "parent must be
        // IN_PROGRESS" cannot apply — a swap is the sanctioned way to change a finished unit's
        // as-built record, which is exactly why it has to leave a ServiceRecord behind it.
        // The delete is still conditional: DELETE /as-built-lines/:id does not take this lock.
        const deleted = await tx.asBuiltLine.deleteMany({ where: { id: removedLineId } });
        if (deleted.count === 0) {
          throw new HttpError(
            409,
            `${served.identifier} was changed concurrently — reload and try again`
          );
        }
      }

      if (installed !== null) {
        await tx.asBuiltLine.create({
          data: {
            parentId: targetParentId,
            childId: installed.id,
            quantity,
            bomLineId,
            substitution: await computeSubstitution(bomLineId, installed.partId, tx),
            recordedById: userId,
          },
        });
      }

      /**
       * Rule G2 — the removed unit is written off only when the caller SAYS SO, via
       * `scrapRemoved`. This was previously inferred from keywords in `reason`, which scrapped
       * working hardware on the standard phrasing "no fault found" — an irreversible status
       * with no way back through the API, decided by prose. A working part pulled for access
       * stays COMPLETED and, its as-built line now gone, is free to be installed elsewhere.
       * The change is still bounded by rule U2's scrap from-set, so a SHIPPED sub-assembly is
       * left alone rather than pushed through a transition the unit endpoints refuse.
       */
      if (removed !== null && scrapRemoved && SCRAPPABLE.includes(removed.status)) {
        const scrapped = await tx.buildUnit.updateMany({
          where: { id: removed.id, status: removed.status },
          data: { status: BuildStatus.SCRAPPED },
        });
        if (scrapped.count === 0) {
          throw new HttpError(
            409,
            `${removed.identifier} was changed concurrently — reload and try again`
          );
        }
      }

      await tx.servicePartSwap.create({
        data: {
          serviceRecordId: record.id,
          removedUnitId,
          installedUnitId,
          position,
          reason,
          scrapRemoved,
          performedById: userId,
        },
      });

      // Inside the transaction on purpose: a swap rewrote the as-built graph, so the people
      // tracking the record must not be told about an edit that then rolls back.
      const what =
        removed && installed
          ? `${installed.identifier} replaced ${removed.identifier}`
          : installed
            ? `${installed.identifier} was installed`
            : `${removed?.identifier} was removed`;
      await notifyUsers(tx, watchersOf(record), userId, {
        type: 'SERVICE_SWAP',
        title: `${record.serviceNumber}: ${what} on ${served.identifier}`,
        body: reason,
        link: `/service/${record.id}`,
      });
    });

    res.status(201).json(await getRecordOrThrow(recordId, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /service-part-swaps/:id — rule G2, reversed
// ---------------------------------------------------------------------------

/**
 * Deleting a swap has to undo the graph edit it made, or the log and the genealogy start
 * disagreeing — the one thing rule G2 forbids. So this is a reversal, not a row delete, and it
 * refuses whenever the reversal cannot be performed exactly:
 *
 * - the record must still be open (a settled record's swaps are history);
 * - the line the swap created must still be there, and unambiguous;
 * - the parent the removed unit came out of has to be recoverable. It is recorded nowhere: it
 *   is read back off the line the swap created. A swap that removed a part WITHOUT installing a
 *   replacement therefore cannot be reversed — guessing the serviced unit would relocate a
 *   deep part to the top level, which is worse than refusing.
 */
router.delete(
  '/service-part-swaps/:id',
  asyncHandler(async (req, res) => {
    const swapId = idParam(req.params.id);
    const userId = currentUserId(req);

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;

      const swap = await tx.servicePartSwap.findUnique({
        where: { id: swapId },
        select: {
          id: true,
          reason: true,
          removedUnitId: true,
          installedUnitId: true,
          /** Needed to undo only what this swap actually did (rule G2). */
          scrapRemoved: true,
          serviceRecord: {
            select: {
              id: true,
              serviceNumber: true,
              status: true,
              buildUnit: { select: { id: true, identifier: true } },
            },
          },
        },
      });
      if (!swap) throw new HttpError(404, 'Part swap not found');
      const record = swap.serviceRecord;
      if (SETTLED.includes(record.status)) {
        throw new HttpError(
          409,
          `${record.serviceNumber} is ${record.status} and cannot be modified`
        );
      }
      const served = record.buildUnit;

      let restoreParentId: number | null = null;
      let quantity = 1;
      let bomLineId: number | null = null;

      if (swap.installedUnitId !== null) {
        const installedUnitId = swap.installedUnitId;
        // Restrict to the serviced unit's own genealogy for the same reason the create path
        // does: a LOT may hang off several parents, and only the one inside this product can be
        // the line this swap created.
        const { edges } = await loadDescendantEdges(served.id, tx);
        const lines = edges.filter((edge) => edge.childId === installedUnitId);
        const installedUnit = await tx.buildUnit.findUnique({
          where: { id: installedUnitId },
          select: { identifier: true },
        });
        const installedIdentifier = installedUnit?.identifier ?? `unit ${installedUnitId}`;
        if (lines.length === 0) {
          throw new HttpError(
            409,
            `Cannot delete this swap: ${installedIdentifier} is no longer recorded inside ${served.identifier} — the as-built record changed after the swap`
          );
        }
        if (lines.length > 1) {
          throw new HttpError(
            409,
            `Cannot delete this swap: ${installedIdentifier} is recorded in ${lines.length} places inside ${served.identifier} — the line this swap created cannot be identified`
          );
        }
        const line = lines[0];
        restoreParentId = line.parentId;
        quantity = line.quantity;
        bomLineId = line.bomLineId;

        const deleted = await tx.asBuiltLine.deleteMany({ where: { id: line.id } });
        if (deleted.count === 0) {
          throw new HttpError(
            409,
            `${served.identifier} was changed concurrently — reload and try again`
          );
        }
      }

      if (swap.removedUnitId !== null) {
        const removed = await tx.buildUnit.findUnique({
          where: { id: swap.removedUnitId },
          select: {
            id: true,
            identifier: true,
            kind: true,
            status: true,
            quantity: true,
            partId: true,
          },
        });
        if (!removed) throw new HttpError(404, 'Removed build unit not found');
        if (restoreParentId === null) {
          throw new HttpError(
            409,
            `Cannot delete this swap: ${removed.identifier} was removed without a replacement, so the position it came out of is no longer recorded — record a new swap that installs it instead`
          );
        }

        // Undo only what THIS swap did. Recomputing the scrap decision resurrected units the
        // swap never scrapped — anything independently written off afterwards came back as
        // COMPLETED and installable. `scrapRemoved` records the intent that was acted on, so
        // a unit scrapped by something else stays scrapped and rule U3 refuses to re-consume
        // it, in U3's own words.
        if (removed.status === BuildStatus.SCRAPPED) {
          if (!swap.scrapRemoved) {
            throw new HttpError(
              409,
              `${removed.identifier} is SCRAPPED and cannot be consumed`
            );
          }
          const restored = await tx.buildUnit.updateMany({
            where: { id: removed.id, status: BuildStatus.SCRAPPED },
            data: { status: BuildStatus.COMPLETED },
          });
          if (restored.count === 0) {
            throw new HttpError(
              409,
              `${removed.identifier} was changed concurrently — reload and try again`
            );
          }
          // Re-read: everything below decides whether this unit may be consumed again, and
          // the row we hold still says SCRAPPED.
          removed.status = BuildStatus.COMPLETED;
        }

        // Rule U3 — a child must be COMPLETED or SHIPPED to be consumed. The restore path
        // checked only the SCRAPPED case, so an IN_PROGRESS unit could be re-edged into a
        // parent: a state the as-built endpoint rejects and U2's reopen guard exists to
        // prevent.
        if (!CONSUMABLE.includes(removed.status)) {
          throw new HttpError(
            409,
            `${removed.identifier} is ${removed.status} and cannot be consumed`
          );
        }

        const parent = await tx.buildUnit.findUnique({
          where: { id: restoreParentId },
          select: { identifier: true },
        });
        if (!parent) throw new HttpError(500, 'Failed to load the as-built parent of the swap');

        // It was there before, but the graph may have moved underneath: re-check both
        // invariants before putting the edge back.
        await assertNoGenealogyCycle(restoreParentId, removed.id, tx);
        await assertInstallable(removed, restoreParentId, parent.identifier, quantity, tx);

        await tx.asBuiltLine.create({
          data: {
            parentId: restoreParentId,
            childId: removed.id,
            quantity,
            bomLineId,
            substitution: await computeSubstitution(bomLineId, removed.partId, tx),
            recordedById: userId,
          },
        });
      }

      await tx.servicePartSwap.delete({ where: { id: swap.id } });
    });

    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// GET /build-units/:id/as-maintained — rule G3
// ---------------------------------------------------------------------------

router.get(
  '/build-units/:id/as-maintained',
  asyncHandler(async (req, res) => {
    const unitId = idParam(req.params.id);
    const user = aclUser(req);
    const unit = await prisma.buildUnit.findFirst({
      where: { id: unitId, ...unitAcl(user) },
      select: unitRefSelect,
    });
    if (!unit) throw new HttpError(404, 'Build unit not found');

    const { byParent, unitIds } = await loadDescendantEdges(unitId);
    const [units, openNcr] = await Promise.all([
      loadGenealogyUnits(unitIds),
      loadOpenNcrCounts(unitIds),
    ]);
    // Rule X4 — one visibility answer for the whole payload: the genealogy AND the change log.
    const allUnits = [...units.values()];
    const [visParts, visUnits] = await Promise.all([
      visibleIds('PART', allUnits.map((u) => u.part.id), user),
      visibleIds('BUILD_UNIT', allUnits.map((u) => u.id), user),
    ]);
    const vis: ServiceVisibility = { parts: visParts, units: visUnits };

    const current = buildGenealogyNode(unitId, null, 1, new Set<number>(), {
      byParent,
      units,
      openNcr,
      vis,
      budget: { remaining: MAX_GENEALOGY_NODES },
    });

    /**
     * "Every swap that has touched this unit" — swaps on records raised against this unit, and
     * swaps on records raised against anything currently inside it. The second half matters:
     * a technician who raises the record against the battery pack still changed the vehicle,
     * and the vehicle's as-maintained log is where that has to show up. The removed unit is by
     * definition no longer in the genealogy, so membership is judged by the record's unit —
     * the position the work was done at — not by the parts involved.
     */
    /**
     * Membership has to be a closure over the swap records, not the CURRENT descendant set.
     * Judging it by present containment made the log self-erasing: once a later swap pulled
     * the battery pack out of the vehicle, the pack was no longer a descendant, so the earlier
     * swap that changed a cell inside it disappeared from the vehicle's history — the one
     * place that change has to remain visible.
     *
     * So: start from what is inside now, then repeatedly pull in any unit a known swap
     * removed or installed. Anything reachable that way was part of this assembly at some
     * point, which is exactly what "has touched this unit" means.
     */
    const touched = new Set<number>(unitIds);
    for (let pass = 0; pass < MAX_DEPTH; pass += 1) {
      const ids = [...touched];
      const referenced = await prisma.servicePartSwap.findMany({
        where: {
          OR: [
            { serviceRecord: { buildUnitId: { in: ids } } },
            { removedUnitId: { in: ids } },
            { installedUnitId: { in: ids } },
          ],
        },
        select: { removedUnitId: true, installedUnitId: true, serviceRecord: { select: { buildUnitId: true } } },
      });
      const before = touched.size;
      for (const row of referenced) {
        if (row.removedUnitId !== null) touched.add(row.removedUnitId);
        if (row.installedUnitId !== null) touched.add(row.installedUnitId);
        touched.add(row.serviceRecord.buildUnitId);
      }
      // Fixed point: nothing new was reachable this pass.
      if (touched.size === before) break;
    }

    const swaps = await prisma.servicePartSwap.findMany({
      where: {
        OR: [
          { serviceRecord: { buildUnitId: { in: [...touched] } } },
          { removedUnitId: { in: [...touched] } },
          { installedUnitId: { in: [...touched] } },
        ],
      },
      orderBy: [{ performedAt: 'desc' }, { id: 'desc' }],
      include: {
        ...swapInclude,
        serviceRecord: { select: { id: true, serviceNumber: true, kind: true, title: true } },
      },
    });

    // The change log names units that may no longer be in the genealogy (that is its point),
    // so its visibility is answered separately from the tree's.
    const swapUnits = swaps.flatMap((swap) =>
      [swap.removedUnit, swap.installedUnit].filter(
        (u): u is NonNullable<typeof u> => u !== null
      )
    );
    const [swapParts, swapVisUnits] = await Promise.all([
      visibleIds('PART', swapUnits.map((u) => u.part.id), user),
      visibleIds('BUILD_UNIT', swapUnits.map((u) => u.id), user),
    ]);
    const changeVis: ServiceVisibility = {
      parts: new Set([...vis.parts, ...swapParts]),
      units: new Set([...vis.units, ...swapVisUnits]),
    };

    const payload: AsMaintainedDto = {
      unit: toUnitRef(unit, changeVis),
      current,
      changes: swaps.map((swap) => ({
        swapId: swap.id,
        serviceRecord: {
          id: swap.serviceRecord.id,
          serviceNumber: swap.serviceRecord.serviceNumber,
          kind: swap.serviceRecord.kind,
          title: swap.serviceRecord.title,
        },
        removedUnit: swap.removedUnit ? toUnitRef(swap.removedUnit, changeVis) : null,
        installedUnit: swap.installedUnit ? toUnitRef(swap.installedUnit, changeVis) : null,
        position: swap.position,
        reason: swap.reason,
        performedBy: { id: swap.performedBy.id, name: swap.performedBy.name },
        performedAt: swap.performedAt.toISOString(),
      })),
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// GET /build-units/:id/service-history — rule G3
// ---------------------------------------------------------------------------

router.get(
  '/build-units/:id/service-history',
  asyncHandler(async (req, res) => {
    const unitId = idParam(req.params.id);
    const user = aclUser(req);
    const unit = await prisma.buildUnit.findFirst({
      where: { id: unitId, ...unitAcl(user) },
      select: { id: true },
    });
    if (!unit) throw new HttpError(404, 'Build unit not found');

    // This unit's own records only. The aggregate over sub-assemblies is the as-maintained
    // change log's job; a unit's service history is the work booked against that unit.
    const rows = await prisma.serviceRecord.findMany({
      where: { buildUnitId: unitId },
      orderBy: { id: 'desc' },
      include: summaryInclude,
    });
    const vis = await recordVisibility(rows, user);
    res.json(rows.map((row) => toServiceRecordSummary(row, vis)));
  })
);

export default router;
