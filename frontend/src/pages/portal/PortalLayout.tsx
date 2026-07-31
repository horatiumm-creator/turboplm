import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { Button, Dropdown, Layout, Space, Spin, Typography, theme } from 'antd';
import { LogoutOutlined, ShopOutlined, UserOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import type { PortalIdentity } from '../../api/types';

const { Header, Content } = Layout;

/**
 * Chrome for the supplier portal. Deliberately shares nothing with AppLayout: a supplier
 * must never see PLM navigation, global search, or internal notifications.
 */
export default function PortalLayout() {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [identity, setIdentity] = useState<PortalIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setIdentity(await api.portalMe());
    } catch {
      setIdentity(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!identity) return <Navigate to="/portal/login" replace />;

  const signOut = async () => {
    try {
      await api.portalLogout();
    } finally {
      navigate('/portal/login', { replace: true });
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: 24,
          // Header forces line-height 64px, which pushes stacked text out of the bar.
          lineHeight: 'normal',
        }}
      >
        <Space size={10}>
          <ShopOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
          <Typography.Text strong style={{ fontSize: 16 }}>
            TurboPLM Supplier Portal
          </Typography.Text>
        </Space>
        <Dropdown
          menu={{
            items: [
              {
                key: 'logout',
                icon: <LogoutOutlined />,
                label: 'Sign out',
                onClick: () => void signOut(),
              },
            ],
          }}
        >
          <Space style={{ cursor: 'pointer' }}>
            <UserOutlined />
            <Space direction="vertical" size={0}>
              <Typography.Text>{identity.name}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {identity.supplier.name}
              </Typography.Text>
            </Space>
          </Space>
        </Dropdown>
      </Header>
      <Content style={{ padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
