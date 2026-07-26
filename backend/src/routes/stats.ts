import { Router } from 'express';
import { Lifecycle, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

/** Include needed to build a PartSummary (see frontend/src/api/types.ts). */
const partSummaryInclude = {
  createdBy: { select: { id: true, name: true } },
  revisions: {
    orderBy: { id: 'desc' as const },
    take: 1,
    select: { id: true, revision: true, lifecycle: true },
  },
  _count: { select: { revisions: true } },
};

type PartWithSummary = Prisma.PartGetPayload<{ include: typeof partSummaryInclude }>;

/** Map a Prisma part (with partSummaryInclude) to the PartSummary DTO. */
function toPartSummary(p: PartWithSummary) {
  const latest = p.revisions.length > 0 ? p.revisions[0] : null;
  return {
    id: p.id,
    partNumber: p.partNumber,
    name: p.name,
    category: p.category,
    uom: p.uom,
    description: p.description,
    createdAt: p.createdAt,
    createdBy: { id: p.createdBy.id, name: p.createdBy.name },
    latestRevision: latest
      ? { id: latest.id, revision: latest.revision, lifecycle: latest.lifecycle }
      : null,
    revisionCount: p._count.revisions,
  };
}

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    const [parts, plans, users, byLifecycle, recent, myInWork, openEcns, recentEcns] =
      await Promise.all([
        prisma.part.count(),
        prisma.processPlan.count(),
        prisma.user.count(),
        prisma.partRevision.groupBy({ by: ['lifecycle'], _count: { _all: true } }),
        prisma.part.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 8,
          include: partSummaryInclude,
        }),
        prisma.partRevision.findMany({
          where: { createdById: userId, lifecycle: 'IN_WORK' },
          orderBy: { id: 'desc' },
          take: 8,
          select: {
            id: true,
            revision: true,
            lifecycle: true,
            createdAt: true,
            part: { select: { id: true, partNumber: true, name: true } },
          },
        }),
        prisma.ecn.count({ where: { status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } } }),
        prisma.ecn.findMany({
          orderBy: { id: 'desc' },
          take: 5,
          include: {
            createdBy: { select: { id: true, name: true } },
            _count: { select: { items: true } },
          },
        }),
      ]);

    const revisionsByLifecycle: Record<Lifecycle, number> = {
      IN_WORK: 0,
      IN_REVIEW: 0,
      RELEASED: 0,
      OBSOLETE: 0,
    };
    for (const group of byLifecycle) {
      revisionsByLifecycle[group.lifecycle] = group._count._all;
    }

    res.json({
      parts,
      plans,
      users,
      openEcns,
      revisionsByLifecycle,
      recentParts: recent.map(toPartSummary),
      recentEcns: recentEcns.map((ecn) => ({
        id: ecn.id,
        ecnNumber: ecn.ecnNumber,
        title: ecn.title,
        priority: ecn.priority,
        status: ecn.status,
        effectivityDate: ecn.effectivityDate,
        itemCount: ecn._count.items,
        createdAt: ecn.createdAt,
        createdBy: { id: ecn.createdBy.id, name: ecn.createdBy.name },
      })),
      myInWork,
    });
  })
);

export default router;
