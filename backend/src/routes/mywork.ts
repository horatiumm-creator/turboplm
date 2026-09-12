import { Request, Router } from 'express';
import {
  EcnPriority,
  EcnReviewDecision,
  EcnStatus,
  EcrStatus,
  Lifecycle,
  Prisma,
  TaskDecision,
  WorkflowStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, REDACTED, aclFilter, visibleIds } from '../lib/acl';

const router = Router();
router.use(requireAuth);

const ACTIVE_ECN_STATUSES: EcnStatus[] = [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED];

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface MyWorkReviewEntryDto {
  reviewId: number;
  ecn: { id: number; ecnNumber: string; title: string; status: EcnStatus };
  decision: EcnReviewDecision;
  createdAt: string;
}

/**
 * A part reference that may have been redacted (rule X4). An ECR the caller
 * raised themselves stays in their inbox even when its part is later closed to
 * them, so the row survives and only the identity is swapped out.
 */
type PartRefOrRedacted = { id: number; partNumber: string; name: string } | typeof REDACTED;

interface EcrSummaryDto {
  id: number;
  ecrNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcrStatus;
  part: PartRefOrRedacted | null;
  ecn: { id: number; ecnNumber: string } | null;
  createdBy: UserRefDto;
  createdAt: string;
}

interface EcnSummaryDto {
  id: number;
  ecnNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcnStatus;
  effectivityDate: string | null;
  itemCount: number;
  createdAt: string;
  createdBy: UserRefDto;
}

