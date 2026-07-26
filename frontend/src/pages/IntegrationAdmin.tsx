import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  ApiKeySummary,
  WebhookDeliveryItem,
  WebhookDeliveryStatus,
  WebhookSummary,
} from '../api/types';
import { formatDate } from '../components/meta';

const SCOPE_META: Record<'read' | 'write', { label: string; color: string }> = {
  read: { label: 'Read only', color: 'blue' },
  write: { label: 'Read & write', color: 'orange' },
};

const SCOPE_OPTIONS = (Object.keys(SCOPE_META) as ('read' | 'write')[]).map((value) => ({
  value,
  label: SCOPE_META[value].label,
}));

const DELIVERY_STATUS_META: Record<WebhookDeliveryStatus, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'default' },
  SUCCESS: { label: 'Delivered', color: 'green' },
  FAILED: { label: 'Failed', color: 'red' },
};

interface ApiKeyFormValues {
  name: string;
  scopes: 'read' | 'write';
}

interface WebhookFormValues {
  name: string;
  url: string;
  events: string[];
}

/** One-time reveal of freshly minted key material. */
interface RevealState {
  title: string;
  heading: string;
  value: string;
  hint: string;
}

export default function IntegrationAdmin() {
  const { message, modal } = AntdApp.useApp();

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [hooks, setHooks] = useState<WebhookSummary[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const [reveal, setReveal] = useState<RevealState | null>(null);

  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const [keyForm] = Form.useForm<ApiKeyFormValues>();

  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  const [hookSaving, setHookSaving] = useState(false);
  const [hookForm] = Form.useForm<WebhookFormValues>();

  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [keyList, hookList, eventList] = await Promise.all([
        api.listApiKeys(),
        api.listWebhooks(),
        api.listWebhookEvents(),
      ]);
      setKeys(keyList);
      setHooks(hookList);
      setEvents(eventList);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- API keys ----

  const openKeyModal = () => {
    setKeyError(null);
    keyForm.resetFields();
    setKeyModalOpen(true);
  };

  const createKey = async () => {
    let values: ApiKeyFormValues;
    try {
      values = await keyForm.validateFields();
    } catch {
      return;
    }
    setKeySaving(true);
    setKeyError(null);
    try {
      const created = await api.createApiKey({
        name: values.name.trim(),
        scopes: values.scopes,
      });
      setKeyModalOpen(false);
      setReveal({
        title: `API key "${created.name}"`,
        heading: 'Copy this API key now — it is shown only once',
        value: created.key,
        hint: 'This is the only time the full key is displayed; it cannot be retrieved again. Store it in your integration’s secret store, then send it as the X-API-Key request header.',
      });
      await load();
    } catch (err) {
      setKeyError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setKeySaving(false);
    }
  };

  const revokeKey = (row: ApiKeySummary) => {
    modal.confirm({
      title: 'Revoke API key',
      content: `Revoke "${row.name}"? Any integration still using this key stops working immediately.`,
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.revokeApiKey(row.id);
          message.success('API key revoked');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const keyColumns: ColumnsType<ApiKeySummary> = [
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: 'Prefix',
      key: 'prefix',
      width: 160,
      render: (_, row) => <Typography.Text code>{`tplm_${row.prefix}`}</Typography.Text>,
    },
    {
      title: 'Scope',
      key: 'scopes',
      width: 130,
      render: (_, row) => (
        <Tag color={SCOPE_META[row.scopes].color}>{SCOPE_META[row.scopes].label}</Tag>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) =>
        row.revokedAt ? <Tag color="red">Revoked</Tag> : <Tag color="green">Active</Tag>,
    },
    {
      title: 'Last used',
      key: 'lastUsedAt',
      width: 170,
      render: (_, row) => formatDate(row.lastUsedAt),
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 170,
      render: (_, row) => formatDate(row.createdAt),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 110,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          danger
          icon={<StopOutlined />}
          disabled={row.revokedAt !== null}
          onClick={() => revokeKey(row)}
        >
          Revoke
        </Button>
      ),
    },
  ];

  // ---- Webhooks ----

  const openHookModal = () => {
    setHookError(null);
    hookForm.resetFields();
    setHookModalOpen(true);
  };

  const createHook = async () => {
    let values: WebhookFormValues;
    try {
      values = await hookForm.validateFields();
    } catch {
      return;
    }
    setHookSaving(true);
    setHookError(null);
    try {
      const created = await api.createWebhook({
        name: values.name.trim(),
        url: values.url.trim(),
        events: values.events,
      });
      setHookModalOpen(false);
      setReveal({
        title: `Webhook "${created.name}"`,
        heading: 'Copy this signing secret now — it is shown only once',
        value: created.secret,
        hint: 'This is the only time the secret is displayed; it cannot be retrieved again. Use it to verify the X-TurboPLM-Signature header (HMAC-SHA256 of the raw request body) on every delivery.',
      });
      await load();
    } catch (err) {
      setHookError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setHookSaving(false);
    }
  };

  const toggleActive = async (row: WebhookSummary, active: boolean) => {
    setTogglingId(row.id);
    try {
      await api.updateWebhook(row.id, { active });
      message.success(`"${row.name}" ${active ? 'enabled' : 'paused'}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setTogglingId(null);
      await load();
    }
  };

  const sendTest = async (row: WebhookSummary) => {
    setTestingId(row.id);
    try {
      await api.testWebhook(row.id);
      message.success('Test event queued');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setTestingId(null);
    }
  };

  const removeHook = (row: WebhookSummary) => {
    modal.confirm({
      title: 'Delete webhook',
      content: `Delete "${row.name}"? Its delivery history is removed as well.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteWebhook(row.id);
          message.success('Webhook deleted');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const deliveryColumns: ColumnsType<WebhookDeliveryItem> = [
    {
      title: 'Event',
      key: 'event',
      width: 170,
      render: (_, row) => <Typography.Text code>{row.event}</Typography.Text>,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) => (
        <Tag color={DELIVERY_STATUS_META[row.status].color}>
          {DELIVERY_STATUS_META[row.status].label}
        </Tag>
      ),
    },
    { title: 'Attempts', dataIndex: 'attempts', key: 'attempts', width: 90, align: 'right' },
    {
      title: 'Response',
      key: 'responseCode',
      width: 100,
      align: 'right',
      render: (_, row) =>
        row.responseCode === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          row.responseCode
        ),
    },
    {
      title: 'Queued',
      key: 'createdAt',
      width: 170,
      render: (_, row) => formatDate(row.createdAt),
    },
    {
      title: 'Delivered',
      key: 'deliveredAt',
      width: 170,
      render: (_, row) => formatDate(row.deliveredAt),
    },
    {
      title: 'Error',
      key: 'error',
      ellipsis: true,
      render: (_, row) =>
        row.error ? (
          <Typography.Text type="danger">{row.error}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const hookColumns: ColumnsType<WebhookSummary> = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 180, ellipsis: true },
    {
      title: 'Endpoint',
      key: 'url',
      ellipsis: true,
      render: (_, row) => <Typography.Text code>{row.url}</Typography.Text>,
    },
    {
      title: 'Events',
      key: 'events',
      width: 300,
      render: (_, row) => (
        <span>
          {row.events.map((event) => (
            <Tag key={event} style={{ marginBottom: 2 }}>
              {event}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      title: 'Active',
      key: 'active',
      width: 80,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.active}
          loading={togglingId === row.id}
          onChange={(checked) => void toggleActive(row, checked)}
        />
      ),
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 170,
      render: (_, row) => formatDate(row.createdAt),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 170,
      render: (_, row) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<SendOutlined />}
            loading={testingId === row.id}
            onClick={() => void sendTest(row)}
          >
            Test
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => removeHook(row)}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Integration
      </Typography.Title>

      <Card
        title="API keys"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openKeyModal}>
            New API key
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Machine access for scripts and integrations. Send the key as the{' '}
          <Typography.Text code>X-API-Key</Typography.Text> header. A key acts as its creator
          with the chosen scope and never grants admin rights.
        </Typography.Paragraph>
        <Table<ApiKeySummary>
          size="middle"
          rowKey="id"
          columns={keyColumns}
          dataSource={keys}
          loading={loading}
          pagination={false}
          scroll={{ x: 900 }}
          locale={{ emptyText: 'No API keys yet' }}
        />
      </Card>

      <Card
        title="Webhooks"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openHookModal}>
            New webhook
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          TurboPLM POSTs subscribed events to your endpoint and signs each body with the
          webhook secret (<Typography.Text code>X-TurboPLM-Signature</Typography.Text>). Expand a
          row to see its most recent deliveries.
        </Typography.Paragraph>
        <Table<WebhookSummary>
          size="middle"
          rowKey="id"
          columns={hookColumns}
          dataSource={hooks}
          loading={loading}
          pagination={false}
          scroll={{ x: 1100 }}
          locale={{ emptyText: 'No webhooks yet' }}
          expandable={{
            expandedRowRender: (row) => (
              <Table<WebhookDeliveryItem>
                size="small"
                rowKey="id"
                columns={deliveryColumns}
                dataSource={row.recentDeliveries}
                pagination={false}
                locale={{ emptyText: 'No deliveries yet' }}
              />
            ),
          }}
        />
      </Card>

      <Modal
        title="New API key"
        open={keyModalOpen}
        onOk={() => void createKey()}
        okText="Create key"
        confirmLoading={keySaving}
        onCancel={() => setKeyModalOpen(false)}
        forceRender
      >
        {keyError && <Alert type="error" showIcon message={keyError} style={{ marginBottom: 16 }} />}
        <Form form={keyForm} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'At most 100 characters' },
            ]}
          >
            <Input placeholder="e.g. ERP nightly sync" />
          </Form.Item>
          <Form.Item
            name="scopes"
            label="Scope"
            initialValue="read"
            rules={[{ required: true, message: 'Scope is required' }]}
          >
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="New webhook"
        open={hookModalOpen}
        onOk={() => void createHook()}
        okText="Create webhook"
        confirmLoading={hookSaving}
        onCancel={() => setHookModalOpen(false)}
        width={620}
        forceRender
      >
        {hookError && (
          <Alert type="error" showIcon message={hookError} style={{ marginBottom: 16 }} />
        )}
        <Form form={hookForm} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'At most 100 characters' },
            ]}
          >
            <Input placeholder="e.g. MES release listener" />
          </Form.Item>
          <Form.Item
            name="url"
            label="Endpoint URL"
            rules={[{ required: true, message: 'An http(s) URL is required' }]}
          >
            <Input placeholder="https://example.com/hooks/turboplm" />
          </Form.Item>
          <Form.Item
            name="events"
            label="Events"
            rules={[{ required: true, message: 'Subscribe to at least one event' }]}
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="Select the events to deliver"
              options={events.map((event) => ({ value: event, label: event }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={reveal?.title}
        open={reveal !== null}
        maskClosable={false}
        onCancel={() => setReveal(null)}
        width={640}
        footer={[
          <Button key="done" type="primary" onClick={() => setReveal(null)}>
            I have copied it
          </Button>,
        ]}
      >
        {reveal && (
          <Alert
            type="warning"
            showIcon
            message={reveal.heading}
            description={
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Typography.Text
                  code
                  copyable={{ text: reveal.value }}
                  style={{ wordBreak: 'break-all' }}
                >
                  {reveal.value}
                </Typography.Text>
                <Typography.Text strong>{reveal.hint}</Typography.Text>
              </Space>
            }
          />
        )}
      </Modal>
    </Space>
  );
}
