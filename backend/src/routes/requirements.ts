import fs from 'fs';
import { Request, Router } from 'express';
import {
  EcnPriority,
  PartCategory,
  Prisma,
  RequirementStatus,
  RequirementType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { escapeLike, withNumberLock } from '../lib/plm';
import { AclUser, aclFilter, REDACTED, visibleIds } from '../lib/acl';
import { absoluteStoragePath, removeStoredFile, uploadSingle } from '../middleware/upload';
import {
  buildReqifDocument,
  parseReqifDocument,
  ReqifImportedRequirement,
  ReqifLinkRef,
  ReqifParseError,
} from '../lib/reqif';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

interface RequirementSummaryDto {
  id: number;
  reqNumber: string;
  title: string;
  type: RequirementType;
  priority: EcnPriority;
  status: RequirementStatus;
  parentId: number | null;
  linkedParts: number;
  linkedDocuments: number;
  childCount: number;
  createdAt: string;
  createdBy: UserRefDto;
}

interface RequirementLinkDto {
  id: number;
  part: PartRefDto | typeof REDACTED | null;
  document:
    | { id: number; docNumber: string; title: string }
    | (typeof REDACTED & { docNumber: string; title: string })
    | null;
}

interface RequirementDetailDto extends RequirementSummaryDto {
  statement: string;
  rationale: string | null;
  acceptance: string | null;
  parent: { id: number; reqNumber: string; title: string } | null;
  children: RequirementSummaryDto[];
  links: RequirementLinkDto[];
}

interface RequirementMatrixRowDto {
  requirement: RequirementSummaryDto;
  parts: PartRefDto[];
  documents: number;
}

interface RequirementMatrixDto {
  totals: { total: number; approved: number; covered: number; uncovered: number };
  rows: RequirementMatrixRowDto[];
}

interface PagedDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const requirementSummaryInclude = {
  createdBy: { select: { id: true, name: true } },
  links: { select: { partId: true, documentId: true } },
  _count: { select: { children: true } },
} satisfies Prisma.RequirementInclude;

const requirementLinkInclude = {
  part: true,
  document: { select: { id: true, docNumber: true, title: true } },
} satisfies Prisma.RequirementLinkInclude;

const requirementDetailInclude = {
  createdBy: { select: { id: true, name: true } },
  _count: { select: { children: true } },
  parent: { select: { id: true, reqNumber: true, title: true } },
  children: { orderBy: { reqNumber: 'asc' as const }, include: requirementSummaryInclude },
  links: { orderBy: { id: 'asc' as const }, include: requirementLinkInclude },
} satisfies Prisma.RequirementInclude;

type RequirementLinkRow = Prisma.RequirementLinkGetPayload<{
  include: typeof requirementLinkInclude;
}>;
type RequirementDetailRow = Prisma.RequirementGetPayload<{
  include: typeof requirementDetailInclude;
}>;

/** Structural source for the summary mapper — satisfied by both the summary and detail rows. */
interface RequirementSummarySource {
  id: number;
  reqNumber: string;
  title: string;
  type: RequirementType;
  priority: EcnPriority;
  status: RequirementStatus;
  parentId: number | null;
  createdAt: Date;
  createdBy: { id: number; name: string };
  links: { partId: number | null; documentId: number | null }[];
  _count: { children: number };
}

function toPartRef(part: {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}): PartRefDto {
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    category: part.category,
    uom: part.uom,
  };
}

function toRequirementSummary(row: RequirementSummarySource): RequirementSummaryDto {
  return {
    id: row.id,
    reqNumber: row.reqNumber,
    title: row.title,
    type: row.type,
    priority: row.priority,
    status: row.status,
    parentId: row.parentId,
    linkedParts: row.links.filter((link) => link.partId !== null).length,
    linkedDocuments: row.links.filter((link) => link.documentId !== null).length,
    childCount: row._count.children,
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
  };
}

