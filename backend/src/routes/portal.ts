/**
 * Supplier portal (rules P3, P4).
 *
 * Everything here is scoped to the signed-in supplier. The recurring rule is that a
 * supplier learns nothing about anyone else: not competitors' prices, not how many quotes
 * came in, not who won, and not whether an RFQ they were never invited to exists.
 */
import { Request, Router } from 'express';
import bcrypt from 'bcryptjs';
import { RfqStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import {
  clearPortalCookie,
  requireSupplierAuth,
  setPortalCookie,
} from '../middleware/portalAuth';

const router = Router();

/** RFQ states a supplier may see at all. A DRAFT is never visible (rule P4). */
const VISIBLE_STATUSES: RfqStatus[] = [RfqStatus.SENT, RfqStatus.CLOSED, RfqStatus.AWARDED];

const MIN_PASSWORD_LENGTH = 12;

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function portalUser(req: Request) {
  if (!req.portalUser) throw new HttpError(401, 'Not authenticated');
  return req.portalUser;
}

// ---------------------------------------------------------------------------
// Unauthenticated: accept an invitation, sign in
// ---------------------------------------------------------------------------

router.post(
  '/portal/accept-invite',
  asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const token = requireString(body.token, 'token');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const account = await prisma.supplierUser.findUnique({
      where: { inviteToken: token },
      include: { supplier: { select: { active: true } } },
    });
    // One message for unknown, expired and already-used, so this cannot be used to probe
    // which invitation tokens exist (rule P3).
    const invalid = new HttpError(400, 'This invitation link is invalid or has expired');
    if (!account || !account.inviteExpiresAt || account.inviteExpiresAt < new Date()) throw invalid;
    if (!account.active || !account.supplier.active) throw invalid;

    const updated = await prisma.supplierUser.update({
      where: { id: account.id },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        inviteToken: null,
        inviteExpiresAt: null,
        lastLoginAt: new Date(),
      },
      include: { supplier: { select: { id: true, name: true, code: true } } },
    });

    setPortalCookie(res, updated.id);
    res.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      supplier: updated.supplier,
    });
  })
);

router.post(
  '/portal/login',
  asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const email = requireString(body.email, 'email').toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    const account = await prisma.supplierUser.findUnique({
      where: { email },
      include: { supplier: { select: { id: true, name: true, code: true, active: true } } },
    });
    // Identical failure for unknown email, wrong password, never-accepted invitation and
    // deactivated account — none of those distinctions are the caller's business.
    const invalid = new HttpError(401, 'Invalid email or password');
    if (!account || !account.passwordHash || !account.active || !account.supplier.active) {
      throw invalid;
    }
    if (!(await bcrypt.compare(password, account.passwordHash))) throw invalid;

    await prisma.supplierUser.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });
    setPortalCookie(res, account.id);
    res.json({
      id: account.id,
      email: account.email,
      name: account.name,
      supplier: {
        id: account.supplier.id,
        name: account.supplier.name,
        code: account.supplier.code,
      },
    });
  })
);

router.post('/portal/logout', (_req, res) => {
  clearPortalCookie(res);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Authenticated portal
// ---------------------------------------------------------------------------

router.get(
  '/portal/me',
  requireSupplierAuth,
  asyncHandler(async (req, res) => {
    const user = portalUser(req);
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      supplier: { id: user.supplierId, name: user.supplierName, code: user.supplierCode },
    });
  })
);

