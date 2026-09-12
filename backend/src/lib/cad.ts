/**
 * Assembly-structure reads from the `cad` sidecar (rules C1–C3).
 *
 * Conversion lives in routes/documents.ts because it writes derivative columns; this
 * module is the read-only half, shared by the document route that exposes the tree and
 * the BOM route that turns it into a proposal.
 */
import type { Part } from '@prisma/client';
import { prisma } from './prisma';
import { AclUser, visibleIds } from './acl';

const CAD_SERVICE_URL = process.env.CAD_SERVICE_URL || 'http://cad:4100';
const READABLE = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp']);

/** Products the kernel could not name — never match a part, never imported. */
export const UNNAMED = 'Unnamed';

export function cadFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function isAssemblyReadable(fileName: string): boolean {
  return READABLE.has(cadFileExtension(fileName));
}

/** Raw tree as returned by the sidecar. */
export interface RawAssemblyNode {
  name: string;
  instances: number;
  children: RawAssemblyNode[];
}

export interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: Part['category'];
  uom: string;
}

export interface CadAssemblyNode {
  name: string;
  instances: number;
  match: { part: PartRefDto; by: 'PART_NUMBER' | 'NAME' } | null;
  children: CadAssemblyNode[];
}

export interface CadAssembly {
  status: 'DONE' | 'SKIPPED' | 'FAILED';
  reason: string | null;
  root: CadAssemblyNode | null;
  nodeCount: number;
  maxDepth: number;
  /** When the snapshot was taken; null when there is no snapshot at all. */
  extractedAt: string | null;
  rootName: string | null;
}

interface AssemblyResponse {
  status?: string;
  root?: RawAssemblyNode;
  nodeCount?: number;
  maxDepth?: number;
  reason?: string;
  error?: string;
}

