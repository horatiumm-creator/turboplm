# Testing the TurboPLM backend

The suite drives the real Express app in-process with [supertest] and asserts against the
numbered rules in [`../CONTRACTS.md`](../CONTRACTS.md) — the same error strings, status
codes and orderings the frontend depends on.

## Database isolation

**The tests truncate every table before each case.** They must therefore never reach a
database anyone cares about — and a live TurboPLM instance runs from this repo.

Isolation is enforced by a rule, not by convention: **the test database name must end in
`_test`.** Three independent checks apply it.

| Where | What it checks | When |
|---|---|---|
| `vitest.config.ts` | The resolved connection string names a `*_test` database | Config load, before any test module or `PrismaClient` exists |
| `scripts/setup-test-db.js` | Same, before `prisma db push` runs | Schema setup |
| `tests/helpers/db.ts` (`assertTestDatabase`) | The connection string *and* `SELECT current_database()` both end in `_test` | First database access in every run, before `resetDatabase` will truncate anything |

The last one matters most: a connection string can say one thing while the server resolves
another (a pooler, `PGDATABASE`, a stale env), so the authority is what Postgres reports
for the live session. If either disagrees the run aborts before a single row is touched.

The connection string comes from `TEST_DATABASE_URL`, defaulting to
`postgresql://turboplm:turboplm@localhost:5442/turboplm_test` — the `db` service published
by `docker-compose.yml`, but a *separate database* on it. Nothing else about the running
stack is touched: no restart, no rebuild, no writes to `turboplm`.

`vitest.config.ts` also pins the rest of the environment, so a developer's `.env` cannot
leak in: `UPLOAD_DIR` points at a scratch directory, `SMTP_HOST` is empty, and
`CAD_SERVICE_URL` points at an unresolvable host so an unstubbed sidecar call fails fast
instead of reaching a real service.

## Running the tests

```bash
cd backend

npm run test:db:setup   # create turboplm_test (if absent) and sync the schema
npm test                # one full run
npm run test:watch      # re-run on change
npm run test:ci         # setup + run, what CI executes
npm run typecheck       # tsc --noEmit for src, then for src + tests
```

Point the suite somewhere else with `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/mything_test npm run test:ci
```

The schema is applied with `prisma db push`, the same way deployment does it — there are
no migration files and the tests do not introduce any.

Files run **sequentially** (`fileParallelism: false`): they share one database, and parallel
workers would truncate it out from under each other. Each test starts from an empty schema
with the identity sequences restarted, so generated numbers (`P-10001`, `ECN-10001`) are
deterministic.

## Layout

```
tests/
  setup.ts                  resets the database before every test
  helpers/db.ts             the isolation guard + TRUNCATE reset
  helpers/api.ts            supertest client, user creation, login per role
  helpers/factories.ts      direct-to-database fixtures (parts, BOMs, plans, cBOM snapshots)
  helpers/cad.ts            CAD sidecar stub
  harness.test.ts           the isolation and login guarantees themselves
  bom.test.ts               rules 1, 4, 5, 8, T4
  revision-lifecycle.test.ts rules 1, 2, 3, 7 + concurrent transitions
  ecn.test.ts               rules E1–E13
  signatures.test.ts        rules S1–S4
  cbom-mbom.test.ts         rules C2–C5
  rbac.test.ts              rule T9 and the app-wide write guard
  numbering.test.ts         rules 6, E1, Q2 and their behaviour under load
```

Setup writes rows directly; the behaviour under test always goes through HTTP. That is
deliberate — a cycle-prevention test cannot build its cycle through the endpoint that
rejects cycles.

## The CAD sidecar

The `cad` service is a separate container running an OCCT kernel, and CI has neither the
service nor real STEP files. `fetchAssemblyFromKernel` in `src/lib/cad.ts` is the only
network call in that path, so `tests/helpers/cad.ts` stubs `fetch` and everything above it
runs for real: extraction, persistence as a cBOM, and read-time name-to-part matching.
Most cBOM tests skip even that and seed `CadStructure`/`CadNode` rows with
`seedCadStructure`, which is exactly what a completed extraction leaves behind.

## Numbering under concurrency

The scan-max generators (`P-`, `ECN-`, `ECR-`, `NCR-`, `CAPA-`, `REQ-`) originally read
`MAX(number)` with no lock and retried at most four times on a unique violation. Concurrent
callers all read the same maximum, so a burst of creates returned spurious
`409 Duplicate value for a unique field` — uniqueness held, but valid requests were dropped.
Measured before the fix: 8 concurrent part creates produced 1–4 rejections.

`withNumberLock` in `src/lib/plm.ts` now wraps scan-and-insert in `pg_advisory_xact_lock`,
the same pattern BOM structure and ECN membership writes already use. The bounded retry
stays as a backstop for a number a user typed by hand between the scan and the insert.
Verified at 16 concurrent creates per entity type with zero rejections.

`numbering.test.ts` asserts both halves: numbers stay unique, and no request in a burst is
dropped.

[supertest]: https://github.com/ladjs/supertest
