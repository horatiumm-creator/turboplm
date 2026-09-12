import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/errors';

/**
 * Machine access: `X-API-Key: tplm_<prefix>_<secret>`.
 *
 * A valid key authenticates the request as its creating user, with an effective
 * role derived from the key's scope ("read" → VIEWER-equivalent, "write" →
 * ENGINEER-equivalent) so the existing RBAC guard applies unchanged. Keys never
 * grant ADMIN. Cookie sessions are untouched when no key header is present.
 */

export const API_KEY_PREFIX = 'tplm';

export function generateApiKey(): { prefix: string; secret: string; full: string; hash: string } {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const full = `${API_KEY_PREFIX}_${prefix}_${secret}`;
  return { prefix, secret, full, hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('x-api-key');
  if (!header) {
    next();
    return;
  }
  try {
    // The secret is base64url and may itself contain "_", so match the fixed
    // scheme + 8-hex prefix and treat the entire remainder as the secret.
    const match = new RegExp(`^${API_KEY_PREFIX}_([0-9a-f]{8})_(.+)$`).exec(header.trim());
    if (!match) throw new HttpError(401, 'Invalid API key');
    const [, prefix, secret] = match;
    const key = await prisma.apiKey.findUnique({
      where: { prefix },
      include: { createdBy: true },
    });
    if (!key || key.revokedAt) throw new HttpError(401, 'Invalid API key');

    const expected = Buffer.from(key.keyHash, 'utf8');
    const actual = Buffer.from(hashApiKey(secret), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new HttpError(401, 'Invalid API key');
    }

    req.apiKeyAuth = true;
    req.user = {
      id: key.createdBy.id,
      email: key.createdBy.email,
      name: `${key.createdBy.name} (API: ${key.name})`,
      role: key.scopes === 'write' ? 'ENGINEER' : 'VIEWER',
      avatarUrl: null,
      provider: key.createdBy.provider,
    };
    // Fire-and-forget last-used stamp; never blocks the request.
    void prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    next();
  } catch (err) {
    next(err instanceof HttpError ? err : new HttpError(401, 'Invalid API key'));
  }
}
