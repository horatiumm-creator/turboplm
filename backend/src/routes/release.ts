/**
 * Release readiness — every reason this revision cannot be released, in one answer.
 *
 * WHY THIS EXISTS. Releasing a revision runs a chain of gates in
 * `POST /revisions/:id/transition` (routes/parts.ts), and each one throws the moment it
 * fails. So the only way to find out what is wrong is to try to release, read one 409, fix
 * it, try again, read the next — on an assembly with forty children that is a morning. This
 * endpoint runs the same checks and reports them all at once, without changing anything.
 *
 * THE PROPERTY THAT MAKES IT WORTH HAVING, and the only one that can really break it:
 *
 *   `ready: true` MUST MEAN THE RELEASE WILL ACTUALLY SUCCEED.
 *
 * A readiness screen that says "ready" and then 409s is worse than no screen, because people
 * stop reading it after the first time it lies. So every blocker below is computed from the
 * SAME source as the gate it mirrors — `buildManifest` for signatures, the same ECN query,
 * the same child-revision test — rather than from a second implementation that can drift.
 * `tests/release-readiness.test.ts` asserts the two agree by actually attempting the release.
 *
 * BLOCKERS VERSUS ADVISORIES. A blocker is a condition that WILL refuse the release today. An
 * advisory is something worth knowing that will not. They are separate fields and advisories
 * never touch `ready`, because inflating an advisory into a blocker teaches people that the
 * blockers are negotiable — and the one thing this screen has to keep is that its blockers
 * are exactly the things that stop you.
 */
import { Request, Router } from 'express';
import {
  ComplianceStatus,
  EcnStatus,
  Lifecycle,
  PartLifecycle,
  Prisma,
  SignedEntityType,
  WaiverStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';
import { buildManifest } from './signatures';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes
// ---------------------------------------------------------------------------

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
}

/** A linked item the caller may not read: counted, never named (rule X4). */
interface RedactedPartRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}

type MaybePartRefDto = PartRefDto | RedactedPartRefDto;

/**
 * Why the release is refused, and what clears it.
 *
 * `summary` is written to be shown verbatim. Where the real gate has a sentence, this is that
 * sentence — so the screen and the 409 cannot describe the same condition two different ways.
 */
type BlockerKind =
  | 'NO_WRITE_ACCESS'
  | 'WRONG_LIFECYCLE'
  | 'MANAGED_BY_ECN'
  | 'SIGNATURES_OUTSTANDING'
  | 'UNRELEASED_CHILDREN';

interface BlockerDto {
  kind: BlockerKind;
  summary: string;
  /** What to do about it, in one sentence. */
  remedy: string;
  /** Present on UNRELEASED_CHILDREN: the children, restricted ones redacted in place. */
  parts?: MaybePartRefDto[];
  /** Present on SIGNATURES_OUTSTANDING: the meanings still needed. */
  meanings?: string[];
}

type AdvisoryKind =
  | 'COMPONENT_OBSOLESCENCE'
  | 'COMPLIANCE_NON_COMPLIANT'
  | 'COMPLIANCE_NOT_DECLARED'
  | 'OPEN_WAIVERS';

/**
 * Worth knowing, and NOT a reason the release is refused. Whether an end-of-life component or
 * an undeclared substance should stop a release is a decision this product does not make for
 * anybody — so it is reported here and the gate is left alone.
 */
interface AdvisoryDto {
  kind: AdvisoryKind;
  summary: string;
  parts?: MaybePartRefDto[];
  /** Where to get the authoritative answer, when this signal is a cheap approximation. */
  seeAlso?: string;
}

