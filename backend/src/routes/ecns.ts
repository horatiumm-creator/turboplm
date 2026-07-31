import { Request, Router } from 'express';
import {
  EcnDisposition,
  EcnPriority,
  EcnReviewDecision,
  EcnStatus,
  Lifecycle,
  PartCategory,
  Prisma,
  Role,
  SignedEntityType,
  WorkflowStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import {
  AclUser,
  aclFilter,
  assertCanRead,
  assertCanWrite,
  REDACTED,
  visibleIds,
} from '../lib/acl';
import { assertSignaturesComplete } from './signatures';
import { nextRevisionLabel, withNumberLock } from '../lib/plm';
import { notifyUsers } from '../lib/notify';
import { emitEvent } from '../lib/webhooks';
import { instantiateWorkflow } from './workflows';

const router = Router();
router.use(requireAuth);

const ACTIVE_STATUSES: EcnStatus[] = [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED];

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

/**
 * Rule X4 — the stand-in for a part the caller may not read. A hidden part is never dropped
 * from a response: an item list that quietly lost a line would understate the scope of the
 * change, and the where-used roll-up under it would understate the impact. Identity out,
 * structure in.
 */
interface RedactedRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}

interface EcnItemDto {
  id: number;
  part: PartRefDto | RedactedRefDto;
  fromRevision: RevisionRefDto | null;
  toRevision: RevisionRefDto | null;
  changeDescription: string | null;
  disposition: EcnDisposition;
}

interface EcnSummaryDto {
  id: number;
  ecnNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcnStatus;
  effectivityDate: string | null;
  itemCount: number;
  createdAt: string;
  createdBy: UserRefDto;
}

interface EcnReviewDto {
  id: number;
  reviewer: UserRefDto;
  decision: EcnReviewDecision;
  comment: string | null;
  decidedAt: string | null;
}

interface EcnDetailDto extends EcnSummaryDto {
  description: string | null;
  reason: string | null;
  effectiveFromSerial: string | null;
  approvedBy: UserRefDto | null;
  approvedAt: string | null;
  releasedAt: string | null;
  items: EcnItemDto[];
  reviews: EcnReviewDto[];
}

interface WhereUsedEntryDto {
  line: { id: number; findNumber: number; quantity: number; uom: string };
  parentRevision: RevisionRefDto;
  parentPart: { id: number; partNumber: string; name: string } | RedactedRefDto;
}

