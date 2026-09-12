import { useCallback, useEffect, useState } from 'react';
import type { Key } from 'react';
import { Link } from 'react-router-dom';
import { Alert, App as AntdApp, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { CostRollup, CostRollupNode, RevisionDetail } from '../../api/types';
import { formatMoney } from '../meta';

interface TreeRow {
  key: string;
  node: CostRollupNode;
  children?: TreeRow[];
}

function toRows(nodes: CostRollupNode[], prefix: string): TreeRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.part.id}-${index}`;
    const children = node.children.length > 0 ? toRows(node.children, `${key}/`) : undefined;
    return { key, node, children };
  });
}

function collectExpandableKeys(rows: TreeRow[]): Key[] {
  const keys: Key[] = [];
  for (const row of rows) {
    if (row.children && row.children.length > 0) {
      keys.push(row.key);
      keys.push(...collectExpandableKeys(row.children));
    }
  }
  return keys;
}

export default function CostTab({ revision }: { revision: RevisionDetail }): JSX.Element {
  const { message } = AntdApp.useApp();
  const [rollup, setRollup] = useState<CostRollup | null>(null);
  const [treeRows, setTreeRows] = useState<TreeRow[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getCostRollup(revision.id);
      const rows = toRows(data.nodes, '');
      setRollup(data);
      setTreeRows(rows);
      setExpandedKeys(collectExpandableKeys(rows));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [revision.id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<TreeRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) => (
        <Space size={8}>
          <Link to={`/parts/${row.node.part.id}`}>
            <Typography.Text style={{ color: 'inherit' }}>
              {row.node.part.partNumber}
            </Typography.Text>
          </Link>
          <Typography.Text type="secondary">{row.node.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (_, row) => row.node.quantity,
    },
    {
      title: 'Unit cost',
      key: 'unitCost',
      width: 180,
      align: 'right',
      render: (_, row) => {
        const { unitCost, effectiveUnitCost, missing } = row.node;
        if (missing) return <Tag color="red">no cost</Tag>;
        if (unitCost === null && effectiveUnitCost !== null) {
          return (
            <Space size={6}>
              <Typography.Text type="secondary" italic>
                roll-up
              </Typography.Text>
              {formatMoney(effectiveUnitCost)}
            </Space>
          );
        }
        return formatMoney(effectiveUnitCost);
      },
    },
    {
      title: 'Extended',
      key: 'extended',
      width: 150,
      align: 'right',
      render: (_, row) => (
        <Typography.Text strong>{formatMoney(row.node.extendedCost)}</Typography.Text>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Statistic
          title={`Total rolled-up cost — ${revision.part.partNumber} rev ${revision.revision}`}
          value={formatMoney(rollup?.totalCost ?? null)}
        />
        {rollup && rollup.missingCosts.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ flex: 1, minWidth: 280 }}
            message="Some parts have no unit cost — the totals are incomplete."
            description={`Missing cost: ${rollup.missingCosts.join(', ')}`}
          />
        )}
      </div>

      <Table<TreeRow>
        size="middle"
        rowKey="key"
        columns={columns}
        dataSource={treeRows}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No BOM lines — nothing to roll up.' }}
        expandable={{
          expandedRowKeys: expandedKeys as Key[],
          onExpandedRowsChange: (keys) => setExpandedKeys(keys),
        }}
      />
    </div>
  );
}
