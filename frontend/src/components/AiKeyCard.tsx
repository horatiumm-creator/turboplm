import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { AiCapabilities, AiKeyStored, AiProvider } from '../api/types';

/**
 * Bring your own API key.
 *
 * The person is handing this product a credential that bills THEIR account, so the screen is
 * written to be honest about custody rather than reassuring: what is stored, what comes back
 * out (nothing), who else can remove it, and who pays when the features run.
 *
 * WHY THE SAVED KEY IS NEVER SHOWN, not even masked beyond four characters: a field that
 * renders a stored secret is a secret that leaves the database on every page load, into a
 * browser, a screen share and a bug report. The last four are enough to recognise which key
 * is in there, which is the only question the owner actually has.
 */
export default function AiKeyCard(): JSX.Element {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ provider: AiProvider; apiKey: string }>();
  const [caps, setCaps] = useState<AiCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AiKeyStored | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCaps(await api.getAiCapabilities());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: { provider: AiProvider; apiKey: string }) => {
    setSaving(true);
    setResult(null);
    try {
      const stored = await api.putAiKey(values.provider, values.apiKey.trim());
      setResult(stored);
      // Cleared from the form the moment it is stored: there is no reason for it to sit in a
      // DOM node afterwards, and leaving it there invites a second submit of a stale value.
      form.setFieldValue('apiKey', '');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.deleteAiKey();
      setResult(null);
      message.success('Key removed');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  if (loading) {
    return (
      <Card title="AI features">
        <Spin />
      </Card>
    );
  }

  const own = caps?.ownKey ?? null;

  return (
    <Card
      title={
        <Space>
          <KeyOutlined />
          <span>AI features — your API key</span>
        </Space>
      }
      extra={
        own ? (
          <Popconfirm
            title="Remove your key?"
            description="The AI features stop working for you until you add another."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={remove}
          >
            <Button danger size="small">
              Remove
            </Button>
          </Popconfirm>
        ) : null
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Nothing can be stored at all without an encryption key, and the honest thing is to
            say so rather than to offer a field that 409s. */}
        {caps && !caps.canStoreKeys && (
          <Alert
            type="warning"
            showIcon
            message="This deployment cannot store API keys yet"
            description="An administrator needs to set AI_KEY_ENCRYPTION_KEY. Until then a key
              cannot be encrypted, and storing one any other way would be worse than declining."
          />
        )}

        {own && (
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="Provider">
              <Tag>{own.provider === 'ANTHROPIC' ? 'Anthropic' : 'OpenAI'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Key">
              <Typography.Text code>…{own.hint ?? '????'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Added">
              {own.setAt ? new Date(own.setAt).toLocaleDateString() : '—'}
            </Descriptions.Item>
          </Descriptions>
        )}

        {/*
         * The result of the save-time check. Reported, never used to block: a rejection is
         * worth saying loudly, and an outage is worth saying quietly, but neither is this
         * product's decision to make about somebody else's credential.
         */}
        {result && (
          <Alert
            type={
              result.verified === true ? 'success' : result.verified === false ? 'error' : 'info'
            }
            showIcon
            message={
              result.verified === true
                ? 'Saved, and the provider accepted it'
                : result.verified === false
                ? 'Saved, but the provider rejected it'
                : 'Saved — it could not be checked just now'
            }
            description={
              result.verified === false
                ? `${result.reason}. It is stored, so you can leave it and try the features
                   later, or paste a different key over it.`
                : result.reason ?? undefined
            }
          />
        )}

        <Form
          form={form}
          layout="vertical"
          initialValues={{ provider: own?.provider ?? 'ANTHROPIC' }}
          onFinish={save}
          disabled={caps ? !caps.canStoreKeys : true}
        >
          <Space align="start" wrap>
            <Form.Item name="provider" label="Provider" style={{ marginBottom: 8, minWidth: 160 }}>
              <Select
                options={[
                  { value: 'ANTHROPIC', label: 'Anthropic' },
                  { value: 'OPENAI', label: 'OpenAI' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="apiKey"
              label={own ? 'Replace with a new key' : 'API key'}
              style={{ marginBottom: 8, minWidth: 420 }}
              rules={[{ required: true, message: 'Paste your key' }]}
            >
              {/* A password field, so it is not read over a shoulder or captured by a screen
                  recording — and `off`, so the browser does not offer it back later. */}
              <Input.Password placeholder="sk-ant-…" autoComplete="off" />
            </Form.Item>
            <Form.Item label=" " style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" loading={saving}>
                {own ? 'Replace key' : 'Save key'}
              </Button>
            </Form.Item>
          </Space>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
          Your key is encrypted before it is stored and is never shown again — only the last four
          characters. It is used for your own requests only, and the model&apos;s usage is billed to
          your provider account. An administrator of this deployment can remove your key but cannot
          read it.
          {caps?.source === 'deployment' && (
            <>
              {' '}
              Right now the AI features are running on this deployment&apos;s own key, so you do not
              need one; add yours to pay for your own usage instead.
            </>
          )}
          {caps?.source === null && (
            <> Nobody has configured a key yet, so the AI features are hidden until you add one.</>
          )}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
