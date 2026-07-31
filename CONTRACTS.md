# TurboPLM — API & Component Contracts

This file is the single source of truth for how the backend and frontend fit together.
DTO shapes live in `frontend/src/api/types.ts` and the typed HTTP client in
`frontend/src/api/client.ts`. Those two files are the pinned wire format: backend routes
must produce exactly the shapes in `types.ts`, and changing a shape means changing both
sides plus this document in the same commit.

## General conventions

- All API routes are under `/api`. Errors are JSON: `{ "error": "human readable message" }`.
- Status codes: 400 validation, 401 unauthenticated, 404 not found, 409 business-rule
  conflict / duplicates, 204 for deletes with no body.
- Backend: Express 4 routers, `export default router`. Wrap async handlers in
  `asyncHandler` from `src/lib/errors.ts`; throw `new HttpError(status, message)`.
  Prisma client: `import { prisma } from '../lib/prisma'`.
  Auth: `import { requireAuth } from '../middleware/auth'` and apply `router.use(requireAuth)`
  at the top of every feature router (auth router excluded). `req.user` is then set
  (`{ id, email, name, role, avatarUrl, provider }`).
- All ids are integer autoincrement. Dates serialize as ISO strings via `res.json`.
- Quantities/minutes are `Float` (plain JS numbers).

## Domain model (see backend/prisma/schema.prisma)

Part (part master, immutable identity) → PartRevision (A, B, … with lifecycle) →
BomLine (eBOM: parentRevision → childPart) and ProcessPlan → Operation → OperationMaterial
(mBOM: materials consumed by an operation).

Lifecycle: `IN_WORK → (submit) → IN_REVIEW → (approve) → RELEASED → (obsolete) → OBSOLETE`,
plus `IN_REVIEW → (reject) → IN_WORK`. `approve` sets `releasedAt`.

## Business rules (enforce in backend)

1. **Edit gate** — BOM lines, changeNote, and the process plan (plan, operations, materials)
   can only be created/updated/deleted while the owning revision is `IN_WORK`; otherwise 409
   `"Revision <rev> is <state> and cannot be modified"`.
2. **Release gate** — `approve` fails with 409 if any BOM child part of the revision has no
   RELEASED revision. Message: `"Cannot release: child parts without a released revision: P-10004, P-10007"`.
3. **Revise** — `POST /api/parts/:id/revisions` allowed only when the part's latest revision
   (highest id) is RELEASED or OBSOLETE (409 otherwise). Creates the next revision label
   (A→B→…→Z→AA→AB, helper `nextRevisionLabel` in `src/lib/plm.ts`), lifecycle IN_WORK,
   and deep-copies the previous revision's BOM lines and process plan (operations + materials).
4. **Cycle prevention** — adding/updating a BOM line is rejected (409 `"Adding this part would create a BOM cycle"`)
   if childPartId === parent part id, or if the parent part is reachable from the child via
   BOM edges. Traverse edges `(revision.partId → line.childPartId)` across ALL revisions
   (conservative BFS over `BomLine` joined to `PartRevision`).
5. **Resolved revision** — when displaying a BOM child: latest RELEASED revision of the child;
   if none, the child's latest revision (highest id); `unreleased = resolved.lifecycle !== 'RELEASED'`.
   `resolvedRevision` is null only if the child somehow has zero revisions.
6. **Part numbers** — if `partNumber` omitted/blank on create, generate via `generatePartNumber`
   (`src/lib/plm.ts`, `P-10001` style). Custom part numbers must match `/^[A-Za-z0-9._-]+$/`
   (max 40 chars); duplicates → 409. Creating a part also creates revision `A` (IN_WORK) by `req.user`.
7. **Delete part** — 409 if the part is referenced by any BomLine or OperationMaterial
   (`"Part is used in a BOM / process plan and cannot be deleted"`). Otherwise delete (cascades).
8. **findNumber** — auto-assign next multiple of 10 (max existing + 10, start 10) when omitted.
   Unique per parent revision (409 `"Find number already used"`). A child part may appear only
   once per parent revision (409 `"Part is already on this BOM"`).
9. **Operation seq** — same auto-assign rule per plan; unique per plan (409).
10. **List filter** — `GET /api/parts?lifecycle=X` filters by the part's LATEST revision lifecycle.
    `search` matches partNumber or name, case-insensitive contains. `category` exact.
    Default page=1, pageSize=20 (max 100), ordered by partNumber asc.

## Endpoints

Auth (`backend/src/routes/auth.ts`):
| Method/Path | Body → Response |
|---|---|
| POST /api/auth/register | {name,email,password} → UserInfo (sets cookie) |
| POST /api/auth/login | {email,password} → UserInfo (sets cookie) |
| POST /api/auth/logout | → 204 |
| GET /api/auth/me | → UserInfo |
| GET /api/auth/providers | → {google: boolean} |
| GET /api/auth/google, /google/callback | OAuth redirect flow |

Feature routers (mounted at `/api` in `src/index.ts`):

`src/routes/parts.ts`:
| Method/Path | Body → Response |
|---|---|
| GET /parts?search&category&lifecycle&page&pageSize | → Paged<PartSummary> |
| POST /parts | {partNumber?,name,description?,category,uom?} → 201 PartDetail |
| GET /parts/:id | → PartDetail |
| PATCH /parts/:id | {name?,description?,category?,uom?} → PartDetail |
| DELETE /parts/:id | → 204 |
| POST /parts/:id/revisions | (no body) → 201 RevisionDetail |
| GET /revisions/:id | → RevisionDetail |
| PATCH /revisions/:id | {changeNote?} → RevisionDetail (edit gate) |
| POST /revisions/:id/transition | {action: 'submit'\|'approve'\|'reject'\|'obsolete'} → RevisionDetail |

`src/routes/bom.ts`:
| Method/Path | Body → Response |
|---|---|
| GET /revisions/:id/bom | → BomLineDetail[] (findNumber asc) |
| GET /revisions/:id/bom/tree | → BomTreeNode[] (recursive, resolved-revision rule; depth cap 15; mark `cycle:true` and stop if a part repeats on its own branch) |
| POST /revisions/:id/bom | {childPartId,quantity,uom?,findNumber?,refDesignators?,notes?} → 201 BomLineDetail |
| PATCH /bom-lines/:id | {quantity?,uom?,findNumber?,refDesignators?,notes?} → BomLineDetail |
| DELETE /bom-lines/:id | → 204 |
| GET /parts/:id/where-used | → WhereUsedEntry[] (every BomLine where part is child, newest parent revision first) |

`src/routes/process.ts` (every mutation passes the edit gate of the owning revision):
| Method/Path | Body → Response |
|---|---|
| GET /revisions/:id/process-plan | → ProcessPlanDetail \| null (JSON null when absent) |
| PUT /revisions/:id/process-plan | {name?,description?} → ProcessPlanDetail (create default name "Manufacturing Process" if missing, else update) |
| POST /process-plans/:id/operations | {seq?,name,workCenter?,description?,setupMinutes?,runMinutes?} → 201 OperationDetail |
| PATCH /operations/:id | same fields optional → OperationDetail |
| DELETE /operations/:id | → 204 |
| POST /operations/:id/materials | {partId,quantity,uom?,notes?} → 201 OperationMaterialDetail |
| PATCH /operation-materials/:id | {quantity?,uom?,notes?} → OperationMaterialDetail |
| DELETE /operation-materials/:id | → 204 |

