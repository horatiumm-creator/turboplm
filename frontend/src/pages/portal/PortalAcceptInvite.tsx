import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { ShopOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';

interface Values {
  password: string;
  confirm: string;
}

export default function PortalAcceptInvite() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Values>();

  const submit = async (values: Values) => {
    setBusy(true);
    setError(null);
    try {
      await api.portalAcceptInvite(token, values.password);
      navigate('/portal', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept the invitation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Card style={{ width: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <ShopOutlined style={{ fontSize: 32, color: '#1677ff' }} />
          <Typography.Title level={4} style={{ marginTop: 12, marginBottom: 4 }}>
            Set your password
          </Typography.Title>
          <Typography.Text type="secondary">
            Choose a password to activate your supplier portal account
          </Typography.Text>
        </div>

        {!token && (
          <Alert
            type="error"
            showIcon
            message="This link is missing its invitation token"
            description="Open the link from your invitation email exactly as it was sent."
            style={{ marginBottom: 16 }}
          />
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        <Form form={form} layout="vertical" onFinish={(v) => void submit(v)} disabled={!token}>
          <Form.Item
            name="password"
            label="Password"
            rules={[
              { required: true, message: 'Choose a password' },
              { min: 12, message: 'Use at least 12 characters' },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Confirm password"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Confirm your password' },
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  !value || getFieldValue('password') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('The passwords do not match')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            Activate account
          </Button>
        </Form>
      </Card>
    </div>
  );
}
