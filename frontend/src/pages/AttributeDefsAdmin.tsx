import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { AttributeDef, AttributeType, PartCategory } from '../api/types';
import { ATTRIBUTE_TYPE_OPTIONS, CATEGORY_OPTIONS } from '../components/meta';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

interface DefFormValues {
  name?: string;
  label: string;
  type: AttributeType;
  options?: string[];
  required?: boolean;
  sortOrder?: number;
}

const typeLabel = (type: AttributeType) =>
  ATTRIBUTE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;

export default function AttributeDefsAdmin() {
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();
  const isViewer = user?.role === 'VIEWER';

  const [category, setCategory] = useState<PartCategory>('ASSEMBLY');
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AttributeDef | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<DefFormValues>();
  const typeValue = Form.useWatch('type', form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDefs(await api.listAttributeDefs(category));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [category, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ type: 'TEXT', required: false, sortOrder: 0 });
    setModalOpen(true);
  };

  const openEdit = (def: AttributeDef) => {
    setEditing(def);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({
      name: def.name,
      label: def.label,
      type: def.type,
      options: def.options,
      required: def.required,
      sortOrder: def.sortOrder,
    });
    setModalOpen(true);
  };

  const save = async () => {
    let values: DefFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      if (editing) {
        await api.updateAttributeDef(editing.id, {
          label: values.label.trim(),
          type: values.type,
          options: values.type === 'LIST' ? values.options ?? [] : [],
          required: values.required ?? false,
          sortOrder: values.sortOrder ?? 0,
        });
        message.success('Attribute updated');
      } else {
        await api.createAttributeDef({
          category,
          name: values.name!.trim(),
          label: values.label.trim(),
          type: values.type,
          options: values.type === 'LIST' ? values.options ?? [] : undefined,
          required: values.required ?? false,
          sortOrder: values.sortOrder ?? 0,
        });
        message.success('Attribute created');
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const remove = (def: AttributeDef) => {
    modal.confirm({
      title: 'Delete attribute',
      content: `Delete "${def.label}"? All values stored on parts for this attribute will be deleted too.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteAttributeDef(def.id);
          message.success('Attribute deleted');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const columns: ColumnsType<AttributeDef> = [
    {
      title: 'Name',
      key: 'name',
      width: 180,
      render: (_, def) => <Typography.Text code>{def.name}</Typography.Text>,
    },
    { title: 'Label', dataIndex: 'label', key: 'label', ellipsis: true },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_, def) => typeLabel(def.type),
    },
    {
      title: 'Options',
      key: 'options',
      ellipsis: true,
      render: (_, def) =>
        def.options.length > 0 ? (
          def.options.join(', ')
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Required',
      key: 'required',
      width: 100,
      render: (_, def) =>
        def.required ? <Tag color="red">required</Tag> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Sort',
      dataIndex: 'sortOrder',
      key: 'sortOrder',
      width: 80,
      align: 'right',
    },
    ...(isViewer
      ? []
      : ([
          {
            title: 'Actions',
            key: 'actions',
            width: 160,
            render: (_, def) => (
              <Space size={0}>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEdit(def)}
                >
                  Edit
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(def)}
                >
                  Delete
                </Button>
              </Space>
            ),
          },
        ] as ColumnsType<AttributeDef>)),
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
        <Typography.Title level={3} style={{ margin: 0 }}>
          Custom attributes
        </Typography.Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New attribute
          </Button>
        )}
      </div>

      <Space style={{ marginBottom: 16 }}>
        <Typography.Text>Part category:</Typography.Text>
        <Select<PartCategory>
          style={{ width: 180 }}
          value={category}
          options={CATEGORY_OPTIONS}
          onChange={(value) => setCategory(value)}
        />
      </Space>

      <Table<AttributeDef>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={defs}
        loading={loading}
        pagination={false}
      />

      <Modal
        title={editing ? 'Edit attribute' : 'New attribute'}
        open={modalOpen}
        onOk={() => void save()}
        okText={editing ? 'Save' : 'Create'}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            tooltip="Internal identifier — lowercase letters, digits and underscores."
            rules={
              editing
                ? []
                : [
                    { required: true, message: 'Name is required' },
                    {
                      pattern: NAME_PATTERN,
                      message:
                        'Lowercase letters, digits and underscores only; must start with a letter',
                    },
                    { max: 40, message: 'At most 40 characters' },
                  ]
            }
          >
            <Input placeholder="e.g. finish_color" disabled={editing !== null} />
          </Form.Item>
          <Form.Item
            name="label"
            label="Label"
            rules={[{ required: true, message: 'Label is required' }]}
          >
            <Input placeholder="Shown on the part page" />
          </Form.Item>
          <Form.Item name="type" label="Type" rules={[{ required: true, message: 'Pick a type' }]}>
            <Select options={ATTRIBUTE_TYPE_OPTIONS} />
          </Form.Item>
          {typeValue === 'LIST' && (
            <Form.Item
              name="options"
              label="Choices"
              tooltip="Allowed values for this list attribute."
              rules={[{ required: true, message: 'Add at least one choice' }]}
            >
              <Select mode="tags" placeholder="Type a choice and press Enter" open={false} />
            </Form.Item>
          )}
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="required" label="Required" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="sortOrder" label="Sort order" style={{ width: 140 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
