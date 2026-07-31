import { Request, Router } from 'express';
import {
  BuildKind,
  BuildStatus,
  EcnDisposition,
  Lifecycle,
  NcrSeverity,
  NcrStatus,
  PartCategory,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { escapeLike, withNumberLock } from '../lib/plm';
import {
  AclUser,
  aclFilter,
  assertCanWrite,
  REDACTED,
  visibleIds,
} from '../lib/acl';

const router = Router();
router.use(requireAuth);

const CONSUMABLE: BuildStatus[] = [BuildStatus.COMPLETED, BuildStatus.SHIPPED];
const FROZEN: BuildStatus[] = [BuildStatus.SHIPPED, BuildStatus.SCRAPPED];

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

/** Rule X4 — a reference the caller may not read keeps its slot and loses its identity. */
type MaybePartRefDto = PartRefDto | typeof REDACTED;
interface RevisionRefDto {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

/** The light shape used wherever a unit is referenced from another unit's record. */
interface BuildUnitRefDto {
  id: number;
  kind: BuildKind;
  identifier: string;
  status: BuildStatus;
  quantity: number;
  part: MaybePartRefDto;
}

interface BuildUnitSummaryDto {
  id: number;
  kind: BuildKind;
  identifier: string;
  part: MaybePartRefDto;
  partRevision: RevisionRefDto;
  quantity: number;
  status: BuildStatus;
  builtAt: string | null;
  shippedAt: string | null;
  createdBy: UserRefDto;
  createdAt: string;
}

interface AsBuiltLineDto {
  id: number;
  parentId: number;
  child: BuildUnitRefDto;
  quantity: number;
  bomLine: { id: number; findNumber: number; quantity: number; childPart: MaybePartRefDto } | null;
  substitution: boolean;
  recordedBy: UserRefDto;
  recordedAt: string;
}

/** Where this unit was consumed — the reverse edge, so the UI can explain a refused reopen. */
interface AsBuiltParentDto {
  id: number;
  parent: BuildUnitRefDto;
  quantity: number;
}

interface UnitNcrDto {
  id: number;
  ncrNumber: string;
  title: string;
  severity: NcrSeverity;
  status: NcrStatus;
  disposition: EcnDisposition | null;
  createdAt: string;
}

interface BuildUnitDetailDto extends BuildUnitSummaryDto {
  notes: string | null;
  updatedAt: string;
  asBuiltLines: AsBuiltLineDto[];
  consumedBy: AsBuiltParentDto[];
  nonconformances: UnitNcrDto[];
}

// ---------------------------------------------------------------------------
// Includes + mappers
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

const unitInclude = {
  part: { select: partRefSelect },
  partRevision: { select: { id: true, revision: true, lifecycle: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.BuildUnitInclude;

const detailInclude = {
  ...unitInclude,
  consumes: {
    orderBy: { id: 'asc' as const },
    include: {
      child: { select: unitRefSelect },
      bomLine: {
        select: {
          id: true,
          findNumber: true,
          quantity: true,
          childPart: { select: partRefSelect },
        },
      },
      recordedBy: { select: { id: true, name: true } },
    },
  },
  consumedBy: {
    orderBy: { id: 'asc' as const },
    include: { parent: { select: unitRefSelect } },
  },
  nonconformances: {
    orderBy: { id: 'desc' as const },
    select: {
      id: true,
      ncrNumber: true,
      title: true,
      severity: true,
      status: true,
      disposition: true,
      createdAt: true,
    },
  },
} satisfies Prisma.BuildUnitInclude;

type UnitRow = Prisma.BuildUnitGetPayload<{ include: typeof unitInclude }>;
type UnitDetailRow = Prisma.BuildUnitGetPayload<{ include: typeof detailInclude }>;
type UnitRefRow = Prisma.BuildUnitGetPayload<{ select: typeof unitRefSelect }>;

/**
 * Which parts and which units this caller may read, resolved in bulk before mapping (rule X4).
 * Genealogy crosses both protected types: the unit being asked about is gated at the route,
 * but the units it consumes, the units consuming it, and every part any of them names carry
 * their own grants.
 */
interface UnitVisibility {
  parts: ReadonlySet<number>;
  units: ReadonlySet<number>;
}

const toPartRef = (part: PartRefDto, vis: UnitVisibility): MaybePartRefDto =>
  vis.parts.has(part.id)
    ? {
        id: part.id,
        partNumber: part.partNumber,
        name: part.name,
        category: part.category,
        uom: part.uom,
      }
    : { ...REDACTED };

/**
 * A hidden unit keeps its slot in the genealogy — quantity, kind and status intact, so the
 * as-built record still adds up and a refused reopen can still say why — and loses its
 * identity: the serial/lot number, and its part regardless of that part's own visibility,
 * because "which part this unit instantiates" is the hidden unit's record, not the part's.
 */
const toUnitRef = (unit: UnitRefRow, vis: UnitVisibility): BuildUnitRefDto =>
  vis.units.has(unit.id)
    ? {
        id: unit.id,
        kind: unit.kind,
        identifier: unit.identifier,
        status: unit.status,
        quantity: unit.quantity,
        part: toPartRef(unit.part, vis),
      }
    : {
        id: unit.id,
        kind: unit.kind,
        identifier: REDACTED.name,
        status: unit.status,
        quantity: unit.quantity,
        part: { ...REDACTED },
      };

function toBuildUnitSummary(unit: UnitRow, vis: UnitVisibility): BuildUnitSummaryDto {
  const partVisible = vis.parts.has(unit.part.id);
  return {
    id: unit.id,
    kind: unit.kind,
    identifier: unit.identifier,
    part: toPartRef(unit.part, vis),
    // The revision inherits its part's grants: its label is part identity, its lifecycle is
    // state the unit record legitimately carries.
    partRevision: {
      id: unit.partRevision.id,
      revision: partVisible ? unit.partRevision.revision : REDACTED.name,
      lifecycle: unit.partRevision.lifecycle,
    },
    quantity: unit.quantity,
    status: unit.status,
    builtAt: unit.builtAt ? unit.builtAt.toISOString() : null,
    shippedAt: unit.shippedAt ? unit.shippedAt.toISOString() : null,
    createdBy: { id: unit.createdBy.id, name: unit.createdBy.name },
    createdAt: unit.createdAt.toISOString(),
  };
}

/** One bulk lookup per detail response: every part and unit id the mapping below can touch. */
async function detailVisibility(unit: UnitDetailRow, user: AclUser): Promise<UnitVisibility> {
  const partIds = [unit.part.id];
  const unitIds: number[] = [];
  for (const line of unit.consumes) {
    unitIds.push(line.child.id);
    partIds.push(line.child.part.id);
    if (line.bomLine) partIds.push(line.bomLine.childPart.id);
  }
  for (const line of unit.consumedBy) {
    unitIds.push(line.parent.id);
    partIds.push(line.parent.part.id);
  }
  const [parts, units] = await Promise.all([
    visibleIds('PART', partIds, user),
    visibleIds('BUILD_UNIT', unitIds, user),
  ]);
  return { parts, units };
}

function toBuildUnitDetail(unit: UnitDetailRow, vis: UnitVisibility): BuildUnitDetailDto {
  return {
    ...toBuildUnitSummary(unit, vis),
    notes: unit.notes,
    updatedAt: unit.updatedAt.toISOString(),
    asBuiltLines: unit.consumes.map((line) => ({
      id: line.id,
      parentId: line.parentId,
      child: toUnitRef(line.child, vis),
      quantity: line.quantity,
      bomLine: line.bomLine
        ? {
            id: line.bomLine.id,
            findNumber: line.bomLine.findNumber,
            quantity: line.bomLine.quantity,
            childPart: toPartRef(line.bomLine.childPart, vis),
          }
        : null,
      substitution: line.substitution,
      recordedBy: { id: line.recordedBy.id, name: line.recordedBy.name },
      recordedAt: line.recordedAt.toISOString(),
    })),
    consumedBy: unit.consumedBy.map((line) => ({
      id: line.id,
      parent: toUnitRef(line.parent, vis),
      quantity: line.quantity,
    })),
    nonconformances: unit.nonconformances.map((ncr) => ({
      id: ncr.id,
      ncrNumber: ncr.ncrNumber,
      title: ncr.title,
      severity: ncr.severity,
      status: ncr.status,
      disposition: ncr.disposition,
      createdAt: ncr.createdAt.toISOString(),
    })),
  };
}

async function getUnitOrThrow(id: number, user: AclUser): Promise<BuildUnitDetailDto> {
  // findFirst with the read filter: a restricted unit 404s exactly like a missing one.
  const unit = await prisma.buildUnit.findFirst({
    where: { id, ...unitAcl(user) },
    include: detailInclude,
  });
  if (!unit) throw new HttpError(404, 'Build unit not found');
  return toBuildUnitDetail(unit, await detailVisibility(unit, user));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function unitAcl(user: AclUser): Prisma.BuildUnitWhereInput {
  return aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput;
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
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

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${label} must be a number greater than 0`);
  }
  return value;
}

function optionalNullableText(value: unknown, label: string): string | null {
  // Absent and explicitly-null both mean "no value". Without the undefined case, POST — which
  // calls this unconditionally — rejected any request that simply omitted the field.
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

function requireIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'identifier must be a non-empty string');
  }
  const trimmed = value.trim();
  if (trimmed.length > 60) throw new HttpError(400, 'identifier must be at most 60 characters');
  return trimmed;
}

/** Rule U1 — a serial is one physical object; a lot is a batch of positive size. */
function parseQuantity(value: unknown, kind: BuildKind): number {
  if (value === undefined || value === null) return 1;
  if (kind === BuildKind.SERIAL) {
    if (typeof value !== 'number' || value !== 1) {
      throw new HttpError(400, 'A SERIAL unit must have quantity 1');
    }
    return 1;
  }
  return requirePositiveNumber(value, 'quantity');
}

/**
 * Quantities are Floats, so a sum of consumptions that exactly drains a lot lands a few
 * ulps off. Rounding both the comparison and the reported balance keeps "0.1 + 0.2 of 0.3"
 * from reporting a phantom overdraw.
 */
const roundQty = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Total already drawn from a unit by every parent that consumed it. */
async function consumedQuantity(childId: number, db: Prisma.TransactionClient): Promise<number> {
  const agg = await db.asBuiltLine.aggregate({ where: { childId }, _sum: { quantity: true } });
  return agg._sum.quantity ?? 0;
}

/**
 * Rule U1 — generated identifiers, scan-max like every other generator. Both prefixes share
 * the `identifier` column, so each scan is anchored to its own pattern: a lot must not take
 * its number from the serial sequence. Callers hold the numbering lock, which makes
 * scan-then-insert atomic — MAX+1 is free by construction, so no retry is needed.
 */
async function nextIdentifier(kind: BuildKind, tx: Prisma.TransactionClient): Promise<string> {
  const rows =
    kind === BuildKind.SERIAL
      ? await tx.$queryRaw<{ max: number | null }[]>`
          SELECT MAX(SUBSTRING("identifier" FROM 4)::int) AS max
          FROM "BuildUnit"
          WHERE "identifier" ~ '^SN-[0-9]{1,9}$'`
      : await tx.$queryRaw<{ max: number | null }[]>`
          SELECT MAX(SUBSTRING("identifier" FROM 5)::int) AS max
          FROM "BuildUnit"
          WHERE "identifier" ~ '^LOT-[0-9]{1,9}$'`;
  const prefix = kind === BuildKind.SERIAL ? 'SN' : 'LOT';
  return `${prefix}-${Math.max(Number(rows[0]?.max ?? 0), 10000) + 1}`;
}

/** Rule U1 — production hardware is built to a released revision of its own part. */
async function assertBuildableRevision(
  partId: number,
  partRevisionId: number,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  const revision = await db.partRevision.findUnique({
    where: { id: partRevisionId },
    select: { partId: true, revision: true, lifecycle: true },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');
  if (revision.partId !== partId) {
    throw new HttpError(400, 'partRevisionId does not belong to the given part');
  }
  if (revision.lifecycle !== Lifecycle.RELEASED) {
    throw new HttpError(409, `Cannot build to ${revision.revision}: it is ${revision.lifecycle}`);
  }
}

async function assertIdentifierFree(identifier: string, excludeId?: number): Promise<void> {
  const clash = await prisma.buildUnit.findUnique({
    where: { identifier },
    select: { id: true },
  });
  if (clash && clash.id !== excludeId) {
    throw new HttpError(409, `Identifier ${identifier} is already in use`);
  }
}

/**
 * Rule U3 — a unit may not appear in its own genealogy, transitively. Same shape as the BOM's
 * assertNoCycle: load the edge set, then walk down from the child looking for the parent.
 *
 * Callers MUST hold the as-built advisory lock. Without it two concurrent records each read a
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

// ---------------------------------------------------------------------------
// GET /build-units — rule U2
// ---------------------------------------------------------------------------

router.get(
  '/build-units',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    // The acl fragment nests under its own AND, so the query-param keys spread beside it
    // safely, and count and page share the same where — the total admits nothing hidden.
    const where: Prisma.BuildUnitWhereInput = { ...unitAcl(user) };
    if (typeof req.query.kind === 'string' && req.query.kind) {
      where.kind = parseEnum(req.query.kind, BuildKind, 'kind');
    }
    if (typeof req.query.status === 'string' && req.query.status) {
      where.status = parseEnum(req.query.status, BuildStatus, 'status');
    }
    if (typeof req.query.partId === 'string' && req.query.partId) {
      where.partId = idParam(req.query.partId, 'partId');
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      where.identifier = {
        contains: escapeLike(req.query.search.trim()),
        mode: 'insensitive',
      };
    }

    const [total, rows] = await Promise.all([
      prisma.buildUnit.count({ where }),
      prisma.buildUnit.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: unitInclude,
      }),
    ]);
    // Every listed unit passed the filter; their PARTS carry their own grants (rule X4).
    const vis: UnitVisibility = {
      parts: await visibleIds('PART', rows.map((row) => row.part.id), user),
      units: new Set(rows.map((row) => row.id)),
    };
    res.json({ items: rows.map((row) => toBuildUnitSummary(row, vis)), total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /build-units — rule U1
// ---------------------------------------------------------------------------

router.post(
  '/build-units',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const user = aclUser(req);
    const body = bodyOf(req);
    const kind = parseEnum(body.kind, BuildKind, 'kind');
    const partId = requirePositiveInt(body.partId, 'partId');
    const partRevisionId = requirePositiveInt(body.partRevisionId, 'partRevisionId');
    const quantity = parseQuantity(body.quantity, kind);
    const notes = optionalNullableText(body.notes, 'notes');
    const supplied =
      body.identifier === undefined || body.identifier === null
        ? undefined
        : requireIdentifier(body.identifier);

    // One cannot build what one cannot see: a restricted part 404s like a missing one.
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');
    await assertBuildableRevision(partId, partRevisionId);
    if (supplied !== undefined) await assertIdentifierFree(supplied);

    const data: Omit<Prisma.BuildUnitUncheckedCreateInput, 'identifier'> = {
      kind,
      partId,
      partRevisionId,
      quantity,
      notes,
      createdById: userId,
    };

    const created =
      supplied !== undefined
        ? await prisma.buildUnit.create({
            data: { ...data, identifier: supplied },
            include: detailInclude,
          })
        : await withNumberLock(async (tx) => {
            const identifier = await nextIdentifier(kind, tx);
            return tx.buildUnit.create({ data: { ...data, identifier }, include: detailInclude });
          });

    // A new unit holds no grants and its part was read-checked above; genealogy is empty.
    res
      .status(201)
      .json(toBuildUnitDetail(created, { parts: new Set([partId]), units: new Set([created.id]) }));
  })
);

// ---------------------------------------------------------------------------
// GET /build-units/:id — rules U2, U7 (nonconformances travel with the unit)
// ---------------------------------------------------------------------------

router.get(
  '/build-units/:id',
  asyncHandler(async (req, res) => {
    res.json(await getUnitOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /build-units/:id — rule U2
// ---------------------------------------------------------------------------

router.patch(
  '/build-units/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 ordering: 404 (unreadable), 403 (read-only), then the 409s below.
    await assertCanWrite('BUILD_UNIT', id, user);
    const body = bodyOf(req);

    const unit = await prisma.buildUnit.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        identifier: true,
        status: true,
        partId: true,
        partRevisionId: true,
        quantity: true,
      },
    });
    if (!unit) throw new HttpError(404, 'Build unit not found');
    if (FROZEN.includes(unit.status)) {
      throw new HttpError(409, `${unit.identifier} is ${unit.status} and cannot be modified`);
    }

    const data: Prisma.BuildUnitUncheckedUpdateManyInput = {};

    if (body.notes !== undefined) data.notes = optionalNullableText(body.notes, 'notes');

    if (body.identifier !== undefined) {
      const identifier = requireIdentifier(body.identifier);
      if (identifier !== unit.identifier) {
        await assertIdentifierFree(identifier, unit.id);
        data.identifier = identifier;
      }
    }

    // Whether the quantity is shrinking decides if this PATCH has to serialize against
    // as-built writes; the check itself happens under the lock, below.
    let shrinking = false;
    if (body.quantity !== undefined) {
      const quantity = parseQuantity(body.quantity, unit.kind);
      shrinking = quantity < unit.quantity;
      data.quantity = quantity;
    }

    if (body.partRevisionId !== undefined) {
      const partRevisionId = requirePositiveInt(body.partRevisionId, 'partRevisionId');
      if (partRevisionId !== unit.partRevisionId) {
        await assertBuildableRevision(unit.partId, partRevisionId);
        // Every planned as-built line points at a BOM line of the unit's revision (rule U3).
        // Retargeting the revision would silently break that, so the lines go first.
        const planned = await prisma.asBuiltLine.count({
          where: { parentId: id, bomLineId: { not: null } },
        });
        if (planned > 0) {
          throw new HttpError(
            409,
            `Cannot change the revision of ${unit.identifier}: ${planned} as-built line(s) reference BOM lines of the current revision`
          );
        }
        data.partRevisionId = partRevisionId;
      }
    }

    if (Object.keys(data).length === 0) {
      res.json(await getUnitOrThrow(id, user));
      return;
    }

    // Shrinking a lot below what parents already drew would leave their as-built records
    // claiming a balance that no longer exists. The check is read-then-write, so it has to
    // hold the as-built lock: otherwise a consumption that reads the OLD quantity can commit
    // between this check and this write, and the total consumed then exceeds the new
    // quantity. The status condition alone does not catch it — the status never changes.
    const result = shrinking
      ? await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;
          const consumed = await consumedQuantity(id, tx);
          if (roundQty(data.quantity as number) < roundQty(consumed)) {
            throw new HttpError(
              409,
              `Cannot reduce ${unit.identifier} to ${data.quantity as number}: ${roundQty(
                consumed
              )} is already consumed by parent units`
            );
          }
          return tx.buildUnit.updateMany({ where: { id, status: unit.status }, data });
        })
      : await prisma.buildUnit.updateMany({ where: { id, status: unit.status }, data });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `${unit.identifier} was changed concurrently — reload and try again`
      );
    }
    res.json(await getUnitOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /build-units/:id/transition — rule U2
// ---------------------------------------------------------------------------

type UnitAction = 'complete' | 'ship' | 'scrap' | 'reopen';

const TRANSITIONS: Record<UnitAction, { from: BuildStatus[]; to: BuildStatus }> = {
  complete: { from: [BuildStatus.IN_PROGRESS], to: BuildStatus.COMPLETED },
  ship: { from: [BuildStatus.COMPLETED], to: BuildStatus.SHIPPED },
  scrap: {
    from: [BuildStatus.IN_PROGRESS, BuildStatus.COMPLETED],
    to: BuildStatus.SCRAPPED,
  },
  reopen: { from: [BuildStatus.COMPLETED], to: BuildStatus.IN_PROGRESS },
};

router.post(
  '/build-units/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanWrite('BUILD_UNIT', id, user);
    const body = bodyOf(req);
    const actions = Object.keys(TRANSITIONS);
    if (typeof body.action !== 'string' || !actions.includes(body.action)) {
      throw new HttpError(400, `action must be one of ${actions.join(', ')}`);
    }
    const action = body.action as UnitAction;
    const transition = TRANSITIONS[action];

    const unit = await prisma.buildUnit.findUnique({
      where: { id },
      select: { id: true, identifier: true, status: true },
    });
    if (!unit) throw new HttpError(404, 'Build unit not found');
    if (!transition.from.includes(unit.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: ${unit.identifier} is ${unit.status} (requires ${transition.from.join(' or ')})`
      );
    }

    const data: Prisma.BuildUnitUncheckedUpdateManyInput = { status: transition.to };
    if (action === 'complete') data.builtAt = new Date();
    if (action === 'ship') data.shippedAt = new Date();
    if (action === 'reopen') data.builtAt = null;

    const guardedUpdate = (db: Prisma.TransactionClient) =>
      db.buildUnit.updateMany({ where: { id, status: unit.status }, data });

    let count: number;
    if (action === 'reopen') {
      // Reopening a consumed unit would invalidate its parents' records, and the check is
      // read-then-write: it runs under the as-built lock so a concurrent consumption (which
      // takes the same lock and re-reads this status) cannot slip in between.
      count = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;
        const parents = await tx.asBuiltLine.findMany({
          where: { childId: id },
          orderBy: { id: 'asc' },
          select: { parent: { select: { id: true, identifier: true } } },
        });
        if (parents.length > 0) {
          // The refusal stands whoever consumed the unit — a restricted parent blocks the
          // reopen exactly as a visible one does, but its serial must not ride out on the
          // message (rule X4).
          const visibleUnits = await visibleIds(
            'BUILD_UNIT',
            parents.map((line) => line.parent.id),
            user
          );
          throw new HttpError(
            409,
            `Cannot reopen: ${unit.identifier} is already built into ${parents
              .map((line) =>
                visibleUnits.has(line.parent.id) ? line.parent.identifier : REDACTED.name
              )
              .join(', ')}`
          );
        }
        return (await guardedUpdate(tx)).count;
      });
    } else {
      // complete / ship / scrap take the same lock. The as-built handler reads the parent's
      // status early in its critical section and then spends time on the cycle walk before
      // inserting; without this, a transition could commit in that window and a line would
      // be appended to a parent that is no longer IN_PROGRESS (or to a scrapped child).
      count = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;
        return (await guardedUpdate(tx)).count;
      });
    }

    if (count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: ${unit.identifier} was changed concurrently — reload and try again`
      );
    }
    res.json(await getUnitOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /build-units/:id/as-built — rule U3
// ---------------------------------------------------------------------------

router.post(
  '/build-units/:id/as-built',
  asyncHandler(async (req, res) => {
    const parentId = idParam(req.params.id);
    const userId = currentUserId(req);
    const user = aclUser(req);
    await assertCanWrite('BUILD_UNIT', parentId, user);
    const body = bodyOf(req);
    const childId = requirePositiveInt(body.childId, 'childId');
    const quantity =
      body.quantity === undefined || body.quantity === null
        ? 1
        : requirePositiveNumber(body.quantity, 'quantity');
    const bomLineId =
      body.bomLineId === undefined || body.bomLineId === null
        ? null
        : requirePositiveInt(body.bomLineId, 'bomLineId');

    // Every invariant below is read-then-write (cycle reachability, the single-parent rule,
    // the remaining balance), so all of them — including the status reads they depend on —
    // run inside one transaction holding the as-built lock. Two concurrent records would
    // otherwise each pass a check the other invalidates.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-as-built'))::text`;

      const parent = await tx.buildUnit.findUnique({
        where: { id: parentId },
        select: { id: true, identifier: true, status: true, partRevisionId: true },
      });
      if (!parent) throw new HttpError(404, 'Build unit not found');
      if (parent.status !== BuildStatus.IN_PROGRESS) {
        throw new HttpError(
          409,
          `${parent.identifier} is ${parent.status} — reopen it to change the as-built record`
        );
      }

      // A restricted child answers like a missing one: consuming a unit one cannot see would
      // both confirm it exists and bind its genealogy to this parent.
      const child = await tx.buildUnit.findFirst({
        where: { id: childId, ...unitAcl(user) },
        select: {
          id: true,
          identifier: true,
          kind: true,
          status: true,
          quantity: true,
          partId: true,
        },
      });
      if (!child) throw new HttpError(404, 'Child build unit not found');
      if (!CONSUMABLE.includes(child.status)) {
        throw new HttpError(409, `${child.identifier} is ${child.status} and cannot be consumed`);
      }

      await assertNoGenealogyCycle(parentId, childId, tx);

      const existing = await tx.asBuiltLine.findMany({
        where: { childId },
        orderBy: { id: 'asc' },
        select: { parentId: true, quantity: true, parent: { select: { identifier: true } } },
      });
      // One physical object is in one place; a lot is divisible and only bounded by its size.
      // This runs before the duplicate-line check so re-recording a serial into the parent it
      // is already in reports where it went, not merely that the line exists.
      if (child.kind === BuildKind.SERIAL && existing.length > 0) {
        // A restricted consumer still blocks — only its serial is need-to-know (rule X4).
        const visibleParents = await visibleIds('BUILD_UNIT', [existing[0].parentId], user);
        throw new HttpError(
          409,
          `${child.identifier} is already built into ${
            visibleParents.has(existing[0].parentId)
              ? existing[0].parent.identifier
              : REDACTED.name
          }`
        );
      }
      if (existing.some((line) => line.parentId === parentId)) {
        throw new HttpError(
          409,
          `${child.identifier} is already recorded on ${parent.identifier} — remove that line first`
        );
      }

      const remaining = roundQty(
        child.quantity - existing.reduce((sum, line) => sum + line.quantity, 0)
      );
      if (roundQty(quantity) > remaining) {
        throw new HttpError(
          409,
          `Cannot consume ${quantity} of ${child.identifier}: only ${remaining} of ${child.quantity} remains`
        );
      }

      // Computed, never taken from the body: the BOM line says what was planned, the child
      // says what actually went in. No line at all is an unplanned consumption, not a
      // substitution — there was nothing to deviate from.
      let substitution = false;
      if (bomLineId !== null) {
        const bomLine = await tx.bomLine.findUnique({
          where: { id: bomLineId },
          select: { parentRevisionId: true, childPartId: true },
        });
        if (!bomLine) throw new HttpError(404, 'BOM line not found');
        if (bomLine.parentRevisionId !== parent.partRevisionId) {
          throw new HttpError(
            400,
            `bomLineId does not belong to the revision ${parent.identifier} was built to`
          );
        }
        substitution = bomLine.childPartId !== child.partId;
      }

      await tx.asBuiltLine.create({
        data: { parentId, childId, quantity, bomLineId, substitution, recordedById: userId },
      });
    });

    res.status(201).json(await getUnitOrThrow(parentId, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /as-built-lines/:id — rule U3
// ---------------------------------------------------------------------------

router.delete(
  '/as-built-lines/:id',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const user = aclUser(req);
    // A line is as visible as the parent unit whose record it sits on.
    const line = await prisma.asBuiltLine.findFirst({
      where: { id: lineId, parent: unitAcl(user) },
      select: { id: true, parentId: true, parent: { select: { identifier: true, status: true } } },
    });
    if (!line) throw new HttpError(404, 'As-built line not found');
    await assertCanWrite('BUILD_UNIT', line.parentId, user);
    if (line.parent.status !== BuildStatus.IN_PROGRESS) {
      throw new HttpError(
        409,
        `${line.parent.identifier} is ${line.parent.status} — reopen it to change the as-built record`
      );
    }

    // Conditional delete: the parent may have been completed since the read above, and a
    // finished unit's as-built record is frozen.
    const result = await prisma.asBuiltLine.deleteMany({
      where: { id: lineId, parent: { status: BuildStatus.IN_PROGRESS } },
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `${line.parent.identifier} was changed concurrently — reload and try again`
      );
    }
    res.status(204).end();
  })
);

export default router;
