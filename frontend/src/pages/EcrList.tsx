import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
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
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { EcnPriority, EcrStatus, EcrSummary } from '../api/types';
import {
  ECN_PRIORITY_OPTIONS,
  ECR_STATUS_OPTIONS,
  EcnPriorityTag,
  EcrStatusTag,
  formatDate,
} from '../components/meta';

interface NewEcrValues {
  title: string;
  priority: EcnPriority;
  description?: string;
  partId?: number;
}

interface PartOption {
  id: number;
  partNumber: string;
  name: string;
}

export default function EcrList() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isViewer = user?.role === 'VIEWER';

  const [items, setItems] = useState<EcrSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EcrStatus | undefined>(undefined);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<NewEcrValues>();

  const [partOptions, setPartOptions] = useState<PartOption[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const partTimer = useRef<number | undefined>(undefined);

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listEcrs({
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

  useEffect(() => {
    return () => {
      window.clearTimeout(partTimer.current);
    };
  }, []);

  const fetchParts = useCallback(async (value: string) => {
    setPartLoading(true);
    try {
      const res = await api.listParts({ search: value || undefined, pageSize: 20 });
      setPartOptions(res.items);
    } catch {
      setPartOptions([]);
    } finally {
      setPartLoading(false);
    }
  }, []);

  const handlePartSearch = (value: string) => {
    window.clearTimeout(partTimer.current);
    partTimer.current = window.setTimeout(() => {
      void fetchParts(value);
    }, 300);
  };

  const openCreate = () => {
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ priority: 'MEDIUM' });
    void fetchParts('');
    setModalOpen(true);
  };

  const handleCreate = async () => {
    let values: NewEcrValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      const created = await api.createEcr({
        title: values.title.trim(),
        priority: values.priority,
        description: values.description?.trim() || undefined,
        partId: values.partId,
      });
      message.success(`${created.ecrNumber} created`);
      setModalOpen(false);
      navigate(`/ecrs/${created.id}`);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<EcrSummary> = [
    {
      title: 'ECR #',
      key: 'ecrNumber',
      width: 130,
      render: (_, ecr) => <Link to={`/ecrs/${ecr.id}`}>{ecr.ecrNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Priority',
      key: 'priority',
      width: 110,
      render: (_, ecr) => <EcnPriorityTag priority={ecr.priority} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, ecr) => <EcrStatusTag status={ecr.status} />,
    },
    {
      title: 'Part',
      key: 'part',
      width: 140,
      render: (_, ecr) =>
        ecr.part ? <Link to={`/parts/${ecr.part.id}`}>{ecr.part.partNumber}</Link> : '—',
    },
    {
      title: 'ECN',
      key: 'ecn',
      width: 130,
      render: (_, ecr) =>
        ecr.ecn ? <Link to={`/ecns/${ecr.ecn.id}`}>{ecr.ecn.ecnNumber}</Link> : '—',
    },
    {
      title: 'Created by',
      key: 'createdBy',
      width: 140,
      render: (_, ecr) => ecr.createdBy.name,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 150,
      render: (_, ecr) => formatDate(ecr.createdAt),
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
          Change Requests
        </Typography.Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New request
          </Button>
        )}
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
          options={ECR_STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </Space>

      <Table<EcrSummary>
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
          showTotal: (t) => `${t} requests`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <Modal
        title="New change request"
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
            <Input placeholder="What should change?" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Problem, proposed change, expected benefit…" />
          </Form.Item>
          <Form.Item name="priority" label="Priority" style={{ width: 180 }}>
            <Select options={ECN_PRIORITY_OPTIONS} />
          </Form.Item>
          <Form.Item name="partId" label="Related part (optional)">
            <Select
              showSearch
              allowClear
              placeholder="Search by part number or name"
              filterOption={false}
              onSearch={handlePartSearch}
              loading={partLoading}
              options={partOptions.map((p) => ({
                value: p.id,
                label: `${p.partNumber} — ${p.name}`,
              }))}
              notFoundContent={partLoading ? 'Searching…' : 'No parts found'}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
