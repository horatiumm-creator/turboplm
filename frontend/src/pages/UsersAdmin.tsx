import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Role, UserSummary } from '../api/types';
import { formatDate, ROLE_OPTIONS } from '../components/meta';

export default function UsersAdmin() {
  const { message } = AntdApp.useApp();
  const { user: currentUser } = useAuth();

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await api.listUsers());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (row: UserSummary, role: Role) => {
    setSavingId(row.id);
    try {
      await api.updateUserRole(row.id, role);
      message.success(`Role updated for ${row.name}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSavingId(null);
      await load();
    }
  };

  const columns: ColumnsType<UserSummary> = [
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: 'Email', dataIndex: 'email', key: 'email', ellipsis: true },
    {
      title: 'Provider',
      key: 'provider',
      width: 110,
      render: (_, row) =>
        row.provider === 'GOOGLE' ? <Tag color="blue">Google</Tag> : <Tag>Local</Tag>,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 160,
      render: (_, row) => formatDate(row.createdAt),
    },
    {
      title: 'Role',
      key: 'role',
      width: 170,
      render: (_, row) => {
        const isSelf = row.id === currentUser?.id;
        const select = (
          <Select<Role>
            style={{ width: 140 }}
            value={row.role}
            options={ROLE_OPTIONS}
            disabled={isSelf}
            loading={savingId === row.id}
            onChange={(role) => void changeRole(row, role)}
          />
        );
        return isSelf ? (
          <Tooltip title="You cannot change your own role">
            <span style={{ display: 'inline-block' }}>{select}</span>
          </Tooltip>
        ) : (
          select
        );
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 16 }}>
        Users
      </Typography.Title>
      <Table<UserSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        pagination={false}
      />
    </div>
  );
}
