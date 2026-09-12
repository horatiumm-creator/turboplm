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
import { AclUser, aclFilter, assertCanRead, assertCanWrite, visibleIds, REDACTED } from '../lib/acl';

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

/**
 * The redacted stand-in for a linked item the caller may not read (rule X4). The four core
 * fields always come from the shared `REDACTED`; a shape the contract does not declare gets its
 * own identity fields as the same constant, so nothing of the hidden item's real data survives
 * while every field the UI reads still exists.
 */
interface RedactedRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}
type RedactedDocumentRefDto = RedactedRefDto & { docNumber: 'Restricted'; title: 'Restricted' };
type RedactedEcnRefDto = RedactedRefDto & { ecnNumber: 'Restricted' };

const REDACTED_DOCUMENT: RedactedDocumentRefDto = {
  ...REDACTED,
  docNumber: 'Restricted',
  title: 'Restricted',
};
// `status` is dropped rather than nulled-out: an ECN's state is real data about a hidden item,
// and no total on this response is computed from it.
const REDACTED_ECN: RedactedEcnRefDto = { ...REDACTED, ecnNumber: 'Restricted' };

interface DeliverableDto {
  id: number;
  name: string;
  status: DeliverableStatus;
  required: boolean;
  owner: UserRefDto | null;
  dueDate: string | null;
  notes: string | null;
  part: PartRefDto | RedactedRefDto | null;
  document: { id: number; docNumber: string; title: string } | RedactedDocumentRefDto | null;
  requirement: { id: number; reqNumber: string; title: string } | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | RedactedEcnRefDto | null;
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

/**
 * The list endpoint's include. Deliberately does NOT reach deliverables: the summary shape has
 * no field they feed, and a query that never loads a part, document or ECN cannot leak one
 * (rule X3). Everything ProjectSummary needs comes off the phase rows themselves.
 */
const summaryInclude = {
  owner: { select: { id: true, name: true } },
  phases: {
    orderBy: { seq: 'asc' as const },
    select: { id: true, seq: true, name: true, status: true },
  },
} satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;
type ProjectSummaryRow = Prisma.ProjectGetPayload<{ include: typeof summaryInclude }>;
type DeliverableRow = ProjectRow['phases'][number]['deliverables'][number];

/**
 * Which of the protected types a deliverable can point at this caller may read, resolved once
 * per response instead of per link (rule X3). Requirements are absent on purpose: `Requirement`
 * is not one of the five ACL-bearing types, so it needs no filtering here.
 */
interface LinkVisibility {
  parts: Set<number>;
  documents: Set<number>;
  ecns: Set<number>;
}

/** Three bulk queries for a whole project, never one per deliverable. */
async function linkVisibility(project: ProjectRow, user: AclUser): Promise<LinkVisibility> {
  const partIds: number[] = [];
  const documentIds: number[] = [];
  const ecnIds: number[] = [];
  for (const phase of project.phases) {
    for (const deliverable of phase.deliverables) {
      if (deliverable.part) partIds.push(deliverable.part.id);
      if (deliverable.document) documentIds.push(deliverable.document.id);
      if (deliverable.ecn) ecnIds.push(deliverable.ecn.id);
    }
  }
  const [parts, documents, ecns] = await Promise.all([
    visibleIds('PART', partIds, user),
    visibleIds('DOCUMENT', documentIds, user),
    visibleIds('ECN', ecnIds, user),
  ]);
  return { parts, documents, ecns };
}

const isBlocking = (d: { required: boolean; status: DeliverableStatus }) =>
  d.required && d.status !== DeliverableStatus.COMPLETE && d.status !== DeliverableStatus.WAIVED;

function toDeliverable(d: DeliverableRow, vis: LinkVisibility): DeliverableDto {
  // A restricted link is redacted, never dropped (rule X4). Dropping it would make a gate look
  // unencumbered — a required deliverable whose evidence the reader cannot see still blocks.
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    required: d.required,
    owner: d.owner ? { id: d.owner.id, name: d.owner.name } : null,
    dueDate: d.dueDate ? d.dueDate.toISOString() : null,
    notes: d.notes,
    part: d.part
      ? vis.parts.has(d.part.id)
        ? {
            id: d.part.id,
            partNumber: d.part.partNumber,
            name: d.part.name,
            category: d.part.category,
            uom: d.part.uom,
          }
        : REDACTED
      : null,
    document: d.document
      ? vis.documents.has(d.document.id)
        ? { id: d.document.id, docNumber: d.document.docNumber, title: d.document.title }
        : REDACTED_DOCUMENT
      : null,
    requirement: d.requirement
      ? { id: d.requirement.id, reqNumber: d.requirement.reqNumber, title: d.requirement.title }
      : null,
    ecn: d.ecn
      ? vis.ecns.has(d.ecn.id)
        ? { id: d.ecn.id, ecnNumber: d.ecn.ecnNumber, status: d.ecn.status }
        : REDACTED_ECN
      : null,
  };
}

