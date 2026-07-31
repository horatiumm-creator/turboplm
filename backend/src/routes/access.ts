/**
 * Access-group administration and per-item grant management — rule X6.
 *
 * The only write path into the five ACL tables. Enforcement itself lives in `lib/acl.ts` and is
 * imported, never re-derived here: "may this caller manage this item's grants" is answered by the
 * same `assertCanWrite` every other route uses, so the screen that lists the grants and the
 * endpoint that changes them cannot drift apart. A second opinion about write access in this file
 * would eventually disagree with the first, and the disagreement that matters is the permissive
 * one.
 *
 * Two asymmetries in the model drive most of what follows:
 *
 *  - Adding the FIRST grant is the only operation that restricts an item (rule X1 is opt-in), and
 *    removing the LAST one un-restricts it — access widens back to the role rules with no other
 *    outward sign. Both transitions are reported through `ItemAccess.restricted`.
 *  - A group's grants outlive the group only if the group survives: the acl rows' group FK is
 *    `onDelete: Cascade`, so deleting a group deletes every grant it holds and widens access on
 *    every item at once, silently. The database will not stop that, which is why the 409 delete
 *    guard below counts grants across all five tables and is the only thing standing there.
 */
import { Request, Router } from 'express';
import { AclPermission } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { AclType, assertCanRead, assertCanWrite, isRestricted } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface AccessGroupSummaryDto {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  memberCount: number;
  /** Total grants this group holds across all five types — the delete guard. */
  grantCount: number;
  createdAt: string;
}

interface AccessGroupDetailDto extends AccessGroupSummaryDto {
  members: { id: number; user: UserRefDto; addedAt: string }[];
}

interface ItemGrantDto {
  /** Composite: the table tag and the row id in one number — see `encodeGrantId`. */
  id: number;
  /** Exactly one of group / user is set. */
  group: { id: number; name: string } | null;
  user: UserRefDto | null;
  permission: AclPermission;
  grantedBy: UserRefDto;
  grantedAt: string;
}

interface ItemAccessDto {
  /** `AclType` is structurally the frozen `AclEntityType`; acl.ts owns the canonical union. */
  entityType: AclType;
  entityId: number;
  /**
   * False when the item has no grants at all — it is then visible to everyone the role rules
   * already allow (rule X1, opt-in). The UI warns before the FIRST grant, because adding one
   * restricts the item to that list.
   */
  restricted: boolean;
  grants: ItemGrantDto[];
  /** Whether the caller may change these grants: WRITE on the item, or global ADMIN. */
  canManage: boolean;
}

// ---------------------------------------------------------------------------
// The five ACL tables
// ---------------------------------------------------------------------------

/**
 * The `findMany` / `create` / `delete` surface this file needs, identical across the five acl
 * models. Prisma's generated argument types are model-specific, so a union of the five delegates
 * collapses their call signatures to `never`; one cast per delegate at the single point where the
 * table is chosen is the cheapest honest way to say "any of the five" — the same trade `lib/acl.ts`
 * makes for its own delegate lookup.
 */
interface AclRowDelegate {
  findMany(args: { where: object; select: object; orderBy?: object }): Promise<GrantRow[]>;
  findFirst(args: { where: object; select: object }): Promise<Record<string, unknown> | null>;
  create(args: { data: object; select: { id: true } }): Promise<{ id: number }>;
  delete(args: { where: { id: number } }): Promise<unknown>;
}

/** One acl row with everything `ItemGrant` needs. */
interface GrantRow {
  id: number;
  permission: AclPermission;
  grantedAt: Date;
  group: { id: number; name: string } | null;
  user: { id: number; name: string } | null;
  grantedBy: { id: number; name: string };
}

type GroupAclRelation = 'partAcls' | 'documentAcls' | 'ecnAcls' | 'projectAcls' | 'buildUnitAcls';

