/**
 * Releasing an assembly and everything under it, in dependency order.
 *
 * WHY THIS EXISTS. Rule 2 refuses to release a revision while any BOM child part has no
 * RELEASED revision, so an assembly can only be released from the bottom up. Today that means
 * hand-walking the tree, working out which leaves to do first, and releasing them one at a
 * time — and getting the order wrong just produces a 409 that names some of the offenders and
 * tells you nothing about the shape of the problem.
 *
 * ---------------------------------------------------------------------------------
 * THE ORDER IS THE FEATURE, AND IT IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------------
 * The plan is a topological order of the parts in the structure, children before parents. It
 * is not a convenience: releasing a parent before its children is exactly what rule 2 forbids,
 * so a plan in the wrong order is not a slower plan, it is one that cannot run.
 *
 * ---------------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------------
 * **It never submits anything for review, and it never signs anything.** A revision reaches
 * IN_REVIEW because somebody decided it was ready, and it is released because the people named
 * in the signature manifest said so. Both are human acts with somebody's name on them, and a
 * cascade that quietly performed either would be forging the one part of this product that
 * must not be forgeable. A part sitting in IN_WORK is reported as blocking and left alone.
 *
 * **It is all or nothing.** Every planned release happens in one transaction, so a cascade
 * that fails halfway leaves nothing released. The alternative — half an assembly released,
 * with the caller holding a success message — is the state this endpoint exists to avoid, and
 * it is exactly what hand-walking the tree produces when somebody is interrupted.
 */
import { Request, Router } from 'express';
import { EcnStatus, Lifecycle, Prisma, SignedEntityType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';
import { pinChildRevisions } from '../lib/plm';
import { emitEvent } from '../lib/webhooks';
import { buildManifest } from './signatures';

const router = Router();
router.use(requireAuth);

/** Same cap as every other traversal in this product. */
const MAX_DEPTH = 15;

// ---------------------------------------------------------------------------
// DTO shapes
// ---------------------------------------------------------------------------

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
}

interface RedactedPartRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}

type MaybePartRefDto = PartRefDto | RedactedPartRefDto;

const redactedPart: RedactedPartRefDto = { ...REDACTED };

type StepBlockReason =
  | 'NOT_IN_REVIEW'
  | 'NO_WRITE_ACCESS'
  | 'MANAGED_BY_ECN'
  | 'SIGNATURES_OUTSTANDING'
  | 'RESTRICTED';

interface PlanStepDto {
  /** Depth-first position, children before parents. Lower runs first. */
  order: number;
  part: MaybePartRefDto;
  revision: { id: number; revision: string; lifecycle: Lifecycle } | null;
  /** How deep below the root this part sits. 0 is the root itself. */
  level: number;
  /** Null when the step is clear; otherwise why the cascade cannot run it. */
  blockedBy: StepBlockReason | null;
  explanation: string | null;
}

interface ReleasePlanDto {
  root: MaybePartRefDto;
  /** True only when every step is clear, so the cascade would run end to end. */
  runnable: boolean;
  /** Parts already released and therefore not in `steps`. */
  alreadyReleased: number;
  steps: PlanStepDto[];
  /** True when the walk hit the depth cap or a restricted subtree. */
  truncated: boolean;
  notes: string[];
}

