/**
 * The credential box — lib/secretBox.ts.
 *
 * Most of this file is about RELOCATION rather than secrecy, because a key does not have to be
 * read to be spent. Encrypting every row under one deployment-wide key with no further binding
 * makes each ciphertext a bearer token: copying one user's `aiKeyEnc` into another row would
 * charge that person's provider account, and anyone with SQL could do it. So every case below
 * changes one component of WHERE the value lives and expects null.
 *
 * The rotation case is the other half of the contract. A sealed value carries the FINGERPRINT
 * of the key that sealed it, so yesterday's key can stay listed as `_PREVIOUS` and nothing
 * becomes unreadable the moment a deployment rotates — an earlier version used a fixed `k1`
 * for whatever was current, which meant a rotation silently invalidated every stored key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isConfigured, needsResealing, open, seal } from '../src/lib/secretBox';

const WHERE = { purpose: 'ai-provider-key', column: 'User.aiKeyEnc', rowId: 7 };
const KEY = 'a'.repeat(48);

beforeEach(() => vi.stubEnv('AI_KEY_ENCRYPTION_KEY', KEY));
afterEach(() => vi.unstubAllEnvs());

describe('secretBox', () => {
  it('round-trips', () => {
    const s = seal('sk-ant-secret-value', WHERE);
    // v1:<8-hex key fingerprint>:<iv>:<tag>:<ciphertext>
    expect(s).toMatch(/^v1:[0-9a-f]{8}:[\w-]+:[\w-]+:[\w-]+$/);
    expect(s).not.toContain('sk-ant-secret-value');
    expect(open(s, WHERE)).toBe('sk-ant-secret-value');
  });

  it('refuses to open in another row', () => {
    const s = seal('sk-ant-secret-value', WHERE);
    expect(open(s, { ...WHERE, rowId: 9 })).toBeNull();
  });

  it('refuses to open in another column', () => {
    const s = seal('x', WHERE);
    expect(open(s, { ...WHERE, column: 'User.other' })).toBeNull();
  });

  it('refuses to open under another purpose', () => {
    const s = seal('x', WHERE);
    expect(open(s, { ...WHERE, purpose: 'sso-client-secret' })).toBeNull();
  });

  it('refuses tampered bytes', () => {
    const s = seal('x', WHERE);
    const parts = s.split(':');
    parts[4] = Buffer.from('zzzz').toString('base64url');
    expect(open(parts.join(':'), WHERE)).toBeNull();
  });

  it('uses a fresh iv each time', () => {
    expect(seal('same', WHERE)).not.toBe(seal('same', WHERE));
  });

  it('is unconfigured without a key, and refuses to seal', () => {
    vi.unstubAllEnvs();
    expect(isConfigured()).toBe(false);
    expect(() => seal('x', WHERE)).toThrow();
  });

  it('treats a too-short key as none', () => {
    vi.stubEnv('AI_KEY_ENCRYPTION_KEY', 'short');
    expect(isConfigured()).toBe(false);
  });

  it('opens a value sealed under a previous key, and flags it for resealing', () => {
    const old = seal('legacy', WHERE);
    // Rotate: yesterday's key becomes PREVIOUS, a new one becomes current.
    vi.stubEnv('AI_KEY_ENCRYPTION_KEY', 'b'.repeat(48));
    vi.stubEnv('AI_KEY_ENCRYPTION_KEY_PREVIOUS', KEY);
    expect(open(old, WHERE)).toBe('legacy');
    expect(needsResealing(old)).toBe(true);
    expect(needsResealing(seal('fresh', WHERE))).toBe(false);
  });
});
