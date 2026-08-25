export type Lifecycle = 'IN_WORK' | 'IN_REVIEW' | 'RELEASED' | 'OBSOLETE';
export type PartCategory =
  | 'ASSEMBLY'
  | 'MECHANICAL'
  | 'ELECTRICAL'
  | 'PURCHASED'
  | 'RAW_MATERIAL'
  | 'SOFTWARE';
export type TransitionAction = 'submit' | 'approve' | 'reject' | 'obsolete';

export interface UserInfo {
  id: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  provider: 'LOCAL' | 'GOOGLE';
}

export interface UserRef {
  id: number;
  name: string;
}

export interface RevisionRef {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
}

export interface PartRef {
  id: number;
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
}

export interface PartSummary extends PartRef {
  description: string | null;
  createdAt: string;
  createdBy: UserRef;
  latestRevision: RevisionRef | null;
  revisionCount: number;
}

export interface RevisionSummary {
  id: number;
  revision: string;
  lifecycle: Lifecycle;
  changeNote: string | null;
  createdAt: string;
  releasedAt: string | null;
  createdBy: UserRef;
}

export interface PartDetail extends PartSummary {
  revisions: RevisionSummary[];
  unitCost: number | null;
  attributes: PartAttribute[];
}

export interface RevisionDetail {
  id: number;
  partId: number;
  revision: string;
  lifecycle: Lifecycle;
  changeNote: string | null;
  createdAt: string;
  releasedAt: string | null;
  createdBy: UserRef;
  part: PartRef;
  bomLineCount: number;
  hasProcessPlan: boolean;
  /** ECN this revision is the working ("to") revision of, if any. */
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
}

// ---- ECN (engineering change notice) ----

export type EcnStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'RELEASED' | 'CANCELLED';
export type EcnPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type EcnDisposition = 'USE_AS_IS' | 'REWORK' | 'SCRAP' | 'RETURN_TO_VENDOR';
export type EcnTransitionAction = 'submit' | 'approve' | 'reject' | 'release' | 'cancel';

export interface EcnSummary {
  id: number;
  ecnNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcnStatus;
  effectivityDate: string | null;
  itemCount: number;
  createdAt: string;
  createdBy: UserRef;
}

export interface EcnItemDetail {
  id: number;
  part: PartRef;
  fromRevision: RevisionRef | null;
  toRevision: RevisionRef | null;
  changeDescription: string | null;
  disposition: EcnDisposition;
}

export type EcnReviewDecision = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface EcnReviewDetail {
  id: number;
  reviewer: UserRef;
  decision: EcnReviewDecision;
  comment: string | null;
  decidedAt: string | null;
}

export interface EcnDetail extends EcnSummary {
  description: string | null;
  reason: string | null;
  /**
   * Unit-based cut-in (rule U6): free text such as "S/N 0042", not a foreign key — the
   * serial is routinely named before the unit exists. Mutually exclusive with
   * `effectivityDate`.
   */
  effectiveFromSerial: string | null;
  approvedBy: UserRef | null;
  approvedAt: string | null;
  releasedAt: string | null;
  items: EcnItemDetail[];
  reviews: EcnReviewDetail[];
}

export interface EcnImpactEntry {
  part: PartRef;
  toRevision: RevisionRef | null;
  usedIn: WhereUsedEntry[];
}

export type Role = 'ADMIN' | 'ENGINEER' | 'VIEWER';

export interface UserSummary {
  id: number;
  name: string;
  email: string;
  role: Role;
  provider: 'LOCAL' | 'GOOGLE';
  createdAt: string;
}

// ---- BOM compare ----

export type BomCompareStatus = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';

export interface BomCompareSide {
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  revision: RevisionRef | null;
  /** Set instead of `revision` when comparing baselines (label snapshot only). */
  revisionLabel?: string | null;
}

export interface BomCompareNode {
  part: PartRef;
  status: BomCompareStatus;
  changedFields: string[];
  left: BomCompareSide | null;
  right: BomCompareSide | null;
  cycle: boolean;
  children: BomCompareNode[];
}

export interface BomCompareEnd {
  revision: RevisionRef;
  part: PartRef;
}

export interface BomCompareResult {
  left: BomCompareEnd;
  right: BomCompareEnd;
  summary: { added: number; removed: number; changed: number; unchanged: number };
  nodes: BomCompareNode[];
}

// ---- Documents ----

export type DocumentCategory =
  | 'DRAWING'
  | 'SPECIFICATION'
  | 'DATASHEET'
  | 'CAD_MODEL'
  | 'IMAGE'
  | 'OTHER';

export type ConversionStatus = 'SKIPPED' | 'PENDING' | 'DONE' | 'FAILED';

export interface DocumentVersionDetail {
  id: number;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: UserRef;
  createdAt: string;
  /** Server-side CAD derivative (STEP/IGES/BREP → glTF) for fast web viewing. */
  conversionStatus: ConversionStatus;
  conversionError: string | null;
  hasGlb: boolean;
  triangleCount: number | null;
  boundingBox: { min: number[]; max: number[]; size: number[] } | null;
}

export interface DocumentSummary {
  id: number;
  docNumber: string;
  title: string;
  category: DocumentCategory;
  description: string | null;
  createdBy: UserRef;
  createdAt: string;
  versionCount: number;
  latestVersion: DocumentVersionDetail | null;
  /**
   * Vault lock (rule D1). Present on the SUMMARY, not just the detail, because rule D3's
   * vault-wide lock column is rendered from the list endpoint — deriving it per row would
   * mean one detail call each.
   */
  lock: DocumentLock | null;
}

export interface DocumentLinkDetail {
  id: number;
  target: { type: 'PART' | 'REVISION' | 'ECN'; id: number; label: string };
}

/**
 * A check-out (rules D1–D2). The lock lives on the **document**, not a version: it reserves
 * the right to produce the next version.
 */
export interface DocumentLock {
  user: UserRef;
  lockedAt: string;
  expiresAt: string | null;
  note: string | null;
  /** The caller holds it. */
  isMine: boolean;
  /** Past expiresAt: anyone may take it. */
  expired: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  /** Newest first. */
  versions: DocumentVersionDetail[];
  links: DocumentLinkDetail[];
  /** null when the document is free; the vault state, so the UI needs no second call. */
  lock: DocumentLock | null;
}

