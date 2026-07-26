# TurboPLM

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node 20](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Postgres 16](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

A self-hosted **Product Lifecycle Management** platform in the spirit of Aras Innovator
and Siemens Teamcenter — product structure, bills of material, part revisioning,
manufacturing processes and full engineering change control. Web client only, fully
dockerized, runs on your laptop with one command.

> **Note:** TurboPLM is a working, functional system with a large feature surface, but it
> is a young project — see [Project status](#project-status) for what is and isn't
> finished before you rely on it.

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

Open **http://localhost:3010** and sign in with one of the seeded accounts:

| Email | Password | Role |
|---|---|---|
| `demo@turboplm.local` | `demo1234` | Engineer — full read/write |
| `admin@turboplm.local` | `admin1234` | Admin — plus users, attributes, workflows, integrations |
| `viewer@turboplm.local` | `viewer1234` | Viewer — read-only (all edit controls hidden) |

The database seeds itself on first start with a demo product: a **TurboDrone X1**
quadcopter (27 parts, four BOM levels, released and in-work revisions, two process
plans) plus a **TurboDrone X1 Pro** variant that shares subassemblies — so BOM compare,
where-used and change management have real data to work on immediately.

> **Tip:** Register your own account from the login page if you'd rather start clean;
> new self-registered users get the Engineer role.

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
- **Baselines** — freeze a full resolved structure as a named snapshot, and diff any two
  baselines against each other.
- **BOM compare** — align any two revisions (same part or different products) into one
  tree: Added / Removed / Changed / Unchanged per node, with the changed fields listed.
- **Cost roll-up** — unit costs rolled through the multi-level BOM, flagging parts with
  unknown cost.
- **Variants** — option groups and values per part, BOM lines conditional on selected
  options, and a configurator that resolves a selection to a concrete structure.
- **Custom attributes** — admin-defined typed attributes (text/number/date/boolean/list)
  per part category, validated server-side.

### Manufacturing
- **Process plans (mBOM)** — per-revision routings: sequenced operations with work
  centers and setup/run times, each consuming materials.
- **AML / sourcing** — manufacturers and manufacturer part numbers per part with
  preferred / approved / alternate / obsolete status.
- **Supplier RFQ** — suppliers, RFQ lines per part, quotes with lead time and MOQ,
  automatic lowest-price flagging and extended pricing, and award tracking that closes
  the RFQ once every line is awarded.

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
- **Quality (NCR/CAPA)** — nonconformances with severity, quantity, lot/serial and
  disposition (*Open → Contained → Closed*; closing requires a disposition), one-click
  escalation into a draft ECN, and CAPAs with root-cause / corrective / preventive
  records whose Verify and Close steps are gated on evidence and on linked NCRs.

### Documents & CAD
- **Versioned documents** — `DOC-10001` records with file storage, categories, download,
  and links to parts, revisions and ECNs.
- **CAD viewer** — in-browser 3D preview: **STEP / IGES / BREP** via OpenCascade
  WebAssembly, plus STL, glTF/GLB, OBJ and 3MF via three.js (orbit, zoom, pan, fit,
  wireframe). PDFs and images preview inline.
- **CAD conversion service** — a separate container runs the OpenCascade kernel
  out-of-process and tessellates uploaded STEP/IGES/BREP into a glTF derivative with
  triangle count and bounding box, so heavy assemblies open instantly.

> **Important:** native CATIA (`.CATPart`), SolidWorks (`.sldprt`) and NX (`.prt`) files
> are proprietary formats that require vendor SDKs to decode. TurboPLM stores them
> as documents, but previews need a neutral export (STEP is the usual choice) — the same
> approach commercial PLM systems take under the hood.

### Requirements & projects
- **Requirements traceability** — `REQ-10001` items with typed statements, priority,
  lifecycle and parent/child decomposition, linked to satisfying parts and verifying
  documents, plus a traceability matrix with coverage totals.
- **Phase-gate projects** — projects with an ordered gate set (Concept → Design →
  Validation → Pilot → Production by default) and deliverables optionally bound to
  parts, documents, requirements or ECNs. A gate refuses to pass while an earlier gate is
  open or a required deliverable is outstanding.

### Platform
- **Auth** — app-managed registration and login (bcrypt + JWT in an httpOnly cookie),
  plus optional Google sign-in that appears automatically once configured.
- **RBAC** — Viewer (read-only), Engineer (edit), Admin (users, attributes, workflows,
  integrations), enforced app-wide on the server and reflected in the UI.
- **Audit trail** — every successful mutation logged with actor, path and sanitized
  payload, on a filterable Activity page.
- **Notifications** — in-app bell with unread badge, plus optional email delivery over
  any SMTP relay (Microsoft 365 documented). Email uses the notification table as an
  outbox, so mail can never delay or roll back a PLM operation.
- **My Work inbox** — approval tasks waiting on you, your in-work revisions, your open
  change requests and active ECNs, in one queue.
- **Global search** — header omnibox across parts, documents, ECNs, ECRs, requirements
  and manufacturers.
- **Integration** — API keys with read/write scopes, HMAC-signed webhooks with delivery
  history, ERP-shaped item/BOM export (CSV + JSON) and CSV import with a dry-run
  validation mode.
- **Analytics** — KPIs for change cycle time, BOM health, requirement coverage and top
  cost drivers.
- **Exports** — multi-level BOM to CSV from any revision.

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

- **Change `JWT_SECRET`.** The default is a well-known placeholder.
- **Put TLS in front.** Session cookies are `httpOnly` + `sameSite=lax` but are not
  `secure`; terminate HTTPS at a reverse proxy and set `PUBLIC_URL` accordingly.
- **Set `WEBHOOK_BLOCK_PRIVATE_HOSTS=true`** if the instance is reachable from the
  internet, so webhook targets can't be used to probe your internal network.
- **Back up both volumes** — the Postgres data and the uploads (documents and CAD files
  are on disk, not in the database).
- **Self-registration is open** and grants the Engineer role. Restrict it, or promote a
  single admin and demote the rest from Admin → Users, before exposing the instance.

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

## Project status

TurboPLM is actively being built. What works has been exercised end-to-end against the
running stack; the gaps below are known and deliberate rather than hidden:

**Solid** — parts, revisions and lifecycles; multi-level BOM with effectivity, alternates
and variants; process plans; BOM compare and baselines; ECR → ECN change management with
reviewers, the workflow engine, impact and atomic release; documents and the CAD viewer;
RBAC, audit, notifications, search, My Work; API keys, webhooks, ERP exchange, analytics;
requirements traceability.

**Backend only (no UI yet)** — the quality (NCR/CAPA), phase-gate project and supplier
RFQ modules are complete and tested over the API, but their pages are not built. The
page-level specs are pinned in `CONTRACTS.md` under *Final tier (iteration 9) → Frontend*.

**Not started** — automated test suite (verification so far is API-level and manual),
CI, and per-object access control finer than the three roles.

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

[MIT](LICENSE) — do what you like, no warranty.

---

## About

Built as an exploration of how much of a commercial PLM's core — product structure,
change control, configuration management — can be assembled into something a small
hardware team could actually run themselves.
