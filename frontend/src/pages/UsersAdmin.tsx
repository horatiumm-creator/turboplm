import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Popconfirm, Select, Table, Tag, Tooltip, Typography } from 'antd';
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

  /*
   * Revoking somebody's AI provider key. CLEAR ONLY — there is no endpoint anywhere that
   * returns another person's key, and this one does not report whether they had one either.
   *
   * It exists because a departed engineer's key cannot otherwise be removed: their User row
   * survives offboarding by design (change control is worthless if attribution can be
   * deleted), they are moved to VIEWER and can no longer sign in to clear it themselves, so
   * without this the credential sits in the database for ever with nobody able to remove it.
   *
   * Offered for every row rather than only for rows that have one, because "who has a key
   * configured" is not a fact this product publishes to the instance — `GET /users` is read by
   * the reviewer pickers too. On somebody with no key it is simply a no-op.
   */
  const revokeAiKey = async (row: UserSummary) => {
    setSavingId(row.id);
    try {
      await api.deleteUserAiKey(row.id);
      message.success(`Any AI key belonging to ${row.name} has been removed`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSavingId(null);
    }
  };

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
    {
      title: 'AI key',
      key: 'aiKey',
      width: 130,
      render: (_, row) => (
        <Popconfirm
          title="Remove this user's AI key?"
          description={
            <span style={{ display: 'inline-block', maxWidth: 320 }}>
              Their own provider key is deleted and the AI features stop working for them. You
              cannot see it and this cannot be undone — only they can add another.
            </span>
          }
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => void revokeAiKey(row)}
        >
          <Button size="small" danger loading={savingId === row.id}>
            Revoke
          </Button>
        </Popconfirm>
      ),
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