interface CascadeResultDto extends ReleasePlanDto {
  /** Revisions actually released, in the order they were. */
  released: { partNumber: string; revision: string; revisionId: number }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function toPartRef(part: { id: number; partNumber: string; name: string }): PartRefDto {
  return { id: part.id, partNumber: part.partNumber, name: part.name };
}

async function canWrite(partId: number, user: AclUser): Promise<boolean> {
  try {
    await assertCanWrite('PART', partId, user);
    return true;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

interface PartNode {
  id: number;
  partNumber: string;
  name: string;
  revisions: { id: number; revision: string; lifecycle: Lifecycle }[];
}

/**
 * The parts beneath this revision, with their depth, children before parents.
 *
 * A part reached by two routes keeps its DEEPEST level, because the order has to satisfy
 * every path: a part that is both a direct child and a grandchild must still be released
 * before the assembly that contains it either way.
 */
async function walkStructure(
  rootRevisionId: number,
  rootPartId: number,
  user: AclUser
): Promise<{ levels: Map<number, number>; hidden: Set<number>; truncated: boolean }> {
  const levels = new Map<number, number>([[rootPartId, 0]]);
  const hidden = new Set<number>();
  let truncated = false;
  let frontier: { partId: number; revisionId: number }[] = [
    { partId: rootPartId, revisionId: rootRevisionId },
  ];
  const expanded = new Set<number>();

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: { in: frontier.map((f) => f.revisionId) } },
      select: {
        childPartId: true,
        childPart: {
          select: { id: true, revisions: { select: { id: true, lifecycle: true } } },
        },
      },
    });
    if (lines.length === 0) break;

    const childIds = [...new Set(lines.map((line) => line.childPartId))];
    const visible = await visibleIds('PART', childIds, user);
    const next: { partId: number; revisionId: number }[] = [];

    for (const line of lines) {
      const childId = line.childPartId;
      levels.set(childId, Math.max(levels.get(childId) ?? 0, depth + 1));
      if (!visible.has(childId)) {
        // Not descended into: its structure is its own data. It is still a step, because the
        // release gate will block on it whatever this caller can see.
        hidden.add(childId);
        truncated = true;
        continue;
      }
      if (expanded.has(childId)) continue;
      expanded.add(childId);
      // Walk through the revision the release gate will care about — the latest one, which is
      // what rule 5 resolves to when nothing is released yet.
      const latest = [...line.childPart.revisions].sort((a, b) => b.id - a.id)[0];
      if (latest) next.push({ partId: childId, revisionId: latest.id });
    }
    frontier = next;
    if (depth === MAX_DEPTH - 1 && next.length > 0) truncated = true;
  }

  return { levels, hidden, truncated };
}

