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
import { EyeOutlined, GoogleOutlined, LockOutlined, MailOutlined, RocketOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface LoginValues {
  email: string;
  password: string;
}

/**
 * Sign-in failures the server can redirect back with. Each says what the user can do about
 * it: "failed, try again" is useless advice for a problem a retry cannot fix.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  google: 'Google sign-in failed, try again.',
  // Rule A1: the state cookie did not match, so this callback did not come from a flow
  // started here. Usually a stale tab or a bookmarked callback URL.
  state:
    'That sign-in link has expired or was not started here. Start again from this page.',
  // Rule A1: we will not link or create an account from an address the provider has not
  // verified, because email is what identifies an existing account.
  unverified:
    'Your provider has not verified that email address, so it cannot be used to sign in. Verify it with your provider, or sign in with a password.',
};

/**
 * The shared read-only account on the public demo, or empty everywhere else.
 *
 * Set as a build argument on the demo deployment ONLY. When it is empty — every other
 * build, including the SaaS — the button below does not render and this file behaves
 * exactly as it did before.
 *
 * A password in browser JavaScript is normally the defect. Here the account is a VIEWER,
 * `requireWriteRole` refuses every mutation from a VIEWER app-wide, and the entire point
 * is that any stranger may sign in with it. A credential you are inviting the public to
 * use is not a secret being leaked.
 */
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL as string | undefined;
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD as string | undefined;
const DEMO_LOGIN_ENABLED = Boolean(DEMO_EMAIL && DEMO_PASSWORD);

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

  const signIn = async (email: string, password: string) => {
    setSubmitting(true);
    try {
      const me = await api.login(email, password);
      setUser(me);
      const from = (location.state as any)?.from;
      navigate(from ? `${from.pathname}${from.search ?? ''}` : '/');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const onFinish = (values: LoginValues) => signIn(values.email, values.password);

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
        {SIGN_IN_ERRORS[searchParams.get('error') ?? ''] && (
          <Alert
            type="error"
            showIcon
            message={SIGN_IN_ERRORS[searchParams.get('error') ?? '']}
            style={{ marginBottom: 16 }}
          />
        )}
        {/*
          ABOVE the form deliberately.

          Someone arriving from turboplm.com's "Try the live demo" has been promised a
          running instance full of real product data, and what they used to meet was an
          empty email box. Registering first is friction at precisely the moment attention
          is highest, and it asks for an email address before showing anything worth the
          address. One click, no typing, straight into the quadcopter.
        */}
        {DEMO_LOGIN_ENABLED && (
          <>
            <Button
              block
              size="large"
              type="primary"
              icon={<EyeOutlined />}
              loading={submitting}
              onClick={() => void signIn(DEMO_EMAIL!, DEMO_PASSWORD!)}
            >
              Explore the demo
            </Button>
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, textAlign: 'center', margin: '10px 0 0' }}
            >
              Read-only, no signup. Everything is real seeded product data — a four-level
              quadcopter with revisions, changes and build units.
            </Typography.Paragraph>
            <Divider plain style={{ margin: '12px 0' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                or sign in
              </Typography.Text>
            </Divider>
          </>
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
