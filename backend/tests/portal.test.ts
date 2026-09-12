/**
 * Supplier portal — rules P1–P4.
 *
 * This suite is written adversarially: nearly every case is something a supplier must NOT
 * be able to do. The portal is the only place an external party touches the system, so the
 * interesting assertions are about absence — a field that is not in the payload, an RFQ
 * that does not appear, a token that stops working.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { prisma, resetDatabase } from './helpers/db';
import {
  Client,
  PORTAL_PASSWORD,
  app,
  createAndLogin,
  createPortalAccount,
  request,
} from './helpers/api';
import { createPart as makePart } from './helpers/factories';

let buyer: Client;
let acmeId: number;
let nordicId: number;

/** An RFQ with one line, both suppliers invited, sent out for quote. */
async function sentRfq(options: { quantity?: number; targetPrice?: number } = {}) {
  const part = await makePart({ createdById: buyer.id });
  const rfq = await buyer.post('/api/rfqs', { title: 'Machined housings' });
  expect(rfq.status).toBe(201);
  const line = await buyer.post(`/api/rfqs/${rfq.body.id}/lines`, {
    partId: part.id,
    quantity: options.quantity ?? 100,
    ...(options.targetPrice !== undefined ? { targetPrice: options.targetPrice } : {}),
  });
  expect(line.status).toBe(201);
  for (const supplierId of [acmeId, nordicId]) {
    expect((await buyer.post(`/api/rfqs/${rfq.body.id}/invitations`, { supplierId })).status).toBe(
      201
    );
  }
  expect((await buyer.post(`/api/rfqs/${rfq.body.id}/transition`, { action: 'send' })).status).toBe(
    200
  );
  return { rfqId: rfq.body.id as number, lineId: line.body.lines[0].id as number };
}

beforeEach(async () => {
  await resetDatabase();
  buyer = await createAndLogin({ role: Role.ADMIN });
  const acme = await buyer.post('/api/suppliers', { code: 'ACME', name: 'Acme Precision' });
  const nordic = await buyer.post('/api/suppliers', { code: 'NORDIC', name: 'Nordic CNC' });
  acmeId = acme.body.id;
  nordicId = nordic.body.id;
});

describe('rule P1 — the internal and portal identities never cross', () => {
  it('rejects an internal session at every portal route', async () => {
    for (const path of ['/api/portal/me', '/api/portal/rfqs']) {
      expect((await buyer.get(path)).status).toBe(401);
    }
  });

  it('rejects a portal session across the internal API', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const paths = [
      '/api/parts',
      '/api/ecns',
      '/api/documents',
      '/api/users',
      '/api/suppliers',
      '/api/rfqs',
      '/api/analytics',
      '/api/stats',
      '/api/signature-requirements',
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set('Cookie', supplier.rawCookie);
      expect(res.status, `${path} must reject a portal token`).toBe(401);
    }
  });

  it('rejects a portal session on an internal mutation', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const res = await request(app)
      .post('/api/parts')
      .set('Cookie', supplier.rawCookie)
      .send({ name: 'Smuggled part', category: 'MECHANICAL' });
    expect(res.status).toBe(401);
  });

  it('ends the session as soon as the account is deactivated', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    expect((await supplier.get('/api/portal/me')).status).toBe(200);

    expect(
      (await buyer.patch(`/api/supplier-users/${supplier.account.id}`, { active: false })).status
    ).toBe(200);
    // The cookie is still cryptographically valid; the middleware re-reads the account.
    expect((await supplier.get('/api/portal/me')).status).toBe(401);
  });

  it('ends the session when the whole supplier is deactivated', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    expect((await buyer.patch(`/api/suppliers/${acmeId}`, { active: false })).status).toBe(200);
    expect((await supplier.get('/api/portal/me')).status).toBe(401);
  });
});