/** Build the ordered plan. Shared by the preview and the execution, so they cannot diverge. */
async function buildPlan(
  rootRevisionId: number,
  user: AclUser
): Promise<{ plan: ReleasePlanDto; runnable: PlanStepDto[] }> {
  const rootRevision = await prisma.partRevision.findFirst({
    where: { id: rootRevisionId, part: aclFilter('PART', user) as Prisma.PartWhereInput },
    select: {
      id: true,
      revision: true,
      lifecycle: true,
      partId: true,
      part: { select: { id: true, partNumber: true, name: true } },
    },
  });
  if (!rootRevision) throw new HttpError(404, 'Revision not found');

  const { levels, hidden, truncated } = await walkStructure(
    rootRevisionId,
    rootRevision.partId,
    user
  );

  const parts = await prisma.part.findMany({
    where: { id: { in: [...levels.keys()] } },
    select: {
      id: true,
      partNumber: true,
      name: true,
      revisions: { select: { id: true, revision: true, lifecycle: true } },
    },
  });
  const partsById = new Map<number, PartNode>(parts.map((p) => [p.id, p]));

  // Deepest first: children before parents, which is the only order rule 2 permits.
  const ordered = [...levels.entries()].sort((a, b) => b[1] - a[1]);

  const steps: PlanStepDto[] = [];
  let alreadyReleased = 0;
  let order = 0;

  for (const [partId, level] of ordered) {
    const part = partsById.get(partId);
    if (hidden.has(partId) || !part) {
      // Counted and never named. Whether it needs releasing is unknowable from here, and
      // assuming it does not would produce a plan that stops with a 409 nobody predicted.
      steps.push({
        order: order++,
        part: redactedPart,
        revision: null,
        level,
        blockedBy: 'RESTRICTED',
        explanation:
          'This part is restricted. The release gate will still require it to have a ' +
          'released revision, so somebody with access has to deal with it.',
      });
      continue;
    }

    const released = part.revisions.some((r) => r.lifecycle === Lifecycle.RELEASED);
    // The root is always a step even if it has a released revision already: the caller asked
    // to release THIS revision, not to be told an older one was already out.
    if (released && partId !== rootRevision.partId) {
      alreadyReleased += 1;
      continue;
    }

    const candidate =
      partId === rootRevision.partId
        ? { id: rootRevision.id, revision: rootRevision.revision, lifecycle: rootRevision.lifecycle }
        : [...part.revisions].sort((a, b) => b.id - a.id)[0];

    const step: PlanStepDto = {
      order: order++,
      part: toPartRef(part),
      revision: candidate ?? null,
      level,
      blockedBy: null,
      explanation: null,
    };

    if (!candidate) {
      step.blockedBy = 'NOT_IN_REVIEW';
      step.explanation = 'This part has no revisions at all.';
    } else if (candidate.lifecycle !== Lifecycle.IN_REVIEW) {
      // Deliberately NOT submitted on the caller's behalf: a revision reaches review because
      // somebody decided it was ready, and that decision has their name on it.
      step.blockedBy = 'NOT_IN_REVIEW';
      step.explanation =
        `Revision ${candidate.revision} is ${candidate.lifecycle}. A cascade only releases ` +
        'revisions already in review — submitting one is a decision with somebody’s name ' +
        'on it, so it is left to a person.';
    } else if (!(await canWrite(partId, user))) {
      step.blockedBy = 'NO_WRITE_ACCESS';
      step.explanation = 'You do not have write access to this part.';
    } else {
      const managed = await prisma.ecnItem.findFirst({
        where: {
          toRevisionId: candidate.id,
          ecn: { status: { in: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED] } },
        },
        select: { ecn: { select: { id: true, ecnNumber: true } } },
      });
      if (managed) {
        const visibleEcn = await visibleIds('ECN', [managed.ecn.id], user);
        step.blockedBy = 'MANAGED_BY_ECN';
        step.explanation = visibleEcn.has(managed.ecn.id)
          ? `Managed by ${managed.ecn.ecnNumber} — progress the change through the ECN.`
          : 'Managed by a restricted change order — somebody with access has to progress it.';
      } else {
        // Voids stale signatures as it reads, exactly as the real gate does — see rule RR1.
        const manifest = await buildManifest(SignedEntityType.REVISION, candidate.id, null);
        if (!manifest.complete) {
          step.blockedBy = 'SIGNATURES_OUTSTANDING';
          step.explanation = `Signatures outstanding for: ${manifest.outstanding.join(', ')}.`;
        }
      }
    }

    steps.push(step);
  }

  const notes: string[] = [];
  const blocked = steps.filter((s) => s.blockedBy !== null);
  if (blocked.length > 0) {
    notes.push(
      `${blocked.length} of ${steps.length} steps cannot run. The cascade is all or nothing, ` +
        'so nothing is released until every step is clear — a half-released assembly is the ' +
        'state this exists to avoid.'
    );
  }
  if (hidden.size > 0) {
    notes.push(
      `${hidden.size} part${hidden.size === 1 ? '' : 's'} in this structure ${
        hidden.size === 1 ? 'is' : 'are'
      } restricted, shown as "Restricted" and not descended into. The plan below cannot be ` +
        'read as a complete account of the assembly.'
    );
  }
  if (truncated) {
    notes.push('The walk stopped early, so there may be parts below what is listed here.');
  }
  notes.push(
    'Nothing here is submitted for review or signed on your behalf. Both are decisions with ' +
      'a person’s name on them.'
  );

  const plan: ReleasePlanDto = {
    root: toPartRef(rootRevision.part),
    runnable: blocked.length === 0 && steps.length > 0,
    alreadyReleased,
    steps,
    truncated,
    notes,
  };
  return { plan, runnable: steps };
}

