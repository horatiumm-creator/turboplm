/**
 * Replacing one part with another everywhere it is used.
 *
 * WHY THIS EXISTS. `GET /obsolescence/risk` tells you a component is end-of-life and names a
 * replacement; `GET /parts/:id/where-used` tells you the forty assemblies that contain it.
 * Until now the only way to act on that was to open forty BOMs by hand, which is how a
 * half-finished swap happens — somebody gets through thirty, is interrupted, and nobody can
 * tell which thirty.
 *
 * ---------------------------------------------------------------------------------
 * THE FACT THAT SHAPES THE WHOLE ENDPOINT
 * ---------------------------------------------------------------------------------
 * **MOST USAGES CANNOT BE CHANGED, AND THAT IS NOT A BUG.** Rule 1 — the edit gate — allows
 * BOM mutations only while the owning revision is IN_WORK. A released BOM is a historical
 * record of what was released; editing it would rewrite what shipped. So on a mature part the
 * honest answer is usually "three of these forty can be changed, and here are the
 * thirty-seven that cannot, and why".
 *
 * An endpoint that quietly did the three and reported success would be the worst possible
 * shape for this: the caller would believe the part had been replaced everywhere. So
 * `blocked` is a first-class part of the response, never a footnote, and the dry run exists
 * so the whole picture is visible BEFORE anything is written.
 *
 * ---------------------------------------------------------------------------------
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS PER-USAGE RATHER THAN GLOBAL
 * ---------------------------------------------------------------------------------
 * A swap across forty assemblies will hit a reason to skip somewhere. Failing the whole
 * operation on the first one would make the feature useless exactly when it matters, so each
 * usage carries its own verdict and the write proceeds for the ones that are clear. The
 * caller is told precisely what was left behind.
 *
 *  - `REVISION_NOT_IN_WORK` — rule 1, above. By far the most common.
 *  - `NO_WRITE_ACCESS` — the caller may not write that parent part (rule X2). Counted and,
 *    where the parent itself is unreadable, not named.
 *  - `ALREADY_PRESENT` — the parent's BOM already carries the replacement, and rule 8 allows
 *    a child part only once per parent revision. Merging the two lines by summing quantities
 *    is NOT done: that is a judgement about the design (are these two uses of the same part,
 *    or one use and one spare?) and inventing an answer would silently change a quantity.
 *  - `WOULD_CYCLE` — rule 4. The replacement is reachable from the parent, so the swap would
 *    make the structure contain itself.
 *
 * ---------------------------------------------------------------------------------
 * WHAT IT PRESERVES
 * ---------------------------------------------------------------------------------
 * Only `childPartId` changes. The find number, quantity, unit of measure, reference
 * designators, effectivity dates and the pinned child revision stay as they are, because the
 * engineering intent they record is about the POSITION in the assembly, not about which part
 * sits in it. The one exception is `childRevisionId`: a pin names a revision OF THE OLD PART
 * and cannot survive the swap, so it is cleared and the response says how many were cleared.
 */
