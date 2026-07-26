import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { Link } from 'react-router-dom';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BomCompareNode, BomCompareSide } from '../api/types';
import { CompareStatusTag, LIFECYCLE_META } from './meta';

interface CompareRow {
  key: string;
  node: BomCompareNode;
  children?: CompareRow[];
}

function toRows(nodes: BomCompareNode[], prefix: string): CompareRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.part.id}-${index}`;
    const children = node.children.length > 0 ? toRows(node.children, `${key}/`) : undefined;
    return { key, node, children };
  });
}

function collectKeys(rows: CompareRow[]): Key[] {
  const keys: Key[] = [];
  for (const row of rows) {
    if (row.children && row.children.length > 0) {
      keys.push(row.key);
      keys.push(...collectKeys(row.children));
    }
  }
  return keys;
}

function sideCell(
  side: BomCompareSide | null,
  field: 'quantity' | 'findNumber',
  changed: boolean
) {
  if (!side) return <Typography.Text type="secondary">—</Typography.Text>;
  const value = field === 'quantity' ? `${side.quantity} ${side.uom}` : side.findNumber;
  return changed ? <Typography.Text strong>{value}</Typography.Text> : <>{value}</>;
}

function revCell(side: BomCompareSide | null, changed: boolean) {
  if (!side) return <Typography.Text type="secondary">—</Typography.Text>;
  const label = side.revision?.revision ?? side.revisionLabel ?? null;
  if (label === null) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4}>
      <Tag color={changed ? 'gold' : undefined}>{label}</Tag>
      {side.revision && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {LIFECYCLE_META[side.revision.lifecycle].label}
        </Typography.Text>
      )}
    </Space>
  );
}

export default function CompareResultView(props: {
  summary: { added: number; removed: number; changed: number; unchanged: number };
  nodes: BomCompareNode[];
  leftTitle: string;
  rightTitle: string;
}): JSX.Element {
  const { summary, nodes, leftTitle, rightTitle } = props;

  const rows = useMemo(() => toRows(nodes, ''), [nodes]);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);

  // Expand everything whenever a new result comes in.
  useEffect(() => {
    setExpandedKeys(collectKeys(rows));
  }, [rows]);

  const columns: ColumnsType<CompareRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) => (
        <Space size={8}>
          <Link to={`/parts/${row.node.part.id}`}>{row.node.part.partNumber}</Link>
          <Typography.Text type="secondary">{row.node.part.name}</Typography.Text>
          {row.node.cycle && <Tag color="red">cycle</Tag>}
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, row) => <CompareStatusTag status={row.node.status} />,
    },
    {
      title: leftTitle,
      children: [
        {
          title: 'Find #',
          key: 'lfind',
          width: 80,
          align: 'right' as const,
          render: (_: unknown, row: CompareRow) =>
            sideCell(row.node.left, 'findNumber', row.node.changedFields.includes('findNumber')),
        },
        {
          title: 'Qty',
          key: 'lqty',
          width: 110,
          align: 'right' as const,
          render: (_: unknown, row: CompareRow) =>
            sideCell(row.node.left, 'quantity', row.node.changedFields.includes('quantity')),
        },
        {
          title: 'Rev',
          key: 'lrev',
          width: 140,
          render: (_: unknown, row: CompareRow) =>
            revCell(row.node.left, row.node.changedFields.includes('revision')),
        },
      ],
    },
    {
      title: rightTitle,
      children: [
        {
          title: 'Find #',
          key: 'rfind',
          width: 80,
          align: 'right' as const,
          render: (_: unknown, row: CompareRow) =>
            sideCell(row.node.right, 'findNumber', row.node.changedFields.includes('findNumber')),
        },
        {
          title: 'Qty',
          key: 'rqty',
          width: 110,
          align: 'right' as const,
          render: (_: unknown, row: CompareRow) =>
            sideCell(row.node.right, 'quantity', row.node.changedFields.includes('quantity')),
        },
        {
          title: 'Rev',
          key: 'rrev',
          width: 140,
          render: (_: unknown, row: CompareRow) =>
            revCell(row.node.right, row.node.changedFields.includes('revision')),
        },
      ],
    },
    {
      title: 'Changed',
      key: 'changed',
      width: 200,
      render: (_, row) =>
        row.node.changedFields.length > 0 ? (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {row.node.changedFields.join(', ')}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col flex="1 1 150px">
          <Card>
            <Statistic title="Added" value={summary.added} valueStyle={{ color: '#389e0d' }} />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card>
            <Statistic title="Removed" value={summary.removed} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card>
            <Statistic title="Changed" value={summary.changed} valueStyle={{ color: '#d48806' }} />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card>
            <Statistic title="Unchanged" value={summary.unchanged} />
          </Card>
        </Col>
      </Row>

      <Card title={`${leftTitle}  ⇄  ${rightTitle}`} styles={{ body: { padding: 0 } }}>
        {rows.length === 0 ? (
          <Empty style={{ padding: 32 }} description="Neither side has BOM lines to compare." />
        ) : (
          <Table<CompareRow>
            size="middle"
            rowKey="key"
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 1150 }}
            rowClassName={(row) =>
              row.node.status === 'ADDED'
                ? 'compare-row-added'
                : row.node.status === 'REMOVED'
                  ? 'compare-row-removed'
                  : row.node.status === 'CHANGED'
                    ? 'compare-row-changed'
                    : ''
            }
            expandable={{
              expandedRowKeys: expandedKeys as Key[],
              onExpandedRowsChange: (keys) => setExpandedKeys(keys),
            }}
          />
        )}
      </Card>
    </Space>
  );
}