interface AclTable {
  /** URL segment in `/:entityType/:id/access`. */
  segment: string;
  /** Owning FK column on the acl row — which item the grant is about. */
  fk: 'partId' | 'documentId' | 'ecnId' | 'projectId' | 'buildUnitId';
  /** The `AccessGroup` relation this table appears as, for the delete guard's count. */
  groupRelation: GroupAclRelation;
  /**
   * Leading digit of the composite grant id. Frozen once shipped: renumbering would repoint every
   * id a client already holds at a different table's row.
   */
  tag: number;
  /** For message text only. The 404/403 wording enforcement uses lives in `lib/acl.ts`. */
  noun: string;
  delegate: AclRowDelegate;
}

/**
 * The single place a URL segment, an acl table, a group relation and a grant-id tag line up.
 * Everything per-type in this file reads from here, so a sixth protected type is one entry rather
 * than a sixth branch in five switch statements — and a forgotten branch in a permission file is
 * how an item ends up unguarded.
 */
const TABLES: Record<AclType, AclTable> = {
  PART: {
    segment: 'parts',
    fk: 'partId',
    groupRelation: 'partAcls',
    tag: 1,
    noun: 'part',
    delegate: prisma.partAcl as unknown as AclRowDelegate,
  },
  DOCUMENT: {
    segment: 'documents',
    fk: 'documentId',
    groupRelation: 'documentAcls',
    tag: 2,
    noun: 'document',
    delegate: prisma.documentAcl as unknown as AclRowDelegate,
  },
  ECN: {
    segment: 'ecns',
    fk: 'ecnId',
    groupRelation: 'ecnAcls',
    tag: 3,
    noun: 'ECN',
    delegate: prisma.ecnAcl as unknown as AclRowDelegate,
  },
  PROJECT: {
    segment: 'projects',
    fk: 'projectId',
    groupRelation: 'projectAcls',
    tag: 4,
    noun: 'project',
    delegate: prisma.projectAcl as unknown as AclRowDelegate,
  },
  BUILD_UNIT: {
    segment: 'build-units',
    fk: 'buildUnitId',
    groupRelation: 'buildUnitAcls',
    tag: 5,
    noun: 'build unit',
    delegate: prisma.buildUnitAcl as unknown as AclRowDelegate,
  },
};

const ACL_TYPES = Object.keys(TABLES) as AclType[];

const TYPE_BY_SEGMENT = new Map<string, AclType>(ACL_TYPES.map((t) => [TABLES[t].segment, t]));
const TYPE_BY_TAG = new Map<number, AclType>(ACL_TYPES.map((t) => [TABLES[t].tag, t]));

/** Same text for a grant that never existed and a grant on an item the caller cannot see. */
const GRANT_NOT_FOUND = 'Item grant not found';

function tableForSegment(segment: string): { type: AclType; table: AclTable } {
  const type = TYPE_BY_SEGMENT.get(segment);
  if (!type) {
    throw new HttpError(404, `Access control is not available for "${segment}"`);
  }
  return { type, table: TABLES[type] };
}

// ---------------------------------------------------------------------------
// Composite grant ids
//
// Row ids are ambiguous across the five tables — `PartAcl` row 3 and `EcnAcl` row 3 are both "3"
// — so `DELETE /item-grants/3` cannot be resolved by probing the tables: several would answer, and
// deleting the wrong row widens access on an unrelated item. The id therefore carries its table:
//
//     tag * 1e8 + rowId     PartAcl 42 -> 100000042,  EcnAcl 42 -> 300000042
//
// Why an encoding rather than the more readable `PART:42`: the frozen wire contract types
// `ItemGrant.id` as a `number`, and returning a string from it would be a silent lie to every
// client. The prefixed form is the change proposed in the report, not one taken unilaterally here.
//
// Bounds: the largest encodable id is 5 * 1e8 + 99_999_999, comfortably inside int32, so it
// survives `idParam` and a Postgres `Int`. Past 1e8 rows in a single acl table the scheme would
// collide, so `encodeGrantId` throws instead of handing out an id that addresses someone else's
// grant. These tables hold a row only where somebody deliberately restricted an item; the ceiling
// is eight orders of magnitude away, and it fails loudly rather than quietly.
// ---------------------------------------------------------------------------

