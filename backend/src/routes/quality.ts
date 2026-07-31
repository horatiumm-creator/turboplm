import { Request, Router } from 'express';
import {
  BuildKind,
  BuildStatus,
  CapaStatus,
  EcnDisposition,
  EcnPriority,
  EcnStatus,
  Lifecycle,
  NcrSeverity,
  NcrStatus,
  PartCategory,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AclUser, aclFilter, REDACTED, visibleIds } from '../lib/acl';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';
import { lockNumbering, withNumberLock } from '../lib/plm';

const router = Router();
router.use(requireAuth);

const ACTIVE_ECN: EcnStatus[] = [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED];

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
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
interface BuildUnitRefDto {
  id: number;
  identifier: string;
  kind: BuildKind;
  status: BuildStatus;
}

interface NcrSummaryDto {
  id: number;
  ncrNumber: string;
  title: string;
  severity: NcrSeverity;
  status: NcrStatus;
  disposition: EcnDisposition | null;
  part: PartRefDto | typeof REDACTED | null;
  createdBy: UserRefDto;
  createdAt: string;
  capa: { id: number; capaNumber: string } | null;
}

interface NcrDetailDto extends NcrSummaryDto {
  description: string;
  quantityAffected: number | null;
  lotOrSerial: string | null;
  buildUnitId: number | null;
  buildUnit: BuildUnitRefDto | null;
  partRevision: RevisionRefDto | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
  closedBy: UserRefDto | null;
  closedAt: string | null;
}

interface CapaSummaryDto {
  id: number;
  capaNumber: string;
  title: string;
  status: CapaStatus;
  owner: UserRefDto;
  dueDate: string | null;
  ncrCount: number;
  createdAt: string;
}

interface CapaDetailDto extends CapaSummaryDto {
  problem: string;
  rootCause: string | null;
  containment: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  createdBy: UserRefDto;
  nonconformances: NcrSummaryDto[];
}

// ---------------------------------------------------------------------------
// Includes + mappers
// ---------------------------------------------------------------------------

const ncrInclude = {
  part: true,
  partRevision: { select: { id: true, revision: true, lifecycle: true } },
  buildUnit: { select: { id: true, identifier: true, kind: true, status: true } },
  ecn: { select: { id: true, ecnNumber: true, status: true } },
  capa: { select: { id: true, capaNumber: true } },
  createdBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
} satisfies Prisma.NonconformanceInclude;

const capaInclude = {
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  nonconformances: { orderBy: { id: 'asc' as const }, include: ncrInclude },
  _count: { select: { nonconformances: true } },
} satisfies Prisma.CorrectiveActionInclude;

type NcrRow = Prisma.NonconformanceGetPayload<{ include: typeof ncrInclude }>;
type CapaRow = Prisma.CorrectiveActionGetPayload<{ include: typeof capaInclude }>;

/**
 * Rule X4 — an NCR is not itself a protected type, but it names four things that are: its
 * part, that part's revision, a build unit and an ECN. All of them are redacted in place —
 * the defect record stays (severity, status, quantities), the identity does not.
 */
interface QualityVisibility {
  parts: ReadonlySet<number>;
  units: ReadonlySet<number>;
  ecns: ReadonlySet<number>;
}

async function qualityVisibility(ncrs: NcrRow[], user: AclUser): Promise<QualityVisibility> {
  const [parts, units, ecns] = await Promise.all([
    visibleIds('PART', ncrs.flatMap((ncr) => (ncr.partId === null ? [] : [ncr.partId])), user),
    visibleIds(
      'BUILD_UNIT',
      ncrs.flatMap((ncr) => (ncr.buildUnitId === null ? [] : [ncr.buildUnitId])),
      user
    ),
    visibleIds('ECN', ncrs.flatMap((ncr) => (ncr.ecnId === null ? [] : [ncr.ecnId])), user),
  ]);
  return { parts, units, ecns };
}

