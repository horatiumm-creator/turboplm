/**
 * Encrypting a credential that belongs to somebody else.
 *
 * Used for the per-user AI provider keys, and written to be the one helper the SSO client
 * secret (CONTRACTS rule A2) uses when that lands, so the product does not grow two schemes.
 *
 * THE INVARIANT IS NOT "NOBODY CAN READ IT". A key does not have to be read to be stolen; it
 * has to be USED. Encrypting every row under one deployment-wide key with no further binding
 * makes each ciphertext a bearer token — it decrypts wherever it is put, so moving one row's
 * value into another row spends that credential. So every ciphertext is bound to WHERE IT
 * LIVES with additional authenticated data: a value sealed for user 7's `aiKeyEnc` fails to
 * open as user 9's, and fails to open as user 7's anything-else.
 *
 * WHY THE KEY IS NOT DERIVED FROM `JWT_SECRET`, which is what rule A2 proposes for the SSO
 * secret. Three reasons, and the third is decisive:
 *  - Blast radius. A leaked `JWT_SECRET` today means forged sessions, bounded by what the app
 *    can do. Deriving from it would also make every user's provider key decryptable from any
 *    backup or copy of the database — one variable, third-party money.
 *  - Rotation. The documented response to a compromised signing key is to rotate it, and that
 *    would silently make every stored key undecryptable — discovered later, one user at a
 *    time, as an authentication-tag failure on a feature that used to work.
 *  - `lib/config.ts` already made this call for the session secret: it refuses to start when
 *    `JWT_SECRET` is missing, too short, or still the shipped default, rather than warning
 *    about it, on the grounds that a warning in a log nobody reads is not a control anyway.
 *    Rule A2 was written before that. Inheriting its warning would re-introduce the thing
 *    this codebase has already decided is wrong, for a credential belonging to a third party
 *    rather than to us.
 *
 * So: no key, no custody. `isConfigured()` is false, and the routes refuse to STORE rather
 * than storing under something weaker.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * The deployment's root secret for credential storage. Deliberately its own variable: see
 * above for why it is not `JWT_SECRET`, and `SSO_ENCRYPTION_KEY` is accepted as an alias so
 * the SSO work does not add a third.
 */
function rootSecret(): string | null {
  return process.env.AI_KEY_ENCRYPTION_KEY || process.env.SSO_ENCRYPTION_KEY || null;
}

export function isConfigured(): boolean {
  const secret = rootSecret();
  // A short secret is the same as no secret, and a deployment that set one character should
  // be told that rather than quietly protected by it.
  return secret !== null && secret.length >= 32;
}

/**
 * The key id carried in each ciphertext, so a rotation is a re-encrypt rather than a mass
 * invalidation: `open` accepts the current key AND any listed in
 * `AI_KEY_ENCRYPTION_KEY_PREVIOUS` (comma-separated), while `seal` always uses the current
 * one, so re-sealing on the next write migrates a row without a data migration.
 *
 * The id is a FINGERPRINT OF THE SECRET, not its position in a list. An earlier version used
 * a fixed `k1` for whatever was current, which meant that the moment you rotated, every
 * existing ciphertext's `k1` resolved to the NEW secret and nothing opened — the exact
 * failure the versioning existed to prevent, found by the rotation test rather than by
 * reading the code. A fingerprint still names the right secret wherever it is listed.
 *
 * Truncated to 8 hex characters: it identifies which key, it is not a secret, and a
 * collision between two of a deployment's own keys would only cost one failed decrypt.
 */
function keyIdOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

function secretsById(): Map<string, string> {
  const map = new Map<string, string>();
  const previous = process.env.AI_KEY_ENCRYPTION_KEY_PREVIOUS;
  if (previous) {
    previous
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => map.set(keyIdOf(entry), entry));
  }
  // Current last, so it wins if the same secret also appears in the previous list.
  const current = rootSecret();
  if (current) map.set(keyIdOf(current), current);
  return map;
}

function currentKeyId(): string {
  const current = rootSecret();
  if (!current) throw new Error('secretBox: no encryption key configured');
  return keyIdOf(current);
}

/**
 * One 32-byte key per PURPOSE, derived with HKDF rather than using the root secret directly.
 *
 * DEFENCE IN DEPTH, not the separating mechanism — be honest about which is which. The
 * purpose is also in the AAD below, and that is what actually stops a value sealed for one
 * purpose opening under another; a mutation that collapsed every purpose onto one derived key
 * passed the whole suite, because no test can tell the two apart through this module's public
 * surface while both are present.
 *
 * It stays because it costs one hash and it fails safe in the direction a refactor breaks: a
 * future caller that forgets to pass AAD still gets keys that do not interchange between
 * purposes. Do not read it as the reason relocation fails.
 */
function keyFor(purpose: string, keyId: string): Buffer {
  const secret = secretsById().get(keyId);
  if (!secret) throw new Error(`no encryption key for id ${keyId}`);
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `turboplm:${purpose}`, 32)
  );
}

/**
 * Where a ciphertext is allowed to live. Any change to this fails the authentication tag, so
 * a value relocated to another row or column does not open.
 */
export interface SecretLocation {
  /** What kind of secret this is — also selects the derived key. */
  purpose: string;
  /** The table and column it belongs to. */
  column: string;
  /** The row it belongs to. */
  rowId: number;
}

/**
 * The three components a ciphertext is bound to: what it is, where it is stored, and which
 * row owns it. Change any of them and the tag fails, which is the whole point — a ciphertext
 * that opens anywhere is a bearer token, and relocating one would spend somebody else's
 * credential.
 */
function aad(where: SecretLocation): Buffer {
  return Buffer.from(`${where.purpose}|${where.column}|${where.rowId}`, 'utf8');
}

/**
 * `v1:<keyId>:<iv>:<tag>:<ciphertext>`, all base64url.
 *
 * Self-describing on purpose: the version lets the format change without a data migration,
 * and the key id lets more than one key exist at once, which is what makes rotation possible
 * at all. A bare blob would have to be decoded by guessing.
 */
export function seal(plaintext: string, where: SecretLocation): string {
  if (!isConfigured()) {
    throw new Error('secretBox: no encryption key configured');
  }
  const iv = randomBytes(12);
  const keyId = currentKeyId();
  const cipher = createCipheriv('aes-256-gcm', keyFor(where.purpose, keyId), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(where));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    keyId,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join(':');
}

/**
 * Returns null rather than throwing on anything that does not open — wrong key, wrong row,
 * tampered bytes, unknown version. The caller cannot do anything different for each case, and
 * distinguishing them in an error message tells an attacker which part they got wrong.
 */
export function open(sealed: string, where: SecretLocation): string | null {
  if (!isConfigured()) return null;
  const parts = sealed.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, keyId, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(where.purpose, keyId),
      Buffer.from(ivB64, 'base64url'),
      { authTagLength: 16 }
    );
    decipher.setAAD(aad(where));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Includes the authentication-tag failure that a relocated ciphertext produces. Nothing
    // is logged: the failure itself is not interesting, and the inputs are credentials.
    return null;
  }
}

/** True when a sealed value was written under a key that is no longer the current one. */
export function needsResealing(sealed: string): boolean {
  if (!isConfigured()) return false;
  const parts = sealed.split(':');
  return parts.length === 5 && parts[0] === 'v1' && parts[1] !== currentKeyId();
}

/**
 * Constant-time compare, for the rare case of checking a secret against a stored copy without
 * leaking the answer through timing. Not used by the AI keys — they are decrypted and sent —
 * but it belongs beside the rest rather than being reinvented next to its first caller.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
