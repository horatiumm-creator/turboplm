import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { ShopOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';

interface Values {
  email: string;
  password: string;
}

export default function PortalLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Values>();

  const submit = async (values: Values) => {
    setBusy(true);
    setError(null);
    try {
      await api.portalLogin(values.email.trim(), values.password);
      navigate('/portal', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
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
      <Card style={{ width: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <ShopOutlined style={{ fontSize: 32, color: '#1677ff' }} />
          <Typography.Title level={4} style={{ marginTop: 12, marginBottom: 4 }}>
            Supplier Portal
          </Typography.Title>
          <Typography.Text type="secondary">
            Sign in to view and quote requests sent to you
          </Typography.Text>
        </div>

        {params.get('accepted') === '1' && (
          <Alert
            type="success"
            showIcon
            message="Your account is ready — sign in to continue"
            style={{ marginBottom: 16 }}
          />
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        <Form form={form} layout="vertical" onFinish={(v) => void submit(v)}>
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, message: 'Enter your email' }]}
          >
            <Input autoComplete="username" placeholder="you@supplier.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Enter your password' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            Sign in
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          Access is by invitation from the buyer. If you have an invitation link, open it to set
          your password. Looking for the main application? <Link to="/login">Sign in here</Link>.
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
