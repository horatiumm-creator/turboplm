import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ExperimentOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { MaterialClass, MaterialSummary } from '../api/types';

const { Text, Paragraph } = Typography;

const CLASS_OPTIONS: { value: MaterialClass; label: string }[] = [
  { value: 'METAL', label: 'Metal' },
  { value: 'POLYMER', label: 'Polymer' },
  { value: 'COMPOSITE', label: 'Composite' },
  { value: 'CERAMIC', label: 'Ceramic' },
  { value: 'ELASTOMER', label: 'Elastomer' },
  { value: 'OTHER', label: 'Other' },
];

const CLASS_COLOR: Record<MaterialClass, string> = {
  METAL: 'blue',
  POLYMER: 'purple',
  COMPOSITE: 'geekblue',
  CERAMIC: 'orange',
  ELASTOMER: 'magenta',
  OTHER: 'default',
};

interface MaterialFormValues {
  code: string;
  name: string;
  materialClass: MaterialClass;
  specification?: string;
  density?: number;
  stockUom: string;
  unitCost?: number;
  notes?: string;
}

/** The materials catalog (rule N2): what mechanical parts are made of, and what stock costs. */
export default function Materials() {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<MaterialSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<MaterialClass | undefined>();
  const [editing, setEditing] = useState<MaterialSummary | 'new' | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<MaterialFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listMaterials({
        search: search || undefined,
        materialClass: classFilter,
        page,
        pageSize: 20,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to load materials');
    } finally {
      setLoading(false);
    }
  }, [search, classFilter, page, message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openModal = (target: MaterialSummary | 'new') => {
    setEditing(target);
    setModalError(null);
    if (target === 'new') {
      form.resetFields();
      form.setFieldsValue({ materialClass: 'METAL', stockUom: 'kg' });
    } else {
      form.setFieldsValue({
        code: target.code,
        name: target.name,
        materialClass: target.materialClass,
        specification: target.specification ?? undefined,
        density: target.density ?? undefined,
        stockUom: target.stockUom,
        unitCost: target.unitCost ?? undefined,
      });
    }
  };

  const submit = async (values: MaterialFormValues) => {
    setSaving(true);
    setModalError(null);
    const input = {
      code: values.code,
      name: values.name,
      materialClass: values.materialClass,
      specification: values.specification || null,
      density: values.density ?? null,
      stockUom: values.stockUom,
      unitCost: values.unitCost ?? null,
      notes: values.notes || null,
    };
    try {
      if (editing === 'new') await api.createMaterial(input);
      else if (editing) await api.updateMaterial(editing.id, input);
      setEditing(null);
      await reload();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Failed to save the material');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (material: MaterialSummary, active: boolean) => {
    try {
      await api.updateMaterial(material.id, { active });
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to update the material');
    }
  };

  const remove = async (material: MaterialSummary) => {
    try {
      await api.deleteMaterial(material.id);
      message.success(`${material.code} deleted`);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to delete the material');
    }
  };

  const columns: ColumnsType<MaterialSummary> = [
    {
      title: 'Code',
      dataIndex: 'code',
      render: (code: string, material) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => openModal(material)}>
          {code}
        </Button>
      ),
    },
    { title: 'Name', dataIndex: 'name' },
    {
      title: 'Class',
      dataIndex: 'materialClass',
      width: 110,
      render: (materialClass: MaterialClass) => (
        <Tag color={CLASS_COLOR[materialClass]}>{materialClass}</Tag>
      ),
    },
    {
      title: 'Specification',
      dataIndex: 'specification',
      render: (spec: string | null) => spec ?? <Text type="secondary">—</Text>,
    },
    { title: 'Stock UoM', dataIndex: 'stockUom', width: 100 },
    {
      title: 'Unit cost',
      dataIndex: 'unitCost',
      width: 110,
      render: (cost: number | null) =>
        cost === null ? <Text type="secondary">—</Text> : cost.toFixed(2),
    },
    {
      title: 'Used by',
      dataIndex: 'partCount',
      width: 90,
      render: (count: number) =>
        count > 0 ? <Tag color="blue">{count} part{count === 1 ? '' : 's'}</Tag> : <Text type="secondary">unused</Text>,
    },
    {
      title: 'Active',
      key: 'active',
      width: 80,
      render: (_, material) => (
        <Switch
          size="small"
          checked={material.active}
          onChange={(checked) => void toggleActive(material, checked)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_, material) => (
        <Popconfirm
          title={
            material.partCount > 0
              ? `${material.code} is declared on ${material.partCount} part(s) — the server will refuse. Deactivate it instead?`
              : 'Delete this material?'
          }
          onConfirm={() => void remove(material)}
        >
          <Button size="small" danger type="text">
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <ExperimentOutlined />
          Materials
        </Space>
      }
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal('new')}>
          New material
        </Button>
      }
    >
      <Paragraph type="secondary">
        The raw-stock catalog behind the mBOM: declare a material on a mechanical part
        (Part → Materials tab) and the material requirements report totals what a build draws.
      </Paragraph>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          allowClear
          placeholder="Search code, name, specification"
          style={{ width: 280 }}
          onSearch={(value) => {
            setPage(1);
            setSearch(value.trim());
          }}
        />
        <Select
          allowClear
          placeholder="Class"
          style={{ width: 140 }}
          options={CLASS_OPTIONS}
          value={classFilter}
          onChange={(value) => {
            setPage(1);
            setClassFilter(value);
          }}
        />
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{
          current: page,
          pageSize: 20,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
      />

      <Modal
        title={editing === 'new' ? 'New material' : `Edit ${editing?.code ?? ''}`}
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
          <Space.Compact block>
            <Form.Item
              name="code"
              label="Code"
              style={{ width: '40%' }}
              rules={[{ required: true, message: 'e.g. AL6061-T6' }]}
            >
              <Input placeholder="AL6061-T6" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="name"
              label="Name"
              style={{ width: '60%' }}
              rules={[{ required: true, message: 'Name the material' }]}
            >
              <Input placeholder="Aluminium 6061-T6" maxLength={120} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="materialClass" label="Class" style={{ width: '40%' }}>
              <Select options={CLASS_OPTIONS} />
            </Form.Item>
            <Form.Item name="specification" label="Specification" style={{ width: '60%' }}>
              <Input placeholder="AMS 4027" maxLength={120} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item
              name="stockUom"
              label="Stock UoM"
              style={{ width: '34%' }}
              rules={[{ required: true, message: 'kg, m, sheet…' }]}
            >
              <Input placeholder="kg" maxLength={16} />
            </Form.Item>
            <Form.Item name="density" label="Density (g/cm³)" style={{ width: '33%' }}>
              <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="unitCost" label="Cost / stock UoM" style={{ width: '33%' }}>
              <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
