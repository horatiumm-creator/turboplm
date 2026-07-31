/**
 * Electronic signatures — rules S1–S4.
 *
 * The properties worth defending: the feature is opt-in, re-authentication is mandatory,
 * a requirement is satisfied by exactly who it names, and a signature stops counting the
 * moment the signed content changes — but *not* when the lifecycle advances, which is the
 * thing the signature authorized in the first place.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle, Role, SignatureStatus } from '@prisma/client';
import { Client, createAndLogin, createUser, DEFAULT_PASSWORD, login, loginWithoutPassword } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, createPart, createReleasedPart } from './helpers/factories';

let admin: Client;
let engineer: Client;

beforeEach(async () => {
  admin = await createAndLogin({ role: Role.ADMIN, name: 'Ada Admin' });
  engineer = await createAndLogin({ role: Role.ENGINEER, name: 'Eve Engineer' });
});

function part(options: Partial<Parameters<typeof createPart>[0]> = {}) {
  return createPart({ createdById: engineer.id, ...options });
}

async function requireSignature(options: {
  entityType: 'REVISION' | 'ECN' | 'DOCUMENT';
  meaning?: string;
  role?: Role;
  userId?: number;
  seq?: number;
}) {
  const res = await admin.post('/api/signature-requirements', {
    entityType: options.entityType,
    meaning: options.meaning ?? 'APPROVED',
    seq: options.seq ?? 1,
    ...(options.userId !== undefined ? { userId: options.userId } : { role: options.role ?? Role.ENGINEER }),
  });
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

/** A releasable assembly: one BOM line whose child already has a released revision. */
async function releasableAssembly(partNumber: string) {
  const assembly = await part({ partNumber });
  const child = await createReleasedPart({
    createdById: engineer.id,
    partNumber: `${partNumber}-C`,
  });
  const line = await addBomLine({
    parentRevisionId: assembly.revisionId,
    childPartId: child.id,
    quantity: 2,
  });
  return { assembly, child, lineId: line.id };
}

async function ecnReadyToApprove(client: Client = engineer) {
  const p = await part({ partNumber: `SIG-ECN-${Math.random().toString(36).slice(2, 7)}` });
  const ecn = await client.post('/api/ecns', { title: 'Signed change' });
  const item = await client.post(`/api/ecns/${ecn.body.id}/items`, { partId: p.id });
  await client.post(`/api/ecn-items/${item.body.id}/revision`);
  return { ecn: ecn.body as { id: number; ecnNumber: string }, part: p, itemId: item.body.id as number };
}

describe('rule S1 — requirement administration', () => {
  it('is admin-only', async () => {
    const res = await engineer.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      role: Role.ENGINEER,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Administrator access required');
  });

  it('requires exactly one of role or userId', async () => {
    const neither = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
    });
    expect(neither.status).toBe(400);
    expect(neither.body.error).toBe('Give exactly one of role or userId');

    const both = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      role: Role.ENGINEER,
      userId: engineer.id,
    });
    expect(both.status).toBe(400);
  });

  it('refuses a read-only signer', async () => {
    const viewer = await createUser({ role: Role.VIEWER });
    const byRole = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      role: Role.VIEWER,
    });
    expect(byRole.status).toBe(400);
    expect(byRole.body.error).toBe('A read-only role cannot be a signer');

    const byUser = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      userId: viewer.id,
    });
    expect(byUser.status).toBe(400);
  });

  it('rejects a duplicate (entityType, meaning, seq)', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const clash = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      seq: 1,
      role: Role.ADMIN,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('A APPROVED requirement already exists at step 1');
  });
});

