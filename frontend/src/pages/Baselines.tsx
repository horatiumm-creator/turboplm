import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DiffOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  BaselineCompareResult,
  BaselineDetail,
  BaselineLineNode,
  BaselineSummary,
  PartRef,
  RevisionSummary,
} from '../api/types';
import CompareResultView from '../components/CompareResultView';
import { LIFECYCLE_META, formatDate } from '../components/meta';

interface NewBaselineValues {
  partId: number;
  partRevisionId: number;
  name: string;
  description?: string;
}

interface BaselineRow {
  key: string;
  node: BaselineLineNode;
  children?: BaselineRow[];
}

function toBaselineRows(nodes: BaselineLineNode[], prefix: string): BaselineRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.part.id}-${index}`;
    const children =
      node.children.length > 0 ? toBaselineRows(node.children, `${key}/`) : undefined;
    return { key, node, children };
  });
}

function collectRowKeys(rows: BaselineRow[]): Key[] {
  const keys: Key[] = [];
  for (const row of rows) {
    if (row.children && row.children.length > 0) {
      keys.push(row.key);
      keys.push(...collectRowKeys(row.children));
    }
  }
  return keys;
}

export default function Baselines() {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const isViewer = user?.role === 'VIEWER';
  const isAdmin = user?.role === 'ADMIN';

  const [items, setItems] = useState<BaselineSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');

  // Create modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<NewBaselineValues>();
  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const partTimer = useRef<number | undefined>(undefined);

  // View modal
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewBaseline, setViewBaseline] = useState<BaselineDetail | null>(null);
  const [viewExpanded, setViewExpanded] = useState<readonly Key[]>([]);

  // Compare
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [compare, setCompare] = useState<BaselineCompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listBaselines({ search: search || undefined, page, pageSize });
      // Drop stale responses: an older request must not overwrite a newer one.
      if (requestRef.current !== requestId) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (requestRef.current === requestId) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [search, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(partTimer.current);
    };
  }, []);

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
    partTimer.current = window.setTimeout(() => {
      void fetchParts(value);
    }, 300);
  };

  const handlePartSelect = async (partId: number) => {
    setRevisions([]);
    form.setFieldValue('partRevisionId', undefined);
    try {
      const part = await api.getPart(partId);
      setRevisions(part.revisions);
      form.setFieldValue('partRevisionId', part.revisions[0]?.id);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  const openCreate = () => {
    setModalError(null);
    form.resetFields();
    setRevisions([]);
    void fetchParts('');
    setModalOpen(true);
  };

  const handleCreate = async () => {
    let values: NewBaselineValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      const created = await api.createBaseline({
        partRevisionId: values.partRevisionId,
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
      });
      message.success(`Baseline "${created.name}" created`);
      setModalOpen(false);
      void load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const openView = async (id: number) => {
    setViewOpen(true);
    setViewLoading(true);
    setViewBaseline(null);
    try {
      setViewBaseline(await api.getBaseline(id));
    } catch (err) {
      setViewOpen(false);
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setViewLoading(false);
    }
  };

  const handleDelete = async (baseline: BaselineSummary) => {
    try {
      await api.deleteBaseline(baseline.id);
      message.success(`Baseline "${baseline.name}" deleted`);
      setSelectedRowKeys((prev) => prev.filter((key) => key !== baseline.id));
      setCompare((prev) =>
        prev && (prev.left.id === baseline.id || prev.right.id === baseline.id) ? null : prev
      );
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  const runCompare = async () => {
    if (selectedRowKeys.length !== 2) return;
    const [leftId, rightId] = selectedRowKeys as number[];
    setCompareLoading(true);
    try {
      setCompare(await api.compareBaselines(leftId, rightId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCompareLoading(false);
    }
  };

  const viewRows = useMemo(
    () => (viewBaseline ? toBaselineRows(viewBaseline.nodes, '') : []),
    [viewBaseline]
  );
  useEffect(() => {
    setViewExpanded(collectRowKeys(viewRows));
  }, [viewRows]);

  const viewColumns: ColumnsType<BaselineRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) => (
        <Space size={8}>
          <Link to={`/parts/${row.node.part.id}`}>{row.node.part.partNumber}</Link>
          <Typography.Text type="secondary">{row.node.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Rev',
      key: 'rev',
      width: 70,
      render: (_, row) => <Tag>{row.node.revisionLabel}</Tag>,
    },
    {
      title: 'Find #',
      key: 'findNumber',
      width: 80,
      align: 'right',
      render: (_, row) => row.node.findNumber,
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (_, row) => row.node.quantity,
    },
    {
      title: 'UoM',
      key: 'uom',
      width: 80,
      render: (_, row) => row.node.uom,
    },
  ];

  const columns: ColumnsType<BaselineSummary> = [
    {
      title: 'Name',
      key: 'name',
      ellipsis: true,
      render: (_, b) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{b.name}</Typography.Text>
          {b.description && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
              {b.description}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Root part',
      key: 'part',
      width: 220,
      render: (_, b) => (
        <Space size={8}>
          <Link to={`/parts/${b.part.id}`}>{b.part.partNumber}</Link>
          <Tag color={LIFECYCLE_META[b.revision.lifecycle].color}>Rev {b.revision.revision}</Tag>
        </Space>
      ),
    },
    {
      title: 'Lines',
      dataIndex: 'lineCount',
      key: 'lineCount',
      width: 80,
      align: 'right',
    },
    {
      title: 'Created by',
      key: 'createdBy',
      width: 140,
      render: (_, b) => b.createdBy.name,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 150,
      render: (_, b) => formatDate(b.createdAt),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_, b) => {
        const canDelete = !isViewer && (isAdmin || user?.id === b.createdBy.id);
        return (
          <Space size={0}>
            <Button type="link" size="small" onClick={() => void openView(b.id)}>
              View
            </Button>
            {canDelete && (
              <Popconfirm
                title={`Delete baseline "${b.name}"?`}
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleDelete(b)}
              >
                <Button type="link" size="small" danger>
                  Delete
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
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
          Baselines
        </Typography.Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New baseline
          </Button>
        )}
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Search name or part number"
          allowClear
          style={{ width: 280 }}
          onSearch={(value) => {
            setSearch(value.trim());
            setPage(1);
          }}
        />
        <Button
          icon={<DiffOutlined />}
          disabled={selectedRowKeys.length !== 2}
          loading={compareLoading}
          onClick={() => void runCompare()}
        >
          Compare selected
        </Button>
        <Typography.Text type="secondary">
          {selectedRowKeys.length === 2
            ? 'Ready to compare'
            : `Select 2 baselines to compare (${selectedRowKeys.length} selected)`}
        </Typography.Text>
      </Space>

      <Table<BaselineSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} baselines`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      {compare && (
        <div style={{ marginTop: 16 }}>
          <Spin spinning={compareLoading}>
            <CompareResultView
              summary={compare.summary}
              nodes={compare.nodes}
              leftTitle={`${compare.left.name} (${compare.left.part.partNumber})`}
              rightTitle={`${compare.right.name} (${compare.right.part.partNumber})`}
            />
          </Spin>
        </div>
      )}

      <Modal
        title="New baseline"
        open={modalOpen}
        onOk={() => void handleCreate()}
        okText="Create"
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="partId"
            label="Part"
            rules={[{ required: true, message: 'Select a part' }]}
          >
            <Select
              showSearch
              placeholder="Search by part number or name"
              filterOption={false}
              onSearch={handlePartSearch}
              onSelect={(value: number) => void handlePartSelect(value)}
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
            label="Revision"
            tooltip="The baseline snapshots this revision's resolved BOM structure."
            rules={[{ required: true, message: 'Select a revision' }]}
          >
            <Select
              placeholder="Revision"
              disabled={revisions.length === 0}
              options={revisions.map((r) => ({
                value: r.id,
                label: `Rev ${r.revision} — ${LIFECYCLE_META[r.lifecycle].label}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, whitespace: true, message: 'Name is required' },
              { max: 120, message: 'At most 120 characters' },
            ]}
          >
            <Input placeholder='e.g. "Pilot build 1", "Rev B release snapshot"' />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Why this snapshot was taken" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          viewBaseline
            ? `${viewBaseline.name} — ${viewBaseline.part.partNumber} rev ${viewBaseline.revision.revision}`
            : 'Baseline'
        }
        open={viewOpen}
        onCancel={() => setViewOpen(false)}
        footer={null}
        width={900}
      >
        {viewLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spin size="large" />
          </div>
        )}
        {!viewLoading && viewBaseline && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {viewBaseline.description ? `${viewBaseline.description} · ` : ''}
              Captured by {viewBaseline.createdBy.name} on {formatDate(viewBaseline.createdAt)} ·{' '}
              {viewBaseline.lineCount} lines
            </Typography.Text>
            {viewRows.length === 0 ? (
              <Empty description="This baseline has no BOM lines." />
            ) : (
              <Table<BaselineRow>
                size="middle"
                rowKey="key"
                columns={viewColumns}
                dataSource={viewRows}
                pagination={false}
                scroll={{ y: 420 }}
                expandable={{
                  expandedRowKeys: viewExpanded as Key[],
                  onExpandedRowsChange: (keys) => setViewExpanded(keys),
                }}
              />
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}
