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
  /*
   * Managing YOUR OWN AI provider key is self-scoped account state, not a PLM mutation — the
   * same reasoning as the notifications exemption above. A VIEWER is a person who may read
   * the product, and bring-your-own-key means they pay for their own model calls; refusing
   * them the field would mean the only people who can spend their own money are the ones who
   * can also change parts.
   *
   * `!req.apiKeyAuth` is not decoration. apikey.ts maps a read-scoped key to role VIEWER
   * acting as its creating user, so without this guard a key issued for reading could write
   * its owner's credential — and the AI endpoints are POSTs, so it could then spend it too.
   * A read key stays strictly read-only.
   */
  if (req.path === '/ai/key' && !req.apiKeyAuth) {
    next();
    return;
  }
  /*
   * And the AI features themselves, which WRITE NOTHING — they read the product's data, send
   * it to a model and return prose. They are POSTs only because the input is a structured
   * body, which is the same reason `resolve-variant` below is exempt.
   *
   * Without this a VIEWER could store a key and then never use it, which is worse than either
   * allowing or refusing cleanly. `draft-change-order` in particular creates no ECN — it
   * fills a form the caller then submits themselves, through the ordinary endpoint that does
   * check their role.
   */
  if (
    /^\/ai\/(draft-change-order|ecns\/\d+\/(narrative|suggest-reviewers))$/.test(req.path) &&
    !req.apiKeyAuth
  ) {
    next();
    return;
  }
  // Resolving a variant configuration writes nothing — it only uses POST because
  // the option selection is a structured body — so read-only callers may use it.
  if (/^\/revisions\/\d+\/resolve-variant$/.test(req.path)) {
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