`src/routes/stats.ts`:
| GET /stats | → DashboardStats (parts, plans, users counts; revisionsByLifecycle with all four keys; recentParts: 8 newest PartSummary; myInWork: current user's IN_WORK revisions, newest first, max 8) |

## DTO composition notes (must match `frontend/src/api/types.ts` exactly)

- `PartSummary.latestRevision` = revision with highest id. `revisionCount` = total revisions.
- `PartDetail.revisions` ordered newest first (highest id first).
- `RevisionDetail.bomLineCount` = count of its BOM lines; `hasProcessPlan` = plan exists.
- `BomTreeNode.children` come from the resolved revision of the child (rule 5); leaf/purchased
  parts naturally have empty children. `line.id` at tree root level refers to the BomLine.

## Frontend conventions

- Pages default-export a React component. Imports: `import * as api from '../api/client'`
  (from components dir: `../../api/client`), types from `../api/types`,
  `useAuth` from `../auth/AuthContext`, `LifecycleTag, CategoryTag, formatDate,
  CATEGORY_OPTIONS, LIFECYCLE_OPTIONS, LIFECYCLE_META, CATEGORY_META` from `../components/meta`.
- Ant Design 5 only (no other UI libs). Use `const { message, modal } = AntdApp.useApp()`
  (`import { App as AntdApp } from 'antd'`) for toasts/confirms — never static `message.x`.
  Show `err instanceof ApiError ? err.message : 'Something went wrong'` on failures.
- After any mutation, refetch the affected data (no optimistic updates).
- Routes: `/login`, `/register`, `/` (Dashboard), `/parts`, `/parts/:id` (+ `?rev=<revisionId>`
  to select a revision). Part links go to `/parts/${id}`.

### Component prop contracts (PartDetail composes these tabs)

```tsx
// frontend/src/components/part/BomTab.tsx
export default function BomTab(props: { revision: RevisionDetail; editable: boolean; onChanged: () => void }): JSX.Element
// frontend/src/components/part/WhereUsedTab.tsx
export default function WhereUsedTab(props: { partId: number }): JSX.Element
// frontend/src/components/part/ProcessTab.tsx
export default function ProcessTab(props: { revision: RevisionDetail; editable: boolean; onChanged: () => void }): JSX.Element
```

`editable === (revision.lifecycle === 'IN_WORK')`. `onChanged` tells the parent to refetch the
revision (counts may change); tabs still manage/refetch their own data internally.

## ECN — Engineering Change Notice

Change management for parts/products: an ECN collects the parts being changed
("affected items"), tracks who changed what and why, carries the manufacturing
notice fields (effectivity date, stock disposition per item), and releases all
new revisions atomically when the change is approved.

ECN lifecycle: `DRAFT → (submit) → IN_REVIEW → (approve) → APPROVED → (release) → RELEASED`,
plus `IN_REVIEW → (reject) → DRAFT` and `DRAFT|IN_REVIEW|APPROVED → (cancel) → CANCELLED`.
"Active" ECN status = DRAFT, IN_REVIEW or APPROVED.

### ECN business rules

- **E1 Numbering** — auto `ECN-10001` style: scan max existing `ECN-<digits>` number
  (same approach as generatePartNumber; ECNs are never deleted after numbering issues,
  concurrency handled by retry on P2002).
- **E2 Edit gates** — ECN header fields (title/description/reason/priority/effectivityDate)
  PATCHable only in DRAFT. Items added/removed only in DRAFT. Item fields
  (changeDescription/disposition) PATCHable in DRAFT and IN_REVIEW. Violations → 409
  `"ECN <number> is <status> and cannot be modified"`.
- **E3 One active ECN per part** — adding a part that is an item of another active ECN
  → 409 `"Part <pn> is already on active ECN <number>"`. Adding a part twice to the same
  ECN → 409 `"Part is already on this ECN"`.
- **E4 Start change** (`POST /ecn-items/:id/revision`) — allowed only while the ECN is
  DRAFT or IN_REVIEW (409 otherwise); 409 if item already has a
  toRevision. Look at the part's latest revision (highest id):
  - `IN_WORK` and not linked to any other EcnItem as toRevision → attach it as
    toRevision; fromRevision = the part's latest RELEASED revision or null.
  - `IN_WORK` but linked elsewhere → 409 (covered by E3 in practice).
  - `IN_REVIEW` → 409 `"Latest revision of <pn> is in review — resolve it first"`.
  - `RELEASED`/`OBSOLETE` → create the next revision (same deep-copy semantics as
    POST /parts/:id/revisions: next label, IN_WORK, copy BOM + process plan, createdBy
    req.user), fromRevision = that latest revision, toRevision = the new one.
- **E5 Transition gates** — submit requires ≥1 item (409 `"Add at least one affected part"`).
  approve requires every item to have a toRevision (409 listing part numbers without one)
  and sets approvedBy/approvedAt.
- **E6 Release (atomic)** — in ONE transaction: every item's toRevision must currently be
  IN_WORK or IN_REVIEW; for each toRevision, every BOM child part must have a RELEASED
  revision **or** be itself an affected part of this ECN (its toRevision releases in the
  same transaction) — otherwise 409 naming the offending child part numbers. Then set all
  toRevisions to RELEASED (releasedAt = now), ECN.status = RELEASED, ECN.releasedAt = now,
  and ECN.effectivityDate = now when not already set.
- **E7 Managed revisions** — `POST /revisions/:id/transition` (any action) on a revision
  that is the toRevision of an item whose ECN is active → 409
  `"Revision is managed by <ecnNumber> (<status>) — progress the change through the ECN"`.
  BOM/process edits on IN_WORK revisions stay allowed (normal rule 1).
- **E8 Concurrency** — all ECN status transitions use a conditional
  `updateMany({ where: { id, status: from } })` and 409 on count 0, like part revisions.
- **E9 Deletion** — DELETE an ECN only in DRAFT with no item having a toRevision (409
  otherwise). DELETE an item only in DRAFT; an attached toRevision is simply unlinked
  and remains a normal IN_WORK revision.
- **E10 Part deletion** — DELETE /parts/:id additionally 409s when the part is
  referenced by any EcnItem (message mentions the ECN reference).

### ECN endpoints (`src/routes/ecns.ts`, mounted at /api, requireAuth)

| Method/Path | Body → Response |
|---|---|
| GET /ecns?search&status&page&pageSize | search matches ecnNumber/title (insensitive contains), status exact; page defaults like /parts; ordered ecnNumber desc → Paged<EcnSummary> |
| POST /ecns | {title, description?, reason?, priority?, effectivityDate? (ISO string)} → 201 EcnDetail (title required non-blank ≤200 chars) |
| GET /ecns/:id | → EcnDetail |
| PATCH /ecns/:id | any header field, effectivityDate nullable → EcnDetail (E2) |
| DELETE /ecns/:id | → 204 (E9) |
| POST /ecns/:id/items | {partId, changeDescription?, disposition?} → 201 EcnItemDetail (E2, E3; fromRevision snapshot = part's latest RELEASED revision or null) |
| PATCH /ecn-items/:id | {changeDescription?, disposition?} → EcnItemDetail (E2) |
| DELETE /ecn-items/:id | → 204 (E9) |
| POST /ecn-items/:id/revision | (no body) → EcnItemDetail (E4 "start change") |
| POST /ecns/:id/transition | {action: 'submit'\|'approve'\|'reject'\|'release'\|'cancel'} → EcnDetail (E5, E6, E8) |

DTO shapes are pinned in `frontend/src/api/types.ts`: `EcnSummary`, `EcnDetail`,
`EcnItemDetail`, plus `RevisionDetail.ecn` (the active-or-not ECN ref a revision is
managed by — null when the revision is no ECN's toRevision; when it is one, always the
newest such item's ECN) and `DashboardStats.openEcns`/`recentEcns`.

### ECN frontend

Routes: `/ecns` (list) and `/ecns/:id` (workspace). Sidebar entry "Changes"
(`AuditOutlined` icon). Shared meta in `components/meta.tsx`: `EcnStatusTag`,
`EcnPriorityTag`, `ECN_STATUS_META/OPTIONS`, `ECN_PRIORITY_META/OPTIONS`,
`ECN_DISPOSITION_META/OPTIONS`. ECN links render as `<ecnNumber> — <title>`.
PartDetail: when `revision.ecn` is set and its status is active, show an Alert
"Managed by <ecnNumber> (<status>)" linking to `/ecns/:id` and HIDE the
submit/approve/reject/obsolete action buttons for that revision.

### ECN reviewers & approval workflow

- **E11 Reviewers** — any user can be assigned as a reviewer while the ECN is DRAFT or
  IN_REVIEW (409 otherwise; duplicate reviewer 409 `"User is already a reviewer"`).
  Removal allowed in the same statuses, only while the review is PENDING.
- **E12 Decisions** — `POST /ecn-reviews/:id/decision {decision:'approve'|'reject', comment?}`:
  only the assigned reviewer may decide (403 `"Only the assigned reviewer can decide"`),
  only while the ECN is IN_REVIEW (409). Re-deciding while IN_REVIEW is allowed;
  sets decision APPROVED/REJECTED, comment, decidedAt.
- **E13 Approve gate extension** — when an ECN has ≥1 reviewer, the `approve` transition
  additionally requires every review APPROVED (409 listing reviewer names that are
  pending/rejected). The `submit` transition resets every review to PENDING
  (comment kept, decidedAt cleared).
- Endpoints: `GET /users` → UserSummary[] (id, name, email; ordered by name),
  `POST /ecns/:id/reviewers {userId}` → 201 EcnReviewDetail,
  `DELETE /ecn-reviews/:id` → 204, `POST /ecn-reviews/:id/decision` → EcnReviewDetail.
  `EcnDetail.reviews: EcnReviewDetail[]` (ordered by id asc).

### ECN change impact

`GET /ecns/:id/impact` → EcnImpactEntry[] — one entry per affected item (ordered like
items): `{ part, toRevision, usedIn }` where usedIn = the part's where-used list
(every BomLine referencing it as child, newest parent revision first, same shape as
GET /parts/:id/where-used). Shows which assemblies a change ripples into.

## BOM compare

`GET /bom-compare?left=<revisionId>&right=<revisionId>` — compare the product structures
of any two revisions (same part or different parts). 404 when either revision is missing.

Alignment: at each level, children are matched by child **part id**. Each side expands
through the child's resolved revision (rule 5). Node statuses:
- `ADDED` — only on the right; `REMOVED` — only on the left (their whole subtree is
  expanded one-sided with the same status).
- `CHANGED` — on both sides but differing in any of `quantity`, `uom`, `findNumber`,
  `refDesignators`, `notes`, or `revision` (resolved revision id differs);
  `changedFields` lists which. `UNCHANGED` otherwise.
- Matched nodes recurse both-sided. Depth cap 15; if a part repeats on its own ancestor
  branch, set `cycle: true` and stop recursing.
- `summary` counts nodes by status across ALL levels. DTOs (`BomCompareResult`,
  `BomCompareNode`, `BomCompareSide`) pinned in types.ts. Implemented in
  `backend/src/routes/compare.ts`, mounted at /api.

Frontend: `/compare?left=&right=` page (sidebar "BOM Compare", `DiffOutlined`): two
pickers (part search + revision select per side), summary tiles, indented tree table
with status tags and side-by-side qty/rev columns. EcnDetail item rows link to
`/compare?left=<fromRevId>&right=<toRevId>` when both exist.

## Documents, RBAC, audit, ECR, AML, effectivity, alternates, baselines, attributes, cost

Foundations already in place (do not re-implement): `middleware/rbac.ts`
(requireWriteRole app-wide: VIEWER read-only 403; `requireAdmin(req)` helper),
`middleware/audit.ts` (automatic audit of successful mutations), `middleware/upload.ts`
(`uploadSingle` multer single-file "file" field, `UPLOAD_DIR`, `removeStoredFile`,
`absoluteStoragePath`), `routes/users.ts` (GET /users incl. role, PATCH /users/:id role,
admin-only), `routes/audit.ts` (GET /audit paged). requireAuth+guards are mounted
app-wide in index.ts; routers may keep their own `router.use(requireAuth)` (idempotent).

### Rules

- **T1 Documents** — `DOC-10001` scan-based numbering (like parts/ECNs). Creating a
  document requires a file (400 `"file is required"`), title (1..200), category enum.
  New versions auto-increment `version`. DELETE removes stored files best-effort
  (`removeStoredFile`) and cascades versions+links. Download streams with
  `Content-Disposition: attachment; filename="<fileName>"`. Links: exactly one of
  partId/partRevisionId/ecnId (400 otherwise); duplicate link to same target → 409;
  target must exist (404). Entity listings return `EntityDocument[]` (newest doc first).
- **T2 ECR** — `ECR-10001` numbering. Machine: OPEN → accept → ACCEPTED,
  OPEN → reject(resolution required) → REJECTED; both set resolvedBy/resolvedAt; 409 when
  not OPEN. PATCH only while OPEN. accept: `{ecnId}` links an existing ECN (404 if
  missing) OR omitted → auto-create a DRAFT ECN titled from the ECR (`title`, reason =
  ECR description, priority copied; if ECR has a part, add it as an ECN item) and link
  it. List filters: search (ecrNumber/title, insensitive), status; order id desc.
- **T3 AML** — Manufacturers: GET (search by name, order name asc, max 50), POST
  {name unique 409, website?}. ManufacturerParts per part: POST validates mpn non-blank
  ≤80 chars, status enum; duplicate (partId,manufacturerId,mpn) → 409. GET ordered by
  status (PREFERRED first) then mpn — implement via fetch + sort in JS.
- **T4 Effectivity** — BomLine gains effectiveFrom/effectiveTo (ISO strings, nullable).
  Validate parseable dates and from < to (400). `?asOf=<ISO date>` on GET bom + bom/tree
  filters lines to those effective at that instant (null bounds = open). Tree recursion
  applies the same asOf at every level.
- **T5 Alternates** — POST /bom-lines/:id/alternates {partId, note?}: edit gate (owning
  revision IN_WORK, 409 rule-1 message), alternate ≠ line's child part (409), part must
  exist (404), duplicate → 409. DELETE /bom-line-alternates/:id with same edit gate.
  BomLineDetail and BomTreeNode.line include `alternates` (and effectivity fields).
- **T6 Baselines** — POST snapshots the revision's resolved structure (same traversal
  as bom/tree: resolved revisions, depth cap 15, cycle-stop) into BaselineLine rows
  (parentLineId tree, revisionLabel = resolved rev letter, sortOrder = sibling index).
  name 1..120 required. GET /baselines/:id rebuilds `nodes` from stored rows. DELETE:
  creator or admin (403 otherwise). GET /baseline-compare?left&right aligns stored
  trees by partId per level — same statuses/changedFields semantics as /bom-compare
  but `revision` comparisons use `revisionLabel` (sides set `revision: null` and
  `revisionLabel`). DELETE /parts/:id additionally 409s when the part appears in any
  BaselineLine ("Part is referenced by a baseline...").
- **T7 Attributes** — AttributeDef CRUD is admin-only (`requireAdmin`). name
  `/^[a-z][a-z0-9_]*$/` ≤40, unique per category (409). options only for LIST (else
  ignored/empty). DELETE cascades values. `PUT /parts/:id/attributes {values: {<defId>: value|null}}`:
  defs must belong to the part's category (400); validate by type (NUMBER finite,
  DATE parseable, BOOLEAN "true"/"false", LIST value ∈ options); null removes the
  value; returns the full PartAttribute[] list. GET /parts/:id (PartDetail) includes
  `attributes` (every def of its category, value or null, sortOrder then label order)
  and `unitCost`. POST/PATCH parts accept optional `unitCost` (≥ 0 or null).
- **T8 Cost roll-up** — GET /revisions/:id/cost-rollup walks the resolved structure
  (depth 15, cycle-stop, no asOf): node.effectiveUnitCost = part.unitCost if non-null,
  else sum of children extendedCost (null if any child null or no children);
  extendedCost = effectiveUnitCost × quantity (root nodes' quantity from their lines).
  totalCost = sum of root nodes' extendedCost (null if any null). missingCosts = sorted
  unique part numbers where unitCost is null AND the node has no children.
- **T9 RBAC specifics** — attribute-def CRUD and user role changes are ADMIN-only;
  everything else follows the global write guard. Document DELETE and baseline DELETE:
  creator or ADMIN.

### Endpoints (all under /api; DTOs pinned in frontend/src/api/types.ts)

`routes/documents.ts`: GET /documents (Paged<DocumentSummary>; search matches
docNumber/title), POST /documents (multipart via uploadSingle) → 201 DocumentDetail,
GET/PATCH/DELETE /documents/:id, POST /documents/:id/versions (multipart) →
DocumentDetail, GET /document-versions/:id/file (download), POST /documents/:id/links →
DocumentDetail, DELETE /document-links/:id → 204, GET /parts/:id/documents,
GET /revisions/:id/documents, GET /ecns/:id/documents → EntityDocument[].
Link labels: PART → partNumber; REVISION → `<partNumber> rev <rev>`; ECN → ecnNumber.

`routes/ecrs.ts`: GET /ecrs, POST /ecrs → 201 EcrDetail, GET/PATCH /ecrs/:id,
POST /ecrs/:id/accept, POST /ecrs/:id/reject.

`routes/sourcing.ts`: GET/POST /manufacturers, GET /parts/:id/manufacturer-parts,
POST /parts/:id/manufacturer-parts → 201, PATCH/DELETE /manufacturer-parts/:id.

`routes/attributes.ts`: GET /attribute-defs?category, POST/PATCH/DELETE
/attribute-defs[/:id] (admin), PUT /parts/:id/attributes.

`routes/baselines.ts`: GET /baselines (Paged; search matches name/part number),
POST /baselines → 201 BaselineDetail, GET/DELETE /baselines/:id,
GET /baseline-compare?left&right → BaselineCompareResult.

`routes/cost.ts`: GET /revisions/:id/cost-rollup → CostRollup.

### Frontend contracts

New tab/panel components (default exports, api imports `../../api/client`):
```tsx
// components/DocumentsCard.tsx — reusable on parts, revisions and ECNs
export default function DocumentsCard(props: {
  title?: string;
  partId?: number; revisionId?: number; ecnId?: number;   // exactly one set
  editable: boolean;
}): JSX.Element
// components/part/SourcingTab.tsx
export default function SourcingTab(props: { part: PartDetail; editable: boolean }): JSX.Element
// components/part/CostTab.tsx
export default function CostTab(props: { revision: RevisionDetail }): JSX.Element
// components/part/AttributesPanel.tsx — shown inside PartDetail Overview tab
export default function AttributesPanel(props: { part: PartDetail; onChanged: () => void }): JSX.Element
// components/CompareResultView.tsx — extracted from BomCompare, reused by baselines
export default function CompareResultView(props: {
  summary: { added: number; removed: number; changed: number; unchanged: number };
  nodes: BomCompareNode[];
  leftTitle: string; rightTitle: string;
}): JSX.Element
```
Pages: /documents (list+create), /documents/:id (versions/links), /ecrs, /ecrs/:id,
/baselines (list + create-from-picker + view modal + compare two), /activity (audit),
/admin/users, /admin/attributes. `useAuth().user.role` gates admin UI ("Admin" menu
section) — server remains the authority. Meta helpers exist in components/meta.tsx:
DOC_CATEGORY_META/OPTIONS, ECR_STATUS_META/OPTIONS + EcrStatusTag, AML_STATUS_META/
OPTIONS + AmlStatusTag, ATTRIBUTE_TYPE_OPTIONS, ROLE_OPTIONS, formatBytes, formatMoney.

## Enterprise layer — inbox, search, notifications, exports

### Notifications (`src/routes/notifications.ts`, helper `src/lib/notify.ts`)

- Model: Notification (userId, type, title, body?, link?, readAt?, createdAt).
  `notifyUsers(db, userIds, actorId, {type,title,body?,link?})` dedupes and skips the actor.
- Events (hooked into existing routes, using the SAME transaction where the action runs):
  - `REVIEWER_ASSIGNED` (POST /ecns/:id/reviewers → notify the reviewer; link /ecns/:id)
  - `ECN_SUBMITTED` (transition submit → notify all reviewers)
  - `REVIEW_DECIDED` (POST /ecn-reviews/:id/decision → notify the ECN creator; title includes reviewer name + decision)
  - `ECN_APPROVED` / `ECN_REJECTED` / `ECN_RELEASED` / `ECN_CANCELLED` (transitions → notify creator + all reviewers)
  - `ECR_ACCEPTED` / `ECR_REJECTED` (→ notify the ECR creator; link /ecrs/:id)
  - `ECR_RAISED` (POST /ecrs → notify all ADMIN users)
- Endpoints: GET /notifications?unread=1&page&pageSize (newest first; response = NotificationList
  in types.ts — `unread` is the caller's total unread count regardless of filters);
  POST /notifications/read {ids:[..]} or {all:true} → {unread} (only the caller's own rows).

### Global search (`src/routes/search.ts`)

GET /search?q= (min 2 chars after trim, else all-empty result) → SearchResults (types.ts):
max 5 hits per group, insensitive contains. parts: partNumber/name → route /parts/:id,
label `PN — name`, sublabel category label. documents: docNumber/title → /documents/:id.
ecns: ecnNumber/title → /ecns/:id, sublabel status. ecrs: ecrNumber/title → /ecrs/:id.
manufacturers: name → sublabel `<n> linked parts`, route /parts (no detail page; label name).

### My Work (`src/routes/mywork.ts`)

GET /my-work → MyWork (types.ts), all scoped to req.user:
pendingReviews (my EcnReviews with decision PENDING on IN_REVIEW ECNs, newest first);
inWorkRevisions (my created IN_WORK revisions + the managing active ECN ref via ecnItemsTo, newest first, max 20);
openEcrs (my created OPEN ECRs as EcrSummary, newest first, max 20);
activeEcns (ECNs I created with active status, as EcnSummary, newest first, max 20).

### BOM export (in `src/routes/bom.ts`)

GET /revisions/:id/bom/export.csv → text/csv attachment `<partNumber>_rev<label>_bom.csv`.
Multi-level walk identical to the tree endpoint (resolved revisions, depth cap, cycle stop,
no asOf filter). Columns: Level,Find,Part Number,Part Name,Category,Revision,Lifecycle,
Quantity,UoM,RefDes,Notes,Effective From,Effective To. Proper CSV quoting (RFC 4180).

### Frontend

- `pages/MyWork.tsx` at /my-work, sidebar "My Work" (InboxOutlined) first after Dashboard.
- Header (AppLayout): global search AutoComplete (debounced ≥2 chars, grouped options,
  navigate on select) + notifications Badge/bell Dropdown (poll every 30s; click item →
  mark read + navigate; "Mark all read"). Bell count = unread.
- `pages/EcnReport.tsx` at /ecns/:id/report — printable ECN notice (white page, no app
  chrome, print button → window.print(), @media print CSS): header (number/title/status/
  priority/effectivity/reason/description), affected items table (from→to, disposition,
  change description), reviewers/sign-offs, impact list. Route registered INSIDE RequireAuth
  but OUTSIDE AppLayout. EcnDetail gets a "Print notice" button linking there.
- BomTab toolbar gets an "Export CSV" button (href = api.bomExportUrl(revision.id)).

## Email, requirements and the workflow engine

### Email (`lib/mailer.ts` outbox dispatcher, `routes/email.ts`)

### Requirements & traceability (`src/routes/requirements.ts`)

Rules: **R1** numbering REQ-10001 (scan + P2002 retry). **R2** title/statement required
(statement ≤ 4000); type/priority enums; parentId must exist and must not create a cycle
(walk ancestors). **R3** edit gate: PATCH only while DRAFT (409 otherwise); transitions:
approve DRAFT→APPROVED, obsolete APPROVED→OBSOLETE (conditional updateMany). **R4** DELETE
only DRAFT with no children (409). **R5** links: exactly one of partId/documentId (400);
target must exist (404); duplicate (same requirement+target) 409; link/unlink allowed any
status. **R6** matrix: rows ordered reqNumber asc; covered = ≥1 part link; totals over all
requirements.
Endpoints: GET /requirements (search on reqNumber/title via escapeLike, status/type filters,
paged like /parts) · POST /requirements · GET /requirements/matrix (register BEFORE
/requirements/:id) · GET /requirements/:id · PATCH · POST /requirements/:id/transition
{action} · DELETE · POST /requirements/:id/links · DELETE /requirement-links/:id ·
GET /parts/:id/requirements (RequirementSummary[] satisfied by the part, reqNumber asc).
DTOs pinned in types.ts (linkedParts/linkedDocuments = counts of respective link kinds;
childCount; RequirementDetail.children as summaries ordered reqNumber asc).

### Workflow engine (`src/routes/workflows.ts` + hooks in ecns.ts)

Rules: **W1** templates admin-managed (requireAdmin on POST/PATCH/DELETE; GET any user):
name unique 1..100; steps array ≥1, each {name 1..100, rule ANY|ALL, role? OR userIds?
(≥1 total assignee source; both allowed)}; PATCH replaces steps wholesale when `steps`
present — 409 if the template has RUNNING instances; DELETE only with zero instances
(otherwise 409 "deactivate instead"). **W2** instantiation: POST /ecns/:id/transition
submit accepts optional workflowTemplateId — template must exist, be active, have ≥1 step
(400/404/409). In the SAME transaction as the status change: create EcnWorkflow
(templateName snapshot, currentSeq 1) + WorkflowTasks for ALL steps upfront (per step:
explicit assignees ∪ users with the step's role at instantiation, deduped; a step
resolving to 0 users → 409 naming the step). Notify TASK_ASSIGNED to step-1 users
(link /ecns/:id). With a workflow attached, flat-reviewer reset still runs (harmless).
**W3** decision: POST /workflow-tasks/:id/decision {decision:'approve'|'reject',comment?}
— 403 unless req.user is the task's user; 409 unless task PENDING, workflow RUNNING,
task.seq === currentSeq, and ecn.status IN_REVIEW. All effects in ONE transaction:
approve → mark task APPROVED; step completes when rule ANY (mark sibling PENDING tasks
of that seq SKIPPED) or rule ALL with no PENDING left in seq. Step complete: last step →
workflow COMPLETED (completedAt), ECN → APPROVED via conditional updateMany from
IN_REVIEW (approvedById = actor) + notify creator+all task users (ECN_APPROVED); else
currentSeq+1 + notify next-step users (TASK_ASSIGNED). reject → task REJECTED, workflow
REJECTED, ECN → DRAFT (conditional) + notify creator + task users (ECN_REJECTED).
**W4** gates in ecns.ts transition: `approve` 409 when a RUNNING workflow exists
("approval is managed by workflow <templateName>"); `reject`/`cancel` set a RUNNING
workflow to CANCELLED in the same transaction. **W5** GET /ecns/:id/workflow →
EcnWorkflowDetail (tasks ordered seq asc then id asc) or JSON null. **W6** my-work adds
pendingTasks (my PENDING tasks, task.seq = currentSeq, workflow RUNNING, ecn IN_REVIEW,
newest first). **W7** E13 flat-reviewer approve gate applies only when NO workflow
instance exists for the ECN. **W8** search gains a requirements group
(reqNumber/title → route /requirements/:id, sublabel = status).

### Frontend

- `pages/RequirementsList.tsx` (/requirements, sidebar "Requirements", ProfileOutlined,
  after Documents): Tabs "Requirements" (filterable paged table: REQ # link, title,
  ReqTypeTag, EcnPriorityTag, ReqStatusTag, links count, children count, created; New
  requirement modal incl. optional parent picker searching requirements) and
  "Traceability matrix" (totals Statistic tiles incl. uncovered highlighted; table:
  requirement, status, satisfied-by part links, doc count; uncovered rows tinted).
- `pages/RequirementDetail.tsx` (/requirements/:id): header (REQ # + title, tags,
  approve/obsolete/delete per R3/R4, edit modal while DRAFT), statement/rationale/
  acceptance, parent link + children table, links card (add part via part search, add
  document via document search — api.listDocuments exists; remove; role-gated).
- `components/part/RequirementsTab.tsx` — `{ part: PartDetailDto }` prop; lists
  api.getPartRequirements; PartDetail gets a "Requirements" tab (wired by integrator).
- `pages/WorkflowsAdmin.tsx` (/admin/workflows, admin section): template table
  (name, active Switch, steps summary, instances) + create/edit modal with a steps
  builder (add/remove/reorder rows: name, rule Select, role Select allowClear
  ADMIN/ENGINEER/VIEWER, users multi-Select from api.listUsers) + delete.
- `pages/EmailAdmin.tsx` (/admin/email): status card (configured/host/from via
  api.getEmailStatus, M365 setup instructions when unconfigured) + "Send test email"
  (admin) showing result.
- EcnDetail: Submit-for-review now opens a small modal with optional workflow template
  Select (active templates; "No workflow — flat reviewers" default) → transitionEcn with
  workflowTemplateId. When api.getEcnWorkflow(ecn.id) is non-null: hide the Reviewers
  card, show a "Approval workflow" card instead — antd Steps (one per seq: title=stepName,
  status by tasks) + task table (step, user, TaskDecisionTag, comment, decided) + inline
  Approve/Request-changes buttons with comment box when I have the actionable task.
  Refetch workflow with the ECN.
- MyWork: "Workflow tasks waiting on you" card (from pendingTasks) above reviews.
- AppLayout SEARCH_GROUPS gains Requirements group.

## Integration — API keys, webhooks, ERP exchange, variants, analytics

Foundations: `src/middleware/apikey.ts`
(apiKeyAuth, generateApiKey, hashApiKey), `src/lib/webhooks.ts` (WEBHOOK_EVENTS,
emitEvent, signPayload, dispatchPendingWebhooks). Routers `integration.ts`, `erp.ts`,
`variants.ts`, `analytics.ts` are already imported+mounted at /api in index.ts.

### I1 — API keys (`src/routes/integration.ts`, admin only for all three)
- GET /api-keys → ApiKeySummary[] (newest first; never returns key material).
- POST /api-keys {name, scopes:'read'|'write'} → 201 ApiKeyCreated — generateApiKey(),
  store prefix+keyHash, return `key` (full string) EXACTLY ONCE.
- POST /api-keys/:id/revoke → ApiKeySummary with revokedAt set (409 if already revoked).

### I2 — Webhooks (`src/routes/integration.ts`, admin only)
- GET /webhook-events → WEBHOOK_EVENTS as string[] (non-admin allowed).
- GET /webhooks → WebhookSummary[] with recentDeliveries = 5 newest deliveries.
- POST /webhooks {name, url (must parse as http/https URL, else 400), events: string[]
  (non-empty; every entry must be in WEBHOOK_EVENTS, else 400)} → 201 WebhookCreated
  (secret = crypto.randomBytes(24).toString('hex'), returned once).
- PATCH /webhooks/:id {name?,url?,events?,active?} → WebhookSummary. DELETE → 204.
- POST /webhooks/:id/test → {queued:true}: queue a `part.released` sample delivery to
  that hook only (insert a WebhookDelivery directly; dispatcher sends it).
- Event emission (call `emitEvent(tx, ...)` inside the existing transactions):
  `revision.released` + `part.released` when a revision reaches RELEASED (both the
  direct approve transition in parts.ts AND the ECN atomic release in ecns.ts);
  `ecn.submitted` / `ecn.approved` / `ecn.released` in the ECN transition;
  `ecr.raised` on ECR create; `document.created` on document create.
  Payload data: compact, ids + numbers + names (e.g. {partId, partNumber, revisionId,
  revision, lifecycle} / {ecnId, ecnNumber, title, status}).

### I3 — ERP exchange (`src/routes/erp.ts`)
- GET /erp/items.csv | /erp/items.json → the item master: every part with
  partNumber, name, category, uom, unitCost, latest released revision label (blank when
  none), lifecycle of latest revision, preferred MPN + manufacturer (AmlStatus PREFERRED,
  else blank). CSV uses the same csvField quoting/neutralization approach as bom.ts.
- GET /erp/bom/:revisionId.csv | .json → single-level BOM for ERP: parentPartNumber,
  findNumber, childPartNumber, quantity, uom, refDesignators. 404 if revision missing.
- POST /erp/import/parts {csv, dryRun} → ImportResult. Header row required with columns
  partNumber,name,category,uom,unitCost,description (order-independent, case-insensitive;
  unknown columns ignored; partNumber+name required). Existing partNumber → update
  (name/category/uom/unitCost/description), else create with revision A IN_WORK by the
  caller. Invalid category/unitCost → issue for that row, row skipped. dryRun=true does
  ALL validation and returns counts WITHOUT writing (wrap in a transaction that throws a
  sentinel to roll back, or validate-only path). Non-dry-run writes in ONE transaction.
- POST /erp/import/bom/:revisionId {csv, dryRun} → ImportResult. Columns
  childPartNumber,quantity,uom,findNumber,refDesignators. Edit gate: revision must be
  IN_WORK (409 otherwise). Unknown childPartNumber → issue+skip. Existing line for that
  child → update quantity/uom/refDes; else create (auto findNumber when blank, same
  rule 8 as bom.ts). Cycle rule 4 must still hold — reuse the same reachability check
  (import a part that would create a cycle → issue+skip, never a 500).

### I4 — Variants (`src/routes/variants.ts`)
- GET /parts/:id/option-groups → OptionGroupDetail[] (sortOrder, then id).
  `lineCount` per value = BomLineOption rows for that value.
- POST /parts/:id/option-groups {code,name,description?,required?,multiSelect?} → 201
  (code: /^[A-Z0-9_-]{1,20}$/i, unique per part → 409). DELETE /option-groups/:id → 204.
- POST /option-groups/:id/values {code,name,isDefault?} → OptionGroupDetail (the parent
  group, refreshed). DELETE /option-values/:id → 204.
- PUT /bom-lines/:id/options {optionValueIds:number[]} → {optionValueIds} — replaces the
  line's conditions. Edit gate: owning revision must be IN_WORK (409). Every id must
  exist and belong to a group of the revision's OWN part (409 otherwise).
- POST /revisions/:id/resolve-variant {selections:[{groupCode,valueCodes[]}]} →
  VariantResolution. Rules: a line with no conditions is ALWAYS included
  (`unconditionalCount`); a conditioned line is included iff at least one of its
  condition values is selected. Validate: unknown groupCode/valueCode → 400; a required
  group with no selection → 400 `"Select an option for <groupName>"`; a non-multiSelect
  group given >1 value → 400. `conditions` on each line = the option value codes.
  included/excluded ordered by findNumber.

### I5 — Analytics (`src/routes/analytics.ts`)
GET /analytics → AnalyticsKpis (types.ts). changeCycle: releasedLast90 = ECNs with
releasedAt within 90 days; avgDraftToReleaseDays = mean(releasedAt − createdAt) over
released ECNs (null when none, round to 1 decimal); avgReviewDays = mean(approvedAt −
createdAt) over approved-or-later ECNs; openByStatus covers all five EcnStatus keys.
bomHealth: partsNeverReleased = parts with no RELEASED revision; partsMissingCost =
unitCost null; revisionsInWork; releasedWithUnreleasedChildren = RELEASED revisions
having ≥1 BOM child part with no RELEASED revision. requirements: total/covered
(≥1 link)/approved. throughput: last 6 calendar months, `month` = 'YYYY-MM',
created = ECNs created that month, released = ECNs released that month, oldest first.
topCostDrivers: 5 parts with the highest rolled-up cost — reuse the roll-up logic in
`src/routes/cost.ts` (import or replicate; depth-capped, cycle-safe).

### Frontend — integration, ERP, variants, analytics
- `pages/IntegrationAdmin.tsx` at /admin/integration (admin): API keys table (name,
  prefix, scope, last used, created, Revoke) + create modal that shows the full key ONCE
  in a copyable Alert with a "copy" button and a warning it won't be shown again;
  Webhooks table (name, url, events tags, active Switch → updateWebhook, Test, Delete)
  + create modal (name, url, events multi-Select from listWebhookEvents) showing the
  secret once; expandable row per webhook listing recentDeliveries (event, status tag,
  attempts, response code, time).
- `pages/ErpExchange.tsx` at /erp (sidebar "ERP Exchange", `ApiOutlined`): export card
  with download links (items CSV/JSON) and a revision picker (part search → revision
  select) for the BOM export; import card with a TextArea/Upload for CSV, target
  selector (Parts | BOM into a chosen revision), "Validate (dry run)" and "Import"
  buttons, and a result panel (counts + issues table).
- `components/part/OptionsTab.tsx` — part tab "Options" (shown for ASSEMBLY parts, or
  always): manage option groups/values; per BOM line condition editing lives in BomTab's
  edit modal (add an "Options" Select there: multi-select of the part's option values,
  loaded via listOptionGroups(revision.partId), saved with setBomLineOptions after the
  line save; only when the part has ≥1 option group).
- `pages/Configurator.tsx` at /configure (sidebar "Configurator", `ControlOutlined`):
  pick part+revision, render one Select per option group (multiple when multiSelect,
  defaults preselected from isDefault), Resolve button → summary Statistic row
  (included/excluded/unconditional) + included lines table (find, part link, qty, rev,
  condition tags) + collapsible excluded table.
- `pages/Analytics.tsx` at /analytics (sidebar "Analytics", `BarChartOutlined`):
  KPI Statistic cards (released last 90d, avg draft→release days, avg review days,
  open changes), BOM health card (list with counts, warning colouring when >0),
  requirement coverage (Progress), throughput table/inline bars by month, and a
  top cost drivers table. No chart library — use antd Progress/Table/Statistic only.
- AppLayout: add sidebar entries "ERP Exchange" (/erp), "Configurator" (/configure),
  "Analytics" (/analytics), and (admin only, alongside the other admin links)
  "Integration" (/admin/integration); extend the selectedKey prefix list. App.tsx:
  register all four routes (Integration wrapped in RequireAdmin like other /admin pages).

## Quality, projects, RFQ and CAD conversion

New routers to create and mount at /api in index.ts: `quality.ts`, `projects.ts`, `rfq.ts`.
Schema models: Nonconformance, CorrectiveAction, Project, ProjectPhase, ProjectDeliverable,
Supplier, Rfq, RfqLine, RfqQuote, plus DocumentVersion conversion columns.
Numbering: scan-max + retry on P2002, exactly like generatePartNumber —
`NCR-10001`, `CAPA-10001`, `RFQ-10001`. Project `code` is user-supplied
(`/^[A-Z0-9-]{2,20}$/i`, unique, 409 on duplicate).

### Q1 — CAD derivatives (EDIT `src/routes/documents.ts`)
- The CAD service (compose service `cad`, `CAD_SERVICE_URL`, default http://cad:4100)
  exposes POST /convert {storagePath, fileName} → {status:'DONE',glbPath,triangleCount,
  boundingBox} | {status:'SKIPPED',reason} | {status:'FAILED',error}.
- After a version is created (document create AND add-version), if the extension is
  step/stp/iges/igs/brep/brp set conversionStatus PENDING, respond immediately, then
  fire-and-forget the conversion and persist the outcome (DONE with glbPath/
  triangleCount/boundingBox, or FAILED with conversionError). Never block or fail the
  upload because of the CAD service — a request error just marks FAILED.
- DocumentVersionDetail gains conversionStatus, conversionError, hasGlb (glbPath != null),
  triangleCount, boundingBox (per types.ts).
- GET /document-versions/:id/glb → streams the derivative as model/gltf-binary, inline,
  404 when there is none. Reuse the existing header-sanitizing approach.
- POST /document-versions/:id/convert → re-runs conversion synchronously and returns the
  updated DocumentVersionDetail (409 when the format is not convertible).

### Q2 — Quality (`src/routes/quality.ts`)
| Endpoint | Behavior |
|---|---|
| GET /ncrs?status&search&page&pageSize | Paged<NcrSummary>, newest first; search matches ncrNumber/title |
| POST /ncrs | title+description required; optional partId/partRevisionId (must belong to that part, else 400), severity, quantityAffected>0, lotOrSerial → 201 NcrDetail (status OPEN) |
| GET/PATCH /ncrs/:id | PATCH blocked once CLOSED (409 "NCR <n> is closed"); capaId must exist |
| POST /ncrs/:id/transition {action} | contain: OPEN→CONTAINED; close: OPEN\|CONTAINED→CLOSED (requires a disposition, else 409 "Set a disposition before closing") sets closedBy/closedAt; reopen: CLOSED→OPEN clears closedBy/closedAt. Conditional updateMany + 409 on concurrent change |
| POST /ncrs/:id/escalate | 409 if the NCR already has an ecnId or has no part. Creates a DRAFT ECN (title `NCR <ncrNumber>: <title>`, reason = the NCR description, priority from severity: CRITICAL→CRITICAL, MAJOR→HIGH, else MEDIUM) with one EcnItem for the NCR's part — honoring rule E3 (advisory lock + active-ECN check; 409 with the existing message when the part is already on an active ECN) — links it, and notifies the NCR creator (`NCR_ESCALATED`) |
| GET /capas, POST /capas, GET/PATCH /capas/:id | ownerId must exist; PATCH blocked once CLOSED |
| POST /capas/:id/transition {action} | start: OPEN→IN_PROGRESS; verify: IN_PROGRESS→VERIFIED (requires rootCause AND correctiveAction, else 409) sets verifiedAt; close: VERIFIED→CLOSED sets closedAt (409 if any linked NCR is not CLOSED, listing their numbers); reopen: VERIFIED\|CLOSED→IN_PROGRESS clears verifiedAt/closedAt |

### Q3 — Projects (`src/routes/projects.ts`)
- GET /projects (Paged<ProjectSummary>; `currentPhase` = lowest-seq phase not PASSED,
  null when all passed; passedPhases counts PASSED).
- POST /projects: code/name/ownerId required; `phases` optional — when omitted create the
  default gate set seq 1..5: Concept, Design, Validation, Pilot, Production (status
  NOT_STARTED). Phase seq is assigned by array order.
- GET/PATCH /projects/:id; POST /projects/:id/phases (seq = max+1).
- POST /project-phases/:id/pass — **the gate rule**: 409 when any earlier-seq phase is not
  PASSED ("Pass gate <name> first"); 409 listing names when required deliverables are not
  COMPLETE or WAIVED ("Blocked by: <a>, <b>"); otherwise PASSED + passedAt/passedBy, and
  the next phase (if any) moves NOT_STARTED→IN_PROGRESS. Returns the full ProjectDetail.
- POST /project-phases/:id/deliverables, PATCH /deliverables/:id, DELETE /deliverables/:id
  (all return ProjectDetail except the delete → 204). Linked entity ids must exist (404).
- PhaseDetail.blockingCount = required deliverables not COMPLETE/WAIVED.

### Q4 — Supplier RFQ (`src/routes/rfq.ts`)
- Suppliers: GET /suppliers (all, name asc, quoteCount), POST (code unique, `/^[A-Z0-9-]{2,20}$/i`),
  PATCH /suppliers/:id.
- RFQ: GET /rfqs, POST /rfqs (DRAFT), GET/PATCH /rfqs/:id (PATCH DRAFT-only),
  POST /rfqs/:id/transition {send|close|cancel}: send DRAFT→SENT (409 when no lines) sets
  sentAt; close SENT→CLOSED sets closedAt; cancel DRAFT|SENT|CLOSED→CANCELLED.
- Lines: POST /rfqs/:id/lines (DRAFT only; quantity>0; duplicate part → 409
  "Part is already on this RFQ"), DELETE /rfq-lines/:id (DRAFT only, 204).
- Quotes: POST /rfq-lines/:id/quotes — allowed while the RFQ is SENT or CLOSED (409 in
  DRAFT: "Send the RFQ before recording quotes"); unitPrice>0; one quote per supplier per
  line (409 on duplicate); DELETE /rfq-quotes/:id (204, not after award).
- Award: POST /rfq-lines/:id/award {supplierId} — 409 unless the RFQ is SENT or CLOSED,
  409 when that supplier has not quoted the line. Sets awardedSupplier/awardedAt; when
  every line is awarded the RFQ becomes AWARDED (closedAt if unset).
- `RfqQuoteDetail.extendedPrice` = unitPrice × line quantity; `isLowest` = true for the
  minimum unitPrice on that line (ties: all tied quotes true). Quotes ordered price asc.

### Frontend — quality, projects, RFQ, CAD
- `pages/Quality.tsx` at /quality — Tabs "Nonconformances" / "Corrective actions", each a
  filterable paginated table + create modal; rows link to detail pages.
- `pages/NcrDetail.tsx` at /ncrs/:id — header (number/title/severity/status tags), details
  Descriptions (part link, revision, quantity, lot/serial, disposition, CAPA link, ECN
  link), edit modal, action bar (Contain / Close / Reopen; "Raise ECN" when no ecn and a
  part is set), and a CAPA linker (Select of open CAPAs → updateNcr{capaId}).
- `pages/CapaDetail.tsx` at /capas/:id — 8D-style sections (problem, root cause,
  containment, corrective, preventive) each editable via one modal, owner/due, action bar
  (Start / Verify / Close / Reopen) surfacing the 409 messages, and the linked NCR table.
- `pages/Projects.tsx` at /projects and `pages/ProjectDetail.tsx` at /projects/:id — the
  detail page renders the phase gates as a vertical timeline (antd Steps or a Card per
  phase, PASSED green / IN_PROGRESS blue / BLOCKED red), each phase listing deliverables
  with status Select (inline updateDeliverable), an "Add deliverable" modal (optional
  links to part/document/requirement/ECN via search Selects), and a "Pass gate" button
  disabled with a tooltip when blockingCount > 0.
- `pages/Rfqs.tsx` at /rfqs, `pages/RfqDetail.tsx` at /rfqs/:id (lines with an expandable
  quote comparison table — lowest price highlighted, award button per quote, awarded
  supplier tag), and `pages/Suppliers.tsx` at /suppliers.
- DocumentDetail: show the conversion state (Tag + triangle count + bounding-box size),
  a "Convert now" button when SKIPPED/FAILED and the format is convertible, and pass the
  GLB URL to CadViewer when `hasGlb` so heavy assemblies skip the browser CAD kernel.
- CadViewer: accept an optional `glbUrl` prop; when present load that instead of parsing
  the source file, and label the viewer "converted derivative".
- AppLayout + App.tsx: sidebar entries Quality (/quality, SafetyCertificateOutlined),
  Projects (/projects, ProjectOutlined), RFQs (/rfqs, ShoppingOutlined), Suppliers
  (/suppliers, ShopOutlined); register every route above; extend the selectedKey prefixes
  (including /ncrs and /capas mapping to /quality).

## CAD-driven BOM and eBOM / mBOM reconciliation

The eBOM is `BomLine` on a `PartRevision` — what engineering designed. The mBOM is the
`ProcessPlan` → `Operation` → `OperationMaterial` chain — what manufacturing consumes, and
where. They are deliberately separate structures; these rules connect them.

Schema additions to `OperationMaterial`:
`scrapFactor Float @default(0)` (0.02 = 2 % expected loss) and
`consumable Boolean @default(false)` (adhesive, solder, thread-lock — legitimately absent
from the eBOM, so it must not read as an mBOM-only defect).

### C1 — Assembly extraction (`cad/src/index.js`)
- `POST /assembly {storagePath, fileName}` → same status envelope as `/convert`:
  `{status:'SKIPPED',reason}` for non-CAD extensions, `{status:'FAILED',error}` when the
  kernel cannot read the file, else `{status:'DONE', root, nodeCount, maxDepth}`.
- `root` is an `{name, instances, children[]}` tree built from the occt `root` node.
  Siblings with the same name **and** the same subtree shape collapse into one node with
  `instances` summed — a STEP file repeats an instanced part once per placement, and a BOM
  wants quantity 4, not four lines. Unnamed products become `Unnamed`.
- occt wraps the real product in an anonymous root; when the root name is empty and it has
  exactly one child, that child becomes the returned root.

### C2 — The cBOM: persisted CAD structure (EDIT `src/routes/documents.ts`)
The CAD BOM is a first-class structure, not a transient read. Models `CadStructure`
(one per `DocumentVersion`, cascade-deleted with it) and `CadNode` (self-referencing tree:
`parentId`, `name`, `instances`, `depth`, `seq`). A `DocumentVersion` is immutable, so its
snapshot is versioned with the file and cannot drift from it.

- Extraction runs exactly where conversion does — after document create and add-version,
  fire-and-forget, and again on `POST /document-versions/:id/convert`. It reuses the
  `ConversionStatus` enum (`PENDING`/`DONE`/`SKIPPED`/`FAILED`) on `CadStructure.status`,
  with `error` for the failure text. Extraction never fails the upload.
- `GET /document-versions/:id/assembly` → `CadAssembly` serves the **persisted** tree and
  extracts on first access when no snapshot exists yet, so the kernel is not re-run per
  page view. Never 409 on format — a non-CAD file is `status:'SKIPPED'`.
- `POST /document-versions/:id/assembly/refresh` re-extracts and returns the new snapshot.
- **Part matches are resolved at read time, never stored.** A part created after the CAD
  upload must start matching immediately; a stored match would go stale. Resolution is one
  query over the distinct names: exact case-insensitive `partNumber` (`by:'PART_NUMBER'`),
  then case-insensitive `name` (`by:'NAME'`), else `match:null`. A name matching more than
  one part stays unmatched — guessing would put the wrong part on a BOM.

### C2a — cBOM ↔ eBOM reconciliation (`src/routes/bom.ts`)
- `GET /revisions/:id/cbom-reconciliation?documentVersionId=` → `CbomReconciliation`.
  Without the query parameter it picks the newest readable CAD version linked to the part
  or the revision; 409 `No CAD model is linked to this part` when there is none.
- Compares the CAD root's immediate children against the revision's eBOM, one row per
  part or unmatched CAD name, with `status`: `MATCH`, `QTY_MISMATCH`,
  `MISSING_IN_EBOM` (modelled but not released), `EXTRA_IN_EBOM` (released but not
  modelled), `UNMATCHED` (CAD product with no part). Same severity-first ordering as
  the eBOM ↔ mBOM view. This is the design-vs-engineering half of the triangle
  cBOM → eBOM → mBOM.

### C2b — cBOM version diff (`src/routes/documents.ts`)
- `GET /document-versions/:fromId/cad-diff/:toId` → `CadStructureDiff`: what changed in
  the model between two CAD versions. Rows are keyed by **full node path** (`A/B/C`) so a
  part appearing at two places in the tree is two rows, with `change`: `ADDED`, `REMOVED`,
  `QTY_CHANGED`, `UNCHANGED`. 409 when either version has no DONE snapshot.

### C3 — CAD → eBOM (EDIT `src/routes/bom.ts`, to reuse the cycle/find-number helpers)
- `POST /revisions/:id/bom-from-cad {documentVersionId, apply?, removeMissing?,
  createMissingParts?, recursive?}` → `CadBomProposal`. Reads the persisted cBOM (rule C2).
- Default scope is **one level**: the immediate children of the CAD assembly root map to
  this revision's eBOM lines. Deeper CAD levels belong to the child parts' own BOMs and are
  reported in `deeperNodeCount`.
- `recursive:true` imports the whole tree: every CAD node that matches a part **and** has
  children contributes its children to that part's latest IN_WORK revision. A matched part
  with no IN_WORK revision is skipped and reported in `skippedAssemblies` (with the reason)
  rather than failing the request — one un-editable sub-assembly must not block the rest.
  The response gains `assemblies[]`, one entry per imported level with its own counts.
- Each proposal line carries `change`: `ADD` (CAD node matched to a part not on the BOM),
  `QTY_CHANGE` (on the BOM with a different quantity), `UNCHANGED`, `UNMATCHED` (no part
  matched — nothing to add), `REMOVE` (BOM line with no corresponding CAD node).
- `apply:false` (default) computes the proposal and writes nothing.
- `apply:true` requires IN_WORK (409 with the standard lifecycle message) and applies
  `ADD` + `QTY_CHANGE` only. `REMOVE` is applied **only** when `removeMissing:true`, so a
  partial CAD export cannot silently strip a BOM.
- `createMissingParts:true` first creates a part per `UNMATCHED` name (generated part
  number, name = the CAD name, category `MECHANICAL`, plus revision `A`), turning those
  lines into `ADD`.
- 409 `The CAD file has no readable assembly structure` when the assembly status is not
  DONE. Cycle and find-number rules are the existing ones — a CAD node that would create a
  cycle fails the whole request with the existing cycle message.

### C4 — mBOM from eBOM (EDIT `src/routes/process.ts`)
- `POST /revisions/:id/process-plan/from-bom` → `ProcessPlanDetail`. Requires IN_WORK.
- 409 `Add eBOM lines before generating a manufacturing plan` when the eBOM is empty.
- Creates the plan when absent, then appends one operation (`seq` = max+1, name
  `Assembly`) consuming every eBOM line **not already consumed anywhere in the plan**,
  copying quantity and uom. 409 `Every eBOM line is already consumed by an operation` when
  there is nothing left to add — so the button is safe to press twice.
- `POST /operations/:id/materials` and `PATCH /operation-materials/:id` accept
  `scrapFactor` (>= 0, < 1) and `consumable`.

### C5 — Reconciliation (EDIT `src/routes/process.ts`)
- `GET /revisions/:id/bom-reconciliation` → `BomReconciliation` (per types.ts). Works with
  no plan (`hasPlan:false`, every eBOM line `MISSING_IN_MBOM`).
- One row per part appearing in either structure, with two mBOM figures rounded to 6 dp:
  `mbomNominalQuantity` = `Σ quantity` and `mbomQuantity` = `Σ quantity × (1 + scrapFactor)`.
  **The status compares the nominal figure** — a scrap factor is expected process loss, so
  it must not read as a discrepancy; `mbomQuantity` is reported for planning.
- `status`: `MATCH` (both, nominal quantities within 1e-6), `QTY_MISMATCH` (both, differ),
  `MISSING_IN_MBOM` (eBOM only — nothing consumes it), `CONSUMABLE_ONLY` (mBOM only and
  every consuming material is `consumable`), `EXTRA_IN_MBOM` (mBOM only, not consumable).
- Rows sort by severity — QTY_MISMATCH, MISSING_IN_MBOM, EXTRA_IN_MBOM, CONSUMABLE_ONLY,
  MATCH — then by partNumber, so defects are at the top.

### Frontend — the three BOMs
- Part tabs read design → engineering → manufacturing: `cBOM`, `eBOM`,
  `mBOM / Manufacturing`.
- `components/part/CbomTab.tsx`: a CAD-version selector, the extraction status with a
  refresh action, the cBOM as an expandable tree (product name, instances, matched part,
  unmatched flagged), the cBOM ↔ eBOM reconciliation panel, and a second selector to diff
  this CAD version against another.
- `components/part/BomTab.tsx`: an "Import from CAD" button (IN_WORK only) opens a modal
  that lists the CAD document versions linked to this part or revision, fetches the
  assembly, and shows the proposal table (change tag, CAD name, matched part, CAD qty vs
  BOM qty) with checkboxes for `removeMissing` / `createMissingParts` before Apply.
  Surface `deeperNodeCount` as a note, not an error.
- `components/part/ProcessTab.tsx`: a reconciliation Card above the operations — counts as
  a summary, a row per part with a status tag, and the consuming operations listed. A
  "Generate from eBOM" button when IN_WORK. Operation-material forms gain scrap % and a
  consumable switch.
- Tab labels on PartDetail become `eBOM` and `mBOM / Manufacturing` so the two structures
  are named the way manufacturing names them.

## Electronic signatures and controlled release

Shaped after 21 CFR Part 11 and ISO 13485: a signature is an immutable record of *who*
signed, *what* they signed, *what it meant*, and *when* — and it must stop being trusted
the moment the signed content changes. Models `SignatureRequirement` and
`ElectronicSignature`, enums `SignedEntityType` (`ECN` | `REVISION` | `DOCUMENT`),
`SignatureMeaning` (`AUTHORED` | `REVIEWED` | `APPROVED` | `QA_APPROVED`),
`SignatureStatus` (`VALID` | `VOIDED`), `SignatureAuthMethod` (`PASSWORD` | `EMAIL_CONFIRM`).

### S1 — Requirements (admin-configurable)
- `SignatureRequirement`: `entityType`, `meaning`, `seq`, and exactly one of `role` (any
  user holding it may sign) or `userId` (a named signer); `active` toggles it off without
  losing history. Unique on (`entityType`, `meaning`, `seq`).
- Admin-only CRUD at `/signature-requirements` (GET list, POST, PATCH, DELETE). 400 when
  neither or both of `role`/`userId` are given.

### S2 — Executing a signature (`src/routes/signatures.ts`)
- `POST /:entityType/:id/signatures {meaning, password?, confirmEmail?, comment?}` → 201.
- **Re-authentication is mandatory.** An account with a password must re-enter it
  (`authMethod:'PASSWORD'`); 401 `Password is incorrect` on mismatch. A Google-only account
  has no password, so it must retype its own email address exactly
  (`authMethod:'EMAIL_CONFIRM'`); 401 when it does not match. The method used is stored on
  the record, so the strength of each signature is auditable. Never accept a signature with
  neither component.
- 403 for VIEWER. 409 when the acting user does not satisfy any active requirement for that
  meaning, listing what is required. 409 `You have already signed this as <meaning>` when a
  VALID signature by the same user with the same meaning exists.
- The record captures a **standalone** copy of the signer's printed name and role plus the
  content hash — Part 11 §11.50 requires the record to be readable without joining to a
  user row that may later change.
- Signatures are append-only: there is no PATCH and no DELETE. They are voided, never
  removed.

### S3 — Content hashing and voiding
- `contentHash` is a SHA-256 over a **canonical** projection of the signed entity, built by
  `lib/signing.ts`:
  - `REVISION` — the part number, revision label, and every BOM line (find number, child
    part number, quantity, uom, ref designators) sorted. **Lifecycle is excluded**:
    advancing it is what the signature authorizes, so hashing it would make a release void
    its own authorization.
  - `ECN` — the ECN number, title, priority, disposition, and every item
    (part number, from/to revision labels) sorted by part number.
  - `DOCUMENT` — the doc number, title, category, and the latest version's file name plus
    byte size.
- `GET /:entityType/:id/signatures` → `SignatureManifest`: the current hash, every
  requirement with its signature (or null), and `complete`. Any VALID signature whose
  `contentHash` differs from the current hash is **voided in place on read**
  (`status:'VOIDED'`, `voidedReason` naming the change) before the manifest is returned —
  so a stale signature can never satisfy a release gate, even if nothing wrote to the
  entity through the API.

### S4 — Release gates
- ECN `approve` additionally requires every active `ECN` requirement to hold a VALID
  signature; 409 `Cannot approve: signatures outstanding for: <meanings>`.
- Revision `approve` (IN_REVIEW → RELEASED) requires the same for `REVISION`
  requirements; 409 with the same shape. Revisions released *through* an ECN are gated by
  the ECN's own manifest, not twice.
- With no active requirements for an entity type, nothing is gated — the feature is opt-in
  so an unregulated shop is unaffected.

### Frontend — signatures
- `components/SignaturePanel.tsx`, reused on `EcnDetail` and the part revision: the
  manifest as a table (meaning, who may sign, signer, date/time, method, status), a "Sign"
  button per unmet requirement the current user may satisfy, and a modal that takes the
  password (or email confirmation) plus an optional comment. Voided rows render struck
  through with their reason.
- A signature block suitable for printing appears on `EcnReport`: printed name, meaning,
  date/time and method per Part 11 §11.50.
- `pages/SignatureRequirementsAdmin.tsx` at `/admin/signatures` (ADMIN only, sidebar entry
  `SignatureOutlined`) for the requirement matrix.

## Supplier portal

External suppliers get their own scoped accounts, their own login, and their own thin UI.
The whole feature exists to let a supplier quote an RFQ **without** being able to see the
PLM — so the isolation rules below are the feature, not an afterthought.

Models `SupplierUser` (belongs to a `Supplier`; unique email; nullable `passwordHash`
until the invitation is accepted; single-use `inviteToken` + `inviteExpiresAt`; `active`)
and `RfqInvitation` (unique on `rfqId` + `supplierId`, with `invitedById`, `invitedAt`,
`respondedAt`).

### P1 — Two separate identities
- A supplier session is a **different kind of token** from an internal one: the JWT carries
  `kind:'supplier'` and rides in the `turboplm_portal` cookie, distinct from the internal
  `turboplm_token`, so the two sessions can coexist in one browser.
- `requireAuth` rejects a supplier token (401). `requireSupplierAuth` rejects an internal
  token (401). Neither is a superset of the other: an internal admin does **not** get
  portal access by virtue of being an admin, and a supplier can never reach `/api/*`
  internal routes. This is enforced at the middleware, not per-route.
- Portal routes live under `/api/portal/*` and are the only routes the supplier middleware
  guards.

### P2 — Accounts and invitations (internal side)
- `POST /suppliers/:id/users {email, name}` → 201 `SupplierUserDto` and a single-use
  invitation token valid 14 days. The token is returned **once** in the response (as
  `inviteUrl`) and stored hashed-at-rest is not required, but it is never returned again by
  any later read. 409 on a duplicate email.
- `POST /supplier-users/:id/reset-invite` → issues a fresh token, invalidating the old one.
- `PATCH /supplier-users/:id {active}` deactivates without deleting: a supplier who has
  quoted is part of the record.
- All three are ENGINEER-or-above; VIEWER is rejected by the existing write guard.
- `POST /rfqs/:id/invitations {supplierId}` (409 unless the RFQ is DRAFT or SENT; 409 if
  the supplier is already invited), `GET /rfqs/:id/invitations`,
  `DELETE /rfq-invitations/:id` (409 once that supplier has quoted — removing it would
  orphan the quote).

### P3 — Accepting and signing in (portal side, unauthenticated)
- `POST /portal/accept-invite {token, password}` → sets the password (min 12 chars, same
  rule as the admin bootstrap), clears the token, returns a portal session. 400 on an
  unknown, used, or expired token — with the same message for all three, so the endpoint
  cannot be used to probe which tokens exist.
- `POST /portal/login {email, password}` → 401 `Invalid email or password` for a wrong
  password, an unknown email, an inactive account, or an account that has not accepted its
  invitation. One message for every case.
- `POST /portal/logout`, `GET /portal/me`.

### P4 — What a supplier may see (the isolation rules)
- `GET /portal/rfqs` lists **only** RFQs this supplier is invited to **and** whose status is
  SENT, CLOSED or AWARDED. A DRAFT RFQ is never visible — invitations may be prepared
  before the RFQ is sent.
- `GET /portal/rfqs/:id` 404s (not 403) for any RFQ the supplier is not invited to, so the
  endpoint does not confirm that an RFQ exists.
- A supplier sees the lines, and **only their own quotes**. Competitors' prices, the
  quote count, `isLowest`, and which supplier won are all withheld. A line awarded
  elsewhere reports `awardedToMe:false` with no supplier named; awarded to them reports
  `awardedToMe:true`.
- `POST /portal/rfq-lines/:id/quotes` creates or replaces this supplier's own quote for the
  line (409 unless the RFQ is SENT; 409 once the line is awarded), stamps
  `RfqInvitation.respondedAt`, and reuses the existing quote validation (unitPrice > 0).
- `DELETE /portal/rfq-quotes/:id` withdraws their own quote while the RFQ is still SENT;
  404 for a quote that is not theirs.

### Frontend — portal
- Routes outside `AppLayout` so the PLM chrome never renders for a supplier:
  `/portal/login`, `/portal/accept-invite`, `/portal` (RFQ list), `/portal/rfqs/:id`.
  A minimal `PortalLayout` with the supplier's name and a sign-out control.
- `pages/portal/PortalRfqDetail.tsx` shows the lines with the supplier's own quote inline
  and a single "Submit quote" form per line — never a comparison table.
- Internal side: a "Suppliers invited" card on `RfqDetail` (invite, revoke, and whether
  each has responded), and supplier-user management on `Suppliers` with the one-time
  invitation link surfaced for copying.

## Serial / lot tracking and as-built records

The eBOM says what *should* be built; the as-built record says what *was*. This module
records real physical output and makes it traceable in both directions — the capability that
turns "a bad lot of cells shipped" from a guess into a list of serial numbers.

**One node type, deliberately.** A serialized unit (quantity 1, unique serial) and a lot
(quantity N, one code) are modelled as a single `BuildUnit` discriminated by `kind`, rather
than two tables. Genealogy is then a tree over one node type, so a recursive trace does not
need to branch on which table it landed in — the alternative doubles every query in the
module for no expressive gain.

Models: `BuildUnit` (kind `SERIAL`|`LOT`, unique `identifier`, `partId`,
`partRevisionId` — the revision it was built to, `quantity`, status, `builtAt`,
`shippedAt`, `notes`) and `AsBuiltLine` (`parentId`, `childId`, `quantity`, nullable
`bomLineId`, `substitution`, `recordedById`, unique on `parentId`+`childId`).
Enums `BuildKind` and `BuildStatus` (`IN_PROGRESS`|`COMPLETED`|`SCRAPPED`|`SHIPPED`).

### U1 — Identity and numbering
- `identifier` is user-supplied or generated. Generated serials are `SN-10001` upwards and
  lots `LOT-10001`, both scan-max **through `withNumberLock`** (lib/plm.ts) like every other
  generator — never the unlocked pattern.
- A `SERIAL` unit has `quantity` exactly 1; 400 otherwise. A `LOT` requires `quantity > 0`.
- `partRevisionId` must belong to `partId` (400) and must be RELEASED (409
  `Cannot build to <rev>: it is <lifecycle>`) — you do not build production hardware to an
  unreleased revision.

### U2 — Build status (`src/routes/units.ts`)
- `GET /build-units?kind&status&partId&search&page&pageSize` → `Paged<BuildUnitSummary>`,
  newest first; search matches identifier.
- `POST /build-units`, `GET/PATCH /build-units/:id`. PATCH is blocked once SHIPPED or
  SCRAPPED (409 `<identifier> is <status> and cannot be modified`).
- `POST /build-units/:id/transition {action}`: `complete` IN_PROGRESS→COMPLETED sets
  `builtAt`; `ship` COMPLETED→SHIPPED sets `shippedAt`; `scrap` from IN_PROGRESS or
  COMPLETED → SCRAPPED; `reopen` COMPLETED→IN_PROGRESS clears `builtAt` (409 when it is
  already consumed by a parent — reopening would invalidate that parent's record).
  Conditional `updateMany` + 409 on concurrent change, as elsewhere.

### U3 — Recording what was consumed
- `POST /build-units/:id/as-built {childId, quantity, bomLineId?}` → 201 `BuildUnitDetail`.
- The parent must be IN_PROGRESS (409 `<identifier> is <status> — reopen it to change the
  as-built record`).
- The child must be COMPLETED or SHIPPED (409 `<identifier> is <status> and cannot be
  consumed`): you cannot build something into a product before it is itself finished.
- **Cycle prevention**, same shape as the BOM's: a unit may not appear in its own genealogy,
  transitively. Serialize with `pg_advisory_xact_lock(hashtext('turboplm-as-built'))` and
  check inside the transaction, so two concurrent records cannot both pass.
- A SERIAL child may be consumed by at most one parent (409 `<identifier> is already built
  into <parent>`) — one physical object is in one place. A LOT child may be split across
  many parents, but the total consumed may not exceed its `quantity` (409 naming the
  remaining balance).
- `substitution` is computed, never supplied: true when the child's part differs from the
  part on the referenced `bomLineId`. A `bomLineId` from a different revision than the
  parent's is 400. Omitting `bomLineId` records an unplanned consumption and is allowed —
  reality is what is being recorded.
- `DELETE /as-built-lines/:id` → 204, parent must be IN_PROGRESS.

### U4 — Genealogy, both directions (`src/routes/traceability.ts`)
- `GET /build-units/:id/genealogy` → `GenealogyNode` tree: what went into this unit,
  recursively, depth-capped at 15 with `truncated:true` at the cap. Each node carries the
  unit, the part, the consumed quantity, `substitution`, and whether it has open
  nonconformances.
- `GET /build-units/:id/where-consumed` → the forward trace: every unit this one ended up
  in, recursively, up to the topmost parents. This is the recall query — given a suspect
  lot, it answers which shipped serials contain it. Response includes `shippedUnits`, the
  subset with status SHIPPED, because that is the list someone has to act on.
- Both 404 on an unknown id and are read-only for any authenticated role.

### U5 — As-built vs as-designed (`src/routes/traceability.ts`)
- `GET /build-units/:id/deviations` → `DeviationReport` comparing the unit's as-built lines
  against the eBOM of its `partRevisionId`, one row per part with `status`:
  `MATCH`, `QTY_MISMATCH`, `MISSING` (on the eBOM, never consumed), `UNPLANNED` (consumed,
  not on the eBOM), `SUBSTITUTED` (an approved `BomLineAlternate` was used — reported
  distinctly, not as a defect). Severity-first ordering, then partNumber, matching the
  eBOM↔mBOM view.

### U6 — Unit effectivity on changes
- `Ecn.effectiveFromSerial String?` alongside the existing `effectivityDate`. Free text, not
  a foreign key: "effective from S/N 0042" is routinely written before that unit exists.
- Surfaced on `EcnDetail` and editable while the ECN is DRAFT or IN_REVIEW. 400 when both
  `effectivityDate` and `effectiveFromSerial` are set — an ECN is effective by date or by
  unit, and claiming both makes the cut-in ambiguous.

### U7 — Quality linkage
- `Nonconformance.buildUnitId Int?` joins an NCR to a real unit. The existing free-text
  `lotOrSerial` stays for records that predate a tracked unit; when `buildUnitId` is set the
  API also returns the resolved unit, and `lotOrSerial` is left untouched.
- `GET /build-units/:id` includes its nonconformances, so a unit's quality history is on one
  page.

### Frontend — traceability
- `pages/BuildUnits.tsx` at `/build-units` (filterable table, create modal) and
  `pages/BuildUnitDetail.tsx` at `/build-units/:id`: header with kind/status tags, the
  status action bar, the as-built lines with an "Add consumed unit" modal (searchable unit
  picker, eBOM line selector), the genealogy tree, the deviation report, and linked NCRs.
- `pages/Traceability.tsx` at `/traceability`: pick a unit and see the forward trace, with
  shipped units called out as the actionable set — the recall view.
- Sidebar entries Build Units (`/build-units`, `BarcodeOutlined`) and Traceability
  (`/traceability`, `NodeIndexOutlined`); extend the `selectedKey` prefixes.

## Enterprise access — SSO and project permissions

Two capabilities: sign-in federated to a corporate identity provider, and project-scoped
access for people who should not see everything.

### A1 — Harden the existing OAuth callback first (`src/routes/auth.ts`)
The Google flow has two defects that must be fixed before any further provider is added,
because generalising the flow would multiply them:
- **No `state`.** The callback accepts any authorization code, so it is open to login-CSRF.
  Generate a random `state`, store it in a short-lived signed httpOnly cookie
  (`turboplm_oauth`, 10 minutes, `sameSite:'lax'`), and reject a callback whose `state` does
  not match (redirect to `/login?error=state`). Clear the cookie on use — one state, one
  callback.
- **No `email_verified` check.** The callback links a provider identity to an existing local
  account purely on matching email, which lets whoever controls an unverified address at an
  IdP take over the matching account. Never link or provision on an unverified email:
  redirect to `/login?error=unverified`. Google returns `email_verified` in userinfo; OIDC
  returns it as an id_token claim.

### A2 — Provider configuration (`IdentityProvider`)
Model: `slug` (unique, URL-safe), `displayName`, `protocol` (`OIDC` only — see A5),
`issuer`, `clientId`, `clientSecretEnc`, `discoveryUrl`, `enabled`, `autoProvision`,
`allowedEmailDomains` (String[]), `defaultRole`, `groupClaim`, `groupRoleMap` (Json),
`createdAt`/`updatedAt`.
- The client secret is **encrypted at rest** with AES-256-GCM under a key from
  `SSO_ENCRYPTION_KEY` (falling back to a key derived from `JWT_SECRET`, with a startup
  warning when the dedicated variable is absent). It is a write-only field: **no read
  endpoint ever returns it**, not even masked-but-recoverable.
- Admin-only CRUD at `/identity-providers` (GET list, POST, PATCH, DELETE). GET returns
  `hasClientSecret: boolean` instead of the value.
- `GET /auth/providers` (already public) gains `sso: [{slug, displayName}]` for enabled
  providers, so the login page can render the buttons. It must expose nothing else.

### A3 — The OIDC flow (`src/routes/sso.ts`)
- `GET /auth/sso/:slug/start` → 302 to the provider's authorization endpoint, resolved from
  the discovery document (cached in memory for 10 minutes; a fetch failure is 503
  `Identity provider is unavailable`, never a 500).
- Uses **PKCE** (S256), plus `state` and `nonce`, all three carried in the same short-lived
  signed cookie as A1. A callback missing or mismatching any of them is rejected.
- `GET /auth/sso/:slug/callback` exchanges the code, then validates the id_token
  **before trusting any claim**: signature against the provider's JWKS (cached), `iss`
  exactly equal to the configured issuer, `aud` containing the client id, `exp`/`iat` within
  60 seconds of clock skew, and `nonce` matching. Any failure redirects to
  `/login?error=sso`, and the reason is logged server-side only.
- On success the user gets the ordinary internal session cookie: SSO is a way to
  authenticate, not a third kind of identity. (Contrast the supplier portal, rule P1, which
  deliberately *is* a separate identity.)

### A4 — Provisioning and linking
- Linking order: existing `SsoIdentity` (provider + subject) → else a user with that verified
  email, which is linked and recorded → else provision, if `autoProvision`.
- `allowedEmailDomains`, when non-empty, is enforced on both provisioning **and** linking;
  otherwise redirect `/login?error=domain`.
- Role comes from `groupRoleMap` applied to the `groupClaim` values, first match wins, else
  `defaultRole`. A mapping may never grant ADMIN by default — an explicit map entry is
  required, so a misconfigured group claim cannot mint administrators.
- On every subsequent sign-in the role is **re-evaluated** from claims, so removing someone
  from an IdP group removes their access here. A role set manually in TurboPLM is overwritten
  by the mapping — the IdP is the authority when one is configured. `SsoIdentity` model:
  `providerId`, `subject`, `userId`, `lastLoginAt`, unique on (`providerId`, `subject`).

### A5 — SAML is deliberately out of scope
`protocol` is an enum with one value so the shape is ready, but SAML 2.0 is not implemented.
Correct SAML means XML canonicalisation and signature verification, where subtle bugs are
silent authentication bypasses; it is not something to hand-roll alongside everything else.
The login page must not advertise it. Revisit with a vetted library, as its own piece of work.

### A6 — Project membership (`ProjectMember`)
Model: `projectId`, `userId`, `projectRole` (`LEAD`|`CONTRIBUTOR`|`OBSERVER`), `addedById`,
`addedAt`, unique on (`projectId`, `userId`). `Project.restricted Boolean @default(false)`.
- An unrestricted project behaves exactly as today: every authenticated user may read it.
- A restricted project is visible only to its members and to global ADMINs. It is omitted
  from `GET /projects` and 404s (not 403) on direct access, so a restricted project's
  existence is not disclosed — the same rule as the supplier portal's RFQs.
- Writes to a restricted project require LEAD or CONTRIBUTOR; OBSERVER is read-only within
  it regardless of global role. Passing a phase gate requires LEAD.
- `GET/POST /projects/:id/members`, `PATCH/DELETE /project-members/:id`. Only a LEAD or a
  global ADMIN may change membership. The last LEAD cannot be removed or demoted (409),
  so a restricted project cannot be orphaned.

### A7 — (superseded)
This tier adds **project**-level roles. Item-level access control, originally scoped out
here, now exists: see the "Item-level access control" section (rules X1–X7), whose grants
govern parts, documents, ECNs, projects and build units independently of project
membership.

### Frontend — enterprise access
- `pages/IdentityProvidersAdmin.tsx` at `/admin/sso` (ADMIN only, `KeyOutlined`): provider
  table, create/edit modal with the group→role map editor, and a secret field that shows
  "configured" rather than any value.
- `pages/Login.tsx`: a button per enabled SSO provider from `GET /auth/providers`, and
  friendly text for each `?error=` code (`state`, `unverified`, `domain`, `sso`).
- `ProjectDetail`: a Members card (add/remove, role select) and a "Restricted" toggle, both
  visible only to a LEAD or global ADMIN. (Item visibility is governed separately by the
  X-rules' grants.)

## Vendor catalog import

Bringing a vendor's parts catalog into the PLM. The hard part is not reading files — it is
that every vendor names its columns differently and that a careless import silently creates
thousands of duplicate parts. So the design is: stage everything, map explicitly, classify
every row, show the user what will happen, and only then write.

### What the formats actually are (why the design looks like this)

| Source | Format | Notes |
|---|---|---|
| Anything, in practice | CSV / XLSX | The overwhelming majority. No agreed columns at all. |
| Digi-Key export | CSV | `Digi-Key Part Number`, `Manufacturer`, `Manufacturer Part Number`, `Description`, `RoHS Status`, `Lead Free Status`, `REACH Status` |
| Mouser export | CSV | `Mouser Part Number`, `Mfr. Part Number`, `Manufacturer Name`, `Description` |
| Farnell / Newark | CSV | `Order Code` / `Newark Part Number`, `Manufacturer Part Number` |
| RS Components | CSV | `RS Stock No.`, `Manufacturer Part Number` |
| BMEcat (+ ETIM) | XML | The formal standard, v5.0, from BME (1999). Dominant in EU electrical / HVAC / plumbing / MRO. Products in `<ARTICLE>` with `SUPPLIER_AID`, `MANUFACTURER_AID`, `MANUFACTURER_NAME`, `DESCRIPTION_SHORT`, and ETIM class/feature blocks. |
| McMaster-Carr | REST API | Client-certificate auth, approved customers only — no bulk file. Out of scope; noted so nobody looks for it. |

The through-line: **column mapping is the feature**, not parsing. Hence reusable named
mappings, vendor auto-detection from the header signature, and a mandatory preview.

Models: `CatalogMapping`, `CatalogImport`, `CatalogImportRow`. Enums `CatalogFormat`
(`CSV`|`XLSX`|`BMECAT_XML`), `CatalogImportStatus`
(`DRAFT`|`VALIDATED`|`COMMITTED`|`FAILED`|`CANCELLED`), `CatalogRowStatus`
(`NEW`|`UPDATE`|`DUPLICATE`|`INVALID`|`SKIPPED`|`COMMITTED`).

### V1 — Target of an import
A catalog row becomes up to three records, reusing the existing AML models rather than a
parallel universe of vendor parts:
- `Part` — the internal part (partNumber, name, description, category, uom, unitCost)
- `Manufacturer` — matched by name, case-insensitively
- `ManufacturerPart` — the MPN linking them, plus two new optional columns
  `distributorName` and `distributorPartNumber` recording the offer the row came from.
  One offer per row: multiple competing distributor offers for one MPN are **out of scope**
  (that is what the RFQ module is for), and the contract says so rather than implying more.

### V2 — Upload and staging (`src/routes/catalog.ts`)
- `POST /catalog-imports` (multipart, field `file`, 25 MB cap) → 201 `CatalogImportDetail`.
  Parses headers only far enough to stage rows; **writes nothing outside the import tables**.
  Detects the format from the extension and, for XML, from a `<BMECAT>` root.
  Auto-detects the vendor by header signature and returns `detectedVendor` plus
  `suggestedMappingId` when a built-in preset matches.
- Every source row is stored verbatim in `CatalogImportRow.raw`, so a mapping can be
  re-applied later without re-uploading the file.
- 400 `Unsupported file type` for anything but .csv/.tsv/.xlsx/.xml; 400
  `The file has no data rows` for a header-only file; 413 for oversize (the existing
  body-parser mapping already covers it).
- `GET /catalog-imports` (Paged), `GET /catalog-imports/:id`, `DELETE /catalog-imports/:id`
  (only while DRAFT/VALIDATED/FAILED/CANCELLED — a COMMITTED import is a record of what
  entered the system and is 409 `<file> is committed and cannot be deleted`).

### V3 — Mapping and validation
- `POST /catalog-imports/:id/validate {mappingId?, fieldMap?, defaults?}` → `CatalogImportDetail`.
  Re-runnable any number of times with a different mapping; each run replaces the previous
  classification and **writes nothing to Part, Manufacturer or ManufacturerPart**.
- `fieldMap` maps target field → source column name. Targets: `partNumber`, `name`,
  `description`, `category`, `uom`, `unitCost`, `manufacturerName`, `mpn`,
  `distributorName`, `distributorPartNumber`. `defaults` supplies values the file lacks
  (e.g. `category: 'PURCHASED'`).
- `name` and `mpn` are the only required targets: a catalog row without a description of
  what it is, or without a manufacturer part number, is not importable. 400 naming what is
  missing.
- Per-row classification, in this order:
  1. `INVALID` — a required target is empty, `unitCost` is not a number, or `category`/`uom`
     is not a valid value. `message` says which field and why.
  2. `DUPLICATE` — the same (manufacturerName, mpn) already appeared earlier **in this
     file**. The first occurrence keeps its own status; later ones are DUPLICATE, so one
     messy export cannot create the same part twice.
  3. `UPDATE` — a `ManufacturerPart` already exists for that (manufacturer, mpn). The row
     will amend the existing part rather than create one.
  4. `NEW` — everything else.
- The import moves to VALIDATED. Counts on the import are per status.

### V4 — Commit
- `POST /catalog-imports/:id/commit {createMissingManufacturers?, updateExisting?}` →
  `CatalogImportDetail`. 409 unless the import is VALIDATED (`Validate the import before
  committing`).
- Processes NEW and, when `updateExisting`, UPDATE rows. INVALID, DUPLICATE and SKIPPED rows
  are never written. Each committed row records its `partId`/`manufacturerPartId` and flips
  to COMMITTED, so the import is an audit trail of exactly what it created.
- A missing manufacturer is created only when `createMissingManufacturers` is true;
  otherwise those rows fail individually with `message` set, and the rest still commit — one
  unknown manufacturer must not abandon a 5,000-row import.
- Parts without a `partNumber` in the file get generated ones **through `withNumberLock`**.
  A bulk import is precisely the concurrent-burst case that made unlocked scan-max numbering
  fail, so this path must not reintroduce it.
- Commits in chunks inside a transaction per chunk, not one transaction for 5,000 rows, and
  reports partial success honestly: status becomes COMMITTED when every eligible row landed,
  FAILED when none did, and COMMITTED with a non-zero `failedCount` when some did.

### V5 — Reusable mappings
- `GET /catalog-mappings`, `POST`, `PATCH`, `DELETE` (`builtIn` mappings are read-only: 409
  `<name> is a built-in mapping`). Unique on `name`.
- Built-in presets seeded idempotently on boot for Digi-Key, Mouser, Farnell/Newark, RS
  Components and BMEcat, each with the `headerSignature` that identifies it.
- Saving a mapping from a completed import is the normal path to a house mapping, so
  `POST /catalog-mappings` accepts `fromImportId` to seed `fieldMap` from that import.

### Frontend — catalog import
- `pages/CatalogImports.tsx` at `/catalog-imports`: the import list with status and counts,
  and an upload control.
- `pages/CatalogImportDetail.tsx` at `/catalog-imports/:id`: a three-step flow — **Map**
  (target-field → column selects, pre-filled from the detected preset, with the first few
  source rows shown so the user can see what they are mapping), **Preview** (rows grouped by
  status, filterable, each INVALID row showing its reason, per-row skip), **Commit** (the two
  toggles, a plain-language summary of what is about to be created or amended, then the
  result). Never let Commit be the first button a user can reach.
- `pages/CatalogMappingsAdmin.tsx` at `/admin/catalog-mappings` for the mapping library,
  built-ins visibly read-only.
- Sidebar entry Catalog Import (`/catalog-imports`, `ImportOutlined`).

## Part classification, custom-attribute import, and materials

Three connected additions. Classification already exists and already drives per-class data;
the gaps are that the importer cannot reach custom attributes, and that nothing records what
raw material a part is *made from*.

### Where classification already stands (no new taxonomy)
`Part.category` (`ASSEMBLY`|`MECHANICAL`|`ELECTRICAL`|`PURCHASED`|`RAW_MATERIAL`|`SOFTWARE`)
is the classification, and `AttributeDef` is already keyed on `(category, name)` with a
`type` and a `required` flag — so each class already defines its own attributes, managed at
`/admin/attributes`. Nothing here replaces that. A second parallel taxonomy would split the
truth about a part across two systems, which is worse than the one that exists.

### N1 — Import can target custom attributes (EDIT the catalog import, rules V1-V5)
- `CatalogTargetField` gains a dynamic form: besides the ten fixed fields, a mapping target
  may be `attr:<attributeDefId>`, mapping a source column onto a custom attribute.
- `GET /catalog-imports/:id/targets` → the mappable targets: the fixed fields plus every
  `AttributeDef`, each with `{ key, label, category, type, required, options }`, so the
  mapping UI can group attributes by the class they belong to.
- Validation resolves each `attr:` target and checks, per row:
  - the def exists (else INVALID `Unknown attribute target attr:<id>`);
  - **the def's category matches the row's resolved category** (else INVALID
    `<label> only applies to <category> parts`) — an attribute belongs to a class, so a
    sheet-metal thickness must not land on a software part;
  - the value coerces to the def's `type` (`NUMBER` parses, `BOOLEAN` accepts
    true/false/yes/no/1/0, `DATE` parses ISO or `YYYY-MM-DD`, `LIST` must be one of
    `options`), else INVALID naming the field and the expected form.
- A `required` `AttributeDef` for the row's category with no mapped column and no default is
  INVALID: importing a part that violates its own class definition is not a favour.
- Commit writes `PartAttributeValue` rows alongside the part, in the same transaction, so a
  part never lands with half its attributes.
- `CatalogMappedRow` gains `attributes: { attributeDefId: number; value: string }[]`.

### N2 — Materials (`src/routes/materials.ts`)
Models `Material` and `PartMaterial`, enums `MaterialClass` and `MaterialForm`.

`Material` is the raw stock itself: `code` (unique), `name`, `materialClass`,
`specification` (the controlling spec — `AL 6061-T6`, `ASTM A36`, `PA66-GF30`), `density`
(g/cm³, so a volume can become a mass), `stockUom` (default `kg`), `unitCost`, `notes`,
`active`.

`PartMaterial` is what a part is **made from** — deliberately distinct from both `BomLine`
(which composes *parts*) and `OperationMaterial` (which consumes *parts* at an operation):
`partId`, `materialId`, `form`, `netQuantity` (what ends up in the finished part, in the
material's `stockUom`), `scrapFactor` (fraction lost to machining, trim or sprue — gross =
net × (1 + scrapFactor)), `stockSize` (free text the buyer orders against, e.g.
`40 × 40 × 220 mm bar`), `notes`. Unique on (`partId`, `materialId`, `form`).

- `GET /materials?search&materialClass&active&page&pageSize` → Paged, name asc, each with
  `partCount`. `POST /materials` (code `/^[A-Z0-9._-]{2,32}$/i`, unique, 409 on duplicate),
  `GET/PATCH /materials/:id`, `DELETE /materials/:id` (409 `<code> is used by <n> parts`
  when referenced — deactivate instead).
- `GET /parts/:id/materials`, `POST /parts/:id/materials`, `PATCH /part-materials/:id`,
  `DELETE /part-materials/:id` (204). `netQuantity > 0`; `scrapFactor >= 0 and < 1`, the same
  rule the mBOM already uses.
- Attaching material to an `ASSEMBLY` is allowed but reported as a note by N3, not blocked:
  an assembly's material normally comes from its children, yet adhesives and potting compound
  are real. Blocking it would make the honest case impossible.

### N3 — Material requirements for the mBOM (`src/routes/materials.ts`)
The point of the whole addition: **what do we need to buy to build this?**

`GET /revisions/:id/material-requirements?quantity=N` (N default 1, > 0) →
`MaterialRequirements`:
- Walks the released BOM tree from this revision using the existing resolved-revision rule
  and depth cap, accumulating each part's total quantity per build.
- `materials[]` — one row per `Material`, with `netQuantity`, `grossQuantity`
  (Σ net × (1 + scrapFactor) × cumulative part quantity × N), `stockUom`, `estimatedCost`
  (gross × `unitCost`, null when the material has no cost), and `fromParts[]` showing which
  parts contribute how much, so a surprising total can be traced to its source.
- `unspecified[]` — parts in the tree with **no** `PartMaterial` that plausibly need one:
  category `MECHANICAL` or `RAW_MATERIAL`. These are the holes in material planning, and
  reporting them is as valuable as the totals; a report that silently omits them would read
  as complete when it is not.
- `notes[]` — assemblies carrying direct material, and any truncation at the depth cap.
- Totals rounded to 6 dp before comparison or display, as elsewhere.
- `GET /revisions/:id/material-requirements/export.csv` for the buyer, reusing the existing
  CSV cell-escaping helper (which prefixes `'` to cells starting with `=+-@`).

### Frontend — materials
- `pages/Materials.tsx` at `/materials`: filterable list, create/edit modal, usage count.
- `PartDetail` gains a **Materials** tab (after mBOM): the part's materials with form, net,
  scrap %, gross, stock size, inline add/edit. For a `MECHANICAL` part with none, an
  informational Alert saying material is unspecified and will show as a planning gap —
  informational, never blocking.
- `components/part/MaterialRequirementsCard.tsx` on the mBOM tab: a build-quantity input,
  the totals table with estimated cost, the unspecified-parts warning, and a CSV export.
- Sidebar entry Materials (`/materials`, `ExperimentOutlined`); extend `selectedKey`.

## Document vault — check-out, check-in and locking

Right now two engineers can upload versions of the same document minutes apart and the second
silently wins. That is the gap Upchain closes with a vault, and it is the reason CAD-managed
PLM insists on check-out before edit.

Models: `Document` gains `lockedById`, `lockedAt`, `lockExpiresAt`, `lockNote`. A lock lives on
the **document**, not a version — you reserve the right to produce the next version.

### D1 — Taking and releasing a lock (`src/routes/documents.ts`)
- `POST /documents/:id/checkout {note?}` → `DocumentDetail`. 409
  `<docNumber> is checked out by <name>` when someone else holds it. Re-checking out your own
  lock is idempotent and refreshes the expiry rather than erroring — a user who lost their tab
  should not be stuck.
- `POST /documents/:id/checkin` (multipart `file`, `note?`) → creates the next version **and**
  releases the lock, in one transaction: a check-in that stored the file but left the lock
  held would be worse than either outcome alone. 409 `<docNumber> is not checked out by you`.
- `POST /documents/:id/cancel-checkout` → releases without a version. The holder, or an ADMIN.
- Locks expire after 7 days (`lockExpiresAt`). An **expired** lock may be taken by anyone; the
  response says whose lock was broken so it is never silent.
- `POST /documents/:id/break-lock {reason}` → ADMIN only, `reason` required, works on a live
  lock. Every one of these five actions is recorded by the existing audit middleware, and the
  reason is stored in `lockNote` so the trail explains itself.

### D2 — Vault discipline
- `POST /documents/:id/versions` (the existing direct upload) now **requires** the caller to
  hold the lock: 409 `Check out <docNumber> before uploading a new version`. This is a
  deliberate behaviour change and the whole point of the feature — without it the lock is
  decorative.
- Deleting a document requires no lock (it is not an edit of content) but is refused while
  someone else holds one: 409, so a delete cannot yank a file from under an editor.
- `DocumentDetail` gains `lock: { user, lockedAt, expiresAt, note, isMine, expired } | null`,
  so the UI can show state without a second call.

### D3 — Frontend
- `DocumentDetail`: a lock bar — "Check out" when free; "Check in" + "Cancel check-out" when
  mine; "Checked out by <name> since <date>" plus "Break lock" for an admin when someone
  else's. The upload control is disabled with the reason as a tooltip when the lock is not
  mine, rather than failing after the file is chosen.
- `DocumentsList` shows a lock column so a vault-wide view of who is holding what exists.

## Design review markup

Comment on a specific place in a model or drawing, discuss it, resolve it, and turn it into a
change request when it is real. This is Aras Visual Collaboration's job and Upchain's markup,
and it is the natural payoff for the CAD viewer and cBOM work already done.

Models `Markup` and `MarkupComment`; enums `MarkupKind` (`PIN_3D` | `BOX_2D` | `POINT_2D` |
`NOTE`) and `MarkupStatus` (`OPEN` | `RESOLVED` | `WONT_FIX`).

### K1 — Anchoring a markup
- A markup belongs to a `DocumentVersion`, never to a document: a comment about geometry is
  about *that* geometry, and must not silently follow a new upload.
- `geometry` is JSON whose shape depends on `kind`, and the contract fixes it:
  - `PIN_3D` — `{ point: [x,y,z], camera: { position: [x,y,z], target: [x,y,z] } }`. The
    camera is stored so "look at what I was looking at" actually works.
  - `BOX_2D` / `POINT_2D` — `{ page: number, x: number, y: number, w?: number, h?: number }`
    in **normalized 0–1 coordinates**, so a markup survives a zoom, a different screen and a
    re-render at another size.
  - `NOTE` — `{}`; a version-level remark with no position.
- 400 when geometry does not match the kind, naming the missing key. Out-of-range normalized
  coordinates are 400, not clamped: silently moving someone's markup is worse than refusing it.

### K2 — Endpoints (`src/routes/markup.ts`)
- `GET /document-versions/:id/markups?status=` → `MarkupDetail[]`, oldest first, each with its
  comment thread.
- `POST /document-versions/:id/markups {kind, geometry, body, page?}` → 201. `body` is the
  opening comment and is required — an anchor with nothing said is noise.
- `PATCH /markups/:id` (geometry and body of the opening comment, author or ADMIN only),
  `DELETE /markups/:id` (author or ADMIN; deletes its thread).
- `POST /markups/:id/comments {body}` → 201 `MarkupCommentDto`. Any write-role user.
- `POST /markups/:id/transition {action}` — `resolve` OPEN→RESOLVED, `wont-fix`
  OPEN→WONT_FIX, `reopen` from either back to OPEN. Records `resolvedById`/`resolvedAt`.
  Conditional update + 409 on concurrent change.
- `POST /markups/:id/escalate` → creates an `Ecr` from the markup (title from the opening
  comment, description carrying the thread and a link back), links it via `Markup.ecrId`, and
  409s if it already has one. This is the path from "that hole is in the wrong place" to a
  governed change.
- `GET /my-markups` → markups the caller opened or commented on that are still OPEN, so a
  reviewer can find their own open points.

### K3 — Notifications
Commenting notifies the markup author and every prior commenter except the actor; resolving
notifies the author. Reuses the existing outbox (`notifyUsers`), types `MARKUP_COMMENTED` and
`MARKUP_RESOLVED`.

### K4 — Frontend
- `components/cad/MarkupLayer.tsx` — a self-contained overlay taking
  `{ documentVersionId, kind, readOnly }`. It renders existing markups, places new ones on
  click, and shows the thread in a side panel. It must **not** modify `CadViewer`'s own
  behaviour when no markup is active.
- `components/DocumentMarkupPanel.tsx` — the composed unit (viewer + layer + thread list) that
  the caller drops into `DocumentDetail`. Exported self-contained so the page owner and the
  markup owner do not edit the same file.
- Resolved markups render muted and are hidden behind a "show resolved" toggle, because an
  old review should not clutter a current one.

## Service and as-maintained records

A shipped unit keeps changing: parts get replaced, upgrades get installed. The as-built record
says what left the factory; the as-maintained record says what is in the field now. This
extends the serial/lot work rather than duplicating it.

Models `ServiceRecord` and `ServicePartSwap`; enums `ServiceKind` (`REPAIR` | `UPGRADE` |
`INSPECTION` | `WARRANTY_CLAIM` | `DECOMMISSION`) and `ServiceStatus` (`OPEN` |
`IN_PROGRESS` | `CLOSED` | `CANCELLED`).

### G1 — Records
- A `ServiceRecord` is against a `BuildUnit` — only one with status SHIPPED or COMPLETED (409
  otherwise: you do not service something that was never finished).
- Fields: `serviceNumber` (`SVC-10001`, scan-max **through `withNumberLock`**), `buildUnitId`,
  `kind`, `status`, `title`, `description`, `reportedAt`, `closedAt`, `technicianId`,
  `ncrId?` (a field failure is often a nonconformance), `ecnId?` (an upgrade usually
  implements a change).
- `GET /service-records?buildUnitId&status&kind&search&page&pageSize`, `POST`, `GET/PATCH /:id`
  (PATCH refused once CLOSED), `POST /:id/transition {start|close|cancel|reopen}`.

### G2 — Part swaps: the as-maintained delta
- `ServicePartSwap`: `serviceRecordId`, `removedUnitId?`, `installedUnitId?`, `position?`
  (free text, e.g. "left motor"), `reason`. At least one of removed/installed is required
  (400) — a swap that neither removes nor installs anything is not an event.
- Rules: the removed unit must currently be inside the serviced unit's genealogy (409
  `<identifier> is not part of <serviced>`); the installed unit must be COMPLETED and not
  already consumed elsewhere, reusing the rule U3 single-parent check.
- Committing a swap **rewrites the as-built graph**: the removed unit's `AsBuiltLine` is
  deleted and the installed unit's created, under the same
  `pg_advisory_xact_lock(hashtext('turboplm-as-built'))` rule U3 uses. Doing it any other way
  would let genealogy and service history disagree, and then neither can be trusted.
- The removed unit is written off only when the request says so: `scrapRemoved` (boolean,
  default false). **Never inferred from `reason`.** Inferring it from prose scrapped working
  hardware on the standard phrasing "removed for bench test, no fault found" — SCRAPPED has no
  way back through the API, so a keyword match became permanent data loss. Otherwise the unit
  stays COMPLETED and, its as-built line now gone, is free to be installed elsewhere.
- Deleting a swap undoes **only what that swap did**: it un-scraps the removed unit only when
  that swap set `scrapRemoved`, so hardware written off independently afterwards is not
  resurrected. The restore also re-checks rule U3's consumable set, or it could re-create an
  edge whose child is IN_PROGRESS.

### G3 — As-maintained view
- `GET /build-units/:id/as-maintained` → the genealogy **as it stands now** plus
  `changes[]`: every swap that has touched this unit, newest first, with the service record,
  what came out, what went in and when. The existing `/genealogy` endpoint already returns
  current state; this one adds the history that explains how it got there.
- `GET /build-units/:id/service-history` → the unit's service records with their swaps.

### G4 — Frontend
- `pages/ServiceRecords.tsx` at `/service`, `pages/ServiceRecordDetail.tsx` at
  `/service/:id` (header, status bar, swaps table with an add-swap modal using searchable unit
  pickers, links to the NCR and ECN).
- `BuildUnitDetail` gains an **As maintained** section: the current genealogy with a change
  log beneath it, and a "Raise service record" action.
- Sidebar entry Service (`/service`, `ToolOutlined`).

## Item-level access control

The one architectural gap. Everything else so far has been additive; this changes what **every
read path** returns. A missed route is a data leak, not a cosmetic bug, so the rules below are
deliberately conservative and the verification requirement is part of the contract rather than
an afterthought.

Earlier work (rule A7) deliberately scoped this out and said so in the UI. That statement must
be removed as part of this change — a permission model users half-believe in is worse than none.

Models `AccessGroup`, `AccessGroupMember`, `ItemAcl`; enums `AclEntityType` (`PART` |
`DOCUMENT` | `ECN` | `PROJECT` | `BUILD_UNIT`) and `AclPermission` (`READ` | `WRITE`).

### X1 — The model
- `AccessGroup`: `name` (unique), `description`, `active`. `AccessGroupMember`:
  (`groupId`, `userId`) unique.
- `ItemAcl`: `entityType`, `entityId`, exactly one of `groupId` / `userId`, `permission`,
  `grantedById`, `grantedAt`. Unique on (`entityType`, `entityId`, `groupId`, `userId`).
- **Opt-in, exactly like signatures.** An item with **no** `ItemAcl` rows is readable and
  writable by everyone the existing role rules already allow. The instant it has one row, only
  the listed principals qualify. This is the only migration story that does not break a running
  install on deploy.
- A global `ADMIN` always passes, read and write. Otherwise no permission model can be
  recovered from once someone locks themselves out of an item.
- `WRITE` implies `READ`. A principal granted WRITE need not also be granted READ.

### X2 — One enforcement point (`src/lib/acl.ts`)
Enforcement must not be re-implemented per route. This module is the only place the rules live:
- `aclFilter(entityType, user)` → a Prisma `where` fragment restricting a query to visible
  ids. It must express "no ACL rows exist for this item **OR** the user is listed", which is
  `{ OR: [{ acls: { none: {} } }, { acls: { some: <principal> } }] }` — so every ACL-bearing
  model carries an `acls` relation and the filter is a relation filter, not an id list. An id
  list would not survive a table of any size.
- `assertCanRead(entityType, id, user)` → throws **404**, never 403: a 403 confirms the item
  exists, which is the leak the whole feature exists to prevent. Same rule the supplier portal
  already follows.
- `assertCanWrite(entityType, id, user)` → 404 when not readable, 403 `You do not have write
  access to this <type>` when readable but read-only.
- `visibleIds(entityType, ids, user)` → the subset of a given set that is visible, for
  redacting traversals in bulk without N queries.

### X3 — Where it is applied
Every list endpoint for an ACL-bearing type applies `aclFilter`. Every detail, update and
delete endpoint calls `assertCanRead`/`assertCanWrite` **before** any other validation, so an
error message cannot reveal an item's contents. This covers, at minimum: parts and revisions,
documents and versions, ECNs and items, projects, build units — and every nested read that
returns one of them (BOM lines, where-used, ECN impact, genealogy, deviations, baselines,
search, dashboards, analytics, exports).

### X4 — Traversals: redact, never omit
A BOM containing a part the caller cannot see is the hard case. Omitting the line is a lie
about the structure — quantities would not add up and a cost roll-up would silently
under-report. So a hidden child is returned as a **redacted node**: `{ redacted: true, id:
null, partNumber: 'Restricted', name: 'Restricted', … }` keeping find number and quantity.
The caller learns that something is there and how much of it, but nothing about what it is.
The same rule applies to genealogy, where-used and the deviation report.

Roll-ups (cost, material requirements) must report `redactedCount` when any contributor was
hidden, so a total is never presented as complete when it is not.

### X5 — Search, notifications and exports
- Global search filters every group through `aclFilter`. A restricted item must not appear as
  a search hit, which is the most commonly missed leak.
- A notification whose `link` points at an item the recipient can no longer read is still
  listed (it is their history) but its link is nulled rather than 404ing on click.
- CSV and report exports apply the same filter and redaction as the screen they mirror.

### X6 — Administration
- `GET/POST /access-groups`, `PATCH/DELETE /access-groups/:id` (ADMIN only; delete refused
  while the group holds any ACL, 409 naming the count).
- `GET/POST /access-groups/:id/members`, `DELETE /access-group-members/:id`.
- `GET /:entityType/:id/acl` → the item's grants, `POST` to add, `DELETE /item-acls/:id`.
  Managing an item's ACL requires WRITE on that item, or ADMIN — otherwise a user with write
  access could not delegate, and only an admin could ever share anything.
- The UI must show, on any restricted item, who can see it, and warn before the **first** grant
  is added that doing so restricts the item to that list.

### X7 — Verification is part of the feature
A permission bug is invisible until it is exploited, so this rule is not optional:
- A test file `tests/acl.test.ts` must **enumerate the router stack** at runtime and assert
  that every registered `GET` route either applies the filter or is on an explicit, commented
  allow-list of genuinely public endpoints. A hand-written list of routes to check will drift;
  reading the stack cannot.
- For each ACL-bearing type: a restricted item is absent from the list endpoint, 404s on
  detail, 404s in search, is redacted in every traversal that reaches it, and is invisible in
  exports — asserted for a user in no group, a user in a granted group, and a global admin.
- The A7 boundary note must be deleted from `CONTRACTS.md` and from any UI copy that repeats
  it, in the same change that makes it untrue.

## Seed data (backend/src/seed.ts)

Idempotent: exit early if any Part exists. Users: `demo@turboplm.local` / `demo1234`
("Demo Engineer", ENGINEER) and `admin@turboplm.local` / `admin1234` ("Ada Admin", ADMIN).
Product: **TurboDrone X1** quadcopter — top assembly with rev A RELEASED and rev B IN_WORK,
4-level eBOM (~25 parts: frame, propulsion, power/battery pack, avionics subassemblies with
mechanical/electrical/purchased/raw-material leaves), realistic part numbers/names/quantities,
refDesignators on electrical items, a mix of RELEASED and IN_WORK leaf revisions, process
plans with operations + operation materials for the battery pack and the top assembly.
