import { Request, Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam, positiveIntQuery } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclType, AclUser, REDACTED, assertCanRead, visibleIds } from '../lib/acl';
import { notifyUsers } from '../lib/notify';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// The five things people talk about
//
// Comment and Watch name their subject with five nullable foreign keys and a CHECK that
// exactly one is set (see prisma/migrations/a0_collaboration/migration.sql). Everything in
// this file therefore goes through this table rather than branching per endpoint: a kind
// added later gets a row here and nothing else changes.
//
// `aclType` is the load-bearing column. PART, ECN and PROJECT are ACL-bearing types with
// item-level grants, so reading them is gated by lib/acl.ts. ECR and REQUIREMENT are NOT in
// acl.ts's `AclType` and that is deliberate upstream (see CONTRACTS.md on /home: "do not
// invent one") — they are org-wide, so being in the organisation IS the grant and Postgres
// row-level security is the whole gate. `null` here means "org-wide", never "unchecked":
// a row belonging to another tenant is invisible to the query below and 404s like a deleted
// one.
// ---------------------------------------------------------------------------

type SubjectKind = 'part' | 'ecn' | 'ecr' | 'project' | 'requirement';

interface SubjectSpec {
  aclType: AclType | null;
  /**
   * Frontend route prefix. These are the prefixes routes/notifications.ts matches for rule
   * X5, so a link to an item the recipient later loses access to goes dead in the bell
   * rather than 404ing on click. A link shape invented here would silently skip that check.
   */
  route: string;
  /** Copied from what the owning router already says, so hidden is indistinguishable from gone. */
  notFound: string;
  /** Key in the grouped GET /watches payload. */
  group: keyof WatchListDto;
}

const SUBJECTS: Record<SubjectKind, SubjectSpec> = {
  part: { aclType: 'PART', route: '/parts/', notFound: 'Part not found', group: 'parts' },
  ecn: { aclType: 'ECN', route: '/ecns/', notFound: 'ECN not found', group: 'ecns' },
  ecr: { aclType: null, route: '/ecrs/', notFound: 'ECR not found', group: 'ecrs' },
  project: {
    aclType: 'PROJECT',
    route: '/projects/',
    notFound: 'Project not found',
    group: 'projects',
  },
  requirement: {
    aclType: null,
    route: '/requirements/',
    notFound: 'Requirement not found',
    group: 'requirements',
  },
};

const SUBJECT_KINDS = Object.keys(SUBJECTS) as SubjectKind[];

/**
 * The subject half of a Comment/Watch row. Spread into a `where` or a `data`, which is why
 * it is five optional keys and not a tagged union — Prisma reads `undefined` as absent.
 */
interface SubjectRef {
  partId?: number;
  ecnId?: number;
  ecrId?: number;
  projectId?: number;
  requirementId?: number;
}

function subjectRef(kind: SubjectKind, id: number): SubjectRef {
  switch (kind) {
    case 'part':
      return { partId: id };
    case 'ecn':
      return { ecnId: id };
    case 'ecr':
      return { ecrId: id };
    case 'project':
      return { projectId: id };
    case 'requirement':
      return { requirementId: id };
  }
}

/** The five nullable columns, as every row in this file selects them. */
interface SubjectColumns {
  partId: number | null;
  ecnId: number | null;
  ecrId: number | null;
  projectId: number | null;
  requirementId: number | null;
}

/**
 * Which object a stored row is about. The CHECK guarantees exactly one column is set, so the
 * fall-through is not a defensive branch for bad input — it is the alarm for a dropped
 * constraint, and it must be a 500 rather than a guess, because guessing would attach a
 * comment's access check to the wrong object.
 */
function subjectOf(row: SubjectColumns): { kind: SubjectKind; id: number } {
  if (row.partId !== null) return { kind: 'part', id: row.partId };
  if (row.ecnId !== null) return { kind: 'ecn', id: row.ecnId };
  if (row.ecrId !== null) return { kind: 'ecr', id: row.ecrId };
  if (row.projectId !== null) return { kind: 'project', id: row.projectId };
  if (row.requirementId !== null) return { kind: 'requirement', id: row.requirementId };
  throw new HttpError(500, 'This row names no subject — the one-subject CHECK is missing');
}

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface CommentAuthorDto {
  id: number;
  name: string;
  avatarUrl: string | null;
}

interface CommentMentionDto {
  userId: number;
  name: string;
}

interface CommentDto {
  id: number;
  /** null once withdrawn: the row survives for its replies, the text does not. */
  body: string | null;
  withdrawn: boolean;
  author: CommentAuthorDto;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  mentions: CommentMentionDto[];
  /** Author may edit their own; an ADMIN may delete anyone's. Neither applies to a tombstone. */
  canEdit: boolean;
  canDelete: boolean;
  /** Always empty on a reply — threads are one level deep. */
  replies: CommentDto[];
  /**
   * True when this comment has more replies than `replies` carries — ask for them with
   * `parentId=<this id>`. Stated per comment rather than only in `notes` because the UI has
   * to decide, for THIS comment, whether to offer "show more": a short reply list that is
   * silently short reads as a conversation that nobody answered.
   */
  moreReplies: boolean;
}

type UnresolvedReason = 'UNKNOWN' | 'AMBIGUOUS';

interface UnresolvedMentionDto {
  text: string;
  reason: UnresolvedReason;
}

/**
 * What a write returns: the comment, plus the @names it could NOT turn into a person.
 *
 * Reported rather than swallowed, and rather than refused. An unresolvable `@` is not an
 * error (people type `@` for other reasons), and an ambiguous one resolves to nobody — but
 * in both cases the author believes they have just notified somebody. The only moment they
 * can be told otherwise is in the response to their own write.
 */
interface CommentWriteResultDto extends CommentDto {
  unresolvedMentions: UnresolvedMentionDto[];
}