/** A document as listed on a part / revision / ECN. */
export interface EntityDocument {
  linkId: number;
  document: DocumentSummary;
}

// ---- ECR (engineering change requests) ----

export type EcrStatus = 'OPEN' | 'ACCEPTED' | 'REJECTED';

export interface EcrSummary {
  id: number;
  ecrNumber: string;
  title: string;
  priority: EcnPriority;
  status: EcrStatus;
  part: { id: number; partNumber: string; name: string } | null;
  ecn: { id: number; ecnNumber: string } | null;
  createdBy: UserRef;
  createdAt: string;
}

export interface EcrDetail extends EcrSummary {
  description: string | null;
  resolution: string | null;
  resolvedBy: UserRef | null;
  resolvedAt: string | null;
}

// ---- AML (manufacturer parts) ----

export type AmlStatus = 'PREFERRED' | 'APPROVED' | 'ALTERNATE' | 'OBSOLETE';

export interface ManufacturerSummary {
  id: number;
  name: string;
  website: string | null;
}

export interface ManufacturerPartDetail {
  id: number;
  manufacturer: ManufacturerSummary;
  mpn: string;
  status: AmlStatus;
  description: string | null;
}

// ---- Custom attributes ----

export type AttributeType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'LIST';

export interface AttributeDef {
  id: number;
  category: PartCategory;
  name: string;
  label: string;
  type: AttributeType;
  /** Choices for LIST attributes; empty otherwise. */
  options: string[];
  required: boolean;
  sortOrder: number;
}

export interface PartAttribute {
  def: AttributeDef;
  value: string | null;
}

// ---- Baselines ----

export interface BaselineSummary {
  id: number;
  name: string;
  description: string | null;
  part: PartRef;
  revision: RevisionRef;
  lineCount: number;
  createdBy: UserRef;
  createdAt: string;
}

export interface BaselineLineNode {
  part: PartRef;
  revisionLabel: string;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  children: BaselineLineNode[];
}

export interface BaselineDetail extends BaselineSummary {
  nodes: BaselineLineNode[];
}

export interface BaselineCompareResult {
  left: BaselineSummary;
  right: BaselineSummary;
  summary: { added: number; removed: number; changed: number; unchanged: number };
  nodes: BomCompareNode[];
}

// ---- Cost roll-up ----

export interface CostRollupNode {
  part: PartRef;
  quantity: number;
  unitCost: number | null;
  /** unitCost when set, else the sum of children's extended costs (null if unknowable). */
  effectiveUnitCost: number | null;
  extendedCost: number | null;
  missing: boolean;
  children: CostRollupNode[];
}

export interface CostRollup {
  revision: RevisionRef;
  part: PartRef;
  totalCost: number | null;
  /** Part numbers with unknown cost anywhere in the structure. */
  missingCosts: string[];
  nodes: CostRollupNode[];
}

// ---- Audit trail ----

export interface AuditEntry {
  id: number;
  user: UserRef | null;
  method: string;
  path: string;
  entityType: string | null;
  entityId: number | null;
  summary: string;
  details: unknown;
  createdAt: string;
}

export interface BomLineAlternateDetail {
  id: number;
  part: PartRef;
  note: string | null;
}

export interface BomLineDetail {
  id: number;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  alternates: BomLineAlternateDetail[];
  childPart: PartRef;
  resolvedRevision: RevisionRef | null;
}

export interface BomTreeNode {
  line: {
    id: number;
    findNumber: number;
    quantity: number;
    uom: string;
    refDesignators: string | null;
    notes: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    alternates: BomLineAlternateDetail[];
  };
  part: PartRef;
  revision: RevisionRef | null;
  unreleased: boolean;
  cycle: boolean;
  children: BomTreeNode[];
}

export interface WhereUsedEntry {
  line: { id: number; findNumber: number; quantity: number; uom: string };
  parentRevision: RevisionRef;
  parentPart: { id: number; partNumber: string; name: string };
}

export interface OperationMaterialDetail {
  id: number;
  quantity: number;
  uom: string;
  notes: string | null;
  /** Expected process loss as a fraction: 0.02 = 2 %. */
  scrapFactor: number;
  /** Adhesive, solder, thread-lock — legitimately absent from the eBOM. */
  consumable: boolean;
  part: PartRef;
}

export interface OperationDetail {
  id: number;
  seq: number;
  name: string;
  workCenter: string | null;
  description: string | null;
  setupMinutes: number;
  runMinutes: number;
  materials: OperationMaterialDetail[];
}

export interface ProcessPlanDetail {
  id: number;
  name: string;
  description: string | null;
  operations: OperationDetail[];
}

// ---- CAD assembly → eBOM (rules C1–C3) ----

export interface CadAssemblyNode {
  name: string;
  instances: number;
  match: { part: PartRef; by: 'PART_NUMBER' | 'NAME' } | null;
  children: CadAssemblyNode[];
}

export interface CadAssembly {
  status: 'DONE' | 'SKIPPED' | 'FAILED';
  /** Why it was skipped or how it failed; null when DONE. */
  reason: string | null;
  root: CadAssemblyNode | null;
  nodeCount: number;
  maxDepth: number;
  /** When the snapshot was taken; null when there is no snapshot at all. */
  extractedAt: string | null;
  rootName: string | null;
}

export type CadBomChange = 'ADD' | 'REMOVE' | 'QTY_CHANGE' | 'UNCHANGED' | 'UNMATCHED';

export interface CadBomProposalLine {
  change: CadBomChange;
  cadName: string | null;
  part: PartRef | null;
  cadQuantity: number | null;
  bomQuantity: number | null;
  bomLineId: number | null;
  matchedBy: 'PART_NUMBER' | 'NAME' | null;
}

export interface CadBomCounts {
  add: number;
  remove: number;
  qtyChange: number;
  unchanged: number;
  unmatched: number;
}