describe('rule P3 — invitations and sign-in', () => {
  it('accepts an invitation exactly once', async () => {
    const invite = await buyer.post(`/api/suppliers/${acmeId}/users`, {
      email: 'once@vendor.test',
      name: 'One Shot',
    });
    expect(invite.status).toBe(201);
    const token = String(invite.body.inviteUrl).split('=').pop();

    const first = await request(app).post('/api/portal/accept-invite').send({
      token,
      password: PORTAL_PASSWORD,
    });
    expect(first.status).toBe(200);

    const replay = await request(app).post('/api/portal/accept-invite').send({
      token,
      password: 'a-different-password',
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('This invitation link is invalid or has expired');
  });

  it('gives an unknown token the same answer as a spent one', async () => {
    const res = await request(app).post('/api/portal/accept-invite').send({
      token: 'not-a-real-token',
      password: PORTAL_PASSWORD,
    });
    expect(res.status).toBe(400);
    // Identical wording, so the endpoint cannot be used to discover which tokens exist.
    expect(res.body.error).toBe('This invitation link is invalid or has expired');
  });

  it('refuses a short password', async () => {
    const invite = await buyer.post(`/api/suppliers/${acmeId}/users`, {
      email: 'weak@vendor.test',
      name: 'Weak',
    });
    const token = String(invite.body.inviteUrl).split('=').pop();
    const res = await request(app)
      .post('/api/portal/accept-invite')
      .send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('invalidates the previous token when the invitation is reset', async () => {
    const invite = await buyer.post(`/api/suppliers/${acmeId}/users`, {
      email: 'reset@vendor.test',
      name: 'Reset Me',
    });
    const firstToken = String(invite.body.inviteUrl).split('=').pop();

    const reissued = await buyer.post(`/api/supplier-users/${invite.body.id}/reset-invite`);
    expect(reissued.status).toBe(200);
    const secondToken = String(reissued.body.inviteUrl).split('=').pop();
    expect(secondToken).not.toBe(firstToken);

    const stale = await request(app)
      .post('/api/portal/accept-invite')
      .send({ token: firstToken, password: PORTAL_PASSWORD });
    expect(stale.status).toBe(400);

    const fresh = await request(app)
      .post('/api/portal/accept-invite')
      .send({ token: secondToken, password: PORTAL_PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('returns one message for every kind of failed sign-in', async () => {
    const supplier = await createPortalAccount({
      supplierId: acmeId,
      email: 'known@vendor.test',
      invitedBy: buyer,
    });

    const wrongPassword = await request(app)
      .post('/api/portal/login')
      .send({ email: 'known@vendor.test', password: 'wrong' });
    const unknownEmail = await request(app)
      .post('/api/portal/login')
      .send({ email: 'nobody@vendor.test', password: 'wrong' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Same status AND same body: a wrong password must be indistinguishable from an
    // address that was never invited.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error).toBe('Invalid email or password');

    await buyer.patch(`/api/supplier-users/${supplier.account.id}`, { active: false });
    const deactivated = await request(app)
      .post('/api/portal/login')
      .send({ email: 'known@vendor.test', password: PORTAL_PASSWORD });
    expect(deactivated.status).toBe(401);
    expect(deactivated.body).toEqual(unknownEmail.body);
  });

  it('refuses a duplicate portal email', async () => {
    await buyer.post(`/api/suppliers/${acmeId}/users`, { email: 'dup@vendor.test', name: 'A' });
    const second = await buyer.post(`/api/suppliers/${nordicId}/users`, {
      email: 'dup@vendor.test',
      name: 'B',
    });
    expect(second.status).toBe(409);
  });

  it('never returns the invitation token again after issuing it', async () => {
    const invite = await buyer.post(`/api/suppliers/${acmeId}/users`, {
      email: 'secret@vendor.test',
      name: 'Secret',
    });
    const token = String(invite.body.inviteUrl).split('=').pop();

    const listed = await buyer.get(`/api/suppliers/${acmeId}/users`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });
});

describe('rule P4 — what a supplier may see', () => {
  it('hides a DRAFT RFQ even from an invited supplier', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const part = await makePart({ createdById: buyer.id });
    const rfq = await buyer.post('/api/rfqs', { title: 'Not sent yet' });
    await buyer.post(`/api/rfqs/${rfq.body.id}/lines`, { partId: part.id, quantity: 10 });
    // Invited while still a draft — invitations are prepared before the RFQ goes out.
    await buyer.post(`/api/rfqs/${rfq.body.id}/invitations`, { supplierId: acmeId });

    expect((await supplier.get('/api/portal/rfqs')).body).toEqual([]);
    expect((await supplier.get(`/api/portal/rfqs/${rfq.body.id}`)).status).toBe(404);

    await buyer.post(`/api/rfqs/${rfq.body.id}/transition`, { action: 'send' });
    expect((await supplier.get('/api/portal/rfqs')).body).toHaveLength(1);
  });

  it('reports an uninvited RFQ as missing, not forbidden', async () => {
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const part = await makePart({ createdById: buyer.id });
    const rfq = await buyer.post('/api/rfqs', { title: 'Someone else’s business' });
    await buyer.post(`/api/rfqs/${rfq.body.id}/lines`, { partId: part.id, quantity: 5 });
    await buyer.post(`/api/rfqs/${rfq.body.id}/invitations`, { supplierId: nordicId });
    await buyer.post(`/api/rfqs/${rfq.body.id}/transition`, { action: 'send' });

    // 404 rather than 403: a supplier must not learn that the RFQ exists at all.
    expect((await supplier.get(`/api/portal/rfqs/${rfq.body.id}`)).status).toBe(404);
    expect((await supplier.get('/api/portal/rfqs')).body).toEqual([]);
  });

  it('exposes only own-quote fields on a line', async () => {
    const { rfqId, lineId } = await sentRfq({ quantity: 250, targetPrice: 42.5 });
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });

    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 44.8 });
    // A competitor undercuts them.
    await buyer.post(`/api/rfq-lines/${lineId}/quotes`, {
      supplierId: nordicId,
      unitPrice: 41.2,
    });

    const detail = await supplier.get(`/api/portal/rfqs/${rfqId}`);
    expect(detail.status).toBe(200);
    const [line] = detail.body.lines;

    expect(Object.keys(line).sort()).toEqual(
      ['awarded', 'awardedToMe', 'id', 'myQuote', 'notes', 'part', 'quantity'].sort()
    );
    expect(line.myQuote.unitPrice).toBe(44.8);

    const payload = JSON.stringify(detail.body);
    // The competitor's identity, their price, the ranking and the buyer's target price are
    // all withheld.
    expect(payload).not.toContain('Nordic');
    expect(payload).not.toContain('41.2');
    expect(payload).not.toContain('isLowest');
    expect(payload).not.toContain('42.5');
  });

  it('never names the winner of a line awarded elsewhere', async () => {
    const { rfqId, lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 50 });
    await buyer.post(`/api/rfq-lines/${lineId}/quotes`, { supplierId: nordicId, unitPrice: 45 });
    expect((await buyer.post(`/api/rfq-lines/${lineId}/award`, { supplierId: nordicId })).status).toBe(
      200
    );

    const [line] = (await supplier.get(`/api/portal/rfqs/${rfqId}`)).body.lines;
    expect(line.awarded).toBe(true);
    expect(line.awardedToMe).toBe(false);
    expect(JSON.stringify(line)).not.toContain('Nordic');
  });

  it('tells the winner that they won', async () => {
    const { rfqId, lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 40 });
    await buyer.post(`/api/rfq-lines/${lineId}/award`, { supplierId: acmeId });

    const [line] = (await supplier.get(`/api/portal/rfqs/${rfqId}`)).body.lines;
    expect(line.awarded).toBe(true);
    expect(line.awardedToMe).toBe(true);
  });

  it('counts only the supplier’s own coverage in the list', async () => {
    const { rfqId, lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    await buyer.post(`/api/rfq-lines/${lineId}/quotes`, { supplierId: nordicId, unitPrice: 30 });

    const [row] = (await supplier.get('/api/portal/rfqs')).body;
    expect(row.id).toBe(rfqId);
    // A competitor quoting must not show up as this supplier's progress.
    expect(row.myQuoteCount).toBe(0);
    expect(JSON.stringify(row)).not.toContain('quoteCount"');
  });
});

describe('rule P4 — submitting quotes', () => {
  it('records a quote and stamps the invitation as answered', async () => {
    const { rfqId, lineId } = await sentRfq({ quantity: 250 });
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });

    const res = await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, {
      unitPrice: 44.8,
      leadTimeDays: 35,
      notes: 'Price held 90 days',
    });
    expect(res.status).toBe(201);
    const [line] = res.body.lines;
    expect(line.myQuote.unitPrice).toBe(44.8);
    expect(line.myQuote.extendedPrice).toBe(44.8 * 250);

    const invitation = await prisma.rfqInvitation.findFirst({
      where: { rfqId, supplierId: acmeId },
    });
    expect(invitation?.respondedAt).not.toBeNull();
  });

  it('replaces rather than stacks a resubmitted quote', async () => {
    const { lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });

    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 50 });
    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 47 });

    // One quote per supplier per line is the existing rule; resubmitting revises it.
    const quotes = await prisma.rfqQuote.findMany({
      where: { rfqLineId: lineId, supplierId: acmeId },
    });
    expect(quotes).toHaveLength(1);
    expect(quotes[0].unitPrice).toBe(47);
  });

  it('refuses a quote on a line belonging to an RFQ it was not invited to', async () => {
    const part = await makePart({ createdById: buyer.id });
    const rfq = await buyer.post('/api/rfqs', { title: 'Private' });
    const line = await buyer.post(`/api/rfqs/${rfq.body.id}/lines`, {
      partId: part.id,
      quantity: 10,
    });
    await buyer.post(`/api/rfqs/${rfq.body.id}/invitations`, { supplierId: nordicId });
    await buyer.post(`/api/rfqs/${rfq.body.id}/transition`, { action: 'send' });

    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const res = await supplier.post(`/api/portal/rfq-lines/${line.body.lines[0].id}/quotes`, {
      unitPrice: 1,
    });
    // Reported as missing, so the line's existence stays hidden.
    expect(res.status).toBe(404);
  });

  it('refuses a quote once the RFQ is closed', async () => {
    const { rfqId, lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    await buyer.post(`/api/rfqs/${rfqId}/transition`, { action: 'close' });

    const res = await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 10 });
    expect(res.status).toBe(409);
    // A closed RFQ is still readable — the supplier can see what they submitted.
    expect((await supplier.get(`/api/portal/rfqs/${rfqId}`)).status).toBe(200);
  });

  it('refuses to change or withdraw a quote once the line is awarded', async () => {
    const { lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const created = await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, {
      unitPrice: 44,
    });
    const quoteId = created.body.lines[0].myQuote.id;
    await buyer.post(`/api/rfq-lines/${lineId}/award`, { supplierId: acmeId });

    expect((await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 1 })).status)
      .toBe(409);
    expect((await supplier.delete(`/api/portal/rfq-quotes/${quoteId}`)).status).toBe(409);
  });

  it('rejects a non-positive price', async () => {
    const { lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    for (const unitPrice of [0, -5, 'free']) {
      expect(
        (await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice })).status
      ).toBe(400);
    }
  });

  it('withdraws only the supplier’s own quote', async () => {
    const { lineId } = await sentRfq();
    const acme = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    const nordic = await createPortalAccount({ supplierId: nordicId, invitedBy: buyer });

    const mine = await acme.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 44 });
    const myQuoteId = mine.body.lines[0].myQuote.id;
    await nordic.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 41 });

    // Someone else's quote is reported as missing, not forbidden.
    const theirs = await prisma.rfqQuote.findFirst({
      where: { rfqLineId: lineId, supplierId: nordicId },
    });
    expect((await acme.delete(`/api/portal/rfq-quotes/${theirs!.id}`)).status).toBe(404);
    expect(await prisma.rfqQuote.count({ where: { id: theirs!.id } })).toBe(1);

    expect((await acme.delete(`/api/portal/rfq-quotes/${myQuoteId}`)).status).toBe(200);
    expect(await prisma.rfqQuote.count({ where: { id: myQuoteId } })).toBe(0);
  });
});

