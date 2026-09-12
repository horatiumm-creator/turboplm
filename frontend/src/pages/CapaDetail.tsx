import { useCallback, useEffect, useState } from 'react';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  EditOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CapaDetail as CapaDetailDto, NcrSummary, UserSummary } from '../api/types';
import {
  CapaStatusTag,
  ECN_DISPOSITION_META,
  formatDate,
  NcrSeverityTag,
  NcrStatusTag,
} from '../components/meta';

interface EditValues {
  title: string;
  problem: string;
  rootCause?: string | null;
  containment?: string | null;
  correctiveAction?: string | null;
  preventiveAction?: string | null;
  ownerId: number;
  dueDate?: Dayjs | null;
}

/** One 8D-style section: a heading plus its recorded text, or a prompt when empty. */
function Section({ title, hint, value }: { title: string; hint: string; value: string | null }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Typography.Text strong>{title}</Typography.Text>
      <div style={{ marginTop: 4 }}>
        {value ? (
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            {value}
          </Typography.Paragraph>
        ) : (
          <Typography.Text type="secondary" italic>
            {hint}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

export default function CapaDetail() {
  const { id: idParam } = useParams();
  const capaId = Number(idParam);
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [capa, setCapa] = useState<CapaDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<EditValues>();
  const [users, setUsers] = useState<UserSummary[]>([]);

  const load = useCallback(async () => {
    if (!Number.isInteger(capaId) || capaId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      setCapa(await api.getCapa(capaId));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [capaId, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !capa) {
    return (
      <Empty description="Corrective action not found">
        <Link to="/quality">Back to quality</Link>
      </Empty>
    );
  }

  const canEdit = user?.role !== 'VIEWER';
  const editable = canEdit && capa.status !== 'CLOSED';

  const transition = (
    action: 'start' | 'verify' | 'close' | 'reopen',
    title: string,
    content: string
  ) => {
    modal.confirm({
      title,
      content,
      okText: title,
      okButtonProps: action === 'reopen' ? { danger: true } : undefined,
      onOk: async () => {
        setActing(true);
        try {
          const updated = await api.transitionCapa(capa.id, action);
          setCapa(updated);
          message.success(`${updated.capaNumber} is now ${updated.status.replace('_', ' ')}`);
        } catch (err) {
          modal.error({
            title: `Cannot ${action}`,
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        } finally {
          setActing(false);
        }
      },
    });
  };

  const openEdit = () => {
    setEditError(null);
    form.setFieldsValue({
      title: capa.title,
      problem: capa.problem,
      rootCause: capa.rootCause,
      containment: capa.containment,
      correctiveAction: capa.correctiveAction,
      preventiveAction: capa.preventiveAction,
      ownerId: capa.owner.id,
      dueDate: capa.dueDate ? dayjs(capa.dueDate) : null,
    });
    setEditOpen(true);
    void (async () => {
      try {
        setUsers(await api.listUsers());
      } catch {
        setUsers([]);
      }
    })();
  };

  const save = async () => {
    let values: EditValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const text = (v?: string | null) => (v && v.trim() ? v.trim() : null);
    setSaving(true);
    setEditError(null);
    try {
      setCapa(
        await api.updateCapa(capa.id, {
          title: values.title.trim(),
          problem: values.problem.trim(),
          rootCause: text(values.rootCause),
          containment: text(values.containment),
          correctiveAction: text(values.correctiveAction),
          preventiveAction: text(values.preventiveAction),
          ownerId: values.ownerId,
          dueDate: values.dueDate ? values.dueDate.toISOString() : null,
        })
      );
      setEditOpen(false);
      message.success('Corrective action updated');
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const ncrColumns: ColumnsType<NcrSummary> = [
    {
      title: 'NCR #',
      key: 'ncrNumber',
      width: 130,
      render: (_, r) => <Link to={`/ncrs/${r.id}`}>{r.ncrNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Part',
      key: 'part',
      width: 140,
      render: (_, r) => (r.part ? <Link to={`/parts/${r.part.id}`}>{r.part.partNumber}</Link> : '—'),
    },
    {
      title: 'Severity',
      key: 'severity',
      width: 110,
      render: (_, r) => <NcrSeverityTag severity={r.severity} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <NcrStatusTag status={r.status} />,
    },
    {
      title: 'Disposition',
      key: 'disposition',
      width: 140,
      render: (_, r) => (r.disposition ? ECN_DISPOSITION_META[r.disposition].label : '—'),
    },
  ];

  const openNcrs = capa.nonconformances.filter((n) => n.status !== 'CLOSED');

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space direction="vertical" size={4}>
            <Space size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {capa.capaNumber} — {capa.title}
              </Typography.Title>
              <CapaStatusTag status={capa.status} />
            </Space>
            <Typography.Text type="secondary">
              Corrective &amp; preventive action · owned by {capa.owner.name}
            </Typography.Text>
          </Space>
          {editable && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
          )}
        </div>

        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Owner">{capa.owner.name}</Descriptions.Item>
          <Descriptions.Item label="Due">{formatDate(capa.dueDate)}</Descriptions.Item>
          <Descriptions.Item label="Verified">{formatDate(capa.verifiedAt)}</Descriptions.Item>
          <Descriptions.Item label="Closed">{formatDate(capa.closedAt)}</Descriptions.Item>
          <Descriptions.Item label="Raised by">{capa.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="Created">{formatDate(capa.createdAt)}</Descriptions.Item>
        </Descriptions>
      </Card>

      {canEdit ? (
        <Card style={{ marginBottom: 16 }} styles={{ body: { display: 'flex', gap: 8, flexWrap: 'wrap' } }}>
          {capa.status === 'OPEN' && (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={acting}
              onClick={() => transition('start', 'Start', 'Begin work on this corrective action?')}
            >
              Start
            </Button>
          )}
          {capa.status === 'IN_PROGRESS' && (
            <Button
              type="primary"
              icon={<SafetyCertificateOutlined />}
              loading={acting}
              onClick={() =>
                transition(
                  'verify',
                  'Verify',
                  'Mark the action as verified? A root cause and corrective action must be recorded.'
                )
              }
            >
              Verify
            </Button>
          )}
          {capa.status === 'VERIFIED' && (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={acting}
              onClick={() =>
                transition('close', 'Close', 'Close this CAPA? Every linked NCR must be closed first.')
              }
            >
              Close
            </Button>
          )}
          {(capa.status === 'VERIFIED' || capa.status === 'CLOSED') && (
            <Button
              danger
              icon={<RedoOutlined />}
              loading={acting}
              onClick={() => transition('reopen', 'Reopen', 'Reopen this corrective action?')}
            >
              Reopen
            </Button>
          )}
        </Card>
      ) : (
        <ReadOnlyNotice>An engineer account is needed to act on this corrective action.</ReadOnlyNotice>
      )}

      {capa.status === 'IN_PROGRESS' && (!capa.rootCause || !capa.correctiveAction) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Record a root cause and a corrective action before verifying."
        />
      )}
      {capa.status === 'VERIFIED' && openNcrs.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Close these nonconformances before closing the CAPA: ${openNcrs
            .map((n) => n.ncrNumber)
            .join(', ')}`}
        />
      )}

      <Card title="Investigation" style={{ marginBottom: 16 }}>
        <Section title="Problem" hint="No problem statement recorded." value={capa.problem} />
        <Section
          title="Containment"
          hint="What was done immediately to limit the impact?"
          value={capa.containment}
        />
        <Section
          title="Root cause"
          hint="Why did it happen? Required before verification."
          value={capa.rootCause}
        />
        <Section
          title="Corrective action"
          hint="What fixes this occurrence? Required before verification."
          value={capa.correctiveAction}
        />
        <Section
          title="Preventive action"
          hint="What stops it happening again?"
          value={capa.preventiveAction}
        />
      </Card>

      <Card title={`Linked nonconformances (${capa.nonconformances.length})`}>
        {capa.nonconformances.length === 0 ? (
          <Typography.Text type="secondary">
            No nonconformances linked yet — link them from the NCR page.
          </Typography.Text>
        ) : (
          <Table<NcrSummary>
            size="middle"
            rowKey="id"
            columns={ncrColumns}
            dataSource={capa.nonconformances}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title="Edit corrective action"
        open={editOpen}
        onOk={() => void save()}
        okText="Save"
        confirmLoading={saving}
        onCancel={() => setEditOpen(false)}
        width={720}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true }, { max: 200 }]}>
            <Input />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="ownerId" label="Owner" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
            </Form.Item>
            <Form.Item name="dueDate" label="Due date" style={{ width: 190 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="problem" label="Problem" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="containment" label="Containment">
            <Input.TextArea rows={2} placeholder="Immediate action taken to limit impact" />
          </Form.Item>
          <Form.Item name="rootCause" label="Root cause">
            <Input.TextArea rows={2} placeholder="Why it happened" />
          </Form.Item>
          <Form.Item name="correctiveAction" label="Corrective action">
            <Input.TextArea rows={2} placeholder="What fixes this occurrence" />
          </Form.Item>
          <Form.Item name="preventiveAction" label="Preventive action">
            <Input.TextArea rows={2} placeholder="What prevents recurrence" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
