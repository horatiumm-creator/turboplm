import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';
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
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  AsMaintained,
  BuildUnitRef,
  EcnSummary,
  GenealogyNode,
  NcrSummary,
  ServiceKind,
  ServicePartSwap,
  ServiceRecordDetail as ServiceRecordDetailDto,
  ServiceStatus,
  ServiceTransition,
  UserSummary,
} from '../api/types';
import {
  BuildKindTag,
  BuildStatusTag,
  EcnStatusTag,
  formatDate,
  NcrStatusTag,
  SERVICE_KIND_OPTIONS,
  SERVICE_STATUS_META,
  ServiceKindTag,
  ServiceStatusTag,
} from '../components/meta';
import { BuildUnitPicker } from './ServiceRecords';

/** Rule G2 / U3 — an installed unit must be COMPLETED and not already consumed elsewhere. */
const INSTALLABLE_STATUSES = ['COMPLETED'] as const;

/** Mirrors the server's transition table (rule G1) so a button is only offered when it applies. */
const ACTIONS: {
  action: ServiceTransition;
  label: string;
  from: ServiceStatus[];
  danger?: boolean;
}[] = [
  { action: 'start', label: 'Start work', from: ['OPEN'] },
  { action: 'close', label: 'Close', from: ['OPEN', 'IN_PROGRESS'] },
  { action: 'cancel', label: 'Cancel', from: ['OPEN', 'IN_PROGRESS'], danger: true },
  { action: 'reopen', label: 'Reopen', from: ['CLOSED', 'CANCELLED'] },
];

interface EditFormValues {
  kind: ServiceKind;
  title: string;
  description?: string;
  reportedAt?: Dayjs | null;
  technicianId?: number | null;
  ncrId?: number | null;
  ecnId?: number | null;
}

interface SwapFormValues {
  removedUnitId?: number;
  installedUnitId?: number;
  position?: string;
  reason: string;
}

