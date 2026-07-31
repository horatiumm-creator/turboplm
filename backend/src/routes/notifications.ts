import { Request, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclType, AclUser, visibleIds } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface NotificationItemDto {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationListDto {
  items: NotificationItemDto[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Mappers + validation helpers
// ---------------------------------------------------------------------------

type NotificationRow = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

function toNotificationItem(n: NotificationRow): NotificationItemDto {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

// ---------------------------------------------------------------------------
// Rule X5 — a notification whose target the recipient may no longer read stays
// listed but loses its link.
//
// Deleting or hiding the row would be the wrong fix twice over: the
// notification is the recipient's own history (they were told something, and
// that happened), and a disappearing unread badge is a bug report waiting to
// happen. The title and body were composed at delivery time, when the recipient
// could read the item, so they stay as written — this is a link check, not a
// re-authorisation of text the user has already seen and probably e-mailed
// themselves.
//
// What the null buys: clicking a stale link would hit the detail route and 404
// (correctly, per X2), but a 404 on demand is still a probe — the user learns
// "this exists but is now closed to me". A dead link says only "not available".
// ---------------------------------------------------------------------------

/**
 * Frontend route prefix → the protected type that page shows. Only the five
 * ACL-bearing types appear here; links to ECRs, NCRs, CAPAs and service records
 * are left untouched because those types carry no grants of their own.
 */
const PROTECTED_LINK_PREFIXES: { prefix: string; type: AclType }[] = [
  { prefix: '/parts/', type: 'PART' },
  { prefix: '/documents/', type: 'DOCUMENT' },
  { prefix: '/ecns/', type: 'ECN' },
  { prefix: '/projects/', type: 'PROJECT' },
  { prefix: '/build-units/', type: 'BUILD_UNIT' },
];

/**
 * The item a notification link points at, or null when it points at nothing
 * protected. Tolerates a suffix or query on purpose — `/ecns/5/report` and
 * `/documents/5?markup=8` are both delivered today and both target id 5.
 */
function linkTarget(link: string | null): { type: AclType; id: number } | null {
  if (!link) return null;
  for (const { prefix, type } of PROTECTED_LINK_PREFIXES) {
    if (!link.startsWith(prefix)) continue;
    const id = Number(link.slice(prefix.length).split(/[/?#]/)[0]);
    // A link this parser cannot resolve is treated as pointing at nothing rather
    // than as safe: it cannot be checked, so it must not be checked *and passed*.
    if (!Number.isInteger(id) || id <= 0) return null;
    return { type, id };
  }
  return null;
}

/**
 * Maps rows to DTOs, nulling the link of anything the caller can no longer read.
 * One `visibleIds` call per distinct type on the page (at most five), never one
 * per row — a 100-row page must not become 100 queries.
 */
async function toItemsWithCheckedLinks(
  rows: NotificationRow[],
  user: AclUser
): Promise<NotificationItemDto[]> {
  const targets = rows.map((row) => linkTarget(row.link));

  const idsByType = new Map<AclType, number[]>();
  for (const target of targets) {
    if (!target) continue;
    const ids = idsByType.get(target.type);
    if (ids) ids.push(target.id);
    else idsByType.set(target.type, [target.id]);
  }

  const visibleByType = new Map<AclType, Set<number>>();
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      visibleByType.set(type, await visibleIds(type, ids, user));
    })
  );

  return rows.map((row, index) => {
    const item = toNotificationItem(row);
    const target = targets[index];
    // `visibleIds` reports a deleted id as invisible too, so a link to something
    // that no longer exists also goes dead instead of 404ing on click.
    if (target && !visibleByType.get(target.type)?.has(target.id)) item.link = null;
    return item;
  });
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parsePositiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${label}`);
  return n;
}

// ---------------------------------------------------------------------------
// GET /notifications — my notifications, newest first (+ optional unread=1)
// ---------------------------------------------------------------------------

router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const page = parsePositiveInt(req.query.page, 'page', 1);
    let pageSize = parsePositiveInt(req.query.pageSize, 'pageSize', 20);
    if (pageSize > 100) pageSize = 100;

    const where: Prisma.NotificationWhereInput = { userId };
    if (req.query.unread === '1') where.readAt = null;

    const [total, unread, rows] = await Promise.all([
      prisma.notification.count({ where }),
      // The caller's total unread count, regardless of the list filters.
      prisma.notification.count({ where: { userId, readAt: null } }),
      prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // `total` and `unread` stay unfiltered: they count the caller's own
    // notification rows, which are not an ACL-bearing type, and a row is listed
    // either way — only its link can change.
    const payload: NotificationListDto = {
      items: await toItemsWithCheckedLinks(rows, aclUser(req)),
      total,
      unread,
      page,
      pageSize,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /notifications/read — mark mine read ({ids: number[]} or {all: true})
//
// No ACL check: this writes the caller's own Notification rows, which carry no
// grants, and it neither reads nor reveals anything about the linked item. The
// `userId` scope in every `updateMany` below is what keeps it honest, and the
// response is a count of the caller's own unread rows.
// ---------------------------------------------------------------------------

router.post(
  '/notifications/read',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = requireBody(req);
    const now = new Date();

    if (body.all === true) {
      await prisma.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: now },
      });
    } else if (Array.isArray(body.ids)) {
      const ids = body.ids.map((value) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
          throw new HttpError(400, 'ids must be an array of positive integers');
        }
        return value;
      });
      if (ids.length > 0) {
        // Scoped to my own rows; already-read rows keep their original readAt.
        await prisma.notification.updateMany({
          where: { id: { in: ids }, userId, readAt: null },
          data: { readAt: now },
        });
      }
    } else {
      throw new HttpError(400, 'Provide ids (an array of notification ids) or all: true');
    }

    const unread = await prisma.notification.count({ where: { userId, readAt: null } });
    res.json({ unread });
  })
);

export default router;
