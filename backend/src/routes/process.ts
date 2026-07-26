import { Router } from 'express';
import type { Lifecycle, Operation, OperationMaterial, Part, ProcessPlan } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, asyncHandler, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// DTO mappers (shapes must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

type MaterialWithPart = OperationMaterial & { part: Part };
type OperationWithMaterials = Operation & { materials: MaterialWithPart[] };
type PlanWithOperations = ProcessPlan & { operations: OperationWithMaterials[] };

function toPartRef(part: Part) {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toOperationMaterialDetail(material: MaterialWithPart) {
  return {
    id: material.id,
    quantity: material.quantity,
    uom: material.uom,
    notes: material.notes,
    part: toPartRef(material.part),
  };
}

function toOperationDetail(operation: OperationWithMaterials) {
  return {
    id: operation.id,
    seq: operation.seq,
    name: operation.name,
    workCenter: operation.workCenter,
    description: operation.description,
    setupMinutes: operation.setupMinutes,
    runMinutes: operation.runMinutes,
    materials: operation.materials.map(toOperationMaterialDetail),
  };
}

function toProcessPlanDetail(plan: PlanWithOperations) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    operations: plan.operations.map(toOperationDetail),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Business rule 1: mutations only while the owning revision is IN_WORK. */
function assertEditable(revision: { revision: string; lifecycle: Lifecycle }): void {
  if (revision.lifecycle !== 'IN_WORK') {
    throw new HttpError(
      409,
      `Revision ${revision.revision} is ${revision.lifecycle} and cannot be modified`
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

/** value is known to be present (not undefined); allows explicit null. */
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string or null`);
  }
  return value;
}

function optNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  return nullableString(value, field);
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, `${field} must be a number >= 0`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a number > 0`);
  }
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw new HttpError(400, `${field} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Full ProcessPlanDetail source: operations ordered by seq, materials with part refs. */
function fetchPlanDetail(partRevisionId: number) {
  return prisma.processPlan.findUnique({
    where: { partRevisionId },
    include: {
      operations: {
        orderBy: { seq: 'asc' },
        include: { materials: { orderBy: { id: 'asc' }, include: { part: true } } },
      },
    },
  });
}

async function getOperationOrThrow(id: number) {
  const operation = await prisma.operation.findUnique({
    where: { id },
    include: { plan: { include: { partRevision: true } } },
  });
  if (!operation) throw new HttpError(404, 'Operation not found');
  return operation;
}

async function getMaterialOrThrow(id: number) {
  const material = await prisma.operationMaterial.findUnique({
    where: { id },
    include: { operation: { include: { plan: { include: { partRevision: true } } } } },
  });
  if (!material) throw new HttpError(404, 'Operation material not found');
  return material;
}

// ---------------------------------------------------------------------------
// Process plan
// ---------------------------------------------------------------------------

// GET /api/revisions/:id/process-plan → ProcessPlanDetail | null
router.get(
  '/revisions/:id/process-plan',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id: revisionId },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    const plan = await fetchPlanDetail(revisionId);
    res.json(plan ? toProcessPlanDetail(plan) : null);
  })
);

// PUT /api/revisions/:id/process-plan → ProcessPlanDetail (create or update)
router.put(
  '/revisions/:id/process-plan',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({ where: { id: revisionId } });
    if (!revision) throw new HttpError(404, 'Revision not found');
    assertEditable(revision);

    const body = bodyOf(req);
    const name = body.name === undefined ? undefined : requireNonEmptyString(body.name, 'name');
    const description = optNullableString(body.description, 'description');

    const existing = await prisma.processPlan.findUnique({
      where: { partRevisionId: revisionId },
      select: { id: true },
    });
    if (existing) {
      const data: { name?: string; description?: string | null } = {};
      if (name !== undefined) data.name = name;
      if (description !== undefined) data.description = description;
      await prisma.processPlan.update({ where: { id: existing.id }, data });
    } else {
      await prisma.processPlan.create({
        data: {
          partRevisionId: revisionId,
          name: name ?? 'Manufacturing Process',
          description: description ?? null,
        },
      });
    }

    const plan = await fetchPlanDetail(revisionId);
    if (!plan) throw new HttpError(500, 'Failed to load process plan');
    res.json(toProcessPlanDetail(plan));
  })
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// POST /api/process-plans/:id/operations → 201 OperationDetail
router.post(
  '/process-plans/:id/operations',
  asyncHandler(async (req, res) => {
    const planId = idParam(req.params.id);
    const plan = await prisma.processPlan.findUnique({
      where: { id: planId },
      include: { partRevision: true },
    });
    if (!plan) throw new HttpError(404, 'Process plan not found');
    assertEditable(plan.partRevision);

    const body = bodyOf(req);
    const name = requireNonEmptyString(body.name, 'name');
    const workCenter = optNullableString(body.workCenter, 'workCenter');
    const description = optNullableString(body.description, 'description');
    const setupMinutes =
      body.setupMinutes === undefined
        ? undefined
        : nonNegativeNumber(body.setupMinutes, 'setupMinutes');
    const runMinutes =
      body.runMinutes === undefined ? undefined : nonNegativeNumber(body.runMinutes, 'runMinutes');

    let seq: number;
    if (body.seq === undefined || body.seq === null) {
      // Rule 9: auto-assign next multiple of 10 (max existing + 10, start 10).
      const agg = await prisma.operation.aggregate({ where: { planId }, _max: { seq: true } });
      seq = (agg._max.seq ?? 0) + 10;
    } else {
      seq = positiveInt(body.seq, 'seq');
      const clash = await prisma.operation.findFirst({
        where: { planId, seq },
        select: { id: true },
      });
      if (clash) throw new HttpError(409, 'Sequence number already used');
    }

    const created = await prisma.operation.create({
      data: {
        planId,
        seq,
        name,
        workCenter: workCenter ?? null,
        description: description ?? null,
        setupMinutes: setupMinutes ?? 0,
        runMinutes: runMinutes ?? 0,
      },
      include: { materials: { orderBy: { id: 'asc' }, include: { part: true } } },
    });
    res.status(201).json(toOperationDetail(created));
  })
);

// PATCH /api/operations/:id → OperationDetail
router.patch(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const operationId = idParam(req.params.id);
    const operation = await getOperationOrThrow(operationId);
    assertEditable(operation.plan.partRevision);

    const body = bodyOf(req);
    const data: {
      seq?: number;
      name?: string;
      workCenter?: string | null;
      description?: string | null;
      setupMinutes?: number;
      runMinutes?: number;
    } = {};

    if (body.name !== undefined) data.name = requireNonEmptyString(body.name, 'name');
    if (body.workCenter !== undefined) data.workCenter = nullableString(body.workCenter, 'workCenter');
    if (body.description !== undefined) {
      data.description = nullableString(body.description, 'description');
    }
    if (body.setupMinutes !== undefined) {
      data.setupMinutes = nonNegativeNumber(body.setupMinutes, 'setupMinutes');
    }
    if (body.runMinutes !== undefined) {
      data.runMinutes = nonNegativeNumber(body.runMinutes, 'runMinutes');
    }
    if (body.seq !== undefined) {
      const seq = positiveInt(body.seq, 'seq');
      if (seq !== operation.seq) {
        const clash = await prisma.operation.findFirst({
          where: { planId: operation.planId, seq, NOT: { id: operation.id } },
          select: { id: true },
        });
        if (clash) throw new HttpError(409, 'Sequence number already used');
      }
      data.seq = seq;
    }

    const updated = await prisma.operation.update({
      where: { id: operation.id },
      data,
      include: { materials: { orderBy: { id: 'asc' }, include: { part: true } } },
    });
    res.json(toOperationDetail(updated));
  })
);

// DELETE /api/operations/:id → 204
router.delete(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const operationId = idParam(req.params.id);
    const operation = await getOperationOrThrow(operationId);
    assertEditable(operation.plan.partRevision);
    await prisma.operation.delete({ where: { id: operation.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Operation materials
// ---------------------------------------------------------------------------

// POST /api/operations/:id/materials → 201 OperationMaterialDetail
router.post(
  '/operations/:id/materials',
  asyncHandler(async (req, res) => {
    const operationId = idParam(req.params.id);
    const operation = await getOperationOrThrow(operationId);
    assertEditable(operation.plan.partRevision);

    const body = bodyOf(req);
    const partId = positiveInt(body.partId, 'partId');
    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(400, 'Part not found');
    const quantity = positiveNumber(body.quantity, 'quantity');
    const uom =
      body.uom === undefined || body.uom === null
        ? undefined
        : requireNonEmptyString(body.uom, 'uom');
    const notes = optNullableString(body.notes, 'notes');

    const created = await prisma.operationMaterial.create({
      data: {
        operationId: operation.id,
        partId,
        quantity,
        uom,
        notes: notes ?? null,
      },
      include: { part: true },
    });
    res.status(201).json(toOperationMaterialDetail(created));
  })
);

// PATCH /api/operation-materials/:id → OperationMaterialDetail
router.patch(
  '/operation-materials/:id',
  asyncHandler(async (req, res) => {
    const materialId = idParam(req.params.id);
    const material = await getMaterialOrThrow(materialId);
    assertEditable(material.operation.plan.partRevision);

    const body = bodyOf(req);
    const data: { quantity?: number; uom?: string; notes?: string | null } = {};
    if (body.quantity !== undefined) data.quantity = positiveNumber(body.quantity, 'quantity');
    if (body.uom !== undefined) data.uom = requireNonEmptyString(body.uom, 'uom');
    if (body.notes !== undefined) data.notes = nullableString(body.notes, 'notes');

    const updated = await prisma.operationMaterial.update({
      where: { id: material.id },
      data,
      include: { part: true },
    });
    res.json(toOperationMaterialDetail(updated));
  })
);

// DELETE /api/operation-materials/:id → 204
router.delete(
  '/operation-materials/:id',
  asyncHandler(async (req, res) => {
    const materialId = idParam(req.params.id);
    const material = await getMaterialOrThrow(materialId);
    assertEditable(material.operation.plan.partRevision);
    await prisma.operationMaterial.delete({ where: { id: material.id } });
    res.status(204).send();
  })
);

export default router;
