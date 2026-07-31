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
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CopyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { SupplierSummary, SupplierUserAccount } from '../api/types';
import { formatDate } from './meta';

interface AccountValues {
  email: string;
  name: string;
}

export default function SupplierAccountsModal({
  supplier,
  open,
  onClose,
}: {
  supplier: SupplierSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<SupplierUserAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<AccountValues>();
  /**
   * The invitation link is returned exactly once by the server, so it lives in local state
   * only until the modal closes. There is no way to retrieve it again — only reissue.
   */
  const [freshInvite, setFreshInvite] = useState<{ email: string; url: string } | null>(null);

  const load = useCallback(async () => {
    if (!supplier) return;
    setLoading(true);
    try {
      setRows(await api.listSupplierUsers(supplier.id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load accounts');
    } finally {
      setLoading(false);
    }
  }, [supplier, message]);

  useEffect(() => {
    if (open) {
      setFreshInvite(null);
      setError(null);
      form.resetFields();
      void load();
    }
  }, [open, load, form]);

  const create = async () => {
    if (!supplier) return;
    let values: AccountValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSupplierUser(supplier.id, {
        email: values.email.trim(),
        name: values.name.trim(),
      });
      setRows((prev) => [...prev, created]);
      setFreshInvite({ email: created.email, url: created.inviteUrl });
      form.resetFields();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  const reissue = async (row: SupplierUserAccount) => {
    setBusy(true);
    try {
      const updated = await api.resetSupplierInvite(row.id);
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setFreshInvite({ email: updated.email, url: updated.inviteUrl });
      message.success('New invitation issued — the previous link no longer works');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not reissue');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: SupplierUserAccount, active: boolean) => {
    setBusy(true);
    try {
      const updated = await api.updateSupplierUser(row.id, { active });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      message.success('Invitation link copied');
    } catch {
      message.warning('Copy failed — select the link and copy it manually');
    }
  };

  const columns: ColumnsType<SupplierUserAccount> = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 160,
      render: (_, row) =>
        !row.active ? (
          <Tag>Disabled</Tag>
        ) : row.accepted ? (
          <Tag color="green">Active</Tag>
        ) : (
          <Tooltip title={`Invitation expires ${formatDate(row.inviteExpiresAt)}`}>
            <Tag color="gold">Invited</Tag>
          </Tooltip>
        ),
    },
    {
      title: 'Last sign-in',
      key: 'lastLoginAt',
      width: 160,
      render: (_, row) => formatDate(row.lastLoginAt),
    },
    {
      title: 'Enabled',
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
      width: 130,
      render: (_, row) => (
        <Button size="small" icon={<ReloadOutlined />} disabled={busy} onClick={() => void reissue(row)}>
          Reissue
        </Button>
      ),
    },
  ];

  return (
    <Modal
      title={supplier ? `Portal accounts — ${supplier.name}` : 'Portal accounts'}
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
      width={780}
    >
      <Typography.Paragraph type="secondary">
        Portal accounts let this supplier sign in to quote the RFQs you invite them to. They see
        only their own quotes — never a competitor's price, and never anything else in the PLM.
      </Typography.Paragraph>

      {freshInvite && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Invitation link for ${freshInvite.email}`}
          description={
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Typography.Text type="secondary">
                Send this to your contact. It is shown once — close this dialog and it is gone,
                though you can always reissue a new one.
              </Typography.Text>
              <Space.Compact style={{ width: '100%' }}>
                <Input readOnly value={freshInvite.url} />
                <Button icon={<CopyOutlined />} onClick={() => void copy(freshInvite.url)}>
                  Copy
                </Button>
              </Space.Compact>
            </Space>
          }
        />
      )}

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      <Form form={form} layout="inline" style={{ marginBottom: 16 }}>
        <Form.Item
          name="name"
          rules={[{ required: true, message: 'Contact name' }]}
          style={{ flex: 1 }}
        >
          <Input placeholder="Contact name" />
        </Form.Item>
        <Form.Item
          name="email"
          rules={[
            { required: true, message: 'Email' },
            { type: 'email', message: 'Enter a valid email' },
          ]}
          style={{ flex: 1 }}
        >
          <Input placeholder="contact@supplier.com" />
        </Form.Item>
        <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={() => void create()}>
          Invite
        </Button>
      </Form>

      <Table<SupplierUserAccount>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No portal accounts yet' }}
      />
    </Modal>
  );
}
