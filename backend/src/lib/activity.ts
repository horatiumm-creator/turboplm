/**
 * The per-item activity timeline — "what has happened to this thing".
 *
 * Nothing here records anything. Every entry is READ out of a source that already existed and
 * was already being written: the audit trail, the comment thread, the revision history, the
 * ECN's own status columns and its reviews, a project's gate passes. The feature is the merge
 * and the ordering, which is the part that was costing an engineer five screens.
 *
 * Three things make it honest rather than decorative, and each one is a rule rather than a
 * preference:
 *
 *  1. THE SUBJECT IS ACCESS-CHECKED FIRST, and an unreadable subject answers 404, never 403
 *     (rule X3). Every query below is scoped to one subject that has already passed that
 *     check, which is also the argument that this endpoint is not a second way around
 *     item-level access: see the note above `auditMatchers` for why no row it can return
 *     names anything other than the subject or something that belongs solely to it.
 *
 *  2. `AuditLog.details` IS NEVER ECHOED TO A NON-ADMIN. The rule, stated once here and
 *     enforced in `auditEntries` below: a non-ADMIN gets `summary` and NO `detail` at all;
 *     an ADMIN gets `details` serialised into `detail`. `details` is the sanitized REQUEST
 *     BODY, so it can name part numbers, prices and names belonging to objects the caller has
 *     no grant on — CONTRACTS proves this rather than suspecting it: `POST /revisions/:id/bom`
 *     on an unrestricted parent records `{childPartId: N}` where N is a restricted part, and
 *     the row itself is legitimately readable. No ownership filter can reach inside that
 *     payload, and scrubbing it field by field against five ACL types is the option CONTRACTS
 *     explicitly rejected as permanently fragile. So the payload does not travel. An ADMIN
 *     keeps it because an ADMIN already passes `aclFilter` everywhere — the trail tells them
 *     nothing they could not read directly.
 *
 *     Note what this does NOT copy from `routes/audit.ts`: that endpoint additionally narrows
 *     a non-ADMIN to their OWN rows, because it is an organisation-wide feed with no subject
 *     and therefore no way to bound what a row can be about. Here every row is pinned to one
 *     subject the caller may read, and "who changed this part" is the entire question a
 *     per-item timeline exists to answer — scoped to yourself it would answer nothing.
 *
 *  3. AN INCOMPLETE ANSWER SAYS SO, in `notes`. A source that threw, a bounded source that hit
 *     its cap, a page the limit cut short, and the two standing gaps (below) all produce a
 *     note. A timeline that silently drops a source reads as "nothing happened", which on this
 *     screen is a lie with consequences.
 *
 * THE TWO STANDING GAPS, recorded here so they are not rediscovered as bugs:
 *
 *  - `middleware/audit.ts` types a row from `ENTITY_PATTERNS`, and that list covers parts,
 *    revisions, ECNs, ECN items, ECRs and documents but has NO pattern for `/projects`,
 *    `/project-phases`, `/deliverables`, `/requirements` or `/requirement-links`. Those rows
 *    carry `entityType: null, entityId: null`. So `entityType`/`entityId` are preferred where
 *    they exist and the path is matched where they do not — and the path is matched exactly,
 *    never with a bare prefix, because `startsWith('/projects/5')` also matches `/projects/50`.
 *  - A row whose own id space is a BOM line, an operation, a process plan or an operation
 *    material (`PATCH /bom-lines/:id` and friends) cannot be reached from the part without
 *    resolving every line and every operation of every revision, which is unbounded. Those
 *    edits are absent, and `partScope` says so in a note rather than leaving the reader to
 *    assume the BOM has never been touched.
 */
