/**
 * The recursive upward walk — `lib/whereUsed.ts`.
 *
 * Why it exists: `GET /parts/:id/where-used` and `GET /ecns/:id/impact` both answer one level,
 * which cannot settle the question where-used is for — "is it safe to change this part?" A
 * bearing rail used by every track section shows you the sections, never the products those
 * sections end up in, and the product is the thing a change actually breaks.
 *
 * WHY THIS DRIVES THE FUNCTION AND NOT AN ENDPOINT. The hosted build exposes
 * `GET /parts/:id/where-used/tree` and tests the walk through it. This build has no such
 * route: `walkWhereUsed` has exactly one caller, `lib/changeBrief.ts`. Testing it only
 * through the brief would mean every assertion about depth caps, cycles and nearest-level
 * reporting had to be read out of a brief's `products` array, which carries just the
 * top-level subset — so the interesting cases would be untestable or vacuous. So the walk is
 * driven directly, and the last two cases go through the brief to prove the wiring is real.
 *
 * TWO THINGS FROM THE HOSTED SUITE ARE ABSENT, deliberately, and neither is a test gap:
 *
 *  1. Revision narrowing. There, `walkWhereUsed(partId, revisionId, user)` can answer "which
 *     assemblies hold this exact revision", because a BOM line is pinned to a child revision
 *     at release. Here a line names a PART and nothing records the pin, so there is no such
 *     question to ask and the signature has no `revisionId`.
 *  2. The obsolete guard. There, retiring a revision a released assembly still contains is
 *     refused unless the caller passes `acknowledgeInUse`, and the walk is what makes that
 *     refusal precise. This build has no such guard — `grep acknowledgeInUse src/` finds
 *     nothing — so `POST /revisions/:id/transition {action:'obsolete'}` always succeeds. That
 *     is a product difference to decide about, not something a test can assert, and the
 *     change-brief suite records the same difference where it meets it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AclUser, REDACTED } from '../src/lib/acl';
import { MAX_TREE_DEPTH, walkWhereUsed } from '../src/lib/whereUsed';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';

let engineer: Client;
let asEngineer: AclUser;

beforeEach(async () => {
  engineer = await createAndLogin({ role: 'ENGINEER' });
  asEngineer = { id: engineer.id, role: 'ENGINEER' };
});

async function release(revisionId: number) {
  expect(
    (await engineer.post(`/api/revisions/${revisionId}/transition`, { action: 'submit' })).status
  ).toBe(200);
  expect(
    (await engineer.post(`/api/revisions/${revisionId}/transition`, { action: 'approve' })).status
  ).toBe(200);
}

/** leaf <- sub <- top. */
async function threeLevels() {
  const leaf = await createReleasedPart({
    createdById: engineer.id,
    partNumber: `LEAF-${Date.now()}`,
  });
  const sub = await createPart({ createdById: engineer.id, partNumber: `SUB-${Date.now()}` });
  const top = await createPart({ createdById: engineer.id, partNumber: `TOP-${Date.now()}` });
  await addBomLine({ parentRevisionId: sub.revisionId, childPartId: leaf.id, quantity: 2 });
  await release(sub.revisionId);
  await addBomLine({ parentRevisionId: top.revisionId, childPartId: sub.id, quantity: 1 });
  await release(top.revisionId);
  return { leaf, sub, top };
}

