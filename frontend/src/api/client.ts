import { ACL_SEGMENTS } from './types';
import type {
  AclEntityType,
  AclPermission,
  AccessGroupDetail,
  AccessGroupSummary,
  ItemAccess,
  MaterialClass,
  MaterialDetail,
  MaterialForm,
  MaterialRequirements,
  MaterialSummary,
  PartMaterial,

  AmlStatus,
  AnalyticsKpis,
  ApiKeyCreated,
  BomReconciliation,
  CadAssembly,
  CadBomProposal,
  CadStructureDiff,
  CbomReconciliation,
  PortalIdentity,
  PortalRfqDetail,
  PortalRfqSummary,
  RfqInvitation,
  SupplierUserAccount,
  SupplierUserWithInvite,
  SignatureManifest,
  SignatureMeaning,
  SignatureRequirement,
  SignedEntityType,
  ApiKeySummary,
  AsMaintained,
  AttributeDef,
  AttributeType,
  AuditEntry,
  AuthProviders,
  BaselineCompareResult,
  BaselineDetail,
  BaselineSummary,
  BomCompareResult,
  BomLineAlternateDetail,
  BomLineDetail,
  BomTreeNode,
  BuildKind,
  BuildStatus,
  BuildUnitDetail,
  BuildUnitSummary,
  BuildUnitTransitionAction,
  CapaDetail,
  CapaStatus,
  CapaSummary,
  CatalogFormat,
  CatalogImportDetail,
  CatalogImportRow,
  CatalogImportSummary,
  CatalogMapping,
  CatalogRowStatus,
  CatalogTargetField,
  CostRollup,
  DashboardStats,
  DeliverableStatus,
  DeviationReport,
  DocumentCategory,
  DocumentDetail,
  DocumentSummary,
  DocumentVersionDetail,
  EcnDetail,
  EcnDisposition,
  EcnImpactEntry,
  EcnItemDetail,
  EcnPriority,
  EcnReviewDetail,
  EcnStatus,
  EcnSummary,
  EcnTransitionAction,
  EcnWorkflowDetail,
  EcrDetail,
  EcrStatus,
  EcrSummary,
  EmailStatus,
  EntityDocument,
  GenealogyNode,
  ImportResult,
  Lifecycle,
  ManufacturerPartDetail,
  ManufacturerSummary,
  MarkupComment,
  MarkupDetail,
  MarkupKind,
  MarkupStatus,
  MarkupTransition,
  MyWork,
  NcrDetail,
  NcrSeverity,
  NcrStatus,
  NcrSummary,
  NotificationList,
  OperationDetail,
  OperationMaterialDetail,
  OptionGroupDetail,
  Paged,
  PartAttribute,
  PartCategory,
  PartDetail,
  PartSummary,
  ProcessPlanDetail,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  ReqifImportResult,
  RequirementDetail,
  RequirementMatrix,
  RequirementStatus,
  RequirementSummary,
  RequirementType,
  RevisionDetail,
  RfqDetail,
  RfqStatus,
  RfqSummary,
  Role,
  SearchResults,
  ServiceKind,
  ServiceRecordDetail,
  ServiceRecordSummary,
  ServiceStatus,
  ServiceTransition,
  SupplierSummary,
  TransitionAction,
  UserInfo,
  UserSummary,
  VariantResolution,
  WebhookCreated,
  WebhookSummary,
  WhereConsumedResult,
  WhereUsedEntry,
  WorkflowRule,
  WorkflowTemplateDetail,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options?: RequestInit & { json?: unknown; keepSessionOn401?: boolean }
): Promise<T> {
  const { json, keepSessionOn401, ...rest } = options ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    ...rest,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Session expired mid-use: send the user back to the login page (auth endpoints
    // handle their own 401s, e.g. a wrong password).
    // Background notification polling must never force a navigation — a session
    // that expires mid-edit would otherwise discard unsaved work on the next poll.
    // `keepSessionOn401` marks calls that re-authenticate the *current* user — signing,
    // for instance. A wrong password there is a rejected credential, not a dead session,
    // and bouncing to /login would throw the user off the page they were working on.
    if (
      res.status === 401 &&
      !keepSessionOn401 &&
      !path.startsWith('/auth/') &&
      !path.startsWith('/notifications') &&
      window.location.pathname !== '/login'
    ) {
      window.location.assign('/login');
    }
    const message =
      data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

// ---- auth ----
export const getMe = () => request<UserInfo>('/auth/me');
export const login = (email: string, password: string) =>
  request<UserInfo>('/auth/login', { method: 'POST', json: { email, password } });
export const register = (name: string, email: string, password: string) =>
  request<UserInfo>('/auth/register', { method: 'POST', json: { name, email, password } });
export const logout = () => request<void>('/auth/logout', { method: 'POST' });
export const getProviders = () => request<AuthProviders>('/auth/providers');

// ---- parts ----
export interface ListPartsParams {
  search?: string;
  category?: PartCategory;
  lifecycle?: Lifecycle;
  page?: number;
  pageSize?: number;
}

export const listParts = (params: ListPartsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.category) qs.set('category', params.category);
  if (params.lifecycle) qs.set('lifecycle', params.lifecycle);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<PartSummary>>(`/parts${suffix}`);
};

export interface CreatePartInput {
  partNumber?: string;
  name: string;
  description?: string;
  category: PartCategory;
  uom?: string;
  unitCost?: number | null;
}

export const createPart = (input: CreatePartInput) =>
  request<PartDetail>('/parts', { method: 'POST', json: input });
export const getPart = (id: number) => request<PartDetail>(`/parts/${id}`);
export const updatePart = (
  id: number,
  patch: {
    name?: string;
    description?: string;
    category?: PartCategory;
    uom?: string;
    unitCost?: number | null;
  }
) => request<PartDetail>(`/parts/${id}`, { method: 'PATCH', json: patch });
export const deletePart = (id: number) => request<void>(`/parts/${id}`, { method: 'DELETE' });

// ---- revisions ----
export const createRevision = (partId: number) =>
  request<RevisionDetail>(`/parts/${partId}/revisions`, { method: 'POST' });
export const getRevision = (id: number) => request<RevisionDetail>(`/revisions/${id}`);
export const updateRevision = (id: number, patch: { changeNote?: string | null }) =>
  request<RevisionDetail>(`/revisions/${id}`, { method: 'PATCH', json: patch });
export const transitionRevision = (id: number, action: TransitionAction) =>
  request<RevisionDetail>(`/revisions/${id}/transition`, { method: 'POST', json: { action } });

// ---- BOM ----
export const getBom = (revisionId: number, asOf?: string) =>
  request<BomLineDetail[]>(
    `/revisions/${revisionId}/bom${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`
  );
export const getBomTree = (revisionId: number, asOf?: string) =>
  request<BomTreeNode[]>(
    `/revisions/${revisionId}/bom/tree${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`
  );
export const addBomLine = (
  revisionId: number,
  input: {
    childPartId: number;
    quantity: number;
    uom?: string;
    findNumber?: number;
    refDesignators?: string;
    notes?: string;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }
) => request<BomLineDetail>(`/revisions/${revisionId}/bom`, { method: 'POST', json: input });
export const updateBomLine = (
  lineId: number,
  patch: {
    quantity?: number;
    uom?: string;
    findNumber?: number;
    refDesignators?: string | null;
    notes?: string | null;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }
) => request<BomLineDetail>(`/bom-lines/${lineId}`, { method: 'PATCH', json: patch });
export const deleteBomLine = (lineId: number) =>
  request<void>(`/bom-lines/${lineId}`, { method: 'DELETE' });
export const getWhereUsed = (partId: number) =>
  request<WhereUsedEntry[]>(`/parts/${partId}/where-used`);

// ---- process plans ----
export const getProcessPlan = (revisionId: number) =>
  request<ProcessPlanDetail | null>(`/revisions/${revisionId}/process-plan`);
export const upsertProcessPlan = (
  revisionId: number,
  input: { name?: string; description?: string | null }
) => request<ProcessPlanDetail>(`/revisions/${revisionId}/process-plan`, { method: 'PUT', json: input });
export const addOperation = (
  planId: number,
  input: {
    seq?: number;
    name: string;
    workCenter?: string;
    description?: string;
    setupMinutes?: number;
    runMinutes?: number;
  }
) => request<OperationDetail>(`/process-plans/${planId}/operations`, { method: 'POST', json: input });
export const updateOperation = (
  opId: number,
  patch: {
    seq?: number;
    name?: string;
    workCenter?: string | null;
    description?: string | null;
    setupMinutes?: number;
    runMinutes?: number;
  }
) => request<OperationDetail>(`/operations/${opId}`, { method: 'PATCH', json: patch });
export const deleteOperation = (opId: number) =>
  request<void>(`/operations/${opId}`, { method: 'DELETE' });
export const addOperationMaterial = (
  opId: number,
  input: {
    partId: number;
    quantity: number;
    uom?: string;
    notes?: string;
    scrapFactor?: number;
    consumable?: boolean;
  }
) =>
  request<OperationMaterialDetail>(`/operations/${opId}/materials`, { method: 'POST', json: input });
export const updateOperationMaterial = (
  materialId: number,
  patch: {
    quantity?: number;
    uom?: string;
    notes?: string | null;
    scrapFactor?: number;
    consumable?: boolean;
  }
) =>
  request<OperationMaterialDetail>(`/operation-materials/${materialId}`, {
    method: 'PATCH',
    json: patch,
  });
export const deleteOperationMaterial = (materialId: number) =>
  request<void>(`/operation-materials/${materialId}`, { method: 'DELETE' });

// ---- ECN (engineering change notices) ----
export interface ListEcnsParams {
  search?: string;
  status?: EcnStatus;
  page?: number;
  pageSize?: number;
}

export const listEcns = (params: ListEcnsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<EcnSummary>>(`/ecns${suffix}`);
};

export interface CreateEcnInput {
  title: string;
  description?: string;
  reason?: string;
  priority?: EcnPriority;
  effectivityDate?: string;
  /** By date or by unit, never both (rule U6) — sending both is a 400. */
  effectiveFromSerial?: string;
}

export const createEcn = (input: CreateEcnInput) =>
  request<EcnDetail>('/ecns', { method: 'POST', json: input });
export const getEcn = (id: number) => request<EcnDetail>(`/ecns/${id}`);
export const updateEcn = (
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    reason?: string | null;
    priority?: EcnPriority;
    effectivityDate?: string | null;
    /** Editable while DRAFT or IN_REVIEW; clear the other field to switch cut-in modes. */
    effectiveFromSerial?: string | null;
  }
) => request<EcnDetail>(`/ecns/${id}`, { method: 'PATCH', json: patch });
export const deleteEcn = (id: number) => request<void>(`/ecns/${id}`, { method: 'DELETE' });
export const addEcnItem = (
  ecnId: number,
  input: { partId: number; changeDescription?: string; disposition?: EcnDisposition }
) => request<EcnItemDetail>(`/ecns/${ecnId}/items`, { method: 'POST', json: input });
export const updateEcnItem = (
  itemId: number,
  patch: { changeDescription?: string | null; disposition?: EcnDisposition }
) => request<EcnItemDetail>(`/ecn-items/${itemId}`, { method: 'PATCH', json: patch });
export const deleteEcnItem = (itemId: number) =>
  request<void>(`/ecn-items/${itemId}`, { method: 'DELETE' });
