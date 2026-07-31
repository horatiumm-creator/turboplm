import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import BomReconciliationCard from './BomReconciliationCard';
import type {
  OperationDetail,
  OperationMaterialDetail,
  ProcessPlanDetail,
  RevisionDetail,
} from '../../api/types';

interface PlanFormValues {
  name: string;
  description?: string;
}

interface OpFormValues {
  seq?: number;
  name: string;
  workCenter?: string;
  description?: string;
  setupMinutes?: number;
  runMinutes?: number;
}

interface MatFormValues {
  partId: number;
  quantity: number;
  uom?: string;
  notes?: string;
  /** Entered as a percentage; stored as a fraction. */
  scrapPercent?: number;
  consumable?: boolean;
}

const fmtMinutes = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function ProcessTab({
  revision,
  editable,
  onChanged,
}: {
  revision: RevisionDetail;
  editable: boolean;
  onChanged: () => void;
}) {
  const { message, modal } = AntdApp.useApp();

  const [plan, setPlan] = useState<ProcessPlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconKey, setReconKey] = useState(0);

  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [planForm] = Form.useForm<PlanFormValues>();

  const [opModalOpen, setOpModalOpen] = useState(false);
  const [editingOp, setEditingOp] = useState<OperationDetail | null>(null);
  const [opForm] = Form.useForm<OpFormValues>();

  const [matModal, setMatModal] = useState<{
    opId: number;
    material: OperationMaterialDetail | null;
  } | null>(null);
  const [matForm] = Form.useForm<MatFormValues>();

  const [partOptions, setPartOptions] = useState<{ value: number; label: string }[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showError = useCallback(
    (err: unknown) => {
      message.error(err instanceof api.ApiError ? err.message : 'Something went wrong');
    },
    [message]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPlan(await api.getProcessPlan(revision.id));
      // Every plan mutation funnels through here, so this is the one place that needs to
      // tell the comparison it is stale.
      setReconKey((key) => key + 1);
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  }, [revision.id, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  // ---- plan ----

  const createPlan = async () => {
    setCreating(true);
    try {
      await api.upsertProcessPlan(revision.id, {});
      message.success('Process plan created');
      await afterMutation();
    } catch (err) {
      showError(err);
    } finally {
      setCreating(false);
    }
  };

  const openPlanModal = () => {
    if (!plan) return;
    planForm.setFieldsValue({ name: plan.name, description: plan.description ?? undefined });
    setPlanModalOpen(true);
  };

  const submitPlan = async () => {
    let values: PlanFormValues;
    try {
      values = await planForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await api.upsertProcessPlan(revision.id, {
        name: values.name,
        description: values.description ? values.description : null,
      });
      setPlanModalOpen(false);
      message.success('Process plan updated');
      await afterMutation();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  };

  // ---- operations ----

  const openAddOp = () => {
    setEditingOp(null);
    opForm.resetFields();
    setOpModalOpen(true);
  };

  const openEditOp = (op: OperationDetail) => {
    setEditingOp(op);
    opForm.setFieldsValue({
      seq: op.seq,
      name: op.name,
      workCenter: op.workCenter ?? undefined,
      description: op.description ?? undefined,
      setupMinutes: op.setupMinutes,
      runMinutes: op.runMinutes,
    });
    setOpModalOpen(true);
  };

  const submitOp = async () => {
    if (!plan) return;
    let values: OpFormValues;
    try {
      values = await opForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editingOp) {
        await api.updateOperation(editingOp.id, {
          seq: values.seq,
          name: values.name,
          workCenter: values.workCenter ? values.workCenter : null,
          description: values.description ? values.description : null,
          setupMinutes: values.setupMinutes,
          runMinutes: values.runMinutes,
        });
        message.success('Operation updated');
      } else {
        await api.addOperation(plan.id, {
          seq: values.seq,
          name: values.name,
          workCenter: values.workCenter ? values.workCenter : undefined,
          description: values.description ? values.description : undefined,
          setupMinutes: values.setupMinutes,
          runMinutes: values.runMinutes,
        });
        message.success('Operation added');
      }
      setOpModalOpen(false);
      await afterMutation();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  };

  const confirmDeleteOp = (op: OperationDetail) => {
    modal.confirm({
      title: `Delete operation "${op.name}"?`,
      content: 'Its consumed materials will also be removed.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteOperation(op.id);
          message.success('Operation deleted');
          await afterMutation();
        } catch (err) {
          showError(err);
        }
      },
    });
  };

  // ---- materials ----

  const searchParts = async (search: string) => {
    setPartSearching(true);
    try {
      const res = await api.listParts({ search: search || undefined, pageSize: 20 });
      setPartOptions(
        res.items.map((p) => ({ value: p.id, label: `${p.partNumber} — ${p.name}` }))
      );
    } catch {
      // search failures are non-fatal; keep previous options
    } finally {
      setPartSearching(false);
    }
  };

  const onPartSearch = (value: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void searchParts(value);
    }, 300);
  };

  const openAddMaterial = (op: OperationDetail) => {
    matForm.resetFields();
    matForm.setFieldsValue({ quantity: 1, scrapPercent: 0, consumable: false });
    void searchParts('');
    setMatModal({ opId: op.id, material: null });
  };

  const openEditMaterial = (op: OperationDetail, m: OperationMaterialDetail) => {
    setPartOptions([{ value: m.part.id, label: `${m.part.partNumber} — ${m.part.name}` }]);
    matForm.setFieldsValue({
      partId: m.part.id,
      quantity: m.quantity,
      uom: m.uom,
      notes: m.notes ?? undefined,
      scrapPercent: m.scrapFactor * 100,
      consumable: m.consumable,
    });
    setMatModal({ opId: op.id, material: m });
  };

  const submitMaterial = async () => {
    if (!matModal) return;
    let values: MatFormValues;
    try {
      values = await matForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (matModal.material) {
        await api.updateOperationMaterial(matModal.material.id, {
          quantity: values.quantity,
          uom: values.uom ? values.uom : undefined,
          notes: values.notes ? values.notes : null,
          scrapFactor: (values.scrapPercent ?? 0) / 100,
          consumable: values.consumable ?? false,
        });
        message.success('Material updated');
      } else {
        await api.addOperationMaterial(matModal.opId, {
          partId: values.partId,
          quantity: values.quantity,
          uom: values.uom ? values.uom : undefined,
          notes: values.notes ? values.notes : undefined,
          scrapFactor: (values.scrapPercent ?? 0) / 100,
          consumable: values.consumable ?? false,
        });
        message.success('Material added');
      }
      setMatModal(null);
      await afterMutation();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  };

  const confirmDeleteMaterial = (m: OperationMaterialDetail) => {
    modal.confirm({
      title: `Remove material ${m.part.partNumber}?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteOperationMaterial(m.id);
          message.success('Material removed');
          await afterMutation();
        } catch (err) {
          showError(err);
        }
      },
    });
  };

  // ---- rendering ----

  const materialColumns = (op: OperationDetail): ColumnsType<OperationMaterialDetail> => {
    const cols: ColumnsType<OperationMaterialDetail> = [
      {
        title: 'Part Number',
        key: 'partNumber',
        render: (_, m) => <Link to={`/parts/${m.part.id}`}>{m.part.partNumber}</Link>,
      },
      { title: 'Name', key: 'name', render: (_, m) => m.part.name },
      {
        title: 'Qty',
        dataIndex: 'quantity',
        key: 'quantity',
        align: 'right',
        width: 90,
      },
      { title: 'UoM', dataIndex: 'uom', key: 'uom', width: 90 },
      {
        title: 'Scrap',
        key: 'scrapFactor',
        width: 90,
        align: 'right',
        render: (_, m) => (m.scrapFactor > 0 ? `${(m.scrapFactor * 100).toFixed(1)}%` : '—'),
      },
      {
        title: 'Type',
        key: 'consumable',
        width: 120,
        render: (_, m) =>
          m.consumable ? (
            <Tooltip title="Manufacturing-only material — not expected on the eBOM">
              <Tag color="purple">Consumable</Tag>
            </Tooltip>
          ) : (
            <Tag>Component</Tag>
          ),
      },
      {
        title: 'Notes',
        dataIndex: 'notes',
        key: 'notes',
        render: (notes: string | null) => notes ?? '—',
      },
    ];
    if (editable) {
      cols.push({
        title: '',
        key: 'actions',
        width: 90,
        render: (_, m) => (
          <Space size={4}>
            <Tooltip title="Edit material">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => openEditMaterial(op, m)}
              />
            </Tooltip>
            <Tooltip title="Delete material">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => confirmDeleteMaterial(m)}
              />
            </Tooltip>
          </Space>
        ),
      });
    }
    return cols;
  };

  const renderMaterials = (op: OperationDetail) => (
    <div style={{ paddingInline: 8 }}>
      <Table<OperationMaterialDetail>
        size="small"
        rowKey="id"
        columns={materialColumns(op)}
        dataSource={op.materials}
        pagination={false}
        locale={{ emptyText: 'No materials consumed by this operation' }}
      />
      {editable && (
        <Button
          size="small"
          icon={<PlusOutlined />}
          style={{ marginTop: 8 }}
          onClick={() => openAddMaterial(op)}
        >
          Add material
        </Button>
      )}
    </div>
  );

  const operations = plan ? [...plan.operations].sort((a, b) => a.seq - b.seq) : [];
  const totalSetup = operations.reduce((sum, op) => sum + op.setupMinutes, 0);
  const totalRun = operations.reduce((sum, op) => sum + op.runMinutes, 0);

  const opColumns: ColumnsType<OperationDetail> = [
    { title: 'Seq', dataIndex: 'seq', key: 'seq', width: 70 },
    {
      title: 'Operation name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: 'Work center',
      dataIndex: 'workCenter',
      key: 'workCenter',
      render: (wc: string | null) => wc ?? '—',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (d: string | null) => d ?? '—',
    },
    {
      title: 'Setup min',
      dataIndex: 'setupMinutes',
      key: 'setupMinutes',
      align: 'right',
      width: 100,
      render: (n: number) => fmtMinutes(n),
    },
    {
      title: 'Run min',
      dataIndex: 'runMinutes',
      key: 'runMinutes',
      align: 'right',
      width: 100,
      render: (n: number) => fmtMinutes(n),
    },
  ];
  if (editable) {
    opColumns.push({
      title: '',
      key: 'actions',
      width: 90,
      render: (_, op) => (
        <Space size={4}>
          <Tooltip title="Edit operation">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditOp(op)}
            />
          </Tooltip>
          <Tooltip title="Delete operation">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => confirmDeleteOp(op)}
            />
          </Tooltip>
        </Space>
      ),
    });
  }

  if (!plan) {
    return (
      <>
        <BomReconciliationCard
          revisionId={revision.id}
          editable={editable}
          refreshKey={reconKey}
          onGenerated={() => {
            void load();
            onChanged();
          }}
        />
        <Card>
          {loading ? (
            <Skeleton active />
          ) : (
            <Empty description="No process plan for this revision">
              {editable && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  loading={creating}
                  onClick={() => void createPlan()}
                >
                  Create process plan
                </Button>
              )}
            </Empty>
          )}
        </Card>
      </>
    );
  }

  return (
    <>
      <BomReconciliationCard
        revisionId={revision.id}
        editable={editable}
        refreshKey={reconKey}
        onGenerated={() => {
          void load();
          onChanged();
        }}
      />
      <Card
        title={
          <Space direction="vertical" size={0} style={{ paddingBlock: 8 }}>
            <Typography.Text strong>{plan.name}</Typography.Text>
            {plan.description && (
              <Typography.Text type="secondary" style={{ fontWeight: 'normal', fontSize: 13 }}>
                {plan.description}
              </Typography.Text>
            )}
          </Space>
        }
        extra={
          editable ? (
            <Space>
              <Button icon={<EditOutlined />} onClick={openPlanModal}>
                Edit
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={openAddOp}>
                Add operation
              </Button>
            </Space>
          ) : undefined
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {operations.length} operation{operations.length === 1 ? '' : 's'} · total setup{' '}
          {fmtMinutes(totalSetup)} min · total run {fmtMinutes(totalRun)} min
        </Typography.Paragraph>
        <Table<OperationDetail>
          size="middle"
          rowKey="id"
          loading={loading}
          columns={opColumns}
          dataSource={operations}
          pagination={false}
          expandable={{ expandedRowRender: renderMaterials }}
          locale={{ emptyText: 'No operations yet' }}
        />
      </Card>

      <Modal
        title="Edit process plan"
        open={planModalOpen}
        onOk={() => void submitPlan()}
        onCancel={() => setPlanModalOpen(false)}
        okText="Save"
        confirmLoading={saving}
        forceRender
      >
        <Form form={planForm} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Plan name is required' }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingOp ? `Edit operation "${editingOp.name}"` : 'Add operation'}
        open={opModalOpen}
        onOk={() => void submitOp()}
        onCancel={() => setOpModalOpen(false)}
        okText={editingOp ? 'Save' : 'Add'}
        confirmLoading={saving}
        forceRender
      >
        <Form form={opForm} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Operation name is required' }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="seq" label="Seq" tooltip="auto = next ×10">
            <InputNumber min={1} step={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="workCenter" label="Work center">
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space size="large" style={{ display: 'flex' }}>
            <Form.Item name="setupMinutes" label="Setup minutes" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="runMinutes" label="Run minutes" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={matModal?.material ? 'Edit material' : 'Add material'}
        open={matModal !== null}
        onOk={() => void submitMaterial()}
        onCancel={() => setMatModal(null)}
        okText={matModal?.material ? 'Save' : 'Add'}
        confirmLoading={saving}
        forceRender
      >
        <Form form={matForm} layout="vertical">
          <Form.Item
            name="partId"
            label="Part"
            rules={[{ required: true, message: 'Select a part' }]}
          >
            <Select
              showSearch
              filterOption={false}
              onSearch={onPartSearch}
              options={partOptions}
              loading={partSearching}
              notFoundContent={partSearching ? <Spin size="small" /> : undefined}
              placeholder="Search by part number or name"
              disabled={!!matModal?.material}
            />
          </Form.Item>
          <Form.Item
            name="quantity"
            label="Quantity"
            rules={[{ required: true, message: 'Quantity is required' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="uom" label="UoM" style={{ width: 120 }}>
              <Input maxLength={20} placeholder="ea" />
            </Form.Item>
            <Form.Item
              name="scrapPercent"
              label="Scrap %"
              style={{ width: 130 }}
              tooltip="Expected process loss. Reported alongside the nominal quantity, not treated as a discrepancy."
              rules={[{ type: 'number', min: 0, max: 99, message: '0–99' }]}
            >
              <InputNumber min={0} max={99} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="consumable"
              label="Consumable"
              valuePropName="checked"
              tooltip="Adhesive, solder, thread-lock — expected to be absent from the eBOM"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