import { EcnReviewDecision, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { AclUser, aclFilter } from './acl';
import { HttpError, positiveIntQuery } from './errors';

/** The five things a timeline can be asked about. Mirrors `Comment`'s five subject columns. */
export type ActivitySubjectType = 'part' | 'ecn' | 'ecr' | 'project' | 'requirement';

const SUBJECT_TYPES: ActivitySubjectType[] = ['part', 'ecn', 'ecr', 'project', 'requirement'];

export type ActivityKind =
  | 'SUBJECT_CREATED'
  | 'AUDIT'
  | 'COMMENT'
  | 'COMMENT_REPLY'
  | 'COMMENT_WITHDRAWN'
  | 'REVISION_CREATED'
  | 'REVISION_RELEASED'
  | 'ECN_APPROVED'
  | 'ECN_RELEASED'
  | 'ECN_REVIEW'
  | 'ECR_RESOLVED'
  | 'PHASE_PASSED';

export interface ActivityActor {
  id: number;
  name: string;
}

export interface ActivityEntry {
  /** ISO timestamp. The one field every source must be able to supply, or it cannot appear. */
  at: string;
  kind: ActivityKind;
  /** Null when the source records no actor — see `REVISION_RELEASED` below. */
  actor: ActivityActor | null;
  summary: string;
  link?: string;
  /**
   * The entry's own content, and a STRING on purpose.
   *
   * Typing it as a string rather than as JSON makes rule 2 above structural: there is no shape
   * here that an `AuditLog.details` object could be spread into by accident, so the only way
   * a payload reaches a caller is the one explicit `JSON.stringify` in `auditEntries`, which
   * is behind the ADMIN test. For a comment or a review it is the text the author wrote about
   * a subject this caller has already been allowed to read.
   */
  detail?: string;
}

export interface ActivityFeed {
  subject: { type: ActivitySubjectType; id: number; label: string; link: string };
  /** Newest first. */
  entries: ActivityEntry[];
  /** Pass as `before` to continue. Null when this page is the end of the timeline. */
  nextBefore: string | null;
  limit: number;
  /** Everything this answer could not do completely, in words. Empty when it is complete. */
  notes: string[];
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * How many rows the bounded sources read — revisions of a part, reviews of an ECN, phases and
 * deliverables of a project, links of a requirement. All of them are small by business reality
 * rather than by construction, so they are read whole and capped as a backstop.
 *
 * Deliberately ABOVE `MAX_LIMIT`. The pagination proof in `paginate` needs every source to
 * contribute at least `limit + 1` candidates before it may trim a tie group, and a cap equal
 * to the maximum limit would leave the largest page one entry short of that.
 */
const BOUNDED_CAP = MAX_LIMIT + 50;

/** `details` is a whole request body; serialised in full it can be megabytes. */
const DETAIL_CHARS = 4000;

/** A comment's first line, for a row in a timeline rather than the thread view. */
const SUMMARY_CHARS = 160;

// ---------------------------------------------------------------------------
// Query parsing — here rather than in the route, so it is testable without HTTP
// ---------------------------------------------------------------------------

export function parseSubjectType(value: unknown): ActivitySubjectType {
  if (typeof value === 'string' && (SUBJECT_TYPES as string[]).includes(value)) {
    return value as ActivitySubjectType;
  }
  throw new HttpError(400, `subject must be one of: ${SUBJECT_TYPES.join(', ')}`);
}

/**
 * Clamped, not refused, which is what `GET /parts?pageSize=` already does for a value over its
 * maximum. The cap is the point — an uncapped timeline on a busy part is a memory incident —
 * and refusing the request would only make a caller guess the number.
 */
export function parseLimit(value: unknown): number {
  return Math.min(MAX_LIMIT, positiveIntQuery(value, 'limit', DEFAULT_LIMIT));
}

/**
 * An instant, with a date, a time and a zone — the shape `nextBefore` hands back, which is
 * the only thing a caller is ever meant to put here.
 *
 * MATCHED BEFORE IT IS PARSED, because `new Date(value)` is the loose parser this refuses to
 * be: `new Date('1')` is 2001-01-01, so `before=1` would have become a valid cursor eight
 * hundred years before the data and returned an empty page — a typo answering 200 with
 * "nothing happened" instead of 400. A time with no zone is refused for the same reason
 * rather than a pedantic one: `new Date('2024-03-03T10:00:00')` is read in the SERVER's
 * timezone, so the same cursor would select a different page on a machine configured
 * differently.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function parseBefore(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid before');
  if (!ISO_INSTANT.test(value)) {
    throw new HttpError(
      400,
      'Invalid before — expected an ISO timestamp such as 2024-03-03T10:00:00.000Z'
    );
  }
  // The shape being right does not make the value an instant: month 13 and hour 25 parse to
  // NaN and are refused here. A day past the end of its month (31 February) does NOT — the
  // ISO parser rolls it into the next one — and that is left alone deliberately. It is a
  // cursor a day away from where it was typed, not the eight centuries `before=1` moved, and
  // rejecting it would mean reimplementing the calendar to improve on a value no client
  // produces: `nextBefore` is what callers send back.
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new HttpError(400, 'Invalid before — expected an ISO timestamp');
  }
  return at;
}

// ---------------------------------------------------------------------------
// Subject resolution: the access check, the label, and what the subject's own rows can date
// ---------------------------------------------------------------------------

interface SubjectScope {
  type: ActivitySubjectType;
  id: number;
  label: string;
  /** The SPA route for this subject, used as every entry's default link. */
  link: string;
  /** Entries the subject's own columns can date without reading anything else. */
  entries: ActivityEntry[];
  /** `AuditLog` conditions naming this subject, or something that belongs solely to it. */
  matchers: Prisma.AuditLogWhereInput[];
  /** The `Comment` column that names this subject (exactly one is set — see the CHECK). */
  commentWhere: Prisma.CommentWhereInput;
}

/**
 * Match one audit path exactly, or anything beneath it.
 *
 * NOT `startsWith(base)`, which matches `/parts/70` when the subject is part 7. On a timeline
 * that misattribution does not look like a bug: it looks like a change somebody made.
 *
 * `startsWith` is a LIKE and Prisma does not escape `%` or `_` in it, which is why
 * `routes/requirements.ts` carries an `escapeLike`. Nothing is needed here: `base` is built
 * from a literal prefix and an integer id, so it contains no character LIKE interprets.
 */
function pathMatchers(base: string): Prisma.AuditLogWhereInput[] {
  return [{ path: base }, { path: { startsWith: `${base}/` } }];
}


/** Prisma codes about the CONNECTION rather than about this query: pool exhaustion, P1xxx. */
const CONNECTION_CODE = /^(?:P2024|P1\d{3})$/;

/**
 * A failure that no note can honestly describe, so it must leave as a 500.
 *
 * `readSource`'s bargain below is "the other five sources, plus a sentence about this one".
 * A connection-level failure breaks the bargain rather than one source: the pool is gone for
 * EVERY statement this request makes — so what the caller would get is not a timeline with
 * one source absent but an empty one, under a note that blames whichever source happened to
 * be asked first. The rule for exactly these errors is not negotiable: never quietly return
 * zero rows. Fail loud, never fail quiet.
 */
function isConnectionFailure(err: unknown): boolean {
  const fault = err as { code?: unknown; errorCode?: unknown; message?: unknown } | null;
  for (const code of [fault?.code, fault?.errorCode]) {
    if (typeof code === 'string' && CONNECTION_CODE.test(code)) return true;
  }
  // `$queryRaw` reports a Postgres error as P2010 with the SQLSTATE in `meta.code`; a model
  // operation leaves it in the message alone. Both are read, so neither path can turn a
  // missing GUC into a note.
  return false;
}

/**
 * Run one source, and turn a failure into a NOTE rather than a 500.
 *
 * A timeline is a read of six independent things, and the useful answer when one of them is
 * unavailable is the other five plus a sentence saying what is missing. The failure mode this
 * exists to prevent is the opposite one — a single source erroring and taking the whole screen
 * with it, which reads to the user as "this feature is broken" rather than "this part of it
 * is". The subject's own access check is deliberately NOT wrapped: a 404 must stay a 404.
 *
 * Exported for the tests. The decision this makes has two directions and only one of them can
 * be reached through HTTP, so the other is asserted here, against a real missing-GUC failure.
 */
export async function readSource<T>(
  name: string,
  notes: string[],
  read: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isConnectionFailure(err)) throw err;
    console.error(`activity: the ${name} source failed`, err);
    notes.push(`The ${name} could not be read, so entries from it are missing here.`);
    return fallback;
  }
}

