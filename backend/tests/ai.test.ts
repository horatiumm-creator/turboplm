/**
 * The AI-assisted change endpoints.
 *
 * Only the model API is stubbed, at `fetch`. Everything else is the real route: the real ACL
 * filter, the real change brief, the real parsing and the real guards on what comes back.
 *
 * The guards are most of what is worth testing. A language model asked to assess an
 * engineering change will, left alone, supply plausible part numbers and confident
 * conclusions, and this product's whole character is refusing to produce a number it cannot
 * stand behind. So: the prompt never contains data the reader may not see, part numbers are
 * checked against the database rather than trusted, invented colleagues are dropped, and a
 * non-JSON answer is reported rather than passed on as blank fields.
 *
 * These three properties are also advertised on turboplm.com — "part numbers it names are
 * checked against real parts", "suggested reviewers are resolved back to real people", "it
 * only ever sees what you can see". That is the second reason not to weaken an assertion
 * here: each one is a claim somebody is being sold.
 *
 * This file covers the DEPLOYMENT key path (`ANTHROPIC_API_KEY`). The per-user key, its
 * encryption, and the three-valued save-time check are in ai-byok.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';
import { resetRateLimits } from '../src/lib/rateLimit';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin({ role: 'ENGINEER' });
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-not-a-real-key');
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Capture what was sent to the model, and answer with `text`. */
function stubModel(text: string, status = 200): { prompts: string[]; headers: string[] } {
  const prompts: string[] = [];
  const headers: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      headers.push(JSON.stringify(init?.headers ?? {}));
      const sent = JSON.parse(init?.body ?? '{}') as {
        system: string;
        messages: { content: string }[];
      };
      prompts.push(`${sent.system}\n---\n${sent.messages[0].content}`);
      return {
        ok: status === 200,
        status,
        json: async () => ({ content: [{ type: 'text', text }] }),
        text: async () => text,
      };
    })
  );
  return { prompts, headers };
}

async function ecnWith(partId: number) {
  const created = await engineer.post('/api/ecns', { title: 'Replace the bearing' });
  expect(created.status).toBe(201);
  const ecnId = created.body.id as number;
  expect((await engineer.post(`/api/ecns/${ecnId}/items`, { partId })).status).toBe(201);
  return ecnId;
}

