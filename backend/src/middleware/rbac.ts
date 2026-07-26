import { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';

/**
 * RBAC write guard, mounted app-wide after requireAuth:
 * - GET/HEAD/OPTIONS pass for every authenticated user.
 * - Mutations require ENGINEER or ADMIN — VIEWERs are read-only.
 * Admin-only endpoints additionally call requireAdmin in their handlers.
 */
export function requireWriteRole(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  // Marking your own notifications read is self-scoped inbox state, not a PLM
  // mutation — viewers receive notifications (e.g. as reviewers) and must be
  // able to clear them. Machine credentials are excluded: a "read" API key must
  // stay strictly read-only, and it acts as its creating user's inbox.
  if (req.path === '/notifications/read' && !req.apiKeyAuth) {
    next();
    return;
  }
  const role = req.user?.role;
  if (role === 'ENGINEER' || role === 'ADMIN') {
    next();
    return;
  }
  next(new HttpError(403, 'Viewers have read-only access'));
}

export function requireAdmin(req: Request): void {
  if (req.user?.role !== 'ADMIN') {
    throw new HttpError(403, 'Administrator access required');
  }
}
