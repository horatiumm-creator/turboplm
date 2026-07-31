import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * The one place the test database is chosen — and the first line of defence for the
 * running demo instance.
 *
 * Tests truncate every table before each case, so pointing them at a live database would
 * destroy it. The name is therefore required to end in `_test`, and the check runs here,
 * at config load, before a single test module (or PrismaClient) is created.
 */
const DEFAULT_TEST_DATABASE_URL = 'postgresql://turboplm:turboplm@localhost:5442/turboplm_test';

export function assertTestDatabaseUrl(url: string): string {
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }
  if (!/_test$/.test(database)) {
    throw new Error(
      `Refusing to run tests against database "${database}": the test database name must end ` +
        'in "_test". Create one with: npm run test:db:setup'
    );
  }
  return url;
}

const databaseUrl = assertTestDatabaseUrl(
  process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL
);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Every worker would otherwise share the one test database and truncate it out
    // from under the others; the suite is fast enough to run files in sequence.
    fileParallelism: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
    // The CAD suite replaces global fetch; restoring it between tests keeps a stub from
    // leaking into a test that expects the real thing.
    unstubGlobals: true,
    env: {
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-not-used-anywhere-real',
      // Self-registration is exercised explicitly; the suite creates users directly.
      ALLOW_REGISTRATION: 'true',
      REGISTRATION_ROLE: 'VIEWER',
      // No sidecar in CI: the CAD kernel is stubbed at the fetch boundary. An
      // unreachable host makes an unstubbed call fail fast instead of hanging.
      CAD_SERVICE_URL: 'http://cad.invalid:4100',
      SMTP_HOST: '',
      PUBLIC_URL: 'http://localhost:3010',
      // Uploads land in a scratch directory, never the deployment's volume.
      UPLOAD_DIR: path.join(os.tmpdir(), 'turboplm-test-uploads'),
    },
  },
});