/**
 * Summary from phase rows alone. `ProjectRow` is a superset of `ProjectSummaryRow`, so the
 * detail mapper reuses this rather than recomputing the same three phase aggregates.
 */
function toProjectSummary(project: ProjectSummaryRow): ProjectSummaryDto {
  const current = project.phases.find((p) => p.status !== GateStatus.PASSED) ?? null;
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    status: project.status,
    owner: { id: project.owner.id, name: project.owner.name },
    startDate: project.startDate ? project.startDate.toISOString() : null,
    targetDate: project.targetDate ? project.targetDate.toISOString() : null,
    phaseCount: project.phases.length,
    passedPhases: project.phases.filter((p) => p.status === GateStatus.PASSED).length,
    currentPhase: current
      ? { id: current.id, seq: current.seq, name: current.name, status: current.status }
      : null,
    createdAt: project.createdAt.toISOString(),
  };
}

function toProjectDetail(project: ProjectRow, vis: LinkVisibility): ProjectDetailDto {
  const phases: PhaseDto[] = project.phases.map((phase) => ({
    id: phase.id,
    seq: phase.seq,
    name: phase.name,
    gateCriteria: phase.gateCriteria,
    status: phase.status,
    targetDate: phase.targetDate ? phase.targetDate.toISOString() : null,
    passedAt: phase.passedAt ? phase.passedAt.toISOString() : null,
    passedBy: phase.passedBy ? { id: phase.passedBy.id, name: phase.passedBy.name } : null,
    deliverables: phase.deliverables.map((d) => toDeliverable(d, vis)),
    // Counted from statuses, never from the linked items, so a redacted link cannot make this
    // number lie — which is why this response needs no `redactedCount` (rule X4).
    blockingCount: phase.deliverables.filter(isBlocking).length,
  }));

  return {
    ...toProjectSummary(project),
    description: project.description,
    createdBy: { id: project.createdBy.id, name: project.createdBy.name },
    phases,
  };
}

/**
 * Every path that returns a project detail goes through here, so the read filter is applied
 * once. `findFirst` rather than `findUnique` because `findUnique` cannot take the filter — and
 * a project the caller may not read must 404 exactly as a deleted one does (rule X2).
 */
async function getProjectDetailOrThrow(id: number, user: AclUser): Promise<ProjectDetailDto> {
  const project = await prisma.project.findFirst({
    where: { id, ...aclFilter('PROJECT', user) },
    include: projectInclude,
  });
  if (!project) throw new HttpError(404, 'Project not found');
  return toProjectDetail(project, await linkVisibility(project, user));
}

/**
 * Resolve the project id owning a phase, only when the caller may read that project.
 *
 * The lookup is scoped by the project's read filter and the 404 stays the phase's own message:
 * answering 'Project not found' here would tell a caller probing phase ids that the phase
 * exists, which is exactly the disclosure the 404-not-403 rule exists to prevent.
 */
async function projectIdOfPhase(phaseId: number, user: AclUser): Promise<number> {
  const phase = await prisma.projectPhase.findFirst({
    where: { id: phaseId, project: aclFilter('PROJECT', user) },
    select: { projectId: true },
  });
  if (!phase) throw new HttpError(404, 'Phase not found');
  return phase.projectId;
}

