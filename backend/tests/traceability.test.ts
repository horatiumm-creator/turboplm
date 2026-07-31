/**
 * Serial / lot build units, as-built records and two-way traceability — rules U1–U7.
 *
 * The invariants here protect a physical record: one object is in one place, a lot cannot be
 * consumed beyond what exists, and a unit cannot end up inside itself. Several of these tests
 * pin bugs that were found and fixed during the build, and they are marked as such — those
 * are the ones most worth keeping honest.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle, Role } from '@prisma/client';
import { prisma, resetDatabase } from './helpers/db';
import { Client, createAndLogin } from './helpers/api';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';

let engineer: Client;

/** A released part is the only legal thing to build against (rule U1). */
async function buildable(options: { name?: string } = {}) {
  return createReleasedPart({ createdById: engineer.id, name: options.name });
}

async function unit(
  part: { id: number; revisionId: number },
  kind: 'SERIAL' | 'LOT',
  quantity = 1,
  extra: Record<string, unknown> = {}
) {
  const res = await engineer.post('/api/build-units', {
    kind,
    partId: part.id,
    partRevisionId: part.revisionId,
    quantity,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; identifier: string; status: string };
}

const complete = (id: number) =>
  engineer.post(`/api/build-units/${id}/transition`, { action: 'complete' });

beforeEach(async () => {
  await resetDatabase();
  engineer = await createAndLogin({ role: Role.ENGINEER });
});

describe('rule U1 — identity and buildability', () => {
  it('forces a SERIAL unit to quantity 1', async () => {
    const part = await buildable();
    const res = await engineer.post('/api/build-units', {
      kind: 'SERIAL',
      partId: part.id,
      partRevisionId: part.revisionId,
      quantity: 5,
    });
    expect(res.status).toBe(400);
  });

  it('requires a positive quantity for a LOT', async () => {
    const part = await buildable();
    for (const quantity of [0, -3]) {
      const res = await engineer.post('/api/build-units', {
        kind: 'LOT',
        partId: part.id,
        partRevisionId: part.revisionId,
        quantity,
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses to build to an unreleased revision', async () => {
    const part = await createPart({ createdById: engineer.id, lifecycle: Lifecycle.IN_WORK });
    const res = await engineer.post('/api/build-units', {
      kind: 'SERIAL',
      partId: part.id,
      partRevisionId: part.revisionId,
    });
    // You do not build production hardware to something engineering has not released.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/IN_WORK/);
  });

  it('refuses a revision belonging to a different part', async () => {
    const [a, b] = [await buildable(), await buildable()];
    const res = await engineer.post('/api/build-units', {
      kind: 'SERIAL',
      partId: a.id,
      partRevisionId: b.revisionId,
    });
    expect(res.status).toBe(400);
  });

  it('generates SN- and LOT- identifiers from separate sequences', async () => {
    const part = await buildable();
    const serial = await unit(part, 'SERIAL');
    const lot = await unit(part, 'LOT', 10);
    expect(serial.identifier).toMatch(/^SN-\d+$/);
    expect(lot.identifier).toMatch(/^LOT-\d+$/);
    // Both prefixes share one column; an unanchored scan would let a lot take a serial's number.
    expect(lot.identifier).not.toMatch(/^SN-/);
  });

  it('accepts an omitted optional field', async () => {
    // Regression: POST once rejected a request that simply left `notes` out, because the
    // nullable-text helper did not treat undefined as absent.
    const part = await buildable();
    const res = await engineer.post('/api/build-units', {
      kind: 'SERIAL',
      partId: part.id,
      partRevisionId: part.revisionId,
    });
    expect(res.status).toBe(201);
  });

  it('rejects a duplicate user-supplied identifier', async () => {
    const part = await buildable();
    await unit(part, 'SERIAL', 1, { identifier: 'HOUSE-0001' });
    const res = await engineer.post('/api/build-units', {
      kind: 'SERIAL',
      partId: part.id,
      partRevisionId: part.revisionId,
      identifier: 'HOUSE-0001',
    });
    expect(res.status).toBe(409);
  });

  it('completes a concurrent burst without dropping a request', async () => {
    // Generated identifiers go through withNumberLock; an unlocked scan-max would surface
    // spurious 409s here, exactly as it did for part numbers.
    const part = await buildable();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        engineer.post('/api/build-units', {
          kind: 'SERIAL',
          partId: part.id,
          partRevisionId: part.revisionId,
        })
      )
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    const identifiers = results.map((r) => r.body.identifier as string);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });
});

describe('rule U2 — build status', () => {
  it('walks the happy path and stamps the dates', async () => {
    const part = await buildable();
    const u = await unit(part, 'SERIAL');

    const completed = await complete(u.id);
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.builtAt).not.toBeNull();

    const shipped = await engineer.post(`/api/build-units/${u.id}/transition`, { action: 'ship' });
    expect(shipped.body.status).toBe('SHIPPED');
    expect(shipped.body.shippedAt).not.toBeNull();
  });

  it('refuses a transition from the wrong state', async () => {
    const part = await buildable();
    const u = await unit(part, 'SERIAL');
    // Cannot ship something that was never completed.
    expect(
      (await engineer.post(`/api/build-units/${u.id}/transition`, { action: 'ship' })).status
    ).toBe(409);
  });

  it('blocks edits once shipped or scrapped', async () => {
    const part = await buildable();
    for (const action of ['ship', 'scrap'] as const) {
      const u = await unit(part, 'SERIAL');
      await complete(u.id);
      await engineer.post(`/api/build-units/${u.id}/transition`, { action });
      const res = await engineer.patch(`/api/build-units/${u.id}`, { notes: 'too late' });
      expect(res.status).toBe(409);
    }
  });

  it('refuses to reopen a unit already built into a parent', async () => {
    const [parentPart, childPart] = [await buildable(), await buildable()];
    const parent = await unit(parentPart, 'SERIAL');
    const child = await unit(childPart, 'SERIAL');
    await complete(child.id);
    await engineer.post(`/api/build-units/${parent.id}/as-built`, { childId: child.id });

    // Reopening would invalidate the parent's as-built record.
    const res = await engineer.post(`/api/build-units/${child.id}/transition`, {
      action: 'reopen',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(parent.identifier);
  });
});

describe('rule U3 — recording what was consumed', () => {
  it('requires the parent to be in progress', async () => {
    const [pp, cp] = [await buildable(), await buildable()];
    const parent = await unit(pp, 'SERIAL');
    const child = await unit(cp, 'SERIAL');
    await complete(child.id);
    await complete(parent.id);

    const res = await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: child.id,
    });
    expect(res.status).toBe(409);
  });

  it('requires the child to be finished', async () => {
    const [pp, cp] = [await buildable(), await buildable()];
    const parent = await unit(pp, 'SERIAL');
    const child = await unit(cp, 'SERIAL');
    // Still IN_PROGRESS: you cannot build an unfinished thing into a product.
    const res = await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: child.id,
    });
    expect(res.status).toBe(409);
  });

  it('rejects a unit consuming itself', async () => {
    const part = await buildable();
    const u = await unit(part, 'SERIAL');
    expect(
      (await engineer.post(`/api/build-units/${u.id}/as-built`, { childId: u.id })).status
    ).toBe(409);
  });

  it('rejects closing a transitive cycle', async () => {
    // Reaching this through the API alone is impossible: a descendant is always COMPLETED (a
    // child must be finished to be consumed) and cannot be reopened while a parent holds it,
    // so it can never become the IN_PROGRESS parent that would close the loop. The edges are
    // therefore seeded directly, which is the only way to exercise the cycle check itself
    // rather than the guards standing in front of it.
    const parts = await Promise.all([buildable(), buildable(), buildable()]);
    const [a, b, c] = await Promise.all(parts.map((p) => unit(p, 'SERIAL')));

    await prisma.asBuiltLine.createMany({
      data: [
        { parentId: a.id, childId: b.id, quantity: 1, recordedById: engineer.id },
        { parentId: b.id, childId: c.id, quantity: 1, recordedById: engineer.id },
      ],
    });
    // a is an ancestor of c; make a consumable and c a legal parent.
    await prisma.buildUnit.update({ where: { id: a.id }, data: { status: 'COMPLETED' } });

    const res = await engineer.post(`/api/build-units/${c.id}/as-built`, { childId: a.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cycle/i);
  });

  it('allows one SERIAL child only one parent', async () => {
    const parts = await Promise.all([buildable(), buildable(), buildable()]);
    const [p1, p2, child] = await Promise.all(parts.map((p) => unit(p, 'SERIAL')));
    await complete(child.id);

    expect(
      (await engineer.post(`/api/build-units/${p1.id}/as-built`, { childId: child.id })).status
    ).toBe(201);
    const res = await engineer.post(`/api/build-units/${p2.id}/as-built`, { childId: child.id });
    // One physical object is in one place.
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already');
  });

  it('splits a LOT across parents up to its quantity, then refuses', async () => {
    const [pp, lotPart] = [await buildable(), await buildable()];
    const lot = await unit(lotPart, 'LOT', 10);
    await complete(lot.id);

    const parents = await Promise.all([unit(pp, 'SERIAL'), unit(pp, 'SERIAL')]);
    expect(
      (
        await engineer.post(`/api/build-units/${parents[0].id}/as-built`, {
          childId: lot.id,
          quantity: 6,
        })
      ).status
    ).toBe(201);
    const overdraw = await engineer.post(`/api/build-units/${parents[1].id}/as-built`, {
      childId: lot.id,
      quantity: 6,
    });
    expect(overdraw.status).toBe(409);
    // The message must say what is left, not merely that it failed.
    expect(overdraw.body.error).toMatch(/4/);
  });

  it('computes substitution rather than trusting the request', async () => {
    const assembly = await buildable();
    const planned = await createReleasedPart({ createdById: engineer.id });
    const actual = await createReleasedPart({ createdById: engineer.id });
    const line = await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: planned.id,
      quantity: 1,
    });

    const parent = await unit(assembly, 'SERIAL');
    const substitute = await unit(actual, 'SERIAL');
    await complete(substitute.id);

    const res = await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: substitute.id,
      bomLineId: line.id,
      // Deliberately lying: the server must ignore this and compute the truth.
      substitution: false,
    });
    expect(res.status).toBe(201);
    const recorded = res.body.asBuiltLines.find(
      (l: { child: { id: number } }) => l.child.id === substitute.id
    );
    expect(recorded.substitution).toBe(true);
  });

  it('records an unplanned consumption when no BOM line is given', async () => {
    const [pp, cp] = [await buildable(), await buildable()];
    const parent = await unit(pp, 'SERIAL');
    const child = await unit(cp, 'SERIAL');
    await complete(child.id);
    const res = await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: child.id,
    });
    // Reality is what is being recorded; an unplanned draw is allowed and flagged later.
    expect(res.status).toBe(201);
    expect(res.body.asBuiltLines[0].bomLine).toBeNull();
    expect(res.body.asBuiltLines[0].substitution).toBe(false);
  });

  it('rejects a BOM line from a different revision', async () => {
    const other = await buildable();
    const foreignChild = await createReleasedPart({ createdById: engineer.id });
    const foreignLine = await addBomLine({
      parentRevisionId: other.revisionId,
      childPartId: foreignChild.id,
      quantity: 1,
    });

    const assembly = await buildable();
    const parent = await unit(assembly, 'SERIAL');
    const child = await unit(foreignChild, 'SERIAL');
    await complete(child.id);

    const res = await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: child.id,
      bomLineId: foreignLine.id,
    });
    expect(res.status).toBe(400);
  });

  it('refuses to shrink a lot below what parents already consumed', async () => {
    const [pp, lotPart] = [await buildable(), await buildable()];
    const lot = await unit(lotPart, 'LOT', 10);
    await complete(lot.id);
    const parent = await unit(pp, 'SERIAL');
    await engineer.post(`/api/build-units/${parent.id}/as-built`, {
      childId: lot.id,
      quantity: 8,
    });

    // Shrinking below 8 would leave the parent's record claiming stock that never existed.
    expect((await engineer.patch(`/api/build-units/${lot.id}`, { quantity: 5 })).status).toBe(409);
    expect((await engineer.patch(`/api/build-units/${lot.id}`, { quantity: 9 })).status).toBe(200);
  });
});

