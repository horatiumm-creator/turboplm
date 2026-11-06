/**
 * Editing many BOM lines in one request.
 *
 * WHY THIS EXISTS. Reworking a BOM is not a sequence of independent edits — it is one change
 * of mind about the structure. Done a line at a time it is N requests, N transactions, N
 * audit rows, and a window after each one where the BOM is in a state nobody designed: swap
 * two find numbers and the first request collides with the second's current value, so the
 * only way through is to move one to a temporary number first. A planner reworking fifty
 * lines meets that repeatedly.
 *
 * ---------------------------------------------------------------------------------
 * THE THING THAT MAKES A BATCH DIFFERENT FROM A LOOP
 * ---------------------------------------------------------------------------------
 * **EVERY RULE IS CHECKED AGAINST THE PROJECTED FINAL STATE, NOT THE CURRENT ONE.** This is
 * the whole correctness argument for the endpoint and the easiest thing to get wrong.
 *
 * Validating each operation against what is in the database today gives both wrong answers,
 * in both directions:
 *
 *  - FALSE PASS: two `add`s naming find number 30 each check against a table that does not
 *    yet contain the other, both pass, and the batch writes a duplicate the one-at-a-time
 *    path would have refused.
 *  - FALSE FAIL: `remove` the line at find number 20 and `add` a different part at 20 — the
 *    add is checked against a row the same batch is about to delete, and a legal rework is
 *    refused. The temporary-number dance exists only because of this.
 *
 * So the operations are first folded into the BOM they would produce, and the rules are
 * applied to THAT: find numbers unique within it, each child part present at most once, no
 * cycle created by the adds considered together.
 *
 * ---------------------------------------------------------------------------------
 * ALL OR NOTHING
 * ---------------------------------------------------------------------------------
 * One bad operation fails the whole request and nothing is written. A partially applied
 * rework is a structure nobody designed, and the caller cannot tell which half landed without
 * re-reading the BOM and diffing it against what they meant. The refusal names the operation
 * by its index so a client can point at the row that caused it.
 */
import { Request, Router } from 'express';
import { Lifecycle, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite } from '../lib/acl';

const router = Router();
router.use(requireAuth);

const MAX_OPERATIONS = 500;

// ---------------------------------------------------------------------------
// Request + response shapes
// ---------------------------------------------------------------------------

