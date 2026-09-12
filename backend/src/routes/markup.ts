import { Request, Router } from 'express';
import { EcrStatus, MarkupKind, MarkupStatus, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUsers } from '../lib/notify';
import { emitEvent } from '../lib/webhooks';
import { withNumberLock } from '../lib/plm';
import { AclUser, aclFilter } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface MarkupCommentDto {
  id: number;
  body: string;
  createdBy: UserRefDto;
  createdAt: string;
}

interface MarkupDetailDto {
  id: number;
  documentVersionId: number;
  kind: MarkupKind;
  /** Shape depends on kind; see rule K1. Normalized 0-1 for 2D. */
  geometry: Record<string, unknown>;
  status: MarkupStatus;
  createdBy: UserRefDto;
  createdAt: string;
  resolvedBy: UserRefDto | null;
  resolvedAt: string | null;
  ecr: { id: number; ecrNumber: string; status: EcrStatus } | null;
  comments: MarkupCommentDto[];
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const markupInclude = {
  createdBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
  ecr: { select: { id: true, ecrNumber: true, status: true } },
  comments: {
    orderBy: { id: 'asc' as const },
    include: { createdBy: { select: { id: true, name: true } } },
  },
} satisfies Prisma.MarkupInclude;

type MarkupRow = Prisma.MarkupGetPayload<{ include: typeof markupInclude }>;
type MarkupCommentRow = MarkupRow['comments'][number];

/**
 * Prisma types a Json column as JsonValue, but rule K1 only ever stores an object (`{}` for a
 * NOTE). Anything else is data written outside this router, and a wire contract promising an
 * object must not hand the viewer an array or a scalar.
 */
function toGeometry(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toMarkupComment(comment: MarkupCommentRow): MarkupCommentDto {
  return {
    id: comment.id,
    body: comment.body,
    createdBy: { id: comment.createdBy.id, name: comment.createdBy.name },
    createdAt: comment.createdAt.toISOString(),
  };
}

function toMarkupDetail(markup: MarkupRow): MarkupDetailDto {
  return {
    id: markup.id,
    documentVersionId: markup.documentVersionId,
    kind: markup.kind,
    geometry: toGeometry(markup.geometry),
    status: markup.status,
    createdBy: { id: markup.createdBy.id, name: markup.createdBy.name },
    createdAt: markup.createdAt.toISOString(),
    resolvedBy: markup.resolvedBy
      ? { id: markup.resolvedBy.id, name: markup.resolvedBy.name }
      : null,
    resolvedAt: markup.resolvedAt ? markup.resolvedAt.toISOString() : null,
    ecr: markup.ecr
      ? { id: markup.ecr.id, ecrNumber: markup.ecr.ecrNumber, status: markup.ecr.status }
      : null,
    comments: markup.comments.map(toMarkupComment),
  };
}

/**
 * Item-level access (rules X2-X3): a markup lives on a document version, so it is exactly as
 * visible as its document — resolved through the document's read filter, 404ing with the
 * markup's own message. Commentary needs no WRITE grant: annotating and discussing is what a
 * READ-grant reviewer is for; the author/admin rule still governs edits and deletes.
 */
function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function documentAcl(user: AclUser): Prisma.DocumentWhereInput {
  return aclFilter('DOCUMENT', user) as Prisma.DocumentWhereInput;
}

/** The markup-side read gate, spread into every markup lookup in this file. */
function visibleMarkup(user: AclUser): Prisma.MarkupWhereInput {
  return { documentVersion: { document: documentAcl(user) } };
}

async function getMarkupOrThrow(id: number, user: AclUser): Promise<MarkupDetailDto> {
  const markup = await prisma.markup.findFirst({
    where: { id, ...visibleMarkup(user) },
    include: markupInclude,
  });
  if (!markup) throw new HttpError(404, 'Markup not found');
  return toMarkupDetail(markup);
}

const versionSelect = {
  id: true,
  version: true,
  fileName: true,
  document: { select: { id: true, docNumber: true, title: true } },
} satisfies Prisma.DocumentVersionSelect;

type VersionRow = Prisma.DocumentVersionGetPayload<{ select: typeof versionSelect }>;

async function getVersionOrThrow(id: number, user: AclUser): Promise<VersionRow> {
  const version = await prisma.documentVersion.findFirst({
    where: { id, document: documentAcl(user) },
    select: versionSelect,
  });
  if (!version) throw new HttpError(404, 'Document version not found');
  return version;
}

/** Where a markup notification sends the recipient: the document page hosts the viewer. */
function markupLink(documentId: number): string {
  return `/documents/${documentId}`;
}

/** "DOC-1001 Frame drawing v3" — enough context for a notification title. */
function versionLabel(version: VersionRow): string {
  return `${version.document.docNumber} ${version.document.title} v${version.version}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseEnum<T extends Record<string, string>>(
  value: unknown,
  enumObj: T,
  label: string
): T[keyof T] {
  const values = Object.values(enumObj);
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new HttpError(400, `${label} must be one of ${values.join(', ')}`);
  }
  return value as T[keyof T];
}

const COMMENT_MAX = 4000;

/** Rule K2 — an anchor with nothing said is noise, so a comment body is never optional. */
function requireCommentBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'body is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > COMMENT_MAX) {
    throw new HttpError(400, `body must be at most ${COMMENT_MAX} characters`);
  }
  return trimmed;
}

function assertAuthorOrAdmin(req: Request, authorId: number, verb: string): void {
  if (authorId !== currentUserId(req) && req.user?.role !== Role.ADMIN) {
    throw new HttpError(403, `Only the author or an administrator can ${verb} this markup`);
  }
}

// ---------------------------------------------------------------------------
// Geometry validation (rule K1)
//
// The shape is fixed per kind and is checked strictly: a missing key is named, and a
// normalized coordinate outside 0-1 is refused rather than clamped. Clamping would move
// somebody's markup to a place they never pointed at, and they would never be told.
// ---------------------------------------------------------------------------

/** A 3D coordinate is in model space, so it has no range — only a shape. */
function requireVec3(value: unknown, key: string): [number, number, number] {
  if (value === undefined || value === null) {
    throw new HttpError(400, `geometry.${key} is required for ${MarkupKind.PIN_3D}`);
  }
  if (!Array.isArray(value) || value.length !== 3) {
    throw new HttpError(400, `geometry.${key} must be an array of 3 numbers [x, y, z]`);
  }
  const nums = value.map((entry, i) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new HttpError(400, `geometry.${key}[${i}] must be a finite number`);
    }
    return entry;
  });
  return [nums[0], nums[1], nums[2]];
}

function requireNormalized(value: unknown, key: string, kind: MarkupKind): number {
  if (value === undefined || value === null) {
    throw new HttpError(400, `geometry.${key} is required for ${kind}`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `geometry.${key} must be a number for ${kind}`);
  }
  if (value < 0 || value > 1) {
    throw new HttpError(
      400,
      `geometry.${key} must be between 0 and 1 — normalized coordinates are refused, not clamped`
    );
  }
  return value;
}

function requirePage(value: unknown, kind: MarkupKind): number {
  if (value === undefined || value === null) {
    throw new HttpError(400, `geometry.page is required for ${kind}`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `geometry.page must be an integer of 1 or more for ${kind}`);
  }
  return value;
}

/**
 * Validate `geometry` against `kind` and return the canonical object to store. Only the keys
 * the contract fixes are kept: an unknown key is dropped rather than persisted, so a viewer
 * reading a markup back can rely on the documented shape.
 *
 * `pageInput` is the request's top-level `page`. It fills in a missing `geometry.page` (the 2D
 * viewer knows the page it is on independently of the click coordinates) but a `page` that
 * contradicts `geometry.page` is refused — guessing which one meant it is how a markup ends up
 * anchored to the wrong sheet.
 */
function parseGeometry(kind: MarkupKind, raw: unknown, pageInput: unknown): Prisma.InputJsonObject {
  // A NOTE is a version-level remark with no position; whatever was sent is not a position.
  if (kind === MarkupKind.NOTE) return {};

  if (raw === undefined || raw === null) throw new HttpError(400, `geometry is required for ${kind}`);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'geometry must be a JSON object');
  }
  const geometry = raw as Record<string, unknown>;

  if (kind === MarkupKind.PIN_3D) {
    // The camera is not decoration: without it "look at what I was looking at" cannot work,
    // so a pin missing it is incomplete rather than merely sparse.
    const camera = geometry.camera;
    if (camera === undefined || camera === null) {
      throw new HttpError(400, `geometry.camera is required for ${MarkupKind.PIN_3D}`);
    }
    if (typeof camera !== 'object' || Array.isArray(camera)) {
      throw new HttpError(400, 'geometry.camera must be a JSON object');
    }
    const cam = camera as Record<string, unknown>;
    return {
      point: requireVec3(geometry.point, 'point'),
      camera: {
        position: requireVec3(cam.position, 'camera.position'),
        target: requireVec3(cam.target, 'camera.target'),
      },
    };
  }

  let page = geometry.page;
  if (pageInput !== undefined && pageInput !== null) {
    const fromBody = requirePage(pageInput, kind);
    if (page === undefined || page === null) page = fromBody;
    else if (page !== fromBody) {
      throw new HttpError(400, 'page and geometry.page disagree — send one of them');
    }
  }

  const anchor = {
    page: requirePage(page, kind),
    x: requireNormalized(geometry.x, 'x', kind),
    y: requireNormalized(geometry.y, 'y', kind),
  };
  if (kind === MarkupKind.POINT_2D) return anchor;

  // A BOX_2D with no extent is a point, not a box, so w/h are required here even though the
  // shared 2D shape marks them optional (they do not apply to POINT_2D at all).
  return {
    ...anchor,
    w: requireNormalized(geometry.w, 'w', kind),
    h: requireNormalized(geometry.h, 'h', kind),
  };
}

// ---------------------------------------------------------------------------
// GET /document-versions/:id/markups — oldest first, with each thread (rule K2)
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/markups',
  asyncHandler(async (req, res) => {
    const documentVersionId = idParam(req.params.id);
    const statusRaw =
      typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(Object.values(MarkupStatus) as string[]).includes(statusRaw)) {
      throw new HttpError(400, 'Invalid status filter');
    }

    // A bogus version id is a 404, not an empty list: the caller must not read "no markups"
    // as "nothing to discuss" when it actually asked about something that does not exist.
    const user = aclUser(req);
    await getVersionOrThrow(documentVersionId, user);

    const markups = await prisma.markup.findMany({
      where: {
        documentVersionId,
        ...(statusRaw ? { status: statusRaw as MarkupStatus } : {}),
      },
      orderBy: { id: 'asc' },
      include: markupInclude,
    });
    res.json(markups.map(toMarkupDetail));
  })
);

// ---------------------------------------------------------------------------
// POST /document-versions/:id/markups — anchor + opening comment (rules K1, K2)
// ---------------------------------------------------------------------------

router.post(
  '/document-versions/:id/markups',
  asyncHandler(async (req, res) => {
    const documentVersionId = idParam(req.params.id);
    const userId = currentUserId(req);
    const body = bodyOf(req);

    const user = aclUser(req);
    const kind = parseEnum(body.kind, MarkupKind, 'kind');
    const geometry = parseGeometry(kind, body.geometry, body.page);
    const openingBody = requireCommentBody(body.body);

    // Rule K1 — a markup belongs to a version, never to a document: a comment about geometry
    // is about that geometry and must not silently follow a new upload.
    await getVersionOrThrow(documentVersionId, user);

    // The anchor and its opening comment are one act, so they commit or fail together.
    const created = await prisma.$transaction(async (tx) => {
      const markup = await tx.markup.create({
        data: { documentVersionId, kind, geometry, createdById: userId },
        select: { id: true },
      });
      await tx.markupComment.create({
        data: { markupId: markup.id, body: openingBody, createdById: userId },
      });
      return markup;
    });

    res.status(201).json(await getMarkupOrThrow(created.id, user));
  })
);

// ---------------------------------------------------------------------------
// PATCH /markups/:id — geometry and the opening comment (author or ADMIN)
// ---------------------------------------------------------------------------

router.patch(
  '/markups/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = bodyOf(req);

    const user = aclUser(req);
    const markup = await prisma.markup.findFirst({
      where: { id, ...visibleMarkup(user) },
      select: {
        id: true,
        kind: true,
        createdById: true,
        comments: { orderBy: { id: 'asc' }, take: 1, select: { id: true } },
      },
    });
    if (!markup) throw new HttpError(404, 'Markup not found');
    assertAuthorOrAdmin(req, markup.createdById, 'edit');

    // The kind is fixed at creation: changing it would reinterpret coordinates that were
    // captured in a different space, so a different anchor is a different markup.
    const geometry =
      body.geometry === undefined ? null : parseGeometry(markup.kind, body.geometry, body.page);
    const openingBody = body.body === undefined ? null : requireCommentBody(body.body);
    if (geometry === null && openingBody === null) {
      throw new HttpError(400, 'Provide geometry or body to update');
    }
    const opening = markup.comments[0];
    if (openingBody !== null && !opening) {
      throw new HttpError(409, 'This markup has no opening comment to edit');
    }

    await prisma.$transaction(async (tx) => {
      if (geometry !== null) await tx.markup.update({ where: { id }, data: { geometry } });
      if (openingBody !== null && opening) {
        await tx.markupComment.update({ where: { id: opening.id }, data: { body: openingBody } });
      }
    });

    res.json(await getMarkupOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /markups/:id — author or ADMIN; the thread goes with it
// ---------------------------------------------------------------------------

router.delete(
  '/markups/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);

    const markup = await prisma.markup.findFirst({
      where: { id, ...visibleMarkup(aclUser(req)) },
      select: { id: true, createdById: true },
    });
    if (!markup) throw new HttpError(404, 'Markup not found');
    assertAuthorOrAdmin(req, markup.createdById, 'delete');

    // MarkupComment cascades on markupId, so the thread is removed with the anchor. An
    // escalated markup may still be deleted: rule K2's ECR carries a copy of the thread in
    // its description precisely so the change request survives the markup.
    await prisma.markup.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /markups/:id/comments — any write-role user (rules K2, K3)
// ---------------------------------------------------------------------------

router.post(
  '/markups/:id/comments',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const commentBody = requireCommentBody(bodyOf(req).body);

    const markup = await prisma.markup.findFirst({
      where: { id, ...visibleMarkup(aclUser(req)) },
      select: {
        id: true,
        createdById: true,
        comments: { select: { createdById: true } },
        documentVersion: { select: versionSelect },
      },
    });
    if (!markup) throw new HttpError(404, 'Markup not found');

    const comment = await prisma.markupComment.create({
      data: { markupId: id, body: commentBody, createdById: userId },
      include: { createdBy: { select: { id: true, name: true } } },
    });

    // Rule K3 — the author and every prior commenter, minus the actor (notifyUsers dedupes
    // and skips them). Delivered after the write and outside any transaction, so a failing
    // notification cannot roll back a comment somebody already believes they posted.
    try {
      await notifyUsers(
        prisma,
        [markup.createdById, ...markup.comments.map((prior) => prior.createdById)],
        userId,
        {
          type: 'MARKUP_COMMENTED',
          title: `${req.user?.name ?? 'Someone'} commented on a markup on ${versionLabel(
            markup.documentVersion
          )}`,
          body: commentBody,
          link: markupLink(markup.documentVersion.document.id),
        }
      );
    } catch (err) {
      console.error('Failed to deliver MARKUP_COMMENTED notification', err);
    }

    res.status(201).json(toMarkupComment(comment));
  })
);

// ---------------------------------------------------------------------------
// POST /markups/:id/transition — resolve / wont-fix / reopen (rule K2)
// ---------------------------------------------------------------------------

type MarkupAction = 'resolve' | 'wont-fix' | 'reopen';

const TRANSITIONS: Record<MarkupAction, { from: MarkupStatus[]; to: MarkupStatus }> = {
  resolve: { from: [MarkupStatus.OPEN], to: MarkupStatus.RESOLVED },
  'wont-fix': { from: [MarkupStatus.OPEN], to: MarkupStatus.WONT_FIX },
  reopen: { from: [MarkupStatus.RESOLVED, MarkupStatus.WONT_FIX], to: MarkupStatus.OPEN },
};

router.post(
  '/markups/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const body = bodyOf(req);

    const actions = Object.keys(TRANSITIONS);
    if (typeof body.action !== 'string' || !actions.includes(body.action)) {
      throw new HttpError(400, `action must be one of ${actions.join(', ')}`);
    }
    const action = body.action as MarkupAction;
    const transition = TRANSITIONS[action];

    const user = aclUser(req);
    const markup = await prisma.markup.findFirst({
      where: { id, ...visibleMarkup(user) },
      select: {
        id: true,
        status: true,
        createdById: true,
        comments: { orderBy: { id: 'asc' }, take: 1, select: { body: true } },
        documentVersion: { select: versionSelect },
      },
    });
    if (!markup) throw new HttpError(404, 'Markup not found');
    if (!transition.from.includes(markup.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: markup #${id} is ${markup.status} (requires ${transition.from.join(
          ' or '
        )})`
      );
    }