describe('rule U4 — genealogy and the recall query', () => {
  /** lot -> two packs -> two drones, one drone shipped. The scenario the module exists for. */
  async function scenario() {
    const [cellPart, packPart, dronePart] = await Promise.all([
      buildable({ name: 'Cell' }),
      buildable({ name: 'Pack' }),
      buildable({ name: 'Drone' }),
    ]);
    const lot = await unit(cellPart, 'LOT', 40);
    await complete(lot.id);

    const packs = [await unit(packPart, 'SERIAL'), await unit(packPart, 'SERIAL')];
    for (const pack of packs) {
      await engineer.post(`/api/build-units/${pack.id}/as-built`, {
        childId: lot.id,
        quantity: 4,
      });
      await complete(pack.id);
    }
    const drones = [await unit(dronePart, 'SERIAL'), await unit(dronePart, 'SERIAL')];
    for (const [i, drone] of drones.entries()) {
      await engineer.post(`/api/build-units/${drone.id}/as-built`, { childId: packs[i].id });
      await complete(drone.id);
    }
    await engineer.post(`/api/build-units/${drones[0].id}/transition`, { action: 'ship' });
    return { lot, packs, drones };
  }

  it('walks the full genealogy down from a top unit', async () => {
    const { lot, packs, drones } = await scenario();
    const res = await engineer.get(`/api/build-units/${drones[0].id}/genealogy`);
    expect(res.status).toBe(200);
    // The response IS the root node, not a wrapper.
    expect(res.body.unit.id).toBe(drones[0].id);
    expect(res.body.quantity).toBeNull();

    const ids: number[] = [];
    const walk = (n: { unit: { id: number }; children: unknown[] }) => {
      ids.push(n.unit.id);
      for (const c of n.children as typeof n[]) walk(c);
    };
    walk(res.body);
    expect(ids).toContain(packs[0].id);
    expect(ids).toContain(lot.id);
  });

  it('finds every unit a suspect lot ended up in, exactly once', async () => {
    const { lot, packs, drones } = await scenario();
    const res = await engineer.get(`/api/build-units/${lot.id}/where-consumed`);
    expect(res.status).toBe(200);

    const ids = res.body.units.map((e: { unit: { id: number } }) => e.unit.id);
    expect(new Set(ids)).toEqual(new Set([...packs.map((p) => p.id), ...drones.map((d) => d.id)]));
    // A unit reachable by more than one route must still appear once.
    expect(ids.length).toBe(new Set(ids).size);
    expect(res.body.counts.total).toBe(4);
  });

  it('names only the shipped units as the actionable set', async () => {
    const { lot, drones } = await scenario();
    const res = await engineer.get(`/api/build-units/${lot.id}/where-consumed`);
    expect(res.body.shippedUnits).toHaveLength(1);
    expect(res.body.shippedUnits[0].unit.id).toBe(drones[0].id);
    expect(res.body.counts.shipped).toBe(1);
  });

  it('carries the hop path from the queried unit to each ancestor', async () => {
    const { lot, packs, drones } = await scenario();
    const res = await engineer.get(`/api/build-units/${lot.id}/where-consumed`);
    const drone = res.body.units.find(
      (e: { unit: { id: number } }) => e.unit.id === drones[0].id
    );
    expect(drone.depth).toBe(2);
    expect(drone.path).toHaveLength(2);
    expect(drone.path.map((s: { unit: { id: number } }) => s.unit.id)).toEqual([
      packs[0].id,
      drones[0].id,
    ]);
  });

  it('404s an unknown unit on both traces', async () => {
    for (const path of ['genealogy', 'where-consumed']) {
      expect((await engineer.get(`/api/build-units/999999/${path}`)).status).toBe(404);
    }
  });
});