const GRANT_ID_SCALE = 100_000_000;

function encodeGrantId(type: AclType, rowId: number): number {
  if (!Number.isInteger(rowId) || rowId < 1 || rowId >= GRANT_ID_SCALE) {
    throw new HttpError(500, `Grant id ${rowId} is out of range for the composite id scheme`);
  }
  return TABLES[type].tag * GRANT_ID_SCALE + rowId;
}

function decodeGrantId(id: number): { type: AclType; rowId: number } {
  const type = TYPE_BY_TAG.get(Math.floor(id / GRANT_ID_SCALE));
  const rowId = id % GRANT_ID_SCALE;
  // An integer that decodes to no table addresses nothing, so it is a 404 and not a 400: the
  // caller learns exactly what they would learn from a grant that has already been removed.
  if (!type || rowId < 1) throw new HttpError(404, GRANT_NOT_FOUND);
  return { type, rowId };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Narrower than `AuthUser` on purpose: exactly what `lib/acl.ts` needs, plus the id to record. */
function actor(req: Request): { id: number; role: string } {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user;
}

/** Present-but-absent-valued and truly absent are different questions in a PATCH. */
function hasKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim().slice(0, max);
}

/** Explicit null clears the field; only a wrong type is an error. */
function optionalText(value: unknown, field: string, max = 1000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  return value.trim().slice(0, max) || null;
}

function requireId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return value;
}

/**
 * Required rather than defaulted to READ. The field decides how much access is handed out, and a
 * permission API that guesses at that is the wrong kind of helpful — the frozen contract types it
 * as required for the same reason.
 */
function requirePermission(value: unknown): AclPermission {
  if (typeof value !== 'string' || !(Object.values(AclPermission) as string[]).includes(value)) {
    throw new HttpError(400, 'permission must be one of READ, WRITE');
  }
  return value as AclPermission;
}

// ---------------------------------------------------------------------------
// Access groups
// ---------------------------------------------------------------------------

const groupCountSelect = {
  members: true,
  partAcls: true,
  documentAcls: true,
  ecnAcls: true,
  projectAcls: true,
  buildUnitAcls: true,
} as const;

const groupSelect = {
  id: true,
  name: true,
  description: true,
  active: true,
  createdAt: true,
  _count: { select: groupCountSelect },
} as const;

const groupDetailSelect = {
  ...groupSelect,
  members: {
    select: { id: true, addedAt: true, user: { select: { id: true, name: true } } },
    orderBy: { user: { name: 'asc' } },
  },
} as const;

interface GroupCountRow extends Record<GroupAclRelation, number> {
  members: number;
}

interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  _count: GroupCountRow;
}

interface GroupDetailRow extends GroupRow {
  members: { id: number; addedAt: Date; user: { id: number; name: string } }[];
}

/** Summed from the registry, so a new acl table cannot be left out of the delete guard. */
function grantCountOf(counts: GroupCountRow): number {
  return ACL_TYPES.reduce((total, type) => total + counts[TABLES[type].groupRelation], 0);
}

function toGroupSummary(row: GroupRow): AccessGroupSummaryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    memberCount: row._count.members,
    grantCount: grantCountOf(row._count),
    createdAt: row.createdAt.toISOString(),
  };
}

function toGroupDetail(row: GroupDetailRow): AccessGroupDetailDto {
  return {
    ...toGroupSummary(row),
    members: row.members.map((m) => ({
      id: m.id,
      user: { id: m.user.id, name: m.user.name },
      addedAt: m.addedAt.toISOString(),
    })),
  };
}

async function groupDetailOr404(id: number): Promise<AccessGroupDetailDto> {
  const group = await prisma.accessGroup.findUnique({ where: { id }, select: groupDetailSelect });
  if (!group) throw new HttpError(404, 'Access group not found');
  return toGroupDetail(group);
}