describe('GET /api/ai/capabilities', () => {
  it('reports configured when the key is set', async () => {
    const res = await engineer.get('/api/ai/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.features.changeNarrative).toBe(true);
  });

  /*
   * Answers WITHOUT the key, so the UI hides the buttons rather than rendering them and
   * discovering a 409 — rule AI3a.
   */
  it('answers without a key, saying nothing is available', async () => {
    vi.unstubAllEnvs();
    const res = await engineer.get('/api/ai/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.model).toBeNull();
    expect(res.body.features.draftChangeOrder).toBe(false);
  });

  it('never reports the key itself', async () => {
    const res = await engineer.get('/api/ai/capabilities');
    expect(JSON.stringify(res.body)).not.toContain('sk-ant');
  });
});

describe('POST /api/ai/ecns/:id/narrative', () => {
  it('returns the narrative alongside the brief it was written from', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const product = await createPart({ createdById: engineer.id });
    await addBomLine({ parentRevisionId: product.revisionId, childPartId: leaf.id, quantity: 1 });
    const ecnId = await ecnWith(leaf.id);
    stubModel('Two released assemblies use the part. Nothing has shipped.');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.narrative).toContain('released assemblies');
    expect(res.body.advisory).toBe(true);
    // The facts come back with the summary, so a reader can check it rather than trust it.
    expect(res.body.brief.ecn.ecnNumber).toMatch(/^ECN-/);
    expect(res.body.brief.totals.affectedParts).toBe(1);
  });

  it('says whose credential paid for it', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    stubModel('fine');
    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    // No per-user key is stored here, so the deployment's is what ran.
    expect(res.body.paidBy).toBe('deployment');
  });

  it('sends the API key as a header and never in the prompt', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    const stub = stubModel('fine');
    await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(stub.headers[0]).toContain('sk-ant-test-not-a-real-key');
    expect(stub.prompts[0]).not.toContain('sk-ant');
  });

  /*
   * The redaction happens BEFORE the prompt exists. Asking a model to keep a secret is not an
   * access control, so a product the reader may not see must never reach the prompt at all.
   *
   * Both halves matter. Absent is not enough on its own — a brief that dropped the product
   * entirely would also pass that — so the count has to be there too, in the prompt, where it
   * stops the model describing the change as safer than it is.
   */
  it('never puts a restricted product in the prompt, but still counts it', async () => {
    const owner = await createAndLogin({ role: 'ENGINEER' });
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const secret = await createPart({ createdById: owner.id, partNumber: 'SECRET-PROD-AI' });
    await addBomLine({ parentRevisionId: secret.revisionId, childPartId: leaf.id, quantity: 1 });
    await prisma.partAcl.create({
      data: { partId: secret.id, userId: owner.id, grantedById: owner.id },
    });
    const ecnId = await ecnWith(leaf.id);
    const stub = stubModel('ok');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(200);
    expect(stub.prompts[0]).not.toContain('SECRET-PROD-AI');
    expect(stub.prompts[0]).toContain('hidden from this reader');
  });

  it('409s when no key is configured, without calling anything', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    const stub = stubModel('should not be reached');
    vi.unstubAllEnvs();

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(409);
    expect(stub.prompts).toEqual([]);
  });

  /*
   * The route checks the credential BEFORE spending the allowance, and that is the whole
   * reason the check is in the route as well as in lib/ai.ts. Without it the request still
   * fails — the lib refuses too — but it fails having consumed one of the twenty calls an
   * hour, so a misconfigured deployment would lock a user out of a feature they never got to
   * use.
   */
  it('does not spend the allowance when no key is configured', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    const stub = stubModel('ok');

    vi.unstubAllEnvs();
    for (let i = 0; i < 25; i += 1) {
      expect((await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {})).status).toBe(409);
    }
    expect(stub.prompts).toEqual([]);

    // The allowance is untouched, so configuring the key makes the feature work immediately.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-not-a-real-key');
    expect((await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {})).status).toBe(200);
  }, 60_000);

  it('404s an ECN the caller may not read', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    await prisma.ecnAcl.create({
      data: { ecnId, userId: engineer.id, grantedById: engineer.id },
    });
    const colleague = await createAndLogin({ role: 'ENGINEER' });
    stubModel('ok');
    expect((await colleague.post(`/api/ai/ecns/${ecnId}/narrative`, {})).status).toBe(404);
  });

  /* Each call is billed, so the limit is low and it is enforced. */
  it('rate-limits the calls', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    stubModel('ok');
    for (let i = 0; i < 20; i += 1) {
      expect((await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {})).status).toBe(200);
    }
    const over = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(over.status).toBe(429);
  }, 60_000);

  it('reports an upstream failure as 503, not 500', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    stubModel('upstream exploded', 500);
    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(503);
    // And the upstream body is not echoed: it can quote the request, which held product data.
    expect(JSON.stringify(res.body)).not.toContain('upstream exploded');
  });

  /*
   * A rejected DEPLOYMENT key names the variable, because the person who can fix it is the
   * operator who set it. A rejected USER key must not — ai-byok.test.ts asserts that half,
   * and until this test existed the 502 half was uncovered in this repo.
   */
  it('reports rejected deployment credentials distinctly', async () => {
    const leaf = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(leaf.id);
    stubModel('unauthorized', 401);
    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('ANTHROPIC_API_KEY');
    // ...and it does not blame the caller for an operator's misconfiguration.
    expect(res.body.error).not.toContain('your API key');
  });
});

