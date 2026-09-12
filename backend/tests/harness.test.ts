/**
 * The harness's own guarantees.
 *
 * A live TurboPLM instance runs from this repo, so "the tests cannot reach the
 * application database" is itself a property worth asserting — a broken guard would be
 * discovered by data loss otherwise.
 */
import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { assertTestDatabaseUrl } from '../vitest.config';
import { prisma } from '../src/lib/prisma';
import { createAndLogin, createUser, request } from './helpers/api';
import { app } from './helpers/api';
import { createPart } from './helpers/factories';

describe('database isolation', () => {
  it('is connected to a database whose name ends in _test', async () => {
    const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(rows[0].db).toMatch(/_test$/);
  });

  it('is not connected to the application database', async () => {
    const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(rows[0].db).not.toBe('turboplm');
  });

  it('refuses a connection string that does not name a _test database', () => {
    expect(() =>
      assertTestDatabaseUrl('postgresql://turboplm:turboplm@localhost:5442/turboplm')
    ).toThrow(/must end in "_test"/);
    expect(() =>
      assertTestDatabaseUrl('postgresql://turboplm:turboplm@localhost:5442/production')
    ).toThrow(/must end in "_test"/);
    expect(() =>
      assertTestDatabaseUrl('postgresql://turboplm:turboplm@localhost:5442/anything_test')
    ).not.toThrow();
  });

  it('starts every test from an empty schema', async () => {
    const [users, parts, ecns] = await Promise.all([
      prisma.user.count(),
      prisma.part.count(),
      prisma.ecn.count(),
    ]);
    expect({ users, parts, ecns }).toEqual({ users: 0, parts: 0, ecns: 0 });
  });

  it('restarts identity sequences, so generated numbers are deterministic', async () => {
    const user = await createUser();
    const part = await createPart({ createdById: user.id, partNumber: 'SEQ-1' });
    expect(part.id).toBe(1);
  });
});

describe('app harness', () => {
  it('serves the health endpoint without a session', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects an unauthenticated API call', async () => {
    const res = await request(app).get('/api/parts');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
  });

  it('issues a working session cookie for each role', async () => {
    for (const role of [Role.ADMIN, Role.ENGINEER, Role.VIEWER]) {
      const client = await createAndLogin({ role });
      const res = await client.get('/api/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.role).toBe(role);
    }
  });
});
