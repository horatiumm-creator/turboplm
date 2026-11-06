import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { BulbOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { AiCapabilities, AiPaidBy, ChangeBrief, ChangeBriefItem } from '../../api/types';
import AiProvenance from '../AiProvenance';
import { LifecycleTag } from '../meta';

/**
 * What this change reaches — and, if the deployment has an API key, a model's reading of it.
 *
 * Sits alongside the existing "Change impact" card rather than replacing it. That card answers
 * which BOM lines call a part out, with find numbers and quantities, which is what you want
 * while editing a structure. This one answers the consequences: the products the change reaches
 * however deep, the released assemblies whose structure is already committed to it, what has
 * already been built and shipped, the requirements it may invalidate.
 *
 * The brief loads on its own and needs no AI. The narrative is a button, because it costs money
 * per press, and the brief stays on screen beside it so the summary can be checked against the
 * facts rather than taken on trust.
 */
export default function ChangeBriefCard({ ecnId }: { ecnId: number }): JSX.Element {
  const { message } = AntdApp.useApp();
  const [brief, setBrief] = useState<ChangeBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeModel, setNarrativeModel] = useState<string | null>(null);
  const [narrativePaidBy, setNarrativePaidBy] = useState<AiPaidBy | null>(null);
  const [narrativePartial, setNarrativePartial] = useState(false);
  const [thinking, setThinking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [result, caps] = await Promise.all([
        api.getChangeBrief(ecnId),
        // A deployment with no key is the normal case, so a failure here must not stop the
        // brief from rendering.
        api.getAiCapabilities().catch(() => null),
      ]);
      setBrief(result);
      setCapabilities(caps);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [ecnId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const explain = async () => {
    setThinking(true);
    try {
      const result = await api.aiEcnNarrative(ecnId);
      setNarrative(result.narrative);
      setNarrativeModel(result.model);
      setNarrativePaidBy(result.paidBy);
      setNarrativePartial(result.inputTruncated);
      // The brief comes back with the narrative; use that one so the two cannot disagree.
      setBrief(result.brief);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setThinking(false);
    }
  };

  const columns: ColumnsType<ChangeBriefItem> = [
    {
      title: 'Affected part',
      key: 'part',
      render: (_value, item) => (
        <Space direction="vertical" size={0}>
          <Link to={`/parts/${item.part.id}`}>{item.part.partNumber}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.part.name}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Revision',
      key: 'revision',
      width: 120,
      render: (_value, item) => (
        <Typography.Text>
          {item.fromRevision ?? '—'} → {item.toRevision ?? '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'Products reached',
      key: 'products',
      render: (_value, item) =>
        item.products.length === 0 && item.redactedProducts === 0 ? (
          <Typography.Text type="secondary">None</Typography.Text>
        ) : (
          <Space direction="vertical" size={2}>
            {item.products.map((p) => (
              <Tooltip key={p.id} title={p.path.join(' → ')}>
                <Link to={`/parts/${p.id}`}>{p.partNumber}</Link>
              </Tooltip>
            ))}
            {/* Counted, never dropped: a brief that hid one would call the change safe. */}
            {item.redactedProducts > 0 && (
              <Tooltip title="Reached, but you do not have access to it">
                <Tag>
                  {item.redactedProducts} restricted
                </Tag>
              </Tooltip>
            )}
          </Space>
        ),
    },
    {
      title: 'Released assemblies',
      key: 'released',
      render: (_value, item) =>
        item.releasedAssemblies.length === 0 ? (
          <Typography.Text type="secondary">None</Typography.Text>
        ) : (
          <Space direction="vertical" size={2}>
            {item.releasedAssemblies.map((a, i) => (
              <Space key={`${a.part.id}-${a.revision}-${i}`} size={4}>
                <Typography.Text>{a.part.partNumber}</Typography.Text>
                <Tag>{a.revision}</Tag>
                <LifecycleTag lifecycle={a.lifecycle} />
              </Space>
            ))}
          </Space>
        ),
    },
    {
      title: 'Built',
      key: 'built',
      width: 150,
      render: (_value, item) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{item.builtUnits.length} unit(s)</Typography.Text>
          {item.shippedCount > 0 && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {item.shippedCount} shipped
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Open against it',
      key: 'open',
      width: 180,
      render: (_value, item) => (
        <Space direction="vertical" size={2}>
          {item.requirements.length > 0 && (
            <Typography.Text style={{ fontSize: 12 }}>
              {item.requirements.length} requirement(s)
            </Typography.Text>
          )}
          {item.openNcrs.map((n) => (
            <Tag key={n.id} color="orange">
              {n.ncrNumber}
            </Tag>
          ))}
          {item.requirements.length === 0 && item.openNcrs.length === 0 && (
            <Typography.Text type="secondary">Nothing</Typography.Text>
          )}
        </Space>
      ),
    },
  ];

  const totals = brief?.totals;

  return (
    <Card
      title="What this change reaches"
      extra={
        /* Hidden entirely when the deployment has no key, rather than offered and failing. */
        capabilities?.features.changeNarrative ? (
          <Tooltip title={`Summarise this brief using ${capabilities.model}`}>
            <Button
              icon={<BulbOutlined />}
              loading={thinking}
              onClick={explain}
              disabled={!brief || brief.items.length === 0}
            >
              Explain this change
            </Button>
          </Tooltip>
        ) : null
      }
    >
      {loading ? (
        <Spin />
      ) : !brief || brief.items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Add the affected parts and this fills in."
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {narrative && (
            <Alert
              type="info"
              showIcon
              icon={<BulbOutlined />}
              message={
                <Space size={6}>
                  <span>What this looks like</span>
                  {/* Labelled, always. The reader is entitled to know what wrote it, and the
                      person who pressed the button to know whose account paid for it. */}
                  <AiProvenance model={narrativeModel} paidBy={narrativePaidBy} />
                </Space>
              }
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>{narrative}</Typography.Text>
                  {narrativePartial && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      The brief was too long to send in full, so this summary did not see all of
                      it. The table below is complete.
                    </Typography.Text>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Written from the figures below and nothing else. Check it against them.
                  </Typography.Text>
                </Space>
              }
            />
          )}

          {brief.notes.map((note) => (
            <Alert key={note} type="warning" showIcon message={note} />
          ))}

          {totals && (
            <Descriptions size="small" column={4} bordered>
              <Descriptions.Item label="Affected parts">{totals.affectedParts}</Descriptions.Item>
              <Descriptions.Item label="Products reached">
                {totals.products}
                {totals.redactedProducts > 0 && ` (+${totals.redactedProducts} restricted)`}
              </Descriptions.Item>
              <Descriptions.Item label="Released assemblies">
                {totals.releasedAssemblies}
              </Descriptions.Item>
              <Descriptions.Item label="Shipped units">
                {/* The number most likely to stop a release, so it is coloured like one. */}
                <Typography.Text type={totals.shippedUnits > 0 ? 'danger' : undefined}>
                  {totals.shippedUnits}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          )}

          <Table<ChangeBriefItem>
            size="middle"
            rowKey={(item) => item.part.id}
            columns={columns}
            dataSource={brief.items}
            pagination={false}
          />
        </Space>
      )}
    </Card>
  );
}
