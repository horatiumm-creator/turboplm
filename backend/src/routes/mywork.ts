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

interface EcrSummaryDto {
  id: number;
  ecrNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcrStatus;
  part: { id: number; partNumber: string; name: string } | null;
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

/** Same EcrSummary shape as routes/ecrs.ts. */
function toEcrSummary(ecr: EcrRow): EcrSummaryDto {
  return {
    id: ecr.id,
    ecrNumber: ecr.ecrNumber,
    title: ecr.title,
    priority: ecr.priority,
    status: ecr.status,
    part: ecr.part
      ? { id: ecr.part.id, partNumber: ecr.part.partNumber, name: ecr.part.name }
      : null,
    ecn: ecr.ecn ? { id: ecr.ecn.id, ecnNumber: ecr.ecn.ecnNumber } : null,
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

// ---------------------------------------------------------------------------
// GET /my-work — the current user's PLM inbox
// ---------------------------------------------------------------------------

router.get(
  '/my-work',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);

    const [reviews, tasks, revisions, ecrs, ecns] = await Promise.all([
      // My PENDING reviews on ECNs currently in review, newest first.
      prisma.ecnReview.findMany({
        where: {
          reviewerId: userId,
          decision: EcnReviewDecision.PENDING,
          ecn: { status: EcnStatus.IN_REVIEW },
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
          workflow: { status: WorkflowStatus.RUNNING, ecn: { status: EcnStatus.IN_REVIEW } },
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
      // My IN_WORK revisions + the active ECN managing each (if any).
      prisma.partRevision.findMany({
        where: { createdById: userId, lifecycle: Lifecycle.IN_WORK },
        orderBy: { id: 'desc' },
        take: 20,
        include: {
          part: { select: { id: true, partNumber: true, name: true } },
          ecnItemsTo: {
            where: { ecn: { status: { in: ACTIVE_ECN_STATUSES } } },
            orderBy: { id: 'desc' },
            take: 1,
            select: { ecn: { select: { id: true, ecnNumber: true } } },
          },
        },
      }),
      // My open change requests.
      prisma.ecr.findMany({
        where: { createdById: userId, status: EcrStatus.OPEN },
        orderBy: { id: 'desc' },
        take: 20,
        include: ecrInclude,
      }),
      // Active ECNs I created.
      prisma.ecn.findMany({
        where: { createdById: userId, status: { in: ACTIVE_ECN_STATUSES } },
        orderBy: { id: 'desc' },
        take: 20,
        include: ecnSummaryInclude,
      }),
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
      openEcrs: ecrs.map(toEcrSummary),
      activeEcns: ecns.map(toEcnSummary),
    };
    res.json(payload);
  })
);

export default router;
