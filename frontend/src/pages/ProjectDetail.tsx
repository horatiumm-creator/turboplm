import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import ItemAccessCard from '../components/ItemAccessCard';
import { useAuth } from '../auth/AuthContext';
import type {
  DeliverableDetail,
  DeliverableStatus,
  PhaseDetail,
  ProjectDetail as ProjectDetailData,
  ProjectStatus,
  UserSummary,
} from '../api/types';
import {
  DELIVERABLE_STATUS_META,
  DELIVERABLE_STATUS_OPTIONS,
  formatDate,
  GATE_STATUS_META,
  GateStatusTag,
  PROJECT_STATUS_OPTIONS,
  ProjectStatusTag,
} from '../components/meta';

interface ProjectFormValues {
  name: string;
  description?: string;
  status: ProjectStatus;
  ownerId: number;
  startDate?: Dayjs | null;
  targetDate?: Dayjs | null;
}

interface PhaseFormValues {
  name: string;
  gateCriteria?: string;
  targetDate?: Dayjs | null;
}

interface DeliverableFormValues {
  name: string;
  required: boolean;
  ownerId?: number;
  dueDate?: Dayjs | null;
  notes?: string;
  partId?: number;
  documentId?: number;
  requirementId?: number;
  ecnId?: number;
}

/** Left-rail colour per gate state, so the timeline reads at a glance. */
const GATE_RAIL: Record<PhaseDetail['status'], string> = {
  NOT_STARTED: '#d9d9d9',
  IN_PROGRESS: '#1677ff',
  PASSED: '#52c41a',
  BLOCKED: '#ff4d4f',
};