describe('recursive where-used', () => {
  it('reaches the product, not just the direct parent', async () => {
    const { leaf, sub, top } = await threeLevels();

    // The old one-level answer, through the endpoint that still gives it: the sub-assembly.
    const flat = await engineer.get(`/api/parts/${leaf.id}/where-used`);
    expect(flat.status).toBe(200);
    expect(flat.body).toHaveLength(1);
    expect(flat.body[0].parentPart.id).toBe(sub.id);

    // The recursive walk reaches the top.
    const tree = await walkWhereUsed(leaf.id, asEngineer);
    const ids = tree.used.map((n) => n.parentPart.id);
    expect(ids).toContain(sub.id);
    expect(ids).toContain(top.id);
  });

  it('names the products as top level and nothing else', async () => {
    const { leaf, sub, top } = await threeLevels();
    const tree = await walkWhereUsed(leaf.id, asEngineer);
    const tops = tree.topLevel.map((n) => n.parentPart.id);
    expect(tops).toEqual([top.id]);
    expect(tops).not.toContain(sub.id);
  });

  it('reports how far up each assembly sits, and the path taken', async () => {
    const { leaf, sub, top } = await threeLevels();
    const tree = await walkWhereUsed(leaf.id, asEngineer);
    const byId = new Map(tree.used.map((n) => [n.parentPart.id, n]));
    expect(byId.get(sub.id)!.level).toBe(1);
    expect(byId.get(top.id)!.level).toBe(2);
    expect(byId.get(top.id)!.path).toEqual([leaf.partNumber, sub.partNumber, top.partNumber]);
  });

  it('returns nothing for a part nobody uses', async () => {
    const orphan = await createPart({ createdById: engineer.id });
    const tree = await walkWhereUsed(orphan.id, asEngineer);
    expect(tree.used).toEqual([]);
    expect(tree.topLevel).toEqual([]);
  });

  /*
   * An assembly reachable by a short route and a long one is reported at the SHORT one.
   *
   * The `expanded` guard is what makes this true. Without it the breadth-first walk reaches
   * the product again one level deeper and overwrites the nearer entry, so a product sitting
   * directly on the part would be reported as two levels up — an engineer reads that as a
   * distant consequence of the change rather than an immediate one. (The results map is keyed
   * by revision, so it deduplicates on its own; it does not order by distance.)
   */
  it('reports an assembly at its nearest level, not a longer route to it', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const sub = await createPart({ createdById: engineer.id });
    const top = await createPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: sub.revisionId, childPartId: leaf.id, quantity: 1 });
    await release(sub.revisionId);
    // The product contains the leaf BOTH directly and through the sub-assembly.
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: leaf.id, quantity: 1 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: sub.id, quantity: 1 });
    await release(top.revisionId);

    const tree = await walkWhereUsed(leaf.id, asEngineer);
    const rows = tree.used.filter((n) => n.parentPart.id === top.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe(1);
  });

  /*
   * A cycle is not supposed to exist — the BOM writer refuses to create one — but the walk
   * must not be the thing that discovers that by hanging. Written straight to the table to get
   * past the writer's own guard, which is the only way the data could arrive from a restore or
   * an older import.
   */
  it('terminates when the stored BOM contains a cycle', async () => {
    const a = await createPart({ createdById: engineer.id });
    const b = await createPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: a.revisionId, childPartId: b.id, quantity: 1 });
    await addBomLine({ parentRevisionId: b.revisionId, childPartId: a.id, quantity: 1 });

    const tree = await walkWhereUsed(a.id, asEngineer);
    // Two assemblies exist, so the walk reports at most two rows and stops.
    expect(tree.used.length).toBeLessThanOrEqual(2);
  }, 15_000);

  /*
   * The cap bounds the answer, and SAYS SO. A chain deeper than the cap is unusual, but a
   * truncated answer that looks complete is the failure that matters: the engineer reads
   * "these are the products affected" off a list that stops short of them. The note is the
   * only thing standing between those two readings, so it is part of the contract — asserting
   * the depth alone would pass just as well with the note deleted.
   */
  it('stops at the depth cap and says the answer is incomplete', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    let childId = leaf.id;
    const chain: number[] = [];
    for (let i = 0; i < MAX_TREE_DEPTH + 2; i += 1) {
      const parent = await createPart({ createdById: engineer.id });
      await addBomLine({ parentRevisionId: parent.revisionId, childPartId: childId, quantity: 1 });
      chain.push(parent.id);
      childId = parent.id;
    }

    const tree = await walkWhereUsed(leaf.id, asEngineer);
    expect(Math.max(...tree.used.map((r) => r.level))).toBeLessThanOrEqual(MAX_TREE_DEPTH);
    expect(tree.used.length).toBeLessThan(chain.length);
    expect(tree.notes.join(' ')).toMatch(new RegExp(`${MAX_TREE_DEPTH} levels`));
  }, 60_000);

  /*
   * Rule X4. An empty list would invite breaking a programme the caller cannot see, which is
   * the opposite of what this is for — so the row stays and the name goes.
   */
  it('keeps a restricted consumer as a row and removes its identity', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const owner = await createAndLogin({ role: 'ENGINEER' });
    const secret = await createPart({ createdById: owner.id, partNumber: 'SECRET-WU' });
    await addBomLine({ parentRevisionId: secret.revisionId, childPartId: leaf.id, quantity: 1 });
    await prisma.partAcl.create({
      data: { partId: secret.id, userId: owner.id, grantedById: owner.id },
    });

    const tree = await walkWhereUsed(leaf.id, asEngineer);
    expect(tree.used).toHaveLength(1);
    expect(JSON.stringify(tree)).not.toContain('SECRET-WU');
    expect(tree.used[0].parentPart.partNumber).toBe(REDACTED.partNumber);
  });

  /*
   * The path is the other way a name escapes. A product the caller MAY read, reached THROUGH a
   * sub-assembly it may not, prints that sub-assembly in its path unless each segment is
   * judged on its own part — which would leak through the route exactly what the redacted row
   * above refuses to leak directly.
   */
  it("removes a restricted intermediate from a visible assembly's path", async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const owner = await createAndLogin({ role: 'ENGINEER' });
    const secretSub = await createPart({ createdById: owner.id, partNumber: 'SECRET-MID' });
    const top = await createPart({
      createdById: engineer.id,
      partNumber: `TOP-MID-${Date.now()}`,
    });
    await addBomLine({ parentRevisionId: secretSub.revisionId, childPartId: leaf.id, quantity: 1 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: secretSub.id, quantity: 1 });
    await prisma.partAcl.create({
      data: { partId: secretSub.id, userId: owner.id, grantedById: owner.id },
    });

    const tree = await walkWhereUsed(leaf.id, asEngineer);
    const visibleTop = tree.used.find((n) => n.parentPart.id === top.id);
    // The caller may read the product, so its own name stays...
    expect(visibleTop!.path.at(-1)).toBe(top.partNumber);
    // ...but the route it was reached by does not name the restricted step.
    expect(visibleTop!.path).not.toContain('SECRET-MID');
    expect(JSON.stringify(tree)).not.toContain('SECRET-MID');
  });
});

