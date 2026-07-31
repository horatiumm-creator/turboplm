import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CopyOutlined, WarningOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  BuildUnitRef,
  BuildUnitSummary,
  WhereConsumedEntry,
  WhereConsumedResult,
} from '../api/types';
import {
  BUILD_STATUS_META,
  BuildKindTag,
  BuildStatusTag,
  formatDate,
} from '../components/meta';

const optionLabel = (unit: BuildUnitRef | BuildUnitSummary) =>
  `${unit.identifier} · ${unit.part.partNumber} — ${unit.part.name}` +
  (unit.kind === 'LOT' ? ` · lot of ${unit.quantity}` : '') +
  ` · ${BUILD_STATUS_META[unit.status].label}`;


export default function Traceability() {
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const paramUnitId = Number(searchParams.get('unit'));
  const [unitId, setUnitId] = useState<number | undefined>(
    Number.isInteger(paramUnitId) && paramUnitId > 0 ? paramUnitId : undefined
  );
  const [options, setOptions] = useState<BuildUnitSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<WhereConsumedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchReq = useRef(0);
  const traceReq = useRef(0);

  const fetchUnits = useCallback(async (search: string) => {
    const seq = ++searchReq.current;
    setSearching(true);
    try {
      const res = await api.listBuildUnits({ search: search || undefined, pageSize: 20 });
      if (searchReq.current !== seq) return; // a later keystroke has superseded this one
      setOptions(res.items);
    } catch {
      if (searchReq.current === seq) setOptions([]);
    } finally {
      if (searchReq.current === seq) setSearching(false);
    }
  }, []);

  const handleSearch = useCallback(
    (value: string) => {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => void fetchUnits(value), 300);
    },
    [fetchUnits]
  );

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  useEffect(() => {
    if (unitId === undefined) {
      setResult(null);
      return;
    }
    const seq = ++traceReq.current;
    setLoading(true);
    void (async () => {
      try {
        const res = await api.getBuildUnitWhereConsumed(unitId);
        if (traceReq.current !== seq) return;
        setResult(res);
      } catch (err) {
        if (traceReq.current !== seq) return;
        setResult(null);
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        if (traceReq.current === seq) setLoading(false);
      }
    })();
  }, [unitId, message]);

  const pickUnit = (value?: number) => {
    setUnitId(value);
    setSearchParams(value ? { unit: String(value) } : {});
  };

  // The traced unit is kept in the option list even after a search replaces it, otherwise the
  // Select would fall back to showing the bare id of the unit on screen.
  const selectOptions = useMemo(() => {
    const units =
      result && !options.some((u) => u.id === result.unit.id)
        ? [result.unit, ...options]
        : options;
    return units.map((u) => ({ value: u.id, label: optionLabel(u) }));
  }, [options, result]);

  // The API returns ancestors flat and already deduplicated — a unit reachable by two
  // routes appears once — so there is no tree to build and no counting to redo here.
  const affected = result?.units ?? [];


  const shipped = result?.shippedUnits ?? [];
  const inHouse = (result?.counts.inProgress ?? 0) + (result?.counts.completed ?? 0);
  const scrapped = result?.counts.scrapped ?? 0;

  const copyIdentifiers = async () => {
    try {
      await navigator.clipboard.writeText(shipped.map((e) => e.unit.identifier).join('\n'));
      message.success(`${shipped.length} identifiers copied`);
    } catch {
      message.warning('Copy failed — select the column and copy it manually');
    }
  };

  const shippedColumns: ColumnsType<WhereConsumedEntry> = [
    {
      title: 'Serial / lot',
      key: 'identifier',
      width: 210,
      render: (_, entry) => (
        <Space size={6}>
          <WarningOutlined style={{ color: '#cf1322' }} />
          <Link to={`/build-units/${entry.unit.id}`} style={{ fontWeight: 600 }}>
            {entry.unit.identifier}
          </Link>
          <BuildKindTag kind={entry.unit.kind} />
        </Space>
      ),
    },
    {
      title: 'Part',
      key: 'part',
      render: (_, entry) => (
        <Space size={8}>
          <Link to={`/parts/${entry.unit.part.id}`}>{entry.unit.part.partNumber}</Link>
          <Typography.Text type="secondary">{entry.unit.part.name}</Typography.Text>
        </Space>
      ),
    },
    { title: 'Qty', key: 'quantity', width: 80, align: 'right', render: (_, e) => e.unit.quantity },
    {
      title: 'Levels up',
      key: 'depth',
      width: 100,
      align: 'right',
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.depth - b.depth,
      render: (_, entry) => entry.depth,
    },
    {
      title: 'How it got in',
      key: 'path',
      render: (_, entry) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {/* Nearest hop first, so the chain reads outward from the suspect unit. */}
          {entry.path.map((step) => step.unit.identifier).join(' → ') || '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'Quality',
      key: 'ncr',
      width: 120,
      render: (_, entry) =>
        entry.hasOpenNonconformances ? (
          <Tag color="red">{entry.openNonconformanceCount} open NCR</Tag>
        ) : (
          '—'
        ),
    },
  ];

  // The full trace lists every affected unit, nearest first, with the hop chain that put the
  // suspect unit inside it. Depth replaces nesting: the API returns ancestors flat, and a
  // reconstructed tree would duplicate units reachable by more than one route.
  const traceColumns: ColumnsType<WhereConsumedEntry> = [
    {
      title: 'Consumed into',
      key: 'unit',
      render: (_, entry) => (
        <Space size={6}>
          {entry.unit.status === 'SHIPPED' && <WarningOutlined style={{ color: '#cf1322' }} />}
          <Link to={`/build-units/${entry.unit.id}`}>{entry.unit.identifier}</Link>
          <BuildKindTag kind={entry.unit.kind} />
          {entry.topLevel && <Tag>top level</Tag>}
        </Space>
      ),
    },
    {
      title: 'Part',
      key: 'part',
      render: (_, entry) => (
        <Space size={8}>
          <Link to={`/parts/${entry.unit.part.id}`}>{entry.unit.part.partNumber}</Link>
          <Typography.Text type="secondary">{entry.unit.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Levels up',
      key: 'depth',
      width: 100,
      align: 'right',
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.depth - b.depth,
      render: (_, entry) => entry.depth,
    },
    {
      title: 'How it got in',
      key: 'path',
      render: (_, entry) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.path.map((step) => `${step.unit.identifier} (${step.quantity})`).join(' → ') ||
            '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, entry) => <BuildStatusTag status={entry.unit.status} />,
    },
  ];

  const hasTrace = result !== null && (result.units.length > 0 || shipped.length > 0);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Traceability
        </Typography.Title>
        <Typography.Text type="secondary">
          A lot is suspect — what shipped with it? Pick the unit in question to trace it forward
          through every unit it ended up in.
        </Typography.Text>
      </div>

      <Card>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text strong>Suspect serial or lot</Typography.Text>
          <Select
            showSearch
            allowClear
            placeholder="Search by serial or lot identifier"
            style={{ width: '100%', maxWidth: 600 }}
            filterOption={false}
            value={unitId}
            loading={searching}
            onFocus={() => {
              if (options.length === 0) handleSearch('');
            }}
            onSearch={handleSearch}
            onChange={pickUnit}
            options={selectOptions}
            notFoundContent={searching ? 'Searching…' : 'No build units found'}
          />
        </Space>

        {result && (
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 20 }}>
            <Descriptions.Item label="Part">
              <Link to={`/parts/${result.unit.part.id}`}>
                {result.unit.part.partNumber} — {result.unit.part.name}
              </Link>
            </Descriptions.Item>
            <Descriptions.Item label="Kind">
              <Space size={6}>
                <BuildKindTag kind={result.unit.kind} />
                <span>
                  {result.unit.kind === 'LOT' ? `${result.unit.quantity} pieces` : 'single unit'}
                </span>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <BuildStatusTag status={result.unit.status} />
            </Descriptions.Item>
            <Descriptions.Item label="Units affected">{result.counts.total}</Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      {loading && !result && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      )}

      {!result && !loading && (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No unit selected. Pick a serial or lot above to see where it ended up."
          />
        </Card>
      )}

      {result && (
        <Spin spinning={loading}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {hasTrace ? (
              <>
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={9}>
                    <Card>
                      <Statistic
                        title="Shipped units containing this one"
                        value={shipped.length}
                        prefix={shipped.length > 0 ? <WarningOutlined /> : undefined}
                        valueStyle={{
                          fontSize: 38,
                          color: shipped.length > 0 ? '#cf1322' : '#389e0d',
                        }}
                      />
                      <Typography.Text type="secondary">
                        {shipped.length > 0
                          ? 'Out of your hands — these need acting on.'
                          : 'Nothing has left the building.'}
                      </Typography.Text>
                    </Card>
                  </Col>
                  <Col xs={12} md={5}>
                    <Card>
                      <Statistic title="Units affected" value={affected.length} />
                    </Card>
                  </Col>
                  <Col xs={12} md={5}>
                    <Card>
                      <Statistic title="Still in-house" value={inHouse} />
                    </Card>
                  </Col>
                  <Col xs={12} md={5}>
                    <Card>
                      <Statistic title="Already scrapped" value={scrapped} />
                    </Card>
                  </Col>
                </Row>

                {shipped.length > 0 ? (
                  <Card
                    title={
                      <Space size={8}>
                        <WarningOutlined style={{ color: '#cf1322' }} />
                        <span>Shipped units to act on</span>
                      </Space>
                    }
                    extra={
                      <Button icon={<CopyOutlined />} onClick={() => void copyIdentifiers()}>
                        Copy identifiers
                      </Button>
                    }
                  >
                    <Alert
                      type="error"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message={`${shipped.length} shipped ${
                        shipped.length === 1 ? 'unit contains' : 'units contain'
                      } ${result.unit.identifier}`}
                      description="Every one of these left with the suspect unit inside. This is the list a recall or customer notice has to cover."
                    />
                    <Table<WhereConsumedEntry>
                      size="middle"
                      rowKey={(e) => e.unit.id}
                      columns={shippedColumns}
                      dataSource={shipped}
                      scroll={{ x: 900 }}
                      pagination={{
                        pageSize: 20,
                        hideOnSinglePage: true,
                        showSizeChanger: true,
                        showTotal: (t) => `${t} shipped units`,
                      }}
                    />
                  </Card>
                ) : (
                  <Alert
                    type="success"
                    showIcon
                    message={`Nothing has shipped with ${result.unit.identifier}`}
                    description={`It is built into ${affected.length} ${
                      affected.length === 1 ? 'unit' : 'units'
                    }, none of them shipped — containment can stop on the shop floor.`}
                  />
                )}

                {result.units.length > 0 && (
                  <Card
                    title="Full forward trace"
                    extra={
                      <Typography.Text type="secondary">
                        {result.counts.total} affected · {result.counts.topLevel} at top level
                      </Typography.Text>
                    }
                  >
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                      Every unit {result.unit.identifier} ended up inside, nearest first. "How it
                      got in" is the chain of consumptions from {result.unit.identifier} up to that
                      unit.
                    </Typography.Paragraph>
                    <Table<WhereConsumedEntry>
                      size="middle"
                      rowKey={(e) => e.unit.id}
                      columns={traceColumns}
                      dataSource={result.units}
                      pagination={false}
                      scroll={{ x: 900 }}
                    />
                  </Card>
                )}
              </>
            ) : result.unit.status === 'SHIPPED' ? (
              // Shipped without ever being consumed: a spare or a standalone deliverable, so the
              // unit itself is the whole recall set rather than there being nothing to do.
              <Alert
                type="warning"
                showIcon
                message={`${result.unit.identifier} shipped on its own`}
                description="It was never built into another unit, so there is no forward trace — the recall set is this unit itself."
              />
            ) : (
              <Card>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <>
                      <div>
                        <strong>{result.unit.identifier}</strong> has not been consumed anywhere
                        yet.
                      </div>
                      <Typography.Text type="secondary">
                        It is not built into any other unit and has not shipped, so nothing needs
                        chasing.
                      </Typography.Text>
                    </>
                  }
                />
              </Card>
            )}
          </Space>
        </Spin>
      )}
    </Space>
  );
}