/** A debounced search Select over one of the linkable entity types. */
function LinkSelect({
  placeholder,
  fetch,
  value,
  onChange,
}: {
  placeholder: string;
  fetch: (search: string) => Promise<{ value: number; label: string }[]>;
  value?: number;
  onChange?: (value: number | undefined) => void;
}) {
  const [options, setOptions] = useState<{ value: number; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const run = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        setOptions(await fetch(search));
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    },
    [fetch]
  );

  useEffect(() => {
    void run('');
    return () => window.clearTimeout(timer.current);
  }, [run]);

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      filterOption={false}
      loading={loading}
      options={options}
      onSearch={(v) => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void run(v), 300);
      }}
      notFoundContent={loading ? 'Searching…' : 'Nothing found'}
    />
  );
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [project, setProject] = useState<ProjectDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<UserSummary[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProject(await api.getProject(projectId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setUsers(await api.listUsers());
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  const userOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
    [users]
  );

  // Every mutating endpoint returns the whole project, so one setter keeps the
  // page consistent without a refetch.
  const apply = async (action: () => Promise<ProjectDetailData>, success: string) => {
    setBusy(true);
    try {
      setProject(await action());
      message.success(success);
      return true;
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ---- edit project --------------------------------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<ProjectFormValues>();

  const openEdit = () => {
    if (!project) return;
    setEditError(null);
    editForm.setFieldsValue({
      name: project.name,
      description: project.description ?? undefined,
      status: project.status,
      ownerId: project.owner.id,
      startDate: project.startDate ? dayjs(project.startDate) : null,
      targetDate: project.targetDate ? dayjs(project.targetDate) : null,
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    let values: ProjectFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      setProject(
        await api.updateProject(projectId, {
          name: values.name.trim(),
          description: values.description?.trim() || null,
          status: values.status,
          ownerId: values.ownerId,
          startDate: values.startDate ? values.startDate.toISOString() : null,
          targetDate: values.targetDate ? values.targetDate.toISOString() : null,
        })
      );
      message.success('Project updated');
      setEditOpen(false);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  // ---- add phase -----------------------------------------------------------
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [phaseSaving, setPhaseSaving] = useState(false);
  const [phaseForm] = Form.useForm<PhaseFormValues>();

  const savePhase = async () => {
    let values: PhaseFormValues;
    try {
      values = await phaseForm.validateFields();
    } catch {
      return;
    }
    setPhaseSaving(true);
    setPhaseError(null);
    try {
      setProject(
        await api.addProjectPhase(projectId, {
          name: values.name.trim(),
          gateCriteria: values.gateCriteria?.trim() || undefined,
          targetDate: values.targetDate ? values.targetDate.toISOString() : undefined,
        })
      );
      message.success('Gate added');
      setPhaseOpen(false);
    } catch (err) {
      setPhaseError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setPhaseSaving(false);
    }
  };

  // ---- add deliverable -----------------------------------------------------
  const [delivPhase, setDelivPhase] = useState<PhaseDetail | null>(null);
  const [delivError, setDelivError] = useState<string | null>(null);
  const [delivSaving, setDelivSaving] = useState(false);
  const [delivForm] = Form.useForm<DeliverableFormValues>();

  const openDeliverable = (phase: PhaseDetail) => {
    setDelivError(null);
    delivForm.resetFields();
    delivForm.setFieldsValue({ required: true });
    setDelivPhase(phase);
  };

  const saveDeliverable = async () => {
    if (!delivPhase) return;
    let values: DeliverableFormValues;
    try {
      values = await delivForm.validateFields();
    } catch {
      return;
    }
    setDelivSaving(true);
    setDelivError(null);
    try {
      setProject(
        await api.addDeliverable(delivPhase.id, {
          name: values.name.trim(),
          required: values.required,
          ownerId: values.ownerId,
          dueDate: values.dueDate ? values.dueDate.toISOString() : undefined,
          notes: values.notes?.trim() || undefined,
          partId: values.partId,
          documentId: values.documentId,
          requirementId: values.requirementId,
          ecnId: values.ecnId,
        })
      );
      message.success('Deliverable added');
      setDelivPhase(null);
    } catch (err) {
      setDelivError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setDelivSaving(false);
    }
  };

  const fetchParts = useCallback(async (search: string) => {
    const res = await api.listParts({ search: search || undefined, pageSize: 20 });
    return res.items.map((p) => ({ value: p.id, label: `${p.partNumber} — ${p.name}` }));
  }, []);
  const fetchDocuments = useCallback(async (search: string) => {
    const res = await api.listDocuments({ search: search || undefined, pageSize: 20 });
    return res.items.map((d) => ({ value: d.id, label: `${d.docNumber} — ${d.title}` }));
  }, []);
  const fetchRequirements = useCallback(async (search: string) => {
    const res = await api.listRequirements({ search: search || undefined, pageSize: 20 });
    return res.items.map((r) => ({ value: r.id, label: `${r.reqNumber} — ${r.title}` }));
  }, []);
  const fetchEcns = useCallback(async (search: string) => {
    const res = await api.listEcns({ search: search || undefined, pageSize: 20 });
    return res.items.map((e) => ({ value: e.id, label: `${e.ecnNumber} — ${e.title}` }));
  }, []);

  // ---- deliverable table ---------------------------------------------------
  const deliverableColumns = (phase: PhaseDetail): ColumnsType<DeliverableDetail> => [
    {
      title: 'Deliverable',
      key: 'name',
      render: (_, d) => (
        <Space size={6} wrap>
          <span>{d.name}</span>
          {!d.required && <Tag>optional</Tag>}
        </Space>
      ),
    },
    {
      title: 'Linked item',
      key: 'link',
      width: 220,
      render: (_, d) => {
        if (d.part) return <Link to={`/parts/${d.part.id}`}>{d.part.partNumber}</Link>;
        if (d.document) return <Link to={`/documents/${d.document.id}`}>{d.document.docNumber}</Link>;
        if (d.requirement)
          return <Link to={`/requirements/${d.requirement.id}`}>{d.requirement.reqNumber}</Link>;
        if (d.ecn) return <Link to={`/ecns/${d.ecn.id}`}>{d.ecn.ecnNumber}</Link>;
        return <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 170,
      render: (_, d) =>
        canEdit && phase.status !== 'PASSED' ? (
          <Select<DeliverableStatus>
            size="small"
            style={{ width: 150 }}
            value={d.status}
            options={DELIVERABLE_STATUS_OPTIONS}
            disabled={busy}
            onChange={(status) =>
              void apply(() => api.updateDeliverable(d.id, { status }), `${d.name} → ${DELIVERABLE_STATUS_META[status].label}`)
            }
          />
        ) : (
          <Tag color={DELIVERABLE_STATUS_META[d.status].color}>
            {DELIVERABLE_STATUS_META[d.status].label}
          </Tag>
        ),
    },
    { title: 'Owner', key: 'owner', width: 150, render: (_, d) => d.owner?.name ?? '—' },
    { title: 'Due', key: 'dueDate', width: 120, render: (_, d) => formatDate(d.dueDate) },
    // A passed gate is a record of what was signed off, so it stays read-only.
    ...(canEdit && phase.status !== 'PASSED'
      ? [
          {
            title: '',
            key: 'actions',
            width: 50,
            render: (_: unknown, d: DeliverableDetail) => (
              <Popconfirm
                title="Remove this deliverable?"
                onConfirm={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await api.deleteDeliverable(d.id);
                      setProject(await api.getProject(projectId));
                      message.success('Deliverable removed');
                    } catch (err) {
                      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (loadError || !project) {
    return <Alert type="error" showIcon message={loadError ?? 'Project not found'} />;
  }

  const gatePercent = project.phaseCount
    ? Math.round((project.passedPhases / project.phaseCount) * 100)
    : 0;

  return (
    <div>
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          message="Read-only access — you can browse this project but not change it."
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Space size={10} wrap align="center">
              <Typography.Title level={3} style={{ margin: 0 }}>
                {project.code} — {project.name}
              </Typography.Title>
              <ProjectStatusTag status={project.status} />
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4 }}>
              Phase-gate project · created by {project.createdBy.name} on{' '}
              {formatDate(project.createdAt)}
            </Typography.Paragraph>
          </div>
          {canEdit && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
          )}
        </div>

        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }} size="small">
          <Descriptions.Item label="Owner">{project.owner.name}</Descriptions.Item>
          <Descriptions.Item label="Start">{formatDate(project.startDate)}</Descriptions.Item>
          <Descriptions.Item label="Target">{formatDate(project.targetDate)}</Descriptions.Item>
          <Descriptions.Item label="Current gate">
            {project.currentPhase ? (
              <Space size={6}>
                {project.currentPhase.name}
                <GateStatusTag status={project.currentPhase.status} />
              </Space>
            ) : (
              'All gates passed'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Gates passed" span={2}>
            <Space size={8} style={{ width: 260 }}>
              <Progress percent={gatePercent} size="small" style={{ width: 160, marginBottom: 0 }} />
              <Typography.Text type="secondary">
                {project.passedPhases}/{project.phaseCount}
              </Typography.Text>
            </Space>
          </Descriptions.Item>
          {project.description && (
            <Descriptions.Item label="Description" span={3}>
              {project.description}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          Gates
        </Typography.Title>
        {canEdit && (
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setPhaseError(null);
              phaseForm.resetFields();
              setPhaseOpen(true);
            }}
          >
            Add gate
          </Button>
        )}
      </div>

      {project.phases.length === 0 ? (
        <Empty description="No gates on this project yet" />
      ) : (
        <Space direction="vertical" size={16} style={{ display: 'flex' }}>
          {project.phases.map((phase, index) => {
            const blocked = phase.blockingCount > 0;
            // Gates are sequential, so an earlier open gate blocks this one too.
            const earlierOpen = project.phases
              .slice(0, index)
              .find((p) => p.status !== 'PASSED');
            const meta = GATE_STATUS_META[phase.status];
            const passHint = earlierOpen
              ? `Pass gate ${earlierOpen.name} first`
              : blocked
                ? 'Complete or waive every required deliverable first'
                : undefined;
            return (
              <Card
                key={phase.id}
                // A coloured left rail makes the gate state readable while scanning.
                style={{ borderLeft: `4px solid ${GATE_RAIL[phase.status]}` }}
                title={
                  <Space size={10} wrap>
                    <Typography.Text type="secondary">Gate {phase.seq}</Typography.Text>
                    <Typography.Text strong>{phase.name}</Typography.Text>
                    <Tag color={meta.color}>{meta.label}</Tag>
                    {blocked && (
                      <Tag color="red">
                        {phase.blockingCount} required deliverable
                        {phase.blockingCount === 1 ? '' : 's'} outstanding
                      </Tag>
                    )}
                  </Space>
                }
                extra={
                  <Space>
                    {canEdit && phase.status !== 'PASSED' && (
                      <Button size="small" onClick={() => openDeliverable(phase)}>
                        Add deliverable
                      </Button>
                    )}
                    {canEdit && phase.status !== 'PASSED' && (
                      <Tooltip title={passHint}>
                        <Button
                          type="primary"
                          size="small"
                          icon={<CheckCircleOutlined />}
                          disabled={blocked || earlierOpen !== undefined || busy}
                          onClick={() =>
                            void apply(() => api.passPhaseGate(phase.id), `${phase.name} passed`)
                          }
                        >
                          Pass gate
                        </Button>
                      </Tooltip>
                    )}
                  </Space>
                }
              >
                <Space direction="vertical" size={8} style={{ display: 'flex' }}>
                  {(phase.gateCriteria || phase.targetDate || phase.passedAt) && (
                    <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small">
                      {phase.gateCriteria && (
                        <Descriptions.Item label="Exit criteria" span={3}>
                          {phase.gateCriteria}
                        </Descriptions.Item>
                      )}
                      {phase.targetDate && (
                        <Descriptions.Item label="Target">
                          {formatDate(phase.targetDate)}
                        </Descriptions.Item>
                      )}
                      {phase.passedAt && (
                        <Descriptions.Item label="Passed">
                          {formatDate(phase.passedAt)}
                          {phase.passedBy ? ` by ${phase.passedBy.name}` : ''}
                        </Descriptions.Item>
                      )}
                    </Descriptions>
                  )}
                  <Table<DeliverableDetail>
                    size="small"
                    rowKey="id"
                    columns={deliverableColumns(phase)}
                    dataSource={phase.deliverables}
                    pagination={false}
                    locale={{ emptyText: 'No deliverables on this gate' }}
                  />
                </Space>
              </Card>
            );
          })}
        </Space>
      )}

      <Modal
        title="Edit project"
        open={editOpen}
        onOk={() => void saveEdit()}
        confirmLoading={editSaving}
        onCancel={() => setEditOpen(false)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Name is required' }, { max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="status" label="Status" style={{ width: 170 }}>
              <Select options={PROJECT_STATUS_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="ownerId"
              label="Owner"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Select an owner' }]}
            >
              <Select showSearch optionFilterProp="label" options={userOptions} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="startDate" label="Start" style={{ width: 190 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="targetDate" label="Target" style={{ width: 190 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="Add gate"
        open={phaseOpen}
        onOk={() => void savePhase()}
        okText="Add"
        confirmLoading={phaseSaving}
        onCancel={() => setPhaseOpen(false)}
        forceRender
      >
        {phaseError && (
          <Alert type="error" showIcon message={phaseError} style={{ marginBottom: 16 }} />
        )}
        <Form form={phaseForm} layout="vertical">
          <Form.Item
            name="name"
            label="Gate name"
            rules={[{ required: true, message: 'Name is required' }, { max: 120 }]}
          >
            <Input placeholder="Ramp-up" />
          </Form.Item>
          <Form.Item name="gateCriteria" label="Exit criteria">
            <Input.TextArea rows={3} placeholder="What must be true to pass this gate?" />
          </Form.Item>
          <Form.Item name="targetDate" label="Target date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Typography.Text type="secondary">
            New gates are appended after the last one.
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={delivPhase ? `Add deliverable to ${delivPhase.name}` : 'Add deliverable'}
        open={delivPhase !== null}
        onOk={() => void saveDeliverable()}
        okText="Add"
        confirmLoading={delivSaving}
        onCancel={() => setDelivPhase(null)}
        width={640}
        forceRender
      >
        {delivError && (
          <Alert type="error" showIcon message={delivError} style={{ marginBottom: 16 }} />
        )}
        <Form form={delivForm} layout="vertical">
          <Form.Item
            name="name"
            label="Deliverable"
            rules={[{ required: true, message: 'Name is required' }, { max: 200 }]}
          >
            <Input placeholder="Design review pack signed off" />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="required"
              label="Required to pass the gate"
              valuePropName="checked"
              style={{ width: 200 }}
            >
              <Switch />
            </Form.Item>
            <Form.Item name="ownerId" label="Owner" style={{ flex: 1 }}>
              <Select showSearch allowClear optionFilterProp="label" options={userOptions} />
            </Form.Item>
            <Form.Item name="dueDate" label="Due" style={{ width: 160 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary">
            Optionally link the PLM item this deliverable is evidenced by.
          </Typography.Text>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 12,
              marginTop: 12,
            }}
          >
            <Form.Item name="partId" label="Part" style={{ marginBottom: 0 }}>
              <LinkSelect placeholder="Search parts" fetch={fetchParts} />
            </Form.Item>
            <Form.Item name="documentId" label="Document" style={{ marginBottom: 0 }}>
              <LinkSelect placeholder="Search documents" fetch={fetchDocuments} />
            </Form.Item>
            <Form.Item name="requirementId" label="Requirement" style={{ marginBottom: 0 }}>
              <LinkSelect placeholder="Search requirements" fetch={fetchRequirements} />
            </Form.Item>
            <Form.Item name="ecnId" label="Change" style={{ marginBottom: 0 }}>
              <LinkSelect placeholder="Search changes" fetch={fetchEcns} />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="Notes" style={{ marginTop: 16 }}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 16 }}>
        <ItemAccessCard entityType="PROJECT" entityId={project.id} />
      </div>
    </div>
  );
}
