import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { TablePaginationConfig } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { Lifecycle, Paged, PartCategory, PartSummary } from '../api/types';
import { CATEGORY_OPTIONS, CategoryTag, formatDate, LIFECYCLE_OPTIONS, LifecycleTag } from '../components/meta';

interface NewPartValues {
  name: string;
  partNumber?: string;
  category: PartCategory;
  uom: string;
  description?: string;
}

export default function PartsList() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<NewPartValues>();

  const [data, setData] = useState<Paged<PartSummary> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<PartCategory | undefined>(undefined);
  const [lifecycle, setLifecycle] = useState<Lifecycle | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const fetchParts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listParts({
        search: search || undefined,
        category,
        lifecycle,
        page,
        pageSize,
      });
      setData(result);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [search, category, lifecycle, page, pageSize, message]);

  useEffect(() => {
    void fetchParts();
  }, [fetchParts]);

  const handleTableChange = (pagination: TablePaginationConfig) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 20);
  };

  const openModal = () => {
    setModalError(null);
    form.resetFields();
    setModalOpen(true);
  };

  const handleCreate = async (values: NewPartValues) => {
    setSubmitting(true);
    setModalError(null);
    try {
      const partNumber = values.partNumber?.trim();
      const description = values.description?.trim();
      const created = await api.createPart({
        name: values.name.trim(),
        partNumber: partNumber ? partNumber : undefined,
        category: values.category,
        uom: values.uom.trim() || 'ea',
        description: description ? description : undefined,
      });
      message.success(`Part ${created.partNumber} created`);
      setModalOpen(false);
      navigate(`/parts/${created.id}`);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<PartSummary> = [
    {
      title: 'Part Number',
      dataIndex: 'partNumber',
      key: 'partNumber',
      render: (_value, record) => <Link to={`/parts/${record.id}`}>{record.partNumber}</Link>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      render: (_value, record) => <CategoryTag category={record.category} />,
    },
    {
      title: 'Rev',
      key: 'rev',
      width: 70,
      render: (_value, record) => record.latestRevision?.revision ?? '—',
    },
    {
      title: 'State',
      key: 'state',
      render: (_value, record) =>
        record.latestRevision ? <LifecycleTag lifecycle={record.latestRevision.lifecycle} /> : '—',
    },
    {
      title: 'UoM',
      dataIndex: 'uom',
      key: 'uom',
      width: 80,
    },
    {
      title: 'Revisions',
      dataIndex: 'revisionCount',
      key: 'revisionCount',
      width: 100,
      align: 'right',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (_value, record) => formatDate(record.createdAt),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space
        style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}
        wrap
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Parts
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openModal}>
          New part
        </Button>
      </Space>

      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Input.Search
              placeholder="Search part number or name"
              allowClear
              style={{ width: 280 }}
              onSearch={(value) => {
                setSearch(value.trim());
                setPage(1);
              }}
            />
            <Select
              placeholder="Category"
              allowClear
              style={{ width: 180 }}
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={(value?: PartCategory) => {
                setCategory(value);
                setPage(1);
              }}
            />
            <Select
              placeholder="Lifecycle"
              allowClear
              style={{ width: 180 }}
              options={LIFECYCLE_OPTIONS}
              value={lifecycle}
              onChange={(value?: Lifecycle) => {
                setLifecycle(value);
                setPage(1);
              }}
            />
          </Space>

          <Table<PartSummary>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={data?.items ?? []}
            loading={loading}
            onChange={handleTableChange}
            pagination={{
              current: page,
              pageSize,
              total: data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => `${total} parts`,
            }}
          />
        </Space>
      </Card>

      <Modal
        title="New part"
        open={modalOpen}
        onOk={() => form.submit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        okText="Create"
      >
        <Form<NewPartValues>
          form={form}
          layout="vertical"
          initialValues={{ uom: 'ea' }}
          onFinish={handleCreate}
        >
          {modalError && (
            <Form.Item>
              <Alert type="error" showIcon message={modalError} />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Name is required' }]}
          >
            <Input placeholder="e.g. Motor Mount Bracket" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="partNumber"
            label="Part number"
            tooltip="leave empty to auto-generate"
            rules={[
              {
                pattern: /^[A-Za-z0-9._-]+$/,
                message: 'Only letters, digits, ".", "_" and "-" are allowed',
              },
              { max: 40, message: 'Max 40 characters' },
            ]}
          >
            <Input placeholder="Auto-generated if empty" />
          </Form.Item>
          <Form.Item
            name="category"
            label="Category"
            rules={[{ required: true, message: 'Category is required' }]}
          >
            <Select placeholder="Select a category" options={CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="uom"
            label="Unit of measure"
            rules={[{ required: true, message: 'Unit of measure is required' }]}
          >
            <Input placeholder="ea" maxLength={20} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Optional description" maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
