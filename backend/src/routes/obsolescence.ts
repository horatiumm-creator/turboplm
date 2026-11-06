/**
 * Component obsolescence: what the manufacturer told us, what it reaches, and what is known.
 *
 * Three things live here and the division between them is the whole design:
 *
 *  1. `ManufacturerNotice` — the PCN/EOL/NRND email, recorded as received. One notice routinely
 *     names a family of MPNs, so the dates belong to the notice and the items hang off it.
 *  2. `ManufacturerPart.lifecycle` and its dates — THE FACT, carried off the notice onto the
 *     part so it survives the notice being superseded, corrected or deleted.
 *  3. `GET /obsolescence/risk` — the report. For every MPN the manufacturer has stopped
 *     standing behind: which internal part carries it, which PRODUCTS that reaches, how much
 *     has been built and shipped, and how long until last-time-buy.
 *
 * THE LINE THIS FILE WILL NOT CROSS, stated once here and again at the report below:
 * nothing in this module computes a recommended last-time-buy quantity. See
 * `OBSOLESCENCE_RISK_REFUSAL`.
 *
 * `ManufacturerPart.status` (AmlStatus) is NEVER written here. It is this organisation's own
 * sourcing decision — preferred, approved, alternate, obsolete-to-us — and a supplier's email
 * does not get to edit it. `lifecycle` is the manufacturer's fact. They disagree constantly and
 * both answers are legitimate; conflating them would let a procurement decision silently
 * rewrite an engineering fact, or the reverse. Editing `status` stays in routes/sourcing.ts,
 * where a human chose it.
 *
 * Notifications are IN-APP ONLY, through `notifyUsers`. Nothing in this file goes near the
 * mailer, and every recipient list is narrowed by `visibleIds` first: somebody who cannot read
 * a part must not learn from their inbox that it is going end-of-life.
 */
import { Request, Router } from 'express';
import {
  AmlStatus,
  BuildStatus,
  EcnStatus,
  NoticeKind,
  PartLifecycle,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam, positiveIntQuery } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';
import { AclUser, REDACTED, aclFilter, assertCanRead, assertCanWrite, visibleIds } from '../lib/acl';
import { WhereUsedTreeDto, walkWhereUsed } from '../lib/whereUsed';
import { withNumberLock } from '../lib/plm';

const router = Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Response DTO shapes
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface ManufacturerRefDto {
  id: number;
  name: string;
}

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
}

/**
 * The redacted stand-in for a linked item the caller may not read (rule X4). The four core
 * fields always come from the shared `REDACTED`; a shape carrying extra identity gets its own
 * fields as the same constant, so nothing of the hidden item survives while every field the UI
 * reads still exists. Same construction as routes/projects.ts.
 */
interface RedactedRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}
type RedactedMpnRefDto = RedactedRefDto & { mpn: 'Restricted' };
type RedactedEcnRefDto = RedactedRefDto & { ecnNumber: 'Restricted' };
type RedactedDocumentRefDto = RedactedRefDto & { docNumber: 'Restricted'; title: 'Restricted' };

const REDACTED_MPN: RedactedMpnRefDto = { ...REDACTED, mpn: 'Restricted' };
// `status` is dropped rather than nulled: an ECN's state is real data about a hidden item, and
// no total on these responses is computed from it.
const REDACTED_ECN: RedactedEcnRefDto = { ...REDACTED, ecnNumber: 'Restricted' };
const REDACTED_DOCUMENT: RedactedDocumentRefDto = {
  ...REDACTED,
  docNumber: 'Restricted',
  title: 'Restricted',
};

type DocumentRefDto = { id: number; docNumber: string; title: string } | RedactedDocumentRefDto;
type EcnRefDto = { id: number; ecnNumber: string; status: EcnStatus } | RedactedEcnRefDto;

interface NoticeSummaryDto {
  id: number;
  noticeNumber: string;
  kind: NoticeKind;
  manufacturer: ManufacturerRefDto;
  reference: string | null;
  title: string;
  summary: string | null;
  issuedAt: string | null;
  effectiveAt: string | null;
  lastTimeBuyAt: string | null;
  replacementMpn: string | null;
  document: DocumentRefDto | null;
  receivedBy: UserRefDto;
  itemCount: number;
  createdAt: string;
}

/**
 * One MPN named by a notice.
 *
 * A restricted internal part makes this row REDACTED rather than absent (rule X4). Dropping it
 * would make a notice that covers six parts read as covering five, and the missing one is
 * precisely the one the reader has no other way to find out about.
 */
interface NoticeItemDto {
  id: number;
  disposition: string | null;
  ecn: EcnRefDto | null;
  manufacturerPart: ManufacturerPartRefDto | RedactedMpnRefDto;
  part: PartRefDto | RedactedRefDto;
  /** Top-level assemblies the internal part reaches. Empty on a redacted row. */
  products: ProductRefDto[];
  /** Products reached but not readable. Counted so the reach stays honest. */
  redactedProducts: number;
  /** True when the upward walk hit its depth cap, so `products` may be short. */
  truncated: boolean;
  createdAt: string;
}

interface NoticeDetailDto extends NoticeSummaryDto {
  items: NoticeItemDto[];
  /** Items whose internal part this caller may not read — redacted above, counted here. */
  redactedItems: number;
}

interface ManufacturerPartRefDto {
  id: number;
  mpn: string;
  manufacturer: ManufacturerRefDto;
  /** THE MANUFACTURER'S FACT. */
  lifecycle: PartLifecycle;
  /**
   * THIS ORGANISATION'S SOURCING DECISION, reported beside the lifecycle and never merged into
   * it. Named `sourcingStatus` rather than `status` so no screen can show one as the other.
   */
  sourcingStatus: AmlStatus;
  eolAnnouncedAt: string | null;
  lastTimeBuyAt: string | null;
  lastShipAt: string | null;
  replacementMpn: string | null;
}

interface ProductRefDto extends PartRefDto {
  /** How far above the internal part this product sits. 1 = it uses it directly. */
  level: number;
  /** The route from the internal part up to it, for reading the chain back. */
  path: string[];
}

/**
 * Build units, counted — never estimated, and never counted over rows the caller cannot read.
 *
 * `aclFilter` is applied to every count here. A total computed over invisible rows leaks their
 * existence, which is why `redacted` exists instead (rule X4, and the note in lib/acl.ts under
 * "Applying the filter").
 */
interface UnitCountsDto {
  /** Ever built and not thrown away: every status except SCRAPPED. */
  built: number;
  shipped: number;
  /** Status IN_PROGRESS — units on the floor right now, which still need the part. */
  inBuild: number;
  /**
   * SHIPPED rows carrying no `shippedAt`. The window below cannot describe them, and saying so
   * is the difference between a period and a guess.
   */
  shippedUndated: number;
  /** First and last DATED shipment, and the whole days between them. Null when none is dated. */
  shippedFirstAt: string | null;
  shippedLastAt: string | null;
  shippedOverDays: number | null;
  /** Units excluded because the caller may not read them. Counted so the total stays honest. */
  redacted: number;
}

/**
 * How a last-time-buy date sits against `asOf`.
 *
 * `NO_DATE` is its own value for the same reason `ComplianceStatus.UNKNOWN` is: an absent
 * last-time-buy is not a distant one. Nobody has been told when the window shuts.
 */
type LastTimeBuyBucket =
  | 'PASSED'
  | 'WITHIN_30_DAYS'
  | 'WITHIN_90_DAYS'
  | 'WITHIN_365_DAYS'
  | 'LATER'
  | 'NO_DATE';

interface LastTimeBuyDto {
  at: string | null;
  /** Whole days from `asOf`. NEGATIVE once the date is behind us; null when there is none. */
  daysRemaining: number | null;
  /** True only when a date exists AND it has passed. A missing date is not a passed one. */
  passed: boolean;
  bucket: LastTimeBuyBucket;
}

interface NoticeRefDto {
  id: number;
  noticeNumber: string;
  kind: NoticeKind;
  issuedAt: string | null;
}

/**
 * One manufacturer part the manufacturer has stopped standing behind, and everything KNOWN
 * about what that reaches.
 *
 * WHAT IS DELIBERATELY NOT HERE — see `OBSOLESCENCE_RISK_REFUSAL`.
 */
