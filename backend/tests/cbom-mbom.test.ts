/**
 * The three BOMs — rules C1–C5.
 *
 * cBOM (what CAD modelled) → eBOM (what engineering released) → mBOM (what the floor
 * consumes). The reconciliations between them are where a real discrepancy shows up, so
 * the statuses and the scrap/consumable exceptions are the substance of this file.
 *
 * The CAD sidecar is never contacted: extraction is stubbed at the fetch boundary and the
 * resulting cBOM lives in the database, exactly as it does in production.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversionStatus, Lifecycle } from '@prisma/client';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import {
  addBomLine,
  addOperation,
  addOperationMaterial,
  createDocumentVersion,
  createPart,
  createProcessPlan,
  createReleasedPart,
  seedCadStructure,
  setLifecycle,
} from './helpers/factories';
import { stubCadKernelUnreachable, stubCadKernelWithTree } from './helpers/cad';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin();
});

function part(options: Partial<Parameters<typeof createPart>[0]> = {}) {
  return createPart({ createdById: engineer.id, ...options });
}

interface ProposalLine {
  change: string;
  cadName: string | null;
  part: { partNumber: string } | null;
  cadQuantity: number | null;
  bomQuantity: number | null;
  matchedBy: string | null;
}

const byChange = (lines: ProposalLine[], change: string) =>
  lines.filter((l) => l.change === change);

describe('rule C2 — reading a persisted cBOM', () => {
  it('extracts through the kernel once, then serves the stored snapshot', async () => {
    const assembly = await part({ partNumber: 'CAD-EXTRACT' });
    const child = await part({ partNumber: 'CAD-EXTRACT-C' });
    const doc = await createDocumentVersion({
      createdById: engineer.id,
      partId: assembly.id,
      fileName: 'top.step',
    });
    const stub = stubCadKernelWithTree({
      name: 'CAD-EXTRACT',
      children: [{ name: 'CAD-EXTRACT-C', instances: 3 }],
    });

    const first = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(first.status).toBe(200);
    expect(first.body.assemblyStatus).toBe('DONE');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toContain('/assembly');

    // Persisted, so a second read never re-runs the kernel.
    const structure = await prisma.cadStructure.findUnique({
      where: { documentVersionId: doc.versionId },
      include: { nodes: true },
    });
    expect(structure?.status).toBe(ConversionStatus.DONE);
    expect(structure?.nodes).toHaveLength(2);

    const second = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(second.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
    expect(second.body.rows[0].part.partNumber).toBe(child.partNumber);
  });

  it('reports an unreachable sidecar as a failed read, never a 500', async () => {
    const assembly = await part({ partNumber: 'CAD-DOWN' });
    await createDocumentVersion({
      createdById: engineer.id,
      partId: assembly.id,
      fileName: 'top.step',
    });
    stubCadKernelUnreachable();

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.assemblyStatus).toBe('FAILED');
    expect(res.body.rows).toEqual([]);
  });

  it('409s when the part has no CAD model linked at all', async () => {
    const assembly = await part({ partNumber: 'CAD-NONE' });
    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('No CAD model is linked to this part');
  });
});

describe('rule C2a — cBOM ↔ eBOM reconciliation', () => {
  it('classifies every row and orders defects first', async () => {
    const assembly = await part({ partNumber: 'REC-ASM' });
    const matched = await part({ partNumber: 'REC-MATCH' });
    const mismatched = await part({ partNumber: 'REC-QTY' });
    const cadOnly = await part({ partNumber: 'REC-CADONLY' });
    const ebomOnly = await part({ partNumber: 'REC-EBOMONLY' });

    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: matched.id, quantity: 2 });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: mismatched.id,
      quantity: 1,
    });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: ebomOnly.id,
      quantity: 5,
    });

    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'REC-ASM',
      children: [
        { name: 'REC-MATCH', instances: 2 },
        { name: 'REC-QTY', instances: 4 },
        { name: 'REC-CADONLY', instances: 1 },
        { name: 'NOT-A-PART', instances: 7 },
      ],
    });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      match: 1,
      qtyMismatch: 1,
      missingInEbom: 1,
      extraInEbom: 1,
      unmatched: 1,
    });
    expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
      'QTY_MISMATCH',
      'MISSING_IN_EBOM',
      'EXTRA_IN_EBOM',
      'UNMATCHED',
      'MATCH',
    ]);

    const qty = res.body.rows[0];
    expect(qty).toMatchObject({ cadQuantity: 4, ebomQuantity: 1 });
    expect(qty.part.partNumber).toBe(mismatched.partNumber);
    expect(res.body.rows[1].part.partNumber).toBe(cadOnly.partNumber);
    expect(res.body.rows[3]).toMatchObject({ part: null, cadName: 'NOT-A-PART', cadQuantity: 7 });
  });

  it('compares only the top level — deeper CAD nodes belong to the children', async () => {
    const assembly = await part({ partNumber: 'REC-DEEP' });
    const sub = await part({ partNumber: 'REC-DEEP-SUB' });
    const grand = await part({ partNumber: 'REC-DEEP-GRAND' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: sub.id, quantity: 1 });

    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'REC-DEEP',
      children: [
        { name: 'REC-DEEP-SUB', instances: 1, children: [{ name: 'REC-DEEP-GRAND', instances: 8 }] },
      ],
    });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ status: 'MATCH' });
    expect(res.body.rows.some((r: { part?: { id: number } }) => r.part?.id === grand.id)).toBe(false);
  });

  it('leaves an ambiguous CAD name unmatched rather than guessing', async () => {
    const assembly = await part({ partNumber: 'REC-AMB' });
    await part({ partNumber: 'AMB-1', name: 'Bracket' });
    await part({ partNumber: 'AMB-2', name: 'Bracket' });

    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'REC-AMB',
      children: [{ name: 'Bracket', instances: 1 }],
    });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/cbom-reconciliation`);
    expect(res.body.rows[0]).toMatchObject({ status: 'UNMATCHED', part: null, cadName: 'Bracket' });
  });
});

describe('rule C3 — CAD → eBOM proposal', () => {
  async function scenario(partNumber: string) {
    const assembly = await part({ partNumber });
    const onBoth = await part({ partNumber: `${partNumber}-SAME` });
    const qtyChanged = await part({ partNumber: `${partNumber}-QTY` });
    const cadOnly = await part({ partNumber: `${partNumber}-NEW` });
    const bomOnly = await part({ partNumber: `${partNumber}-GONE` });

    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: onBoth.id, quantity: 2 });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: qtyChanged.id,
      quantity: 1,
    });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: bomOnly.id, quantity: 3 });

    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: partNumber,
      children: [
        { name: `${partNumber}-SAME`, instances: 2 },
        { name: `${partNumber}-QTY`, instances: 6 },
        { name: `${partNumber}-NEW`, instances: 1 },
        { name: 'UNKNOWN-PRODUCT', instances: 2 },
      ],
    });
    return { assembly, onBoth, qtyChanged, cadOnly, bomOnly, doc };
  }

  it('classifies ADD, QTY_CHANGE, UNCHANGED, REMOVE and UNMATCHED', async () => {
    const { assembly, doc } = await scenario('C3-CLASS');
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.counts).toEqual({ add: 1, remove: 1, qtyChange: 1, unchanged: 1, unmatched: 1 });

    const lines = res.body.lines as ProposalLine[];
    // Sorted by severity: ADD, QTY_CHANGE, REMOVE, UNMATCHED, UNCHANGED.
    expect(lines.map((l) => l.change)).toEqual([
      'ADD',
      'QTY_CHANGE',
      'REMOVE',
      'UNMATCHED',
      'UNCHANGED',
    ]);
    expect(byChange(lines, 'ADD')[0]).toMatchObject({
      part: { partNumber: 'C3-CLASS-NEW' },
      cadQuantity: 1,
      bomQuantity: null,
      matchedBy: 'PART_NUMBER',
    });
    expect(byChange(lines, 'QTY_CHANGE')[0]).toMatchObject({ cadQuantity: 6, bomQuantity: 1 });
    expect(byChange(lines, 'REMOVE')[0]).toMatchObject({
      part: { partNumber: 'C3-CLASS-GONE' },
      cadQuantity: null,
      bomQuantity: 3,
    });
    expect(byChange(lines, 'UNMATCHED')[0]).toMatchObject({
      cadName: 'UNKNOWN-PRODUCT',
      part: null,
    });
  });

  it('writes nothing when apply is omitted', async () => {
    const { assembly, doc } = await scenario('C3-DRY');
    const before = await prisma.bomLine.count({ where: { parentRevisionId: assembly.revisionId } });
    await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
    });
    const after = await prisma.bomLine.findMany({
      where: { parentRevisionId: assembly.revisionId },
    });
    expect(after).toHaveLength(before);
    expect(after.map((l) => l.quantity).sort()).toEqual([1, 2, 3]);
  });

  it('applies ADD and QTY_CHANGE but leaves REMOVE alone by default', async () => {
    const { assembly, doc } = await scenario('C3-APPLY');
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.removedMissing).toBe(false);

    const bom = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    const byPartNumber = Object.fromEntries(
      bom.body.map((l: { childPart: { partNumber: string }; quantity: number }) => [
        l.childPart.partNumber,
        l.quantity,
      ])
    );
    expect(byPartNumber).toEqual({
      'C3-APPLY-SAME': 2,
      'C3-APPLY-QTY': 6,
      'C3-APPLY-NEW': 1,
      // A partial CAD export must not silently strip the BOM.
      'C3-APPLY-GONE': 3,
    });
  });

  it('deletes missing lines only with removeMissing', async () => {
    const { assembly, doc } = await scenario('C3-REMOVE');
    await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
      removeMissing: true,
    });

    const bom = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    const numbers = bom.body.map((l: { childPart: { partNumber: string } }) => l.childPart.partNumber);
    expect(numbers).not.toContain('C3-REMOVE-GONE');
    expect(numbers.sort()).toEqual(['C3-REMOVE-NEW', 'C3-REMOVE-QTY', 'C3-REMOVE-SAME']);
  });

  it('creates a part per unmatched product with createMissingParts', async () => {
    const { assembly, doc } = await scenario('C3-CREATE');
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
      createMissingParts: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.counts.unmatched).toBe(0);
    expect(res.body.counts.add).toBe(2);

    const created = await prisma.part.findFirst({ where: { name: 'UNKNOWN-PRODUCT' } });
    expect(created).not.toBeNull();
    expect(created?.category).toBe('MECHANICAL');
    expect(created?.partNumber).toMatch(/^P-1000\d$/);
    expect(await prisma.partRevision.count({ where: { partId: created!.id } })).toBe(1);

    const bom = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    const line = bom.body.find(
      (l: { childPart: { id: number } }) => l.childPart.id === created!.id
    );
    expect(line.quantity).toBe(2);
  });

  it('assigns find numbers to applied lines by the normal rule', async () => {
    const assembly = await part({ partNumber: 'C3-FIND' });
    await part({ partNumber: 'C3-FIND-1' });
    await part({ partNumber: 'C3-FIND-2' });
    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'C3-FIND',
      children: [{ name: 'C3-FIND-1' }, { name: 'C3-FIND-2' }],
    });

    await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
    });
    const bom = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    expect(bom.body.map((l: { findNumber: number }) => l.findNumber)).toEqual([10, 20]);
  });

  it('refuses to apply to a revision that is not IN_WORK, but still dry-runs it', async () => {
    const { assembly, doc } = await scenario('C3-GATE');
    await setLifecycle(assembly.revisionId, Lifecycle.RELEASED);

    const applied = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
    });
    expect(applied.status).toBe(409);
    expect(applied.body.error).toBe('Revision A is RELEASED and cannot be modified');

    const dryRun = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
    });
    expect(dryRun.status).toBe(200);
  });

  it('fails the whole request when a CAD node would create a cycle', async () => {
    const top = await part({ partNumber: 'C3-CYC-TOP' });
    const sub = await part({ partNumber: 'C3-CYC-SUB' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: sub.id });

    const doc = await createDocumentVersion({ createdById: engineer.id, partId: sub.id });
    await seedCadStructure(doc.versionId, {
      name: 'C3-CYC-SUB',
      children: [{ name: 'C3-CYC-TOP', instances: 1 }],
    });

    const res = await engineer.post(`/api/revisions/${sub.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Adding this part would create a BOM cycle');
    expect(await prisma.bomLine.count({ where: { parentRevisionId: sub.revisionId } })).toBe(0);
  });

  it('reports deeper nodes as a note rather than importing them', async () => {
    const assembly = await part({ partNumber: 'C3-DEEP' });
    await part({ partNumber: 'C3-DEEP-SUB' });
    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'C3-DEEP',
      children: [
        {
          name: 'C3-DEEP-SUB',
          children: [{ name: 'C3-DEEP-LEAF' }, { name: 'C3-DEEP-LEAF-2' }],
        },
      ],
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
    });
    expect(res.status).toBe(200);
    expect(res.body.deeperNodeCount).toBe(2);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.levels).toHaveLength(1);
  });

  it('imports sub-assembly levels with recursive:true', async () => {
    const assembly = await part({ partNumber: 'C3-REC' });
    const sub = await part({ partNumber: 'C3-REC-SUB' });
    const leaf = await part({ partNumber: 'C3-REC-LEAF' });
    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'C3-REC',
      children: [{ name: 'C3-REC-SUB', children: [{ name: 'C3-REC-LEAF', instances: 4 }] }],
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
      recursive: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.levels).toHaveLength(2);
    expect(res.body.totals.add).toBe(2);

    const subBom = await engineer.get(`/api/revisions/${sub.revisionId}/bom`);
    expect(subBom.body).toHaveLength(1);
    expect(subBom.body[0]).toMatchObject({ quantity: 4, childPart: { id: leaf.id } });
  });

  it('skips a sub-assembly with no IN_WORK revision instead of failing', async () => {
    const assembly = await part({ partNumber: 'C3-SKIP' });
    const sub = await createReleasedPart({ createdById: engineer.id, partNumber: 'C3-SKIP-SUB' });
    await part({ partNumber: 'C3-SKIP-LEAF' });
    const doc = await createDocumentVersion({ createdById: engineer.id, partId: assembly.id });
    await seedCadStructure(doc.versionId, {
      name: 'C3-SKIP',
      children: [{ name: 'C3-SKIP-SUB', children: [{ name: 'C3-SKIP-LEAF' }] }],
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
      apply: true,
      recursive: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.skippedAssemblies).toHaveLength(1);
    expect(res.body.skippedAssemblies[0].reason).toBe(
      'C3-SKIP-SUB has no In Work revision to write to'
    );
    // The top level still landed.
    const bom = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    expect(bom.body[0].childPart.id).toBe(sub.id);
  });

  it('409s when the CAD version has no readable structure', async () => {
    const assembly = await part({ partNumber: 'C3-UNREADABLE' });
    const doc = await createDocumentVersion({
      createdById: engineer.id,
      partId: assembly.id,
      fileName: 'notes.txt',
    });
    await prisma.cadStructure.create({
      data: {
        documentVersionId: doc.versionId,
        status: ConversionStatus.FAILED,
        error: 'kernel could not read it',
      },
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom-from-cad`, {
      documentVersionId: doc.versionId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('The CAD file has no readable assembly structure');
  });
});

describe('rule C4 — mBOM generated from the eBOM', () => {
  it('refuses when the eBOM is empty', async () => {
    const assembly = await part({ partNumber: 'C4-EMPTY' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Add eBOM lines before generating a manufacturing plan');
  });

  it('creates the plan and one Assembly operation consuming every line', async () => {
    const assembly = await part({ partNumber: 'C4-GEN' });
    const first = await part({ partNumber: 'C4-GEN-1' });
    const second = await part({ partNumber: 'C4-GEN-2' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: first.id, quantity: 2 });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: second.id,
      quantity: 0.5,
      uom: 'kg',
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);
    expect(res.status).toBe(201);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0].name).toBe('Assembly');
    const materials = res.body.operations[0].materials as {
      quantity: number;
      uom: string;
      part: { partNumber: string };
    }[];
    expect(materials).toHaveLength(2);
    expect(materials.map((m) => [m.part.partNumber, m.quantity, m.uom])).toEqual([
      ['C4-GEN-1', 2, 'ea'],
      ['C4-GEN-2', 0.5, 'kg'],
    ]);
  });

  it('is safe to press twice', async () => {
    const assembly = await part({ partNumber: 'C4-TWICE' });
    const child = await part({ partNumber: 'C4-TWICE-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });
    await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);

    const again = await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Every eBOM line is already consumed by an operation');
  });

  it('appends only the lines nothing consumes yet', async () => {
    const assembly = await part({ partNumber: 'C4-PARTIAL' });
    const consumed = await part({ partNumber: 'C4-PARTIAL-OLD' });
    const fresh = await part({ partNumber: 'C4-PARTIAL-NEW' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: consumed.id });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: fresh.id });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10, name: 'Prep' });
    await addOperationMaterial({ operationId: operation.id, partId: consumed.id, quantity: 1 });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);
    expect(res.status).toBe(201);
    expect(res.body.operations).toHaveLength(2);
    const generated = res.body.operations[1];
    expect(generated.name).toBe('Assembly');
    expect(generated.materials).toHaveLength(1);
    expect(generated.materials[0].part.partNumber).toBe('C4-PARTIAL-NEW');
  });

  it('refuses on a revision that is not IN_WORK', async () => {
    const assembly = await part({ partNumber: 'C4-GATE' });
    const child = await part({ partNumber: 'C4-GATE-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });
    await setLifecycle(assembly.revisionId, Lifecycle.RELEASED);

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/process-plan/from-bom`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Revision A is RELEASED and cannot be modified');
  });

  it('validates scrapFactor and consumable on materials', async () => {
    const assembly = await part({ partNumber: 'C4-SCRAP' });
    const material = await part({ partNumber: 'C4-SCRAP-M' });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10 });

    const bad = await engineer.post(`/api/operations/${operation.id}/materials`, {
      partId: material.id,
      quantity: 1,
      scrapFactor: 1,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('scrapFactor must be a number >= 0 and < 1');

    const good = await engineer.post(`/api/operations/${operation.id}/materials`, {
      partId: material.id,
      quantity: 1,
      scrapFactor: 0.05,
      consumable: true,
    });
    expect(good.status).toBe(201);
    expect(good.body).toMatchObject({ scrapFactor: 0.05, consumable: true });
  });
});

describe('rule C5 — eBOM ↔ mBOM reconciliation', () => {
  it('reports every eBOM line as MISSING_IN_MBOM when there is no plan', async () => {
    const assembly = await part({ partNumber: 'C5-NOPLAN' });
    const child = await part({ partNumber: 'C5-NOPLAN-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 2 });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.hasPlan).toBe(false);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      status: 'MISSING_IN_MBOM',
      ebomQuantity: 2,
      mbomQuantity: null,
      mbomNominalQuantity: null,
    });
  });

  it('treats a scrap factor as expected loss, not a discrepancy', async () => {
    const assembly = await part({ partNumber: 'C5-SCRAP' });
    const child = await part({ partNumber: 'C5-SCRAP-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 10 });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10, name: 'Cut' });
    await addOperationMaterial({
      operationId: operation.id,
      partId: child.id,
      quantity: 10,
      scrapFactor: 0.02,
    });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    const row = res.body.rows[0];
    expect(row.status).toBe('MATCH');
    expect(row.mbomNominalQuantity).toBe(10);
    // The floor draws 2 % more; reported for planning, never compared.
    expect(row.mbomQuantity).toBe(10.2);
  });

  it('sums a part consumed by several operations before comparing', async () => {
    const assembly = await part({ partNumber: 'C5-SPLIT' });
    const child = await part({ partNumber: 'C5-SPLIT-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 4 });
    const plan = await createProcessPlan(assembly.revisionId);
    const first = await addOperation({ planId: plan.id, seq: 10, name: 'Stage 1' });
    const second = await addOperation({ planId: plan.id, seq: 20, name: 'Stage 2' });
    await addOperationMaterial({ operationId: first.id, partId: child.id, quantity: 1 });
    await addOperationMaterial({ operationId: second.id, partId: child.id, quantity: 3 });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    const row = res.body.rows[0];
    expect(row.status).toBe('MATCH');
    expect(row.mbomNominalQuantity).toBe(4);
    expect(row.consumedBy.map((c: { seq: number }) => c.seq)).toEqual([10, 20]);
  });

  it('rounds float sums so 3 × 0.1 does not read as a mismatch', async () => {
    const assembly = await part({ partNumber: 'C5-FLOAT' });
    const child = await part({ partNumber: 'C5-FLOAT-C' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 0.3 });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10 });
    for (let i = 0; i < 3; i++) {
      await addOperationMaterial({ operationId: operation.id, partId: child.id, quantity: 0.1 });
    }

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    expect(res.body.rows[0]).toMatchObject({ status: 'MATCH', mbomNominalQuantity: 0.3 });
  });

  it('distinguishes CONSUMABLE_ONLY from EXTRA_IN_MBOM', async () => {
    const assembly = await part({ partNumber: 'C5-CONS' });
    const adhesive = await part({ partNumber: 'C5-CONS-GLUE' });
    const surprise = await part({ partNumber: 'C5-CONS-EXTRA' });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10, name: 'Bond' });
    await addOperationMaterial({
      operationId: operation.id,
      partId: adhesive.id,
      quantity: 0.02,
      consumable: true,
    });
    await addOperationMaterial({ operationId: operation.id, partId: surprise.id, quantity: 1 });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    const byPartNumber = Object.fromEntries(
      res.body.rows.map((r: { part: { partNumber: string }; status: string }) => [
        r.part.partNumber,
        r.status,
      ])
    );
    expect(byPartNumber).toEqual({
      'C5-CONS-GLUE': 'CONSUMABLE_ONLY',
      'C5-CONS-EXTRA': 'EXTRA_IN_MBOM',
    });
    expect(res.body.counts).toMatchObject({ consumableOnly: 1, extraInMbom: 1 });
  });

  it('reads a part as EXTRA_IN_MBOM when only some of its uses are consumable', async () => {
    const assembly = await part({ partNumber: 'C5-MIXED' });
    const material = await part({ partNumber: 'C5-MIXED-M' });
    const plan = await createProcessPlan(assembly.revisionId);
    const first = await addOperation({ planId: plan.id, seq: 10 });
    const second = await addOperation({ planId: plan.id, seq: 20 });
    await addOperationMaterial({
      operationId: first.id,
      partId: material.id,
      quantity: 1,
      consumable: true,
    });
    await addOperationMaterial({ operationId: second.id, partId: material.id, quantity: 1 });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    expect(res.body.rows[0].status).toBe('EXTRA_IN_MBOM');
    expect(res.body.rows[0].consumable).toBe(false);
  });

  it('sorts defects above matches', async () => {
    const assembly = await part({ partNumber: 'C5-ORDER' });
    const matched = await part({ partNumber: 'C5-ORDER-MATCH' });
    const mismatched = await part({ partNumber: 'C5-ORDER-QTY' });
    const missing = await part({ partNumber: 'C5-ORDER-MISSING' });
    const extra = await part({ partNumber: 'C5-ORDER-EXTRA' });
    const glue = await part({ partNumber: 'C5-ORDER-GLUE' });
    for (const [child, quantity] of [
      [matched, 1],
      [mismatched, 1],
      [missing, 1],
    ] as const) {
      await addBomLine({
        parentRevisionId: assembly.revisionId,
        childPartId: child.id,
        quantity,
      });
    }
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10 });
    await addOperationMaterial({ operationId: operation.id, partId: matched.id, quantity: 1 });
    await addOperationMaterial({ operationId: operation.id, partId: mismatched.id, quantity: 5 });
    await addOperationMaterial({ operationId: operation.id, partId: extra.id, quantity: 1 });
    await addOperationMaterial({
      operationId: operation.id,
      partId: glue.id,
      quantity: 1,
      consumable: true,
    });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom-reconciliation`);
    expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual([
      'QTY_MISMATCH',
      'MISSING_IN_MBOM',
      'EXTRA_IN_MBOM',
      'CONSUMABLE_ONLY',
      'MATCH',
    ]);
    expect(res.body.counts).toEqual({
      match: 1,
      qtyMismatch: 1,
      missingInMbom: 1,
      extraInMbom: 1,
      consumableOnly: 1,
    });
  });
});
