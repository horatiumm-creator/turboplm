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
}

export interface DocumentLinkDetail {
  id: number;
  target: { type: 'PART' | 'REVISION' | 'ECN'; id: number; label: string };
}

export interface DocumentDetail extends DocumentSummary {
  /** Newest first. */
  versions: DocumentVersionDetail[];
  links: DocumentLinkDetail[];
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
