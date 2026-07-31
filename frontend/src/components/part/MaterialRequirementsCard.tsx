import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, InputNumber, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, ExperimentOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { MaterialRequirement, MaterialRequirements } from '../../api/types';

const { Text } = Typography;

/**
 * Rule N3 — "what do we need to buy to build this?" A build-quantity input, the per-material
 * totals with estimated cost, and — as loudly as the totals — the parts that declare no
 * material at all: the holes someone would otherwise order against.
 */
export default function MaterialRequirementsCard(props: { revisionId: number }) {
  const { revisionId } = props;
  const [quantity, setQuantity] = useState(1);
  const [report, setReport] = useState<MaterialRequirements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.getMaterialRequirements(revisionId, quantity));
    } catch (err) {
      setReport(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load material requirements');
    } finally {
      setLoading(false);
    }
  }, [revisionId, quantity]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const columns: ColumnsType<MaterialRequirement> = [
    {
      title: 'Material',
      key: 'material',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>
            {row.material.code} · {row.material.name}
          </Text>
          <Text type="secondary">
            {row.fromParts.map((source) => `${source.part.partNumber} ×${source.totalParts}`).join(', ')}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Net',
      dataIndex: 'netQuantity',
      width: 110,
      render: (net: number, row) => `${net} ${row.stockUom}`,
    },
    {
      title: 'Gross (incl. scrap)',
      dataIndex: 'grossQuantity',
      width: 140,
      render: (gross: number, row) => (
        <Text strong>
          {gross} {row.stockUom}
        </Text>
      ),
    },
    {
      title: 'Est. cost',
      dataIndex: 'estimatedCost',
      width: 110,
      render: (cost: number | null) =>
        cost === null ? <Tag>no cost</Tag> : cost.toFixed(2),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space>
          <ExperimentOutlined />
          Material requirements
        </Space>
      }
      loading={loading && !report}
      extra={
        <Space>
          <span>
            Build qty{' '}
            <InputNumber
              min={1}
              value={quantity}
              onChange={(value) => setQuantity(value ?? 1)}
              style={{ width: 90 }}
            />
          </span>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            href={api.materialRequirementsCsvUrl(revisionId, quantity)}
          >
            CSV
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {report && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {report.unspecified.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${report.unspecified.length} part${report.unspecified.length === 1 ? '' : 's'} with no material declared`}
              description={report.unspecified
                .map((gap) => `${gap.part.partNumber} (×${gap.totalParts})`)
                .join(', ')}
            />
          )}
          {report.notes.map((note) => (
            <Alert key={note} type="info" showIcon message={note} />
          ))}
          <Table
            size="small"
            rowKey={(row) => row.material.id}
            columns={columns}
            dataSource={report.materials}
            pagination={false}
            locale={{ emptyText: 'No materials declared anywhere in this structure yet.' }}
            summary={() =>
              report.totalEstimatedCost !== null ? (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={3}>
                    <Text strong>Estimated material cost per {report.buildQuantity} build(s)</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1}>
                    <Text strong>{report.totalEstimatedCost.toFixed(2)}</Text>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              ) : null
            }
          />
        </Space>
      )}
    </Card>
  );
}
