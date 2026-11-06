/**
 * GET /ecns/:id/change-brief — what a change actually reaches.
 *
 * The screen whose whole job is answering "what does this change break?" was answering one
 * level up: `/ecns/:id/impact` does `bomLine.findMany({ where: { childPartId } })`, so an
 * engineer assessing a change saw the sub-assemblies and never the products those
 * sub-assemblies go into. The product is the thing a change breaks.
 *
 * Every figure in the brief is RETRIEVED, never inferred. That is what makes the AI narrative
 * layered on top of it defensible: the model is handed this and asked to explain it, not to
 * supply a fact. These tests are therefore the foundation the AI suite stands on — if the
 * brief is wrong, a correct narrative of it is still wrong.
 *
 * ONE DIFFERENCE FROM THE HOSTED BUILD, and it is worth knowing before reading the
 * assertions. `BomLine` here has no `childRevisionId`: a BOM line names a PART, so this build
 * records nothing about which child revision a released parent was built against. The hosted
 * build pins that at release and can therefore report "the assemblies holding the exact
 * revision being replaced". This one cannot, and deliberately does not pretend to — the field
 * is `releasedAssemblies` and it means "released or in-review assemblies that use this part,
 * on any revision" (rule CB2). Several assertions below are correspondingly weaker than their
 * hosted counterparts, and each says so where it matters.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BuildStatus } from '@prisma/client';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin({ role: 'ENGINEER' });
});

async function release(revisionId: number, client: Client = engineer) {
  expect(
    (await client.post(`/api/revisions/${revisionId}/transition`, { action: 'submit' })).status
  ).toBe(200);
  expect(
    (await client.post(`/api/revisions/${revisionId}/transition`, { action: 'approve' })).status
  ).toBe(200);
}

/** An ECN naming one part, plus the brief for it. */
async function ecnFor(partId: number) {
  const created = await engineer.post('/api/ecns', { title: 'Replace the bearing' });
  expect(created.status).toBe(201);
  const ecnId = created.body.id as number;
  const item = await engineer.post(`/api/ecns/${ecnId}/items`, { partId });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  const brief = await engineer.get(`/api/ecns/${ecnId}/change-brief`);
  expect(brief.status, JSON.stringify(brief.body)).toBe(200);
  return { ecnId, brief: brief.body };
}

/** leaf <- sub <- product, the two parents released. */
async function threeLevels() {
  const leaf = await createReleasedPart({
    createdById: engineer.id,
    partNumber: `LF-${Date.now()}`,
  });
  const sub = await createPart({ createdById: engineer.id, partNumber: `SB-${Date.now()}` });
  const product = await createPart({
    createdById: engineer.id,
    partNumber: `PR-${Date.now()}`,
  });
  await addBomLine({ parentRevisionId: sub.revisionId, childPartId: leaf.id, quantity: 2 });
  await release(sub.revisionId);
  await addBomLine({ parentRevisionId: product.revisionId, childPartId: sub.id, quantity: 1 });
  await release(product.revisionId);
  return { leaf, sub, product };
}

