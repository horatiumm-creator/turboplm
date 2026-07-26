import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Dropdown,
  Input,
  Layout,
  List,
  Menu,
  Space,
  Typography,
  theme,
} from 'antd';
import {
  ApartmentOutlined,
  ApiOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined,
  ControlOutlined,
  MailOutlined,
  ProfileOutlined,
  DashboardOutlined,
  DiffOutlined,
  FileTextOutlined,
  FlagOutlined,
  HistoryOutlined,
  InboxOutlined,
  LogoutOutlined,
  RocketOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import type { NotificationItem, SearchHit, SearchResults } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from './meta';

const { Sider, Header, Content } = Layout;

const SEARCH_GROUPS: { title: string; key: keyof SearchResults }[] = [
  { title: 'Parts', key: 'parts' },
  { title: 'Documents', key: 'documents' },
  { title: 'Changes', key: 'ecns' },
  { title: 'Requests', key: 'ecrs' },
  { title: 'Manufacturers', key: 'manufacturers' },
  { title: 'Requirements', key: 'requirements' },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();

  // Global search
  const [searchValue, setSearchValue] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchRequestRef = useRef(0);

  // Notifications
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);

  const selectedKey = useMemo(() => {
    const prefixes = [
      '/my-work',
      '/parts',
      '/ecns',
      '/ecrs',
      '/compare',
      '/documents',
      '/requirements',
      '/baselines',
      '/activity',
      '/erp',
      '/configure',
      '/analytics',
      '/admin/users',
      '/admin/attributes',
      '/admin/workflows',
      '/admin/email',
      '/admin/integration',
    ];
    const match = prefixes.find((prefix) => location.pathname.startsWith(prefix));
    return match ?? '/';
  }, [location.pathname]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimer.current);
    };
  }, []);

  const handleSearch = (value: string) => {
    setSearchValue(value);
    window.clearTimeout(searchTimer.current);
    const q = value.trim();
    if (q.length < 2) {
      searchRequestRef.current += 1;
      setSearchResults(null);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      const requestId = ++searchRequestRef.current;
      void api
        .globalSearch(q)
        .then((results) => {
          // Drop stale responses — an older query must not overwrite a newer one.
          if (searchRequestRef.current === requestId) setSearchResults(results);
        })
        .catch(() => {
          if (searchRequestRef.current === requestId) setSearchResults(null);
        });
    }, 300);
  };

  const { searchOptions, searchRoutes } = useMemo(() => {
    const routes = new Map<string, string>();
    if (!searchResults) return { searchOptions: [], searchRoutes: routes };
    const options = SEARCH_GROUPS.filter((group) => searchResults[group.key].length > 0).map(
      (group) => ({
        label: group.title,
        options: searchResults[group.key].map((hit: SearchHit) => {
          const value = `${group.key}:${hit.id}`;
          routes.set(value, hit.route);
          return {
            value,
            label: (
              <Space size={8}>
                <span>{hit.label}</span>
                {hit.sublabel && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {hit.sublabel}
                  </Typography.Text>
                )}
              </Space>
            ),
          };
        }),
      })
    );
    return { searchOptions: options, searchRoutes: routes };
  }, [searchResults]);

  const handleSearchSelect = (value: string) => {
    const route = searchRoutes.get(value);
    setSearchValue('');
    setSearchResults(null);
    if (route) navigate(route);
  };

  const loadNotifications = useCallback(async () => {
    try {
      const res = await api.listNotifications({ pageSize: 8 });
      setNotifications(res.items);
      setUnread(res.unread);
    } catch {
      // Polling — stay quiet on failures.
    }
  }, []);

  useEffect(() => {
    void loadNotifications();
    const timer = window.setInterval(() => {
      void loadNotifications();
    }, 30000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadNotifications]);

  const openNotification = async (item: NotificationItem) => {
    setNotifOpen(false);
    if (!item.readAt) {
      try {
        const res = await api.markNotificationsRead([item.id]);
        setUnread(res.unread);
        setNotifications((prev) =>
          prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n))
        );
      } catch {
        // Ignore — navigation still proceeds.
      }
    }
    if (item.link) navigate(item.link);
  };

  const markAllRead = async () => {
    try {
      const res = await api.markNotificationsRead();
      setUnread(res.unread);
      setNotifications((prev) =>
        prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() }))
      );
    } catch {
      // Ignore — the next poll refreshes the state.
    }
  };

  const notificationPanel = (
    <div
      style={{
        width: 360,
        background: token.colorBgElevated,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        <List<NotificationItem>
          size="small"
          dataSource={notifications}
          locale={{ emptyText: 'No notifications' }}
          renderItem={(item) => (
            <List.Item
              onClick={() => void openNotification(item)}
              style={{ cursor: 'pointer', paddingInline: 12 }}
            >
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                <Space size={6}>
                  {!item.readAt && <Badge color="blue" />}
                  <Typography.Text strong={!item.readAt}>{item.title}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDate(item.createdAt)}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          padding: '4px 8px',
        }}
      >
        <Button type="link" size="small" onClick={() => void markAllRead()}>
          Mark all read
        </Button>
        <Button type="link" size="small" onClick={() => void loadNotifications()}>
          Refresh
        </Button>
      </div>
    </div>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="64" width={220}>
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '18px 20px',
            color: '#fff',
          }}
        >
          <RocketOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
          <Typography.Text strong style={{ color: '#fff', fontSize: 17 }}>
            TurboPLM
          </Typography.Text>
        </Link>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key)}
          items={[
            { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
            { key: '/my-work', icon: <InboxOutlined />, label: 'My Work' },
            { key: '/parts', icon: <AppstoreOutlined />, label: 'Parts' },
            { key: '/documents', icon: <FileTextOutlined />, label: 'Documents' },
            { key: '/requirements', icon: <ProfileOutlined />, label: 'Requirements' },
            { key: '/ecrs', icon: <InboxOutlined />, label: 'Requests' },
            { key: '/ecns', icon: <AuditOutlined />, label: 'Changes' },
            { key: '/compare', icon: <DiffOutlined />, label: 'BOM Compare' },
            { key: '/baselines', icon: <FlagOutlined />, label: 'Baselines' },
            { key: '/activity', icon: <HistoryOutlined />, label: 'Activity' },
            { key: '/erp', icon: <ApiOutlined />, label: 'ERP Exchange' },
            { key: '/configure', icon: <ControlOutlined />, label: 'Configurator' },
            { key: '/analytics', icon: <BarChartOutlined />, label: 'Analytics' },
            ...(user?.role === 'ADMIN'
              ? [
                  { type: 'divider' as const },
                  { key: '/admin/users', icon: <TeamOutlined />, label: 'Users' },
                  { key: '/admin/attributes', icon: <SettingOutlined />, label: 'Attributes' },
                  { key: '/admin/workflows', icon: <ApartmentOutlined />, label: 'Workflows' },
                  { key: '/admin/email', icon: <MailOutlined />, label: 'Email' },
                  {
                    key: '/admin/integration',
                    icon: <ThunderboltOutlined />,
                    label: 'Integration',
                  },
                ]
              : []),
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingInline: 24,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space size={16}>
            <AutoComplete
              value={searchValue}
              options={searchOptions}
              style={{ width: 320 }}
              onSearch={handleSearch}
              onSelect={handleSearchSelect}
              popupMatchSelectWidth={360}
            >
              <Input
                prefix={<SearchOutlined />}
                placeholder="Search parts, documents, changes…"
                allowClear
              />
            </AutoComplete>
            <Dropdown
              trigger={['click']}
              open={notifOpen}
              onOpenChange={setNotifOpen}
              dropdownRender={() => notificationPanel}
            >
              <Badge count={unread} size="small">
                <Button type="text" icon={<BellOutlined />} />
              </Badge>
            </Dropdown>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: 'Sign out',
                    onClick: async () => {
                      await logout();
                      navigate('/login');
                    },
                  },
                ],
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar src={user?.avatarUrl ?? undefined} icon={<UserOutlined />} size="small" />
                <Typography.Text>{user?.name}</Typography.Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ padding: 24, maxWidth: 1400, width: '100%', margin: '0 auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
