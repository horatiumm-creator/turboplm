import { Request, Router } from 'express';
import {
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
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';

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

interface NcrSummaryDto {
  id: number;
  ncrNumber: string;
  title: string;
  severity: NcrSeverity;
  status: NcrStatus;
  disposition: EcnDisposition | null;
  part: PartRefDto | null;
  createdBy: UserRefDto;
  createdAt: string;
  capa: { id: number; capaNumber: string } | null;
}

interface NcrDetailDto extends NcrSummaryDto {
  description: string;
  quantityAffected: number | null;
  lotOrSerial: string | null;
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

const toPartRef = (part: NcrRow['part']): PartRefDto | null =>
  part
    ? {
        id: part.id,
        partNumber: part.partNumber,
        name: part.name,
        category: part.category,
        uom: part.uom,
      }
    : null;

function toNcrSummary(ncr: NcrRow): NcrSummaryDto {
  return {
    id: ncr.id,
    ncrNumber: ncr.ncrNumber,
    title: ncr.title,
    severity: ncr.severity,
    status: ncr.status,
    disposition: ncr.disposition,
    part: toPartRef(ncr.part),
    createdBy: { id: ncr.createdBy.id, name: ncr.createdBy.name },
    createdAt: ncr.createdAt.toISOString(),
    capa: ncr.capa ? { id: ncr.capa.id, capaNumber: ncr.capa.capaNumber } : null,
  };
}

function toNcrDetail(ncr: NcrRow): NcrDetailDto {
  return {
    ...toNcrSummary(ncr),
    description: ncr.description,
    quantityAffected: ncr.quantityAffected,
    lotOrSerial: ncr.lotOrSerial,
    partRevision: ncr.partRevision
      ? {
          id: ncr.partRevision.id,
          revision: ncr.partRevision.revision,
          lifecycle: ncr.partRevision.lifecycle,
        }
      : null,
    ecn: ncr.ecn ? { id: ncr.ecn.id, ecnNumber: ncr.ecn.ecnNumber, status: ncr.ecn.status } : null,
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

function toCapaDetail(capa: CapaRow): CapaDetailDto {
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
    nonconformances: capa.nonconformances.map(toNcrSummary),
  };
}

async function getNcrOrThrow(id: number): Promise<NcrDetailDto> {
  const ncr = await prisma.nonconformance.findUnique({ where: { id }, include: ncrInclude });
  if (!ncr) throw new HttpError(404, 'Nonconformance not found');
  return toNcrDetail(ncr);
}

async function getCapaOrThrow(id: number): Promise<CapaDetailDto> {
  const capa = await prisma.correctiveAction.findUnique({ where: { id }, include: capaInclude });
  if (!capa) throw new HttpError(404, 'Corrective action not found');
  return toCapaDetail(capa);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

function parseDate(value: unknown, label: string): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

/** Scan-max numbering, matching generatePartNumber's approach. */
async function nextNumber(prefix: 'NCR' | 'CAPA'): Promise<string> {
  const table = prefix === 'NCR' ? 'Nonconformance' : 'CorrectiveAction';
  const column = prefix === 'NCR' ? 'ncrNumber' : 'capaNumber';
  const offset = prefix.length + 2; // SUBSTRING is 1-based, skip "PREFIX-"
  const rows = await prisma.$queryRawUnsafe<{ max: number | null }[]>(
    `SELECT MAX(SUBSTRING("${column}" FROM ${offset})::int) AS max
     FROM "${table}" WHERE "${column}" ~ '^${prefix}-[0-9]{1,9}$'`
  );
  return `${prefix}-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

async function createWithNumber<T>(
  prefix: 'NCR' | 'CAPA',
  create: (num: string) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(await nextNumber(prefix));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
      throw err;
    }
  }
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
    res.json({ items: rows.map(toNcrSummary), total, page, pageSize });
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

    let quantityAffected: number | null = null;
    if (body.quantityAffected !== undefined && body.quantityAffected !== null) {
      const q = Number(body.quantityAffected);
      if (!Number.isFinite(q) || q <= 0) {
        throw new HttpError(400, 'quantityAffected must be a number greater than 0');
      }
      quantityAffected = q;
    }

    if (partId !== null) {
      const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
      if (!part) throw new HttpError(404, 'Part not found');
    }
    if (partRevisionId !== null) {
      const rev = await prisma.partRevision.findUnique({
        where: { id: partRevisionId },
        select: { partId: true },
      });
      if (!rev) throw new HttpError(404, 'Revision not found');
      if (partId !== null && rev.partId !== partId) {
        throw new HttpError(400, 'partRevisionId does not belong to the given part');
      }
    }

    const created = await createWithNumber('NCR', (ncrNumber) =>
      prisma.nonconformance.create({
        data: {
          ncrNumber,
          title,
          description,
          severity,
          partId,
          partRevisionId,
          quantityAffected,
          lotOrSerial,
          createdById: userId,
        },
        select: { id: true },
      })
    );
    res.status(201).json(await getNcrOrThrow(created.id));
  })
);

router.get(
  '/ncrs/:id',
  asyncHandler(async (req, res) => {
    res.json(await getNcrOrThrow(idParam(req.params.id)));
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
    res.json(await getNcrOrThrow(id));
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
    res.json(await getNcrOrThrow(id));
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

    const ncr = await prisma.nonconformance.findUnique({
      where: { id },
      include: { part: { select: { id: true, partNumber: true } } },
    });
    if (!ncr) throw new HttpError(404, 'Nonconformance not found');
    if (ncr.ecnId !== null) throw new HttpError(409, 'This NCR already has an ECN');
    if (ncr.partId === null || !ncr.part) {
      throw new HttpError(409, 'Set the affected part before raising an ECN');
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
            include: { ecn: { select: { ecnNumber: true } } },
          });
          if (elsewhere) {
            throw new HttpError(
              409,
              `Part ${part.partNumber} is already on active ECN ${elsewhere.ecn.ecnNumber}`
            );
          }

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

    res.json(await getNcrOrThrow(id));
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

    const created = await createWithNumber('CAPA', (capaNumber) =>
      prisma.correctiveAction.create({
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

    res.status(201).json(await getCapaOrThrow(created.id));
  })
);

router.get(
  '/capas/:id',
  asyncHandler(async (req, res) => {
    res.json(await getCapaOrThrow(idParam(req.params.id)));
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
    res.json(await getCapaOrThrow(id));
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
    res.json(await getCapaOrThrow(id));
  })
);

export default router;