describe('rule S4 — opt-in: no requirements, nothing gated', () => {
  it('releases a revision with an empty manifest', async () => {
    const { assembly } = await releasableAssembly('SIG-OPTIN');
    const manifest = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(manifest.status).toBe(200);
    expect(manifest.body.entries).toEqual([]);
    expect(manifest.body.complete).toBe(true);
    expect(manifest.body.outstanding).toEqual([]);

    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const released = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(released.status).toBe(200);
    expect(released.body.lifecycle).toBe('RELEASED');
  });

  it('approves an ECN with an empty manifest', async () => {
    const { ecn } = await ecnReadyToApprove();
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(res.status).toBe(200);
  });

  it('ignores an inactive requirement', async () => {
    const requirement = await requireSignature({ entityType: 'REVISION' });
    await admin.patch(`/api/signature-requirements/${requirement.id}`, { active: false });

    const { assembly } = await releasableAssembly('SIG-INACTIVE');
    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(200);
  });
});

describe('rule S4 — release gates', () => {
  it('blocks a revision release with the exact outstanding message', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-BLOCK');
    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot release: signatures outstanding for: APPROVED');

    const after = await prisma.partRevision.findUnique({ where: { id: assembly.revisionId } });
    expect(after?.lifecycle).toBe(Lifecycle.IN_REVIEW);
  });

  it('lists every outstanding meaning in requirement order', async () => {
    await requireSignature({ entityType: 'REVISION', meaning: 'REVIEWED', seq: 1 });
    await requireSignature({ entityType: 'REVISION', meaning: 'APPROVED', seq: 2 });
    const { assembly } = await releasableAssembly('SIG-MULTI');
    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.body.error).toBe('Cannot release: signatures outstanding for: REVIEWED, APPROVED');
  });

  it('blocks an ECN approval with the exact outstanding message', async () => {
    await requireSignature({ entityType: 'ECN' });
    const { ecn } = await ecnReadyToApprove();
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot approve: signatures outstanding for: APPROVED');
  });

  it('releases once the requirement is signed', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-PASS');

    const signed = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(signed.status).toBe(201);
    expect(signed.body.complete).toBe(true);

    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(200);
  });

  it('gates a revision released through an ECN by the ECN manifest, not the revision one', async () => {
    // A REVISION requirement exists and is unsigned; the ECN has none. E6 release must
    // not ask the revision to satisfy a gate it was never meant to.
    await requireSignature({ entityType: 'REVISION' });
    const { ecn } = await ecnReadyToApprove();
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });

    const res = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'release' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RELEASED');
  });
});

describe('rule S2 — re-authentication', () => {
  it('records a PASSWORD signature with the printed name and role', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-AUTH');

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
      comment: 'Reviewed the drawing',
    });
    expect(res.status).toBe(201);
    const entry = res.body.entries[0];
    expect(entry.signature).toMatchObject({
      meaning: 'APPROVED',
      authMethod: 'PASSWORD',
      status: 'VALID',
      signedName: 'Eve Engineer',
      signedRole: 'ENGINEER',
      comment: 'Reviewed the drawing',
    });
  });

  it('rejects a wrong password with 401', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-BADPW');

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: 'not-my-password',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Password is incorrect');
    expect(await prisma.electronicSignature.count()).toBe(0);
  });

  it('refuses a signature with no re-authentication at all', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-NOPW');

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Re-enter your password to sign');
    expect(await prisma.electronicSignature.count()).toBe(0);
  });

  it('takes an email confirmation from a password-less account', async () => {
    const googleUser = await createUser({
      role: Role.ENGINEER,
      name: 'Gina Google',
      password: null,
    });
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-EMAIL');
    const google = loginWithoutPassword(googleUser);

    const res = await google.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      confirmEmail: googleUser.email.toUpperCase(),
    });
    expect(res.status).toBe(201);
    expect(res.body.entries[0].signature).toMatchObject({
      authMethod: 'EMAIL_CONFIRM',
      signedName: 'Gina Google',
    });
  });

  it('rejects a mismatched email confirmation with 401', async () => {
    const googleUser = await createUser({ role: Role.ENGINEER, password: null });
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-EMAIL-BAD');
    const google = loginWithoutPassword(googleUser);

    const res = await google.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      confirmEmail: 'someone.else@turboplm.test',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('That is not your email address');

    const missing = await google.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('Retype your email address to sign');
  });

  it('refuses a signature from a read-only account', async () => {
    const viewer = await createAndLogin({ role: Role.VIEWER });
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-VIEWER');

    const res = await viewer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(await prisma.electronicSignature.count()).toBe(0);
  });
});