interface RiskRowDto {
  manufacturerPart: ManufacturerPartRefDto;
  part: PartRefDto;
  products: ProductRefDto[];
  redactedProducts: number;
  truncated: boolean;
  units: {
    /** Units of the internal part itself — present only where the component is serialised. */
    ofPart: UnitCountsDto;
    /** Units of the products reached. Summed over the READABLE products only. */
    ofProducts: UnitCountsDto;
  };
  lastTimeBuy: LastTimeBuyDto;
  /**
   * The values the sort used, in the order it used them (`ordering` on the response names
   * them). Published so a reader can see WHICH input put a row where it is, rather than being
   * handed a score that hides it.
   */
  sortKey: {
    lastTimeBuyBucket: LastTimeBuyBucket;
    shippedUnits: number;
    lifecycle: PartLifecycle;
  };
  /** The notices that said so, newest first — "what did they actually tell us, and when". */
  notices: NoticeRefDto[];
}

/**
 * A part with lifecycle UNKNOWN. Lighter than `RiskRowDto` ON PURPOSE, and this is the one
 * judgement call in the report worth stating plainly.
 *
 * UNKNOWN is the schema default, so in a populated database this bucket is most of the AML. A
 * full upward walk per row — which is what `RiskRowDto` costs — would make the report
 * unloadable precisely for the customers who most need it. The action an UNKNOWN row implies
 * is "go ask the manufacturer", not "assess the exposure", and that needs the MPN and nothing
 * else. Anything here can be run through `GET /manufacturer-parts/:id/impact` for the full
 * answer one row at a time.
 */
interface UnknownLifecycleRowDto {
  manufacturerPart: ManufacturerPartRefDto;
  part: PartRefDto;
  /** True when a notice names this MPN — somebody was told something and nobody recorded it. */
  hasNotice: boolean;
}

interface ObsolescenceRiskDto {
  asOf: string;
  /** NRND, EOL_ANNOUNCED and OBSOLETE, most urgent first. See `ordering`. */
  atRisk: RiskRowDto[];
  /**
   * Lifecycle UNKNOWN — its OWN bucket, never folded in with ACTIVE. Nobody has asked the
   * manufacturer, which is a different and much more common state than "we asked and they
   * still ship it". Exactly as the schedule-health endpoint reports undated work rather than
   * filing it under "fine".
   */
  unknownLifecycle: UnknownLifecycleRowDto[];
  counts: {
    /** Complete, from count queries — NOT the length of the lists, which are capped. */
    atRisk: number;
    unknownLifecycle: number;
    byLifecycle: Record<PartLifecycle, number>;
    lastTimeBuyPassed: number;
    lastTimeBuyNoDate: number;
    /**
     * At-risk MPNs on internal parts this caller may not read. Counted, identity stripped: an
     * obsolescence report that silently omitted them would report a dangerous situation as
     * safe, which is the one error this screen must not make.
     */
    restrictedAtRisk: number;
    restrictedUnknownLifecycle: number;
  };
  /** The sort inputs, in precedence order. There is no composite score. */
  ordering: string[];
  notes: string[];
}

