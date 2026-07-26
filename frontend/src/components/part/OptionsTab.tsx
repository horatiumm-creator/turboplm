import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { OptionGroupDetail, OptionValueDetail, PartDetail } from '../../api/types';

interface GroupFormValues {
  code: string;
  name: string;
  description?: string;
  required: boolean;
  multiSelect: boolean;
}

interface ValueFormValues {
  code: string;
  name: string;
  isDefault: boolean;
}

/** Option / value codes are short identifiers, mirroring the backend rule. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

export default function OptionsTab({
  part,
  editable,
  onChanged,
}: {
  part: PartDetail;
  editable: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { message, modal } = AntdApp.useApp();

  const [groups, setGroups] = useState<OptionGroupDetail[]>([]);
  const [loading, setLoading] = useState(false);

  // Add option group modal
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupForm] = Form.useForm<GroupFormValues>();

  // Add value modal (scoped to one group)
  const [valueGroup, setValueGroup] = useState<OptionGroupDetail | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [valueSaving, setValueSaving] = useState(false);
  const [valueForm] = Form.useForm<ValueFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await api.listOptionGroups(part.id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [part.id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const showError = useCallback(
    (err: unknown, title: string) => {
      if (err instanceof ApiError && err.status === 409) {
        modal.error({ title, content: err.message });
      } else {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    },
    [modal, message]
  );

  // ---- option groups ------------------------------------------------------

  const openGroupModal = () => {
    setGroupError(null);
    groupForm.resetFields();
    groupForm.setFieldsValue({ required: false, multiSelect: false });
    setGroupOpen(true);
  };

  const submitGroup = async () => {
    let values: GroupFormValues;
    try {
      values = await groupForm.validateFields();
    } catch {
      return;
    }
    setGroupSaving(true);
    setGroupError(null);
    try {
      await api.createOptionGroup(part.id, {
        code: values.code.trim(),
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        required: values.required,
        multiSelect: values.multiSelect,
      });
      message.success('Option group added');
      setGroupOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setGroupError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setGroupSaving(false);
    }
  };

  const confirmDeleteGroup = (group: OptionGroupDetail) => {
    const used = group.values.reduce((sum, v) => sum + v.lineCount, 0);
    modal.confirm({
      title: 'Delete option group',
      content:
        used > 0
          ? `Delete ${group.code} — ${group.name}? Its values condition ${used} BOM line(s); those conditions will be removed too.`
          : `Delete ${group.code} — ${group.name}? All of its option values will be removed.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteOptionGroup(group.id);
          message.success('Option group deleted');
          await load();
          onChanged();
        } catch (err) {
          showError(err, 'Cannot delete option group');
        }
      },
    });
  };

  // ---- option values ------------------------------------------------------

  const openValueModal = (group: OptionGroupDetail) => {
    setValueError(null);
    valueForm.resetFields();
    valueForm.setFieldsValue({ isDefault: false });
    setValueGroup(group);
  };

  const submitValue = async () => {
    if (!valueGroup) return;
    let values: ValueFormValues;
    try {
      values = await valueForm.validateFields();
    } catch {
      return;
    }
    setValueSaving(true);
    setValueError(null);
    try {
      await api.createOptionValue(valueGroup.id, {
        code: values.code.trim(),
        name: values.name.trim(),
        isDefault: values.isDefault,
      });
      message.success('Option value added');
      setValueGroup(null);
      await load();
      onChanged();
    } catch (err) {
      setValueError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setValueSaving(false);
    }
  };

  const confirmDeleteValue = (group: OptionGroupDetail, value: OptionValueDetail) => {
    modal.confirm({
      title: 'Delete option value',
      content:
        value.lineCount > 0
          ? `Delete ${value.code} — ${value.name} from ${group.name}? It currently conditions ${value.lineCount} BOM line(s).`
          : `Delete ${value.code} — ${value.name} from ${group.name}?`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteOptionValue(value.id);
          message.success('Option value deleted');
          await load();
          onChanged();
        } catch (err) {
          showError(err, 'Cannot delete option value');
        }
      },
    });
  };

  // ---- render -------------------------------------------------------------

  const valueColumns = (group: OptionGroupDetail): ColumnsType<OptionValueDetail> => [
    {
      title: 'Code',
      key: 'code',
      width: 160,
      render: (_, value) => <Typography.Text code>{value.code}</Typography.Text>,
    },
    {
      title: 'Value',
      key: 'name',
      render: (_, value) => (
        <Space size={8}>
          <Typography.Text>{value.name}</Typography.Text>
          {value.isDefault && <Tag color="blue">Default</Tag>}
        </Space>
      ),
    },
    {
      title: 'Usage',
      key: 'lineCount',
      width: 180,
      render: (_, value) => (
        <Typography.Text type="secondary">
          {value.lineCount === 0
            ? 'not used on any line'
            : `used on ${value.lineCount} line${value.lineCount === 1 ? '' : 's'}`}
        </Typography.Text>
      ),
    },
    ...(editable
      ? ([
          {
            title: 'Actions',
            key: 'actions',
            width: 110,
            render: (_, value) => (
              <Button
                type="link"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => confirmDeleteValue(group, value)}
              >
                Delete
              </Button>
            ),
          },
        ] as ColumnsType<OptionValueDetail>)
      : []),
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Typography.Text type="secondary">
          Option groups turn {part.partNumber} into a configurable product: give each group its
          values, then condition BOM lines on them in the Bill of Materials tab.
        </Typography.Text>
        {editable && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openGroupModal}>
            Add option group
          </Button>
        )}
      </div>

      <Spin spinning={loading}>
        {groups.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text strong>No option groups yet</Typography.Text>
                <Typography.Text type="secondary">
                  Options describe the choices a customer makes on a product variant — for example a
                  group &quot;BATTERY&quot; with values &quot;4S&quot; and &quot;6S&quot;. Once a
                  group has values you can condition BOM lines on them in the Bill of Materials tab,
                  and resolve a concrete variant on the Configurator page.
                </Typography.Text>
              </Space>
            }
            style={{ padding: 32 }}
          />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {groups.map((group) => (
              <Card
                key={group.id}
                size="small"
                title={
                  <Space size={8} wrap>
                    <Typography.Text code>{group.code}</Typography.Text>
                    <Typography.Text strong>{group.name}</Typography.Text>
                    {group.required && <Tag color="red">Required</Tag>}
                    <Tag>{group.multiSelect ? 'Multi-select' : 'Single-select'}</Tag>
                  </Space>
                }
                extra={
                  editable && (
                    <Space size={0}>
                      <Button
                        type="link"
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={() => openValueModal(group)}
                      >
                        Add value
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => confirmDeleteGroup(group)}
                      >
                        Delete group
                      </Button>
                    </Space>
                  )
                }
              >
                {group.description && (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                    {group.description}
                  </Typography.Paragraph>
                )}
                <Table<OptionValueDetail>
                  size="small"
                  rowKey="id"
                  columns={valueColumns(group)}
                  dataSource={group.values}
                  pagination={false}
                  locale={{
                    emptyText: 'No values yet — add at least one so the group can be configured.',
                  }}
                />
              </Card>
            ))}
          </Space>
        )}
      </Spin>

      <Modal
        title="Add option group"
        open={groupOpen}
        onOk={() => void submitGroup()}
        okText="Add"
        confirmLoading={groupSaving}
        onCancel={() => setGroupOpen(false)}
        forceRender
      >
        {groupError && (
          <Alert type="error" showIcon message={groupError} style={{ marginBottom: 16 }} />
        )}
        <Form form={groupForm} layout="vertical">
          <Form.Item
            name="code"
            label="Code"
            tooltip="Short identifier used when resolving a variant, e.g. BATTERY."
            rules={[
              { required: true, whitespace: true, message: 'Code is required' },
              { pattern: CODE_PATTERN, message: 'Letters, digits, _ and - only (max 20)' },
            ]}
          >
            <Input placeholder="e.g. BATTERY" maxLength={20} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, whitespace: true, message: 'Name is required' }]}
          >
            <Input placeholder="e.g. Battery pack" maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space size={32}>
            <Form.Item
              name="required"
              label="Required"
              valuePropName="checked"
              tooltip="A variant cannot be resolved without a choice from this group."
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="multiSelect"
              label="Multi-select"
              valuePropName="checked"
              tooltip="Allow more than one value of this group to be selected at a time."
            >
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={valueGroup ? `Add value to ${valueGroup.name}` : 'Add value'}
        open={valueGroup !== null}
        onOk={() => void submitValue()}
        okText="Add"
        confirmLoading={valueSaving}
        onCancel={() => setValueGroup(null)}
        forceRender
      >
        {valueError && (
          <Alert type="error" showIcon message={valueError} style={{ marginBottom: 16 }} />
        )}
        <Form form={valueForm} layout="vertical">
          <Form.Item
            name="code"
            label="Code"
            rules={[
              { required: true, whitespace: true, message: 'Code is required' },
              { pattern: CODE_PATTERN, message: 'Letters, digits, _ and - only (max 20)' },
            ]}
          >
            <Input placeholder="e.g. 6S" maxLength={20} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, whitespace: true, message: 'Name is required' }]}
          >
            <Input placeholder="e.g. 6-cell pack" maxLength={120} />
          </Form.Item>
          <Form.Item
            name="isDefault"
            label="Default"
            valuePropName="checked"
            tooltip="Preselected on the Configurator page."
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
