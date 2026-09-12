import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntdApp, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { AuditEntry } from '../api/types';
import { formatDate } from '../components/meta';

const ENTITY_TYPES = [
  'PART',
  'REVISION',
  'BOM_LINE',
  'ECN',
  'ECN_ITEM',
  'ECR',
  'DOCUMENT',
  'BASELINE',
  'MANUFACTURER',
  'ATTRIBUTE_DEF',
  'USER',
];

const ENTITY_TYPE_OPTIONS = ENTITY_TYPES.map((value) => ({ value, label: value }));

const METHOD_COLORS: Record<string, string> = {
  POST: 'green',
  PATCH: 'gold',
  PUT: 'gold',
  DELETE: 'red',
};

export default function Activity() {
  const { message } = AntdApp.useApp();

  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [entityType, setEntityType] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listAudit({
        entityType,
        search: search || undefined,
        page,
        pageSize,
      });
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
  }, [entityType, search, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AuditEntry> = [
    {
      title: 'When',
      key: 'createdAt',
      width: 160,
      render: (_, entry) => formatDate(entry.createdAt),
    },
    {
      title: 'User',
      key: 'user',
      width: 160,
      ellipsis: true,
      render: (_, entry) =>
        entry.user ? (
          entry.user.name
        ) : (
          <Typography.Text type="secondary">system</Typography.Text>
        ),
    },
    {
      title: 'Method',
      key: 'method',
      width: 100,
      render: (_, entry) => (
        <Tag color={METHOD_COLORS[entry.method] ?? 'default'}>{entry.method}</Tag>
      ),
    },
    {
      title: 'Path',
      key: 'path',
      ellipsis: true,
      render: (_, entry) => <Typography.Text code>{entry.path}</Typography.Text>,
    },
    {
      title: 'Entity',
      key: 'entity',
      width: 180,
      render: (_, entry) =>
        entry.entityType ? (
          `${entry.entityType}${entry.entityId !== null ? ` #${entry.entityId}` : ''}`
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 16 }}>
        Activity log
      </Typography.Title>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Entity type"
          allowClear
          style={{ width: 200 }}
          options={ENTITY_TYPE_OPTIONS}
          value={entityType}
          onChange={(value) => {
            setEntityType(value);
            setPage(1);
          }}
        />
        <Input.Search
          placeholder="Search path"
          allowClear
          style={{ width: 280 }}
          onSearch={(value) => {
            setSearch(value.trim());
            setPage(1);
          }}
        />
      </Space>

      <Table<AuditEntry>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        expandable={{
          rowExpandable: (entry) => entry.details !== null && entry.details !== undefined,
          expandedRowRender: (entry) => (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} entries`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />
    </div>
  );
}