/** One imported level: the top assembly, plus one per sub-assembly when recursive. */
export interface CadBomLevel {
  assemblyName: string;
  /** The part whose eBOM this level writes; null for the revision's own part. */
  part: PartRef | null;
  revision: RevisionRef;
  lines: CadBomProposalLine[];
  counts: CadBomCounts;
}

export interface CadBomProposal {
  documentVersion: { id: number; version: number; fileName: string };
  revision: RevisionRef;
  assemblyName: string;
  applied: boolean;
  removedMissing: boolean;
  recursive: boolean;
  /** CAD nodes below the imported level — they belong to the child parts' own BOMs. */
  deeperNodeCount: number;
  /** The top level, kept at the root so a one-level import reads as it always did. */
  lines: CadBomProposalLine[];
  counts: CadBomCounts;
  levels: CadBomLevel[];
  /** Sub-assemblies the recursion could not write, with why — never fatal. */
  skippedAssemblies: { cadName: string; part: PartRef | null; reason: string }[];
  totals: CadBomCounts;
}

// ---- cBOM ↔ eBOM reconciliation (rule C2a) ----

export type CbomReconStatus =
  | 'MATCH'
  | 'QTY_MISMATCH'
  | 'MISSING_IN_EBOM'
  | 'EXTRA_IN_EBOM'
  | 'UNMATCHED';

export interface CbomReconciliationRow {
  part: PartRef | null;
  cadName: string | null;
  status: CbomReconStatus;
  cadQuantity: number | null;
  ebomQuantity: number | null;
}

export interface CbomReconciliation {
  revision: RevisionRef;
  documentVersion: { id: number; version: number; fileName: string };
  assemblyStatus: 'DONE' | 'SKIPPED' | 'FAILED';
  assemblyReason: string | null;
  assemblyName: string | null;
  extractedAt: string | null;
  rows: CbomReconciliationRow[];
  counts: {
    match: number;
    qtyMismatch: number;
    missingInEbom: number;
    extraInEbom: number;
    unmatched: number;
  };
}

// ---- cBOM version diff (rule C2b) ----

export type CadDiffChange = 'ADDED' | 'REMOVED' | 'QTY_CHANGED' | 'UNCHANGED';

export interface CadStructureDiffRow {
  /** Occurrence path relative to the assembly root, e.g. `BATTERY-PACK/CELL-18650`. */
  path: string;
  name: string;
  change: CadDiffChange;
  fromQuantity: number | null;
  toQuantity: number | null;
}

export interface CadStructureDiff {
  from: { id: number; version: number; fileName: string; docNumber: string; rootName: string | null };
  to: { id: number; version: number; fileName: string; docNumber: string; rootName: string | null };
  sameDocument: boolean;
  rootRenamed: boolean;
  rows: CadStructureDiffRow[];
  counts: { added: number; removed: number; qtyChanged: number; unchanged: number };
}

// ---- eBOM ↔ mBOM reconciliation (rule C5) ----

export type ReconStatus =
  | 'MATCH'
  | 'QTY_MISMATCH'
  | 'MISSING_IN_MBOM'
  | 'EXTRA_IN_MBOM'
  | 'CONSUMABLE_ONLY';

export interface BomReconciliationRow {
  part: PartRef;
  status: ReconStatus;
  ebomQuantity: number | null;
  /** Σ quantity — the figure the status compares against the eBOM. */
  mbomNominalQuantity: number | null;
  /** Σ quantity × (1 + scrap) — what the floor actually draws. */
  mbomQuantity: number | null;
  consumedBy: {
    operationId: number;
    seq: number;
    name: string;
    quantity: number;
    scrapFactor: number;
    consumable: boolean;
  }[];
  consumable: boolean;
}