/**
 * One page of a thread. Deliberately not a bare array: a list that can be cut has to be able
 * to say so, and the cut is three different facts — there are more roots (`nextAfter`), this
 * root has more replies (`moreReplies`), and here is what that means in words (`notes`).
 * Named after `ActivityFeed` in lib/activity.ts, which pages the same table the same way.
 */
interface CommentPageDto {
  comments: CommentDto[];
  /** Pass as `after` to continue. Null when this page reaches the end of the level. */
  nextAfter: number | null;
  /** The page size actually used, after clamping. */
  limit: number;
  /** Everything this answer could not do completely, in words. Empty when it is complete. */
  notes: string[];
}

interface WatchedItemDto {
  id: number;
  label: string;
  link: string;
  /** True when the caller may no longer read it — see the note on GET /watches. */
  redacted: boolean;
}

interface WatchListDto {
  parts: WatchedItemDto[];
  ecns: WatchedItemDto[];
  ecrs: WatchedItemDto[];
  projects: WatchedItemDto[];
  requirements: WatchedItemDto[];
}

interface WatchStateDto {
  subject: SubjectKind;
  id: number;
  watching: boolean;
}

// ---------------------------------------------------------------------------
// Includes + mappers
//
// The page sizes live here rather than beside the route because the reply cap is baked into
// the include below, and an include whose bound and whose mapper disagreed would silently
// report "there are more replies" for a page that had them all.
// ---------------------------------------------------------------------------

/** Roots per page of a thread, and the ceiling a caller may ask for. */
const ROOT_PAGE_DEFAULT = 50;
const ROOT_PAGE_MAX = 200;

/**
 * Replies carried per root. Enough for the conversations the UI renders inline; past it the
 * client asks again with `parentId`, so one 4,000-reply root cannot decide the size of a page
 * of fifty of them.
 */
const REPLY_PAGE = 20;

const authorSelect = { id: true, name: true, avatarUrl: true } satisfies Prisma.UserSelect;

const mentionInclude = {
  orderBy: { id: 'asc' as const },
  include: { user: { select: { id: true, name: true } } },
};

/** A reply carries no replies of its own, which is the schema shape the UI renders. */
const replyInclude = {
  author: { select: authorSelect },
  mentions: mentionInclude,
} satisfies Prisma.CommentInclude;

/**
 * `take: REPLY_PAGE + 1` — one more than is returned, which is how the mapper below knows a
 * root has more replies than it is showing without counting them. Unbounded, this nested read
 * was the second half of the memory incident: a page of fifty roots pulled every reply, every
 * author and every mention row of all fifty.
 */
const commentInclude = {
  ...replyInclude,
  replies: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: REPLY_PAGE + 1,
    include: replyInclude,
  },
} satisfies Prisma.CommentInclude;

type CommentRow = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;
type ReplyRow = Prisma.CommentGetPayload<{ include: typeof replyInclude }>;

