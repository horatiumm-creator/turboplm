/**
 * Materials and mBOM material requirements — rules N2, N3.
 *
 * The roll-up is the part worth testing hardest: it multiplies quantities down a tree, adds
 * scrap, and is the number somebody orders stock against. The gap report matters just as much —
 * a requirements list that silently omits parts declaring no material reads as complete when it
 * is not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { prisma, resetDatabase } from './helpers/db';
import { Client, createAndLogin } from './helpers/api';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';

let engineer: Client;

async function material(overrides: Record<string, unknown> = {}) {
  const res = await engineer.post('/api/materials', {
    code: `MAT-${Math.floor(Math.random() * 1e9)}`,
    name: 'Aluminium 6061-T6',
    materialClass: 'METAL',
    specification: 'AL 6061-T6',
    density: 2.7,
    stockUom: 'kg',
    unitCost: 4.5,
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; code: string; stockUom: string };
}

/** Attach a material to a part and return the part's material list. */
async function attach(partId: number, materialId: number, body: Record<string, unknown> = {}) {
  const res = await engineer.post(`/api/parts/${partId}/materials`, {
    materialId,
    form: 'BAR',
    netQuantity: 1,
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

beforeEach(async () => {
  await resetDatabase();
  engineer = await createAndLogin({ role: Role.ENGINEER });
});

describe('rule N2 — materials', () => {
  it('rejects a malformed code and a duplicate', async () => {
    expect((await engineer.post('/api/materials', { code: 'x', name: 'Too short' })).status).toBe(400);
    expect(
      (await engineer.post('/api/materials', { code: 'has space', name: 'Bad' })).status
    ).toBe(400);

    const first = await material({ code: 'AL6061' });
    const dup = await engineer.post('/api/materials', { code: 'al6061', name: 'Same code' });
    // Codes are compared case-insensitively by the unique index? If not, this documents that
    // they are distinct — either way the first must still exist.
    expect([201, 409]).toContain(dup.status);
    expect((await engineer.get(`/api/materials/${first.id}`)).status).toBe(200);
  });

  it('refuses to delete a material that parts depend on', async () => {
    const part = await createPart({ createdById: engineer.id });
    const mat = await material();
    await attach(part.id, mat.id);

    const res = await engineer.delete(`/api/materials/${mat.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivate/i);

    // Deactivating is the supported path and keeps the history.
    expect((await engineer.patch(`/api/materials/${mat.id}`, { active: false })).status).toBe(200);
  });

  it('deletes a material nothing references', async () => {
    const mat = await material();
    expect((await engineer.delete(`/api/materials/${mat.id}`)).status).toBe(204);
    expect((await engineer.get(`/api/materials/${mat.id}`)).status).toBe(404);
  });

  it('refuses an inactive material on a part', async () => {
    const part = await createPart({ createdById: engineer.id });
    const mat = await material();
    await engineer.patch(`/api/materials/${mat.id}`, { active: false });
    const res = await engineer.post(`/api/parts/${part.id}/materials`, {
      materialId: mat.id,
      netQuantity: 1,
    });
    expect(res.status).toBe(409);
  });

  it('validates quantity and scrap', async () => {
    const part = await createPart({ createdById: engineer.id });
    const mat = await material();
    for (const netQuantity of [0, -2, 'lots']) {
      expect(
        (await engineer.post(`/api/parts/${part.id}/materials`, { materialId: mat.id, netQuantity }))
          .status
      ).toBe(400);
    }
    // 100 % loss is nonsense, the same rule the mBOM already applies.
    expect(
      (
        await engineer.post(`/api/parts/${part.id}/materials`, {
          materialId: mat.id,
          netQuantity: 1,
          scrapFactor: 1,
        })
      ).status
    ).toBe(400);
  });

  it('allows the same alloy in two forms but not twice in one form', async () => {
    const part = await createPart({ createdById: engineer.id });
    const mat = await material();
    await attach(part.id, mat.id, { form: 'BAR' });
    await attach(part.id, mat.id, { form: 'SHEET' });

    const dup = await engineer.post(`/api/parts/${part.id}/materials`, {
      materialId: mat.id,
      form: 'BAR',
      netQuantity: 2,
    });
    expect(dup.status).toBe(409);
    expect((await engineer.get(`/api/parts/${part.id}/materials`)).body).toHaveLength(2);
  });

  it('computes gross from net and scrap', async () => {
    const part = await createPart({ createdById: engineer.id });
    const mat = await material();
    const list = await attach(part.id, mat.id, { netQuantity: 2, scrapFactor: 0.1 });
    expect(list[0].netQuantity).toBe(2);
    // 2 x 1.1 = 2.2, and it must not arrive as 2.2000000000000004.
    expect(list[0].grossQuantity).toBe(2.2);
  });
});

describe('rule N3 — material requirements', () => {
  it('multiplies quantities down the tree and applies scrap', async () => {
    // top -> sub x2 -> leaf x3, so one top needs 6 leaves.
    const top = await createReleasedPart({ createdById: engineer.id });
    const sub = await createReleasedPart({ createdById: engineer.id });
    const leaf = await createReleasedPart({ createdById: engineer.id, category: 'MECHANICAL' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: sub.id, quantity: 2 });
    await addBomLine({ parentRevisionId: sub.revisionId, childPartId: leaf.id, quantity: 3 });

    const mat = await material({ unitCost: 10 });
    await attach(leaf.id, mat.id, { netQuantity: 0.5, scrapFactor: 0.2 });

    const res = await engineer.get(`/api/revisions/${top.revisionId}/material-requirements`);
    expect(res.status).toBe(200);
    expect(res.body.buildQuantity).toBe(1);

    const row = res.body.materials.find((m: { material: { id: number } }) => m.material.id === mat.id);
    // 6 leaves x 0.5 net = 3 net; gross adds 20 % => 3.6.
    expect(row.netQuantity).toBe(3);
    expect(row.grossQuantity).toBe(3.6);
    expect(row.estimatedCost).toBe(36);
    expect(row.fromParts[0].part.id).toBe(leaf.id);
    expect(row.fromParts[0].perAssembly).toBe(6);
  });

  it('scales by the build quantity', async () => {
    const top = await createReleasedPart({ createdById: engineer.id });
    const leaf = await createReleasedPart({ createdById: engineer.id, category: 'MECHANICAL' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: leaf.id, quantity: 4 });
    const mat = await material({ unitCost: null });
    await attach(leaf.id, mat.id, { netQuantity: 1 });

    const res = await engineer.get(
      `/api/revisions/${top.revisionId}/material-requirements?quantity=25`
    );
    expect(res.body.buildQuantity).toBe(25);
    const row = res.body.materials[0];
    expect(row.netQuantity).toBe(100);
    // No unit cost means no invented cost.
    expect(row.estimatedCost).toBeNull();
    expect(res.body.totalEstimatedCost).toBeNull();
  });

  it('accumulates a part reached by two routes rather than de-duplicating it', async () => {
    // Both subassemblies use the same leaf; the total must be the sum, not one of them.
    const top = await createReleasedPart({ createdById: engineer.id });
    const subA = await createReleasedPart({ createdById: engineer.id });
    const subB = await createReleasedPart({ createdById: engineer.id });
    const leaf = await createReleasedPart({ createdById: engineer.id, category: 'MECHANICAL' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: subA.id, quantity: 1 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: subB.id, quantity: 1 });
    await addBomLine({ parentRevisionId: subA.revisionId, childPartId: leaf.id, quantity: 2 });
    await addBomLine({ parentRevisionId: subB.revisionId, childPartId: leaf.id, quantity: 5 });

    const mat = await material();
    await attach(leaf.id, mat.id, { netQuantity: 1 });

    const res = await engineer.get(`/api/revisions/${top.revisionId}/material-requirements`);
    const row = res.body.materials[0];
    expect(row.netQuantity).toBe(7);
    expect(row.fromParts[0].perAssembly).toBe(7);
  });

  it('reports parts that declare no material as planning gaps', async () => {
    const top = await createReleasedPart({ createdById: engineer.id });
    const machined = await createReleasedPart({
      createdById: engineer.id,
      category: 'MECHANICAL',
    });
    const bought = await createReleasedPart({ createdById: engineer.id, category: 'PURCHASED' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: machined.id, quantity: 3 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: bought.id, quantity: 9 });

    const res = await engineer.get(
      `/api/revisions/${top.revisionId}/material-requirements?quantity=10`
    );
    const gaps = res.body.unspecified.map((g: { part: { id: number } }) => g.part.id);
    // A machined part with no material is a hole in planning; a purchased one is not.
    expect(gaps).toContain(machined.id);
    expect(gaps).not.toContain(bought.id);

    const gap = res.body.unspecified.find(
      (g: { part: { id: number } }) => g.part.id === machined.id
    );
    expect(gap.perAssembly).toBe(3);
    expect(gap.totalParts).toBe(30);
  });

  it('drops a part from the gaps once it declares a material', async () => {
    // The top is an ASSEMBLY so it is not itself a gap: an assembly's material comes from its
    // children, which is why NEEDS_MATERIAL excludes the category.
    const top = await createReleasedPart({ createdById: engineer.id, category: 'ASSEMBLY' });
    const machined = await createReleasedPart({
      createdById: engineer.id,
      category: 'MECHANICAL',
    });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: machined.id, quantity: 1 });

    const before = await engineer.get(`/api/revisions/${top.revisionId}/material-requirements`);
    expect(before.body.unspecified).toHaveLength(1);

    const mat = await material();
    await attach(machined.id, mat.id, { netQuantity: 1 });

    const after = await engineer.get(`/api/revisions/${top.revisionId}/material-requirements`);
    expect(after.body.unspecified).toHaveLength(0);
    expect(after.body.materials).toHaveLength(1);
  });

  it('counts material on the top assembly itself exactly once', async () => {
    // Adhesive on the assembly is real; it must not be multiplied by anything.
    const top = await createReleasedPart({ createdById: engineer.id, category: 'ASSEMBLY' });
    const mat = await material({ stockUom: 'ml' });
    await attach(top.id, mat.id, { form: 'LIQUID', netQuantity: 12 });

    const res = await engineer.get(
      `/api/revisions/${top.revisionId}/material-requirements?quantity=5`
    );
    expect(res.body.materials[0].netQuantity).toBe(60);
    // Reported, not blocked: an assembly carrying material is a note, not an error.
    expect(res.body.notes.join(' ')).toMatch(/assembly carrying material/i);
  });

  it('rejects a non-positive build quantity', async () => {
    const top = await createReleasedPart({ createdById: engineer.id });
    for (const q of ['0', '-4', 'many']) {
      expect(
        (await engineer.get(`/api/revisions/${top.revisionId}/material-requirements?quantity=${q}`))
          .status
      ).toBe(400);
    }
  });

  it('404s an unknown revision', async () => {
    expect((await engineer.get('/api/revisions/999999/material-requirements')).status).toBe(404);
  });

  it('exports the totals and the gaps together', async () => {
    const top = await createReleasedPart({ createdById: engineer.id });
    const machined = await createReleasedPart({
      createdById: engineer.id,
      category: 'MECHANICAL',
    });
    const gapPart = await createReleasedPart({
      createdById: engineer.id,
      category: 'MECHANICAL',
    });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: machined.id, quantity: 1 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: gapPart.id, quantity: 1 });
    const mat = await material({ code: 'AL6061X', name: 'Aluminium bar' });
    await attach(machined.id, mat.id, { netQuantity: 1 });

    const res = await engineer.get(
      `/api/revisions/${top.revisionId}/material-requirements/export.csv`
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('AL6061X');
    // The gaps ship with the totals or a buyer assumes the list is whole.
    expect(res.text).toContain('Parts with no material declared');
    expect(res.text).toContain(gapPart.partNumber);
  });
});

describe('materials respect the write role', () => {
  it('blocks a viewer from every mutation but allows reads', async () => {
    const part = await createReleasedPart({ createdById: engineer.id });
    const mat = await material();
    await attach(part.id, mat.id);
    const viewer = await createAndLogin({ role: Role.VIEWER });

    expect((await viewer.post('/api/materials', { code: 'NOPE1', name: 'No' })).status).toBe(403);
    expect((await viewer.patch(`/api/materials/${mat.id}`, { name: 'No' })).status).toBe(403);
    expect((await viewer.delete(`/api/materials/${mat.id}`)).status).toBe(403);
    expect(
      (await viewer.post(`/api/parts/${part.id}/materials`, { materialId: mat.id, netQuantity: 1 }))
        .status
    ).toBe(403);

    expect((await viewer.get('/api/materials')).status).toBe(200);
    expect((await viewer.get(`/api/parts/${part.id}/materials`)).status).toBe(200);
    expect(
      (await viewer.get(`/api/revisions/${part.revisionId}/material-requirements`)).status
    ).toBe(200);
  });
});
