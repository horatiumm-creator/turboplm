import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  BuildKind,
  BuildStatus,
  BuildUnitSummary,
  PartRef,
  RevisionSummary,
} from '../api/types';
import {
  BUILD_KIND_OPTIONS,
  BUILD_STATUS_OPTIONS,
  BuildKindTag,
  BuildStatusTag,
  formatDate,
  LifecycleTag,
} from '../components/meta';

interface BuildUnitFormValues {
  kind: BuildKind;
  identifier?: string;
  partId: number;
  partRevisionId: number;
  quantity?: number;
  notes?: string;
}

export default function BuildUnits() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [units, setUnits] = useState<BuildUnitSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<BuildKind | undefined>(undefined);
  const [status, setStatus] = useState<BuildStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const listReq = useRef(0);

  const load = useCallback(async () => {
    const id = ++listReq.current;
    setLoading(true);
    try {
      const res = await api.listBuildUnits({
        kind,
        status,
        search: search || undefined,
        page,
        pageSize,
      });
      if (listReq.current !== id) return; // a newer request has superseded this one
      setUnits(res.items);
      setTotal(res.total);
    } catch (err) {
      if (listReq.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (listReq.current === id) setLoading(false);
    }
  }, [kind, status, search, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- create ---------------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<BuildUnitFormValues>();
  const [formKind, setFormKind] = useState<BuildKind>('SERIAL');

  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const partTimer = useRef<number | undefined>(undefined);

  // Only RELEASED revisions are offered — production hardware is not built to a draft (U1).
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [partPicked, setPartPicked] = useState(false);

  const fetchParts = useCallback(async (value: string) => {
    setPartLoading(true);
    try {
      const res = await api.listParts({ search: value || undefined, pageSize: 20 });
      setPartOptions(res.items);
    } catch {
      setPartOptions([]);
    } finally {
      setPartLoading(false);
    }
  }, []);

  const handlePartSearch = (value: string) => {
    window.clearTimeout(partTimer.current);
    partTimer.current = window.setTimeout(() => void fetchParts(value), 300);
  };

  useEffect(() => () => window.clearTimeout(partTimer.current), []);

  const loadRevisions = useCallback(async (partId: number) => {
    setRevisionsLoading(true);
    try {
      const part = await api.getPart(partId);
      const released = part.revisions.filter((r) => r.lifecycle === 'RELEASED');
      setRevisions(released);
      return released;
    } catch {
      setRevisions([]);
      return [];
    } finally {
      setRevisionsLoading(false);
    }
  }, []);

  const openCreate = () => {
    setCreateError(null);
    form.resetFields();
    form.setFieldsValue({ kind: 'SERIAL', quantity: 1 });
    setFormKind('SERIAL');
    setRevisions([]);
    setPartPicked(false);
    void fetchParts('');
    setCreateOpen(true);
  };

  const onValuesChange = (changed: Partial<BuildUnitFormValues>) => {
    if (changed.kind) {
      setFormKind(changed.kind);
      // A SERIAL unit is exactly one physical object, so its quantity is not a choice.
      form.setFieldsValue({ quantity: changed.kind === 'SERIAL' ? 1 : undefined });
    }
    if (changed.partId !== undefined) {
      setPartPicked(true);
      form.setFieldsValue({ partRevisionId: undefined });
      void (async () => {
        const released = await loadRevisions(changed.partId as number);
        if (released.length === 1) form.setFieldsValue({ partRevisionId: released[0].id });
      })();
    }
  };

  const save = async () => {
    let values: BuildUnitFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setCreateError(null);
    try {
      const created = await api.createBuildUnit({
        kind: values.kind,
        identifier: values.identifier?.trim() || undefined,
        partId: values.partId,
        partRevisionId: values.partRevisionId,
        quantity: values.kind === 'SERIAL' ? 1 : values.quantity,
        notes: values.notes?.trim() || undefined,
      });
      message.success(`${created.identifier} created`);
      setCreateOpen(false);
      navigate(`/build-units/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<BuildUnitSummary> = [
    {
      title: 'Identifier',
      key: 'identifier',
      width: 160,
      render: (_, r) => <Link to={`/build-units/${r.id}`}>{r.identifier}</Link>,
    },
    { title: 'Kind', key: 'kind', width: 90, render: (_, r) => <BuildKindTag kind={r.kind} /> },
    {
      title: 'Part',
      key: 'part',
      ellipsis: true,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link to={`/parts/${r.part.id}`}>{r.part.partNumber}</Link>
          <Typography.Text type="secondary">{r.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Built to',
      key: 'revision',
      width: 150,
      render: (_, r) => (
        <Space size={6}>
          <span>Rev {r.partRevision.revision}</span>
          <LifecycleTag lifecycle={r.partRevision.lifecycle} />
        </Space>
      ),
    },
    {
      title: 'Quantity',
      key: 'quantity',
      width: 100,
      align: 'right',
      render: (_, r) => `${r.quantity} ${r.part.uom}`,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <BuildStatusTag status={r.status} />,
    },
    { title: 'Built', key: 'builtAt', width: 150, render: (_, r) => formatDate(r.builtAt) },
    { title: 'Created', key: 'createdAt', width: 150, render: (_, r) => formatDate(r.createdAt) },
  ];

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Build units
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Serialized units and lots as they were actually built — the as-built record behind every
        genealogy and recall trace.
      </Typography.Paragraph>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Space wrap>
          <Input.Search
            placeholder="Search serial or lot code"
            allowClear
            style={{ width: 260 }}
            onSearch={(v) => {
              setSearch(v.trim());
              setPage(1);
            }}
          />
          <Select
            placeholder="Kind"
            allowClear
            style={{ width: 140 }}
            options={BUILD_KIND_OPTIONS}
            value={kind}
            onChange={(v) => {
              setKind(v);
              setPage(1);
            }}
          />
          <Select
            placeholder="Status"
            allowClear
            style={{ width: 160 }}
            options={BUILD_STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
        </Space>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New build unit
          </Button>
        )}
      </div>

      <Table<BuildUnitSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={units}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} build units`,
          onChange: (p, size) => {
            setPage(size !== pageSize ? 1 : p);
            setPageSize(size);
          },
        }}
      />

      <Modal
        title="New build unit"
        open={createOpen}
        onOk={() => void save()}
        okText="Create"
        confirmLoading={saving}
        onCancel={() => setCreateOpen(false)}
        width={620}
        forceRender
      >
        {createError && (
          <Alert type="error" showIcon message={createError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical" onValuesChange={onValuesChange}>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="kind" label="Kind" style={{ width: 150 }}>
              <Select options={BUILD_KIND_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="quantity"
              label="Quantity"
              style={{ width: 150 }}
              rules={
                formKind === 'LOT'
                  ? [{ required: true, message: 'A lot needs a quantity' }]
                  : undefined
              }
            >
              <InputNumber
                min={formKind === 'SERIAL' ? 1 : 0.001}
                max={formKind === 'SERIAL' ? 1 : undefined}
                disabled={formKind === 'SERIAL'}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item
              name="identifier"
              label="Identifier"
              style={{ flex: 1 }}
              extra={
                formKind === 'SERIAL'
                  ? 'Leave blank and a serial is generated (SN-10001 upwards).'
                  : 'Leave blank and a lot code is generated (LOT-10001 upwards).'
              }
              rules={[{ max: 100 }]}
            >
              <Input placeholder="optional" />
            </Form.Item>
          </Space>
          <Form.Item
            name="partId"
            label="Part"
            rules={[{ required: true, message: 'Select the part being built' }]}
          >
            <Select
              showSearch
              placeholder="Search by part number or name"
              filterOption={false}
              onSearch={handlePartSearch}
              loading={partLoading}
              options={partOptions.map((p) => ({
                value: p.id,
                label: `${p.partNumber} — ${p.name}`,
              }))}
              notFoundContent={partLoading ? 'Searching…' : 'No parts found'}
            />
          </Form.Item>
          <Form.Item
            name="partRevisionId"
            label="Built to revision"
            tooltip="Only released revisions can be built — this is the baseline the deviation report compares against."
            rules={[{ required: true, message: 'Select a released revision' }]}
          >
            <Select
              placeholder={partPicked ? 'Select a released revision' : 'Pick a part first'}
              disabled={!partPicked}
              loading={revisionsLoading}
              options={revisions.map((r) => ({ value: r.id, label: `Rev ${r.revision}` }))}
              notFoundContent={
                revisionsLoading ? 'Loading…' : 'This part has no released revision yet'
              }
            />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} placeholder="Work order, cell, operator — anything worth keeping" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
