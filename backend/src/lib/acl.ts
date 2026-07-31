import { AclPermission } from '@prisma/client';
import { prisma } from './prisma';
import { HttpError } from './errors';

/**
 * Item-level access control — the single enforcement point (rule X2).
 *
 * Every read path funnels through one of the exports below; no route re-implements the rules.
 * Three invariants make the model safe, and each one is load-bearing:
 *
 *  1. **Opt-in.** An item with no acl rows is governed by the role rules alone, exactly as it
 *     was before this feature existed. Only the first grant restricts anything, which is why
 *     deploying against a populated database changes nobody's access.
 *  2. **A global ADMIN always passes**, read and write. Grants are item-level and users will
 *     lock themselves out of items; without an unconditional admin path there is no recovery.
 *  3. **WRITE implies READ.** The read filter matches any grant regardless of permission, so a
 *     principal given WRITE never needs a redundant READ row.
 *
 * Unreadable is always **404**, never 403 — a 403 confirms the item exists, which is the leak
 * the feature exists to prevent. 403 is reserved for "you can see it but may not change it",
 * which by definition tells the caller nothing they did not already know.
 */

/** The five protected types. Mirrors the `AclEntityType` enum. */
export type AclType = 'PART' | 'DOCUMENT' | 'ECN' | 'PROJECT' | 'BUILD_UNIT';

/**
 * The caller as far as access control is concerned. Deliberately narrower than `AuthUser` so a
 * route can pass `req.user` straight in and a background job can pass a two-field literal.
 */
export interface AclUser {
  id: number;
  role: string;
}

/**
 * The redacted stand-in for a traversal node the caller cannot see (rule X4). Frozen because
 * every applier spreads this one shared object into its own node; a mutation here would
 * corrupt every redaction in the process.
 */
export const REDACTED: { redacted: true; id: null; partNumber: 'Restricted'; name: 'Restricted' } =
  Object.freeze({
    redacted: true,
    id: null,
    partNumber: 'Restricted',
    name: 'Restricted',
  } as const);

/**
 * 404 text is copied from what the routes already say for a genuinely missing item, so a
 * hidden item is indistinguishable from a deleted one.
 */
const NOT_FOUND: Record<AclType, string> = {
  PART: 'Part not found',
  DOCUMENT: 'Document not found',
  ECN: 'ECN not found',
  PROJECT: 'Project not found',
  BUILD_UNIT: 'Build unit not found',
};

/** Noun for the 403 text rule X2 mandates: `You do not have write access to this <type>`. */
const NOUN: Record<AclType, string> = {
  PART: 'part',
  DOCUMENT: 'document',
  ECN: 'ECN',
  PROJECT: 'project',
  BUILD_UNIT: 'build unit',
};

/**
 * The worst failure mode of this module is returning "no restriction" by accident, so an
 * unrecognised type is a hard error rather than a filter that matches everything. A typo in a
 * caller's mapping must fail loudly at the first request, not leak silently forever.
 */
function checkType(type: AclType): void {
  if (!Object.prototype.hasOwnProperty.call(NOUN, type)) {
    throw new HttpError(500, `Unknown ACL entity type: ${String(type)}`);
  }
}

function isAdmin(user: AclUser): boolean {
  return user.role === 'ADMIN';
}

/**
 * Matches an acl row that names this user, directly or through one of their groups.
 *
 * Group membership is resolved *inside* the filter as a nested relation condition, never by
 * pre-loading the user's group ids: a filter that needs a prior query cannot be dropped into
 * an arbitrary `where` safely, and a stale id list is a leak with a long half-life.
 *
 * `active: false` groups grant nothing. Deactivating a group is the only reason the flag
 * exists, and this is the fail-closed reading — an admin can always reactivate it, whereas
 * access wrongly kept alive is invisible until it is abused.
 */
function principalMatch(user: AclUser): object {
  return {
    OR: [{ userId: user.id }, { group: { active: true, members: { some: { userId: user.id } } } }],
  };
}

