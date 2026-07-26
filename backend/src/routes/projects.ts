import { Request, Router } from 'express';
import {
  DeliverableStatus,
  EcnStatus,
  GateStatus,
  PartCategory,
  Prisma,
  ProjectStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';

const router = Router();
router.use(requireAuth);

const PROJECT_CODE_RE = /^[A-Z0-9-]{2,20}$/i;
const DEFAULT_PHASES = ['Concept', 'Design', 'Validation', 'Pilot', 'Production'];

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

interface DeliverableDto {
  id: number;
  name: string;
  status: DeliverableStatus;
  required: boolean;
  owner: UserRefDto | null;
  dueDate: string | null;
  notes: string | null;
  part: PartRefDto | null;
  document: { id: number; docNumber: string; title: string } | null;
  requirement: { id: number; reqNumber: string; title: string } | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
}

interface PhaseDto {
  id: number;
  seq: number;
  name: string;
  gateCriteria: string | null;
  status: GateStatus;
  targetDate: string | null;
  passedAt: string | null;
  passedBy: UserRefDto | null;
  deliverables: DeliverableDto[];
  blockingCount: number;
}

interface ProjectSummaryDto {
  id: number;
  code: string;
  name: string;
  status: ProjectStatus;
  owner: UserRefDto;
  startDate: string | null;
  targetDate: string | null;
  phaseCount: number;
  passedPhases: number;
  currentPhase: { id: number; seq: number; name: string; status: GateStatus } | null;
  createdAt: string;
}

interface ProjectDetailDto extends ProjectSummaryDto {
  description: string | null;
  createdBy: UserRefDto;
  phases: PhaseDto[];
}

// ---------------------------------------------------------------------------
// Includes + mappers
// ---------------------------------------------------------------------------

const deliverableInclude = {
  owner: { select: { id: true, name: true } },
  part: true,
  document: { select: { id: true, docNumber: true, title: true } },
  requirement: { select: { id: true, reqNumber: true, title: true } },
  ecn: { select: { id: true, ecnNumber: true, status: true } },
} satisfies Prisma.ProjectDeliverableInclude;

const projectInclude = {
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  phases: {
    orderBy: { seq: 'asc' as const },
    include: {
      passedBy: { select: { id: true, name: true } },
      deliverables: { orderBy: { id: 'asc' as const }, include: deliverableInclude },
    },
  },
} satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;
type DeliverableRow = ProjectRow['phases'][number]['deliverables'][number];

const isBlocking = (d: { required: boolean; status: DeliverableStatus }) =>
  d.required && d.status !== DeliverableStatus.COMPLETE && d.status !== DeliverableStatus.WAIVED;

function toDeliverable(d: DeliverableRow): DeliverableDto {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    required: d.required,
    owner: d.owner ? { id: d.owner.id, name: d.owner.name } : null,
    dueDate: d.dueDate ? d.dueDate.toISOString() : null,
    notes: d.notes,
    part: d.part
      ? {
          id: d.part.id,
          partNumber: d.part.partNumber,
          name: d.part.name,
          category: d.part.category,
          uom: d.part.uom,
        }
      : null,
    document: d.document
      ? { id: d.document.id, docNumber: d.document.docNumber, title: d.document.title }
      : null,
    requirement: d.requirement
      ? { id: d.requirement.id, reqNumber: d.requirement.reqNumber, title: d.requirement.title }
      : null,
    ecn: d.ecn ? { id: d.ecn.id, ecnNumber: d.ecn.ecnNumber, status: d.ecn.status } : null,
  };
}

