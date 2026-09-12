/**
 * Scan-max numbering (rules 6, E1, T1, T2, Q2) and its behaviour under concurrency.
 *
 * Every generator reads MAX(number) and writes; two requests that read the same maximum
 * collide on the unique index and retry. The property to defend is that a burst of
 * creates yields distinct numbers — a duplicated part number is unrecoverable once it is
 * on a drawing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import { createPart } from './helpers/factories';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin();
});

const newPart = (overrides: Record<string, unknown> = {}) =>
  engineer.post('/api/parts', { name: 'Generated', category: 'MECHANICAL', ...overrides });

/** Past the 4-attempt retry ceiling every scan-max generator shares. */
const BURST = 8;

describe('rule 6 — part numbers', () => {
  it('generates P-10001 upwards when partNumber is omitted or blank', async () => {
    expect((await newPart()).body.partNumber).toBe('P-10001');
    expect((await newPart({ partNumber: '' })).body.partNumber).toBe('P-10002');
    expect((await newPart({ partNumber: '   ' })).body.partNumber).toBe('P-10003');
  });

  it('continues above the highest existing generated number', async () => {
    await createPart({ createdById: engineer.id, partNumber: 'P-10050' });
    expect((await newPart()).body.partNumber).toBe('P-10051');
  });

  it('ignores part numbers that are not in the generated format', async () => {
    await createPart({ createdById: engineer.id, partNumber: 'BRKT-99999' });
    expect((await newPart()).body.partNumber).toBe('P-10001');
  });

  it('creates revision A IN_WORK owned by the caller', async () => {
    const res = await newPart();
    expect(res.status).toBe(201);
    expect(res.body.revisions).toHaveLength(1);
    expect(res.body.revisions[0]).toMatchObject({ revision: 'A', lifecycle: 'IN_WORK' });
    expect(res.body.revisions[0].createdBy.id).toBe(engineer.id);
  });

  it('accepts a valid custom number and rejects an invalid one', async () => {
    expect((await newPart({ partNumber: 'BRKT-001.A_2' })).status).toBe(201);

    const bad = await newPart({ partNumber: 'has spaces' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(
      'partNumber must be at most 40 characters of letters, digits, ".", "_" or "-"'
    );
    expect((await newPart({ partNumber: 'x'.repeat(41) })).status).toBe(400);
  });

  it('rejects a duplicate custom number with 409', async () => {
    await newPart({ partNumber: 'DUP-1' });
    const res = await newPart({ partNumber: 'DUP-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Part number DUP-1 already exists');
  });

  it('never persists a duplicate number, however concurrent the burst', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newPart()));
    const created = results.filter((r) => r.status === 201);
    const numbers = created.map((r) => r.body.partNumber as string);

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((n) => /^P-100\d\d$/.test(n))).toBe(true);
    expect(await prisma.part.count()).toBe(created.length);
  });

  it('lets every request in a concurrent burst succeed', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newPart()));
    expect(results.map((r) => r.status)).toEqual(Array(BURST).fill(201));
  });
});

describe('rule E1 — ECN numbers', () => {
  const newEcn = () => engineer.post('/api/ecns', { title: 'Concurrent change' });

  it('generates ECN-10001 upwards', async () => {
    expect((await newEcn()).body.ecnNumber).toBe('ECN-10001');
    expect((await newEcn()).body.ecnNumber).toBe('ECN-10002');
  });

  it('never persists a duplicate number, however concurrent the burst', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newEcn()));
    const numbers = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.ecnNumber as string);

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((n) => /^ECN-100\d\d$/.test(n))).toBe(true);
  });

  // KNOWN DEFECT — same retry exhaustion as part numbers.
  it('lets every request in a concurrent burst succeed', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newEcn()));
    expect(results.map((r) => r.status)).toEqual(Array(BURST).fill(201));
  });
});

describe('rule Q2 — NCR numbers', () => {
  const newNcr = () =>
    engineer.post('/api/ncrs', { title: 'Scrap found', description: 'Out of tolerance' });

  it('generates NCR-10001 upwards', async () => {
    expect((await newNcr()).body.ncrNumber).toBe('NCR-10001');
    expect((await newNcr()).body.ncrNumber).toBe('NCR-10002');
  });

  it('never persists a duplicate number, however concurrent the burst', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newNcr()));
    const numbers = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.ncrNumber as string);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  // KNOWN DEFECT — same retry exhaustion as part numbers.
  it('lets every request in a concurrent burst succeed', async () => {
    const results = await Promise.all(Array.from({ length: BURST }, () => newNcr()));
    expect(results.map((r) => r.status)).toEqual(Array(BURST).fill(201));
  });
});

describe('other scan-max sequences', () => {
  it('numbers ECRs and requirements from their own base', async () => {
    const ecr = await engineer.post('/api/ecrs', { title: 'Please change', description: 'why' });
    expect(ecr.body.ecrNumber).toBe('ECR-10001');

    const requirement = await engineer.post('/api/requirements', {
      title: 'Must survive drop test',
      statement: 'The unit shall survive a 1 m drop.',
    });
    expect(requirement.body.reqNumber).toBe('REQ-10001');
  });

  it('keeps ECR numbers distinct under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        engineer.post('/api/ecrs', { title: 'Please change', description: 'why' })
      )
    );
    const numbers = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.ecrNumber as string);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

/**
 * Numbering allocation is serialized by `withNumberLock` (lib/plm.ts), which takes
 * `pg_advisory_xact_lock` around scan-and-insert — the same pattern BOM structure and ECN
 * membership writes use.
 *
 * Before that lock existed, every generator read `MAX(number)` unlocked and retried at
 * most four times on P2002, so concurrent callers all read the same maximum and a burst
 * surfaced spurious `409 Duplicate value for a unique field` on perfectly valid requests.
 * Uniqueness was never at risk — the database constraint held — but a bulk ERP import or
 * several engineers pressing "New part" at once hit it. This suite covers both halves:
 * that numbers stay unique, and that no request in a burst is dropped.
 */
describe('numbering under load', () => {
  it('completes an entire burst without dropping a request', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => newPart()));

    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const numbers = results.map((r) => r.body.partNumber as string);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

