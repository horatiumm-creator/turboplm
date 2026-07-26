import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { App as AntdApp, Button, Card, Divider, Form, Input, Typography } from 'antd';
import {
  GoogleOutlined,
  LockOutlined,
  MailOutlined,
  RocketOutlined,
  UserOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface RegisterValues {
  name: string;
  email: string;
  password: string;
  confirm: string;
}

export default function Register() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
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

  const onFinish = async (values: RegisterValues) => {
    setSubmitting(true);
    try {
      const me = await api.register(values.name, values.email, values.password);
      setUser(me);
      navigate('/');
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
          <Typography.Text type="secondary">Create your account</Typography.Text>
        </div>
        <Form<RegisterValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Please enter your name' },
              { min: 2, message: 'Name must be at least 2 characters' },
            ]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="Full name"
              autoComplete="name"
              size="large"
            />
          </Form.Item>
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
            rules={[
              { required: true, message: 'Please enter a password' },
              { min: 8, message: 'Password must be at least 8 characters' },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              size="large"
            />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Confirm password"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Please confirm your password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Passwords do not match'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Repeat password"
              autoComplete="new-password"
              size="large"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              Create account
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
            Already have an account? <Link to="/login">Sign in</Link>
          </Typography.Text>
        </div>
      </Card>
    </div>
  );
}