router.get(
  '/portal/rfqs',
  requireSupplierAuth,
  asyncHandler(async (req, res) => {
    const user = portalUser(req);
    const rows = await prisma.rfq.findMany({
      where: {
        status: { in: VISIBLE_STATUSES },
        invitations: { some: { supplierId: user.supplierId } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rfqNumber: true,
        title: true,
        status: true,
        dueDate: true,
        sentAt: true,
        closedAt: true,
        _count: { select: { lines: true } },
        invitations: {
          where: { supplierId: user.supplierId },
          select: { respondedAt: true },
        },
        lines: {
          select: {
            _count: { select: { quotes: { where: { supplierId: user.supplierId } } } },
          },
        },
      },
    });

    res.json(
      rows.map((rfq) => ({
        id: rfq.id,
        rfqNumber: rfq.rfqNumber,
        title: rfq.title,
        status: rfq.status,
        dueDate: rfq.dueDate ? rfq.dueDate.toISOString() : null,
        sentAt: rfq.sentAt ? rfq.sentAt.toISOString() : null,
        closedAt: rfq.closedAt ? rfq.closedAt.toISOString() : null,
        lineCount: rfq._count.lines,
        // Only this supplier's own coverage — never the total number of quotes received.
        myQuoteCount: rfq.lines.filter((line) => line._count.quotes > 0).length,
        respondedAt: rfq.invitations[0]?.respondedAt?.toISOString() ?? null,
      }))
    );
  })
);

/** Load an RFQ only if this supplier was invited and it is visible; 404 otherwise. */
async function visibleRfqOrThrow(rfqId: number, supplierId: number) {
  const rfq = await prisma.rfq.findFirst({
    where: {
      id: rfqId,
      status: { in: VISIBLE_STATUSES },
      invitations: { some: { supplierId } },
    },
    select: {
      id: true,
      rfqNumber: true,
      title: true,
      description: true,
      status: true,
      dueDate: true,
      sentAt: true,
      closedAt: true,
      lines: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          quantity: true,
          notes: true,
          awardedSupplierId: true,
          part: { select: { partNumber: true, name: true, uom: true } },
          quotes: {
            where: { supplierId },
            select: {
              id: true,
              unitPrice: true,
              currency: true,
              leadTimeDays: true,
              moq: true,
              notes: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  // 404 rather than 403: a supplier must not learn that an RFQ exists (rule P4).
  if (!rfq) throw new HttpError(404, 'Request for quote not found');
  return rfq;
}

type VisibleRfq = Awaited<ReturnType<typeof visibleRfqOrThrow>>;

function toPortalRfqDetail(rfq: VisibleRfq, supplierId: number) {
  return {
    id: rfq.id,
    rfqNumber: rfq.rfqNumber,
    title: rfq.title,
    description: rfq.description,
    status: rfq.status,
    dueDate: rfq.dueDate ? rfq.dueDate.toISOString() : null,
    sentAt: rfq.sentAt ? rfq.sentAt.toISOString() : null,
    closedAt: rfq.closedAt ? rfq.closedAt.toISOString() : null,
    /** Quoting is only open while the RFQ is out for quote. */
    open: rfq.status === RfqStatus.SENT,
    lines: rfq.lines.map((line) => {
      const mine = line.quotes[0];
      return {
        id: line.id,
        part: line.part,
        quantity: line.quantity,
        notes: line.notes,
        // Whether *they* won. A line awarded to a competitor names nobody.
        awarded: line.awardedSupplierId !== null,
        awardedToMe: line.awardedSupplierId === supplierId,
        myQuote: mine
          ? {
              id: mine.id,
              unitPrice: mine.unitPrice,
              currency: mine.currency,
              leadTimeDays: mine.leadTimeDays,
              moq: mine.moq,
              notes: mine.notes,
              extendedPrice: mine.unitPrice * line.quantity,
              createdAt: mine.createdAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

router.get(
  '/portal/rfqs/:id',
  requireSupplierAuth,
  asyncHandler(async (req, res) => {
    const user = portalUser(req);
    const rfq = await visibleRfqOrThrow(idParam(req.params.id), user.supplierId);
    res.json(toPortalRfqDetail(rfq, user.supplierId));
  })
);

router.post(
  '/portal/rfq-lines/:id/quotes',
  requireSupplierAuth,
  asyncHandler(async (req, res) => {
    const user = portalUser(req);
    const lineId = idParam(req.params.id);
    const body = bodyOf(req);

    const unitPrice = body.unitPrice;
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new HttpError(400, 'unitPrice must be a number greater than 0');
    }
    const currency =
      body.currency === undefined || body.currency === null
        ? 'USD'
        : requireString(body.currency, 'currency').toUpperCase().slice(0, 3);
    const optionalNumber = (value: unknown, field: string): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new HttpError(400, `${field} must be a number >= 0`);
      }
      return value;
    };
    const leadTimeDays = optionalNumber(body.leadTimeDays, 'leadTimeDays');
    const moq = optionalNumber(body.moq, 'moq');
    const notes =
      body.notes === undefined || body.notes === null
        ? null
        : String(body.notes).trim().slice(0, 1000) || null;

    const line = await prisma.rfqLine.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        awardedSupplierId: true,
        rfq: { select: { id: true, status: true } },
      },
    });
    // Scope check before anything else: an uninvited supplier gets the same 404 as a
    // non-existent line.
    if (!line) throw new HttpError(404, 'Line not found');
    const invitation = await prisma.rfqInvitation.findUnique({
      where: { rfqId_supplierId: { rfqId: line.rfq.id, supplierId: user.supplierId } },
      select: { id: true },
    });
    if (!invitation) throw new HttpError(404, 'Line not found');

    if (line.rfq.status !== RfqStatus.SENT) {
      throw new HttpError(409, 'This request for quote is no longer accepting quotes');
    }
    if (line.awardedSupplierId !== null) {
      throw new HttpError(409, 'This line has already been awarded');
    }

    // Re-submitting replaces the previous price rather than stacking a second quote:
    // one quote per supplier per line is the existing rule.
    await prisma.$transaction(async (tx) => {
      await tx.rfqQuote.deleteMany({ where: { rfqLineId: lineId, supplierId: user.supplierId } });
      await tx.rfqQuote.create({
        data: {
          rfqLineId: lineId,
          supplierId: user.supplierId,
          unitPrice,
          currency,
          leadTimeDays,
          moq,
          notes,
        },
      });
      await tx.rfqInvitation.update({
        where: { id: invitation.id },
        data: { respondedAt: new Date() },
      });
    });

    const rfq = await visibleRfqOrThrow(line.rfq.id, user.supplierId);
    res.status(201).json(toPortalRfqDetail(rfq, user.supplierId));
  })
);

router.delete(
  '/portal/rfq-quotes/:id',
  requireSupplierAuth,
  asyncHandler(async (req, res) => {
    const user = portalUser(req);
    const quoteId = idParam(req.params.id);
    const quote = await prisma.rfqQuote.findUnique({
      where: { id: quoteId },
      select: {
        id: true,
        supplierId: true,
        rfqLine: { select: { awardedSupplierId: true, rfq: { select: { id: true, status: true } } } },
      },
    });
    // Someone else's quote is reported as missing, not forbidden.
    if (!quote || quote.supplierId !== user.supplierId) throw new HttpError(404, 'Quote not found');
    if (quote.rfqLine.rfq.status !== RfqStatus.SENT) {
      throw new HttpError(409, 'This request for quote is no longer accepting changes');
    }
    if (quote.rfqLine.awardedSupplierId !== null) {
      throw new HttpError(409, 'This line has already been awarded');
    }

    await prisma.rfqQuote.delete({ where: { id: quoteId } });
    const rfq = await visibleRfqOrThrow(quote.rfqLine.rfq.id, user.supplierId);
    res.json(toPortalRfqDetail(rfq, user.supplierId));
  })
);

export default router;