/** Rule X4 — a link target the caller may not read keeps its row and loses its identity. */
function toRequirementLink(
  link: RequirementLinkRow,
  vis: { parts: ReadonlySet<number>; documents: ReadonlySet<number> }
): RequirementLinkDto {
  return {
    id: link.id,
    part: link.part
      ? vis.parts.has(link.part.id)
        ? toPartRef(link.part)
        : { ...REDACTED }
      : null,
    document: link.document
      ? vis.documents.has(link.document.id)
        ? { id: link.document.id, docNumber: link.document.docNumber, title: link.document.title }
        : { ...REDACTED, docNumber: REDACTED.name, title: REDACTED.name }
      : null,
  };
}

function toRequirementDetail(
  row: RequirementDetailRow,
  vis: { parts: ReadonlySet<number>; documents: ReadonlySet<number> }
): RequirementDetailDto {
  return {
    ...toRequirementSummary(row),
    statement: row.statement,
    rationale: row.rationale,
    acceptance: row.acceptance,
    parent: row.parent
      ? { id: row.parent.id, reqNumber: row.parent.reqNumber, title: row.parent.title }
      : null,
    children: row.children.map(toRequirementSummary),
    links: row.links.map((link) => toRequirementLink(link, vis)),
  };
}

async function getRequirementDetailOrThrow(id: number, user: AclUser): Promise<RequirementDetailDto> {
  const requirement = await prisma.requirement.findUnique({
    where: { id },
    include: requirementDetailInclude,
  });
  if (!requirement) throw new HttpError(404, 'Requirement not found');
  const [parts, documents] = await Promise.all([
    visibleIds(
      'PART',
      requirement.links.flatMap((link) => (link.part ? [link.part.id] : [])),
      user
    ),
    visibleIds(
      'DOCUMENT',
      requirement.links.flatMap((link) => (link.document ? [link.document.id] : [])),
      user
    ),
  ]);
  return toRequirementDetail(requirement, { parts, documents });
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
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

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'title is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) throw new HttpError(400, 'title must be at most 200 characters');
  return trimmed;
}

/** Rule R2 — statement is required and capped at 4000 characters. */
function requireStatement(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'statement is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 4000) {
    throw new HttpError(400, 'statement must be at most 4000 characters');
  }
  return trimmed;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseType(value: unknown): RequirementType {
  if (typeof value !== 'string' || !(Object.values(RequirementType) as string[]).includes(value)) {
    throw new HttpError(
      400,
      'type must be one of FUNCTIONAL, PERFORMANCE, SAFETY, REGULATORY, INTERFACE'
    );
  }
  return value as RequirementType;
}

function parsePriority(value: unknown): EcnPriority {
  if (typeof value !== 'string' || !(Object.values(EcnPriority) as string[]).includes(value)) {
    throw new HttpError(400, 'priority must be one of LOW, MEDIUM, HIGH, CRITICAL');
  }
  return value as EcnPriority;
}

function parseParentId(value: unknown): number | null {
  if (value === null) return null;
  const parentId = Number(value);
  if (!Number.isInteger(parentId) || parentId <= 0 || parentId > 2147483647) {
    throw new HttpError(400, 'parentId must be a positive integer or null');
  }
  return parentId;
}

/**
 * Rule R2 — the parent must exist and must not create a cycle: walk up the
 * ancestor chain from the candidate parent; finding the requirement itself
 * (or parent === self) means the tree would loop. `selfId` is null on create,
 * where the new node cannot be an ancestor of anything yet.
 */
async function assertValidParent(
  db: Prisma.TransactionClient | typeof prisma,
  parentId: number,
  selfId: number | null
): Promise<void> {
  if (selfId !== null && parentId === selfId) {
    throw new HttpError(409, 'A requirement cannot be its own parent');
  }
  const parent = await db.requirement.findUnique({
    where: { id: parentId },
    select: { parentId: true },
  });
  if (!parent) throw new HttpError(404, 'Parent requirement not found');

  const seen = new Set<number>([parentId]);
  let cursor = parent.parentId;
  while (cursor !== null) {
    if (selfId !== null && cursor === selfId) {
      throw new HttpError(409, 'Setting this parent would create a requirement cycle');
    }
    if (seen.has(cursor)) break; // defensive stop on pre-existing bad data
    seen.add(cursor);
    const node: { parentId: number | null } | null = await db.requirement.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    if (!node) break;
    cursor = node.parentId;
  }
}