interface MyWorkDto {
  pendingReviews: MyWorkReviewEntryDto[];
  pendingTasks: {
    taskId: number;
    stepName: string;
    ecn: { id: number; ecnNumber: string; title: string };
    createdAt: string;
  }[];
  inWorkRevisions: {
    id: number;
    revision: string;
    createdAt: string;
    ecn: { id: number; ecnNumber: string } | null;
    part: { id: number; partNumber: string; name: string };
  }[];
  openEcrs: EcrSummaryDto[];
  activeEcns: EcnSummaryDto[];
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const ecrInclude = {
  part: { select: { id: true, partNumber: true, name: true } },
  ecn: { select: { id: true, ecnNumber: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.EcrInclude;

type EcrRow = Prisma.EcrGetPayload<{ include: typeof ecrInclude }>;

/**
 * Same EcrSummary shape as routes/ecrs.ts, with both protected sub-objects
 * checked against what the caller may see.
 *
 * `include` on a to-one relation takes no `where`, so these two cannot be
 * filtered in the query the way the other five lists are — they are resolved in
 * bulk with `visibleIds` and handled here. This is the nested read that is easy
 * to miss: the ECR is not an ACL-bearing type, so nothing about the row itself
 * suggests it carries a part's number and name.
 *
 * The part is redacted rather than nulled, because "no part" and "a part you may
 * not see" are different facts and the caller raised this ECR against something.
 * The ECN reference is nulled instead: the frozen `RedactedRef` shape is
 * part-shaped (`partNumber`/`name`) and inventing an ECN-shaped variant would
 * change the wire contract. Nothing is under-reported by the null — no quantity
 * or total depends on it — so it degrades to "not linked" for this caller only.
 */
function toEcrSummary(
  ecr: EcrRow,
  visibleParts: ReadonlySet<number>,
  visibleEcns: ReadonlySet<number>
): EcrSummaryDto {
  return {
    id: ecr.id,
    ecrNumber: ecr.ecrNumber,
    title: ecr.title,
    priority: ecr.priority,
    status: ecr.status,
    part: ecr.part
      ? visibleParts.has(ecr.part.id)
        ? { id: ecr.part.id, partNumber: ecr.part.partNumber, name: ecr.part.name }
        : REDACTED
      : null,
    ecn: ecr.ecn && visibleEcns.has(ecr.ecn.id)
      ? { id: ecr.ecn.id, ecnNumber: ecr.ecn.ecnNumber }
      : null,
    createdBy: { id: ecr.createdBy.id, name: ecr.createdBy.name },
    createdAt: ecr.createdAt.toISOString(),
  };
}

const ecnSummaryInclude = {
  createdBy: { select: { id: true, name: true } },
  _count: { select: { items: true } },
} satisfies Prisma.EcnInclude;

type EcnSummaryRow = Prisma.EcnGetPayload<{ include: typeof ecnSummaryInclude }>;

/** Same EcnSummary shape as the routes/ecns.ts list endpoint. */
function toEcnSummary(ecn: EcnSummaryRow): EcnSummaryDto {
  return {
    id: ecn.id,
    ecnNumber: ecn.ecnNumber,
    title: ecn.title,
    priority: ecn.priority,
    status: ecn.status,
    effectivityDate: ecn.effectivityDate ? ecn.effectivityDate.toISOString() : null,
    itemCount: ecn._count.items,
    createdAt: ecn.createdAt.toISOString(),
    createdBy: { id: ecn.createdBy.id, name: ecn.createdBy.name },
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

// ---------------------------------------------------------------------------
// GET /my-work — the current user's PLM inbox
//
// Every one of the five lists reaches a protected type, four of them through a
// nested read rather than the queried model. The governing idea: being named as
// reviewer, assignee or author is not a grant. An ECN assigned to someone who
// was later excluded from it is not actionable by them any more, and listing it
// would hand over its number and title — so those rows are filtered out at the
// database. The exception is the caller's own ECR (below), which is their own
// record and is redacted instead of dropped.
// ---------------------------------------------------------------------------

router.get(
  '/my-work',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const user = aclUser(req);

    const [reviews, tasks, revisions, ecrs, ecns] = await Promise.all([
      // My PENDING reviews on ECNs currently in review, newest first. The filter
      // belongs on the `ecn` relation, not on the review — the ECN is what owns
      // the grants, and it is what this row's nested select exposes.
      prisma.ecnReview.findMany({
        where: {
          reviewerId: userId,
          decision: EcnReviewDecision.PENDING,
          ecn: { status: EcnStatus.IN_REVIEW, ...aclFilter('ECN', user) },
        },
        orderBy: { id: 'desc' },
        include: {
          ecn: { select: { id: true, ecnNumber: true, title: true, status: true } },
        },
      }),
      // Rule W6 — my PENDING workflow tasks on running workflows of in-review
      // ECNs, newest first. Only tasks on the current step are actionable, so
      // seq is matched against currentSeq below (Prisma cannot compare two
      // columns in a where clause).
      prisma.workflowTask.findMany({
        where: {
          userId,
          decision: TaskDecision.PENDING,
          workflow: {
            status: WorkflowStatus.RUNNING,
            // Two relations deep: the task exposes workflow → ecn, so the filter
            // has to travel with the read.
            ecn: { status: EcnStatus.IN_REVIEW, ...aclFilter('ECN', user) },
          },
        },
        orderBy: { id: 'desc' },
        include: {
          workflow: {
            select: {
              currentSeq: true,
              ecn: { select: { id: true, ecnNumber: true, title: true } },
            },
          },
        },
      }),
      // My IN_WORK revisions + the active ECN managing each (if any). Two
      // protected types in one query: the revision's part, and the managing ECN
      // reached through ecnItemsTo. A nested `include` is its own query with its
      // own `where`, so it needs its own filter — an ECN restricted after it
      // picked up this revision would otherwise surface its number here.
      prisma.partRevision.findMany({
        where: {
          createdById: userId,
          lifecycle: Lifecycle.IN_WORK,
          part: { ...aclFilter('PART', user) },
        },
        orderBy: { id: 'desc' },
        take: 20,
        include: {
          part: { select: { id: true, partNumber: true, name: true } },
          ecnItemsTo: {
            where: { ecn: { status: { in: ACTIVE_ECN_STATUSES }, ...aclFilter('ECN', user) } },
            orderBy: { id: 'desc' },
            take: 1,
            select: { ecn: { select: { id: true, ecnNumber: true } } },
          },
        },
      }),
      // My open change requests. The ECR itself is not ACL-bearing and stays
      // listed whatever happens to its part — see toEcrSummary for the two
      // sub-objects that do need checking.
      prisma.ecr.findMany({
        where: { createdById: userId, status: EcrStatus.OPEN },
        orderBy: { id: 'desc' },
        take: 20,
        include: ecrInclude,
      }),
      // Active ECNs I created — a list of a protected type, so it takes the
      // filter like any other. Authorship is not a standing grant.
      prisma.ecn.findMany({
        where: {
          createdById: userId,
          status: { in: ACTIVE_ECN_STATUSES },
          ...aclFilter('ECN', user),
        },
        orderBy: { id: 'desc' },
        take: 20,
        include: ecnSummaryInclude,
      }),
    ]);

    // The ECR rows' two protected sub-objects, resolved in two queries rather
    // than one per row.
    const [visibleEcrParts, visibleEcrEcns] = await Promise.all([
      visibleIds(
        'PART',
        ecrs.flatMap((ecr) => (ecr.part ? [ecr.part.id] : [])),
        user
      ),
      visibleIds(
        'ECN',
        ecrs.flatMap((ecr) => (ecr.ecn ? [ecr.ecn.id] : [])),
        user
      ),
    ]);

    const payload: MyWorkDto = {
      pendingReviews: reviews.map((review) => ({
        reviewId: review.id,
        ecn: {
          id: review.ecn.id,
          ecnNumber: review.ecn.ecnNumber,
          title: review.ecn.title,
          status: review.ecn.status,
        },
        decision: review.decision,
        createdAt: review.createdAt.toISOString(),
      })),
      pendingTasks: tasks
        .filter((task) => task.seq === task.workflow.currentSeq)
        .map((task) => ({
          taskId: task.id,
          stepName: task.stepName,
          ecn: {
            id: task.workflow.ecn.id,
            ecnNumber: task.workflow.ecn.ecnNumber,
            title: task.workflow.ecn.title,
          },
          createdAt: task.createdAt.toISOString(),
        })),
      inWorkRevisions: revisions.map((rev) => {
        const managing = rev.ecnItemsTo.length > 0 ? rev.ecnItemsTo[0].ecn : null;
        return {
          id: rev.id,
          revision: rev.revision,
          createdAt: rev.createdAt.toISOString(),
          ecn: managing ? { id: managing.id, ecnNumber: managing.ecnNumber } : null,
          part: { id: rev.part.id, partNumber: rev.part.partNumber, name: rev.part.name },
        };
      }),
      openEcrs: ecrs.map((ecr) => toEcrSummary(ecr, visibleEcrParts, visibleEcrEcns)),
      activeEcns: ecns.map(toEcnSummary),
    };
    res.json(payload);
  })
);

export default router;
