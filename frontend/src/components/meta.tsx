import { Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import type {
  DocumentLock,
  MarkupKind,
  MarkupStatus,
  ServiceKind,
  ServiceStatus,
  CapaStatus,
  ConversionStatus,
  SignatureMeaning,
  SignatureStatus,
  DeliverableStatus,
  GateStatus,
  NcrSeverity,
  NcrStatus,
  ProjectStatus,
  RfqStatus,
  AmlStatus,
  AttributeType,
  BomCompareStatus,
  BuildKind,
  BuildStatus,
  CatalogFormat,
  CatalogImportStatus,
  CatalogRowStatus,
  CatalogTargetField,
  DeviationStatus,
  DocumentCategory,
  EcnDisposition,
  EcnPriority,
  EcnReviewDecision,
  EcnStatus,
  EcrStatus,
  Lifecycle,
  PartCategory,
  RequirementStatus,
  RequirementType,
  Role,
  TaskDecision,
  WorkflowRule,
  WorkflowStatus,
} from '../api/types';

export const LIFECYCLE_META: Record<Lifecycle, { label: string; color: string }> = {
  IN_WORK: { label: 'In Work', color: 'gold' },
  IN_REVIEW: { label: 'In Review', color: 'blue' },
  RELEASED: { label: 'Released', color: 'green' },
  OBSOLETE: { label: 'Obsolete', color: 'default' },
};

export const CATEGORY_META: Record<PartCategory, { label: string; color: string }> = {
  ASSEMBLY: { label: 'Assembly', color: 'purple' },
  MECHANICAL: { label: 'Mechanical', color: 'geekblue' },
  ELECTRICAL: { label: 'Electrical', color: 'cyan' },
  PURCHASED: { label: 'Purchased', color: 'orange' },
  RAW_MATERIAL: { label: 'Raw material', color: 'volcano' },
  SOFTWARE: { label: 'Software', color: 'magenta' },
};

export function LifecycleTag({ lifecycle }: { lifecycle: Lifecycle }) {
  const meta = LIFECYCLE_META[lifecycle];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function CategoryTag({ category }: { category: PartCategory }) {
  const meta = CATEGORY_META[category];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const formatDate = (iso: string | null | undefined) =>
  iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—';

export const CATEGORY_OPTIONS = (Object.keys(CATEGORY_META) as PartCategory[]).map((value) => ({
  value,
  label: CATEGORY_META[value].label,
}));

export const LIFECYCLE_OPTIONS = (Object.keys(LIFECYCLE_META) as Lifecycle[]).map((value) => ({
  value,
  label: LIFECYCLE_META[value].label,
}));

// ---- ECN meta ----

export const ECN_STATUS_META: Record<EcnStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'default' },
  IN_REVIEW: { label: 'In Review', color: 'blue' },
  APPROVED: { label: 'Approved', color: 'cyan' },
  RELEASED: { label: 'Released', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
};

export const ECN_PRIORITY_META: Record<EcnPriority, { label: string; color: string }> = {
  LOW: { label: 'Low', color: 'default' },
  MEDIUM: { label: 'Medium', color: 'blue' },
  HIGH: { label: 'High', color: 'orange' },
  CRITICAL: { label: 'Critical', color: 'red' },
};

export const ECN_DISPOSITION_META: Record<EcnDisposition, { label: string }> = {
  USE_AS_IS: { label: 'Use as is' },
  REWORK: { label: 'Rework' },
  SCRAP: { label: 'Scrap' },
  RETURN_TO_VENDOR: { label: 'Return to vendor' },
};

export function EcnStatusTag({ status }: { status: EcnStatus }) {
  const meta = ECN_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function EcnPriorityTag({ priority }: { priority: EcnPriority }) {
  const meta = ECN_PRIORITY_META[priority];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const ECN_STATUS_OPTIONS = (Object.keys(ECN_STATUS_META) as EcnStatus[]).map((value) => ({
  value,
  label: ECN_STATUS_META[value].label,
}));

export const ECN_PRIORITY_OPTIONS = (Object.keys(ECN_PRIORITY_META) as EcnPriority[]).map(
  (value) => ({ value, label: ECN_PRIORITY_META[value].label })
);

export const ECN_DISPOSITION_OPTIONS = (
  Object.keys(ECN_DISPOSITION_META) as EcnDisposition[]
).map((value) => ({ value, label: ECN_DISPOSITION_META[value].label }));

export const ECN_REVIEW_DECISION_META: Record<EcnReviewDecision, { label: string; color: string }> =
  {
    PENDING: { label: 'Pending', color: 'default' },
    APPROVED: { label: 'Approved', color: 'green' },
    REJECTED: { label: 'Changes requested', color: 'red' },
  };

export function EcnReviewDecisionTag({ decision }: { decision: EcnReviewDecision }) {
  const meta = ECN_REVIEW_DECISION_META[decision];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

// ---- requirements meta ----

export const REQ_STATUS_META: Record<RequirementStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'default' },
  APPROVED: { label: 'Approved', color: 'green' },
  OBSOLETE: { label: 'Obsolete', color: 'red' },
};

export const REQ_TYPE_META: Record<RequirementType, { label: string; color: string }> = {
  FUNCTIONAL: { label: 'Functional', color: 'geekblue' },
  PERFORMANCE: { label: 'Performance', color: 'purple' },
  SAFETY: { label: 'Safety', color: 'red' },
  REGULATORY: { label: 'Regulatory', color: 'orange' },
  INTERFACE: { label: 'Interface', color: 'cyan' },
};

export function ReqStatusTag({ status }: { status: RequirementStatus }) {
  const meta = REQ_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function ReqTypeTag({ type }: { type: RequirementType }) {
  const meta = REQ_TYPE_META[type];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const REQ_STATUS_OPTIONS = (Object.keys(REQ_STATUS_META) as RequirementStatus[]).map(
  (value) => ({ value, label: REQ_STATUS_META[value].label })
);
export const REQ_TYPE_OPTIONS = (Object.keys(REQ_TYPE_META) as RequirementType[]).map((value) => ({
  value,
  label: REQ_TYPE_META[value].label,
}));

// ---- workflow meta ----

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, { label: string; color: string }> = {
  RUNNING: { label: 'Running', color: 'blue' },
  COMPLETED: { label: 'Completed', color: 'green' },
  REJECTED: { label: 'Rejected', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
};

export const TASK_DECISION_META: Record<TaskDecision, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'default' },
  APPROVED: { label: 'Approved', color: 'green' },
  REJECTED: { label: 'Rejected', color: 'red' },
  SKIPPED: { label: 'Skipped', color: 'default' },
};

export const WORKFLOW_RULE_META: Record<WorkflowRule, { label: string }> = {
  ANY: { label: 'Any one approves' },
  ALL: { label: 'All must approve' },
};

export function WorkflowStatusTag({ status }: { status: WorkflowStatus }) {
  const meta = WORKFLOW_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function TaskDecisionTag({ decision }: { decision: TaskDecision }) {
  const meta = TASK_DECISION_META[decision];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

// ---- BOM compare meta ----

export const COMPARE_STATUS_META: Record<BomCompareStatus, { label: string; color: string }> = {
  ADDED: { label: 'Added', color: 'green' },
  REMOVED: { label: 'Removed', color: 'red' },
  CHANGED: { label: 'Changed', color: 'gold' },
  UNCHANGED: { label: 'Unchanged', color: 'default' },
};

export function CompareStatusTag({ status }: { status: BomCompareStatus }) {
  const meta = COMPARE_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

// ---- Tier 1+2 meta ----

export const DOC_CATEGORY_META: Record<DocumentCategory, { label: string; color: string }> = {
  DRAWING: { label: 'Drawing', color: 'geekblue' },
  SPECIFICATION: { label: 'Specification', color: 'purple' },
  DATASHEET: { label: 'Datasheet', color: 'cyan' },
  CAD_MODEL: { label: 'CAD model', color: 'blue' },
  IMAGE: { label: 'Image', color: 'magenta' },
  OTHER: { label: 'Other', color: 'default' },
};
export const DOC_CATEGORY_OPTIONS = (Object.keys(DOC_CATEGORY_META) as DocumentCategory[]).map(
  (value) => ({ value, label: DOC_CATEGORY_META[value].label })
);
export const CONVERSION_STATUS_META: Record<ConversionStatus, { label: string; color: string }> = {
  SKIPPED: { label: 'Not converted', color: 'default' },
  PENDING: { label: 'Converting…', color: 'blue' },
  DONE: { label: 'Derivative ready', color: 'green' },
  FAILED: { label: 'Conversion failed', color: 'red' },
};

export function ConversionStatusTag({ status }: { status: ConversionStatus }) {
  const meta = CONVERSION_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function DocCategoryTag({ category }: { category: DocumentCategory }) {
  const meta = DOC_CATEGORY_META[category];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const ECR_STATUS_META: Record<EcrStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'blue' },
  ACCEPTED: { label: 'Accepted', color: 'green' },
  REJECTED: { label: 'Rejected', color: 'red' },
};
export const ECR_STATUS_OPTIONS = (Object.keys(ECR_STATUS_META) as EcrStatus[]).map((value) => ({
  value,
  label: ECR_STATUS_META[value].label,
}));
export function EcrStatusTag({ status }: { status: EcrStatus }) {
  const meta = ECR_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const AML_STATUS_META: Record<AmlStatus, { label: string; color: string }> = {
  PREFERRED: { label: 'Preferred', color: 'green' },
  APPROVED: { label: 'Approved', color: 'blue' },
  ALTERNATE: { label: 'Alternate', color: 'gold' },
  OBSOLETE: { label: 'Obsolete', color: 'default' },
};
export const AML_STATUS_OPTIONS = (Object.keys(AML_STATUS_META) as AmlStatus[]).map((value) => ({
  value,
  label: AML_STATUS_META[value].label,
}));
export function AmlStatusTag({ status }: { status: AmlStatus }) {
  const meta = AML_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const ATTRIBUTE_TYPE_OPTIONS: { value: AttributeType; label: string }[] = [
  { value: 'TEXT', label: 'Text' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'DATE', label: 'Date' },
  { value: 'BOOLEAN', label: 'Yes/No' },
  { value: 'LIST', label: 'List of choices' },
];

export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'ENGINEER', label: 'Engineer' },
  { value: 'VIEWER', label: 'Viewer' },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ---- quality: nonconformance & CAPA ----

export const NCR_STATUS_META: Record<NcrStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'red' },
  CONTAINED: { label: 'Contained', color: 'gold' },
  CLOSED: { label: 'Closed', color: 'green' },
};

export const NCR_SEVERITY_META: Record<NcrSeverity, { label: string; color: string }> = {
  MINOR: { label: 'Minor', color: 'default' },
  MAJOR: { label: 'Major', color: 'orange' },
  CRITICAL: { label: 'Critical', color: 'red' },
};

export const CAPA_STATUS_META: Record<CapaStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'default' },
  IN_PROGRESS: { label: 'In Progress', color: 'blue' },
  VERIFIED: { label: 'Verified', color: 'cyan' },
  CLOSED: { label: 'Closed', color: 'green' },
};

export function NcrStatusTag({ status }: { status: NcrStatus }) {
  const meta = NCR_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function NcrSeverityTag({ severity }: { severity: NcrSeverity }) {
  const meta = NCR_SEVERITY_META[severity];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function CapaStatusTag({ status }: { status: CapaStatus }) {
  const meta = CAPA_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const NCR_STATUS_OPTIONS = (Object.keys(NCR_STATUS_META) as NcrStatus[]).map((value) => ({
  value,
  label: NCR_STATUS_META[value].label,
}));

export const NCR_SEVERITY_OPTIONS = (Object.keys(NCR_SEVERITY_META) as NcrSeverity[]).map(
  (value) => ({ value, label: NCR_SEVERITY_META[value].label })
);

export const CAPA_STATUS_OPTIONS = (Object.keys(CAPA_STATUS_META) as CapaStatus[]).map((value) => ({
  value,
  label: CAPA_STATUS_META[value].label,
}));

// ---- phase-gate projects ----

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string }> = {
  PLANNING: { label: 'Planning', color: 'default' },
  ACTIVE: { label: 'Active', color: 'blue' },
  ON_HOLD: { label: 'On Hold', color: 'gold' },
  COMPLETED: { label: 'Completed', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
};

export const GATE_STATUS_META: Record<GateStatus, { label: string; color: string }> = {
  NOT_STARTED: { label: 'Not started', color: 'default' },
  IN_PROGRESS: { label: 'In Progress', color: 'blue' },
  PASSED: { label: 'Passed', color: 'green' },
  BLOCKED: { label: 'Blocked', color: 'red' },
};

export const DELIVERABLE_STATUS_META: Record<DeliverableStatus, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'default' },
  IN_PROGRESS: { label: 'In Progress', color: 'blue' },
  COMPLETE: { label: 'Complete', color: 'green' },
  WAIVED: { label: 'Waived', color: 'purple' },
};

export function ProjectStatusTag({ status }: { status: ProjectStatus }) {
  const meta = PROJECT_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function GateStatusTag({ status }: { status: GateStatus }) {
  const meta = GATE_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const PROJECT_STATUS_OPTIONS = (Object.keys(PROJECT_STATUS_META) as ProjectStatus[]).map(
  (value) => ({ value, label: PROJECT_STATUS_META[value].label })
);

export const DELIVERABLE_STATUS_OPTIONS = (
  Object.keys(DELIVERABLE_STATUS_META) as DeliverableStatus[]
).map((value) => ({ value, label: DELIVERABLE_STATUS_META[value].label }));

// ---- supplier RFQ ----

export const RFQ_STATUS_META: Record<RfqStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'default' },
  SENT: { label: 'Sent', color: 'blue' },
  CLOSED: { label: 'Closed', color: 'gold' },
  AWARDED: { label: 'Awarded', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
};

export function RfqStatusTag({ status }: { status: RfqStatus }) {
  const meta = RFQ_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const RFQ_STATUS_OPTIONS = (Object.keys(RFQ_STATUS_META) as RfqStatus[]).map((value) => ({
  value,
  label: RFQ_STATUS_META[value].label,
}));

// ---- electronic signatures ----

export const MEANING_META: Record<SignatureMeaning, { label: string; color: string; hint: string }> =
  {
    AUTHORED: {
      label: 'Authored',
      color: 'blue',
      hint: 'that you prepared this content',
    },
    REVIEWED: {
      label: 'Reviewed',
      color: 'cyan',
      hint: 'that you have reviewed this content and found it correct',
    },
    APPROVED: {
      label: 'Approved',
      color: 'green',
      hint: 'that you approve this content for release',
    },
    QA_APPROVED: {
      label: 'QA approved',
      color: 'purple',
      hint: 'that this content meets the applicable quality requirements',
    },
  };

export const MEANING_OPTIONS = (Object.keys(MEANING_META) as SignatureMeaning[]).map((value) => ({
  value,
  label: MEANING_META[value].label,
}));

export const SIGNATURE_STATUS_META: Record<SignatureStatus, { label: string; color: string }> = {
  VALID: { label: 'Valid', color: 'green' },
  VOIDED: { label: 'Voided', color: 'red' },
};

// ---- build units ----

export const BUILD_KIND_META: Record<BuildKind, { label: string; color: string }> = {
  SERIAL: { label: 'Serial', color: 'geekblue' },
  LOT: { label: 'Lot', color: 'purple' },
};

export const BUILD_STATUS_META: Record<BuildStatus, { label: string; color: string }> = {
  IN_PROGRESS: { label: 'In Progress', color: 'blue' },
  COMPLETED: { label: 'Completed', color: 'green' },
  SCRAPPED: { label: 'Scrapped', color: 'red' },
  SHIPPED: { label: 'Shipped', color: 'cyan' },
};

/** `SUBSTITUTED` is an approved alternate, so it is coloured apart from the defects. */
export const DEVIATION_STATUS_META: Record<DeviationStatus, { label: string; color: string }> = {
  MATCH: { label: 'Match', color: 'green' },
  QTY_MISMATCH: { label: 'Qty mismatch', color: 'gold' },
  MISSING: { label: 'Missing', color: 'red' },
  UNPLANNED: { label: 'Unplanned', color: 'orange' },
  SUBSTITUTED: { label: 'Substituted', color: 'purple' },
};

export function BuildKindTag({ kind }: { kind: BuildKind }) {
  const meta = BUILD_KIND_META[kind];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function BuildStatusTag({ status }: { status: BuildStatus }) {
  const meta = BUILD_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function DeviationStatusTag({ status }: { status: DeviationStatus }) {
  const meta = DEVIATION_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const BUILD_KIND_OPTIONS = (Object.keys(BUILD_KIND_META) as BuildKind[]).map((value) => ({
  value,
  label: BUILD_KIND_META[value].label,
}));

export const BUILD_STATUS_OPTIONS = (Object.keys(BUILD_STATUS_META) as BuildStatus[]).map(
  (value) => ({ value, label: BUILD_STATUS_META[value].label })
);

// ---- catalog import ----

export const CATALOG_FORMAT_META: Record<CatalogFormat, { label: string; color: string }> = {
  CSV: { label: 'CSV', color: 'blue' },
  XLSX: { label: 'Excel', color: 'green' },
  BMECAT_XML: { label: 'BMEcat XML', color: 'purple' },
};

export const CATALOG_IMPORT_STATUS_META: Record<
  CatalogImportStatus,
  { label: string; color: string }
> = {
  DRAFT: { label: 'Draft', color: 'default' },
  VALIDATED: { label: 'Validated', color: 'blue' },
  COMMITTING: { label: 'Committing…', color: 'processing' },
  COMMITTED: { label: 'Committed', color: 'green' },
  FAILED: { label: 'Failed', color: 'red' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
};

/** Colours follow what the row will *do*: green creates, blue amends, red is refused. */
export const CATALOG_ROW_STATUS_META: Record<CatalogRowStatus, { label: string; color: string }> = {
  NEW: { label: 'New', color: 'green' },
  UPDATE: { label: 'Update', color: 'blue' },
  DUPLICATE: { label: 'Duplicate', color: 'gold' },
  INVALID: { label: 'Invalid', color: 'red' },
  SKIPPED: { label: 'Skipped', color: 'default' },
  COMMITTED: { label: 'Committed', color: 'cyan' },
};

export function CatalogFormatTag({ format }: { format: CatalogFormat }) {
  const meta = CATALOG_FORMAT_META[format];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function CatalogImportStatusTag({ status }: { status: CatalogImportStatus }) {
  const meta = CATALOG_IMPORT_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function CatalogRowStatusTag({ status }: { status: CatalogRowStatus }) {
  const meta = CATALOG_ROW_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const CATALOG_FORMAT_OPTIONS = (Object.keys(CATALOG_FORMAT_META) as CatalogFormat[]).map(
  (value) => ({ value, label: CATALOG_FORMAT_META[value].label })
);

export const CATALOG_ROW_STATUS_OPTIONS = (
  Object.keys(CATALOG_ROW_STATUS_META) as CatalogRowStatus[]
).map((value) => ({ value, label: CATALOG_ROW_STATUS_META[value].label }));

/**
 * The mappable target fields, in the order the mapping UI shows them. `required` is rule V3:
 * a row without a name or an MPN is not importable, and validate rejects the whole mapping.
 */
export const CATALOG_TARGET_META: Record<
  CatalogTargetField,
  { label: string; required: boolean; hint: string }
> = {
  partNumber: {
    label: 'Part number',
    required: false,
    hint: 'Internal part number. Leave unmapped to have one generated.',
  },
  name: { label: 'Name', required: true, hint: 'What the part is — usually the short description.' },
  description: {
    label: 'Description',
    required: false,
    hint: 'The longer text, when the file carries both.',
  },
  category: {
    label: 'Category',
    required: false,
    hint: 'Assembly, Mechanical, Electrical, Purchased, Raw material or Software.',
  },
  uom: {
    label: 'Unit of measure',
    required: false,
    hint: 'A unit this PLM knows — anything else makes the row invalid.',
  },
  unitCost: {
    label: 'Unit cost',
    required: false,
    hint: 'Price per unit. A cell that is not a number makes the row invalid.',
  },
  manufacturerName: {
    label: 'Manufacturer',
    required: false,
    hint: 'Matched to an existing manufacturer, case-insensitively.',
  },
  mpn: {
    label: 'Manufacturer part number',
    required: true,
    hint: 'The MPN. With the manufacturer it decides new versus update.',
  },
  distributorName: {
    label: 'Distributor',
    required: false,
    hint: 'Who this offer came from, e.g. Digi-Key.',
  },
  distributorPartNumber: {
    label: 'Distributor part number',
    required: false,
    hint: "The distributor's own order code.",
  },
};

export const CATALOG_TARGET_FIELDS = Object.keys(CATALOG_TARGET_META) as CatalogTargetField[];

export const CATALOG_REQUIRED_TARGETS = CATALOG_TARGET_FIELDS.filter(
  (field) => CATALOG_TARGET_META[field].required
);

/**
 * Mirrors `CATALOG_UOMS` in backend/src/lib/catalogParse.ts: the units the importer
 * recognizes. Offering them as a list keeps a default from silently invalidating every row.
 */
export const CATALOG_UOM_OPTIONS = [
  'ea',
  'set',
  'pair',
  'kit',
  'box',
  'pack',
  'reel',
  'roll',
  'sheet',
  'm',
  'cm',
  'mm',
  'in',
  'ft',
  'm2',
  'cm2',
  'mm2',
  'm3',
  'l',
  'ml',
  'gal',
  'kg',
  'g',
  'mg',
  'lb',
  'oz',
  'hr',
  'min',
].map((value) => ({ value, label: value }));

// ---- vault, markup, service ----

/**
 * Rule D3 — one sentence describing the vault state, reused by the lock bar, the lock column
 * and the tooltip on a disabled upload control. `docNumber` is in the "check it out first"
 * wording so the hint reads the same as the server's refusal for the same situation.
 */
export function lockReason(lock: DocumentLock | null | undefined, docNumber: string): string | null {
  // `isMine` is checked before expiry on purpose: the server keys the upload on who the row
  // names, and an expired lock only means somebody else *may* take it — until one does, the
  // holder can still file the work they just did.
  if (lock?.isMine) return null;
  if (!lock || lock.expired) return `Check out ${docNumber} before uploading a new version`;
  return `${docNumber} is checked out by ${lock.user.name}`;
}

/**
 * The vault state as a tag. An expired lock is shown as takeable rather than held: the server
 * lets anyone take it, so calling it "checked out" would contradict what the buttons do.
 */
export function DocumentLockTag({ lock }: { lock: DocumentLock | null | undefined }) {
  if (!lock) return <Tag color="default">Available</Tag>;
  if (lock.expired) {
    return (
      <Tooltip title={`${lock.user.name}'s lock lapsed ${formatDate(lock.expiresAt)} — anyone may take it`}>
        <Tag color="gold">Lock expired</Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`Checked out ${formatDate(lock.lockedAt)}${lock.note ? ` — ${lock.note}` : ''}`}>
      <Tag color={lock.isMine ? 'blue' : 'red'}>
        {lock.isMine ? 'Checked out by you' : `Checked out by ${lock.user.name}`}
      </Tag>
    </Tooltip>
  );
}

export const MARKUP_KIND_META: Record<MarkupKind, { label: string; color: string; hint: string }> = {
  PIN_3D: {
    label: '3D pin',
    color: 'geekblue',
    hint: 'A point on the model, stored with the camera so the view can be restored.',
  },
  BOX_2D: {
    label: '2D box',
    color: 'purple',
    hint: 'A rectangle on a drawing page, in normalized 0–1 coordinates.',
  },
  POINT_2D: {
    label: '2D point',
    color: 'cyan',
    hint: 'A point on a drawing page, in normalized 0–1 coordinates.',
  },
  NOTE: { label: 'Note', color: 'default', hint: 'A remark about the version with no position.' },
};

export const MARKUP_KIND_OPTIONS = (Object.keys(MARKUP_KIND_META) as MarkupKind[]).map((value) => ({
  value,
  label: MARKUP_KIND_META[value].label,
}));

export const MARKUP_STATUS_META: Record<MarkupStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'red' },
  RESOLVED: { label: 'Resolved', color: 'green' },
  WONT_FIX: { label: "Won't fix", color: 'default' },
};

export const MARKUP_STATUS_OPTIONS = (Object.keys(MARKUP_STATUS_META) as MarkupStatus[]).map(
  (value) => ({ value, label: MARKUP_STATUS_META[value].label })
);

export function MarkupKindTag({ kind }: { kind: MarkupKind }) {
  const meta = MARKUP_KIND_META[kind];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function MarkupStatusTag({ status }: { status: MarkupStatus }) {
  const meta = MARKUP_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const SERVICE_KIND_META: Record<ServiceKind, { label: string; color: string }> = {
  REPAIR: { label: 'Repair', color: 'orange' },
  UPGRADE: { label: 'Upgrade', color: 'geekblue' },
  INSPECTION: { label: 'Inspection', color: 'cyan' },
  WARRANTY_CLAIM: { label: 'Warranty claim', color: 'volcano' },
  DECOMMISSION: { label: 'Decommission', color: 'default' },
};

export const SERVICE_STATUS_META: Record<ServiceStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'red' },
  IN_PROGRESS: { label: 'In Progress', color: 'blue' },
  CLOSED: { label: 'Closed', color: 'green' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
};

export function ServiceKindTag({ kind }: { kind: ServiceKind }) {
  const meta = SERVICE_KIND_META[kind];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function ServiceStatusTag({ status }: { status: ServiceStatus }) {
  const meta = SERVICE_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const SERVICE_KIND_OPTIONS = (Object.keys(SERVICE_KIND_META) as ServiceKind[]).map(
  (value) => ({ value, label: SERVICE_KIND_META[value].label })
);

export const SERVICE_STATUS_OPTIONS = (Object.keys(SERVICE_STATUS_META) as ServiceStatus[]).map(
  (value) => ({ value, label: SERVICE_STATUS_META[value].label })
);

/**
 * Only a unit that was finished or shipped can be serviced (rule G1), so both pickers offer
 * exactly these two and nothing else — the alternative is letting the user pick a unit the
 * server will refuse.
 */
export const SERVICEABLE_BUILD_STATUSES = ['SHIPPED', 'COMPLETED'] as const;