export const startEcnItemChange = (itemId: number) =>
  request<EcnItemDetail>(`/ecn-items/${itemId}/revision`, { method: 'POST' });
export const transitionEcn = (
  id: number,
  action: EcnTransitionAction,
  extra?: { workflowTemplateId?: number }
) =>
  request<EcnDetail>(`/ecns/${id}/transition`, {
    method: 'POST',
    json: { action, ...(extra ?? {}) },
  });
export const getEcnImpact = (id: number) => request<EcnImpactEntry[]>(`/ecns/${id}/impact`);

// ---- ECN reviewers ----
export const listUsers = () => request<UserSummary[]>('/users');
export const addEcnReviewer = (ecnId: number, userId: number) =>
  request<EcnReviewDetail>(`/ecns/${ecnId}/reviewers`, { method: 'POST', json: { userId } });
export const removeEcnReview = (reviewId: number) =>
  request<void>(`/ecn-reviews/${reviewId}`, { method: 'DELETE' });
export const decideEcnReview = (
  reviewId: number,
  decision: 'approve' | 'reject',
  comment?: string
) =>
  request<EcnReviewDetail>(`/ecn-reviews/${reviewId}/decision`, {
    method: 'POST',
    json: { decision, comment },
  });

// ---- BOM compare ----
export const compareBom = (left: number, right: number) =>
  request<BomCompareResult>(`/bom-compare?left=${left}&right=${right}`);

// ---- multipart helper ----
async function requestForm<T>(path: string, form: FormData, method = 'POST'): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

// ---- documents ----
export const listDocuments = (
  params: { search?: string; category?: DocumentCategory; page?: number; pageSize?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.category) qs.set('category', params.category);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<DocumentSummary>>(`/documents${suffix}`);
};

export const createDocument = (input: {
  file: File;
  title: string;
  category: DocumentCategory;
  description?: string;
}) => {
  const form = new FormData();
  form.set('file', input.file);
  form.set('title', input.title);
  form.set('category', input.category);
  if (input.description) form.set('description', input.description);
  return requestForm<DocumentDetail>('/documents', form);
};

export const getDocument = (id: number) => request<DocumentDetail>(`/documents/${id}`);
export const updateDocument = (
  id: number,
  patch: { title?: string; category?: DocumentCategory; description?: string | null }
) => request<DocumentDetail>(`/documents/${id}`, { method: 'PATCH', json: patch });
export const deleteDocument = (id: number) =>
  request<void>(`/documents/${id}`, { method: 'DELETE' });

export const addDocumentVersion = (documentId: number, file: File, note?: string) => {
  const form = new FormData();
  form.set('file', file);
  if (note) form.set('note', note);
  return requestForm<DocumentDetail>(`/documents/${documentId}/versions`, form);
};

/** Direct download URL for a stored file version; inline=true for in-browser preview. */
export const documentVersionFileUrl = (versionId: number, inline = false) =>
  `/api/document-versions/${versionId}/file${inline ? '?inline=1' : ''}`;

export const addDocumentLink = (
  documentId: number,
  target: { partId?: number; partRevisionId?: number; ecnId?: number }
) => request<DocumentDetail>(`/documents/${documentId}/links`, { method: 'POST', json: target });
export const removeDocumentLink = (linkId: number) =>
  request<void>(`/document-links/${linkId}`, { method: 'DELETE' });

export const getPartDocuments = (partId: number) =>
  request<EntityDocument[]>(`/parts/${partId}/documents`);
export const getRevisionDocuments = (revisionId: number) =>
  request<EntityDocument[]>(`/revisions/${revisionId}/documents`);
export const getEcnDocuments = (ecnId: number) =>
  request<EntityDocument[]>(`/ecns/${ecnId}/documents`);