/**
 * A Prisma `where` fragment restricting a query to what this user may read. Spread it into any
 * `where` on an ACL-bearing model: `where: { status: 'ACTIVE', ...aclFilter('PART', user) }`.
 *
 * ADMIN gets `{}` — a true absence of restriction rather than a filter that happens to match
 * every row. The planner sees the untouched query and a reader sees no dead condition.
 *
 * For everyone else the shape is rule X2's, wrapped in a single-element `AND`:
 *
 *   { AND: [ { OR: [ { acls: { none: {} } },
 *                    { acls: { some: { OR: [ { userId: 7 },
 *                                            { group: { active: true,
 *                                                       members: { some: { userId: 7 } } } }
 *                                          ] } } } ] } ] }
 *
 * The `AND` wrapper is not decoration and must not be flattened. Callers apply this by object
 * spread, and a bare top-level `OR` would collide with the `OR` half these queries already
 * carry — `where: { OR: [{ partNumber: q }, { name: q }], ...aclFilter(…) }` in search is the
 * exact case. One of the two keys wins silently, and in one spread order the survivor is the
 * search term and the ACL is gone: a leak produced by nothing more than key order. Under `AND`
 * the fragment composes with any caller `OR`, and it may equally be dropped into an existing
 * `AND` array as an element. The one shape that still breaks is spreading it into a `where`
 * that already has its own top-level `AND` — see "Applying the filter" below.
 *
 * Prisma 5.22 emits this (verified against the running schema, not guessed — Part shown, user 7;
 * the other four are character-for-character identical modulo the table and FK names, because
 * every protected model names the relation `acls`, which is what makes the fragment
 * type-agnostic by construction):
 *
 *   WHERE (
 *      ("Part"."id") NOT IN (SELECT t1."partId" FROM "PartAcl" t1
 *                            WHERE (1=1 AND t1."partId" IS NOT NULL))
 *      OR ("Part"."id") IN (
 *           SELECT t2."partId" FROM "PartAcl" t2
 *           LEFT JOIN "AccessGroup" j3 ON (j3."id") = (t2."groupId")
 *           WHERE ((t2."userId" = 7
 *                   OR (j3."active" = true
 *                       AND (j3."id") IN (SELECT t4."groupId" FROM "AccessGroupMember" t4
 *                                         WHERE (t4."userId" = 7 AND t4."groupId" IS NOT NULL))
 *                       AND (j3."id" IS NOT NULL)))
 *                  AND t2."partId" IS NOT NULL))
 *   )
 *
 * Why it cannot match an item the user has no grant on:
 *
 *  - Both branches compare *this row's* id against a `partId` projected from `PartAcl`, so
 *    another item's grants are never consulted. The only join is the acl row's own group; there
 *    is no path by which another item's row could widen the match.
 *  - Branch 1 is the opt-in escape hatch, true only when the acl table holds no row at all for
 *    this item. It is the exact complement of "some row exists", and branch 2's row set is a
 *    subset of that "some" — so the two branches cannot both be true, and an item that has any
 *    grant can only pass through branch 2. Opt-in is therefore not a hole in the filter: it is
 *    the disjoint other half of it.
 *  - Branch 2 needs one row to satisfy the whole conjunction: either `userId` equals this user,
 *    or the row's group is active AND has a membership row for this user. Both halves are
 *    `NULL`-safe in the fail-closed direction. For a group row `t2."userId" = 7` is `NULL`, not
 *    true. For a user row the `LEFT JOIN` finds no group, so `j3."active" = true` is `NULL` and
 *    the explicit `j3."id" IS NOT NULL` guard is false. A malformed row with both columns `NULL`
 *    (the routes forbid it) matches nobody while still making the item restricted — it denies,
 *    it never grants. An inactive group is denied by `j3."active" = true`.
 *  - `NOT IN` is safe here only because `partId` is `NOT NULL` and Prisma still guards the
 *    subquery with `IS NOT NULL`. A nullable projection would make `NOT IN` evaluate to `NULL`
 *    for every row and hide *everything* — which is the reason this must stay a relation filter
 *    Prisma generates rather than a hand-rolled subquery someone maintains by eye.
 *  - Cost: both branches are index lookups on the acl table's FK (`@@unique([partId, groupId])`
 *    leads with `partId`), and the membership hop hits `AccessGroupMember`'s `userId` index. The
 *    acl tables stay small — a row exists only where someone deliberately restricted an item.
 */
export function aclFilter(type: AclType, user: AclUser): object {
  checkType(type);
  if (isAdmin(user)) return {};
  return { AND: [{ OR: [{ acls: { none: {} } }, { acls: { some: principalMatch(user) } }] }] };
}

// ---------------------------------------------------------------------------
// Applying the filter — the rules a caller must not break
//
//  - Spread it, never merge it by key. `{ ...other, ...aclFilter(t, u) }` is only safe while
//    `other` has no top-level `AND`. If it does, nest instead: `{ AND: [{ ...other },
//    aclFilter(t, u)] }`. A dropped `AND` is silent, and it is a leak.
//  - Filter the model that owns the acl rows. Reaching a part through a BOM line means the
//    filter belongs on the relation — `where: { child: { ...aclFilter('PART', user) } }` — not
//    on the line. Filtering the wrong model quietly filters nothing.
//  - `include` / `select` bypass it. A nested read is a separate query with its own `where`, so
//    an unfiltered `include` of parts on a visible project returns restricted parts. Every
//    nested read of a protected type needs its own filter, or `visibleIds` + `REDACTED`.
//  - `count`, `aggregate` and `groupBy` need it too. A total computed over invisible rows leaks
//    their existence, which is why rule X4 asks for an explicit `redactedCount` instead.
//  - `findUnique` cannot take it (it accepts unique fields only). Use `findFirst` with the
//    filter, or call `assertCanRead` before the `findUnique`.
// ---------------------------------------------------------------------------

/**
 * Same shape as `aclFilter`, narrowed to grants that carry WRITE. Not exported: writes go
 * through `assertCanWrite`, which gets the 404-before-403 ordering right. An exported write
 * filter would invite a route to check write access without first checking read access, and
 * that route would answer 403 on an item the caller may not know exists.
 */