// GET /access-groups — every group with its member and grant counts (admin only).
router.get(
  '/access-groups',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const groups = await prisma.accessGroup.findMany({
      orderBy: { name: 'asc' },
      select: groupSelect,
    });
    res.json(groups.map(toGroupSummary));
  })
);

// POST /access-groups — create an empty group. Creating one grants nobody anything; only a
// grant on an item does, so this is deliberately unguarded beyond the admin check.
router.post(
  '/access-groups',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const me = actor(req);
    const body = bodyOf(req);
    const name = requireText(body.name, 'name', 100);
    const description = optionalText(body.description, 'description');
    // Pre-checked so the response names the group, rather than errorMiddleware's generic P2002
    // text. A concurrent create still lands there, which is the correct 409 either way.
    const clash = await prisma.accessGroup.findUnique({ where: { name }, select: { id: true } });
    if (clash) throw new HttpError(409, `An access group named "${name}" already exists`);
    const group = await prisma.accessGroup.create({
      data: { name, description, createdById: me.id },
      select: groupDetailSelect,
    });
    res.status(201).json(toGroupDetail(group));
  })
);

// GET /access-groups/:id — the group with its members.
router.get(
  '/access-groups/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await groupDetailOr404(idParam(req.params.id)));
  })
);

// PATCH /access-groups/:id — rename, re-describe, or activate/deactivate.
router.patch(
  '/access-groups/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const body = bodyOf(req);
    const existing = await prisma.accessGroup.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Access group not found');

    const data: { name?: string; description?: string | null; active?: boolean } = {};
    if (hasKey(body, 'name')) {
      const name = requireText(body.name, 'name', 100);
      const clash = await prisma.accessGroup.findFirst({
        where: { name, NOT: { id } },
        select: { id: true },
      });
      if (clash) throw new HttpError(409, `An access group named "${name}" already exists`);
      data.name = name;
    }
    if (hasKey(body, 'description')) {
      data.description = optionalText(body.description, 'description');
    }
    if (hasKey(body, 'active')) {
      if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
      // Deactivating is the group-wide kill switch: `lib/acl.ts` matches only active groups, so
      // every grant this group holds stops applying at once. It needs no 409 guard because it is
      // reversible and fail-closed — unlike deleting the group, which destroys the grants.
      data.active = body.active;
    }
    // An empty body updates nothing and returns the group unchanged. Rejecting it would mean
    // rejecting a request whose every field is legitimately absent.
    const group = await prisma.accessGroup.update({ where: { id }, data, select: groupDetailSelect });
    res.json(toGroupDetail(group));
  })
);

// DELETE /access-groups/:id — refused while the group holds any grant.
router.delete(
  '/access-groups/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const group = await prisma.accessGroup.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: groupCountSelect } },
    });
    if (!group) throw new HttpError(404, 'Access group not found');
    const grants = grantCountOf(group._count);
    if (grants > 0) {
      // The acl rows' group FK cascades, so the database would delete them without complaint and
      // every item the group appears on would quietly widen. This count is the whole guard.
      // (It races with a grant added in the same instant; the window is one admin action wide and
      // an admin can restore the grant, so it is left as a check rather than a row lock.)
      throw new HttpError(
        409,
        `"${group.name}" still holds ${grants} item grant${grants === 1 ? '' : 's'} — remove ` +
          `${grants === 1 ? 'it' : 'them'} first, or deleting the group would widen access on ` +
          `every item it appears on`
      );
    }
    // Memberships cascade with the group. They grant nothing on their own, so nothing widens.
    await prisma.accessGroup.delete({ where: { id } });
    res.status(204).end();
  })
);

// POST /access-groups/:id/members — add a user. Returns the whole group so the caller's member
// list and counts cannot drift from the server's.
router.post(
  '/access-groups/:id/members',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const groupId = idParam(req.params.id);
    const userId = requireId(bodyOf(req).userId, 'userId');
    const group = await prisma.accessGroup.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw new HttpError(404, 'Access group not found');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!user) throw new HttpError(404, 'User not found');
    const already = await prisma.accessGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { id: true },
    });
    if (already) throw new HttpError(409, `${user.name} is already a member of this group`);
    await prisma.accessGroupMember.create({ data: { groupId, userId } });
    res.status(201).json(await groupDetailOr404(groupId));
  })
);