/** Report a bounded source that hit its cap, which is the one way it can be short. */
function noteCap(notes: string[], rows: unknown[], what: string): boolean {
  if (rows.length <= BOUNDED_CAP) return false;
  notes.push(
    `Only the ${BOUNDED_CAP} most recent ${what} were read; anything recorded against an ` +
      'older one is absent from this timeline.'
  );
  return true;
}

const ACTOR = { select: { id: true, name: true } } as const;

async function partScope(id: number, user: AclUser, notes: string[]): Promise<SubjectScope> {
  // Resolved THROUGH the filter rather than fetched and then checked, so an unreadable part and
  // a missing one take the same path to the same 404 (rule X3).
  const part = await prisma.part.findFirst({
    where: { id, ...aclFilter('PART', user) },
    select: { id: true, partNumber: true, name: true, createdAt: true, createdBy: ACTOR },
  });
  if (!part) throw new HttpError(404, 'Part not found');

  const link = `/parts/${part.id}`;
  // The API path and the SPA route coincide for all five subjects. Kept as separate locals on
  // purpose: they are different things, and a future change to either must not silently
  // re-point the other.
  const apiBase = `/parts/${part.id}`;

  const entries: ActivityEntry[] = [
    {
      at: part.createdAt.toISOString(),
      kind: 'SUBJECT_CREATED',
      actor: part.createdBy,
      summary: `Part ${part.partNumber} created`,
      link,
    },
  ];

  /*
   * The revision history, and what it can and cannot date.
   *
   * `createdAt` and `releasedAt` are columns, so creation and release are dated exactly.
   * SUBMIT, REJECT and OBSOLETE are not: the lifecycle is one enum column with no transition
   * log, so the only dated record of them is the audit row for
   * `POST /revisions/:id/transition` — which is why the matcher below reaches revision-scoped
   * audit rows rather than stopping at the part.
   *
   * `REVISION_RELEASED` carries a null actor, and that is honest rather than lazy: there is no
   * `releasedById` column. The audit row for the transition names the actor, and it appears
   * beside this entry.
   */
  const revisions = await readSource(
    'revision history',
    notes,
    () =>
      prisma.partRevision.findMany({
        where: { partId: part.id },
        orderBy: { id: 'desc' },
        take: BOUNDED_CAP + 1,
        select: {
          id: true,
          revision: true,
          createdAt: true,
          releasedAt: true,
          createdBy: ACTOR,
        },
      }),
    []
  );
  noteCap(notes, revisions, 'revisions of this part');
  const read = revisions.slice(0, BOUNDED_CAP);
  for (const rev of read) {
    entries.push({
      at: rev.createdAt.toISOString(),
      kind: 'REVISION_CREATED',
      actor: rev.createdBy,
      summary: `Revision ${rev.revision} created`,
      link: `${link}?rev=${rev.id}`,
    });
    if (rev.releasedAt !== null) {
      entries.push({
        at: rev.releasedAt.toISOString(),
        kind: 'REVISION_RELEASED',
        actor: null,
        summary: `Revision ${rev.revision} released`,
        link: `${link}?rev=${rev.id}`,
      });
    }
  }

  const matchers: Prisma.AuditLogWhereInput[] = [
    { entityType: 'PART', entityId: part.id },
    ...pathMatchers(apiBase),
  ];
  if (read.length > 0) {
    // Both of these types carry a PartRevision id: `ENTITY_PATTERNS` maps `/revisions/:id/...`
    // to REVISION and `/revisions/:id/bom-import` to BOM_IMPORT. Matched by id and type
    // together, never by id alone — ids are per-table sequences, so a revision and a document
    // routinely share a number.
    matchers.push({
      entityType: { in: ['REVISION', 'BOM_IMPORT'] },
      entityId: { in: read.map((rev) => rev.id) },
    });
  }

  notes.push(
    'Edits recorded against a BOM line, an alternate, a process plan, an operation or an ' +
      'operation material carry that row’s own id in the audit trail and cannot be ' +
      'reached from the part, so they are not listed here.'
  );

  return {
    type: 'part',
    id: part.id,
    label: `${part.partNumber} — ${part.name}`,
    link,
    entries,
    matchers,
    commentWhere: { partId: part.id },
  };
}