/** Everything currently inside the serviced unit — the only units a swap may remove (rule G2). */
function descendantsOf(root: GenealogyNode): BuildUnitRef[] {
  const out: BuildUnitRef[] = [];
  const walk = (node: GenealogyNode) => {
    for (const child of node.children) {
      out.push(child.unit);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export default function ServiceRecordDetail() {
  const { id: idParam } = useParams();
  const recordId = Number(idParam);
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [record, setRecord] = useState<ServiceRecordDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);

  const reqRef = useRef(0);
  const load = useCallback(async () => {
    if (!Number.isInteger(recordId) || recordId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const id = ++reqRef.current;
    try {
      const detail = await api.getServiceRecord(recordId);
      if (reqRef.current !== id) return; // a newer request has superseded this one
      setRecord(detail);
      setNotFound(false);
    } catch (err) {
      if (reqRef.current !== id) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }, [recordId, message]);

  useEffect(() => {
    setRecord(null);
    setLoading(true);
    void load();
  }, [load]);

  // ---- as-maintained, for the removed-unit picker -------------------------
  // Loaded when the swap modal opens rather than with the page: it is only needed to answer
  // "what is currently inside this unit", and a swap rewrites it, so a stale copy is useless.
  const [asMaintained, setAsMaintained] = useState<AsMaintained | null>(null);
  const [insideLoading, setInsideLoading] = useState(false);
  const asMaintainedReq = useRef(0);

  const loadAsMaintained = useCallback(
    async (buildUnitId: number) => {
      const id = ++asMaintainedReq.current;
      setInsideLoading(true);
      try {
        const res = await api.getBuildUnitAsMaintained(buildUnitId);
        if (asMaintainedReq.current !== id) return;
        setAsMaintained(res);
      } catch (err) {
        if (asMaintainedReq.current === id) {
          setAsMaintained(null);
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      } finally {
        if (asMaintainedReq.current === id) setInsideLoading(false);
      }
    },
    [message]
  );

  const installedInside = useMemo(
    () => (asMaintained ? descendantsOf(asMaintained.current) : []),
    [asMaintained]
  );

  // ---- edit ---------------------------------------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [ncrs, setNcrs] = useState<NcrSummary[]>([]);
  const [ecns, setEcns] = useState<EcnSummary[]>([]);

  // ---- swaps --------------------------------------------------------------
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapSaving, setSwapSaving] = useState(false);
  const [swapForm] = Form.useForm<SwapFormValues>();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !record) {
    return (
      <Empty description="Service record not found">
        <Link to="/service">Back to service</Link>
      </Empty>
    );
  }

  /** PATCH is refused once CLOSED; swaps are refused once CLOSED or CANCELLED. */
  const editable = canEdit && record.status !== 'CLOSED';
  const swappable = canEdit && record.status !== 'CLOSED' && record.status !== 'CANCELLED';

  const openEdit = () => {
    setEditError(null);
    editForm.setFieldsValue({
      kind: record.kind,
      title: record.title,
      description: record.description ?? undefined,
      reportedAt: dayjs(record.reportedAt),
      technicianId: record.technician?.id ?? null,
      ncrId: record.ncr?.id ?? null,
      ecnId: record.ecn?.id ?? null,
    });
    setEditOpen(true);
    void (async () => {
      const [userList, ncrList, ecnList] = await Promise.all([
        api.listUsers().catch(() => []),
        api.listNcrs({ pageSize: 50 }).then((res) => res.items).catch(() => []),
        api.listEcns({ pageSize: 50 }).then((res) => res.items).catch(() => []),
      ]);
      setUsers(userList);
      setNcrs(ncrList);
      setEcns(ecnList);
    })();
  };

  const saveEdit = async () => {
    let values: EditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await api.updateServiceRecord(record.id, {
        kind: values.kind,
        title: values.title.trim(),
        description: values.description?.trim() ? values.description.trim() : null,
        reportedAt: values.reportedAt ? values.reportedAt.toISOString() : undefined,
        technicianId: values.technicianId ?? null,
        ncrId: values.ncrId ?? null,
        ecnId: values.ecnId ?? null,
      });
      setRecord(updated);
      setEditOpen(false);
      message.success(`${updated.serviceNumber} updated`);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  const runTransition = (action: ServiceTransition, label: string, danger?: boolean) => {
    modal.confirm({
      title: `${label} ${record.serviceNumber}?`,
      content:
        action === 'close'
          ? 'A closed record can no longer be edited and takes no further swaps.'
          : action === 'cancel'
            ? 'Cancelling keeps the record and its swaps but stops the work.'
            : undefined,
      okText: label,
      okButtonProps: danger ? { danger: true } : undefined,
      onOk: async () => {
        setActing(true);
        try {
          const updated = await api.transitionServiceRecord(record.id, action);
          setRecord(updated);
          message.success(`${updated.serviceNumber} → ${SERVICE_STATUS_META[updated.status].label}`);
        } catch (err) {
          // The refusals here — wrong status, changed concurrently — explain themselves, so the
          // server's wording is shown verbatim rather than paraphrased.
          modal.error({
            title: `Cannot ${action} ${record.serviceNumber}`,
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        } finally {
          setActing(false);
        }
      },
    });
  };

  const openSwap = () => {
    setSwapError(null);
    swapForm.resetFields();
    setSwapOpen(true);
    void loadAsMaintained(record.buildUnit.id);
  };

  const saveSwap = async () => {
    let values: SwapFormValues;
    try {
      values = await swapForm.validateFields();
    } catch {
      return;
    }
    if (!values.removedUnitId && !values.installedUnitId) {
      setSwapError('A swap must remove a unit, install a unit, or both');
      return;
    }
    setSwapSaving(true);
    setSwapError(null);
    try {
      const updated = await api.addServicePartSwap(record.id, {
        removedUnitId: values.removedUnitId,
        installedUnitId: values.installedUnitId,
        position: values.position?.trim() || undefined,
        reason: values.reason.trim(),
      });
      setRecord(updated);
      setSwapOpen(false);
      message.success('Swap recorded — the as-built graph has been rewritten');
      // The genealogy this modal offered is now out of date by construction.
      setAsMaintained(null);
    } catch (err) {
      setSwapError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSwapSaving(false);
    }
  };

  const removeSwap = (swap: ServicePartSwap) => {
    modal.confirm({
      title: 'Delete swap',
      content:
        'The as-built graph is put back the way it was: an installed unit is detached and a removed one is restored. This cannot be undone.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteServicePartSwap(swap.id);
          message.success('Swap deleted');
          setAsMaintained(null);
          await load();
        } catch (err) {
          modal.error({
            title: 'Could not delete the swap',
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        }
      },
    });
  };

  const unitCell = (unit: BuildUnitRef | null) =>
    unit ? (
      <Space size={6} wrap>
        <Link to={`/build-units/${unit.id}`}>{unit.identifier}</Link>
        <BuildKindTag kind={unit.kind} />
        <BuildStatusTag status={unit.status} />
        <Typography.Text type="secondary">{unit.part.partNumber}</Typography.Text>
      </Space>
    ) : (
      <Typography.Text type="secondary">—</Typography.Text>
    );

  const swapColumns: ColumnsType<ServicePartSwap> = [
    {
      title: 'Removed',
      key: 'removed',
      width: 300,
      render: (_, swap) => unitCell(swap.removedUnit),
    },
    {
      title: 'Installed',
      key: 'installed',
      width: 300,
      render: (_, swap) => unitCell(swap.installedUnit),
    },
    {
      title: 'Position',
      key: 'position',
      width: 150,
      render: (_, swap) => swap.position ?? '—',
    },
    { title: 'Reason', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: 'Performed by',
      key: 'performedBy',
      width: 150,
      render: (_, swap) => swap.performedBy.name,
    },
    {
      title: 'Performed',
      key: 'performedAt',
      width: 150,
      render: (_, swap) => formatDate(swap.performedAt),
    },
    ...(swappable
      ? [
          {
            title: 'Actions',
            key: 'actions',
            width: 110,
            render: (_: unknown, swap: ServicePartSwap) => (
              <Button
                type="link"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeSwap(swap)}
              >
                Delete
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space direction="vertical" size={4}>
            <Space size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {record.serviceNumber} — {record.title}
              </Typography.Title>
              <ServiceKindTag kind={record.kind} />
              <ServiceStatusTag status={record.status} />
            </Space>
            <Space size={8} wrap>
              <Typography.Text type="secondary">Serviced unit</Typography.Text>
              <Link to={`/build-units/${record.buildUnit.id}`}>{record.buildUnit.identifier}</Link>
              <BuildKindTag kind={record.buildUnit.kind} />
              <BuildStatusTag status={record.buildUnit.status} />
              <Link to={`/parts/${record.buildUnit.part.id}`}>
                {record.buildUnit.part.partNumber}
              </Link>
              <Typography.Text type="secondary">{record.buildUnit.part.name}</Typography.Text>
            </Space>
          </Space>
          <Space wrap>
            {editable && (
              <Button icon={<EditOutlined />} onClick={openEdit}>
                Edit
              </Button>
            )}
            {canEdit &&
              ACTIONS.filter((entry) => entry.from.includes(record.status)).map((entry) => (
                <Button
                  key={entry.action}
                  type={entry.action === 'close' ? 'primary' : 'default'}
                  danger={entry.danger}
                  loading={acting}
                  icon={entry.action === 'reopen' ? <ReloadOutlined /> : undefined}
                  onClick={() => runTransition(entry.action, entry.label, entry.danger)}
                >
                  {entry.label}
                </Button>
              ))}
          </Space>
        </div>

        {!canEdit && (
          <ReadOnlyNotice>A Viewer can read this record but not change it or record swaps.</ReadOnlyNotice>
        )}

        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Reported">{formatDate(record.reportedAt)}</Descriptions.Item>
          <Descriptions.Item label="Closed">{formatDate(record.closedAt)}</Descriptions.Item>
          <Descriptions.Item label="Technician">
            {record.technician?.name ?? 'Unassigned'}
          </Descriptions.Item>
          <Descriptions.Item label="Nonconformance">
            {record.ncr ? (
              <Space size={6}>
                <Link to={`/ncrs/${record.ncr.id}`}>{record.ncr.ncrNumber}</Link>
                <NcrStatusTag status={record.ncr.status} />
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="ECN">
            {record.ecn ? (
              <Space size={6}>
                <Link to={`/ecns/${record.ecn.id}`}>{record.ecn.ecnNumber}</Link>
                <EcnStatusTag status={record.ecn.status} />
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Raised by">
            {record.createdBy.name} · {formatDate(record.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {record.description ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title={
          <Space size={8}>
            <SwapOutlined />
            <span>Part swaps</span>
            <Tag>{record.swaps.length}</Tag>
          </Space>
        }
        extra={
          swappable && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openSwap}>
              Record swap
            </Button>
          )
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Every swap rewrites the as-built graph, so the unit's genealogy always matches its
          service history. See the unit's <Link to={`/build-units/${record.buildUnit.id}`}>as
          maintained</Link> view for the whole change log.
        </Typography.Paragraph>
        {record.swaps.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No parts have been swapped on this record"
          />
        ) : (
          <Table<ServicePartSwap>
            size="middle"
            rowKey="id"
            columns={swapColumns}
            dataSource={record.swaps}
            pagination={false}
            scroll={{ x: 1300 }}
          />
        )}
      </Card>

      <Modal
        title={`Edit ${record.serviceNumber}`}
        open={editOpen}
        onOk={() => void saveEdit()}
        okText="Save"
        confirmLoading={editSaving}
        onCancel={() => setEditOpen(false)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={editForm} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="kind"
              label="Kind"
              rules={[{ required: true, message: 'Kind is required' }]}
              style={{ width: 180 }}
            >
              <Select options={SERVICE_KIND_OPTIONS} />
            </Form.Item>
            <Form.Item name="reportedAt" label="Reported" style={{ width: 200 }}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="technicianId" label="Technician" style={{ flex: 1 }}>
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Unassigned"
                options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
            </Form.Item>
          </Space>
          <Form.Item
            name="title"
            label="Title"
            rules={[
              { required: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="ncrId"
              label="Nonconformance"
              tooltip="A field failure is often a nonconformance"
              style={{ flex: 1 }}
            >
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="None"
                options={ncrs.map((n) => ({ value: n.id, label: `${n.ncrNumber} — ${n.title}` }))}
              />
            </Form.Item>
            <Form.Item
              name="ecnId"
              label="ECN"
              tooltip="An upgrade usually implements a change"
              style={{ flex: 1 }}
            >
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="None"
                options={ecns.map((e) => ({ value: e.id, label: `${e.ecnNumber} — ${e.title}` }))}
              />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="Record a part swap"
        open={swapOpen}
        onOk={() => void saveSwap()}
        okText="Record swap"
        confirmLoading={swapSaving}
        onCancel={() => setSwapOpen(false)}
        forceRender
        width={640}
      >
        {swapError && (
          <Alert type="error" showIcon message={swapError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          At least one side is required. The removed unit has to be inside{' '}
          {record.buildUnit.identifier} right now; the installed one has to be COMPLETED and not
          already consumed elsewhere.
        </Typography.Paragraph>
        <Form form={swapForm} layout="vertical">
          <Form.Item
            name="removedUnitId"
            label="Removed unit"
            tooltip="Offered from the serviced unit's current genealogy — nothing else can be removed from it"
          >
            {/* No wrapper element here: Form.Item injects value/onChange into its direct child. */}
            <BuildUnitPicker
              statuses={INSTALLABLE_STATUSES}
              fixedOptions={installedInside}
              allowClear
              disabled={insideLoading}
              placeholder={
                insideLoading
                  ? 'Reading the current genealogy…'
                  : installedInside.length === 0
                    ? 'Nothing is currently installed in this unit'
                    : 'Pick a unit currently installed'
              }
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="installedUnitId"
            label="Installed unit"
            tooltip="Only a COMPLETED unit can be installed"
          >
            <BuildUnitPicker
              statuses={INSTALLABLE_STATUSES}
              allowClear
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="position" label="Position">
            <Input placeholder='Free text, e.g. "left motor" (optional)' />
          </Form.Item>
          <Form.Item
            name="reason"
            label="Reason"
            tooltip="A failure scraps the removed unit; anything else leaves it COMPLETED and reusable"
            rules={[
              { required: true, message: 'A reason is required' },
              { max: 2000, message: 'At most 2000 characters' },
            ]}
          >
            <Input.TextArea rows={3} placeholder="Why the part was swapped" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
