/**
 * Revision lifecycle: rules 1 (edit gate), 2 (release gate), 3 (revise + deep copy)
 * and the conditional-update concurrency guard.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle } from '@prisma/client';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import {
  addBomLine,
  addOperation,
  addOperationMaterial,
  addRevision,
  createPart,
  createProcessPlan,
  createReleasedPart,
  setLifecycle,
} from './helpers/factories';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin();
});

function part(options: Partial<Parameters<typeof createPart>[0]> = {}) {
  return createPart({ createdById: engineer.id, ...options });
}

describe('the transition machine', () => {
  it('walks IN_WORK → IN_REVIEW → RELEASED → OBSOLETE and stamps releasedAt', async () => {
    const p = await part({ partNumber: 'LC-HAPPY' });

    const submitted = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'submit',
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.lifecycle).toBe('IN_REVIEW');
    expect(submitted.body.releasedAt).toBeNull();

    const released = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'approve',
    });
    expect(released.body.lifecycle).toBe('RELEASED');
    expect(released.body.releasedAt).not.toBeNull();

    const obsoleted = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'obsolete',
    });
    expect(obsoleted.body.lifecycle).toBe('OBSOLETE');
  });

  it('sends a rejected revision back to IN_WORK', async () => {
    const p = await part({ partNumber: 'LC-REJECT' });
    await engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'submit' });

    const rejected = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'reject',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.lifecycle).toBe('IN_WORK');
  });

  const illegal: [Lifecycle, string, string][] = [
    [Lifecycle.IN_WORK, 'approve', 'Cannot approve: revision A is IN_WORK (requires IN_REVIEW)'],
    [Lifecycle.IN_WORK, 'reject', 'Cannot reject: revision A is IN_WORK (requires IN_REVIEW)'],
    [Lifecycle.IN_WORK, 'obsolete', 'Cannot obsolete: revision A is IN_WORK (requires RELEASED)'],
    [Lifecycle.IN_REVIEW, 'submit', 'Cannot submit: revision A is IN_REVIEW (requires IN_WORK)'],
    [Lifecycle.RELEASED, 'submit', 'Cannot submit: revision A is RELEASED (requires IN_WORK)'],
    [Lifecycle.RELEASED, 'approve', 'Cannot approve: revision A is RELEASED (requires IN_REVIEW)'],
    [Lifecycle.OBSOLETE, 'obsolete', 'Cannot obsolete: revision A is OBSOLETE (requires RELEASED)'],
  ];

  it.each(illegal)('refuses %s → %s', async (lifecycle, action, message) => {
    const p = await part({ partNumber: `LC-${lifecycle}-${action}` });
    await setLifecycle(p.revisionId, lifecycle);
    const res = await engineer.post(`/api/revisions/${p.revisionId}/transition`, { action });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(message);
  });

  it('rejects an unknown action', async () => {
    const p = await part({ partNumber: 'LC-UNKNOWN' });
    const res = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'teleport',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown action (expected submit, approve, reject or obsolete)');
  });

  it('404s for a revision that does not exist', async () => {
    const res = await engineer.post('/api/revisions/999999/transition', { action: 'submit' });
    expect(res.status).toBe(404);
  });
});

describe('rule 2 — release gate', () => {
  it('blocks approve and names every child without a released revision, sorted', async () => {
    const assembly = await part({ partNumber: 'RG-ASM' });
    const ok = await createReleasedPart({ createdById: engineer.id, partNumber: 'P-10001' });
    const bad1 = await part({ partNumber: 'P-10007' });
    const bad2 = await part({ partNumber: 'P-10004' });
    for (const child of [ok, bad1, bad2]) {
      await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });
    }
    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'Cannot release: child parts without a released revision: P-10004, P-10007'
    );

    const after = await prisma.partRevision.findUnique({ where: { id: assembly.revisionId } });
    expect(after?.lifecycle).toBe(Lifecycle.IN_REVIEW);
  });

  it('accepts a child whose released revision is not its newest', async () => {
    const assembly = await part({ partNumber: 'RG-OLDREL' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'RG-CHILD' });
    await addRevision({ partId: child.id, createdById: engineer.id, revision: 'B' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });

    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(200);
    expect(res.body.lifecycle).toBe('RELEASED');
  });

  it('lets a leaf with no BOM lines release', async () => {
    const leaf = await part({ partNumber: 'RG-LEAF' });
    await engineer.post(`/api/revisions/${leaf.revisionId}/transition`, { action: 'submit' });
    const res = await engineer.post(`/api/revisions/${leaf.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(200);
  });
});

describe('rule 8 — concurrent transitions', () => {
  it('lets exactly one of two simultaneous submits win', async () => {
    const p = await part({ partNumber: 'CONC-SUBMIT' });
    const results = await Promise.all([
      engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'submit' }),
      engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'submit' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const loser = results.find((r) => r.status === 409)!;
    // Either the pre-check or the conditional update caught it; both are correct
    // outcomes, and neither may leave the revision in a second state.
    expect(loser.body.error).toMatch(/Cannot submit: revision A (is IN_REVIEW|was changed)/);

    const after = await prisma.partRevision.findUnique({ where: { id: p.revisionId } });
    expect(after?.lifecycle).toBe(Lifecycle.IN_REVIEW);
  });

  it('lets exactly one of a simultaneous approve and reject win', async () => {
    const p = await part({ partNumber: 'CONC-RACE' });
    await engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'submit' });

    const results = await Promise.all([
      engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'approve' }),
      engineer.post(`/api/revisions/${p.revisionId}/transition`, { action: 'reject' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const after = await prisma.partRevision.findUnique({ where: { id: p.revisionId } });
    expect([Lifecycle.RELEASED, Lifecycle.IN_WORK]).toContain(after?.lifecycle);
  });
});

describe('rule 1 — changeNote edit gate', () => {
  it('accepts a changeNote while IN_WORK', async () => {
    const p = await part({ partNumber: 'CN-OK' });
    const res = await engineer.patch(`/api/revisions/${p.revisionId}`, {
      changeNote: 'Widened the slot',
    });
    expect(res.status).toBe(200);
    expect(res.body.changeNote).toBe('Widened the slot');
  });

  it('refuses a changeNote once the revision has left IN_WORK', async () => {
    const p = await part({ partNumber: 'CN-GATE' });
    await setLifecycle(p.revisionId, Lifecycle.IN_REVIEW);
    const res = await engineer.patch(`/api/revisions/${p.revisionId}`, { changeNote: 'nope' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Revision A is IN_REVIEW and cannot be modified');
  });
});

describe('rule 3 — revise', () => {
  it('refuses while the latest revision is IN_WORK or IN_REVIEW', async () => {
    const p = await part({ partNumber: 'REV-GATE' });
    const inWork = await engineer.post(`/api/parts/${p.id}/revisions`);
    expect(inWork.status).toBe(409);
    expect(inWork.body.error).toBe(
      'Cannot revise: latest revision A is IN_WORK (must be RELEASED or OBSOLETE)'
    );

    await setLifecycle(p.revisionId, Lifecycle.IN_REVIEW);
    const inReview = await engineer.post(`/api/parts/${p.id}/revisions`);
    expect(inReview.status).toBe(409);
  });

  it('creates the next label from a RELEASED revision', async () => {
    const p = await createReleasedPart({ createdById: engineer.id, partNumber: 'REV-NEXT' });
    const res = await engineer.post(`/api/parts/${p.id}/revisions`);
    expect(res.status).toBe(201);
    expect(res.body.revision).toBe('B');
    expect(res.body.lifecycle).toBe('IN_WORK');
    expect(res.body.createdBy.id).toBe(engineer.id);
  });

  it('rolls Z over to AA', async () => {
    const p = await part({ partNumber: 'REV-ROLL' });
    await prisma.partRevision.update({
      where: { id: p.revisionId },
      data: { revision: 'Z', lifecycle: Lifecycle.RELEASED, releasedAt: new Date() },
    });
    const res = await engineer.post(`/api/parts/${p.id}/revisions`);
    expect(res.body.revision).toBe('AA');
  });

  it('revises from an OBSOLETE revision too', async () => {
    const p = await part({ partNumber: 'REV-OBS', lifecycle: Lifecycle.OBSOLETE });
    const res = await engineer.post(`/api/parts/${p.id}/revisions`);
    expect(res.status).toBe(201);
    expect(res.body.revision).toBe('B');
  });

  it('deep-copies the BOM and the process plan into the new revision', async () => {
    const assembly = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'REV-COPY',
    });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'REV-COPY-C' });
    const consumable = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'REV-COPY-M',
    });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: child.id,
      quantity: 4,
      findNumber: 30,
      refDesignators: 'R1,R2',
    });
    const plan = await createProcessPlan(assembly.revisionId, 'Line 3');
    const operation = await addOperation({ planId: plan.id, seq: 20, name: 'Press fit' });
    await addOperationMaterial({
      operationId: operation.id,
      partId: consumable.id,
      quantity: 0.25,
    });

    const revised = await engineer.post(`/api/parts/${assembly.id}/revisions`);
    expect(revised.status).toBe(201);
    const newRevisionId = revised.body.id as number;
    expect(revised.body.bomLineCount).toBe(1);
    expect(revised.body.hasProcessPlan).toBe(true);

    const bom = await engineer.get(`/api/revisions/${newRevisionId}/bom`);
    expect(bom.body).toHaveLength(1);
    expect(bom.body[0]).toMatchObject({
      findNumber: 30,
      quantity: 4,
      refDesignators: 'R1,R2',
      childPart: { partNumber: 'REV-COPY-C' },
    });
    // A copy, not a reference: editing the new revision must not touch the released one.
    expect(bom.body[0].id).not.toBe(assembly.revisionId);

    const copiedPlan = await engineer.get(`/api/revisions/${newRevisionId}/process-plan`);
    expect(copiedPlan.body.name).toBe('Line 3');
    expect(copiedPlan.body.operations).toHaveLength(1);
    expect(copiedPlan.body.operations[0]).toMatchObject({ seq: 20, name: 'Press fit' });
    expect(copiedPlan.body.operations[0].materials[0]).toMatchObject({
      quantity: 0.25,
      part: { partNumber: 'REV-COPY-M' },
    });

    // The source revision keeps exactly what it had.
    const original = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    expect(original.body).toHaveLength(1);
  });

  it('leaves the previous revision untouched when the copy is edited', async () => {
    const p = await createReleasedPart({ createdById: engineer.id, partNumber: 'REV-INDEP' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'REV-INDEP-C' });
    await addBomLine({ parentRevisionId: p.revisionId, childPartId: child.id, quantity: 1 });

    const revised = await engineer.post(`/api/parts/${p.id}/revisions`);
    const copied = await engineer.get(`/api/revisions/${revised.body.id}/bom`);
    await engineer.patch(`/api/bom-lines/${copied.body[0].id}`, { quantity: 99 });

    const original = await engineer.get(`/api/revisions/${p.revisionId}/bom`);
    expect(original.body[0].quantity).toBe(1);
  });
});

describe('rule 7 — part deletion guards', () => {
  it('refuses to delete a part used on a BOM', async () => {
    const assembly = await part({ partNumber: 'DEL-ASM' });
    const child = await part({ partNumber: 'DEL-CHILD' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });

    const res = await engineer.delete(`/api/parts/${child.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Part is used in a BOM / process plan and cannot be deleted');
  });

  it('refuses to delete a part consumed by a process plan', async () => {
    const assembly = await part({ partNumber: 'DEL-PLAN' });
    const material = await part({ partNumber: 'DEL-MAT' });
    const plan = await createProcessPlan(assembly.revisionId);
    const operation = await addOperation({ planId: plan.id, seq: 10 });
    await addOperationMaterial({ operationId: operation.id, partId: material.id, quantity: 1 });

    const res = await engineer.delete(`/api/parts/${material.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Part is used in a BOM / process plan and cannot be deleted');
  });

  it('deletes an unreferenced part and cascades its revisions', async () => {
    const p = await part({ partNumber: 'DEL-FREE' });
    expect((await engineer.delete(`/api/parts/${p.id}`)).status).toBe(204);
    expect(await prisma.partRevision.count({ where: { partId: p.id } })).toBe(0);
  });
});
