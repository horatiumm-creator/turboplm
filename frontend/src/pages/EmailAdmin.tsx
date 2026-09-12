import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Descriptions,
  Typography,
} from 'antd';
import { SendOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { EmailStatus } from '../api/types';

const ENV_EXAMPLE = `SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mailbox@yourcompany.com
SMTP_PASS=<mailbox password>
SMTP_FROM=mailbox@yourcompany.com`;

export default function EmailAdmin() {
  const { message } = AntdApp.useApp();

  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.getEmailStatus());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = async () => {
    setSending(true);
    setSendError(null);
    try {
      const result = await api.sendTestEmail();
      message.success(`Test email sent to ${result.to}`);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 16 }}>
        Email
      </Typography.Title>

      <Card title="SMTP status" loading={loading} style={{ maxWidth: 720 }}>
        <Descriptions size="middle" column={1} bordered>
          <Descriptions.Item label="Status">
            {status?.configured ? (
              <Badge status="success" text="Configured" />
            ) : (
              <Badge status="warning" text="Not configured" />
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Host">
            {status?.host ?? <Typography.Text type="secondary">—</Typography.Text>}
          </Descriptions.Item>
          <Descriptions.Item label="From">
            {status?.from ?? <Typography.Text type="secondary">—</Typography.Text>}
          </Descriptions.Item>
        </Descriptions>

        {status && !status.configured && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="Connect a Microsoft 365 mailbox"
            description={
              <div>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  Notification emails are sent through SMTP. For Microsoft 365, add these
                  values to the <Typography.Text code>.env</Typography.Text> file at the
                  project root:
                </Typography.Paragraph>
                <pre style={{ margin: '0 0 8px', padding: 12, background: 'rgba(0,0,0,0.04)', borderRadius: 6, overflowX: 'auto' }}>
                  {ENV_EXAMPLE}
                </pre>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  Port 587 uses STARTTLS, so leave{' '}
                  <Typography.Text code>SMTP_SECURE=false</Typography.Text>. The mailbox must
                  have <strong>Authenticated SMTP</strong> enabled (Microsoft 365 admin center
                  → user → Mail → Manage email apps).{' '}
                  <Typography.Text code>SMTP_FROM</Typography.Text> is optional and defaults
                  to <Typography.Text code>SMTP_USER</Typography.Text>.
                </Typography.Paragraph>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  Then apply the change with{' '}
                  <Typography.Text code>docker compose up -d api</Typography.Text>.
                </Typography.Paragraph>
              </div>
            }
          />
        )}

        {sendError && (
          <Alert type="error" showIcon message={sendError} style={{ marginTop: 16 }} />
        )}

        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={sending}
          onClick={() => void sendTest()}
          style={{ marginTop: 16 }}
        >
          Send test email
        </Button>
      </Card>
    </div>
  );
}