describe('rule U5 — as-built versus as-designed', () => {
  it('reports MISSING for an eBOM line nothing satisfied', async () => {
    const assembly = await buildable();
    const child = await createReleasedPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 2 });

    const built = await unit(assembly, 'SERIAL');
    const res = await engineer.get(`/api/build-units/${built.id}/deviations`);
    expect(res.status).toBe(200);
    expect(res.body.hasEbom).toBe(true);
    const row = res.body.rows.find(
      (r: { part: { id: number } }) => r.part.id === child.id
    );
    expect(row.status).toBe('MISSING');
    expect(row.plannedQuantity).toBe(2);
    expect(row.builtQuantity).toBeNull();
  });

  it('reports UNPLANNED for a consumption with no eBOM line', async () => {
    const assembly = await buildable();
    const rogue = await createReleasedPart({ createdById: engineer.id });
    const built = await unit(assembly, 'SERIAL');
    const child = await unit(rogue, 'SERIAL');
    await complete(child.id);
    await engineer.post(`/api/build-units/${built.id}/as-built`, { childId: child.id });

    const res = await engineer.get(`/api/build-units/${built.id}/deviations`);
    const row = res.body.rows.find((r: { part: { id: number } }) => r.part.id === rogue.id);
    expect(row.status).toBe('UNPLANNED');
    expect(row.plannedQuantity).toBeNull();
  });

  it('reports MATCH when the build follows the eBOM', async () => {
    const assembly = await buildable();
    const child = await createReleasedPart({ createdById: engineer.id });
    const line = await addBomLine({
      parentRevisionId: assembly.revisionId,
      childPartId: child.id,
      quantity: 1,
    });
    const built = await unit(assembly, 'SERIAL');
    const consumed = await unit(child, 'SERIAL');
    await complete(consumed.id);
    await engineer.post(`/api/build-units/${built.id}/as-built`, {
      childId: consumed.id,
      bomLineId: line.id,
    });

    const res = await engineer.get(`/api/build-units/${built.id}/deviations`);
    const row = res.body.rows.find((r: { part: { id: number } }) => r.part.id === child.id);
    expect(row.status).toBe('MATCH');
    expect(res.body.counts.match).toBeGreaterThanOrEqual(1);
  });

  it('scales the planned quantity by the build quantity of a lot', async () => {
    // An eBOM quantity is per assembly, so a lot of 5 is expected to draw 5x the line.
    const assembly = await buildable();
    const child = await createReleasedPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: assembly.revisionId, childPartId: child.id, quantity: 3 });

    const built = await unit(assembly, 'LOT', 5);
    const res = await engineer.get(`/api/build-units/${built.id}/deviations`);
    expect(res.body.buildQuantity).toBe(5);
    const row = res.body.rows.find((r: { part: { id: number } }) => r.part.id === child.id);
    expect(row.plannedQuantity).toBe(15);
  });
});

