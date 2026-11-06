/**
 * WAIVERS — bounded permission to ship something that does not match its released design.
 *
 * NOT THE SAME THING AS A DEVIATION, and the two must never be read for each other.
 * `GET /build-units/:id/deviations` (routes/traceability.ts, rule U5) REPORTS where a unit's
 * as-built structure differs from the design it was meant to be built to: an observation,
 * after the fact, carrying no approval and no authority. A waiver is the opposite — a decision
 * taken IN ADVANCE that PERMITS a departure, by a named person, for a measured amount of
 * production. See the doc comment on `model Waiver`, which records the same split.
 *
 * ---------------------------------------------------------------------------------
 * THE FOUR PROPERTIES THIS FILE EXISTS TO HOLD
 * ---------------------------------------------------------------------------------
 *  1. REMAINING IS COMPUTED FROM THE USAGE ROWS, NEVER STORED. `remaining = quantityLimit -
 *     count(usages)`, evaluated on every read. A counter column drifts the first time a usage
 *     is deleted or two requests race, and the question asked when a unit comes back from the
 *     field — "which units went out under this waiver" — is one a counter cannot answer at
 *     all. There is deliberately no column to drift.
 *  2. CONSUMPTION IS REFUSED PAST THE BOUND, naming the bound that stopped it. One function,
 *     `consumptionRefusal`, produces that sentence, and both the read (`blockedReason`) and
 *     the write path use it — so what the register says and what the refusal says cannot
 *     disagree.
 *  3. EXPIRY IS REACHED WITHOUT ANYBODY ACTING. There is no cron in this product. Every read
 *     computes `effectiveStatus` from `expiresAt` against the clock, and the refusal in (2)
 *     is computed the same way inside the transaction that would have written the usage. No
 *     refusal anywhere in this file depends on a column having been updated by a background
 *     job, because no background job exists to update it.
 *  4. APPROVAL IS ATTRIBUTED. `approvedById` and `approvedAt` are stamped in the same
 *     statement as the status, so no APPROVED row exists for even an instant without the
 *     person who approved it. This route also holds the part no constraint could ever see:
 *     the requester may not approve their own waiver.
 *
 * ---------------------------------------------------------------------------------
 * THE CHECKS IN THIS FILE ARE THE ONLY ENFORCEMENT
 * ---------------------------------------------------------------------------------
 * There is no CHECK constraint behind any of them. `assertBounded`, `parseQuantityLimit` and
 * the approval stamps are not a friendlier error message in front of a database that would
 * refuse the row anyway — they are the whole of the rule, and three invariants rest on them
 * and on nothing else:
 *
 *   - a waiver is BOUNDED: a quantity, a date, or both;
 *   - a quantity bound is a POSITIVE whole number of units;
 *   - an APPROVED row carries BOTH `approvedById` and `approvedAt`.
 *
 * Deleting one of those checks does not downgrade a 400 into a 500, it PERMITS THE ROW —
 * which makes them more important than they would be with a constraint underneath, not less.
 * Where a comment below names something like `Waiver_must_be_bounded`, it is naming the rule,
 * not a second line of defence that will catch what this file misses.
 *
 * ---------------------------------------------------------------------------------
 * ITEM-LEVEL ACCESS
 * ---------------------------------------------------------------------------------
 * `Waiver` is not one of the five ACL-bearing types; the PART it waives is. So this file
 * follows the shape routes/quality.ts uses for nonconformances, for the reason rule X4 gives:
 *
 *   - READS list and serve every waiver row, with the identity of a restricted part, ECN or
 *     build unit stripped in place. A waiver register that silently DROPPED the rows a caller
 *     has no grant for would answer "no outstanding exceptions" when there are three
 *     outstanding exceptions — reporting a dangerous situation as safe, which is exactly what
 *     X4 forbids. `usedCount` and `remaining` are likewise computed over ALL usages, visible
 *     or not: a unit nobody here may name still spent the allowance.
 *   - WRITES are gated on the part with `assertCanWrite('PART', …)`, which answers 404 for a
 *     part the caller may not read (rule X3 — never 403, which would confirm it exists) and
 *     403 for one they may read but not change. Granting, consuming or withdrawing permission
 *     to depart from a design is writing that design's engineering record.
 */
