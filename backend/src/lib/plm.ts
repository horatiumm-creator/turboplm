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
 */
export function resolveDisplayRevision<T extends Pick<PartRevision, 'id' | 'lifecycle'>>(
  revisions: T[]
): T | null {
  if (revisions.length === 0) return null;
  const released = revisions.filter((r) => r.lifecycle === Lifecycle.RELEASED);
  const pool = released.length > 0 ? released : revisions;
  return pool.reduce((best, r) => (r.id > best.id ? r : best));
}