/** Rule R1 — scan-based numbering, REQ-10001 style. */
async function generateReqNumber(db: Prisma.TransactionClient = prisma): Promise<string> {
  const rows = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(SUBSTRING("reqNumber" FROM 5)::int) AS max
    FROM "Requirement"
    WHERE "reqNumber" ~ '^REQ-[0-9]{1,9}$'`;
  return `REQ-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
}

// ---------------------------------------------------------------------------
// GET /requirements — list with search/status/type filters + pagination
// ---------------------------------------------------------------------------

router.get(
  '/requirements',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where: Prisma.RequirementWhereInput = {};

    const searchRaw = req.query.search;
    if (typeof searchRaw === 'string' && searchRaw.trim() !== '') {
      const q = escapeLike(searchRaw.trim());
      where.OR = [
        { reqNumber: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }

    const statusRaw = req.query.status;
    if (statusRaw !== undefined && statusRaw !== '') {
      if (
        typeof statusRaw !== 'string' ||
        !(Object.values(RequirementStatus) as string[]).includes(statusRaw)
      ) {
        throw new HttpError(400, 'Invalid status filter');
      }
      where.status = statusRaw as RequirementStatus;
    }

    const typeRaw = req.query.type;
    if (typeRaw !== undefined && typeRaw !== '') {
      if (
        typeof typeRaw !== 'string' ||
        !(Object.values(RequirementType) as string[]).includes(typeRaw)
      ) {
        throw new HttpError(400, 'Invalid type filter');
      }
      where.type = typeRaw as RequirementType;
    }

    const [total, requirements] = await Promise.all([
      prisma.requirement.count({ where }),
      prisma.requirement.findMany({
        where,
        orderBy: { reqNumber: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: requirementSummaryInclude,
      }),
    ]);

    const payload: PagedDto<RequirementSummaryDto> = {
      items: requirements.map(toRequirementSummary),
      total,
      page,
      pageSize,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /requirements — create (rules R1, R2)
// ---------------------------------------------------------------------------

router.post(
  '/requirements',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);

    const title = requireTitle(body.title);
    const statement = requireStatement(body.statement);
    const type = body.type === undefined ? RequirementType.FUNCTIONAL : parseType(body.type);
    const priority = body.priority === undefined ? EcnPriority.MEDIUM : parsePriority(body.priority);
    const rationale =
      body.rationale === undefined ? null : optionalNullableText(body.rationale, 'rationale');
    const acceptance =
      body.acceptance === undefined ? null : optionalNullableText(body.acceptance, 'acceptance');
    const parentId = body.parentId === undefined ? null : parseParentId(body.parentId);
    if (parentId !== null) await assertValidParent(prisma, parentId, null);

    const createRequirementRecord = (reqNumber: string, db: Prisma.TransactionClient = prisma) =>
      db.requirement.create({
        data: {
          reqNumber,
          title,
          statement,
          type,
          priority,
          rationale,
          acceptance,
          parentId,
          createdById: userId,
        },
        select: { id: true },
      });

    // Numbers can only collide under concurrent creates — regenerate and retry.
    const created = await withNumberLock(async (tx) => {
      // Serialized allocation; the retry is a backstop for a manually-typed clash.
      for (let attempt = 0; ; attempt++) {
        try {
          return await createRequirementRecord(await generateReqNumber(tx), tx);
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    });

    res.status(201).json(await getRequirementDetailOrThrow(created.id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// GET /requirements/matrix — traceability matrix (rule R6)
// NOTE: registered BEFORE /requirements/:id so "matrix" never parses as an id.
// ---------------------------------------------------------------------------

router.get(
  '/requirements/matrix',
  asyncHandler(async (_req, res) => {
    const requirements = await prisma.requirement.findMany({
      orderBy: { reqNumber: 'asc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { children: true } },
        links: { orderBy: { id: 'asc' }, include: { part: true } },
      },
    });

    const rows: RequirementMatrixRowDto[] = requirements.map((requirement) => ({
      requirement: toRequirementSummary(requirement),
      parts: requirement.links
        .filter((link) => link.part !== null)
        .map((link) => toPartRef(link.part!)),
      documents: requirement.links.filter((link) => link.documentId !== null).length,
    }));

    const covered = rows.filter((row) => row.parts.length > 0).length;
    const payload: RequirementMatrixDto = {
      totals: {
        total: rows.length,
        approved: requirements.filter((r) => r.status === RequirementStatus.APPROVED).length,
        covered,
        uncovered: rows.length - covered,
      },
      rows,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// ReqIF 1.2 interchange (lib/reqif.ts holds the format; this holds ACLs and the transaction)
//
// Both routes are registered BEFORE /requirements/:id for the same reason the matrix route
// is: `export` and `import` must never be parsed as an id. Express would not in fact confuse
// them — they carry a third path segment — but the ordering costs nothing and survives
// someone later shortening a path.
// ---------------------------------------------------------------------------

/**
 * Below the shared 50 MB multer ceiling, and deliberately: the whole document is parsed into
 * memory as one DOM before a single row is written, because "import nothing unless the whole
 * file parses" cannot be promised by a streaming parser that has already handed rows to the
 * caller. 25 MB of ReqIF is on the order of a hundred thousand requirements.
 */
const MAX_REQIF_BYTES = 25 * 1024 * 1024;

/**
 * The same ceiling the two other bulk importers use (`IMPORT_TX_OPTIONS` in routes/erp.ts and
 * routes/catalog.ts). Prisma's default interactive-transaction timeout is 5 seconds, which a
 * few thousand requirements comfortably exceed — and unlike the catalog commit, this work
 * CANNOT be split across transactions: "import nothing unless the whole file parses" means
 * the tree lands atomically or not at all.
 */
const IMPORT_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

interface ReqifImportSummaryDto {
  created: number;
  updated: number;
  skipped: number;
  unknownAttributesDropped: number;
  /** Individual `TurboPLM.Links` entries recognised and not applied — see lib/reqif.ts. */
  linksIgnored: number;
}

/**
 * Decode an uploaded ReqIF file as UTF-8.
 *
 * Two things a real export from a Windows tool routinely carries and a naive `toString('utf8')`
 * gets wrong: a UTF-8 BOM, which is not whitespace and makes the document fail well-formedness
 * checking on character one with a message nobody can act on; and UTF-16, which decodes as
 * mojibake and produces an equally unhelpful error about a character in column 1.
 */
function decodeReqifUpload(buffer: Buffer): string {
  if (buffer.length >= 2) {
    const isUtf16 =
      (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
    if (isUtf16) {
      throw new HttpError(
        400,
        'The file is UTF-16 encoded. Re-export it as UTF-8, which is what ReqIF documents use.'
      );
    }
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * A cycle in a prospective parent map, as the chain that closes it, or null.
 *
 * Keyed by reqNumber rather than by row id on purpose: the map has to describe the tree AFTER
 * the import, and requirements the file creates have no id yet. reqNumber is the identity the
 * import matches on, so it is the one name that exists for every node on both sides.
 */
function findParentCycle(parents: ReadonlyMap<string, string | null>): string[] | null {
  const DONE = 2;
  const IN_PROGRESS = 1;
  const state = new Map<string, number>();

  for (const start of parents.keys()) {
    if (state.get(start) === DONE) continue;
    const chain: string[] = [];
    let cursor: string | null = start;
    while (cursor !== null) {
      const seen = state.get(cursor);
      if (seen === DONE) break;
      if (seen === IN_PROGRESS) return [...chain.slice(chain.indexOf(cursor)), cursor];
      state.set(cursor, IN_PROGRESS);
      chain.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const node of chain) state.set(node, DONE);
  }
  return null;
}

router.get(
  '/requirements/export/reqif',
  asyncHandler(async (req, res) => {
    const user = aclUser(req);

    /*
     * Requirement is NOT one of the five ACL-bearing types — `AclType` in lib/acl.ts is
     * PART | DOCUMENT | ECN | PROJECT | BUILD_UNIT and the Requirement model carries no
     * `acls` relation — so there is no filter to apply to the rows themselves, and the list
     * and matrix routes above apply none either.
     *
     * The LINKS are a different matter. They name parts and documents, both of which are
     * ACL-bearing, and a part number is exactly the kind of thing an item-level grant exists
     * to hide. An export that dumped them would be the same leak as a list endpoint that
     * does. They therefore go through `visibleIds` and a hidden target is exported as
     * `Restricted`, which is what the BOM CSV export does with a redacted node and what rule
     * X4 asks for: the link's existence is preserved, its identity is not.
     */
    const requirements = await prisma.requirement.findMany({
      orderBy: { reqNumber: 'asc' },
      include: {
        links: {
          orderBy: { id: 'asc' },
          select: {
            part: { select: { id: true, partNumber: true } },
            document: { select: { id: true, docNumber: true } },
          },
        },
      },
    });

    const [visibleParts, visibleDocuments] = await Promise.all([
      visibleIds(
        'PART',
        requirements.flatMap((r) => r.links.flatMap((l) => (l.part ? [l.part.id] : []))),
        user
      ),
      visibleIds(
        'DOCUMENT',
        requirements.flatMap((r) => r.links.flatMap((l) => (l.document ? [l.document.id] : []))),
        user
      ),
    ]);

    const xml = buildReqifDocument({
      requirements: requirements.map((requirement) => ({
        ...requirement,
        links: requirement.links.flatMap((link): ReqifLinkRef[] => {
          if (link.part) {
            return [
              {
                kind: 'PART',
                identifier: visibleParts.has(link.part.id) ? link.part.partNumber : REDACTED.name,
              },
            ];
          }
          if (link.document) {
            return [
              {
                kind: 'DOCUMENT',
                identifier: visibleDocuments.has(link.document.id)
                  ? link.document.docNumber
                  : REDACTED.name,
              },
            ];
          }
          return [];
        }),
      })),
    });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="requirements.reqif"');
    res.send(xml);
  })
);

/**
 * Write a parsed document into the database, inside one transaction.
 *
 * The lock is the same one PATCH takes for a re-parent, and for the same reason: the cycle
 * check below is a check-then-write over the whole tree, so a concurrent re-parent that
 * validated against a pre-import snapshot could complete a loop neither request could see on
 * its own.
 */
async function applyReqifImport(
  parsed: { requirements: ReqifImportedRequirement[]; skipped: number },
  userId: number
): Promise<{ created: number; updated: number; skipped: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-requirement-tree'))::text`;

    const existing = await tx.requirement.findMany({
      select: { id: true, reqNumber: true, parentId: true, status: true },
    });
    const reqNumberById = new Map(existing.map((row) => [row.id, row.reqNumber]));
    const rowByReqNumber = new Map(existing.map((row) => [row.reqNumber, row]));

    /*
     * Rule R3 — a requirement that is not DRAFT cannot be modified. PATCH refuses it with a
     * 409 and the import must not be the way around change control: an APPROVED requirement
     * is frozen, and quietly rewriting one because a file said so would make the approval
     * meaningless. Such rows are counted as skipped alongside the ones the file could not
     * identify, and everything else in the file still imports — a whole-file rejection would
     * be worse, because a document usually contains far more DRAFT rows than frozen ones.
     *
     * Creating a requirement directly in APPROVED is a different thing and is allowed: there
     * is no local approval to overwrite, and refusing would make it impossible to migrate an
     * existing baseline in from another tool.
     */
    const writable = parsed.requirements.filter((requirement) => {
      const row = rowByReqNumber.get(requirement.reqNumber);
      return row === undefined || row.status === RequirementStatus.DRAFT;
    });
    const frozen = parsed.requirements.length - writable.length;

    // The tree as it will be once this import lands: every existing row's current parent,
    // overlaid with what the file says for the rows this import will actually touch.
    const prospective = new Map<string, string | null>();
    for (const row of existing) {
      prospective.set(
        row.reqNumber,
        row.parentId === null ? null : (reqNumberById.get(row.parentId) ?? null)
      );
    }
    for (const requirement of writable) {
      prospective.set(requirement.reqNumber, requirement.parentReqNumber);
    }
    const cycle = findParentCycle(prospective);
    if (cycle) {
      // 409 rather than 400: the file is well-formed and the conflict is with rows that are
      // already here, which is the same thing PATCH reports when a re-parent would loop.
      throw new HttpError(
        409,
        `Importing this file would create a requirement cycle (${cycle.join(' -> ')}). ` +
          'Nothing was imported.'
      );
    }

    const idByReqNumber = new Map(existing.map((row) => [row.reqNumber, row.id]));
    const parentIdByReqNumber = new Map(existing.map((row) => [row.reqNumber, row.parentId]));
    let created = 0;
    let updated = 0;

    /*
     * Pass one writes the content and leaves parentage alone, pass two sets it. Two passes
     * because SPEC-HIERARCHY nesting freely puts a child before its parent in document order,
     * and a single pass would have to resolve a parent row that does not exist yet.
     *
     * An enum the file did not carry means "unstated", not "reset to default": on an update
     * the existing value is left alone, so importing a document from a tool that has no
     * notion of our status column cannot silently walk an approved requirement backwards. On
     * a create there is nothing to preserve, so the column default applies.
     */
    for (const requirement of writable) {
      const enums = {
        ...(requirement.type !== null ? { type: requirement.type } : {}),
        ...(requirement.priority !== null ? { priority: requirement.priority } : {}),
        ...(requirement.status !== null ? { status: requirement.status } : {}),
      };
      const existingId = idByReqNumber.get(requirement.reqNumber);
      if (existingId !== undefined) {
        await tx.requirement.update({
          where: { id: existingId },
          data: {
            title: requirement.title,
            statement: requirement.statement,
            rationale: requirement.rationale,
            acceptance: requirement.acceptance,
            ...enums,
          },
        });
        updated += 1;
      } else {
        const row = await tx.requirement.create({
          data: {
            reqNumber: requirement.reqNumber,
            title: requirement.title,
            statement: requirement.statement,
            rationale: requirement.rationale,
            acceptance: requirement.acceptance,
            ...enums,
            // Provenance, kept when the source tool recorded it. `updatedAt` is deliberately
            // NOT taken from the file: it records when THIS installation last touched the
            // row, and a foreign timestamp there would make the local audit trail lie.
            ...(requirement.createdAt !== null ? { createdAt: requirement.createdAt } : {}),
            createdById: userId,
          },
          select: { id: true },
        });
        idByReqNumber.set(requirement.reqNumber, row.id);
        parentIdByReqNumber.set(requirement.reqNumber, null);
        created += 1;
      }
    }

    for (const requirement of writable) {
      const id = idByReqNumber.get(requirement.reqNumber);
      const parentId =
        requirement.parentReqNumber === null
          ? null
          : (idByReqNumber.get(requirement.parentReqNumber) ?? null);
      if (id === undefined || (requirement.parentReqNumber !== null && parentId === null)) {
        // Unreachable: the parser only ever names a parent that is itself in the file, and
        // pass one gave every file row an id. Loud rather than a silently detached subtree.
        throw new HttpError(
          500,
          `Could not resolve the parent of ${requirement.reqNumber} after import`
        );
      }
      if (parentIdByReqNumber.get(requirement.reqNumber) !== parentId) {
        await tx.requirement.update({ where: { id }, data: { parentId } });
      }
    }

    /*
     * Nothing is reserved for the numbering, and nothing needs to be. Rule R1 allocates by
     * scanning — `generateReqNumber` takes MAX() over the reqNumbers that exist on every
     * allocation — so numbers that arrived from a file are visible to it the moment this
     * transaction commits, and the next "new requirement" continues above the import instead
     * of colliding with it. A counter that seeded once would have had to be told.
     */
    return { created, updated, skipped: parsed.skipped + frozen };
  }, IMPORT_TX_OPTIONS);
}

router.post(
  '/requirements/import/reqif',
  // ADMIN or ENGINEER only. Enforced by `requireWriteRole`, mounted app-wide in index.ts,
  // which refuses every non-GET from a VIEWER — the same way every other mutation in this
  // file is guarded. Nothing extra is needed here, and adding a second check would suggest
  // the middleware could not be relied on.
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, 'file is required');
      const userId = currentUserId(req);
      if (file.size > MAX_REQIF_BYTES) {
        throw new HttpError(413, 'File exceeds the 25 MB ReqIF upload limit');
      }

      const xml = decodeReqifUpload(await fs.promises.readFile(absoluteStoragePath(file.filename)));

      /*
       * Parsed and validated in full BEFORE the transaction opens. Everything the file can be
       * wrong about on its own — not XML, not ReqIF, a duplicated requirement, a missing
       * title, an enum literal we do not have — is a ReqifParseError raised here, so a
       * malformed document cannot leave a half-built tree behind. It never gets as far as a
       * write to fail.
       */
      let parsed;
      try {
        parsed = parseReqifDocument(xml);
      } catch (err) {
        if (err instanceof ReqifParseError) throw new HttpError(400, err.message);
        throw err;
      }

      const written = await applyReqifImport(parsed, userId);
      const summary: ReqifImportSummaryDto = {
        ...written,
        unknownAttributesDropped: parsed.unknownAttributesDropped,
        linksIgnored: parsed.linksIgnored,
      };
      res.status(200).json(summary);
    } finally {
      // The document is fully in memory by the time anything is written, so the upload has no
      // further use — and a requirements export is customer engineering data that has no
      // business sitting on the API server's disk.
      if (file) removeStoredFile(file.filename);
    }
  })
);

// ---------------------------------------------------------------------------
// GET /requirements/:id
// ---------------------------------------------------------------------------

router.get(
  '/requirements/:id',
  asyncHandler(async (req, res) => {
    res.json(await getRequirementDetailOrThrow(idParam(req.params.id), aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// PATCH /requirements/:id — edit while DRAFT only (rules R2, R3)
// ---------------------------------------------------------------------------

router.patch(
  '/requirements/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const requirement = await prisma.requirement.findUnique({
      where: { id },
      select: { id: true, reqNumber: true, status: true },
    });
    if (!requirement) throw new HttpError(404, 'Requirement not found');
    if (requirement.status !== RequirementStatus.DRAFT) {
      throw new HttpError(
        409,
        `Requirement ${requirement.reqNumber} is ${requirement.status} and cannot be modified`
      );
    }

    const data: Prisma.RequirementUncheckedUpdateInput = {};
    if (body.title !== undefined) data.title = requireTitle(body.title);
    if (body.statement !== undefined) data.statement = requireStatement(body.statement);
    if (body.type !== undefined) data.type = parseType(body.type);
    if (body.priority !== undefined) data.priority = parsePriority(body.priority);
    if (body.rationale !== undefined)
      data.rationale = optionalNullableText(body.rationale, 'rationale');
    if (body.acceptance !== undefined)
      data.acceptance = optionalNullableText(body.acceptance, 'acceptance');
    const reparent = body.parentId !== undefined ? parseParentId(body.parentId) : undefined;
    if (reparent !== undefined) data.parentId = reparent;

    if (reparent !== null && reparent !== undefined) {
      // Check-then-write on the tree: serialize re-parenting so two concurrent
      // swaps cannot each validate against a pre-move snapshot and form a cycle.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('turboplm-requirement-tree'))::text`;
        await assertValidParent(tx, reparent, id);
        await tx.requirement.update({ where: { id }, data });
      });
    } else {
      await prisma.requirement.update({ where: { id }, data });
    }
    res.json(await getRequirementDetailOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// POST /requirements/:id/transition — approve / obsolete (rule R3)
// ---------------------------------------------------------------------------

type RequirementTransitionAction = 'approve' | 'obsolete';

const REQUIREMENT_TRANSITIONS: Record<
  RequirementTransitionAction,
  { from: RequirementStatus; to: RequirementStatus }
> = {
  approve: { from: RequirementStatus.DRAFT, to: RequirementStatus.APPROVED },
  obsolete: { from: RequirementStatus.APPROVED, to: RequirementStatus.OBSOLETE },
};

router.post(
  '/requirements/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const action = body.action;
    if (
      typeof action !== 'string' ||
      !Object.prototype.hasOwnProperty.call(REQUIREMENT_TRANSITIONS, action)
    ) {
      throw new HttpError(400, 'Unknown action (expected approve or obsolete)');
    }
    const transition = REQUIREMENT_TRANSITIONS[action as RequirementTransitionAction];

    const requirement = await prisma.requirement.findUnique({
      where: { id },
      select: { id: true, reqNumber: true, status: true },
    });
    if (!requirement) throw new HttpError(404, 'Requirement not found');
    if (requirement.status !== transition.from) {
      throw new HttpError(
        409,
        `Cannot ${action}: requirement ${requirement.reqNumber} is ${requirement.status} (requires ${transition.from})`
      );
    }

    const result = await prisma.requirement.updateMany({
      where: { id, status: transition.from },
      data: { status: transition.to },
    });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: requirement ${requirement.reqNumber} was changed concurrently — reload and try again`
      );
    }

    res.json(await getRequirementDetailOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /requirements/:id — DRAFT with no children only (rule R4)
// ---------------------------------------------------------------------------

router.delete(
  '/requirements/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const requirement = await prisma.requirement.findUnique({
      where: { id },
      select: {
        id: true,
        reqNumber: true,
        status: true,
        _count: { select: { children: true } },
      },
    });
    if (!requirement) throw new HttpError(404, 'Requirement not found');
    if (requirement.status !== RequirementStatus.DRAFT) {
      throw new HttpError(
        409,
        `Requirement ${requirement.reqNumber} is ${requirement.status} and cannot be deleted`
      );
    }
    if (requirement._count.children > 0) {
      throw new HttpError(
        409,
        `Requirement ${requirement.reqNumber} has child requirements and cannot be deleted`
      );
    }
    await prisma.requirement.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /requirements/:id/links — link a part or a document (rule R5)
// ---------------------------------------------------------------------------

router.post(
  '/requirements/:id/links',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const requirement = await prisma.requirement.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!requirement) throw new HttpError(404, 'Requirement not found');

    // Rule R5 — exactly one of partId / documentId.
    const hasPart = body.partId !== undefined && body.partId !== null;
    const hasDocument = body.documentId !== undefined && body.documentId !== null;
    if (hasPart === hasDocument) {
      throw new HttpError(400, 'Provide exactly one of partId or documentId');
    }

    if (hasPart) {
      const partId = Number(body.partId);
      if (!Number.isInteger(partId) || partId <= 0 || partId > 2147483647) {
        throw new HttpError(400, 'partId must be a positive integer');
      }
      // A restricted part answers like a missing one (rule X2).
      const part = await prisma.part.findFirst({
        where: { id: partId, ...(aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput) },
        select: { id: true },
      });
      if (!part) throw new HttpError(404, 'Part not found');
      const duplicate = await prisma.requirementLink.findFirst({
        where: { requirementId: id, partId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Part is already linked to this requirement');
      await prisma.requirementLink.create({ data: { requirementId: id, partId } });
    } else {
      const documentId = Number(body.documentId);
      if (!Number.isInteger(documentId) || documentId <= 0 || documentId > 2147483647) {
        throw new HttpError(400, 'documentId must be a positive integer');
      }
      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          ...(aclFilter('DOCUMENT', aclUser(req)) as Prisma.DocumentWhereInput),
        },
        select: { id: true },
      });
      if (!document) throw new HttpError(404, 'Document not found');
      const duplicate = await prisma.requirementLink.findFirst({
        where: { requirementId: id, documentId },
        select: { id: true },
      });
      if (duplicate) throw new HttpError(409, 'Document is already linked to this requirement');
      await prisma.requirementLink.create({ data: { requirementId: id, documentId } });
    }

    res.status(201).json(await getRequirementDetailOrThrow(id, aclUser(req)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /requirement-links/:id (rule R5 — allowed in any status)
// ---------------------------------------------------------------------------

router.delete(
  '/requirement-links/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const link = await prisma.requirementLink.findUnique({ where: { id }, select: { id: true } });
    if (!link) throw new HttpError(404, 'Requirement link not found');
    await prisma.requirementLink.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// GET /parts/:id/requirements — requirements satisfied by the part
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id/requirements',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const part = await prisma.part.findFirst({
      where: { id: partId, ...(aclFilter('PART', aclUser(req)) as Prisma.PartWhereInput) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    const requirements = await prisma.requirement.findMany({
      where: { links: { some: { partId } } },
      orderBy: { reqNumber: 'asc' },
      include: requirementSummaryInclude,
    });
    res.json(requirements.map(toRequirementSummary));
  })
);

export default router;
