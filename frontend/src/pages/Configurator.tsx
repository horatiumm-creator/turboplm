import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Collapse,
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
import { ControlOutlined, ThunderboltOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  OptionGroupDetail,
  PartRef,
  RevisionSummary,
  VariantBomLine,
  VariantResolution,
} from '../api/types';
import { CategoryTag, LifecycleTag, LIFECYCLE_META } from '../components/meta';

function defaultSelections(groups: OptionGroupDetail[]): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const group of groups) {
    const defaults = group.values.filter((v) => v.isDefault).map((v) => v.code);
    next[group.code] = group.multiSelect ? defaults : defaults.slice(0, 1);
  }
  return next;
}

export default function Configurator() {
  const { message } = AntdApp.useApp();

  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partId, setPartId] = useState<number | undefined>(undefined);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [revisionId, setRevisionId] = useState<number | undefined>(undefined);

  const [groups, setGroups] = useState<OptionGroupDetail[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const [result, setResult] = useState<VariantResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(searchTimer.current);
  }, []);

  const searchParts = useCallback((value: string) => {
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await api.listParts({ search: value || undefined, pageSize: 20 });
          setPartOptions(res.items);
        } catch {
          /* leave the previous options in place */
        }
      })();
    }, 300);
  }, []);

  const pickPart = useCallback(
    async (nextPartId: number) => {
      setPartId(nextPartId);
      setResult(null);
      setError(null);
      setGroupsLoading(true);
      try {
        const [part, optionGroups] = await Promise.all([
          api.getPart(nextPartId),
          api.listOptionGroups(nextPartId),
        ]);
        setRevisions(part.revisions);
        setRevisionId(part.revisions[0]?.id);
        setGroups(optionGroups);
        setSelections(defaultSelections(optionGroups));
      } catch (err) {
        setRevisions([]);
        setRevisionId(undefined);
        setGroups([]);
        setSelections({});
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setGroupsLoading(false);
      }
    },
    [message]
  );

  const setGroupSelection = (groupCode: string, valueCodes: string[]) => {
    setSelections((prev) => ({ ...prev, [groupCode]: valueCodes }));
  };

  const resolve = async () => {
    if (revisionId === undefined) return;
    setResolving(true);
    setError(null);
    try {
      const payload = groups
        .map((group) => ({
          groupCode: group.code,
          valueCodes: selections[group.code] ?? [],
        }))
        .filter((entry) => entry.valueCodes.length > 0);
      setResult(await api.resolveVariant(revisionId, payload));
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setResolving(false);
    }
  };

  const lineColumns: ColumnsType<VariantBomLine> = [
    {
      title: 'Find #',
      key: 'findNumber',
      width: 80,
      align: 'right',
      render: (_, line) => line.findNumber,
    },
    {
      title: 'Part',
      key: 'part',
      render: (_, line) => (
        <Space size={8}>
          <Link to={`/parts/${line.part.id}`}>{line.part.partNumber}</Link>
          <Typography.Text type="secondary">{line.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Category',
      key: 'category',
      width: 130,
      render: (_, line) => <CategoryTag category={line.part.category} />,
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 120,
      align: 'right',
      render: (_, line) => `${line.quantity} ${line.uom}`,
    },
    {
      title: 'Rev',
      key: 'revision',
      width: 190,
      render: (_, line) =>
        line.revision ? (
          <Space size={4}>
            <Tag>{line.revision.revision}</Tag>
            <LifecycleTag lifecycle={line.revision.lifecycle} />
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Conditions',
      key: 'conditions',
      render: (_, line) =>
        line.conditions.length === 0 ? (
          <Typography.Text type="secondary">always</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {line.conditions.map((code) => (
              <Tag key={code} color="blue">
                {code}
              </Tag>
            ))}
          </Space>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Configurator
      </Typography.Title>
      <Typography.Text type="secondary">
        Pick a configurable product, choose its options and resolve the variant BOM — lines without
        option conditions are always included.
      </Typography.Text>

      <Card>
        {error && (
          <Alert
            type="error"
            showIcon
            closable
            message={error}
            style={{ marginBottom: 16 }}
            onClose={() => setError(null)}
          />
        )}
        <Row gutter={[16, 16]} align="bottom">
          <Col xs={24} md={10}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Typography.Text strong>Product</Typography.Text>
              <Select
                showSearch
                placeholder="Search part number or name"
                style={{ width: '100%' }}
                filterOption={false}
                value={partId}
                onFocus={() => searchParts('')}
                onSearch={searchParts}
                onSelect={(value: number) => void pickPart(value)}
                options={partOptions.map((p) => ({
                  value: p.id,
                  label: `${p.partNumber} — ${p.name}`,
                }))}
              />
            </Space>
          </Col>
          <Col xs={24} md={10}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Typography.Text strong>Revision</Typography.Text>
              <Select
                placeholder="Revision"
                style={{ width: '100%' }}
                value={revisionId}
                disabled={revisions.length === 0}
                onChange={(value: number) => {
                  setRevisionId(value);
                  setResult(null);
                }}
                options={revisions.map((r) => ({
                  value: r.id,
                  label: `Rev ${r.revision} — ${LIFECYCLE_META[r.lifecycle].label}`,
                }))}
              />
            </Space>
          </Col>
          <Col xs={24} md={4}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              block
              disabled={revisionId === undefined}
              loading={resolving}
              onClick={() => void resolve()}
            >
              Resolve
            </Button>
          </Col>
        </Row>

        <Spin spinning={groupsLoading}>
          {partId !== undefined && groups.length === 0 && !groupsLoading && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 16 }}
              message="This part has no option groups"
              description="Every BOM line of the selected revision is unconditional. Add option groups on the part's Options tab to make it configurable."
            />
          )}
          {groups.length > 0 && (
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              {groups.map((group) => (
                <Col xs={24} md={12} lg={8} key={group.id}>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space size={8} wrap>
                      <Typography.Text strong>{group.name}</Typography.Text>
                      <Typography.Text code>{group.code}</Typography.Text>
                      {group.required && <Tag color="red">Required</Tag>}
                      {group.multiSelect && <Tag>Multi-select</Tag>}
                    </Space>
                    {group.multiSelect ? (
                      <Select<string[]>
                        mode="multiple"
                        allowClear
                        style={{ width: '100%' }}
                        placeholder={`Select ${group.name.toLowerCase()}`}
                        value={selections[group.code] ?? []}
                        onChange={(values) => setGroupSelection(group.code, values ?? [])}
                        options={group.values.map((v) => ({
                          value: v.code,
                          label: `${v.code} — ${v.name}`,
                        }))}
                      />
                    ) : (
                      <Select<string>
                        allowClear
                        style={{ width: '100%' }}
                        placeholder={`Select ${group.name.toLowerCase()}`}
                        value={selections[group.code]?.[0]}
                        onChange={(value) => setGroupSelection(group.code, value ? [value] : [])}
                        options={group.values.map((v) => ({
                          value: v.code,
                          label: `${v.code} — ${v.name}`,
                        }))}
                      />
                    )}
                    {group.description && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {group.description}
                      </Typography.Text>
                    )}
                  </Space>
                </Col>
              ))}
            </Row>
          )}
        </Spin>
      </Card>

      {result && (
        <Spin spinning={resolving}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Row gutter={[16, 16]}>
              <Col flex="1 1 180px">
                <Card>
                  <Statistic
                    title="Included lines"
                    value={result.included.length}
                    valueStyle={{ color: '#389e0d' }}
                  />
                </Card>
              </Col>
              <Col flex="1 1 180px">
                <Card>
                  <Statistic
                    title="Excluded lines"
                    value={result.excluded.length}
                    valueStyle={{ color: '#cf1322' }}
                  />
                </Card>
              </Col>
              <Col flex="1 1 180px">
                <Card>
                  <Statistic title="Always included" value={result.unconditionalCount} />
                </Card>
              </Col>
            </Row>

            <Card
              title={
                <Space size={8} wrap>
                  <ControlOutlined />
                  <Typography.Text strong>
                    {result.part.partNumber} rev {result.revision.revision}
                  </Typography.Text>
                  <LifecycleTag lifecycle={result.revision.lifecycle} />
                  {result.selections.length === 0 ? (
                    <Typography.Text type="secondary">no options selected</Typography.Text>
                  ) : (
                    result.selections.map((sel) => (
                      <Tag key={sel.groupCode} color="blue">
                        {sel.groupCode}: {sel.valueCodes.join(', ')}
                      </Tag>
                    ))
                  )}
                </Space>
              }
              styles={{ body: { padding: 0 } }}
            >
              <Table<VariantBomLine>
                size="middle"
                rowKey="lineId"
                columns={lineColumns}
                dataSource={result.included}
                pagination={false}
                locale={{ emptyText: 'No BOM lines are included for this configuration.' }}
              />
            </Card>

            <Collapse
              items={[
                {
                  key: 'excluded',
                  label: `Excluded lines (${result.excluded.length})`,
                  children: (
                    <Table<VariantBomLine>
                      size="small"
                      rowKey="lineId"
                      columns={lineColumns}
                      dataSource={result.excluded}
                      pagination={false}
                      locale={{ emptyText: 'Nothing was excluded by this configuration.' }}
                    />
                  ),
                },
              ]}
            />
          </Space>
        </Spin>
      )}

      {!result && !resolving && (
        <Empty description="Pick a product and a revision, choose the options you want, then Resolve to see the variant BOM." />
      )}
    </Space>
  );
}