describe('rule S2 — who may satisfy a requirement', () => {
  it('does not let an ADMIN satisfy an ENGINEER requirement', async () => {
    await requireSignature({ entityType: 'REVISION', role: Role.ENGINEER });
    const { assembly } = await releasableAssembly('SIG-ROLE');

    const res = await admin.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('APPROVED must be signed by ENGINEER');
    expect(await prisma.electronicSignature.count()).toBe(0);

    // The requirement is still outstanding after the refused attempt.
    const manifest = await admin.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(manifest.body.complete).toBe(false);
  });

  it('does not let an ENGINEER satisfy an ADMIN requirement', async () => {
    await requireSignature({ entityType: 'REVISION', role: Role.ADMIN });
    const { assembly } = await releasableAssembly('SIG-ROLE-REV');

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('APPROVED must be signed by ADMIN');
  });

  it('binds a named requirement to that person only', async () => {
    const namedUser = await createUser({ role: Role.ENGINEER, name: 'Quinn QA' });
    const named = await login(namedUser);
    await requireSignature({ entityType: 'REVISION', userId: namedUser.id });
    const { assembly } = await releasableAssembly('SIG-NAMED');

    const wrongPerson = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(wrongPerson.status).toBe(409);
    expect(wrongPerson.body.error).toBe('APPROVED must be signed by Quinn QA');

    const right = await named.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(right.status).toBe(201);
    expect(right.body.complete).toBe(true);
  });

  it('rejects a meaning nothing requires', async () => {
    await requireSignature({ entityType: 'REVISION', meaning: 'APPROVED' });
    const { assembly } = await releasableAssembly('SIG-UNREQ');

    const res = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'QA_APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('QA_APPROVED is not a required signature for this REVISION');
  });

  it('rejects a second signature of the same meaning by the same user', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-TWICE');
    const first = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(first.status).toBe(201);

    const second = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('You have already signed this as APPROVED');
    expect(await prisma.electronicSignature.count()).toBe(1);
  });
});

