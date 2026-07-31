import { useCallback, useEffect, useRef, useState } from 'react';
import type { Key } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PartitionOutlined,
  PlusOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type {
  BomLineAlternateDetail,
  BomTreeNode,
  OptionGroupDetail,
  PartRef,
  RevisionDetail,
} from '../../api/types';
import { CategoryTag, LifecycleTag } from '../meta';
import CadImportModal from './CadImportModal';

interface TreeRow {
  key: string;
  node: BomTreeNode;
  /** 0 = direct child of the viewed revision — the only editable level. */
  depth: number;
  children?: TreeRow[];
}

interface BomLineFormValues {
  childPartId: number;
  quantity: number;
  uom?: string;
  findNumber?: number;
  refDesignators?: string;
  notes?: string;
  effective?: [Dayjs | null, Dayjs | null] | null;
}

function toRows(nodes: BomTreeNode[], prefix: string, depth: number): TreeRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.line.id}-${index}`;
    const children =
      node.children.length > 0 ? toRows(node.children, `${key}/`, depth + 1) : undefined;
    return { key, node, depth, children };
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

const formatDay = (iso: string) => dayjs(iso).format('YYYY-MM-DD');

function formatEffectivity(from: string | null, to: string | null): string {
  if (from && to) return `${formatDay(from)} → ${formatDay(to)}`;
  if (from) return `from ${formatDay(from)}`;
  if (to) return `until ${formatDay(to)}`;
  return '—';
}

export default function BomTab({
  revision,
  editable,
  onChanged,
}: {
  revision: RevisionDetail;
  editable: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { message, modal } = AntdApp.useApp();
  const [cadOpen, setCadOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [treeRows, setTreeRows] = useState<TreeRow[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);
  const [asOf, setAsOf] = useState<Dayjs | null>(null);

  // Add / edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<TreeRow | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const [form] = Form.useForm<BomLineFormValues>();

  // Alternates (edit modal only)
  const [alternates, setAlternates] = useState<BomLineAlternateDetail[]>([]);
  const [altOptions, setAltOptions] = useState<PartRef[]>([]);
  const [altLoading, setAltLoading] = useState(false);
  const [altPartId, setAltPartId] = useState<number | undefined>(undefined);
  const [altNote, setAltNote] = useState('');
  const [altAdding, setAltAdding] = useState(false);
  const altSearchTimer = useRef<number | undefined>(undefined);

  // Option conditions (variants): the part's option groups are fetched once, the first
  // time the add/edit modal is opened, and the Options field only shows when there are any.
  const [optionGroups, setOptionGroups] = useState<OptionGroupDetail[]>([]);
  const optionGroupsLoadedRef = useRef(false);
  const [lineOptionIds, setLineOptionIds] = useState<number[]>([]);
  const [optionsDirty, setOptionsDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tree = await api.getBomTree(revision.id, asOf ? asOf.toISOString() : undefined);
      const rows = toRows(tree, '', 0);
      setTreeRows(rows);
      setExpandedKeys(collectExpandableKeys(rows));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [revision.id, asOf, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimer.current);
      window.clearTimeout(altSearchTimer.current);
    };
  }, []);

  useEffect(() => {
    optionGroupsLoadedRef.current = false;
    setOptionGroups([]);
  }, [revision.partId]);

  const ensureOptionGroups = useCallback(async () => {
    if (optionGroupsLoadedRef.current) return;
    optionGroupsLoadedRef.current = true;
    try {
      setOptionGroups(await api.listOptionGroups(revision.partId));
    } catch {
      // Options are an optional extra — keep the field hidden when they cannot be loaded.
      optionGroupsLoadedRef.current = false;
    }
  }, [revision.partId]);

  const fetchParts = useCallback(
    async (search: string) => {
      setPartLoading(true);
      try {
        const res = await api.listParts({ search: search || undefined, pageSize: 20 });
        setPartOptions(res.items.filter((p) => p.id !== revision.partId));
      } catch {
        setPartOptions([]);
      } finally {
        setPartLoading(false);
      }
    },
    [revision.partId]
  );

  const handlePartSearch = (value: string) => {
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void fetchParts(value);
    }, 300);
  };

  const fetchAltParts = useCallback(async (search: string) => {
    setAltLoading(true);
    try {
      const res = await api.listParts({ search: search || undefined, pageSize: 20 });
      setAltOptions(res.items);
    } catch {
      setAltOptions([]);
    } finally {
      setAltLoading(false);
    }
  }, []);

  const handleAltSearch = (value: string) => {
    window.clearTimeout(altSearchTimer.current);
    altSearchTimer.current = window.setTimeout(() => {
      void fetchAltParts(value);
    }, 300);
  };

  const openAdd = () => {
    setEditingRow(null);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ quantity: 1 });
    setLineOptionIds([]);
    setOptionsDirty(false);
    void fetchParts('');
    void ensureOptionGroups();
    setModalOpen(true);
  };

  const openEdit = (row: TreeRow) => {
    setEditingRow(row);
    setModalError(null);
    form.resetFields();
    setPartOptions([row.node.part]);
    setAlternates(row.node.line.alternates);
    setAltOptions([]);
    setAltPartId(undefined);
    setAltNote('');
    setLineOptionIds([]);
    setOptionsDirty(false);
    form.setFieldsValue({
      childPartId: row.node.part.id,
      quantity: row.node.line.quantity,
      uom: row.node.line.uom,
      findNumber: row.node.line.findNumber,
      refDesignators: row.node.line.refDesignators ?? undefined,
      notes: row.node.line.notes ?? undefined,
      effective:
        row.node.line.effectiveFrom || row.node.line.effectiveTo
          ? [
              row.node.line.effectiveFrom ? dayjs(row.node.line.effectiveFrom) : null,
              row.node.line.effectiveTo ? dayjs(row.node.line.effectiveTo) : null,
            ]
          : undefined,
    });
    void fetchAltParts('');
    void ensureOptionGroups();
    setModalOpen(true);
  };

  const handlePartSelect = (partId: number) => {
    const part = partOptions.find((p) => p.id === partId);
    if (part) {
      form.setFieldsValue({ uom: part.uom });
    }
  };

  const handleSubmit = async () => {
    let values: BomLineFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const effectiveFrom = values.effective?.[0] ? values.effective[0].toISOString() : null;
    const effectiveTo = values.effective?.[1] ? values.effective[1].toISOString() : null;
    setSubmitting(true);
    setModalError(null);
    try {
      let savedLineId: number;
      if (editingRow) {
        await api.updateBomLine(editingRow.node.line.id, {
          quantity: values.quantity,
          uom: values.uom?.trim() || undefined,
          findNumber: values.findNumber ?? undefined,
          refDesignators: values.refDesignators?.trim() ? values.refDesignators.trim() : null,
          notes: values.notes?.trim() ? values.notes.trim() : null,
          effectiveFrom,
          effectiveTo,
        });
        savedLineId = editingRow.node.line.id;
        message.success('BOM line updated');
      } else {
        const created = await api.addBomLine(revision.id, {
          childPartId: values.childPartId,
          quantity: values.quantity,
          uom: values.uom?.trim() || undefined,
          findNumber: values.findNumber ?? undefined,
          refDesignators: values.refDesignators?.trim() || undefined,
          notes: values.notes?.trim() || undefined,
          effectiveFrom,
          effectiveTo,
        });
        savedLineId = created.id;
        message.success('Component added');
      }
      // The line itself is already saved — an option-condition failure must not roll the
      // modal back into an "unsaved" state, so it is reported separately.
      if (optionsDirty && optionGroups.length > 0) {
        try {
          await api.setBomLineOptions(savedLineId, lineOptionIds);
        } catch (err) {
          message.error(
            `Line saved, but the option conditions could not be updated: ${
              err instanceof ApiError ? err.message : 'something went wrong'
            }`
          );
        }
      }
      setModalOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const addAlternate = async () => {
    if (!editingRow || altPartId === undefined) return;
    setAltAdding(true);
    setModalError(null);
    try {
      const created = await api.addBomLineAlternate(editingRow.node.line.id, {
        partId: altPartId,
        note: altNote.trim() || undefined,
      });
      setAlternates((prev) => [...prev, created]);
      setAltPartId(undefined);
      setAltNote('');
      message.success('Alternate added');
      await load();
      onChanged();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setAltAdding(false);
    }
  };

  const removeAlternate = async (alternateId: number) => {
    setModalError(null);
    try {
      await api.removeBomLineAlternate(alternateId);
      setAlternates((prev) => prev.filter((a) => a.id !== alternateId));
      message.success('Alternate removed');
      await load();
      onChanged();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  const confirmDelete = (row: TreeRow) => {
    modal.confirm({
      title: 'Remove BOM line',
      content: `Remove ${row.node.part.partNumber} — ${row.node.part.name} from this BOM?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteBomLine(row.node.line.id);
          message.success('BOM line removed');
          await load();
          onChanged();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const columns: ColumnsType<TreeRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) => (
        <Space size={8}>
          <Link to={`/parts/${row.node.part.id}`}>
            <Typography.Text strong={row.depth === 0} style={{ color: 'inherit' }}>
              {row.node.part.partNumber}
            </Typography.Text>
          </Link>
          <Typography.Text type="secondary">{row.node.part.name}</Typography.Text>
          {row.node.line.alternates.length > 0 && (
            <Tooltip
              title={`Alternates: ${row.node.line.alternates
                .map((a) => a.part.partNumber)
                .join(', ')}`}
            >
              <Tag>+{row.node.line.alternates.length} alt</Tag>
            </Tooltip>
          )}
          {row.node.cycle && (
            <Tooltip title="This branch loops back on itself and is truncated.">
              <Tag color="red">cycle</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Find #',
      key: 'findNumber',
      width: 80,
      align: 'right',
      render: (_, row) => row.node.line.findNumber,
    },
    {
      title: 'Category',
      key: 'category',
      width: 120,
      render: (_, row) => <CategoryTag category={row.node.part.category} />,
    },
    {
      title: 'Rev',
      key: 'rev',
      width: 190,
      render: (_, row) =>
        row.node.revision ? (
          <Space size={4}>
            <Tag>{row.node.revision.revision}</Tag>
            <LifecycleTag lifecycle={row.node.revision.lifecycle} />
            {row.node.unreleased && (
              <Tooltip title="This part has no released revision; showing its latest revision.">
                <WarningOutlined style={{ color: '#faad14' }} />
              </Tooltip>
            )}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: 80,
      align: 'right',
      render: (_, row) => row.node.line.quantity,
    },
    {
      title: 'UoM',
      key: 'uom',
      width: 70,
      render: (_, row) => row.node.line.uom,
    },
    {
      title: 'Effectivity',
      key: 'effectivity',
      width: 180,
      render: (_, row) =>
        formatEffectivity(row.node.line.effectiveFrom, row.node.line.effectiveTo),
    },
    {
      title: 'RefDes',
      key: 'refDesignators',
      ellipsis: true,
      render: (_, row) => row.node.line.refDesignators ?? '—',
    },
    {
      title: 'Notes',
      key: 'notes',
      ellipsis: true,
      render: (_, row) => row.node.line.notes ?? '—',
    },
    ...(editable
      ? ([
          {
            title: 'Actions',
            key: 'actions',
            width: 150,
            render: (_, row) =>
              row.depth === 0 ? (
                <Space size={0}>
                  <Button
                    type="link"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEdit(row)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => confirmDelete(row)}
                  >
                    Delete
                  </Button>
                </Space>
              ) : (
                <Tooltip title="Lower levels belong to child revisions — open the child part to edit them.">
                  <Typography.Text type="secondary">—</Typography.Text>
                </Tooltip>
              ),
          },
        ] as ColumnsType<TreeRow>)
      : []),
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Typography.Text type="secondary">
          Product structure of {revision.part.partNumber} rev {revision.revision} — first level is
          editable{editable ? '' : ' when the revision is In Work'}; deeper levels come from each
          child&#39;s resolved revision.
        </Typography.Text>
        <Space size={8}>
          {asOf && <Tag>effectivity filter active</Tag>}
          <DatePicker
            allowClear
            placeholder="As of"
            value={asOf}
            onChange={(value) => setAsOf(value)}
          />
          <Button icon={<DownloadOutlined />} href={api.bomExportUrl(revision.id)}>
            Export CSV
          </Button>
          {editable && (
            <Button icon={<PartitionOutlined />} onClick={() => setCadOpen(true)}>
              Import from CAD
            </Button>
          )}
          {editable && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
              Add component
            </Button>
          )}
        </Space>
      </div>

      <Table<TreeRow>
        size="middle"
        rowKey="key"
        columns={columns}
        dataSource={treeRows}
        loading={loading}
        pagination={false}
        expandable={{
          expandedRowKeys: expandedKeys as Key[],
          onExpandedRowsChange: (keys) => setExpandedKeys(keys),
        }}
      />

      <Modal
        title={editingRow ? 'Edit BOM line' : 'Add component'}
        open={modalOpen}
        onOk={() => void handleSubmit()}
        okText={editingRow ? 'Save' : 'Add'}
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        width={editingRow ? 640 : 520}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="childPartId"
            label="Component part"
            rules={[{ required: true, message: 'Select a part' }]}
          >
            <Select
              showSearch
              disabled={editingRow !== null}
              placeholder="Search by part number or name"
              filterOption={false}
              onSearch={handlePartSearch}
              onSelect={(value: number) => handlePartSelect(value)}
              loading={partLoading}
              options={partOptions.map((p) => ({
                value: p.id,
                label: `${p.partNumber} — ${p.name}`,
              }))}
              notFoundContent={partLoading ? 'Searching…' : 'No parts found'}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="quantity"
              label="Quantity"
              rules={[{ required: true, message: 'Quantity is required' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="uom" label="UoM" style={{ flex: 1 }}>
              <Input placeholder="ea" />
            </Form.Item>
            <Form.Item name="findNumber" label="Find #" style={{ flex: 1 }}>
              <InputNumber
                min={1}
                max={2147483647}
                precision={0}
                placeholder="auto"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Space>
          <Form.Item name="effective" label="Effective">
            <DatePicker.RangePicker allowEmpty={[true, true]} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="refDesignators" label="Reference designators">
            <Input placeholder="e.g. R1, R2, C4" />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
          {optionGroups.length > 0 && (
            <Form.Item
              label="Options"
              help={
                editingRow
                  ? 'Selecting values replaces this line’s option conditions; leave untouched to keep them as they are.'
                  : 'Leave empty to always include this line; pick option values to include it only for those variants.'
              }
            >
              <Select<number[]>
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Always included"
                value={lineOptionIds}
                onChange={(ids) => {
                  setLineOptionIds(ids ?? []);
                  setOptionsDirty(true);
                }}
                options={optionGroups.map((group) => ({
                  label: group.name,
                  options: group.values.map((value) => ({
                    value: value.id,
                    label: `${value.code} — ${value.name}`,
                  })),
                }))}
              />
            </Form.Item>
          )}
        </Form>
        {editingRow && (
          <>
            <Divider orientation="left" plain>
              Alternates
            </Divider>
            <List
              size="small"
              dataSource={alternates}
              locale={{ emptyText: 'No alternate parts' }}
              renderItem={(alt) => (
                <List.Item
                  actions={[
                    <Button
                      key="remove"
                      type="link"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => void removeAlternate(alt.id)}
                    >
                      Remove
                    </Button>,
                  ]}
                >
                  <Space size={8}>
                    <Typography.Text>{alt.part.partNumber}</Typography.Text>
                    <Typography.Text type="secondary">{alt.part.name}</Typography.Text>
                    {alt.note && <Typography.Text type="secondary">— {alt.note}</Typography.Text>}
                  </Space>
                </List.Item>
              )}
            />
            <Space.Compact style={{ width: '100%', marginTop: 8 }}>
              <Select<number>
                showSearch
                style={{ width: '45%' }}
                placeholder="Search part to add as alternate"
                filterOption={false}
                value={altPartId}
                onSearch={handleAltSearch}
                onChange={(value) => setAltPartId(value)}
                loading={altLoading}
                options={altOptions
                  .filter(
                    (p) =>
                      p.id !== editingRow.node.part.id &&
                      !alternates.some((a) => a.part.id === p.id)
                  )
                  .map((p) => ({ value: p.id, label: `${p.partNumber} — ${p.name}` }))}
                notFoundContent={altLoading ? 'Searching…' : 'No parts found'}
              />
              <Input
                style={{ width: '35%' }}
                placeholder="Note (optional)"
                value={altNote}
                onChange={(e) => setAltNote(e.target.value)}
              />
              <Button
                style={{ width: '20%' }}
                icon={<PlusOutlined />}
                loading={altAdding}
                disabled={altPartId === undefined}
                onClick={() => void addAlternate()}
              >
                Add
              </Button>
            </Space.Compact>
          </>
        )}
      </Modal>

      <CadImportModal
        revision={revision}
        open={cadOpen}
        onClose={() => setCadOpen(false)}
        onApplied={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}