export interface BomReconciliation {
  revision: RevisionRef;
  hasPlan: boolean;
  rows: BomReconciliationRow[];
  counts: {
    match: number;
    qtyMismatch: number;
    missingInMbom: number;
    extraInMbom: number;
    consumableOnly: number;
  };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardStats {
  parts: number;
  plans: number;
  users: number;
  /** ECNs in DRAFT, IN_REVIEW or APPROVED. */
  openEcns: number;
  revisionsByLifecycle: Record<Lifecycle, number>;
  recentParts: PartSummary[];
  /** 5 newest ECNs, any status. */
  recentEcns: EcnSummary[];
  myInWork: {
    id: number;
    revision: string;
    lifecycle: Lifecycle;
    createdAt: string;
    part: { id: number; partNumber: string; name: string };
  }[];
}

export interface AuthProviders {
  google: boolean;
}

// ---- notifications ----

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationItem[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
}

// ---- requirements & traceability ----

export type RequirementType =
  | 'FUNCTIONAL'
  | 'PERFORMANCE'
  | 'SAFETY'
  | 'REGULATORY'
  | 'INTERFACE';
export type RequirementStatus = 'DRAFT' | 'APPROVED' | 'OBSOLETE';

export interface RequirementSummary {
  id: number;
  reqNumber: string;
  title: string;
  type: RequirementType;
  priority: EcnPriority;
  status: RequirementStatus;
  parentId: number | null;
  linkedParts: number;
  linkedDocuments: number;
  childCount: number;
  createdAt: string;
  createdBy: UserRef;
}

export interface RequirementLinkDetail {
  id: number;
  part: PartRef | null;
  document: { id: number; docNumber: string; title: string } | null;
}

export interface RequirementDetail extends RequirementSummary {
  statement: string;
  rationale: string | null;
  acceptance: string | null;
  parent: { id: number; reqNumber: string; title: string } | null;
  children: RequirementSummary[];
  links: RequirementLinkDetail[];
}

export interface RequirementMatrixRow {
  requirement: RequirementSummary;
  parts: PartRef[];
  documents: number;
}

export interface RequirementMatrix {
  totals: { total: number; approved: number; covered: number; uncovered: number };
  rows: RequirementMatrixRow[];
}

/**
 * The outcome of a ReqIF import.
 *
 * `unknownAttributesDropped` is the one that matters and the one a caller is most likely to drop on
 * the floor. A ReqIF file from DOORS or Polarion carries whatever attributes that tool's
 * template defined — verification method, allocation, obligation, a dozen customer-specific
 * columns — and this data model has a home for only a few of them. The rest cannot be stored,
 * so they are counted and discarded. Showing `created` and `updated` while quietly swallowing
 * that count would tell someone their requirements imported cleanly when a third of each one's
 * content did not arrive, which they would discover much later and much more expensively.
 * Every caller must surface it.
 */
export interface ReqifImportResult {
  created: number;
  updated: number;
  /** Requirements in the file that the server chose not to write. */
  skipped: number;
  unknownAttributesDropped: number;
  /**
   * Links in the file that pointed at parts or documents and could not be applied.
   *
   * Surfaced for the same reason as the attribute count, and it is the easier one to forget
   * because the requirements themselves all arrived: a file whose every link was dropped would
   * otherwise report total success. A silent drop is discovered weeks later, by which time
   * nobody connects it to the import.
   */
  linksIgnored: number;
}

// ---- workflow engine ----

export type WorkflowRule = 'ANY' | 'ALL';
export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
export type TaskDecision = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export interface WorkflowStepDefDetail {
  id: number;
  seq: number;
  name: string;
  rule: WorkflowRule;
  role: string | null;
  assignees: UserRef[];
}

export interface WorkflowTemplateDetail {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  instanceCount: number;
  steps: WorkflowStepDefDetail[];
}

export interface WorkflowTaskDetail {
  id: number;
  seq: number;
  stepName: string;
  rule: WorkflowRule;
  user: UserRef;
  decision: TaskDecision;
  comment: string | null;
  decidedAt: string | null;
}

export interface EcnWorkflowDetail {
  id: number;
  templateName: string;
  status: WorkflowStatus;
  currentSeq: number;
  createdAt: string;
  completedAt: string | null;
  tasks: WorkflowTaskDetail[];
}

// ---- email ----

export interface EmailStatus {
  configured: boolean;
  host: string | null;
  from: string | null;
}

// ---- integration: API keys & webhooks ----

export interface ApiKeySummary {
  id: number;
  name: string;
  prefix: string;
  scopes: 'read' | 'write';
  createdBy: UserRef;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned once, on creation only — the full key is never retrievable again. */
export interface ApiKeyCreated extends ApiKeySummary {
  key: string;
}

export type WebhookDeliveryStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface WebhookDeliveryItem {
  id: number;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookSummary {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdBy: UserRef;
  createdAt: string;
  recentDeliveries: WebhookDeliveryItem[];
}

/** Returned once, on creation only. */
export interface WebhookCreated extends WebhookSummary {
  secret: string;
}

// ---- ERP exchange ----

export interface ImportIssue {
  row: number;
  message: string;
}

export interface ImportResult {
  dryRun: boolean;
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  issues: ImportIssue[];
}

// ---- variants & configuration ----

export interface OptionValueDetail {
  id: number;
  code: string;
  name: string;
  isDefault: boolean;
  /** BOM lines conditioned on this value, within the resolved revision. */
  lineCount: number;
}

export interface OptionGroupDetail {
  id: number;
  code: string;
  name: string;
  description: string | null;
  required: boolean;
  multiSelect: boolean;
  values: OptionValueDetail[];
}

export interface VariantBomLine {
  lineId: number;
  findNumber: number;
  part: PartRef;
  revision: RevisionRef | null;
  quantity: number;
  uom: string;
  /** Option value codes that caused this line to be included; empty = always. */
  conditions: string[];
}

export interface VariantResolution {
  part: PartRef;
  revision: RevisionRef;
  selections: { groupCode: string; valueCodes: string[] }[];
  included: VariantBomLine[];
  excluded: VariantBomLine[];
  unconditionalCount: number;
}

// ---- analytics ----

export interface AnalyticsKpis {
  changeCycle: {
    releasedLast90: number;
    avgDraftToReleaseDays: number | null;
    avgReviewDays: number | null;
    openByStatus: Record<EcnStatus, number>;
  };
  bomHealth: {
    partsTotal: number;
    partsNeverReleased: number;
    partsMissingCost: number;
    revisionsInWork: number;
    releasedWithUnreleasedChildren: number;
  };
  requirements: { total: number; covered: number; approved: number };
  throughput: { month: string; created: number; released: number }[];
  topCostDrivers: { part: PartRef; rolledCost: number }[];
}

// ---- quality: nonconformance & CAPA ----

export type NcrStatus = 'OPEN' | 'CONTAINED' | 'CLOSED';
export type NcrSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type CapaStatus = 'OPEN' | 'IN_PROGRESS' | 'VERIFIED' | 'CLOSED';

export interface NcrSummary {
  id: number;
  ncrNumber: string;
  title: string;
  severity: NcrSeverity;
  status: NcrStatus;
  disposition: EcnDisposition | null;
  part: PartRef | null;
  createdBy: UserRef;
  createdAt: string;
  capa: { id: number; capaNumber: string } | null;
}

export interface NcrDetail extends NcrSummary {
  description: string;
  quantityAffected: number | null;
  lotOrSerial: string | null;
  /**
   * The tracked unit this NCR is against (rule U7). `lotOrSerial` stays populated and
   * untouched for records that predate a tracked unit — the two are independent.
   */
  buildUnit: BuildUnitRef | null;
  partRevision: RevisionRef | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
  closedBy: UserRef | null;
  closedAt: string | null;
}

export interface CapaSummary {
  id: number;
  capaNumber: string;
  title: string;
  status: CapaStatus;
  owner: UserRef;
  dueDate: string | null;
  ncrCount: number;
  createdAt: string;
}

export interface CapaDetail extends CapaSummary {
  problem: string;
  rootCause: string | null;
  containment: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  createdBy: UserRef;
  nonconformances: NcrSummary[];
}

// ---- phase-gate projects ----

export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type GateStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'PASSED' | 'BLOCKED';
export type DeliverableStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETE' | 'WAIVED';

export interface DeliverableDetail {
  id: number;
  name: string;
  status: DeliverableStatus;
  required: boolean;
  owner: UserRef | null;
  dueDate: string | null;
  notes: string | null;
  part: PartRef | null;
  document: { id: number; docNumber: string; title: string } | null;
  requirement: { id: number; reqNumber: string; title: string } | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
}

export interface PhaseDetail {
  id: number;
  seq: number;
  name: string;
  gateCriteria: string | null;
  status: GateStatus;
  targetDate: string | null;
  passedAt: string | null;
  passedBy: UserRef | null;
  deliverables: DeliverableDetail[];
  /** Required deliverables that are neither COMPLETE nor WAIVED. */
  blockingCount: number;
}

export interface ProjectSummary {
  id: number;
  code: string;
  name: string;
  status: ProjectStatus;
  owner: UserRef;
  startDate: string | null;
  targetDate: string | null;
  phaseCount: number;
  passedPhases: number;
  currentPhase: { id: number; seq: number; name: string; status: GateStatus } | null;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  createdBy: UserRef;
  phases: PhaseDetail[];
}

// ---- supplier RFQ ----

export type RfqStatus = 'DRAFT' | 'SENT' | 'CLOSED' | 'AWARDED' | 'CANCELLED';

export interface SupplierSummary {
  id: number;
  code: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  active: boolean;
  quoteCount: number;
}

export interface RfqQuoteDetail {
  id: number;
  supplier: { id: number; code: string; name: string };
  unitPrice: number;
  currency: string;
  leadTimeDays: number | null;
  moq: number | null;
  notes: string | null;
  extendedPrice: number;
  /** True when this is the lowest unit price quoted on its line. */
  isLowest: boolean;
  createdAt: string;
}

export interface RfqLineDetail {
  id: number;
  part: PartRef;
  quantity: number;
  targetPrice: number | null;
  notes: string | null;
  awardedSupplier: { id: number; code: string; name: string } | null;
  awardedAt: string | null;
  quotes: RfqQuoteDetail[];
}

export interface RfqSummary {
  id: number;
  rfqNumber: string;
  title: string;
  status: RfqStatus;
  dueDate: string | null;
  lineCount: number;
  quoteCount: number;
  createdBy: UserRef;
  createdAt: string;
}

export interface RfqDetail extends RfqSummary {
  description: string | null;
  sentAt: string | null;
  closedAt: string | null;
  lines: RfqLineDetail[];
}

// ---- global search ----

export interface SearchHit {
  id: number;
  label: string;
  sublabel: string | null;
  route: string;
}

export interface SearchResults {
  parts: SearchHit[];
  documents: SearchHit[];
  ecns: SearchHit[];
  ecrs: SearchHit[];
  manufacturers: SearchHit[];
  requirements: SearchHit[];
}

// ---- my work ----

export interface MyWorkReviewEntry {
  reviewId: number;
  ecn: { id: number; ecnNumber: string; title: string; status: EcnStatus };
  decision: EcnReviewDecision;
  createdAt: string;
}

export interface MyWork {
  pendingReviews: MyWorkReviewEntry[];
  pendingTasks: {
    taskId: number;
    stepName: string;
    ecn: { id: number; ecnNumber: string; title: string };
    createdAt: string;
  }[];
  inWorkRevisions: {
    id: number;
    revision: string;
    createdAt: string;
    ecn: { id: number; ecnNumber: string } | null;
    part: { id: number; partNumber: string; name: string };
  }[];
  openEcrs: EcrSummary[];
  activeEcns: EcnSummary[];
}

// ---- Electronic signatures (rules S1–S4) ----

export type SignedEntityType = 'ECN' | 'REVISION' | 'DOCUMENT';
export type SignatureMeaning = 'AUTHORED' | 'REVIEWED' | 'APPROVED' | 'QA_APPROVED';
export type SignatureStatus = 'VALID' | 'VOIDED';
/** How the signer re-authenticated: a password, or retyping their address (SSO accounts). */
export type SignatureAuthMethod = 'PASSWORD' | 'EMAIL_CONFIRM';

export interface SignatureRequirement {
  id: number;
  entityType: SignedEntityType;
  meaning: SignatureMeaning;
  seq: number;
  /** Exactly one of role / user identifies who may sign. */
  role: Role | null;
  user: UserRef | null;
  active: boolean;
}

export interface ElectronicSignature {
  id: number;
  meaning: SignatureMeaning;
  user: UserRef;
  /** Name and role captured at signing time, so the record stands alone. */
  signedName: string;
  signedRole: string;
  signedAt: string;
  authMethod: SignatureAuthMethod;
  status: SignatureStatus;
  voidedAt: string | null;
  voidedReason: string | null;
  comment: string | null;
}

export interface SignatureManifestEntry {
  requirement: SignatureRequirement;
  signature: ElectronicSignature | null;
  /** Whether the current user may execute this requirement right now. */
  canSign: boolean;
}

export interface SignatureManifest {
  entityType: SignedEntityType;
  entityId: number;
  label: string;
  contentHash: string;
  entries: SignatureManifestEntry[];
  complete: boolean;
  outstanding: SignatureMeaning[];
  /** Every signature ever executed here, newest first, including voided ones. */
  history: ElectronicSignature[];
}

// ---- Supplier portal (rules P1–P4) ----

export interface SupplierUserAccount {
  id: number;
  email: string;
  name: string;
  active: boolean;
  /** True once the invitation has been accepted and a password set. */
  accepted: boolean;
  invitePending: boolean;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
}

/** Only the create/reset responses carry the link; no later read exposes it. */
export interface SupplierUserWithInvite extends SupplierUserAccount {
  inviteUrl: string;
}

export interface RfqInvitation {
  id: number;
  supplier: { id: number; code: string; name: string };
  invitedBy: UserRef;
  invitedAt: string;
  respondedAt: string | null;
  activeAccounts: number;
}

export interface PortalIdentity {
  id: number;
  email: string;
  name: string;
  supplier: { id: number; name: string; code: string };
}

export interface PortalRfqSummary {
  id: number;
  rfqNumber: string;
  title: string;
  status: RfqStatus;
  dueDate: string | null;
  sentAt: string | null;
  closedAt: string | null;
  lineCount: number;
  /** Lines this supplier has quoted — never the total received. */
  myQuoteCount: number;
  respondedAt: string | null;
}

export interface PortalQuote {
  id: number;
  unitPrice: number;
  currency: string;
  leadTimeDays: number | null;
  moq: number | null;
  notes: string | null;
  extendedPrice: number;
  createdAt: string;
}

export interface PortalRfqLine {
  id: number;
  part: { partNumber: string; name: string; uom: string };
  quantity: number;
  notes: string | null;
  awarded: boolean;
  /** A line awarded to a competitor names nobody. */
  awardedToMe: boolean;
  myQuote: PortalQuote | null;
}

export interface PortalRfqDetail {
  id: number;
  rfqNumber: string;
  title: string;
  description: string | null;
  status: RfqStatus;
  dueDate: string | null;
  sentAt: string | null;
  closedAt: string | null;
  open: boolean;
  lines: PortalRfqLine[];
}

// ---- Serial / lot tracking and as-built records (rules U1–U7) ----
//
// These mirror the DTOs in backend/src/routes/units.ts and traceability.ts field for field.
// An earlier version of this block was written independently of the routers and diverged on
// almost every name; the shapes below were taken from the wire, not guessed.

/** A serialized unit is quantity 1 with a unique serial; a lot is quantity N under one code. */
export type BuildKind = 'SERIAL' | 'LOT';
export type BuildStatus = 'IN_PROGRESS' | 'COMPLETED' | 'SCRAPPED' | 'SHIPPED';
export type BuildUnitTransitionAction = 'complete' | 'ship' | 'scrap' | 'reopen';

/** Identity of a build unit as referenced from another record; its part is nested. */
export interface BuildUnitRef {
  id: number;
  kind: BuildKind;
  identifier: string;
  status: BuildStatus;
  quantity: number;
  part: PartRef;
}

export interface BuildUnitSummary {
  id: number;
  kind: BuildKind;
  identifier: string;
  part: PartRef;
  /** The revision it was built to — the baseline the deviation report compares against. */
  partRevision: RevisionRef;
  quantity: number;
  status: BuildStatus;
  builtAt: string | null;
  shippedAt: string | null;
  createdBy: UserRef;
  createdAt: string;
}

/** One consumption event: `quantity` of `child` went into the parent unit. */
export interface AsBuiltLine {
  id: number;
  parentId: number;
  child: BuildUnitRef;
  quantity: number;
  /**
   * The eBOM line this satisfies; null records an unplanned consumption. `childPart` is the
   * part that line *planned* — compare it with `child.part` to see a substitution.
   */
  bomLine: { id: number; findNumber: number; quantity: number; childPart: PartRef } | null;
  /** Computed at record time, never supplied: the child's part differs from the BOM line's. */
  substitution: boolean;
  recordedBy: UserRef;
  recordedAt: string;
}

/** The other end of an as-built line: a parent this unit was consumed by. */
export interface AsBuiltUsage {
  id: number;
  parent: BuildUnitRef;
  quantity: number;
}

/** Trimmed NCR shape the unit endpoints return, not the full `NcrSummary`. */
export interface BuildUnitNcr {
  id: number;
  ncrNumber: string;
  title: string;
  severity: NcrSeverity;
  status: NcrStatus;
  disposition: EcnDisposition | null;
  createdAt: string;
}

export interface BuildUnitDetail extends BuildUnitSummary {
  notes: string | null;
  updatedAt: string;
  asBuiltLines: AsBuiltLine[];
  /** A SERIAL unit has at most one parent; a LOT may be split across several. */
  consumedBy: AsBuiltUsage[];
  nonconformances: BuildUnitNcr[];
}

/**
 * Backward trace — what went into a unit. The response IS the root node, not a wrapper, and
 * the root describes no consumption, so its `asBuiltLineId` and `quantity` are null.
 */
export interface GenealogyNode {
  unit: BuildUnitRef;
  /** The as-built line that consumed this unit into its parent; null on the root. */
  asBuiltLineId: number | null;
  quantity: number | null;
  substitution: boolean;
  hasOpenNonconformances: boolean;
  openNonconformanceCount: number;
  /** Consumed something, but the depth cap or node budget stopped the walk. */
  truncated: boolean;
  /** Defensive: writes reject cycles, but a read must not hang if one ever exists. */
  cycle: boolean;
  children: GenealogyNode[];
}

/** One hop on the path from the queried unit up to an ancestor. */
export interface WhereConsumedStep {
  unit: BuildUnitRef;
  quantity: number;
  asBuiltLineId: number;
}

/**
 * Forward trace is returned FLAT, not as a tree: one entry per ancestor, each carrying the
 * `path` back to the queried unit. A unit reachable by two routes appears once.
 */
export interface WhereConsumedEntry {
  unit: BuildUnitRef;
  /** Hops from the queried unit; 1 is a direct parent. */
  depth: number;
  /** Nothing consumes this unit — the boundary of the recall. */
  topLevel: boolean;
  /** At the depth cap: it may itself sit inside something outside this trace. */
  truncated: boolean;
  hasOpenNonconformances: boolean;
  openNonconformanceCount: number;
  /** Queried unit → … → this unit, nearest hop first; `path.length === depth`. */
  path: WhereConsumedStep[];
}

export interface WhereConsumedResult {
  /** The unit the question was asked about — the suspect lot or serial. */
  unit: BuildUnitRef;
  units: WhereConsumedEntry[];
  /** The subset a human has to act on: these left the building. */
  shippedUnits: WhereConsumedEntry[];
  /** The subset nothing else consumes — still recallable in house. */
  topLevelUnits: WhereConsumedEntry[];
  truncated: boolean;
  counts: {
    total: number;
    shipped: number;
    completed: number;
    inProgress: number;
    scrapped: number;
    topLevel: number;
  };
}

/** `SUBSTITUTED` is an approved alternate, reported distinctly and not as a defect. */
export type DeviationStatus =
  | 'MATCH'
  | 'QTY_MISMATCH'
  | 'MISSING'
  | 'UNPLANNED'
  | 'SUBSTITUTED';

export interface DeviationConsumed {
  asBuiltLineId: number;
  unit: BuildUnitRef;
  quantity: number;
}

export interface DeviationRow {
  /** The part actually consumed; the eBOM part when `MISSING`. */
  part: PartRef;
  status: DeviationStatus;
  bomLine: { id: number; findNumber: number; quantity: number; uom: string } | null;
  /** eBOM line quantity × the unit's build quantity — what the whole build should draw. */
  plannedQuantity: number | null;
  builtQuantity: number | null;
  consumed: DeviationConsumed[];
  /** Approved alternates used in place of `part`: the evidence behind SUBSTITUTED. */
  substitutes: { part: PartRef; quantity: number }[];
  /**
   * Set when this part was recorded against a BOM line it is not an approved alternate of:
   * the part that line planned, so the two defect rows can be read together.
   */
  unapprovedSubstitutionFor: PartRef | null;
}

export interface DeviationReport {
  unit: BuildUnitRef;
  /** eBOM quantities are per assembly, so a lot of N is expected to draw N × the line. */
  buildQuantity: number;
  hasEbom: boolean;
  /** Severity first, then partNumber — the same ordering as the eBOM↔mBOM view. */
  rows: DeviationRow[];
  counts: {
    match: number;
    qtyMismatch: number;
    missing: number;
    unplanned: number;
    substituted: number;
  };
}

// ---- vendor catalog import (rules V1–V5) ----
//
// Transcribed field for field from the frozen wire contract in backend/src/routes/catalog.ts.
// Nothing here is flattened or renamed for convenience: a divergence in this block is a
// runtime crash the compiler cannot see, which is how this file has broken before.

export type CatalogFormat = 'CSV' | 'XLSX' | 'BMECAT_XML';
export type CatalogImportStatus =
  | 'DRAFT'
  | 'VALIDATED'
  /** Claimed by a commit in flight — the state that stops two commits writing the same rows. */
  | 'COMMITTING'
  | 'COMMITTED'
  | 'FAILED'
  | 'CANCELLED';
export type CatalogRowStatus =
  | 'NEW'
  | 'UPDATE'
  | 'DUPLICATE'
  | 'INVALID'
  | 'SKIPPED'
  | 'COMMITTED';

/** The mappable target fields. Exactly these keys, nothing else. */
export type CatalogTargetField =
  | 'partNumber'
  | 'name'
  | 'description'
  | 'category'
  | 'uom'
  | 'unitCost'
  | 'manufacturerName'
  | 'mpn'
  | 'distributorName'
  | 'distributorPartNumber';

export interface CatalogMapping {
  id: number;
  name: string;
  vendor: string | null;
  format: CatalogFormat;
  /** target field -> source column name. Partial: unmapped targets are absent. */
  fieldMap: Partial<Record<CatalogTargetField, string>>;
  /** Literal values for fields the file does not carry, e.g. { category: 'PURCHASED' }. */
  defaults: Partial<Record<CatalogTargetField, string>> | null;
  headerSignature: string[];
  builtIn: boolean;
  createdBy: UserRef | null;
  createdAt: string;
}

export interface CatalogImportCounts {
  rows: number;
  new: number;
  update: number;
  duplicate: number;
  invalid: number;
  skipped: number;
  committed: number;
  failed: number;
}

export interface CatalogImportSummary {
  id: number;
  fileName: string;
  format: CatalogFormat;
  status: CatalogImportStatus;
  detectedVendor: string | null;
  mapping: { id: number; name: string } | null;
  counts: CatalogImportCounts;
  error: string | null;
  createdBy: UserRef;
  createdAt: string;
  validatedAt: string | null;
  committedAt: string | null;
}

export interface CatalogImportDetail extends CatalogImportSummary {
  /** Source column names in file order — what the mapping UI offers. */
  sourceColumns: string[];
  /** Built-in preset whose headerSignature matched, if any. */
  suggestedMappingId: number | null;
  /** First 5 source rows verbatim, so the user can see what they are mapping. */
  sampleRows: Record<string, string>[];
}

export interface CatalogMappedRow {
  partNumber: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  uom: string | null;
  unitCost: number | null;
  manufacturerName: string | null;
  mpn: string | null;
  distributorName: string | null;
  distributorPartNumber: string | null;
}

export interface CatalogImportRow {
  id: number;
  lineNumber: number;
  status: CatalogRowStatus;
  message: string | null;
  raw: Record<string, string>;
  /** null until the import has been validated. */
  mapped: CatalogMappedRow | null;
  /** Set on commit. */
  part: { id: number; partNumber: string; name: string } | null;
  manufacturerPart: { id: number; mpn: string; manufacturer: string } | null;
}

// ---- design review markup (rules K1–K4) ----
//
// Transcribed field for field from the frozen wire contract. A markup anchors to a
// DocumentVersion, never to a document: a comment about geometry is about *that* geometry.

export type MarkupKind = 'PIN_3D' | 'BOX_2D' | 'POINT_2D' | 'NOTE';
export type MarkupStatus = 'OPEN' | 'RESOLVED' | 'WONT_FIX';
export type MarkupTransition = 'resolve' | 'wont-fix' | 'reopen';

export interface MarkupComment {
  id: number;
  body: string;
  createdBy: UserRef;
  createdAt: string;
}

export interface MarkupDetail {
  id: number;
  documentVersionId: number;
  kind: MarkupKind;
  /** Shape depends on kind; see rule K1. Normalized 0-1 for 2D. */
  geometry: Record<string, unknown>;
  status: MarkupStatus;
  createdBy: UserRef;
  createdAt: string;
  resolvedBy: UserRef | null;
  resolvedAt: string | null;
  ecr: { id: number; ecrNumber: string; status: EcrStatus } | null;
  comments: MarkupComment[];
}

// ---- service and as-maintained records (rules G1–G4) ----
//
// These extend the serial/lot block above rather than duplicating it: a service record hangs
// off the existing `BuildUnitRef`, and the as-maintained view reuses `GenealogyNode` verbatim.

export type ServiceKind =
  | 'REPAIR'
  | 'UPGRADE'
  | 'INSPECTION'
  | 'WARRANTY_CLAIM'
  | 'DECOMMISSION';
export type ServiceStatus = 'OPEN' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';
export type ServiceTransition = 'start' | 'close' | 'cancel' | 'reopen';

/** One swap event: at least one of removed / installed is always set (rule G2). */
export interface ServicePartSwap {
  id: number;
  removedUnit: BuildUnitRef | null;
  installedUnit: BuildUnitRef | null;
  position: string | null;
  reason: string;
  /**
   * Whether the removed unit was written off. Explicit on the request, never inferred from
   * `reason` — inferring it from prose scrapped working hardware on "no fault found".
   */
  scrapRemoved: boolean;
  performedBy: UserRef;
  performedAt: string;
}

export interface ServiceRecordSummary {
  id: number;
  serviceNumber: string;
  buildUnit: BuildUnitRef;
  kind: ServiceKind;
  status: ServiceStatus;
  title: string;
  reportedAt: string;
  closedAt: string | null;
  technician: UserRef | null;
  swapCount: number;
  createdBy: UserRef;
  createdAt: string;
}

export interface ServiceRecordDetail extends ServiceRecordSummary {
  description: string | null;
  ncr: { id: number; ncrNumber: string; status: NcrStatus } | null;
  ecn: { id: number; ecnNumber: string; status: EcnStatus } | null;
  swaps: ServicePartSwap[];
}

/** A swap seen from the unit's side: the same event, carrying the record it belongs to. */
export interface AsMaintainedChange {
  swapId: number;
  serviceRecord: { id: number; serviceNumber: string; kind: ServiceKind; title: string };
  removedUnit: BuildUnitRef | null;
  installedUnit: BuildUnitRef | null;
  position: string | null;
  reason: string;
  performedBy: UserRef;
  performedAt: string;
}

export interface AsMaintained {
  unit: BuildUnitRef;
  /** Current genealogy — the SAME GenealogyNode shape /genealogy already returns. */
  current: GenealogyNode;
  /** Newest first. */
  changes: AsMaintainedChange[];
}

// ---------------------------------------------------------------------------
// Item-level access control (rules X1-X7)
// ---------------------------------------------------------------------------

/**
 * The redacted stand-in the backend substitutes for any reference the caller may not read
 * (rule X4). Wherever a `PartRef`-like field can be redacted, `partNumber` and `name` arrive
 * as "Restricted" and `id` as null — render the strings and do not link.
 */
export interface RedactedRef {
  redacted: true;
  id: null;
  partNumber: 'Restricted';
  name: 'Restricted';
}

export type AclEntityType = 'PART' | 'DOCUMENT' | 'ECN' | 'PROJECT' | 'BUILD_UNIT';
export type AclPermission = 'READ' | 'WRITE';

/** URL segment for `/:entityType/:id/access`, keyed by type. */
export const ACL_SEGMENTS: Record<AclEntityType, string> = {
  PART: 'parts',
  DOCUMENT: 'documents',
  ECN: 'ecns',
  PROJECT: 'projects',
  BUILD_UNIT: 'build-units',
};

export interface ItemGrant {
  id: number;
  group: { id: number; name: string } | null;
  user: UserRef | null;
  permission: AclPermission;
  grantedBy: UserRef;
  grantedAt: string;
}

export interface ItemAccess {
  entityType: AclEntityType;
  entityId: number;
  /** False = no grants at all: the item is open to everyone the role rules allow (rule X1). */
  restricted: boolean;
  grants: ItemGrant[];
  /** WRITE on the item, or global ADMIN. */
  canManage: boolean;
}

export interface AccessGroupSummary {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  memberCount: number;
  /** Total grants this group holds across all five types — the delete guard. */
  grantCount: number;
  createdAt: string;
}

export interface AccessGroupDetail extends AccessGroupSummary {
  members: { id: number; user: UserRef; addedAt: string }[];
}

// ---------------------------------------------------------------------------
// Materials (rules N2-N3)
// ---------------------------------------------------------------------------

export type MaterialClass = 'METAL' | 'POLYMER' | 'COMPOSITE' | 'CERAMIC' | 'ELASTOMER' | 'OTHER';
export type MaterialForm =
  | 'SHEET'
  | 'PLATE'
  | 'BAR'
  | 'ROD'
  | 'TUBE'
  | 'PROFILE'
  | 'CASTING'
  | 'FORGING'
  | 'POWDER'
  | 'LIQUID'
  | 'OTHER';

export interface MaterialSummary {
  id: number;
  code: string;
  name: string;
  materialClass: MaterialClass;
  specification: string | null;
  density: number | null;
  stockUom: string;
  unitCost: number | null;
  active: boolean;
  /** How many parts declare this material — the guard against deleting one in use. */
  partCount: number;
  createdAt: string;
}

export interface MaterialDetail extends MaterialSummary {
  notes: string | null;
  updatedAt: string;
}

export interface PartMaterial {
  id: number;
  material: MaterialSummary;
  form: MaterialForm;
  netQuantity: number;
  scrapFactor: number;
  /** net x (1 + scrapFactor), rounded — what is actually drawn from stock. */
  grossQuantity: number;
  stockSize: string | null;
  notes: string | null;
}

export interface RequirementContributor {
  part: PartRef | RedactedRef;
  perAssembly: number;
  totalParts: number;
  netQuantity: number;
  grossQuantity: number;
}

export interface MaterialRequirement {
  material: MaterialSummary;
  netQuantity: number;
  grossQuantity: number;
  stockUom: string;
  estimatedCost: number | null;
  fromParts: RequirementContributor[];
}

export interface UnspecifiedPart {
  part: PartRef | RedactedRef;
  perAssembly: number;
  totalParts: number;
}

export interface MaterialRequirements {
  revision: { id: number; revision: string; lifecycle: Lifecycle };
  part: PartRef;
  buildQuantity: number;
  materials: MaterialRequirement[];
  /** Parts that plausibly need a material and declare none — the planning gaps. */
  unspecified: UnspecifiedPart[];
  notes: string[];
  totalEstimatedCost: number | null;
}