function toProjectDetail(project: ProjectRow): ProjectDetailDto {
  const phases: PhaseDto[] = project.phases.map((phase) => ({
    id: phase.id,
    seq: phase.seq,
    name: phase.name,
    gateCriteria: phase.gateCriteria,
    status: phase.status,
    targetDate: phase.targetDate ? phase.targetDate.toISOString() : null,
    passedAt: phase.passedAt ? phase.passedAt.toISOString() : null,
    passedBy: phase.passedBy ? { id: phase.passedBy.id, name: phase.passedBy.name } : null,
    deliverables: phase.deliverables.map(toDeliverable),
    blockingCount: phase.deliverables.filter(isBlocking).length,
  }));
  const current = phases.find((p) => p.status !== GateStatus.PASSED) ?? null;

  return {
    id: project.id,
    code: project.code,
    name: project.name,
    status: project.status,
    owner: { id: project.owner.id, name: project.owner.name },
    startDate: project.startDate ? project.startDate.toISOString() : null,
    targetDate: project.targetDate ? project.targetDate.toISOString() : null,
    phaseCount: phases.length,
    passedPhases: phases.filter((p) => p.status === GateStatus.PASSED).length,
    currentPhase: current
      ? { id: current.id, seq: current.seq, name: current.name, status: current.status }
      : null,
    createdAt: project.createdAt.toISOString(),
    description: project.description,
    createdBy: { id: project.createdBy.id, name: project.createdBy.name },
    phases,
  };
}

async function getProjectDetailOrThrow(id: number): Promise<ProjectDetailDto> {
  const project = await prisma.project.findUnique({ where: { id }, include: projectInclude });
  if (!project) throw new HttpError(404, 'Project not found');
  return toProjectDetail(project);
}

/** Resolve the project id owning a phase / deliverable, 404 when missing. */
async function projectIdOfPhase(phaseId: number): Promise<number> {
  const phase = await prisma.projectPhase.findUnique({
    where: { id: phaseId },
    select: { projectId: true },
  });
  if (!phase) throw new HttpError(404, 'Phase not found');
  return phase.projectId;
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
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
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

/** Validate the optional entity links on a deliverable; 404 names the missing one. */
async function assertLinksExist(links: {
  partId: number | null;
  documentId: number | null;
  requirementId: number | null;
  ecnId: number | null;
}): Promise<void> {
  if (links.partId !== null) {
    const row = await prisma.part.findUnique({ where: { id: links.partId }, select: { id: true } });
    if (!row) throw new HttpError(404, 'Part not found');
  }
  if (links.documentId !== null) {
    const row = await prisma.document.findUnique({
      where: { id: links.documentId },
      select: { id: true },
    });
    if (!row) throw new HttpError(404, 'Document not found');
  }
  if (links.requirementId !== null) {
    const row = await prisma.requirement.findUnique({
      where: { id: links.requirementId },
      select: { id: true },
    });
    if (!row) throw new HttpError(404, 'Requirement not found');
  }
  if (links.ecnId !== null) {
    const row = await prisma.ecn.findUnique({ where: { id: links.ecnId }, select: { id: true } });
    if (!row) throw new HttpError(404, 'ECN not found');
  }
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------

router.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Prisma.ProjectWhereInput = {};
    if (typeof req.query.status === 'string' && req.query.status) {
      where.status = parseEnum(req.query.status, ProjectStatus, 'status');
    }
    const [total, rows] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: projectInclude,
      }),
    ]);
    // ProjectSummary is ProjectDetail without the heavy fields.
    const items = rows.map((row) => {
      const { description: _d, createdBy: _c, phases: _p, ...summary } = toProjectDetail(row);
      return summary;
    });
    res.json({ items, total, page, pageSize });
  })
);

// ---------------------------------------------------------------------------
// POST /projects
// ---------------------------------------------------------------------------

