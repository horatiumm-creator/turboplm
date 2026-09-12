import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ProjectStatus, ProjectSummary, UserSummary } from '../api/types';
import {
  formatDate,
  GateStatusTag,
  PROJECT_STATUS_OPTIONS,
  ProjectStatusTag,
} from '../components/meta';

interface ProjectFormValues {
  code: string;
  name: string;
  description?: string;
  ownerId: number;
  startDate?: Dayjs | null;
  targetDate?: Dayjs | null;
}

export default function Projects() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<ProjectStatus | undefined>(undefined);
  const req = useRef(0);

  const load = useCallback(async () => {
    const id = ++req.current;
    setLoading(true);
    try {
      const res = await api.listProjects({ status, page, pageSize });
      if (req.current !== id) return; // a newer request has superseded this one
      setProjects(res.items);
      setTotal(res.total);
    } catch (err) {
      if (req.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (req.current === id) setLoading(false);
    }
  }, [status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- create --------------------------------------------------------------
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ProjectFormValues>();
  const [users, setUsers] = useState<UserSummary[]>([]);

  const openCreate = () => {
    setError(null);
    form.resetFields();
    setOpen(true);
    void (async () => {
      try {
        const list = await api.listUsers();
        setUsers(list);
        if (user) {
          const me = list.find((u) => u.id === user.id);
          if (me) form.setFieldsValue({ ownerId: me.id });
        }
      } catch {
        setUsers([]);
      }
    })();
  };

  const save = async () => {
    let values: ProjectFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createProject({
        code: values.code.trim().toUpperCase(),
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        ownerId: values.ownerId,
        startDate: values.startDate ? values.startDate.toISOString() : undefined,
        targetDate: values.targetDate ? values.targetDate.toISOString() : undefined,
      });
      message.success(`${created.code} created`);
      setOpen(false);
      navigate(`/projects/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<ProjectSummary> = [
    {
      title: 'Code',
      key: 'code',
      width: 130,
      render: (_, r) => <Link to={`/projects/${r.id}`}>{r.code}</Link>,
    },
    { title: 'Project', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <ProjectStatusTag status={r.status} />,
    },
    {
      title: 'Current gate',
      key: 'currentPhase',
      width: 220,
      render: (_, r) =>
        r.currentPhase ? (
          <Space size={6}>
            <span>{r.currentPhase.name}</span>
            <GateStatusTag status={r.currentPhase.status} />
          </Space>
        ) : (
          <Typography.Text type="secondary">All gates passed</Typography.Text>
        ),
    },
    {
      title: 'Gates',
      key: 'gates',
      width: 160,
      render: (_, r) => (
        <Space size={8}>
          <Progress
            percent={r.phaseCount ? Math.round((r.passedPhases / r.phaseCount) * 100) : 0}
            size="small"
            style={{ width: 80, marginBottom: 0 }}
            showInfo={false}
          />
          <Typography.Text type="secondary">
            {r.passedPhases}/{r.phaseCount}
          </Typography.Text>
        </Space>
      ),
    },
    { title: 'Owner', key: 'owner', width: 150, render: (_, r) => r.owner.name },
    { title: 'Target', key: 'targetDate', width: 130, render: (_, r) => formatDate(r.targetDate) },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Projects
        </Typography.Title>
        <Space wrap>
          <Select
            placeholder="Status"
            allowClear
            style={{ width: 170 }}
            options={PROJECT_STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New project
            </Button>
          )}
        </Space>
      </div>

      <Table<ProjectSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={projects}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} projects`,
          onChange: (p, size) => {
            setPage(size !== pageSize ? 1 : p);
            setPageSize(size);
          },
        }}
      />

      <Modal
        title="New project"
        open={open}
        onOk={() => void save()}
        okText="Create"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        forceRender
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="code"
              label="Code"
              style={{ width: 180 }}
              rules={[
                { required: true, message: 'Code is required' },
                {
                  pattern: /^[A-Z0-9-]{2,20}$/i,
                  message: '2–20 chars: letters, digits, dashes',
                },
              ]}
            >
              <Input placeholder="NPD-2026" />
            </Form.Item>
            <Form.Item
              name="name"
              label="Name"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Name is required' }, { max: 200 }]}
            >
              <Input placeholder="Next-gen battery pack" />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Scope and objectives" />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="ownerId"
              label="Owner"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Select an owner' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
            </Form.Item>
            <Form.Item name="startDate" label="Start" style={{ width: 150 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="targetDate" label="Target" style={{ width: 150 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary">
            The five standard gates — Concept, Design, Validation, Pilot, Production — are created
            automatically. You can add more later.
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
