/**
 * Role-based access control (rules T9 and the app-wide write guard).
 *
 * The guard is mounted once in index.ts and keys off the HTTP method, so the risk is not
 * that one handler forgets it — it is that a route slips outside the mount, or that an
 * exemption grows wider than intended. These tests therefore sweep a route per router
 * rather than testing the middleware in isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { Client, createAndLogin, createUser } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, createPart, createProcessPlan, addOperation } from './helpers/factories';

let admin: Client;
let engineer: Client;
let viewer: Client;

beforeEach(async () => {
  admin = await createAndLogin({ role: Role.ADMIN });
  engineer = await createAndLogin({ role: Role.ENGINEER });
  viewer = await createAndLogin({ role: Role.VIEWER });
});

/** One real id per route family, so a 403 cannot be mistaken for a 404. */
async function fixtures() {
  const assembly = await createPart({ createdById: engineer.id, partNumber: 'RBAC-ASM' });
  const child = await createPart({ createdById: engineer.id, partNumber: 'RBAC-CHILD' });
  const line = await addBomLine({
    parentRevisionId: assembly.revisionId,
    childPartId: child.id,
  });
  const plan = await createProcessPlan(assembly.revisionId);
  const operation = await addOperation({ planId: plan.id, seq: 10 });
  const ecn = await engineer.post('/api/ecns', { title: 'RBAC change' });
  const ecr = await engineer.post('/api/ecrs', { title: 'RBAC request', description: 'why' });
  return {
    assembly,
    child,
    lineId: line.id,
    planId: plan.id,
    operationId: operation.id,
    ecnId: ecn.body.id as number,
    ecrId: ecr.body.id as number,
  };
}