router.post(
  '/projects',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);

    const code = requireText(body.code, 'code', 20).toUpperCase();
    if (!PROJECT_CODE_RE.test(code)) {
      throw new HttpError(400, 'code must be 2–20 letters, digits or hyphens');
    }
    const name = requireText(body.name, 'name');
    const description = body.description === undefined ? null : optionalText(body.description, 'description');
    const ownerId = optionalId(body.ownerId, 'ownerId');
    if (ownerId === null) throw new HttpError(400, 'ownerId is required');
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) throw new HttpError(404, 'Owner not found');
    const startDate = parseDate(body.startDate, 'startDate');
    const targetDate = parseDate(body.targetDate, 'targetDate');

    let phaseNames: { name: string; gateCriteria: string | null }[];
    if (body.phases === undefined) {
      phaseNames = DEFAULT_PHASES.map((name) => ({ name, gateCriteria: null }));
    } else {
      if (!Array.isArray(body.phases) || body.phases.length === 0) {
        throw new HttpError(400, 'phases must be a non-empty array when supplied');
      }
      phaseNames = body.phases.map((raw, index) => {
        const phase = raw as Record<string, unknown>;
        return {
          name: requireText(phase.name, `phases[${index}].name`),
          gateCriteria:
            phase.gateCriteria === undefined
              ? null
              : optionalText(phase.gateCriteria, `phases[${index}].gateCriteria`),
        };
      });
    }

    const existing = await prisma.project.findUnique({ where: { code }, select: { id: true } });
    if (existing) throw new HttpError(409, `Project code ${code} already exists`);

    const created = await prisma.project.create({
      data: {
        code,
        name,
        description,
        ownerId,
        startDate,
        targetDate,
        createdById: userId,
        phases: {
          create: phaseNames.map((phase, index) => ({
            seq: index + 1,
            name: phase.name,
            gateCriteria: phase.gateCriteria,
            status: index === 0 ? GateStatus.IN_PROGRESS : GateStatus.NOT_STARTED,
          })),
        },
      },
      select: { id: true },
    });

    if (ownerId !== userId) {
      await notifyUsers(prisma, [ownerId], userId, {
        type: 'PROJECT_ASSIGNED',
        title: `You own project ${code}`,
        body: name,
        link: `/projects/${created.id}`,
      }).catch((err) => console.error('Project notify failed:', err));
    }

    res.status(201).json(await getProjectDetailOrThrow(created.id));
  })
);

router.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    res.json(await getProjectDetailOrThrow(idParam(req.params.id)));
  })
);

router.patch(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) throw new HttpError(404, 'Project not found');

    const data: Prisma.ProjectUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = requireText(body.name, 'name');
    if (body.description !== undefined) data.description = optionalText(body.description, 'description');
    if (body.status !== undefined) data.status = parseEnum(body.status, ProjectStatus, 'status');
    if (body.startDate !== undefined) data.startDate = parseDate(body.startDate, 'startDate');
    if (body.targetDate !== undefined) data.targetDate = parseDate(body.targetDate, 'targetDate');
    if (body.ownerId !== undefined) {
      const ownerId = optionalId(body.ownerId, 'ownerId');
      if (ownerId === null) throw new HttpError(400, 'ownerId cannot be null');
      const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!owner) throw new HttpError(404, 'Owner not found');
      data.ownerId = ownerId;
    }

    await prisma.project.update({ where: { id }, data });
    res.json(await getProjectDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// POST /projects/:id/phases
// ---------------------------------------------------------------------------

router.post(
  '/projects/:id/phases',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) throw new HttpError(404, 'Project not found');

    const name = requireText(body.name, 'name');
    const gateCriteria = body.gateCriteria === undefined ? null : optionalText(body.gateCriteria, 'gateCriteria');
    const targetDate = parseDate(body.targetDate, 'targetDate');

    const agg = await prisma.projectPhase.aggregate({
      where: { projectId: id },
      _max: { seq: true },
    });
    await prisma.projectPhase.create({
      data: { projectId: id, seq: (agg._max.seq ?? 0) + 1, name, gateCriteria, targetDate },
    });
    res.status(201).json(await getProjectDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// POST /project-phases/:id/pass — the gate rule
// ---------------------------------------------------------------------------

router.post(
  '/project-phases/:id/pass',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);

    const phase = await prisma.projectPhase.findUnique({
      where: { id },
      include: {
        deliverables: { select: { name: true, required: true, status: true } },
        project: { select: { id: true } },
      },
    });
    if (!phase) throw new HttpError(404, 'Phase not found');
    if (phase.status === GateStatus.PASSED) {
      throw new HttpError(409, `Gate ${phase.name} has already been passed`);
    }

    const earlier = await prisma.projectPhase.findFirst({
      where: { projectId: phase.projectId, seq: { lt: phase.seq }, status: { not: GateStatus.PASSED } },
      orderBy: { seq: 'asc' },
      select: { name: true },
    });
    if (earlier) throw new HttpError(409, `Pass gate ${earlier.name} first`);

    const blocking = phase.deliverables.filter(isBlocking).map((d) => d.name);
    if (blocking.length > 0) {
      throw new HttpError(409, `Blocked by: ${blocking.join(', ')}`);
    }

    await prisma.$transaction(async (tx) => {
      const result = await tx.projectPhase.updateMany({
        where: { id, status: phase.status },
        data: { status: GateStatus.PASSED, passedAt: new Date(), passedById: userId },
      });
      if (result.count === 0) {
        throw new HttpError(409, `Gate ${phase.name} was changed concurrently — reload and try again`);
      }
      // Move the next gate into progress.
      const next = await tx.projectPhase.findFirst({
        where: { projectId: phase.projectId, seq: { gt: phase.seq } },
        orderBy: { seq: 'asc' },
        select: { id: true, status: true },
      });
      if (next && next.status === GateStatus.NOT_STARTED) {
        await tx.projectPhase.update({
          where: { id: next.id },
          data: { status: GateStatus.IN_PROGRESS },
        });
      }
    });

    res.json(await getProjectDetailOrThrow(phase.projectId));
  })
);

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

