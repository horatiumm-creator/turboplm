import { Lifecycle, Prisma, PartRevision } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Escape SQL LIKE metacharacters for Prisma `contains` filters (Prisma does not
 * escape them itself): a literal search for "FRAME_ARM" must not wildcard-match.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Next revision label: A → B → … → Z → AA → AB → … */
export function nextRevisionLabel(current: string): string {
  const chars = current.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
    i -= 1;
  }
  return 'A' + chars.join('');
}

/**
 * Generate the next auto part number, P-10001 style. Derived from the highest
 * existing P-<digits> part number (not part ids, which drift on deletes and can
 * collide with user-chosen numbers); concurrent creates are handled by the
 * caller retrying on a unique-constraint violation.
 */
export async function generatePartNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  // The scan must run on the caller's transaction client: parts created earlier in an
  // open transaction are invisible from outside it, so a shared connection would hand
  // out the same number twice.
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("partNumber" FROM 3)::int) AS max
    FROM "Part"
    WHERE "partNumber" ~ '^P-[0-9]{1,9}$'`;
  return `P-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}


/**
 * Serialize scan-max number allocation across concurrent requests.
 *
 * Every generator in this codebase reads `MAX(<number>)` and then inserts. With no lock,
 * concurrent callers all read the same maximum, all but one hit the unique constraint, and
 * the bounded retry runs out — so a burst of creates returns spurious 409s even though
 * uniqueness itself is never violated. Serializing allocation with the same advisory-lock
 * pattern BOM structure and ECN membership writes already use makes the retry a backstop
 * rather than the mechanism.
 *
 * The lock is transaction-scoped, so it releases on commit or rollback.
 */
export async function withNumberLock<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-numbering'))::text`;
    return fn(tx);
  });
}

/** Take the same lock inside a transaction the caller already opened. */
export async function lockNumbering(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-numbering'))::text`;
}

/**
 * Resolved revision rule: latest RELEASED revision, else latest revision (highest id).
 * Returns null for an empty list.
 *
 * A PINNED line overrides all of that. Once a parent assembly is released its BOM lines name
 * the exact child revision they were released against (`pinChildRevisions` below), and the
 * whole point of that pin is that the structure stops following the child as it is revised.
 * So a pin is returned outright, and a pin naming a revision that is not in the list returns
 * null rather than falling back to the latest — falling back would silently resume the
 * following behaviour the pin exists to stop, which is the one failure worth being loud about.
 */
export function resolveDisplayRevision<T extends Pick<PartRevision, 'id' | 'lifecycle'>>(
  revisions: T[],
  pinnedRevisionId?: number | null
): T | null {
  if (revisions.length === 0) return null;
  if (pinnedRevisionId !== undefined && pinnedRevisionId !== null) {
    return revisions.find((r) => r.id === pinnedRevisionId) ?? null;
  }
  const released = revisions.filter((r) => r.lifecycle === Lifecycle.RELEASED);
  const pool = released.length > 0 ? released : revisions;
  return pool.reduce((best, r) => (r.id > best.id ? r : best));
}

/**
 * Pin every BOM line of a revision to the child revision it resolves to right now.
 *
 * Called at the moment a parent assembly is RELEASED, from both release paths — the direct
 * lifecycle transition and the ECN one — because a BOM released through a change order must
 * be frozen exactly as firmly as one released on its own. A pin written by one path and not
 * the other would be worse than no pinning at all: the behaviour would depend on which
 * button somebody used.
 *
 * Idempotent, and it only ever fills a null. Re-running it must not re-point a line that is
 * already pinned — the second write would be the silent history rewrite this whole feature
 * exists to prevent, arriving by a different route.
 *
 * Takes the transaction client, so the pins and the lifecycle change commit together. A
 * release that committed without its pins would leave a released assembly reading as
 * unpinned, which is indistinguishable from one released before this feature existed.
 */
export async function pinChildRevisions(
  tx: Prisma.TransactionClient,
  parentRevisionId: number
): Promise<number> {
  const lines = await tx.bomLine.findMany({
    where: { parentRevisionId, childRevisionId: null },
    select: {
      id: true,
      childPart: { select: { revisions: { select: { id: true, lifecycle: true } } } },
    },
  });

  let pinned = 0;
  for (const line of lines) {
    const resolved = resolveDisplayRevision(line.childPart.revisions);
    // No resolvable revision means the child has none at all. The release gate in
    // routes/parts.ts already refuses that case; leaving the line unpinned rather than
    // throwing keeps this function safe to call from a path whose gate differs.
    if (!resolved) continue;
    await tx.bomLine.update({
      where: { id: line.id },
      data: { childRevisionId: resolved.id },
    });
    pinned += 1;
  }
  return pinned;
}
