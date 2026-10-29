/**
 * Bring your own API key.
 *
 * The product takes custody of a credential belonging to a third party and bills somebody
 * else's account with it, so most of this file is about what must NOT happen: the key must
 * not come back out, must not reach the audit trail, must not be usable from another row, and
 * must not be readable by an administrator who can nonetheless revoke it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '@prisma/client';
import { app, Client, createAndLogin, request } from './helpers/api';
import { prisma } from './helpers/db';
import { createReleasedPart } from './helpers/factories';
import { resetRateLimits } from '../src/lib/rateLimit';
import { verifyCredential } from '../src/lib/ai';

let engineer: Client;

const BOX_KEY = 'z'.repeat(48);
const ANTHROPIC_KEY = `sk-ant-api03-${'k'.repeat(40)}`;
const OPENAI_KEY = `sk-proj-${'o'.repeat(40)}`;

beforeEach(async () => {
  engineer = await createAndLogin({ role: Role.ENGINEER });
  vi.stubEnv('AI_KEY_ENCRYPTION_KEY', BOX_KEY);
  resetRateLimits();
  // PUT /ai/key checks the key against the provider, so without a stub in place BEFORE the
  // first save every test in this file would make a live request to api.anthropic.com. Tests
  // that care what the provider answers re-stub; this one just keeps the suite off the wire.
  stubModel('ok');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubModel(text: string, status = 200): { headers: string[]; urls: string[] } {
  const headers: string[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      urls.push(String(url));
      headers.push(JSON.stringify(init?.headers ?? {}));
      return {
        ok: status === 200,
        status,
        json: async () => ({
          content: [{ type: 'text', text }],
          choices: [{ message: { content: text } }],
        }),
        text: async () => text,
      };
    })
  );
  return { headers, urls };
}

async function ecnWith(partId: number) {
  const created = await engineer.post('/api/ecns', { title: 'A change' });
  const ecnId = created.body.id as number;
  await engineer.post(`/api/ecns/${ecnId}/items`, { partId });
  return ecnId;
}

/**
 * Everything the audit trail would hand back, as one string.
 *
 * The audit write happens in `res.on('finish')` — after supertest has already resolved — and
 * this build has no flush seam to await, so the row for the PUT has to be waited for.
 * Asserting on an empty table would pass for the wrong reason: it contains no credential
 * either.
 */
async function auditSurfaceAfterKeySave(): Promise<string> {
  let rows: unknown[] = [];
  for (let attempt = 0; attempt < 80 && rows.length === 0; attempt += 1) {
    rows = await prisma.auditLog.findMany({ where: { path: '/ai/key' } });
    if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(rows, 'no audit row was written for PUT /ai/key, so this proves nothing').not.toEqual([]);
  const read = await engineer.get('/api/audit');
  return JSON.stringify(rows) + JSON.stringify(read.body ?? {});
}

describe('storing your own key', () => {
  it('stores it and reports only a hint', async () => {
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hint).toBe(ANTHROPIC_KEY.slice(-4));
    // The key itself never comes back, not even masked beyond the hint.
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  it('never stores it in plaintext', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
    expect(row.aiKeyEnc).not.toContain(ANTHROPIC_KEY);
    expect(row.aiKeyEnc).toMatch(/^v1:/);
  });

  /* The whole point of binding the ciphertext to its row. */
  it('stores a ciphertext that is useless in another user row', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const mine = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    const thief = await createAndLogin({ role: Role.ENGINEER });
    // Copy the ciphertext verbatim into another row, the way anyone with SQL could.
    await prisma.user.update({
      where: { id: thief.id },
      data: { aiProvider: 'ANTHROPIC', aiKeyEnc: mine.aiKeyEnc, aiKeyHint: mine.aiKeyHint },
    });

    const part = await createReleasedPart({ createdById: thief.id });
    const ecn = await thief.post('/api/ecns', { title: 'Stolen' });
    await thief.post(`/api/ecns/${ecn.body.id}/items`, { partId: part.id });
    const stub = stubModel('should never be reached');
    const res = await thief.post(`/api/ai/ecns/${ecn.body.id}/narrative`, {});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('could not be read');
    // And nothing was sent anywhere with it.
    expect(stub.urls).toEqual([]);
  });

  /*
   * The audit middleware records the request body. A PUT carrying `apiKey` is exactly the
   * case the redaction rule was fixed for, so this is the regression test that it stays fixed
   * for the endpoint that actually sends one.
   */
  it('never writes the key to the audit trail', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect(await auditSurfaceAfterKeySave()).not.toContain(ANTHROPIC_KEY);
  });

  it('refuses a key that is not the provider s shape', async () => {
    const res = await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: OPENAI_KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sk-ant-');
  });

  /* A pasted env line would otherwise put the tail of it on screen as a "hint". */
  it('refuses a pasted NAME=value line', async () => {
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
    });
    expect(res.status).toBe(400);
  });

  it('refuses whitespace around or inside the key', async () => {
    for (const bad of [` ${ANTHROPIC_KEY}`, `${ANTHROPIC_KEY}\n`, 'sk-ant- has a space']) {
      expect((await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: bad })).status).toBe(400);
    }
  });

  it('refuses an unknown provider', async () => {
    const res = await engineer.put('/api/ai/key', { provider: 'LLAMA', apiKey: ANTHROPIC_KEY });
    expect(res.status).toBe(400);
  });

  /*
   * No encryption key, no custody. Storing somebody's paid credential under something weaker
   * is worse than declining to hold it.
   */
  it('refuses to store anything when the deployment cannot encrypt', async () => {
    vi.unstubAllEnvs();
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('AI_KEY_ENCRYPTION_KEY');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).toBeNull();
  });

  it('lets the owner remove it', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect((await engineer.delete('/api/ai/key')).status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).toBeNull();
    expect(row.aiProvider).toBeNull();
    expect(row.aiKeyHint).toBeNull();
  });
});

