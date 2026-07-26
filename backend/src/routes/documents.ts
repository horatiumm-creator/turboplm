import { Request, Router } from 'express';
import { DocumentCategory, Prisma } from '@prisma/client';
import { ConversionStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { absoluteStoragePath, removeStoredFile, uploadSingle } from '../middleware/upload';
import { emitEvent } from '../lib/webhooks';

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
  partRevision: { select: { id: true, revision: true, part: { select: { partNumber: true } } } },
  ecn: { select: { id: true, ecnNumber: true } },
} satisfies Prisma.DocumentLinkInclude;

const documentSummaryInclude = {
  createdBy: { select: { id: true, name: true } },
  versions: { orderBy: { version: 'desc' as const }, take: 1, include: documentVersionInclude },
  _count: { select: { versions: true } },
} satisfies Prisma.DocumentInclude;

const documentDetailInclude = {
  createdBy: { select: { id: true, name: true } },
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

/** Link labels: PART → partNumber; REVISION → `<partNumber> rev <rev>`; ECN → ecnNumber. */
function toLink(link: DocumentLinkRow): DocumentLinkDto {
  if (link.part) {
    return { id: link.id, target: { type: 'PART', id: link.part.id, label: link.part.partNumber } };
  }
  if (link.partRevision) {
    return {
      id: link.id,
      target: {
        type: 'REVISION',
        id: link.partRevision.id,
        label: `${link.partRevision.part.partNumber} rev ${link.partRevision.revision}`,
      },
    };
  }
  if (link.ecn) {
    return { id: link.id, target: { type: 'ECN', id: link.ecn.id, label: link.ecn.ecnNumber } };
  }
  // Unreachable: exactly one target is enforced on create.
  throw new Error(`DocumentLink ${link.id} has no target`);
}

function toDocumentSummary(doc: DocumentSummaryRow): DocumentSummaryDto {
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
  };
}

function toDocumentDetail(doc: DocumentDetailRow): DocumentDetailDto {
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
    links: doc.links.map(toLink),
  };
}