async function ecnScope(id: number, user: AclUser, notes: string[]): Promise<SubjectScope> {
  const ecn = await prisma.ecn.findFirst({
    where: { id, ...aclFilter('ECN', user) },
    select: {
      id: true,
      ecnNumber: true,
      title: true,
      createdAt: true,
      createdBy: ACTOR,
      approvedAt: true,
      approvedBy: ACTOR,
      releasedAt: true,
      items: { select: { id: true }, take: BOUNDED_CAP + 1 },
    },
  });
  if (!ecn) throw new HttpError(404, 'ECN not found');

  const link = `/ecns/${ecn.id}`;
  const apiBase = `/ecns/${ecn.id}`;

  /*
   * Which transitions this can date, and which it cannot.
   *
   * APPROVED and RELEASED have their own columns, so they are exact — and `approvedById` means
   * APPROVED also has an actor. SUBMIT, REJECT and CANCEL have neither a timestamp nor an
   * actor column anywhere on `Ecn`; `updatedAt` records only the latest write of any kind. So
   * they come from the audit row for `POST /ecns/:id/transition`, which the ECN matcher picks
   * up, and nothing here pretends to a second source for them.
   */
  const entries: ActivityEntry[] = [
    {
      at: ecn.createdAt.toISOString(),
      kind: 'SUBJECT_CREATED',
      actor: ecn.createdBy,
      summary: `${ecn.ecnNumber} raised`,
      link,
    },
  ];
  if (ecn.approvedAt !== null) {
    entries.push({
      at: ecn.approvedAt.toISOString(),
      kind: 'ECN_APPROVED',
      actor: ecn.approvedBy,
      summary: `${ecn.ecnNumber} approved`,
      link,
    });
  }
  if (ecn.releasedAt !== null) {
    entries.push({
      at: ecn.releasedAt.toISOString(),
      kind: 'ECN_RELEASED',
      actor: null,
      summary: `${ecn.ecnNumber} released`,
      link,
    });
  }

  const reviews = await readSource(
    'review decisions',
    notes,
    () =>
      prisma.ecnReview.findMany({
        where: { ecnId: ecn.id, NOT: { decidedAt: null } },
        orderBy: { decidedAt: 'desc' },
        take: BOUNDED_CAP + 1,
        select: { decision: true, comment: true, decidedAt: true, reviewer: ACTOR },
      }),
    []
  );
  noteCap(notes, reviews, 'review decisions on this ECN');
  for (const review of reviews.slice(0, BOUNDED_CAP)) {
    // `decidedAt` is non-null by the `where` above; narrowed for the compiler, which cannot
    // read a `NOT: { decidedAt: null }` filter.
    if (review.decidedAt === null) continue;
    const approved = review.decision === EcnReviewDecision.APPROVED;
    entries.push({
      at: review.decidedAt.toISOString(),
      kind: 'ECN_REVIEW',
      actor: review.reviewer,
      summary: `${review.reviewer.name} ${approved ? 'approved' : 'requested changes on'} ${
        ecn.ecnNumber
      }`,
      link,
      // The reviewer's own words about an ECN this caller has been allowed to read — the same
      // content `GET /ecns/:id` already returns in `reviews`. Not an audit payload.
      ...(review.comment ? { detail: review.comment } : {}),
    });
  }

  const matchers: Prisma.AuditLogWhereInput[] = [
    { entityType: 'ECN', entityId: ecn.id },
    ...pathMatchers(apiBase),
  ];
  const itemIds = ecn.items.slice(0, BOUNDED_CAP).map((item) => item.id);
  if (itemIds.length > 0) {
    // `PATCH /ecn-items/:id` records ECN_ITEM with the item's own id, which is only reachable
    // from the ECN by resolving the items — cheap, because an ECN has a handful.
    matchers.push({ entityType: 'ECN_ITEM', entityId: { in: itemIds } });
  }
  noteCap(notes, ecn.items, 'affected items on this ECN');

  return {
    type: 'ecn',
    id: ecn.id,
    label: `${ecn.ecnNumber} — ${ecn.title}`,
    link,
    entries,
    matchers,
    commentWhere: { ecnId: ecn.id },
  };
}

