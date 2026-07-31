import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { MaterialForm as MaterialFormEnum, MaterialSummary, PartDetail, PartMaterial } from '../../api/types';

const { Text } = Typography;

const FORM_OPTIONS: MaterialFormEnum[] = [
  'SHEET',
  'PLATE',
  'BAR',
  'ROD',
  'TUBE',
  'PROFILE',
  'CASTING',
  'FORGING',
  'POWDER',
  'LIQUID',
  'OTHER',
];

interface RowFormValues {
  materialId: number;
  form: MaterialFormEnum;
  netQuantity: number;
  scrapFactor?: number;
  stockSize?: string;
  notes?: string;
}

/**
 * Rule N2 — what this part is made of, feeding the mBOM material requirements. Scrap is
 * entered as a percentage here and stored as a fraction; gross comes back computed.
 */
export default function MaterialsTab(props: { part: PartDetail; editable: boolean }) {
  const { part, editable } = props;
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<PartMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<MaterialSummary[]>([]);
  const [editing, setEditing] = useState<PartMaterial | 'new' | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<RowFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.listPartMaterials(part.id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to load materials');
    } finally {
      setLoading(false);
    }
  }, [part.id, message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openModal = async (target: PartMaterial | 'new') => {
    setEditing(target);
    setModalError(null);
    if (target === 'new') {
      form.resetFields();
      form.setFieldsValue({ form: 'BAR', scrapFactor: 0 });
    } else {
      form.setFieldsValue({
        materialId: target.material.id,
        form: target.form,
        netQuantity: target.netQuantity,
        scrapFactor: Math.round(target.scrapFactor * 10000) / 100,
        stockSize: target.stockSize ?? undefined,
        notes: target.notes ?? undefined,
      });
    }
    try {
      const result = await api.listMaterials({ active: true, pageSize: 100 });
      setCatalog(result.items);
    } catch {
      // The select stays empty; the modal error will say why on submit.
    }
  };

  const submit = async (values: RowFormValues) => {
    setSaving(true);
    setModalError(null);
    const input = {
      form: values.form,
      netQuantity: values.netQuantity,
      scrapFactor: (values.scrapFactor ?? 0) / 100,
      stockSize: values.stockSize || null,
      notes: values.notes || null,
    };
    try {
      const updated =
        editing === 'new'
          ? await api.addPartMaterial(part.id, { ...input, materialId: values.materialId })
          : await api.updatePartMaterial((editing as PartMaterial).id, input);
      setRows(updated);
      setEditing(null);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: PartMaterial) => {
    try {
      await api.deletePartMaterial(row.id);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to remove');
    }
  };

  const needsMaterial = part.category === 'MECHANICAL' || part.category === 'RAW_MATERIAL';

  const columns: ColumnsType<PartMaterial> = [
    {
      title: 'Material',
      key: 'material',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>
            {row.material.code} · {row.material.name}
          </Text>
          {row.material.specification && (
            <Text type="secondary">{row.material.specification}</Text>
          )}
        </Space>
      ),
    },
    { title: 'Form', dataIndex: 'form', width: 100, render: (value: string) => <Tag>{value}</Tag> },
    {
      title: 'Net / part',
      dataIndex: 'netQuantity',
      width: 120,
      render: (net: number, row) => `${net} ${row.material.stockUom}`,
    },
    {
      title: 'Scrap',
      dataIndex: 'scrapFactor',
      width: 90,
      render: (scrap: number) => `${Math.round(scrap * 10000) / 100}%`,
    },
    {
      title: 'Gross / part',
      dataIndex: 'grossQuantity',
      width: 120,
      render: (gross: number, row) => (
        <Text strong>
          {gross} {row.material.stockUom}
        </Text>
      ),
    },
    {
      title: 'Stock size',
      dataIndex: 'stockSize',
      render: (size: string | null) => size ?? <Text type="secondary">—</Text>,
    },
    ...(editable
      ? [
          {
            title: '',
            key: 'actions',
            width: 130,
            render: (_: unknown, row: PartMaterial) => (
              <Space size={0}>
                <Button size="small" type="text" onClick={() => void openModal(row)}>
                  Edit
                </Button>
                <Popconfirm title="Remove this material?" onConfirm={() => void remove(row)}>
                  <Button size="small" danger type="text">
                    Remove
                  </Button>
                </Popconfirm>
              </Space>
            ),
          } satisfies ColumnsType<PartMaterial>[number],
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {needsMaterial && rows.length === 0 && !loading && (
        <Alert
          type="info"
          showIcon
          message="No material declared"
          description="This part plausibly consumes raw stock. Until a material is declared it will appear as a planning gap in every material-requirements report that includes it — informational, never blocking."
        />
      )}
      {editable && (
        <div>
          <Button icon={<PlusOutlined />} onClick={() => void openModal('new')}>
            Add material
          </Button>
        </div>
      )}
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: 'No materials declared on this part.' }}
      />

      <Modal
        title={editing === 'new' ? 'Add material' : 'Edit material'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        destroyOnClose
      >
        {modalError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={modalError} />
        )}
        <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item
            name="materialId"
            label="Material"
            rules={[{ required: true, message: 'Pick a material' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              disabled={editing !== 'new'}
              options={catalog.map((material) => ({
                value: material.id,
                label: `${material.code} — ${material.name} (${material.stockUom})`,
              }))}
              placeholder="From the materials catalog"
            />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="form" label="Form" style={{ width: '34%' }}>
              <Select options={FORM_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item
              name="netQuantity"
              label="Net qty / part"
              style={{ width: '33%' }}
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={0.000001} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="scrapFactor" label="Scrap %" style={{ width: '33%' }}>
              <InputNumber min={0} max={99} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="stockSize" label="Stock size">
            <Input placeholder='e.g. "50 × 50 × 6 mm bar"' maxLength={200} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