describe('rule U6 — unit effectivity on changes', () => {
  it('accepts a serial cut-in', async () => {
    const res = await engineer.post('/api/ecns', {
      title: 'Cut in at a serial',
      effectiveFromSerial: 'S/N 0042',
    });
    expect(res.status).toBe(201);
    expect(res.body.effectiveFromSerial).toBe('S/N 0042');
  });

  it('refuses both effectivity kinds at once, in either order', async () => {
    const withSerial = await engineer.post('/api/ecns', {
      title: 'A',
      effectiveFromSerial: 'S/N 1',
    });
    expect(
      (
        await engineer.patch(`/api/ecns/${withSerial.body.id}`, {
          effectivityDate: '2026-09-01T00:00:00.000Z',
        })
      ).status
    ).toBe(400);

    const withDate = await engineer.post('/api/ecns', {
      title: 'B',
      effectivityDate: '2026-09-01T00:00:00.000Z',
    });
    // The check must consider the resulting state, not just the fields in the body.
    expect(
      (await engineer.patch(`/api/ecns/${withDate.body.id}`, { effectiveFromSerial: 'S/N 2' }))
        .status
    ).toBe(400);
  });

  it('does not stamp a date cut-in on release when a serial cut-in is set', async () => {
    // Regression: release defaulted effectivityDate to now unconditionally, permanently
    // producing the both-set state this rule exists to forbid.
    const admin = await createAndLogin({ role: Role.ADMIN });
    const part = await createReleasedPart({ createdById: admin.id });
    const ecn = await admin.post('/api/ecns', {
      title: 'Serial cut-in release',
      effectiveFromSerial: 'S/N 0100',
    });
    const item = await admin.post(`/api/ecns/${ecn.body.id}/items`, { partId: part.id });
    await admin.post(`/api/ecn-items/${item.body.id}/revision`);
    await admin.post(`/api/ecns/${ecn.body.id}/transition`, { action: 'submit' });
    await admin.post(`/api/ecns/${ecn.body.id}/transition`, { action: 'approve' });
    const released = await admin.post(`/api/ecns/${ecn.body.id}/transition`, {
      action: 'release',
    });

    expect(released.status).toBe(200);
    expect(released.body.effectiveFromSerial).toBe('S/N 0100');
    expect(released.body.effectivityDate).toBeNull();
  });

  it('still stamps a date on release when no serial cut-in is set', async () => {
    const admin = await createAndLogin({ role: Role.ADMIN });
    const part = await createReleasedPart({ createdById: admin.id });
    const ecn = await admin.post('/api/ecns', { title: 'Plain release' });
    const item = await admin.post(`/api/ecns/${ecn.body.id}/items`, { partId: part.id });
    await admin.post(`/api/ecn-items/${item.body.id}/revision`);
    await admin.post(`/api/ecns/${ecn.body.id}/transition`, { action: 'submit' });
    await admin.post(`/api/ecns/${ecn.body.id}/transition`, { action: 'approve' });
    const released = await admin.post(`/api/ecns/${ecn.body.id}/transition`, {
      action: 'release',
    });
    expect(released.body.effectivityDate).not.toBeNull();
  });
});

