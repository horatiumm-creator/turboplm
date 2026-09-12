import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, TeamOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { AccessGroupDetail, AccessGroupSummary, UserSummary } from '../api/types';

const { Text, Paragraph } = Typography;

/**
 * Access groups (rule X6). A group grants nothing by itself — only a grant on an item does —
 * so this page manages membership, and the one loud control is `active`: deactivating a group
 * suspends every grant it holds, everywhere, at once.
 */
export default function AccessGroupsAdmin() {
  const { message } = AntdApp.useApp();
  const [groups, setGroups] = useState<AccessGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AccessGroupDetail | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addUserId, setAddUserId] = useState<number | undefined>();
  const [form] = Form.useForm<{ name: string; description?: string }>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listAccessGroups();
      setGroups(list);
      setSelected((current) => {
        if (!current) return current;
        return list.some((group) => group.id === current.id) ? current : null;
      });
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to load access groups');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
    api.listUsers().then(setUsers, () => undefined);
  }, [reload]);

  const openGroup = async (id: number) => {
    try {
      setSelected(await api.getAccessGroup(id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to load the group');
    }
  };

  const create = async (values: { name: string; description?: string }) => {
    setSaving(true);
    setCreateError(null);
    try {
      const created = await api.createAccessGroup({
        name: values.name,
        description: values.description || null,
      });
      setCreateOpen(false);
      form.resetFields();
      await reload();
      setSelected(created);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create the group');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (group: AccessGroupSummary, active: boolean) => {
    try {
      const updated = await api.updateAccessGroup(group.id, { active });
      message.success(
        active
          ? `${updated.name} is active — its grants apply again`
          : `${updated.name} is deactivated — every grant it holds is suspended`
      );
      await reload();
      setSelected((current) => (current?.id === group.id ? updated : current));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to update the group');
    }
  };

  const remove = async (group: AccessGroupSummary) => {
    try {
      await api.deleteAccessGroup(group.id);
      message.success(`${group.name} deleted`);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to delete the group');
    }
  };

  const addMember = async () => {
    if (!selected || addUserId === undefined) return;
    try {
      setSelected(await api.addAccessGroupMember(selected.id, addUserId));
      setAddUserId(undefined);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to add the member');
    }
  };

  const removeMember = async (memberId: number) => {
    if (!selected) return;
    try {
      await api.removeAccessGroupMember(memberId);
      setSelected(await api.getAccessGroup(selected.id));
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to remove the member');
    }
  };

  const columns: ColumnsType<AccessGroupSummary> = [
    {
      title: 'Group',
      key: 'name',
      render: (_, group) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0 }} onClick={() => void openGroup(group.id)}>
            {group.name}
          </Button>
          {group.description && <Text type="secondary">{group.description}</Text>}
        </Space>
      ),
    },
    { title: 'Members', dataIndex: 'memberCount', width: 100 },
    {
      title: 'Grants',
      dataIndex: 'grantCount',
      width: 100,
      render: (count: number) => (count > 0 ? <Tag color="blue">{count}</Tag> : <Text type="secondary">0</Text>),
    },
    {
      title: 'Active',
      key: 'active',
      width: 90,
      render: (_, group) => (
        <Switch
          size="small"
          checked={group.active}
          onChange={(checked) => void toggleActive(group, checked)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_, group) => (
        <Popconfirm
          title={
            group.grantCount > 0
              ? `${group.name} still holds ${group.grantCount} grant(s) — the server will refuse. Deactivate it instead?`
              : 'Delete this group?'
          }
          onConfirm={() => void remove(group)}
        >
          <Button size="small" danger type="text">
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <TeamOutlined />
            Access groups
          </Space>
        }
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            New group
          </Button>
        }
      >
        <Paragraph type="secondary">
          A group grants nothing by itself. Grant it access on a part, document, ECN, project or
          build unit from that item&apos;s Access panel — the <em>first</em> grant on an item
          restricts the item to its list. Deactivating a group suspends every grant it holds.
        </Paragraph>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={groups}
          pagination={false}
        />
      </Card>

      {selected && (
        <Card size="small" title={`Members of ${selected.name}`}>
          <Space style={{ marginBottom: 12 }}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 260 }}
              placeholder="Add a user"
              value={addUserId}
              onChange={setAddUserId}
              options={users
                .filter((user) => !selected.members.some((member) => member.user.id === user.id))
                .map((user) => ({ value: user.id, label: `${user.name} (${user.email})` }))}
            />
            <Button icon={<PlusOutlined />} disabled={addUserId === undefined} onClick={() => void addMember()}>
              Add
            </Button>
          </Space>
          {selected.members.length === 0 ? (
            <Alert type="info" showIcon message="No members yet — this group grants access to nobody." />
          ) : (
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={selected.members}
              columns={[
                { title: 'Name', key: 'name', render: (_, member) => member.user.name },
                {
                  title: 'Added',
                  key: 'addedAt',
                  render: (_, member) => new Date(member.addedAt).toLocaleDateString(),
                },
                {
                  title: '',
                  key: 'actions',
                  width: 100,
                  render: (_, member) => (
                    <Popconfirm
                      title="Removing this member revokes their access through this group on every item it is granted on."
                      onConfirm={() => void removeMember(member.id)}
                    >
                      <Button size="small" danger type="text">
                        Remove
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
        </Card>
      )}

      <Modal
        title="New access group"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        destroyOnClose
      >
        {createError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={createError} />
        )}
        <Form form={form} layout="vertical" onFinish={(values) => void create(values)}>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Name the group' }]}
          >
            <Input maxLength={100} placeholder="e.g. Propulsion team" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
