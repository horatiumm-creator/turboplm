import { Request, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

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

    const payload: NotificationListDto = {
      items: rows.map(toNotificationItem),
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