import { Request, Router } from 'express';
import { BuildKind, BuildStatus, PartCategory, Prisma, Role, WaiverStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';
import { walkWhereUsed } from '../lib/whereUsed';
import { withNumberLock } from '../lib/plm';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes
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
/**
 * A linked item the caller may not read, in the shape rule X4 fixed and `toPartRef` below
 * already uses: the row stays, the identity goes, and `redacted` says which it is.
 *
 * `id` IS NULL, which is the part that matters. A real id with a 'Restricted' label still
 * hands a client everything it needs to render a link to the hidden item — and it will, since
 * nothing in the payload tells it not to. Rule PM1a is explicit that a redactable linked item
 * must not be linkable; a null id is how that is enforced rather than requested.
 *
 * `kind` and `status` are DROPPED rather than nulled: the state of a hidden unit is real data
 * about a hidden unit, and no total on these responses is computed from it.
 */
type RedactedEcnRefDto = { redacted: true; id: null; ecnNumber: 'Restricted' };
type RedactedBuildUnitRefDto = { redacted: true; id: null; identifier: 'Restricted' };

const REDACTED_ECN: RedactedEcnRefDto = Object.freeze({
  redacted: true,
  id: null,
  ecnNumber: 'Restricted',
} as const);
const REDACTED_BUILD_UNIT: RedactedBuildUnitRefDto = Object.freeze({
  redacted: true,
  id: null,
  identifier: 'Restricted',
} as const);

type EcnRefDto = { id: number; ecnNumber: string } | RedactedEcnRefDto;
type BuildUnitRefDto =
  | { id: number; identifier: string; kind: BuildKind; status: BuildStatus }
  | RedactedBuildUnitRefDto;

interface WaiverUsageDto {
  id: number;
  /**
   * The unit that went out under the waiver. Its `identifier` is redacted when the caller
   * holds no grant on it, and the row still appears — it is one unit of the allowance, and an
   * allowance that reads as larger than it is would authorise a shipment nobody approved.
   */
  buildUnit: BuildUnitRefDto;
  recordedBy: UserRefDto;
  recordedAt: string;
  notes: string | null;
}

interface WaiverSummaryDto {
  id: number;
  waiverNumber: string;
  title: string;
  /** The stored column, exactly as it is on disk. */
  status: WaiverStatus;
  /**
   * What the waiver IS, now — the stored status with expiry applied (rule 3). The two differ
   * for an APPROVED waiver whose date has passed and which nothing has touched since, which
   * with no cron in this product is the normal case rather than an edge one.
   */
  effectiveStatus: WaiverStatus;
  part: PartRefDto | typeof REDACTED;
  quantityLimit: number | null;
  expiresAt: string | null;
  /** Usages recorded against this waiver. Counted, not stored. */
  usedCount: number;
  /**
   * `quantityLimit - usedCount`, or NULL when the waiver is bounded only by a date.
   *
   * Null rather than 0, -1 or Infinity: there is no quantity allowance to have a remainder
   * of, and every one of those numbers would read as one.
   */
  remaining: number | null;
  /** Past `expiresAt` as of this response. False when the waiver carries no date. */
  expired: boolean;
  /** Whether one more unit could be recorded against it right now. */
  consumable: boolean;
  /** Why not, in the words the refusal uses — or null when it is consumable. */
  blockedReason: string | null;
  requestedBy: UserRefDto;
  approvedBy: UserRefDto | null;
  approvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface WaiverDetailDto extends WaiverSummaryDto {
  justification: string;
  notes: string | null;
  ecn: EcnRefDto | null;
  usages: WaiverUsageDto[];
}

// ---------------------------------------------------------------------------
// Includes + mappers
// ---------------------------------------------------------------------------

/**
 * The list include carries `_count` and NOT the usage rows.
 *
 * Rule 12's lesson, applied before it bites: a register of 20 waivers that included every
 * usage row would transfer the whole shipment history of every waiver to render a page that
 * shows one number per row. `usedCount` comes from the count, so nothing here reads
 * `usages.length` — on a summary row that property does not exist, which is the point.
 */
const waiverSummaryInclude = {
  part: true,
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  _count: { select: { usages: true } },
} satisfies Prisma.WaiverInclude;

const waiverDetailInclude = {
  ...waiverSummaryInclude,
  ecn: { select: { id: true, ecnNumber: true } },
  usages: {
    orderBy: { id: 'asc' as const },
    include: {
      buildUnit: { select: { id: true, identifier: true, kind: true, status: true } },
      recordedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.WaiverInclude;

type WaiverSummaryRow = Prisma.WaiverGetPayload<{ include: typeof waiverSummaryInclude }>;
type WaiverDetailRow = Prisma.WaiverGetPayload<{ include: typeof waiverDetailInclude }>;

/** What the caller may name, resolved once per response rather than per row (rule X4). */
interface WaiverVisibility {
  parts: ReadonlySet<number>;
  ecns: ReadonlySet<number>;
  units: ReadonlySet<number>;
}

async function waiverVisibility(
  rows: { partId: number; ecnId: number | null; usages?: { buildUnitId: number }[] }[],
  user: AclUser
): Promise<WaiverVisibility> {
  const [parts, ecns, units] = await Promise.all([
    visibleIds('PART', rows.map((row) => row.partId), user),
    visibleIds('ECN', rows.flatMap((row) => (row.ecnId === null ? [] : [row.ecnId])), user),
    visibleIds(
      'BUILD_UNIT',
      rows.flatMap((row) => (row.usages ?? []).map((usage) => usage.buildUnitId)),
      user
    ),
  ]);
  return { parts, ecns, units };
}

function toPartRef(
  part: WaiverSummaryRow['part'],
  vis: WaiverVisibility
): PartRefDto | typeof REDACTED {
  if (!vis.parts.has(part.id)) return { ...REDACTED };
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

// ---------------------------------------------------------------------------
// The computed answers — rules 1, 2 and 3 live in these four functions
// ---------------------------------------------------------------------------

/** Day precision, which is what an expiry date is read at. */
function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The bound a waiver may be used until, measured against a clock the caller cannot set. */
function isPastExpiry(waiver: { expiresAt: Date | null }, now: Date): boolean {
  return waiver.expiresAt !== null && waiver.expiresAt.getTime() <= now.getTime();
}

/**
 * Rule 1. Null when there is no quantity bound — see `WaiverSummaryDto.remaining`.
 *
 * Clamped at zero on the low side only as a reporting courtesy; it cannot go negative by any
 * path the route allows (consumption is refused at zero under a lock, and `quantityLimit` is
 * only editable while DRAFT or PENDING, states in which no usage can exist). A negative number
 * reaching a screen would mean one of those two invariants had broken, so it is worth not
 * hiding: it is clamped for the subtraction, never for the refusal, which counts rows.
 */
function remainingOf(quantityLimit: number | null, usedCount: number): number | null {
  return quantityLimit === null ? null : Math.max(0, quantityLimit - usedCount);
}

/**
 * Rule 3 — what the waiver is, now, whatever the column says.
 *
 * EXPIRY ONLY OVERRIDES `APPROVED`, and that restriction is deliberate rather than lazy.
 * APPROVED is the only state that permits anything, so it is the only one where a passed date
 * changes what the record MEANS. Collapsing a DRAFT or PENDING waiver whose date has slipped
 * would be actively harmful: PATCH is DRAFT/PENDING only, so a draft reported as EXPIRED could
 * never have its date corrected — the one repair it needs would be the one thing refused.
 * REJECTED, CLOSED and EXPIRED are already terminal and are passed through untouched.
 *
 * A fully-consumed waiver also reports EXPIRED, matching `enum WaiverStatus`'s own wording
 * ("Past its date or its quantity"). That reading is only safe because it is COMPUTED: delete
 * a usage recorded in error and the waiver is APPROVED again with one unit left, which a
 * stored terminal status would have made unrecoverable.
 */
function effectiveStatus(
  waiver: { status: WaiverStatus; expiresAt: Date | null; quantityLimit: number | null },
  usedCount: number,
  now: Date
): WaiverStatus {
  if (waiver.status !== WaiverStatus.APPROVED) return waiver.status;
  if (isPastExpiry(waiver, now)) return WaiverStatus.EXPIRED;
  const remaining = remainingOf(waiver.quantityLimit, usedCount);
  return remaining !== null && remaining <= 0 ? WaiverStatus.EXPIRED : WaiverStatus.APPROVED;
}

/**
 * Rule 2 — may one more unit be recorded against this waiver, and if not, WHICH BOUND SAID NO.
 *
 * The single source of that sentence. The read path puts it in `blockedReason` and the write
 * path throws it as a 409, so the register and the refusal cannot drift apart — and each
 * branch names the specific thing that stopped it (the date, or the quantity), because
 * "cannot be used" tells a planner nothing they can act on.
 *
 * Takes `usedCount` rather than reading it, so the caller decides which count it is: on a read
 * that is the count from the response, and in the consumption path it is the count taken
 * inside the locked transaction, which is the only one that can be trusted for a decision.
 */
function consumptionRefusal(
  waiver: {
    waiverNumber: string;
    status: WaiverStatus;
    expiresAt: Date | null;
    closedAt: Date | null;
    quantityLimit: number | null;
  },
  usedCount: number,
  now: Date
): string | null {
  const label = `Waiver ${waiver.waiverNumber}`;
  switch (waiver.status) {
    case WaiverStatus.DRAFT:
    case WaiverStatus.PENDING:
      // A permission nobody has granted yet permits nothing. Said in those words rather than
      // as a state machine complaint, because the caller's next action is to get it approved.
      return `${label} is ${waiver.status} and permits nothing until it is approved`;
    case WaiverStatus.REJECTED:
      return `${label} was rejected`;
    case WaiverStatus.CLOSED:
      return waiver.closedAt
        ? `${label} was closed on ${dateOnly(waiver.closedAt)}`
        : `${label} is closed`;
    case WaiverStatus.EXPIRED:
      // The stored terminal state, written by the materialisation below. The date is still
      // the reason, so it is still what the message names.
      return waiver.expiresAt
        ? `${label} expired on ${dateOnly(waiver.expiresAt)}`
        : `${label} has expired`;
    case WaiverStatus.APPROVED:
      break;
  }
  if (isPastExpiry(waiver, now)) {
    // `waiver.expiresAt` is non-null here by `isPastExpiry`; the fallback keeps the type
    // honest rather than asserting it away.
    return `${label} expired on ${waiver.expiresAt ? dateOnly(waiver.expiresAt) : 'its expiry date'}`;
  }
  const remaining = remainingOf(waiver.quantityLimit, usedCount);
  if (remaining !== null && remaining <= 0) {
    return (
      `${label} is fully consumed: all ${waiver.quantityLimit} units of its allowance have ` +
      'already been recorded'
    );
  }
  return null;
}

function toWaiverSummary(row: WaiverSummaryRow, vis: WaiverVisibility, now: Date): WaiverSummaryDto {
  const usedCount = row._count.usages;
  const blockedReason = consumptionRefusal(row, usedCount, now);
  return {
    id: row.id,
    waiverNumber: row.waiverNumber,
    title: row.title,
    status: row.status,
    effectiveStatus: effectiveStatus(row, usedCount, now),
    part: toPartRef(row.part, vis),
    quantityLimit: row.quantityLimit,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    usedCount,
    remaining: remainingOf(row.quantityLimit, usedCount),
    expired: isPastExpiry(row, now),
    consumable: blockedReason === null,
    blockedReason,
    requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
    approvedBy: row.approvedBy ? { id: row.approvedBy.id, name: row.approvedBy.name } : null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWaiverDetail(row: WaiverDetailRow, vis: WaiverVisibility, now: Date): WaiverDetailDto {
  return {
    ...toWaiverSummary(row, vis, now),
    justification: row.justification,
    notes: row.notes,
    // An ECN carries its own grants, so a restricted one keeps its id (the link is still
    // real) and loses its number — the shape routes/projects.ts redacts an ECN ref with.
    ecn: row.ecn
      ? vis.ecns.has(row.ecn.id)
        ? { id: row.ecn.id, ecnNumber: row.ecn.ecnNumber }
        : { ...REDACTED_ECN }
      : null,
    usages: row.usages.map((usage) => ({
      id: usage.id,
      // The row stays — it is one unit of the allowance, and an allowance that read as larger
      // than it is would authorise a shipment nobody approved. Only the identity goes.
      buildUnit: vis.units.has(usage.buildUnit.id)
        ? {
            id: usage.buildUnit.id,
            identifier: usage.buildUnit.identifier,
            kind: usage.buildUnit.kind,
            status: usage.buildUnit.status,
          }
        : { ...REDACTED_BUILD_UNIT },
      recordedBy: { id: usage.recordedBy.id, name: usage.recordedBy.name },
      recordedAt: usage.recordedAt.toISOString(),
      notes: usage.notes,
    })),
  };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalText(value: unknown, label: string, max = 5000): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed === '' ? null : trimmed;
}

function optionalId(value: unknown, label: string): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
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

function parseDate(value: unknown, label: string): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

/**
 * The quantity bound, and the ONLY thing that keeps a nonsense allowance out of the table.
 *
 * There is no `Waiver_quantity_positive` CHECK in this build, so this is not a 400 standing in
 * front of a constraint violation that would otherwise surface through errorMiddleware as a
 * 500 (a server fault reported for what is a plain bad request) — nothing would refuse the
 * write at all. A zero or negative limit would be stored, `remainingOf` would clamp it to
 * nothing, and the register would carry an APPROVED waiver that permits nothing while reading
 * as live permission.
 */
function parseQuantityLimit(value: unknown): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, 'quantityLimit must be a positive whole number of units');
  }
  return n;
}

/**
 * `Waiver_must_be_bounded` — the rule the record exists for, and in this build the only place
 * it is enforced: there is no CHECK constraint of that name behind this function, so an
 * unbounded waiver that gets past here is simply stored. A waiver with neither a quantity nor
 * a date is permanent, unmeasured permission to ship something that does not match its
 * drawing, which is not a waiver at all.
 */
function assertBounded(quantityLimit: number | null, expiresAt: Date | null): void {
  if (quantityLimit === null && expiresAt === null) {
    throw new HttpError(
      400,
      'A waiver must be bounded: set a quantityLimit, an expiresAt, or both'
    );
  }
}

/**
 * `WVR-10001` upward, by scanning for the highest `WVR-<digits>` already stored — the same
 * scan-max shape `generatePartNumber` (lib/plm.ts) and the NCR/CAPA numbering in
 * routes/quality.ts use, and deliberately not a third scheme.
 *
 * The scan must run on the caller's transaction client: a waiver created earlier in an open
 * transaction is invisible from outside it, so a shared connection would hand out the same
 * number twice.
 */
async function nextNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("waiverNumber" FROM 5)::int) AS max
    FROM "Waiver"
    WHERE "waiverNumber" ~ '^WVR-[0-9]{1,9}$'`;
  return `WVR-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

async function createWithNumber<T>(
  create: (waiverNumber: string, db: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  // Allocation is serialized so a concurrent burst queues instead of every caller
  // reading the same maximum; the retry below is only a backstop — for a hand-typed WVR-
  // number the scan later reaches, say. Same shape as routes/quality.ts.
  return withNumberLock(async (tx) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await create(await nextNumber(tx), tx);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Loading a waiver
// ---------------------------------------------------------------------------

/**
 * Read a waiver, with its part/ECN/unit identities redacted where the caller holds no grant.
 *
 * No ACL fragment narrows THIS query, deliberately: see the header. A waiver on a restricted
 * part is served with `part: REDACTED`, not hidden, so the register cannot under-report
 * outstanding exceptions. Acting on it is a different question, and `assertCanWrite` answers
 * that one.
 */
async function getWaiverOrThrow(id: number, user: AclUser): Promise<WaiverDetailDto> {
  const row = await prisma.waiver.findUnique({ where: { id }, include: waiverDetailInclude });
  if (!row) throw new HttpError(404, 'Waiver not found');
  return toWaiverDetail(row, await waiverVisibility([row], user), new Date());
}

/**
 * The row a mutation is about to change, plus the write check, in the order rule X3 requires:
 * 404 for a part the caller cannot read (indistinguishable from a waiver that is not there),
 * then 403 for one they can read but not write, and only then this file's own 409s.
 */
async function loadWritableWaiver(
  id: number,
  user: AclUser
): Promise<{
  id: number;
  waiverNumber: string;
  status: WaiverStatus;
  partId: number;
  quantityLimit: number | null;
  expiresAt: Date | null;
  closedAt: Date | null;
  notes: string | null;
  requestedById: number;
}> {
  const row = await prisma.waiver.findUnique({
    where: { id },
    select: {
      id: true,
      waiverNumber: true,
      status: true,
      partId: true,
      quantityLimit: true,
      expiresAt: true,
      closedAt: true,
      notes: true,
      requestedById: true,
    },
  });
  if (!row) throw new HttpError(404, 'Waiver not found');
  await assertCanWrite('PART', row.partId, user);
  return row;
}

/** The 409 every state-machine refusal in this file speaks with. */
function wrongState(
  waiver: { waiverNumber: string; status: WaiverStatus },
  requires: WaiverStatus[],
  verb: string
): HttpError {
  return new HttpError(
    409,
    `Cannot ${verb}: waiver ${waiver.waiverNumber} is ${waiver.status} ` +
      `(requires ${requires.join(' or ')})`
  );
}

/**
 * Rule 3's write half: an APPROVED row whose date has passed is EXPIRED, so the column is
 * corrected the next time anybody touches the waiver.
 *
 * WHAT THIS IS NOT: it is not what makes the refusal work. `consumptionRefusal` computes the
 * same answer from `expiresAt` whether or not this ever ran, which is the whole of rule 3 —
 * this only keeps the stored column from staying wrong forever in a product with no cron.
 *
 * It runs on WRITE paths only. Writing a status during a GET would make a read a mutation: a
 * VIEWER's page load would start writing rows, every concurrent reader would race to write the
 * same one, and `/waivers` would issue an UPDATE per listed row.
 *
 * Only the DATE is materialised, never exhaustion. Time does not go backwards, so
 * EXPIRED-by-date can never become wrong later; EXPIRED-by-quantity can, the moment a usage
 * recorded in error is deleted, and a terminal status written into that correction would
 * survive it.
 */
async function materialiseExpiry(
  tx: Prisma.TransactionClient,
  waiver: { id: number; status: WaiverStatus; expiresAt: Date | null },
  now: Date
): Promise<WaiverStatus> {
  if (waiver.status !== WaiverStatus.APPROVED || !isPastExpiry(waiver, now)) return waiver.status;
  // Guarded on the status it was read with, so two writers racing here cannot overwrite a
  // state somebody reached in between (a close committed a millisecond earlier, say).
  await tx.waiver.updateMany({
    where: { id: waiver.id, status: WaiverStatus.APPROVED },
    data: { status: WaiverStatus.EXPIRED },
  });
  return WaiverStatus.EXPIRED;
}

/**
 * Of these candidates, the ones who may still read the part the waiver is about.
 *
 * A NOTIFICATION IS A DISCLOSURE. routes/notifications.ts serves the stored `title` and `body`
 * verbatim — they were composed when the recipient could read the subject — so a waiver titled
 * "Ship Foxtrot brackets without the second weld" would tell somebody with no grant on that
 * part both that the part exists and what is wrong with it, from their own inbox, with no 404
 * anywhere in the way. Same shape and same primitive as `recipientsWhoCanRead` in
 * routes/collab.ts, and sized the same way: one or two people per waiver, so `visibleIds` per
 * candidate is the right cost.
 *
 * A candidate no user row comes back for is dropped: fail closed.
 */
async function recipientsWhoCanReadPart(
  partId: number,
  candidates: readonly number[]
): Promise<number[]> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, role: true },
  });
  const roles = new Map<number, string>(users.map((row) => [row.id, row.role]));
  const allowed = await Promise.all(
    unique.map(async (userId) => {
      const role = roles.get(userId);
      if (role === undefined) return false;
      const visible = await visibleIds('PART', [partId], { id: userId, role });
      return visible.has(partId);
    })
  );
  return unique.filter((_userId, index) => allowed[index]);
}

// ---------------------------------------------------------------------------
// GET /waivers — the register
// ---------------------------------------------------------------------------

router.get(
  '/waivers',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const now = new Date();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where: Prisma.WaiverWhereInput = {};
    if (typeof req.query.partId === 'string' && req.query.partId) {
      where.partId = idParam(req.query.partId, 'partId');
    }
    if (typeof req.query.status === 'string' && req.query.status) {
      const status = parseEnum(req.query.status, WaiverStatus, 'status');
      /*
       * THE FILTER MATCHES THE EFFECTIVE STATUS, not the column — rule 3 again, and this is
       * where getting it wrong does the most damage. "Show me the APPROVED waivers" is asked
       * by somebody deciding what may ship today; answering it from the column alone would
       * hand them a list of expired permissions, and "show me the EXPIRED ones" would leave
       * out every waiver that expired without anybody acting, which is all of them.
       *
       * Expressed in SQL rather than filtered afterwards, so `count` and `skip`/`take` stay
       * exact (rule 12). Top-level `OR` is safe here only because no `aclFilter` fragment is
       * spread into this `where` — see the collision rule in lib/acl.ts.
       *
       * THE QUANTITY DIMENSION IS DELIBERATELY NOT IN THE FILTER: a fully-consumed waiver is
       * still APPROVED here, because deciding otherwise needs a count per row, which SQL this
       * query cannot express and a post-filter would make `total` a lie. Every row carries
       * `remaining`, `consumable` and `blockedReason`, which answer it exactly.
       */
      if (status === WaiverStatus.EXPIRED) {
        where.OR = [
          { status: WaiverStatus.EXPIRED },
          { status: WaiverStatus.APPROVED, expiresAt: { lte: now } },
        ];
      } else if (status === WaiverStatus.APPROVED) {
        where.status = WaiverStatus.APPROVED;
        where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
      } else {
        where.status = status;
      }
    }

    const [total, rows] = await Promise.all([
      prisma.waiver.count({ where }),
      prisma.waiver.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: waiverSummaryInclude,
      }),
    ]);
    const vis = await waiverVisibility(rows, user);
    res.json({
      items: rows.map((row) => toWaiverSummary(row, vis, now)),
      total,
      page,
      pageSize,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /waivers
// ---------------------------------------------------------------------------

router.post(
  '/waivers',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const actorId = currentUserId(req);
    const body = requireBody(req);

    const title = requireText(body.title, 'title');
    const justification = requireText(body.justification, 'justification', 5000);
    const partId = optionalId(body.partId, 'partId');
    if (partId === null) throw new HttpError(400, 'partId is required');
    const ecnId = body.ecnId === undefined ? null : optionalId(body.ecnId, 'ecnId');
    const quantityLimit =
      body.quantityLimit === undefined ? null : parseQuantityLimit(body.quantityLimit);
    const expiresAt = body.expiresAt === undefined ? null : parseDate(body.expiresAt, 'expiresAt');
    const notes = body.notes === undefined ? null : optionalText(body.notes, 'notes');
    assertBounded(quantityLimit, expiresAt);

    // A restricted part answers like a missing one (rule X2), and permitting a departure from
    // a design is writing that design's record — so this is the write gate, not a read check.
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');
    await assertCanWrite('PART', partId, user);

    if (ecnId !== null) {
      const ecn = await prisma.ecn.findFirst({
        where: { id: ecnId, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
        select: { id: true },
      });
      if (!ecn) throw new HttpError(404, 'ECN not found');
    }

    /*
     * A PAST `expiresAt` IS ACCEPTED, with no warning and no refusal.
     *
     * The model's doc comment is explicit that this table covers the deviation-before and the
     * waiver-after case, and a retrospective waiver is a real document: it records that a
     * departure which already happened was reviewed and accepted. What it cannot do is permit
     * a future shipment, and it does not — the detail reports `effectiveStatus: EXPIRED` the
     * moment it is approved, and consumption is refused naming the date.
     */
    const created = await createWithNumber((waiverNumber, tx) =>
      tx.waiver.create({
        data: {
          waiverNumber,
          title,
          justification,
          partId,
          ecnId,
          quantityLimit,
          expiresAt,
          notes,
          requestedById: actorId,
        },
        select: { id: true },
      })
    );

    res.status(201).json(await getWaiverOrThrow(created.id, user));
  })
);

// ---------------------------------------------------------------------------
// GET /waivers/:id — with its usages and the remaining allowance
// ---------------------------------------------------------------------------

router.get(
  '/waivers/:id',
  asyncHandler(async (req, res) => {
    res.json(await getWaiverOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /waivers/:id — DRAFT or PENDING only
// ---------------------------------------------------------------------------

const PATCHABLE: WaiverStatus[] = [WaiverStatus.DRAFT, WaiverStatus.PENDING];

router.patch(
  '/waivers/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const waiver = await loadWritableWaiver(id, user);
    if (!PATCHABLE.includes(waiver.status)) {
      // Editable up to the decision and not after it: an approved bound that its holder can
      // still widen is not a bound, and the APPROVED row is what somebody signed.
      throw wrongState(waiver, PATCHABLE, 'edit');
    }
    const body = requireBody(req);

    if (body.partId !== undefined) {
      // Refused rather than ignored. Re-pointing a waiver at another part would carry its
      // number, its justification and (in PENDING) its place in somebody's approval queue
      // onto a different design — and a silently dropped field is worse, because the caller
      // is told the edit succeeded.
      throw new HttpError(
        400,
        "A waiver's part cannot be changed — raise a waiver against the other part instead"
      );
    }

    const data: Prisma.WaiverUncheckedUpdateInput = {};
    if (body.title !== undefined) data.title = requireText(body.title, 'title');
    if (body.justification !== undefined) {
      data.justification = requireText(body.justification, 'justification', 5000);
    }
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');
    if (body.ecnId !== undefined) {
      const ecnId = optionalId(body.ecnId, 'ecnId');
      if (ecnId !== null) {
        const ecn = await prisma.ecn.findFirst({
          where: { id: ecnId, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
          select: { id: true },
        });
        if (!ecn) throw new HttpError(404, 'ECN not found');
      }
      data.ecnId = ecnId;
    }

    // The bound is re-checked against the MERGED values, not the supplied ones: clearing
    // `quantityLimit` on a waiver that has no date would otherwise leave an unbounded waiver,
    // and nothing underneath this route would refuse it — there is no CHECK constraint to fall
    // back on, so the merged re-check is not a courtesy, it is where the rule is kept.
    const quantityLimit =
      body.quantityLimit === undefined
        ? waiver.quantityLimit
        : parseQuantityLimit(body.quantityLimit);
    const expiresAt =
      body.expiresAt === undefined ? waiver.expiresAt : parseDate(body.expiresAt, 'expiresAt');
    assertBounded(quantityLimit, expiresAt);
    if (body.quantityLimit !== undefined) data.quantityLimit = quantityLimit;
    if (body.expiresAt !== undefined) data.expiresAt = expiresAt;

    // Guarded on the status it was read with: a submit or approval that landed in between
    // must not have its decision silently edited out from under it.
    const result = await prisma.waiver.updateMany({
      where: { id, status: waiver.status },
      data,
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
      );
    }
    res.json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /waivers/:id — DRAFT only
// ---------------------------------------------------------------------------

router.delete(
  '/waivers/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const waiver = await loadWritableWaiver(id, user);
    if (waiver.status !== WaiverStatus.DRAFT) {
      /*
       * A waiver that has been seen by anybody else is a record, not a draft. Once it is
       * PENDING somebody has been asked to decide; once it is APPROVED, REJECTED, EXPIRED or
       * CLOSED the decision itself is the thing worth keeping — and an APPROVED one may have
       * units recorded against it, whose rows would go with it under
       * `WaiverUsage_waiverId_fkey ON DELETE CASCADE`, deleting the answer to "what shipped
       * under this exception" along with the exception.
       */
      throw wrongState(waiver, [WaiverStatus.DRAFT], 'delete');
    }
    const result = await prisma.waiver.deleteMany({ where: { id, status: WaiverStatus.DRAFT } });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
      );
    }
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /waivers/:id/submit — DRAFT -> PENDING
// ---------------------------------------------------------------------------

router.post(
  '/waivers/:id/submit',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const waiver = await loadWritableWaiver(id, user);
    if (waiver.status !== WaiverStatus.DRAFT) {
      throw wrongState(waiver, [WaiverStatus.DRAFT], 'submit');
    }
    const result = await prisma.waiver.updateMany({
      where: { id, status: WaiverStatus.DRAFT },
      data: { status: WaiverStatus.PENDING },
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
      );
    }
    res.json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /waivers/:id/approve — PENDING -> APPROVED (rule 4)
// ---------------------------------------------------------------------------

router.post(
  '/waivers/:id/approve',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const actorId = currentUserId(req);
    const now = new Date();
    const waiver = await loadWritableWaiver(id, user);
    if (waiver.status !== WaiverStatus.PENDING) {
      throw wrongState(waiver, [WaiverStatus.PENDING], 'approve');
    }

    /*
     * SELF-APPROVAL IS REFUSED. A bounded exception somebody granted themselves is not a
     * control, it is a note to file — and this record's entire value is that a second person
     * looked at the departure and accepted it.
     *
     * ADMIN IS EXEMPT, and here is why that is acceptable rather than a hole. The exemption
     * is the same one lib/acl.ts invariant 2 makes for every item-level grant: an
     * installation must always have somebody who can reach everything, because otherwise the
     * product deadlocks. A site that is one or two people — a great many of them are —
     * would otherwise have no way to approve any waiver at all, and the alternative is not
     * better separation of duties, it is somebody editing the row in SQL, where nothing
     * records who did it. The control the exemption keeps is ATTRIBUTION, not separation:
     * `approvedById` is stamped with the admin's own id, the request is audited by
     * middleware/audit.ts, and the register shows plainly that the same person asked and
     * granted. 403 rather than 409, because this is a refusal about WHO is asking.
     */
    if (waiver.requestedById === actorId && req.user?.role !== Role.ADMIN) {
      throw new HttpError(
        403,
        `You requested waiver ${waiver.waiverNumber}, so you cannot approve it — ` +
          'a waiver must be approved by somebody other than the requester'
      );
    }

    /*
     * Rule 3 at the approval boundary: approving a waiver whose window has already closed
     * would write APPROVED onto a permission that permits nothing, and that row would then
     * sit in the register reading as live until somebody tried to use it. The refusal names
     * the date, and it does not depend on any job having materialised the status — the PENDING
     * row's own `expiresAt` is the whole input.
     */
    if (isPastExpiry(waiver, now)) {
      throw new HttpError(
        409,
        `Cannot approve waiver ${waiver.waiverNumber}: it expired on ` +
          `${dateOnly(waiver.expiresAt as Date)}. Re-date it before approving.`
      );
    }

    // Resolved BEFORE the transaction opens: who may be TOLD is a read of the part's grants
    // rather than part of this write, and `visibleIds` resolves its delegate from the
    // module-level client, so it would escape this transaction onto another connection
    // regardless (the reason routes/projects.ts does the same).
    const recipients = await recipientsWhoCanReadPart(waiver.partId, [waiver.requestedById]);

    await prisma.$transaction(async (tx) => {
      const result = await tx.waiver.updateMany({
        where: { id, status: WaiverStatus.PENDING },
        // Both stamps, in the same statement as the status, so an APPROVED row never exists
        // without the person who approved it. Nothing below this route enforces that pairing
        // — there is no `Waiver_approved_has_approver` CHECK in this build — so this single
        // statement is the whole of rule 4.
        data: { status: WaiverStatus.APPROVED, approvedById: actorId, approvedAt: now },
      });
      if (result.count === 0) {
        throw new HttpError(
          409,
          `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
        );
      }
      // In the transaction, so a recorded approval whose notification was lost cannot happen:
      // that is the failure that teaches people their inbox is not worth reading.
      await notifyUsers(tx, recipients, actorId, {
        type: 'waiver.approved',
        title: `Waiver ${waiver.waiverNumber} was approved`,
        body: waiver.notes ? `${waiver.waiverNumber} approved. ${waiver.notes}` : null,
        link: `/waivers/${id}`,
      });
    });

    res.json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /waivers/:id/reject — PENDING -> REJECTED
// ---------------------------------------------------------------------------

router.post(
  '/waivers/:id/reject',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const actorId = currentUserId(req);
    const body = requireBody(req);
    const reason = requireText(body.reason, 'reason', 2000);

    const waiver = await loadWritableWaiver(id, user);
    if (waiver.status !== WaiverStatus.PENDING) {
      throw wrongState(waiver, [WaiverStatus.PENDING], 'reject');
    }

    /*
     * The reason is APPENDED TO `notes`, with its author and date.
     *
     * There is no `rejectionReason` column and the schema is final, so the alternatives were
     * to keep the reason only in the requester's notification — where it is one click from
     * being deleted, and invisible to everybody else looking at the register — or to lose it.
     * Why a bounded exception was refused is the one fact a rejected waiver has to keep: it
     * is what stops the same request coming back next week, and what an auditor asks for.
     * Appended rather than overwritten, so the justification the requester wrote survives
     * beside the answer.
     */
    const stamped = `Rejected by ${req.user?.name ?? `user ${actorId}`} on ${dateOnly(
      new Date()
    )}: ${reason}`;
    const notes = waiver.notes ? `${waiver.notes}\n${stamped}` : stamped;

    const recipients = await recipientsWhoCanReadPart(waiver.partId, [waiver.requestedById]);

    await prisma.$transaction(async (tx) => {
      const result = await tx.waiver.updateMany({
        where: { id, status: WaiverStatus.PENDING },
        data: { status: WaiverStatus.REJECTED, notes },
      });
      if (result.count === 0) {
        throw new HttpError(
          409,
          `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
        );
      }
      await notifyUsers(tx, recipients, actorId, {
        type: 'waiver.rejected',
        title: `Waiver ${waiver.waiverNumber} was rejected`,
        body: reason,
        link: `/waivers/${id}`,
      });
    });

    res.json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /waivers/:id/close — APPROVED -> CLOSED, early, by a person
// ---------------------------------------------------------------------------

router.post(
  '/waivers/:id/close',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const now = new Date();
    const waiver = await loadWritableWaiver(id, user);

    await prisma.$transaction(async (tx) => {
      // The stored status may be stale by exactly one thing — a date that has passed with
      // nobody acting — so it is corrected first and then judged. A waiver that already
      // expired is terminal: there is nothing left for a person to end, and reporting it as
      // CLOSED would overwrite WHY it stopped being usable.
      const status = await materialiseExpiry(tx, waiver, now);
      if (status !== WaiverStatus.APPROVED) {
        throw wrongState({ ...waiver, status }, [WaiverStatus.APPROVED], 'close');
      }
      const result = await tx.waiver.updateMany({
        where: { id, status: WaiverStatus.APPROVED },
        // `closedAt` is the stamp; there is no `closedById` column, and the audit trail
        // (middleware/audit.ts) carries who called this.
        data: { status: WaiverStatus.CLOSED, closedAt: now },
      });
      if (result.count === 0) {
        throw new HttpError(
          409,
          `Waiver ${waiver.waiverNumber} was changed concurrently — reload and try again`
        );
      }
    });

    res.json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /waivers/:id/usages — consume one unit of the allowance
// ---------------------------------------------------------------------------

/**
 * THE FILING RULE: a unit may be recorded against a waiver when it is a unit OF the waived
 * part, or a unit of an assembly that USES the waived part.
 *
 * The second half is the one that matters, and leaving it out would make the register
 * unusable. A waiver is written against the thing that departs from its drawing — a bracket —
 * and the thing that ships is the product the bracket is inside. Only ever matching
 * `unit.partId === waiver.partId` would mean a waiver could only be consumed by units of
 * sub-assemblies nobody serialises, so in practice it would never be consumed at all and the
 * remaining allowance would never fall.
 *
 * The walk is `walkWhereUsed(partId, null, user)` — the same upward walk the where-used tab
 * and `lib/changeBrief.ts` use, un-narrowed by revision for the reason changeBrief states:
 * narrowing to pinned lines answers "who is demonstrably holding this revision", which is a
 * different question, and it would refuse a legitimate filing against a product whose BOM line
 * has not been pinned yet (pins are written at release, rule PN3). The failure this rule exists
 * to stop is the UNRELATED product — a bracket waiver consumed by a unit of something that has
 * never contained the bracket, which makes the whole register worthless — and the un-narrowed
 * walk stops exactly that.
 *
 * The answer does not depend on who is asking. `walkWhereUsed` redacts names but keeps every
 * `parentPart.id`, so the id set below is identical for every caller — two people must not get
 * different answers to "is this a legal filing".
 *
 * Resolved BEFORE the transaction opens, because `walkWhereUsed` reads through the
 * module-level client and would otherwise run outside the transaction on another connection.
 */
async function assertUnitBelongsToWaiverPart(
  waiver: { waiverNumber: string; partId: number },
  unit: { identifier: string; partId: number },
  user: AclUser
): Promise<void> {
  if (unit.partId === waiver.partId) return;
  const tree = await walkWhereUsed(waiver.partId, null, user);
  if (tree.used.some((node) => node.parentPart.id === unit.partId)) return;

  const [waiverPart, unitPart] = await Promise.all([
    prisma.part.findUnique({ where: { id: waiver.partId }, select: { partNumber: true } }),
    prisma.part.findUnique({ where: { id: unit.partId }, select: { id: true, partNumber: true } }),
  ]);
  // The caller holds write access on the waiver's part, so naming it is safe; the UNIT's part
  // carries its own grants and is named only if they may see it (rule X2).
  const visible = await visibleIds('PART', unitPart ? [unitPart.id] : [], user);
  const unitPartLabel =
    unitPart && visible.has(unitPart.id) ? unitPart.partNumber : REDACTED.partNumber;
  throw new HttpError(
    409,
    `${unit.identifier} is a unit of ${unitPartLabel}, which neither is nor uses ` +
      `${waiverPart?.partNumber ?? `part ${waiver.partId}`} — waiver ${waiver.waiverNumber} ` +
      'can only be consumed by a unit of that part or of an assembly that uses it' +
      // When the upward walk hit its depth cap the id set may be short, so the refusal says
      // so rather than stating a structural conclusion it cannot support.
      (tree.notes.length > 0 ? `. ${tree.notes.join(' ')}` : '')
  );
}

router.post(
  '/waivers/:id/usages',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const actorId = currentUserId(req);
    const now = new Date();

    const waiver = await loadWritableWaiver(id, user);
    const body = requireBody(req);
    const buildUnitId = optionalId(body.buildUnitId, 'buildUnitId');
    if (buildUnitId === null) throw new HttpError(400, 'buildUnitId is required');
    const notes = body.notes === undefined ? null : optionalText(body.notes, 'notes');

    /*
     * The unit must be readable, and a restricted one answers exactly like a nonexistent one —
     * 400, because the id is one field of a larger write, which is the shape and the wording
     * `assertBuildUnitExists` in routes/quality.ts already uses.
     *
     * READ on the unit, not WRITE: this row is a fact about the waiver's allowance, not a
     * change to the unit's own record (nothing about the unit's build, status or structure
     * moves). The write gate is on the PART whose design is being departed from, and
     * `loadWritableWaiver` has already applied it.
     *
     * The unit's `status` is deliberately not constrained: permission is recorded when the
     * unit is built, which is before it ships, and requiring SHIPPED would mean the register
     * could only ever be filled in after the fact.
     */
    const unit = await prisma.buildUnit.findFirst({
      where: {
        id: buildUnitId,
        ...(aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput),
      },
      select: { id: true, identifier: true, partId: true },
    });
    if (!unit) throw new HttpError(400, 'buildUnitId does not reference an existing build unit');
    await assertUnitBelongsToWaiverPart(waiver, unit, user);

    await prisma.$transaction(async (tx) => {
      /*
       * THE RACE (rule 2), and how it is closed.
       *
       * Recording a usage is check-then-write on a COUNT: two requests for the last remaining
       * unit can each count 4 of 5 against their own snapshot, each conclude there is one
       * left, and both insert — and the waiver has then authorised six units while reading as
       * bounded at five. `WaiverUsage_waiverId_buildUnitId_key` does not help, because the two
       * requests name DIFFERENT units, which is the legitimate case.
       *
       * So the check and the write are serialised on one advisory lock, with the same
       * primitive and the same discipline as the BOM-structure write in routes/bom.ts and the
       * ECN membership check in routes/ecns.ts. The one-argument form is the whole scope
       * wanted here: every usage write in this installation queues behind every other for the
       * few statements this transaction takes, and nothing else contends for this key.
       *
       * Three things make it actually hold:
       *  - The lock is taken INSIDE the interactive transaction opened above, so it is held
       *    until that transaction commits. `pg_advisory_xact_lock` issued on an autocommit
       *    statement would be released the moment that statement returned — a lock nobody
       *    holds, with no symptom until two requests interleave.
       *  - The lock is taken BEFORE the count, so no decision is made on a snapshot taken
       *    while another writer was mid-flight.
       *  - The transaction runs at Postgres' default READ COMMITTED, where every statement
       *    takes a FRESH snapshot. The second request blocks on the lock until the first
       *    COMMITS, and its `count` then sees that committed row. This is the one place the
       *    isolation level is load-bearing: under REPEATABLE READ the snapshot would be fixed
       *    before the lock was granted, the count would miss the row that had just landed,
       *    and the lock would be serialising two decisions made on identical stale data. No
       *    `isolationLevel` is passed here, deliberately.
       */
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-waiver-usage'))::text`;

      // Re-read inside the lock: everything decided below must come from the state the insert
      // will actually land on, not from the read that preceded the lock.
      const current = await tx.waiver.findUnique({
        where: { id },
        select: {
          waiverNumber: true,
          status: true,
          quantityLimit: true,
          expiresAt: true,
          closedAt: true,
        },
      });
      if (!current) throw new HttpError(404, 'Waiver not found');
      const status = await materialiseExpiry(tx, { id, ...current }, now);
      const usedCount = await tx.waiverUsage.count({ where: { waiverId: id } });
      const refusal = consumptionRefusal({ ...current, status }, usedCount, now);
      if (refusal !== null) throw new HttpError(409, refusal);

      try {
        await tx.waiverUsage.create({
          data: { waiverId: id, buildUnitId, recordedById: actorId, notes },
          select: { id: true },
        });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002') {
          // One unit cannot spend the allowance twice. Caught here so it reads as the rule it
          // is rather than as errorMiddleware's generic duplicate-value 409.
          throw new HttpError(
            409,
            `${unit.identifier} is already recorded against waiver ${current.waiverNumber}`
          );
        }
        throw err;
      }
    });

    res.status(201).json(await getWaiverOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /waiver-usages/:id — recorded in error
// ---------------------------------------------------------------------------

router.delete(
  '/waiver-usages/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Scoped through the waiver's part two relations up: a usage of a waiver on a part the
    // caller cannot read does not exist (rules X2-X3), exactly as routes/materials.ts scopes
    // a part-attached row.
    const usage = await prisma.waiverUsage.findFirst({
      where: { id, waiver: { part: partAcl(user) } },
      select: { id: true, waiverId: true, waiver: { select: { partId: true } } },
    });
    if (!usage) throw new HttpError(404, 'Waiver usage not found');
    await assertCanWrite('PART', usage.waiver.partId, user);

    /*
     * Allowed whatever state the waiver is in, and that is the point of rule 1.
     *
     * This endpoint exists for a unit recorded against the wrong waiver, and the mistake is
     * usually noticed later — after the waiver was closed, or after it expired. Refusing the
     * correction then would leave the register permanently wrong about which units went out
     * under which exception, which is the question the register is kept for. No lock is
     * needed: a delete only ever RAISES the remaining allowance, so it cannot oversubscribe
     * anything, and `remaining` is recomputed from the rows on the next read — which is the
     * behaviour a stored counter would get wrong.
     */
    await prisma.waiverUsage.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
