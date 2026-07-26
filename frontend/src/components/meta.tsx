import { Tag } from 'antd';
import dayjs from 'dayjs';
import type {
  AmlStatus,
  AttributeType,
  BomCompareStatus,
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
