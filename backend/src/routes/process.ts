import { Request, Router } from 'express';
import type { Lifecycle, Operation, OperationMaterial, Part, ProcessPlan } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, asyncHandler, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';

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

/** Rule X4 — a material line's part the caller may not read keeps its line, loses identity. */
function toOperationMaterialDetail(material: MaterialWithPart, visibleParts: ReadonlySet<number>) {
  return {
    id: material.id,
    quantity: material.quantity,
    uom: material.uom,
    notes: material.notes,
    scrapFactor: material.scrapFactor,
    consumable: material.consumable,
    part: visibleParts.has(material.part.id) ? toPartRef(material.part) : { ...REDACTED },
  };
}

function toOperationDetail(operation: OperationWithMaterials, visibleParts: ReadonlySet<number>) {
  return {
    id: operation.id,
    seq: operation.seq,
    name: operation.name,
    workCenter: operation.workCenter,
    description: operation.description,
    setupMinutes: operation.setupMinutes,
    runMinutes: operation.runMinutes,
    materials: operation.materials.map((m) => toOperationMaterialDetail(m, visibleParts)),
  };
}

async function planVisibility(plan: PlanWithOperations, user: AclUser): Promise<Set<number>> {
  return visibleIds(
    'PART',
    plan.operations.flatMap((op) => op.materials.map((m) => m.part.id)),
    user
  );
}

function toProcessPlanDetail(plan: PlanWithOperations, visibleParts: ReadonlySet<number>) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    operations: plan.operations.map((op) => toOperationDetail(op, visibleParts)),
  };
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
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

/** Scrap is a fraction of the nominal quantity: 0.02 = 2 %. 100 % loss is nonsense. */
function scrapFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new HttpError(400, 'scrapFactor must be a number >= 0 and < 1');
  }
  return value;
}