const toPartRef = (
  part: NcrRow['part'],
  vis: QualityVisibility
): PartRefDto | typeof REDACTED | null =>
  part
    ? vis.parts.has(part.id)
      ? {
          id: part.id,
          partNumber: part.partNumber,
          name: part.name,
          category: part.category,
          uom: part.uom,
        }
      : { ...REDACTED }
    : null;

function toNcrSummary(ncr: NcrRow, vis: QualityVisibility): NcrSummaryDto {
  return {
    id: ncr.id,
    ncrNumber: ncr.ncrNumber,
    title: ncr.title,
    severity: ncr.severity,
    status: ncr.status,
    disposition: ncr.disposition,
    part: toPartRef(ncr.part, vis),
    createdBy: { id: ncr.createdBy.id, name: ncr.createdBy.name },
    createdAt: ncr.createdAt.toISOString(),
    capa: ncr.capa ? { id: ncr.capa.id, capaNumber: ncr.capa.capaNumber } : null,
  };
}

function toNcrDetail(ncr: NcrRow, vis: QualityVisibility): NcrDetailDto {
  const partVisible = ncr.partId !== null && vis.parts.has(ncr.partId);
  return {
    ...toNcrSummary(ncr, vis),
    description: ncr.description,
    quantityAffected: ncr.quantityAffected,
    lotOrSerial: ncr.lotOrSerial,
    buildUnitId: ncr.buildUnitId,
    buildUnit: ncr.buildUnit
      ? {
          id: ncr.buildUnit.id,
          identifier: vis.units.has(ncr.buildUnit.id)
            ? ncr.buildUnit.identifier
            : REDACTED.name,
          kind: ncr.buildUnit.kind,
          status: ncr.buildUnit.status,
        }
      : null,
    partRevision: ncr.partRevision
      ? {
          id: ncr.partRevision.id,
          revision: partVisible ? ncr.partRevision.revision : REDACTED.name,
          lifecycle: ncr.partRevision.lifecycle,
        }
      : null,
    ecn: ncr.ecn
      ? {
          id: ncr.ecn.id,
          ecnNumber: vis.ecns.has(ncr.ecn.id) ? ncr.ecn.ecnNumber : REDACTED.name,
          status: ncr.ecn.status,
        }
      : null,
    closedBy: ncr.closedBy ? { id: ncr.closedBy.id, name: ncr.closedBy.name } : null,
    closedAt: ncr.closedAt ? ncr.closedAt.toISOString() : null,
  };
}

function toCapaSummary(capa: CapaRow): CapaSummaryDto {
  return {
    id: capa.id,
    capaNumber: capa.capaNumber,
    title: capa.title,
    status: capa.status,
    owner: { id: capa.owner.id, name: capa.owner.name },
    dueDate: capa.dueDate ? capa.dueDate.toISOString() : null,
    ncrCount: capa._count.nonconformances,
    createdAt: capa.createdAt.toISOString(),
  };
}

function toCapaDetail(capa: CapaRow, vis: QualityVisibility): CapaDetailDto {
  return {
    ...toCapaSummary(capa),
    problem: capa.problem,
    rootCause: capa.rootCause,
    containment: capa.containment,
    correctiveAction: capa.correctiveAction,
    preventiveAction: capa.preventiveAction,
    verifiedAt: capa.verifiedAt ? capa.verifiedAt.toISOString() : null,
    closedAt: capa.closedAt ? capa.closedAt.toISOString() : null,
    createdBy: { id: capa.createdBy.id, name: capa.createdBy.name },
    nonconformances: capa.nonconformances.map((ncr) => toNcrSummary(ncr, vis)),
  };
}

async function getNcrOrThrow(id: number, user: AclUser): Promise<NcrDetailDto> {
  const ncr = await prisma.nonconformance.findUnique({ where: { id }, include: ncrInclude });
  if (!ncr) throw new HttpError(404, 'Nonconformance not found');
  return toNcrDetail(ncr, await qualityVisibility([ncr], user));
}