interface ImpactDto {
  asOf: string;
  manufacturerPart: ManufacturerPartRefDto;
  part: PartRefDto;
  products: ProductRefDto[];
  redactedProducts: number;
  truncated: boolean;
  units: { ofPart: UnitCountsDto; ofProducts: UnitCountsDto };
  lastTimeBuy: LastTimeBuyDto;
  notices: NoticeRefDto[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// THE REFUSAL
// ---------------------------------------------------------------------------

/**
 * WHY THERE IS NO RECOMMENDED LAST-TIME-BUY QUANTITY ON ANY RESPONSE IN THIS FILE.
 *
 * It is the first thing everybody asks for, and the honest answer is that nobody knows. A
 * last-time-buy quantity is a function of demand over the remaining life of the product, and
 * that demand is not in this database — nobody has committed to it. Every number this code
 * could produce would be built on an assumption it invented: that next year looks like last
 * year, that the shipped history is the forecast, that the open build is the whole pipeline.
 *
 * So the report states what is RETRIEVED and stops:
 *   - units shipped, and the period those shipments actually span (`shippedOverDays`), plus
 *     how many shipments carry no date and therefore are not in that period at all,
 *   - units in build right now,
 *   - the products reached, and how many were reached but not readable,
 *   - the days remaining until last-time-buy, negative once it has passed.
 * A human multiplies. They know which programmes are being quoted and which are winding down;
 * this process does not.
 *
 * This is the same refusal `lib/uom.ts` makes when it returns null rather than converting
 * across dimensions, and the same one `GET /projects/:id/health` makes with its `unknown`
 * bucket. Here it is worth more: a confident wrong number is a six-figure purchase of parts
 * nobody needs, or a line stopped for want of a part that was available for one more week.
 *
 * DO NOT ADD THE FIELD. If somebody needs a forecast, it belongs where the demand is
 * committed, under a name that says whose assumption it is. tests/obsolescence.test.ts
 * asserts that no response here carries a field of this kind, so adding one fails the suite
 * rather than shipping quietly.
 */
const OBSOLESCENCE_RISK_REFUSAL =
  'This report states what is known, not how many to buy. The quantity depends on demand ' +
  'nobody has committed to, so the inputs are listed and the arithmetic is left to a person.';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
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

function optionalText(value: unknown, label: string, max = 2000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed === '' ? null : trimmed;
}

/**
 * A positive `int4` id out of a request BODY, or null when absent.
 *
 * Digits and nothing else, matched rather than coerced — the rule `lib/errors.ts` states for a
 * path parameter and routes/projects.ts restates for a body. `Number()` is not a format check:
 * it reads `true` as 1, so the coercing version accepts `{"manufacturerPartId": true}` as
 * manufacturer part 1 and carries an EOL date onto whatever that happens to be.
 */
function optionalId(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

function requireId(value: unknown, label: string): number {
  const id = optionalId(value, label);
  if (id === null) throw new HttpError(400, `${label} is required`);
  return id;
}

function parseDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
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

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

// ---------------------------------------------------------------------------
// Notice numbering
// ---------------------------------------------------------------------------

/**
 * MN-10001 upward, scanned out of the table the way every other numbered record here is
 * generated — `generateEcrNumber` in routes/ecrs.ts, `nextNumber` in routes/quality.ts.
 *
 * ONE run for all four kinds rather than a run per kind: a notice's number is its filing
 * reference, people quote it back, and `kind` is editable — so numbering by kind would mean
 * either renumbering a filed record or two notices sharing a number. The kind is a column, not
 * part of the identifier.
 *
 * The regex keeps the scan to numbers drawn from the generated space, so anything imported
 * under somebody else's scheme reads as NULL and correctly does not move the start. Call this
 * under the numbering lock — the maximum it reads is stale the moment two creates overlap.
 */
async function generateNoticeNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("noticeNumber" FROM 4)::int) AS max
    FROM "ManufacturerNotice"
    WHERE "noticeNumber" ~ '^MN-[0-9]{1,9}$'`;
  return `MN-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

// ---------------------------------------------------------------------------
// Includes + mappers
// ---------------------------------------------------------------------------

const noticeInclude = {
  manufacturer: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  document: { select: { id: true, docNumber: true, title: true } },
  _count: { select: { items: true } },
} satisfies Prisma.ManufacturerNoticeInclude;

type NoticeRow = Prisma.ManufacturerNoticeGetPayload<{ include: typeof noticeInclude }>;

const manufacturerPartSelect = {
  id: true,
  mpn: true,
  status: true,
  lifecycle: true,
  eolAnnouncedAt: true,
  lastTimeBuyAt: true,
  lastShipAt: true,
  replacementMpn: true,
  partId: true,
  manufacturerId: true,
  manufacturer: { select: { id: true, name: true } },
  part: { select: { id: true, partNumber: true, name: true } },
} satisfies Prisma.ManufacturerPartSelect;

type ManufacturerPartRow = Prisma.ManufacturerPartGetPayload<{
  select: typeof manufacturerPartSelect;
}>;

function toManufacturerPartRef(row: ManufacturerPartRow): ManufacturerPartRefDto {
  return {
    id: row.id,
    mpn: row.mpn,
    manufacturer: { id: row.manufacturer.id, name: row.manufacturer.name },
    lifecycle: row.lifecycle,
    sourcingStatus: row.status,
    eolAnnouncedAt: iso(row.eolAnnouncedAt),
    lastTimeBuyAt: iso(row.lastTimeBuyAt),
    lastShipAt: iso(row.lastShipAt),
    replacementMpn: row.replacementMpn,
  };
}

function toPartRef(part: { id: number; partNumber: string; name: string }): PartRefDto {
  return { id: part.id, partNumber: part.partNumber, name: part.name };
}

function toNoticeSummary(row: NoticeRow, visibleDocuments: ReadonlySet<number>): NoticeSummaryDto {
  return {
    id: row.id,
    noticeNumber: row.noticeNumber,
    kind: row.kind,
    manufacturer: { id: row.manufacturer.id, name: row.manufacturer.name },
    reference: row.reference,
    title: row.title,
    summary: row.summary,
    issuedAt: iso(row.issuedAt),
    effectiveAt: iso(row.effectiveAt),
    lastTimeBuyAt: iso(row.lastTimeBuyAt),
    replacementMpn: row.replacementMpn,
    // A document the caller may not read is redacted rather than named: its id and number are
    // real data about a hidden item, and a notice is a perfectly good place to discover one.
    document: row.document
      ? visibleDocuments.has(row.document.id)
        ? { id: row.document.id, docNumber: row.document.docNumber, title: row.document.title }
        : REDACTED_DOCUMENT
      : null,
    receivedBy: { id: row.receivedBy.id, name: row.receivedBy.name },
    itemCount: row._count.items,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The visible subset of the documents a set of notices attaches, in one query. */
async function visibleNoticeDocuments(
  rows: readonly { document: { id: number } | null }[],
  user: AclUser
): Promise<Set<number>> {
  const ids = rows.flatMap((row) => (row.document ? [row.document.id] : []));
  return visibleIds('DOCUMENT', ids, user);
}

// ---------------------------------------------------------------------------
// The upward walk, reused rather than rewritten
// ---------------------------------------------------------------------------

/**
 * `walkWhereUsed` per internal part, memoised for the length of one request.
 *
 * Memoised because several MPNs on one report routinely belong to the SAME internal part — an
 * AML with three approved sources that all went end-of-life together is the normal case for the
 * parts this report is about — and the walk is the expensive half of a row.
 *
 * There is deliberately no second walk anywhere in this file. lib/whereUsed.ts exists because
 * `GET /ecns/:id/impact` grew a shallower answer beside it and reported sub-assemblies where
 * the question was about products; a third implementation would be the same mistake again.
 */
function makeWalker(user: AclUser): (partId: number) => Promise<WhereUsedTreeDto> {
  const cache = new Map<number, Promise<WhereUsedTreeDto>>();
  return (partId: number) => {
    const hit = cache.get(partId);
    if (hit) return hit;
    const walk = walkWhereUsed(partId, null, user);
    cache.set(partId, walk);
    return walk;
  };
}

interface ReachedProducts {
  products: ProductRefDto[];
  redactedProducts: number;
  truncated: boolean;
}

/**
 * The top-level products a part reaches, split into named and counted.
 *
 * `walkWhereUsed` already redacts the names of products the caller may not read and keeps them
 * in the list. They are counted here and dropped from `products` rather than listed as
 * `Restricted` rows, which is the shape `lib/changeBrief.ts` settled on: a reader scanning a
 * reach list wants the products they can act on, and the count is what keeps the total honest.
 */
async function reachedProducts(
  partId: number,
  walker: (partId: number) => Promise<WhereUsedTreeDto>,
  user: AclUser
): Promise<ReachedProducts & { tree: WhereUsedTreeDto }> {
  const tree = await walker(partId);
  const top = tree.topLevel;
  const visible = await visibleIds(
    'PART',
    top.map((node) => node.parentPart.id),
    user
  );
  const readable = top.filter((node) => visible.has(node.parentPart.id));
  return {
    products: readable.map((node) => ({
      id: node.parentPart.id,
      partNumber: node.parentPart.partNumber,
      name: node.parentPart.name,
      level: node.level,
      path: node.path,
    })),
    redactedProducts: top.length - readable.length,
    truncated: tree.notes.length > 0,
    tree,
  };
}

// ---------------------------------------------------------------------------
// Build and ship counts
// ---------------------------------------------------------------------------

interface UnitTally {
  built: number;
  shipped: number;
  inBuild: number;
  shippedUndated: number;
  shippedFirstAt: Date | null;
  shippedLastAt: Date | null;
  redacted: number;
}

const EMPTY_TALLY: UnitCountsDto = {
  built: 0,
  shipped: 0,
  inBuild: 0,
  shippedUndated: 0,
  shippedFirstAt: null,
  shippedLastAt: null,
  shippedOverDays: null,
  redacted: 0,
};

/**
 * Every build-unit figure the report needs, for every part it names, in four queries.
 *
 * Grouped rather than asked per part: a report of a hundred rows, each with its own products,
 * is a thousand parts, and five counts apiece would be five thousand statements. `groupBy`
 * gives the counts and the shipment window together.
 *
 * SCRAPPED is excluded from `built`: it was made and thrown away, so it is not hardware the
 * obsolescence of a component has to be reconciled against — the same exclusion
 * `lib/changeBrief.ts` makes, and for the same reason.
 */
async function tallyUnits(partIds: readonly number[], user: AclUser): Promise<Map<number, UnitTally>> {
  const tallies = new Map<number, UnitTally>();
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return tallies;

  const blank = (partId: number): UnitTally => {
    const existing = tallies.get(partId);
    if (existing) return existing;
    const fresh: UnitTally = {
      built: 0,
      shipped: 0,
      inBuild: 0,
      shippedUndated: 0,
      shippedFirstAt: null,
      shippedLastAt: null,
      redacted: 0,
    };
    tallies.set(partId, fresh);
    return fresh;
  };

  const acl = aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput;

  const byStatus = await prisma.buildUnit.groupBy({
    by: ['partId', 'status'],
    where: { partId: { in: ids }, ...acl },
    _count: { _all: true },
    _min: { shippedAt: true },
    _max: { shippedAt: true },
  });
  for (const group of byStatus) {
    const tally = blank(group.partId);
    const count = group._count._all;
    if (group.status !== BuildStatus.SCRAPPED) tally.built += count;
    if (group.status === BuildStatus.IN_PROGRESS) tally.inBuild += count;
    if (group.status === BuildStatus.SHIPPED) {
      tally.shipped += count;
      tally.shippedFirstAt = group._min.shippedAt;
      tally.shippedLastAt = group._max.shippedAt;
    }
  }

  // Shipped with no date. Counted separately because a window computed over the dated rows
  // alone would otherwise read as describing every shipment, which is the quiet way a period
  // becomes a guess.
  const undated = await prisma.buildUnit.groupBy({
    by: ['partId'],
    where: { partId: { in: ids }, status: BuildStatus.SHIPPED, shippedAt: null, ...acl },
    _count: { _all: true },
  });
  for (const group of undated) blank(group.partId).shippedUndated = group._count._all;

  /*
   * The redacted count — the ONLY query here without the ACL filter, and it returns nothing
   * but a number per part.
   *
   * A count over rows the caller cannot read would leak their existence if it were folded into
   * `built`; reported on its own it is rule X4's "counted and stripped of identity", and it is
   * what stops a restricted programme's shipments from making a component look unused.
   */
  const totals = await prisma.buildUnit.groupBy({
    by: ['partId'],
    where: { partId: { in: ids }, status: { not: BuildStatus.SCRAPPED } },
    _count: { _all: true },
  });
  for (const group of totals) {
    const tally = blank(group.partId);
    tally.redacted = Math.max(0, group._count._all - tally.built);
  }

  return tallies;
}

function toUnitCounts(tally: UnitTally | undefined): UnitCountsDto {
  if (!tally) return { ...EMPTY_TALLY };
  const first = tally.shippedFirstAt;
  const last = tally.shippedLastAt;
  return {
    built: tally.built,
    shipped: tally.shipped,
    inBuild: tally.inBuild,
    shippedUndated: tally.shippedUndated,
    shippedFirstAt: iso(first),
    shippedLastAt: iso(last),
    // Null, not zero, when nothing is dated: zero days would read as "they all went out at
    // once", which is a fact about the data rather than about the shipments.
    shippedOverDays:
      first && last ? Math.max(0, Math.round((last.getTime() - first.getTime()) / DAY_MS)) : null,
    redacted: tally.redacted,
  };
}

/** The same shape summed over several parts — the products one row reaches. */
function sumUnitCounts(
  partIds: readonly number[],
  tallies: ReadonlyMap<number, UnitTally>
): UnitCountsDto {
  let first: Date | null = null;
  let last: Date | null = null;
  const total: UnitTally = {
    built: 0,
    shipped: 0,
    inBuild: 0,
    shippedUndated: 0,
    shippedFirstAt: null,
    shippedLastAt: null,
    redacted: 0,
  };
  for (const partId of new Set(partIds)) {
    const tally = tallies.get(partId);
    if (!tally) continue;
    total.built += tally.built;
    total.shipped += tally.shipped;
    total.inBuild += tally.inBuild;
    total.shippedUndated += tally.shippedUndated;
    total.redacted += tally.redacted;
    if (tally.shippedFirstAt && (!first || tally.shippedFirstAt < first)) {
      first = tally.shippedFirstAt;
    }
    if (tally.shippedLastAt && (!last || tally.shippedLastAt > last)) last = tally.shippedLastAt;
  }
  total.shippedFirstAt = first;
  total.shippedLastAt = last;
  return toUnitCounts(total);
}

// ---------------------------------------------------------------------------
// Last-time-buy, and the urgency order
// ---------------------------------------------------------------------------

function lastTimeBuyOf(at: Date | null, asOf: Date): LastTimeBuyDto {
  if (at === null) {
    return { at: null, daysRemaining: null, passed: false, bucket: 'NO_DATE' };
  }
  /*
   * Rounded, not truncated, and signed. A date 18 hours behind us must read as passed rather
   * than as "0 days left": the window is shut, and the only number that says so is a negative
   * one. Purchasing reads this field and nothing else.
   */
  const days = Math.round((at.getTime() - asOf.getTime()) / DAY_MS);
  const passed = at.getTime() < asOf.getTime();
  const bucket: LastTimeBuyBucket = passed
    ? 'PASSED'
    : days <= 30
      ? 'WITHIN_30_DAYS'
      : days <= 90
        ? 'WITHIN_90_DAYS'
        : days <= 365
          ? 'WITHIN_365_DAYS'
          : 'LATER';
  return { at: at.toISOString(), daysRemaining: days, passed, bucket };
}

/**
 * The urgency order, as a precedence of NAMED inputs rather than a score.
 *
 * A composite number — days-remaining divided by shipped units, weighted by lifecycle — would
 * sort the list plausibly and tell nobody why. Two rows a place apart would differ for reasons
 * the reader cannot recover, and the first thing anybody does with a score they cannot explain
 * is stop trusting the list. So the comparison is lexicographic over three values, every one of
 * which is printed on the row it decided (`sortKey`):
 *
 *   1. the last-time-buy bucket — passed first, then nearest,
 *   2. shipped units, descending — this is what makes a near date WITH shipped history outrank
 *      a near date with none,
 *   3. lifecycle, OBSOLETE first — the manufacturer has already stopped.
 *
 * NO_DATE sorts last, and that is NOT a claim that it is least urgent. An undated last-time-buy
 * cannot be ordered against a dated one at all; it goes at the end because it has to go
 * somewhere, and `counts.lastTimeBuyNoDate` plus a note on the response say how many rows are
 * down there and why. Folding them in among the dated rows would be worse: it would put a
 * position on them that the data does not support.
 */
const LTB_RANK: Record<LastTimeBuyBucket, number> = {
  PASSED: 0,
  WITHIN_30_DAYS: 1,
  WITHIN_90_DAYS: 2,
  WITHIN_365_DAYS: 3,
  LATER: 4,
  NO_DATE: 5,
};

/** OBSOLETE first. UNKNOWN never reaches this comparison — it has its own bucket. */
const LIFECYCLE_URGENCY: Record<PartLifecycle, number> = {
  [PartLifecycle.OBSOLETE]: 0,
  [PartLifecycle.EOL_ANNOUNCED]: 1,
  [PartLifecycle.NRND]: 2,
  [PartLifecycle.UNKNOWN]: 3,
  [PartLifecycle.ACTIVE]: 4,
};

const RISK_ORDERING = ['lastTimeBuyBucket', 'shippedUnits', 'lifecycle', 'manufacturerPartId'];

function compareRisk(a: RiskRowDto, b: RiskRowDto): number {
  return (
    LTB_RANK[a.sortKey.lastTimeBuyBucket] - LTB_RANK[b.sortKey.lastTimeBuyBucket] ||
    b.sortKey.shippedUnits - a.sortKey.shippedUnits ||
    LIFECYCLE_URGENCY[a.sortKey.lifecycle] - LIFECYCLE_URGENCY[b.sortKey.lifecycle] ||
    a.manufacturerPart.id - b.manufacturerPart.id
  );
}

/** The three lifecycles the manufacturer has said something about. */
const AT_RISK_LIFECYCLES: PartLifecycle[] = [
  PartLifecycle.NRND,
  PartLifecycle.EOL_ANNOUNCED,
  PartLifecycle.OBSOLETE,
];

/**
 * How many rows the report details before it says it stopped.
 *
 * The COUNTS stay complete — they come from count queries, not from the length of these lists
 * — so a truncated report still states the size of the problem. Only the detail is capped,
 * and a note says so, which is the trade `lib/whereUsed.ts` makes at its depth cap: a
 * truncated answer that admits it, rather than a wrong one.
 */
const MAX_RISK_ROWS = 100;
const MAX_UNKNOWN_ROWS = 200;
/** Notices per row. Enough to see the history; a family EOL can name the same MPN often. */
const NOTICES_PER_ROW = 5;

// ---------------------------------------------------------------------------
// Carrying a notice's facts onto the manufacturer part
// ---------------------------------------------------------------------------

/**
 * What each kind of notice asserts about a part's lifecycle, or null where it asserts nothing.
 *
 * PCN is deliberately null. A product change notice says the part is CHANGING and remains
 * available; writing a lifecycle off one would mark a part end-of-life because its datasheet
 * revision moved, and the next report would show a live part as obsolete.
 */
const KIND_LIFECYCLE: Record<NoticeKind, PartLifecycle | null> = {
  [NoticeKind.PCN]: null,
  [NoticeKind.EOL]: PartLifecycle.EOL_ANNOUNCED,
  [NoticeKind.NRND]: PartLifecycle.NRND,
  [NoticeKind.DISCONTINUED]: PartLifecycle.OBSOLETE,
};

/**
 * How far along the lifecycle a state is, for the advance-only rule below. UNKNOWN is lowest
 * because it is the absence of an answer rather than a stage.
 */
const LIFECYCLE_PROGRESSION: Record<PartLifecycle, number> = {
  [PartLifecycle.UNKNOWN]: 0,
  [PartLifecycle.ACTIVE]: 1,
  [PartLifecycle.NRND]: 2,
  [PartLifecycle.EOL_ANNOUNCED]: 3,
  [PartLifecycle.OBSOLETE]: 4,
};

/**
 * The facts a notice carries onto the `ManufacturerPart`, so they survive the notice.
 *
 * WHY THIS WRITE EXISTS AT ALL. The notice is a record of what arrived; the part is what every
 * report reads. A notice gets superseded, corrected, or deleted when somebody tidies up, and if
 * the lifecycle lived only on the notice then a tidy-up would quietly make an end-of-life part
 * look live again. Carrying the fact onto the part is what makes `GET /obsolescence/risk`
 * answerable from one table.
 *
 * `status` (AmlStatus) IS NOT IN THE RETURNED OBJECT AND MUST NEVER BE. It is this
 * organisation's sourcing decision — whether this source is preferred, approved, alternate, or
 * one we have stopped using — and it is not a supplier's email's business to edit it. A
 * manufacturer announcing EOL does not decide that we have dropped the part, and a part we
 * still call PREFERRED while we burn down stock is a legitimate state. Changing `status` is a
 * human act in routes/sourcing.ts.
 *
 * THREE RULES, each preventing a specific wrong answer:
 *
 *  - ADVANCE ONLY. A notice never walks the lifecycle backwards. Notices arrive out of order —
 *    a distributor forwards an old NRND bulletin months after the EOL letter — and an
 *    announcement that the part is merely not-recommended must not un-announce the
 *    end-of-life. `PATCH /manufacturer-parts/:id/lifecycle` is the deliberate human override;
 *    an inbox is not one.
 *  - THE EARLIEST LAST-TIME-BUY BINDS. Two notices with two dates means the window shuts on the
 *    first of them. Taking the later date would tell purchasing they have more time than they
 *    do, which is the single most expensive error this feature can make.
 *  - `effectiveAt` IS NOT `lastShipAt`. The notice says when the change takes effect; the part
 *    column says when the factory last ships. Copying one into the other would invent a date
 *    the manufacturer never gave, so nothing here writes `lastShipAt` — only the explicit
 *    lifecycle route does, where a person typed it.
 */
interface CarriedFacts {
  lifecycle?: PartLifecycle;
  eolAnnouncedAt?: Date;
  lastTimeBuyAt?: Date;
  replacementMpn?: string;
}

function factsFromNotice(
  notice: {
    kind: NoticeKind;
    issuedAt: Date | null;
    lastTimeBuyAt: Date | null;
    replacementMpn: string | null;
  },
  part: {
    lifecycle: PartLifecycle;
    eolAnnouncedAt: Date | null;
    lastTimeBuyAt: Date | null;
    replacementMpn: string | null;
  }
): CarriedFacts {
  const facts: CarriedFacts = {};

  const asserted = KIND_LIFECYCLE[notice.kind];
  if (asserted !== null && LIFECYCLE_PROGRESSION[asserted] > LIFECYCLE_PROGRESSION[part.lifecycle]) {
    facts.lifecycle = asserted;
  }

  // Only for the kinds that announce an ending. A PCN's issue date is not an EOL announcement,
  // and `eolAnnouncedAt` is read as "when were we told this part is going away".
  if (asserted !== null && asserted !== PartLifecycle.NRND && notice.issuedAt) {
    if (!part.eolAnnouncedAt || notice.issuedAt < part.eolAnnouncedAt) {
      facts.eolAnnouncedAt = notice.issuedAt;
    }
  }

  if (notice.lastTimeBuyAt) {
    if (!part.lastTimeBuyAt || notice.lastTimeBuyAt < part.lastTimeBuyAt) {
      facts.lastTimeBuyAt = notice.lastTimeBuyAt;
    }
  }

  // Only when the part has none. A replacement already on the part was either carried from an
  // earlier notice or chosen by an engineer, and overwriting an engineer's choice with a
  // supplier's default suggestion is the same category of mistake as editing `status`.
  if (notice.replacementMpn && !part.replacementMpn) facts.replacementMpn = notice.replacementMpn;

  return facts;
}

// ---------------------------------------------------------------------------
// Who may be told
// ---------------------------------------------------------------------------

/**
 * The followers of an internal part who may actually READ it.
 *
 * Same shape as `recipientsWhoCanReadProject` in routes/projects.ts and
 * `recipientsWhoCanRead` in routes/collab.ts, and the same reason: a notification is a side
 * channel. "TI has put P-10042's only approved source end-of-life" in somebody's inbox tells
 * them the part exists, who makes it and that it is in trouble — everything the ACL on that
 * part refuses to tell them directly.
 *
 * Resolved BEFORE the transaction opens, because who may be told is a read of the part's
 * grants rather than part of this write, and because `visibleIds` resolves its delegate from
 * the module-level client and would escape the transaction onto another connection anyway.
 *
 * An empty list means the attachment stands and nobody is told, which is correct: the sentence
 * that would sit in their inbox is one they may not have.
 */
async function followersWhoCanReadPart(partId: number, actorId: number): Promise<number[]> {
  const watchers = await prisma.watch.findMany({
    where: { partId },
    select: { user: { select: { id: true, role: true } } },
  });
  const candidates = watchers.map((row) => row.user).filter((row) => row.id !== actorId);
  const allowed = await Promise.all(
    candidates.map(async (candidate) => {
      const visible = await visibleIds('PART', [partId], candidate);
      return visible.has(partId);
    })
  );
  return candidates.filter((_candidate, index) => allowed[index]).map((candidate) => candidate.id);
}

// ---------------------------------------------------------------------------
// GET /manufacturer-notices — what arrived, newest issue first
// ---------------------------------------------------------------------------

router.get(
  '/manufacturer-notices',
  asyncHandler(async (req, res) => {
    const page = positiveIntQuery(req.query.page, 'page', 1);
    const pageSize = Math.min(100, positiveIntQuery(req.query.pageSize, 'pageSize', 20));

    const where: Prisma.ManufacturerNoticeWhereInput = {};
    if (typeof req.query.kind === 'string' && req.query.kind !== '') {
      where.kind = parseEnum(req.query.kind, NoticeKind, 'kind');
    }
    if (typeof req.query.manufacturerId === 'string' && req.query.manufacturerId !== '') {
      where.manufacturerId = positiveIntQuery(req.query.manufacturerId, 'manufacturerId', 0);
    }

    const [total, rows] = await Promise.all([
      prisma.manufacturerNotice.count({ where }),
      prisma.manufacturerNotice.findMany({
        where,
        // Undated notices last rather than first: a notice nobody dated is not the newest news,
        // and `nulls: 'last'` says so instead of letting NULL sort wherever Postgres puts it.
        orderBy: [{ issuedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: noticeInclude,
      }),
    ]);

    const user = aclUser(req);
    const visibleDocuments = await visibleNoticeDocuments(rows, user);
    res.json({
      items: rows.map((row) => toNoticeSummary(row, visibleDocuments)),
      total,
      page,
      pageSize,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /manufacturer-notices — record what a manufacturer sent
// ---------------------------------------------------------------------------

router.post(
  '/manufacturer-notices',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const user = aclUser(req);

    const kind = parseEnum(body.kind, NoticeKind, 'kind');
    const manufacturerId = requireId(body.manufacturerId, 'manufacturerId');
    const title = requireText(body.title, 'title');
    const reference = optionalText(body.reference, 'reference', 200);
    const summary = optionalText(body.summary, 'summary', 4000);
    const issuedAt = parseDate(body.issuedAt, 'issuedAt');
    const effectiveAt = parseDate(body.effectiveAt, 'effectiveAt');
    const lastTimeBuyAt = parseDate(body.lastTimeBuyAt, 'lastTimeBuyAt');
    const replacementMpn = optionalText(body.replacementMpn, 'replacementMpn', 200);
    const documentId = optionalId(body.documentId, 'documentId');

    const manufacturer = await prisma.manufacturer.findUnique({
      where: { id: manufacturerId },
      select: { id: true },
    });
    if (!manufacturer) throw new HttpError(404, 'Manufacturer not found');
    // A restricted document answers exactly like a missing one, so attaching one cannot be used
    // to discover that it exists (rule X3).
    if (documentId !== null) await assertCanRead('DOCUMENT', documentId, user);

    /*
     * `lastTimeBuyAt >= issuedAt`, and in this build THIS COMPARISON IS THE WHOLE RULE.
     *
     * A CHECK constraint would be the better enforcer, because the route is not the only
     * writer a database outlives — but this schema is applied with `prisma db push` and
     * carries no raw SQL, so there is no constraint behind this route. Nothing re-checks the
     * pair once it is past this line: an impossible date is then stored, and read back as
     * fact by every obsolescence report. Do not remove this as a duplicate of something the
     * database does — the database does not do it.
     *
     * It would earn its place even where a constraint exists: a CHECK violation arrives as
     * Postgres 23514 inside a `PrismaClientUnknownRequestError` with no `code`, so
     * errorMiddleware can only report it as a 500. A transcription error in the one field
     * every obsolescence decision is made from would then come back as "Internal server
     * error" — the caller is told the server is broken, learns nothing about the typo, and has
     * no reason to think the date is the problem. Same reasoning, and same shape, as
     * `parseQuantityLimit` and `assertBounded` in routes/waivers.ts.
     */
    if (issuedAt && lastTimeBuyAt && lastTimeBuyAt < issuedAt) {
      throw new HttpError(
        400,
        'lastTimeBuyAt is before issuedAt — a last-time-buy date cannot precede the notice ' +
          'that announced it. Check the transcription.'
      );
    }
    /*
     * The number is allocated and the notice inserted in ONE transaction, under the numbering
     * lock. `generateNoticeNumber` scans the table for the highest MN- already filed, so two
     * creates running at once without the lock read the same maximum and one of them dies on
     * the unique index. Same shape as POST /ecrs and POST /requirements; the retry is only a
     * backstop, for a number somebody typed in by hand.
     */
    const createNoticeRecord = (noticeNumber: string, db: Prisma.TransactionClient) =>
      db.manufacturerNotice.create({
        data: {
          noticeNumber,
          kind,
          manufacturerId,
          reference,
          title,
          summary,
          issuedAt,
          effectiveAt,
          lastTimeBuyAt,
          replacementMpn,
          documentId,
          receivedById: currentUserId(req),
        },
        include: noticeInclude,
      });
    const created = await withNumberLock(async (tx) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await createNoticeRecord(await generateNoticeNumber(tx), tx);
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    });

    const visibleDocuments = await visibleNoticeDocuments([created], user);
    res.status(201).json(toNoticeSummary(created, visibleDocuments));
  })
);

// ---------------------------------------------------------------------------
// GET /manufacturer-notices/:id — the notice, its items, and what they reach
// ---------------------------------------------------------------------------

router.get(
  '/manufacturer-notices/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);

    const notice = await prisma.manufacturerNotice.findUnique({
      where: { id },
      include: {
        ...noticeInclude,
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            disposition: true,
            createdAt: true,
            ecn: { select: { id: true, ecnNumber: true, status: true } },
            manufacturerPart: { select: manufacturerPartSelect },
          },
        },
      },
    });
    if (!notice) throw new HttpError(404, 'Manufacturer notice not found');

    const visibleDocuments = await visibleNoticeDocuments([notice], user);
    const visibleParts = await visibleIds(
      'PART',
      notice.items.map((item) => item.manufacturerPart.partId),
      user
    );
    const visibleEcns = await visibleIds(
      'ECN',
      notice.items.flatMap((item) => (item.ecn ? [item.ecn.id] : [])),
      user
    );

    const walker = makeWalker(user);
    const items: NoticeItemDto[] = [];
    let redactedItems = 0;
    for (const item of notice.items) {
      const readable = visibleParts.has(item.manufacturerPart.partId);
      if (!readable) redactedItems += 1;
      // The walk is skipped on a redacted row rather than run and thrown away: the row carries
      // no identity, so there is nothing for its reach to be attached to.
      const reach = readable
        ? await reachedProducts(item.manufacturerPart.partId, walker, user)
        : { products: [], redactedProducts: 0, truncated: false };
      items.push({
        id: item.id,
        disposition: item.disposition,
        ecn: item.ecn
          ? visibleEcns.has(item.ecn.id)
            ? { id: item.ecn.id, ecnNumber: item.ecn.ecnNumber, status: item.ecn.status }
            : REDACTED_ECN
          : null,
        manufacturerPart: readable ? toManufacturerPartRef(item.manufacturerPart) : REDACTED_MPN,
        part: readable ? toPartRef(item.manufacturerPart.part) : REDACTED,
        products: reach.products,
        redactedProducts: reach.redactedProducts,
        truncated: reach.truncated,
        createdAt: item.createdAt.toISOString(),
      });
    }

    const detail: NoticeDetailDto = {
      ...toNoticeSummary(notice, visibleDocuments),
      items,
      redactedItems,
    };
    res.json(detail);
  })
);

// ---------------------------------------------------------------------------
// PATCH /manufacturer-notices/:id
// ---------------------------------------------------------------------------

router.patch(
  '/manufacturer-notices/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const user = aclUser(req);

    const existing = await prisma.manufacturerNotice.findUnique({
      where: { id },
      // The two dates are read because the `lastTimeBuyAt >= issuedAt` rule spans both, and a
      // PATCH may name either one, the other, or neither. See the check below.
      select: { id: true, issuedAt: true, lastTimeBuyAt: true },
    });
    if (!existing) throw new HttpError(404, 'Manufacturer notice not found');

    const data: Prisma.ManufacturerNoticeUpdateInput = {};
    if (body.kind !== undefined) data.kind = parseEnum(body.kind, NoticeKind, 'kind');
    if (body.title !== undefined) data.title = requireText(body.title, 'title');
    if (body.reference !== undefined) data.reference = optionalText(body.reference, 'reference', 200);
    if (body.summary !== undefined) data.summary = optionalText(body.summary, 'summary', 4000);
    if (body.issuedAt !== undefined) data.issuedAt = parseDate(body.issuedAt, 'issuedAt');
    if (body.effectiveAt !== undefined) data.effectiveAt = parseDate(body.effectiveAt, 'effectiveAt');
    if (body.lastTimeBuyAt !== undefined) {
      data.lastTimeBuyAt = parseDate(body.lastTimeBuyAt, 'lastTimeBuyAt');
    }
    if (body.replacementMpn !== undefined) {
      data.replacementMpn = optionalText(body.replacementMpn, 'replacementMpn', 200);
    }
    if (body.documentId !== undefined) {
      const documentId = optionalId(body.documentId, 'documentId');
      if (documentId !== null) await assertCanRead('DOCUMENT', documentId, user);
      data.document = documentId === null ? { disconnect: true } : { connect: { id: documentId } };
    }

    /*
     * The same `lastTimeBuyAt >= issuedAt` check as the create route, against the EFFECTIVE
     * pair rather than the submitted one.
     *
     * A PATCH names either date, both, or neither, so comparing only what arrived would miss
     * the two cases that actually happen: moving `issuedAt` forward past a stored
     * last-time-buy, and moving `lastTimeBuyAt` back behind a stored issue date. Nothing after
     * this line catches either one — there is no CHECK constraint in this schema, for the
     * reason the create route gives — so an impossible pair would simply be stored.
     */
    const effectiveIssuedAt =
      body.issuedAt !== undefined ? (data.issuedAt as Date | null) : existing.issuedAt;
    const effectiveLastTimeBuyAt =
      body.lastTimeBuyAt !== undefined
        ? (data.lastTimeBuyAt as Date | null)
        : existing.lastTimeBuyAt;
    if (
      effectiveIssuedAt &&
      effectiveLastTimeBuyAt &&
      effectiveLastTimeBuyAt < effectiveIssuedAt
    ) {
      throw new HttpError(
        400,
        'lastTimeBuyAt would be before issuedAt — a last-time-buy date cannot precede the ' +
          'notice that announced it. Check the transcription.'
      );
    }

    /*
     * `manufacturerId` and `noticeNumber` are deliberately not editable.
     *
     * The number is the filing reference people quote back, and moving a notice to another
     * manufacturer would leave its items pointing at MPNs of the manufacturer it came from —
     * the exact mismatch the attach route refuses. A notice filed against the wrong
     * manufacturer is deleted and re-recorded, which leaves a trail; silently re-pointing it
     * does not.
     *
     * Editing the dates does NOT retroactively re-carry anything onto the parts already
     * attached. That is the point of carrying the facts across in the first place: the part's
     * lifecycle is what the reports read, and a correction to a notice is a prompt for a human
     * to look at the part, not a licence for an edit to reach into it.
     */
    const updated = await prisma.manufacturerNotice.update({
      where: { id },
      data,
      include: noticeInclude,
    });
    const visibleDocuments = await visibleNoticeDocuments([updated], user);
    res.json(toNoticeSummary(updated, visibleDocuments));
  })
);

// ---------------------------------------------------------------------------
// DELETE /manufacturer-notices/:id
// ---------------------------------------------------------------------------

router.delete(
  '/manufacturer-notices/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const existing = await prisma.manufacturerNotice.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new HttpError(404, 'Manufacturer notice not found');

    /*
     * The items go with it (onDelete: Cascade) and the LIFECYCLE STAYS ON THE PARTS. That
     * asymmetry is the whole reason the facts are copied across on attach: deleting a
     * superseded bulletin must not quietly make an end-of-life part look live again, which is
     * what would happen if the report read the notice instead of the part. Un-announcing an
     * EOL is a deliberate act, and it is `PATCH /manufacturer-parts/:id/lifecycle`.
     */
    await prisma.manufacturerNotice.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /manufacturer-notices/:id/items — name an MPN this notice covers
// ---------------------------------------------------------------------------

router.post(
  '/manufacturer-notices/:id/items',
  asyncHandler(async (req, res) => {
    const noticeId = idParam(req.params.id);
    const body = requireBody(req);
    const user = aclUser(req);
    const actorId = currentUserId(req);

    const manufacturerPartId = requireId(body.manufacturerPartId, 'manufacturerPartId');
    const disposition = optionalText(body.disposition, 'disposition', 2000);

    const notice = await prisma.manufacturerNotice.findUnique({
      where: { id: noticeId },
      select: {
        id: true,
        kind: true,
        noticeNumber: true,
        title: true,
        manufacturerId: true,
        issuedAt: true,
        lastTimeBuyAt: true,
        replacementMpn: true,
      },
    });
    if (!notice) throw new HttpError(404, 'Manufacturer notice not found');

    // A restricted part's AML row answers exactly like a missing one (rule X2), and the access
    // check comes before every other validation so a 400 or 409 cannot confirm it exists.
    const mpart = await prisma.manufacturerPart.findFirst({
      where: { id: manufacturerPartId, part: partAcl(user) },
      select: manufacturerPartSelect,
    });
    if (!mpart) throw new HttpError(404, 'Manufacturer part not found');
    // Attaching the item writes the part's lifecycle, which is part of the part's sourcing
    // record — a write to the part, exactly as adding an AML entry is in routes/sourcing.ts.
    await assertCanWrite('PART', mpart.partId, user);

    /*
     * The MPN must belong to the manufacturer that sent the notice.
     *
     * Not a database constraint — the two tables are related only through `Manufacturer` — and
     * not cosmetic either. An item attached across manufacturers means somebody picked the
     * wrong row out of a long list, and the next thing this route does is write an end-of-life
     * date onto whatever they picked. A 409 here costs one re-click; the alternative is a live
     * part reported obsolete, or worse, an obsolete one that nobody looked at again.
     */
    if (mpart.manufacturerId !== notice.manufacturerId) {
      throw new HttpError(
        409,
        'That manufacturer part is made by a different manufacturer than the notice is from'
      );
    }

    const duplicate = await prisma.manufacturerNoticeItem.findFirst({
      where: { noticeId, manufacturerPartId },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, 'This notice already names that manufacturer part');

    const facts = factsFromNotice(notice, mpart);
    const recipients = await followersWhoCanReadPart(mpart.partId, actorId);

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.manufacturerNoticeItem.create({
        data: { noticeId, manufacturerPartId, disposition },
        select: { id: true, disposition: true, createdAt: true },
      });
      /*
       * One UPDATE, and `status` IS NOT IN IT. `facts` is built by `factsFromNotice`, which
       * cannot produce a `status` key — the organisation's sourcing decision is not a
       * supplier's email's to edit. Read that function's header for the three rules governing
       * what IS written.
       *
       * Inside the transaction with the item: a stored item whose carried dates were lost is a
       * part that reads as live while the notice says otherwise, and that is the one failure a
       * transaction can rule out outright.
       */
      if (Object.keys(facts).length > 0) {
        await tx.manufacturerPart.update({ where: { id: manufacturerPartId }, data: facts });
      }
      if (recipients.length > 0) {
        await notifyUsers(tx, recipients, actorId, {
          type: 'obsolescence.notice',
          title: `${notice.kind} notice on ${mpart.mpn}: ${mpart.part.partNumber}`,
          // The dates are the news. "No last-time-buy date given" rather than nothing, because
          // the absence is the fact worth carrying: it is the one somebody has to go and ask
          // about, and a silent omission reads as "not urgent".
          body: notice.lastTimeBuyAt
            ? `${notice.noticeNumber}: last-time-buy ${notice.lastTimeBuyAt.toISOString().slice(0, 10)}`
            : `${notice.noticeNumber}: no last-time-buy date given`,
          link: `/parts/${mpart.partId}`,
        });
      }
      return created;
    });

    const after = await prisma.manufacturerPart.findUnique({
      where: { id: manufacturerPartId },
      select: manufacturerPartSelect,
    });
    if (!after) throw new HttpError(404, 'Manufacturer part not found');

    const reach = await reachedProducts(after.partId, makeWalker(user), user);
    const dto: NoticeItemDto = {
      id: item.id,
      disposition: item.disposition,
      ecn: null,
      manufacturerPart: toManufacturerPartRef(after),
      part: toPartRef(after.part),
      products: reach.products,
      redactedProducts: reach.redactedProducts,
      truncated: reach.truncated,
      createdAt: item.createdAt.toISOString(),
    };
    res.status(201).json(dto);
  })
);

// ---------------------------------------------------------------------------
// PATCH /notice-items/:id — the disposition, and the change order raised for it
// ---------------------------------------------------------------------------

router.patch(
  '/notice-items/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const user = aclUser(req);

    const existing = await prisma.manufacturerNoticeItem.findFirst({
      where: { id, manufacturerPart: { part: partAcl(user) } },
      select: { id: true, manufacturerPart: { select: { partId: true } } },
    });
    if (!existing) throw new HttpError(404, 'Notice item not found');
    await assertCanWrite('PART', existing.manufacturerPart.partId, user);

    const data: Prisma.ManufacturerNoticeItemUpdateInput = {};
    if (body.disposition !== undefined) {
      data.disposition = optionalText(body.disposition, 'disposition', 2000);
    }
    if (body.ecnId !== undefined) {
      const ecnId = optionalId(body.ecnId, 'ecnId');
      // A restricted ECN 404s like a missing one, so linking cannot be used to find out that
      // somebody else's change order exists.
      if (ecnId !== null) await assertCanRead('ECN', ecnId, user);
      data.ecn = ecnId === null ? { disconnect: true } : { connect: { id: ecnId } };
    }

    const updated = await prisma.manufacturerNoticeItem.update({
      where: { id },
      data,
      select: {
        id: true,
        disposition: true,
        createdAt: true,
        ecn: { select: { id: true, ecnNumber: true, status: true } },
        manufacturerPart: { select: manufacturerPartSelect },
      },
    });

    const reach = await reachedProducts(updated.manufacturerPart.partId, makeWalker(user), user);
    const dto: NoticeItemDto = {
      id: updated.id,
      disposition: updated.disposition,
      ecn: updated.ecn
        ? { id: updated.ecn.id, ecnNumber: updated.ecn.ecnNumber, status: updated.ecn.status }
        : null,
      manufacturerPart: toManufacturerPartRef(updated.manufacturerPart),
      part: toPartRef(updated.manufacturerPart.part),
      products: reach.products,
      redactedProducts: reach.redactedProducts,
      truncated: reach.truncated,
      createdAt: updated.createdAt.toISOString(),
    };
    res.json(dto);
  })
);

