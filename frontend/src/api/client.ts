import type {
  AmlStatus,
  AnalyticsKpis,
  ApiKeyCreated,
  ApiKeySummary,
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
  CapaDetail,
  CapaStatus,
  CapaSummary,
  CostRollup,
  DashboardStats,
  DeliverableStatus,
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
  ImportResult,
  Lifecycle,
  ManufacturerPartDetail,
  ManufacturerSummary,
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
  SupplierSummary,
  TransitionAction,
  UserInfo,
  UserSummary,
  VariantResolution,
  WebhookCreated,
  WebhookSummary,
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

async function request<T>(path: string, options?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = options ?? {};
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
    if (
      res.status === 401 &&
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
  input: { partId: number; quantity: number; uom?: string; notes?: string }
) =>
  request<OperationMaterialDetail>(`/operations/${opId}/materials`, { method: 'POST', json: input });
export const updateOperationMaterial = (
  materialId: number,
  patch: { quantity?: number; uom?: string; notes?: string | null }
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