    const closing = transition.to !== MarkupStatus.OPEN;
    const updated = await prisma.markup.updateMany({
      where: { id, status: markup.status },
      data: {
        status: transition.to,
        // Reopening clears the disposition: who resolved it last is no longer true of it.
        resolvedById: closing ? userId : null,
        resolvedAt: closing ? new Date() : null,
      },
    });
    if (updated.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: markup #${id} was changed concurrently — reload and try again`
      );
    }

    // Rule K3 — resolving tells the author their point was dealt with. Outside the write for
    // the same reason as the comment path.
    if (action === 'resolve') {
      try {
        await notifyUsers(prisma, [markup.createdById], userId, {
          type: 'MARKUP_RESOLVED',
          title: `${req.user?.name ?? 'Someone'} resolved your markup on ${versionLabel(
            markup.documentVersion
          )}`,
          body: markup.comments[0]?.body ?? null,
          link: markupLink(markup.documentVersion.document.id),
        });
      } catch (err) {
        console.error('Failed to deliver MARKUP_RESOLVED notification', err);
      }
    }

    res.json(await getMarkupOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// POST /markups/:id/escalate — from "that hole is wrong" to a governed change (rule K2)
// ---------------------------------------------------------------------------

const ECR_TITLE_MAX = 120;

/**
 * The ECR title is the opening comment on one line, cut on a word boundary. The full text is
 * repeated in the description, so the title only has to be recognizable in a list.
 */
function summarizeTitle(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= ECR_TITLE_MAX) return oneLine;
  const cut = oneLine.slice(0, ECR_TITLE_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

router.post(
  '/markups/:id/escalate',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);
    const user = aclUser(req);

    const markup = await prisma.markup.findFirst({
      where: { id, ...visibleMarkup(user) },
      include: {
        comments: {
          orderBy: { id: 'asc' },
          include: { createdBy: { select: { name: true } } },
        },
        documentVersion: {
          select: {
            id: true,
            version: true,
            fileName: true,
            document: {
              select: {
                id: true,
                docNumber: true,
                title: true,
                links: { select: { partId: true, partRevision: { select: { partId: true } } } },
              },
            },
          },
        },
      },
    });
    if (!markup) throw new HttpError(404, 'Markup not found');
    if (markup.ecrId !== null) throw new HttpError(409, 'This markup already has an ECR');
    const opening = markup.comments[0];
    if (!opening) {
      throw new HttpError(409, 'This markup has no comment to raise a change request from');
    }

    const version = markup.documentVersion;
    const doc = version.document;
    const title = summarizeTitle(opening.body);

    // The whole thread goes into the description, not a link to it: the ECR outlives the
    // markup (which its author may delete) and a change request that cannot be read on its
    // own is not a record of anything.
    const description = [
      `Raised from design review markup #${markup.id} (${markup.kind}) on ${doc.docNumber} ` +
        `${doc.title} v${version.version} — ${version.fileName}.`,
      `Document version ${version.id}: ${markupLink(doc.id)}`,
      `Anchor: ${JSON.stringify(toGeometry(markup.geometry))}`,
      '',
      'Review thread:',
      ...markup.comments.map(
        (comment) =>
          `- ${comment.createdBy.name} (${comment.createdAt.toISOString()}): ${comment.body}`
      ),
    ].join('\n');

    // Carry the affected part over only when the document points at exactly one — that makes
    // the ECR actionable (POST /ecrs/:id/accept builds the ECN item from it). More than one
    // linked part is a guess, and guessing the subject of a change request is worse than
    // leaving it for the reviewer to set.
    const linkedPartIds = [
      ...new Set(
        doc.links
          .map((link) => link.partId ?? link.partRevision?.partId ?? null)
          .filter((partId): partId is number => partId !== null)
      ),
    ];
    const partId = linkedPartIds.length === 1 ? linkedPartIds[0] : null;

    // Same scan-max numbering the ECR create path uses, under the same lock. The retry re-runs
    // the whole transaction: a P2002 raised inside one aborts it, so retrying in place cannot
    // work — the surrounding Postgres transaction is already dead.
    const raiseEcr = async (): Promise<{ id: number; ecrNumber: string }> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await withNumberLock(async (tx) => {
            const rows = await tx.$queryRaw<{ max: number | null }[]>`
              SELECT MAX(SUBSTRING("ecrNumber" FROM 5)::int) AS max
              FROM "Ecr"
              WHERE "ecrNumber" ~ '^ECR-[0-9]{1,9}$'`;
            const ecrNumber = `ECR-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;

            const ecr = await tx.ecr.create({
              data: { ecrNumber, title, description, partId, createdById: userId },
              select: { id: true, ecrNumber: true },
            });

            // Claim the markup conditionally. Two concurrent escalations would otherwise each
            // raise an ECR and one would be orphaned; throwing here rolls this one back.
            const linked = await tx.markup.updateMany({
              where: { id, ecrId: null },
              data: { ecrId: ecr.id },
            });
            if (linked.count === 0) {
              throw new HttpError(
                409,
                `Cannot escalate: markup #${id} was changed concurrently — reload and try again`
              );
            }
            return ecr;
          });
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    };
    const created = await raiseEcr();

    // ECR_RAISED to every admin and the markup's author, exactly as POST /ecrs does; outside
    // the transaction, so a delivery failure cannot undo the escalation.
    try {
      const admins = await prisma.user.findMany({
        where: { role: Role.ADMIN },
        select: { id: true },
      });
      await notifyUsers(
        prisma,
        [...admins.map((admin) => admin.id), markup.createdById],
        userId,
        {
          type: 'ECR_RAISED',
          title: `${req.user?.name ?? 'Someone'} raised ${created.ecrNumber} from a markup on ${
            doc.docNumber
          }`,
          body: title,
          link: `/ecrs/${created.id}`,
        }
      );
    } catch (err) {
      console.error('Failed to deliver ECR_RAISED notification', err);
    }

    // Rule I2 — an ECR raised here must appear in the event stream like any other, or an
    // integration reading ecr.raised silently misses it.
    try {
      await emitEvent(prisma, 'ecr.raised', {
        ecrId: created.id,
        ecrNumber: created.ecrNumber,
        title,
        markupId: markup.id,
        documentVersionId: version.id,
      });
    } catch (err) {
      console.error('Failed to queue ecr.raised webhook', err);
    }

    res.json(await getMarkupOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// GET /my-markups — still-open points the caller opened or joined (rule K2)
// ---------------------------------------------------------------------------

router.get(
  '/my-markups',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const markups = await prisma.markup.findMany({
      where: {
        status: MarkupStatus.OPEN,
        OR: [{ createdById: userId }, { comments: { some: { createdById: userId } } }],
        // A worklist must not resurface threads on documents the caller has since lost.
        // Its own key, so it ANDs with the participation OR above instead of colliding.
        ...visibleMarkup(aclUser(req)),
      },
      // Newest first: this is a worklist, and the point raised today is the one still in mind.
      orderBy: { id: 'desc' },
      include: markupInclude,
    });
    res.json(markups.map(toMarkupDetail));
  })
);

export default router;