describe('rule P2 — invitation management is an internal, write-role action', () => {
  it('refuses to invite a supplier to a closed RFQ', async () => {
    const { rfqId } = await sentRfq();
    await buyer.post(`/api/rfqs/${rfqId}/transition`, { action: 'close' });
    const third = await buyer.post('/api/suppliers', { code: 'THIRD', name: 'Third Party' });
    const res = await buyer.post(`/api/rfqs/${rfqId}/invitations`, { supplierId: third.body.id });
    expect(res.status).toBe(409);
  });

  it('refuses a duplicate invitation', async () => {
    const { rfqId } = await sentRfq();
    expect((await buyer.post(`/api/rfqs/${rfqId}/invitations`, { supplierId: acmeId })).status).toBe(
      409
    );
  });

  it('refuses to revoke an invitation once that supplier has quoted', async () => {
    const { rfqId, lineId } = await sentRfq();
    const supplier = await createPortalAccount({ supplierId: acmeId, invitedBy: buyer });
    await supplier.post(`/api/portal/rfq-lines/${lineId}/quotes`, { unitPrice: 44 });

    const invitations = await buyer.get(`/api/rfqs/${rfqId}/invitations`);
    const mine = invitations.body.find(
      (i: { supplier: { id: number }; id: number }) => i.supplier.id === acmeId
    );
    // Revoking would orphan the quote already on the record.
    expect((await buyer.delete(`/api/rfq-invitations/${mine.id}`)).status).toBe(409);
  });

  it('blocks a viewer from creating portal accounts or invitations', async () => {
    const viewer = await createAndLogin({ role: Role.VIEWER });
    const { rfqId } = await sentRfq();
    expect(
      (await viewer.post(`/api/suppliers/${acmeId}/users`, { email: 'v@v.test', name: 'V' })).status
    ).toBe(403);
    expect((await viewer.post(`/api/rfqs/${rfqId}/invitations`, { supplierId: acmeId })).status).toBe(
      403
    );
  });
});