/**
 * ECR and Requirement are NOT ACL-bearing types — `acl.ts` governs PART, DOCUMENT, ECN,
 * PROJECT and BUILD_UNIT and nothing else. So the only check here is existence, under the org
 * scope row-level security already supplies, and no item filter is invented for them. That is
 * the same decision `GET /home` records for CorrectiveAction and Rfq.
 */
async function ecrScope(id: number, _user: AclUser, _notes: string[]): Promise<SubjectScope> {
  const ecr = await prisma.ecr.findFirst({
    where: { id },
    select: {
      id: true,
      ecrNumber: true,
      title: true,
      status: true,
      createdAt: true,
      createdBy: ACTOR,
      resolvedAt: true,
      resolvedBy: ACTOR,
    },
  });
  if (!ecr) throw new HttpError(404, 'ECR not found');

  const link = `/ecrs/${ecr.id}`;
  const entries: ActivityEntry[] = [
    {
      at: ecr.createdAt.toISOString(),
      kind: 'SUBJECT_CREATED',
      actor: ecr.createdBy,
      summary: `${ecr.ecrNumber} raised`,
      link,
    },
  ];
  if (ecr.resolvedAt !== null) {
    entries.push({
      at: ecr.resolvedAt.toISOString(),
      kind: 'ECR_RESOLVED',
      actor: ecr.resolvedBy,
      summary: `${ecr.ecrNumber} ${ecr.status.toLowerCase()}`,
      link,
    });
  }

  return {
    type: 'ecr',
    id: ecr.id,
    label: `${ecr.ecrNumber} — ${ecr.title}`,
    link,
    entries,
    matchers: [{ entityType: 'ECR', entityId: ecr.id }, ...pathMatchers(`/ecrs/${ecr.id}`)],
    commentWhere: { ecrId: ecr.id },
  };
}

