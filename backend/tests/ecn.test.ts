/**
 * Engineering Change Notices — rules E1–E13.
 *
 * The two rules that carry the most risk are E3 (a part may sit on only one active ECN,
 * enforced with an advisory lock) and E6 (release is atomic: either every managed
 * revision goes RELEASED or none does).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { EcnStatus, Lifecycle, Role } from '@prisma/client';
import { Client, createAndLogin, createUser, login } from './helpers/api';
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

async function createEcn(client: Client = engineer, title = 'Test change') {
  const res = await client.post('/api/ecns', { title });
  expect(res.status).toBe(201);
  return res.body as { id: number; ecnNumber: string; status: EcnStatus };
}

async function addItem(ecnId: number, partId: number, client: Client = engineer) {
  return client.post(`/api/ecns/${ecnId}/items`, { partId });
}

describe('rule E1 — numbering', () => {
  it('starts at ECN-10001 and increments', async () => {
    const first = await createEcn();
    const second = await createEcn(engineer, 'Second change');
    expect(first.ecnNumber).toBe('ECN-10001');
    expect(second.ecnNumber).toBe('ECN-10002');
  });

  it('continues past a manually numbered ECN rather than colliding', async () => {
    await prisma.ecn.create({
      data: { ecnNumber: 'ECN-10042', title: 'Imported', createdById: engineer.id },
    });
    const next = await createEcn();
    expect(next.ecnNumber).toBe('ECN-10043');
  });

  it('requires a non-blank title of at most 200 characters', async () => {
    expect((await engineer.post('/api/ecns', { title: '   ' })).status).toBe(400);
    const tooLong = await engineer.post('/api/ecns', { title: 'x'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('title must be at most 200 characters');
  });
});

describe('rule E2 — edit gates', () => {
  it('allows header edits only in DRAFT', async () => {
    const p = await part({ partNumber: 'E2-P' });
    const ecn = await createEcn();
    await addItem(ecn.id, p.id);

    const draft = await engineer.patch(`/api/ecns/${ecn.id}`, { title: 'Renamed' });
    expect(draft.status).toBe(200);
    expect(draft.body.title).toBe('Renamed');

    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    const inReview = await engineer.patch(`/api/ecns/${ecn.id}`, { title: 'Too late' });
    expect(inReview.status).toBe(409);
    expect(inReview.body.error).toBe(`ECN ${ecn.ecnNumber} is IN_REVIEW and cannot be modified`);
  });

  it('allows items to be added only in DRAFT', async () => {
    const first = await part({ partNumber: 'E2-ADD-1' });
    const second = await part({ partNumber: 'E2-ADD-2' });
    const ecn = await createEcn();
    await addItem(ecn.id, first.id);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const res = await addItem(ecn.id, second.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`ECN ${ecn.ecnNumber} is IN_REVIEW and cannot be modified`);
  });

  it('allows item fields to be patched in DRAFT and IN_REVIEW but not once APPROVED', async () => {
    const p = await createReleasedPart({ createdById: engineer.id, partNumber: 'E2-ITEM' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);

    expect(
      (await engineer.patch(`/api/ecn-items/${item.body.id}`, { disposition: 'REWORK' })).status
    ).toBe(200);

    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    const inReview = await engineer.patch(`/api/ecn-items/${item.body.id}`, {
      changeDescription: 'Reworked the boss',
    });
    expect(inReview.status).toBe(200);
    expect(inReview.body.changeDescription).toBe('Reworked the boss');

    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    const approved = await engineer.patch(`/api/ecn-items/${item.body.id}`, {
      changeDescription: 'Too late',
    });
    expect(approved.status).toBe(409);
    expect(approved.body.error).toBe(`ECN ${ecn.ecnNumber} is APPROVED and cannot be modified`);
  });
});

describe('rule E3 — one active ECN per part', () => {
  it('refuses a part already on another active ECN', async () => {
    const p = await part({ partNumber: 'E3-SHARED' });
    const first = await createEcn(engineer, 'First');
    const second = await createEcn(engineer, 'Second');
    expect((await addItem(first.id, p.id)).status).toBe(201);

    const clash = await addItem(second.id, p.id);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe(`Part E3-SHARED is already on active ECN ${first.ecnNumber}`);
  });

  it('refuses the same part twice on one ECN', async () => {
    const p = await part({ partNumber: 'E3-DUP' });
    const ecn = await createEcn();
    expect((await addItem(ecn.id, p.id)).status).toBe(201);

    const again = await addItem(ecn.id, p.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Part is already on this ECN');
  });

  it.each([EcnStatus.RELEASED, EcnStatus.CANCELLED])(
    'lets a part join a new ECN once the old one is %s',
    async (status) => {
      const p = await part({ partNumber: `E3-FREE-${status}` });
      const first = await createEcn(engineer, 'Old');
      await addItem(first.id, p.id);
      await prisma.ecn.update({ where: { id: first.id }, data: { status } });

      const second = await createEcn(engineer, 'New');
      expect((await addItem(second.id, p.id)).status).toBe(201);
    }
  );

  it('serializes concurrent adds of the same part to two ECNs (advisory lock)', async () => {
    const p = await part({ partNumber: 'E3-RACE' });
    const first = await createEcn(engineer, 'Race A');
    const second = await createEcn(engineer, 'Race B');

    const results = await Promise.all([addItem(first.id, p.id), addItem(second.id, p.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toMatch(
      /is already on active ECN ECN-100/
    );

    // The invariant that matters: one active membership, never two.
    const active = await prisma.ecnItem.count({
      where: {
        partId: p.id,
        ecn: { status: { in: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED] } },
      },
    });
    expect(active).toBe(1);
  });

  it('snapshots fromRevision as the latest RELEASED revision when the item is added', async () => {
    const p = await createReleasedPart({ createdById: engineer.id, partNumber: 'E3-FROM' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    expect(item.body.fromRevision).toMatchObject({ revision: 'A', lifecycle: 'RELEASED' });

    const fresh = await part({ partNumber: 'E3-FROM-NONE' });
    const other = await createEcn(engineer, 'Other');
    const noRelease = await addItem(other.id, fresh.id);
    expect(noRelease.body.fromRevision).toBeNull();
  });
});

describe('rule E4 — start change', () => {
  it('adopts an existing IN_WORK revision rather than creating another', async () => {
    const p = await part({ partNumber: 'E4-ATTACH' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);

    const res = await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    expect(res.status).toBe(200);
    expect(res.body.toRevision.id).toBe(p.revisionId);
    expect(await prisma.partRevision.count({ where: { partId: p.id } })).toBe(1);
  });

  it('creates the next revision from a RELEASED one, deep-copying its structure', async () => {
    const assembly = await createReleasedPart({ createdById: engineer.id, partNumber: 'E4-REV' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'E4-REV-C' });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: child.id,
      quantity: 3,
      findNumber: 20,
    });
    const plan = await createProcessPlan(assembly.revisionId, 'Cell 7');
    const operation = await addOperation({ planId: plan.id, seq: 10, name: 'Weld' });
    await addOperationMaterial({ operationId: operation.id, partId: child.id, quantity: 3 });

    const ecn = await createEcn();
    const item = await addItem(ecn.id, assembly.id);
    const res = await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    expect(res.status).toBe(201);
    expect(res.body.fromRevision).toMatchObject({ revision: 'A' });
    expect(res.body.toRevision).toMatchObject({ revision: 'B', lifecycle: 'IN_WORK' });

    const bom = await engineer.get(`/api/revisions/${res.body.toRevision.id}/bom`);
    expect(bom.body).toHaveLength(1);
    expect(bom.body[0]).toMatchObject({ quantity: 3, findNumber: 20 });
    const copiedPlan = await engineer.get(`/api/revisions/${res.body.toRevision.id}/process-plan`);
    expect(copiedPlan.body.name).toBe('Cell 7');
    expect(copiedPlan.body.operations[0].materials).toHaveLength(1);
  });

  it('refuses when the latest revision is IN_REVIEW', async () => {
    const p = await part({ partNumber: 'E4-REVIEW' });
    await setLifecycle(p.revisionId, Lifecycle.IN_REVIEW);
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);

    const res = await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Latest revision of E4-REVIEW is in review — resolve it first');
  });

  it('refuses a second start on the same item', async () => {
    const p = await part({ partNumber: 'E4-TWICE' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    const again = await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Change already started for this part');
  });

  it('refuses once the ECN is APPROVED', async () => {
    const withRev = await part({ partNumber: 'E4-GATE-1' });
    const other = await part({ partNumber: 'E4-GATE-2' });
    const ecn = await createEcn();
    const first = await addItem(ecn.id, withRev.id);
    const second = await addItem(ecn.id, other.id);
    await engineer.post(`/api/ecn-items/${first.body.id}/revision`);
    await engineer.post(`/api/ecn-items/${second.body.id}/revision`);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });

    const item = await prisma.ecnItem.findFirst({ where: { ecnId: ecn.id } });
    const res = await engineer.post(`/api/ecn-items/${item!.id}/revision`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`ECN ${ecn.ecnNumber} is APPROVED and cannot be modified`);
  });
});

describe('rule E5 — transition gates', () => {
  it('refuses to submit an ECN with no affected parts', async () => {
    const ecn = await createEcn();
    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Add at least one affected part before submitting');
  });

  it('refuses to approve while any item lacks a working revision, naming them sorted', async () => {
    const started = await part({ partNumber: 'E5-OK' });
    const missingB = await part({ partNumber: 'E5-ZZ' });
    const missingA = await part({ partNumber: 'E5-AA' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, started.id);
    await addItem(ecn.id, missingB.id);
    await addItem(ecn.id, missingA.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot approve: no working revision for: E5-AA, E5-ZZ');
  });

  it('stamps approvedBy and approvedAt on approve', async () => {
    const p = await part({ partNumber: 'E5-APPROVE' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedBy.id).toBe(engineer.id);
    expect(res.body.approvedAt).not.toBeNull();
  });

  const illegal: [EcnStatus, string][] = [
    [EcnStatus.DRAFT, 'approve'],
    [EcnStatus.DRAFT, 'release'],
    [EcnStatus.DRAFT, 'reject'],
    [EcnStatus.IN_REVIEW, 'submit'],
    [EcnStatus.IN_REVIEW, 'release'],
    [EcnStatus.APPROVED, 'submit'],
    [EcnStatus.APPROVED, 'approve'],
    [EcnStatus.RELEASED, 'cancel'],
    [EcnStatus.CANCELLED, 'submit'],
  ];

  it.each(illegal)('refuses %s → %s', async (status, action) => {
    const ecn = await createEcn(engineer, `Matrix ${status} ${action}`);
    await prisma.ecn.update({ where: { id: ecn.id }, data: { status } });
    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`Cannot ${action}: ECN ${ecn.ecnNumber} is ${status}`);
  });

  it('cancels from DRAFT, IN_REVIEW and APPROVED', async () => {
    for (const status of [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED]) {
      const ecn = await createEcn(engineer, `Cancel ${status}`);
      await prisma.ecn.update({ where: { id: ecn.id }, data: { status } });
      const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'cancel' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
    }
  });
});

describe('rule E6 — atomic release', () => {
  async function approvedEcnWith(parts: { id: number }[]) {
    const ecn = await createEcn();
    const items: number[] = [];
    for (const p of parts) {
      const item = await addItem(ecn.id, p.id);
      expect(item.status).toBe(201);
      const started = await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
      expect([200, 201]).toContain(started.status);
      items.push(started.body.toRevision.id as number);
    }
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    const approved = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(approved.status).toBe(200);
    return { ecn, revisionIds: items };
  }

  it('releases every managed revision and the ECN in one step', async () => {
    const one = await part({ partNumber: 'E6-ONE' });
    const two = await part({ partNumber: 'E6-TWO' });
    const { ecn, revisionIds } = await approvedEcnWith([one, two]);

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RELEASED');
    expect(res.body.releasedAt).not.toBeNull();
    // Effectivity defaults to the release instant when it was never set.
    expect(res.body.effectivityDate).not.toBeNull();

    const revisions = await prisma.partRevision.findMany({ where: { id: { in: revisionIds } } });
    expect(revisions).toHaveLength(2);
    for (const revision of revisions) {
      expect(revision.lifecycle).toBe(Lifecycle.RELEASED);
      expect(revision.releasedAt).not.toBeNull();
    }
  });

  it('keeps an explicit effectivityDate rather than overwriting it', async () => {
    const p = await part({ partNumber: 'E6-EFF' });
    const { ecn } = await approvedEcnWith([p]);
    const chosen = '2027-01-15T00:00:00.000Z';
    await prisma.ecn.update({
      where: { id: ecn.id },
      data: { effectivityDate: new Date(chosen) },
    });

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.body.effectivityDate).toBe(chosen);
  });

  it('rolls the whole release back when one child part has no released revision', async () => {
    const assembly = await part({ partNumber: 'E6-ASM' });
    const sibling = await part({ partNumber: 'E6-SIBLING' });
    const orphan = await part({ partNumber: 'E6-ORPHAN' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: orphan.id });
    const { ecn, revisionIds } = await approvedEcnWith([assembly, sibling]);

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'Cannot release: child parts without a released revision: E6-ORPHAN'
    );

    // Atomic: the innocent sibling must not have slipped through.
    const revisions = await prisma.partRevision.findMany({ where: { id: { in: revisionIds } } });
    for (const revision of revisions) expect(revision.lifecycle).toBe(Lifecycle.IN_WORK);
    const after = await prisma.ecn.findUnique({ where: { id: ecn.id } });
    expect(after?.status).toBe(EcnStatus.APPROVED);
    expect(after?.releasedAt).toBeNull();
  });

  it('accepts a child that is itself an affected part of the same ECN', async () => {
    // The child has never been released, but its own revision goes out in this
    // transaction — the gate must look at the ECN, not just history.
    const assembly = await part({ partNumber: 'E6-MUTUAL-ASM' });
    const child = await part({ partNumber: 'E6-MUTUAL-CHILD' });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });
    const { ecn, revisionIds } = await approvedEcnWith([assembly, child]);

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.status).toBe(200);
    const revisions = await prisma.partRevision.findMany({ where: { id: { in: revisionIds } } });
    for (const revision of revisions) expect(revision.lifecycle).toBe(Lifecycle.RELEASED);
  });

  it('refuses when a managed revision was released out from under the ECN', async () => {
    const p = await part({ partNumber: 'E6-DRIFT' });
    const { ecn, revisionIds } = await approvedEcnWith([p]);
    await setLifecycle(revisionIds[0], Lifecycle.RELEASED);

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('is RELEASED');
  });
});

describe('rule E7 — managed revisions', () => {
  it('refuses a direct transition on a revision an active ECN owns', async () => {
    const p = await part({ partNumber: 'E7-MANAGED' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    for (const action of ['submit', 'approve', 'reject', 'obsolete']) {
      const res = await engineer.post(`/api/revisions/${p.revisionId}/transition`, { action });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        `Revision is managed by ${ecn.ecnNumber} (DRAFT) — progress the change through the ECN`
      );
    }
  });

  it('still allows BOM edits on the managed IN_WORK revision', async () => {
    const p = await part({ partNumber: 'E7-EDIT' });
    const child = await part({ partNumber: 'E7-EDIT-C' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    const res = await engineer.post(`/api/revisions/${p.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
    });
    expect(res.status).toBe(201);
  });

  it('releases the revision again to direct control once the ECN is cancelled', async () => {
    const p = await part({ partNumber: 'E7-FREED' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'cancel' });

    const res = await engineer.post(`/api/revisions/${p.revisionId}/transition`, {
      action: 'submit',
    });
    expect(res.status).toBe(200);
  });
});

describe('rule E8 — concurrent transitions', () => {
  it('lets exactly one of two simultaneous submits win', async () => {
    const p = await part({ partNumber: 'E8-RACE' });
    const ecn = await createEcn();
    await addItem(ecn.id, p.id);

    const results = await Promise.all([
      engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' }),
      engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await prisma.ecn.findUnique({ where: { id: ecn.id } });
    expect(after?.status).toBe(EcnStatus.IN_REVIEW);
  });
});

describe('rule E9 — deletion', () => {
  it('deletes a DRAFT ECN with no started changes', async () => {
    const p = await part({ partNumber: 'E9-OK' });
    const ecn = await createEcn();
    await addItem(ecn.id, p.id);
    expect((await engineer.delete(`/api/ecns/${ecn.id}`)).status).toBe(204);
    expect(await prisma.ecn.count({ where: { id: ecn.id } })).toBe(0);
  });

  it('refuses to delete once a working revision is attached', async () => {
    const p = await part({ partNumber: 'E9-STARTED' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    const res = await engineer.delete(`/api/ecns/${ecn.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'This ECN has started changes (working revisions attached) and cannot be deleted'
    );
  });

  it('refuses to delete outside DRAFT', async () => {
    const p = await part({ partNumber: 'E9-SUBMITTED' });
    const ecn = await createEcn();
    await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const res = await engineer.delete(`/api/ecns/${ecn.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`ECN ${ecn.ecnNumber} is IN_REVIEW and cannot be deleted`);
  });

  it('unlinks rather than deletes the working revision when an item is removed', async () => {
    const p = await part({ partNumber: 'E9-UNLINK' });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);

    expect((await engineer.delete(`/api/ecn-items/${item.body.id}`)).status).toBe(204);
    const revision = await prisma.partRevision.findUnique({ where: { id: p.revisionId } });
    expect(revision?.lifecycle).toBe(Lifecycle.IN_WORK);
  });
});

describe('rule E10 — part deletion referenced by an ECN', () => {
  it('refuses to delete a part that is an affected item', async () => {
    const p = await part({ partNumber: 'E10-P' });
    const ecn = await createEcn();
    await addItem(ecn.id, p.id);

    const res = await engineer.delete(`/api/parts/${p.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Part is referenced by an ECN and cannot be deleted');
  });
});

describe('rules E11–E13 — reviewers and the approve gate', () => {
  async function ecnReadyForReview() {
    const p = await part({ partNumber: `RV-${Math.random().toString(36).slice(2, 8)}` });
    const ecn = await createEcn();
    const item = await addItem(ecn.id, p.id);
    await engineer.post(`/api/ecn-items/${item.body.id}/revision`);
    return ecn;
  }

  it('assigns a reviewer in DRAFT and refuses a duplicate', async () => {
    const reviewer = await createUser({ role: Role.ENGINEER });
    const ecn = await ecnReadyForReview();

    const first = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: reviewer.id });
    expect(first.status).toBe(201);
    expect(first.body.decision).toBe('PENDING');

    const again = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: reviewer.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('User is already a reviewer');
  });

  it('refuses to assign a reviewer once the ECN is APPROVED', async () => {
    const reviewer = await createUser();
    const ecn = await ecnReadyForReview();
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });

    const res = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: reviewer.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`ECN ${ecn.ecnNumber} is APPROVED and cannot be modified`);
  });

  it('lets only the assigned reviewer decide, and only while IN_REVIEW', async () => {
    const reviewerUser = await createUser();
    const reviewer = await login(reviewerUser);
    const ecn = await ecnReadyForReview();
    const review = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, {
      userId: reviewerUser.id,
    });

    const tooEarly = await reviewer.post(`/api/ecn-reviews/${review.body.id}/decision`, {
      decision: 'approve',
    });
    expect(tooEarly.status).toBe(409);

    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const wrongUser = await engineer.post(`/api/ecn-reviews/${review.body.id}/decision`, {
      decision: 'approve',
    });
    expect(wrongUser.status).toBe(403);
    expect(wrongUser.body.error).toBe('Only the assigned reviewer can decide');

    const decided = await reviewer.post(`/api/ecn-reviews/${review.body.id}/decision`, {
      decision: 'approve',
      comment: 'Looks right',
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ decision: 'APPROVED', comment: 'Looks right' });
    expect(decided.body.decidedAt).not.toBeNull();
  });

  it('blocks approve while any review is pending or rejected, naming reviewers sorted', async () => {
    const alice = await createUser({ name: 'Alice Zephyr' });
    const bob = await createUser({ name: 'Bob Anders' });
    const ecn = await ecnReadyForReview();
    const aliceReview = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: alice.id });
    await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: bob.id });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const blocked = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe(
      'Cannot approve: reviews outstanding for: Alice Zephyr, Bob Anders'
    );

    // A rejection is still outstanding — only APPROVED clears the gate.
    const aliceClient = await login(alice);
    await aliceClient.post(`/api/ecn-reviews/${aliceReview.body.id}/decision`, {
      decision: 'reject',
    });
    const stillBlocked = await engineer.post(`/api/ecns/${ecn.id}/transition`, {
      action: 'approve',
    });
    expect(stillBlocked.body.error).toBe(
      'Cannot approve: reviews outstanding for: Alice Zephyr, Bob Anders'
    );
  });

  it('approves once every reviewer has approved', async () => {
    const alice = await createUser({ name: 'Alice' });
    const bob = await createUser({ name: 'Bob' });
    const ecn = await ecnReadyForReview();
    const reviews = [
      await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: alice.id }),
      await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: bob.id }),
    ];
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    for (const [user, review] of [
      [alice, reviews[0]],
      [bob, reviews[1]],
    ] as const) {
      const client = await login(user);
      await client.post(`/api/ecn-reviews/${review.body.id}/decision`, { decision: 'approve' });
    }

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('resets every review to PENDING when the ECN is resubmitted', async () => {
    const reviewerUser = await createUser({ name: 'Rita' });
    const reviewer = await login(reviewerUser);
    const ecn = await ecnReadyForReview();
    const review = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, {
      userId: reviewerUser.id,
    });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    await reviewer.post(`/api/ecn-reviews/${review.body.id}/decision`, {
      decision: 'approve',
      comment: 'Fine by me',
    });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'reject' });

    const resubmitted = await engineer.post(`/api/ecns/${ecn.id}/transition`, {
      action: 'submit',
    });
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.reviews[0]).toMatchObject({
      decision: 'PENDING',
      // The comment survives the reset; only the decision restarts.
      comment: 'Fine by me',
      decidedAt: null,
    });
  });

  it('refuses to assign a VIEWER, who could never decide', async () => {
    const viewer = await createUser({ role: Role.VIEWER, name: 'Val Viewer' });
    const ecn = await ecnReadyForReview();
    const res = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, { userId: viewer.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Viewers cannot approve — Val Viewer is a read-only user');
  });

  it('refuses to remove a reviewer who has already decided', async () => {
    const reviewerUser = await createUser();
    const reviewer = await login(reviewerUser);
    const ecn = await ecnReadyForReview();
    const review = await engineer.post(`/api/ecns/${ecn.id}/reviewers`, {
      userId: reviewerUser.id,
    });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    await reviewer.post(`/api/ecn-reviews/${review.body.id}/decision`, { decision: 'approve' });

    const res = await engineer.delete(`/api/ecn-reviews/${review.body.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A decided review cannot be removed');
  });
});

describe('ECN change impact', () => {
  it('reports the where-used list per affected item', async () => {
    const changed = await part({ partNumber: 'IMP-CHILD' });
    const parent = await part({ partNumber: 'IMP-PARENT' });
    await addBomLine({ parentRevisionId: parent.revisionId, childPartId: changed.id, quantity: 6 });
    const ecn = await createEcn();
    await addItem(ecn.id, changed.id);

    const res = await engineer.get(`/api/ecns/${ecn.id}/impact`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].part.partNumber).toBe('IMP-CHILD');
    expect(res.body[0].usedIn[0].parentPart.partNumber).toBe('IMP-PARENT');
    expect(res.body[0].usedIn[0].line.quantity).toBe(6);
  });
});
