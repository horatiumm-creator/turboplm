import { Request, Router } from 'express';
import { DocumentCategory, Prisma } from '@prisma/client';
import { ConversionStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { absoluteStoragePath, removeStoredFile, uploadSingle } from '../middleware/upload';
import { emitEvent } from '../lib/webhooks';
import { extractCadStructure, readAssembly, scrubHiddenMatches } from '../lib/cad';
import { notifyUsers } from '../lib/notify';
import { lockNumbering } from '../lib/plm';
import {
  AclUser,
  aclFilter,
  assertCanRead,
  assertCanWrite,
  REDACTED,
  visibleIds,
} from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface DocumentVersionDto {
  id: number;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: UserRefDto;
  createdAt: string;
  conversionStatus: ConversionStatus;
  conversionError: string | null;
  hasGlb: boolean;
  triangleCount: number | null;
  boundingBox: { min: number[]; max: number[]; size: number[] } | null;
}

/** Rule D1 — the vault lock, resolved server-side so the UI needs no clock logic. */
interface DocumentLockDto {
  user: UserRefDto;
  lockedAt: string;
  expiresAt: string | null;
  note: string | null;
  /** The caller holds it. */
  isMine: boolean;
  /** Past expiresAt: anyone may take it. */
  expired: boolean;
}

interface DocumentSummaryDto {
  id: number;
  docNumber: string;
  title: string;
  category: DocumentCategory;
  description: string | null;
  createdBy: UserRefDto;
  createdAt: string;
  versionCount: number;
  latestVersion: DocumentVersionDto | null;
  /**
   * Rule D2 puts this on DocumentDetail; it lives on the summary because rule D3's
   * vault-wide lock column is rendered from the list endpoint, which would otherwise
   * need one detail call per row.
   */
  lock: DocumentLockDto | null;
}

interface DocumentLinkDto {
  id: number;
  target: { type: 'PART' | 'REVISION' | 'ECN'; id: number; label: string };
}

interface DocumentDetailDto extends DocumentSummaryDto {
  /** Newest first. */
  versions: DocumentVersionDto[];
  links: DocumentLinkDto[];
}

interface EntityDocumentDto {
  linkId: number;
  document: DocumentSummaryDto;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const documentVersionInclude = {
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.DocumentVersionInclude;

const documentLinkInclude = {
  part: { select: { id: true, partNumber: true } },
  // `partId` is selected because a revision carries no grants of its own — it is as visible as
  // its part, and that is the id the redaction check below needs (rule X3).
  partRevision: {
    select: { id: true, revision: true, partId: true, part: { select: { partNumber: true } } },
  },
  ecn: { select: { id: true, ecnNumber: true } },
} satisfies Prisma.DocumentLinkInclude;

const documentSummaryInclude = {
  createdBy: { select: { id: true, name: true } },
  lockedBy: { select: { id: true, name: true } },
  versions: { orderBy: { version: 'desc' as const }, take: 1, include: documentVersionInclude },
  _count: { select: { versions: true } },
} satisfies Prisma.DocumentInclude;

const documentDetailInclude = {
  createdBy: { select: { id: true, name: true } },
  lockedBy: { select: { id: true, name: true } },
  versions: { orderBy: { version: 'desc' as const }, include: documentVersionInclude },
  links: { orderBy: { id: 'asc' as const }, include: documentLinkInclude },
} satisfies Prisma.DocumentInclude;

type DocumentVersionRow = Prisma.DocumentVersionGetPayload<{
  include: typeof documentVersionInclude;
}>;
type DocumentLinkRow = Prisma.DocumentLinkGetPayload<{ include: typeof documentLinkInclude }>;
type DocumentSummaryRow = Prisma.DocumentGetPayload<{ include: typeof documentSummaryInclude }>;
type DocumentDetailRow = Prisma.DocumentGetPayload<{ include: typeof documentDetailInclude }>;

function toVersion(version: DocumentVersionRow): DocumentVersionDto {
  return {
    id: version.id,
    version: version.version,
    fileName: version.fileName,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    note: version.note,
    uploadedBy: { id: version.uploadedBy.id, name: version.uploadedBy.name },
    createdAt: version.createdAt.toISOString(),
    conversionStatus: version.conversionStatus,
    conversionError: version.conversionError,
    hasGlb: version.glbPath !== null,
    triangleCount: version.triangleCount,
    boundingBox: parseBoundingBox(version.boundingBox),
  };
}

/** The stored Json is written by the CAD service; validate its shape defensively. */
function parseBoundingBox(value: unknown): { min: number[]; max: number[]; size: number[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const box = value as Record<string, unknown>;
  const numbers = (v: unknown): number[] | null =>
    Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : null;
  const min = numbers(box.min);
  const max = numbers(box.max);
  const size = numbers(box.size);
  return min && max && size ? { min, max, size } : null;
}

/**
 * Link labels: PART → partNumber; REVISION → `<partNumber> rev <rev>`; ECN → ecnNumber.
 *
 * A link target is a part, a revision's part or an ECN — three of the five protected types,
 * reached as a sub-object of a document the caller may well be allowed to read. The label *is*
 * the identity, so a target the caller cannot read keeps its row and loses its label (rule X4):
 * the document's owner still learns that something is attached, and can unlink it, without
 * learning what. `target.id` stays because `DocumentLinkDetail` types it `number` — the frozen
 * shape has no null to put there, and a surrogate id on its own discloses nothing the caller
 * cannot already probe for (the probe answers with the same 404 as a nonexistent item).
 */
function toLink(
  link: DocumentLinkRow,
  visibleParts: Set<number>,
  visibleEcns: Set<number>
): DocumentLinkDto {
  if (link.part) {
    const label = visibleParts.has(link.part.id) ? link.part.partNumber : REDACTED.name;
    return { id: link.id, target: { type: 'PART', id: link.part.id, label } };
  }
  if (link.partRevision) {
    const revision = link.partRevision;
    return {
      id: link.id,
      target: {
        type: 'REVISION',
        id: revision.id,
        label: visibleParts.has(revision.partId)
          ? `${revision.part.partNumber} rev ${revision.revision}`
          : REDACTED.name,
      },
    };
  }
  if (link.ecn) {
    const label = visibleEcns.has(link.ecn.id) ? link.ecn.ecnNumber : REDACTED.name;
    return { id: link.id, target: { type: 'ECN', id: link.ecn.id, label } };
  }
  // Unreachable: exactly one target is enforced on create.
  throw new Error(`DocumentLink ${link.id} has no target`);
}

/**
 * Two `visibleIds` calls for the whole link list rather than one check per link: a document with
 * twenty attachments must not cost twenty queries, and `visibleIds` asks nothing at all when the
 * list holds no target of that type.
 */
async function toLinks(links: DocumentLinkRow[], viewer: AclUser): Promise<DocumentLinkDto[]> {
  const partIds: number[] = [];
  const ecnIds: number[] = [];
  for (const link of links) {
    if (link.part) partIds.push(link.part.id);
    else if (link.partRevision) partIds.push(link.partRevision.partId);
    else if (link.ecn) ecnIds.push(link.ecn.id);
  }
  const [visibleParts, visibleEcns] = await Promise.all([
    visibleIds('PART', partIds, viewer),
    visibleIds('ECN', ecnIds, viewer),
  ]);
  return links.map((link) => toLink(link, visibleParts, visibleEcns));
}

// ---------------------------------------------------------------------------
// Vault locks (rules D1/D2)
// ---------------------------------------------------------------------------

/** Rule D1 — a check-out reserves the next version for seven days. */
const LOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The lock columns, as read by both the mappers and the lock endpoints. */
interface LockFields {
  lockedById: number | null;
  lockedBy: UserRefDto | null;
  lockedAt: Date | null;
  lockExpiresAt: Date | null;
  lockNote: string | null;
}

/**
 * A lock with no expiry never lapses; one whose expiry has passed may be taken by anyone.
 * Computed here rather than in the UI so a client with a skewed clock cannot disagree with
 * the server about who is allowed to check out.
 */
function lockExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

function toLock(doc: LockFields, viewerId: number, now: Date = new Date()): DocumentLockDto | null {
  // lockedAt/lockedBy are written together with lockedById; the guard keeps the DTO honest
  // rather than asserting non-null on three columns the database allows to be null.
  if (doc.lockedById === null || doc.lockedBy === null || doc.lockedAt === null) return null;
  return {
    user: { id: doc.lockedBy.id, name: doc.lockedBy.name },
    lockedAt: doc.lockedAt.toISOString(),
    expiresAt: doc.lockExpiresAt === null ? null : doc.lockExpiresAt.toISOString(),
    note: doc.lockNote,
    isMine: doc.lockedById === viewerId,
    expired: lockExpired(doc.lockExpiresAt, now),
  };
}

function toDocumentSummary(doc: DocumentSummaryRow, viewerId: number): DocumentSummaryDto {
  const latest = doc.versions[0];
  return {
    id: doc.id,
    docNumber: doc.docNumber,
    title: doc.title,
    category: doc.category,
    description: doc.description,
    createdBy: { id: doc.createdBy.id, name: doc.createdBy.name },
    createdAt: doc.createdAt.toISOString(),
    versionCount: doc._count.versions,
    latestVersion: latest ? toVersion(latest) : null,
    lock: toLock(doc, viewerId),
  };
}

/** Async only because the link targets have to be checked against the caller's access. */
async function toDocumentDetail(
  doc: DocumentDetailRow,
  viewer: AclUser
): Promise<DocumentDetailDto> {
  const latest = doc.versions[0]; // ordered version desc → highest version first
  return {
    id: doc.id,
    docNumber: doc.docNumber,
    title: doc.title,
    category: doc.category,
    description: doc.description,
    createdBy: { id: doc.createdBy.id, name: doc.createdBy.name },
    createdAt: doc.createdAt.toISOString(),
    versionCount: doc.versions.length,
    latestVersion: latest ? toVersion(latest) : null,
    versions: doc.versions.map(toVersion),
    links: await toLinks(doc.links, viewer),
    lock: toLock(doc, viewer.id),
  };
}

/**
 * Every route in this file that answers with a document detail goes through here, so the acl
 * filter lives on the fetch itself (`findFirst`, since `findUnique` cannot take a filter). The
 * write paths still assert access up front — an error raised after a mutation would be too late
 * — but a route added later that forgets to cannot leak a restricted document through this
 * helper, and the 404 is the same one a deleted document gets.
 */
async function getDocumentDetailOrThrow(id: number, viewer: AclUser): Promise<DocumentDetailDto> {
  const doc = await prisma.document.findFirst({
    where: { id, ...aclFilter('DOCUMENT', viewer) },
    include: documentDetailInclude,
  });
  if (!doc) throw new HttpError(404, 'Document not found');
  return toDocumentDetail(doc, viewer);
}

const lockStateSelect = {
  id: true,
  docNumber: true,
  lockedById: true,
  lockedBy: { select: { id: true, name: true } },
  lockedAt: true,
  lockExpiresAt: true,
  lockNote: true,
} satisfies Prisma.DocumentSelect;

type LockStateRow = Prisma.DocumentGetPayload<{ select: typeof lockStateSelect }>;

/**
 * Filtered like the detail fetch: the lock state carries the document number and the holder's
 * name, which is more than a caller who may not read the document should learn from a 409.
 */
async function getLockStateOrThrow(id: number, viewer: AclUser): Promise<LockStateRow> {
  const doc = await prisma.document.findFirst({
    where: { id, ...aclFilter('DOCUMENT', viewer) },
    select: lockStateSelect,
  });
  if (!doc) throw new HttpError(404, 'Document not found');
  return doc;
}

/** Clearing every lock column together — a half-released lock has no meaning. */
const RELEASED_LOCK = {
  lockedById: null,
  lockedAt: null,
  lockExpiresAt: null,
} satisfies Prisma.DocumentUncheckedUpdateManyInput;

/**
 * A lost race for the lock. Every claim below is a conditional update, so a zero count means
 * someone else got there first: report who actually holds it, since "reload and try again"
 * on its own leaves the user guessing.
 */
async function throwLockRace(id: number, docNumber: string): Promise<never> {
  const current = await prisma.document.findUnique({
    where: { id },
    select: { lockedBy: { select: { name: true } } },
  });
  if (current?.lockedBy) {
    throw new HttpError(409, `${docNumber} is checked out by ${current.lockedBy.name}`);
  }
  throw new HttpError(409, `${docNumber} was changed concurrently — reload and try again`);
}

/**
 * Release someone's lock (cancel-checkout, break-lock). The holder is told in the same
 * transaction as the release: a lock that disappears without a word is exactly the silent
 * failure rule D1 forbids, and a notification written afterwards can be lost.
 *
 * `reason` is kept in `lockNote` after the release so the audit trail explains itself; the
 * next check-out overwrites it.
 */
async function releaseLock(params: {
  id: number;
  docNumber: string;
  holder: UserRefDto;
  actorId: number;
  actorName: string;
  reason: string | null;
}): Promise<void> {
  const { id, docNumber, holder, actorId, actorName, reason } = params;
  await prisma.$transaction(async (tx) => {
    const released = await tx.document.updateMany({
      where: { id, lockedById: holder.id },
      data: { ...RELEASED_LOCK, lockNote: reason },
    });
    if (released.count === 0) {
      throw new HttpError(409, `${docNumber} was changed concurrently — reload and try again`);
    }
    await notifyUsers(tx, [holder.id], actorId, {
      type: 'DOCUMENT_LOCK_BROKEN',
      title: `${actorName} released your check-out of ${docNumber}`,
      body: reason,
      link: `/documents/${id}`,
    });
  });
}


// ---------------------------------------------------------------------------
// CAD conversion (rule Q1) — delegated to the `cad` sidecar so the OpenCascade
// kernel never blocks this process.
// ---------------------------------------------------------------------------

const CAD_SERVICE_URL = process.env.CAD_SERVICE_URL || 'http://cad:4100';
const CONVERTIBLE = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp']);

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function isConvertible(fileName: string): boolean {
  return CONVERTIBLE.has(fileExtension(fileName));
}

interface ConversionResponse {
  status?: string;
  glbPath?: string;
  triangleCount?: number;
  boundingBox?: unknown;
  error?: string;
  reason?: string;
}

/**
 * Convert one stored version and persist the outcome. Never throws: a failure
 * is recorded on the row so the upload itself is unaffected.
 */
async function runConversion(versionId: number, storagePath: string, fileName: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${CAD_SERVICE_URL}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath, fileName }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`CAD service responded ${res.status}`);
    const result = (await res.json()) as ConversionResponse;

    if (result.status === 'DONE' && typeof result.glbPath === 'string') {
      await prisma.documentVersion.update({
        where: { id: versionId },
        data: {
          conversionStatus: ConversionStatus.DONE,
          conversionError: null,
          glbPath: result.glbPath,
          triangleCount:
            typeof result.triangleCount === 'number' ? Math.round(result.triangleCount) : null,
          boundingBox: (result.boundingBox ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      return;
    }
    if (result.status === 'SKIPPED') {
      await prisma.documentVersion.update({
        where: { id: versionId },
        data: { conversionStatus: ConversionStatus.SKIPPED, conversionError: null },
      });
      return;
    }
    await prisma.documentVersion.update({
      where: { id: versionId },
      data: {
        conversionStatus: ConversionStatus.FAILED,
        conversionError: (result.error || 'Conversion failed').slice(0, 400),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Conversion failed';
    await prisma.documentVersion
      .update({
        where: { id: versionId },
        data: { conversionStatus: ConversionStatus.FAILED, conversionError: message.slice(0, 400) },
      })
      .catch((updateErr) => console.error('Could not record conversion failure:', updateErr));
  } finally {
    clearTimeout(timeout);
  }
}

/** Fire-and-forget conversion for the newest version of a document. */
async function queueConversion(documentId: number): Promise<void> {
  const version = await prisma.documentVersion.findFirst({
    where: { documentId },
    orderBy: { version: 'desc' },
    select: { id: true, storagePath: true, fileName: true, conversionStatus: true },
  });
  if (!version || version.conversionStatus !== ConversionStatus.PENDING) return;
  void runConversion(version.id, version.storagePath, version.fileName).catch((err) =>
    console.error('Conversion runner failed:', err)
  );
  // The cBOM snapshot (rule C2) is independent of the glTF derivative: a file can carry a
  // readable structure even if tessellation fails, so they run separately.
  void extractCadStructure(version.id, version.storagePath, version.fileName).catch((err) =>
    console.error('CAD structure extraction failed:', err)
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

/** The acting user, for the lock endpoints: their messages name who did what. */
function currentUser(req: Request): { id: number; name: string; role: string } {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user;
}

/** The caller as the acl module wants them (rule X3) — id and role, nothing else. */
function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/** The readable-document fragment, for nesting under a relation that points at a Document. */
function visibleDocument(viewer: AclUser): Prisma.DocumentWhereInput {
  return { ...aclFilter('DOCUMENT', viewer) };
}

/**
 * A version — and therefore its stored file, its glTF derivative and its CAD structure — carries
 * no grants of its own: it is exactly as visible as the document that owns it (rule X3).
 *
 * A where-fragment rather than an assert, so the answer for a restricted document is the same
 * 404 a nonexistent version gets. Two different messages would turn a loop over version ids into
 * an existence oracle for documents the caller may not see, which is the leak rule X2's
 * 404-never-403 exists to close.
 */
function visibleVersion(id: number, viewer: AclUser): Prisma.DocumentVersionWhereInput {
  return { id, document: visibleDocument(viewer) };
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Multipart text fields (multer puts them on req.body as strings). */
function multipartFields(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'title is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) throw new HttpError(400, 'title must be at most 200 characters');
  return trimmed;
}

/** Required free text — the break-lock reason (rule D1). */
function requireText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseCategory(value: unknown): DocumentCategory {
  if (typeof value !== 'string' || !(Object.values(DocumentCategory) as string[]).includes(value)) {
    throw new HttpError(
      400,
      'category must be one of DRAWING, SPECIFICATION, DATASHEET, CAD_MODEL, IMAGE, OTHER'
    );
  }
  return value as DocumentCategory;
}

function parseTargetId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return id;
}

/** Rule T1 — scan-based numbering, DOC-10001 style (like parts/ECNs). */
async function generateDocNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("docNumber" FROM 5)::int) AS max
    FROM "Document"
    WHERE "docNumber" ~ '^DOC-[0-9]{1,9}$'`;
  return `DOC-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

// ---------------------------------------------------------------------------
// GET /documents — list with search/category filters + pagination
// ---------------------------------------------------------------------------

router.get(
  '/documents',
  asyncHandler(async (req, res) => {
    const viewer = aclUser(req);
    const userId = viewer.id;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const categoryRaw = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (
      categoryRaw !== undefined &&
      !(Object.values(DocumentCategory) as string[]).includes(categoryRaw)
    ) {
      throw new HttpError(400, 'Invalid category filter');
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    // The acl fragment goes in first and is never merged by key: it arrives as `AND`, so the
    // search `OR` below composes with it instead of overwriting it. The `count` shares this
    // object, so the paging total counts only documents the caller may see.
    const where: Prisma.DocumentWhereInput = { ...aclFilter('DOCUMENT', viewer) };
    if (search) {
      where.OR = [
        { docNumber: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (categoryRaw) where.category = categoryRaw as DocumentCategory;

    const [total, docs] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: documentSummaryInclude,
      }),
    ]);

    res.json({
      items: docs.map((doc) => toDocumentSummary(doc, userId)),
      total,
      page,
      pageSize,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /documents — create with first file version (rule T1)
// ---------------------------------------------------------------------------

router.post(
  '/documents',
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    let persistedId: number | null = null;
    try {
      if (!file) throw new HttpError(400, 'file is required');
      const upload = file; // non-optional binding for the closure below
      const body = multipartFields(req);
      // No access check to make: a document that does not exist yet holds no grants, so it is
      // created unrestricted (rule X1's opt-in) and read back through the filtered helper.
      const viewer = aclUser(req);
      const userId = viewer.id;

      const title = requireTitle(body.title);
      const category =
        body.category === undefined ? DocumentCategory.OTHER : parseCategory(body.category);
      const description =
        body.description === undefined
          ? null
          : optionalNullableText(body.description, 'description');

      const createDocumentRecord = (docNumber: string) =>
        prisma.document.create({
          data: {
            docNumber,
            title,
            category,
            description,
            createdById: userId,
            versions: {
              create: {
                version: 1,
                fileName: upload.originalname,
                mimeType: upload.mimetype,
                sizeBytes: upload.size,
                storagePath: upload.filename,
                uploadedById: userId,
                conversionStatus: isConvertible(upload.originalname)
                  ? ConversionStatus.PENDING
                  : ConversionStatus.SKIPPED,
              },
            },
          },
          select: { id: true, docNumber: true },
        });

      // Numbers can only collide under concurrent creates — regenerate and retry.
      const created = await (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await createDocumentRecord(await generateDocNumber());
          } catch (err) {
            if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
            throw err;
          }
        }
      })();
      persistedId = created.id;

      // Rule I2 — document.created webhook; outside a transaction, so a
      // queueing failure must not undo the create (or delete the stored file).
      try {
        await emitEvent(prisma, 'document.created', {
          documentId: created.id,
          docNumber: created.docNumber,
          title,
          category,
        });
      } catch (err) {
        console.error('Failed to queue document.created webhook', err);
      }

      const payload = await getDocumentDetailOrThrow(created.id, viewer);
      void queueConversion(created.id);
      res.status(201).json(payload);
    } catch (err) {
      // The upload is already on disk when validation fails — roll it back.
      if (file && persistedId === null) removeStoredFile(file.filename);
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /documents/:id
// ---------------------------------------------------------------------------

router.get(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    // The read check *is* the acl filter inside the helper: one query, and a restricted document
    // answers with the same 404 as a missing one. There is no other validation here for it to
    // have to precede, and its link targets are redacted on the way out.
    res.json(await getDocumentDetailOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /documents/:id — metadata only
// ---------------------------------------------------------------------------

router.patch(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const viewer = aclUser(req);
    // Access before validation (rule X3). A 400 about the body, raised first, would already
    // confirm that this document exists to someone who may not know it does.
    await assertCanWrite('DOCUMENT', id, viewer);
    const body = requireBody(req);

    const data: Prisma.DocumentUpdateInput = {};
    if (body.title !== undefined) data.title = requireTitle(body.title);
    if (body.category !== undefined) data.category = parseCategory(body.category);
    if (body.description !== undefined)
      data.description = optionalNullableText(body.description, 'description');

    await prisma.document.update({ where: { id }, data });
    res.json(await getDocumentDetailOrThrow(id, viewer));
  })
);

// ---------------------------------------------------------------------------
// DELETE /documents/:id — creator or admin (rule T9)
// ---------------------------------------------------------------------------

router.delete(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const viewer = aclUser(req);
    const userId = viewer.id;
    // Deleting is the most destructive write there is, so it takes the write check first — and
    // before the creator/admin rule, whose 403 would otherwise confirm the document to someone
    // with no access at all.
    await assertCanWrite('DOCUMENT', id, viewer);

    const doc = await prisma.document.findUnique({
      where: { id },
      include: {
        versions: { select: { storagePath: true } },
        lockedBy: { select: { id: true, name: true } },
      },
    });
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.createdById !== userId && req.user?.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the creator or an administrator can delete this document');
    }
    // Rule D2 — a delete is not an edit of content, so it needs no lock of its own, but it
    // must not yank the file out from under someone who is editing. An expired lock is
    // already takeable by anyone, so it blocks nothing; break the lock first to delete.
    if (doc.lockedBy !== null && doc.lockedBy.id !== userId && !lockExpired(doc.lockExpiresAt)) {
      throw new HttpError(409, `${doc.docNumber} is checked out by ${doc.lockedBy.name}`);
    }

    // Best-effort file cleanup, then delete (cascades versions + links).
    for (const version of doc.versions) removeStoredFile(version.storagePath);
    await prisma.document.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/versions — upload a new file version (rule T1)
// ---------------------------------------------------------------------------

/**
 * The stored-file half of a DocumentVersion row. Shared by the direct upload and check-in so
 * the two paths cannot drift in what they record about a file (notably the conversion status,
 * which decides whether the CAD sidecar is asked to look at it at all).
 */
function uploadedVersionData(
  file: Express.Multer.File,
  userId: number,
  note: string | null
): Omit<Prisma.DocumentVersionUncheckedCreateInput, 'documentId' | 'version'> {
  return {
    fileName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    storagePath: file.filename,
    note,
    uploadedById: userId,
    conversionStatus: isConvertible(file.originalname)
      ? ConversionStatus.PENDING
      : ConversionStatus.SKIPPED,
  };
}

router.post(
  '/documents/:id/versions',
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    let persistedDocId: number | null = null;
    try {
      const id = idParam(req.params.id);
      const viewer = aclUser(req);
      const userId = viewer.id;
      // Before the file and note checks (rule X3): a 400 must not be the answer that tells a
      // caller without access that this document is there. The upload multer already stored is
      // still cleaned up by the catch below, because persistedDocId is null when this throws.
      await assertCanWrite('DOCUMENT', id, viewer);
      if (!file) throw new HttpError(400, 'file is required');
      const body = multipartFields(req);
      const note = body.note === undefined ? null : optionalNullableText(body.note, 'note');

      const doc = await prisma.document.findUnique({
        where: { id },
        select: { id: true, docNumber: true, lockedById: true },
      });
      if (!doc) throw new HttpError(404, 'Document not found');
      // Rule D2 — the deliberate behaviour change: without this gate the lock is decorative
      // and two engineers can still upload minutes apart with the second silently winning.
      // Expiry is not checked: it only says others *may* take the lock, and until one does
      // the holder's own work is still theirs to file.
      if (doc.lockedById !== userId) {
        throw new HttpError(409, `Check out ${doc.docNumber} before uploading a new version`);
      }

      // Auto-increment version; @@unique(documentId, version) catches concurrent
      // uploads — recompute and retry on P2002.
      for (let attempt = 0; ; attempt++) {
        const latest = await prisma.documentVersion.aggregate({
          where: { documentId: id },
          _max: { version: true },
        });
        try {
          await prisma.documentVersion.create({
            data: {
              documentId: id,
              version: (latest._max.version ?? 0) + 1,
              ...uploadedVersionData(file, userId, note),
            },
          });
          break;
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
      persistedDocId = id;

      const payload = await getDocumentDetailOrThrow(id, viewer);
      void queueConversion(id);
      res.json(payload);
    } catch (err) {
      if (file && persistedDocId === null) removeStoredFile(file.filename);
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/checkout — take (or refresh) the vault lock (rule D1)
// ---------------------------------------------------------------------------

router.post(
  '/documents/:id/checkout',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const actor = currentUser(req);
    const userId = actor.id;
    const viewer = aclUser(req);
    // A check-out reserves the right to write the next version, so it is a write on the document
    // — and the check runs before the body is validated (rule X3).
    await assertCanWrite('DOCUMENT', id, viewer);
    const body = requireBody(req);
    // An absent note and an explicit null are different requests: absent means "leave the
    // existing note alone" on a refresh, null means "clear it".
    const noteGiven = body.note !== undefined;
    const note = noteGiven ? optionalNullableText(body.note, 'note') : null;

    const doc = await getLockStateOrThrow(id, viewer);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    if (doc.lockedById === userId) {
      // Idempotent: a user whose tab died still holds the lock, and answering 409 would
      // strand them behind their own check-out. Refresh the expiry, keep lockedAt — the UI
      // shows "since <date>", meaning since the lock was first taken, not since the last ping.
      const refreshed = await prisma.document.updateMany({
        where: { id, lockedById: userId },
        data: { lockExpiresAt: expiresAt, ...(noteGiven ? { lockNote: note } : {}) },
      });
      if (refreshed.count === 0) await throwLockRace(id, doc.docNumber);
      res.json(await getDocumentDetailOrThrow(id, viewer));
      return;
    }

    if (doc.lockedById === null) {
      // Conditional on the lock still being free: two simultaneous check-outs must not both
      // report success with the last write silently winning — that is the bug the vault exists
      // to close, one level down.
      const taken = await prisma.document.updateMany({
        where: { id, lockedById: null },
        data: { lockedById: userId, lockedAt: now, lockExpiresAt: expiresAt, lockNote: note },
      });
      if (taken.count === 0) await throwLockRace(id, doc.docNumber);
      res.json(await getDocumentDetailOrThrow(id, viewer));
      return;
    }

    const holder = doc.lockedBy;
    // lockedBy is a required relation whenever lockedById is set; treat a missing row as a
    // live lock rather than handing the document to the caller on a broken invariant.
    if (holder === null) {
      throw new HttpError(
        409,
        `${doc.docNumber} was changed concurrently — reload and try again`
      );
    }

    if (lockExpired(doc.lockExpiresAt, now)) {
      // An expired lock may be taken by anyone, but never silently: the previous holder's name
      // goes into lockNote, so the check-out that broke it is visible in the response the UI
      // already renders, and the holder is told in the same transaction.
      const takenOver = `Took over the expired check-out held by ${holder.name}`;
      await prisma.$transaction(async (tx) => {
        const taken = await tx.document.updateMany({
          // The exact expiry we read is the optimistic condition: a concurrent takeover or a
          // refresh by the holder both move it, and either means this caller lost the race.
          where: { id, lockedById: holder.id, lockExpiresAt: doc.lockExpiresAt },
          data: {
            lockedById: userId,
            lockedAt: now,
            lockExpiresAt: expiresAt,
            lockNote: note === null ? takenOver : `${takenOver} — ${note}`,
          },
        });
        if (taken.count === 0) {
          throw new HttpError(
            409,
            `${doc.docNumber} was changed concurrently — reload and try again`
          );
        }
        await notifyUsers(tx, [holder.id], userId, {
          type: 'DOCUMENT_LOCK_BROKEN',
          title: `${actor.name} took over your expired check-out of ${doc.docNumber}`,
          body: note,
          link: `/documents/${id}`,
        });
      });
      res.json(await getDocumentDetailOrThrow(id, viewer));
      return;
    }

    throw new HttpError(409, `${doc.docNumber} is checked out by ${holder.name}`);
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/checkin — new version + release, atomically (rule D1)
// ---------------------------------------------------------------------------

router.post(
  '/documents/:id/checkin',
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    let persistedDocId: number | null = null;
    try {
      const id = idParam(req.params.id);
      const viewer = aclUser(req);
      const userId = viewer.id;
      // Write access first, ahead of the file check (rule X3). The stored upload is still
      // removed on the way out: persistedDocId is null when this throws.
      await assertCanWrite('DOCUMENT', id, viewer);
      if (!file) throw new HttpError(400, 'file is required');
      const upload = file; // non-optional binding for the transaction closure
      const body = multipartFields(req);
      const note = body.note === undefined ? null : optionalNullableText(body.note, 'note');

      const doc = await getLockStateOrThrow(id, viewer);
      // Expiry is deliberately not checked: it only means someone else *may* take the lock,
      // and while the row still names this caller the work they just did is theirs to file.
      if (doc.lockedById !== userId) {
        throw new HttpError(409, `${doc.docNumber} is not checked out by you`);
      }

      /*
       * One transaction for the release and the version. Storing the file but leaving the lock
       * held would block the vault on a document that is already up to date; releasing without
       * the version would hand the next editor a lock over work that was never recorded. Both
       * are worse than failing outright, so they commit together or not at all.
       *
       * The release goes first because it is also the claim: two check-ins racing on the same
       * lock serialize on that row, and the loser re-reads a null lockedById and 409s instead
       * of writing a second version.
       */
      for (let attempt = 0; ; attempt++) {
        try {
          await prisma.$transaction(async (tx) => {
            // Version numbers are a scan-max allocation like every other number here, so they
            // take the numbering lock — and they take it before touching the Document row, so
            // advisory-lock ordering matches the rest of the codebase.
            await lockNumbering(tx);
            const released = await tx.document.updateMany({
              where: { id, lockedById: userId },
              data: { ...RELEASED_LOCK, lockNote: null },
            });
            if (released.count === 0) {
              throw new HttpError(409, `${doc.docNumber} is not checked out by you`);
            }
            const latest = await tx.documentVersion.aggregate({
              where: { documentId: id },
              _max: { version: true },
            });
            await tx.documentVersion.create({
              data: {
                documentId: id,
                version: (latest._max.version ?? 0) + 1,
                ...uploadedVersionData(upload, userId, note),
              },
            });
          });
          break;
        } catch (err) {
          // @@unique(documentId, version) is the backstop behind the numbering lock. A failed
          // transaction rolls the release back too, so the retry re-claims the lock cleanly.
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
      persistedDocId = id;

      const payload = await getDocumentDetailOrThrow(id, viewer);
      // Conversion stays outside the transaction on purpose: it calls the CAD sidecar over
      // HTTP with a two-minute timeout and writes the outcome to the version row it just
      // read. Inside, it would hold a database connection for the whole call, could not see
      // its own uncommitted version, and any failure would roll back the check-in.
      void queueConversion(id);
      res.json(payload);
    } catch (err) {
      // The upload is already on disk by the time this handler runs; a refused or rolled-back
      // check-in must not leave it orphaned.
      if (file && persistedDocId === null) removeStoredFile(file.filename);
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/cancel-checkout — release without a version (rule D1)
// ---------------------------------------------------------------------------

router.post(
  '/documents/:id/cancel-checkout',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const actor = currentUser(req);
    const viewer = aclUser(req);
    // Releasing the lock changes the document's vault state, so it takes the write check — and
    // takes it before the 409s below, which name the document and its holder.
    await assertCanWrite('DOCUMENT', id, viewer);

    const doc = await getLockStateOrThrow(id, viewer);
    if (doc.lockedById === null || doc.lockedBy === null) {
      throw new HttpError(409, `${doc.docNumber} is not checked out`);
    }
    // The holder, or an ADMIN cleaning up after someone (rule D1).
    if (doc.lockedById !== actor.id && actor.role !== 'ADMIN') {
      throw new HttpError(409, `${doc.docNumber} is not checked out by you`);
    }

    await releaseLock({
      id,
      docNumber: doc.docNumber,
      holder: doc.lockedBy,
      actorId: actor.id,
      actorName: actor.name,
      reason: null,
    });
    res.json(await getDocumentDetailOrThrow(id, viewer));
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/break-lock — ADMIN override on a live lock (rule D1)
// ---------------------------------------------------------------------------

router.post(
  '/documents/:id/break-lock',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const actor = currentUser(req);
    // Authorization before validation: a non-admin must not learn from the error message
    // whether the document is even locked.
    requireAdmin(req);
    const viewer = aclUser(req);
    // Redundant for an ADMIN, who passes every grant by rule X1 — kept so this route cannot
    // become the one write path with no item-level check if the role rule is ever relaxed. For
    // an admin it degenerates to an existence check, which is the 404 this route already owes.
    await assertCanWrite('DOCUMENT', id, viewer);
    const body = requireBody(req);
    const reason = requireText(body.reason, 'reason');

    const doc = await getLockStateOrThrow(id, viewer);
    if (doc.lockedById === null || doc.lockedBy === null) {
      throw new HttpError(409, `${doc.docNumber} is not checked out`);
    }

    // Unlike a takeover, this works on a *live* lock — which is exactly why the reason is
    // mandatory and is kept in lockNote: the audit row records the call, the note records why.
    await releaseLock({
      id,
      docNumber: doc.docNumber,
      holder: doc.lockedBy,
      actorId: actor.id,
      actorName: actor.name,
      reason,
    });
    res.json(await getDocumentDetailOrThrow(id, viewer));
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:id/file — download a stored file
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/file',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // The bytes are the document. Guessing a version id must not serve the file of a document
    // the caller cannot read, and the 404 is the same either way (see `visibleVersion`).
    const version = await prisma.documentVersion.findFirst({
      where: visibleVersion(id, aclUser(req)),
    });
    if (!version) throw new HttpError(404, 'Document version not found');

    // Header values are built from client-supplied upload metadata: strip all
    // control characters, escape backslashes before quotes (else \" re-opens the
    // quoted-string and injects extra parameters), fall back to ASCII with an
    // RFC 5987 filename* for non-ASCII names, and never trust the stored MIME.
    const cleaned = version.fileName.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || 'download';
    const asciiFallback =
      cleaned
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"') || 'download';
    const mimeType = /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(version.mimeType)
      ? version.mimeType
      : 'application/octet-stream';
    // ?inline=1 serves for in-browser preview (CAD viewer, PDF embed) instead of download.
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`
    );
    await new Promise<void>((resolve, reject) => {
      res.sendFile(absoluteStoragePath(version.storagePath), (err) => {
        if (!err) {
          resolve();
        } else if (!res.headersSent && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new HttpError(404, 'Stored file is missing'));
        } else {
          reject(err);
        }
      });
    });
  })
);

// ---------------------------------------------------------------------------
// POST /documents/:id/links — attach to exactly one part / revision / ECN
// ---------------------------------------------------------------------------

router.post(
  '/documents/:id/links',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // Rule X3 — 404/403 on the document before the body is parsed.
    await assertCanWrite('DOCUMENT', id, user);
    const body = requireBody(req);

    const provided = (['partId', 'partRevisionId', 'ecnId'] as const).filter(
      (key) => body[key] !== undefined && body[key] !== null
    );
    if (provided.length !== 1) {
      throw new HttpError(400, 'Provide exactly one of partId, partRevisionId or ecnId');
    }

    // Every target is resolved through its own read filter: linking would otherwise both
    // confirm a restricted item exists and hang this document off it.
    const data: Prisma.DocumentLinkUncheckedCreateInput = { documentId: id };
    if (provided[0] === 'partId') {
      const partId = parseTargetId(body.partId, 'partId');
      await assertCanRead('PART', partId, user);
      const duplicate = await prisma.documentLink.findFirst({
        where: { documentId: id, partId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this part');
      data.partId = partId;
    } else if (provided[0] === 'partRevisionId') {
      const partRevisionId = parseTargetId(body.partRevisionId, 'partRevisionId');
      // A revision inherits its part's grants; resolved through the part filter so a
      // restricted part's revision 404s with the revision's own message.
      const revision = await prisma.partRevision.findFirst({
        where: { id: partRevisionId, part: { ...aclFilter('PART', user) } },
        select: { id: true },
      });
      if (!revision) throw new HttpError(404, 'Revision not found');
      const duplicate = await prisma.documentLink.findFirst({
        where: { documentId: id, partRevisionId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this revision');
      data.partRevisionId = partRevisionId;
    } else {
      const ecnId = parseTargetId(body.ecnId, 'ecnId');
      await assertCanRead('ECN', ecnId, user);
      const duplicate = await prisma.documentLink.findFirst({
        where: { documentId: id, ecnId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this ECN');
      data.ecnId = ecnId;
    }

    await prisma.documentLink.create({ data });
    res.json(await getDocumentDetailOrThrow(id, user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /document-links/:id
// ---------------------------------------------------------------------------

router.delete(
  '/document-links/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // A link is as visible as the document it hangs off, and unlinking edits that document.
    // The link's target may be restricted to this caller — that does not matter here: removing
    // the reference requires no access to what it referenced.
    const link = await prisma.documentLink.findFirst({
      where: { id, document: visibleDocument(user) },
      select: { id: true, documentId: true },
    });
    if (!link) throw new HttpError(404, 'Document link not found');
    await assertCanWrite('DOCUMENT', link.documentId, user);
    await prisma.documentLink.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Entity document listings — EntityDocument[] (newest doc first)
// ---------------------------------------------------------------------------

/**
 * Restricted documents are omitted, not redacted: this is a list endpoint ("documents you can
 * open from here"), not a traversal — nothing structural (a quantity, a total) depends on the
 * hidden rows, and a Restricted tile with nothing behind it would be dead UI. The same rule
 * the document list itself follows.
 */
async function listEntityDocuments(
  where: Prisma.DocumentLinkWhereInput,
  viewer: AclUser
): Promise<EntityDocumentDto[]> {
  const links = await prisma.documentLink.findMany({
    where: { ...where, document: visibleDocument(viewer) },
    orderBy: { documentId: 'desc' },
    include: { document: { include: documentSummaryInclude } },
  });
  return links.map((link) => ({
    linkId: link.id,
    document: toDocumentSummary(link.document, viewer.id),
  }));
}

router.get(
  '/parts/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanRead('PART', id, user);
    res.json(await listEntityDocuments({ partId: id }, user));
  })
);

router.get(
  '/revisions/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // A revision inherits its part's grants; resolved through the part filter so a restricted
    // part's revision 404s with the revision's own message.
    const revision = await prisma.partRevision.findFirst({
      where: { id, part: { ...aclFilter('PART', user) } },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    res.json(await listEntityDocuments({ partRevisionId: id }, user));
  })
);

router.get(
  '/ecns/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanRead('ECN', id, user);
    res.json(await listEntityDocuments({ ecnId: id }, user));
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:id/glb — the converted derivative
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/glb',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // The derivative is the document's geometry — gated exactly like the raw file above.
    const version = await prisma.documentVersion.findFirst({
      where: visibleVersion(id, aclUser(req)),
    });
    if (!version || !version.glbPath) throw new HttpError(404, 'No converted model for this version');

    const cleaned = version.fileName.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || 'model';
    const asciiFallback =
      `${cleaned}.glb`
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"') || 'model.glb';
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(`${cleaned}.glb`)}`
    );
    await new Promise<void>((resolve, reject) => {
      res.sendFile(absoluteStoragePath(version.glbPath as string), (err) => {
        if (!err) resolve();
        else if (!res.headersSent && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new HttpError(404, 'Converted model file is missing'));
        } else reject(err);
      });
    });
  })
);

// ---------------------------------------------------------------------------
// POST /document-versions/:id/convert — run (or re-run) conversion now
// ---------------------------------------------------------------------------

router.post(
  '/document-versions/:id/convert',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const version = await prisma.documentVersion.findFirst({
      where: visibleVersion(id, aclUser(req)),
      select: { id: true, documentId: true, storagePath: true, fileName: true },
    });
    if (!version) throw new HttpError(404, 'Document version not found');
    if (!isConvertible(version.fileName)) {
      throw new HttpError(
        409,
        'Only STEP, IGES and BREP files can be converted — export a neutral format from your CAD system'
      );
    }
    await runConversion(version.id, version.storagePath, version.fileName);
    await extractCadStructure(version.id, version.storagePath, version.fileName);
    const updated = await prisma.documentVersion.findUnique({
      where: { id },
      include: documentVersionInclude,
    });
    if (!updated) throw new HttpError(404, 'Document version not found');
    res.json(toVersion(updated));
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:id/assembly — the CAD product hierarchy (rule C2)
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/assembly',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const version = await prisma.documentVersion.findFirst({
      where: visibleVersion(id, user),
      select: { id: true, storagePath: true, fileName: true },
    });
    if (!version) throw new HttpError(404, 'Document version not found');
    // A non-CAD file is reported as SKIPPED, never as an error — the caller renders
    // the reason instead of a failure. Served from the snapshot, extracted on first access.
    const assembly = await readAssembly(version.id, version.storagePath, version.fileName);
    // The tree decorates nodes with matched PLM parts — a match against a part this caller
    // cannot read is stripped, leaving the node as CAD-only (rule X4).
    if (assembly.root) await scrubHiddenMatches(assembly.root, user);
    res.json(assembly);
  })
);

// POST /document-versions/:id/assembly/refresh — re-extract the cBOM snapshot
router.post(
  '/document-versions/:id/assembly/refresh',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const version = await prisma.documentVersion.findFirst({
      where: visibleVersion(id, user),
      select: { id: true, storagePath: true, fileName: true },
    });
    if (!version) throw new HttpError(404, 'Document version not found');
    const assembly = await readAssembly(version.id, version.storagePath, version.fileName, {
      refresh: true,
    });
    if (assembly.root) await scrubHiddenMatches(assembly.root, user);
    res.json(assembly);
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:fromId/cad-diff/:toId — what changed in the model
// between two CAD versions (rule C2b)
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:fromId/cad-diff/:toId',
  asyncHandler(async (req, res) => {
    const fromId = idParam(req.params.fromId);
    const toId = idParam(req.params.toId);

    // Both sides gated: a hidden version in either position 404s exactly like a missing one.
    // The diff itself needs no part scrubbing — it compares the files' own product names,
    // which belong to documents the caller has just been cleared to read.
    const versions = await prisma.documentVersion.findMany({
      where: { id: { in: [fromId, toId] }, document: visibleDocument(aclUser(req)) },
      select: {
        id: true,
        version: true,
        fileName: true,
        documentId: true,
        document: { select: { docNumber: true } },
      },
    });
    const from = versions.find((v) => v.id === fromId);
    const to = versions.find((v) => v.id === toId);
    if (!from || !to) throw new HttpError(404, 'Document version not found');

    const structures = await prisma.cadStructure.findMany({
      where: { documentVersionId: { in: [fromId, toId] }, status: 'DONE' },
      include: { nodes: { orderBy: [{ depth: 'asc' }, { seq: 'asc' }] } },
    });
    const fromStructure = structures.find((s) => s.documentVersionId === fromId);
    const toStructure = structures.find((s) => s.documentVersionId === toId);
    if (!fromStructure || !toStructure) {
      throw new HttpError(
        409,
        'Both CAD versions need a readable structure before they can be compared'
      );
    }

    /**
     * Flatten to path → quantity. The path identifies an occurrence, so the same part used
     * in two places is two rows and a move reads as a remove plus an add — which is what a
     * reviewer needs to see.
     *
     * Paths are **relative to the root**: both versions are the same model, so including
     * the root's own name would make renaming the top assembly look like every component
     * was removed and re-added. A rename is reported separately instead.
     */
    const flatten = (nodes: typeof fromStructure.nodes) => {
      const pathById = new Map<number, string>();
      const result = new Map<string, number>();
      for (const node of nodes) {
        if (node.depth === 0) {
          pathById.set(node.id, '');
          continue; // the assembly itself, not a component of it
        }
        const parentPath = node.parentId === null ? '' : (pathById.get(node.parentId) ?? '');
        const path = parentPath === '' ? node.name : `${parentPath}/${node.name}`;
        pathById.set(node.id, path);
        result.set(path, (result.get(path) ?? 0) + node.instances);
      }
      return result;
    };

    const before = flatten(fromStructure.nodes);
    const after = flatten(toStructure.nodes);

    type Change = 'ADDED' | 'REMOVED' | 'QTY_CHANGED' | 'UNCHANGED';
    const order: Record<Change, number> = { ADDED: 0, REMOVED: 1, QTY_CHANGED: 2, UNCHANGED: 3 };
    const rows: {
      path: string;
      name: string;
      change: Change;
      fromQuantity: number | null;
      toQuantity: number | null;
    }[] = [];

    for (const [path, toQty] of after) {
      const fromQty = before.get(path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (fromQty === undefined) {
        rows.push({ path, name, change: 'ADDED', fromQuantity: null, toQuantity: toQty });
      } else if (Math.abs(fromQty - toQty) > 1e-6) {
        rows.push({ path, name, change: 'QTY_CHANGED', fromQuantity: fromQty, toQuantity: toQty });
      } else {
        rows.push({ path, name, change: 'UNCHANGED', fromQuantity: fromQty, toQuantity: toQty });
      }
    }
    for (const [path, fromQty] of before) {
      if (after.has(path)) continue;
      rows.push({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        change: 'REMOVED',
        fromQuantity: fromQty,
        toQuantity: null,
      });
    }
    rows.sort((a, b) => order[a.change] - order[b.change] || a.path.localeCompare(b.path));

    res.json({
      from: {
        id: from.id,
        version: from.version,
        fileName: from.fileName,
        docNumber: from.document.docNumber,
        rootName: fromStructure.rootName,
      },
      to: {
        id: to.id,
        version: to.version,
        fileName: to.fileName,
        docNumber: to.document.docNumber,
        rootName: toStructure.rootName,
      },
      sameDocument: from.documentId === to.documentId,
      // A renamed top assembly is worth knowing about, but it must not read as a
      // wholesale replacement of the structure below it.
      rootRenamed: fromStructure.rootName !== toStructure.rootName,
      rows,
      counts: {
        added: rows.filter((r) => r.change === 'ADDED').length,
        removed: rows.filter((r) => r.change === 'REMOVED').length,
        qtyChanged: rows.filter((r) => r.change === 'QTY_CHANGED').length,
        unchanged: rows.filter((r) => r.change === 'UNCHANGED').length,
      },
    });
  })
);

export default router;