describe('rule S3 — content hashing and voiding', () => {
  it('voids a revision signature when a BOM line changes, and re-blocks the release', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly, lineId } = await releasableAssembly('SIG-VOID');

    const signed = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(signed.status).toBe(201);
    const hashBefore = signed.body.contentHash as string;

    const patched = await engineer.patch(`/api/bom-lines/${lineId}`, { quantity: 9 });
    expect(patched.status).toBe(200);

    const manifest = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(manifest.body.contentHash).not.toBe(hashBefore);
    expect(manifest.body.complete).toBe(false);
    expect(manifest.body.outstanding).toEqual(['APPROVED']);
    expect(manifest.body.entries[0].signature).toBeNull();
    // The void is recorded, not erased: the audit trail keeps the fact it was signed.
    expect(manifest.body.history[0]).toMatchObject({
      status: 'VOIDED',
      voidedReason: `${assembly.partNumber} rev A changed after signing`,
    });

    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const blocked = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('Cannot release: signatures outstanding for: APPROVED');
  });

  it('voids without anyone reading the manifest first — the gate itself catches it', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly, lineId } = await releasableAssembly('SIG-VOID-GATE');
    await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    await engineer.delete(`/api/bom-lines/${lineId}`);
    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });

    const blocked = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(blocked.status).toBe(409);
    const signature = await prisma.electronicSignature.findFirst();
    expect(signature?.status).toBe(SignatureStatus.VOIDED);
  });

  it('does NOT void on a lifecycle transition — that is what the signature authorized', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-LIFECYCLE');
    const signed = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    const hash = signed.body.contentHash as string;

    await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, { action: 'submit' });
    const afterSubmit = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(afterSubmit.body.contentHash).toBe(hash);
    expect(afterSubmit.body.entries[0].signature.status).toBe('VALID');
    expect(afterSubmit.body.complete).toBe(true);

    const released = await engineer.post(`/api/revisions/${assembly.revisionId}/transition`, {
      action: 'approve',
    });
    expect(released.status).toBe(200);

    const afterRelease = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(afterRelease.body.contentHash).toBe(hash);
    expect(afterRelease.body.entries[0].signature.status).toBe('VALID');
  });

  it('is insensitive to BOM line order but sensitive to BOM content', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly, lineId } = await releasableAssembly('SIG-HASH');
    const signed = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    const hash = signed.body.contentHash as string;

    // Notes are not part of what a signer attests to.
    await engineer.patch(`/api/bom-lines/${lineId}`, { notes: 'Torque to 4 Nm' });
    const afterNote = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(afterNote.body.contentHash).toBe(hash);
    expect(afterNote.body.complete).toBe(true);

    // Ref designators are.
    await engineer.patch(`/api/bom-lines/${lineId}`, { refDesignators: 'R1' });
    const afterRefDes = await engineer.get(`/api/revisions/${assembly.revisionId}/signatures`);
    expect(afterRefDes.body.contentHash).not.toBe(hash);
    expect(afterRefDes.body.complete).toBe(false);
  });

  it('voids an ECN signature when its affected items change', async () => {
    await requireSignature({ entityType: 'ECN' });
    const { ecn } = await ecnReadyToApprove();
    const signed = await engineer.post(`/api/ecns/${ecn.id}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(signed.status).toBe(201);
    expect(signed.body.complete).toBe(true);

    const extra = await part({ partNumber: 'SIG-ECN-EXTRA' });
    const added = await engineer.post(`/api/ecns/${ecn.id}/items`, { partId: extra.id });
    expect(added.status).toBe(201);
    // Give it a working revision too, so the approve attempt below reaches the
    // signature gate rather than stopping at E5.
    await engineer.post(`/api/ecn-items/${added.body.id}/revision`);

    const manifest = await engineer.get(`/api/ecns/${ecn.id}/signatures`);
    expect(manifest.body.complete).toBe(false);
    expect(manifest.body.history[0].status).toBe('VOIDED');

    await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'submit' });
    const blocked = await engineer.post(`/api/ecns/${ecn.id}/transition`, { action: 'approve' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('Cannot approve: signatures outstanding for: APPROVED');
  });

  it('lets the same user re-sign after their signature was voided', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly, lineId } = await releasableAssembly('SIG-RESIGN');
    await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    await engineer.patch(`/api/bom-lines/${lineId}`, { quantity: 4 });

    const again = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    expect(again.status).toBe(201);
    expect(again.body.complete).toBe(true);
    // Append-only: the voided record is kept alongside the new one.
    expect(await prisma.electronicSignature.count()).toBe(2);
    expect(again.body.history).toHaveLength(2);
  });

  it('never exposes a way to update or delete a signature', async () => {
    await requireSignature({ entityType: 'REVISION' });
    const { assembly } = await releasableAssembly('SIG-APPEND');
    const signed = await engineer.post(`/api/revisions/${assembly.revisionId}/signatures`, {
      meaning: 'APPROVED',
      password: DEFAULT_PASSWORD,
    });
    const signatureId = signed.body.entries[0].signature.id as number;

    expect((await engineer.delete(`/api/signatures/${signatureId}`)).status).toBe(404);
    expect((await engineer.patch(`/api/signatures/${signatureId}`, { status: 'VOIDED' })).status).toBe(
      404
    );
  });
});
