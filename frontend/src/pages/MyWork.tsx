import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntdApp, Badge, Card, Col, Empty, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { EcnSummary, EcrSummary, MyWork as MyWorkDto, MyWorkReviewEntry } from '../api/types';
import { EcnPriorityTag, EcnStatusTag, formatDate } from '../components/meta';

type InWorkEntry = MyWorkDto['inWorkRevisions'][number];
type PendingTaskEntry = MyWorkDto['pendingTasks'][number];

const taskColumns: ColumnsType<PendingTaskEntry> = [
  {
    title: 'ECN',
    key: 'ecn',
    ellipsis: true,
    render: (_, record) => (
      <Link to={`/ecns/${record.ecn.id}`}>
        {record.ecn.ecnNumber} — {record.ecn.title}
      </Link>
    ),
  },
  {
    title: 'Step',
    key: 'step',
    width: 220,
    render: (_, record) => record.stepName,
  },
  {
    title: 'Assigned',
    key: 'assigned',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

const reviewColumns: ColumnsType<MyWorkReviewEntry> = [
  {
    title: 'ECN',
    key: 'ecn',
    ellipsis: true,
    render: (_, record) => (
      <Link to={`/ecns/${record.ecn.id}`}>
        {record.ecn.ecnNumber} — {record.ecn.title}
      </Link>
    ),
  },
  {
    title: 'Status',
    key: 'status',
    width: 110,
    render: (_, record) => <EcnStatusTag status={record.ecn.status} />,
  },
  {
    title: 'Assigned',
    key: 'assigned',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

const inWorkColumns: ColumnsType<InWorkEntry> = [
  {
    title: 'Part',
    key: 'part',
    ellipsis: true,
    render: (_, record) => (
      <Link to={`/parts/${record.part.id}?rev=${record.id}`}>
        {record.part.partNumber} — {record.part.name}
      </Link>
    ),
  },
  {
    title: 'Rev',
    key: 'revision',
    width: 70,
    render: (_, record) => <Tag>{record.revision}</Tag>,
  },
  {
    title: 'ECN',
    key: 'ecn',
    width: 120,
    render: (_, record) =>
      record.ecn ? (
        <Link to={`/ecns/${record.ecn.id}`}>{record.ecn.ecnNumber}</Link>
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      ),
  },
  {
    title: 'Created',
    key: 'createdAt',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

const ecrColumns: ColumnsType<EcrSummary> = [
  {
    title: 'ECR #',
    key: 'ecrNumber',
    width: 110,
    render: (_, record) => <Link to={`/ecrs/${record.id}`}>{record.ecrNumber}</Link>,
  },
  {
    title: 'Title',
    dataIndex: 'title',
    key: 'title',
    ellipsis: true,
  },
  {
    title: 'Priority',
    key: 'priority',
    width: 100,
    render: (_, record) => <EcnPriorityTag priority={record.priority} />,
  },
  {
    title: 'Created',
    key: 'createdAt',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

const ecnColumns: ColumnsType<EcnSummary> = [
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
    title: 'Affected',
    key: 'itemCount',
    width: 90,
    align: 'right',
    render: (_, record) => record.itemCount,
  },
  {
    title: 'Created',
    key: 'createdAt',
    width: 150,
    render: (_, record) => formatDate(record.createdAt),
  },
];

export default function MyWork() {
  const { message } = AntdApp.useApp();
  const [work, setWork] = useState<MyWorkDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWork(await api.getMyWork());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingCount = work?.pendingReviews.length ?? 0;
  const taskCount = work?.pendingTasks.length ?? 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        My Work
      </Typography.Title>
      <Card
        title={
          <Space size={8}>
            Workflow tasks waiting on you
            <Badge count={taskCount} style={{ backgroundColor: '#1677ff' }} />
          </Space>
        }
        style={{ borderColor: '#1677ff' }}
        styles={{ body: { padding: 0 } }}
      >
        <Table<PendingTaskEntry>
          size="small"
          rowKey="taskId"
          columns={taskColumns}
          dataSource={work?.pendingTasks ?? []}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No workflow tasks waiting on you"
              />
            ),
          }}
        />
      </Card>
      <Card
        title={
          <Space size={8}>
            Reviews waiting on you
            <Badge count={pendingCount} style={{ backgroundColor: '#1677ff' }} />
          </Space>
        }
        style={{ borderColor: '#1677ff' }}
        styles={{ body: { padding: 0 } }}
      >
        <Table<MyWorkReviewEntry>
          size="small"
          rowKey="reviewId"
          columns={reviewColumns}
          dataSource={work?.pendingReviews ?? []}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No reviews waiting on you — nothing to sign off"
              />
            ),
          }}
        />
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="My in-work revisions" styles={{ body: { padding: 0 } }}>
            <Table<InWorkEntry>
              size="small"
              rowKey="id"
              columns={inWorkColumns}
              dataSource={work?.inWorkRevisions ?? []}
              loading={loading}
              pagination={false}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No in-work revisions — you are all caught up"
                  />
                ),
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="My open change requests" styles={{ body: { padding: 0 } }}>
            <Table<EcrSummary>
              size="small"
              rowKey="id"
              columns={ecrColumns}
              dataSource={work?.openEcrs ?? []}
              loading={loading}
              pagination={false}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No open change requests"
                  />
                ),
              }}
            />
          </Card>
        </Col>
      </Row>
      <Card title="My active ECNs" styles={{ body: { padding: 0 } }}>
        <Table<EcnSummary>
          size="small"
          rowKey="id"
          columns={ecnColumns}
          dataSource={work?.activeEcns ?? []}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No active engineering changes"
              />
            ),
          }}
        />
      </Card>
    </Space>
  );
}