router.post(
  '/project-phases/:id/deliverables',
  asyncHandler(async (req, res) => {
    const phaseId = idParam(req.params.id);
    const body = requireBody(req);
    const projectId = await projectIdOfPhase(phaseId);

    const name = requireText(body.name, 'name');
    const required = body.required === undefined ? true : Boolean(body.required);
    const ownerId = optionalId(body.ownerId, 'ownerId');
    if (ownerId !== null) {
      const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!owner) throw new HttpError(404, 'Owner not found');
    }
    const links = {
      partId: optionalId(body.partId, 'partId'),
      documentId: optionalId(body.documentId, 'documentId'),
      requirementId: optionalId(body.requirementId, 'requirementId'),
      ecnId: optionalId(body.ecnId, 'ecnId'),
    };
    await assertLinksExist(links);

    await prisma.projectDeliverable.create({
      data: {
        phaseId,
        name,
        required,
        ownerId,
        dueDate: parseDate(body.dueDate, 'dueDate'),
        notes: body.notes === undefined ? null : optionalText(body.notes, 'notes'),
        ...links,
      },
    });
    res.status(201).json(await getProjectDetailOrThrow(projectId));
  })
);

router.patch(
  '/deliverables/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const deliverable = await prisma.projectDeliverable.findUnique({
      where: { id },
      select: { id: true, phaseId: true },
    });
    if (!deliverable) throw new HttpError(404, 'Deliverable not found');
    const projectId = await projectIdOfPhase(deliverable.phaseId);

    const data: Prisma.ProjectDeliverableUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = requireText(body.name, 'name');
    if (body.status !== undefined) data.status = parseEnum(body.status, DeliverableStatus, 'status');
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');
    if (body.dueDate !== undefined) data.dueDate = parseDate(body.dueDate, 'dueDate');
    if (body.ownerId !== undefined) {
      const ownerId = optionalId(body.ownerId, 'ownerId');
      if (ownerId !== null) {
        const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
        if (!owner) throw new HttpError(404, 'Owner not found');
      }
      data.ownerId = ownerId;
    }

    await prisma.projectDeliverable.update({ where: { id }, data });
    res.json(await getProjectDetailOrThrow(projectId));
  })
);

router.delete(
  '/deliverables/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const deliverable = await prisma.projectDeliverable.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!deliverable) throw new HttpError(404, 'Deliverable not found');
    await prisma.projectDeliverable.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
