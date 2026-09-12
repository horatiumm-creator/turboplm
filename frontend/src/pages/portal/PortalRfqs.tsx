import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Empty, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { PortalRfqSummary } from '../../api/types';
import { formatDate, RfqStatusTag } from '../../components/meta';

export default function PortalRfqs() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<PortalRfqSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setRows(await api.portalListRfqs());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load requests');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<PortalRfqSummary> = [
    {
      title: 'RFQ #',
      key: 'rfqNumber',
      width: 130,
      render: (_, row) => <Link to={`/portal/rfqs/${row.id}`}>{row.rfqNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, row) => <RfqStatusTag status={row.status} />,
    },
    {
      title: 'Your response',
      key: 'response',
      width: 190,
      render: (_, row) =>
        row.myQuoteCount === 0 ? (
          <Tag color="gold">Awaiting your quote</Tag>
        ) : (
          <Space size={6}>
            <Tag color="green">Quoted</Tag>
            <Typography.Text type="secondary">
              {row.myQuoteCount} of {row.lineCount} lines
            </Typography.Text>
          </Space>
        ),
    },
    { title: 'Quotes due', key: 'dueDate', width: 140, render: (_, row) => formatDate(row.dueDate) },
    { title: 'Received', key: 'sentAt', width: 150, render: (_, row) => formatDate(row.sentAt) },
  ];

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Requests for quote
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Only requests you have been invited to appear here.
      </Typography.Paragraph>

      <Table<PortalRfqSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{
          emptyText: (
            <Empty description="No requests for quote yet — the buyer will invite you when one is ready" />
          ),
        }}
      />
    </div>
  );
}