/** Same reasoning one level down: a deliverable of an unreadable project simply does not exist. */
async function projectIdOfDeliverable(deliverableId: number, user: AclUser): Promise<number> {
  const row = await prisma.projectDeliverable.findFirst({
    where: { id: deliverableId, phase: { project: aclFilter('PROJECT', user) } },
    select: { phase: { select: { projectId: true } } },
  });
  if (!row) throw new HttpError(404, 'Deliverable not found');
  return row.phase.projectId;
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
/**
 * Link targets are read-checked through `assertCanRead`, so a restricted part, document or ECN
 * answers exactly like a missing one — linking an item to a deliverable would otherwise confirm
 * it exists. Requirements are not one of the five protected types; a plain existence check.
 */
async function assertLinksExist(
  links: {
    partId: number | null;
    documentId: number | null;
    requirementId: number | null;
    ecnId: number | null;
  },
  user: AclUser
): Promise<void> {
  if (links.partId !== null) await assertCanRead('PART', links.partId, user);
  if (links.documentId !== null) await assertCanRead('DOCUMENT', links.documentId, user);
  if (links.requirementId !== null) {
    const row = await prisma.requirement.findUnique({
      where: { id: links.requirementId },
      select: { id: true },
    });
    if (!row) throw new HttpError(404, 'Requirement not found');
  }
  if (links.ecnId !== null) await assertCanRead('ECN', links.ecnId, user);
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------

router.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    // The acl fragment nests under its own AND, so spreading it beside `status` is safe, and
    // the same `where` feeds count and page — the total never admits to hidden projects.
    const where: Prisma.ProjectWhereInput = {
      ...(aclFilter('PROJECT', user) as Prisma.ProjectWhereInput),
    };
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
        include: summaryInclude,
      }),
    ]);
    res.json({ items: rows.map(toProjectSummary), total, page, pageSize });
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

    res.status(201).json(await getProjectDetailOrThrow(created.id, aclUser(req)));
  })
);

router.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    res.json(await getProjectDetailOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

router.patch(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — 404/403 resolved before the body is even parsed.
    await assertCanWrite('PROJECT', id, user);
    const body = requireBody(req);

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
    res.json(await getProjectDetailOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /projects/:id/phases
// ---------------------------------------------------------------------------

router.post(
  '/projects/:id/phases',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanWrite('PROJECT', id, user);
    const body = requireBody(req);

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
    res.status(201).json(await getProjectDetailOrThrow(id, user));
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
    const user = aclUser(req);

    // Scoped through the project's read filter: a phase of a hidden project does not exist.
    const phase = await prisma.projectPhase.findFirst({
      where: { id, project: aclFilter('PROJECT', user) as Prisma.ProjectWhereInput },
      include: {
        deliverables: { select: { name: true, required: true, status: true } },
        project: { select: { id: true } },
      },
    });
    if (!phase) throw new HttpError(404, 'Phase not found');
    await assertCanWrite('PROJECT', phase.projectId, user);
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

    res.json(await getProjectDetailOrThrow(phase.projectId, user));
  })
);

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

router.post(
  '/project-phases/:id/deliverables',
  asyncHandler(async (req, res) => {
    const phaseId = idParam(req.params.id);
    const user = aclUser(req);
    const projectId = await projectIdOfPhase(phaseId, user);
    await assertCanWrite('PROJECT', projectId, user);
    const body = requireBody(req);

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
    await assertLinksExist(links, user);

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
    res.status(201).json(await getProjectDetailOrThrow(projectId, user));
  })
);

router.patch(
  '/deliverables/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Resolves through the project's read filter and 404s with the deliverable's own message.
    const projectId = await projectIdOfDeliverable(id, user);
    await assertCanWrite('PROJECT', projectId, user);
    const body = requireBody(req);

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
    res.json(await getProjectDetailOrThrow(projectId, user));
  })
);

router.delete(
  '/deliverables/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const projectId = await projectIdOfDeliverable(id, user);
    await assertCanWrite('PROJECT', projectId, user);
    await prisma.projectDeliverable.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