function toComment(row: CommentRow | ReplyRow, user: AclUser): CommentDto {
  const withdrawn = row.deletedAt !== null;
  const isAuthor = row.authorId === user.id;
  const loaded = 'replies' in row ? row.replies : [];
  return {
    id: row.id,
    body: withdrawn ? null : row.body,
    withdrawn,
    author: { id: row.author.id, name: row.author.name, avatarUrl: row.author.avatarUrl },
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    mentions: row.mentions.map((m) => ({ userId: m.userId, name: m.user.name })),
    // A withdrawn comment is not editable by its author and not deletable again: there is
    // nothing left to change, and offering the buttons would invite a resurrection.
    canEdit: !withdrawn && isAuthor,
    canDelete: !withdrawn && (isAuthor || user.role === Role.ADMIN),
    replies: loaded.slice(0, REPLY_PAGE).map((reply) => toComment(reply, user)),
    moreReplies: loaded.length > REPLY_PAGE,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** The largest value a Postgres `int4` primary key can hold. */
const MAX_INT4 = 2147483647;

const BODY_MAX = 10000;

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function actorName(req: Request): string {
  return req.user?.name ?? 'Someone';
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireSubjectKind(value: unknown): SubjectKind {
  if (typeof value !== 'string' || !SUBJECT_KINDS.includes(value as SubjectKind)) {
    throw new HttpError(400, `subject must be one of ${SUBJECT_KINDS.join(', ')}`);
  }
  return value as SubjectKind;
}

function requireIdField(value: unknown, label = 'id'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_INT4) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return value;
}

/**
 * Trimmed, 1..10000. Trimmed BEFORE the length check and stored trimmed, so "   " is an
 * empty comment rather than a three-character one, and the body that is searched, mentioned
 * and notified is the same string everywhere.
 */
function requireCommentBody(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'body is required');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new HttpError(400, 'body is required');
  if (trimmed.length > BODY_MAX) {
    throw new HttpError(400, `body must be at most ${BODY_MAX} characters`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// The access check, and it is the subject's — never the comment's
//
// Rule X3: a caller who may not read the object a comment hangs off gets 404, and gets it
// for the OBJECT. The comment is not the secret; the existence of the part, ECN or project
// is. So every handler below resolves its subject first, before it validates anything else
// and before it decides whether the caller is the author — a 400 or a 403 raised ahead of
// this would already confirm the item exists.
// ---------------------------------------------------------------------------

interface ResolvedSubject {
  kind: SubjectKind;
  id: number;
  /** Short human label for a notification title: "P-10001 Bracket", "ECN-10004 Hole size". */
  label: string;
  /** Frontend route for the notification link. */
  link: string;
}

/**
 * Existence and label in one query. Not folded into `assertCanRead`: that function is the
 * single enforcement point (lib/acl.ts) and it returns nothing, so the label is read
 * afterwards, with no item filter, precisely because the filtered check has already passed.
 */
async function subjectLabel(kind: SubjectKind, id: number): Promise<string | null> {
  switch (kind) {
    case 'part': {
      const row = await prisma.part.findFirst({
        where: { id },
        select: { partNumber: true, name: true },
      });
      return row === null ? null : `${row.partNumber} ${row.name}`;
    }
    case 'ecn': {
      const row = await prisma.ecn.findFirst({
        where: { id },
        select: { ecnNumber: true, title: true },
      });
      return row === null ? null : `${row.ecnNumber} ${row.title}`;
    }
    case 'ecr': {
      const row = await prisma.ecr.findFirst({
        where: { id },
        select: { ecrNumber: true, title: true },
      });
      return row === null ? null : `${row.ecrNumber} ${row.title}`;
    }
    case 'project': {
      const row = await prisma.project.findFirst({
        where: { id },
        select: { code: true, name: true },
      });
      return row === null ? null : `${row.code} ${row.name}`;
    }
    case 'requirement': {
      const row = await prisma.requirement.findFirst({
        where: { id },
        select: { reqNumber: true, title: true },
      });
      return row === null ? null : `${row.reqNumber} ${row.title}`;
    }
  }
}

async function resolveSubject(
  kind: SubjectKind,
  id: number,
  user: AclUser
): Promise<ResolvedSubject> {
  const spec = SUBJECTS[kind];
  // PART/ECN/PROJECT: item-level grants, 404 (never 403) when the caller has none.
  if (spec.aclType !== null) await assertCanRead(spec.aclType, id, user);
  // ECR/REQUIREMENT: org-wide, so the row simply has to exist in THIS tenant — which is
  // all this query can see.
  const label = await subjectLabel(kind, id);
  if (label === null) throw new HttpError(404, spec.notFound);
  return { kind, id, label, link: `${spec.route}${id}` };
}

/**
 * One grant on the subject, with the memberships of its group narrowed to the candidates.
 *
 * `userId` and `group` are both nullable because exactly one of them is set (see the ACL
 * models). A row with neither — which the ACL routes forbid — grants nobody and still makes
 * the item restricted, which is the fail-closed direction.
 */
interface SubjectGrant {
  userId: number | null;
  group: { active: boolean; members: { userId: number }[] } | null;
}

/**
 * The `findFirst` this needs, identical across the three ACL-bearing subjects. Same cast as
 * `delegateFor` in lib/acl.ts and for the same reason: Prisma's generated argument types are
 * model-specific, so a union of the delegates collapses their call signatures to `never`.
 */
interface GrantBearingDelegate {
  findFirst(args: {
    where: { id: number };
    select: object;
  }): Promise<{ acls: SubjectGrant[] } | null>;
}

function grantDelegate(aclType: AclType): GrantBearingDelegate {
  switch (aclType) {
    case 'PART':
      return prisma.part as unknown as GrantBearingDelegate;
    case 'ECN':
      return prisma.ecn as unknown as GrantBearingDelegate;
    case 'PROJECT':
      return prisma.project as unknown as GrantBearingDelegate;
    default:
      // No subject in this file is a document or a build unit. Returning "no grants" for an
      // unexpected type would read as "unrestricted" and notify everybody, so it is an alarm.
      throw new HttpError(500, `No collaboration subject is an ACL type of ${aclType}`);
  }
}

/**
 * Of these candidate recipients, the ones who may still read the subject.
 *
 * This is the one notification rule in this file that is a security property rather than a
 * courtesy: a follower whose access was revoked must stop hearing about the object, or the
 * activity feed becomes a side channel that reports every change to somebody who may no
 * longer open it.
 *
 * ONE QUERY FOR THE WHOLE SET, and the shape is why. The obvious spelling — `visibleIds` per
 * candidate inside a `Promise.all` — is one two-statement transaction per person through the
 * tenancy extension, so a part followed by 300 people opened 300 CONCURRENT transactions
 * against a pool of `cpus * 2 + 1`. At that size the overflow does not degrade, it fails: a
 * P2024 pool timeout, i.e. a 500 on a comment that should have been posted. So the question
 * is inverted. Instead of asking the parts table once per person, this reads the SUBJECT's
 * grants once and narrows each granted group's memberships to the candidates, which is the
 * information wanted and is constant in the number of recipients.
 *
 * The predicate it then evaluates is `aclFilter`'s, restated here because lib/acl.ts has no
 * set-of-users shape — `visibleIds` answers for a set of ITEMS and one user, which is the
 * other axis. Each clause below names the invariant it implements; `tests/collab.test.ts`
 * asserts this function and `visibleIds` agree over the whole matrix (unrestricted, direct
 * grant, active group, inactive group, no grant, admin), so the two cannot drift silently.
 *
 * Roles come from the caller's map rather than from a query: every candidate is either a
 * follower, a mentioned user or a parent author, and all three are read with their role
 * already. A candidate with no role in the map fails closed.
 *
 * The actor is never in this list: the caller's own access was proven by `resolveSubject`
 * before anything got this far.
 */
async function recipientsWhoCanRead(
  subject: ResolvedSubject,
  candidates: number[],
  roles: Map<number, string>
): Promise<number[]> {
  const aclType = SUBJECTS[subject.kind].aclType;
  // Org-wide subject: everyone in the tenant can read it, and every candidate is in the
  // tenant — RLS is what guarantees that, not a check here.
  if (aclType === null || candidates.length === 0) return candidates;

  const unique = [...new Set(candidates)];
  const row = await grantDelegate(aclType).findFirst({
    where: { id: subject.id },
    select: {
      acls: {
        select: {
          userId: true,
          // Memberships of OTHER people are not needed and a closed programme's group can be
          // large, so the nested read is narrowed to the people being told something.
          group: {
            select: {
              active: true,
              members: { where: { userId: { in: unique } }, select: { userId: true } },
            },
          },
        },
      },
    },
  });
  // Gone between `resolveSubject` and here, or hidden from this statement by RLS: nobody is
  // told about an object that is not there.
  if (row === null) return [];
  // Opt-in (lib/acl.ts invariant 1): an item with no grants at all is governed by the role
  // rules alone, exactly as it was before the ACL feature existed.
  if (row.acls.length === 0) return candidates;

  const granted = new Set<number>();
  for (const grant of row.acls) {
    // WRITE implies READ, so the permission is not consulted — any grant is a read grant.
    if (grant.userId !== null) granted.add(grant.userId);
    // An inactive group grants nothing: deactivating a group is the only reason the flag
    // exists, and access wrongly kept alive is invisible until it is abused.
    if (grant.group !== null && grant.group.active) {
      for (const member of grant.group.members) granted.add(member.userId);
    }
  }

  return candidates.filter((userId) => {
    const role = roles.get(userId);
    if (role === undefined) return false; // a recipient we hold no row for: fail closed
    // A global ADMIN passes every item-level grant (lib/acl.ts invariant 2).
    return role === Role.ADMIN || granted.has(userId);
  });
}

// ---------------------------------------------------------------------------
// @mentions
//
// THE RULE THIS IMPLEMENTS, stated once so the reader does not have to derive it:
//
//   * A mention starts at an `@` that begins the body or follows whitespace or an opening
//     bracket/quote. `ana@example.com` is therefore not a mention of anybody.
//   * The text after the `@` is matched against `User.name`, case-insensitively, with
//     internal whitespace collapsed. Names contain spaces, so the match spans up to as many
//     words as the longest name in the organisation (capped), and the LONGEST match wins:
//     with both "Ana" and "Ana Maria" on the books, "@Ana Maria" is Ana Maria.
//   * The longest match DECIDES. If it names two people it resolves to NOBODY — it does not
//     fall back to a shorter, unambiguous match, because that would silently notify a
//     different person from the one the author typed.
//   * Anything that matches no name is left as plain text and is not an error.
//
// Both failures are returned to the author (`unresolvedMentions`) rather than logged: they
// are the only signal that a notification they believe they sent does not exist.
//
// AN INDEX IS STILL BUILT, AND IT IS NO LONGER THE WHOLE USER TABLE. The index is what makes
// the two rules above decidable: a per-`@` `equals`/`insensitive` probe can decide neither
// "longest match wins" nor "ambiguity resolves to nobody", because both need the whole
// candidate set for one `@`. So the narrowing is by WHAT THIS BODY COULD POSSIBLY NAME rather
// than by giving up the index. Every span the scanner tries at one `@` starts with the same
// first word, and a name that matches any of those spans must contain that word — so the
// first words ARE the filter, and a body with no `@` in it reads no User rows at all. Before
// this, every comment write loaded every User row in the tenant, including the overwhelming
// majority that mention nobody and never consult the map.
// ---------------------------------------------------------------------------

/** No real name is longer than this many words, and an unbounded scan is a body-sized loop. */
const MENTION_MAX_WORDS = 6;

/** How far past an `@` to look for a name. Six words of a human name fit comfortably. */
const MENTION_SCAN_CHARS = 200;

const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/;

/**
 * How many distinct first words may go into the narrowing filter before it is cheaper to
 * read the tenant's users than to describe them.
 *
 * A 10,000-character body can hold thousands of `@`s, and an `OR` of thousands of `ILIKE`
 * terms is its own denial of service. Past this many the query reverts to the whole user
 * table — ONE query over a few hundred rows, which is what every write used to cost — so the
 * pathological body is bounded by the old behaviour rather than by a filter built from it.
 */
const MENTION_PROBE_MAX = 32;

interface NameIndex {
  /** Normalised name → every user with it. More than one entry IS the ambiguity. */
  byName: Map<string, number[]>;
  rolesById: Map<number, string>;
  maxWords: number;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One `@` in the body, with the words that follow it — the only places a name can be.
 *
 * Separated from the matching pass because the query that loads the index is built from it:
 * the scan needs the index and the index needs the body, so the body is read first.
 */
interface MentionSite {
  words: string[];
}

function mentionSites(body: string): MentionSite[] {
  // Built per call: a module-level /g regex carries `lastIndex` between requests, and one
  // mention would then be skipped depending on what the previous caller wrote.
  const starts = /(?:^|[\s([{<"'])@(?=[^\s@])/g;
  const sites: MentionSite[] = [];
  let match: RegExpExecArray | null;
  while ((match = starts.exec(body)) !== null) {
    const from = match.index + match[0].length;
    const words = body
      .slice(from, from + MENTION_SCAN_CHARS)
      .split(/\s+/)
      .filter((word) => word !== '')
      // Beyond the longest possible name those words can never be part of a match, and
      // carrying them would make the span loop body-sized rather than name-sized.
      .slice(0, MENTION_MAX_WORDS);
    if (words.length > 0) sites.push({ words });
  }
  return sites;
}

/**
 * The words any name in this body must contain, lower-cased and de-duplicated.
 *
 * `contains` rather than `startsWith`, because `normalizeName` exists to absorb stored names
 * with leading or doubled whitespace (" Ana  Maria") and a prefix match would quietly make
 * those people unmentionable — a narrowing must not change who can be named. Trailing
 * punctuation is stripped, which can only widen the filter: "@Ana," probes for "ana", and
 * both "Ana" and the literal "Ana," contain it.
 */
function mentionProbes(sites: MentionSite[]): string[] {
  const probes = new Set<string>();
  for (const site of sites) {
    const first = site.words[0].replace(TRAILING_PUNCTUATION, '').toLowerCase();
    if (first !== '') probes.add(first);
  }
  return [...probes];
}

const EMPTY_INDEX: NameIndex = { byName: new Map(), rolesById: new Map(), maxWords: 1 };

async function loadNameIndex(sites: MentionSite[]): Promise<NameIndex> {
  const probes = mentionProbes(sites);
  // No `@` that could name anybody: there is nothing to resolve, so nothing is read. This is
  // the common case for a comment, and it used to be the most expensive query in the write.
  if (probes.length === 0) return EMPTY_INDEX;
  const users = await prisma.user.findMany({
    where:
      probes.length <= MENTION_PROBE_MAX
        ? { OR: probes.map((probe) => ({ name: { contains: probe, mode: 'insensitive' as const } })) }
        : {},
    select: { id: true, name: true, role: true },
  });
  const byName = new Map<string, number[]>();
  const rolesById = new Map<number, string>();
  let maxWords = 1;
  for (const user of users) {
    rolesById.set(user.id, user.role);
    const key = normalizeName(user.name);
    if (key === '') continue;
    maxWords = Math.max(maxWords, Math.min(key.split(' ').length, MENTION_MAX_WORDS));
    const existing = byName.get(key);
    if (existing) existing.push(user.id);
    else byName.set(key, [user.id]);
  }
  // `maxWords` is now the longest name THIS BODY could match rather than the longest in the
  // organisation. The spans it drops are exactly the ones no loaded name is long enough to
  // match, and no name outside the loaded set can match any span of this body.
  return { byName, rolesById, maxWords };
}

interface MentionScan {
  userIds: number[];
  unresolved: UnresolvedMentionDto[];
}

function scanMentions(sites: MentionSite[], index: NameIndex): MentionScan {
  const userIds = new Set<number>();
  const unresolved = new Map<string, UnresolvedMentionDto>();

  for (const { words } of sites) {
    let settled = false;
    for (let span = Math.min(index.maxWords, words.length); span >= 1 && !settled; span -= 1) {
      const candidate = words.slice(0, span).join(' ').replace(TRAILING_PUNCTUATION, '');
      if (candidate === '') continue;
      const matched = index.byName.get(normalizeName(candidate));
      if (matched === undefined) continue;
      settled = true;
      if (matched.length === 1) userIds.add(matched[0]);
      // Two people, one name. Resolving to either would be a guess with somebody else's
      // name on it, so this resolves to nobody and says so.
      else unresolved.set(`AMBIGUOUS:${candidate}`, { text: candidate, reason: 'AMBIGUOUS' });
    }

    if (!settled) {
      const text = words[0].replace(TRAILING_PUNCTUATION, '');
      if (text !== '') unresolved.set(`UNKNOWN:${text}`, { text, reason: 'UNKNOWN' });
    }
  }

  return { userIds: [...userIds], unresolved: [...unresolved.values()] };
}

/** The body's `@`s, resolved to people — one narrowed query, or none when there are no `@`s. */
async function resolveMentions(body: string): Promise<{ scan: MentionScan; index: NameIndex }> {
  const sites = mentionSites(body);
  const index = await loadNameIndex(sites);
  return { scan: scanMentions(sites, index), index };
}

// ---------------------------------------------------------------------------
// Notification types. Lower-case dotted, which differs from the SCREAMING_SNAKE types the
// older events use ('MARKUP_COMMENTED'); the strings are a wire contract with the frontend
// and were specified this way, so they are not quietly renamed to match.
// ---------------------------------------------------------------------------

const MENTION_NOTIFICATION = 'comment.mention';
const NEW_COMMENT_NOTIFICATION = 'comment.new';

// ---------------------------------------------------------------------------
// GET /comments?subject=<kind>&id=<n>&limit=&after=&parentId=
//
// ONE PAGE of a thread, because the thread is user-grown and nothing else bounds it. Any
// ENGINEER may post 10,000 comments of 10,000 characters on one part, and the unpaged version
// of this handler then assembled ~100 MB of JSON per request — for every viewer of that part,
// author and mention rows included. CONTRACTS rule 12 is explicit that paging is the
// database's job, and `lib/activity.ts` already pages the same table; this is that shape
// applied to the thread, with its vocabulary (`limit`, `notes`) kept so the two read alike.
//
// Two levels, one endpoint. Without `parentId` this answers a page of ROOTS, each carrying
// the first `REPLY_PAGE` of its replies; with `parentId` it answers a page of THAT root's
// replies, which is how a UI follows `moreReplies` to the rest. A cut is always stated — in
// `nextAfter`, in `moreReplies` and in `notes` — because a silently short thread reads as a
// complete one, and a reader who cannot see that an answer was withheld will act as though
// nobody gave one.
// ---------------------------------------------------------------------------

router.get(
  '/comments',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const kind = requireSubjectKind(req.query.subject);
    // Shares the API's one id parser rather than restating it: 0 is the "absent" sentinel,
    // and anything malformed is already a 400 from there.
    const subjectId = positiveIntQuery(req.query.id, 'id', 0);
    if (subjectId === 0) throw new HttpError(400, 'id is required');
    // Clamped rather than refused, which is what `parseLimit` on the timeline and `pageSize`
    // on the parts list already do: the cap is the point, and refusing only makes a caller
    // guess the number.
    const limit = Math.min(
      ROOT_PAGE_MAX,
      positiveIntQuery(req.query.limit, 'limit', ROOT_PAGE_DEFAULT)
    );
    const after = positiveIntQuery(req.query.after, 'after', 0);
    const parentId = positiveIntQuery(req.query.parentId, 'parentId', 0);

    // The subject's access check before anything else is read (rule X3) — including before
    // `parentId` and `after` are looked up, so neither can report on a thread the caller may
    // not see.
    await resolveSubject(kind, subjectId, user);

    const subject = subjectRef(kind, subjectId);
    const notes: string[] = [];

    if (parentId !== 0) {
      // Scoped to this subject, so a comment id from another object's thread is simply not
      // found — the same answer POST gives for a parent that is not in this thread.
      const parent = await prisma.comment.findFirst({
        where: { id: parentId, ...subject, parentId: null },
        select: { id: true },
      });
      if (!parent) throw new HttpError(404, 'Comment not found');
    }

    /*
     * The cursor is resolved to its (createdAt, id) pair and compared as a pair.
     *
     * `id > after` alone would be wrong: the page is ordered by `createdAt` and two comments
     * written in the same instant can carry ids in the other order, which skips a row. The
     * pair is the order the rows are sorted in, so the comparison cannot disagree with it.
     * Reading the cursor row also scopes it: an `after` from another object's thread, or one
     * that no longer exists, is a 404 rather than a silently empty page that reads as the
     * end of the conversation.
     */
    let seek: object = {};
    if (after !== 0) {
      const cursor = await prisma.comment.findFirst({
        where: { id: after, ...subject },
        select: { id: true, createdAt: true },
      });
      if (!cursor) throw new HttpError(404, 'Comment not found');
      seek = {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      };
    }

    // `take: limit + 1` is how the page learns there is a next one without a second COUNT
    // over a table the caller is allowed to grow.
    const rows = await prisma.comment.findMany({
      where: { ...subject, parentId: parentId === 0 ? null : parentId, ...seek },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: parentId === 0 ? commentInclude : replyInclude,
    });

    const page = rows.slice(0, limit);
    const comments = page.map((row) => toComment(row, user));
    const nextAfter = rows.length > limit ? page[page.length - 1].id : null;
    if (nextAfter !== null) {
      notes.push(
        `This page carries ${limit} of ` +
          `${parentId === 0 ? 'the thread' : 'the replies'}; ask again with after=${nextAfter}.`
      );
    }
    const truncated = comments.filter((comment) => comment.moreReplies);
    if (truncated.length > 0) {
      notes.push(
        `${truncated.length} comment(s) have more than ${REPLY_PAGE} replies; ask again with ` +
          `parentId=<comment id> for the rest of one — for example ${truncated[0].id}.`
      );
    }

    const payload: CommentPageDto = { comments, nextAfter, limit, notes };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /comments — {subject, id, body, parentId?}
//
// Every read happens before the transaction and every write inside it. Two reasons, and the
// second is not optional: `assertCanRead` and the visibility pass resolve their delegate from
// the module-level client, so called inside the transaction they would run on a different
// pooled connection — outside the transaction they appear to belong to. And a P2002 inside a
// Postgres transaction aborts it, so the auto-follow below cannot be a `create` in a
// try/catch; it is an `ON CONFLICT DO NOTHING` that never raises.
// ---------------------------------------------------------------------------

router.post(
  '/comments',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const body = requireBody(req);
    const kind = requireSubjectKind(body.subject);
    const subjectId = requireIdField(body.id);

    // Subject access FIRST — before the body is validated, so a 400 cannot confirm that an
    // item the caller may not read exists (rule X3).
    const subject = await resolveSubject(kind, subjectId, user);

    const text = requireCommentBody(body.body);
    const parentId =
      body.parentId === undefined || body.parentId === null
        ? null
        : requireIdField(body.parentId, 'parentId');

    let parentAuthorId: number | null = null;
    let parentAuthorRole: string | null = null;
    if (parentId !== null) {
      // Scoped to this subject: a parent id from another object's thread is not found here,
      // which is also what the database trigger would refuse one statement later.
      const parent = await prisma.comment.findFirst({
        where: { id: parentId, ...subjectRef(kind, subjectId) },
        // The author's ROLE comes back with the row on purpose: it is what decides whether
        // they still pass the subject's grants, and the mention index no longer loads every
        // user, so this is the only place it can be read from.
        select: {
          id: true,
          parentId: true,
          authorId: true,
          deletedAt: true,
          author: { select: { role: true } },
        },
      });
      if (!parent) throw new HttpError(404, 'Comment not found');
      if (parent.parentId !== null) {
        throw new HttpError(
          409,
          'Threads are one level deep — reply to the top-level comment instead'
        );
      }
      /*
       * A WITHDRAWN COMMENT TAKES NO MORE REPLIES, and that is the decision rather than an
       * oversight: the tombstone keeps the replies it already had (removing the row would
       * cascade them away) but it has no body, so an answer accepted under it would be
       * rendered beneath an empty box — an argument with a question nobody can read. 409
       * rather than 404 because the comment is plainly there in the thread the caller is
       * looking at, and the subject's existence — the thing rule X3 protects — was settled
       * by `resolveSubject` above.
       */
      if (parent.deletedAt !== null) {
        throw new HttpError(409, 'That comment was withdrawn — reply to the thread instead');
      }
      parentAuthorId = parent.authorId;
      parentAuthorRole = parent.author.role;
    }

    const { scan, index } = await resolveMentions(text);

    // Who hears about the comment itself: everyone following the object, plus the author of
    // the comment being answered. Minus the actor (you are not told about your own typing),
    // and minus anyone mentioned — they get the mention notification, and two notifications
    // for one comment is noise.
    const followers = await prisma.watch.findMany({
      where: subjectRef(kind, subjectId),
      select: { user: { select: { id: true, role: true } } },
    });
    const roles = new Map<number, string>(index.rolesById);
    const newCommentCandidates = new Set<number>();
    for (const follower of followers) {
      roles.set(follower.user.id, follower.user.role);
      newCommentCandidates.add(follower.user.id);
    }
    if (parentAuthorId !== null) {
      newCommentCandidates.add(parentAuthorId);
      // Every candidate must have a role here: `recipientsWhoCanRead` fails closed on one it
      // cannot classify, so a parent author who had unfollowed the object would silently stop
      // being told that their comment was answered.
      if (parentAuthorRole !== null) roles.set(parentAuthorId, parentAuthorRole);
    }
    newCommentCandidates.delete(user.id);
    for (const mentioned of scan.userIds) newCommentCandidates.delete(mentioned);

    // One visibility pass over everybody who might be told anything, including the mentioned:
    // a mention notification quotes the comment, so it leaks the discussion of an object the
    // recipient may not open just as surely as an activity notification does.
    const audience = [...new Set([...scan.userIds, ...newCommentCandidates])].filter(
      (id) => id !== user.id
    );
    const readable = new Set(await recipientsWhoCanRead(subject, audience, roles));
    const mentionRecipients = scan.userIds.filter((id) => readable.has(id));
    const commentRecipients = [...newCommentCandidates].filter((id) => readable.has(id));

    const createdId = await prisma.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: { body: text, authorId: user.id, parentId, ...subjectRef(kind, subjectId) },
        select: { id: true },
      });

      if (scan.userIds.length > 0) {
        // Stored for everyone resolved, including a self-mention and including somebody who
        // cannot read the subject: the author did mention them, the thread renders it, and
        // it is the NOTIFICATION that is withheld above, not the record.
        await tx.commentMention.createMany({
          data: scan.userIds.map((userId) => ({ commentId: comment.id, userId })),
          skipDuplicates: true,
        });
      }

      // Commenting on something follows it, atomically with the comment: a follow that
      // failed separately would leave the author out of the thread they just started.
      // `createMany` + `skipDuplicates` compiles to ON CONFLICT DO NOTHING, which covers
      // Watch's partial unique indexes — and, unlike catching P2002, does not poison the
      // transaction when the follow is already there.
      await tx.watch.createMany({
        data: [{ userId: user.id, ...subjectRef(kind, subjectId) }],
        skipDuplicates: true,
      });

      // Delivered on `tx`, so a notification cannot exist for a comment that rolled back.
      if (mentionRecipients.length > 0) {
        await notifyUsers(tx, mentionRecipients, user.id, {
          type: MENTION_NOTIFICATION,
          title: `${actorName(req)} mentioned you in a comment on ${subject.label}`,
          body: text,
          link: subject.link,
        });
      }
      if (commentRecipients.length > 0) {
        await notifyUsers(tx, commentRecipients, user.id, {
          type: NEW_COMMENT_NOTIFICATION,
          title: `${actorName(req)} commented on ${subject.label}`,
          body: text,
          link: subject.link,
        });
      }

      return comment.id;
    });

    const created = await prisma.comment.findFirst({
      where: { id: createdId },
      include: commentInclude,
    });
    if (!created) throw new HttpError(500, 'The comment was created but could not be read back');
    const payload: CommentWriteResultDto = {
      ...toComment(created, user),
      unresolvedMentions: scan.unresolved,
    };
    res.status(201).json(payload);
  })
);

// ---------------------------------------------------------------------------
// PATCH /comments/:id — {body}. Author only.
//
// 403 rather than 404 for anyone else, and that is not a breach of rule X3: the caller got
// here from the thread, so the comment's existence is already known to them. What X3 still
// governs is the SUBJECT, which is why the read check above the author check stays.
// ---------------------------------------------------------------------------

router.patch(
  '/comments/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);

    const existing = await prisma.comment.findFirst({
      where: { id },
      select: {
        id: true,
        authorId: true,
        deletedAt: true,
        partId: true,
        ecnId: true,
        ecrId: true,
        projectId: true,
        requirementId: true,
        mentions: { select: { userId: true } },
      },
    });
    if (!existing) throw new HttpError(404, 'Comment not found');

    const { kind, id: subjectId } = subjectOf(existing);
    const subject = await resolveSubject(kind, subjectId, user);

    if (existing.authorId !== user.id) {
      throw new HttpError(403, 'Only the author can edit this comment');
    }
    if (existing.deletedAt !== null) {
      throw new HttpError(409, 'This comment was withdrawn and cannot be edited');
    }

    const text = requireCommentBody(requireBody(req).body);

    const { scan, index } = await resolveMentions(text);
    const previous = new Set(existing.mentions.map((mention) => mention.userId));
    const next = new Set(scan.userIds);
    const added = [...next].filter((userId) => !previous.has(userId));
    const removed = [...previous].filter((userId) => !next.has(userId));

    // ONLY the newly added names are notified. Someone already mentioned is not told again:
    // fixing a typo in a sentence that mentions six people must not ping all six a second
    // time, which is the behaviour that teaches people to mute a thread.
    //
    // `index.rolesById` covers every id here by construction: an added name was resolved out
    // of this index one statement ago, so it cannot be a candidate the visibility pass has no
    // role for.
    const readable = new Set(
      await recipientsWhoCanRead(
        subject,
        added.filter((userId) => userId !== user.id),
        index.rolesById
      )
    );
    const mentionRecipients = added.filter((userId) => readable.has(userId));

    await prisma.$transaction(async (tx) => {
      await tx.comment.update({ where: { id }, data: { body: text, editedAt: new Date() } });
      // A name taken out of the text keeps no mention row: the mention is a claim about what
      // the body says, and the body no longer says it.
      if (removed.length > 0) {
        await tx.commentMention.deleteMany({ where: { commentId: id, userId: { in: removed } } });
      }
      if (added.length > 0) {
        await tx.commentMention.createMany({
          data: added.map((userId) => ({ commentId: id, userId })),
          skipDuplicates: true,
        });
      }
      if (mentionRecipients.length > 0) {
        await notifyUsers(tx, mentionRecipients, user.id, {
          type: MENTION_NOTIFICATION,
          title: `${actorName(req)} mentioned you in a comment on ${subject.label}`,
          body: text,
          link: subject.link,
        });
      }
    });

    const updated = await prisma.comment.findFirst({ where: { id }, include: commentInclude });
    if (!updated) throw new HttpError(500, 'The comment was updated but could not be read back');
    const payload: CommentWriteResultDto = {
      ...toComment(updated, user),
      unresolvedMentions: scan.unresolved,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// DELETE /comments/:id — author or ADMIN, and it is a TOMBSTONE
//
// Never a hard delete: the self-relation cascades, so removing the row would take its
// replies with it and leave a thread where an answer hangs under nothing. The row stays,
// the text goes, and the thread still reads as a conversation.
// ---------------------------------------------------------------------------

router.delete(
  '/comments/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);

    const existing = await prisma.comment.findFirst({
      where: { id },
      select: {
        id: true,
        authorId: true,
        deletedAt: true,
        partId: true,
        ecnId: true,
        ecrId: true,
        projectId: true,
        requirementId: true,
      },
    });
    if (!existing) throw new HttpError(404, 'Comment not found');

    const { kind, id: subjectId } = subjectOf(existing);
    await resolveSubject(kind, subjectId, user);

    if (existing.authorId !== user.id && user.role !== Role.ADMIN) {
      throw new HttpError(403, 'Only the author or an administrator can delete this comment');
    }

    // Already withdrawn: nothing to do, and the second request is as successful as the first.
    // Re-stamping deletedAt would move the record of when it was withdrawn.
    if (existing.deletedAt === null) {
      await prisma.comment.update({
        where: { id },
        // Blanked rather than nulled: the column is NOT NULL, and `deletedAt` is the flag
        // the DTO reads. The mapper is what turns this into `body: null, withdrawn: true`.
        data: { body: '', deletedAt: new Date() },
      });
    }

    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// GET /watches — what I follow, grouped by subject type
//
// An item the caller may no longer read is LISTED and stripped of its identity rather than
// dropped (rule X4's instinct, applied to a list the caller built themselves). Dropping it
// would leave a follow nobody can see and nobody can cancel; naming it would disclose an
// object they have lost access to. They already know the id — they followed it — so the id
// stays and the label does not, which is exactly enough to press Unfollow.
// ---------------------------------------------------------------------------

const watchInclude = {
  part: { select: { id: true, partNumber: true, name: true } },
  ecn: { select: { id: true, ecnNumber: true, title: true } },
  ecr: { select: { id: true, ecrNumber: true, title: true } },
  project: { select: { id: true, code: true, name: true } },
  requirement: { select: { id: true, reqNumber: true, title: true } },
} satisfies Prisma.WatchInclude;

type WatchRow = Prisma.WatchGetPayload<{ include: typeof watchInclude }>;

function watchLabel(row: WatchRow): string {
  if (row.part) return `${row.part.partNumber} ${row.part.name}`;
  if (row.ecn) return `${row.ecn.ecnNumber} ${row.ecn.title}`;
  if (row.ecr) return `${row.ecr.ecrNumber} ${row.ecr.title}`;
  if (row.project) return `${row.project.code} ${row.project.name}`;
  if (row.requirement) return `${row.requirement.reqNumber} ${row.requirement.title}`;
  // The CHECK makes this unreachable; the subject row cannot be missing either, because
  // every subject FK cascades the follow away with it.
  return REDACTED.name;
}

router.get(
  '/watches',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const rows = await prisma.watch.findMany({
      where: { userId: user.id },
      orderBy: { id: 'asc' },
      include: watchInclude,
    });

    // One `visibleIds` per ACL-bearing type on the page (at most three), never one per row.
    const byType = new Map<AclType, number[]>();
    for (const row of rows) {
      const { kind, id } = subjectOf(row);
      const aclType = SUBJECTS[kind].aclType;
      if (aclType === null) continue;
      const ids = byType.get(aclType);
      if (ids) ids.push(id);
      else byType.set(aclType, [id]);
    }
    const visibleByType = new Map<AclType, Set<number>>();
    await Promise.all(
      [...byType].map(async ([aclType, ids]) => {
        visibleByType.set(aclType, await visibleIds(aclType, ids, user));
      })
    );

    const payload: WatchListDto = {
      parts: [],
      ecns: [],
      ecrs: [],
      projects: [],
      requirements: [],
    };
    for (const row of rows) {
      const { kind, id } = subjectOf(row);
      const spec = SUBJECTS[kind];
      const redacted = spec.aclType !== null && !visibleByType.get(spec.aclType)?.has(id);
      payload[spec.group].push({
        id,
        label: redacted ? REDACTED.name : watchLabel(row),
        link: `${spec.route}${id}`,
        redacted,
      });
    }
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /watches — {subject, id}. Idempotent.
//
// Following twice is 200, not 409. The user's intent — "keep me posted about this" — is
// satisfied either way, and a client that cannot tell whether it already followed something
// would have to GET first and would still race. The partial unique index is what makes the
// row unique; catching its violation is what makes the request honest. Safe as a bare
// `create` + catch precisely because it is a single statement and not inside a transaction
// that a P2002 would abort.
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

router.post(
  '/watches',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const body = requireBody(req);
    const kind = requireSubjectKind(body.subject);
    const subjectId = requireIdField(body.id);

    await resolveSubject(kind, subjectId, user);

    try {
      await prisma.watch.create({ data: { userId: user.id, ...subjectRef(kind, subjectId) } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const payload: WatchStateDto = { subject: kind, id: subjectId, watching: true };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// DELETE /watches — {subject, id}. Idempotent, and deliberately NOT read-gated.
//
// Following something requires being able to read it; UNfollowing it does not. The response
// is the same 204 whether a row was removed or none existed, so it discloses nothing — and
// gating it would strand the one person who most needs it: a follower who lost access,
// looking at the redacted row GET /watches hands them, with an Unfollow button that 404s.
// ---------------------------------------------------------------------------

router.delete(
  '/watches',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);
    const body = requireBody(req);
    const kind = requireSubjectKind(body.subject);
    const subjectId = requireIdField(body.id);

    await prisma.watch.deleteMany({
      where: { userId: user.id, ...subjectRef(kind, subjectId) },
    });

    res.status(204).end();
  })
);

export default router;
