import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  AccessGroupSummary,
  AclEntityType,
  AclPermission,
  ItemAccess,
  ItemGrant,
  UserSummary,
} from '../api/types';

const { Text } = Typography;

const NOUN: Record<AclEntityType, string> = {
  PART: 'part',
  DOCUMENT: 'document',
  ECN: 'ECN',
  PROJECT: 'project',
  BUILD_UNIT: 'build unit',
};

interface GrantFormValues {
  principal: 'group' | 'user';
  groupId?: number;
  userId?: number;
  permission: AclPermission;
}

/**
 * Who can see this item (rules X1-X6). Shown on every protected detail page.
 *
 * The one deliberately loud moment is the FIRST grant: an open item becomes restricted to
 * that list, which is the opposite of what "add access" sounds like. The modal says so
 * before the write, not after.
 */
export default function ItemAccessCard(props: { entityType: AclEntityType; entityId: number }) {
  const { entityType, entityId } = props;
  const { message } = AntdApp.useApp();
  const [access, setAccess] = useState<ItemAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [groups, setGroups] = useState<AccessGroupSummary[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [form] = Form.useForm<GrantFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAccess(await api.getItemAccess(entityType, entityId));
    } catch {
      // A caller without read access never reaches this card; treat errors as "no panel".
      setAccess(null);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openModal = async () => {
    setModalError(null);
    form.resetFields();
    setModalOpen(true);
    try {
      const [groupList, userList] = await Promise.all([api.listAccessGroups(), api.listUsers()]);
      setGroups(groupList.filter((group) => group.active));
      setUsers(userList);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Failed to load groups and users');
    }
  };

  const submit = async (values: GrantFormValues) => {
    setSaving(true);
    setModalError(null);
    try {
      const updated = await api.addItemGrant(entityType, entityId, {
        permission: values.permission,
        ...(values.principal === 'group' ? { groupId: values.groupId } : { userId: values.userId }),
      });
      setAccess(updated);
      setModalOpen(false);
      message.success(
        updated.grants.length === 1
          ? `This ${NOUN[entityType]} is now restricted to the list below`
          : 'Access granted'
      );
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Failed to add the grant');
    } finally {
      setSaving(false);
    }
  };

  const removeGrant = async (grant: ItemGrant) => {
    try {
      await api.removeItemGrant(grant.id);
      const updated = await api.getItemAccess(entityType, entityId);
      setAccess(updated);
      if (!updated.restricted) {
        message.warning(
          `The last grant is gone — this ${NOUN[entityType]} is open to everyone again`
        );
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Failed to remove the grant');
    }
  };

  if (!access && !loading) return null;

  const columns: ColumnsType<ItemGrant> = [
    {
      title: 'Who',
      key: 'who',
      render: (_, grant) =>
        grant.group ? (
          <Space size={4}>
            <Tag color="geekblue">Group</Tag>
            {grant.group.name}
          </Space>
        ) : (
          <Space size={4}>
            <Tag>User</Tag>
            {grant.user?.name}
          </Space>
        ),
    },
    {
      title: 'Permission',
      dataIndex: 'permission',
      render: (permission: AclPermission) => (
        <Tag color={permission === 'WRITE' ? 'gold' : 'default'}>{permission}</Tag>
      ),
    },
    {
      title: 'Granted by',
      key: 'grantedBy',
      render: (_, grant) => (
        <Text type="secondary">
          {grant.grantedBy.name} · {new Date(grant.grantedAt).toLocaleDateString()}
        </Text>
      ),
    },
    ...(access?.canManage
      ? [
          {
            title: '',
            key: 'actions',
            width: 90,
            render: (_: unknown, grant: ItemGrant) => (
              <Popconfirm
                title={
                  access.grants.length === 1
                    ? 'This is the last grant — removing it opens the item to everyone again.'
                    : 'Remove this grant?'
                }
                onConfirm={() => void removeGrant(grant)}
              >
                <Button size="small" danger type="text">
                  Remove
                </Button>
              </Popconfirm>
            ),
          } satisfies ColumnsType<ItemGrant>[number],
        ]
      : []),
  ];

  const firstGrant = access !== null && !access.restricted;

  return (
    <Card
      size="small"
      title={
        <Space>
          {access?.restricted ? <LockOutlined /> : <UnlockOutlined />}
          Access
          {access?.restricted ? (
            <Tag color="red">Restricted</Tag>
          ) : (
            <Tag color="green">Open</Tag>
          )}
        </Space>
      }
      loading={loading}
      extra={
        access?.canManage ? (
          <Button size="small" icon={<PlusOutlined />} onClick={() => void openModal()}>
            Grant access
          </Button>
        ) : undefined
      }
    >
      {/*
        The "Open" state is already a tag on the card title, and Grant access is already a
        button in the corner. A three-line banner restating both, on every unrestricted item —
        which is most items — is wallpaper. It trains people to skip the panel, which is the
        opposite of what an access control needs.
      */}
      {access && access.grants.length > 0 && (
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={access.grants}
          pagination={false}
        />
      )}

      <Modal
        title={firstGrant ? 'Restrict this item' : 'Grant access'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText={firstGrant ? 'Restrict and grant' : 'Grant'}
        confirmLoading={saving}
        destroyOnClose
      >
        {firstGrant && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="This is the first grant"
            description={`Adding it RESTRICTS this ${NOUN[entityType]}: from then on only the people and groups on the list (and administrators) can see it. Everyone else will no longer find it anywhere.`}
          />
        )}
        {modalError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={modalError} />
        )}
        <Form<GrantFormValues>
          form={form}
          layout="vertical"
          initialValues={{ principal: 'group', permission: 'READ' }}
          onFinish={(values) => void submit(values)}
        >
          <Form.Item name="principal" label="Grant to">
            <Radio.Group
              options={[
                { label: 'Access group', value: 'group' },
                { label: 'Single user', value: 'user' },
              ]}
              optionType="button"
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.principal !== next.principal}>
            {({ getFieldValue }) =>
              getFieldValue('principal') === 'group' ? (
                <Form.Item
                  name="groupId"
                  label="Group"
                  rules={[{ required: true, message: 'Pick a group' }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={groups.map((group) => ({
                      value: group.id,
                      label: `${group.name} (${group.memberCount} member${group.memberCount === 1 ? '' : 's'})`,
                    }))}
                    placeholder="Access group"
                  />
                </Form.Item>
              ) : (
                <Form.Item
                  name="userId"
                  label="User"
                  rules={[{ required: true, message: 'Pick a user' }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={users.map((user) => ({ value: user.id, label: user.name }))}
                    placeholder="User"
                  />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item name="permission" label="Permission">
            <Radio.Group
              options={[
                { label: 'Read', value: 'READ' },
                { label: 'Read + write', value: 'WRITE' },
              ]}
              optionType="button"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