interface AddOp {
  op: 'add';
  childPartId: number;
  /** Omitted means "next free in the PROJECTED bom", not next free today. */
  findNumber: number | null;
  quantity: number;
  uom: string | null;
  refDesignators: string | null;
  notes: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

interface UpdateOp {
  op: 'update';
  bomLineId: number;
  /** Only the fields the caller named; everything else is left as it is. */
  patch: {
    findNumber?: number;
    quantity?: number;
    uom?: string;
    refDesignators?: string | null;
    notes?: string | null;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
  };
}

interface RemoveOp {
  op: 'remove';
  bomLineId: number;
}

type Operation = AddOp | UpdateOp | RemoveOp;

interface BulkResultDto {
  revision: { id: number; revision: string; lifecycle: Lifecycle };
  applied: { added: number; updated: number; removed: number };
  /** The BOM as it now stands, so a client does not have to re-read to redraw. */
  lines: {
    id: number;
    findNumber: number;
    childPartId: number;
    quantity: number;
    uom: string;
    refDesignators: string | null;
    notes: string | null;
  }[];
  notes: string[];
}

/** A line in the projected BOM. `id` is null for one this batch is adding. */
interface ProjectedLine {
  id: number | null;
  /** Index of the operation that produced it, for naming the culprit in a refusal. */
  sourceIndex: number | null;
  findNumber: number | null;
  childPartId: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/** Refusals name the operation's index: a client with fifty rows needs to know which one. */
function at(index: number, message: string): HttpError {
  return new HttpError(400, `operations[${index}]: ${message}`);
}

function positiveInt(value: unknown, index: number, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw at(index, `${field} must be a positive whole number`);
  return n;
}

function positiveNumber(value: unknown, index: number, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw at(index, `${field} must be a positive number`);
  return n;
}

function nullableText(value: unknown, index: number, field: string, max = 1000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw at(index, `${field} must be a string or null`);
  return value.trim().slice(0, max) || null;
}

function nullableDate(value: unknown, index: number, field: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw at(index, `${field} must be an ISO date string or null`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw at(index, `${field} is not a valid date`);
  return date;
}

function parseOperations(raw: unknown): Operation[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'operations must be an array');
  if (raw.length === 0) throw new HttpError(400, 'operations is empty — nothing to do');
  if (raw.length > MAX_OPERATIONS) {
    // A cap, stated rather than silently applied: a request bigger than this is a BOM import,
    // which has its own endpoint with its own reporting.
    throw new HttpError(
      400,
      `operations has ${raw.length} entries, more than the ${MAX_OPERATIONS} this endpoint ` +
        'accepts. Split it, or use the spreadsheet import for a whole-BOM load.'
    );
  }

  return raw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const op = item.op;
    if (op === 'add') {
      const effectiveFrom = nullableDate(item.effectiveFrom, index, 'effectiveFrom');
      const effectiveTo = nullableDate(item.effectiveTo, index, 'effectiveTo');
      if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
        throw at(index, 'effectiveTo is before effectiveFrom');
      }
      return {
        op: 'add',
        childPartId: positiveInt(item.childPartId, index, 'childPartId'),
        findNumber:
          item.findNumber === undefined || item.findNumber === null
            ? null
            : positiveInt(item.findNumber, index, 'findNumber'),
        quantity: positiveNumber(item.quantity, index, 'quantity'),
        uom: item.uom === undefined || item.uom === null ? null : nullableText(item.uom, index, 'uom', 16),
        refDesignators: nullableText(item.refDesignators, index, 'refDesignators'),
        notes: nullableText(item.notes, index, 'notes'),
        effectiveFrom,
        effectiveTo,
      } satisfies AddOp;
    }
    if (op === 'update') {
      const patch: UpdateOp['patch'] = {};
      if (item.findNumber !== undefined) {
        patch.findNumber = positiveInt(item.findNumber, index, 'findNumber');
      }
      if (item.quantity !== undefined) {
        patch.quantity = positiveNumber(item.quantity, index, 'quantity');
      }
      if (item.uom !== undefined) {
        const uom = nullableText(item.uom, index, 'uom', 16);
        if (!uom) throw at(index, 'uom cannot be blank');
        patch.uom = uom;
      }
      if (item.refDesignators !== undefined) {
        patch.refDesignators = nullableText(item.refDesignators, index, 'refDesignators');
      }
      if (item.notes !== undefined) patch.notes = nullableText(item.notes, index, 'notes');
      if (item.effectiveFrom !== undefined) {
        patch.effectiveFrom = nullableDate(item.effectiveFrom, index, 'effectiveFrom');
      }
      if (item.effectiveTo !== undefined) {
        patch.effectiveTo = nullableDate(item.effectiveTo, index, 'effectiveTo');
      }
      /*
       * `childPartId` is deliberately NOT updatable here, and this is checked BEFORE the
       * empty-patch refusal below — otherwise an update naming only `childPartId` is told it
       * "names no fields to change", which is both wrong and unhelpful: it named a field, and
       * the useful answer is which tool to use instead.
       *
       * Swapping the part on a line is a different act from adjusting its quantity or
       * position, and it has its own endpoint (`POST /parts/:id/replace`) with its own cycle
       * and duplicate rules.
       */
      if (item.childPartId !== undefined) {
        throw at(
          index,
          'childPartId cannot be changed here — remove the line and add the new part, or use ' +
            'the replace-across-BOMs action'
        );
      }
      if (Object.keys(patch).length === 0) throw at(index, 'update names no fields to change');
      return { op: 'update', bomLineId: positiveInt(item.bomLineId, index, 'bomLineId'), patch };
    }
    if (op === 'remove') {
      return { op: 'remove', bomLineId: positiveInt(item.bomLineId, index, 'bomLineId') };
    }
    throw at(index, `unknown op ${JSON.stringify(op)} (expected add, update or remove)`);
  });
}