async function getDocumentDetailOrThrow(id: number): Promise<DocumentDetailDto> {
  const doc = await prisma.document.findUnique({ where: { id }, include: documentDetailInclude });
  if (!doc) throw new HttpError(404, 'Document not found');
  return toDocumentDetail(doc);
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
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
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

    const where: Prisma.DocumentWhereInput = {};
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

    res.json({ items: docs.map(toDocumentSummary), total, page, pageSize });
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
      const userId = currentUserId(req);

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

      const payload = await getDocumentDetailOrThrow(created.id);
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
    res.json(await getDocumentDetailOrThrow(idParam(req.params.id)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /documents/:id — metadata only
// ---------------------------------------------------------------------------

router.patch(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const doc = await prisma.document.findUnique({ where: { id }, select: { id: true } });
    if (!doc) throw new HttpError(404, 'Document not found');

    const data: Prisma.DocumentUpdateInput = {};
    if (body.title !== undefined) data.title = requireTitle(body.title);
    if (body.category !== undefined) data.category = parseCategory(body.category);
    if (body.description !== undefined)
      data.description = optionalNullableText(body.description, 'description');

    await prisma.document.update({ where: { id }, data });
    res.json(await getDocumentDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// DELETE /documents/:id — creator or admin (rule T9)
// ---------------------------------------------------------------------------

router.delete(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const userId = currentUserId(req);

    const doc = await prisma.document.findUnique({
      where: { id },
      include: { versions: { select: { storagePath: true } } },
    });
    if (!doc) throw new HttpError(404, 'Document not found');
    if (doc.createdById !== userId && req.user?.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the creator or an administrator can delete this document');
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

router.post(
  '/documents/:id/versions',
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    let persistedDocId: number | null = null;
    try {
      const id = idParam(req.params.id);
      if (!file) throw new HttpError(400, 'file is required');
      const body = multipartFields(req);
      const userId = currentUserId(req);
      const note = body.note === undefined ? null : optionalNullableText(body.note, 'note');

      const doc = await prisma.document.findUnique({ where: { id }, select: { id: true } });
      if (!doc) throw new HttpError(404, 'Document not found');

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
              fileName: file.originalname,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storagePath: file.filename,
              note,
              uploadedById: userId,
              conversionStatus: isConvertible(file.originalname)
                ? ConversionStatus.PENDING
                : ConversionStatus.SKIPPED,
            },
          });
          break;
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
      persistedDocId = id;

      const payload = await getDocumentDetailOrThrow(id);
      void queueConversion(id);
      res.json(payload);
    } catch (err) {
      if (file && persistedDocId === null) removeStoredFile(file.filename);
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:id/file — download a stored file
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/file',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const version = await prisma.documentVersion.findUnique({ where: { id } });
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
    const body = requireBody(req);

    const doc = await prisma.document.findUnique({ where: { id }, select: { id: true } });
    if (!doc) throw new HttpError(404, 'Document not found');

    const provided = (['partId', 'partRevisionId', 'ecnId'] as const).filter(
      (key) => body[key] !== undefined && body[key] !== null
    );
    if (provided.length !== 1) {
      throw new HttpError(400, 'Provide exactly one of partId, partRevisionId or ecnId');
    }

    const data: Prisma.DocumentLinkUncheckedCreateInput = { documentId: id };
    if (provided[0] === 'partId') {
      const partId = parseTargetId(body.partId, 'partId');
      const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
      if (!part) throw new HttpError(404, 'Part not found');
      const duplicate = await prisma.documentLink.findFirst({
        where: { documentId: id, partId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this part');
      data.partId = partId;
    } else if (provided[0] === 'partRevisionId') {
      const partRevisionId = parseTargetId(body.partRevisionId, 'partRevisionId');
      const revision = await prisma.partRevision.findUnique({
        where: { id: partRevisionId },
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
      const ecn = await prisma.ecn.findUnique({ where: { id: ecnId }, select: { id: true } });
      if (!ecn) throw new HttpError(404, 'ECN not found');
      const duplicate = await prisma.documentLink.findFirst({
        where: { documentId: id, ecnId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this ECN');
      data.ecnId = ecnId;
    }

    await prisma.documentLink.create({ data });
    res.json(await getDocumentDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// DELETE /document-links/:id
// ---------------------------------------------------------------------------

router.delete(
  '/document-links/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const link = await prisma.documentLink.findUnique({ where: { id }, select: { id: true } });
    if (!link) throw new HttpError(404, 'Document link not found');
    await prisma.documentLink.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Entity document listings — EntityDocument[] (newest doc first)
// ---------------------------------------------------------------------------

async function listEntityDocuments(
  where: Prisma.DocumentLinkWhereInput
): Promise<EntityDocumentDto[]> {
  const links = await prisma.documentLink.findMany({
    where,
    orderBy: { documentId: 'desc' },
    include: { document: { include: documentSummaryInclude } },
  });
  return links.map((link) => ({ linkId: link.id, document: toDocumentSummary(link.document) }));
}

router.get(
  '/parts/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const part = await prisma.part.findUnique({ where: { id }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');
    res.json(await listEntityDocuments({ partId: id }));
  })
);

router.get(
  '/revisions/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const revision = await prisma.partRevision.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    res.json(await listEntityDocuments({ partRevisionId: id }));
  })
);

router.get(
  '/ecns/:id/documents',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const ecn = await prisma.ecn.findUnique({ where: { id }, select: { id: true } });
    if (!ecn) throw new HttpError(404, 'ECN not found');
    res.json(await listEntityDocuments({ ecnId: id }));
  })
);

// ---------------------------------------------------------------------------
// GET /document-versions/:id/glb — the converted derivative
// ---------------------------------------------------------------------------

router.get(
  '/document-versions/:id/glb',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const version = await prisma.documentVersion.findUnique({ where: { id } });
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
    const version = await prisma.documentVersion.findUnique({
      where: { id },
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
    const updated = await prisma.documentVersion.findUnique({
      where: { id },
      include: documentVersionInclude,
    });
    if (!updated) throw new HttpError(404, 'Document version not found');
    res.json(toVersion(updated));
  })
);

export default router;
