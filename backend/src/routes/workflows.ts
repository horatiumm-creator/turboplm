import { Request, Router } from 'express';
import {
  EcnStatus,
  Prisma,
  Role,
  TaskDecision,
  WorkflowRule,
  WorkflowStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter } from '../lib/acl';
import { requireAdmin } from '../middleware/rbac';
import { notifyUsers } from '../lib/notify';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface WorkflowStepDefDto {
  id: number;
  seq: number;
  name: string;
  rule: WorkflowRule;
  role: Role | null;
  assignees: UserRefDto[];
}

interface WorkflowTemplateDto {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  instanceCount: number;
  steps: WorkflowStepDefDto[];
}

interface WorkflowTaskDto {
  id: number;
  seq: number;
  stepName: string;
  rule: WorkflowRule;
  user: UserRefDto;
  decision: TaskDecision;
  comment: string | null;
  decidedAt: string | null;
}

interface EcnWorkflowDto {
  id: number;
  templateName: string;
  status: WorkflowStatus;
  currentSeq: number;
  createdAt: string;
  completedAt: string | null;
  tasks: WorkflowTaskDto[];
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const stepDefInclude = {
  assignees: {
    orderBy: { id: 'asc' as const },
    include: { user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.WorkflowStepDefInclude;

const templateInclude = {
  steps: { orderBy: { seq: 'asc' as const }, include: stepDefInclude },
  _count: { select: { instances: true } },
} satisfies Prisma.WorkflowTemplateInclude;

const workflowInclude = {
  tasks: {
    orderBy: [{ seq: 'asc' as const }, { id: 'asc' as const }],
    include: { user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.EcnWorkflowInclude;

type TemplateRow = Prisma.WorkflowTemplateGetPayload<{ include: typeof templateInclude }>;
type WorkflowRow = Prisma.EcnWorkflowGetPayload<{ include: typeof workflowInclude }>;

function toTemplateDetail(template: TemplateRow): WorkflowTemplateDto {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    active: template.active,
    instanceCount: template._count.instances,
    steps: template.steps.map((step) => ({
      id: step.id,
      seq: step.seq,
      name: step.name,
      rule: step.rule,
      role: step.role,
      assignees: step.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    })),
  };
}

function toWorkflowDetail(workflow: WorkflowRow): EcnWorkflowDto {
  return {
    id: workflow.id,
    templateName: workflow.templateName,
    status: workflow.status,
    currentSeq: workflow.currentSeq,
    createdAt: workflow.createdAt.toISOString(),
    completedAt: workflow.completedAt ? workflow.completedAt.toISOString() : null,
    tasks: workflow.tasks.map((task) => ({
      id: task.id,
      seq: task.seq,
      stepName: task.stepName,
      rule: task.rule,
      user: { id: task.user.id, name: task.user.name },
      decision: task.decision,
      comment: task.comment,
      decidedAt: task.decidedAt ? task.decidedAt.toISOString() : null,
    })),
  };
}

async function getTemplateDetailOrThrow(id: number): Promise<WorkflowTemplateDto> {
  const template = await prisma.workflowTemplate.findUnique({
    where: { id },
    include: templateInclude,
  });
  if (!template) throw new HttpError(404, 'Workflow template not found');
  return toTemplateDetail(template);
}

async function getWorkflowDetailOrThrow(id: number): Promise<EcnWorkflowDto> {
  const workflow = await prisma.ecnWorkflow.findUnique({ where: { id }, include: workflowInclude });
  if (!workflow) throw new HttpError(404, 'Workflow not found');
  return toWorkflowDetail(workflow);
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

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Rule W1 — template/step names 1..100 characters. */
function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 100) throw new HttpError(400, `${label} must be at most 100 characters`);
  return trimmed;
}

function parseActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'active must be a boolean');
  return value;
}

interface StepInput {
  name: string;
  rule: WorkflowRule;
  role: Role | null;
  userIds: number[];
}

/** Rule W1 — steps array ≥1; each step needs a role and/or explicit users. */
function parseSteps(value: unknown): StepInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'steps must be a non-empty array');
  }
  return value.map((raw, index) => {
    const label = `steps[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, `${label} must be an object`);
    }
    const step = raw as Record<string, unknown>;
    const name = requireName(step.name, `${label}.name`);

    const rule = step.rule;
    if (typeof rule !== 'string' || !(Object.values(WorkflowRule) as string[]).includes(rule)) {
      throw new HttpError(400, `${label}.rule must be ANY or ALL`);
    }

    let role: Role | null = null;
    if (step.role !== undefined && step.role !== null) {
      if (
        typeof step.role !== 'string' ||
        !(Object.values(Role) as string[]).includes(step.role)
      ) {
        throw new HttpError(400, `${label}.role must be one of ADMIN, ENGINEER, VIEWER`);
      }
      role = step.role as Role;
    }

    let userIds: number[] = [];
    if (step.userIds !== undefined && step.userIds !== null) {
      if (!Array.isArray(step.userIds)) {
        throw new HttpError(400, `${label}.userIds must be an array of user ids`);
      }
      userIds = [
        ...new Set(
          step.userIds.map((id) => {
            const n = Number(id);
            if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
              throw new HttpError(400, `${label}.userIds must contain positive integers`);
            }
            return n;
          })
        ),
      ];
    }

    if (role === null && userIds.length === 0) {
      throw new HttpError(400, `${label} needs a role or at least one assigned user`);
    }
    return { name, rule: rule as WorkflowRule, role, userIds };
  });
}

async function assertStepUsersExist(steps: StepInput[]): Promise<void> {
  // Viewers are read-only and cannot decide a task, so an ALL-rule step holding
  // one would deadlock the workflow — reject such assignments up front.
  if (steps.some((step) => step.role === Role.VIEWER)) {
    throw new HttpError(400, 'Viewers cannot approve — a step role must be ENGINEER or ADMIN');
  }
  const ids = [...new Set(steps.flatMap((step) => step.userIds))];
  if (ids.length === 0) return;
  const found = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, role: true },
  });
  if (found.length !== ids.length) {
    const known = new Set(found.map((u) => u.id));
    const missing = ids.filter((id) => !known.has(id));
    throw new HttpError(400, `Unknown user id(s) in steps: ${missing.join(', ')}`);
  }
  const viewers = found.filter((u) => u.role === Role.VIEWER);
  if (viewers.length > 0) {
    throw new HttpError(
      400,
      `Viewers cannot approve — remove: ${viewers.map((u) => u.name).join(', ')}`
    );
  }
}

async function assertTemplateNameFree(name: string, excludeId?: number): Promise<void> {
  const clash = await prisma.workflowTemplate.findFirst({
    where: { name, ...(excludeId !== undefined ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, `A workflow template named "${name}" already exists`);
}

/** Recreate a template's step definitions wholesale (rule W1). */
async function replaceSteps(
  tx: Prisma.TransactionClient,
  templateId: number,
  steps: StepInput[]
): Promise<void> {
  await tx.workflowStepDef.deleteMany({ where: { templateId } });
  for (const [index, step] of steps.entries()) {
    await tx.workflowStepDef.create({
      data: {
        templateId,
        seq: index + 1,
        name: step.name,
        rule: step.rule,
        role: step.role,
        assignees: { create: step.userIds.map((userId) => ({ userId })) },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// instantiateWorkflow — shared with POST /ecns/:id/transition submit (rule W2).
// Runs inside the caller's transaction: loads + validates the template, creates
// the EcnWorkflow + ALL tasks upfront, and notifies step-1 users.
// ---------------------------------------------------------------------------

export async function instantiateWorkflow(
  tx: Prisma.TransactionClient,
  ecn: { id: number; ecnNumber: string; createdById: number },
  templateId: number,
  actorId: number
): Promise<void> {
  const template = await tx.workflowTemplate.findUnique({
    where: { id: templateId },
    include: {
      steps: { orderBy: { seq: 'asc' }, include: { assignees: { select: { userId: true } } } },
    },
  });
  if (!template) throw new HttpError(404, 'Workflow template not found');
  if (!template.active) {
    throw new HttpError(409, `Workflow template "${template.name}" is not active`);
  }
  if (template.steps.length === 0) {
    throw new HttpError(409, `Workflow template "${template.name}" has no steps`);
  }

  // Resolve each step's users at instantiation: explicit assignees ∪ users
  // holding the step's role, deduped (rule W2).
  const roles = [...new Set(template.steps.flatMap((s) => (s.role === null ? [] : [s.role])))];
  const roleUsers =
    roles.length === 0
      ? []
      : await tx.user.findMany({ where: { role: { in: roles } }, select: { id: true, role: true } });

  const resolvedSteps = template.steps.map((step) => {
    const userIds = new Set(step.assignees.map((a) => a.userId));
    if (step.role !== null) {
      for (const user of roleUsers) if (user.role === step.role) userIds.add(user.id);
    }
    if (userIds.size === 0) {
      throw new HttpError(409, `Workflow step "${step.name}" resolves to no users`);
    }
    return { step, userIds: [...userIds] };
  });

  // Safety net for users demoted to VIEWER after the template was saved: they
  // could never decide their task, deadlocking an ALL step. Surface it here, at
  // submit time, instead of mid-flow.
  const resolvedUsers = await tx.user.findMany({
    where: { id: { in: [...new Set(resolvedSteps.flatMap((s) => s.userIds))] } },
    select: { id: true, name: true, role: true },
  });
  const viewerNames = resolvedUsers.filter((u) => u.role === Role.VIEWER).map((u) => u.name);
  if (viewerNames.length > 0) {
    throw new HttpError(
      409,
      `Workflow template "${template.name}" assigns read-only users (${viewerNames.join(', ')}) who cannot approve — update the template first`
    );
  }

  // A rejected/cancelled workflow from an earlier review cycle is superseded on
  // resubmit (EcnWorkflow.ecnId is unique — one instance per ECN).
  const existing = await tx.ecnWorkflow.findUnique({
    where: { ecnId: ecn.id },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status === WorkflowStatus.RUNNING) {
      throw new HttpError(409, `ECN ${ecn.ecnNumber} already has a running workflow`);
    }
    await tx.ecnWorkflow.delete({ where: { id: existing.id } });
  }

  const workflow = await tx.ecnWorkflow.create({
    data: { ecnId: ecn.id, templateId: template.id, templateName: template.name },
    select: { id: true },
  });
  await tx.workflowTask.createMany({
    data: resolvedSteps.flatMap(({ step, userIds }) =>
      userIds.map((userId) => ({
        workflowId: workflow.id,
        seq: step.seq,
        stepName: step.name,
        rule: step.rule,
        userId,
      }))
    ),
  });

  const first = resolvedSteps[0];
  await notifyUsers(tx, first.userIds, actorId, {
    type: 'TASK_ASSIGNED',
    title: `You were assigned workflow step "${first.step.name}" on ${ecn.ecnNumber}`,
    link: `/ecns/${ecn.id}`,
  });
}

// ---------------------------------------------------------------------------
// GET /workflow-templates — any authenticated user (rule W1)
// ---------------------------------------------------------------------------

router.get(
  '/workflow-templates',
  asyncHandler(async (_req, res) => {
    const templates = await prisma.workflowTemplate.findMany({
      orderBy: { name: 'asc' },
      include: templateInclude,
    });
    res.json(templates.map(toTemplateDetail));
  })
);

// ---------------------------------------------------------------------------
// POST /workflow-templates — create (admin, rule W1)
// ---------------------------------------------------------------------------

router.post(
  '/workflow-templates',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = requireBody(req);

    const name = requireName(body.name, 'name');
    const description =
      body.description === undefined ? null : optionalNullableText(body.description, 'description');
    const active = body.active === undefined ? true : parseActive(body.active);
    const steps = parseSteps(body.steps);
    await assertStepUsersExist(steps);
    await assertTemplateNameFree(name);

    const created = await prisma.$transaction(async (tx) => {
      const template = await tx.workflowTemplate.create({
        data: { name, description, active },
        select: { id: true },
      });
      await replaceSteps(tx, template.id, steps);
      return template;
    });
    res.status(201).json(await getTemplateDetailOrThrow(created.id));
  })
);

// ---------------------------------------------------------------------------
// PATCH /workflow-templates/:id — update; steps replaced wholesale (rule W1)
// ---------------------------------------------------------------------------

router.patch(
  '/workflow-templates/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const template = await prisma.workflowTemplate.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!template) throw new HttpError(404, 'Workflow template not found');

    const data: Prisma.WorkflowTemplateUpdateInput = {};
    if (body.name !== undefined) {
      const name = requireName(body.name, 'name');
      await assertTemplateNameFree(name, id);
      data.name = name;
    }
    if (body.description !== undefined)
      data.description = optionalNullableText(body.description, 'description');
    if (body.active !== undefined) data.active = parseActive(body.active);

    const steps = body.steps === undefined ? null : parseSteps(body.steps);
    if (steps) await assertStepUsersExist(steps);

    await prisma.$transaction(async (tx) => {
      if (steps) {
        // Rule W1 — steps are frozen while any instance is mid-flight. Clients
        // that always resend the (unchanged) steps alongside a rename must not
        // be punished for it, so compare first and skip identical payloads.
        const current = await tx.workflowStepDef.findMany({
          where: { templateId: id },
          orderBy: { seq: 'asc' },
          include: { assignees: { select: { userId: true } } },
        });
        // Steps are positional (seq = index + 1), so compare in order.
        const normalize = (
          rows: { name: string; rule: WorkflowRule; role: Role | null; userIds: number[] }[]
        ) =>
          JSON.stringify(
            rows.map((r) => ({
              name: r.name,
              rule: r.rule,
              role: r.role,
              userIds: [...r.userIds].sort((a, b) => a - b),
            }))
          );
        const unchanged =
          normalize(
            current.map((s) => ({
              name: s.name,
              rule: s.rule,
              role: s.role,
              userIds: s.assignees.map((a) => a.userId),
            }))
          ) === normalize(steps);

        if (!unchanged) {
          const running = await tx.ecnWorkflow.count({
            where: { templateId: id, status: WorkflowStatus.RUNNING },
          });
          if (running > 0) {
            throw new HttpError(
              409,
              `Template "${template.name}" has running workflow instances — steps cannot be changed`
            );
          }
          await replaceSteps(tx, id, steps);
        }
      }
      await tx.workflowTemplate.update({ where: { id }, data });
    });
    res.json(await getTemplateDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// DELETE /workflow-templates/:id — only with zero instances (rule W1)
// ---------------------------------------------------------------------------

router.delete(
  '/workflow-templates/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);

    const template = await prisma.workflowTemplate.findUnique({
      where: { id },
      include: { _count: { select: { instances: true } } },
    });
    if (!template) throw new HttpError(404, 'Workflow template not found');
    if (template._count.instances > 0) {
      throw new HttpError(
        409,
        `Template "${template.name}" has workflow instances — deactivate it instead`
      );
    }
    await prisma.workflowTemplate.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// GET /ecns/:id/workflow — instance for an ECN, or JSON null (rule W5)
// ---------------------------------------------------------------------------

router.get(
  '/ecns/:id/workflow',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // Scoped by the ECN's read filter: a workflow on a restricted ECN answers exactly like a
    // workflow on a missing one (rule X2).
    const user = aclUser(req);
    const ecn = await prisma.ecn.findFirst({
      where: { id, ...(aclFilter('ECN', user) as Prisma.EcnWhereInput) },
      select: { id: true },
    });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    const workflow = await prisma.ecnWorkflow.findUnique({
      where: { ecnId: id },
      include: workflowInclude,
    });
    if (!workflow) {
      res.json(null);
      return;
    }
    res.json(toWorkflowDetail(workflow));
  })
);

// ---------------------------------------------------------------------------
// POST /workflow-tasks/:id/decision — the step engine (rule W3)
// ---------------------------------------------------------------------------

router.post(
  '/workflow-tasks/:id/decision',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const actorId = currentUserId(req);

    const decisionRaw = body.decision;
    if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
      throw new HttpError(400, "decision must be 'approve' or 'reject'");
    }
    const comment =
      body.comment === undefined ? undefined : optionalNullableText(body.comment, 'comment');

    // Scoped through the ECN: an assigned approver who cannot read the (restricted) change
    // can no longer decide it — deciding what one cannot read is worse than stalling.
    const task = await prisma.workflowTask.findFirst({
      where: { id, workflow: { ecn: aclFilter('ECN', aclUser(req)) as Prisma.EcnWhereInput } },
      include: {
        workflow: {
          include: {
            ecn: {
              select: { id: true, ecnNumber: true, title: true, status: true, createdById: true },
            },
            tasks: { select: { userId: true, seq: true, stepName: true } },
          },
        },
      },
    });
    if (!task) throw new HttpError(404, 'Workflow task not found');
    const workflow = task.workflow;
    const ecn = workflow.ecn;

    if (task.userId !== actorId) {
      throw new HttpError(403, 'Only the assigned user can decide this task');
    }
    if (task.decision !== TaskDecision.PENDING) {
      throw new HttpError(409, `This task is already ${task.decision}`);
    }
    if (workflow.status !== WorkflowStatus.RUNNING) {
      throw new HttpError(
        409,
        `Workflow is ${workflow.status} — decisions are made while it is RUNNING`
      );
    }
    if (task.seq !== workflow.currentSeq) {
      throw new HttpError(
        409,
        `This task is for step ${task.seq}; the workflow is on step ${workflow.currentSeq}`
      );
    }
    if (ecn.status !== EcnStatus.IN_REVIEW) {
      throw new HttpError(
        409,
        `ECN ${ecn.ecnNumber} is ${ecn.status} — decisions are made while it is IN_REVIEW`
      );
    }

    const allTaskUserIds = workflow.tasks.map((t) => t.userId);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // Serialize decisions per workflow so two concurrent sibling approvals on
      // an ALL step cannot both see the other's task as still PENDING.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-workflow'), ${workflow.id}::int)::text`;

      // Re-assert the pre-transaction reads now that the lock is held: a
      // concurrent rejection may have terminated the workflow or moved the step
      // on, and even a non-completing approval must not land on it.
      const fresh = await tx.ecnWorkflow.findUnique({
        where: { id: workflow.id },
        select: { status: true, currentSeq: true },
      });
      if (!fresh || fresh.status !== WorkflowStatus.RUNNING || fresh.currentSeq !== task.seq) {
        throw new HttpError(409, 'The workflow was changed concurrently — reload and try again');
      }

      const marked = await tx.workflowTask.updateMany({
        where: { id: task.id, decision: TaskDecision.PENDING },
        data: {
          decision: decisionRaw === 'approve' ? TaskDecision.APPROVED : TaskDecision.REJECTED,
          decidedAt: now,
          ...(comment !== undefined ? { comment } : {}),
        },
      });
      if (marked.count === 0) {
        throw new HttpError(409, 'This task was decided concurrently — reload and try again');
      }

      const conditionalWorkflowUpdate = async (
        where: Prisma.EcnWorkflowWhereInput,
        data: Prisma.EcnWorkflowUncheckedUpdateManyInput
      ) => {
        const result = await tx.ecnWorkflow.updateMany({
          where: { id: workflow.id, status: WorkflowStatus.RUNNING, ...where },
          data,
        });
        if (result.count === 0) {
          throw new HttpError(409, 'The workflow was changed concurrently — reload and try again');
        }
      };
      const conditionalEcnUpdate = async (data: Prisma.EcnUncheckedUpdateManyInput) => {
        const result = await tx.ecn.updateMany({
          where: { id: ecn.id, status: EcnStatus.IN_REVIEW },
          data,
        });
        if (result.count === 0) {
          throw new HttpError(
            409,
            `ECN ${ecn.ecnNumber} was changed concurrently — reload and try again`
          );
        }
      };

      if (decisionRaw === 'reject') {
        // Any rejection ends the workflow and sends the ECN back to DRAFT.
        await conditionalWorkflowUpdate({}, { status: WorkflowStatus.REJECTED, completedAt: now });
        await conditionalEcnUpdate({ status: EcnStatus.DRAFT });
        await notifyUsers(tx, [ecn.createdById, ...allTaskUserIds], actorId, {
          type: 'ECN_REJECTED',
          title: `${ecn.ecnNumber} was rejected`,
          body: ecn.title,
          link: `/ecns/${ecn.id}`,
        });
        return;
      }

      // Approve — does this complete the current step?
      let stepComplete: boolean;
      if (task.rule === WorkflowRule.ANY) {
        await tx.workflowTask.updateMany({
          where: { workflowId: workflow.id, seq: task.seq, decision: TaskDecision.PENDING },
          data: { decision: TaskDecision.SKIPPED },
        });
        stepComplete = true;
      } else {
        const pendingLeft = await tx.workflowTask.count({
          where: { workflowId: workflow.id, seq: task.seq, decision: TaskDecision.PENDING },
        });
        stepComplete = pendingLeft === 0;
      }
      if (!stepComplete) return;

      const lastSeq = Math.max(...workflow.tasks.map((t) => t.seq));
      if (task.seq >= lastSeq) {
        // Final step — workflow completed, ECN approved. Rule E5 still applies:
        // APPROVED must mean releasable, so every item needs a working revision
        // (otherwise the ECN would strand — release 409s and start-change is
        // blocked outside DRAFT/IN_REVIEW).
        const missing = await tx.ecnItem.findMany({
          where: { ecnId: ecn.id, toRevisionId: null },
          include: { part: { select: { partNumber: true } } },
        });
        if (missing.length > 0) {
          const names = missing
            .map((item) => item.part.partNumber)
            .sort()
            .join(', ');
          throw new HttpError(
            409,
            `Cannot approve: no working revision for: ${names} — the change owner must start the change before final approval`
          );
        }
        await conditionalWorkflowUpdate(
          { currentSeq: task.seq },
          { status: WorkflowStatus.COMPLETED, completedAt: now }
        );
        await conditionalEcnUpdate({
          status: EcnStatus.APPROVED,
          approvedById: actorId,
          approvedAt: now,
        });
        await notifyUsers(tx, [ecn.createdById, ...allTaskUserIds], actorId, {
          type: 'ECN_APPROVED',
          title: `${ecn.ecnNumber} was approved`,
          body: ecn.title,
          link: `/ecns/${ecn.id}`,
        });
      } else {
        // Advance to the next step and tell its users.
        const nextSeq = task.seq + 1;
        await conditionalWorkflowUpdate({ currentSeq: task.seq }, { currentSeq: nextSeq });
        const nextTasks = workflow.tasks.filter((t) => t.seq === nextSeq);
        await notifyUsers(
          tx,
          nextTasks.map((t) => t.userId),
          actorId,
          {
            type: 'TASK_ASSIGNED',
            title: `You were assigned workflow step "${nextTasks[0]?.stepName ?? ''}" on ${ecn.ecnNumber}`,
            body: ecn.title,
            link: `/ecns/${ecn.id}`,
          }
        );
      }
    });

    res.json(await getWorkflowDetailOrThrow(workflow.id));
  })
);

export default router;
