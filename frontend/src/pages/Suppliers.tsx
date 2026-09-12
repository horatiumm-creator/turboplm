import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { SupplierSummary } from '../api/types';
import SupplierAccountsModal from '../components/SupplierAccountsModal';

interface SupplierFormValues {
  code: string;
  name: string;
  contactName?: string;
  contactEmail?: string;
  notes?: string;
  active: boolean;
}

export default function Suppliers() {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSuppliers(await api.listSuppliers());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // A null editing target with the modal open means "create".
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SupplierSummary | null>(null);
  // Portal-account management for one supplier at a time.
  const [accountsFor, setAccountsFor] = useState<SupplierSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SupplierFormValues>();

  const openCreate = () => {
    setEditing(null);
    setError(null);
    form.resetFields();
    form.setFieldsValue({ active: true });
    setOpen(true);
  };

  const openEdit = (supplier: SupplierSummary) => {
    setEditing(supplier);
    setError(null);
    form.setFieldsValue({
      code: supplier.code,
      name: supplier.name,
      contactName: supplier.contactName ?? undefined,
      contactEmail: supplier.contactEmail ?? undefined,
      notes: supplier.notes ?? undefined,
      active: supplier.active,
    });
    setOpen(true);
  };

  const save = async () => {
    let values: SupplierFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const updated = await api.updateSupplier(editing.id, {
          name: values.name.trim(),
          contactName: values.contactName?.trim() || null,
          contactEmail: values.contactEmail?.trim() || null,
          notes: values.notes?.trim() || null,
          active: values.active,
        });
        setSuppliers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        message.success(`${updated.code} updated`);
      } else {
        const created = await api.createSupplier({
          code: values.code.trim().toUpperCase(),
          name: values.name.trim(),
          contactName: values.contactName?.trim() || undefined,
          contactEmail: values.contactEmail?.trim() || undefined,
          notes: values.notes?.trim() || undefined,
        });
        // Keep the server's name-ascending order without a refetch.
        setSuppliers((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
        );
        message.success(`${created.code} added`);
      }
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<SupplierSummary> = [
    { title: 'Code', dataIndex: 'code', key: 'code', width: 140 },
    { title: 'Supplier', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: 'Contact', key: 'contactName', width: 170, render: (_, s) => s.contactName ?? '—' },
    {
      title: 'Email',
      key: 'contactEmail',
      width: 240,
      render: (_, s) =>
        s.contactEmail ? <a href={`mailto:${s.contactEmail}`}>{s.contactEmail}</a> : '—',
    },
    {
      title: 'Quotes',
      dataIndex: 'quoteCount',
      key: 'quoteCount',
      width: 100,
      align: 'right',
    },
    {
      title: 'Status',
      key: 'active',
      width: 110,
      render: (_, s) =>
        s.active ? <Tag color="green">Active</Tag> : <Tag>Inactive</Tag>,
    },
    ...(canEdit
      ? [
          {
            title: '',
            key: 'actions',
            width: 96,
            render: (_: unknown, s: SupplierSummary) => (
              <Space size={4}>
                <Button
                  type="text"
                  size="small"
                  icon={<TeamOutlined />}
                  title="Portal accounts"
                  onClick={() => setAccountsFor(s)}
                />
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(s)} />
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Suppliers
        </Typography.Title>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add supplier
          </Button>
        )}
      </div>

      <Table<SupplierSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={suppliers}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No suppliers yet' }}
      />

      <SupplierAccountsModal
        supplier={accountsFor}
        open={accountsFor !== null}
        onClose={() => setAccountsFor(null)}
      />

      <Modal
        title={editing ? `Edit ${editing.code}` : 'Add supplier'}
        open={open}
        onOk={() => void save()}
        okText={editing ? 'Save' : 'Add'}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        forceRender
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="code"
              label="Code"
              style={{ width: 180 }}
              rules={[
                { required: true, message: 'Code is required' },
                { pattern: /^[A-Z0-9-]{2,20}$/i, message: '2–20 chars: letters, digits, dashes' },
              ]}
            >
              {/* The code identifies the supplier on quotes, so it is fixed after creation. */}
              <Input placeholder="ACME-MFG" disabled={editing !== null} />
            </Form.Item>
            <Form.Item
              name="name"
              label="Name"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Name is required' }, { max: 200 }]}
            >
              <Input placeholder="Acme Manufacturing Ltd" />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="contactName" label="Contact" style={{ flex: 1 }}>
              <Input placeholder="optional" />
            </Form.Item>
            <Form.Item
              name="contactEmail"
              label="Contact email"
              style={{ flex: 1 }}
              rules={[{ type: 'email', message: 'Enter a valid email' }]}
            >
              <Input placeholder="optional" />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={3} placeholder="Capabilities, certifications, terms" />
          </Form.Item>
          {editing && (
            <Form.Item
              name="active"
              label="Active"
              valuePropName="checked"
              tooltip="Inactive suppliers stay on past quotes but are hidden from new ones"
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
