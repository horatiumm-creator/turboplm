#!/usr/bin/env node
/**
 * Create (if missing) and sync the schema of the test database.
 *
 * `prisma db push` creates the database when it does not exist, so this script is mostly
 * the guard in front of it: the suite truncates every table, and a mistyped URL pointing
 * at a live instance would wipe it. The name must end in `_test`, no exceptions.
 *
 * Deployment applies the schema with `db push` and keeps no migration files, so the test
 * database is built the same way the real one is.
 */
const { execFileSync } = require('child_process');

const DEFAULT_TEST_DATABASE_URL = 'postgresql://turboplm:turboplm@localhost:5442/turboplm_test';
const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

let database;
try {
  database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
} catch {
  console.error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  process.exit(1);
}

if (!/_test$/.test(database)) {
  console.error(
    `Refusing to set up database "${database}": the test database name must end in "_test".\n` +
      'Set TEST_DATABASE_URL to a throwaway database, e.g.\n' +
      `  ${DEFAULT_TEST_DATABASE_URL}`
  );
  process.exit(1);
}

console.log(`Syncing schema into test database "${database}"...`);
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
