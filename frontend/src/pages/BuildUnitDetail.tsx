import { useCallback, useEffect, useRef, useState } from 'react';
import type { Key } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RedoOutlined,
  SendOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import ItemAccessCard from '../components/ItemAccessCard';
import { useAuth } from '../auth/AuthContext';
import type {
  AsBuiltLine,
  BomLineDetail,
  BuildUnitDetail as BuildUnitDetailDto,
  BuildUnitNcr,
  BuildUnitSummary,
  BuildUnitTransitionAction,
  DeviationReport,
  DeviationRow,
  DeviationStatus,
  GenealogyNode,
  NcrSummary,
} from '../api/types';
import {
  BUILD_STATUS_META,
  BuildKindTag,
  BuildStatusTag,
  DEVIATION_STATUS_META,
  DeviationStatusTag,
  formatDate,
  LifecycleTag,
  NcrSeverityTag,
  NcrStatusTag,
} from '../components/meta';

interface AsBuiltFormValues {
  childId: number;
  quantity: number;
  bomLineId?: number;
}

interface EditFormValues {
  identifier: string;
  quantity: number;
  notes?: string;
}

interface GenealogyRow {
  key: string;
  node: GenealogyNode;
  children?: GenealogyRow[];
}

/** Pairs each deviation status with its count field, so the summary tags follow the meta order. */
const DEVIATION_COUNTS: [DeviationStatus, keyof DeviationReport['counts']][] = [
  ['MATCH', 'match'],
  ['QTY_MISMATCH', 'qtyMismatch'],
  ['MISSING', 'missing'],
  ['UNPLANNED', 'unplanned'],
  ['SUBSTITUTED', 'substituted'],
];