describe('rule U7 — quality linkage', () => {
  it('links a nonconformance to a build unit and surfaces it on the unit', async () => {
    const part = await buildable();
    const lot = await unit(part, 'LOT', 20);

    const ncr = await engineer.post('/api/ncrs', {
      title: 'Cells below capacity',
      description: 'Lot suspect',
      severity: 'MAJOR',
      buildUnitId: lot.id,
    });
    expect(ncr.status).toBe(201);

    const detail = await engineer.get(`/api/build-units/${lot.id}`);
    expect(detail.body.nonconformances).toHaveLength(1);
    expect(detail.body.nonconformances[0].ncrNumber).toBe(ncr.body.ncrNumber);
  });

  it('rejects an unknown build unit', async () => {
    const res = await engineer.post('/api/ncrs', {
      title: 'Bad reference',
      description: 'x',
      buildUnitId: 999999,
    });
    expect(res.status).toBe(400);
  });

  it('leaves the free-text lot/serial field untouched', async () => {
    // Records that predate a tracked unit keep working.
    const res = await engineer.post('/api/ncrs', {
      title: 'Historical',
      description: 'x',
      lotOrSerial: 'L-2291',
    });
    expect(res.status).toBe(201);
    expect(res.body.lotOrSerial).toBe('L-2291');
  });
});

describe('build units respect the write role', () => {
  it('blocks a viewer from every mutation', async () => {
    const part = await buildable();
    const u = await unit(part, 'SERIAL');
    const viewer = await createAndLogin({ role: Role.VIEWER });

    expect(
      (
        await viewer.post('/api/build-units', {
          kind: 'SERIAL',
          partId: part.id,
          partRevisionId: part.revisionId,
        })
      ).status
    ).toBe(403);
    expect((await viewer.patch(`/api/build-units/${u.id}`, { notes: 'no' })).status).toBe(403);
    expect(
      (await viewer.post(`/api/build-units/${u.id}/transition`, { action: 'complete' })).status
    ).toBe(403);
    // Reads stay open.
    expect((await viewer.get(`/api/build-units/${u.id}`)).status).toBe(200);
    expect((await viewer.get(`/api/build-units/${u.id}/genealogy`)).status).toBe(200);
  });
});
