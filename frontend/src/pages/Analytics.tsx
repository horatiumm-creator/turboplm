import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  App as AntdApp,
  Card,
  Col,
  Empty,
  List,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { AnalyticsKpis, EcnStatus } from '../api/types';
import { CategoryTag, EcnStatusTag, formatMoney } from '../components/meta';

type ThroughputRow = AnalyticsKpis['throughput'][number];
type CostDriverRow = AnalyticsKpis['topCostDrivers'][number];

interface BomHealthRow {
  key: string;
  label: string;
  value: number;
  hint: string;
}

/** Pipeline columns follow the ECN lifecycle order. */
const ECN_STATUS_ORDER: EcnStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASED', 'CANCELLED'];
/** "Open" changes = the active ECN statuses (CONTRACTS: DRAFT, IN_REVIEW, APPROVED). */
const OPEN_ECN_STATUSES: EcnStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED'];

const formatMonth = (month: string) => {
  const parsed = dayjs(`${month}-01`);
  return parsed.isValid() ? parsed.format('MMM YYYY') : month;
};

export default function Analytics() {
  const { message } = AntdApp.useApp();
  const { token } = theme.useToken();
  const [kpis, setKpis] = useState<AnalyticsKpis | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setKpis(await api.getAnalytics());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !kpis) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!kpis) {
    return <Empty description="No analytics available" />;
  }

  const { changeCycle, bomHealth, requirements, throughput, topCostDrivers } = kpis;

  const openChanges = OPEN_ECN_STATUSES.reduce(
    (sum, status) => sum + changeCycle.openByStatus[status],
    0
  );
  const uncovered = Math.max(0, requirements.total - requirements.covered);
  const coveragePercent =
    requirements.total > 0 ? Math.round((requirements.covered / requirements.total) * 100) : 0;
  const throughputMax = Math.max(
    1,
    ...throughput.map((row) => Math.max(row.created, row.released))
  );

  const bomHealthRows: BomHealthRow[] = [
    {
      key: 'partsNeverReleased',
      label: 'Parts never released',
      value: bomHealth.partsNeverReleased,
      hint: 'No released revision yet — assemblies using them cannot be released.',
    },
    {
      key: 'partsMissingCost',
      label: 'Parts missing cost',
      value: bomHealth.partsMissingCost,
      hint: 'No unit cost captured — every roll-up above them stays incomplete.',
    },
    {
      key: 'revisionsInWork',
      label: 'Revisions in work',
      value: bomHealth.revisionsInWork,
      hint: 'Designs still being edited — submit them for review to freeze the structure.',
    },
    {
      key: 'releasedWithUnreleasedChildren',
      label: 'Released assemblies with unreleased children',
      value: bomHealth.releasedWithUnreleasedChildren,
      hint: 'Released structures reference children with no released revision — resolve before manufacturing.',
    },
  ];

  const renderBar = (value: number, color: string) => (
    <div
      style={{
        background: token.colorFillSecondary,
        borderRadius: 2,
        height: 8,
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${(value / throughputMax) * 100}%`,
          background: color,
          height: '100%',
          borderRadius: 2,
        }}
      />
    </div>
  );

  const throughputColumns: ColumnsType<ThroughputRow> = [
    {
      title: 'Month',
      key: 'month',
      width: 130,
      render: (_, row) => formatMonth(row.month),
    },
    {
      title: 'Created',
      key: 'created',
      width: 100,
      align: 'right',
      render: (_, row) => row.created,
    },
    {
      title: 'Released',
      key: 'released',
      width: 100,
      align: 'right',
      render: (_, row) => row.released,
    },
    {
      title: 'Volume',
      key: 'volume',
      render: (_, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
          {renderBar(row.created, token.colorPrimary)}
          {renderBar(row.released, token.colorSuccess)}
        </div>
      ),
    },
  ];

  const costColumns: ColumnsType<CostDriverRow> = [
    {
      title: 'Part',
      key: 'part',
      ellipsis: true,
      render: (_, row) => (
        <Link to={`/parts/${row.part.id}`}>
          {row.part.partNumber} — {row.part.name}
        </Link>
      ),
    },
    {
      title: 'Category',
      key: 'category',
      width: 140,
      render: (_, row) => <CategoryTag category={row.part.category} />,
    },
    {
      title: 'Rolled cost',
      key: 'rolledCost',
      width: 150,
      align: 'right',
      render: (_, row) => <Typography.Text strong>{formatMoney(row.rolledCost)}</Typography.Text>,
    },
  ];

  const legendDot = (color: string, label: string) => (
    <Space size={6}>
      <span
        style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
    </Space>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Analytics
      </Typography.Title>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="Released last 90 days"
              value={changeCycle.releasedLast90}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: token.colorSuccess }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            {changeCycle.avgDraftToReleaseDays === null ? (
              <Statistic title="Avg draft → release" value="—" prefix={<ClockCircleOutlined />} />
            ) : (
              <Statistic
                title="Avg draft → release"
                value={changeCycle.avgDraftToReleaseDays}
                precision={1}
                suffix="days"
                prefix={<ClockCircleOutlined />}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            {changeCycle.avgReviewDays === null ? (
              <Statistic title="Avg review time" value="—" prefix={<FileSearchOutlined />} />
            ) : (
              <Statistic
                title="Avg review time"
                value={changeCycle.avgReviewDays}
                precision={1}
                suffix="days"
                prefix={<FileSearchOutlined />}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="Open changes"
              value={openChanges}
              prefix={<AuditOutlined />}
              valueStyle={{ color: token.colorPrimary }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="Change pipeline"
        extra={
          <Typography.Text type="secondary">
            {openChanges} open (draft, in review, approved)
          </Typography.Text>
        }
      >
        <Space size={40} wrap>
          {ECN_STATUS_ORDER.map((status) => (
            <Space key={status} direction="vertical" size={4} align="center">
              <EcnStatusTag status={status} />
              <Typography.Title level={3} style={{ margin: 0 }}>
                {changeCycle.openByStatus[status]}
              </Typography.Title>
            </Space>
          ))}
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            title="BOM health"
            extra={
              <Typography.Text type="secondary">{bomHealth.partsTotal} parts</Typography.Text>
            }
            styles={{ body: { paddingBlock: 0 } }}
          >
            <List<BomHealthRow>
              size="small"
              dataSource={bomHealthRows}
              renderItem={(row) => {
                const warn = row.value > 0;
                return (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <span style={warn ? { color: token.colorWarning } : undefined}>
                          {row.label}
                        </span>
                      }
                      description={
                        warn ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {row.hint}
                          </Typography.Text>
                        ) : undefined
                      }
                    />
                    <Typography.Text
                      strong
                      style={warn ? { color: token.colorWarning } : undefined}
                    >
                      {row.value}
                    </Typography.Text>
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Requirement coverage">
            <Space size={32} align="center" wrap>
              <Progress
                type="circle"
                size={120}
                percent={coveragePercent}
                strokeColor={token.colorSuccess}
              />
              <Space size={32} wrap>
                <Statistic title="Requirements" value={requirements.total} />
                <Statistic
                  title="Covered by a part"
                  value={requirements.covered}
                  valueStyle={{ color: token.colorSuccess }}
                />
                <Statistic title="Approved" value={requirements.approved} />
                <Statistic
                  title="Uncovered"
                  value={uncovered}
                  valueStyle={uncovered > 0 ? { color: token.colorWarning } : undefined}
                />
              </Space>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        title="Throughput (last 6 months)"
        extra={
          <Space size={16}>
            {legendDot(token.colorPrimary, 'Created')}
            {legendDot(token.colorSuccess, 'Released')}
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table<ThroughputRow>
          size="small"
          rowKey="month"
          columns={throughputColumns}
          dataSource={throughput}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No change history yet" />
            ),
          }}
        />
      </Card>

      <Card title="Top cost drivers" styles={{ body: { padding: 0 } }}>
        <Table<CostDriverRow>
          size="small"
          rowKey={(row) => row.part.id}
          columns={costColumns}
          dataSource={topCostDrivers}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No rolled-up costs yet — add unit costs to your parts"
              />
            ),
          }}
        />
      </Card>
    </Space>
  );
}
