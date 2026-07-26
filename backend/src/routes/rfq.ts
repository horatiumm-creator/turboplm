import { Request, Router } from 'express';
import { PartCategory, Prisma, RfqStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const SUPPLIER_CODE_RE = /^[A-Z0-9-]{2,20}$/i;

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
interface SupplierRefDto {
  id: number;
  code: string;
  name: string;
}

interface SupplierSummaryDto extends SupplierRefDto {
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  active: boolean;
  quoteCount: number;
}

interface QuoteDto {
  id: number;
  supplier: SupplierRefDto;
  unitPrice: number;
  currency: string;
  leadTimeDays: number | null;
  moq: number | null;
  notes: string | null;
  extendedPrice: number;
  isLowest: boolean;
  createdAt: string;
}

interface RfqLineDto {
  id: number;
  part: PartRefDto;
  quantity: number;
  targetPrice: number | null;
  notes: string | null;
  awardedSupplier: SupplierRefDto | null;
  awardedAt: string | null;
  quotes: QuoteDto[];
}

interface RfqSummaryDto {
  id: number;
  rfqNumber: string;
  title: string;
  status: RfqStatus;
  dueDate: string | null;
  lineCount: number;
  quoteCount: number;
  createdBy: UserRefDto;
  createdAt: string;
}

interface RfqDetailDto extends RfqSummaryDto {
  description: string | null;
  sentAt: string | null;
  closedAt: string | null;
  lines: RfqLineDto[];
}

// ---------------------------------------------------------------------------
// Includes + mappers
// ---------------------------------------------------------------------------

const rfqInclude = {
  createdBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { id: 'asc' as const },
    include: {
      part: true,
      awardedSupplier: { select: { id: true, code: true, name: true } },
      quotes: {
        orderBy: { unitPrice: 'asc' as const },
        include: { supplier: { select: { id: true, code: true, name: true } } },
      },
    },
  },
} satisfies Prisma.RfqInclude;

type RfqRow = Prisma.RfqGetPayload<{ include: typeof rfqInclude }>;

function toRfqDetail(rfq: RfqRow): RfqDetailDto {
  let quoteCount = 0;
  const lines: RfqLineDto[] = rfq.lines.map((line) => {
    quoteCount += line.quotes.length;
    const lowest = line.quotes.length > 0 ? Math.min(...line.quotes.map((q) => q.unitPrice)) : null;
    return {
      id: line.id,
      part: {
        id: line.part.id,
        partNumber: line.part.partNumber,
        name: line.part.name,
        category: line.part.category,
        uom: line.part.uom,
      },
      quantity: line.quantity,
      targetPrice: line.targetPrice,
      notes: line.notes,
      awardedSupplier: line.awardedSupplier
        ? {
            id: line.awardedSupplier.id,
            code: line.awardedSupplier.code,
            name: line.awardedSupplier.name,
          }
        : null,
      awardedAt: line.awardedAt ? line.awardedAt.toISOString() : null,
      quotes: line.quotes.map((quote) => ({
        id: quote.id,
        supplier: {
          id: quote.supplier.id,
          code: quote.supplier.code,
          name: quote.supplier.name,
        },
        unitPrice: quote.unitPrice,
        currency: quote.currency,
        leadTimeDays: quote.leadTimeDays,
        moq: quote.moq,
        notes: quote.notes,
        extendedPrice: Number((quote.unitPrice * line.quantity).toFixed(4)),
        isLowest: lowest !== null && quote.unitPrice === lowest,
        createdAt: quote.createdAt.toISOString(),
      })),
    };
  });

  return {
    id: rfq.id,
    rfqNumber: rfq.rfqNumber,
    title: rfq.title,
    status: rfq.status,
    dueDate: rfq.dueDate ? rfq.dueDate.toISOString() : null,
    lineCount: lines.length,
    quoteCount,
    createdBy: { id: rfq.createdBy.id, name: rfq.createdBy.name },
    createdAt: rfq.createdAt.toISOString(),
    description: rfq.description,
    sentAt: rfq.sentAt ? rfq.sentAt.toISOString() : null,
    closedAt: rfq.closedAt ? rfq.closedAt.toISOString() : null,
    lines,
  };
}

async function getRfqDetailOrThrow(id: number): Promise<RfqDetailDto> {
  const rfq = await prisma.rfq.findUnique({ where: { id }, include: rfqInclude });
  if (!rfq) throw new HttpError(404, 'RFQ not found');
  return toRfqDetail(rfq);
}