describe('POST /api/ai/draft-change-order', () => {
  it('drafts from a description, using only real part numbers', async () => {
    await createPart({ createdById: engineer.id, partNumber: 'BRK-5501' });
    stubModel(
      JSON.stringify({
        title: 'Thicken the bracket',
        description: 'Increase wall thickness.',
        partNumbers: ['BRK-5501'],
        priority: 'HIGH',
        uncertain: [],
      })
    );

    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'We need to thicken BRK-5501 because it keeps cracking under load.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.draft.title).toBe('Thicken the bracket');
    expect(res.body.draft.partNumbers).toEqual(['BRK-5501']);
    expect(res.body.draft.priority).toBe('HIGH');
    expect(res.body.candidatesConsidered).toBeGreaterThan(0);
  });

  /*
   * The guard that matters most here. Part-number formats are guessable, so a model asked to
   * fill this field invents numbers that look exactly like the tenant's — and a plausible
   * wrong part number in a change order is worse than a blank field, because it gets accepted.
   */
  it('discards a part number that does not exist, and says it did', async () => {
    await createPart({ createdById: engineer.id, partNumber: 'BRK-5501' });
    stubModel(
      JSON.stringify({
        title: 'Thicken the bracket',
        description: 'x',
        partNumbers: ['BRK-5501', 'BRK-9999-INVENTED'],
        priority: 'MEDIUM',
        uncertain: [],
      })
    );
    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'Thicken BRK-5501 and whatever else is affected.',
    });
    expect(res.body.draft.partNumbers).toEqual(['BRK-5501']);
    expect(res.body.discardedPartNumbers).toEqual(['BRK-9999-INVENTED']);
  });

  /*
   * The candidate list is retrieved under the caller's ACL filter, so a restricted part is
   * never offered to the model — and is discarded even if the model names it anyway.
   *
   * The description is deliberately worded so the part WOULD match the candidate search on
   * its name, without the test typing the part number itself: the engineer's own text is
   * echoed into the prompt verbatim, as it must be, so asserting the number is absent from
   * the whole prompt would only be testing what the test typed.
   */
  it('cannot propose a part the caller may not read', async () => {
    const owner = await createAndLogin({ role: 'ENGINEER' });
    const secret = await createPart({
      createdById: owner.id,
      partNumber: 'SECRET-BRK-1',
      name: 'Clandestine bracket',
    });
    await prisma.partAcl.create({
      data: { partId: secret.id, userId: owner.id, grantedById: owner.id },
    });
    const stub = stubModel(
      JSON.stringify({
        title: 't',
        description: 'd',
        partNumbers: ['SECRET-BRK-1'],
        priority: 'LOW',
        uncertain: [],
      })
    );

    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'The clandestine bracket keeps cracking and needs thickening.',
    });
    expect(res.status).toBe(200);
    // Never offered as a candidate...
    expect(stub.prompts[0]).not.toContain('SECRET-BRK-1');
    expect(stub.prompts[0]).not.toContain('Clandestine bracket');
    // ...and discarded even though the model named it anyway.
    expect(res.body.draft.partNumbers).toEqual([]);
    expect(res.body.discardedPartNumbers).toEqual(['SECRET-BRK-1']);
    expect(res.body.candidatesConsidered).toBe(0);
  });

  /* The same search, unrestricted, DOES find it — or the test above proves nothing. */
  it('does offer the same part when it is not restricted', async () => {
    await createPart({
      createdById: engineer.id,
      partNumber: 'OPEN-BRK-1',
      name: 'Clandestine bracket',
    });
    const stub = stubModel(
      JSON.stringify({
        title: 't',
        description: 'd',
        partNumbers: ['OPEN-BRK-1'],
        priority: 'LOW',
        uncertain: [],
      })
    );
    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'The clandestine bracket keeps cracking and needs thickening.',
    });
    expect(stub.prompts[0]).toContain('OPEN-BRK-1');
    expect(res.body.draft.partNumbers).toEqual(['OPEN-BRK-1']);
  });

  it('refuses a description too short to work from', async () => {
    const res = await engineer.post('/api/ai/draft-change-order', { description: 'fix it' });
    expect(res.status).toBe(400);
  });

  it('falls back to MEDIUM for a priority it does not recognise', async () => {
    stubModel(
      JSON.stringify({
        title: 't',
        description: 'd',
        partNumbers: [],
        priority: 'URGENT!!',
        uncertain: [],
      })
    );
    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'Something needs changing on the main assembly.',
    });
    expect(res.body.draft.priority).toBe('MEDIUM');
  });

  it('reports an answer it cannot parse rather than returning blanks', async () => {
    stubModel('I would be happy to help you draft that change order!');
    const res = await engineer.post('/api/ai/draft-change-order', {
      description: 'Please draft a change for the bracket thickness.',
    });
    expect(res.status).toBe(502);
  });

  /* Nothing is written: this fills a form the engineer then edits. */
  it('creates no ECN', async () => {
    const before = await prisma.ecn.count();
    stubModel(
      JSON.stringify({
        title: 't',
        description: 'd',
        partNumbers: [],
        priority: 'LOW',
        uncertain: [],
      })
    );
    await engineer.post('/api/ai/draft-change-order', {
      description: 'Draft something about the bracket please.',
    });
    expect(await prisma.ecn.count()).toBe(before);
  });
});

