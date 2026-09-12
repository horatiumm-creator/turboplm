import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { EditOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type { AttributeDef, PartAttribute, PartDetail } from '../../api/types';

function displayValue(attr: PartAttribute): ReactNode {
  const { def, value } = attr;
  if (value === null) {
    return def.required ? (
      <Tag color="red">required</Tag>
    ) : (
      <Typography.Text type="secondary">—</Typography.Text>
    );
  }
  switch (def.type) {
    case 'BOOLEAN':
      return value === 'true' ? 'Yes' : 'No';
    case 'DATE':
      return dayjs(value).format('YYYY-MM-DD');
    default:
      return value;
  }
}

function fieldFor(def: AttributeDef): JSX.Element {
  switch (def.type) {
    case 'NUMBER':
      return <InputNumber style={{ width: '100%' }} />;
    case 'DATE':
      return <DatePicker style={{ width: '100%' }} />;
    case 'BOOLEAN':
      return <Switch />;
    case 'LIST':
      return (
        <Select
          allowClear
          options={def.options.map((option) => ({ value: option, label: option }))}
        />
      );
    default:
      return <Input />;
  }
}

export default function AttributesPanel({
  part,
  onChanged,
}: {
  part: PartDetail;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<Record<string, unknown>>();

  if (part.attributes.length === 0) return null;

  const openEdit = () => {
    setModalError(null);
    form.resetFields();
    const initial: Record<string, unknown> = {};
    for (const { def, value } of part.attributes) {
      const key = String(def.id);
      switch (def.type) {
        case 'BOOLEAN':
          initial[key] = value === 'true';
          break;
        case 'DATE':
          initial[key] = value ? dayjs(value) : null;
          break;
        case 'NUMBER':
          initial[key] = value !== null && value !== '' ? Number(value) : null;
          break;
        default:
          initial[key] = value;
      }
    }
    form.setFieldsValue(initial as Parameters<typeof form.setFieldsValue>[0]);
    setOpen(true);
  };

  const save = async () => {
    let raw: Record<string, unknown>;
    try {
      raw = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      const values: Record<number, string | null> = {};
      for (const { def, value: original } of part.attributes) {
        const v = raw[String(def.id)];
        switch (def.type) {
          case 'BOOLEAN':
            // An untouched Switch reads false — don't turn a previously unset
            // value into an explicit 'false'.
            values[def.id] = v ? 'true' : original === null ? null : 'false';
            break;
          case 'DATE':
            values[def.id] = v ? (v as Dayjs).toISOString() : null;
            break;
          case 'NUMBER':
            values[def.id] = v === null || v === undefined || v === '' ? null : String(v);
            break;
          default: {
            const text = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
            values[def.id] = text ? text : null;
          }
        }
      }
      await api.setPartAttributes(part.id, values);
      message.success('Attributes updated');
      setOpen(false);
      onChanged();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Descriptions
        title="Attributes"
        size="middle"
        column={{ xs: 1, sm: 2, lg: 3 }}
        extra={
          user?.role !== 'VIEWER' && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit attributes
            </Button>
          )
        }
      >
        {part.attributes.map((attr) => (
          <Descriptions.Item key={attr.def.id} label={attr.def.label}>
            {displayValue(attr)}
          </Descriptions.Item>
        ))}
      </Descriptions>

      <Modal
        title="Edit attributes"
        open={open}
        onOk={() => void save()}
        okText="Save"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          {part.attributes.map(({ def }) => (
            <Form.Item
              key={def.id}
              name={String(def.id)}
              label={def.label}
              valuePropName={def.type === 'BOOLEAN' ? 'checked' : 'value'}
            >
              {fieldFor(def)}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  );
}