async function rfqOfLine(lineId: number) {
  const line = await prisma.rfqLine.findUnique({
    where: { id: lineId },
    include: { rfq: { select: { id: true, rfqNumber: true, status: true } } },
  });
  if (!line) throw new HttpError(404, 'RFQ line not found');
  return line;
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

function requireText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requirePositive(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, `${label} must be a number greater than 0`);
  }
  return n;
}

function optionalPositive(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return requirePositive(value, label);
}

function optionalId(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

function parseDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be an ISO date or null`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return date;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

router.get(
  '/suppliers',
  asyncHandler(async (_req, res) => {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { quotes: true } } },
    });
    const payload: SupplierSummaryDto[] = suppliers.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      contactName: s.contactName,
      contactEmail: s.contactEmail,
      notes: s.notes,
      active: s.active,
      quoteCount: s._count.quotes,
    }));
    res.json(payload);
  })
);

router.post(
  '/suppliers',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const code = requireText(body.code, 'code', 20).toUpperCase();
    if (!SUPPLIER_CODE_RE.test(code)) {
      throw new HttpError(400, 'code must be 2–20 letters, digits or hyphens');
    }
    const name = requireText(body.name, 'name');
    const existing = await prisma.supplier.findUnique({ where: { code }, select: { id: true } });
    if (existing) throw new HttpError(409, `Supplier code ${code} already exists`);

    const supplier = await prisma.supplier.create({
      data: {
        code,
        name,
        contactName: body.contactName === undefined ? null : optionalText(body.contactName, 'contactName'),
        contactEmail:
          body.contactEmail === undefined ? null : optionalText(body.contactEmail, 'contactEmail'),
        notes: body.notes === undefined ? null : optionalText(body.notes, 'notes'),
      },
    });
    res.status(201).json({
      id: supplier.id,
      code: supplier.code,
      name: supplier.name,
      contactName: supplier.contactName,
      contactEmail: supplier.contactEmail,
      notes: supplier.notes,
      active: supplier.active,
      quoteCount: 0,
    });
  })
);

router.patch(
  '/suppliers/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const existing = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Supplier not found');

    const data: Prisma.SupplierUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = requireText(body.name, 'name');
    if (body.contactName !== undefined) data.contactName = optionalText(body.contactName, 'contactName');
    if (body.contactEmail !== undefined)
      data.contactEmail = optionalText(body.contactEmail, 'contactEmail');
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');
    if (body.active !== undefined) data.active = Boolean(body.active);

    const supplier = await prisma.supplier.update({
      where: { id },
      data,
      include: { _count: { select: { quotes: true } } },
    });
    res.json({
      id: supplier.id,
      code: supplier.code,
      name: supplier.name,
      contactName: supplier.contactName,
      contactEmail: supplier.contactEmail,
      notes: supplier.notes,
      active: supplier.active,
      quoteCount: supplier._count.quotes,
    });
  })
);

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

router.get(
  '/rfqs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Prisma.RfqWhereInput = {};
    if (typeof req.query.status === 'string' && req.query.status) {
      const values = Object.values(RfqStatus);
      if (!values.includes(req.query.status as RfqStatus)) {
        throw new HttpError(400, `status must be one of ${values.join(', ')}`);
      }
      where.status = req.query.status as RfqStatus;
    }
    const [total, rows] = await Promise.all([
      prisma.rfq.count({ where }),
      prisma.rfq.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: rfqInclude,
      }),
    ]);
    const items = rows.map((row) => {
      const { description: _d, sentAt: _s, closedAt: _c, lines: _l, ...summary } = toRfqDetail(row);
      return summary;
    });
    res.json({ items, total, page, pageSize });
  })
);

router.post(
  '/rfqs',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    const userId = currentUserId(req);
    const title = requireText(body.title, 'title');
    const description = body.description === undefined ? null : optionalText(body.description, 'description');
    const dueDate = parseDate(body.dueDate, 'dueDate');

    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await prisma.$queryRaw<{ max: number | null }[]>`
          SELECT MAX(SUBSTRING("rfqNumber" FROM 5)::int) AS max
          FROM "Rfq" WHERE "rfqNumber" ~ '^RFQ-[0-9]{1,9}$'`;
        const rfqNumber = `RFQ-${Math.max(rows[0]?.max ?? 0, 10000) + 1}`;
        const created = await prisma.rfq.create({
          data: { rfqNumber, title, description, dueDate, createdById: userId },
          select: { id: true },
        });
        res.status(201).json(await getRfqDetailOrThrow(created.id));
        return;
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
        throw err;
      }
    }
  })
);

router.get(
  '/rfqs/:id',
  asyncHandler(async (req, res) => {
    res.json(await getRfqDetailOrThrow(idParam(req.params.id)));
  })
);

router.patch(
  '/rfqs/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const rfq = await prisma.rfq.findUnique({
      where: { id },
      select: { id: true, rfqNumber: true, status: true },
    });
    if (!rfq) throw new HttpError(404, 'RFQ not found');
    if (rfq.status !== RfqStatus.DRAFT) {
      throw new HttpError(409, `RFQ ${rfq.rfqNumber} is ${rfq.status} and cannot be modified`);
    }

    const data: Prisma.RfqUncheckedUpdateInput = {};
    if (body.title !== undefined) data.title = requireText(body.title, 'title');
    if (body.description !== undefined) data.description = optionalText(body.description, 'description');
    if (body.dueDate !== undefined) data.dueDate = parseDate(body.dueDate, 'dueDate');

    await prisma.rfq.update({ where: { id }, data });
    res.json(await getRfqDetailOrThrow(id));
  })
);

const RFQ_TRANSITIONS: Record<string, { from: RfqStatus[]; to: RfqStatus }> = {
  send: { from: [RfqStatus.DRAFT], to: RfqStatus.SENT },
  close: { from: [RfqStatus.SENT], to: RfqStatus.CLOSED },
  cancel: { from: [RfqStatus.DRAFT, RfqStatus.SENT, RfqStatus.CLOSED], to: RfqStatus.CANCELLED },
};

router.post(
  '/rfqs/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!Object.prototype.hasOwnProperty.call(RFQ_TRANSITIONS, action)) {
      throw new HttpError(400, 'Unknown action (expected send, close or cancel)');
    }
    const transition = RFQ_TRANSITIONS[action];

    const rfq = await prisma.rfq.findUnique({
      where: { id },
      include: { _count: { select: { lines: true } } },
    });
    if (!rfq) throw new HttpError(404, 'RFQ not found');
    if (!transition.from.includes(rfq.status)) {
      throw new HttpError(
        409,
        `Cannot ${action}: RFQ ${rfq.rfqNumber} is ${rfq.status} (requires ${transition.from.join(' or ')})`
      );
    }
    if (action === 'send' && rfq._count.lines === 0) {
      throw new HttpError(409, 'Add at least one line before sending');
    }

    const data: Prisma.RfqUncheckedUpdateManyInput = { status: transition.to };
    if (action === 'send') data.sentAt = new Date();
    if (action === 'close') data.closedAt = new Date();

    const result = await prisma.rfq.updateMany({ where: { id, status: rfq.status }, data });
    if (result.count === 0) {
      throw new HttpError(
        409,
        `Cannot ${action}: RFQ ${rfq.rfqNumber} was changed concurrently — reload and try again`
      );
    }
    res.json(await getRfqDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

router.post(
  '/rfqs/:id/lines',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);
    const rfq = await prisma.rfq.findUnique({
      where: { id },
      select: { id: true, rfqNumber: true, status: true },
    });
    if (!rfq) throw new HttpError(404, 'RFQ not found');
    if (rfq.status !== RfqStatus.DRAFT) {
      throw new HttpError(409, `RFQ ${rfq.rfqNumber} is ${rfq.status} — lines can only be edited in draft`);
    }

    const partId = optionalId(body.partId, 'partId');
    if (partId === null) throw new HttpError(400, 'partId is required');
    const part = await prisma.part.findUnique({ where: { id: partId }, select: { id: true } });
    if (!part) throw new HttpError(404, 'Part not found');
    const quantity = requirePositive(body.quantity, 'quantity');

    const duplicate = await prisma.rfqLine.findFirst({
      where: { rfqId: id, partId },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, 'Part is already on this RFQ');

    await prisma.rfqLine.create({
      data: {
        rfqId: id,
        partId,
        quantity,
        targetPrice: optionalPositive(body.targetPrice, 'targetPrice'),
        notes: body.notes === undefined ? null : optionalText(body.notes, 'notes'),
      },
    });
    res.status(201).json(await getRfqDetailOrThrow(id));
  })
);

router.delete(
  '/rfq-lines/:id',
  asyncHandler(async (req, res) => {
    const line = await rfqOfLine(idParam(req.params.id));
    if (line.rfq.status !== RfqStatus.DRAFT) {
      throw new HttpError(
        409,
        `RFQ ${line.rfq.rfqNumber} is ${line.rfq.status} — lines can only be edited in draft`
      );
    }
    await prisma.rfqLine.delete({ where: { id: line.id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

router.post(
  '/rfq-lines/:id/quotes',
  asyncHandler(async (req, res) => {
    const line = await rfqOfLine(idParam(req.params.id));
    const body = requireBody(req);
    if (line.rfq.status === RfqStatus.DRAFT) {
      throw new HttpError(409, 'Send the RFQ before recording quotes');
    }
    if (line.rfq.status === RfqStatus.CANCELLED) {
      throw new HttpError(409, `RFQ ${line.rfq.rfqNumber} is cancelled`);
    }

    const supplierId = optionalId(body.supplierId, 'supplierId');
    if (supplierId === null) throw new HttpError(400, 'supplierId is required');
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true },
    });
    if (!supplier) throw new HttpError(404, 'Supplier not found');

    const unitPrice = requirePositive(body.unitPrice, 'unitPrice');
    const duplicate = await prisma.rfqQuote.findFirst({
      where: { rfqLineId: line.id, supplierId },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, 'This supplier has already quoted this line');

    let leadTimeDays: number | null = null;
    if (body.leadTimeDays !== undefined && body.leadTimeDays !== null) {
      const n = Number(body.leadTimeDays);
      if (!Number.isInteger(n) || n < 0) {
        throw new HttpError(400, 'leadTimeDays must be a non-negative integer');
      }
      leadTimeDays = n;
    }

    await prisma.rfqQuote.create({
      data: {
        rfqLineId: line.id,
        supplierId,
        unitPrice,
        currency:
          body.currency === undefined || body.currency === null
            ? 'USD'
            : requireText(body.currency, 'currency', 8).toUpperCase(),
        leadTimeDays,
        moq: optionalPositive(body.moq, 'moq'),
        notes: body.notes === undefined ? null : optionalText(body.notes, 'notes'),
      },
    });
    res.status(201).json(await getRfqDetailOrThrow(line.rfq.id));
  })
);

router.delete(
  '/rfq-quotes/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const quote = await prisma.rfqQuote.findUnique({
      where: { id },
      include: { rfqLine: { select: { awardedSupplierId: true } } },
    });
    if (!quote) throw new HttpError(404, 'Quote not found');
    if (quote.rfqLine.awardedSupplierId !== null) {
      throw new HttpError(409, 'This line is already awarded — quotes are locked');
    }
    await prisma.rfqQuote.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /rfq-lines/:id/award
// ---------------------------------------------------------------------------

router.post(
  '/rfq-lines/:id/award',
  asyncHandler(async (req, res) => {
    const lineId = idParam(req.params.id);
    const body = requireBody(req);
    const line = await rfqOfLine(lineId);
    if (line.rfq.status !== RfqStatus.SENT && line.rfq.status !== RfqStatus.CLOSED) {
      throw new HttpError(
        409,
        `Cannot award: RFQ ${line.rfq.rfqNumber} is ${line.rfq.status} (requires SENT or CLOSED)`
      );
    }
    const supplierId = optionalId(body.supplierId, 'supplierId');
    if (supplierId === null) throw new HttpError(400, 'supplierId is required');

    const quote = await prisma.rfqQuote.findFirst({
      where: { rfqLineId: lineId, supplierId },
      select: { id: true },
    });
    if (!quote) throw new HttpError(409, 'That supplier has not quoted this line');

    await prisma.$transaction(async (tx) => {
      await tx.rfqLine.update({
        where: { id: lineId },
        data: { awardedSupplierId: supplierId, awardedAt: new Date() },
      });
      const outstanding = await tx.rfqLine.count({
        where: { rfqId: line.rfq.id, awardedSupplierId: null },
      });
      if (outstanding === 0) {
        await tx.rfq.updateMany({
          where: { id: line.rfq.id, status: { in: [RfqStatus.SENT, RfqStatus.CLOSED] } },
          data: {
            status: RfqStatus.AWARDED,
            ...(line.rfq.status === RfqStatus.SENT ? { closedAt: new Date() } : {}),
          },
        });
      }
    });

    res.json(await getRfqDetailOrThrow(line.rfq.id));
  })
);

export default router;