describe('POST /api/ai/ecns/:id/suggest-reviewers', () => {
  it('suggests from who actually created the affected parts', async () => {
    const colleague = await createAndLogin({ role: 'ENGINEER' });
    const part = await createPart({ createdById: colleague.id });
    const ecnId = await ecnWith(part.id);
    const them = await prisma.user.findUniqueOrThrow({ where: { id: colleague.id } });
    stubModel(
      JSON.stringify({
        suggestions: [{ name: them.name, why: 'Created the affected part.' }],
        reasoning: 'One person has touched these parts.',
      })
    );

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/suggest-reviewers`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].userId).toBe(colleague.id);
    // The counts it reasoned from come back, so a reader can disagree on the facts.
    expect(res.body.evidence[0].partsCreated).toBe(1);
  });

  /* A confidently invented colleague must not become a reviewer suggestion. */
  it('drops a suggested person who is not in the evidence', async () => {
    const colleague = await createAndLogin({ role: 'ENGINEER' });
    const part = await createPart({ createdById: colleague.id });
    const ecnId = await ecnWith(part.id);
    stubModel(
      JSON.stringify({
        suggestions: [{ name: 'Someone Who Does Not Work Here', why: 'Seems relevant.' }],
        reasoning: 'x',
      })
    );
    const res = await engineer.post(`/api/ai/ecns/${ecnId}/suggest-reviewers`, {});
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });

  /*
   * No candidates means no model call: there is nothing to summarise, the call costs money,
   * and a model handed an empty list writes a paragraph about how it cannot help.
   */
  it('answers without calling the model when nobody qualifies', async () => {
    const part = await createPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    // Assigning the only candidate as a reviewer empties the candidate list.
    await prisma.ecnReview.create({ data: { ecnId, reviewerId: engineer.id } });
    const stub = stubModel('should not be reached');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/suggest-reviewers`, {});
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.model).toBeNull();
    expect(stub.prompts).toEqual([]);
    // Nobody paid, and the field says so rather than being absent — the frontend type
    // declares it, so a missing field would throw on the first caller that trusts it.
    expect(res.body.paidBy).toBeNull();
  });

  it('409s an ECN with no affected parts yet', async () => {
    const created = await engineer.post('/api/ecns', { title: 'Empty' });
    const res = await engineer.post(`/api/ai/ecns/${created.body.id}/suggest-reviewers`, {});
    expect(res.status).toBe(409);
  });
});
