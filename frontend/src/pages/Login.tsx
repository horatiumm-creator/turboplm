import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Typography,
} from 'antd';
import { GoogleOutlined, LockOutlined, MailOutlined, RocketOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface LoginValues {
  email: string;
  password: string;
}

export default function Login() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { message } = AntdApp.useApp();
  const [submitting, setSubmitting] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getProviders()
      .then((providers) => {
        if (!cancelled) setGoogleEnabled(providers.google);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (user) return <Navigate to="/" replace />;

  const onFinish = async (values: LoginValues) => {
    setSubmitting(true);
    try {
      const me = await api.login(values.email, values.password);
      setUser(me);
      const from = (location.state as any)?.from;
      navigate(from ? `${from.pathname}${from.search ?? ''}` : '/');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
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
        background: 'linear-gradient(135deg, #e8eef7 0%, #f5f7fa 45%, #dde6f2 100%)',
      }}
    >
      <Card
        style={{ width: 380, boxShadow: '0 12px 32px rgba(15, 34, 58, 0.10)' }}
        styles={{ body: { padding: 32 } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <RocketOutlined style={{ fontSize: 36, color: '#1677ff' }} />
          <Typography.Title level={3} style={{ marginTop: 8, marginBottom: 4 }}>
            TurboPLM
          </Typography.Title>
          <Typography.Text type="secondary">Sign in to manage your product data</Typography.Text>
        </div>
        {searchParams.get('error') === 'google' && (
          <Alert
            type="error"
            showIcon
            message="Google sign-in failed, try again."
            style={{ marginBottom: 16 }}
          />
        )}
        <Form<LoginValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input
              prefix={<MailOutlined />}
              placeholder="you@company.com"
              autoComplete="email"
              size="large"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Password"
              autoComplete="current-password"
              size="large"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              Sign in
            </Button>
          </Form.Item>
        </Form>
        {googleEnabled && (
          <>
            <Divider plain style={{ margin: '12px 0' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                or
              </Typography.Text>
            </Divider>
            <Button block size="large" icon={<GoogleOutlined />} href="/api/auth/google">
              Continue with Google
            </Button>
          </>
        )}
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <Typography.Text type="secondary">
            No account? <Link to="/register">Create one</Link>
          </Typography.Text>
        </div>
      </Card>
    </div>
  );
}
