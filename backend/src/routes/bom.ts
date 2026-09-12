import { Request, Router } from 'express';
import { Lifecycle, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, asyncHandler, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { generatePartNumber, resolveDisplayRevision } from '../lib/plm';
import type { CadAssemblyNode } from '../lib/cad';
import {
  countDescendants,
  isAssemblyReadable,
  readAssembly,
  scrubHiddenMatches,
} from '../lib/cad';
import {
  AclUser,
  aclFilter,
  assertCanRead,
  assertCanWrite,
  REDACTED,
  visibleIds,
} from '../lib/acl';
import type { Ap242Node, Ap242Usage } from '../lib/ap242';
import { writeAp242 } from '../lib/ap242';

const router = Router();
router.use(requireAuth);

const MAX_TREE_DEPTH = 15;

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface PartRef {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

/**
 * Rule X4 — a BOM position whose child the caller may not read keeps its row (find number,
 * quantity, uom — the structure must still add up) and loses the child's identity. The line's
 * own prose (notes, refDesignators) survives: it belongs to the parent revision the caller has
 * already been allowed to read, not to the hidden child.
 */
type MaybePartRef = PartRef | typeof REDACTED;

interface RevisionRef {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

interface BomLineAlternateDetail {
  id: number;
  part: MaybePartRef;
  note: string | null;
}

interface BomLineDetail {
  id: number;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  alternates: BomLineAlternateDetail[];
  childPart: MaybePartRef;
  resolvedRevision: RevisionRef | null;
}

interface BomTreeNode {
  line: {
    id: number;
    findNumber: number;
    quantity: number;
    uom: string;
    refDesignators: string | null;
    notes: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    alternates: BomLineAlternateDetail[];
  };
  part: MaybePartRef;
  revision: RevisionRef | null;
  unreleased: boolean;
  cycle: boolean;
  children: BomTreeNode[];
}

interface WhereUsedEntry {
  line: { id: number; findNumber: number; quantity: number; uom: string };
  parentRevision: RevisionRef;
  parentPart: { id: number; partNumber: string; name: string };
}

// ---------------------------------------------------------------------------
// Item-level access (rules X2-X4)
// ---------------------------------------------------------------------------

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

function documentAcl(user: AclUser): Prisma.DocumentWhereInput {
  return aclFilter('DOCUMENT', user) as Prisma.DocumentWhereInput;
}

/**
 * A revision inherits its part's grants, so every revision route resolves the revision
 * *through* the part's read filter. Loading the revision first and then checking the part
 * would answer 'Part not found' for a restricted part but 'Revision not found' for a missing
 * revision id — an existence oracle. Resolved this way, both fail identically.
 */
async function readableRevisionOrThrow(revisionId: number, user: AclUser) {
  const revision = await prisma.partRevision.findFirst({
    where: { id: revisionId, part: partAcl(user) },
    select: {
      id: true,
      partId: true,
      revision: true,
      lifecycle: true,
      part: { select: { partNumber: true } },
    },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');
  return revision;
}

// ---------------------------------------------------------------------------
// Query shapes + mappers
// ---------------------------------------------------------------------------

const lineInclude = {
  childPart: {
    include: {
      revisions: { select: { id: true, revision: true, lifecycle: true } },
    },
  },
  alternates: {
    include: { alternatePart: true },
    orderBy: { id: 'asc' },
  },
} as const;

type LineWithChild = Prisma.BomLineGetPayload<{ include: typeof lineInclude }>;

function toPartRef(part: {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}): PartRef {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toRevisionRef(rev: { id: number; revision: string; lifecycle: Lifecycle }): RevisionRef {
  return { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle };
}

function toAlternateDetail(
  alt: {
    id: number;
    note: string | null;
    alternatePart: {
      id: number;
      partNumber: string;
      name: string;
      category: PartCategory;
      uom: string;
    };
  },
  visible: ReadonlySet<number>
): BomLineAlternateDetail {
  return {
    id: alt.id,
    part: visible.has(alt.alternatePart.id) ? toPartRef(alt.alternatePart) : REDACTED,
    note: alt.note,
  };
}

function toBomLineDetail(line: LineWithChild, visible: ReadonlySet<number>): BomLineDetail {
  const hidden = !visible.has(line.childPartId);
  // A hidden child's revision state is part of what is hidden.
  const resolved = hidden ? null : resolveDisplayRevision(line.childPart.revisions);
  return {
    id: line.id,
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    notes: line.notes,
    effectiveFrom: line.effectiveFrom ? line.effectiveFrom.toISOString() : null,
    effectiveTo: line.effectiveTo ? line.effectiveTo.toISOString() : null,
    alternates: line.alternates.map((alt) => toAlternateDetail(alt, visible)),
    childPart: hidden ? REDACTED : toPartRef(line.childPart),
    resolvedRevision: resolved ? toRevisionRef(resolved) : null,
  };
}

/**
 * One visibility query for a page of lines: every child part plus every alternate part, so the
 * mappers above never ask the database themselves (rule X4 — collect, ask once, redact).
 */
async function lineVisibility(lines: LineWithChild[], user: AclUser): Promise<Set<number>> {
  return visibleIds(
    'PART',
    lines.flatMap((line) => [
      line.childPartId,
      ...line.alternates.map((alt) => alt.alternatePartId),
    ]),
    user
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${label} must be a number greater than 0`);
  }
  return value;
}

/** Optional non-empty string; returns undefined when blank/omitted. */
function optionalUom(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'uom must be a string');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Optional nullable text field; blank strings collapse to null. */
function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Rule T4 — effectivity bound: ISO date string or null (null = open bound). */
function parseEffectivityBound(value: unknown, label: string): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be an ISO date string or null`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

/** Rule T4 — effectiveFrom must precede effectiveTo when both are set. */
function assertEffectivityWindow(from: Date | null, to: Date | null): void {
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw new HttpError(400, 'effectiveFrom must be before effectiveTo');
  }
}

/** Rule T4 — optional ?asOf= query value; blank/omitted means no filter. */
function parseAsOfQuery(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'asOf must be an ISO date string');
  if (value.trim() === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'asOf is not a valid date');
  return date;
}

/** Rule T4 — lines effective at asOf: (from null or <= asOf) AND (to null or > asOf). */
function effectivityFilter(asOf: Date | undefined): Prisma.BomLineWhereInput {
  if (!asOf) return {};
  return {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Business-rule helpers
// ---------------------------------------------------------------------------

/** Rule 1 — edit gate: BOM mutations only while the owning revision is IN_WORK. */
function assertEditable(rev: { revision: string; lifecycle: Lifecycle }): void {
  if (rev.lifecycle !== Lifecycle.IN_WORK) {
    throw new HttpError(409, `Revision ${rev.revision} is ${rev.lifecycle} and cannot be modified`);
  }
}

/**
 * Rule 4 — cycle prevention. Conservative BFS over ALL BomLine edges
 * (parentRevision.partId -> childPartId): reject if the parent part is
 * reachable from the new child (or the child IS the parent part).
 */
async function assertNoCycle(
  parentPartId: number,
  childPartId: number,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  const cycleError = () => new HttpError(409, 'Adding this part would create a BOM cycle');
  if (childPartId === parentPartId) throw cycleError();

  const edges = await db.bomLine.findMany({
    select: { childPartId: true, parentRevision: { select: { partId: true } } },
  });
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const from = edge.parentRevision.partId;
    const targets = adjacency.get(from);
    if (targets) targets.push(edge.childPartId);
    else adjacency.set(from, [edge.childPartId]);
  }

  const visited = new Set<number>([childPartId]);
  const queue: number[] = [childPartId];
  for (const current of queue) {
    if (current === parentPartId) throw cycleError();
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
}

/** Rule 8 — auto-assign the next multiple of 10 (start 10). */
async function nextFindNumber(
  parentRevisionId: number,
  db: Prisma.TransactionClient = prisma
): Promise<number> {
  const agg = await db.bomLine.aggregate({
    where: { parentRevisionId },
    _max: { findNumber: true },
  });
  const max = agg._max.findNumber ?? 0;
  return Math.floor(max / 10) * 10 + 10;
}

async function assertFindNumberFree(
  parentRevisionId: number,
  findNumber: number,
  excludeLineId?: number,
  db: Prisma.TransactionClient = prisma
): Promise<void> {
  const clash = await db.bomLine.findFirst({
    where: {
      parentRevisionId,
      findNumber,
      ...(excludeLineId !== undefined ? { id: { not: excludeLineId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, 'Find number already used');
}

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom — flat BOM, findNumber asc
// ---------------------------------------------------------------------------

router.get(
  '/revisions/:id/bom',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    await readableRevisionOrThrow(revisionId, user);
    const asOf = parseAsOfQuery(req.query.asOf);

    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: revisionId, ...effectivityFilter(asOf) },
      orderBy: { findNumber: 'asc' },
      include: lineInclude,
    });
    const visible = await lineVisibility(lines, user);
    res.json(lines.map((line) => toBomLineDetail(line, visible)));
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom/tree — recursive expansion via resolved revisions
// ---------------------------------------------------------------------------

async function buildTreeLevel(
  parentRevisionId: number,
  ancestorPartIds: ReadonlySet<number>,
  depth: number,
  asOf: Date | undefined,
  user: AclUser
): Promise<BomTreeNode[]> {
  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId, ...effectivityFilter(asOf) },
    orderBy: { findNumber: 'asc' },
    include: lineInclude,
  });
  const visible = await lineVisibility(lines, user);

  const nodes: BomTreeNode[] = [];
  for (const line of lines) {
    const hidden = !visible.has(line.childPartId);
    // Rule X4 — the node stays (find number and quantity intact, so the parent's structure
    // still adds up) but the walk does not descend: expanding a hidden child would disclose
    // its BOM, and even an all-redacted subtree leaks its shape. `unreleased` is forced to
    // false because the flag drives a warning banner, and for a child whose state the caller
    // may not know, no signal is the only honest signal.
    const resolved = hidden ? null : resolveDisplayRevision(line.childPart.revisions);
    const cycle = !hidden && ancestorPartIds.has(line.childPartId);
    let children: BomTreeNode[] = [];
    if (!hidden && !cycle && resolved && depth < MAX_TREE_DEPTH) {
      const branch = new Set(ancestorPartIds);
      branch.add(line.childPartId);
      children = await buildTreeLevel(resolved.id, branch, depth + 1, asOf, user);
    }
    nodes.push({
      line: {
        id: line.id,
        findNumber: line.findNumber,
        quantity: line.quantity,
        uom: line.uom,
        refDesignators: line.refDesignators,
        notes: line.notes,
        effectiveFrom: line.effectiveFrom ? line.effectiveFrom.toISOString() : null,
        effectiveTo: line.effectiveTo ? line.effectiveTo.toISOString() : null,
        alternates: line.alternates.map((alt) => toAlternateDetail(alt, visible)),
      },
      part: hidden ? REDACTED : toPartRef(line.childPart),
      revision: resolved ? toRevisionRef(resolved) : null,
      unreleased: hidden ? false : !resolved || resolved.lifecycle !== Lifecycle.RELEASED,
      cycle,
      children,
    });
  }
  return nodes;
}

router.get(
  '/revisions/:id/bom/tree',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await readableRevisionOrThrow(revisionId, user);
    const asOf = parseAsOfQuery(req.query.asOf);

    const tree = await buildTreeLevel(revision.id, new Set([revision.partId]), 1, asOf, user);
    res.json(tree);
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/bom/export.csv — flattened multi-level BOM as CSV
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'Level,Find,Part Number,Part Name,Category,Revision,Lifecycle,Quantity,UoM,RefDes,Notes,Effective From,Effective To';

/**
 * RFC 4180 quoting plus formula neutralization: cells starting with = + - @ or tab
 * are prefixed with a single quote so spreadsheet apps treat them as text
 * (CSV-injection mitigation; numeric columns never start with those characters).
 */
function csvField(value: string): string {
  const neutralized = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

/**
 * Depth-first flatten of the BOM tree into CSV rows with a 1-based Level column.
 *
 * A redacted node exports as `Restricted` with an empty category — the tree has already
 * withheld the child's revision and subtree, so the row here inherits that shape. The export
 * must not be a way around the tree's redaction.
 */
function appendCsvRows(rows: string[], nodes: BomTreeNode[], level: number): void {
  for (const node of nodes) {
    const fields = [
      String(level),
      String(node.line.findNumber),
      node.part.partNumber,
      node.part.name,
      'category' in node.part ? node.part.category : '',
      node.revision ? node.revision.revision : '',
      node.revision ? node.revision.lifecycle : '',
      String(node.line.quantity),
      node.line.uom,
      node.line.refDesignators ?? '',
      node.line.notes ?? '',
      node.line.effectiveFrom ? node.line.effectiveFrom.slice(0, 10) : '',
      node.line.effectiveTo ? node.line.effectiveTo.slice(0, 10) : '',
    ];
    rows.push(fields.map(csvField).join(','));
    appendCsvRows(rows, node.children, level + 1);
  }
}

router.get(
  '/revisions/:id/bom/export.csv',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await readableRevisionOrThrow(revisionId, user);

    const tree = await buildTreeLevel(revision.id, new Set([revision.partId]), 1, undefined, user);
    const rows: string[] = [CSV_HEADER];
    appendCsvRows(rows, tree, 1);

    const safePartNumber = revision.part.partNumber.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safePartNumber}_rev${revision.revision}_bom.csv"`
    );
    res.send(rows.join('\r\n') + '\r\n');
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/export/step — AP242 product structure as a Part 21 file
//
// The file format, the entity graph, the quantity decision and the determinism rules all
// live in lib/ap242.ts, which is pure. What lives here is what must live here: reading
// the structure out of the database, resolving each child's revision by the SAME rule the
// BOM read uses, and applying item-level access control. An export endpoint that dumps
// restricted items is the same leak as a list endpoint that does.
// ---------------------------------------------------------------------------

/**
 * Everything the exporter needs about a child, and nothing else.
 *
 * Deliberately narrower than `lineInclude`: alternates are not exported at all. AP242
 * carries substitutes through a different subset (`alternate_product_relationship`), and
 * emitting an alternate as if it were a component would overstate the assembly.
 */
const stepLineInclude = {
  childPart: {
    select: {
      id: true,
      partNumber: true,
      name: true,
      description: true,
      category: true,
      updatedAt: true,
      revisions: {
        select: { id: true, revision: true, lifecycle: true, changeNote: true, createdAt: true },
      },
    },
  },
} as const;

interface StepWalk {
  /** Keyed by partId. Insertion order IS walk order, which fixes the emission order. */
  nodes: Map<number, Ap242Node>;
  usages: Ap242Usage[];
  /**
   * Revisions whose lines have already been read.
   *
   * Two jobs. It makes a shared subassembly appear once in the entity graph rather than
   * once per parent — the export is a graph, not an expanded tree. And it is what
   * terminates the walk: the codebase prevents BOM cycles on write, but an exporter that
   * would hang on one is an exporter that hangs on a corrupted database, so the walk is
   * bounded by the number of distinct revisions reachable no matter what the data says.
   */
  expanded: Set<number>;
  notes: string[];
  /** Most recent change among everything exported — the file's data-derived time stamp. */
  changedAt: number;
}

function noteChange(walk: StepWalk, ...times: Date[]): void {
  for (const time of times) walk.changedAt = Math.max(walk.changedAt, time.getTime());
}

function addVisibleStepNode(
  walk: StepWalk,
  part: {
    id: number;
    partNumber: string;
    name: string;
    description: string | null;
    category: PartCategory;
  },
  revision: { revision: string; lifecycle: Lifecycle; changeNote: string | null }
): void {
  if (walk.nodes.has(part.id)) return;
  walk.nodes.set(part.id, {
    key: part.id,
    walkOrder: walk.nodes.size,
    restricted: false,
    partNumber: part.partNumber,
    name: part.name,
    description: part.description,
    category: part.category,
    revision: revision.revision,
    changeNote: revision.changeNote,
    lifecycle: revision.lifecycle,
  });
}

/**
 * Rule X4 — a position whose child the caller may not read keeps its row so the parent's
 * structure still adds up, and loses the child's identity entirely. Note what is NOT
 * passed: nothing about the part reaches the writer, so the redaction cannot be undone by
 * a later change to the writer.
 */
function addRestrictedStepNode(walk: StepWalk, partId: number): void {
  if (walk.nodes.has(partId)) return;
  walk.nodes.set(partId, { key: partId, walkOrder: walk.nodes.size, restricted: true });
}

function addStepUsage(walk: StepWalk, parentPartId: number, line: LineForStep): void {
  walk.usages.push({
    parentKey: parentPartId,
    childKey: line.childPartId,
    findNumber: line.findNumber,
    quantity: line.quantity,
    uom: line.uom,
    refDesignators: line.refDesignators,
    notes: line.notes,
  });
}

type LineForStep = Prisma.BomLineGetPayload<{ include: typeof stepLineInclude }>;

/**
 * Read one assembly level and recurse.
 *
 * Find-number order, which the unique index on (parentRevisionId, findNumber) makes
 * total, so the traversal — and therefore every entity id in the output — is
 * reproducible.
 *
 * Recursion rather than an explicit stack, mirroring `buildTreeLevel`. There is no depth
 * cap: unlike the tree view, which caps at MAX_TREE_DEPTH to bound a response that grows
 * exponentially with depth, this walk visits each revision once, so its cost is linear in
 * the structure and truncating it would silently ship an incomplete assembly.
 */
async function expandStepLevel(
  parentPartId: number,
  parentPartNumber: string,
  parentRevisionId: number,
  ancestorPartIds: ReadonlySet<number>,
  walk: StepWalk,
  user: AclUser
): Promise<void> {
  if (walk.expanded.has(parentRevisionId)) return;
  walk.expanded.add(parentRevisionId);

  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId },
    orderBy: { findNumber: 'asc' },
    include: stepLineInclude,
  });
  const visible = await visibleIds(
    'PART',
    lines.map((line) => line.childPartId),
    user
  );

  for (const line of lines) {
    const child = line.childPart;
    if (!visible.has(child.id)) {
      addRestrictedStepNode(walk, child.id);
      addStepUsage(walk, parentPartId, line);
      continue;
    }

    // The resolved-revision rule is not re-derived here: `resolveDisplayRevision` is the
    // same helper the flat BOM read and the tree walk use — latest RELEASED, and failing
    // that the latest revision of any state. An exporter that quietly picked a different
    // revision than the screen shows would be the worst kind of wrong.
    const resolved = resolveDisplayRevision(child.revisions);
    if (!resolved) {
      // A part with no revision at all has nothing to hang a PRODUCT_DEFINITION on, and
      // inventing one would put a revision in the file that does not exist. Dropping the
      // position is the lesser evil, but it is not allowed to be silent.
      walk.notes.push(
        `Omitted find number ${line.findNumber} of ${parentPartNumber}: ` +
          `${child.partNumber} has no revision, so no product definition could be written.`
      );
      continue;
    }

    addVisibleStepNode(walk, child, resolved);
    noteChange(walk, child.updatedAt, resolved.createdAt);
    addStepUsage(walk, parentPartId, line);

    if (ancestorPartIds.has(child.id)) {
      walk.notes.push(
        `${child.partNumber} appears within its own assembly. The position is exported; ` +
          'the branch is not expanded again.'
      );
      continue;
    }
    const branch = new Set(ancestorPartIds);
    branch.add(child.id);
    await expandStepLevel(child.id, child.partNumber, resolved.id, branch, walk, user);
  }
}

/** Content-Disposition and the FILE_NAME entity both take this. */
function stepFileName(partNumber: string, revision: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe(partNumber)}_rev${safe(revision)}.stp`;
}

router.get(
  '/revisions/:id/export/step',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    // The access decision belongs to the shared helper, so this route cannot drift from
    // the rest of the revision routes: unreadable and absent both answer 404 here too.
    await readableRevisionOrThrow(revisionId, user);

    // A second read for the fields the exporter needs, carrying the part filter again
    // rather than trusting the line above — the cost is one indexed lookup and it means
    // no future edit can leave this query unfiltered.
    const root = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: partAcl(user) },
      select: {
        id: true,
        revision: true,
        lifecycle: true,
        changeNote: true,
        createdAt: true,
        part: {
          select: {
            id: true,
            partNumber: true,
            name: true,
            description: true,
            category: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!root) throw new HttpError(404, 'Revision not found');

    const walk: StepWalk = {
      nodes: new Map(),
      usages: [],
      expanded: new Set(),
      notes: [],
      changedAt: 0,
    };
    // The root is exported at the revision that was asked for, released or not; only its
    // components go through the resolved-revision rule.
    addVisibleStepNode(walk, root.part, root);
    noteChange(walk, root.part.updatedAt, root.createdAt);
    await expandStepLevel(
      root.part.id,
      root.part.partNumber,
      root.id,
      new Set([root.part.id]),
      walk,
      user
    );

    const fileName = stepFileName(root.part.partNumber, root.revision);
    const file = writeAp242({
      fileName,
      timestamp: new Date(walk.changedAt),
      nodes: [...walk.nodes.values()],
      usages: walk.usages,
      notes: walk.notes,
    });

    // `application/step` is what Teamcenter, Windchill and NX register for a .stp file.
    // Express appends charset=utf-8 to it; harmless, because lib/ap242.ts escapes every
    // non-ASCII character, so the body reads identically under any ASCII-compatible
    // encoding the receiving system happens to assume.
    res.setHeader('Content-Type', 'application/step');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(file);
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/bom — add a BOM line
// ---------------------------------------------------------------------------

router.post(
  '/revisions/:id/bom',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 ordering: 404 (unreadable), then 403 (read-only), then 409 (lifecycle) — each
    // answer is only ever seen by a caller entitled to the one before it.
    const revision = await readableRevisionOrThrow(revisionId, user);
    await assertCanWrite('PART', revision.partId, user);
    assertEditable(revision);

    const body = bodyOf(req);
    const childPartId = requirePositiveInt(body.childPartId, 'childPartId');
    const quantity = requirePositiveNumber(body.quantity, 'quantity');
    const uom = optionalUom(body.uom);
    const refDesignators =
      body.refDesignators === undefined
        ? null
        : optionalNullableText(body.refDesignators, 'refDesignators');
    const notes = body.notes === undefined ? null : optionalNullableText(body.notes, 'notes');
    const effectiveFrom =
      body.effectiveFrom === undefined
        ? null
        : parseEffectivityBound(body.effectiveFrom, 'effectiveFrom');
    const effectiveTo =
      body.effectiveTo === undefined ? null : parseEffectivityBound(body.effectiveTo, 'effectiveTo');
    assertEffectivityWindow(effectiveFrom, effectiveTo);

    // Acl-filtered: a child part the caller cannot read answers exactly like one that does not
    // exist. Being unable to *place* a hidden part is the cheap half of the rule; the expensive
    // half would be confirming its existence by accepting it.
    const childPart = await prisma.part.findFirst({
      where: { id: childPartId, ...partAcl(user) },
      select: { id: true },
    });
    if (!childPart) throw new HttpError(404, 'Child part not found');

    const requestedFindNumber =
      body.findNumber === undefined || body.findNumber === null
        ? undefined
        : requirePositiveInt(body.findNumber, 'findNumber');

    // Serialize structure edits (advisory xact lock) so two concurrent adds can't
    // both pass the cycle BFS and persist a cycle the check would have rejected.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-bom-structure'))::text`;

      await assertNoCycle(revision.partId, childPartId, tx);

      const duplicate = await tx.bomLine.findFirst({
        where: { parentRevisionId: revision.id, childPartId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Part is already on this BOM');

      let findNumber: number;
      if (requestedFindNumber === undefined) {
        findNumber = await nextFindNumber(revision.id, tx);
      } else {
        findNumber = requestedFindNumber;
        await assertFindNumberFree(revision.id, findNumber, undefined, tx);
      }

      return tx.bomLine.create({
        data: {
          parentRevisionId: revision.id,
          childPartId,
          findNumber,
          quantity,
          ...(uom !== undefined ? { uom } : {}),
          refDesignators,
          notes,
          effectiveFrom,
          effectiveTo,
        },
        include: lineInclude,
      });
    });
    // The child was read-checked above and a new line has no alternates.
    res.status(201).json(toBomLineDetail(created, new Set([childPartId])));
  })
);

// ---------------------------------------------------------------------------
// PATCH /bom-lines/:id — update a BOM line
// ---------------------------------------------------------------------------

router.patch(
  '/bom-lines/:id',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const user = aclUser(req);
    // A line is as visible as the part whose BOM it sits on; a line on a restricted parent
    // answers like a line that does not exist.
    const line = await prisma.bomLine.findFirst({
      where: { id: lineId, parentRevision: { part: partAcl(user) } },
      select: {
        id: true,
        parentRevisionId: true,
        effectiveFrom: true,
        effectiveTo: true,
        parentRevision: { select: { partId: true, revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    await assertCanWrite('PART', line.parentRevision.partId, user);
    assertEditable(line.parentRevision);

    const body = bodyOf(req);
    const data: {
      quantity?: number;
      uom?: string;
      findNumber?: number;
      refDesignators?: string | null;
      notes?: string | null;
      effectiveFrom?: Date | null;
      effectiveTo?: Date | null;
    } = {};

    if (body.quantity !== undefined) {
      data.quantity = requirePositiveNumber(body.quantity, 'quantity');
    }
    if (body.uom !== undefined) {
      const uom = optionalUom(body.uom);
      if (uom !== undefined) data.uom = uom;
    }
    if (body.findNumber !== undefined) {
      const findNumber = requirePositiveInt(body.findNumber, 'findNumber');
      await assertFindNumberFree(line.parentRevisionId, findNumber, line.id);
      data.findNumber = findNumber;
    }
    if (body.refDesignators !== undefined) {
      data.refDesignators = optionalNullableText(body.refDesignators, 'refDesignators');
    }
    if (body.notes !== undefined) {
      data.notes = optionalNullableText(body.notes, 'notes');
    }
    if (body.effectiveFrom !== undefined) {
      data.effectiveFrom = parseEffectivityBound(body.effectiveFrom, 'effectiveFrom');
    }
    if (body.effectiveTo !== undefined) {
      data.effectiveTo = parseEffectivityBound(body.effectiveTo, 'effectiveTo');
    }
    // Validate the window that would result from applying this patch.
    assertEffectivityWindow(
      data.effectiveFrom !== undefined ? data.effectiveFrom : line.effectiveFrom,
      data.effectiveTo !== undefined ? data.effectiveTo : line.effectiveTo
    );

    const updated = await prisma.bomLine.update({
      where: { id: line.id },
      data,
      include: lineInclude,
    });
    res.json(toBomLineDetail(updated, await lineVisibility([updated], user)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /bom-lines/:id
// ---------------------------------------------------------------------------

router.delete(
  '/bom-lines/:id',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const user = aclUser(req);
    const line = await prisma.bomLine.findFirst({
      where: { id: lineId, parentRevision: { part: partAcl(user) } },
      select: {
        id: true,
        parentRevision: { select: { partId: true, revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    await assertCanWrite('PART', line.parentRevision.partId, user);
    assertEditable(line.parentRevision);

    await prisma.bomLine.delete({ where: { id: line.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// POST /bom-lines/:id/alternates — rule T5, add an alternate part to a line
// ---------------------------------------------------------------------------

router.post(
  '/bom-lines/:id/alternates',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const user = aclUser(req);
    const line = await prisma.bomLine.findFirst({
      where: { id: lineId, parentRevision: { part: partAcl(user) } },
      select: {
        id: true,
        childPartId: true,
        parentRevision: { select: { partId: true, revision: true, lifecycle: true } },
      },
    });
    if (!line) throw new HttpError(404, 'BOM line not found');
    await assertCanWrite('PART', line.parentRevision.partId, user);
    assertEditable(line.parentRevision);

    const body = bodyOf(req);
    const partId = requirePositiveInt(body.partId, 'partId');
    const note = body.note === undefined ? null : optionalNullableText(body.note, 'note');

    if (partId === line.childPartId) {
      throw new HttpError(409, 'Alternate cannot be the same as the BOM line part');
    }

    // Same rule as adding a BOM line: a hidden alternate answers like a nonexistent one.
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    const duplicate = await prisma.bomLineAlternate.findFirst({
      where: { bomLineId: line.id, alternatePartId: partId },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, 'Part is already an alternate on this BOM line');

    const created = await prisma.bomLineAlternate.create({
      data: { bomLineId: line.id, alternatePartId: partId, note },
      include: { alternatePart: true },
    });
    res.status(201).json(toAlternateDetail(created, new Set([partId])));
  })
);

// ---------------------------------------------------------------------------
// DELETE /bom-line-alternates/:id — rule T5, same edit gate as the line
// ---------------------------------------------------------------------------

router.delete(
  '/bom-line-alternates/:id',
  asyncHandler(async (req, res) => {
    const alternateId = idParam(req.params.id);
    const user = aclUser(req);
    const alternate = await prisma.bomLineAlternate.findFirst({
      where: { id: alternateId, bomLine: { parentRevision: { part: partAcl(user) } } },
      select: {
        id: true,
        bomLine: {
          select: { parentRevision: { select: { partId: true, revision: true, lifecycle: true } } },
        },
      },
    });
    if (!alternate) throw new HttpError(404, 'Alternate not found');
    await assertCanWrite('PART', alternate.bomLine.parentRevision.partId, user);
    assertEditable(alternate.bomLine.parentRevision);

    await prisma.bomLineAlternate.delete({ where: { id: alternate.id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// GET /parts/:id/where-used — every BomLine where the part is the child
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id/where-used',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanRead('PART', partId, user);

    const lines = await prisma.bomLine.findMany({
      where: { childPartId: partId },
      orderBy: { parentRevisionId: 'desc' },
      include: {
        parentRevision: {
          select: {
            id: true,
            revision: true,
            lifecycle: true,
            part: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
    });

    // Rule X4 — a consumer the caller cannot read keeps its row and loses its identity. Where-
    // used exists to answer "is it safe to change or retire this part?", and the honest answer
    // when a restricted assembly consumes it is "no, something uses it" — not an empty list
    // that invites breaking a program the caller cannot see. The lifecycle stays: it is state,
    // not identity, and it decides whether the row still matters.
    const visible = await visibleIds(
      'PART',
      lines.map((line) => line.parentRevision.part.id),
      user
    );
    const entries: WhereUsedEntry[] = lines.map((line) => {
      const parentVisible = visible.has(line.parentRevision.part.id);
      return {
        line: {
          id: line.id,
          findNumber: line.findNumber,
          quantity: line.quantity,
          uom: line.uom,
        },
        parentRevision: parentVisible
          ? toRevisionRef(line.parentRevision)
          : {
              id: line.parentRevision.id,
              revision: REDACTED.name,
              lifecycle: line.parentRevision.lifecycle,
            },
        parentPart: parentVisible
          ? {
              id: line.parentRevision.part.id,
              partNumber: line.parentRevision.part.partNumber,
              name: line.parentRevision.part.name,
            }
          : {
              id: line.parentRevision.part.id,
              partNumber: REDACTED.partNumber,
              name: REDACTED.name,
            },
      };
    });
    res.json(entries);
  })
);

// ---------------------------------------------------------------------------
// GET /revisions/:id/cbom-reconciliation — design vs engineering (rule C2a)
// ---------------------------------------------------------------------------

type CbomReconStatus =
  | 'MATCH'
  | 'QTY_MISMATCH'
  | 'MISSING_IN_EBOM'
  | 'EXTRA_IN_EBOM'
  | 'UNMATCHED';

const CBOM_ORDER: Record<CbomReconStatus, number> = {
  QTY_MISMATCH: 0,
  MISSING_IN_EBOM: 1,
  EXTRA_IN_EBOM: 2,
  UNMATCHED: 3,
  MATCH: 4,
};

/** Newest readable CAD version linked to the part or one of its revisions. */
async function findLinkedCadVersion(partId: number, revisionId: number, user: AclUser) {
  const links = await prisma.documentLink.findMany({
    // Acl-filtered: a CAD model in a restricted document is as good as not linked.
    where: { OR: [{ partId }, { partRevisionId: revisionId }], document: documentAcl(user) },
    select: {
      document: {
        select: {
          versions: {
            orderBy: { version: 'desc' },
            select: { id: true, version: true, fileName: true, storagePath: true, createdAt: true },
          },
        },
      },
    },
  });
  const candidates = links
    .flatMap((link) => link.document.versions)
    .filter((version) => isAssemblyReadable(version.fileName));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, v) => (v.createdAt > best.createdAt ? v : best));
}

router.get(
  '/revisions/:id/cbom-reconciliation',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    const revision = await readableRevisionOrThrow(revisionId, user);

    const requested = req.query.documentVersionId;
    let version;
    if (requested !== undefined) {
      const id = Number(requested);
      if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(400, 'documentVersionId must be a positive integer');
      }
      // A version in a restricted document answers like a missing one.
      version = await prisma.documentVersion.findFirst({
        where: { id, document: documentAcl(user) },
        select: { id: true, version: true, fileName: true, storagePath: true },
      });
      if (!version) throw new HttpError(404, 'Document version not found');
    } else {
      version = await findLinkedCadVersion(revision.partId, revision.id, user);
      if (!version) throw new HttpError(409, 'No CAD model is linked to this part');
    }

    const assembly = await readAssembly(version.id, version.storagePath, version.fileName);
    if (assembly.root) await scrubHiddenMatches(assembly.root, user);
    const [bomLines] = await Promise.all([
      prisma.bomLine.findMany({
        where: { parentRevisionId: revision.id },
        select: { id: true, quantity: true, childPart: true },
      }),
    ]);

    // Only the top level is comparable: deeper CAD levels belong to the child parts.
    const topLevel = assembly.root?.children ?? [];
    const cadByPart = new Map<number, { name: string; quantity: number }>();
    const cadUnmatched: { name: string; quantity: number }[] = [];
    for (const node of topLevel) {
      if (!node.match) {
        const existing = cadUnmatched.find((u) => u.name === node.name);
        if (existing) existing.quantity += node.instances;
        else cadUnmatched.push({ name: node.name, quantity: node.instances });
        continue;
      }
      const current = cadByPart.get(node.match.part.id);
      if (current) current.quantity += node.instances;
      else cadByPart.set(node.match.part.id, { name: node.name, quantity: node.instances });
    }

    interface Row {
      part: MaybePartRef | null;
      cadName: string | null;
      status: CbomReconStatus;
      cadQuantity: number | null;
      ebomQuantity: number | null;
    }
    const rows: Row[] = [];
    const bomByPart = new Map(bomLines.map((line) => [line.childPart.id, line]));
    // The CAD side is already scrubbed (hidden matches degraded to UNMATCHED above), so a
    // hidden eBOM child can only surface here as EXTRA_IN_EBOM — redacted, quantity intact.
    const visibleEbomParts = await visibleIds(
      'PART',
      bomLines.map((line) => line.childPart.id),
      user
    );

    for (const [partId, cad] of cadByPart) {
      const line = bomByPart.get(partId);
      const node = topLevel.find((n) => n.match?.part.id === partId);
      const part = line ? toPartRef(line.childPart) : (node?.match?.part as PartRef);
      if (!line) {
        rows.push({
          part,
          cadName: cad.name,
          status: 'MISSING_IN_EBOM',
          cadQuantity: cad.quantity,
          ebomQuantity: null,
        });
      } else {
        rows.push({
          part,
          cadName: cad.name,
          status:
            Math.abs(line.quantity - cad.quantity) > 1e-6 ? 'QTY_MISMATCH' : 'MATCH',
          cadQuantity: cad.quantity,
          ebomQuantity: line.quantity,
        });
      }
    }
    for (const line of bomLines) {
      if (cadByPart.has(line.childPart.id)) continue;
      rows.push({
        part: visibleEbomParts.has(line.childPart.id) ? toPartRef(line.childPart) : REDACTED,
        cadName: null,
        status: 'EXTRA_IN_EBOM',
        cadQuantity: null,
        ebomQuantity: line.quantity,
      });
    }
    for (const node of cadUnmatched) {
      rows.push({
        part: null,
        cadName: node.name,
        status: 'UNMATCHED',
        cadQuantity: node.quantity,
        ebomQuantity: null,
      });
    }
    rows.sort(
      (a, b) =>
        CBOM_ORDER[a.status] - CBOM_ORDER[b.status] ||
        (a.part?.partNumber ?? a.cadName ?? '').localeCompare(b.part?.partNumber ?? b.cadName ?? '')
    );

    res.json({
      revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
      documentVersion: { id: version.id, version: version.version, fileName: version.fileName },
      assemblyStatus: assembly.status,
      assemblyReason: assembly.reason,
      assemblyName: assembly.root?.name ?? null,
      extractedAt: assembly.extractedAt,
      rows,
      counts: {
        match: rows.filter((r) => r.status === 'MATCH').length,
        qtyMismatch: rows.filter((r) => r.status === 'QTY_MISMATCH').length,
        missingInEbom: rows.filter((r) => r.status === 'MISSING_IN_EBOM').length,
        extraInEbom: rows.filter((r) => r.status === 'EXTRA_IN_EBOM').length,
        unmatched: rows.filter((r) => r.status === 'UNMATCHED').length,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /revisions/:id/bom-from-cad — propose (and optionally apply) an eBOM
// derived from a CAD assembly's top level (rule C3)
// ---------------------------------------------------------------------------
type CadBomChange = 'ADD' | 'REMOVE' | 'QTY_CHANGE' | 'UNCHANGED' | 'UNMATCHED';

interface CadBomProposalLine {
  change: CadBomChange;
  cadName: string | null;
  /** REDACTED for a REMOVE whose existing child the caller cannot read (rule X4). */
  part: MaybePartRef | null;
  cadQuantity: number | null;
  bomQuantity: number | null;
  bomLineId: number | null;
  /** How the CAD name resolved to a part, for reviewer confidence. */
  matchedBy: 'PART_NUMBER' | 'NAME' | null;
}

/** One imported level: the top assembly, plus one entry per sub-assembly when recursive. */
interface CadBomLevel {
  assemblyName: string;
  /** The part whose eBOM this level writes; null for the revision's own part. */
  part: PartRef | null;
  revision: RevisionRef;
  lines: CadBomProposalLine[];
  counts: { add: number; remove: number; qtyChange: number; unchanged: number; unmatched: number };
}

const CHANGE_ORDER: Record<CadBomChange, number> = {
  ADD: 0,
  QTY_CHANGE: 1,
  REMOVE: 2,
  UNMATCHED: 3,
  UNCHANGED: 4,
};

function countChanges(lines: CadBomProposalLine[]) {
  return {
    add: lines.filter((l) => l.change === 'ADD').length,
    remove: lines.filter((l) => l.change === 'REMOVE').length,
    qtyChange: lines.filter((l) => l.change === 'QTY_CHANGE').length,
    unchanged: lines.filter((l) => l.change === 'UNCHANGED').length,
    unmatched: lines.filter((l) => l.change === 'UNMATCHED').length,
  };
}

function sortProposal(lines: CadBomProposalLine[]): CadBomProposalLine[] {
  return [...lines].sort(
    (a, b) =>
      CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] ||
      (a.part?.partNumber ?? a.cadName ?? '').localeCompare(b.part?.partNumber ?? b.cadName ?? '')
  );
}

/**
 * Collapse one CAD level into per-part quantities.
 *
 * Two differently named CAD products can resolve to the same part, and a BOM allows a part
 * only once, so their instance counts are summed rather than producing a duplicate line.
 */
function collapseLevel(nodes: CadAssemblyNode[]) {
  const byPart = new Map<number, { name: string; quantity: number; by: 'PART_NUMBER' | 'NAME' }>();
  const refs = new Map<number, PartRef>();
  const unmatched: { name: string; quantity: number }[] = [];
  for (const node of nodes) {
    if (!node.match) {
      const existing = unmatched.find((u) => u.name === node.name);
      if (existing) existing.quantity += node.instances;
      else unmatched.push({ name: node.name, quantity: node.instances });
      continue;
    }
    refs.set(node.match.part.id, node.match.part);
    const current = byPart.get(node.match.part.id);
    if (current) current.quantity += node.instances;
    else
      byPart.set(node.match.part.id, {
        name: node.name,
        quantity: node.instances,
        by: node.match.by,
      });
  }
  return { byPart, refs, unmatched };
}

/** Diff one collapsed CAD level against a revision's existing eBOM. */
async function proposeLevel(
  db: Prisma.TransactionClient,
  parentRevisionId: number,
  byPart: Map<number, { name: string; quantity: number; by: 'PART_NUMBER' | 'NAME' }>,
  refs: Map<number, PartRef>,
  unmatched: { name: string; quantity: number }[],
  user: AclUser
): Promise<CadBomProposalLine[]> {
  const existing = await db.bomLine.findMany({
    where: { parentRevisionId },
    select: { id: true, quantity: true, childPart: true },
  });
  // CAD matches were scrubbed before this diff, so a hidden existing child can only land in
  // the REMOVE branch — where it keeps its line id (deleting a line off a BOM the caller may
  // write needs no access to the child) and loses its identity.
  const visibleExisting = await visibleIds(
    'PART',
    existing.map((line) => line.childPart.id),
    user
  );
  const existingByPart = new Map(existing.map((line) => [line.childPart.id, line]));
  const lines: CadBomProposalLine[] = [];

  for (const [partId, cad] of byPart) {
    const line = existingByPart.get(partId);
    const part = line ? toPartRef(line.childPart) : (refs.get(partId) as PartRef);
    if (!line) {
      lines.push({
        change: 'ADD',
        cadName: cad.name,
        part,
        cadQuantity: cad.quantity,
        bomQuantity: null,
        bomLineId: null,
        matchedBy: cad.by,
      });
    } else if (Math.abs(line.quantity - cad.quantity) > 1e-6) {
      lines.push({
        change: 'QTY_CHANGE',
        cadName: cad.name,
        part,
        cadQuantity: cad.quantity,
        bomQuantity: line.quantity,
        bomLineId: line.id,
        matchedBy: cad.by,
      });
    } else {
      lines.push({
        change: 'UNCHANGED',
        cadName: cad.name,
        part,
        cadQuantity: cad.quantity,
        bomQuantity: line.quantity,
        bomLineId: line.id,
        matchedBy: cad.by,
      });
    }
  }
  for (const line of existing) {
    if (byPart.has(line.childPart.id)) continue;
    lines.push({
      change: 'REMOVE',
      cadName: null,
      part: visibleExisting.has(line.childPart.id) ? toPartRef(line.childPart) : REDACTED,
      cadQuantity: null,
      bomQuantity: line.quantity,
      bomLineId: line.id,
      matchedBy: null,
    });
  }
  for (const node of unmatched) {
    lines.push({
      change: 'UNMATCHED',
      cadName: node.name,
      part: null,
      cadQuantity: node.quantity,
      bomQuantity: null,
      bomLineId: null,
      matchedBy: null,
    });
  }
  return lines;
}

/** Create a part per unmatched CAD product so it can join the level as an ADD. */
async function createPartsForUnmatched(
  tx: Prisma.TransactionClient,
  unmatched: { name: string; quantity: number }[],
  byPart: Map<number, { name: string; quantity: number; by: 'PART_NUMBER' | 'NAME' }>,
  refs: Map<number, PartRef>,
  userId: number,
  sourceFileName: string
): Promise<void> {
  for (const node of unmatched) {
    // The scan-max number generator must run on this transaction client, or parts created
    // here are invisible to it and it hands out the same number twice.
    const partNumber = await generatePartNumber(tx);
    const created = await tx.part.create({
      data: {
        partNumber,
        name: node.name,
        description: `Created from CAD assembly ${sourceFileName}`,
        category: PartCategory.MECHANICAL,
        createdById: userId,
        revisions: {
          create: { revision: 'A', lifecycle: Lifecycle.IN_WORK, createdById: userId },
        },
      },
    });
    byPart.set(created.id, { name: node.name, quantity: node.quantity, by: 'NAME' });
    refs.set(created.id, toPartRef(created));
  }
  unmatched.length = 0;
}

/** Write one proposed level. REMOVE only lands when the caller opted in. */
async function applyLevel(
  tx: Prisma.TransactionClient,
  target: { id: number; partId: number },
  lines: CadBomProposalLine[],
  removeMissing: boolean
): Promise<void> {
  for (const line of lines) {
    // The redacted guard is for the type: an ADD can only come from a scrubbed (visible) CAD
    // match, so a REDACTED part here is unreachable — but the union must still be narrowed.
    if (line.change === 'ADD' && line.part && !('redacted' in line.part)) {
      await assertNoCycle(target.partId, line.part.id, tx);
      await tx.bomLine.create({
        data: {
          parentRevisionId: target.id,
          childPartId: line.part.id,
          findNumber: await nextFindNumber(target.id, tx),
          quantity: line.cadQuantity as number,
          uom: line.part.uom,
        },
      });
    } else if (line.change === 'QTY_CHANGE' && line.bomLineId !== null) {
      await tx.bomLine.update({
        where: { id: line.bomLineId },
        data: { quantity: line.cadQuantity as number },
      });
    } else if (line.change === 'REMOVE' && removeMissing && line.bomLineId !== null) {
      await tx.bomLine.delete({ where: { id: line.bomLineId } });
    }
  }
}

router.post(
  '/revisions/:id/bom-from-cad',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — resolve access before reading the body, so a 400 about the payload can never
    // confirm a restricted revision exists.
    const revision = await readableRevisionOrThrow(revisionId, user);
    const userId = user.id;

    const body = bodyOf(req);
    const documentVersionId = requirePositiveInt(body.documentVersionId, 'documentVersionId');
    const apply = body.apply === true;
    const removeMissing = body.removeMissing === true;
    const createMissingParts = body.createMissingParts === true;
    const recursive = body.recursive === true;

    // A dry run is a read, so only an actual write needs the write grant and the lifecycle.
    if (apply) {
      await assertCanWrite('PART', revision.partId, user);
      assertEditable(revision);
    }

    const version = await prisma.documentVersion.findFirst({
      where: { id: documentVersionId, document: documentAcl(user) },
      select: { id: true, version: true, fileName: true, storagePath: true },
    });
    if (!version) throw new HttpError(404, 'Document version not found');

    const assembly = await readAssembly(version.id, version.storagePath, version.fileName);
    if (assembly.root) await scrubHiddenMatches(assembly.root, user);
    if (assembly.status !== 'DONE' || !assembly.root) {
      throw new HttpError(
        409,
        assembly.status === 'SKIPPED'
          ? `${version.fileName} is not a readable CAD format`
          : 'The CAD file has no readable assembly structure'
      );
    }

    const topLevel = assembly.root.children;
    const deeperNodeCount = topLevel.reduce((sum, node) => sum + countDescendants(node), 0);

    /** Sub-assemblies the recursion could not write, with why — never fatal. */
    const skippedAssemblies: { cadName: string; part: PartRef | null; reason: string }[] = [];

    /**
     * Walk one CAD level and, when recursive, descend into every matched sub-assembly.
     * Each level writes to its own part's latest IN_WORK revision.
     */
    const walk = async (
      db: Prisma.TransactionClient,
      target: { id: number; partId: number; revision: string; lifecycle: Lifecycle },
      part: PartRef | null,
      assemblyName: string,
      nodes: CadAssemblyNode[],
      write: boolean,
      depth: number
    ): Promise<CadBomLevel[]> => {
      const { byPart, refs, unmatched } = collapseLevel(nodes);
      if (write && createMissingParts && unmatched.length > 0) {
        await createPartsForUnmatched(db, unmatched, byPart, refs, userId, version.fileName);
      }
      const lines = await proposeLevel(db, target.id, byPart, refs, unmatched, user);
      if (write) await applyLevel(db, target, lines, removeMissing);

      const levels: CadBomLevel[] = [
        {
          assemblyName,
          part,
          revision: {
            id: target.id,
            revision: target.revision,
            lifecycle: target.lifecycle,
          },
          lines: sortProposal(lines),
          counts: countChanges(lines),
        },
      ];
      if (!recursive) return levels;

      // A CAD node only defines a sub-BOM when it both matches a part and has children.
      for (const node of nodes) {
        if (node.children.length === 0) continue;
        // node.match is null for a part created moments ago by createPartsForUnmatched;
        // those land in `refs` under the CAD name, so look there too.
        const resolved =
          node.match?.part ?? [...refs.values()].find((ref) => ref.name === node.name) ?? null;
        if (!resolved) {
          skippedAssemblies.push({
            cadName: node.name,
            part: null,
            reason: 'No part matches this CAD sub-assembly',
          });
          continue;
        }
        const childPartId = resolved.id;
        const childRevisions = await db.partRevision.findMany({
          where: { partId: childPartId, lifecycle: Lifecycle.IN_WORK },
          orderBy: { id: 'desc' },
          take: 1,
          select: { id: true, partId: true, revision: true, lifecycle: true },
        });
        const childRevision = childRevisions[0];
        if (!childRevision) {
          skippedAssemblies.push({
            cadName: node.name,
            part: resolved,
            reason: `${resolved.partNumber} has no In Work revision to write to`,
          });
          continue;
        }
        // 15 is the same ceiling the BOM tree walk uses.
        if (depth + 1 >= MAX_TREE_DEPTH) {
          skippedAssemblies.push({
            cadName: node.name,
            part: resolved,
            reason: 'Maximum BOM depth reached',
          });
          continue;
        }
        // Recursion writes to the CHILD part's eBOM, which needs its own write grant — WRITE
        // on the top assembly does not extend downward. Skipped, not fatal: one locked
        // sub-assembly should not abort the rest of the import. The part is visible here
        // (matches were scrubbed), so naming it in the reason discloses nothing new.
        if (write) {
          try {
            await assertCanWrite('PART', childPartId, user);
          } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            skippedAssemblies.push({
              cadName: node.name,
              part: resolved,
              reason: `You do not have write access to ${resolved.partNumber}`,
            });
            continue;
          }
        }
        levels.push(
          ...(await walk(
            db,
            childRevision,
            resolved,
            node.name,
            node.children,
            write,
            depth + 1
          ))
        );
      }
      return levels;
    };

    let levels: CadBomLevel[];
    if (!apply) {
      levels = await walk(prisma, revision, null, assembly.root.name, topLevel, false, 0);
    } else {
      levels = await prisma.$transaction(async (tx) => {
        // Same lock the manual BOM writes take, so a concurrent add cannot slip a cycle
        // past the checks inside applyLevel.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-bom-structure'))::text`;
        return walk(tx, revision, null, assembly.root!.name, topLevel, true, 0);
      });
    }

    const top = levels[0];
    res.json({
      documentVersion: { id: version.id, version: version.version, fileName: version.fileName },
      revision: { id: revision.id, revision: revision.revision, lifecycle: revision.lifecycle },
      assemblyName: assembly.root.name,
      applied: apply,
      removedMissing: apply && removeMissing,
      recursive,
      deeperNodeCount,
      // The top level stays at the root of the response so a one-level import reads the
      // same as it did before recursion existed.
      lines: top.lines,
      counts: top.counts,
      levels,
      skippedAssemblies,
      totals: {
        add: levels.reduce((sum, l) => sum + l.counts.add, 0),
        remove: levels.reduce((sum, l) => sum + l.counts.remove, 0),
        qtyChange: levels.reduce((sum, l) => sum + l.counts.qtyChange, 0),
        unchanged: levels.reduce((sum, l) => sum + l.counts.unchanged, 0),
        unmatched: levels.reduce((sum, l) => sum + l.counts.unmatched, 0),
      },
    });
  })
);

export default router;
