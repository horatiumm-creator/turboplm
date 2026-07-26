import { Router } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';

const router = Router();
router.use(requireAuth);

// GET /users — reviewer picker + admin user management.
router.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true, provider: true, createdAt: true },
    });
    res.json(
      users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        provider: u.provider,
        createdAt: u.createdAt.toISOString(),
      }))
    );
  })
);

// PATCH /users/:id — change a user's role (admin only; not your own).
router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const role = (req.body as Record<string, unknown> | undefined)?.role;
    if (typeof role !== 'string' || !(Object.values(Role) as string[]).includes(role)) {
      throw new HttpError(400, 'role must be one of ADMIN, ENGINEER, VIEWER');
    }
    if (req.user!.id === id) {
      throw new HttpError(409, 'You cannot change your own role');
    }
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new HttpError(404, 'User not found');
    const updated = await prisma.user.update({
      where: { id },
      data: { role: role as Role },
      select: { id: true, name: true, email: true, role: true, provider: true, createdAt: true },
    });
    res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  })
);

export default router;