// ---- document vault: check-out and check-in (rules D1–D2) ----
/**
 * Take the lock. Re-checking out your own lock is idempotent and refreshes the expiry;
 * 409 `<docNumber> is checked out by <name>` when someone else holds a live one.
 */
export const checkoutDocument = (id: number, note?: string) =>
  request<DocumentDetail>(`/documents/${id}/checkout`, { method: 'POST', json: { note } });
/**
 * Create the next version and release the lock in one transaction. Multipart, like
 * `addDocumentVersion`; 409 `<docNumber> is not checked out by you`.
 */
export const checkinDocument = (id: number, file: File, note?: string) => {
  const form = new FormData();
  form.set('file', file);
  if (note) form.set('note', note);
  return requestForm<DocumentDetail>(`/documents/${id}/checkin`, form);
};
/** Release without producing a version. The holder, or an ADMIN. */
export const cancelDocumentCheckout = (id: number) =>
  request<DocumentDetail>(`/documents/${id}/cancel-checkout`, { method: 'POST' });
/** ADMIN only. `reason` is required and is kept in the lock note so the trail explains itself. */
export const breakDocumentLock = (id: number, reason: string) =>
  request<DocumentDetail>(`/documents/${id}/break-lock`, { method: 'POST', json: { reason } });

// ---- ECRs ----
export const listEcrs = (
  params: { search?: string; status?: EcrStatus; page?: number; pageSize?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<EcrSummary>>(`/ecrs${suffix}`);
};
export const createEcr = (input: {
  title: string;
  description?: string;
  priority?: EcnPriority;
  partId?: number;
}) => request<EcrDetail>('/ecrs', { method: 'POST', json: input });
export const getEcr = (id: number) => request<EcrDetail>(`/ecrs/${id}`);
export const updateEcr = (
  id: number,
  patch: { title?: string; description?: string | null; priority?: EcnPriority; partId?: number | null }
) => request<EcrDetail>(`/ecrs/${id}`, { method: 'PATCH', json: patch });
export const acceptEcr = (id: number, input: { ecnId?: number }) =>
  request<EcrDetail>(`/ecrs/${id}/accept`, { method: 'POST', json: input });
export const rejectEcr = (id: number, resolution: string) =>
  request<EcrDetail>(`/ecrs/${id}/reject`, { method: 'POST', json: { resolution } });

// ---- AML (manufacturer parts) ----
export const listManufacturers = (search?: string) => {
  const suffix = search ? `?search=${encodeURIComponent(search)}` : '';
  return request<ManufacturerSummary[]>(`/manufacturers${suffix}`);
};
export const createManufacturer = (input: { name: string; website?: string }) =>
  request<ManufacturerSummary>('/manufacturers', { method: 'POST', json: input });
export const getPartManufacturerParts = (partId: number) =>
  request<ManufacturerPartDetail[]>(`/parts/${partId}/manufacturer-parts`);
export const addManufacturerPart = (
  partId: number,
  input: { manufacturerId: number; mpn: string; status?: AmlStatus; description?: string }
) =>
  request<ManufacturerPartDetail>(`/parts/${partId}/manufacturer-parts`, {
    method: 'POST',
    json: input,
  });
export const updateManufacturerPart = (
  id: number,
  patch: { mpn?: string; status?: AmlStatus; description?: string | null }
) => request<ManufacturerPartDetail>(`/manufacturer-parts/${id}`, { method: 'PATCH', json: patch });
export const deleteManufacturerPart = (id: number) =>
  request<void>(`/manufacturer-parts/${id}`, { method: 'DELETE' });

// ---- BOM line alternates ----
export const addBomLineAlternate = (lineId: number, input: { partId: number; note?: string }) =>
  request<BomLineAlternateDetail>(`/bom-lines/${lineId}/alternates`, {
    method: 'POST',
    json: input,
  });
export const removeBomLineAlternate = (alternateId: number) =>
  request<void>(`/bom-line-alternates/${alternateId}`, { method: 'DELETE' });

// ---- Custom attributes ----
export const listAttributeDefs = (category?: PartCategory) => {
  const suffix = category ? `?category=${category}` : '';
  return request<AttributeDef[]>(`/attribute-defs${suffix}`);
};
export const createAttributeDef = (input: {
  category: PartCategory;
  name: string;
  label: string;
  type: AttributeType;
  options?: string[];
  required?: boolean;
  sortOrder?: number;
}) => request<AttributeDef>('/attribute-defs', { method: 'POST', json: input });
export const updateAttributeDef = (
  id: number,
  patch: {
    label?: string;
    type?: AttributeType;
    options?: string[];
    required?: boolean;
    sortOrder?: number;
  }
) => request<AttributeDef>(`/attribute-defs/${id}`, { method: 'PATCH', json: patch });
export const deleteAttributeDef = (id: number) =>
  request<void>(`/attribute-defs/${id}`, { method: 'DELETE' });
export const setPartAttributes = (partId: number, values: Record<number, string | null>) =>
  request<PartAttribute[]>(`/parts/${partId}/attributes`, { method: 'PUT', json: { values } });

// ---- Baselines ----
export const listBaselines = (
  params: { search?: string; page?: number; pageSize?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<BaselineSummary>>(`/baselines${suffix}`);
};
export const createBaseline = (input: {
  partRevisionId: number;
  name: string;
  description?: string;
}) => request<BaselineDetail>('/baselines', { method: 'POST', json: input });
export const getBaseline = (id: number) => request<BaselineDetail>(`/baselines/${id}`);
export const deleteBaseline = (id: number) =>
  request<void>(`/baselines/${id}`, { method: 'DELETE' });
export const compareBaselines = (left: number, right: number) =>
  request<BaselineCompareResult>(`/baseline-compare?left=${left}&right=${right}`);

// ---- Cost roll-up ----
export const getCostRollup = (revisionId: number) =>
  request<CostRollup>(`/revisions/${revisionId}/cost-rollup`);

// ---- Users / audit ----
export const updateUserRole = (id: number, role: Role) =>
  request<UserSummary>(`/users/${id}`, { method: 'PATCH', json: { role } });
export const listAudit = (
  params: {
    entityType?: string;
    entityId?: number;
    userId?: number;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {}
) => {
  const qs = new URLSearchParams();
  if (params.entityType) qs.set('entityType', params.entityType);
  if (params.entityId) qs.set('entityId', String(params.entityId));
  if (params.userId) qs.set('userId', String(params.userId));
  if (params.search) qs.set('search', params.search);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<AuditEntry>>(`/audit${suffix}`);
};

// ---- notifications ----
export const listNotifications = (params: { unread?: boolean; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.unread) qs.set('unread', '1');
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<NotificationList>(`/notifications${suffix}`);
};
export const markNotificationsRead = (ids?: number[]) =>
  request<{ unread: number }>('/notifications/read', {
    method: 'POST',
    json: ids ? { ids } : { all: true },
  });

// ---- global search ----
export const globalSearch = (q: string) =>
  request<SearchResults>(`/search?q=${encodeURIComponent(q)}`);

// ---- my work ----
export const getMyWork = () => request<MyWork>('/my-work');

// ---- exports ----
/** Direct download URL for the multi-level BOM CSV of a revision. */
export const bomExportUrl = (revisionId: number) => `/api/revisions/${revisionId}/bom/export.csv`;

/**
 * Direct download URL for the STEP (.stp) product structure of a revision.
 *
 * Structure, not shapes. STEP is best known as a geometry format, so the name sets an
 * expectation this endpoint cannot meet: a PLM database holds an assembly tree, quantities and
 * part identification, and none of that is a solid model. Anything in the UI that offers this
 * has to say so at the point of the click — see the label and hint on the eBOM tab.
 */
export const revisionStepExportUrl = (revisionId: number) =>
  `/api/revisions/${revisionId}/export/step`;

// ---- requirements & traceability ----
export interface ListRequirementsParams {
  search?: string;
  status?: RequirementStatus;
  type?: RequirementType;
  page?: number;
  pageSize?: number;
}

export const listRequirements = (params: ListRequirementsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<RequirementSummary>>(`/requirements${suffix}`);
};

export interface RequirementInput {
  title: string;
  statement: string;
  type?: RequirementType;
  priority?: EcnPriority;
  parentId?: number | null;
  rationale?: string | null;
  acceptance?: string | null;
}

export const createRequirement = (input: RequirementInput) =>
  request<RequirementDetail>('/requirements', { method: 'POST', json: input });
export const getRequirement = (id: number) => request<RequirementDetail>(`/requirements/${id}`);
export const updateRequirement = (id: number, patch: Partial<RequirementInput>) =>
  request<RequirementDetail>(`/requirements/${id}`, { method: 'PATCH', json: patch });
export const transitionRequirement = (id: number, action: 'approve' | 'obsolete') =>
  request<RequirementDetail>(`/requirements/${id}/transition`, {
    method: 'POST',
    json: { action },
  });
export const deleteRequirement = (id: number) =>
  request<void>(`/requirements/${id}`, { method: 'DELETE' });
export const addRequirementLink = (
  id: number,
  target: { partId?: number; documentId?: number }
) => request<RequirementDetail>(`/requirements/${id}/links`, { method: 'POST', json: target });
export const removeRequirementLink = (linkId: number) =>
  request<void>(`/requirement-links/${linkId}`, { method: 'DELETE' });
export const getRequirementMatrix = () => request<RequirementMatrix>('/requirements/matrix');
export const getPartRequirements = (partId: number) =>
  request<RequirementSummary[]>(`/parts/${partId}/requirements`);

// ---- requirements: ReqIF interchange ----

/**
 * Direct download URL for every requirement the caller may read, as ReqIF.
 *
 * A plain string rather than a function because the endpoint takes no arguments — and that is
 * itself worth knowing at the call site: the export is not scoped by whatever search or filter
 * the list happens to be showing.
 */
export const requirementsReqifExportUrl = '/api/requirements/export/reqif';

/**
 * Import a ReqIF file. ADMIN and ENGINEER only; a VIEWER is refused with 403.
 *
 * Read the `unknownAttributesDropped` count in the result and show it. Attributes the file
 * carries that this data model has nowhere to put are dropped, and the count is the only
 * trace of that; see ReqifImportResult.
 */
export const importRequirementsReqif = (file: File) => {
  const form = new FormData();
  form.set('file', file);
  return requestForm<ReqifImportResult>('/requirements/import/reqif', form);
};

// ---- workflow engine ----
export const listWorkflowTemplates = () =>
  request<WorkflowTemplateDetail[]>('/workflow-templates');

export interface WorkflowTemplateInput {
  name: string;
  description?: string | null;
  active?: boolean;
  steps?: { name: string; rule: WorkflowRule; role?: string | null; userIds?: number[] }[];
}

export const createWorkflowTemplate = (input: WorkflowTemplateInput) =>
  request<WorkflowTemplateDetail>('/workflow-templates', { method: 'POST', json: input });
export const updateWorkflowTemplate = (id: number, input: Partial<WorkflowTemplateInput>) =>
  request<WorkflowTemplateDetail>(`/workflow-templates/${id}`, { method: 'PATCH', json: input });
export const deleteWorkflowTemplate = (id: number) =>
  request<void>(`/workflow-templates/${id}`, { method: 'DELETE' });
export const getEcnWorkflow = (ecnId: number) =>
  request<EcnWorkflowDetail | null>(`/ecns/${ecnId}/workflow`);
export const decideWorkflowTask = (
  taskId: number,
  decision: 'approve' | 'reject',
  comment?: string
) =>
  request<EcnWorkflowDetail>(`/workflow-tasks/${taskId}/decision`, {
    method: 'POST',
    json: { decision, comment },
  });

// ---- email ----
export const getEmailStatus = () => request<EmailStatus>('/email/status');
export const sendTestEmail = () => request<{ ok: boolean; to: string }>('/email/test', { method: 'POST' });

// ---- integration: API keys ----
export const listApiKeys = () => request<ApiKeySummary[]>('/api-keys');
export const createApiKey = (input: { name: string; scopes: 'read' | 'write' }) =>
  request<ApiKeyCreated>('/api-keys', { method: 'POST', json: input });
export const revokeApiKey = (id: number) =>
  request<ApiKeySummary>(`/api-keys/${id}/revoke`, { method: 'POST' });

// ---- integration: webhooks ----
export const listWebhooks = () => request<WebhookSummary[]>('/webhooks');
export const createWebhook = (input: { name: string; url: string; events: string[] }) =>
  request<WebhookCreated>('/webhooks', { method: 'POST', json: input });
export const updateWebhook = (
  id: number,
  patch: { name?: string; url?: string; events?: string[]; active?: boolean }
) => request<WebhookSummary>(`/webhooks/${id}`, { method: 'PATCH', json: patch });
export const deleteWebhook = (id: number) => request<void>(`/webhooks/${id}`, { method: 'DELETE' });
export const testWebhook = (id: number) =>
  request<{ queued: boolean }>(`/webhooks/${id}/test`, { method: 'POST' });
export const listWebhookEvents = () => request<string[]>('/webhook-events');

// ---- ERP exchange ----
export const erpItemsUrl = (format: 'csv' | 'json' = 'csv') => `/api/erp/items.${format}`;
export const erpBomUrl = (revisionId: number, format: 'csv' | 'json' = 'csv') =>
  `/api/erp/bom/${revisionId}.${format}`;
export const importParts = (csv: string, dryRun: boolean) =>
  request<ImportResult>('/erp/import/parts', { method: 'POST', json: { csv, dryRun } });
export const importBom = (revisionId: number, csv: string, dryRun: boolean) =>
  request<ImportResult>(`/erp/import/bom/${revisionId}`, {
    method: 'POST',
    json: { csv, dryRun },
  });

// ---- variants & configuration ----
export const listOptionGroups = (partId: number) =>
  request<OptionGroupDetail[]>(`/parts/${partId}/option-groups`);
export const createOptionGroup = (
  partId: number,
  input: { code: string; name: string; description?: string; required?: boolean; multiSelect?: boolean }
) => request<OptionGroupDetail>(`/parts/${partId}/option-groups`, { method: 'POST', json: input });
export const deleteOptionGroup = (groupId: number) =>
  request<void>(`/option-groups/${groupId}`, { method: 'DELETE' });
export const createOptionValue = (
  groupId: number,
  input: { code: string; name: string; isDefault?: boolean }
) => request<OptionGroupDetail>(`/option-groups/${groupId}/values`, { method: 'POST', json: input });
export const deleteOptionValue = (valueId: number) =>
  request<void>(`/option-values/${valueId}`, { method: 'DELETE' });
export const setBomLineOptions = (lineId: number, optionValueIds: number[]) =>
  request<{ optionValueIds: number[] }>(`/bom-lines/${lineId}/options`, {
    method: 'PUT',
    json: { optionValueIds },
  });
export const resolveVariant = (
  revisionId: number,
  selections: { groupCode: string; valueCodes: string[] }[]
) =>
  request<VariantResolution>(`/revisions/${revisionId}/resolve-variant`, {
    method: 'POST',
    json: { selections },
  });

// ---- analytics ----
export const getAnalytics = () => request<AnalyticsKpis>('/analytics');

// ---- CAD derivatives ----
/** GLB derivative URL for a converted CAD version (only when hasGlb). */
export const documentVersionGlbUrl = (versionId: number) =>
  `/api/document-versions/${versionId}/glb`;
export const convertDocumentVersion = (versionId: number) =>
  request<DocumentVersionDetail>(`/document-versions/${versionId}/convert`, { method: 'POST' });

// ---- CAD-driven BOM and eBOM/mBOM reconciliation ----
/** Product hierarchy of a CAD version, with each node matched to a part where possible. */
export const getCadAssembly = (versionId: number) =>
  request<CadAssembly>(`/document-versions/${versionId}/assembly`);
/** Re-run extraction for this CAD version and return the fresh snapshot. */
export const refreshCadAssembly = (versionId: number) =>
  request<CadAssembly>(`/document-versions/${versionId}/assembly/refresh`, { method: 'POST' });
/** cBOM vs cBOM: what changed in the model between two CAD versions. */
export const getCadDiff = (fromVersionId: number, toVersionId: number) =>
  request<CadStructureDiff>(`/document-versions/${fromVersionId}/cad-diff/${toVersionId}`);
/** cBOM vs eBOM: does what was modelled match what engineering released? */
export const getCbomReconciliation = (revisionId: number, documentVersionId?: number) => {
  const qs = documentVersionId ? `?documentVersionId=${documentVersionId}` : '';
  return request<CbomReconciliation>(`/revisions/${revisionId}/cbom-reconciliation${qs}`);
};
/**
 * Diff a CAD assembly's top level against this revision's eBOM. Omit `apply` for a dry
 * run — nothing is written and the revision need not be IN_WORK.
 */
export const bomFromCad = (
  revisionId: number,
  input: {
    documentVersionId: number;
    apply?: boolean;
    removeMissing?: boolean;
    createMissingParts?: boolean;
    /** Import the whole tree, each sub-assembly into its own part's In Work revision. */
    recursive?: boolean;
  }
) => request<CadBomProposal>(`/revisions/${revisionId}/bom-from-cad`, { method: 'POST', json: input });
export const generatePlanFromBom = (revisionId: number) =>
  request<ProcessPlanDetail>(`/revisions/${revisionId}/process-plan/from-bom`, { method: 'POST' });
export const getBomReconciliation = (revisionId: number) =>
  request<BomReconciliation>(`/revisions/${revisionId}/bom-reconciliation`);

// ---- quality: nonconformance ----
export const listNcrs = (params: { status?: NcrStatus; search?: string; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.search) qs.set('search', params.search);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<NcrSummary>>(`/ncrs${qs.toString() ? `?${qs}` : ''}`);
};
export const createNcr = (input: {
  title: string;
  description: string;
  severity?: NcrSeverity;
  partId?: number;
  partRevisionId?: number;
  quantityAffected?: number;
  lotOrSerial?: string;
  /** Links the NCR to a tracked unit (rule U7); `lotOrSerial` remains free text. */
  buildUnitId?: number;
}) => request<NcrDetail>('/ncrs', { method: 'POST', json: input });
export const getNcr = (id: number) => request<NcrDetail>(`/ncrs/${id}`);
export const updateNcr = (
  id: number,
  patch: {
    title?: string;
    description?: string;
    severity?: NcrSeverity;
    disposition?: EcnDisposition | null;
    quantityAffected?: number | null;
    lotOrSerial?: string | null;
    buildUnitId?: number | null;
    capaId?: number | null;
  }
) => request<NcrDetail>(`/ncrs/${id}`, { method: 'PATCH', json: patch });
export const transitionNcr = (id: number, action: 'contain' | 'close' | 'reopen') =>
  request<NcrDetail>(`/ncrs/${id}/transition`, { method: 'POST', json: { action } });
/** Raise an ECN from an NCR and link them. */
export const escalateNcrToEcn = (id: number) => request<NcrDetail>(`/ncrs/${id}/escalate`, { method: 'POST' });

// ---- quality: CAPA ----
export const listCapas = (params: { status?: CapaStatus; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<CapaSummary>>(`/capas${qs.toString() ? `?${qs}` : ''}`);
};
export const createCapa = (input: { title: string; problem: string; ownerId: number; dueDate?: string }) =>
  request<CapaDetail>('/capas', { method: 'POST', json: input });
export const getCapa = (id: number) => request<CapaDetail>(`/capas/${id}`);
export const updateCapa = (
  id: number,
  patch: {
    title?: string;
    problem?: string;
    rootCause?: string | null;
    containment?: string | null;
    correctiveAction?: string | null;
    preventiveAction?: string | null;
    ownerId?: number;
    dueDate?: string | null;
  }
) => request<CapaDetail>(`/capas/${id}`, { method: 'PATCH', json: patch });
export const transitionCapa = (id: number, action: 'start' | 'verify' | 'close' | 'reopen') =>
  request<CapaDetail>(`/capas/${id}/transition`, { method: 'POST', json: { action } });

// ---- phase-gate projects ----
export const listProjects = (params: { status?: ProjectStatus; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<ProjectSummary>>(`/projects${qs.toString() ? `?${qs}` : ''}`);
};
export const createProject = (input: {
  code: string;
  name: string;
  description?: string;
  ownerId: number;
  startDate?: string;
  targetDate?: string;
  /** Optional starting phases; a default gate set is created when omitted. */
  phases?: { name: string; gateCriteria?: string }[];
}) => request<ProjectDetail>('/projects', { method: 'POST', json: input });
export const getProject = (id: number) => request<ProjectDetail>(`/projects/${id}`);
export const updateProject = (
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    status?: ProjectStatus;
    ownerId?: number;
    startDate?: string | null;
    targetDate?: string | null;
  }
) => request<ProjectDetail>(`/projects/${id}`, { method: 'PATCH', json: patch });
export const addProjectPhase = (
  projectId: number,
  input: { name: string; gateCriteria?: string; targetDate?: string }
) => request<ProjectDetail>(`/projects/${projectId}/phases`, { method: 'POST', json: input });
export const passPhaseGate = (phaseId: number) =>
  request<ProjectDetail>(`/project-phases/${phaseId}/pass`, { method: 'POST' });
export const addDeliverable = (
  phaseId: number,
  input: {
    name: string;
    required?: boolean;
    ownerId?: number;
    dueDate?: string;
    partId?: number;
    documentId?: number;
    requirementId?: number;
    ecnId?: number;
    notes?: string;
  }
) => request<ProjectDetail>(`/project-phases/${phaseId}/deliverables`, { method: 'POST', json: input });
export const updateDeliverable = (
  id: number,
  patch: { status?: DeliverableStatus; name?: string; ownerId?: number | null; dueDate?: string | null; notes?: string | null }
) => request<ProjectDetail>(`/deliverables/${id}`, { method: 'PATCH', json: patch });
export const deleteDeliverable = (id: number) => request<void>(`/deliverables/${id}`, { method: 'DELETE' });

// ---- supplier RFQ ----
export const listSuppliers = () => request<SupplierSummary[]>('/suppliers');
export const createSupplier = (input: {
  code: string;
  name: string;
  contactName?: string;
  contactEmail?: string;
  notes?: string;
}) => request<SupplierSummary>('/suppliers', { method: 'POST', json: input });
export const updateSupplier = (
  id: number,
  patch: { name?: string; contactName?: string | null; contactEmail?: string | null; notes?: string | null; active?: boolean }
) => request<SupplierSummary>(`/suppliers/${id}`, { method: 'PATCH', json: patch });
export const listRfqs = (params: { status?: RfqStatus; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<RfqSummary>>(`/rfqs${qs.toString() ? `?${qs}` : ''}`);
};
export const createRfq = (input: { title: string; description?: string; dueDate?: string }) =>
  request<RfqDetail>('/rfqs', { method: 'POST', json: input });
export const getRfq = (id: number) => request<RfqDetail>(`/rfqs/${id}`);
export const updateRfq = (
  id: number,
  patch: { title?: string; description?: string | null; dueDate?: string | null }
) => request<RfqDetail>(`/rfqs/${id}`, { method: 'PATCH', json: patch });
export const transitionRfq = (id: number, action: 'send' | 'close' | 'cancel') =>
  request<RfqDetail>(`/rfqs/${id}/transition`, { method: 'POST', json: { action } });
export const addRfqLine = (
  rfqId: number,
  input: { partId: number; quantity: number; targetPrice?: number; notes?: string }
) => request<RfqDetail>(`/rfqs/${rfqId}/lines`, { method: 'POST', json: input });
export const deleteRfqLine = (lineId: number) => request<void>(`/rfq-lines/${lineId}`, { method: 'DELETE' });
export const addQuote = (
  lineId: number,
  input: { supplierId: number; unitPrice: number; currency?: string; leadTimeDays?: number; moq?: number; notes?: string }
) => request<RfqDetail>(`/rfq-lines/${lineId}/quotes`, { method: 'POST', json: input });
export const deleteQuote = (quoteId: number) => request<void>(`/rfq-quotes/${quoteId}`, { method: 'DELETE' });
export const awardRfqLine = (lineId: number, supplierId: number) =>
  request<RfqDetail>(`/rfq-lines/${lineId}/award`, { method: 'POST', json: { supplierId } });

// ---- dashboard ----
export const getStats = () => request<DashboardStats>('/stats');

// ---- electronic signatures ----
const SIGN_PATHS: Record<SignedEntityType, string> = {
  ECN: 'ecns',
  REVISION: 'revisions',
  DOCUMENT: 'documents',
};
export const getSignatureManifest = (entityType: SignedEntityType, entityId: number) =>
  request<SignatureManifest>(`/${SIGN_PATHS[entityType]}/${entityId}/signatures`);
/**
 * Execute a signature. Accounts with a password send `password`; SSO-only accounts have
 * none and send `confirmEmail` instead. Returns the refreshed manifest.
 */
export const signEntity = (
  entityType: SignedEntityType,
  entityId: number,
  input: { meaning: SignatureMeaning; password?: string; confirmEmail?: string; comment?: string }
) =>
  request<SignatureManifest>(`/${SIGN_PATHS[entityType]}/${entityId}/signatures`, {
    method: 'POST',
    json: input,
    keepSessionOn401: true,
  });
export const listSignatureRequirements = (entityType?: SignedEntityType) =>
  request<SignatureRequirement[]>(
    `/signature-requirements${entityType ? `?entityType=${entityType}` : ''}`
  );
export const createSignatureRequirement = (input: {
  entityType: SignedEntityType;
  meaning: SignatureMeaning;
  seq?: number;
  role?: Role;
  userId?: number;
}) => request<SignatureRequirement>('/signature-requirements', { method: 'POST', json: input });
export const updateSignatureRequirement = (
  id: number,
  patch: { active?: boolean; seq?: number; role?: Role | null; userId?: number | null }
) =>
  request<SignatureRequirement>(`/signature-requirements/${id}`, { method: 'PATCH', json: patch });
export const deleteSignatureRequirement = (id: number) =>
  request<void>(`/signature-requirements/${id}`, { method: 'DELETE' });

// ---- supplier portal: internal side ----
export const listSupplierUsers = (supplierId: number) =>
  request<SupplierUserAccount[]>(`/suppliers/${supplierId}/users`);
export const createSupplierUser = (supplierId: number, input: { email: string; name: string }) =>
  request<SupplierUserWithInvite>(`/suppliers/${supplierId}/users`, { method: 'POST', json: input });
export const resetSupplierInvite = (id: number) =>
  request<SupplierUserWithInvite>(`/supplier-users/${id}/reset-invite`, { method: 'POST' });
export const updateSupplierUser = (id: number, patch: { active?: boolean; name?: string }) =>
  request<SupplierUserAccount>(`/supplier-users/${id}`, { method: 'PATCH', json: patch });
export const listRfqInvitations = (rfqId: number) =>
  request<RfqInvitation[]>(`/rfqs/${rfqId}/invitations`);
export const inviteSupplier = (rfqId: number, supplierId: number) =>
  request<RfqInvitation>(`/rfqs/${rfqId}/invitations`, { method: 'POST', json: { supplierId } });
export const revokeInvitation = (id: number) =>
  request<void>(`/rfq-invitations/${id}`, { method: 'DELETE' });

// ---- supplier portal: portal side ----
// These carry the portal cookie, not the internal one, and must never trigger the
// internal session-expiry redirect.
export const portalLogin = (email: string, password: string) =>
  request<PortalIdentity>('/portal/login', {
    method: 'POST',
    json: { email, password },
    keepSessionOn401: true,
  });
export const portalAcceptInvite = (token: string, password: string) =>
  request<PortalIdentity>('/portal/accept-invite', {
    method: 'POST',
    json: { token, password },
    keepSessionOn401: true,
  });
export const portalLogout = () =>
  request<void>('/portal/logout', { method: 'POST', keepSessionOn401: true });
export const portalMe = () => request<PortalIdentity>('/portal/me', { keepSessionOn401: true });
export const portalListRfqs = () =>
  request<PortalRfqSummary[]>('/portal/rfqs', { keepSessionOn401: true });
export const portalGetRfq = (id: number) =>
  request<PortalRfqDetail>(`/portal/rfqs/${id}`, { keepSessionOn401: true });
export const portalSubmitQuote = (
  lineId: number,
  input: { unitPrice: number; currency?: string; leadTimeDays?: number; moq?: number; notes?: string }
) =>
  request<PortalRfqDetail>(`/portal/rfq-lines/${lineId}/quotes`, {
    method: 'POST',
    json: input,
    keepSessionOn401: true,
  });
export const portalWithdrawQuote = (quoteId: number) =>
  request<PortalRfqDetail>(`/portal/rfq-quotes/${quoteId}`, {
    method: 'DELETE',
    keepSessionOn401: true,
  });

// ---- build units: serial / lot tracking (rules U1–U3) ----
export interface ListBuildUnitsParams {
  kind?: BuildKind;
  status?: BuildStatus;
  partId?: number;
  /** Matches the identifier. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export const listBuildUnits = (params: ListBuildUnitsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.kind) qs.set('kind', params.kind);
  if (params.status) qs.set('status', params.status);
  if (params.partId) qs.set('partId', String(params.partId));
  if (params.search) qs.set('search', params.search);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<BuildUnitSummary>>(`/build-units${qs.toString() ? `?${qs}` : ''}`);
};

export interface CreateBuildUnitInput {
  kind: BuildKind;
  /** Omit to have the server generate `SN-10001` / `LOT-10001` upwards. */
  identifier?: string;
  partId: number;
  /** Must belong to `partId` and be RELEASED — production is not built to a draft. */
  partRevisionId: number;
  /** SERIAL requires exactly 1; LOT requires > 0. */
  quantity?: number;
  notes?: string;
}

export const createBuildUnit = (input: CreateBuildUnitInput) =>
  request<BuildUnitDetail>('/build-units', { method: 'POST', json: input });
export const getBuildUnit = (id: number) => request<BuildUnitDetail>(`/build-units/${id}`);
/** Rejected with 409 once the unit is SHIPPED or SCRAPPED. */
export const updateBuildUnit = (
  id: number,
  patch: {
    identifier?: string;
    partRevisionId?: number;
    quantity?: number;
    notes?: string | null;
  }
) => request<BuildUnitDetail>(`/build-units/${id}`, { method: 'PATCH', json: patch });
export const transitionBuildUnit = (id: number, action: BuildUnitTransitionAction) =>
  request<BuildUnitDetail>(`/build-units/${id}/transition`, { method: 'POST', json: { action } });

/**
 * Record that `childId` went into this unit. The parent must be IN_PROGRESS and the child
 * COMPLETED or SHIPPED. Omitting `bomLineId` records an unplanned consumption, which is
 * allowed — the point is to capture what actually happened.
 */
export const addAsBuiltLine = (
  id: number,
  input: { childId: number; quantity: number; bomLineId?: number }
) => request<BuildUnitDetail>(`/build-units/${id}/as-built`, { method: 'POST', json: input });
export const deleteAsBuiltLine = (lineId: number) =>
  request<void>(`/as-built-lines/${lineId}`, { method: 'DELETE' });

// ---- traceability: genealogy, recall and deviations (rules U4–U5) ----
/** Backward trace: what went into this unit, recursively. */
export const getBuildUnitGenealogy = (id: number) =>
  request<GenealogyNode>(`/build-units/${id}/genealogy`);
/** Forward trace: every unit this one ended up in — the recall query. */
export const getBuildUnitWhereConsumed = (id: number) =>
  request<WhereConsumedResult>(`/build-units/${id}/where-consumed`);
/** As-built vs as-designed: the unit's consumption against the eBOM of its revision. */
export const getBuildUnitDeviations = (id: number) =>
  request<DeviationReport>(`/build-units/${id}/deviations`);

// ---- vendor catalog import ----

/**
 * Stages the file and every source row verbatim; nothing is written to Part, Manufacturer or
 * ManufacturerPart until commit. 400 `Unsupported file type` for anything but
 * .csv/.tsv/.xlsx/.xml, 400 `The file has no data rows` for a header-only file, 413 over 25 MB.
 */
export const uploadCatalogImport = (file: File) => {
  const form = new FormData();
  form.set('file', file);
  return requestForm<CatalogImportDetail>('/catalog-imports', form);
};

export const listCatalogImports = (params: { page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<CatalogImportSummary>>(`/catalog-imports${suffix}`);
};

export const getCatalogImport = (id: number) =>
  request<CatalogImportDetail>(`/catalog-imports/${id}`);

/** 409 once the import is COMMITTED: it is the record of what entered the system. */
export const deleteCatalogImport = (id: number) =>
  request<void>(`/catalog-imports/${id}`, { method: 'DELETE' });

export interface ValidateCatalogImportInput {
  /** A saved mapping to apply. */
  mappingId?: number;
  /** Target field -> source column name. `name` and `mpn` are the only required targets. */
  fieldMap?: Partial<Record<CatalogTargetField, string>>;
  /** Literal values for fields the file does not carry, e.g. { category: 'PURCHASED' }. */
  defaults?: Partial<Record<CatalogTargetField, string>>;
}

/**
 * Classifies every row and moves the import to VALIDATED. Re-runnable with a different
 * mapping — each run replaces the previous classification and still writes nothing.
 */
export const validateCatalogImport = (id: number, input: ValidateCatalogImportInput = {}) =>
  request<CatalogImportDetail>(`/catalog-imports/${id}/validate`, { method: 'POST', json: input });

export interface CommitCatalogImportInput {
  /** Without it, rows naming an unknown manufacturer fail individually and the rest commit. */
  createMissingManufacturers?: boolean;
  /** Without it, UPDATE rows are left untouched; only NEW rows are written. */
  updateExisting?: boolean;
}

/**
 * 409 unless the import is VALIDATED. Partial success is honest: status COMMITTED with a
 * non-zero `counts.failed` when only some eligible rows landed, FAILED when none did.
 */
export const commitCatalogImport = (id: number, input: CommitCatalogImportInput = {}) =>
  request<CatalogImportDetail>(`/catalog-imports/${id}/commit`, { method: 'POST', json: input });

export const listCatalogImportRows = (
  id: number,
  params: { status?: CatalogRowStatus; page?: number; pageSize?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<Paged<CatalogImportRow>>(`/catalog-imports/${id}/rows${suffix}`);
};

/** Per-row skip in the preview step; `NEW` puts a skipped row back in the commit. */
export const updateCatalogImportRow = (id: number, status: 'SKIPPED' | 'NEW') =>
  request<CatalogImportRow>(`/catalog-import-rows/${id}`, { method: 'PATCH', json: { status } });

// ---- vendor catalog mappings ----

export const listCatalogMappings = () => request<CatalogMapping[]>('/catalog-mappings');

export interface CreateCatalogMappingInput {
  name: string;
  vendor?: string;
  format: CatalogFormat;
  fieldMap?: Partial<Record<CatalogTargetField, string>>;
  defaults?: Partial<Record<CatalogTargetField, string>>;
  /** The header signature that identifies this vendor's export. */
  headerSignature?: string[];
  /** Seeds `fieldMap` from that import — the normal path to a house mapping. */
  fromImportId?: number;
}

export const createCatalogMapping = (input: CreateCatalogMappingInput) =>
  request<CatalogMapping>('/catalog-mappings', { method: 'POST', json: input });

/** 409 `<name> is a built-in mapping`: the seeded presets are read-only. */
export const updateCatalogMapping = (
  id: number,
  patch: {
    name?: string;
    vendor?: string | null;
    format?: CatalogFormat;
    fieldMap?: Partial<Record<CatalogTargetField, string>>;
    defaults?: Partial<Record<CatalogTargetField, string>> | null;
    headerSignature?: string[];
  }
) => request<CatalogMapping>(`/catalog-mappings/${id}`, { method: 'PATCH', json: patch });

export const deleteCatalogMapping = (id: number) =>
  request<void>(`/catalog-mappings/${id}`, { method: 'DELETE' });

// ---- design review markup (rules K1–K4) ----

/** Oldest first, each with its comment thread. */
export const listMarkups = (documentVersionId: number, status?: MarkupStatus) =>
  request<MarkupDetail[]>(
    `/document-versions/${documentVersionId}/markups${status ? `?status=${status}` : ''}`
  );

export interface CreateMarkupInput {
  kind: MarkupKind;
  /**
   * Shape is fixed by `kind` (rule K1): `PIN_3D` a point plus the camera, `BOX_2D` /
   * `POINT_2D` normalized 0–1 coordinates, `NOTE` an empty object. Out-of-range
   * coordinates are a 400, never clamped.
   */
  geometry: Record<string, unknown>;
  /** The opening comment. Required — an anchor with nothing said is noise. */
  body: string;
  page?: number;
}

export const createMarkup = (documentVersionId: number, input: CreateMarkupInput) =>
  request<MarkupDetail>(`/document-versions/${documentVersionId}/markups`, {
    method: 'POST',
    json: input,
  });
/** Author or ADMIN only; `body` edits the opening comment. */
export const updateMarkup = (
  id: number,
  patch: { geometry?: Record<string, unknown>; body?: string }
) => request<MarkupDetail>(`/markups/${id}`, { method: 'PATCH', json: patch });
/** Author or ADMIN; takes the thread with it. */
export const deleteMarkup = (id: number) => request<void>(`/markups/${id}`, { method: 'DELETE' });
export const addMarkupComment = (id: number, body: string) =>
  request<MarkupComment>(`/markups/${id}/comments`, { method: 'POST', json: { body } });
export const transitionMarkup = (id: number, action: MarkupTransition) =>
  request<MarkupDetail>(`/markups/${id}/transition`, { method: 'POST', json: { action } });
/** Raise an ECR from the markup and link it; 409 when it already has one. */
export const escalateMarkup = (id: number) =>
  request<MarkupDetail>(`/markups/${id}/escalate`, { method: 'POST' });
/** Still-OPEN markups the caller opened or commented on. */
export const getMyMarkups = () => request<MarkupDetail[]>('/my-markups');

// ---- service and as-maintained records (rules G1–G4) ----

export interface ListServiceRecordsParams {
  buildUnitId?: number;
  status?: ServiceStatus;
  kind?: ServiceKind;
  search?: string;
  page?: number;
  pageSize?: number;
}

export const listServiceRecords = (params: ListServiceRecordsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.buildUnitId) qs.set('buildUnitId', String(params.buildUnitId));
  if (params.status) qs.set('status', params.status);
  if (params.kind) qs.set('kind', params.kind);
  if (params.search) qs.set('search', params.search);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  return request<Paged<ServiceRecordSummary>>(
    `/service-records${qs.toString() ? `?${qs}` : ''}`
  );
};

export interface CreateServiceRecordInput {
  /** Must be SHIPPED or COMPLETED: you do not service something that was never finished. */
  buildUnitId: number;
  kind: ServiceKind;
  title: string;
  description?: string;
  reportedAt?: string;
  technicianId?: number;
  /** A field failure is often a nonconformance. */
  ncrId?: number;
  /** An upgrade usually implements a change. */
  ecnId?: number;
}

export const createServiceRecord = (input: CreateServiceRecordInput) =>
  request<ServiceRecordDetail>('/service-records', { method: 'POST', json: input });
export const getServiceRecord = (id: number) =>
  request<ServiceRecordDetail>(`/service-records/${id}`);
/** Refused once the record is CLOSED. */
export const updateServiceRecord = (
  id: number,
  patch: {
    kind?: ServiceKind;
    title?: string;
    description?: string | null;
    reportedAt?: string;
    technicianId?: number | null;
    ncrId?: number | null;
    ecnId?: number | null;
  }
) => request<ServiceRecordDetail>(`/service-records/${id}`, { method: 'PATCH', json: patch });
export const transitionServiceRecord = (id: number, action: ServiceTransition) =>
  request<ServiceRecordDetail>(`/service-records/${id}/transition`, {
    method: 'POST',
    json: { action },
  });

/**
 * Record a swap, which rewrites the as-built graph (rule G2): the removed unit must currently
 * sit inside the serviced unit, the installed one must be COMPLETED and unconsumed. At least
 * one of the two is required.
 */
export const addServicePartSwap = (
  id: number,
  input: {
    removedUnitId?: number;
    installedUnitId?: number;
    /** Free text, e.g. "left motor". */
    position?: string;
    reason: string;
  }
) => request<ServiceRecordDetail>(`/service-records/${id}/swaps`, { method: 'POST', json: input });
export const deleteServicePartSwap = (id: number) =>
  request<void>(`/service-part-swaps/${id}`, { method: 'DELETE' });

/** Current genealogy plus the change log that explains how it got there, newest first. */
export const getBuildUnitAsMaintained = (id: number) =>
  request<AsMaintained>(`/build-units/${id}/as-maintained`);
export const getBuildUnitServiceHistory = (id: number) =>
  request<ServiceRecordSummary[]>(`/build-units/${id}/service-history`);

// ---------------------------------------------------------------------------
// Item-level access control (rules X1-X7)
// ---------------------------------------------------------------------------

export const getItemAccess = (entityType: AclEntityType, id: number) =>
  request<ItemAccess>(`/${ACL_SEGMENTS[entityType]}/${id}/access`);

export interface AddItemGrantInput {
  groupId?: number;
  userId?: number;
  permission: AclPermission;
}

export const addItemGrant = (entityType: AclEntityType, id: number, input: AddItemGrantInput) =>
  request<ItemAccess>(`/${ACL_SEGMENTS[entityType]}/${id}/access`, {
    method: 'POST',
    json: input,
  });

export const removeItemGrant = (grantId: number) =>
  request<void>(`/item-grants/${grantId}`, { method: 'DELETE' });

export const listAccessGroups = () => request<AccessGroupSummary[]>('/access-groups');

export const getAccessGroup = (id: number) => request<AccessGroupDetail>(`/access-groups/${id}`);

export const createAccessGroup = (input: { name: string; description?: string | null }) =>
  request<AccessGroupDetail>('/access-groups', { method: 'POST', json: input });

export const updateAccessGroup = (
  id: number,
  input: { name?: string; description?: string | null; active?: boolean }
) => request<AccessGroupDetail>(`/access-groups/${id}`, { method: 'PATCH', json: input });

export const deleteAccessGroup = (id: number) =>
  request<void>(`/access-groups/${id}`, { method: 'DELETE' });

export const addAccessGroupMember = (groupId: number, userId: number) =>
  request<AccessGroupDetail>(`/access-groups/${groupId}/members`, {
    method: 'POST',
    json: { userId },
  });

export const removeAccessGroupMember = (memberId: number) =>
  request<void>(`/access-group-members/${memberId}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Materials (rules N2-N3)
// ---------------------------------------------------------------------------

export interface ListMaterialsParams {
  search?: string;
  materialClass?: MaterialClass;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

export const listMaterials = (params: ListMaterialsParams = {}) => {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.materialClass) query.set('materialClass', params.materialClass);
  if (params.active !== undefined) query.set('active', String(params.active));
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<Paged<MaterialSummary>>(`/materials${suffix}`);
};

export interface MaterialInput {
  code?: string;
  name?: string;
  materialClass?: MaterialClass;
  specification?: string | null;
  density?: number | null;
  stockUom?: string;
  unitCost?: number | null;
  notes?: string | null;
  active?: boolean;
}

export const createMaterial = (input: MaterialInput) =>
  request<MaterialDetail>('/materials', { method: 'POST', json: input });

export const updateMaterial = (id: number, input: MaterialInput) =>
  request<MaterialDetail>(`/materials/${id}`, { method: 'PATCH', json: input });

export const deleteMaterial = (id: number) =>
  request<void>(`/materials/${id}`, { method: 'DELETE' });

export const listPartMaterials = (partId: number) =>
  request<PartMaterial[]>(`/parts/${partId}/materials`);

export interface PartMaterialInput {
  materialId?: number;
  form?: MaterialForm;
  netQuantity?: number;
  scrapFactor?: number;
  stockSize?: string | null;
  notes?: string | null;
}

export const addPartMaterial = (partId: number, input: PartMaterialInput) =>
  request<PartMaterial[]>(`/parts/${partId}/materials`, { method: 'POST', json: input });

export const updatePartMaterial = (id: number, input: PartMaterialInput) =>
  request<PartMaterial[]>(`/part-materials/${id}`, { method: 'PATCH', json: input });

export const deletePartMaterial = (id: number) =>
  request<void>(`/part-materials/${id}`, { method: 'DELETE' });

export const getMaterialRequirements = (revisionId: number, quantity?: number) =>
  request<MaterialRequirements>(
    `/revisions/${revisionId}/material-requirements${quantity ? `?quantity=${quantity}` : ''}`
  );

export const materialRequirementsCsvUrl = (revisionId: number, quantity?: number) =>
  `/api/revisions/${revisionId}/material-requirements/export.csv${quantity ? `?quantity=${quantity}` : ''}`;
