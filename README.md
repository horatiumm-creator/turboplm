# TurboPLM

A lightweight, self-hosted Product Lifecycle Management system (in the spirit of Aras
Innovator / Siemens Teamcenter) — iteration 1. Web client only, fully dockerized.

## Features

- **Parts & revisions** — part master with lettered revisions (A, B, … Z, AA, …) and a
  lifecycle state machine: *In Work → In Review → Released → Obsolete* (with reject back
  to In Work). Released revisions are immutable.
- **eBOM / product structure** — multi-level bill of materials with find numbers,
  quantities, units, reference designators; flat table and indented structure views;
  BOM cycle prevention; where-used lookup; child revisions resolve to the latest
  *Released* revision.
- **Release gate** — a revision cannot be released while any BOM child lacks a released
  revision (the error names the offending parts).
- **Revise** — creating the next revision deep-copies the previous BOM and process plan.
- **Manufacturing processes (mBOM)** — per-revision process plans: sequenced operations
  with work centers and setup/run times, each consuming materials.
- **ECN change management** — engineering change notices with their own lifecycle
  (*Draft → In Review → Approved → Released*, reject/cancel), auto-numbering
  (`ECN-10001`), priority, reason, and **effectivity date**. Each ECN lists affected
  parts with *from → to* revisions, per-part change descriptions, and **stock
  dispositions** for manufacturing (use as is / rework / scrap / return to vendor).
  "Start change" creates or adopts the working revision; a part can be on only one
  active ECN; revisions under an active ECN can't be released directly; releasing the
  ECN releases all its revisions **atomically** (the BOM release-gate counts sibling
  items releasing in the same ECN).
- **Reviewer approvals** — assign reviewers to an ECN; each signs off (approve /
  request changes, with comments); approving the ECN requires every reviewer's
  approval, and resubmitting restarts the review cycle.
- **Change impact** — per-ECN where-used rollup showing which assemblies each
  affected part ripples into.