interface EcnImpactEntryDto {
  part: PartRefDto | RedactedRefDto;
  toRevision: RevisionRefDto | null;
  usedIn: WhereUsedEntryDto[];
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const revisionRefSelect = { select: { id: true, revision: true, lifecycle: true } } as const;

const ecnItemInclude = {
  part: true,
  fromRevision: revisionRefSelect,
  toRevision: revisionRefSelect,
} satisfies Prisma.EcnItemInclude;

const ecnReviewInclude = {
  reviewer: { select: { id: true, name: true } },
} satisfies Prisma.EcnReviewInclude;

const ecnDetailInclude = {
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  items: { orderBy: { id: 'asc' as const }, include: ecnItemInclude },
  reviews: { orderBy: { id: 'asc' as const }, include: ecnReviewInclude },
} satisfies Prisma.EcnInclude;

type EcnItemRow = Prisma.EcnItemGetPayload<{ include: typeof ecnItemInclude }>;
type EcnReviewRow = Prisma.EcnReviewGetPayload<{ include: typeof ecnReviewInclude }>;
type EcnDetailRow = Prisma.EcnGetPayload<{ include: typeof ecnDetailInclude }>;

function toEcnReview(review: EcnReviewRow): EcnReviewDto {
  return {
    id: review.id,
    reviewer: { id: review.reviewer.id, name: review.reviewer.name },
    decision: review.decision,
    comment: review.comment,
    decidedAt: review.decidedAt ? review.decidedAt.toISOString() : null,
  };
}

function toRevisionRef(rev: { id: number; revision: string; lifecycle: Lifecycle } | null) {
  return rev ? { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle } : null;
}

/**
 * Rule X4 — a part the caller may read maps in full; one they may not becomes the redacted
 * node. `visibleParts` comes from a single `visibleIds` call per response, never from
 * `assertCanRead` in a loop: a traversal has to degrade, not throw.
 */
function toPartRef(
  part: { id: number; partNumber: string; name: string; category: PartCategory; uom: string },
  visibleParts: Set<number>
): PartRefDto | RedactedRefDto {
  if (!visibleParts.has(part.id)) return { ...REDACTED };
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toEcnItem(item: EcnItemRow, visibleParts: Set<number>): EcnItemDto {
  const visible = visibleParts.has(item.partId);
  return {
    id: item.id,
    part: toPartRef(item.part, visibleParts),
    // The revision refs go with the identity they belong to: their ids address the hidden
    // part's own history, and every route that would resolve one refuses it anyway. The item
    // itself stays on the list, so the caller still learns that something they cannot see is
    // in the scope of this change.
    fromRevision: visible ? toRevisionRef(item.fromRevision) : null,
    toRevision: visible ? toRevisionRef(item.toRevision) : null,
    changeDescription: item.changeDescription,
    disposition: item.disposition,
  };
}

function toEcnDetail(ecn: EcnDetailRow, visibleParts: Set<number>): EcnDetailDto {
  return {
    id: ecn.id,
    ecnNumber: ecn.ecnNumber,
    title: ecn.title,
    priority: ecn.priority,
    status: ecn.status,
    effectivityDate: ecn.effectivityDate ? ecn.effectivityDate.toISOString() : null,
    itemCount: ecn.items.length,
    createdAt: ecn.createdAt.toISOString(),
    createdBy: { id: ecn.createdBy.id, name: ecn.createdBy.name },
    description: ecn.description,
    reason: ecn.reason,
    effectiveFromSerial: ecn.effectiveFromSerial,
    approvedBy: ecn.approvedBy ? { id: ecn.approvedBy.id, name: ecn.approvedBy.name } : null,
    approvedAt: ecn.approvedAt ? ecn.approvedAt.toISOString() : null,
    releasedAt: ecn.releasedAt ? ecn.releasedAt.toISOString() : null,
    // itemCount above counts redacted items too, so the header never disagrees with the list.
    items: ecn.items.map((item) => toEcnItem(item, visibleParts)),
    reviews: ecn.reviews.map(toEcnReview),
  };
}

/**
 * The one ECN detail read path — every route that returns an ECN goes through it, so the ACL
 * check cannot be forgotten on a new one.
 *
 * `findFirst` with the filter rather than `findUnique`: `aclFilter` is a relation condition and
 * `findUnique` accepts unique fields only. A hidden ECN 404s with the same message a deleted one
 * does, which is the whole point of rule X2's 404-never-403.
 */
async function getEcnDetailOrThrow(id: number, user: AclUser): Promise<EcnDetailDto> {
  const ecn = await prisma.ecn.findFirst({
    where: { id, ...aclFilter('ECN', user) },
    include: ecnDetailInclude,
  });
  if (!ecn) throw new HttpError(404, 'ECN not found');
  // A readable ECN still names parts, and a part carries its own grants — one bulk lookup
  // decides which of them survive into the response (rule X3, nested reads).
  const visibleParts = await visibleIds(
    'PART',
    ecn.items.map((item) => item.partId),
    user
  );
  return toEcnDetail(ecn, visibleParts);
}

/**
 * Item reads are scoped through the owning ECN — the acl rows live on `Ecn`, so the filter goes
 * on the relation. The 404 text stays the item's own: answering `ECN not found` here would tell
 * the caller their item id exists and hangs off an ECN they may not see.
 */
async function getEcnItemDtoOrThrow(id: number, user: AclUser): Promise<EcnItemDto> {
  const item = await prisma.ecnItem.findFirst({
    where: { id, ecn: { ...aclFilter('ECN', user) } },
    include: ecnItemInclude,
  });
  if (!item) throw new HttpError(404, 'ECN item not found');
  return toEcnItem(item, await visibleIds('PART', [item.partId], user));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

/**
 * The ACL principal for this request. Deliberately built from `req.user` on every call rather
 * than cached on the request: a stale principal is the one input that would make the enforcement
 * module answer for the wrong user.
 */
function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'title is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) throw new HttpError(400, 'title must be at most 200 characters');
  return trimmed;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePriority(value: unknown): EcnPriority {
  if (typeof value !== 'string' || !(Object.values(EcnPriority) as string[]).includes(value)) {
    throw new HttpError(400, 'priority must be one of LOW, MEDIUM, HIGH, CRITICAL');
  }
  return value as EcnPriority;
}

function parseDisposition(value: unknown): EcnDisposition {
  if (typeof value !== 'string' || !(Object.values(EcnDisposition) as string[]).includes(value)) {
    throw new HttpError(400, 'disposition must be one of USE_AS_IS, REWORK, SCRAP, RETURN_TO_VENDOR');
  }
  return value as EcnDisposition;
}

function parseEffectivityDate(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'effectivityDate must be an ISO date string or null');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'effectivityDate is not a valid date');
  return date;
}

/**
 * Rule U6 — an ECN cuts in by date or by unit, never both: with both set there is no single
 * answer to which units carry the change. Callers pass the values the write would leave
 * behind, so setting one while the other already holds is caught too.
 */
function assertSingleEffectivity(
  effectivityDate: Date | null,
  effectiveFromSerial: string | null
): void {
  if (effectivityDate !== null && effectiveFromSerial !== null) {
    throw new HttpError(400, 'Set either effectivityDate or effectiveFromSerial, not both');
  }
}

/** Rule E2 — these stop being PATCHable once the ECN leaves DRAFT. */
const DRAFT_ONLY_HEADER_FIELDS = [
  'title',
  'description',
  'reason',
  'priority',
  'effectivityDate',
] as const;

/** Rule E2 — header/items editable only in the given statuses. */
function assertEcnEditable(
  ecn: { ecnNumber: string; status: EcnStatus },
  allowed: EcnStatus[] = [EcnStatus.DRAFT]
): void {
  if (!allowed.includes(ecn.status)) {
    throw new HttpError(409, `ECN ${ecn.ecnNumber} is ${ecn.status} and cannot be modified`);
  }
}

/** Rule E1 — scan-based numbering, ECN-10001 style. */
async function generateEcnNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("ecnNumber" FROM 5)::int) AS max
    FROM "Ecn"
    WHERE "ecnNumber" ~ '^ECN-[0-9]{1,9}$'`;
  return `ECN-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

// ---------------------------------------------------------------------------
// GET /ecns — list with search/status filters + pagination
// ---------------------------------------------------------------------------