describe('whose key pays', () => {
  it('uses the caller s own key, and says so', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    const stub = stubModel('fine');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.paidBy).toBe('user');
    expect(stub.headers[0]).toContain(ANTHROPIC_KEY);
  });

  it('sends an OpenAI key to OpenAI, in OpenAI s shape', async () => {
    await engineer.put('/api/ai/key', { provider: 'OPENAI', apiKey: OPENAI_KEY });
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    const stub = stubModel('fine');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(200);
    expect(stub.urls[0]).toBe('https://api.openai.com/v1/chat/completions');
    // Bearer, not x-api-key — the adapter exists for exactly this difference.
    expect(stub.headers[0]).toContain(`Bearer ${OPENAI_KEY}`);
  });

  it('falls back to the deployment key when the caller has none', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-deployment-key');
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    stubModel('fine');

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(200);
    expect(res.body.paidBy).toBe('deployment');
  });

  /*
   * A rejected USER key must not name a variable the caller cannot see: they would go looking
   * for an administrator instead of fixing the key in their own profile.
   */
  it('blames the caller s own key when the provider rejects it', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    stubModel('unauthorized', 401);

    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('your API key');
    expect(res.body.error).not.toContain('ANTHROPIC_API_KEY');
  });

  it('refuses when neither the caller nor the deployment has a key', async () => {
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    const stub = stubModel('unreachable');
    const res = await engineer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status).toBe(409);
    expect(stub.urls).toEqual([]);
  });
});

/*
 * Validation on save REPORTS; it does not gate.
 *
 * The product is being handed somebody else's paid credential. It is entitled to tell them
 * what the provider said about it, and not entitled to decide on their behalf that a key is
 * unusable because a request failed — an outage, a 429 on a busy account or a DNS blip is
 * evidence about the network, not about the key. So the answer is three-valued and the write
 * happens either way.
 */