describe('VIEWER is read-only', () => {
  it('blocks every mutating route with the same 403', async () => {
    const f = await fixtures();
    const mutations: [string, string, unknown?][] = [
      ['post', '/api/parts', { name: 'Nope', category: 'MECHANICAL' }],
      ['patch', `/api/parts/${f.assembly.id}`, { name: 'Renamed' }],
      ['delete', `/api/parts/${f.child.id}`],
      ['post', `/api/parts/${f.assembly.id}/revisions`],
      ['patch', `/api/revisions/${f.assembly.revisionId}`, { changeNote: 'x' }],
      ['post', `/api/revisions/${f.assembly.revisionId}/transition`, { action: 'submit' }],
      ['post', `/api/revisions/${f.assembly.revisionId}/bom`, { childPartId: f.child.id, quantity: 1 }],
      ['patch', `/api/bom-lines/${f.lineId}`, { quantity: 2 }],
      ['delete', `/api/bom-lines/${f.lineId}`],
      ['post', `/api/bom-lines/${f.lineId}/alternates`, { partId: f.child.id }],
      ['put', `/api/revisions/${f.assembly.revisionId}/process-plan`, { name: 'Plan' }],
      ['post', `/api/process-plans/${f.planId}/operations`, { name: 'Op' }],
      ['patch', `/api/operations/${f.operationId}`, { name: 'Op2' }],
      ['delete', `/api/operations/${f.operationId}`],
      ['post', `/api/operations/${f.operationId}/materials`, { partId: f.child.id, quantity: 1 }],
      ['post', `/api/revisions/${f.assembly.revisionId}/process-plan/from-bom`],
      ['post', `/api/revisions/${f.assembly.revisionId}/bom-from-cad`, { documentVersionId: 1 }],
      ['post', '/api/ecns', { title: 'Nope' }],
      ['patch', `/api/ecns/${f.ecnId}`, { title: 'Nope' }],
      ['delete', `/api/ecns/${f.ecnId}`],
      ['post', `/api/ecns/${f.ecnId}/items`, { partId: f.assembly.id }],
      ['post', `/api/ecns/${f.ecnId}/transition`, { action: 'submit' }],
      ['post', `/api/ecns/${f.ecnId}/reviewers`, { userId: 1 }],
      ['post', '/api/ecrs', { title: 'Nope', description: 'x' }],
      ['patch', `/api/ecrs/${f.ecrId}`, { title: 'Nope' }],
      ['post', `/api/ecrs/${f.ecrId}/accept`, {}],
      ['post', '/api/manufacturers', { name: 'Acme' }],
      ['post', `/api/parts/${f.assembly.id}/manufacturer-parts`, { manufacturerId: 1, mpn: 'X' }],
      ['put', `/api/parts/${f.assembly.id}/attributes`, { values: {} }],
      ['post', '/api/baselines', { name: 'Nope', partRevisionId: f.assembly.revisionId }],
      ['post', '/api/requirements', { title: 'Nope', statement: 'x' }],
      ['post', '/api/ncrs', { title: 'Nope', description: 'x' }],
      ['post', '/api/capas', { title: 'Nope', problem: 'x', ownerId: 1 }],
      ['post', '/api/projects', { code: 'PRJ-1', name: 'Nope', ownerId: 1 }],
      ['post', '/api/suppliers', { code: 'SUP-1', name: 'Acme' }],
      ['post', '/api/rfqs', { title: 'Nope' }],
      ['post', `/api/parts/${f.assembly.id}/option-groups`, { code: 'CLR', name: 'Colour' }],
      ['post', `/api/revisions/${f.assembly.revisionId}/signatures`, { meaning: 'APPROVED' }],
      ['post', '/api/erp/import/parts', { csv: 'partNumber,name\nX,Y' }],
    ];

    for (const [method, path, body] of mutations) {
      const res = await (viewer as unknown as Record<string, (p: string, b?: unknown) => Promise<{ status: number; body: { error?: string } }>>)[
        method
      ](path, body);
      expect(`${method.toUpperCase()} ${path} → ${res.status}`).toBe(
        `${method.toUpperCase()} ${path} → 403`
      );
      expect(res.body.error).toBe('Viewers have read-only access');
    }
  });

  it('leaves the same routes reachable for an ENGINEER', async () => {
    // Proves the 403s above come from the role guard, not from every route failing.
    const f = await fixtures();
    const attempts: [string, string, unknown?][] = [
      ['patch', `/api/parts/${f.assembly.id}`, { name: 'Renamed' }],
      ['patch', `/api/bom-lines/${f.lineId}`, { quantity: 2 }],
      ['post', '/api/ecns', { title: 'Allowed' }],
      ['post', `/api/process-plans/${f.planId}/operations`, { name: 'Op' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await (engineer as unknown as Record<string, (p: string, b?: unknown) => Promise<{ status: number }>>)[
        method
      ](path, body);
      expect(res.status).toBeLessThan(300);
    }
  });

  it('allows reads', async () => {
    const f = await fixtures();
    for (const path of [
      '/api/parts',
      `/api/parts/${f.assembly.id}`,
      `/api/revisions/${f.assembly.revisionId}/bom`,
      `/api/revisions/${f.assembly.revisionId}/bom/tree`,
      `/api/parts/${f.child.id}/where-used`,
      '/api/ecns',
      '/api/stats',
      '/api/my-work',
      '/api/audit',
      '/api/users',
      '/api/notifications',
      '/api/analytics',
    ]) {
      const res = await viewer.get(path);
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
    }
  });

  it('still lets a viewer clear their own notifications', async () => {
    // Documented exemption: inbox state is self-scoped, and viewers receive
    // notifications as reviewers.
    await prisma.notification.create({
      data: { userId: viewer.id, type: 'TEST', title: 'Something happened' },
    });
    const res = await viewer.post('/api/notifications/read', { all: true });
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(0);
  });

  it('still lets a viewer resolve a variant configuration, which writes nothing', async () => {
    const f = await fixtures();
    const res = await viewer.post(`/api/revisions/${f.assembly.revisionId}/resolve-variant`, {
      selections: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.included).toBeDefined();
  });
});

describe('admin-only routes', () => {
  const adminOnly: [string, string, unknown?][] = [
    ['post', '/api/attribute-defs', { category: 'MECHANICAL', name: 'finish', label: 'Finish', type: 'TEXT' }],
    ['post', '/api/signature-requirements', { entityType: 'REVISION', meaning: 'APPROVED', role: 'ENGINEER' }],
    ['post', '/api/api-keys', { name: 'key', scopes: 'read' }],
    ['post', '/api/webhooks', { name: 'hook', url: 'https://example.com/h', events: ['part.released'] }],
    ['post', '/api/workflow-templates', { name: 'Flow', steps: [{ name: 'Step', rule: 'ANY', role: 'ENGINEER' }] }],
    ['post', '/api/email/test', { to: 'nobody@example.com' }],
  ];

  it.each(adminOnly)('rejects an ENGINEER on %s %s', async (method, path, body) => {
    const res = await (engineer as unknown as Record<string, (p: string, b?: unknown) => Promise<{ status: number; body: { error?: string } }>>)[
      method
    ](path, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Administrator access required');
  });

  it.each(adminOnly)('rejects a VIEWER on %s %s before it ever reaches the handler', async (method, path, body) => {
    const res = await (viewer as unknown as Record<string, (p: string, b?: unknown) => Promise<{ status: number; body: { error?: string } }>>)[
      method
    ](path, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Viewers have read-only access');
  });

  it('lets an ADMIN through the same routes', async () => {
    const created = await admin.post('/api/attribute-defs', {
      category: 'MECHANICAL',
      name: 'finish',
      label: 'Finish',
      type: 'TEXT',
    });
    expect(created.status).toBe(201);

    const requirement = await admin.post('/api/signature-requirements', {
      entityType: 'REVISION',
      meaning: 'APPROVED',
      role: Role.ENGINEER,
    });
    expect(requirement.status).toBe(201);
  });

  it('restricts role changes to admins and refuses self-demotion', async () => {
    const target = await createUser({ role: Role.ENGINEER });

    const byEngineer = await engineer.patch(`/api/users/${target.id}`, { role: 'VIEWER' });
    expect(byEngineer.status).toBe(403);

    const byAdmin = await admin.patch(`/api/users/${target.id}`, { role: 'VIEWER' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.role).toBe('VIEWER');

    const self = await admin.patch(`/api/users/${admin.id}`, { role: 'VIEWER' });
    expect(self.status).toBe(409);
    expect(self.body.error).toBe('You cannot change your own role');
  });

  it('validates the role value', async () => {
    const target = await createUser();
    const res = await admin.patch(`/api/users/${target.id}`, { role: 'SUPERUSER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('role must be one of ADMIN, ENGINEER, VIEWER');
  });
});

describe('authentication', () => {
  it('rejects every unauthenticated call under /api', async () => {
    const { request, app } = await import('./helpers/api');
    for (const path of ['/api/parts', '/api/ecns', '/api/stats', '/api/users']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    }
    const write = await request(app).post('/api/parts').send({ name: 'x', category: 'MECHANICAL' });
    expect(write.status).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const { request, app } = await import('./helpers/api');
    const res = await request(app)
      .get('/api/parts')
      .set('Cookie', 'turboplm_token=not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const doomed = await createAndLogin();
    await prisma.user.delete({ where: { id: doomed.id } });
    const res = await doomed.get('/api/parts');
    expect(res.status).toBe(401);
  });
});