// ---------------------------------------------------------------------------
// POST /revisions/:id/bom/bulk
// ---------------------------------------------------------------------------

router.post(
  '/revisions/:id/bom/bulk',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);

    // Rule X3 ordering, copied from the single-line path: 404 (unreadable), 403 (read-only),
    // then 409 (lifecycle). Each answer is only seen by a caller entitled to the one before.
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: aclFilter('PART', user) as Prisma.PartWhereInput },
      select: { id: true, revision: true, lifecycle: true, partId: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    await assertCanWrite('PART', revision.partId, user);
    if (revision.lifecycle !== Lifecycle.IN_WORK) {
      throw new HttpError(
        409,
        `Revision ${revision.revision} is ${revision.lifecycle} and cannot be modified`
      );
    }

    const operations = parseOperations((req.body ?? {}).operations);

    const current = await prisma.bomLine.findMany({
      where: { parentRevisionId: revisionId },
      select: {
        id: true,
        findNumber: true,
        childPartId: true,
        quantity: true,
        uom: true,
        refDesignators: true,
        notes: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    const byId = new Map(current.map((line) => [line.id, line]));

    // --- Fold the operations into the BOM they would produce ------------------
    const projected = new Map<number | string, ProjectedLine>();
    for (const line of current) {
      projected.set(line.id, { ...line, sourceIndex: null });
    }
    const removedIds = new Set<number>();
    const updatedIds = new Set<number>();
    let addCount = 0;

    operations.forEach((operation, index) => {
      if (operation.op === 'remove') {
        if (!byId.has(operation.bomLineId)) {
          // Scoped to THIS revision, so a line id belonging to another assembly answers the
          // same way as one that does not exist.
          throw at(index, `bomLineId ${operation.bomLineId} is not a line of this revision`);
        }
        if (removedIds.has(operation.bomLineId)) {
          throw at(index, `bomLineId ${operation.bomLineId} is removed twice`);
        }
        removedIds.add(operation.bomLineId);
        projected.delete(operation.bomLineId);
        return;
      }
      if (operation.op === 'update') {
        const existing = byId.get(operation.bomLineId);
        if (!existing) {
          throw at(index, `bomLineId ${operation.bomLineId} is not a line of this revision`);
        }
        if (removedIds.has(operation.bomLineId)) {
          throw at(index, `bomLineId ${operation.bomLineId} is updated after being removed`);
        }
        if (updatedIds.has(operation.bomLineId)) {
          throw at(index, `bomLineId ${operation.bomLineId} is updated twice`);
        }
        updatedIds.add(operation.bomLineId);
        const base = projected.get(operation.bomLineId);
        if (!base) throw at(index, `bomLineId ${operation.bomLineId} is no longer in this BOM`);
        const next: ProjectedLine = { ...base, ...operation.patch, sourceIndex: index };
        if (next.effectiveFrom && next.effectiveTo && next.effectiveTo < next.effectiveFrom) {
          throw at(index, 'effectiveTo is before effectiveFrom');
        }
        projected.set(operation.bomLineId, next);
        return;
      }
      addCount += 1;
      projected.set(`add-${index}`, {
        id: null,
        sourceIndex: index,
        findNumber: operation.findNumber,
        childPartId: operation.childPartId,
        quantity: operation.quantity,
        uom: operation.uom ?? 'ea',
        refDesignators: operation.refDesignators,
        notes: operation.notes,
        effectiveFrom: operation.effectiveFrom,
        effectiveTo: operation.effectiveTo,
      });
    });

    const projectedLines = [...projected.values()];

    // --- Rule 8, against the projection --------------------------------------
    // Auto find numbers are assigned from the projected maximum, so a batch that frees 30 by
    // removing it and adds two lines gets 40 and 50 rather than colliding on 30.
    let nextAuto =
      Math.floor(
        Math.max(0, ...projectedLines.map((line) => line.findNumber ?? 0)) / 10
      ) * 10;
    for (const line of projectedLines) {
      if (line.findNumber === null) {
        nextAuto += 10;
        line.findNumber = nextAuto;
      }
    }

    const seenFindNumbers = new Map<number, ProjectedLine>();
    for (const line of projectedLines) {
      const clash = seenFindNumbers.get(line.findNumber as number);
      if (clash) {
        const culprit = line.sourceIndex ?? clash.sourceIndex ?? 0;
        throw at(
          culprit,
          `find number ${line.findNumber} would be used twice on this BOM once the whole ` +
            'batch is applied'
        );
      }
      seenFindNumbers.set(line.findNumber as number, line);
    }

    const seenChildren = new Map<number, ProjectedLine>();
    for (const line of projectedLines) {
      const clash = seenChildren.get(line.childPartId);
      if (clash) {
        const culprit = line.sourceIndex ?? clash.sourceIndex ?? 0;
        throw at(
          culprit,
          `part ${line.childPartId} would appear twice on this BOM once the whole batch is ` +
            'applied — a part may be on a revision only once'
        );
      }
      seenChildren.set(line.childPartId, line);
    }

    // --- The added parts must be readable ------------------------------------
    const addedChildIds = [
      ...new Set(
        operations.filter((o): o is AddOp => o.op === 'add').map((o) => o.childPartId)
      ),
    ];
    if (addedChildIds.length > 0) {
      const readable = await prisma.part.findMany({
        where: { id: { in: addedChildIds }, ...(aclFilter('PART', user) as Prisma.PartWhereInput) },
        select: { id: true },
      });
      const readableIds = new Set(readable.map((p) => p.id));
      operations.forEach((operation, index) => {
        // A child the caller cannot read answers exactly like one that does not exist: being
        // unable to PLACE a hidden part is the cheap half of the rule, and confirming its
        // existence by accepting it is the expensive half.
        if (operation.op === 'add' && !readableIds.has(operation.childPartId)) {
          throw at(index, `childPartId ${operation.childPartId} does not exist`);
        }
      });
    }

    // --- Rule 4, for every added part at once --------------------------------
    /*
     * The adds are considered TOGETHER. Checking each one against the stored edges would miss
     * a batch that adds A under this part and this part under A — each edge is innocent on
     * its own and the pair is a loop. So the projected edges are added to the graph before
     * the search runs.
     */
    if (addedChildIds.length > 0) {
      const edges = await prisma.bomLine.findMany({
        select: { childPartId: true, parentRevision: { select: { partId: true } } },
      });
      const adjacency = new Map<number, number[]>();
      const link = (from: number, to: number) => {
        const targets = adjacency.get(from);
        if (targets) targets.push(to);
        else adjacency.set(from, [to]);
      };
      for (const edge of edges) link(edge.parentRevision.partId, edge.childPartId);
      // Removals are NOT subtracted from the graph. A removal on this revision does not
      // remove the edge from other revisions of the same part, and the stored cycle rule is
      // deliberately conservative across all of them — loosening it here would make the batch
      // path accept a structure the single-line path refuses.
      for (const childId of addedChildIds) link(revision.partId, childId);

      for (const childId of addedChildIds) {
        if (childId === revision.partId) {
          const index = operations.findIndex(
            (o) => o.op === 'add' && o.childPartId === childId
          );
          throw at(index, 'a part cannot contain itself');
        }
        const visited = new Set<number>([childId]);
        const queue = [childId];
        let loops = false;
        for (const currentId of queue) {
          if (currentId === revision.partId) {
            loops = true;
            break;
          }
          for (const next of adjacency.get(currentId) ?? []) {
            if (!visited.has(next)) {
              visited.add(next);
              queue.push(next);
            }
          }
        }
        if (loops) {
          const index = operations.findIndex(
            (o) => o.op === 'add' && o.childPartId === childId
          );
          throw at(index, 'adding this part would create a BOM cycle');
        }
      }
    }

    // --- Write, all or nothing ------------------------------------------------
    await prisma.$transaction(async (tx) => {
      /*
       * Removals first, then updates, then inserts.
       *
       * The order matters because the database still enforces uniqueness row by row even
       * though the batch was validated as a whole: freeing a find number before anything
       * claims it is what lets two lines swap positions in one request, which is the case
       * that made the one-at-a-time path need a temporary number.
       */
      if (removedIds.size > 0) {
        await tx.bomLine.deleteMany({ where: { id: { in: [...removedIds] }, parentRevisionId: revisionId } });
      }

      /*
       * MOVE EVERY CHANGING FIND NUMBER OUT OF THE WAY FIRST.
       *
       * `@@unique([parentRevisionId, findNumber])` is enforced per statement, not per
       * transaction, so writing the batch's final numbers directly fails on any PERMUTATION:
       * setting line A to 20 collides with line B, which still holds 20 until its own update
       * runs. Validating against the projected BOM proves the end state is legal; it does
       * nothing about the order the rows get there in.
       *
       * So changing lines are parked above the highest number in play — a range nothing in
       * this revision can be using — and then written to their real values. Without this the
       * swap case still needs the caller to invent a temporary number, which is the whole
       * thing this endpoint was supposed to remove.
       */
      const changingFindNumbers = projectedLines.filter(
        (line) =>
          line.id !== null &&
          updatedIds.has(line.id) &&
          byId.get(line.id)?.findNumber !== line.findNumber
      );
      if (changingFindNumbers.length > 0) {
        const parkBase =
          Math.max(
            0,
            ...current.map((l) => l.findNumber),
            ...projectedLines.map((l) => l.findNumber ?? 0)
          ) + 1;
        let park = parkBase;
        for (const line of changingFindNumbers) {
          await tx.bomLine.update({
            where: { id: line.id as number },
            data: { findNumber: park },
          });
          park += 1;
        }
      }

      for (const line of projectedLines) {
        if (line.id === null || !updatedIds.has(line.id)) continue;
        await tx.bomLine.update({
          where: { id: line.id },
          data: {
            findNumber: line.findNumber as number,
            quantity: line.quantity,
            uom: line.uom,
            refDesignators: line.refDesignators,
            notes: line.notes,
            effectiveFrom: line.effectiveFrom,
            effectiveTo: line.effectiveTo,
          },
        });
      }
      const toInsert = projectedLines.filter((line) => line.id === null);
      if (toInsert.length > 0) {
        await tx.bomLine.createMany({
          data: toInsert.map((line) => ({
            parentRevisionId: revisionId,
            childPartId: line.childPartId,
            findNumber: line.findNumber as number,
            quantity: line.quantity,
            uom: line.uom,
            refDesignators: line.refDesignators,
            notes: line.notes,
            effectiveFrom: line.effectiveFrom,
            effectiveTo: line.effectiveTo,
          })),
        });
      }
    });

    const after = await prisma.bomLine.findMany({
      where: { parentRevisionId: revisionId },
      orderBy: { findNumber: 'asc' },
      select: {
        id: true,
        findNumber: true,
        childPartId: true,
        quantity: true,
        uom: true,
        refDesignators: true,
        notes: true,
      },
    });

    const notes: string[] = [];
    const autoAssigned = operations.filter((o) => o.op === 'add' && o.findNumber === null).length;
    if (autoAssigned > 0) {
      notes.push(
        `${autoAssigned} line${autoAssigned === 1 ? '' : 's'} had no find number and ` +
          `${autoAssigned === 1 ? 'was' : 'were'} given the next free one after the whole ` +
          'batch was applied, not the next free one before it.'
      );
    }

    const payload: BulkResultDto = {
      revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
      applied: { added: addCount, updated: updatedIds.size, removed: removedIds.size },
      lines: after,
      notes,
    };
    res.json(payload);
  })
);

export default router;
