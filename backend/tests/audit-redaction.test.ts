/**
 * What the audit trail must never record.
 *
 * `AuditLog.details` is the sanitized request body, and `GET /audit` hands it straight back to
 * any authenticated caller — there is no admin gate on the read in this build — so a
 * credential that reaches `details` is a credential every person with a login can read. The
 * audit table is also the one this product promises never to lose, which makes the copy
 * durable and backed up alongside the rest.
 *
 * The redaction used to be an exact, case-sensitive, top-level set of four literal names:
 * `password`, `passwordHash`, `token`, `secret`. `clientSecret` did not match `secret`,
 * `apiKey` matched nothing, and anything nested was copied through whole. Nothing in the
 * product tripped it, which is exactly why it needed a test before something did — and
 * `PUT /ai/key` is the first endpoint here that posts a credential, so these cases drive it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';

let engineer: Client;

/**
 * The value that must never be recorded, shaped like a real Anthropic key so `PUT /ai/key`
 * ACCEPTS it. A malformed one would 400, no audit row would be written, and every assertion
 * below would pass against an empty table while proving nothing.
 */
const SENTINEL = 'sk-ant-api03-SENTINEL-must-never-be-recorded-0123456789';

/** A second valid key, for the cases where the sentinel rides along in some other field. */
const GOOD_KEY = `sk-ant-api03-${'k'.repeat(40)}`;

beforeEach(async () => {
  engineer = await createAndLogin();
  vi.stubEnv('AI_KEY_ENCRYPTION_KEY', 'z'.repeat(48));
  // Saving a key checks it against the provider. Without a stub in place first, every case in
  // this file would post the sentinel to api.anthropic.com.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
      text: async () => '',
    }))
  );
});

afterEach(() => vi.unstubAllEnvs());

/**
 * The audit write happens in `res.on('finish')` — after supertest has already resolved — and
 * this build has no flush seam to await, so the row has to be waited for. Asserting on the
 * trail before it lands would pass for the wrong reason: an empty table contains no credential
 * either.
 */
async function auditedDetails(): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await prisma.auditLog.findMany({
      where: { path: '/ai/key' },
      orderBy: { id: 'asc' },
    });
    if (rows.length > 0) return rows.map((row) => (row.details ?? {}) as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no audit row was ever written for PUT /ai/key');
}

/** Both ways `details` leaves the server: the stored rows, and the read endpoint. */
async function auditSurface(): Promise<string> {
  const details = await auditedDetails();
  const read = await engineer.get('/api/audit');
  return JSON.stringify(details) + JSON.stringify(read.body ?? {});
}

describe('credentials never reach the audit trail', () => {
  /*
   * Driven through a REAL route rather than by calling `sanitize` directly: the middleware
   * takes `sanitize(req.body)` at entry, before any handler runs, so a unit test of the
   * function would not prove that the value never arrives by some other path.
   */
  it('never records the key that a PUT actually carries', async () => {
    const res = await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: SENTINEL });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await auditSurface()).not.toContain(SENTINEL);
  });

  /*
   * The nested and array cases assert the marker IS there as well as that the value is not.
   * "Absent" alone would also be satisfied by a sanitizer that dropped the whole subtree, or
   * by a request that never reached the middleware — and the audit row has to still say that
   * a secret was sent.
   */
  it('redacts one nested inside an object', async () => {
    await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: GOOD_KEY,
      integration: { clientSecret: SENTINEL },
    });
    expect(await auditSurface()).not.toContain(SENTINEL);
    const [details] = await auditedDetails();
    expect(details.integration).toEqual({ clientSecret: '[redacted]' });
  });

  it('redacts one inside an array of objects', async () => {
    await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: GOOD_KEY,
      providers: [{ label: 'a' }, { privateKey: SENTINEL }],
    });
    expect(await auditSurface()).not.toContain(SENTINEL);
    const [details] = await auditedDetails();
    expect(details.providers).toEqual([{ label: 'a' }, { privateKey: '[redacted]' }]);
  });

  /*
   * Case and separators vary by provider and by whoever named the field.
   *
   * `access_key_id` is the one that earns the separator-stripping: it does not end in "key",
   * and the underscores break the `accesskey` substring, so it leaks unless the name is
   * normalised first. Every other case here is caught by the endsWith rule even without
   * stripping, which is how a mutation proved the stripping was untested.
   */
  it.each([
    'API_KEY',
    'api-key',
    'apiKey',
    'openai_key',
    'Authorization',
    'accessKeyId',
    'access_key_id',
    'Private-Key',
  ])('redacts %s', async (field) => {
    // When `field` is `apiKey` this overwrites the good key with the sentinel, which is the
    // top-level case again — the sentinel is a valid key precisely so that still returns 200.
    const res = await engineer.put('/api/ai/key', {
      provider: 'ANTHROPIC',
      apiKey: GOOD_KEY,
      [field]: SENTINEL,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await auditSurface()).not.toContain(SENTINEL);
    // Named, so a failure says WHICH field was matched rather than only that the value is gone.
    const [details] = await auditedDetails();
    expect(details[field]).toBe('[redacted]');
  });

  /*
   * The other half of the contract. Redacting everything would also pass every test above
   * while destroying the trail's purpose — the audit row has to still say what was done.
   */
  it('keeps ordinary values, and keeps the redacted field present', async () => {
    const res = await engineer.put('/api/ai/key', { provider: 'ANTHROPIC', apiKey: SENTINEL });
    expect(res.status).toBe(200);
    const [details] = await auditedDetails();
    expect(details.provider).toBe('ANTHROPIC');
    // Present, so the trail says a key was set — it is the VALUE that goes.
    expect(details.apiKey).toBe('[redacted]');
  });
});
