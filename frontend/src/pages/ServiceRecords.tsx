import { useCallback, useEffect, useRef, useState } from 'react';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  BuildStatus,
  BuildUnitRef,
  BuildUnitSummary,
  ServiceKind,
  ServiceRecordSummary,
  ServiceStatus,
  UserSummary,
} from '../api/types';
import {
  BuildStatusTag,
  formatDate,
  SERVICE_KIND_OPTIONS,
  SERVICE_STATUS_OPTIONS,
  SERVICEABLE_BUILD_STATUSES,
  ServiceKindTag,
  ServiceStatusTag,
} from '../components/meta';

/**
 * A searchable build-unit picker, used by the filters, the create modal and — imported from
 * here — the swap modal on the detail page. It lives in this file rather than a new one so the
 * three call sites share one definition of "which units may be offered".
 *
 * `statuses` is a list because rule G1 admits two (SHIPPED or COMPLETED) while an install
 * admits only COMPLETED. `listBuildUnits` filters by a single status, so a multi-status picker
 * asks once per status and merges.
 */
export interface BuildUnitPickerProps {
  value?: number;
  onChange?: (value: number | undefined) => void;
  statuses: readonly BuildStatus[];
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  /** Offered instead of a search, when the candidates are already known (e.g. a genealogy). */
  fixedOptions?: BuildUnitRef[];
}

export function BuildUnitPicker({
  value,
  onChange,
  statuses,
  placeholder = 'Search serial or lot',
  allowClear = false,
  disabled = false,
  style,
  fixedOptions,
}: BuildUnitPickerProps) {
  const [units, setUnits] = useState<BuildUnitSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const reqRef = useRef(0);

  // The dependency is the *contents* of `statuses`, not the array identity: a caller writing
  // `statuses={['COMPLETED']}` inline would otherwise hand us a fresh array on every render and
  // the seeding effect below would refetch forever.
  const statusKey = [...statuses].sort().join(',');

  const fetchUnits = useCallback(
    async (search: string) => {
      const id = ++reqRef.current;
      setLoading(true);
      try {
        const pages = await Promise.all(
          (statusKey.split(',') as BuildStatus[]).map((status) =>
            api.listBuildUnits({ status, search: search || undefined, pageSize: 20 })
          )
        );
        if (reqRef.current !== id) return; // a newer search has superseded this one
        const merged = new Map<number, BuildUnitSummary>();
        for (const page of pages) for (const unit of page.items) merged.set(unit.id, unit);
        setUnits(
          [...merged.values()].sort((a, b) => a.identifier.localeCompare(b.identifier))
        );
      } catch {
        if (reqRef.current === id) setUnits([]);
      } finally {
        if (reqRef.current === id) setLoading(false);
      }
    },
    [statusKey]
  );

  // Options are seeded so the first click already shows candidates; keyed on the status set so
  // a picker reused under a different rule reloads.
  useEffect(() => {
    if (!fixedOptions) void fetchUnits('');
  }, [fetchUnits, fixedOptions]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const options = (fixedOptions ?? units).map((unit) => ({
    value: unit.id,
    label: `${unit.identifier} — ${unit.part.partNumber} ${unit.part.name}`,
  }));

  return (
    <Select
      showSearch
      allowClear={allowClear}
      disabled={disabled}
      style={style}
      placeholder={placeholder}
      value={value}
      onChange={(next: number | undefined) => onChange?.(next)}
      loading={loading}
      // A fixed candidate list is small enough to filter in the browser; a searched one is not.
      filterOption={fixedOptions ? undefined : false}
      optionFilterProp={fixedOptions ? 'label' : undefined}
      onSearch={
        fixedOptions
          ? undefined
          : (search) => {
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void fetchUnits(search), 300);
            }
      }
      options={options}
      notFoundContent={loading ? 'Searching…' : 'No matching units'}
    />
  );
}

interface CreateFormValues {
  buildUnitId: number;
  kind: ServiceKind;
  title: string;
  description?: string;
  reportedAt?: Dayjs | null;
  technicianId?: number;
}