// ---------------------------------------------------------------------------
// DELETE /notice-items/:id
// ---------------------------------------------------------------------------

router.delete(
  '/notice-items/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);

    const existing = await prisma.manufacturerNoticeItem.findFirst({
      where: { id, manufacturerPart: { part: partAcl(user) } },
      select: { id: true, manufacturerPart: { select: { partId: true } } },
    });
    if (!existing) throw new HttpError(404, 'Notice item not found');
    await assertCanWrite('PART', existing.manufacturerPart.partId, user);

    // Detaching the item does NOT un-announce the end-of-life: the lifecycle and dates stay on
    // the manufacturer part, for the reason given on DELETE /manufacturer-notices/:id. Removing
    // the wrong item from a notice is a filing correction, not new information from the factory.
    await prisma.manufacturerNoticeItem.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// PATCH /manufacturer-parts/:id/lifecycle — the human override
//
// The one place in this file that writes a lifecycle somebody chose rather than one a notice
// asserted, which is why it is not subject to the advance-only rule in `factsFromNotice`: a
// manufacturer does reinstate a part, and the record has to be able to say so. It still cannot
// touch `status` — this route accepts no such field, and the organisation's sourcing decision
// stays in routes/sourcing.ts where it belongs.
// ---------------------------------------------------------------------------

router.patch(
  '/manufacturer-parts/:id/lifecycle',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const user = aclUser(req);

    const existing = await prisma.manufacturerPart.findFirst({
      where: { id, part: partAcl(user) },
      select: { id: true, partId: true },
    });
    if (!existing) throw new HttpError(404, 'Manufacturer part not found');
    await assertCanWrite('PART', existing.partId, user);

    const data: Prisma.ManufacturerPartUpdateInput = {
      lifecycle: parseEnum(body.lifecycle, PartLifecycle, 'lifecycle'),
    };
    // Each date is written only when the caller named it, so setting a lifecycle does not
    // silently clear dates the notices carried across. `null` clears one explicitly.
    if (body.eolAnnouncedAt !== undefined) {
      data.eolAnnouncedAt = parseDate(body.eolAnnouncedAt, 'eolAnnouncedAt');
    }
    if (body.lastTimeBuyAt !== undefined) {
      data.lastTimeBuyAt = parseDate(body.lastTimeBuyAt, 'lastTimeBuyAt');
    }
    if (body.lastShipAt !== undefined) data.lastShipAt = parseDate(body.lastShipAt, 'lastShipAt');
    if (body.replacementMpn !== undefined) {
      data.replacementMpn = optionalText(body.replacementMpn, 'replacementMpn', 200);
    }

    const updated = await prisma.manufacturerPart.update({
      where: { id },
      data,
      select: manufacturerPartSelect,
    });
    res.json(toManufacturerPartRef(updated));
  })
);