async function projectScope(id: number, user: AclUser, notes: string[]): Promise<SubjectScope> {
  const project = await prisma.project.findFirst({
    where: { id, ...aclFilter('PROJECT', user) },
    select: { id: true, code: true, name: true, createdAt: true, createdBy: ACTOR },
  });
  if (!project) throw new HttpError(404, 'Project not found');

  const link = `/projects/${project.id}`;
  const entries: ActivityEntry[] = [
    {
      at: project.createdAt.toISOString(),
      kind: 'SUBJECT_CREATED',
      actor: project.createdBy,
      summary: `Project ${project.code} created`,
      link,
    },
  ];

  const phases = await readSource(
    'gate history',
    notes,
    () =>
      prisma.projectPhase.findMany({
        where: { projectId: project.id },
        orderBy: { seq: 'asc' },
        take: BOUNDED_CAP + 1,
        select: { id: true, seq: true, name: true, passedAt: true, passedBy: ACTOR },
      }),
    []
  );
  noteCap(notes, phases, 'phases of this project');
  const readPhases = phases.slice(0, BOUNDED_CAP);
  for (const phase of readPhases) {
    if (phase.passedAt === null) continue;
    entries.push({
      at: phase.passedAt.toISOString(),
      kind: 'PHASE_PASSED',
      actor: phase.passedBy,
      summary: `Gate ${phase.seq} (${phase.name}) passed`,
      link,
    });
  }

  /*
   * DELIVERABLE STATUS CHANGES HAVE NO TIMESTAMP TO SORT BY, anywhere.
   *
   * `ProjectDeliverable` carries `status` and no `updatedAt`, no `completedAt`, nothing — so
   * the model cannot say WHEN a deliverable moved, and this timeline cannot invent it. The
   * only dated record is the audit row for `PATCH /deliverables/:id`, which is what the
   * matcher below reaches. Its `entityType` is null (`ENTITY_PATTERNS` has no deliverable
   * pattern), so it is matched by exact path, and the NEW STATUS is inside `details` — which
   * rule 2 keeps from every non-ADMIN. So a non-ADMIN learns that a deliverable changed and
   * not what it changed to. That is the honest shape of this source, and the note says so
   * rather than leaving the reader to infer completeness from a row that has none.
   */
  const deliverables = await readSource(
    'deliverable history',
    notes,
    () =>
      prisma.projectDeliverable.findMany({
        where: { phase: { projectId: project.id } },
        select: { id: true },
        take: BOUNDED_CAP + 1,
      }),
    []
  );
  noteCap(notes, deliverables, 'deliverables of this project');

  const matchers: Prisma.AuditLogWhereInput[] = [...pathMatchers(`/projects/${project.id}`)];
  if (readPhases.length > 0) {
    matchers.push({
      path: {
        in: readPhases.flatMap((phase) => [
          `/project-phases/${phase.id}/pass`,
          `/project-phases/${phase.id}/deliverables`,
        ]),
      },
    });
  }
  const deliverableIds = deliverables.slice(0, BOUNDED_CAP);
  if (deliverableIds.length > 0) {
    matchers.push({ path: { in: deliverableIds.map((row) => `/deliverables/${row.id}`) } });
  }

  if (deliverableIds.length > 0) {
    notes.push(
      'A deliverable’s status change is dated from the audit trail, because ' +
        'ProjectDeliverable records no transition timestamp; the status it moved to is in the ' +
        'audit payload, which only an ADMIN is shown.'
    );
  }

  return {
    type: 'project',
    id: project.id,
    label: `${project.code} — ${project.name}`,
    link,
    entries,
    matchers,
    commentWhere: { projectId: project.id },
  };
}

async function requirementScope(
  id: number,
  _user: AclUser,
  notes: string[]
): Promise<SubjectScope> {
  // Not ACL-bearing — see the note on `ecrScope`.
  const requirement = await prisma.requirement.findFirst({
    where: { id },
    select: {
      id: true,
      reqNumber: true,
      title: true,
      createdAt: true,
      createdBy: ACTOR,
    },
  });
  if (!requirement) throw new HttpError(404, 'Requirement not found');

  const link = `/requirements/${requirement.id}`;
  const entries: ActivityEntry[] = [
    {
      at: requirement.createdAt.toISOString(),
      kind: 'SUBJECT_CREATED',
      actor: requirement.createdBy,
      summary: `${requirement.reqNumber} created`,
      link,
    },
  ];

  // APPROVE and OBSOLETE (rule R3) change one enum column and stamp nothing, so like an ECN's
  // submit they exist only as the audit row for `POST /requirements/:id/transition`.
  const links = await readSource(
    'requirement link history',
    notes,
    () =>
      prisma.requirementLink.findMany({
        where: { requirementId: requirement.id },
        select: { id: true },
        take: BOUNDED_CAP + 1,
      }),
    []
  );
  noteCap(notes, links, 'links on this requirement');

  const matchers: Prisma.AuditLogWhereInput[] = [...pathMatchers(link)];
  const linkIds = links.slice(0, BOUNDED_CAP);
  if (linkIds.length > 0) {
    matchers.push({ path: { in: linkIds.map((row) => `/requirement-links/${row.id}`) } });
  }

  return {
    type: 'requirement',
    id: requirement.id,
    label: `${requirement.reqNumber} — ${requirement.title}`,
    link,
    entries,
    matchers,
    commentWhere: { requirementId: requirement.id },
  };
}

async function resolveScope(
  type: ActivitySubjectType,
  id: number,
  user: AclUser,
  notes: string[]
): Promise<SubjectScope> {
  switch (type) {
    case 'part':
      return partScope(id, user, notes);
    case 'ecn':
      return ecnScope(id, user, notes);
    case 'ecr':
      return ecrScope(id, user, notes);
    case 'project':
      return projectScope(id, user, notes);
    case 'requirement':
      return requirementScope(id, user, notes);
  }
  // Unreachable while the union holds, and a hard error rather than an empty timeline if a
  // caller is ever added without a branch — the same reason acl.ts refuses an unknown type.
  throw new HttpError(500, `Unknown activity subject: ${String(type)}`);
}