describe('validation on save reports, never blocks', () => {
  it('says verified when the provider accepts the key', async () => {
    const stub = stubModel('ok');
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.verified).toBe(true);
    expect(res.body.reason).toBeNull();
    // Checked against the provider the key is FOR, with the key itself.
    expect(stub.urls).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(stub.headers[0]).toContain(ANTHROPIC_KEY);
  });

  it('checks an OpenAI key against OpenAI', async () => {
    const stub = stubModel('ok');
    const res = await engineer.put('/api/ai/key', { provider: 'OPENAI', apiKey: OPENAI_KEY });
    expect(res.body.verified).toBe(true);
    expect(stub.urls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  /* The one unambiguous answer: the provider looked at this key and said no. */
  it('reports not-verified when the provider rejects the key — and still stores it', async () => {
    stubModel('unauthorized', 401);
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toMatch(/rejected/i);
    // Stored anyway. Refusing the write would be this product deciding, on one request, that
    // the person does not know their own credential — and would lose a key that works again
    // five minutes later once a provider-side problem clears.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
    expect(row.aiKeyHint).toBe(ANTHROPIC_KEY.slice(-4));
  });

  it('reports not-verified on a 403 too — and still stores it', async () => {
    stubModel('forbidden', 403);
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.body.verified).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
  });

  /*
   * Everything that is NOT a verdict on the key reads as "could not tell" — null, not false.
   * This is the distinction the whole three-valued answer exists for: a 429 means the account
   * is busy, a 529 means the provider is overloaded, and neither says anything about whether
   * the key is good.
   */
  it.each([
    [429, /rate-limit/i],
    [500, /could not be checked/i],
    [529, /could not be checked/i],
  ])('could not tell on a %i, and stores the key', async (status, reason) => {
    stubModel('busy', status as number);
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.verified).toBeNull();
    expect(res.body.reason).toMatch(reason as RegExp);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
  });

  /*
   * A network failure, which is also the path a timeout takes: `verifyCredential` aborts the
   * request on its own timer and the abort surfaces as a rejection in the same catch. This
   * test drives the rejection rather than the timer, so it covers the line without waiting
   * ten seconds for it.
   */
  it('could not tell when the provider cannot be reached, and stores the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
      })
    );
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verified).toBeNull();
    expect(res.body.reason).toMatch(/could not be reached/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
  });

  /* Whatever the outcome, the reason is shown to a human and must not carry the credential. */
  it('never puts the key in the reason it reports', async () => {
    for (const status of [401, 429, 500]) {
      stubModel(`body mentioning ${ANTHROPIC_KEY}`, status);
      const res = await engineer.put('/api/ai/key', {
        provider: 'ANTHROPIC',
        apiKey: ANTHROPIC_KEY,
      });
      expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
    }
  });

  /*
   * The check is a check, not a feature use: one token, so verifying a key costs the person
   * who owns it approximately nothing.
   */
  it('spends one token checking', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(init?.body ?? '');
        return { ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' };
      })
    );
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect(JSON.parse(bodies[0]).max_tokens).toBe(1);
  });

  /*
   * The check runs its OWN short timer, not the sixty seconds `aiComplete` allows a model to
   * write prose in. Somebody is sitting in front of a form with their finger off the paste
   * button; a minute of nothing is worse than being told it could not be checked.
   *
   * Driven against `verifyCredential` directly with fake timers rather than through the route,
   * because the only honest way to test a timeout through HTTP is to wait for it. A mutant
   * that swaps in `TIMEOUT_MS` leaves this promise pending at eleven seconds and the test
   * fails, which is the point.
   */
  it('gives up on a silent provider in seconds, not a minute', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
        )
      );
      const pending = verifyCredential({
        provider: 'ANTHROPIC',
        apiKey: ANTHROPIC_KEY,
        source: 'user',
      });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await pending).toEqual({
        verified: null,
        reason: expect.stringContaining('could not be reached'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /* A malformed key is still refused outright — nothing is sent and nothing is stored. */
  it('does not call the provider at all when the format is wrong', async () => {
    const stub = stubModel('should never be reached');
    const res = await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: 'hunter2' });
    expect(res.status).toBe(400);
    expect(stub.urls).toEqual([]);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).toBeNull();
  });
});

describe('capabilities are per caller', () => {
  it('reports the caller s own key, never the key itself', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const res = await engineer.get('/api/ai/capabilities');
    expect(res.body.configured).toBe(true);
    expect(res.body.source).toBe('user');
    expect(res.body.ownKey.provider).toBe('ANTHROPIC');
    expect(res.body.ownKey.hint).toBe(ANTHROPIC_KEY.slice(-4));
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  /* Two people on one deployment now get different answers. */
  it('tells a colleague with no key that nothing is available', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const colleague = await createAndLogin({ role: Role.ENGINEER });
    const res = await colleague.get('/api/ai/capabilities');
    expect(res.body.configured).toBe(false);
    expect(res.body.ownKey).toBeNull();
    expect(res.body.features.changeNarrative).toBe(false);
  });

  /*
   * The CIPHERTEXT must not come back either. Asserting only that the plaintext is absent is
   * too weak — a handler returning `aiKeyEnc` in place of the hint would pass that check,
   * since the sealed value does not contain the key it protects.
   */
  it('never returns the stored ciphertext', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    const res = await engineer.get('/api/ai/capabilities');
    expect(stored.aiKeyEnc).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(stored.aiKeyEnc as string);
  });

  it('says whether the deployment can store keys at all', async () => {
    expect((await engineer.get('/api/ai/capabilities')).body.canStoreKeys).toBe(true);
    vi.unstubAllEnvs();
    expect((await engineer.get('/api/ai/capabilities')).body.canStoreKeys).toBe(false);
  });
});

