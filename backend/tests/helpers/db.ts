/**
 * Test-database plumbing.
 *
 * A live TurboPLM instance runs from this repo, so the guard below matters more than the
 * reset does: `resetDatabase` truncates every table in the schema, and running it against
 * the application database would destroy production data. Nothing here touches the
 * database until `assertTestDatabase` has proved which one is connected.
 */
import { prisma } from '../../src/lib/prisma';

let verified = false;

/** Database name in the connection string, or '' when it cannot be parsed. */
function configuredDatabaseName(): string {
  const url = process.env.DATABASE_URL || '';
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * Prove the connection points at a throwaway database before anything writes.
 *
 * Checked twice on purpose: the connection string can say one thing while the server
 * resolves another (a pooler, a `PGDATABASE`, a stale env), so the authority is what
 * Postgres reports for the live session.
 */
export async function assertTestDatabase(): Promise<void> {
  if (verified) return;

  const configured = configuredDatabaseName();
  if (!/_test$/.test(configured)) {
    throw new Error(
      `Refusing to touch database "${configured || '<unparseable DATABASE_URL>'}": ` +
        'the test database name must end in "_test".'
    );
  }

  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const actual = rows[0]?.db ?? '';
  if (!/_test$/.test(actual)) {
    throw new Error(
      `Refusing to touch database "${actual}": the connected database name must end in "_test".`
    );
  }

  const tables = await listTables();
  if (tables.length === 0) {
    throw new Error(
      `Test database "${actual}" has no tables — run "npm run test:db:setup" (prisma db push).`
    );
  }

  verified = true;
}

async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`;
  return rows.map((r) => r.tablename);
}

/**
 * Empty every table and restart the id sequences, so each test starts from a known state
 * and ids are comparable across runs. One TRUNCATE keeps it a single round trip and lets
 * CASCADE sort out the foreign keys rather than requiring a hand-maintained delete order.
 */
export async function resetDatabase(): Promise<void> {
  await assertTestDatabase();
  const tables = await listTables();
  const quoted = tables.map((t) => `"public"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

export { prisma };