/*
 * The two cases that go through a route, so the walk is proven WIRED and not merely correct in
 * isolation. The change brief is its only caller in this build.
 */
describe('the walk as the change brief uses it', () => {
  it('puts the product the walk found into the brief', async () => {
    const { leaf, product } = await (async () => {
      const l = await createReleasedPart({ createdById: engineer.id });
      const s = await createPart({ createdById: engineer.id });
      const p = await createPart({ createdById: engineer.id });
      await addBomLine({ parentRevisionId: s.revisionId, childPartId: l.id, quantity: 1 });
      await release(s.revisionId);
      await addBomLine({ parentRevisionId: p.revisionId, childPartId: s.id, quantity: 1 });
      await release(p.revisionId);
      return { leaf: l, product: p };
    })();

    const created = await engineer.post('/api/ecns', { title: 'Through the brief' });
    const ecnId = created.body.id as number;
    expect((await engineer.post(`/api/ecns/${ecnId}/items`, { partId: leaf.id })).status).toBe(201);

    const res = await engineer.get(`/api/ecns/${ecnId}/change-brief`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const products = (res.body.items[0].products as { id: number; level: number }[]).map(
      (p) => p.id
    );
    expect(products).toEqual([product.id]);
  });

  it('carries the walk s depth note through to the brief', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    let childId = leaf.id;
    for (let i = 0; i < MAX_TREE_DEPTH + 2; i += 1) {
      const parent = await createPart({ createdById: engineer.id });
      await addBomLine({ parentRevisionId: parent.revisionId, childPartId: childId, quantity: 1 });
      childId = parent.id;
    }

    const created = await engineer.post('/api/ecns', { title: 'Deep chain' });
    const ecnId = created.body.id as number;
    expect((await engineer.post(`/api/ecns/${ecnId}/items`, { partId: leaf.id })).status).toBe(201);

    const res = await engineer.get(`/api/ecns/${ecnId}/change-brief`);
    expect(res.status).toBe(200);
    // The brief must not present a truncated walk as a complete answer.
    expect(res.body.notes.join(' ')).toMatch(new RegExp(`${MAX_TREE_DEPTH} levels`));
    expect(res.body.items[0].truncated).toBe(true);
  }, 60_000);
});

/*
 * The UI decides whether a row is redacted by comparing its part number to a literal, which is
 * a string agreement across two packages with nothing checking it. Change the sentinel in
 * `lib/acl.ts` and the where-used views silently go back to rendering restricted rows as links
 * to parts the caller cannot open — a 404 where there should be a tag, and a part id in the
 * URL bar.
 *
 * This is the weakest true thing to assert: the literal the UI tests for is the one the server
 * actually sends.
 */
describe('the redaction sentinel the UI tests for', () => {
  it('is the one the server sends', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../frontend/src/components/part/WhereUsedTab.tsx', import.meta.url);
    /*
     * The one test here that reads across the package boundary, so the one test that can fail
     * for a reason having nothing to do with the code: a checkout with no frontend answers
     * ENOENT, which reads like a broken assertion. CI checks out the whole repo and so does
     * any developer, so absence means something unusual — said plainly rather than left as a
     * stack trace. Not skipped: a skip is how a cross-package check quietly stops running.
     */
    const tab = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw new Error(
        err.code === 'ENOENT'
          ? `Cannot check the redaction sentinel: ${path.pathname} is not present. This test ` +
            'reads the frontend from the backend package; run it from a full checkout.'
          : String(err)
      );
    });
    const check = tab.match(/parentPart\.partNumber === '([^']+)'/);
    expect(check, 'WhereUsedTab no longer compares partNumber to a literal').not.toBeNull();
    expect(check![1]).toBe(REDACTED.partNumber);
  });
});