function toRows(nodes: GenealogyNode[], prefix: string): GenealogyRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.unit.id}-${index}`;
    const children = node.children.length > 0 ? toRows(node.children, `${key}/`) : undefined;
    return { key, node, children };
  });
}

function collectExpandableKeys(rows: GenealogyRow[]): Key[] {
  const keys: Key[] = [];
  for (const row of rows) {
    if (row.children && row.children.length > 0) {
      keys.push(row.key);
      keys.push(...collectExpandableKeys(row.children));
    }
  }
  return keys;
}

export default function BuildUnitDetail() {
  const { id: idParam } = useParams();
  const unitId = Number(idParam);
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [unit, setUnit] = useState<BuildUnitDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);

  const [genealogyRows, setGenealogyRows] = useState<GenealogyRow[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);
  const [deviations, setDeviations] = useState<DeviationReport | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(unitId) || unitId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      setUnit(await api.getBuildUnit(unitId));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [unitId, message]);

  // Genealogy and the deviation report are both derived from the as-built lines, so they are
  // refetched together whenever those lines or the unit's status move.
  const loadTrace = useCallback(async () => {
    if (!Number.isInteger(unitId) || unitId <= 0) return;
    setTraceLoading(true);
    try {
      const [genealogy, report] = await Promise.all([
        api.getBuildUnitGenealogy(unitId),
        api.getBuildUnitDeviations(unitId),
      ]);
      const rows = toRows([genealogy], '');
      setGenealogyRows(rows);
      setExpandedKeys(collectExpandableKeys(rows));
      setDeviations(report);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      setTraceLoading(false);
    }
  }, [unitId, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    void loadTrace();
  }, [loadTrace]);

  // ---- add consumed unit ---------------------------------------------------
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addForm] = Form.useForm<AsBuiltFormValues>();
  const [candidates, setCandidates] = useState<BuildUnitSummary[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [bomLines, setBomLines] = useState<BomLineDetail[]>([]);
  // The child is held as an object, not an id: a later search replaces `candidates` and the
  // substitution hint below still needs the part of whatever was picked.
  const [picked, setPicked] = useState<{ child?: BuildUnitSummary; bomLineId?: number }>({});
  const [lineBusy, setLineBusy] = useState(false);
  const candidateTimer = useRef<number | undefined>(undefined);

  const fetchCandidates = useCallback(
    async (search: string) => {
      setCandidatesLoading(true);
      try {
        // Only a finished unit can be consumed (U3). The list filter takes one status at a
        // time, so both are queried — filtering a single mixed page client-side would leave
        // the picker empty whenever in-progress units fill it.
        const [completed, shipped] = await Promise.all([
          api.listBuildUnits({ search: search || undefined, status: 'COMPLETED', pageSize: 20 }),
          api.listBuildUnits({ search: search || undefined, status: 'SHIPPED', pageSize: 20 }),
        ]);
        setCandidates(
          [...completed.items, ...shipped.items].filter((u) => u.id !== unitId)
        );
      } catch {
        setCandidates([]);
      } finally {
        setCandidatesLoading(false);
      }
    },
    [unitId]
  );

  useEffect(() => () => window.clearTimeout(candidateTimer.current), []);

  // ---- edit ----------------------------------------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !unit) {
    return (
      <Empty description="Build unit not found">
        <Link to="/build-units">Back to build units</Link>
      </Empty>
    );
  }

  const canEdit = user?.role !== 'VIEWER';
  const frozen = unit.status === 'SHIPPED' || unit.status === 'SCRAPPED';
  const recordable = unit.status === 'IN_PROGRESS';

  const applyDetail = (updated: BuildUnitDetailDto) => {
    setUnit(updated);
    void loadTrace();
  };

  const transition = (
    action: BuildUnitTransitionAction,
    label: string,
    content: string,
    danger?: boolean
  ) => {
    modal.confirm({
      title: label,
      content,
      okText: label,
      okButtonProps: danger ? { danger: true } : undefined,
      onOk: async () => {
        setActing(true);
        try {
          const updated = await api.transitionBuildUnit(unit.id, action);
          applyDetail(updated);
          message.success(`${updated.identifier} → ${BUILD_STATUS_META[updated.status].label}`);
        } catch (err) {
          // The refusals here (already consumed, changed concurrently) explain themselves,
          // so the server's wording is shown as-is rather than paraphrased.
          modal.error({
            title: `Cannot ${action} ${unit.identifier}`,
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          // A concurrent change is one of the refusals, so pull the whole page back in sync.
          await load();
          void loadTrace();
        } finally {
          setActing(false);
        }
      },
    });
  };

  const openAdd = () => {
    setAddError(null);
    addForm.resetFields();
    addForm.setFieldsValue({ quantity: 1 });
    setPicked({});
    void fetchCandidates('');
    void (async () => {
      try {
        setBomLines(await api.getBom(unit.partRevision.id));
      } catch {
        setBomLines([]);
      }
    })();
    setAddOpen(true);
  };

  const saveAdd = async () => {
    let values: AsBuiltFormValues;
    try {
      values = await addForm.validateFields();
    } catch {
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      applyDetail(
        await api.addAsBuiltLine(unit.id, {
          childId: values.childId,
          quantity: values.quantity,
          bomLineId: values.bomLineId,
        })
      );
      message.success('Consumption recorded');
      setAddOpen(false);
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setAddSaving(false);
    }
  };

  const removeLine = async (line: AsBuiltLine) => {
    setLineBusy(true);
    try {
      await api.deleteAsBuiltLine(line.id);
      applyDetail(await api.getBuildUnit(unit.id));
      message.success(`${line.child.identifier} removed from the as-built record`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLineBusy(false);
    }
  };

  const openEdit = () => {
    setEditError(null);
    editForm.setFieldsValue({
      identifier: unit.identifier,
      quantity: unit.quantity,
      notes: unit.notes ?? undefined,
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    let values: EditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      applyDetail(
        await api.updateBuildUnit(unit.id, {
          identifier: values.identifier.trim(),
          quantity: unit.kind === 'SERIAL' ? 1 : values.quantity,
          notes: values.notes?.trim() ? values.notes.trim() : null,
        })
      );
      message.success('Build unit updated');
      setEditOpen(false);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  // A substitution is computed server-side; showing it before saving stops it reading as a
  // surprise when the recorded line comes back flagged.
  const pickedLine = bomLines.find((l) => l.id === picked.bomLineId);
  const willSubstitute =
    picked.child !== undefined &&
    pickedLine !== undefined &&
    picked.child.part.id !== pickedLine.childPart.id;

  const asBuiltColumns: ColumnsType<AsBuiltLine> = [
    {
      title: 'Unit',
      key: 'child',
      width: 160,
      render: (_, l) => (
        <Space size={6} wrap>
          <Link to={`/build-units/${l.child.id}`}>{l.child.identifier}</Link>
          <BuildKindTag kind={l.child.kind} />
        </Space>
      ),
    },
    {
      title: 'Part',
      key: 'part',
      ellipsis: true,
      render: (_, l) => (
        <Space size={6} wrap>
          <Link to={`/parts/${l.child.part.id}`}>{l.child.part.partNumber}</Link>
          <Typography.Text type="secondary">{l.child.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      render: (_, l) => `${l.quantity} ${l.child.part.uom}`,
    },
    {
      title: 'eBOM line',
      key: 'bomLine',
      width: 220,
      render: (_, l) =>
        l.bomLine ? (
          <Space size={6} wrap>
            <Typography.Text type="secondary">Find {l.bomLine.findNumber}</Typography.Text>
            <Link to={`/parts/${l.bomLine.childPart.id}`}>{l.bomLine.childPart.partNumber}</Link>
            {l.substitution && <Tag color="purple">substitution</Tag>}
          </Space>
        ) : (
          <Tag color="orange">unplanned</Tag>
        ),
    },
    {
      title: 'Recorded',
      key: 'recorded',
      width: 220,
      render: (_, l) => `${formatDate(l.recordedAt)} by ${l.recordedBy.name}`,
    },
    // The as-built record of a unit no longer in progress is history, so it stays read-only.
    ...(canEdit && recordable
      ? [
          {
            title: '',
            key: 'actions',
            width: 50,
            render: (_: unknown, l: AsBuiltLine) => (
              <Popconfirm
                title={`Remove ${l.child.identifier} from this record?`}
                onConfirm={() => void removeLine(l)}
              >
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ];

  const genealogyColumns: ColumnsType<GenealogyRow> = [
    {
      title: 'Unit',
      key: 'unit',
      render: (_, r) => (
        <Space size={6} wrap>
          {r.node.unit.id === unit.id ? (
            <Typography.Text strong>{r.node.unit.identifier}</Typography.Text>
          ) : (
            <Link to={`/build-units/${r.node.unit.id}`}>{r.node.unit.identifier}</Link>
          )}
          <BuildKindTag kind={r.node.unit.kind} />
          {r.node.substitution && <Tag color="purple">substitution</Tag>}
          {r.node.hasOpenNonconformances && (
            <Tag color="red" icon={<WarningOutlined />}>
              open NCR
            </Tag>
          )}
          {r.node.truncated && <Tag>depth limit — not expanded</Tag>}
        </Space>
      ),
    },
    {
      title: 'Part',
      key: 'part',
      width: 300,
      ellipsis: true,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link to={`/parts/${r.node.unit.part.id}`}>{r.node.unit.part.partNumber}</Link>
          <Typography.Text type="secondary">{r.node.unit.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Consumed',
      key: 'quantity',
      width: 120,
      align: 'right',
      render: (_, r) =>
        r.node.quantity === null ? '—' : `${r.node.quantity} ${r.node.unit.part.uom}`,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <BuildStatusTag status={r.node.unit.status} />,
    },
  ];

  const deviationColumns: ColumnsType<DeviationRow> = [
    {
      title: 'Part',
      key: 'part',
      ellipsis: true,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link to={`/parts/${r.part.id}`}>{r.part.partNumber}</Link>
          <Typography.Text type="secondary">{r.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Deviation',
      key: 'status',
      width: 150,
      render: (_, r) => <DeviationStatusTag status={r.status} />,
    },
    {
      title: 'Planned',
      key: 'planned',
      width: 100,
      align: 'right',
      render: (_, r) => (r.plannedQuantity === null ? '—' : r.plannedQuantity),
    },
    {
      title: 'As built',
      key: 'actual',
      width: 100,
      align: 'right',
      render: (_, r) => (r.builtQuantity === null ? '—' : r.builtQuantity),
    },
    {
      title: 'Stood in for',
      key: 'unapprovedSubstitutionFor',
      width: 180,
      render: (_, r) =>
        r.unapprovedSubstitutionFor ? (
          <Link to={`/parts/${r.unapprovedSubstitutionFor.id}`}>{r.unapprovedSubstitutionFor.partNumber}</Link>
        ) : (
          '—'
        ),
    },
    {
      title: 'Units',
      key: 'consumedBy',
      width: 240,
      render: (_, r) =>
        r.consumed.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={6} wrap>
            {r.consumed.map((c) => (
              <Link key={c.asBuiltLineId} to={`/build-units/${c.unit.id}`}>
                {c.unit.identifier}
              </Link>
            ))}
          </Space>
        ),
    },
  ];

  const ncrColumns: ColumnsType<BuildUnitNcr> = [
    {
      title: 'NCR #',
      key: 'ncrNumber',
      width: 130,
      render: (_, r) => <Link to={`/ncrs/${r.id}`}>{r.ncrNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Severity',
      key: 'severity',
      width: 110,
      render: (_, r) => <NcrSeverityTag severity={r.severity} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <NcrStatusTag status={r.status} />,
    },
    { title: 'Raised', key: 'createdAt', width: 160, render: (_, r) => formatDate(r.createdAt) },
  ];

  return (
    <div>
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Read-only access — an engineer account is needed to build or change this unit."
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space direction="vertical" size={4}>
            <Space size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {unit.identifier}
              </Typography.Title>
              <BuildKindTag kind={unit.kind} />
              <BuildStatusTag status={unit.status} />
            </Space>
            <Typography.Text type="secondary">
              As-built record · opened by {unit.createdBy.name} on {formatDate(unit.createdAt)}
            </Typography.Text>
          </Space>
          {canEdit && !frozen && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
          )}
        </div>

        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Part">
            <Link to={`/parts/${unit.part.id}`}>
              {unit.part.partNumber} — {unit.part.name}
            </Link>
          </Descriptions.Item>
          <Descriptions.Item label="Built to revision">
            <Space size={6}>
              <span>Rev {unit.partRevision.revision}</span>
              <LifecycleTag lifecycle={unit.partRevision.lifecycle} />
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Quantity">
            {unit.quantity} {unit.part.uom}
          </Descriptions.Item>
          <Descriptions.Item label="Built">{formatDate(unit.builtAt)}</Descriptions.Item>
          <Descriptions.Item label="Shipped">{formatDate(unit.shippedAt)}</Descriptions.Item>
          <Descriptions.Item label="Consumed by">
            {unit.consumedBy.length === 0 ? (
              <Typography.Text type="secondary">Not built into anything yet</Typography.Text>
            ) : (
              <Space size={6} wrap>
                {unit.consumedBy.map((usage) => (
                  <Link key={usage.id} to={`/build-units/${usage.parent.id}`}>
                    {usage.parent.identifier} ({usage.quantity})
                  </Link>
                ))}
              </Space>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Notes" span={3}>
            {unit.notes ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {canEdit && (
        <Card
          style={{ marginBottom: 16 }}
          styles={{ body: { display: 'flex', gap: 8, flexWrap: 'wrap' } }}
        >
          {unit.status === 'IN_PROGRESS' && (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={acting}
              onClick={() =>
                transition(
                  'complete',
                  'Complete',
                  'Mark this unit as built? Its as-built record is then frozen until it is reopened.'
                )
              }
            >
              Complete
            </Button>
          )}
          {unit.status === 'COMPLETED' && (
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={acting}
              onClick={() => transition('ship', 'Ship', 'Record this unit as shipped?')}
            >
              Ship
            </Button>
          )}
          {unit.status === 'COMPLETED' && (
            <Button
              icon={<RedoOutlined />}
              loading={acting}
              onClick={() =>
                transition(
                  'reopen',
                  'Reopen',
                  'Reopen this unit so its as-built record can be changed? This is refused once a parent has consumed it.'
                )
              }
            >
              Reopen
            </Button>
          )}
          {(unit.status === 'IN_PROGRESS' || unit.status === 'COMPLETED') && (
            <Button
              danger
              icon={<StopOutlined />}
              loading={acting}
              onClick={() =>
                transition('scrap', 'Scrap', 'Scrap this unit? Scrapping cannot be undone.', true)
              }
            >
              Scrap
            </Button>
          )}
          {frozen && (
            <Typography.Text type="secondary">
              {unit.identifier} is {BUILD_STATUS_META[unit.status].label.toLowerCase()} — this
              record is final.
            </Typography.Text>
          )}
        </Card>
      )}

      <Card
        title="As-built record"
        style={{ marginBottom: 16 }}
        extra={
          canEdit &&
          recordable && (
            <Button size="small" icon={<PlusOutlined />} onClick={openAdd}>
              Add consumed unit
            </Button>
          )
        }
      >
        <Table<AsBuiltLine>
          size="small"
          rowKey="id"
          columns={asBuiltColumns}
          dataSource={unit.asBuiltLines}
          loading={lineBusy}
          pagination={false}
          locale={{
            emptyText: recordable
              ? 'Nothing recorded yet — add the units that went into this one.'
              : 'No consumption was recorded against this unit.',
          }}
        />
      </Card>

      <Card title="Genealogy" style={{ marginBottom: 16 }}>
        <Typography.Paragraph type="secondary">
          What went into this unit, recursively. Expand a row to follow the chain down.
        </Typography.Paragraph>
        <Table<GenealogyRow>
          size="small"
          rowKey="key"
          columns={genealogyColumns}
          dataSource={genealogyRows}
          loading={traceLoading}
          pagination={false}
          expandable={{
            expandedRowKeys: expandedKeys as Key[],
            onExpandedRowsChange: (keys) => setExpandedKeys(keys),
          }}
        />
      </Card>

      <Card
        title="As-built vs as-designed"
        style={{ marginBottom: 16 }}
        extra={
          deviations && (
            <Space size={6} wrap>
              {DEVIATION_COUNTS.filter(([, field]) => deviations.counts[field] > 0).map(
                ([status, field]) => (
                  <Tag key={status} color={DEVIATION_STATUS_META[status].color}>
                    {deviations.counts[field]} {DEVIATION_STATUS_META[status].label.toLowerCase()}
                  </Tag>
                )
              )}
            </Space>
          )
        }
      >
        <Typography.Paragraph type="secondary">
          Every line of the eBOM for rev {unit.partRevision.revision} against what was actually
          consumed. An approved alternate is reported as a substitution, not as a defect.
        </Typography.Paragraph>
        <Table<DeviationRow>
          size="small"
          rowKey={(r) => `${r.part.id}-${r.status}`}
          columns={deviationColumns}
          dataSource={deviations?.rows ?? []}
          loading={traceLoading}
          pagination={false}
          locale={{ emptyText: 'Nothing to compare — the eBOM and the as-built record are empty.' }}
        />
      </Card>

      <Card title="Nonconformances">
        <Table<BuildUnitNcr>
          size="small"
          rowKey="id"
          columns={ncrColumns}
          dataSource={unit.nonconformances}
          pagination={false}
          locale={{ emptyText: 'No nonconformance has been raised against this unit.' }}
        />
      </Card>

      <Modal
        title={`Add a consumed unit to ${unit.identifier}`}
        open={addOpen}
        onOk={() => void saveAdd()}
        okText="Record"
        confirmLoading={addSaving}
        onCancel={() => setAddOpen(false)}
        width={640}
        forceRender
      >
        {addError && <Alert type="error" showIcon message={addError} style={{ marginBottom: 16 }} />}
        <Form
          form={addForm}
          layout="vertical"
          onValuesChange={(changed: Partial<AsBuiltFormValues>) =>
            setPicked((prev) => ({
              child:
                changed.childId === undefined
                  ? prev.child
                  : candidates.find((c) => c.id === changed.childId),
              bomLineId: 'bomLineId' in changed ? changed.bomLineId : prev.bomLineId,
            }))
          }
        >
          <Form.Item
            name="childId"
            label="Unit consumed"
            tooltip="Only completed or shipped units can be built into something else."
            rules={[{ required: true, message: 'Select the unit that went in' }]}
          >
            <Select
              showSearch
              placeholder="Search a serial or lot code"
              filterOption={false}
              loading={candidatesLoading}
              onSearch={(value) => {
                window.clearTimeout(candidateTimer.current);
                candidateTimer.current = window.setTimeout(() => void fetchCandidates(value), 300);
              }}
              options={candidates.map((c) => ({
                value: c.id,
                label: `${c.identifier} — ${c.part.partNumber} (${c.quantity} ${c.part.uom})`,
              }))}
              notFoundContent={candidatesLoading ? 'Searching…' : 'No finished units found'}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="quantity"
              label="Quantity consumed"
              style={{ width: 190 }}
              rules={[{ required: true, message: 'How much went in?' }]}
            >
              <InputNumber min={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="bomLineId"
              label="eBOM line satisfied"
              style={{ flex: 1 }}
              extra="Leave blank to record an unplanned consumption."
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Unplanned"
                options={bomLines.map((l) => ({
                  value: l.id,
                  label: `Find ${l.findNumber} — ${l.childPart.partNumber} (${l.quantity} ${l.uom})`,
                }))}
                notFoundContent="This revision has no eBOM lines"
              />
            </Form.Item>
          </Space>
          {willSubstitute && picked.child && pickedLine && (
            <Alert
              type="warning"
              showIcon
              message={`Recorded as a substitution: ${picked.child.part.partNumber} in place of ${pickedLine.childPart.partNumber}.`}
            />
          )}
        </Form>
      </Modal>

      <Modal
        title="Edit build unit"
        open={editOpen}
        onOk={() => void saveEdit()}
        okText="Save"
        confirmLoading={editSaving}
        onCancel={() => setEditOpen(false)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={editForm} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="identifier"
              label={unit.kind === 'SERIAL' ? 'Serial' : 'Lot code'}
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'An identifier is required' }, { max: 100 }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="quantity"
              label="Quantity"
              style={{ width: 160 }}
              tooltip={unit.kind === 'SERIAL' ? 'A serialized unit is always one.' : undefined}
              rules={[{ required: true, message: 'A quantity is required' }]}
            >
              <InputNumber
                min={unit.kind === 'SERIAL' ? 1 : 0.001}
                max={unit.kind === 'SERIAL' ? 1 : undefined}
                disabled={unit.kind === 'SERIAL'}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 16 }}>
        <ItemAccessCard entityType="BUILD_UNIT" entityId={unit.id} />
      </div>
    </div>
  );
}