interface ReleaseReadinessDto {
  revision: {
    id: number;
    revision: string;
    lifecycle: Lifecycle;
    part: PartRefDto;
  };
  /**
   * True only when `blockers` is empty. Advisories never make it false, and nothing here
   * makes it true while something could not be checked — see `notes`.
   */
  ready: boolean;
  blockers: BlockerDto[];
  advisories: AdvisoryDto[];
  /** What this answer could not do completely. Always render it. */
  notes: string[];
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

const redactedPart: RedactedPartRefDto = { ...REDACTED };

/**
 * A revision carries no grants of its own; it is exactly as visible as its part. Resolved
 * through the part's read filter so a restricted part's revision fails identically to a
 * revision id that does not exist (rules X2–X3) — the same construction routes/signatures.ts
 * uses for the same reason.
 */
async function readableRevision(id: number, user: AclUser) {
  const revision = await prisma.partRevision.findFirst({
    where: { id, part: aclFilter('PART', user) as Prisma.PartWhereInput },
    select: {
      id: true,
      revision: true,
      lifecycle: true,
      partId: true,
      part: { select: { id: true, partNumber: true, name: true } },
    },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');
  return revision;
}

/**
 * Does this caller hold WRITE on the part?
 *
 * Asked by CALLING THE REAL GATE and catching its refusal, rather than by rebuilding its
 * `where` here. The write filter is not quite what it looks like — a group grant only counts
 * while the group is `active: true` — and a copy of it in this file would have reported a user
 * in a deactivated group as ready to release, right up to the 403. The whole value of this
 * endpoint is that it cannot disagree with the gate, so it does not get its own opinion about
 * who may write.
 */
async function canWritePart(partId: number, user: AclUser): Promise<boolean> {
  try {
    await assertCanWrite('PART', partId, user);
    return true;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /revisions/:id/release-readiness
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id/release-readiness',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await readableRevision(id, user);

    const blockers: BlockerDto[] = [];
    const advisories: AdvisoryDto[] = [];
    const notes: string[] = [];

    /*
     * --- Gate 0: may THIS CALLER write at all ---------------------------------
     *
     * TWO SEPARATE GATES, and missing the first is how this endpoint first lied. Item-level
     * access (`assertCanWrite`) treats a part with no grants as writable by anyone who can
     * read it, so it passes for a VIEWER — who is then refused by `requireWriteRole` BEFORE
     * the transition handler runs at all. Checking only the ACL reported a viewer's release
     * as ready right up to the 403.
     *
     * So the role gate is mirrored here in the middleware's own precedence: the role first (a
     * VIEWER may never write, whatever the part's grants say), then the part's own grants.
     */
    const roleMayWrite = user.role === 'ENGINEER' || user.role === 'ADMIN';
    if (!roleMayWrite) {
      blockers.push({
        kind: 'NO_WRITE_ACCESS',
        summary: 'Viewers have read-only access, so you cannot release this revision',
        remedy: 'Ask somebody with an engineer or administrator role to release it.',
      });
    } else if (!(await canWritePart(revision.partId, user))) {
      blockers.push({
        kind: 'NO_WRITE_ACCESS',
        summary: 'You do not have write access to this part, so you cannot release it',
        remedy: 'Ask somebody with write access on the part, or an administrator, to release it.',
      });
    }

    // --- Gate 1: the revision must be IN_REVIEW ------------------------------
    if (revision.lifecycle !== Lifecycle.IN_REVIEW) {
      blockers.push({
        kind: 'WRONG_LIFECYCLE',
        summary: `Revision ${revision.revision} is ${revision.lifecycle} (release requires IN_REVIEW)`,
        remedy:
          revision.lifecycle === Lifecycle.IN_WORK
            ? 'Submit it for review first.'
            : 'Only a revision in review can be released.',
      });
    }

    // --- Gate 2: managed by an active ECN ------------------------------------
    // Deliberately NOT acl-filtered, exactly as the gate is not: an ECN the caller cannot see
    // still governs this revision, and filtering it away here would report the release as
    // ready when it is about to be refused. Only the NAME is redacted.
    const managedBy = await prisma.ecnItem.findFirst({
      where: {
        toRevisionId: id,
        ecn: { status: { in: [EcnStatus.DRAFT, EcnStatus.IN_REVIEW, EcnStatus.APPROVED] } },
      },
      select: { ecn: { select: { id: true, ecnNumber: true, status: true } } },
    });
    if (managedBy) {
      const visibleEcn = await visibleIds('ECN', [managedBy.ecn.id], user);
      const named = visibleEcn.has(managedBy.ecn.id);
      blockers.push({
        kind: 'MANAGED_BY_ECN',
        summary: named
          ? `Revision is managed by ${managedBy.ecn.ecnNumber} (${managedBy.ecn.status}) — progress the change through the ECN`
          : 'Revision is managed by a restricted ECN — progress the change through the ECN',
        remedy: named
          ? `Release it by approving and releasing ${managedBy.ecn.ecnNumber}.`
          : 'Somebody with access to that change order has to progress it.',
      });
    }

    // --- Gate 3: the signature manifest --------------------------------------
    /*
     * A revision released THROUGH an ECN is gated by that ECN's manifest instead and is not
     * asked to satisfy both (rule S4), so this check is skipped exactly when the real gate
     * skips it.
     *
     * NOTE THAT THIS READ WRITES. `buildManifest` voids any signature whose content has
     * changed since it was given, which is the whole reason a stale signature cannot satisfy
     * a gate. Calling a cheaper non-voiding copy here would let this endpoint report
     * "signatures complete" on a manifest the release is about to void and refuse — the exact
     * lie the file is written against. `GET /:entityType/:id/signatures` already accepts the
     * same trade for the same reason.
     */
    if (!managedBy) {
      const manifest = await buildManifest(SignedEntityType.REVISION, id, null);
      if (!manifest.complete) {
        blockers.push({
          kind: 'SIGNATURES_OUTSTANDING',
          summary: `Signatures outstanding for: ${manifest.outstanding.join(', ')}`,
          remedy: 'Each outstanding meaning needs a valid signature from somebody who satisfies it.',
          meanings: manifest.outstanding,
        });
      }
    }

    // --- Gate 4: every BOM child must have a RELEASED revision ---------------
    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: id },
      select: {
        childPart: {
          select: {
            id: true,
            partNumber: true,
            name: true,
            revisions: { select: { lifecycle: true } },
          },
        },
      },
    });
    const childParts = lines.map((line) => line.childPart);
    const unreleased = childParts.filter(
      (child) => !child.revisions.some((r) => r.lifecycle === Lifecycle.RELEASED)
    );
    // Distinct, because one child may sit on several lines and the gate counts parts.
    const unreleasedById = new Map(unreleased.map((child) => [child.id, child]));

    const visibleChildren = await visibleIds('PART', [...unreleasedById.keys()], user);
    if (unreleasedById.size > 0) {
      // The gate blocks on a restricted child too — the release must not depend on who is
      // looking — but naming it would leak a part number, so it is counted in place.
      const parts: MaybePartRefDto[] = [...unreleasedById.values()]
        .map((child) => (visibleChildren.has(child.id) ? toPartRef(child) : redactedPart))
        .sort((a, b) => a.partNumber.localeCompare(b.partNumber));
      const hiddenCount = parts.filter((p) => 'redacted' in p).length;
      blockers.push({
        kind: 'UNRELEASED_CHILDREN',
        summary:
          `Cannot release: ${unreleasedById.size} child part` +
          `${unreleasedById.size === 1 ? '' : 's'} without a released revision`,
        remedy: 'Release each child part first; the assembly cannot be released ahead of them.',
        parts,
      });
      if (hiddenCount > 0) {
        notes.push(
          `${hiddenCount} of the child parts blocking this release ${
            hiddenCount === 1 ? 'is' : 'are'
          } restricted and shown as "Restricted". They still block it — somebody with access ` +
            'to them has to release them.'
        );
      }
    }

    // --- Advisories ----------------------------------------------------------
    /*
     * DIRECT CHILDREN AND THIS PART ONLY, and the notes say so.
     *
     * The authoritative compliance answer is the assembly roll-up, which walks the whole
     * structure; repeating that walk here would be a second implementation of rule CM1 and
     * the two would eventually disagree. A cheap signal that says what it covers is honest.
     * A cheap signal presented as the whole answer is not.
     */
    const scopeIds = [revision.partId, ...childParts.map((c) => c.id)];
    const distinctScope = [...new Set(scopeIds)];
    const visibleScope = await visibleIds('PART', distinctScope, user);
    const partsById = new Map<number, { id: number; partNumber: string; name: string }>([
      [revision.part.id, revision.part],
      ...childParts.map(
        (c) => [c.id, { id: c.id, partNumber: c.partNumber, name: c.name }] as const
      ),
    ]);
    const refFor = (partId: number): MaybePartRefDto => {
      const part = partsById.get(partId);
      return part && visibleScope.has(partId) ? toPartRef(part) : redactedPart;
    };

    const [nonCompliant, declarations, atRiskMpns, liveWaivers] = await Promise.all([
      prisma.partCompliance.findMany({
        where: { partId: { in: distinctScope }, status: ComplianceStatus.NON_COMPLIANT },
        select: { partId: true, regulation: true },
      }),
      prisma.partCompliance.findMany({
        where: { partId: { in: distinctScope } },
        select: { partId: true },
      }),
      prisma.manufacturerPart.findMany({
        where: {
          partId: { in: distinctScope },
          lifecycle: {
            in: [PartLifecycle.NRND, PartLifecycle.EOL_ANNOUNCED, PartLifecycle.OBSOLETE],
          },
        },
        select: { partId: true, lifecycle: true },
      }),
      prisma.waiver.findMany({
        where: { partId: revision.partId, status: WaiverStatus.APPROVED },
        select: { id: true, waiverNumber: true },
      }),
    ]);

    if (nonCompliant.length > 0) {
      const ids = [...new Set(nonCompliant.map((row) => row.partId))];
      advisories.push({
        kind: 'COMPLIANCE_NON_COMPLIANT',
        summary:
          `${ids.length} part${ids.length === 1 ? '' : 's'} in this assembly ` +
          `${ids.length === 1 ? 'is' : 'are'} declared NON_COMPLIANT for at least one regulation`,
        parts: ids.map(refFor),
        seeAlso: `/parts/${revision.partId}/compliance-rollup`,
      });
    }

    const declaredIds = new Set(declarations.map((row) => row.partId));
    const undeclared = distinctScope.filter((partId) => !declaredIds.has(partId));
    if (undeclared.length > 0) {
      advisories.push({
        kind: 'COMPLIANCE_NOT_DECLARED',
        summary:
          `${undeclared.length} part${undeclared.length === 1 ? '' : 's'} here ` +
          `${undeclared.length === 1 ? 'has' : 'have'} no compliance declaration at all — ` +
          'nobody has said anything about them, which is not the same as compliant',
        parts: undeclared.map(refFor),
        seeAlso: `/parts/${revision.partId}/compliance-rollup`,
      });
    }

    if (atRiskMpns.length > 0) {
      const ids = [...new Set(atRiskMpns.map((row) => row.partId))];
      advisories.push({
        kind: 'COMPONENT_OBSOLESCENCE',
        summary:
          `${ids.length} part${ids.length === 1 ? '' : 's'} here ` +
          `${ids.length === 1 ? 'has a source' : 'have sources'} the manufacturer has stopped ` +
          'standing behind (NRND, end-of-life or obsolete)',
        parts: ids.map(refFor),
        seeAlso: '/obsolescence/risk',
      });
    }

    if (liveWaivers.length > 0) {
      advisories.push({
        kind: 'OPEN_WAIVERS',
        summary:
          `${liveWaivers.length} approved waiver${liveWaivers.length === 1 ? '' : 's'} ` +
          `on this part: ${liveWaivers.map((w) => w.waiverNumber).join(', ')}. A waiver permits ` +
          'a departure from the released design — check it still describes what you are releasing.',
        seeAlso: `/waivers?partId=${revision.partId}`,
      });
    }

    notes.push(
      'Advisories never block a release. Whether an end-of-life component or an undeclared ' +
        'substance should stop one is a decision this product does not make for you.'
    );
    notes.push(
      'The compliance and obsolescence signals above cover THIS PART AND ITS DIRECT CHILDREN ' +
        'only. The assembly roll-up walks the whole structure and is the authoritative answer.'
    );

    const payload: ReleaseReadinessDto = {
      revision: {
        id: revision.id,
        revision: revision.revision,
        lifecycle: revision.lifecycle,
        part: toPartRef(revision.part),
      },
      ready: blockers.length === 0,
      blockers,
      advisories,
      notes,
    };
    res.json(payload);
  })
);

export default router;
