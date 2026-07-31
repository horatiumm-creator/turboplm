import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { BomReconciliation, BomReconciliationRow, ReconStatus } from '../../api/types';

const STATUS_META: Record<ReconStatus, { label: string; color: string; hint: string }> = {
  QTY_MISMATCH: {
    label: 'Quantity differs',
    color: 'gold',
    hint: 'The eBOM and the mBOM disagree on how many are used',
  },
  MISSING_IN_MBOM: {
    label: 'Not consumed',
    color: 'red',
    hint: 'On the eBOM but no operation consumes it — the plan is incomplete',
  },
  EXTRA_IN_MBOM: {
    label: 'Not on eBOM',
    color: 'volcano',
    hint: 'Consumed by an operation but absent from the eBOM, and not flagged as a consumable',
  },
  CONSUMABLE_ONLY: {
    label: 'Consumable',
    color: 'purple',
    hint: 'Manufacturing-only material — expected to be absent from the eBOM',
  },
  MATCH: { label: 'Aligned', color: 'green', hint: 'Quantities agree' },
};

const fmtQty = (value: number | null) => (value === null ? '—' : String(value));

export default function BomReconciliationCard({
  revisionId,
  editable,
  /** Bumped by the parent after any plan edit so the view refetches. */
  refreshKey,
  onGenerated,
}: {
  revisionId: number;
  editable: boolean;
  refreshKey: number;
  onGenerated: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<BomReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getBomReconciliation(revisionId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load the comparison');
    } finally {
      setLoading(false);
    }
  }, [revisionId, message]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const generate = async () => {
    setGenerating(true);
    try {
      await api.generatePlanFromBom(revisionId);
      message.success('Operation added from the eBOM');
      onGenerated();
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not generate from the eBOM');
    } finally {
      setGenerating(false);
    }
  };

  const columns: ColumnsType<BomReconciliationRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) => (
        <Space size={6} wrap>
          <Link to={`/parts/${row.part.id}`}>{row.part.partNumber}</Link>
          <Typography.Text type="secondary">{row.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 160,
      render: (_, row) => {
        const meta = STATUS_META[row.status];
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'eBOM',
      key: 'ebom',
      width: 90,
      align: 'right',
      render: (_, row) => fmtQty(row.ebomQuantity),
    },
    {
      title: 'mBOM',
      key: 'mbom',
      width: 90,
      align: 'right',
      render: (_, row) => fmtQty(row.mbomNominalQuantity),
    },
    {
      title: 'With scrap',
      key: 'withScrap',
      width: 110,
      align: 'right',
      render: (_, row) =>
        // Only worth showing when a scrap allowance actually changes the figure.
        row.mbomQuantity !== null && row.mbomQuantity !== row.mbomNominalQuantity ? (
          <Typography.Text type="warning">{row.mbomQuantity}</Typography.Text>
        ) : (
          fmtQty(row.mbomQuantity)
        ),
    },
    {
      title: 'Consumed by',
      key: 'consumedBy',
      render: (_, row) =>
        row.consumedBy.length === 0 ? (
          <Typography.Text type="secondary">nothing</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.consumedBy.map((c) => (
              <Tag key={c.operationId}>
                {c.seq}. {c.name} · {c.quantity}
                {c.scrapFactor > 0 ? ` +${(c.scrapFactor * 100).toFixed(1)}%` : ''}
              </Tag>
            ))}
          </Space>
        ),
    },
  ];

  const counts = data?.counts;
  const defects = counts ? counts.qtyMismatch + counts.missingInMbom + counts.extraInMbom : 0;

  return (
    <Card
      title="eBOM ↔ mBOM"
      style={{ marginBottom: 16 }}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            Refresh
          </Button>
          {editable && (
            <Tooltip title="Add an operation consuming every eBOM line not already covered">
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={generating}
                onClick={() => void generate()}
              >
                Generate from eBOM
              </Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      {loading && !data ? (
        <Skeleton active />
      ) : !data ? null : (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {data.rows.length === 0 ? (
            <Alert
              type="info"
              showIcon
              message="Nothing to compare yet"
              description="Add eBOM lines on the eBOM tab, then generate the manufacturing plan from them."
            />
          ) : defects === 0 ? (
            <Alert
              type="success"
              showIcon
              message="The manufacturing plan covers the eBOM"
              description={
                counts && counts.consumableOnly > 0
                  ? `${counts.match} part(s) aligned, plus ${counts.consumableOnly} manufacturing-only consumable(s).`
                  : `${counts?.match ?? 0} part(s) aligned.`
              }
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              message={`${defects} discrepanc${defects === 1 ? 'y' : 'ies'} between engineering and manufacturing`}
              description={
                <Space size={12} wrap>
                  {counts!.missingInMbom > 0 && (
                    <span>{counts!.missingInMbom} eBOM part(s) nothing consumes</span>
                  )}
                  {counts!.qtyMismatch > 0 && (
                    <span>{counts!.qtyMismatch} quantity disagreement(s)</span>
                  )}
                  {counts!.extraInMbom > 0 && (
                    <span>{counts!.extraInMbom} consumed part(s) not on the eBOM</span>
                  )}
                </Space>
              }
            />
          )}

          {data.rows.length > 0 && (
            <Table<BomReconciliationRow>
              size="small"
              rowKey={(row) => row.part.id}
              columns={columns}
              dataSource={data.rows}
              loading={loading}
              pagination={false}
            />
          )}
        </Space>
      )}
    </Card>
  );
}
