/**
 * Supplier portal authentication (rule P1).
 *
 * A supplier session is deliberately a *different kind* of credential from an internal
 * one, not a lesser one. The token carries `kind:'supplier'`, rides in its own cookie, and
 * resolves against `SupplierUser` rather than `User`. `requireAuth` rejects it and this
 * rejects an internal token, so neither identity is a superset of the other: an admin does
 * not get portal access by being an admin, and a supplier can never reach the internal API
 * even if a route forgets to check.
 */
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/errors';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SECURE_COOKIES = (process.env.PUBLIC_URL || '').startsWith('https://');

/** Distinct from the internal cookie so both sessions can coexist in one browser. */
export const PORTAL_COOKIE_NAME = 'turboplm_portal';

/** Marks the token kind, so an internal token can never be replayed at the portal. */
export const PORTAL_TOKEN_KIND = 'supplier';

export interface PortalUser {
  id: number;
  email: string;
  name: string;
  supplierId: number;
  supplierName: string;
  supplierCode: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portalUser?: PortalUser;
    }
  }
}

export function setPortalCookie(res: Response, supplierUserId: number): void {
  const token = jwt.sign({ sub: String(supplierUserId), kind: PORTAL_TOKEN_KIND }, JWT_SECRET, {
    // Shorter than an internal session: these are external parties.
    expiresIn: '2d',
  });
  res.cookie(PORTAL_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: 2 * 24 * 3600 * 1000,
  });
}

export function clearPortalCookie(res: Response): void {
  res.clearCookie(PORTAL_COOKIE_NAME);
}

export async function requireSupplierAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[PORTAL_COOKIE_NAME];
    if (!token) throw new HttpError(401, 'Not authenticated');
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string; kind?: string };
    // An internal token signed with the same secret must not be accepted here.
    if (payload.kind !== PORTAL_TOKEN_KIND) throw new HttpError(401, 'Not authenticated');

    const id = Number(payload.sub);
    if (!Number.isInteger(id)) throw new HttpError(401, 'Not authenticated');

    const account = await prisma.supplierUser.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, name: true, code: true, active: true } } },
    });
    // Deactivating the account or the supplier ends the session immediately, without
    // waiting for the token to expire.
    if (!account || !account.active || !account.passwordHash || !account.supplier.active) {
      throw new HttpError(401, 'Not authenticated');
    }

    req.portalUser = {
      id: account.id,
      email: account.email,
      name: account.name,
      supplierId: account.supplier.id,
      supplierName: account.supplier.name,
      supplierCode: account.supplier.code,
    };
    next();
  } catch (err) {
    next(err instanceof HttpError ? err : new HttpError(401, 'Not authenticated'));
  }
}