// DELETE /access-group-members/:id — revokes this user's access on every item granted to the
// group. No guard: that is precisely what was asked for, and re-adding them restores it.
router.delete(
  '/access-group-members/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const member = await prisma.accessGroupMember.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!member) throw new HttpError(404, 'Group membership not found');
    await prisma.accessGroupMember.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Per-item grants
// ---------------------------------------------------------------------------

const grantSelect = {
  id: true,
  permission: true,
  grantedAt: true,
  group: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
  grantedBy: { select: { id: true, name: true } },
} as const;

function toGrant(type: AclType, row: GrantRow): ItemGrantDto {
  return {
    id: encodeGrantId(type, row.id),
    group: row.group ? { id: row.group.id, name: row.group.name } : null,
    user: row.user ? { id: row.user.id, name: row.user.name } : null,
    permission: row.permission,
    grantedBy: { id: row.grantedBy.id, name: row.grantedBy.name },
    grantedAt: row.grantedAt.toISOString(),
  };
}

/**
 * "WRITE on the item, or global ADMIN", answered by the same `assertCanWrite` the mutating
 * endpoints call. Reading it out of the exception is less pretty than a second query would be, and
 * that is the point: a separate write-permission predicate in this file could disagree with the
 * enforcement one, and a UI that offers a button the API refuses is the friendly half of that bug.
 *
 * The role gate mirrors `requireWriteRole`, which rejects every VIEWER mutation app-wide before a
 * grant is ever consulted. Without it a VIEWER holding a WRITE grant would be told they may manage
 * access and then be refused by the middleware. An allow-list rather than a `!== 'VIEWER'` test, so
 * a role added later starts out unable to reshare items instead of able to.
 */
async function canManageItem(
  type: AclType,
  id: number,
  user: { id: number; role: string }
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'ENGINEER') return false;
  try {
    await assertCanWrite(type, id, user);
    return true;
  } catch (err) {
    // 403 is read-only access, 404 is unreadable (unreachable here — the caller has already
    // passed the read check — but swallowing it stays fail-closed rather than 500ing).
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

/**
 * The `ItemAccess` payload. `restricted` comes from `isRestricted` rather than from
 * `grants.length > 0`: the flag must mean what the enforcement module means by restricted — "an
 * acl row exists for this item", the exact complement of `aclFilter`'s opt-in branch — and not
 * whatever this route happened to select. The day someone filters this list (grants whose user was
 * deactivated, say) the derived version would start reporting an item as open while the filter
 * still closes it. Both queries run in parallel, so the guarantee is free.
 */
async function itemAccess(
  type: AclType,
  id: number,
  user: { id: number; role: string }
): Promise<ItemAccessDto> {
  const table = TABLES[type];
  const [rows, restricted, canManage] = await Promise.all([
    table.delegate.findMany({
      where: { [table.fk]: id },
      select: grantSelect,
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    }),
    isRestricted(type, id),
    canManageItem(type, id, user),
  ]);
  return {
    entityType: type,
    entityId: id,
    restricted,
    grants: rows.map((row) => toGrant(type, row)),
    canManage,
  };
}

// GET /:entityType/:id/access — who can see this item.
router.get(
  '/:entityType/:id/access',
  asyncHandler(async (req, res) => {
    const me = actor(req);
    const { type } = tableForSegment(req.params.entityType);
    const id = idParam(req.params.id);
    // Listing who can read an item is a read of the item. Without this an outsider could ask a
    // restricted item for its access list and learn both that it exists and who works on it.
    await assertCanRead(type, id, me);
    res.json(await itemAccess(type, id, me));
  })
);

// POST /:entityType/:id/access — grant a group or a user READ or WRITE on this item.
router.post(
  '/:entityType/:id/access',
  asyncHandler(async (req, res) => {
    const me = actor(req);
    const { type, table } = tableForSegment(req.params.entityType);
    const id = idParam(req.params.id);
    // Before any body validation (rule X3): a 400 about the payload, raised first, already
    // confirms the item exists. `assertCanWrite` is the entire "WRITE on the item, or ADMIN" rule
    // — 404 when the item is invisible, 403 when it is read-only, and an admin passes outright.
    await assertCanWrite(type, id, me);

    const body = bodyOf(req);
    const wantsGroup = body.groupId !== undefined && body.groupId !== null;
    const wantsUser = body.userId !== undefined && body.userId !== null;
    // Both would be a row that matches two principals and satisfies neither unique constraint;
    // neither would be a row that restricts the item and grants nobody. Both are 400.
    if (wantsGroup === wantsUser) {
      throw new HttpError(400, 'Provide exactly one of groupId or userId');
    }
    const permission = requirePermission(body.permission);

    let principal: { groupId: number } | { userId: number };
    let principalLabel: string;
    if (wantsGroup) {
      const groupId = requireId(body.groupId, 'groupId');
      const group = await prisma.accessGroup.findUnique({
        where: { id: groupId },
        select: { id: true, name: true, active: true },
      });
      if (!group) throw new HttpError(404, 'Access group not found');
      // An inactive group is accepted: `lib/acl.ts` ignores it, so the grant restricts the item
      // without granting anyone — fail-closed, and reactivating the group makes it live. The UI has
      // `active` on every group and should warn there rather than have this route invent a 409 the
      // contract does not describe.
      principal = { groupId };
      principalLabel = `Group "${group.name}"`;
    } else {
      const userId = requireId(body.userId, 'userId');
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });
      if (!user) throw new HttpError(404, 'User not found');
      principal = { userId };
      principalLabel = user.name;
    }

    const duplicate = await table.delegate.findFirst({
      where: { [table.fk]: id, ...principal },
      select: { id: true, permission: true },
    });
    if (duplicate) {
      // One row per principal per item: a second row would make the effective permission depend
      // on which one a reader noticed. Changing a permission is therefore delete-then-grant.
      throw new HttpError(
        409,
        `${principalLabel} already has ${String(duplicate.permission)} access to this ` +
          `${table.noun} — remove that grant before adding a different one`
      );
    }

    await table.delegate.create({
      data: { [table.fk]: id, ...principal, permission, grantedById: me.id },
      select: { id: true },
    });
    // When this was the first grant the response comes back `restricted: true` — the transition
    // the UI warns about, confirmed rather than assumed by the client.
    res.status(201).json(await itemAccess(type, id, me));
  })
);

