import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Card, Col, Empty, Row, Space, Statistic, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AppstoreOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  EditOutlined,
  FileSearchOutlined,
  PartitionOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { DashboardStats, EcnSummary, PartSummary } from '../api/types';
import {
  CategoryTag,
  EcnPriorityTag,
  EcnStatusTag,
  LifecycleTag,
  formatDate,
} from '../components/meta';

type MyInWorkEntry = DashboardStats['myInWork'][number];

const recentColumns: ColumnsType<PartSummary> = [
  {
    title: 'Part number',
    dataIndex: 'partNumber',
    key: 'partNumber',
    render: (_, record) => <Link to={`/parts/${record.id}`}>{record.partNumber}</Link>,
  },
  {
    title: 'Name',
    dataIndex: 'name',
    key: 'name',
    ellipsis: true,
  },
  {
    title: 'Category',
    dataIndex: 'category',
    key: 'category',
    render: (_, record) => <CategoryTag category={record.category} />,
  },
  {
    title: 'Revision',
    key: 'revision',
    render: (_, record) =>
      record.latestRevision ? (
        <Space size={4}>
          <Typography.Text strong>{record.latestRevision.revision}</Typography.Text>
          <LifecycleTag lifecycle={record.latestRevision.lifecycle} />
        </Space>
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      ),
  },
  {
    title: 'Created',
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (_, record) => formatDate(record.createdAt),
  },
];

const recentEcnColumns: ColumnsType<EcnSummary> = [
  {
    title: 'ECN #',
    key: 'ecnNumber',
    width: 110,
    render: (_, record) => <Link to={`/ecns/${record.id}`}>{record.ecnNumber}</Link>,
  },
  {
    title: 'Title',
    dataIndex: 'title',
    key: 'title',
    ellipsis: true,
  },
  {
    title: 'Status',
    key: 'status',
    width: 110,
    render: (_, record) => <EcnStatusTag status={record.status} />,
  },
  {
    title: 'Priority',
    key: 'priority',
    width: 100,
    render: (_, record) => <EcnPriorityTag priority={record.priority} />,
  },
];

const inWorkColumns: ColumnsType<MyInWorkEntry> = [
  {
    title: 'Part',
    key: 'part',
    render: (_, record) => (
      <Link to={`/parts/${record.part.id}?rev=${record.id}`}>
        {record.part.partNumber} — {record.part.name}
      </Link>
    ),
  },
  {
    title: 'Rev',
    dataIndex: 'revision',
    key: 'revision',
    width: 70,
    render: (_, record) => <Typography.Text strong>{record.revision}</Typography.Text>,
  },
  {
    title: 'Created',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

export default function Dashboard() {
  const { message } = AntdApp.useApp();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await api.getStats());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const statCards: { title: string; value: number; icon: ReactNode; color?: string }[] = [
    {
      title: 'Total parts',
      value: stats?.parts ?? 0,
      icon: <AppstoreOutlined />,
    },
    {
      title: 'In Work',
      value: stats?.revisionsByLifecycle.IN_WORK ?? 0,
      icon: <EditOutlined />,
      color: '#d48806',
    },
    {
      title: 'In Review',
      value: stats?.revisionsByLifecycle.IN_REVIEW ?? 0,
      icon: <FileSearchOutlined />,
      color: '#1677ff',
    },
    {
      title: 'Released',
      value: stats?.revisionsByLifecycle.RELEASED ?? 0,
      icon: <CheckCircleOutlined />,
      color: '#389e0d',
    },
    {
      title: 'Process plans',
      value: stats?.plans ?? 0,
      icon: <PartitionOutlined />,
    },
    {
      title: 'Open changes',
      value: stats?.openEcns ?? 0,
      icon: <AuditOutlined />,
      color: '#531dab',
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Dashboard
      </Typography.Title>
      <Row gutter={[16, 16]}>
        {statCards.map((card) => (
          <Col key={card.title} flex="1 1 180px">
            <Card loading={loading && !stats}>
              <Statistic
                title={card.title}
                value={card.value}
                prefix={card.icon}
                valueStyle={card.color ? { color: card.color } : undefined}
              />
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="Recent parts" styles={{ body: { padding: 0 } }}>
            <Table<PartSummary>
              size="small"
              rowKey="id"
              columns={recentColumns}
              dataSource={stats?.recentParts ?? []}
              loading={loading}
              pagination={false}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No parts yet — create your first part to get started"
                  />
                ),
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card title="My in-work revisions" styles={{ body: { padding: 0 } }}>
              <Table<MyInWorkEntry>
                size="small"
                rowKey="id"
                columns={inWorkColumns}
                dataSource={stats?.myInWork ?? []}
                loading={loading}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="Nothing in work — you are all caught up"
                    />
                  ),
                }}
              />
            </Card>
            <Card title="Recent changes" styles={{ body: { padding: 0 } }}>
              <Table<EcnSummary>
                size="small"
                rowKey="id"
                columns={recentEcnColumns}
                dataSource={stats?.recentEcns ?? []}
                loading={loading}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="No engineering changes yet"
                    />
                  ),
                }}
              />
            </Card>
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