function toPartRef(part: Part): PartRefDto {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

/**
 * Resolve CAD product names to parts: exact part number first, then exact name.
 * Both are case-insensitive. A name matching more than one part stays unmatched —
 * guessing would silently put the wrong part on a BOM.
 */
export async function matchNamesToParts(
  names: Iterable<string>
): Promise<Map<string, { part: PartRefDto; by: 'PART_NUMBER' | 'NAME' }>> {
  const wanted = [...new Set([...names].filter((n) => n !== UNNAMED))];
  const result = new Map<string, { part: PartRefDto; by: 'PART_NUMBER' | 'NAME' }>();
  if (wanted.length === 0) return result;

  const candidates = await prisma.part.findMany({
    where: {
      OR: [
        { partNumber: { in: wanted, mode: 'insensitive' } },
        { name: { in: wanted, mode: 'insensitive' } },
      ],
    },
  });

  for (const name of wanted) {
    const key = name.toLowerCase();
    const byNumber = candidates.filter((p) => p.partNumber.toLowerCase() === key);
    if (byNumber.length === 1) {
      result.set(name, { part: toPartRef(byNumber[0]), by: 'PART_NUMBER' });
      continue;
    }
    if (byNumber.length > 1) continue; // ambiguous — leave unmatched
    const byName = candidates.filter((p) => p.name.toLowerCase() === key);
    if (byName.length === 1) result.set(name, { part: toPartRef(byName[0]), by: 'NAME' });
  }
  return result;
}

/** Raw kernel read — the only place the sidecar is called. */
async function fetchAssemblyFromKernel(
  storagePath: string,
  fileName: string
): Promise<
  | { status: 'DONE'; root: RawAssemblyNode; nodeCount: number; maxDepth: number }
  | { status: 'SKIPPED' | 'FAILED'; reason: string }
> {
  if (!isAssemblyReadable(fileName)) {
    return {
      status: 'SKIPPED',
      reason: `.${cadFileExtension(fileName) || 'unknown'} is not a readable CAD format`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${CAD_SERVICE_URL}/assembly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath, fileName }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`CAD service responded ${res.status}`);
    const body = (await res.json()) as AssemblyResponse;

    if (body.status === 'SKIPPED') {
      return { status: 'SKIPPED', reason: body.reason ?? 'Not a readable CAD format' };
    }
    if (body.status !== 'DONE' || !body.root) {
      return {
        status: 'FAILED',
        reason: (body.error || 'The CAD kernel could not read this file').slice(0, 400),
      };
    }
    return {
      status: 'DONE',
      root: body.root,
      nodeCount: typeof body.nodeCount === 'number' ? body.nodeCount : 0,
      maxDepth: typeof body.maxDepth === 'number' ? body.maxDepth : 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Assembly read failed';
    return { status: 'FAILED', reason: message.slice(0, 400) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract a CAD version's structure and persist it as the cBOM (rule C2).
 *
 * Never throws: a failure is recorded on the row so an upload is unaffected. Replaces any
 * previous snapshot for the version, so a refresh is a clean overwrite.
 */
export async function extractCadStructure(
  documentVersionId: number,
  storagePath: string,
  fileName: string
): Promise<void> {
  const result = await fetchAssemblyFromKernel(storagePath, fileName);

  try {
    await prisma.$transaction(async (tx) => {
      // Cascade clears the old node tree; one snapshot per version.
      await tx.cadStructure.deleteMany({ where: { documentVersionId } });

      if (result.status !== 'DONE') {
        await tx.cadStructure.create({
          data: {
            documentVersionId,
            status: result.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
            error: result.reason,
          },
        });
        return;
      }

      const structure = await tx.cadStructure.create({
        data: {
          documentVersionId,
          status: 'DONE',
          rootName: result.root.name,
          nodeCount: result.nodeCount,
          maxDepth: result.maxDepth,
        },
      });

      // Breadth-first so every parent id exists before its children are written.
      let frontier: { node: RawAssemblyNode; parentId: number | null }[] = [
        { node: result.root, parentId: null },
      ];
      for (let depth = 0; frontier.length > 0; depth++) {
        const next: { node: RawAssemblyNode; parentId: number | null }[] = [];
        for (const [index, item] of frontier.entries()) {
          const created = await tx.cadNode.create({
            data: {
              structureId: structure.id,
              parentId: item.parentId,
              name: item.node.name,
              instances: item.node.instances,
              depth,
              seq: index,
            },
            select: { id: true },
          });
          for (const child of item.node.children) next.push({ node: child, parentId: created.id });
        }
        frontier = next;
      }
    });
  } catch (err) {
    console.error(`Could not persist CAD structure for version ${documentVersionId}:`, err);
  }
}

interface StoredNode {
  id: number;
  parentId: number | null;
  name: string;
  instances: number;
  depth: number;
  seq: number;
}

/** Rebuild the decorated tree from stored rows, resolving part matches at read time. */
async function buildFromStored(
  rootName: string | null,
  rows: StoredNode[],
  nodeCount: number,
  maxDepth: number,
  extractedAt: Date
): Promise<CadAssembly> {
  const matches = await matchNamesToParts(rows.map((row) => row.name));
  const byId = new Map<number, CadAssemblyNode>();
  for (const row of rows) {
    byId.set(row.id, {
      name: row.name,
      instances: row.instances,
      match: matches.get(row.name) ?? null,
      children: [],
    });
  }
  let root: CadAssemblyNode | null = null;
  for (const row of rows) {
    const node = byId.get(row.id) as CadAssemblyNode;
    if (row.parentId === null) root = node;
    else byId.get(row.parentId)?.children.push(node);
  }
  return {
    status: 'DONE',
    reason: null,
    root,
    nodeCount,
    maxDepth,
    extractedAt: extractedAt.toISOString(),
    rootName,
  };
}

/**
 * Read the persisted cBOM for a CAD version, extracting on first access.
 *
 * Serving from the snapshot keeps the kernel off the request path — a real assembly takes
 * seconds to read, which is unacceptable per page view.
 */
export async function readAssembly(
  documentVersionId: number,
  storagePath: string,
  fileName: string,
  options: { refresh?: boolean } = {}
): Promise<CadAssembly> {
  const load = () =>
    prisma.cadStructure.findUnique({
      where: { documentVersionId },
      include: { nodes: { orderBy: [{ depth: 'asc' }, { seq: 'asc' }] } },
    });

  let structure = options.refresh ? null : await load();
  if (!structure || structure.status === 'PENDING') {
    await extractCadStructure(documentVersionId, storagePath, fileName);
    structure = await load();
  }
  if (!structure) {
    return {
      status: 'FAILED',
      reason: 'Could not read the CAD structure',
      root: null,
      nodeCount: 0,
      maxDepth: 0,
      extractedAt: null,
      rootName: null,
    };
  }
  if (structure.status !== 'DONE') {
    return {
      status: structure.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
      reason: structure.error,
      root: null,
      nodeCount: 0,
      maxDepth: 0,
      extractedAt: structure.extractedAt.toISOString(),
      rootName: null,
    };
  }
  return buildFromStored(
    structure.rootName,
    structure.nodes,
    structure.nodeCount,
    structure.maxDepth,
    structure.extractedAt
  );
}

/** Nodes below the imported level, reported so a one-level import is not mistaken for all of it. */
export function countDescendants(node: CadAssemblyNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/**
 * Rule X4 for CAD matching — a part the caller cannot read must behave exactly as if it does
 * not exist, so its match is stripped before the tree is served or diffed: the node degrades
 * to UNMATCHED, the same answer the matcher gives for a name that resolves to nothing. The CAD
 * file's own product names stay, because they belong to a document the caller has already been
 * allowed to read. Safe to do in place: `readAssembly` rebuilds the tree from rows per call.
 */
export async function scrubHiddenMatches(root: CadAssemblyNode, user: AclUser): Promise<void> {
  const ids: number[] = [];
  const collect = (node: CadAssemblyNode): void => {
    if (node.match) ids.push(node.match.part.id);
    node.children.forEach(collect);
  };
  collect(root);
  const visible = await visibleIds('PART', ids, user);
  const scrub = (node: CadAssemblyNode): void => {
    if (node.match && !visible.has(node.match.part.id)) node.match = null;
    node.children.forEach(scrub);
  };
  scrub(root);
}
