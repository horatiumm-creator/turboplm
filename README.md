# TurboPLM

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE)
[![Node 20](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Postgres 16](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

A self-hosted **Product Lifecycle Management** platform in the spirit of Aras Innovator
and Siemens Teamcenter — product structure, bills of material, part revisioning,
manufacturing processes and full engineering change control. Web client only, fully
dockerized, runs on your laptop with one command.

> **Note:** TurboPLM is a young project under active development. It runs and the
> features below work, but treat it as pre-1.0: review the Deployment Notes before
> putting it anywhere that matters.

---

## Quick Start

You need **Docker Desktop** (or Docker Engine + Compose v2). Nothing else — Node,
Postgres and the CAD toolchain all live in containers.

```bash
git clone https://github.com/horatiumm-creator/turboplm.git
cd turboplm
cp .env.example .env          # sensible local defaults; edit only if you want email/OAuth
docker compose up -d --build
```

Open **http://localhost:3010** and sign in with one of the seeded development accounts:

| Email | Password | Role |
|---|---|---|
| `demo@turboplm.local` | `demo1234` | Engineer — full read/write |
| `admin@turboplm.local` | `admin1234` | Admin — plus users, attributes, workflows, integrations |
| `viewer@turboplm.local` | `viewer1234` | Viewer — read-only (all edit controls hidden) |

> **Important:** those are **local development credentials only**, published here on
> purpose. Never expose an instance that has them. For anything reachable from the
> internet, start it with `SEED_DEMO_DATA=false` and `ALLOW_REGISTRATION=false`, then
> create your first administrator explicitly:
>
> ```bash
> docker compose exec api npm run create-admin -- you@example.com 'a-long-strong-password' 'Your Name'
> ```

The database seeds itself on first start with a demo product: a **TurboDrone X1**
quadcopter (27 parts, four BOM levels, released and in-work revisions, two process
plans) plus a **TurboDrone X1 Pro** variant that shares subassemblies — so BOM compare,
where-used and change management have real data to work on immediately.

> **Tip:** Register your own account from the login page if you'd rather start clean.
> New self-registered users get the **Viewer** (read-only) role by default — change that
> with `REGISTRATION_ROLE=ENGINEER`, or set `ALLOW_REGISTRATION=false` to turn
> self-registration off entirely.

To stop, and to wipe everything including the database and uploaded files:

```bash
docker compose down          # stop
docker compose down -v       # stop and delete all data
```

---

## Features

### Product structure
- **Parts & revisions** — part master with lettered revisions (A, B, … Z, AA) and a
  lifecycle state machine: *In Work → In Review → Released → Obsolete*, with reject.
  Released revisions are immutable, enforced server-side.
- **Multi-level eBOM** — find numbers, quantities, units, reference designators, notes,
  rendered as an indented product-structure tree. Cycle prevention, where-used lookup,
  and children resolving to their latest released revision.
- **Release gate** — a revision cannot be released while any BOM child lacks a released
  revision; the error names the offending parts.
- **Revise** — creating the next revision deep-copies the BOM (including effectivity
  windows and alternates) and the process plan.
- **Effectivity & alternates** — date-effective BOM lines with an "as of" filter, and
  substitute parts per line.
- **Baselines** — freeze a revision's resolved structure as a named snapshot, and diff any
  two baselines against each other. A baseline captures BOM lines — not documents,
  attributes or process plans — so it is a structure snapshot, not a release package.
- **BOM compare** — align any two revisions (same part or different products) into one
  tree: Added / Removed / Changed / Unchanged per node, with the changed fields listed.
- **Cost roll-up** — unit costs rolled through the multi-level BOM, flagging parts with
  unknown cost. Straight unit-cost arithmetic: no currency conversion, no labour/overhead
  split, no quantity price breaks.
- **Variants** — option groups and values per part, BOM lines conditional on selected
  options, and a configurator that resolves a selection to a concrete structure. Lines are
  included by option value; there are no compatibility rules and no per-option pricing.
- **Custom attributes** — admin-defined typed attributes (text/number/date/boolean/list)
  scoped to a part category and validated server-side. This is how parts are classified
  beyond the built-in categories; values are entered on the part, and custom attributes
  are not targets of the catalog importer.
- **Materials** — a material master (class, form, density, unit cost) attached to parts
  with a net quantity and a scrap factor, so a modelled volume becomes a purchasable mass.
- **Material requirements** — gross demand rolled up across a revision's BOM
  (*net × (1 + scrap)*, accumulated per material) with estimated cost, a list of parts
  that declare no material at all, and CSV export. This is a demand calculation, not MRP:
  nothing nets against on-hand stock, and nothing plans supply or lead times.

### Manufacturing
- **Process plans (mBOM)** — per-revision routings: sequenced operations with work
  centers and setup/run times, each consuming materials.
- **mBOM from the eBOM** — seed a process plan's consumption straight from the engineering
  BOM, then reconcile the two: every part is reported as matched, quantity-mismatched,
  designed but never consumed, or consumed but never designed.

### Traceability & service
- **Build units** — record what was physically made as serial numbers or lots
  (`SN-…` / `LOT-…`), each tied to a released revision and moved through a build status;
  a shipped or scrapped unit is locked. You cannot build to an unreleased revision.
- **As-built records** — log which child serials and lots were consumed into each unit. A
  serial can be consumed by exactly one parent, a lot cannot be over-drawn, and structural
  cycles are refused under a database advisory lock, so two people recording builds at the
  same moment cannot both slip past the check.
- **Genealogy** — walk backwards from a unit through everything inside it, level by level
  (capped at 15 levels, and flagged when the walk is truncated).
- **Where-consumed** — walk forwards from a suspect lot to every unit that contains it,
  with the *shipped* units listed separately, which is the answer a recall actually needs.
- **As-built deviations** — compare a unit against the BOM it was supposed to be built to:
  match, quantity mismatch, missing, unplanned, or substituted — and an approved BOM
  alternate is reported as a substitution rather than as a defect.
- **Service records** — log repairs, upgrades, inspections, warranty claims and
  decommissions against a shipped unit, and drive each record through to completion.
  Record-keeping, not field service: no maintenance scheduling, dispatch, labour costing
  or spares inventory.
- **Part swaps & as-maintained** — record the unit removed and the unit fitted in its
  place; committing a swap rewrites the as-built graph under the same lock, so genealogy
  and service history can never disagree. A unit's as-maintained view then shows what is
  installed today next to what originally shipped.

### Change management
- **ECR intake** — engineering change requests raised against a part, then triaged:
  reject with a resolution, or accept to auto-create a linked draft ECN.
- **ECN** — change notices with their own lifecycle (*Draft → In Review → Approved →
  Released*, plus reject and cancel), priority, reason, and **effectivity date**.
  Affected items carry *from → to* revisions, change descriptions and **stock
  dispositions** (use as is / rework / scrap / return to vendor).
- **Guard rails** — a part can be on only one active ECN; revisions managed by an ECN
  cannot be transitioned directly; releasing the ECN releases every one of its revisions
  **atomically**, with the BOM release gate aware that siblings release together.
- **Reviewers & workflow engine** — either flat reviewer sign-off, or an admin-defined
  approval template: ordered steps, each any-one or all-must-approve, assignees by user
  or role. Tasks activate step by step, the final step approves the ECN, any rejection
  returns it to Draft.
- **Change impact** — per-ECN where-used rollup showing which assemblies a change ripples
  into.
- **Printable ECN notice** — a formal change document at `/ecns/:id/report` with items,
  dispositions, sign-offs and impact, ready to print to PDF.
- **Quality (NCR/CAPA)** — nonconformances with severity, quantity, a link to the exact
  build unit affected (or free-text lot/serial) and a disposition
  (*Open → Contained → Closed*; closing requires a disposition), one-click
  escalation into a draft ECN, and CAPAs with root-cause / corrective / preventive
  records whose Verify and Close steps are gated on evidence and on linked NCRs.

### Documents & CAD
- **Versioned documents** — `DOC-10001` records with file storage, categories, download,
  and links to parts, revisions and ECNs. Files up to 50 MB each are kept on the server's
  own filesystem — there is no object store, no CDN and no virus scanning.
- **Vault check-out / check-in** — take a lock before you edit, so two engineers cannot
  silently overwrite each other's work. A second simultaneous check-out is refused, and
  check-in creates the new version and releases the lock in one transaction. Locks expire
  after seven days (after which anyone may take them), and an admin can break a lock with
  a recorded reason. This is a web vault: you download the file and upload its
  replacement — there is no desktop client, CAD add-in or workspace sync.
- **Design review markup** — pin a comment to a point or a box on a drawing image, or to a
  3D location on a converted model, thread the discussion under it, resolve it, or
  escalate it straight into a change request. PDFs take version-level notes rather than
  positional pins. Markups stay anchored to the version they were raised on and
  deliberately do not carry forward to the next upload.
- **CAD viewer** — in-browser 3D preview: **STEP / IGES / BREP** via OpenCascade
  WebAssembly, plus STL, glTF/GLB, OBJ and 3MF via three.js (orbit, zoom, pan, fit,
  wireframe). PDFs and images preview inline.
- **CAD conversion service** — a separate container runs the OpenCascade kernel
  out-of-process and tessellates uploaded STEP/IGES/BREP into a glTF derivative with
  triangle count and bounding box, so heavy assemblies open instantly.
- **cBOM from CAD** — the same kernel returns the assembly structure, stored as a CAD BOM
  on the document version. Diff it between two CAD versions, reconcile it against the
  engineering BOM (added, removed, quantity changed), or import it — dry run first — to
  build the eBOM, creating missing parts and walking sub-assemblies recursively.
  Components are matched to the part catalog by name, so anything the kernel could not
  name stays unmatched.

> **Important:** kernel work — derivative conversion and assembly-structure extraction —
> happens on neutral formats only: STEP, IGES and BREP (mesh formats such as STL and glTF
> render directly). Native CATIA (`.CATPart`), SolidWorks (`.sldprt`) and NX (`.prt`)
> files are proprietary formats that require vendor SDKs to decode; TurboPLM stores them
> as documents but cannot read inside them, and there is no plug-in that pushes data out
> of a CAD seat. Export a neutral file and upload it — the same approach commercial PLM
> systems take under the hood. Extraction is best-effort: if the conversion container is
> down or the model is too slow to tessellate, the upload still succeeds and the version
> is marked failed.

### Sourcing & suppliers
- **AML / sourcing** — manufacturers and manufacturer part numbers per part with
  preferred / approved / alternate / obsolete status. A static approved-source list: no
  live availability, pricing, lead time or end-of-life alerting.
- **Supplier RFQ** — suppliers, RFQ lines per part, quotes with lead time and MOQ,
  automatic lowest-price flagging and extended pricing, and award tracking that closes
  the RFQ once every line is awarded. An award is a record, not a purchase order.
- **Supplier portal** — invited suppliers sign in under `/portal` with accounts that are a
  wholly separate identity from internal users, and see only the RFQs they were invited
  to, where they submit and withdraw quotes. They cannot see competitors, competitors'
  prices, your target price, parts, BOMs, documents or changes; an RFQ they were not
  invited to answers "not found" rather than "forbidden", so its existence is not leaked.
- **Vendor catalog import** — upload a distributor or manufacturer catalog as **CSV, TSV
  or BMEcat XML**, map its columns onto part fields, validate row by row and fix bad rows
  in place, then commit the good ones. Five vendor presets ship seeded and admins can save
  reusable mappings. Excel workbooks are rejected. File-based import only: there is no
  distributor API, pricing feed or scheduled sync.
- **ERP exchange** — item master and BOM export as CSV or JSON, and bulk part / BOM-line
  import from CSV with a dry-run validation mode. This is file exchange rather than a live
  ERP connector — no middleware, no scheduled sync, no vendor adapter.

### Requirements & projects
- **Requirements traceability** — `REQ-10001` items with typed statements, priority,
  lifecycle and parent/child decomposition, linked to satisfying parts and verifying
  documents, plus a traceability matrix with coverage totals.
- **Phase-gate projects** — projects with an ordered gate set (Concept → Design →
  Validation → Pilot → Production by default) and deliverables optionally bound to
  parts, documents, requirements or ECNs. A gate refuses to pass while an earlier gate is
  open or a required deliverable is outstanding.

### Access control & signatures
- **RBAC** — Viewer (read-only), Engineer (edit), Admin (users, attributes, workflows,
  integrations), enforced app-wide on the server and reflected in the UI. Three global
  roles, no custom ones.
- **Item-level access** — grant an individual part, document, ECN, project or build unit
  to named users or to access groups, with read or read-write permission. Enforcement sits
  in one library used by every router: an item you may not read answers "not found" rather
  than "forbidden", so its existence is not disclosed, and a restricted child inside a BOM
  you *can* see is redacted to a **Restricted** placeholder instead of being dropped —
  quantities and find numbers survive, so the structure in front of you is never quietly
  falsified. Grants are opt-in per item; an item with no grants is governed by role alone,
  and admins always pass.
- **Electronic signatures** — Part 11-style signing: an admin defines who must sign — a
  named person or a role — before an ECN can be approved or a part revision released.
  Signing re-authenticates the signer — password re-entry, or, for an account that has no
  password because it only ever signs in with Google, retyping its own address — and the
  method used is recorded on the signature, so the strength of each one stays auditable.
  (That second path is a weak factor: anyone already at the keyboard can satisfy it. Treat
  password accounts as the ones that carry real signing weight until this is hardened.)
  Signing stamps the printed name and role at the moment of signing, and binds the
  signature to a hash of exactly what was signed, so editing the signed content voids the
  signature and re-blocks the release. Signatures are
  append-only and cannot be edited or deleted. Requirements are opt-in: configure none and
  nothing is gated. These are Part 11-*informed* mechanics, not a validated or certified
  installation.
- **Audit trail** — successful mutations through the internal API logged with actor, path
  and sanitized payload, on a filterable Activity page. Two caveats worth knowing: the
  supplier-portal and auth routers mount ahead of the audit middleware, so supplier quote
  writes are not captured; and the audit row is written after the response, best-effort, so
  a failed insert loses the entry rather than failing the request.

### Platform
- **Auth** — app-managed registration and login (bcrypt + JWT in an httpOnly cookie), plus
  optional Google sign-in that appears automatically once configured: the callback
  compares a CSRF `state` cookie in constant time and refuses accounts whose Google
  address is unverified. Google is the only federated provider.
- **Notifications** — in-app bell with unread badge, plus optional email delivery over
  any SMTP relay (Microsoft 365 documented). Email uses the notification table as an
  outbox, so mail can never delay or roll back a PLM operation.
- **My Work inbox** — approval tasks waiting on you, your in-work revisions, your open
  change requests and active ECNs, in one queue.
- **Global search** — header omnibox across parts, documents, ECNs, ECRs, requirements
  and manufacturers. It matches record metadata — numbers, titles, statuses — not the
  contents of uploaded files.
- **Integration** — API keys with read/write scopes, and HMAC-signed webhooks with a fixed
  event list, a test-fire button and delivery history. Admin-only.
- **Analytics** — a fixed KPI dashboard for change cycle time, BOM health, requirement
  coverage and top cost drivers, filtered by the same item-level access rules as the rest
  of the app. Not a report builder.
- **Exports** — multi-level BOM to CSV from any revision, material requirements to CSV,
  and the ERP-shaped item/BOM extracts above.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  React 18 · TypeScript · Ant Design 5 · three.js            │
└───────────────────────────┬─────────────────────────────────┘
                            │ :3010
┌───────────────────────────▼─────────────────────────────────┐
│  web — nginx (serves the Vite build, proxies /api)          │
└───────────────────────────┬─────────────────────────────────┘
                            │ :4000 (host :8010)
┌───────────────────────────▼─────────────────────────────────┐
│  api — Node 20 · Express 4 · Prisma 5                       │
│  auth · RBAC · audit · notifications · webhooks · ERP        │
└──────────┬────────────────────────────────┬─────────────────┘
           │ :5432 (host :5442)             │ :4100
┌──────────▼──────────────┐      ┌──────────▼──────────────────┐
│  db — Postgres 16       │      │  cad — OpenCascade (WASM)   │
│  volume: turboplm-pgdata│      │  STEP/IGES/BREP → glTF      │
└─────────────────────────┘      └─────────────────────────────┘
                                  shared volume: turboplm-uploads
```

`CONTRACTS.md` is the pinned specification — every API endpoint, DTO shape and business
rule (edit gates, release gates, cycle prevention, ECN rules E1–E13, workflow rules
W1–W8, and the rest). Both sides of the app were built against it; keep it updated when
you change an endpoint.

---

## Local Development (without Docker)

You need **Node 20+** and a **Postgres 16** instance.

**Backend**

```bash
cd backend
npm install
export DATABASE_URL="postgresql://turboplm:turboplm@localhost:5442/turboplm"
npx prisma generate
npx prisma db push        # create/update the schema
npx tsc                   # compile to dist/
node dist/seed.js         # seed demo data (idempotent)
node dist/index.js        # API on :4000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev               # Vite dev server on :3010, proxies /api to :8010
```

**CAD service** (only needed for STEP/IGES/BREP conversion)

```bash
cd cad
npm install
UPLOAD_DIR=../backend/uploads npm start   # :4100
```

**Type-checking** — both packages are strict TypeScript:

```bash
cd backend  && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```

---

## Environment Variables

Copy `.env.example` to `.env`; Docker Compose loads it automatically. Everything has a
working local default, so the stack boots with no configuration at all.

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-me` | Signs session cookies. **Change this for any real deployment.** |
| `PUBLIC_URL` | `http://localhost:3010` | Public base URL; used for the Google OAuth redirect. |
| `GOOGLE_CLIENT_ID` | *(empty)* | Google OAuth client id. The Google button appears only when both Google vars are set. |
| `GOOGLE_CLIENT_SECRET` | *(empty)* | Google OAuth client secret. Redirect URI: `<PUBLIC_URL>/api/auth/google/callback` |
| `SMTP_HOST` | *(empty)* | SMTP relay host. Leave empty to keep notifications in-app only. M365: `smtp.office365.com` |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (465); `false` uses STARTTLS. |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | Mailbox credentials. M365 needs *Authenticated SMTP* enabled; with MFA use an app password. |
| `SMTP_FROM` | *(empty)* | From address on outgoing mail. |
| `WEBHOOK_BLOCK_PRIVATE_HOSTS` | `false` | Set `true` on internet-facing deployments to refuse private/loopback webhook targets. Link-local and cloud-metadata hosts are always refused. |
| `JSON_BODY_LIMIT` | `25mb` | Max JSON body — bulk ERP CSV imports travel in the request body. |
| `CAD_SERVICE_URL` | `http://cad:4100` | Where the API reaches the CAD conversion service. |
| `DATABASE_URL` | set by Compose | Postgres connection string. |
| `UPLOAD_DIR` | `/app/uploads` | Where document files and CAD derivatives are stored. |

---

## Database Management

```bash
# Apply schema changes after editing backend/prisma/schema.prisma
cd backend && DATABASE_URL="postgresql://turboplm:turboplm@localhost:5442/turboplm" \
  npx prisma db push

# Browse the data
npx prisma studio

# psql shell inside the container
docker exec -it turboplm-db-1 psql -U turboplm -d turboplm
```

The seed is idempotent and runs on every API start — it only fills in what's missing, so
it's safe to leave enabled. Uploaded files live in the `turboplm-uploads` volume; the
database in `turboplm-pgdata`.

---

## Deployment Notes

- **Change `JWT_SECRET`.** The default is a well-known placeholder published in this
  repository — leaving it lets anyone forge a session cookie for any user, including an
  administrator. The API logs a warning at startup if it is still the default while
  serving over HTTPS.
- **Set `SEED_DEMO_DATA=false`** so the demo product and the demo logins above are never
  created, and bootstrap your admin with `npm run create-admin`.
- **Set `ALLOW_REGISTRATION=false`** unless you intend a public sandbox; open
  registration grants Engineer-level write access to anyone.
- **Serve over HTTPS.** Session cookies are automatically marked `secure` when
  `PUBLIC_URL` is an `https://` URL.
- **Access control is role-based, not per-object.** Any signed-in user can read every
  part, BOM and change in the instance; roles only gate writes. Do not give a read-only
  account to someone who should not see all of the data.
- **Set `WEBHOOK_BLOCK_PRIVATE_HOSTS=true`** if the instance is reachable from the
  internet, so webhook targets can't be used to probe your internal network.
- **Back up both volumes** — the Postgres data and the uploads (documents and CAD files
  are on disk, not in the database).
- **Back up before upgrading.** `prisma db push` is used for schema changes, which can be
  destructive on column removals.

---

## Project Structure

```
turboplm/
├── docker-compose.yml        # db · api · cad · web
├── CONTRACTS.md              # pinned API / DTO / business-rule spec
├── backend/
│   ├── prisma/schema.prisma  # ~40 models: parts, BOM, ECN, quality, projects, RFQ…
│   └── src/
│       ├── index.ts          # app wiring, middleware chain
│       ├── lib/              # prisma, errors, notify, mailer, webhooks, plm helpers
│       ├── middleware/       # auth, api keys, RBAC, audit, uploads
│       ├── routes/           # one router per domain (parts, bom, ecns, quality, …)
│       └── seed.ts           # idempotent demo data
├── frontend/
│   ├── nginx.conf
│   └── src/
│       ├── api/              # types.ts (DTOs) + client.ts (typed fetch layer)
│       ├── auth/             # session context, route guards
│       ├── components/       # layout, shared meta/tags, cad/, part/ tabs
│       └── pages/            # one page per route
└── cad/
    └── src/                  # OpenCascade WASM service + glTF encoder
```

---

## Contributing

Issues and pull requests are welcome. Two conventions keep the codebase coherent:

1. **`CONTRACTS.md` first.** It is the single source of truth for endpoints, DTO shapes
   and business rules. Update it in the same change that alters behavior.
2. **DTOs are pinned.** `frontend/src/api/types.ts` defines the wire format; backend
   mappers must match it exactly (field names, nullability, ISO date strings). Both
   packages must pass `npx tsc --noEmit`.

---

## License

[FSL-1.1-MIT](LICENSE) — the [Functional Source License](https://fsl.software), which
grants broad rights for any **Permitted Purpose** (internal use, non-commercial education
and research, and professional services around it) while excluding **Competing Use** —
repackaging TurboPLM as a commercial product or service that substitutes for it.

Each version converts to the plain **MIT license two years after its release**, so
everything published here becomes fully permissive on a rolling schedule.

---

## About

Built as an exploration of how much of a commercial PLM's core — product structure,
change control, configuration management — can be assembled into something a small
hardware team could actually run themselves.