import { Request, Router } from 'express';
import { Lifecycle, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';

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

interface RedactedPartRefDto {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}

type MaybePartRefDto = PartRefDto | RedactedPartRefDto;

const redactedPart: RedactedPartRefDto = { ...REDACTED };

type SkipReason = 'REVISION_NOT_IN_WORK' | 'NO_WRITE_ACCESS' | 'ALREADY_PRESENT' | 'WOULD_CYCLE';

/** One BOM line that uses the part being replaced. */
interface UsageDto {
  bomLineId: number;
  parentPart: MaybePartRefDto;
  parentRevision: { id: number; revision: string; lifecycle: Lifecycle };
  findNumber: number;
  quantity: number;
  uom: string;
  /** True when this line pinned a revision of the OLD part, which the swap must clear. */
  hadPinnedRevision: boolean;
}

interface BlockedUsageDto extends UsageDto {
  reason: SkipReason;
  /** The sentence to show. Written per reason so a reader knows what to do next. */
  explanation: string;
}

interface ReplaceResultDto {
  from: MaybePartRefDto;
  to: MaybePartRefDto;
  /** True when nothing was written — the preview. */
  dryRun: boolean;
  /** Usages that were changed (or, on a dry run, that WOULD be). */
  changed: UsageDto[];
  /** Usages that cannot be changed, each with its reason. Never a footnote. */
  blocked: BlockedUsageDto[];
  counts: {
    /** Every line using the old part, including ones this caller cannot read. */
    totalUsages: number;
    changed: number;
    blocked: number;
    /**
     * Usages on parents this caller cannot read at all. They are in `totalUsages` and in
     * `blocked` with their identity stripped — never dropped, because a swap that reported
     * "done" while leaving unreadable assemblies untouched would be read as complete.
     */
    restricted: number;
    /** Pins to a revision of the old part that were cleared. */
    clearedRevisionPins: number;
  };
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

async function readablePartOrThrow(id: number, user: AclUser) {
  const part = await prisma.part.findFirst({
    where: { id, ...(aclFilter('PART', user) as Prisma.PartWhereInput) },
    select: { id: true, partNumber: true, name: true },
  });
  if (!part) throw new HttpError(404, 'Part not found');
  return part;
}

/** Same construction as `canWritePart` in routes/release.ts, and for the same reason. */
async function canWritePart(partId: number, user: AclUser): Promise<boolean> {
  try {
    await assertCanWrite('PART', partId, user);
    return true;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

/**
 * Rule 4 — the set of part ids reachable downward from each of several starting points, in ONE
 * pass over the edges.
 *
 * `assertNoCycle` in routes/bom.ts answers this for a single (parent, child) pair and reads
 * every BomLine to do it. A replace asks the same question once per candidate parent, so
 * asking it that way would read the whole edge table forty times. The adjacency map is built
 * once here and each parent is tested against it.
 */
async function reachableFrom(startIds: number[]): Promise<Map<number, Set<number>>> {
  const edges = await prisma.bomLine.findMany({
    select: { childPartId: true, parentRevision: { select: { partId: true } } },
  });
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const from = edge.parentRevision.partId;
    const targets = adjacency.get(from);
    if (targets) targets.push(edge.childPartId);
    else adjacency.set(from, [edge.childPartId]);
  }

  const result = new Map<number, Set<number>>();
  for (const start of new Set(startIds)) {
    const visited = new Set<number>([start]);
    const queue = [start];
    for (const current of queue) {
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    result.set(start, visited);
  }
  return result;
}

// ---------------------------------------------------------------------------
// POST /parts/:id/replace
// ---------------------------------------------------------------------------

router.post(
  '/parts/:id/replace',
  asyncHandler(async (req, res) => {
    const fromId = idParam(req.params.id);
    const user = aclUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Access before anything else: a 400 about the body raised ahead of it would confirm the
    // part exists (rule X3).
    const fromPart = await readablePartOrThrow(fromId, user);

    if (body.withPartId === undefined || body.withPartId === null) {
      throw new HttpError(400, 'withPartId is required');
    }
    const toId = idParam(String(body.withPartId), 'withPartId');
    if (toId === fromId) {
      throw new HttpError(400, 'A part cannot be replaced with itself');
    }
    const toPart = await readablePartOrThrow(toId, user);

    /*
     * DRY RUN IS THE DEFAULT.
     *
     * The caller must say `dryRun: false` to write. A bulk structural edit across assemblies
     * somebody else owns is not something to do because a request arrived without a flag, and
     * the preview is the whole point of the feature — the default should be the safe reading
     * of an ambiguous request, not the destructive one.
     */
    const dryRun = body.dryRun !== false;

    // Every line using the old part, unfiltered: the counts must cover usages this caller
    // cannot read, or a swap would report "done" while leaving assemblies untouched (rule X4).
    const lines = await prisma.bomLine.findMany({
      where: { childPartId: fromId },
      select: {
        id: true,
        findNumber: true,
        quantity: true,
        uom: true,
        childRevisionId: true,
        parentRevision: {
          select: {
            id: true,
            revision: true,
            lifecycle: true,
            partId: true,
            part: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    const parentPartIds = [...new Set(lines.map((line) => line.parentRevision.partId))];
    const visibleParents = await visibleIds('PART', parentPartIds, user);

    // Write access, asked once per distinct parent rather than once per line.
    const writable = new Map<number, boolean>();
    await Promise.all(
      parentPartIds.map(async (partId) => {
        writable.set(partId, visibleParents.has(partId) ? await canWritePart(partId, user) : false);
      })
    );

    // Which parents already carry the replacement (rule 8), in one query.
    const existing = await prisma.bomLine.findMany({
      where: { childPartId: toId, parentRevisionId: { in: lines.map((l) => l.parentRevision.id) } },
      select: { parentRevisionId: true },
    });
    const alreadyHasReplacement = new Set(existing.map((row) => row.parentRevisionId));

    // Rule 4, for every candidate parent at once.
    const reachable = await reachableFrom([toId]);
    const fromReplacement = reachable.get(toId) ?? new Set<number>();

    const changed: UsageDto[] = [];
    const blocked: BlockedUsageDto[] = [];
    let clearedRevisionPins = 0;

    for (const line of lines) {
      const parentVisible = visibleParents.has(line.parentRevision.partId);
      const usage: UsageDto = {
        bomLineId: line.id,
        parentPart: parentVisible ? toPartRef(line.parentRevision.part) : redactedPart,
        parentRevision: {
          id: line.parentRevision.id,
          revision: line.parentRevision.revision,
          lifecycle: line.parentRevision.lifecycle,
        },
        findNumber: line.findNumber,
        quantity: line.quantity,
        uom: line.uom,
        hadPinnedRevision: line.childRevisionId !== null,
      };

      const block = (reason: SkipReason, explanation: string) =>
        blocked.push({ ...usage, reason, explanation });

      if (!parentVisible || !writable.get(line.parentRevision.partId)) {
        block(
          'NO_WRITE_ACCESS',
          'You do not have write access to this assembly, so this usage was left as it is.'
        );
        continue;
      }
      if (line.parentRevision.lifecycle !== Lifecycle.IN_WORK) {
        block(
          'REVISION_NOT_IN_WORK',
          `Revision ${line.parentRevision.revision} is ${line.parentRevision.lifecycle} and ` +
            'cannot be modified. A released BOM records what was released — revise the part ' +
            'and make the change on the new revision.'
        );
        continue;
      }
      if (alreadyHasReplacement.has(line.parentRevision.id)) {
        block(
          'ALREADY_PRESENT',
          `${toPart.partNumber} is already on this BOM, and a part may appear only once per ` +
            'revision. Decide whether the two uses should be merged, and by what quantity — ' +
            'this endpoint will not guess.'
        );
        continue;
      }
      if (fromReplacement.has(line.parentRevision.partId)) {
        block(
          'WOULD_CYCLE',
          `${line.parentRevision.part.partNumber} is reachable from ${toPart.partNumber}, so ` +
            'this swap would make the structure contain itself.'
        );
        continue;
      }

      changed.push(usage);
      if (line.childRevisionId !== null) clearedRevisionPins += 1;
    }

    if (!dryRun && changed.length > 0) {
      /*
       * One transaction for the whole swap. A partial write is the state this endpoint exists
       * to prevent — "somebody got through thirty and was interrupted" is the problem, and
       * reproducing it with a crash halfway through the loop would be no better than doing it
       * by hand.
       *
       * The verdicts above were computed from a read taken before this opened. A concurrent
       * release or a concurrent identical swap can invalidate one between then and now, so
       * each update is CONDITIONAL on the facts that justified it — the line still points at
       * the old part, and its revision is still IN_WORK. A row that no longer matches is not
       * written, and the count is checked below.
       */
      const ids = changed.map((usage) => usage.bomLineId);
      const applied = await prisma.$transaction(async (tx) =>
        tx.bomLine.updateMany({
          where: {
            id: { in: ids },
            childPartId: fromId,
            parentRevision: { lifecycle: Lifecycle.IN_WORK },
          },
          // The pin names a revision of the OLD part and cannot survive the swap.
          data: { childPartId: toId, childRevisionId: null },
        })
      );
      if (applied.count !== ids.length) {
        // Reported rather than swallowed: the caller was shown a plan and part of it did not
        // happen. They need to know the number, not a success message.
        throw new HttpError(
          409,
          `${applied.count} of ${ids.length} usages were replaced — the rest changed while ` +
            'this ran (a release, or the same swap from elsewhere). Re-run the preview to see ' +
            'the current state.'
        );
      }
    }

    const restricted = lines.filter(
      (line) => !visibleParents.has(line.parentRevision.partId)
    ).length;

    const notes: string[] = [];
    if (dryRun) {
      // Worded for the person reading it on a screen, not for the API caller: `notes` is
      // rendered verbatim in the UI, and telling somebody who is about to press a button to
      // "send dryRun: false" describes a request they are not making. How to apply it over
      // the API belongs in the client function's doc comment and in CONTRACTS, where an API
      // caller is actually looking.
      notes.push('Nothing has been changed yet — this is a preview of what the swap would do.');
    }
    if (blocked.length > 0) {
      notes.push(
        `${blocked.length} of ${lines.length} usages cannot be changed and were left exactly ` +
          'as they are. This is normal — a released BOM records what was released, and most ' +
          'usages of an established part are on released revisions.'
      );
    }
    if (restricted > 0) {
      notes.push(
        `${restricted} usage${restricted === 1 ? '' : 's'} ${
          restricted === 1 ? 'is' : 'are'
        } in an assembly you may not read, shown as "Restricted". They are counted here and ` +
          'were not changed — somebody with access to them has to make the same swap.'
      );
    }
    if (clearedRevisionPins > 0) {
      notes.push(
        `${clearedRevisionPins} line${clearedRevisionPins === 1 ? '' : 's'} pinned a specific ` +
          `revision of ${fromPart.partNumber}. A pin names a revision of the part being ` +
          'replaced and cannot carry across, so it was cleared and those lines now resolve to ' +
          `the released revision of ${toPart.partNumber}.`
      );
    }
    if (lines.length === 0) {
      notes.push(`${fromPart.partNumber} is not used on any BOM, so there was nothing to replace.`);
    }

    const payload: ReplaceResultDto = {
      from: toPartRef(fromPart),
      to: toPartRef(toPart),
      dryRun,
      changed,
      blocked,
      counts: {
        totalUsages: lines.length,
        changed: changed.length,
        blocked: blocked.length,
        restricted,
        clearedRevisionPins,
      },
      notes,
    };
    res.json(payload);
  })
);

export default router;
