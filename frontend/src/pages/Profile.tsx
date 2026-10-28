import { Avatar, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import AiKeyCard from '../components/AiKeyCard';

/**
 * The signed-in person's own page: who they are here, and the one setting that belongs to them
 * rather than to the deployment — their AI provider key.
 *
 * Read-only above the key card. Name, email and role are not editable here on purpose: role is
 * an administrator's decision (changing your own would be a privilege escalation with a form
 * around it), and email identifies the account the session is bound to.
 */
export default function Profile(): JSX.Element {
  const { user } = useAuth();

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ marginBottom: 0 }}>
        Your profile
      </Typography.Title>

      <Card>
        <Space size="large" align="start">
          <Avatar size={56} src={user?.avatarUrl ?? undefined} icon={<UserOutlined />} />
          <Descriptions size="small" column={1} style={{ minWidth: 320 }}>
            <Descriptions.Item label="Name">{user?.name ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Email">{user?.email ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Role">
              <Tag>{user?.role ?? '—'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Sign-in">
              <Tag>{user?.provider === 'GOOGLE' ? 'Google' : 'Email and password'}</Tag>
            </Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <AiKeyCard />
    </Space>
  );
}