// ---------------------------------------------------------------------------
// GET /manufacturer-parts/:id/impact — what this one MPN reaches
// ---------------------------------------------------------------------------

router.get(
  '/manufacturer-parts/:id/impact',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const asOf = new Date();

    const mpart = await prisma.manufacturerPart.findFirst({
      where: { id, part: partAcl(user) },
      select: {
        ...manufacturerPartSelect,
        noticeItems: {
          orderBy: { id: 'desc' },
          take: NOTICES_PER_ROW,
          select: {
            notice: { select: { id: true, noticeNumber: true, kind: true, issuedAt: true } },
          },
        },
      },
    });
    if (!mpart) throw new HttpError(404, 'Manufacturer part not found');

    const reach = await reachedProducts(mpart.partId, makeWalker(user), user);
    const productIds = reach.products.map((product) => product.id);
    const tallies = await tallyUnits([mpart.partId, ...productIds], user);

    const impact: ImpactDto = {
      asOf: asOf.toISOString(),
      manufacturerPart: toManufacturerPartRef(mpart),
      part: toPartRef(mpart.part),
      products: reach.products,
      redactedProducts: reach.redactedProducts,
      truncated: reach.truncated,
      units: {
        ofPart: toUnitCounts(tallies.get(mpart.partId)),
        ofProducts: sumUnitCounts(productIds, tallies),
      },
      lastTimeBuy: lastTimeBuyOf(mpart.lastTimeBuyAt, asOf),
      notices: mpart.noticeItems.map((item) => ({
        id: item.notice.id,
        noticeNumber: item.notice.noticeNumber,
        kind: item.notice.kind,
        issuedAt: iso(item.notice.issuedAt),
      })),
      // Carried on the single-MPN view too: this is the screen somebody opens with a purchase
      // order half-written, and the absence of a quantity needs its reason attached to it.
      notes: [OBSOLESCENCE_RISK_REFUSAL, ...reach.tree.notes],
    };
    res.json(impact);
  })
);