// ---------------------------------------------------------------------------
// GET /revisions/:id/release-plan
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id/release-plan',
  asyncHandler(async (req, res) => {
    const { plan } = await buildPlan(idParam(req.params.id), aclUser(req));
    res.json(plan);
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/release-cascade
// ---------------------------------------------------------------------------

router.post(
  '/revisions/:id/release-cascade',
  asyncHandler(async (req, res) => {
    const rootRevisionId = idParam(req.params.id);
    const user = aclUser(req);

    // The plan is rebuilt here rather than taken from the request: a client that cached one
    // from five minutes ago would otherwise decide what gets released now.
    const { plan, runnable } = await buildPlan(rootRevisionId, user);

    if (!plan.runnable) {
      const first = runnable.find((step) => step.blockedBy !== null);
      throw new HttpError(
        409,
        `Cannot release this assembly: ${
          runnable.filter((s) => s.blockedBy !== null).length
        } step(s) are blocked, starting with ${
          first && 'redacted' in first.part ? 'a restricted part' : first?.part.partNumber
        } — ${first?.explanation ?? 'see the release plan'}`
      );
    }

    const released: CascadeResultDto['released'] = [];

    await prisma.$transaction(async (tx) => {
      for (const step of runnable) {
        if (!step.revision || 'redacted' in step.part) continue;
        const revisionId = step.revision.id;

        /*
         * Rule 2 again, INSIDE the transaction and per step.
         *
         * The plan established the order, which is what makes this satisfiable at all — by
         * the time a parent is reached its children have been released in this same
         * transaction. It is re-checked rather than assumed because the plan was computed
         * before the transaction opened, and because a child outside the walked structure
         * (one reached only through a restricted subtree) would never have been in it.
         */
        const lines = await tx.bomLine.findMany({
          where: { parentRevisionId: revisionId },
          select: {
            childPart: { select: { id: true, partNumber: true, revisions: { select: { lifecycle: true } } } },
          },
        });
        const offending = lines.filter(
          (line) => !line.childPart.revisions.some((r) => r.lifecycle === Lifecycle.RELEASED)
        );
        if (offending.length > 0) {
          const visible = await visibleIds(
            'PART',
            offending.map((l) => l.childPart.id),
            user
          );
          const names = [
            ...new Set(
              offending.map((l) =>
                visible.has(l.childPart.id) ? l.childPart.partNumber : REDACTED.partNumber
              )
            ),
          ].sort();
          throw new HttpError(
            409,
            `Cannot release ${step.part.partNumber} rev ${step.revision.revision}: child ` +
              `parts without a released revision: ${names.join(', ')}. Nothing was released.`
          );
        }

        // Conditional, like the single-revision path: two concurrent transitions must not
        // both win, and a revision that moved since the plan was built is not released here.
        const result = await tx.partRevision.updateMany({
          where: { id: revisionId, lifecycle: Lifecycle.IN_REVIEW },
          data: { lifecycle: Lifecycle.RELEASED, releasedAt: new Date() },
        });
        if (result.count === 0) {
          throw new HttpError(
            409,
            `${step.part.partNumber} rev ${step.revision.revision} changed while this ran — ` +
              'nothing was released. Re-check the plan and try again.'
          );
        }

        // Freeze the structure at the moment of release, in the same transaction, so a
        // released assembly can never exist without its pins (rule PN3).
        await pinChildRevisions(tx, revisionId);

        const payload = {
          partId: step.part.id,
          partNumber: step.part.partNumber,
          revisionId,
          revision: step.revision.revision,
          lifecycle: Lifecycle.RELEASED,
        };
        await emitEvent(tx, 'revision.released', payload);
        await emitEvent(tx, 'part.released', payload);

        released.push({
          partNumber: step.part.partNumber,
          revision: step.revision.revision,
          revisionId,
        });
      }
    });

    const after = await buildPlan(rootRevisionId, user);
    const payload: CascadeResultDto = { ...after.plan, released };
    res.json(payload);
  })
);

export default router;
