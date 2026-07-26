import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Empty, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { WhereUsedEntry } from '../../api/types';
import { LifecycleTag } from '../meta';

export default function WhereUsedTab({ partId }: { partId: number }): JSX.Element {
  const { message } = AntdApp.useApp();
  const [entries, setEntries] = useState<WhereUsedEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.getWhereUsed(partId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [partId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<WhereUsedEntry> = [
    {
      title: 'Parent Part Number',
      key: 'parentPartNumber',
      render: (_, entry) => (
        <Link to={`/parts/${entry.parentPart.id}?rev=${entry.parentRevision.id}`}>
          {entry.parentPart.partNumber}
        </Link>
      ),
    },
    {
      title: 'Parent Name',
      key: 'parentName',
      render: (_, entry) => entry.parentPart.name,
    },
    {
      title: 'Parent Rev',
      key: 'parentRev',
      render: (_, entry) => (
        <Space size={4}>
          <Tag>{entry.parentRevision.revision}</Tag>
          <LifecycleTag lifecycle={entry.parentRevision.lifecycle} />
        </Space>
      ),
    },
    {
      title: 'Find #',
      key: 'findNumber',
      width: 90,
      render: (_, entry) => entry.line.findNumber,
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (_, entry) => entry.line.quantity,
    },
    {
      title: 'UoM',
      key: 'uom',
      width: 80,
      render: (_, entry) => entry.line.uom,
    },
  ];

  return (
    <Table<WhereUsedEntry>
      size="middle"
      rowKey={(entry) => entry.line.id}
      columns={columns}
      dataSource={entries}
      loading={loading}
      pagination={false}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="This part is not used in any BOM."
          />
        ),
      }}
    />
  );
}
