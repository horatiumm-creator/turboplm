import { Request, Router } from 'express';
import { Lifecycle, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter } from '../lib/acl';

const router = Router();

router.use(requireAuth);

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

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

// ---------------------------------------------------------------------------
// GET /stats — the dashboard.
//
// Rule X3 applied to aggregates. Every number here is scoped to what the caller
// may see rather than annotated with what was left out: a *count* is the whole
// answer, so a scoped count is complete and honest, whereas "42 parts (3
// hidden)" would hand back the existence fact the grant was meant to withhold.
// That is the opposite trade-off from a roll-up (rule X4), where the total is
// the answer and silence about a hidden contributor would make it wrong — see
// `redactedCount` in analytics.ts.
//
// The consequence to keep in mind: two users legitimately see different totals
// on this screen. That is the feature working, not a bug report.
// ---------------------------------------------------------------------------

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const userId = user.id;

    const [parts, plans, users, byLifecycle, recent, myInWork, openEcns, recentEcns] =
      await Promise.all([
        prisma.part.count({ where: { ...aclFilter('PART', user) } }),
        // A process plan hangs off a part revision, so plan counts inherit the
        // part's visibility — the plan is a description of how to make a part the
        // caller may not know about.
        prisma.processPlan.count({
          where: { partRevision: { part: { ...aclFilter('PART', user) } } },
        }),
        // Users are not an ACL-bearing type; the headcount reveals nothing about
        // any item.
        prisma.user.count(),
        // groupBy needs the filter as much as findMany does: a lifecycle
        // histogram computed over invisible revisions leaks their existence one
        // bucket at a time.
        prisma.partRevision.groupBy({
          by: ['lifecycle'],
          _count: { _all: true },
          where: { part: { ...aclFilter('PART', user) } },
        }),
        prisma.part.findMany({
          where: { ...aclFilter('PART', user) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 8,
          include: partSummaryInclude,
        }),
        // "My in-work revisions" is not an exception: authorship does not grant
        // access. A part restricted after someone drafted a revision on it must
        // drop off their dashboard, and the nested `part` select is precisely the
        // identity that would otherwise leak.
        prisma.partRevision.findMany({
          where: {
            createdById: userId,
            lifecycle: 'IN_WORK',
            part: { ...aclFilter('PART', user) },
          },
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
        prisma.ecn.count({
          where: { status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] }, ...aclFilter('ECN', user) },
        }),
        prisma.ecn.findMany({
          where: { ...aclFilter('ECN', user) },
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