function writeFilter(user: AclUser): object {
  if (isAdmin(user)) return {};
  return {
    AND: [
      {
        OR: [
          { acls: { none: {} } },
          // `permission` and the principal condition sit in the same `some` object, so they
          // must hold on ONE row: a READ row naming this user plus a WRITE row naming someone
          // else does not add up to write access. The generated enum rather than a bare string,
          // so a typo here is a compile error instead of a query that matches nothing.
          { acls: { some: { permission: AclPermission.WRITE, ...principalMatch(user) } } },
        ],
      },
    ],
  };
}

/**
 * The `findFirst` / `findMany` surface this module needs, identical across the five models.
 * Prisma's generated argument types are model-specific, so a union of the five delegates
 * collapses their call signatures to `never`; one cast per delegate at the single point where
 * the type is chosen is the cheapest honest way to express "any of the five".
 */
interface AclEntityDelegate {
  findFirst(args: { where: object; select: { id: true } }): Promise<{ id: number } | null>;
  findMany(args: { where: object; select: { id: true } }): Promise<{ id: number }[]>;
}

function delegateFor(type: AclType): AclEntityDelegate {
  switch (type) {
    case 'PART':
      return prisma.part as unknown as AclEntityDelegate;
    case 'DOCUMENT':
      return prisma.document as unknown as AclEntityDelegate;
    case 'ECN':
      return prisma.ecn as unknown as AclEntityDelegate;
    case 'PROJECT':
      return prisma.project as unknown as AclEntityDelegate;
    case 'BUILD_UNIT':
      return prisma.buildUnit as unknown as AclEntityDelegate;
  }
  throw new HttpError(500, `Unknown ACL entity type: ${String(type)}`);
}

/**
 * Throws 404 unless this user may read the item — including when the item does not exist,
 * which is the point: the two cases must be indistinguishable from outside.
 *
 * Call this **before** any other validation in a route (rule X3). A 400 about a malformed body
 * or a 409 about a lifecycle state, raised ahead of the access check, already tells the caller
 * the item exists and hints at its contents.
 *
 * For an ADMIN the filter is empty, so this degenerates to an existence check. That is
 * deliberate rather than a short-circuit: a missing id then 404s for every role, and a route
 * that trusts this call cannot blow up on a `null` for an admin alone.
 */
export async function assertCanRead(type: AclType, id: number, user: AclUser): Promise<void> {
  const found = await delegateFor(type).findFirst({
    where: { id, ...aclFilter(type, user) },
    select: { id: true },
  });
  if (!found) throw new HttpError(404, NOT_FOUND[type]);
}

/**
 * Throws 404 when the item is unreadable (or absent), 403 when it is readable but the caller
 * holds no WRITE grant. The read check runs first and unconditionally, so the 403 can only
 * ever be seen by someone who already knows the item exists.
 *
 * This is orthogonal to role RBAC: it answers "may this principal write *this item*", not "may
 * this role write at all". Keep the existing `requireEngineer`-style middleware in place — a
 * VIEWER with a WRITE grant must still be refused by the role rules.
 */
export async function assertCanWrite(type: AclType, id: number, user: AclUser): Promise<void> {
  await assertCanRead(type, id, user);
  if (isAdmin(user)) return;
  const writable = await delegateFor(type).findFirst({
    where: { id, ...writeFilter(user) },
    select: { id: true },
  });
  if (!writable) {
    throw new HttpError(403, `You do not have write access to this ${NOUN[type]}`);
  }
}

/**
 * The visible subset of a set of ids, in one query — the primitive behind redacted traversals
 * (rule X4). A BOM, genealogy or where-used walk collects its ids, asks once, and swaps
 * `REDACTED` in for everything the set does not contain. Never call `assertCanRead` in a loop
 * for this: that is N queries and it throws where a traversal must degrade instead.
 *
 * An id that does not exist is reported as not visible, which keeps the fail-closed direction
 * for the caller. (An ADMIN gets the input back unfiltered, existence included — with no
 * restriction to apply there is nothing to ask the database.)
 *
 * One `IN` list, so this is sized for a traversal (hundreds to a few thousand ids), not for
 * paging a whole table. Past Postgres' bind-parameter ceiling it fails loudly rather than
 * quietly returning less — but chunk the walk before you get there.
 */
export async function visibleIds(
  type: AclType,
  ids: number[],
  user: AclUser
): Promise<Set<number>> {
  checkType(type);
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  // Admins see every item, so the query would only ever return its own input.
  if (isAdmin(user)) return new Set(unique);
  const rows = await delegateFor(type).findMany({
    where: { id: { in: unique }, ...aclFilter(type, user) },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * True when the item carries at least one grant, i.e. is restricted at all. Role-independent
 * on purpose: this reports the item's state, not what a particular caller may do, and it is
 * what the UI needs to warn before the **first** grant turns an open item into a closed one.
 */
export async function isRestricted(type: AclType, id: number): Promise<boolean> {
  const found = await delegateFor(type).findFirst({
    where: { id, acls: { some: {} } },
    select: { id: true },
  });
  return found !== null;
}
