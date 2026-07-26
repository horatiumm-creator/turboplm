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
import type { EcnPriority, EcnStatus, EcnSummary } from '../api/types';
import {
  ECN_PRIORITY_OPTIONS,
  ECN_STATUS_OPTIONS,
  EcnPriorityTag,
  EcnStatusTag,
  formatDate,
} from '../components/meta';

interface NewEcnValues {
  title: string;
  priority: EcnPriority;
  reason?: string;
  description?: string;
  effectivityDate?: Dayjs | null;
}

export default function EcnList() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();

  const [items, setItems] = useState<EcnSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EcnStatus | undefined>(undefined);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<NewEcnValues>();

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listEcns({
        search: search || undefined,
        status,
        page,
        pageSize,
      });
      // Drop stale responses: an older request must not overwrite a newer one.
      if (requestRef.current !== requestId) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (requestRef.current === requestId) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [search, status, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ priority: 'MEDIUM' });
    setModalOpen(true);
  };

  const handleCreate = async () => {
    let values: NewEcnValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      const created = await api.createEcn({
        title: values.title.trim(),
        priority: values.priority,
        reason: values.reason?.trim() || undefined,
        description: values.description?.trim() || undefined,
        effectivityDate: values.effectivityDate ? values.effectivityDate.toISOString() : undefined,
      });
      message.success(`${created.ecnNumber} created`);
      setModalOpen(false);
      navigate(`/ecns/${created.id}`);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<EcnSummary> = [
    {
      title: 'ECN #',
      key: 'ecnNumber',
      width: 130,
      render: (_, ecn) => <Link to={`/ecns/${ecn.id}`}>{ecn.ecnNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Priority',
      key: 'priority',
      width: 110,
      render: (_, ecn) => <EcnPriorityTag priority={ecn.priority} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, ecn) => <EcnStatusTag status={ecn.status} />,
    },
    {
      title: 'Affected parts',
      dataIndex: 'itemCount',
      key: 'itemCount',
      width: 120,
      align: 'right',
    },
    {
      title: 'Effectivity',
      key: 'effectivity',
      width: 150,
      render: (_, ecn) => formatDate(ecn.effectivityDate),
    },
    {
      title: 'Created by',
      key: 'createdBy',
      width: 140,
      render: (_, ecn) => ecn.createdBy.name,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 150,
      render: (_, ecn) => formatDate(ecn.createdAt),
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
          Engineering Changes
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          New ECN
        </Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Search number or title"
          allowClear
          style={{ width: 280 }}
          onSearch={(value) => {
            setSearch(value.trim());
            setPage(1);
          }}
        />
        <Select
          placeholder="Status"
          allowClear
          style={{ width: 160 }}
          options={ECN_STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </Space>

      <Table<EcnSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} changes`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <Modal
        title="New engineering change"
        open={modalOpen}
        onOk={() => void handleCreate()}
        okText="Create"
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[
              { required: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input placeholder="What is changing?" />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="priority" label="Priority" style={{ width: 180 }}>
              <Select options={ECN_PRIORITY_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="effectivityDate"
              label="Effectivity date"
              tooltip="When the change takes effect in manufacturing; defaults to the release date."
              style={{ flex: 1 }}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="reason" label="Reason for change">
            <Input.TextArea rows={2} placeholder="Root cause, customer request, cost down…" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Summary of the change" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
