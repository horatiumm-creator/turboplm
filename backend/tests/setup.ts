import { afterAll, beforeAll, beforeEach } from 'vitest';
import { assertTestDatabase, prisma, resetDatabase } from './helpers/db';

beforeAll(async () => {
  await assertTestDatabase();
});

// Per test rather than per file: a shared database plus a suite that asserts on generated
// numbers (P-10001, ECN-10001) needs the sequences to restart for every case.
beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