router.get(
  '/ecns',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(Object.values(EcnStatus) as string[]).includes(statusRaw)) {
      throw new HttpError(400, 'Invalid status filter');
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    // Rule X3 — the ACL fragment seeds the `where`, and `count` below shares it: a total taken
    // over rows the caller cannot list would leak their existence. The fragment only ever sets
    // `AND`, so the search `OR` and the status filter cannot collide with it.
    const where: Prisma.EcnWhereInput = { ...aclFilter('ECN', aclUser(req)) };
    if (search) {
      where.OR = [
        { ecnNumber: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (statusRaw) where.status = statusRaw as EcnStatus;

    const [total, ecns] = await Promise.all([
      prisma.ecn.count({ where }),
      prisma.ecn.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          createdBy: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    res.json({
      items: ecns.map((ecn) => ({
        id: ecn.id,
        ecnNumber: ecn.ecnNumber,
        title: ecn.title,
        priority: ecn.priority,
        status: ecn.status,
        effectivityDate: ecn.effectivityDate ? ecn.effectivityDate.toISOString() : null,
        itemCount: ecn._count.items,
        createdAt: ecn.createdAt.toISOString(),
        createdBy: { id: ecn.createdBy.id, name: ecn.createdBy.name },
      })),
      total,
      page,
      pageSize,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /ecns — create (rule E1 numbering)
// ---------------------------------------------------------------------------

router.post(
  '/ecns',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const user = aclUser(req);

    const title = requireTitle(body.title);
    const description =
      body.description === undefined ? null : optionalNullableText(body.description, 'description');
    const reason = body.reason === undefined ? null : optionalNullableText(body.reason, 'reason');
    const priority = body.priority === undefined ? EcnPriority.MEDIUM : parsePriority(body.priority);
    const effectivityDate =
      body.effectivityDate === undefined ? null : parseEffectivityDate(body.effectivityDate);
    const effectiveFromSerial =
      body.effectiveFromSerial === undefined
        ? null
        : optionalNullableText(body.effectiveFromSerial, 'effectiveFromSerial');
    assertSingleEffectivity(effectivityDate, effectiveFromSerial);

    const createEcnRecord = (ecnNumber: string, db: Prisma.TransactionClient = prisma) =>
      db.ecn.create({
        data: {
          ecnNumber,
          title,
          description,
          reason,
          priority,
          effectivityDate,
          effectiveFromSerial,
          createdById: user.id,
        },
        select: { id: true },
      });

    // Numbers can only collide under concurrent creates — regenerate and retry.
    const created = await withNumberLock(async (tx) => {
      // Serialized allocation; the retry is a backstop for a manually-typed clash.
      for (let attempt = 0; ; attempt++) {
        try {
          return await createEcnRecord(await generateEcnNumber(tx), tx);
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    });

    res.status(201).json(await getEcnDetailOrThrow(created.id, user));
  })
);

// ---------------------------------------------------------------------------
// GET /ecns/:id
// ---------------------------------------------------------------------------

router.get(
  '/ecns/:id',
  asyncHandler(async (req, res) => {
    res.json(await getEcnDetailOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /ecns/:id — header fields (rule E2: DRAFT only; U6: serial also in IN_REVIEW)
// ---------------------------------------------------------------------------

router.patch(
  '/ecns/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — 404 (unreadable), then 403 (read-only), before the body is parsed.
    await assertCanWrite('ECN', id, user);
    const body = requireBody(req);

    const ecn = await prisma.ecn.findUnique({
      where: { id },
      select: {
        id: true,
        ecnNumber: true,
        status: true,
        effectivityDate: true,
        effectiveFromSerial: true,
      },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    // Rule U6 — the unit cut-in stays editable through review, unlike every other header
    // field (E2): the serial it starts at is often only pinned down while the change is
    // being reviewed. So the gate is per field, not per request.
    const serialOnly =
      body.effectiveFromSerial !== undefined &&
      !DRAFT_ONLY_HEADER_FIELDS.some((field) => body[field] !== undefined);
    assertEcnEditable(ecn, serialOnly ? [EcnStatus.DRAFT, EcnStatus.IN_REVIEW] : [EcnStatus.DRAFT]);

    const data: Prisma.EcnUpdateInput = {};
    if (body.title !== undefined) data.title = requireTitle(body.title);
    if (body.description !== undefined)
      data.description = optionalNullableText(body.description, 'description');
    if (body.reason !== undefined) data.reason = optionalNullableText(body.reason, 'reason');
    if (body.priority !== undefined) data.priority = parsePriority(body.priority);

    // Resolved against the stored row so the check sees the resulting state, not the body.
    const effectivityDate =
      body.effectivityDate === undefined
        ? ecn.effectivityDate
        : parseEffectivityDate(body.effectivityDate);
    const effectiveFromSerial =
      body.effectiveFromSerial === undefined
        ? ecn.effectiveFromSerial
        : optionalNullableText(body.effectiveFromSerial, 'effectiveFromSerial');
    assertSingleEffectivity(effectivityDate, effectiveFromSerial);
    if (body.effectivityDate !== undefined) data.effectivityDate = effectivityDate;
    if (body.effectiveFromSerial !== undefined) data.effectiveFromSerial = effectiveFromSerial;

    await prisma.ecn.update({ where: { id }, data });
    res.json(await getEcnDetailOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /ecns/:id (rule E9)
// ---------------------------------------------------------------------------

router.delete(
  '/ecns/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    await assertCanWrite('ECN', id, aclUser(req));
    const ecn = await prisma.ecn.findUnique({
      where: { id },
      include: { items: { select: { toRevisionId: true } } },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    if (ecn.status !== EcnStatus.DRAFT) {
      throw new HttpError(409, `ECN ${ecn.ecnNumber} is ${ecn.status} and cannot be deleted`);
    }
    if (ecn.items.some((item) => item.toRevisionId !== null)) {
      throw new HttpError(
        409,
        'This ECN has started changes (working revisions attached) and cannot be deleted'
      );
    }
    await prisma.ecn.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /ecns/:id/items — add affected part (rules E2, E3)
// ---------------------------------------------------------------------------

router.post(
  '/ecns/:id/items',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanWrite('ECN', id, user);
    const body = requireBody(req);

    const ecn = await prisma.ecn.findUnique({
      where: { id },
      select: { id: true, ecnNumber: true, status: true },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    assertEcnEditable(ecn);

    const partId = Number(body.partId);
    if (!Number.isInteger(partId) || partId <= 0 || partId > 2147483647) {
      throw new HttpError(400, 'partId must be a positive integer');
    }
    const changeDescription =
      body.changeDescription === undefined
        ? null
        : optionalNullableText(body.changeDescription, 'changeDescription');
    const disposition =
      body.disposition === undefined ? EcnDisposition.USE_AS_IS : parseDisposition(body.disposition);

    // A restricted part cannot be put on a change: the item would name it to every reader of
    // the ECN. 404, indistinguishable from a part that does not exist.
    const part = await prisma.part.findFirst({
      where: { id: partId, ...(aclFilter('PART', user) as Prisma.PartWhereInput) },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    // Serialize ECN membership writes so two concurrent adds cannot both pass
    // the E3 one-active-ECN check.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-ecn-membership'))::text`;

      const duplicate = await tx.ecnItem.findFirst({
        where: { ecnId: id, partId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Part is already on this ECN');

      // Rule E3 — one active ECN per part.
      const elsewhere = await tx.ecnItem.findFirst({
        where: { partId, ecnId: { not: id }, ecn: { status: { in: ACTIVE_STATUSES } } },
        include: { ecn: { select: { id: true, ecnNumber: true } } },
      });
      if (elsewhere) {
        // The one-active-ECN rule must hold whoever is looking — but when the other ECN is
        // restricted, its number must not ride out on the error message.
        const visibleEcns = await visibleIds('ECN', [elsewhere.ecn.id], user);
        throw new HttpError(
          409,
          visibleEcns.has(elsewhere.ecn.id)
            ? `Part ${part.partNumber} is already on active ECN ${elsewhere.ecn.ecnNumber}`
            : `Part ${part.partNumber} is already on an active restricted ECN`
        );
      }

      const fromRevision = await tx.partRevision.findFirst({
        where: { partId, lifecycle: Lifecycle.RELEASED },
        orderBy: { id: 'desc' },
        select: { id: true },
      });

      return tx.ecnItem.create({
        data: {
          ecnId: id,
          partId,
          fromRevisionId: fromRevision?.id ?? null,
          changeDescription,
          disposition,
        },
        select: { id: true },
      });
    });
    res.status(201).json(await getEcnItemDtoOrThrow(created.id, user));
  })
);

// ---------------------------------------------------------------------------
// PATCH /ecn-items/:id (rule E2: DRAFT or IN_REVIEW)
// ---------------------------------------------------------------------------

router.patch(
  '/ecn-items/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // An item of an unreadable ECN answers with the item's own 404 (see getEcnItemDtoOrThrow).
    const item = await prisma.ecnItem.findFirst({
      where: { id, ecn: { ...aclFilter('ECN', user) } },
      include: { ecn: { select: { ecnNumber: true, status: true } } },
    });
    if (!item) throw new HttpError(404, 'ECN item not found');
    await assertCanWrite('ECN', item.ecnId, user);
    const body = requireBody(req);
    assertEcnEditable(item.ecn, [EcnStatus.DRAFT, EcnStatus.IN_REVIEW]);

    const data: Prisma.EcnItemUpdateInput = {};
    if (body.changeDescription !== undefined)
      data.changeDescription = optionalNullableText(body.changeDescription, 'changeDescription');
    if (body.disposition !== undefined) data.disposition = parseDisposition(body.disposition);

    await prisma.ecnItem.update({ where: { id }, data });
    res.json(await getEcnItemDtoOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /ecn-items/:id (rule E9: DRAFT only; toRevision is just unlinked)
// ---------------------------------------------------------------------------

router.delete(
  '/ecn-items/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const item = await prisma.ecnItem.findFirst({
      where: { id, ecn: { ...aclFilter('ECN', user) } },
      include: { ecn: { select: { ecnNumber: true, status: true } } },
    });
    if (!item) throw new HttpError(404, 'ECN item not found');
    await assertCanWrite('ECN', item.ecnId, user);
    assertEcnEditable(item.ecn);
    await prisma.ecnItem.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /ecn-items/:id/revision — start change (rule E4)
// ---------------------------------------------------------------------------

router.post(
  '/ecn-items/:id/revision',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const user = aclUser(req);

    const item = await prisma.ecnItem.findFirst({
      where: { id, ecn: { ...aclFilter('ECN', user) } },
      include: {
        ecn: { select: { ecnNumber: true, status: true } },
        part: { select: { id: true, partNumber: true } },
      },
    });
    if (!item) throw new HttpError(404, 'ECN item not found');
    await assertCanWrite('ECN', item.ecnId, user);
    assertEcnEditable(item.ecn, [EcnStatus.DRAFT, EcnStatus.IN_REVIEW]);
    if (item.toRevisionId !== null) {
      throw new HttpError(409, 'Change already started for this part');
    }

    const latest = await prisma.partRevision.findFirst({
      where: { partId: item.partId },
      orderBy: { id: 'desc' },
      include: {
        bomLines: { include: { alternates: true, optionConditions: true } },
        processPlan: {
          include: { operations: { orderBy: { seq: 'asc' }, include: { materials: true } } },
        },
      },
    });
    if (!latest) throw new HttpError(409, 'Part has no revisions to change');

    if (latest.lifecycle === Lifecycle.IN_REVIEW) {
      throw new HttpError(
        409,
        `Latest revision of ${item.part.partNumber} is in review — resolve it first`
      );
    }

    if (latest.lifecycle === Lifecycle.IN_WORK) {
      // Attach path: adopt the existing working revision (links from cancelled or
      // released ECNs don't block adoption). Same membership lock as item adds so
      // two ECNs cannot adopt the same revision concurrently.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-ecn-membership'))::text`;

        const linked = await tx.ecnItem.findFirst({
          where: { toRevisionId: latest.id, ecn: { status: { in: ACTIVE_STATUSES } } },
          include: { ecn: { select: { id: true, ecnNumber: true } } },
        });
        if (linked) {
          // The block stands whoever holds the other ECN; only its number is need-to-know.
          const visibleEcns = await visibleIds('ECN', [linked.ecn.id], user);
          throw new HttpError(
            409,
            visibleEcns.has(linked.ecn.id)
              ? `Latest revision of ${item.part.partNumber} is managed by ECN ${linked.ecn.ecnNumber}`
              : `Latest revision of ${item.part.partNumber} is managed by a restricted ECN`
          );
        }
        const fromRevision = await tx.partRevision.findFirst({
          where: { partId: item.partId, lifecycle: Lifecycle.RELEASED },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        await tx.ecnItem.update({
          where: { id },
          data: { toRevisionId: latest.id, fromRevisionId: fromRevision?.id ?? null },
        });
      });
      res.json(await getEcnItemDtoOrThrow(id, user));
      return;
    }

    // Revise path: latest is RELEASED or OBSOLETE — same deep-copy semantics as
    // POST /parts/:id/revisions.
    const label = nextRevisionLabel(latest.revision);
    await prisma.$transaction(async (tx) => {
      const rev = await tx.partRevision.create({
        data: {
          partId: item.partId,
          revision: label,
          lifecycle: Lifecycle.IN_WORK,
          createdById: userId,
        },
        select: { id: true },
      });

      if (latest.bomLines.length > 0) {
        await tx.bomLine.createMany({
          data: latest.bomLines.map((line) => ({
            parentRevisionId: rev.id,
            childPartId: line.childPartId,
            findNumber: line.findNumber,
            quantity: line.quantity,
            uom: line.uom,
            refDesignators: line.refDesignators,
            notes: line.notes,
            effectiveFrom: line.effectiveFrom,
            effectiveTo: line.effectiveTo,
          })),
        });
        // Copy each line's alternates onto the matching new line.
        const newLines = await tx.bomLine.findMany({
          where: { parentRevisionId: rev.id },
          select: { id: true, childPartId: true },
        });
        const newIdByChild = new Map(newLines.map((l) => [l.childPartId, l.id]));
        const altRows = latest.bomLines.flatMap((line) =>
          line.alternates.map((alt) => ({
            bomLineId: newIdByChild.get(line.childPartId)!,
            alternatePartId: alt.alternatePartId,
            note: alt.note,
          }))
        );
        if (altRows.length > 0) await tx.bomLineAlternate.createMany({ data: altRows });
        // Variant option conditions travel with the line, like alternates.
        const optionRows = latest.bomLines.flatMap((line) =>
          line.optionConditions.map((cond) => ({
            bomLineId: newIdByChild.get(line.childPartId)!,
            optionValueId: cond.optionValueId,
          }))
        );
        if (optionRows.length > 0) await tx.bomLineOption.createMany({ data: optionRows });
      }

      if (latest.processPlan) {
        await tx.processPlan.create({
          data: {
            partRevisionId: rev.id,
            name: latest.processPlan.name,
            description: latest.processPlan.description,
            operations: {
              create: latest.processPlan.operations.map((op) => ({
                seq: op.seq,
                name: op.name,
                workCenter: op.workCenter,
                description: op.description,
                setupMinutes: op.setupMinutes,
                runMinutes: op.runMinutes,
                materials: {
                  create: op.materials.map((mat) => ({
                    partId: mat.partId,
                    quantity: mat.quantity,
                    uom: mat.uom,
                    notes: mat.notes,
                  })),
                },
              })),
            },
          },
        });
      }

      await tx.ecnItem.update({
        where: { id },
        data: { fromRevisionId: latest.id, toRevisionId: rev.id },
      });
    });

    res.status(201).json(await getEcnItemDtoOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /ecns/:id/reviewers — assign a reviewer (rule E11)
// ---------------------------------------------------------------------------

router.post(
  '/ecns/:id/reviewers',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const actorId = currentUserId(req);
    await assertCanWrite('ECN', id, aclUser(req));
    const body = requireBody(req);

    const ecn = await prisma.ecn.findUnique({
      where: { id },
      select: { id: true, ecnNumber: true, title: true, status: true },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    assertEcnEditable(ecn, [EcnStatus.DRAFT, EcnStatus.IN_REVIEW]);

    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0 || userId > 2147483647) {
      throw new HttpError(400, 'userId must be a positive integer');
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });
    if (!user) throw new HttpError(404, 'User not found');
    // Viewers are read-only and cannot record a decision, so assigning one would
    // deadlock the approve gate (same rule as workflow step assignees).
    if (user.role === Role.VIEWER) {
      throw new HttpError(409, `Viewers cannot approve — ${user.name} is a read-only user`);
    }

    const existing = await prisma.ecnReview.findFirst({
      where: { ecnId: id, reviewerId: userId },
      select: { id: true },
    });
    if (existing) throw new HttpError(409, 'User is already a reviewer');

    const created = await prisma.ecnReview.create({
      data: { ecnId: id, reviewerId: userId },
      include: ecnReviewInclude,
    });

    // REVIEWER_ASSIGNED — outside a transaction, so a delivery failure must
    // not undo the assignment.
    try {
      await notifyUsers(prisma, [userId], actorId, {
        type: 'REVIEWER_ASSIGNED',
        title: `You were assigned to review ${ecn.ecnNumber}`,
        body: ecn.title,
        link: `/ecns/${id}`,
      });
    } catch (err) {
      console.error('Failed to deliver REVIEWER_ASSIGNED notification', err);
    }

    res.status(201).json(toEcnReview(created));
  })
);

// ---------------------------------------------------------------------------
// DELETE /ecn-reviews/:id — remove a pending reviewer (rule E11)
// ---------------------------------------------------------------------------

router.delete(
  '/ecn-reviews/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const review = await prisma.ecnReview.findFirst({
      where: { id, ecn: { ...aclFilter('ECN', user) } },
      include: { ecn: { select: { ecnNumber: true, status: true } } },
    });
    if (!review) throw new HttpError(404, 'Review not found');
    await assertCanWrite('ECN', review.ecnId, user);
    assertEcnEditable(review.ecn, [EcnStatus.DRAFT, EcnStatus.IN_REVIEW]);
    if (review.decision !== EcnReviewDecision.PENDING) {
      throw new HttpError(409, 'A decided review cannot be removed');
    }
    await prisma.ecnReview.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /ecn-reviews/:id/decision — approve / request changes (rule E12)
// ---------------------------------------------------------------------------

router.post(
  '/ecn-reviews/:id/decision',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const userId = currentUserId(req);

    const decisionRaw = body.decision;
    if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
      throw new HttpError(400, "decision must be 'approve' or 'reject'");
    }
    const comment =
      body.comment === undefined ? undefined : optionalNullableText(body.comment, 'comment');

    // Scoped by the ECN's read filter: an assigned reviewer who has since lost visibility of a
    // restricted ECN can no longer decide it — deciding a change one cannot read is worse than
    // stalling the review. No write grant needed beyond that: the assignment itself is the
    // authorization, checked on the next line.
    const review = await prisma.ecnReview.findFirst({
      where: { id, ecn: { ...aclFilter('ECN', aclUser(req)) } },
      include: {
        ecn: { select: { id: true, ecnNumber: true, title: true, status: true, createdById: true } },
      },
    });
    if (!review) throw new HttpError(404, 'Review not found');
    if (review.reviewerId !== userId) {
      throw new HttpError(403, 'Only the assigned reviewer can decide');
    }
    if (review.ecn.status !== EcnStatus.IN_REVIEW) {
      throw new HttpError(
        409,
        `ECN ${review.ecn.ecnNumber} is ${review.ecn.status} — decisions are made while it is IN_REVIEW`
      );
    }

    const updated = await prisma.ecnReview.update({
      where: { id },
      data: {
        decision:
          decisionRaw === 'approve' ? EcnReviewDecision.APPROVED : EcnReviewDecision.REJECTED,
        ...(comment !== undefined ? { comment } : {}),
        decidedAt: new Date(),
      },
      include: ecnReviewInclude,
    });

    // REVIEW_DECIDED — tell the ECN creator; outside a transaction, so a
    // delivery failure must not undo the decision.
    try {
      await notifyUsers(prisma, [review.ecn.createdById], userId, {
        type: 'REVIEW_DECIDED',
        title: `${updated.reviewer.name} ${
          decisionRaw === 'approve' ? 'approved' : 'rejected'
        } their review on ${review.ecn.ecnNumber}`,
        body: review.ecn.title,
        link: `/ecns/${review.ecn.id}`,
      });
    } catch (err) {
      console.error('Failed to deliver REVIEW_DECIDED notification', err);
    }

    res.json(toEcnReview(updated));
  })
);

// ---------------------------------------------------------------------------
// GET /ecns/:id/impact — where-used rollup across affected parts
// ---------------------------------------------------------------------------

router.get(
  '/ecns/:id/impact',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const ecn = await prisma.ecn.findFirst({
      where: { id, ...aclFilter('ECN', user) },
      include: {
        items: {
          orderBy: { id: 'asc' },
          include: { part: true, toRevision: revisionRefSelect },
        },
      },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');

    const rawEntries = await Promise.all(
      ecn.items.map(async (item) => {
        const lines = await prisma.bomLine.findMany({
          where: { childPartId: item.partId },
          orderBy: { parentRevisionId: 'desc' },
          include: {
            parentRevision: {
              select: {
                id: true,
                revision: true,
                lifecycle: true,
                part: { select: { id: true, partNumber: true, name: true } },
              },
            },
          },
        });
        return { item, lines };
      })
    );
    // Rule X4 — one visibility query for the whole rollup: item parts and every BOM parent.
    // Both sides redact rather than drop, the same shape the where-used route answers with:
    // an impact list that omitted a restricted consumer would call a change safe when it isn't.
    const visibleParts = await visibleIds(
      'PART',
      rawEntries.flatMap(({ item, lines }) => [
        item.partId,
        ...lines.map((line) => line.parentRevision.part.id),
      ]),
      user
    );
    const entries = rawEntries.map(({ item, lines }) => {
      const itemVisible = visibleParts.has(item.partId);
      return {
        part: toPartRef(item.part, visibleParts),
        toRevision: itemVisible ? toRevisionRef(item.toRevision) : null,
        usedIn: lines.map((line) => {
          const parentVisible = visibleParts.has(line.parentRevision.part.id);
          return {
            line: {
              id: line.id,
              findNumber: line.findNumber,
              quantity: line.quantity,
              uom: line.uom,
            },
            parentRevision: {
              id: line.parentRevision.id,
              revision: parentVisible ? line.parentRevision.revision : REDACTED.name,
              lifecycle: line.parentRevision.lifecycle,
            },
            parentPart: parentVisible
              ? {
                  id: line.parentRevision.part.id,
                  partNumber: line.parentRevision.part.partNumber,
                  name: line.parentRevision.part.name,
                }
              : {
                  id: line.parentRevision.part.id,
                  partNumber: REDACTED.partNumber,
                  name: REDACTED.name,
                },
          };
        }),
      };
    });
    res.json(entries);
  })
);

// ---------------------------------------------------------------------------
// POST /ecns/:id/transition — lifecycle machine (rules E5, E6, E8)
// ---------------------------------------------------------------------------

type EcnTransitionAction = 'submit' | 'approve' | 'reject' | 'release' | 'cancel';

const ECN_TRANSITIONS: Record<EcnTransitionAction, { from: EcnStatus[]; to: EcnStatus }> = {
  submit: { from: [EcnStatus.DRAFT], to: EcnStatus.IN_REVIEW },
  approve: { from: [EcnStatus.IN_REVIEW], to: EcnStatus.APPROVED },
  reject: { from: [EcnStatus.IN_REVIEW], to: EcnStatus.DRAFT },
  release: { from: [EcnStatus.APPROVED], to: EcnStatus.RELEASED },
  cancel: {
    from: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED],
    to: EcnStatus.CANCELLED,
  },
};

router.post(
  '/ecns/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — before the body: a 400 about the action must not confirm the ECN exists.
    await assertCanWrite('ECN', id, user);
    const body = requireBody(req);
    const userId = currentUserId(req);

    const action = body.action;
    if (
      typeof action !== 'string' ||
      !Object.prototype.hasOwnProperty.call(ECN_TRANSITIONS, action)
    ) {
      throw new HttpError(400, 'Unknown action (expected submit, approve, reject, release or cancel)');
    }
    const transition = ECN_TRANSITIONS[action as EcnTransitionAction];

    // Rule W2 — submit may attach an approval workflow template.
    let workflowTemplateId: number | null = null;
    if (
      action === 'submit' &&
      body.workflowTemplateId !== undefined &&
      body.workflowTemplateId !== null
    ) {
      const parsed = Number(body.workflowTemplateId);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
        throw new HttpError(400, 'workflowTemplateId must be a positive integer');
      }
      workflowTemplateId = parsed;
    }

    const ecn = await prisma.ecn.findUnique({
      where: { id },
      include: {
        workflow: { select: { id: true, status: true, templateName: true } },
        reviews: { include: { reviewer: { select: { id: true, name: true } } } },
        items: {
          include: {
            part: { select: { id: true, partNumber: true } },
            toRevision: {
              include: {
                bomLines: {
                  include: {
                    childPart: {
                      select: {
                        id: true,
                        partNumber: true,
                        revisions: { select: { lifecycle: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');

    if (!transition.from.includes(ecn.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: ECN ${ecn.ecnNumber} is ${ecn.status} (requires ${transition.from.join(' or ')})`
      );
    }

    if (action === 'submit' && ecn.items.length === 0) {
      throw new HttpError(409, 'Add at least one affected part before submitting');
    }

    if (action === 'approve') {
      // Rule W4 — a running workflow owns the approval decision.
      if (ecn.workflow && ecn.workflow.status === WorkflowStatus.RUNNING) {
        throw new HttpError(
          409,
          `Cannot approve: approval is managed by workflow ${ecn.workflow.templateName}`
        );
      }
      const missing = ecn.items.filter((item) => item.toRevision === null);
      if (missing.length > 0) {
        // A writer of this ECN may still be blind to some of its parts — the gate holds
        // either way, but a hidden part's number must not surface in the message.
        const visibleParts = await visibleIds(
          'PART',
          missing.map((item) => item.part.id),
          user
        );
        const names = missing
          .map((item) =>
            visibleParts.has(item.part.id) ? item.part.partNumber : REDACTED.partNumber
          )
          .sort();
        throw new HttpError(409, `Cannot approve: no working revision for: ${names.join(', ')}`);
      }
      // Rule S4 — every active ECN signature requirement must hold a valid signature.
      // No requirements configured means nothing is gated, so an unregulated shop is
      // unaffected by the feature existing.
      await assertSignaturesComplete(SignedEntityType.ECN, id, 'approve');
      // Rule E13 — with reviewers assigned, all of them must have approved.
      // Rule W7 — the flat-reviewer gate only applies when no workflow
      // instance exists for the ECN (whatever its status).
      if (!ecn.workflow) {
        const outstanding = ecn.reviews
          .filter((review) => review.decision !== EcnReviewDecision.APPROVED)
          .map((review) => review.reviewer.name)
          .sort();
        if (outstanding.length > 0) {
          throw new HttpError(
            409,
            `Cannot approve: reviews outstanding for: ${outstanding.join(', ')}`
          );
        }
      }
    }

    // Notification recipients: the ECN creator + every assigned reviewer
    // (notifyUsers dedupes and skips the acting user).
    const reviewerIds = ecn.reviews.map((review) => review.reviewerId);

    const conditionalUpdate = async (
      tx: Prisma.TransactionClient,
      data: Prisma.EcnUncheckedUpdateManyInput
    ) => {
      const result = await tx.ecn.updateMany({
        where: { id, status: ecn.status },
        data: { ...data, status: transition.to },
      });
      if (result.count === 0) {
        throw new HttpError(
          409,
          `Cannot ${action}: ECN ${ecn.ecnNumber} was changed concurrently — reload and try again`
        );
      }
    };

    if (action === 'release') {
      // Rule E6 — atomic release of every working revision under this ECN. The
      // gate is evaluated INSIDE the transaction, under the same advisory lock
      // BOM structure edits take, so a concurrent BOM add cannot invalidate the
      // gate between its evaluation and the release commit.
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-bom-structure'))::text`;

        const items = await tx.ecnItem.findMany({
          where: { ecnId: id },
          include: {
            part: { select: { id: true, partNumber: true } },
            toRevision: {
              include: {
                bomLines: {
                  include: {
                    childPart: {
                      select: {
                        id: true,
                        partNumber: true,
                        revisions: { select: { lifecycle: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        });

        const affectedPartIds = new Set(items.map((item) => item.partId));
        // The gates below hold regardless of who is looking, but their messages name parts —
        // and a writer of the ECN may still be blind to some of them. One bulk visibility
        // lookup covers every name a message could carry (rule X4).
        const visibleParts = await visibleIds(
          'PART',
          items.flatMap((item) => [
            item.partId,
            ...(item.toRevision?.bomLines.map((line) => line.childPart.id) ?? []),
          ]),
          user
        );
        const partName = (partId: number, partNumber: string) =>
          visibleParts.has(partId) ? partNumber : REDACTED.partNumber;
        // Keyed by part id, so several hidden offenders stay several — collapsing them into
        // one "Restricted" would understate what blocks the release.
        const offenders = new Map<number, string>();
        for (const item of items) {
          if (!item.toRevision) {
            throw new HttpError(
              409,
              `Cannot release: no working revision for ${partName(item.partId, item.part.partNumber)}`
            );
          }
          if (
            item.toRevision.lifecycle !== Lifecycle.IN_WORK &&
            item.toRevision.lifecycle !== Lifecycle.IN_REVIEW
          ) {
            const name = partName(item.partId, item.part.partNumber);
            throw new HttpError(
              409,
              visibleParts.has(item.partId)
                ? `Cannot release: revision ${item.toRevision.revision} of ${name} is ${item.toRevision.lifecycle}`
                : `Cannot release: the working revision of ${name} is ${item.toRevision.lifecycle}`
            );
          }
          for (const line of item.toRevision.bomLines) {
            const childReleased = line.childPart.revisions.some(
              (r) => r.lifecycle === Lifecycle.RELEASED
            );
            if (!childReleased && !affectedPartIds.has(line.childPart.id)) {
              offenders.set(
                line.childPart.id,
                partName(line.childPart.id, line.childPart.partNumber)
              );
            }
          }
        }
        if (offenders.size > 0) {
          throw new HttpError(
            409,
            `Cannot release: child parts without a released revision: ${[...offenders.values()].sort().join(', ')}`
          );
        }

        const toRevisionIds = items.map((item) => item.toRevision!.id);
        const released = await tx.partRevision.updateMany({
          where: {
            id: { in: toRevisionIds },
            lifecycle: { in: [Lifecycle.IN_WORK, Lifecycle.IN_REVIEW] },
          },
          data: { lifecycle: Lifecycle.RELEASED, releasedAt: now },
        });
        if (released.count !== toRevisionIds.length) {
          throw new HttpError(
            409,
            'Cannot release: a revision was changed concurrently — reload and try again'
          );
        }
        await conditionalUpdate(tx, {
          releasedAt: now,
          // Rule U6 — only default a date cut-in when the ECN has no unit cut-in. Stamping
          // both would permanently produce the ambiguous state U6 exists to forbid, and
          // release is the one path that writes effectivityDate without the validator.
          effectivityDate:
            ecn.effectivityDate ?? (ecn.effectiveFromSerial ? null : now),
        });
        await notifyUsers(tx, [ecn.createdById, ...reviewerIds], userId, {
          type: 'ECN_RELEASED',
          title: `${ecn.ecnNumber} was released`,
          body: ecn.title,
          link: `/ecns/${id}`,
        });

        // Rule I2 — queue outbound webhooks inside the release transaction, so
        // deliveries only exist once the atomic release commits.
        await emitEvent(tx, 'ecn.released', {
          ecnId: ecn.id,
          ecnNumber: ecn.ecnNumber,
          title: ecn.title,
          status: transition.to,
        });
        for (const item of items) {
          const toRevision = item.toRevision!;
          const payload = {
            partId: item.part.id,
            partNumber: item.part.partNumber,
            revisionId: toRevision.id,
            revision: toRevision.revision,
            lifecycle: Lifecycle.RELEASED,
          };
          await emitEvent(tx, 'revision.released', payload);
          await emitEvent(tx, 'part.released', payload);
        }
      });
    } else {
      const data: Prisma.EcnUncheckedUpdateManyInput = {};
      if (action === 'approve') {
        data.approvedById = userId;
        data.approvedAt = new Date();
      }
      await prisma.$transaction(async (tx) => {
        await conditionalUpdate(tx, data);
        if (action === 'submit') {
          // Rule E13 — resubmitting restarts the review cycle (harmless when a
          // workflow is attached).
          await tx.ecnReview.updateMany({
            where: { ecnId: id },
            data: { decision: EcnReviewDecision.PENDING, decidedAt: null },
          });
          await notifyUsers(tx, reviewerIds, userId, {
            type: 'ECN_SUBMITTED',
            title: `${ecn.ecnNumber} was submitted for your review`,
            body: ecn.title,
            link: `/ecns/${id}`,
          });
          // Rule I2 — queued inside the transaction: no delivery unless the
          // status change commits.
          await emitEvent(tx, 'ecn.submitted', {
            ecnId: ecn.id,
            ecnNumber: ecn.ecnNumber,
            title: ecn.title,
            status: transition.to,
          });
          // Rule W2 — instantiate the approval workflow atomically with the
          // status change.
          if (workflowTemplateId !== null) {
            await instantiateWorkflow(
              tx,
              { id: ecn.id, ecnNumber: ecn.ecnNumber, createdById: ecn.createdById },
              workflowTemplateId,
              userId
            );
          } else {
            // Resubmitting with flat reviewers: a terminal workflow from an
            // earlier cycle must not stay attached, or the UI keeps showing the
            // (dead) workflow instead of the reviewer gate.
            const stale = await tx.ecnWorkflow.findUnique({
              where: { ecnId: ecn.id },
              select: { id: true, status: true },
            });
            if (stale) {
              if (stale.status === WorkflowStatus.RUNNING) {
                throw new HttpError(
                  409,
                  `ECN ${ecn.ecnNumber} already has a running workflow — cancel it before submitting with flat reviewers`
                );
              }
              await tx.ecnWorkflow.delete({ where: { id: stale.id } });
            }
          }
        } else {
          // Rule W4 — rejecting or cancelling the ECN cancels a running
          // approval workflow in the same transaction.
          if (action === 'reject' || action === 'cancel') {
            await tx.ecnWorkflow.updateMany({
              where: { ecnId: id, status: WorkflowStatus.RUNNING },
              data: { status: WorkflowStatus.CANCELLED },
            });
          }
          const outcome =
            action === 'approve'
              ? { type: 'ECN_APPROVED', verb: 'approved' }
              : action === 'reject'
                ? { type: 'ECN_REJECTED', verb: 'rejected' }
                : { type: 'ECN_CANCELLED', verb: 'cancelled' };
          await notifyUsers(tx, [ecn.createdById, ...reviewerIds], userId, {
            type: outcome.type,
            title: `${ecn.ecnNumber} was ${outcome.verb}`,
            body: ecn.title,
            link: `/ecns/${id}`,
          });
          // Rule I2 — queued inside the transaction: no delivery unless the
          // approval commits.
          if (action === 'approve') {
            await emitEvent(tx, 'ecn.approved', {
              ecnId: ecn.id,
              ecnNumber: ecn.ecnNumber,
              title: ecn.title,
              status: transition.to,
            });
          }
        }
      });
    }

    res.json(await getEcnDetailOrThrow(id, user));
  })
);

export default router;
