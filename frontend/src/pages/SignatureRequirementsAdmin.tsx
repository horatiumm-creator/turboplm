import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  Role,
  SignatureMeaning,
  SignatureRequirement,
  SignedEntityType,
  UserSummary,
} from '../api/types';
import { MEANING_META, MEANING_OPTIONS } from '../components/meta';

const ENTITY_OPTIONS: { value: SignedEntityType; label: string; hint: string }[] = [
  { value: 'REVISION', label: 'Part revision', hint: 'Gates releasing a revision on its own' },
  { value: 'ECN', label: 'Change notice', hint: 'Gates approving an ECN' },
  { value: 'DOCUMENT', label: 'Document', hint: 'Recorded against a document; no release gate' },
];

const SIGNER_ROLES: { value: Role; label: string }[] = [
  { value: 'ENGINEER', label: 'Any engineer' },
  { value: 'ADMIN', label: 'Any administrator' },
];

interface FormValues {
  entityType: SignedEntityType;
  meaning: SignatureMeaning;
  seq: number;
  signerKind: 'role' | 'user';
  role?: Role;
  userId?: number;
}

export default function SignatureRequirementsAdmin() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<SignatureRequirement[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const signerKind = Form.useWatch('signerKind', form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [requirements, userList] = await Promise.all([
        api.listSignatureRequirements(),
        api.listUsers().catch(() => []),
      ]);
      setRows(requirements);
      // A read-only account can never be a signer, so it is not offered.
      setUsers(userList.filter((user) => user.role !== 'VIEWER'));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load requirements');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setError(null);
    form.resetFields();
    form.setFieldsValue({ entityType: 'REVISION', seq: 1, signerKind: 'role', role: 'ENGINEER' });
    setOpen(true);
  };

  const save = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createSignatureRequirement({
        entityType: values.entityType,
        meaning: values.meaning,
        seq: values.seq,
        ...(values.signerKind === 'role' ? { role: values.role } : { userId: values.userId }),
      });
      setRows((prev) => [...prev, created]);
      message.success('Requirement added');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the requirement');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: SignatureRequirement, active: boolean) => {
    setBusy(true);
    try {
      const updated = await api.updateSignatureRequirement(row.id, { active });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: SignatureRequirement) => {
    setBusy(true);
    try {
      await api.deleteSignatureRequirement(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      message.success('Requirement removed');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnsType<SignatureRequirement> = [
    {
      title: 'Applies to',
      key: 'entityType',
      width: 150,
      render: (_, row) =>
        ENTITY_OPTIONS.find((option) => option.value === row.entityType)?.label ?? row.entityType,
    },
    { title: 'Step', dataIndex: 'seq', key: 'seq', width: 80 },
    {
      title: 'Meaning',
      key: 'meaning',
      width: 160,
      render: (_, row) => {
        const meta = MEANING_META[row.meaning];
        return (
          <Tooltip title={`Certifies ${meta.hint}`}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Who may sign',
      key: 'signer',
      render: (_, row) =>
        row.user ? (
          <Space size={6}>
            <span>{row.user.name}</span>
            <Tag>named signer</Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary">any {row.role}</Typography.Text>
        ),
    },
    {
      title: 'Active',
      key: 'active',
      width: 100,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.active}
          disabled={busy}
          onChange={(value) => void toggle(row, value)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, row) => (
        <Popconfirm
          title="Remove this requirement?"
          description="Signatures already executed against it are kept."
          onConfirm={() => void remove(row)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
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
          Signature requirements
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Add requirement
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Signatures are opt-in"
        description="With no active requirement for a type, nothing about releasing it changes. Add one and every release of that type needs a valid signature — executed with a password re-entry, and voided automatically if the signed content changes afterwards."
      />

      <Table<SignatureRequirement>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No signature requirements — releases are ungated' }}
      />

      <Modal
        title="Add signature requirement"
        open={open}
        onOk={() => void save()}
        okText="Add"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        forceRender
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical">
          <Form.Item
            name="entityType"
            label="Applies to"
            rules={[{ required: true, message: 'Choose what this gates' }]}
          >
            <Select
              options={ENTITY_OPTIONS.map((option) => ({
                value: option.value,
                label: `${option.label} — ${option.hint}`,
              }))}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="meaning"
              label="Meaning"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Choose what the signature certifies' }]}
            >
              <Select options={MEANING_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="seq"
              label="Step"
              style={{ width: 120 }}
              tooltip="Display order of the signing steps"
              rules={[{ required: true, message: 'Required' }]}
            >
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="signerKind" label="Who may sign">
            <Select
              options={[
                { value: 'role', label: 'Anyone holding a role' },
                { value: 'user', label: 'A named person' },
              ]}
            />
          </Form.Item>
          {signerKind === 'user' ? (
            <Form.Item
              name="userId"
              label="Signer"
              rules={[{ required: true, message: 'Choose the signer' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={users.map((user) => ({
                  value: user.id,
                  label: `${user.name} (${user.role})`,
                }))}
              />
            </Form.Item>
          ) : (
            <Form.Item
              name="role"
              label="Role"
              tooltip="Matched exactly — an administrator does not satisfy an engineer step, so separation of duties holds"
              rules={[{ required: true, message: 'Choose the role' }]}
            >
              <Select options={SIGNER_ROLES} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