export default function ServiceRecords() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [items, setItems] = useState<ServiceRecordSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ServiceStatus | undefined>(undefined);
  const [kind, setKind] = useState<ServiceKind | undefined>(undefined);
  const [buildUnitId, setBuildUnitId] = useState<number | undefined>(undefined);

  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const res = await api.listServiceRecords({
        search: search || undefined,
        status,
        kind,
        buildUnitId,
        page,
        pageSize,
      });
      if (reqRef.current !== id) return; // a newer request has superseded this one
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (reqRef.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }, [search, status, kind, buildUnitId, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- create -------------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSaving, setCreateSaving] = useState(false);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [users, setUsers] = useState<UserSummary[]>([]);

  const openCreate = () => {
    setCreateError(null);
    createForm.resetFields();
    createForm.setFieldsValue({ kind: 'REPAIR' });
    setCreateOpen(true);
    void (async () => {
      try {
        setUsers(await api.listUsers());
      } catch {
        setUsers([]);
      }
    })();
  };

  const saveCreate = async () => {
    let values: CreateFormValues;
    try {
      values = await createForm.validateFields();
    } catch {
      return;
    }
    setCreateSaving(true);
    setCreateError(null);
    try {
      const created = await api.createServiceRecord({
        buildUnitId: values.buildUnitId,
        kind: values.kind,
        title: values.title.trim(),
        description: values.description?.trim() || undefined,
        reportedAt: values.reportedAt ? values.reportedAt.toISOString() : undefined,
        technicianId: values.technicianId,
      });
      message.success(`${created.serviceNumber} raised`);
      setCreateOpen(false);
      navigate(`/service/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCreateSaving(false);
    }
  };

  const columns: ColumnsType<ServiceRecordSummary> = [
    {
      title: 'Service #',
      key: 'serviceNumber',
      width: 130,
      render: (_, r) => <Link to={`/service/${r.id}`}>{r.serviceNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Unit',
      key: 'unit',
      width: 240,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link to={`/build-units/${r.buildUnit.id}`}>{r.buildUnit.identifier}</Link>
          <BuildStatusTag status={r.buildUnit.status} />
        </Space>
      ),
    },
    {
      title: 'Part',
      key: 'part',
      width: 200,
      ellipsis: true,
      render: (_, r) => (
        <Link to={`/parts/${r.buildUnit.part.id}`}>{r.buildUnit.part.partNumber}</Link>
      ),
    },
    { title: 'Kind', key: 'kind', width: 150, render: (_, r) => <ServiceKindTag kind={r.kind} /> },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, r) => <ServiceStatusTag status={r.status} />,
    },
    {
      title: 'Technician',
      key: 'technician',
      width: 150,
      render: (_, r) => r.technician?.name ?? '—',
    },
    { title: 'Swaps', dataIndex: 'swapCount', key: 'swapCount', width: 90, align: 'right' },
    {
      title: 'Reported',
      key: 'reportedAt',
      width: 150,
      render: (_, r) => formatDate(r.reportedAt),
    },
    { title: 'Closed', key: 'closedAt', width: 150, render: (_, r) => formatDate(r.closedAt) },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Service
        </Typography.Title>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Raise service record
          </Button>
        )}
      </div>

      {!canEdit && (
        <ReadOnlyNotice>A Viewer can read service history but not raise or change records.</ReadOnlyNotice>
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Search number or title"
          allowClear
          style={{ width: 260 }}
          onSearch={(value) => {
            setSearch(value.trim());
            setPage(1);
          }}
        />
        <Select
          placeholder="Status"
          allowClear
          style={{ width: 160 }}
          options={SERVICE_STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <Select
          placeholder="Kind"
          allowClear
          style={{ width: 170 }}
          options={SERVICE_KIND_OPTIONS}
          value={kind}
          onChange={(value) => {
            setKind(value);
            setPage(1);
          }}
        />
        <BuildUnitPicker
          statuses={SERVICEABLE_BUILD_STATUSES}
          placeholder="Any unit"
          allowClear
          style={{ width: 300 }}
          value={buildUnitId}
          onChange={(value) => {
            setBuildUnitId(value);
            setPage(1);
          }}
        />
      </Space>

      <Table<ServiceRecordSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 1500 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} service records`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <Modal
        title="Raise a service record"
        open={createOpen}
        onOk={() => void saveCreate()}
        okText="Raise"
        confirmLoading={createSaving}
        onCancel={() => setCreateOpen(false)}
        forceRender
      >
        {createError && (
          <Alert type="error" showIcon message={createError} style={{ marginBottom: 16 }} />
        )}
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="buildUnitId"
            label="Serviced unit"
            tooltip="Only a unit that was completed or shipped can be serviced"
            rules={[{ required: true, message: 'Choose the unit being serviced' }]}
          >
            <BuildUnitPicker statuses={SERVICEABLE_BUILD_STATUSES} style={{ width: '100%' }} />
          </Form.Item>
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
              <DatePicker showTime style={{ width: '100%' }} placeholder="Now" />
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
            <Input placeholder="What was reported?" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Symptoms, findings, context (optional)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
