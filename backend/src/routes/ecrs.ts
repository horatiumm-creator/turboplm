import { Request, Router } from 'express';
import { EcnPriority, EcnStatus, EcrStatus, Lifecycle, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';
import { emitEvent } from '../lib/webhooks';
import { lockNumbering, withNumberLock } from '../lib/plm';
import { AclUser, aclFilter, REDACTED, visibleIds } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface EcrSummaryDto {
  id: number;
  ecrNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcrStatus;
  part: { id: number; partNumber: string; name: string } | typeof REDACTED | null;
  ecn: { id: number; ecnNumber: string } | null;
  createdBy: UserRefDto;
  createdAt: string;
}

interface EcrDetailDto extends EcrSummaryDto {
  description: string | null;
  resolution: string | null;
  resolvedBy: UserRefDto | null;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const ecrInclude = {
  part: { select: { id: true, partNumber: true, name: true } },
  ecn: { select: { id: true, ecnNumber: true } },
  createdBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
} satisfies Prisma.EcrInclude;

type EcrRow = Prisma.EcrGetPayload<{ include: typeof ecrInclude }>;

/**
 * Rule X4 — an ECR is not a protected type, but it may name a part and an ECN, each carrying
 * its own grants. Redacted in place; the request itself (title, status, priority) stays.
 */
interface EcrVisibility {
  parts: ReadonlySet<number>;
  ecns: ReadonlySet<number>;
}

async function ecrVisibility(ecrs: EcrRow[], user: AclUser): Promise<EcrVisibility> {
  const [parts, ecns] = await Promise.all([
    visibleIds('PART', ecrs.flatMap((e) => (e.part ? [e.part.id] : [])), user),
    visibleIds('ECN', ecrs.flatMap((e) => (e.ecn ? [e.ecn.id] : [])), user),
  ]);
  return { parts, ecns };
}

function toEcrSummary(ecr: EcrRow, vis: EcrVisibility): EcrSummaryDto {
  return {
    id: ecr.id,
    ecrNumber: ecr.ecrNumber,
    title: ecr.title,
    priority: ecr.priority,
    status: ecr.status,
    part: ecr.part
      ? vis.parts.has(ecr.part.id)
        ? { id: ecr.part.id, partNumber: ecr.part.partNumber, name: ecr.part.name }
        : { ...REDACTED }
      : null,
    ecn: ecr.ecn
      ? {
          id: ecr.ecn.id,
          ecnNumber: vis.ecns.has(ecr.ecn.id) ? ecr.ecn.ecnNumber : REDACTED.name,
        }
      : null,
    createdBy: { id: ecr.createdBy.id, name: ecr.createdBy.name },
    createdAt: ecr.createdAt.toISOString(),
  };
}

function toEcrDetail(ecr: EcrRow, vis: EcrVisibility): EcrDetailDto {
  return {
    ...toEcrSummary(ecr, vis),
    description: ecr.description,
    resolution: ecr.resolution,
    resolvedBy: ecr.resolvedBy ? { id: ecr.resolvedBy.id, name: ecr.resolvedBy.name } : null,
    resolvedAt: ecr.resolvedAt ? ecr.resolvedAt.toISOString() : null,
  };
}

async function getEcrDetailOrThrow(id: number, user: AclUser): Promise<EcrDetailDto> {
  const ecr = await prisma.ecr.findUnique({ where: { id }, include: ecrInclude });
  if (!ecr) throw new HttpError(404, 'ECR not found');
  return toEcrDetail(ecr, await ecrVisibility([ecr], user));
}

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

/** Like requireBody, but tolerates an absent body (routes with optional bodies). */
function optionalBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
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

function parseBodyId(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

/** Rule T2 — scan-based numbering, ECR-10001 style (same approach as parts/ECNs). */
async function generateEcrNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("ecrNumber" FROM 5)::int) AS max
    FROM "Ecr"
    WHERE "ecrNumber" ~ '^ECR-[0-9]{1,9}$'`;
  return `ECR-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

/** ECN-10001 style numbering inside the accept transaction. */
async function generateEcnNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("ecnNumber" FROM 5)::int) AS max
    FROM "Ecn"
    WHERE "ecnNumber" ~ '^ECN-[0-9]{1,9}$'`;
  return `ECN-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

// ---------------------------------------------------------------------------
// GET /ecrs — list with search/status filters + pagination
// ---------------------------------------------------------------------------

router.get(
  '/ecrs',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(Object.values(EcrStatus) as string[]).includes(statusRaw)) {
      throw new HttpError(400, 'Invalid status filter');
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where: Prisma.EcrWhereInput = {};
    if (search) {
      where.OR = [
        { ecrNumber: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (statusRaw) where.status = statusRaw as EcrStatus;

    const [total, ecrs] = await Promise.all([
      prisma.ecr.count({ where }),
      prisma.ecr.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ecrInclude,
      }),
    ]);

    const vis = await ecrVisibility(ecrs, aclUser(req));
    res.json({ items: ecrs.map((ecr) => toEcrSummary(ecr, vis)), total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /ecrs — create (rule T2 numbering)
// ---------------------------------------------------------------------------

router.post(
  '/ecrs',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);

    const title = requireTitle(body.title);
    const description =
      body.description === undefined ? null : optionalNullableText(body.description, 'description');
    const priority = body.priority === undefined ? EcnPriority.MEDIUM : parsePriority(body.priority);

    let partId: number | null = null;
    if (body.partId !== undefined && body.partId !== null) {
      partId = parseBodyId(body.partId, 'partId');
      // A restricted part answers like a missing one (rule X2).
      const part = await prisma.part.findFirst({
        where: { id: partId, ...(aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput) },
        select: { id: true },
      });
      if (!part) throw new HttpError(404, 'Part not found');
    }

    const createEcrRecord = (ecrNumber: string, db: Prisma.TransactionClient = prisma) =>
      db.ecr.create({
        data: { ecrNumber, title, description, priority, partId, createdById: userId },
        select: { id: true, ecrNumber: true },
      });

    // Numbers can only collide under concurrent creates — regenerate and retry.
    const created = await withNumberLock(async (tx) => {
      // Serialized allocation; the retry is a backstop for a manually-typed clash.
      for (let attempt = 0; ; attempt++) {
        try {
          return await createEcrRecord(await generateEcrNumber(tx), tx);
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    });

    // ECR_RAISED — tell every admin; outside a transaction, so a delivery
    // failure must not undo the create.
    try {
      const admins = await prisma.user.findMany({
        where: { role: Role.ADMIN },
        select: { id: true },
      });
      await notifyUsers(
        prisma,
        admins.map((admin) => admin.id),
        userId,
        {
          type: 'ECR_RAISED',
          title: `${req.user?.name ?? 'Someone'} raised ${created.ecrNumber}`,
          body: title,
          link: `/ecrs/${created.id}`,
        }
      );
    } catch (err) {
      console.error('Failed to deliver ECR_RAISED notification', err);
    }

    // Rule I2 — ecr.raised webhook; outside a transaction, so a queueing
    // failure must not undo the create.
    try {
      await emitEvent(prisma, 'ecr.raised', {
        ecrId: created.id,
        ecrNumber: created.ecrNumber,
        title,
        priority,
      });
    } catch (err) {
      console.error('Failed to queue ecr.raised webhook', err);
    }

    res.status(201).json(await getEcrDetailOrThrow(created.id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// GET /ecrs/:id
// ---------------------------------------------------------------------------

router.get(
  '/ecrs/:id',
  asyncHandler(async (req, res) => {
    res.json(await getEcrDetailOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /ecrs/:id — only while OPEN (rule T2)
// ---------------------------------------------------------------------------

router.patch(
  '/ecrs/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const ecr = await prisma.ecr.findUnique({
      where: { id },
      select: { id: true, ecrNumber: true, status: true },
    });
    if (!ecr) throw new HttpError(404, 'ECR not found');
    if (ecr.status !== EcrStatus.OPEN) {
      throw new HttpError(409, `ECR ${ecr.ecrNumber} is ${ecr.status} and cannot be modified`);
    }

    const data: Prisma.EcrUpdateInput = {};
    if (body.title !== undefined) data.title = requireTitle(body.title);
    if (body.description !== undefined)
      data.description = optionalNullableText(body.description, 'description');
    if (body.priority !== undefined) data.priority = parsePriority(body.priority);
    if (body.partId !== undefined) {
      if (body.partId === null) {
        data.part = { disconnect: true };
      } else {
        const partId = parseBodyId(body.partId, 'partId');
        const part = await prisma.part.findFirst({
          where: { id: partId, ...(aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput) },
          select: { id: true },
        });
        if (!part) throw new HttpError(404, 'Part not found');
        data.part = { connect: { id: partId } };
      }
    }

    await prisma.ecr.update({ where: { id }, data });
    res.json(await getEcrDetailOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /ecrs/:id/accept — OPEN → ACCEPTED, linking or auto-creating an ECN
// ---------------------------------------------------------------------------

router.post(
  '/ecrs/:id/accept',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = optionalBody(req);
    const userId = currentUserId(req);

    const ecr = await prisma.ecr.findUnique({
      where: { id },
      select: {
        id: true,
        ecrNumber: true,
        title: true,
        description: true,
        priority: true,
        status: true,
        partId: true,
        createdById: true,
      },
    });
    if (!ecr) throw new HttpError(404, 'ECR not found');
    if (ecr.status !== EcrStatus.OPEN) {
      throw new HttpError(409, `ECR ${ecr.ecrNumber} is ${ecr.status} and cannot be accepted`);
    }

    /** Conditional OPEN → ACCEPTED transition; 409 on a concurrent change. */
    const markAccepted = async (
      tx: Prisma.TransactionClient,
      ecn: { id: number; ecnNumber: string }
    ) => {
      const updated = await tx.ecr.updateMany({
        where: { id, status: EcrStatus.OPEN },
        data: {
          status: EcrStatus.ACCEPTED,
          ecnId: ecn.id,
          resolution: `Accepted — see ${ecn.ecnNumber}`,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });
      if (updated.count === 0) {
        throw new HttpError(
          409,
          `ECR ${ecr.ecrNumber} was changed concurrently — reload and try again`
        );
      }
      // ECR_ACCEPTED — tell the requester, atomically with the transition.
      await notifyUsers(tx, [ecr.createdById], userId, {
        type: 'ECR_ACCEPTED',
        title: `${ecr.ecrNumber} was accepted — see ${ecn.ecnNumber}`,
        body: ecr.title,
        link: `/ecrs/${id}`,
      });
    };

    if (body.ecnId !== undefined && body.ecnId !== null) {
      // Link an existing ECN.
      const ecnId = parseBodyId(body.ecnId, 'ecnId');
      const ecn = await prisma.ecn.findFirst({
        where: { id: ecnId, ...(aclFilter('ECN', aclUser(req)) as Prisma.EcnWhereInput) },
        select: { id: true, ecnNumber: true },
      });
      if (!ecn) throw new HttpError(404, 'ECN not found');
      await prisma.$transaction(async (tx) => {
        await markAccepted(tx, ecn);
      });
    } else {
      // Auto-create a DRAFT ECN from the ECR. The ECN number can collide only
      // under concurrent creates — regenerate and retry the whole transaction.
      const acceptWithNewEcn = () =>
        prisma.$transaction(async (tx) => {
          // Same numbering lock POST /ecns takes; see the note in quality.ts's escalate path
          // for why a retry cannot substitute for it inside a transaction.
          await lockNumbering(tx);
          const ecn = await tx.ecn.create({
            data: {
              ecnNumber: await generateEcnNumber(tx),
              title: ecr.title,
              reason: ecr.description,
              priority: ecr.priority,
              createdById: userId,
            },
            select: { id: true, ecnNumber: true },
          });
          if (ecr.partId !== null) {
            // Rule E3 — the part must not already be on another active ECN; take
            // the same membership lock the item-add endpoint uses.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-ecn-membership'))::text`;
            const elsewhere = await tx.ecnItem.findFirst({
              where: {
                partId: ecr.partId,
                ecn: { status: { in: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED] } },
              },
              include: {
                ecn: { select: { id: true, ecnNumber: true } },
                part: { select: { partNumber: true } },
              },
            });
            if (elsewhere) {
              throw new HttpError(
                409,
                `Part ${elsewhere.part.partNumber} is already on active ECN ${elsewhere.ecn.ecnNumber} — accept this ECR by linking that ECN instead`
              );
            }
            const fromRevision = await tx.partRevision.findFirst({
              where: { partId: ecr.partId, lifecycle: Lifecycle.RELEASED },
              orderBy: { id: 'desc' },
              select: { id: true },
            });
            await tx.ecnItem.create({
              data: {
                ecnId: ecn.id,
                partId: ecr.partId,
                fromRevisionId: fromRevision?.id ?? null,
              },
            });
          }
          await markAccepted(tx, ecn);
        });

      for (let attempt = 0; ; attempt++) {
        try {
          await acceptWithNewEcn();
          break;
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    }

    res.json(await getEcrDetailOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /ecrs/:id/reject — OPEN → REJECTED (resolution required)
// ---------------------------------------------------------------------------

router.post(
  '/ecrs/:id/reject',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = optionalBody(req);
    const userId = currentUserId(req);

    const resolutionRaw = body.resolution;
    if (typeof resolutionRaw !== 'string' || resolutionRaw.trim().length === 0) {
      throw new HttpError(400, 'resolution is required');
    }
    const resolution = resolutionRaw.trim();

    const ecr = await prisma.ecr.findUnique({
      where: { id },
      select: { id: true, ecrNumber: true, title: true, status: true, createdById: true },
    });
    if (!ecr) throw new HttpError(404, 'ECR not found');
    if (ecr.status !== EcrStatus.OPEN) {
      throw new HttpError(409, `ECR ${ecr.ecrNumber} is ${ecr.status} and cannot be rejected`);
    }

    const updated = await prisma.ecr.updateMany({
      where: { id, status: EcrStatus.OPEN },
      data: {
        status: EcrStatus.REJECTED,
        resolution,
        resolvedById: userId,
        resolvedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw new HttpError(
        409,
        `ECR ${ecr.ecrNumber} was changed concurrently — reload and try again`
      );
    }

    // ECR_REJECTED — tell the requester; outside a transaction, so a delivery
    // failure must not undo the rejection.
    try {
      await notifyUsers(prisma, [ecr.createdById], userId, {
        type: 'ECR_REJECTED',
        title: `${ecr.ecrNumber} was rejected`,
        body: ecr.title,
        link: `/ecrs/${id}`,
      });
    } catch (err) {
      console.error('Failed to deliver ECR_REJECTED notification', err);
    }

    res.json(await getEcrDetailOrThrow(id, aclUser(req)));
  })
);

export default router;
