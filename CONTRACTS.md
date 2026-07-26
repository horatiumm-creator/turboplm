# TurboPLM — API & Component Contracts (iteration 1)

This file is the single source of truth for how the backend and frontend fit together.
DTO shapes live in `frontend/src/api/types.ts` and the typed HTTP client in
`frontend/src/api/client.ts` — both are already written and MUST NOT be changed by
implementation agents. Backend routes must produce exactly the shapes in `types.ts`.

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

Auth (already implemented in `backend/src/routes/auth.ts` — do not modify):
| Method/Path | Body → Response |
|---|---|
| POST /api/auth/register | {name,email,password} → UserInfo (sets cookie) |
| POST /api/auth/login | {email,password} → UserInfo (sets cookie) |
| POST /api/auth/logout | → 204 |
| GET /api/auth/me | → UserInfo |
| GET /api/auth/providers | → {google: boolean} |
| GET /api/auth/google, /google/callback | OAuth redirect flow |

Feature routers (to implement; mounted at `/api` in `src/index.ts`):

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

### Component prop contracts (PartDetail composes tabs from other agents)

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

## ECN — Engineering Change Notice (iteration 2)

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

### ECN reviewers & approval workflow (iteration 3)

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

## Tier 1+2 (iteration 4) — documents, RBAC, audit, ECR, AML, effectivity, alternates, baselines, attributes, cost

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

## Enterprise layer (iteration 6)

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

## Iteration 7 — email, requirements, workflow engine

### Email (done inline — lib/mailer.ts outbox dispatcher, routes/email.ts; do not modify)

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

## Deployable tier (iteration 8)

Foundations already written (Read, do not modify): `src/middleware/apikey.ts`
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

### Frontend (iteration 8)
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

## Final tier (iteration 9)

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

### Frontend (iteration 9)
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

## Seed data (backend/src/seed.ts)

Idempotent: exit early if any Part exists. Users: `demo@turboplm.local` / `demo1234`
("Demo Engineer", ENGINEER) and `admin@turboplm.local` / `admin1234` ("Ada Admin", ADMIN).
Product: **TurboDrone X1** quadcopter — top assembly with rev A RELEASED and rev B IN_WORK,
4-level eBOM (~25 parts: frame, propulsion, power/battery pack, avionics subassemblies with
mechanical/electrical/purchased/raw-material leaves), realistic part numbers/names/quantities,
refDesignators on electrical items, a mix of RELEASED and IN_WORK leaf revisions, process
plans with operations + operation materials for the battery pack and the top assembly.