describe('the change brief', () => {
  /* The reason the endpoint exists, asserted against the endpoint it supersedes. */
  it('reaches the product, where /impact reached only the sub-assembly', async () => {
    const { leaf, sub, product } = await threeLevels();
    const { ecnId, brief } = await ecnFor(leaf.id);

    // What the existing impact view sees: one level.
    const impact = await engineer.get(`/api/ecns/${ecnId}/impact`);
    expect(impact.status, JSON.stringify(impact.body)).toBe(200);
    const impactParents = (impact.body[0].usedIn as { parentPart: { id: number } }[]).map(
      (u) => u.parentPart.id
    );
    expect(impactParents).toContain(sub.id);
    expect(impactParents).not.toContain(product.id);

    // What the brief sees: the product.
    const products = (brief.items[0].products as { id: number }[]).map((p) => p.id);
    expect(products).toEqual([product.id]);
    expect(brief.totals.products).toBe(1);
  });

  it('shows the route from the changed part up to the product', async () => {
    const { leaf, sub, product } = await threeLevels();
    const { brief } = await ecnFor(leaf.id);
    const top = brief.items[0].products[0];
    expect(top.level).toBe(2);
    expect(top.path).toEqual([leaf.partNumber, sub.partNumber, product.partNumber]);
  });

  /*
   * The committed structures this part sits in.
   *
   * WEAKER THAN THE HOSTED ASSERTION ON PURPOSE. There it reads "pinned to the revision being
   * changed", which is demonstrable because a pin is stored. Here nothing records which child
   * revision the parent was released against, so the honest claim is only that the assembly
   * is released or in review and uses the part. Asserting the stronger thing would make this
   * test pass while describing something the database does not hold — see the header.
   */
  it('names the released assemblies that use the part', async () => {
    const { leaf, sub } = await threeLevels();
    const { brief } = await ecnFor(leaf.id);
    const released = brief.items[0].releasedAssemblies as {
      part: { id: number };
      lifecycle: string;
    }[];
    expect(released.map((p) => p.part.id)).toContain(sub.id);
    expect(released.every((p) => p.lifecycle === 'RELEASED' || p.lifecycle === 'IN_REVIEW')).toBe(
      true
    );
    expect(brief.totals.releasedAssemblies).toBeGreaterThan(0);
  });

  /*
   * A DRAFT parent is excluded by the lifecycle filter. It has not been committed to, and it
   * re-resolves to whatever is current the moment it is released, so it is not work this
   * change creates.
   */
  it('leaves an unreleased parent out of the released list', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const draft = await createPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: draft.revisionId, childPartId: leaf.id, quantity: 1 });

    const { brief } = await ecnFor(leaf.id);
    expect(brief.items[0].releasedAssemblies).toEqual([]);
  });

  /*
   * The other half of what the lifecycle filter is for: an assembly that WAS released and has
   * since been retired. Nobody is going to rework those, so counting them would overstate the
   * change.
   *
   * The hosted version of this test passes `acknowledgeInUse: true`, because that build
   * refuses to obsolete a revision a released assembly still contains. This build has no such
   * guard, so the plain action succeeds — and that difference is itself worth recording here,
   * because a reader comparing the two files will otherwise think the flag was dropped by
   * accident.
   */
  it('leaves an obsoleted assembly out of the released list', async () => {
    const { leaf, sub } = await threeLevels();
    const obsoleted = await engineer.post(`/api/revisions/${sub.revisionId}/transition`, {
      action: 'obsolete',
    });
    expect(obsoleted.status, JSON.stringify(obsoleted.body)).toBe(200);

    const { brief } = await ecnFor(leaf.id);
    const ids = (brief.items[0].releasedAssemblies as { part: { id: number } }[]).map(
      (p) => p.part.id
    );
    expect(ids).not.toContain(sub.id);
  });

  /*
   * The cap on that list, and the note that admits it.
   *
   * This is new code in this build and it exists because dropping the revision narrowing
   * removed the bound the hosted query had: asking about the PART means (parents using it) x
   * (their released revisions), which a common fastener makes large. An unbounded list would
   * not merely bloat the payload — `briefToPrompt` emits every entry, and the prompt is
   * truncated from the END, which is exactly where the incompleteness notes live. So the cap
   * protects the disclosures, and a silent cap would defeat the point of having them.
   */
  it('caps the released list and says the list is partial', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const stamp = Date.now();
    for (let i = 0; i < 26; i += 1) {
      const parent = await createPart({
        createdById: engineer.id,
        partNumber: `CAP-${stamp}-${String(i).padStart(2, '0')}`,
      });
      await addBomLine({ parentRevisionId: parent.revisionId, childPartId: leaf.id, quantity: 1 });
      await release(parent.revisionId);
    }

    const { brief } = await ecnFor(leaf.id);
    expect(brief.items[0].releasedAssemblies).toHaveLength(25);
    expect(brief.notes.join(' ')).toContain(leaf.partNumber);
    expect(brief.notes.join(' ')).toMatch(/more than 25|sample/i);
  }, 120_000);

  /*
   * The number most likely to stop a release. Counted with its own query rather than from the
   * (capped) unit list, so it is never a sample.
   */
  it('counts units already shipped, and lists what was built', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    for (const [n, status] of [
      ['SN-1', BuildStatus.SHIPPED],
      ['SN-2', BuildStatus.SHIPPED],
      ['SN-3', BuildStatus.COMPLETED],
      ['SN-4', BuildStatus.SCRAPPED],
    ] as const) {
      await prisma.buildUnit.create({
        data: {
          partId: leaf.id,
          partRevisionId: leaf.revisionId,
          identifier: `${n}-${Date.now()}`,
          kind: 'SERIAL',
          status,
          createdById: engineer.id,
        },
      });
    }
    const { brief } = await ecnFor(leaf.id);
    expect(brief.items[0].shippedCount).toBe(2);
    expect(brief.totals.shippedUnits).toBe(2);
    // Scrapped was built and thrown away: it is not something a change must be reconciled
    // against, and counting it would inflate the one number that stops a release.
    const ids = (brief.items[0].builtUnits as { identifier: string }[]).map((u) => u.identifier);
    expect(ids).toHaveLength(3);
    expect(ids.some((i) => i.startsWith('SN-4'))).toBe(false);
  });

  /*
   * The shipped count is its own COUNT query, not a tally of the listed units, because the
   * list is capped at 25. A change with 40 shipped units must not report the 25 that happen
   * to be newest — the figure that decides whether a field action is needed can never be a
   * sample.
   */
  it('counts every shipped unit even when more exist than it lists', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const stamp = Date.now();
    // 30 units, the OLDEST 5 shipped, so they fall outside the newest-25 window.
    for (let i = 0; i < 30; i += 1) {
      await prisma.buildUnit.create({
        data: {
          partId: leaf.id,
          partRevisionId: leaf.revisionId,
          identifier: `BULK-${stamp}-${String(i).padStart(2, '0')}`,
          kind: 'SERIAL',
          status: i < 5 ? BuildStatus.SHIPPED : BuildStatus.COMPLETED,
          createdById: engineer.id,
        },
      });
    }
    const { brief } = await ecnFor(leaf.id);
    expect(brief.items[0].builtUnits).toHaveLength(25);
    expect(brief.items[0].shippedCount).toBe(5);
    expect(brief.totals.shippedUnits).toBe(5);
    // And it says the list is short rather than letting it read as complete.
    expect(brief.notes.join(' ')).toContain('built units');
  }, 60_000);

  it('names the requirements traced to the part', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const req = await prisma.requirement.create({
      data: {
        reqNumber: `REQ-${Date.now()}`,
        title: 'Shall withstand 8g',
        statement: 'The bracket shall withstand 8g.',
        createdById: engineer.id,
      },
    });
    await prisma.requirementLink.create({ data: { requirementId: req.id, partId: leaf.id } });

    const { brief } = await ecnFor(leaf.id);
    expect((brief.items[0].requirements as { id: number }[]).map((r) => r.id)).toContain(req.id);
    expect(brief.totals.requirements).toBe(1);
  });

  it('names open nonconformances and ignores closed ones', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const open = await prisma.nonconformance.create({
      data: {
        ncrNumber: `NCR-${Date.now()}`,
        title: 'Bearing seizes',
        description: 'Seizes under load.',
        partId: leaf.id,
        createdById: engineer.id,
      },
    });
    await prisma.nonconformance.create({
      data: {
        ncrNumber: `NCR-closed-${Date.now()}`,
        title: 'Old issue',
        description: 'Fixed long ago.',
        partId: leaf.id,
        status: 'CLOSED',
        createdById: engineer.id,
      },
    });

    const { brief } = await ecnFor(leaf.id);
    const ids = (brief.items[0].openNcrs as { id: number }[]).map((n) => n.id);
    expect(ids).toEqual([open.id]);
  });

  /*
   * Rule X4, and the DIRECTION is the whole point: a brief that dropped a restricted product
   * would report a change as safe when it is not. So it is counted and not named.
   *
   * This is the single most important assertion in the file. It is also the one the landing
   * page makes a claim about ("what is hidden from them is counted, never quietly left out"),
   * which is a second reason it must not be weakened into "the name is absent" — that alone
   * would also pass if the product had been dropped entirely.
   */
  it('counts a product it cannot show rather than dropping it', async () => {
    const owner = await createAndLogin({ role: 'ENGINEER' });
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const secret = await createPart({ createdById: owner.id, partNumber: 'SECRET-PROD' });
    await addBomLine({ parentRevisionId: secret.revisionId, childPartId: leaf.id, quantity: 1 });
    await prisma.partAcl.create({
      data: { partId: secret.id, userId: owner.id, grantedById: owner.id },
    });

    const { brief } = await ecnFor(leaf.id);
    expect(JSON.stringify(brief)).not.toContain('SECRET-PROD');
    expect(brief.items[0].redactedProducts).toBe(1);
    expect(brief.totals.redactedProducts).toBe(1);
  });

  /* Two parts on one ECN usually share products; counting them twice would mislead. */
  it('deduplicates totals across items', async () => {
    const product = await createPart({ createdById: engineer.id });
    const a = await createReleasedPart({ createdById: engineer.id });
    const b = await createReleasedPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: product.revisionId, childPartId: a.id, quantity: 1 });
    await addBomLine({ parentRevisionId: product.revisionId, childPartId: b.id, quantity: 1 });
    await release(product.revisionId);

    const created = await engineer.post('/api/ecns', { title: 'Two parts, one product' });
    const ecnId = created.body.id as number;
    expect((await engineer.post(`/api/ecns/${ecnId}/items`, { partId: a.id })).status).toBe(201);
    expect((await engineer.post(`/api/ecns/${ecnId}/items`, { partId: b.id })).status).toBe(201);

    const res = await engineer.get(`/api/ecns/${ecnId}/change-brief`);
    expect(res.status).toBe(200);
    expect(res.body.totals.affectedParts).toBe(2);
    // Both items reach the same product, so the total is one, not two.
    expect(res.body.totals.products).toBe(1);
  });

  /* 404 rather than 403, so a restricted ECN's existence is not disclosed (rule X3). */
  it('404s an ECN the caller may not read', async () => {
    const { leaf } = await threeLevels();
    const { ecnId } = await ecnFor(leaf.id);
    const colleague = await createAndLogin({ role: 'ENGINEER' });
    await prisma.ecnAcl.create({
      data: { ecnId, userId: engineer.id, grantedById: engineer.id },
    });
    expect((await colleague.get(`/api/ecns/${ecnId}/change-brief`)).status).toBe(404);
    // ...and the person it is granted to still gets it.
    expect((await engineer.get(`/api/ecns/${ecnId}/change-brief`)).status).toBe(200);
  });

  it('answers for an ECN with no items at all', async () => {
    const created = await engineer.post('/api/ecns', { title: 'Nothing yet' });
    const res = await engineer.get(`/api/ecns/${created.body.id}/change-brief`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.totals.products).toBe(0);
    expect(res.body.totals.affectedParts).toBe(0);
  });

  it('reports the ECN it is about', async () => {
    const { leaf } = await threeLevels();
    const { brief } = await ecnFor(leaf.id);
    expect(brief.ecn.ecnNumber).toMatch(/^ECN-/);
    expect(brief.ecn.title).toBe('Replace the bearing');
    expect(brief.ecn.status).toBe('DRAFT');
  });
});
