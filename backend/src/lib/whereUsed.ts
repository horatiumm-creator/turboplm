/**
 * Walking UPWARD from a part to every assembly that contains it.
 *
 * Its own module rather than a helper inside a route, because two screens ask the same
 * question and the shallow answer is a trap. `GET /parts/:id/where-used` and
 * `GET /ecns/:id/impact` both do `bomLine.findMany({ where: { childPartId } })` — one level.
 * That is the right answer for the structure editor, where you want the lines that call a
 * part out with their find numbers. It is the wrong answer for "what does this change
 * break?", where one level shows the sub-assemblies and never the products.
 *
 * NO REVISION NARROWING, because a BOM line in this build names a child PART and not a
 * child revision: there is no `childRevisionId` to pin a line to the revision being
 * replaced. So the question this answers is "what contains this part", at every level, and
 * the honest reading of the answer is that every assembly listed will follow the part as it
 * is revised. Nothing here claims to know which assemblies hold one specific old revision,
 * because the schema does not record it.
 */
import { Lifecycle } from '@prisma/client';
import { prisma } from './prisma';
import { AclUser, REDACTED, visibleIds } from './acl';

/** How far up the walk goes before it reports a truncated answer instead of a wrong one. */
export const MAX_TREE_DEPTH = 15;

export interface RevisionRef {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

function toRevisionRef(rev: { id: number; revision: string; lifecycle: Lifecycle }): RevisionRef {
  return { id: rev.id, revision: rev.revision, lifecycle: rev.lifecycle };
}

/** One assembly that contains the part, somewhere above it. */
export interface WhereUsedNode {
  parentRevision: RevisionRef;
  parentPart: { id: number; partNumber: string; name: string };
  /** 1 = direct parent, 2 = its parent, and so on. */
  level: number;
  /** True when nothing consumes this assembly: the top of a product. */
  isTopLevel: boolean;
  /** Part numbers from the part asked about up to this assembly, for reading a path back. */
  path: string[];
}

/** A node plus the part ids behind its path, which the DTO does not carry. */
type WalkedNode = WhereUsedNode & { pathIds: number[] };

export interface WhereUsedTreeDto {
  /** Every assembly above the part, deduplicated by revision, nearest level first. */
  used: WhereUsedNode[];
  /** The subset with nothing above them — the products this part ends up in. */
  topLevel: WhereUsedNode[];
  notes: string[];
}

export async function walkWhereUsed(partId: number, user: AclUser): Promise<WhereUsedTreeDto> {
  const notes: string[] = [];
  const found = new Map<number, WalkedNode>();
  /*
   * Revisions already expanded.
   *
   * Not for deduplication — `found` is keyed by revision and does that on its own. This set
   * does two other things: it keeps the level NEAREST, because the map does not order by
   * distance and a second, deeper sighting would otherwise overwrite the first (a product
   * sitting directly on the part would read as two levels away), and it bounds the walk if
   * the stored BOM contains a cycle, which should not exist but could arrive from a restore.
   */
  const expanded = new Set<number>();

  interface Frontier {
    childPartId: number;
    level: number;
    path: string[];
    pathIds: number[];
  }

  const startPart = await prisma.part.findUnique({
    where: { id: partId },
    select: { partNumber: true },
  });
  let frontier: Frontier[] = [
    {
      childPartId: partId,
      level: 1,
      path: [startPart?.partNumber ?? String(partId)],
      pathIds: [partId],
    },
  ];

  while (frontier.length > 0) {
    if (frontier[0].level > MAX_TREE_DEPTH) {
      notes.push(`Stopped after ${MAX_TREE_DEPTH} levels; there may be more above this.`);
      break;
    }
    const next: Frontier[] = [];

    for (const step of frontier) {
      const lines = await prisma.bomLine.findMany({
        where: { childPartId: step.childPartId },
        select: {
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

      for (const line of lines) {
        const rev = line.parentRevision;
        if (expanded.has(rev.id)) continue;
        expanded.add(rev.id);

        const path = [...step.path, rev.part.partNumber];
        const pathIds = [...step.pathIds, rev.part.id];
        found.set(rev.id, {
          parentRevision: toRevisionRef(rev),
          parentPart: { id: rev.part.id, partNumber: rev.part.partNumber, name: rev.part.name },
          level: step.level,
          // Filled in below, once every level is known.
          isTopLevel: false,
          path,
          pathIds,
        });
        next.push({
          childPartId: rev.part.id,
          level: step.level + 1,
          path,
          pathIds,
        });
      }
    }
    frontier = next;
  }

  // An assembly is top-level when nothing consumes the PART it belongs to.
  const partIds = [...new Set([...found.values()].map((n) => n.parentPart.id))];
  const consumed = new Set(
    (
      await prisma.bomLine.findMany({
        where: { childPartId: { in: partIds } },
        select: { childPartId: true },
      })
    ).map((l) => l.childPartId)
  );

  /*
   * Visibility is asked about every part named ANYWHERE, including parts that appear only
   * as an intermediate step in someone else's path.
   *
   * Judging a path by the visibility of the row it belongs to is not enough: a visible
   * top-level product reached THROUGH a restricted sub-assembly would print that
   * sub-assembly's part number in its path, leaking through the route exactly what the
   * redacted row above it refuses to leak directly. Each segment is judged on its own part.
   */
  const namedIds = [...new Set([...found.values()].flatMap((n) => n.pathIds))];
  const visible = await visibleIds('PART', namedIds, user);
  const nodes: WhereUsedNode[] = [...found.values()]
    .map(({ pathIds, ...node }) => ({
      ...node,
      isTopLevel: !consumed.has(node.parentPart.id),
      parentRevision: visible.has(node.parentPart.id)
        ? node.parentRevision
        : { ...node.parentRevision, revision: REDACTED.name },
      parentPart: visible.has(node.parentPart.id)
        ? node.parentPart
        : { id: node.parentPart.id, partNumber: REDACTED.partNumber, name: REDACTED.name },
      // Index 0 is the part asked about, which the caller's own ACL check already cleared.
      path: node.path.map((step, i) =>
        i === 0 || visible.has(pathIds[i]) ? step : REDACTED.partNumber
      ),
    }))
    .sort((a, b) => a.level - b.level || a.parentPart.id - b.parentPart.id);

  return { used: nodes, topLevel: nodes.filter((n) => n.isTopLevel), notes };
}
