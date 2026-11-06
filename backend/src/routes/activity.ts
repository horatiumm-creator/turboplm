/**
 * GET /activity — the per-item timeline.
 *
 * Thin on purpose, the way `GET /ecns/:id/change-brief` is thin over `lib/changeBrief.ts`:
 * everything that decides what a caller may see lives in `lib/activity.ts`, so it can be
 * exercised without an HTTP client and so there is exactly one place to read the rules. This
 * file parses a query string and serialises a result.
 *
 * Note the shape of the URL: ONE endpoint taking `subject` and `id`, not five endpoints hung
 * off `/parts/:id/activity`, `/ecns/:id/activity` and so on. The five answers differ only in
 * which sources exist for them, and five routes would be five places for the access check to
 * be forgotten — which on this endpoint is the whole of the security.
 */
import { Request, Router } from 'express';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser } from '../lib/acl';
import { buildActivity, parseBefore, parseLimit, parseSubjectType } from '../lib/activity';

const router = Router();
router.use(requireAuth);

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

// GET /activity?subject=<part|ecn|ecr|project|requirement>&id=<n>&limit=&before=
router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const subject = parseSubjectType(req.query.subject);
    // `idParam` rather than a local coercion: `Number()` accepts `1e3` and `0x10`, and this is
    // the API's one id parser.
    const id = idParam(typeof req.query.id === 'string' ? req.query.id : '', 'id');

    res.json(
      await buildActivity({
        subject,
        id,
        limit: parseLimit(req.query.limit),
        before: parseBefore(req.query.before),
        user: aclUser(req),
      })
    );
  })
);

export default router;
