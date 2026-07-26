import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /audit?entityType&entityId&userId&search&page&pageSize — newest first.
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const where: Prisma.AuditLogWhereInput = {};
    if (typeof req.query.entityType === 'string' && req.query.entityType) {
      where.entityType = req.query.entityType;
    }
    const entityId = Number(req.query.entityId);
    if (Number.isInteger(entityId) && entityId > 0) where.entityId = entityId;
    const userId = Number(req.query.userId);
    if (Number.isInteger(userId) && userId > 0) where.userId = userId;
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      where.path = { contains: req.query.search.trim(), mode: 'insensitive' };
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, name: true } } },
      }),
    ]);

    res.json({
      items: logs.map((log) => ({
        id: log.id,
        user: log.user ? { id: log.user.id, name: log.user.name } : null,
        method: log.method,
        path: log.path,
        entityType: log.entityType,
        entityId: log.entityId,
        summary: log.summary,
        details: log.details ?? null,
        createdAt: log.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    });
  })
);

export default router;
