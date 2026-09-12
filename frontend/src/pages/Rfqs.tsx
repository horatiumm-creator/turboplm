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
import type { RfqStatus, RfqSummary } from '../api/types';
import { formatDate, RFQ_STATUS_OPTIONS, RfqStatusTag } from '../components/meta';

interface RfqFormValues {
  title: string;
  description?: string;
  dueDate?: Dayjs | null;
}

export default function Rfqs() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [rfqs, setRfqs] = useState<RfqSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<RfqStatus | undefined>(undefined);
  const req = useRef(0);

  const load = useCallback(async () => {
    const id = ++req.current;
    setLoading(true);
    try {
      const res = await api.listRfqs({ status, page, pageSize });
      if (req.current !== id) return; // a newer request has superseded this one
      setRfqs(res.items);
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

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<RfqFormValues>();

  const save = async () => {
    let values: RfqFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createRfq({
        title: values.title.trim(),
        description: values.description?.trim() || undefined,
        dueDate: values.dueDate ? values.dueDate.toISOString() : undefined,
      });
      message.success(`${created.rfqNumber} created`);
      setOpen(false);
      navigate(`/rfqs/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<RfqSummary> = [
    {
      title: 'RFQ #',
      key: 'rfqNumber',
      width: 130,
      render: (_, r) => <Link to={`/rfqs/${r.id}`}>{r.rfqNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <RfqStatusTag status={r.status} />,
    },
    { title: 'Lines', dataIndex: 'lineCount', key: 'lineCount', width: 90, align: 'right' },
    { title: 'Quotes', dataIndex: 'quoteCount', key: 'quoteCount', width: 90, align: 'right' },
    { title: 'Raised by', key: 'createdBy', width: 150, render: (_, r) => r.createdBy.name },
    { title: 'Quotes due', key: 'dueDate', width: 130, render: (_, r) => formatDate(r.dueDate) },
    { title: 'Created', key: 'createdAt', width: 150, render: (_, r) => formatDate(r.createdAt) },
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
          Requests for quote
        </Typography.Title>
        <Space wrap>
          <Select
            placeholder="Status"
            allowClear
            style={{ width: 170 }}
            options={RFQ_STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          {canEdit && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setError(null);
                form.resetFields();
                setOpen(true);
              }}
            >
              New RFQ
            </Button>
          )}
        </Space>
      </div>

      <Table<RfqSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rfqs}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} requests`,
          onChange: (p, size) => {
            setPage(size !== pageSize ? 1 : p);
            setPageSize(size);
          },
        }}
      />

      <Modal
        title="New request for quote"
        open={open}
        onOk={() => void save()}
        okText="Create"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        forceRender
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[{ required: true, message: 'Title is required' }, { max: 200 }]}
          >
            <Input placeholder="Battery enclosure — 2026 volumes" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Scope, packaging, quality requirements" />
          </Form.Item>
          <Form.Item name="dueDate" label="Quotes due">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Typography.Text type="secondary">
            The RFQ starts as a draft — add lines, then send it to start collecting quotes.
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