function boolField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`);
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

async function getOperationOrThrow(id: number, user: AclUser) {
  // As visible as the part whose plan it belongs to (rule X2).
  const operation = await prisma.operation.findFirst({
    where: { id, plan: { partRevision: { part: partAcl(user) } } },
    include: { plan: { include: { partRevision: true } } },
  });
  if (!operation) throw new HttpError(404, 'Operation not found');
  return operation;
}

async function getMaterialOrThrow(id: number, user: AclUser) {
  const material = await prisma.operationMaterial.findFirst({
    where: { id, operation: { plan: { partRevision: { part: partAcl(user) } } } },
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
    const user = aclUser(req);
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: partAcl(user) },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    const plan = await fetchPlanDetail(revisionId);
    res.json(plan ? toProcessPlanDetail(plan, await planVisibility(plan, user)) : null);
  })
);

// PUT /api/revisions/:id/process-plan → ProcessPlanDetail (create or update)
router.put(
  '/revisions/:id/process-plan',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: partAcl(user) },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    await assertCanWrite('PART', revision.partId, user);
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
    res.json(toProcessPlanDetail(plan, await planVisibility(plan, user)));
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
    const user = aclUser(req);
    const plan = await prisma.processPlan.findFirst({
      where: { id: planId, partRevision: { part: partAcl(user) } },
      include: { partRevision: true },
    });
    if (!plan) throw new HttpError(404, 'Process plan not found');
    await assertCanWrite('PART', plan.partRevision.partId, user);
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
    res.status(201).json(toOperationDetail(created, new Set()));
  })
);

// PATCH /api/operations/:id → OperationDetail
router.patch(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const operationId = idParam(req.params.id);
    const user = aclUser(req);
    const operation = await getOperationOrThrow(operationId, user);
    await assertCanWrite('PART', operation.plan.partRevision.partId, user);
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
    res.json(
      toOperationDetail(
        updated,
        await visibleIds('PART', updated.materials.map((m) => m.part.id), user)
      )
    );
  })
);

// DELETE /api/operations/:id → 204
router.delete(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const operationId = idParam(req.params.id);
    const user = aclUser(req);
    const operation = await getOperationOrThrow(operationId, user);
    await assertCanWrite('PART', operation.plan.partRevision.partId, user);
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
    const user = aclUser(req);
    const operation = await getOperationOrThrow(operationId, user);
    await assertCanWrite('PART', operation.plan.partRevision.partId, user);
    assertEditable(operation.plan.partRevision);

    const body = bodyOf(req);
    const partId = positiveInt(body.partId, 'partId');
    // A restricted part answers like a missing one (rule X2).
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(400, 'Part not found');
    const quantity = positiveNumber(body.quantity, 'quantity');
    const uom =
      body.uom === undefined || body.uom === null
        ? undefined
        : requireNonEmptyString(body.uom, 'uom');
    const notes = optNullableString(body.notes, 'notes');
    const scrapFactor =
      body.scrapFactor === undefined ? undefined : scrapFraction(body.scrapFactor);
    const consumable = body.consumable === undefined ? undefined : boolField(body.consumable, 'consumable');

    const created = await prisma.operationMaterial.create({
      data: {
        operationId: operation.id,
        partId,
        quantity,
        uom,
        notes: notes ?? null,
        ...(scrapFactor !== undefined ? { scrapFactor } : {}),
        ...(consumable !== undefined ? { consumable } : {}),
      },
      include: { part: true },
    });
    res.status(201).json(toOperationMaterialDetail(created, new Set([created.part.id])));
  })
);

// PATCH /api/operation-materials/:id → OperationMaterialDetail
router.patch(
  '/operation-materials/:id',
  asyncHandler(async (req, res) => {
    const materialId = idParam(req.params.id);
    const user = aclUser(req);
    const material = await getMaterialOrThrow(materialId, user);
    await assertCanWrite('PART', material.operation.plan.partRevision.partId, user);
    assertEditable(material.operation.plan.partRevision);

    const body = bodyOf(req);
    const data: {
      quantity?: number;
      uom?: string;
      notes?: string | null;
      scrapFactor?: number;
      consumable?: boolean;
    } = {};
    if (body.quantity !== undefined) data.quantity = positiveNumber(body.quantity, 'quantity');
    if (body.uom !== undefined) data.uom = requireNonEmptyString(body.uom, 'uom');
    if (body.notes !== undefined) data.notes = nullableString(body.notes, 'notes');
    if (body.scrapFactor !== undefined) data.scrapFactor = scrapFraction(body.scrapFactor);
    if (body.consumable !== undefined) data.consumable = boolField(body.consumable, 'consumable');

    const updated = await prisma.operationMaterial.update({
      where: { id: material.id },
      data,
      include: { part: true },
    });
    res.json(
      toOperationMaterialDetail(updated, await visibleIds('PART', [updated.part.id], user))
    );
  })
);

// DELETE /api/operation-materials/:id → 204
router.delete(
  '/operation-materials/:id',
  asyncHandler(async (req, res) => {
    const materialId = idParam(req.params.id);
    const user = aclUser(req);
    const material = await getMaterialOrThrow(materialId, user);
    await assertCanWrite('PART', material.operation.plan.partRevision.partId, user);
    assertEditable(material.operation.plan.partRevision);
    await prisma.operationMaterial.delete({ where: { id: material.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// mBOM generation and eBOM ↔ mBOM reconciliation (rules C4, C5)
// ---------------------------------------------------------------------------

// POST /api/revisions/:id/process-plan/from-bom → ProcessPlanDetail
router.post(
  '/revisions/:id/process-plan/from-bom',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: partAcl(user) },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    await assertCanWrite('PART', revision.partId, user);
    assertEditable(revision);

    const bomLines = await prisma.bomLine.findMany({
      where: { parentRevisionId: revisionId },
      orderBy: { findNumber: 'asc' },
      select: { childPartId: true, quantity: true, uom: true },
    });
    if (bomLines.length === 0) {
      throw new HttpError(409, 'Add eBOM lines before generating a manufacturing plan');
    }

    const plan =
      (await prisma.processPlan.findUnique({
        where: { partRevisionId: revisionId },
        select: { id: true },
      })) ??
      (await prisma.processPlan.create({
        data: { partRevisionId: revisionId, name: 'Manufacturing Process' },
        select: { id: true },
      }));

    // Anything already consumed anywhere in the plan is left alone, so pressing the
    // button twice is harmless rather than duplicating every material.
    const consumed = await prisma.operationMaterial.findMany({
      where: { operation: { planId: plan.id } },
      select: { partId: true },
    });
    const consumedParts = new Set(consumed.map((m) => m.partId));
    const missing = bomLines.filter((line) => !consumedParts.has(line.childPartId));
    if (missing.length === 0) {
      throw new HttpError(409, 'Every eBOM line is already consumed by an operation');
    }

    const seqAgg = await prisma.operation.aggregate({
      where: { planId: plan.id },
      _max: { seq: true },
    });
    await prisma.operation.create({
      data: {
        planId: plan.id,
        seq: (seqAgg._max.seq ?? 0) + 1,
        name: 'Assembly',
        description: `Generated from the eBOM of revision ${revision.revision}`,
        materials: {
          create: missing.map((line) => ({
            partId: line.childPartId,
            quantity: line.quantity,
            uom: line.uom,
          })),
        },
      },
    });

    const detail = await fetchPlanDetail(revisionId);
    if (!detail) throw new HttpError(500, 'Failed to load process plan');
    res.status(201).json(toProcessPlanDetail(detail, await planVisibility(detail, user)));
  })
);

type ReconStatus =
  | 'MATCH'
  | 'QTY_MISMATCH'
  | 'MISSING_IN_MBOM'
  | 'EXTRA_IN_MBOM'
  | 'CONSUMABLE_ONLY';

/** Defects first — the point of the view is what needs fixing. */
const RECON_ORDER: Record<ReconStatus, number> = {
  QTY_MISMATCH: 0,
  MISSING_IN_MBOM: 1,
  EXTRA_IN_MBOM: 2,
  CONSUMABLE_ONLY: 3,
  MATCH: 4,
};

/** Float sums need rounding before comparison or 3 × 0.1 reads as a mismatch. */
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

// GET /api/revisions/:id/bom-reconciliation → BomReconciliation
router.get(
  '/revisions/:id/bom-reconciliation',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: partAcl(user) },
      select: { id: true, revision: true, lifecycle: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');

    const [bomLines, plan] = await Promise.all([
      prisma.bomLine.findMany({
        where: { parentRevisionId: revisionId },
        select: { quantity: true, childPart: true },
      }),
      prisma.processPlan.findUnique({
        where: { partRevisionId: revisionId },
        include: {
          operations: {
            orderBy: { seq: 'asc' },
            include: { materials: { include: { part: true } } },
          },
        },
      }),
    ]);

    interface Row {
      part: ReturnType<typeof toPartRef>;
      ebomQuantity: number | null;
      /** Σ quantity — what the status compares against the eBOM. */
      mbomNominalQuantity: number | null;
      /** Σ quantity × (1 + scrap) — what the floor actually draws. */
      mbomQuantity: number | null;
      consumedBy: {
        operationId: number;
        seq: number;
        name: string;
        quantity: number;
        scrapFactor: number;
        consumable: boolean;
      }[];
    }
    const rows = new Map<number, Row>();

    for (const line of bomLines) {
      rows.set(line.childPart.id, {
        part: toPartRef(line.childPart),
        ebomQuantity: line.quantity,
        mbomNominalQuantity: null,
        mbomQuantity: null,
        consumedBy: [],
      });
    }

    for (const operation of plan?.operations ?? []) {
      for (const material of operation.materials) {
        const row =
          rows.get(material.partId) ??
          (() => {
            const fresh: Row = {
              part: toPartRef(material.part),
              ebomQuantity: null,
              mbomNominalQuantity: null,
              mbomQuantity: null,
              consumedBy: [],
            };
            rows.set(material.partId, fresh);
            return fresh;
          })();
        row.mbomNominalQuantity = round6((row.mbomNominalQuantity ?? 0) + material.quantity);
        // Scrap is what the floor actually draws, reported alongside rather than compared.
        row.mbomQuantity = round6(
          (row.mbomQuantity ?? 0) + material.quantity * (1 + material.scrapFactor)
        );
        row.consumedBy.push({
          operationId: operation.id,
          seq: operation.seq,
          name: operation.name,
          quantity: material.quantity,
          scrapFactor: material.scrapFactor,
          consumable: material.consumable,
        });
      }
    }

    const classify = (row: Row): ReconStatus => {
      if (row.ebomQuantity === null) {
        // Consumables are meant to be absent from the eBOM, so they are not a defect.
        return row.consumedBy.every((c) => c.consumable) ? 'CONSUMABLE_ONLY' : 'EXTRA_IN_MBOM';
      }
      if (row.mbomNominalQuantity === null) return 'MISSING_IN_MBOM';
      // Compared against the nominal figure: an expected scrap allowance is not a defect.
      return Math.abs(row.ebomQuantity - row.mbomNominalQuantity) > 1e-6
        ? 'QTY_MISMATCH'
        : 'MATCH';
    };

    // Rule X4 — redaction at the boundary only: rows stay keyed by real part ids above.
    const visibleParts = await visibleIds('PART', [...rows.keys()], user);
    const result = [...rows.values()]
      .map((row) => ({
        part: visibleParts.has(row.part.id) ? row.part : { ...REDACTED },
        status: classify(row),
        ebomQuantity: row.ebomQuantity,
        mbomNominalQuantity: row.mbomNominalQuantity,
        mbomQuantity: row.mbomQuantity,
        consumedBy: row.consumedBy.sort((a, b) => a.seq - b.seq),
        consumable: row.consumedBy.length > 0 && row.consumedBy.every((c) => c.consumable),
      }))
      .sort((a, b) => {
        const order = RECON_ORDER[a.status] - RECON_ORDER[b.status];
        return order !== 0 ? order : a.part.partNumber.localeCompare(b.part.partNumber);
      });

    res.json({
      revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
      hasPlan: plan !== null,
      rows: result,
      counts: {
        match: result.filter((r) => r.status === 'MATCH').length,
        qtyMismatch: result.filter((r) => r.status === 'QTY_MISMATCH').length,
        missingInMbom: result.filter((r) => r.status === 'MISSING_IN_MBOM').length,
        extraInMbom: result.filter((r) => r.status === 'EXTRA_IN_MBOM').length,
        consumableOnly: result.filter((r) => r.status === 'CONSUMABLE_ONLY').length,
      },
    });
  })
);

export default router;