describe('an administrator may revoke but never read', () => {
  /*
   * This exists because an offboarded engineer's key cannot otherwise be removed: the foreign
   * keys pointing at `User` restrict deletion, so the row survives offboarding by design
   * (change control is worthless if attribution can be deleted) and they can no longer sign in
   * to clear it themselves.
   */
  it('lets an ADMIN clear another user s key', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const admin = await createAndLogin({ role: Role.ADMIN });
    const res = await admin.delete(`/api/ai/key/${engineer.id}`);
    expect(res.status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).toBeNull();
  });

  it('refuses a non-admin clearing somebody else s key', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const other = await createAndLogin({ role: Role.ENGINEER });
    expect((await other.delete(`/api/ai/key/${engineer.id}`)).status).toBe(403);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } });
    expect(row.aiKeyEnc).not.toBeNull();
  });

  /* There is no read endpoint at all — the admin surface is revoke-only. */
  it('exposes no endpoint that returns another user s key', async () => {
    await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const admin = await createAndLogin({ role: Role.ADMIN });
    for (const path of [`/api/ai/key/${engineer.id}`, '/api/ai/key', '/api/users']) {
      const res = await admin.get(path);
      expect(JSON.stringify(res.body ?? {})).not.toContain(ANTHROPIC_KEY);
    }
  });
});

describe('a VIEWER may manage and use their own key', () => {
  it('lets a VIEWER store one, but not through a read-scoped API key', async () => {
    const viewer = await createAndLogin({ role: Role.VIEWER });
    const stored = await viewer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: ANTHROPIC_KEY,
    });
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
  });

  /*
   * apikey.ts maps a READ-scoped key to role VIEWER acting as its creating user, so without
   * the `!req.apiKeyAuth` guard on the exemption a key issued for reading could write its
   * owner's credential — and then spend it, since the AI endpoints are POSTs too.
   */
  it('refuses a read-scoped API key writing its owner s key', async () => {
    // Issuing an API key is an ADMIN action, so the key acts as that admin — which is the
    // case that matters: a read key must not write ITS OWNER's credential.
    const owner = await createAndLogin({ role: Role.ADMIN });
    const created = await owner.post('/api/api-keys', { name: 'reader', scopes: 'read' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const token = created.body.key as string;
    expect(token, 'the create response should hand back the key once').toBeTruthy();

    // `X-API-Key`, which is the only header apikey.ts reads — an earlier version of this test
    // sent a Bearer token, got the 401 that any unauthenticated request gets, and asserted
    // nothing at all about the guard it was named after.
    const res = await request(app)
      .put('/api/ai/key')
      .set('X-API-Key', token)
      .send({ provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // The WRITE GUARD is what must refuse this, not some other 403 further in. Asserting the
    // status alone would also be satisfied by a handler-level refusal that a mutation to the
    // exemption would leave in place.
    expect(res.body.error).toBe('Viewers have read-only access');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.aiKeyEnc).toBeNull();
  });

  /*
   * And the other half of it: a read-scoped key must not SPEND the credential either. The AI
   * endpoints are POSTs, so they need their own exemption from the write guard, and that
   * exemption carries the same `!req.apiKeyAuth` condition for the same reason. Without this
   * test a mutation removing it survives — which it did, until this was written.
   */
  it('refuses a read-scoped API key spending its owner s key', async () => {
    const owner = await createAndLogin({ role: Role.ADMIN });
    await owner.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const created = await owner.post('/api/api-keys', { name: 'reader', scopes: 'read' });
    const token = created.body.key as string;

    const part = await createReleasedPart({ createdById: owner.id });
    const ecn = await owner.post('/api/ecns', { title: 'Spend it' });
    await owner.post(`/api/ecns/${ecn.body.id}/items`, { partId: part.id });

    const stub = stubModel('should never be reached');
    const res = await request(app)
      .post(`/api/ai/ecns/${ecn.body.id}/narrative`)
      .set('X-API-Key', token)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe('Viewers have read-only access');
    // The point is the money, so assert the money: nothing was sent to the provider.
    expect(stub.urls).toEqual([]);
  });

  it('lets a VIEWER use it — the AI endpoints write nothing', async () => {
    const viewer = await createAndLogin({ role: Role.VIEWER });
    await viewer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const part = await createReleasedPart({ createdById: engineer.id });
    const ecnId = await ecnWith(part.id);
    stubModel('fine');
    const res = await viewer.post(`/api/ai/ecns/${ecnId}/narrative`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