- **BOM compare** — compare any two revisions (same part or different products) as an
  aligned multi-level tree: Added / Removed / Changed / Unchanged per node, changed
  fields (qty, UoM, find #, refdes, notes, resolved revision), and summary counts.
  Entry points: the "BOM Compare" page and per-item Compare links on ECNs.
- **Email notifications (SMTP / Microsoft 365)** — outbox-based delivery of every
  in-app notification via any SMTP relay; M365 preset documented in `.env`
  (smtp.office365.com:587, STARTTLS, mailbox needs Authenticated SMTP). Admin →
  Email page shows status and sends a test message.
- **Requirements & traceability** — `REQ-10001` items with typed statements,
  decomposition (parent/child), links to satisfying parts and verifying documents,
  a traceability matrix with coverage stats, a Requirements tab on parts, and
  requirements in global search.
- **Configurable workflow engine** — admin-defined approval templates (ordered
  steps; any-one or all-must-approve; assignees by user or role). Attach one when
  submitting an ECN: tasks activate step by step with notifications and My Work
  queueing, the final approval auto-approves the ECN, and any rejection returns it
  to Draft. ECNs without a template keep the flat reviewer flow.
- **My Work inbox** — reviews waiting on you, your in-work revisions (with managing
  ECN), open change requests, and active ECNs, in one queue.
- **Global search** — header omnibox across parts, documents, ECNs, ECRs and
  manufacturers.
- **In-app notifications** — bell with unread badge; events on reviewer assignment,
  ECN submission, review decisions, approvals/releases/rejections, and ECR outcomes
  (actor excluded; 30s polling).
- **Exports & reports** — multi-level BOM CSV export from any revision, and a
  printable ECN notice (`/ecns/:id/report`) with items, dispositions, sign-offs and
  impact — print to PDF from the browser.
- **Email notifications (SMTP / Microsoft 365)** — every in-app notification is also
  emailed when SMTP is configured. Delivery uses the notification table as an outbox:
  a dispatcher sends after the business transaction commits, so mail can never fail or
  delay a PLM operation. Configure in `.env` (`SMTP_HOST=smtp.office365.com`,
  `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`/`SMTP_PASS`, `SMTP_FROM`); the
  M365 mailbox needs *Authenticated SMTP* enabled. Admin → Email shows status and
  sends a test message.
- **Requirements & traceability** — `REQ-10001` requirements with statement, type,
  priority, lifecycle (Draft → Approved → Obsolete), parent/child decomposition, and
  links to parts (satisfied-by) and documents (verified-by). Traceability matrix with
  coverage totals; a Requirements tab on each part; requirements in global search.
- **Configurable workflow engine** — admin-defined approval templates: ordered steps,
  each with a rule (any-one or all-must-approve) and assignees by user and/or role.
  Pick a template when submitting an ECN; tasks activate step by step with
  notifications and My Work queue entries, the final step approves the ECN, and any
  rejection returns it to Draft. ECNs submitted without a template keep the simple
  flat-reviewer flow.
- **CAD conversion service** — a dedicated `cad` container runs the OpenCascade kernel
  out-of-process: STEP/IGES/BREP uploads are auto-tessellated into a glTF (.glb)
  derivative with triangle count and bounding box, so heavy assemblies open instantly
  in the browser instead of parsing the CAD kernel per viewer.
- **Quality (NCR/CAPA)** — nonconformances with severity, stock disposition and
  Open→Contained→Closed flow (closing requires a disposition), one-click escalation into
  a draft ECN (honouring the one-active-ECN rule), and CAPAs with root-cause/corrective/
  preventive records whose Verify and Close steps are gated on evidence and on all
  linked NCRs being closed.
- **Phase-gate projects** — projects with an ordered gate set (Concept → Design →
  Validation → Pilot → Production by default), deliverables optionally bound to parts,
  documents, requirements or ECNs, and gates that refuse to pass while an earlier gate
  is open or a required deliverable is outstanding.
- **Supplier RFQ** — suppliers, RFQ lines per part, quotes with lead time/MOQ, automatic
  lowest-price flagging and extended pricing, and award tracking that closes the RFQ
  once every line is awarded.
- **CAD viewer** — in-browser 3D preview of neutral CAD formats on document pages and
  attachment cards: **STEP / IGES / BREP** via OpenCascade WebAssembly, plus STL,
  glTF/GLB, OBJ and 3MF via three.js (orbit/zoom/pan, fit, wireframe), and inline
  PDF / image preview for 2D drawings. Native CATIA/SolidWorks/NX files are stored
  as documents; export STEP alongside them to get a preview (native formats are
  proprietary and need vendor SDKs to decode).
- **Documents & files** — versioned document records (`DOC-10001`) with file storage,
  categories (drawing/spec/datasheet/CAD/…), downloads, and links to parts, revisions
  and ECNs.
- **ECR intake** — engineering change requests (`ECR-10001`): raise against a part,
  triage (reject with resolution, or accept — auto-creating a linked draft ECN).
- **AML sourcing** — manufacturers and manufacturer part numbers per part with
  preferred/approved/alternate/obsolete status; part unit costs.
- **RBAC** — enforced roles: Viewer (read-only), Engineer (edit), Admin (user
  management, attribute definitions); admin Users page.
- **Audit trail** — every successful mutation logged (who/what/when + sanitized
  payload) with a filterable Activity page.
- **BOM effectivity & alternates** — date-effective BOM lines with an "as of" filter,
  and substitute parts per line.
- **Baselines** — named snapshots of a full resolved structure; view and diff any two
  baselines with the compare engine.
- **Custom attributes** — admin-defined typed attributes per part category (text,
  number, date, yes/no, choice lists) with validation.
- **Cost roll-up** — unit costs rolled up through the multi-level BOM with
  missing-cost flagging (Cost tab per revision).
- **Integration API** — scoped machine credentials (`X-API-Key: tplm_<prefix>_<secret>`,
  read or write, never admin, shown once at creation, revocable) and outbound
  **webhooks**: HMAC-SHA256 signed (`X-TurboPLM-Signature`) POSTs on part/revision
  release, ECN submit/approve/release, ECR raised and document created, with a
  delivery log, capped retries and a test-fire button.
- **ERP exchange** — item-master and single-level BOM exports (CSV + JSON), plus bulk
  **CSV import** of parts and BOM lines with a mandatory dry run that validates
  everything (categories, costs, unknown parts, BOM cycles) and reports per-row issues
  before a single write.
- **Variants & configuration** — option groups and values per product, BOM lines
  conditioned on option values (the 150% BOM), and a **configurator** that resolves a
  selection into the buildable variant BOM; conditions survive revise and ECN changes.
- **Analytics** — change cycle time and throughput, BOM health (never-released parts,
  missing costs, in-work revisions, released assemblies with unreleased children),
  requirement coverage and top rolled-cost drivers.
- **Auth** — app-managed registration/login (bcrypt + JWT httpOnly cookie) plus optional
  Google sign-in.

## Run it

```bash
docker compose up -d --build
```

| Service  | URL                        |
|----------|----------------------------|
| Web app  | http://localhost:3010      |
| API      | http://localhost:8010/api  |
| Postgres | localhost:5442 (`turboplm`/`turboplm`) |

Demo accounts (seeded with the **TurboDrone X1** demo product):

- `demo@turboplm.local` / `demo1234` (Engineer)
- `admin@turboplm.local` / `admin1234` (Admin)

## Google sign-in (optional)

Create an OAuth 2.0 Web client in Google Cloud Console with authorized redirect URI
`http://localhost:3010/api/auth/google/callback`, put the credentials in `.env`
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), then `docker compose up -d api`.
The "Continue with Google" button appears automatically once configured.

## Architecture

```
web  (nginx :3010)  — React 18 + TypeScript + Ant Design 5, Vite build; proxies /api →
api  (node  :8010)  — Express 4 + Prisma; JWT cookie auth; business rules server-side
db   (postgres :5442) — Postgres 16, volume turboplm-pgdata
```

- `CONTRACTS.md` — the API/DTO/business-rule contract both sides are built against.
- `backend/prisma/schema.prisma` — data model: `User`, `Part`, `PartRevision`,
  `BomLine`, `ProcessPlan`, `Operation`, `OperationMaterial`, `Ecn`, `EcnItem`.
- The API container runs `prisma db push` and an idempotent seed on start.

## Development (outside Docker)

```bash
# backend — needs DATABASE_URL pointing at the compose db
cd backend && npm install && npx prisma generate && npx tsc
# frontend — dev server on :3010 proxying to the api on :8010
cd frontend && npm install && npm run dev
```
