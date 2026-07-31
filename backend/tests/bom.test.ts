/**
 * eBOM structure rules: 1 (edit gate), 4 (cycle prevention), 5 (resolved revision),
 * 8 (find numbers) and T4 (effectivity windows).
 *
 * Cycles get the most attention: the BFS is conservative across every revision, and a
 * false negative persists a structure that every recursive walk in the app then has to
 * survive.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle } from '@prisma/client';
import { Client, createAndLogin } from './helpers/api';
import {
  addBomLine,
  addRevision,
  createPart,
  createReleasedPart,
  setLifecycle,
  type PartFixture,
} from './helpers/factories';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin();
});

function part(options: Partial<Parameters<typeof createPart>[0]> = {}) {
  return createPart({ createdById: engineer.id, ...options });
}

describe('rule 4 — cycle prevention', () => {
  it('rejects a part as a child of itself', async () => {
    const assembly = await part({ partNumber: 'CYC-SELF' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: assembly.id,
      quantity: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Adding this part would create a BOM cycle');
  });

  it('rejects the direct back-edge A→B then B→A', async () => {
    const a = await part({ partNumber: 'CYC-A' });
    const b = await part({ partNumber: 'CYC-B' });

    const forward = await engineer.post(`/api/revisions/${a.revisionId}/bom`, {
      childPartId: b.id,
      quantity: 2,
    });
    expect(forward.status).toBe(201);

    const back = await engineer.post(`/api/revisions/${b.revisionId}/bom`, {
      childPartId: a.id,
      quantity: 1,
    });
    expect(back.status).toBe(409);
    expect(back.body.error).toBe('Adding this part would create a BOM cycle');
  });

  it('rejects the transitive case A→B→C then C→A', async () => {
    const a = await part({ partNumber: 'CYC-T-A' });
    const b = await part({ partNumber: 'CYC-T-B' });
    const c = await part({ partNumber: 'CYC-T-C' });

    expect(
      (await engineer.post(`/api/revisions/${a.revisionId}/bom`, { childPartId: b.id, quantity: 1 }))
        .status
    ).toBe(201);
    expect(
      (await engineer.post(`/api/revisions/${b.revisionId}/bom`, { childPartId: c.id, quantity: 1 }))
        .status
    ).toBe(201);

    const closing = await engineer.post(`/api/revisions/${c.revisionId}/bom`, {
      childPartId: a.id,
      quantity: 1,
    });
    expect(closing.status).toBe(409);
    expect(closing.body.error).toBe('Adding this part would create a BOM cycle');
  });

  it('rejects a four-deep transitive cycle', async () => {
    const chain: PartFixture[] = [];
    for (let i = 0; i < 4; i++) chain.push(await part({ partNumber: `CYC-D${i}` }));
    for (let i = 0; i < 3; i++) {
      const res = await engineer.post(`/api/revisions/${chain[i].revisionId}/bom`, {
        childPartId: chain[i + 1].id,
        quantity: 1,
      });
      expect(res.status).toBe(201);
    }
    const closing = await engineer.post(`/api/revisions/${chain[3].revisionId}/bom`, {
      childPartId: chain[0].id,
      quantity: 1,
    });
    expect(closing.status).toBe(409);
  });

  it('traverses edges on every revision, not just the one being edited', async () => {
    // The back-edge lives on an obsolete revision of B. Rule 4 is deliberately
    // conservative: a structure that is a cycle on any revision is refused.
    const a = await part({ partNumber: 'CYC-ALL-A' });
    const b = await part({ partNumber: 'CYC-ALL-B' });

    const oldB = await addRevision({
      partId: b.id,
      createdById: engineer.id,
      revision: 'Z',
      lifecycle: Lifecycle.OBSOLETE,
    });
    await addBomLine({ parentRevisionId: oldB.id, childPartId: a.id });

    const res = await engineer.post(`/api/revisions/${a.revisionId}/bom`, {
      childPartId: b.id,
      quantity: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Adding this part would create a BOM cycle');
  });

  it('allows a diamond, which is not a cycle', async () => {
    // top → left, top → right, left → leaf, right → leaf. The leaf is reached twice
    // but never reaches back up.
    const top = await part({ partNumber: 'DIA-TOP' });
    const left = await part({ partNumber: 'DIA-L' });
    const right = await part({ partNumber: 'DIA-R' });
    const leaf = await part({ partNumber: 'DIA-LEAF' });

    for (const [parent, child] of [
      [top, left],
      [top, right],
      [left, leaf],
      [right, leaf],
    ] as const) {
      const res = await engineer.post(`/api/revisions/${parent.revisionId}/bom`, {
        childPartId: child.id,
        quantity: 1,
      });
      expect(res.status).toBe(201);
    }
  });
});

describe('rule 8 — find numbers', () => {
  it('auto-assigns 10, 20, 30 as lines are added', async () => {
    const assembly = await part({ partNumber: 'FN-ASM' });
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++) {
      const child = await part({ partNumber: `FN-CHILD-${i}` });
      const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
        childPartId: child.id,
        quantity: 1,
      });
      expect(res.status).toBe(201);
      numbers.push(res.body.findNumber as number);
    }
    expect(numbers).toEqual([10, 20, 30]);
  });

  it('continues from the highest existing find number', async () => {
    const assembly = await part({ partNumber: 'FN-HIGH' });
    const first = await part({ partNumber: 'FN-HIGH-1' });
    const second = await part({ partNumber: 'FN-HIGH-2' });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: first.id,
      findNumber: 250,
    });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: second.id,
      quantity: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.findNumber).toBe(260);
  });

  it('rejects an explicit find number already used on that revision', async () => {
    const assembly = await part({ partNumber: 'FN-DUP' });
    const first = await part({ partNumber: 'FN-DUP-1' });
    const second = await part({ partNumber: 'FN-DUP-2' });

    expect(
      (
        await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
          childPartId: first.id,
          quantity: 1,
          findNumber: 40,
        })
      ).body.findNumber
    ).toBe(40);

    const clash = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: second.id,
      quantity: 1,
      findNumber: 40,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('Find number already used');
  });

  it('allows the same find number on a different parent revision', async () => {
    const one = await part({ partNumber: 'FN-SCOPE-1' });
    const two = await part({ partNumber: 'FN-SCOPE-2' });
    const child = await part({ partNumber: 'FN-SCOPE-C' });

    for (const parent of [one, two]) {
      const res = await engineer.post(`/api/revisions/${parent.revisionId}/bom`, {
        childPartId: child.id,
        quantity: 1,
        findNumber: 10,
      });
      expect(res.status).toBe(201);
    }
  });

  it('rejects a PATCH onto an occupied find number but allows a no-op re-set', async () => {
    const assembly = await part({ partNumber: 'FN-PATCH' });
    const first = await part({ partNumber: 'FN-PATCH-1' });
    const second = await part({ partNumber: 'FN-PATCH-2' });
    const lineA = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: first.id,
      quantity: 1,
    });
    const lineB = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: second.id,
      quantity: 1,
    });

    const clash = await engineer.patch(`/api/bom-lines/${lineB.body.id}`, { findNumber: 10 });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('Find number already used');

    const noop = await engineer.patch(`/api/bom-lines/${lineA.body.id}`, { findNumber: 10 });
    expect(noop.status).toBe(200);
    expect(noop.body.findNumber).toBe(10);
  });

  it('rejects a duplicate child part on the same revision', async () => {
    const assembly = await part({ partNumber: 'DUP-ASM' });
    const child = await part({ partNumber: 'DUP-CHILD' });

    expect(
      (
        await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
          childPartId: child.id,
          quantity: 1,
        })
      ).status
    ).toBe(201);

    const again = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 5,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Part is already on this BOM');
  });
});

describe('rule 1 — edit gate on BOM mutations', () => {
  const blocked: [Lifecycle, string][] = [
    [Lifecycle.IN_REVIEW, 'Revision A is IN_REVIEW and cannot be modified'],
    [Lifecycle.RELEASED, 'Revision A is RELEASED and cannot be modified'],
    [Lifecycle.OBSOLETE, 'Revision A is OBSOLETE and cannot be modified'],
  ];

  it.each(blocked)('refuses to add a line while %s', async (lifecycle, message) => {
    const assembly = await part({ partNumber: `GATE-${lifecycle}` });
    const child = await part({ partNumber: `GATE-C-${lifecycle}` });
    await setLifecycle(assembly.revisionId, lifecycle);

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(message);
  });

  it('refuses to patch or delete a line on a released revision', async () => {
    const assembly = await part({ partNumber: 'GATE-PD' });
    const child = await part({ partNumber: 'GATE-PD-C' });
    const line = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
    });
    await setLifecycle(assembly.revisionId, Lifecycle.RELEASED);

    const patched = await engineer.patch(`/api/bom-lines/${line.body.id}`, { quantity: 9 });
    expect(patched.status).toBe(409);
    expect(patched.body.error).toBe('Revision A is RELEASED and cannot be modified');

    const deleted = await engineer.delete(`/api/bom-lines/${line.body.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error).toBe('Revision A is RELEASED and cannot be modified');
  });

  it('allows the full add/patch/delete cycle while IN_WORK', async () => {
    const assembly = await part({ partNumber: 'GATE-OK' });
    const child = await part({ partNumber: 'GATE-OK-C' });

    const created = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
    });
    expect(created.status).toBe(201);

    const patched = await engineer.patch(`/api/bom-lines/${created.body.id}`, { quantity: 7.5 });
    expect(patched.status).toBe(200);
    expect(patched.body.quantity).toBe(7.5);

    expect((await engineer.delete(`/api/bom-lines/${created.body.id}`)).status).toBe(204);
    expect((await engineer.get(`/api/revisions/${assembly.revisionId}/bom`)).body).toEqual([]);
  });
});

describe('rule T4 — effectivity windows', () => {
  it('rejects a window whose start is not before its end', async () => {
    const assembly = await part({ partNumber: 'EFF-BAD' });
    const child = await part({ partNumber: 'EFF-BAD-C' });

    const inverted = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveTo: '2026-01-01T00:00:00.000Z',
    });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toBe('effectiveFrom must be before effectiveTo');

    const equal = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveTo: '2026-06-01T00:00:00.000Z',
    });
    expect(equal.status).toBe(400);
  });

  it('rejects an unparseable date', async () => {
    const assembly = await part({ partNumber: 'EFF-NAN' });
    const child = await part({ partNumber: 'EFF-NAN-C' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
      effectiveFrom: 'not-a-date',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('effectiveFrom is not a valid date');
  });

  it('validates the window a PATCH would produce, not just its own fields', async () => {
    const assembly = await part({ partNumber: 'EFF-PATCH' });
    const child = await part({ partNumber: 'EFF-PATCH-C' });
    const line = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    const res = await engineer.patch(`/api/bom-lines/${line.body.id}`, {
      effectiveTo: '2025-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('effectiveFrom must be before effectiveTo');
  });

  it('accepts an open-ended window and clears a bound with null', async () => {
    const assembly = await part({ partNumber: 'EFF-OPEN' });
    const child = await part({ partNumber: 'EFF-OPEN-C' });
    const created = await engineer.post(`/api/revisions/${assembly.revisionId}/bom`, {
      childPartId: child.id,
      quantity: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(created.status).toBe(201);
    expect(created.body.effectiveTo).toBeNull();

    const cleared = await engineer.patch(`/api/bom-lines/${created.body.id}`, {
      effectiveFrom: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.effectiveFrom).toBeNull();
  });

  it('filters the flat BOM and the tree by ?asOf', async () => {
    const assembly = await part({ partNumber: 'EFF-ASOF' });
    const oldChild = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'EFF-ASOF-OLD',
    });
    const newChild = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'EFF-ASOF-NEW',
    });
    // Superseded on 2026-03-01: the old line closes, the new one opens.
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: oldChild.id,
      effectiveTo: new Date('2026-03-01T00:00:00.000Z'),
    });
    await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: newChild.id,
      effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
    });

    const before = await engineer.get(
      `/api/revisions/${assembly.revisionId}/bom?asOf=2026-02-01T00:00:00.000Z`
    );
    expect(before.body.map((l: { childPart: { partNumber: string } }) => l.childPart.partNumber)).toEqual([
      'EFF-ASOF-OLD',
    ]);

    const after = await engineer.get(
      `/api/revisions/${assembly.revisionId}/bom?asOf=2026-04-01T00:00:00.000Z`
    );
    expect(after.body.map((l: { childPart: { partNumber: string } }) => l.childPart.partNumber)).toEqual([
      'EFF-ASOF-NEW',
    ]);

    const unfiltered = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    expect(unfiltered.body).toHaveLength(2);

    const tree = await engineer.get(
      `/api/revisions/${assembly.revisionId}/bom/tree?asOf=2026-04-01T00:00:00.000Z`
    );
    expect(tree.body.map((n: { part: { partNumber: string } }) => n.part.partNumber)).toEqual([
      'EFF-ASOF-NEW',
    ]);
  });
});

describe('rule 5 — resolved revision and the tree walk', () => {
  it('resolves to the latest RELEASED revision, not the newest one', async () => {
    const assembly = await part({ partNumber: 'RES-ASM' });
    const child = await part({ partNumber: 'RES-CHILD', lifecycle: Lifecycle.RELEASED });
    const newer = await addRevision({
      partId: child.id,
      createdById: engineer.id,
      revision: 'B',
      lifecycle: Lifecycle.IN_WORK,
    });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });

    const res = await engineer.get(`/api/revisions/${assembly.revisionId}/bom`);
    expect(res.body[0].resolvedRevision.revision).toBe('A');
    expect(res.body[0].resolvedRevision.id).not.toBe(newer.id);
  });

  it('falls back to the newest revision when none is released, and flags it unreleased', async () => {
    const assembly = await part({ partNumber: 'RES-UNREL' });
    const child = await part({ partNumber: 'RES-UNREL-C' });
    const newer = await addRevision({
      partId: child.id,
      createdById: engineer.id,
      revision: 'B',
    });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id });

    const tree = await engineer.get(`/api/revisions/${assembly.revisionId}/bom/tree`);
    expect(tree.body[0].revision.id).toBe(newer.id);
    expect(tree.body[0].unreleased).toBe(true);
  });

  it('marks a repeat on its own branch as a cycle and stops recursing', async () => {
    // Built directly: the API would never accept this structure (rule 4).
    const a = await part({ partNumber: 'TREE-CYC-A' });
    const b = await part({ partNumber: 'TREE-CYC-B' });
    await addBomLine({ parentRevisionId: a.revisionId, childPartId: b.id });
    await addBomLine({ parentRevisionId: b.revisionId, childPartId: a.id });

    const tree = await engineer.get(`/api/revisions/${a.revisionId}/bom/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body[0].part.partNumber).toBe('TREE-CYC-B');
    expect(tree.body[0].cycle).toBe(false);
    expect(tree.body[0].children[0].part.partNumber).toBe('TREE-CYC-A');
    expect(tree.body[0].children[0].cycle).toBe(true);
    expect(tree.body[0].children[0].children).toEqual([]);
  });
});

describe('where-used', () => {
  it('lists every parent revision the part appears on, newest first', async () => {
    const child = await part({ partNumber: 'WU-CHILD' });
    const older = await part({ partNumber: 'WU-P1' });
    const newer = await part({ partNumber: 'WU-P2' });
    await addBomLine({ parentRevisionId: older.revisionId, childPartId: child.id, quantity: 2 });
    await addBomLine({ parentRevisionId: newer.revisionId, childPartId: child.id, quantity: 3 });

    const res = await engineer.get(`/api/parts/${child.id}/where-used`);
    expect(res.status).toBe(200);
    expect(res.body.map((e: { parentPart: { partNumber: string } }) => e.parentPart.partNumber)).toEqual([
      'WU-P2',
      'WU-P1',
    ]);
  });
});