// ---------------------------------------------------------------------------
// GET /obsolescence/risk — THE REPORT
//
// Every figure is RETRIEVED: a stored lifecycle, a stored date compared against one `asOf`, a
// count of rows. Nothing is estimated, extrapolated or inferred from a trend, and nothing says
// how many to buy — see `OBSOLESCENCE_RISK_REFUSAL` above for why that field is absent and must
// stay absent.
// ---------------------------------------------------------------------------

router.get(
  '/obsolescence/risk',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    /*
     * One clock for the whole answer, echoed back as `asOf`. Reading `new Date()` per
     * comparison would let a part fall between two last-time-buy buckets while the response was
     * being assembled, and nothing on the screen would show which moment it described. Same
     * rule as `GET /projects/:id/health`.
     */
    const asOf = new Date();
    const acl = partAcl(user);
    const notes: string[] = [OBSOLESCENCE_RISK_REFUSAL];

    const atRiskWhere: Prisma.ManufacturerPartWhereInput = {
      lifecycle: { in: AT_RISK_LIFECYCLES },
      part: acl,
    };
    const unknownWhere: Prisma.ManufacturerPartWhereInput = {
      lifecycle: PartLifecycle.UNKNOWN,
      part: acl,
    };

    /*
     * The counts are complete and the LISTS are capped, so a truncated report still states the
     * size of the problem rather than the size of the page.
     *
     * `restricted*` is the one count taken without the ACL filter, and it returns a number and
     * no identity: an obsolescence report that silently dropped a restricted programme's parts
     * would report a dangerous situation as safe, which is the error rule X4 exists to prevent.
     */
    const [
      atRiskCount,
      unknownCount,
      byLifecycleGroups,
      lastTimeBuyPassed,
      lastTimeBuyNoDate,
      allAtRiskCount,
      allUnknownCount,
    ] = await Promise.all([
      prisma.manufacturerPart.count({ where: atRiskWhere }),
      prisma.manufacturerPart.count({ where: unknownWhere }),
      prisma.manufacturerPart.groupBy({
        by: ['lifecycle'],
        where: { part: acl },
        _count: { _all: true },
      }),
      prisma.manufacturerPart.count({
        where: { ...atRiskWhere, lastTimeBuyAt: { lt: asOf } },
      }),
      prisma.manufacturerPart.count({ where: { ...atRiskWhere, lastTimeBuyAt: null } }),
      prisma.manufacturerPart.count({ where: { lifecycle: { in: AT_RISK_LIFECYCLES } } }),
      prisma.manufacturerPart.count({ where: { lifecycle: PartLifecycle.UNKNOWN } }),
    ]);

    const byLifecycle: Record<PartLifecycle, number> = {
      [PartLifecycle.ACTIVE]: 0,
      [PartLifecycle.NRND]: 0,
      [PartLifecycle.EOL_ANNOUNCED]: 0,
      [PartLifecycle.OBSOLETE]: 0,
      [PartLifecycle.UNKNOWN]: 0,
    };
    for (const group of byLifecycleGroups) byLifecycle[group.lifecycle] = group._count._all;

    /*
     * Ordered by last-time-buy in the DATABASE — the first key of the urgency order — and
     * refined in JS, because the second key is a count of build units no `orderBy` can reach.
     * The cap therefore drops the rows furthest from a last-time-buy date, which is the honest
     * place to cut a list that has to be cut somewhere.
     */
    const atRiskRows = await prisma.manufacturerPart.findMany({
      where: atRiskWhere,
      orderBy: [{ lastTimeBuyAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: MAX_RISK_ROWS,
      select: {
        ...manufacturerPartSelect,
        noticeItems: {
          orderBy: { id: 'desc' },
          take: NOTICES_PER_ROW,
          select: {
            notice: { select: { id: true, noticeNumber: true, kind: true, issuedAt: true } },
          },
        },
      },
    });

    const walker = makeWalker(user);
    const reaches = new Map<number, Awaited<ReturnType<typeof reachedProducts>>>();
    for (const row of atRiskRows) {
      if (!reaches.has(row.id)) reaches.set(row.id, await reachedProducts(row.partId, walker, user));
    }

    // Every part the report names, in one pass: the internal parts and the products they reach.
    // `tallyUnits` is then four statements for the whole report rather than five per row.
    const namedPartIds = atRiskRows.flatMap((row) => [
      row.partId,
      ...(reaches.get(row.id)?.products ?? []).map((product) => product.id),
    ]);
    const tallies = await tallyUnits(namedPartIds, user);

    const atRisk: RiskRowDto[] = atRiskRows.map((row) => {
      const reach = reaches.get(row.id);
      const products = reach?.products ?? [];
      const productIds = products.map((product) => product.id);
      const ofPart = toUnitCounts(tallies.get(row.partId));
      const ofProducts = sumUnitCounts(productIds, tallies);
      const lastTimeBuy = lastTimeBuyOf(row.lastTimeBuyAt, asOf);
      return {
        manufacturerPart: toManufacturerPartRef(row),
        part: toPartRef(row.part),
        products,
        redactedProducts: reach?.redactedProducts ?? 0,
        truncated: reach?.truncated ?? false,
        units: { ofPart, ofProducts },
        lastTimeBuy,
        sortKey: {
          lastTimeBuyBucket: lastTimeBuy.bucket,
          // The shipped history the order is driven by: shipments of the PRODUCTS plus
          // shipments of the component itself where it is serialised in its own right.
          shippedUnits: ofProducts.shipped + ofPart.shipped,
          lifecycle: row.lifecycle,
        },
        notices: row.noticeItems.map((item) => ({
          id: item.notice.id,
          noticeNumber: item.notice.noticeNumber,
          kind: item.notice.kind,
          issuedAt: iso(item.notice.issuedAt),
        })),
      };
    });
    atRisk.sort(compareRisk);

    const unknownRows = await prisma.manufacturerPart.findMany({
      where: unknownWhere,
      orderBy: { id: 'asc' },
      take: MAX_UNKNOWN_ROWS,
      select: { ...manufacturerPartSelect, _count: { select: { noticeItems: true } } },
    });
    const unknownLifecycle: UnknownLifecycleRowDto[] = unknownRows.map((row) => ({
      manufacturerPart: toManufacturerPartRef(row),
      part: toPartRef(row.part),
      hasNotice: row._count.noticeItems > 0,
    }));

    if (atRiskCount > atRisk.length) {
      notes.push(
        `Showing the ${atRisk.length} at-risk parts nearest a last-time-buy date, of ` +
          `${atRiskCount}. The counts above are complete.`
      );
    }
    if (unknownCount > unknownLifecycle.length) {
      notes.push(
        `Showing ${unknownLifecycle.length} of ${unknownCount} parts whose lifecycle nobody ` +
          'has asked about. The counts above are complete.'
      );
    }
    if (lastTimeBuyNoDate > 0) {
      notes.push(
        `${lastTimeBuyNoDate} at-risk parts have no last-time-buy date. They sort last ` +
          'because they cannot be ordered against a date, not because they are less urgent — ' +
          'nobody has been told when the window shuts.'
      );
    }
    if (unknownCount > 0) {
      notes.push(
        `${unknownCount} manufacturer parts have lifecycle UNKNOWN. That is not low risk: ` +
          'nobody has asked the manufacturer. They are listed separately rather than counted ' +
          'as active.'
      );
    }

    const report: ObsolescenceRiskDto = {
      asOf: asOf.toISOString(),
      atRisk,
      unknownLifecycle,
      counts: {
        atRisk: atRiskCount,
        unknownLifecycle: unknownCount,
        byLifecycle,
        lastTimeBuyPassed,
        lastTimeBuyNoDate,
        restrictedAtRisk: Math.max(0, allAtRiskCount - atRiskCount),
        restrictedUnknownLifecycle: Math.max(0, allUnknownCount - unknownCount),
      },
      ordering: RISK_ORDERING,
      notes,
    };
    res.json(report);
  })
);

export default router;