// DELETE /item-grants/:id — remove one grant, addressed by its composite id (see above).
router.delete(
  '/item-grants/:id',
  asyncHandler(async (req, res) => {
    const me = actor(req);
    const { type, rowId } = decodeGrantId(idParam(req.params.id, 'grant id'));
    const table = TABLES[type];
    // The row is read first only to learn which item it belongs to; nothing about it is returned.
    const row = await table.delegate.findFirst({
      where: { id: rowId },
      select: { id: true, [table.fk]: true },
    });
    if (!row) throw new HttpError(404, GRANT_NOT_FOUND);
    const itemId = Number(row[table.fk]);

    try {
      await assertCanWrite(type, itemId, me);
    } catch (err) {
      // A grant on an item the caller cannot see must be indistinguishable from no such grant, so
      // the item's 404 is re-thrown as the grant's. The 403 passes through unchanged: it can only
      // reach someone who can already read the item.
      if (err instanceof HttpError && err.status === 404) throw new HttpError(404, GRANT_NOT_FOUND);
      throw err;
    }

    // Removing the last grant un-restricts the item: it returns to role-only access, which is
    // wider than it was a moment ago. 204 carries no body to say so, so a client that cares must
    // re-read `GET /<type>/:id/access` — where `restricted` is now false. See the report.
    await table.delegate.delete({ where: { id: rowId } });
    res.status(204).end();
  })
);

export default router;
