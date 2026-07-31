import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/errors';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/**
 * Serve cookies as `secure` whenever the public URL is HTTPS, so a session
 * cookie can never travel over plaintext on a real deployment. Local HTTP
 * development is unaffected.
 */
const SECURE_COOKIES = (process.env.PUBLIC_URL || '').startsWith('https://');

if (JWT_SECRET === 'dev-secret-change-me' && SECURE_COOKIES) {
  console.warn(
    'SECURITY: JWT_SECRET is still the default placeholder while serving over HTTPS — ' +
      'set a strong JWT_SECRET or any user session can be forged.'
  );
}
export const COOKIE_NAME = 'turboplm_token';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  provider: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** True when this request was authenticated by an X-API-Key credential. */
      apiKeyAuth?: boolean;
    }
  }
}

export function setAuthCookie(res: Response, userId: number): void {
  const token = jwt.sign({ sub: String(userId) }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // Already authenticated upstream (e.g. by an X-API-Key machine credential).
    if (req.user) {
      next();
      return;
    }
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME];
    if (!token) throw new HttpError(401, 'Not authenticated');
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string; kind?: string };
    // A supplier-portal token is signed with the same secret, so the kind claim is what
    // keeps an external account out of the internal API (rule P1).
    if (payload.kind) throw new HttpError(401, 'Not authenticated');
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId)) throw new HttpError(401, 'Not authenticated');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(401, 'Not authenticated');
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      provider: user.provider,
    };
    next();
  } catch (err) {
    next(err instanceof HttpError ? err : new HttpError(401, 'Not authenticated'));
  }
}
