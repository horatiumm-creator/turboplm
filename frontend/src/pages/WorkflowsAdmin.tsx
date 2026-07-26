import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { Role, UserSummary, WorkflowRule, WorkflowTemplateDetail } from '../api/types';
import { ROLE_OPTIONS, WORKFLOW_RULE_META } from '../components/meta';

const RULE_OPTIONS = (Object.keys(WORKFLOW_RULE_META) as WorkflowRule[]).map((value) => ({
  value,
  label: WORKFLOW_RULE_META[value].label,
}));

interface StepRow {
  key: number;
  name: string;
  rule: WorkflowRule;
  role: Role | null;
  userIds: number[];
}

interface TemplateFormValues {
  name: string;
  description?: string;
}

const stepsSummary = (template: WorkflowTemplateDetail) =>
  template.steps
    .map((step) => `${step.seq}. ${step.name} (${step.rule === 'ALL' ? 'All' : 'Any'})`)
    .join(' → ');

export default function WorkflowsAdmin() {
  const { message, modal } = AntdApp.useApp();

  const [templates, setTemplates] = useState<WorkflowTemplateDetail[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowTemplateDetail | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [form] = Form.useForm<TemplateFormValues>();
  const nextKey = useRef(1);

  const makeStep = (): StepRow => ({
    key: nextKey.current++,
    name: '',
    rule: 'ALL',
    role: null,
    userIds: [],
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [templateList, userList] = await Promise.all([
        api.listWorkflowTemplates(),
        api.listUsers(),
      ]);
      setTemplates(templateList);
      setUsers(userList);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const userOptions = users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));

  const toggleActive = async (row: WorkflowTemplateDetail, active: boolean) => {
    setTogglingId(row.id);
    try {
      await api.updateWorkflowTemplate(row.id, { active });
      message.success(`"${row.name}" ${active ? 'activated' : 'deactivated'}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setTogglingId(null);
      await load();
    }
  };

  const openCreate = () => {
    setEditing(null);
    setModalError(null);
    form.resetFields();
    setSteps([makeStep()]);
    setModalOpen(true);
  };

  const openEdit = (template: WorkflowTemplateDetail) => {
    setEditing(template);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ name: template.name, description: template.description ?? undefined });
    setSteps(
      template.steps.map((step) => ({
        key: nextKey.current++,
        name: step.name,
        rule: step.rule,
        role: (step.role as Role | null) ?? null,
        userIds: step.assignees.map((a) => a.id),
      }))
    );
    setModalOpen(true);
  };

  const updateStep = (key: number, patch: Partial<StepRow>) => {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  };

  const removeStep = (key: number) => {
    setSteps((prev) => prev.filter((step) => step.key !== key));
  };

  const moveStep = (index: number, delta: number) => {
    setSteps((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    let values: TemplateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const trimmed = steps.map((step) => ({ ...step, name: step.name.trim() }));
    if (trimmed.length === 0) {
      setModalError('Add at least one step');
      return;
    }
    for (let i = 0; i < trimmed.length; i++) {
      const step = trimmed[i];
      if (!step.name) {
        setModalError(`Step ${i + 1} needs a name`);
        return;
      }
      if (!step.role && step.userIds.length === 0) {
        setModalError(`Step ${i + 1} ("${step.name}") needs a role or at least one user`);
        return;
      }
    }
    const input: api.WorkflowTemplateInput = {
      name: values.name.trim(),
      description: values.description?.trim() ? values.description.trim() : null,
      steps: trimmed.map((step) => ({
        name: step.name,
        rule: step.rule,
        role: step.role ?? undefined,
        userIds: step.userIds.length > 0 ? step.userIds : undefined,
      })),
    };
    setSaving(true);
    setModalError(null);
    try {
      if (editing) {
        await api.updateWorkflowTemplate(editing.id, input);
        message.success('Workflow template updated');
      } else {
        await api.createWorkflowTemplate(input);
        message.success('Workflow template created');
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const remove = (template: WorkflowTemplateDetail) => {
    modal.confirm({
      title: 'Delete workflow template',
      content: `Delete "${template.name}"? Templates with existing workflow instances cannot be deleted.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteWorkflowTemplate(template.id);
          message.success('Workflow template deleted');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const columns: ColumnsType<WorkflowTemplateDetail> = [
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, width: 200 },
    {
      title: 'Description',
      key: 'description',
      ellipsis: true,
      render: (_, row) =>
        row.description ? (
          row.description
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Active',
      key: 'active',
      width: 80,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.active}
          loading={togglingId === row.id}
          onChange={(checked) => void toggleActive(row, checked)}
        />
      ),
    },
    {
      title: 'Steps',
      key: 'steps',
      ellipsis: true,
      render: (_, row) => stepsSummary(row),
    },
    {
      title: 'Instances',
      dataIndex: 'instanceCount',
      key: 'instanceCount',
      width: 100,
      align: 'right',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_, row) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            Edit
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => remove(row)}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Approval workflows
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          New template
        </Button>
      </div>

      <Table<WorkflowTemplateDetail>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={templates}
        loading={loading}
        pagination={false}
      />

      <Modal
        title={editing ? 'Edit workflow template' : 'New workflow template'}
        open={modalOpen}
        onOk={() => void save()}
        okText={editing ? 'Save' : 'Create'}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        width={760}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'At most 100 characters' },
            ]}
          >
            <Input placeholder="e.g. Standard ECN approval" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="When should this workflow be used?" />
          </Form.Item>
        </Form>

        <Divider orientation="left" plain style={{ marginTop: 0 }}>
          Steps
        </Divider>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Steps run in order. Each step is assigned by role, by specific users, or both — it
          needs at least one of the two.
        </Typography.Paragraph>

        {steps.map((step, index) => (
          <div
            key={step.key}
            style={{
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <Typography.Text strong style={{ width: 24, textAlign: 'right' }}>
                {index + 1}.
              </Typography.Text>
              <Input
                placeholder="Step name (e.g. Engineering review)"
                value={step.name}
                onChange={(e) => updateStep(step.key, { name: e.target.value })}
                style={{ flex: 1 }}
              />
              <Select<WorkflowRule>
                style={{ width: 180 }}
                value={step.rule}
                options={RULE_OPTIONS}
                onChange={(rule) => updateStep(step.key, { rule })}
              />
              <Button
                type="text"
                size="small"
                icon={<ArrowUpOutlined />}
                disabled={index === 0}
                onClick={() => moveStep(index, -1)}
              />
              <Button
                type="text"
                size="small"
                icon={<ArrowDownOutlined />}
                disabled={index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeStep(step.key)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ width: 24 }} />
              <Select<Role>
                style={{ width: 180 }}
                allowClear
                placeholder="Assign by role"
                value={step.role ?? undefined}
                options={ROLE_OPTIONS}
                onChange={(role) => updateStep(step.key, { role: role ?? null })}
              />
              <Select<number[]>
                mode="multiple"
                style={{ flex: 1 }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Assign specific users"
                value={step.userIds}
                options={userOptions}
                onChange={(userIds) => updateStep(step.key, { userIds })}
              />
            </div>
          </div>
        ))}
        <Button
          type="dashed"
          block
          icon={<PlusOutlined />}
          onClick={() => setSteps((prev) => [...prev, makeStep()])}
        >
          Add step
        </Button>
      </Modal>
    </div>
  );
}
