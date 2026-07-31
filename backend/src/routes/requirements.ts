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