// ---------------------------------------------------------------------------
// The two unbounded sources
// ---------------------------------------------------------------------------

function firstLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

async function commentEntries(
  scope: SubjectScope,
  before: Date | null,
  limit: number,
  notes: string[]
): Promise<ActivityEntry[]> {
  const rows = await readSource(
    'comment thread',
    notes,
    () =>
      prisma.comment.findMany({
        where: { ...scope.commentWhere, ...(before ? { createdAt: { lt: before } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          body: true,
          createdAt: true,
          editedAt: true,
          deletedAt: true,
          parentId: true,
          author: ACTOR,
        },
      }),
    []
  );

  /*
   * A WITHDRAWN COMMENT IS LISTED, AND ITS BODY IS NOT.
   *
   * Tombstoned rows are kept (the comment model deletes by blanking rather than by removing,
   * so a thread does not lose the replies to a withdrawn parent) and they belong on a
   * timeline: "somebody said something here and took it back" is part of what happened to
   * this item, and omitting it would make the thread read as though the replies answered
   * nothing. The entry sits at `createdAt`, where the conversation actually happened, rather
   * than at `deletedAt` — a withdrawal is not a second event in the subject's history.
   */
  return rows.map((row) => {
    const withdrawn = row.deletedAt !== null;
    if (withdrawn) {
      return {
        at: row.createdAt.toISOString(),
        kind: 'COMMENT_WITHDRAWN' as ActivityKind,
        actor: row.author,
        summary: `${row.author.name} left a comment, since withdrawn`,
        link: scope.link,
      };
    }
    return {
      at: row.createdAt.toISOString(),
      kind: (row.parentId === null ? 'COMMENT' : 'COMMENT_REPLY') as ActivityKind,
      actor: row.author,
      summary: `${row.author.name} commented${row.editedAt ? ' (edited)' : ''}: ${firstLine(
        row.body
      )}`,
      link: scope.link,
      detail: row.body,
    };
  });
}

/**
 * THE AUDIT SOURCE, AND WHY IT IS NOT A SECOND WAY AROUND ITEM-LEVEL ACCESS.
 *
 * `routes/audit.ts` had to narrow a non-ADMIN to their own rows because its feed is
 * organisation-wide: a row could be about anything, so nothing bounded what `details` might
 * name. Here every matcher in `scope.matchers` names either the subject itself — already
 * resolved through `aclFilter` — or a row that exists only as part of it: a PartRevision of
 * this part, an EcnItem of this ECN, a phase or deliverable of this project, a link of this
 * requirement. None of those is independently ACL-bearing, so no row this query can return
 * identifies an item other than the one the caller was just allowed to read.
 *
 * `aclFilter` is therefore not applied, and it could not be: `AuditLog` names its subject with
 * a string column and an integer column and has no relation to walk (which is why `hiddenIds`
 * exists at all). The access decision was made once, on the subject, above.
 *
 * `details` is the exception and it is handled by rule 2 at the top of this file: the payload
 * reaches an ADMIN and nobody else.
 */
async function auditEntries(
  scope: SubjectScope,
  user: AclUser,
  before: Date | null,
  limit: number,
  notes: string[]
): Promise<ActivityEntry[]> {
  if (scope.matchers.length === 0) return [];
  const rows = await readSource(
    'audit trail',
    notes,
    () =>
      prisma.auditLog.findMany({
        // `OR` and `createdAt` are both plain top-level keys here, so there is no `AND` for a
        // future condition to collide with — see acl.ts's "Applying the filter".
        where: { OR: scope.matchers, ...(before ? { createdAt: { lt: before } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          method: true,
          path: true,
          summary: true,
          details: true,
          createdAt: true,
          user: ACTOR,
        },
      }),
    []
  );

  const isAdmin = user.role === 'ADMIN';
  return rows.map((row) => ({
    at: row.createdAt.toISOString(),
    kind: 'AUDIT' as ActivityKind,
    actor: row.user,
    /*
     * The STORED summary, verbatim — `"<METHOD> <path>"`, exactly what `/audit` already shows.
     * Deliberately not translated into prose: a path-to-English mapping would be a second
     * `ENTITY_PATTERNS` to keep in step with the routes, and the failure mode of a stale one
     * is a timeline that confidently describes the wrong action.
     */
    summary: row.summary,
    link: scope.link,
    ...(isAdmin ? auditDetail(row.details) : {}),
  }));
}

/** `{ detail }` for an ADMIN, `{}` when there is no payload. See rule 2. */
function auditDetail(details: Prisma.JsonValue | null): { detail?: string } {
  if (details === null || details === undefined) return {};
  const text = JSON.stringify(details);
  if (text === undefined) return {};
  return {
    detail: text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…[truncated]` : text,
  };
}

// ---------------------------------------------------------------------------
// Merge, order, paginate
// ---------------------------------------------------------------------------

/**
 * Newest first, with a DETERMINISTIC tiebreak.
 *
 * The tiebreak is not cosmetic. `paginate` below reasons about groups of entries sharing one
 * timestamp, and two requests that ordered such a group differently could show the same entry
 * on two pages. Comparing the ISO strings is sound because every one of them is produced by
 * `Date.toISOString()`: same length, same zone, so lexical order is chronological order.
 */
function sortNewestFirst(entries: ActivityEntry[]): void {
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
    return 0;
  });
}

/**
 * The page, and the cursor that provably neither skips nor repeats an entry.
 *
 * `before` is a timestamp and the fetch is strict (`createdAt < before`), so the one way a
 * cursor can go wrong is a page boundary falling INSIDE a group of entries that share a
 * timestamp: the next request would ask for everything strictly older and the rest of that
 * group would vanish. Timestamp collisions are not hypothetical here — a release writes a
 * revision row and an audit row from the same request.
 *
 * So the page is cut back to a timestamp boundary. If the entry after the page shares the last
 * returned entry's timestamp, every trailing entry at that timestamp is dropped from this page;
 * the next request, asking for `< lastReturned.at`, then gets the whole group intact.
 *
 * That this is enough relies on every source contributing its newest `limit + 1` candidates:
 * if a source held a further row at the trimmed page's last timestamp, that source would have
 * had to supply `limit + 1` entries at or above it, and they cannot all fit in a page of
 * `limit`. Hence `take: limit + 1` in both unbounded sources and `BOUNDED_CAP > MAX_LIMIT`.
 *
 * The degenerate case — a whole page of entries sharing ONE timestamp, so trimming would leave
 * nothing and the cursor could not advance — returns the page and says in a note that the
 * cursor cannot separate them. An infinite loop would be worse, and a silent one worse still.
 */
function paginate(
  all: ActivityEntry[],
  limit: number,
  notes: string[]
): { entries: ActivityEntry[]; nextBefore: string | null } {
  if (all.length <= limit) return { entries: all, nextBefore: null };

  const boundary = all[limit - 1].at;
  if (all[limit].at !== boundary) {
    notes.push(
      `The window cut this list short at ${limit} entries; ask again with before=${boundary} ` +
        'for what came before it.'
    );
    return { entries: all.slice(0, limit), nextBefore: boundary };
  }

  const trimmed = all.slice(0, limit).filter((entry) => entry.at !== boundary);
  if (trimmed.length === 0) {
    notes.push(
      `More than ${limit} entries share the timestamp ${boundary}, which a timestamp cursor ` +
        'cannot separate; some of them are not listed and will not appear on the next page.'
    );
    return { entries: all.slice(0, limit), nextBefore: boundary };
  }
  const nextBefore = trimmed[trimmed.length - 1].at;
  notes.push(
    `The window cut this list short at ${trimmed.length} entries; ask again with ` +
      `before=${nextBefore} for what came before it.`
  );
  return { entries: trimmed, nextBefore };
}

export interface ActivityQuery {
  subject: ActivitySubjectType;
  id: number;
  limit: number;
  /** Strictly-before cursor. Null for the first page. */
  before: Date | null;
  user: AclUser;
}

/**
 * The whole feature, with no HTTP in it. The route parses the query, calls this, and serialises
 * the result — the same split `lib/changeBrief.ts` and its route use.
 */
export async function buildActivity(query: ActivityQuery): Promise<ActivityFeed> {
  const notes: string[] = [];
  const { before, limit, user } = query;

  // The access check, before anything else is read (rule X3). Not wrapped in `readSource`:
  // a 404 is the answer, not a degraded source.
  const scope = await resolveScope(query.subject, query.id, user, notes);

  // The subject's own dated columns are already in hand; the cursor is applied to them here
  // rather than in SQL because they come from rows that were fetched for their labels too.
  const own = scope.entries.filter(
    (entry) => before === null || new Date(entry.at).getTime() < before.getTime()
  );

  const [comments, audit] = await Promise.all([
    commentEntries(scope, before, limit, notes),
    auditEntries(scope, user, before, limit, notes),
  ]);

  const merged = [...own, ...comments, ...audit];
  sortNewestFirst(merged);
  const { entries, nextBefore } = paginate(merged, limit, notes);

  return {
    subject: { type: scope.type, id: scope.id, label: scope.label, link: scope.link },
    entries,
    nextBefore,
    limit,
    notes,
  };
}