async function getCapaOrThrow(id: number, user: AclUser): Promise<CapaDetailDto> {
  const capa = await prisma.correctiveAction.findUnique({ where: { id }, include: capaInclude });
  if (!capa) throw new HttpError(404, 'Corrective action not found');
  return toCapaDetail(capa, await qualityVisibility(capa.nonconformances, user));
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

function optionalText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
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

/**
 * Rule U7 — an NCR may point at a tracked unit; 400 rather than 404 because the id is one
 * field of a larger write. The free-text `lotOrSerial` is independent and untouched.
 */
async function assertBuildUnitExists(buildUnitId: number, user: AclUser): Promise<void> {
  // Acl-filtered: a restricted unit answers exactly like a nonexistent one (rule X2).
  const unit = await prisma.buildUnit.findFirst({
    where: { id: buildUnitId, ...(aclFilter('BUILD_UNIT', user) as Prisma.BuildUnitWhereInput) },
    select: { id: true },
  });
  if (!unit) throw new HttpError(400, 'buildUnitId does not reference an existing build unit');
}

function parseDate(value: unknown, label: string): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

/** Scan-max numbering, matching generatePartNumber's approach. */
async function nextNumber(
  prefix: 'NCR' | 'CAPA',
  db: Prisma.TransactionClient = prisma
): Promise<string> {
  const table = prefix === 'NCR' ? 'Nonconformance' : 'CorrectiveAction';
  const column = prefix === 'NCR' ? 'ncrNumber' : 'capaNumber';
  const offset = prefix.length + 2; // SUBSTRING is 1-based, skip "PREFIX-"
  const rows = await db.$queryRawUnsafe<{ max: number | null }[]>(
    `SELECT MAX(SUBSTRING("${column}" FROM ${offset})::int) AS max
     FROM "${table}" WHERE "${column}" ~ '^${prefix}-[0-9]{1,9}$'`
  );
  return `${prefix}-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

async function createWithNumber<T>(
  prefix: 'NCR' | 'CAPA',
  create: (num: string, db: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  // Allocation is serialized so a concurrent burst queues instead of every caller
  // reading the same maximum; the retry below is only a backstop.
  return withNumberLock(async (tx) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await create(await nextNumber(prefix, tx), tx);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// GET /ncrs
// ---------------------------------------------------------------------------

router.get(
  '/ncrs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Prisma.NonconformanceWhereInput = {};
    if (typeof req.query.status === 'string' && req.query.status) {
      where.status = parseEnum(req.query.status, NcrStatus, 'status');
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const q = req.query.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
      where.OR = [
        { ncrNumber: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }
    const [total, rows] = await Promise.all([
      prisma.nonconformance.count({ where }),
      prisma.nonconformance.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ncrInclude,
      }),
    ]);
    const vis = await qualityVisibility(rows, aclUser(req));
    res.json({ items: rows.map((row) => toNcrSummary(row, vis)), total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /ncrs
// ---------------------------------------------------------------------------

router.post(
  '/ncrs',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);

    const title = requireText(body.title, 'title');
    const description = requireText(body.description, 'description', 5000);
    const severity =
      body.severity === undefined ? NcrSeverity.MINOR : parseEnum(body.severity, NcrSeverity, 'severity');
    const partId = body.partId === undefined ? null : optionalId(body.partId, 'partId');
    const partRevisionId =
      body.partRevisionId === undefined ? null : optionalId(body.partRevisionId, 'partRevisionId');
    const lotOrSerial = body.lotOrSerial === undefined ? null : optionalText(body.lotOrSerial, 'lotOrSerial');
    const buildUnitId =
      body.buildUnitId === undefined ? null : optionalId(body.buildUnitId, 'buildUnitId');

    let quantityAffected: number | null = null;
    if (body.quantityAffected !== undefined && body.quantityAffected !== null) {
      const q = Number(body.quantityAffected);
      if (!Number.isFinite(q) || q <= 0) {
        throw new HttpError(400, 'quantityAffected must be a number greater than 0');
      }
      quantityAffected = q;
    }

    if (partId !== null) {
      // A restricted part answers like a missing one (rule X2).
      const part = await prisma.part.findFirst({
        where: { id: partId, ...(aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput) },
        select: { id: true },
      });
      if (!part) throw new HttpError(404, 'Part not found');
    }
    if (partRevisionId !== null) {
      const rev = await prisma.partRevision.findFirst({
        where: {
          id: partRevisionId,
          part: aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput,
        },
        select: { partId: true },
      });
      if (!rev) throw new HttpError(404, 'Revision not found');
      if (partId !== null && rev.partId !== partId) {
        throw new HttpError(400, 'partRevisionId does not belong to the given part');
      }
    }
    if (buildUnitId !== null) await assertBuildUnitExists(buildUnitId, aclUser(req));

    const created = await createWithNumber('NCR', (ncrNumber, tx) =>
      tx.nonconformance.create({
        data: {
          ncrNumber,
          title,
          description,
          severity,
          partId,
          partRevisionId,
          quantityAffected,
          lotOrSerial,
          buildUnitId,
          createdById: userId,
        },
        select: { id: true },
      })
    );
    res.status(201).json(await getNcrOrThrow(created.id, aclUser(req)));
  })
);

router.get(
  '/ncrs/:id',
  asyncHandler(async (req, res) => {
    res.json(await getNcrOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /ncrs/:id — blocked once closed
// ---------------------------------------------------------------------------

router.patch(
  '/ncrs/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const ncr = await prisma.nonconformance.findUnique({
      where: { id },
      select: { id: true, ncrNumber: true, status: true },
    });
    if (!ncr) throw new HttpError(404, 'Nonconformance not found');
    if (ncr.status === NcrStatus.CLOSED) {
      throw new HttpError(409, `NCR ${ncr.ncrNumber} is closed`);
    }

    const data: Prisma.NonconformanceUncheckedUpdateInput = {};
    if (body.title !== undefined) data.title = requireText(body.title, 'title');
    if (body.description !== undefined)
      data.description = requireText(body.description, 'description', 5000);
    if (body.severity !== undefined) data.severity = parseEnum(body.severity, NcrSeverity, 'severity');
    if (body.disposition !== undefined) {
      data.disposition =
        body.disposition === null
          ? null
          : parseEnum(body.disposition, EcnDisposition, 'disposition');
    }
    if (body.lotOrSerial !== undefined) data.lotOrSerial = optionalText(body.lotOrSerial, 'lotOrSerial');
    if (body.buildUnitId !== undefined) {
      const buildUnitId = optionalId(body.buildUnitId, 'buildUnitId');
      if (buildUnitId !== null) await assertBuildUnitExists(buildUnitId, aclUser(req));
      data.buildUnitId = buildUnitId;
    }
    if (body.quantityAffected !== undefined) {
      if (body.quantityAffected === null) data.quantityAffected = null;
      else {
        const q = Number(body.quantityAffected);
        if (!Number.isFinite(q) || q <= 0) {
          throw new HttpError(400, 'quantityAffected must be a number greater than 0');
        }
        data.quantityAffected = q;
      }
    }
    if (body.capaId !== undefined) {
      const capaId = optionalId(body.capaId, 'capaId');
      if (capaId !== null) {
        const capa = await prisma.correctiveAction.findUnique({
          where: { id: capaId },
          select: { id: true },
        });
        if (!capa) throw new HttpError(404, 'Corrective action not found');
      }
      data.capaId = capaId;
    }

    await prisma.nonconformance.update({ where: { id }, data });
    res.json(await getNcrOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /ncrs/:id/transition
// ---------------------------------------------------------------------------

const NCR_TRANSITIONS: Record<string, { from: NcrStatus[]; to: NcrStatus }> = {
  contain: { from: [NcrStatus.OPEN], to: NcrStatus.CONTAINED },
  close: { from: [NcrStatus.OPEN, NcrStatus.CONTAINED], to: NcrStatus.CLOSED },
  reopen: { from: [NcrStatus.CLOSED], to: NcrStatus.OPEN },
};

router.post(
  '/ncrs/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const userId = currentUserId(req);

    const action = typeof body.action === 'string' ? body.action : '';
    if (!Object.prototype.hasOwnProperty.call(NCR_TRANSITIONS, action)) {
      throw new HttpError(400, 'Unknown action (expected contain, close or reopen)');
    }
    const transition = NCR_TRANSITIONS[action];

    const ncr = await prisma.nonconformance.findUnique({
      where: { id },
      select: { id: true, ncrNumber: true, status: true, disposition: true },
    });
    if (!ncr) throw new HttpError(404, 'Nonconformance not found');
    if (!transition.from.includes(ncr.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: NCR ${ncr.ncrNumber} is ${ncr.status} (requires ${transition.from.join(' or ')})`
      );
    }
    if (action === 'close' && ncr.disposition === null) {
      throw new HttpError(409, 'Set a disposition before closing');
    }

    const data: Prisma.NonconformanceUncheckedUpdateManyInput = { status: transition.to };
    if (action === 'close') {
      data.closedById = userId;
      data.closedAt = new Date();
    } else if (action === 'reopen') {
      data.closedById = null;
      data.closedAt = null;
    }

    const result = await prisma.nonconformance.updateMany({
      where: { id, status: ncr.status },
      data,
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: NCR ${ncr.ncrNumber} was changed concurrently — reload and try again`
      );
    }
    res.json(await getNcrOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /ncrs/:id/escalate — raise a draft ECN from the nonconformance
// ---------------------------------------------------------------------------

const SEVERITY_PRIORITY: Record<NcrSeverity, EcnPriority> = {
  CRITICAL: EcnPriority.CRITICAL,
  MAJOR: EcnPriority.HIGH,
  MINOR: EcnPriority.MEDIUM,
};

router.post(
  '/ncrs/:id/escalate',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);

    const user = aclUser(req);
    const ncr = await prisma.nonconformance.findUnique({
      where: { id },
      include: { part: { select: { id: true, partNumber: true } } },
    });
    if (!ncr) throw new HttpError(404, 'Nonconformance not found');
    if (ncr.ecnId !== null) throw new HttpError(409, 'This NCR already has an ECN');
    if (ncr.partId === null || !ncr.part) {
      throw new HttpError(409, 'Set the affected part before raising an ECN');
    }
    // Raising a change against a part is naming it on an ECN — the caller must be able to
    // read it, and a restricted part answers as if the NCR had none they can act on.
    const visibleParts = await visibleIds('PART', [ncr.partId], user);
    if (!visibleParts.has(ncr.partId)) {
      throw new HttpError(404, 'Part not found');
    }
    const partId = ncr.partId;
    const part = ncr.part;

    for (let attempt = 0; ; attempt++) {
      try {
        await prisma.$transaction(async (tx) => {
          // Rule E3 — one active ECN per part.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-ecn-membership'))::text`;
          const elsewhere = await tx.ecnItem.findFirst({
            where: { partId, ecn: { status: { in: ACTIVE_ECN } } },
            include: { ecn: { select: { id: true, ecnNumber: true } } },
          });
          if (elsewhere) {
            // The rule holds either way; a restricted ECN's number stays out of the message.
            const visibleEcns = await visibleIds('ECN', [elsewhere.ecn.id], user);
            throw new HttpError(
              409,
              visibleEcns.has(elsewhere.ecn.id)
                ? `Part ${part.partNumber} is already on active ECN ${elsewhere.ecn.ecnNumber}`
                : `Part ${part.partNumber} is already on an active restricted ECN`
            );
          }

          // Take the numbering lock before the scan, exactly as POST /ecns does. Without it
          // this path and that one can read the same maximum and one of them fails on the
          // unique constraint — and a P2002 raised inside an interactive transaction cannot
          // be retried, because the surrounding Postgres transaction is already aborted.
          await lockNumbering(tx);
          const rows = await tx.$queryRaw<{ max: number | null }[]>`
            SELECT MAX(SUBSTRING("ecnNumber" FROM 5)::int) AS max
            FROM "Ecn" WHERE "ecnNumber" ~ '^ECN-[0-9]{1,9}$'`;
          const ecnNumber = `ECN-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;

          const ecn = await tx.ecn.create({
            data: {
              ecnNumber,
              title: `NCR ${ncr.ncrNumber}: ${ncr.title}`.slice(0, 200),
              reason: ncr.description,
              priority: SEVERITY_PRIORITY[ncr.severity],
              createdById: userId,
            },
            select: { id: true, ecnNumber: true },
          });

          const fromRevision = await tx.partRevision.findFirst({
            where: { partId, lifecycle: Lifecycle.RELEASED },
            orderBy: { id: 'desc' },
            select: { id: true },
          });
          await tx.ecnItem.create({
            data: {
              ecnId: ecn.id,
              partId,
              fromRevisionId: fromRevision?.id ?? null,
              changeDescription: `Raised from ${ncr.ncrNumber}`,
            },
          });
          await tx.nonconformance.update({ where: { id }, data: { ecnId: ecn.id } });

          await notifyUsers(tx, [ncr.createdById], userId, {
            type: 'NCR_ESCALATED',
            title: `${ecn.ecnNumber} was raised from ${ncr.ncrNumber}`,
            body: ncr.title,
            link: `/ecns/${ecn.id}`,
          });
        });
        break;
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }

    res.json(await getNcrOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// CAPA
// ---------------------------------------------------------------------------

router.get(
  '/capas',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Prisma.CorrectiveActionWhereInput = {};
    if (typeof req.query.status === 'string' && req.query.status) {
      where.status = parseEnum(req.query.status, CapaStatus, 'status');
    }
    const [total, rows] = await Promise.all([
      prisma.correctiveAction.count({ where }),
      prisma.correctiveAction.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: capaInclude,
      }),
    ]);
    res.json({ items: rows.map(toCapaSummary), total, page, pageSize });
  })
);

router.post(
  '/capas',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);

    const title = requireText(body.title, 'title');
    const problem = requireText(body.problem, 'problem', 5000);
    const ownerId = optionalId(body.ownerId, 'ownerId');
    if (ownerId === null) throw new HttpError(400, 'ownerId is required');
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) throw new HttpError(404, 'Owner not found');
    const dueDate = body.dueDate === undefined ? null : parseDate(body.dueDate, 'dueDate');

    const created = await createWithNumber('CAPA', (capaNumber, tx) =>
      tx.correctiveAction.create({
        data: { capaNumber, title, problem, ownerId, dueDate, createdById: userId },
        select: { id: true },
      })
    );

    if (ownerId !== userId) {
      await notifyUsers(prisma, [ownerId], userId, {
        type: 'CAPA_ASSIGNED',
        title: `You own a new corrective action`,
        body: title,
        link: `/capas/${created.id}`,
      }).catch((err) => console.error('CAPA notify failed:', err));
    }

    res.status(201).json(await getCapaOrThrow(created.id, aclUser(req)));
  })
);

router.get(
  '/capas/:id',
  asyncHandler(async (req, res) => {
    res.json(await getCapaOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

router.patch(
  '/capas/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const capa = await prisma.correctiveAction.findUnique({
      where: { id },
      select: { id: true, capaNumber: true, status: true },
    });
    if (!capa) throw new HttpError(404, 'Corrective action not found');
    if (capa.status === CapaStatus.CLOSED) {
      throw new HttpError(409, `CAPA ${capa.capaNumber} is closed`);
    }

    const data: Prisma.CorrectiveActionUncheckedUpdateInput = {};
    if (body.title !== undefined) data.title = requireText(body.title, 'title');
    if (body.problem !== undefined) data.problem = requireText(body.problem, 'problem', 5000);
    if (body.rootCause !== undefined) data.rootCause = optionalText(body.rootCause, 'rootCause');
    if (body.containment !== undefined) data.containment = optionalText(body.containment, 'containment');
    if (body.correctiveAction !== undefined)
      data.correctiveAction = optionalText(body.correctiveAction, 'correctiveAction');
    if (body.preventiveAction !== undefined)
      data.preventiveAction = optionalText(body.preventiveAction, 'preventiveAction');
    if (body.dueDate !== undefined) data.dueDate = parseDate(body.dueDate, 'dueDate');
    if (body.ownerId !== undefined) {
      const ownerId = optionalId(body.ownerId, 'ownerId');
      if (ownerId === null) throw new HttpError(400, 'ownerId cannot be null');
      const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!owner) throw new HttpError(404, 'Owner not found');
      data.ownerId = ownerId;
    }

    await prisma.correctiveAction.update({ where: { id }, data });
    res.json(await getCapaOrThrow(id, aclUser(req)));
  })
);

const CAPA_TRANSITIONS: Record<string, { from: CapaStatus[]; to: CapaStatus }> = {
  start: { from: [CapaStatus.OPEN], to: CapaStatus.IN_PROGRESS },
  verify: { from: [CapaStatus.IN_PROGRESS], to: CapaStatus.VERIFIED },
  close: { from: [CapaStatus.VERIFIED], to: CapaStatus.CLOSED },
  reopen: { from: [CapaStatus.VERIFIED, CapaStatus.CLOSED], to: CapaStatus.IN_PROGRESS },
};

router.post(
  '/capas/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const action = typeof body.action === 'string' ? body.action : '';
    if (!Object.prototype.hasOwnProperty.call(CAPA_TRANSITIONS, action)) {
      throw new HttpError(400, 'Unknown action (expected start, verify, close or reopen)');
    }
    const transition = CAPA_TRANSITIONS[action];

    const capa = await prisma.correctiveAction.findUnique({
      where: { id },
      include: {
        nonconformances: { select: { ncrNumber: true, status: true } },
      },
    });
    if (!capa) throw new HttpError(404, 'Corrective action not found');
    if (!transition.from.includes(capa.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: CAPA ${capa.capaNumber} is ${capa.status} (requires ${transition.from.join(' or ')})`
      );
    }
    if (action === 'verify' && (!capa.rootCause || !capa.correctiveAction)) {
      throw new HttpError(409, 'Record a root cause and a corrective action before verifying');
    }
    if (action === 'close') {
      const openNcrs = capa.nonconformances
        .filter((n) => n.status !== NcrStatus.CLOSED)
        .map((n) => n.ncrNumber)
        .sort();
      if (openNcrs.length > 0) {
        throw new HttpError(409, `Cannot close: these NCRs are still open: ${openNcrs.join(', ')}`);
      }
    }

    const data: Prisma.CorrectiveActionUncheckedUpdateManyInput = { status: transition.to };
    if (action === 'verify') data.verifiedAt = new Date();
    if (action === 'close') data.closedAt = new Date();
    if (action === 'reopen') {
      data.verifiedAt = null;
      data.closedAt = null;
    }

    const result = await prisma.correctiveAction.updateMany({
      where: { id, status: capa.status },
      data,
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: CAPA ${capa.capaNumber} was changed concurrently — reload and try again`
      );
    }
    res.json(await getCapaOrThrow(id, aclUser(req)));
  })
);

export default router;
