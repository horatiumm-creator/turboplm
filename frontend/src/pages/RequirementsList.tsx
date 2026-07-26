import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  EcnPriority,
  RequirementMatrix,
  RequirementMatrixRow,
  RequirementStatus,
  RequirementSummary,
  RequirementType,
} from '../api/types';
import {
  ECN_PRIORITY_OPTIONS,
  EcnPriorityTag,
  REQ_STATUS_OPTIONS,
  REQ_TYPE_OPTIONS,
  ReqStatusTag,
  ReqTypeTag,
  formatDate,
} from '../components/meta';

interface NewRequirementValues {
  title: string;
  statement: string;
  type: RequirementType;
  priority: EcnPriority;
  parentId?: number;
  rationale?: string;
  acceptance?: string;
}

interface ReqOption {
  id: number;
  reqNumber: string;
  title: string;
}

export default function RequirementsList() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isViewer = user?.role === 'VIEWER';

  const [activeTab, setActiveTab] = useState('list');

  // ---- list tab state ----
  const [items, setItems] = useState<RequirementSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RequirementStatus | undefined>(undefined);
  const [type, setType] = useState<RequirementType | undefined>(undefined);

  // ---- matrix tab state ----
  const [matrix, setMatrix] = useState<RequirementMatrix | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);

  // ---- create modal state ----
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<NewRequirementValues>();

  const [parentOptions, setParentOptions] = useState<ReqOption[]>([]);
  const [parentLoading, setParentLoading] = useState(false);
  const parentTimer = useRef<number | undefined>(undefined);

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listRequirements({
        search: search || undefined,
        status,
        type,
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
  }, [search, status, type, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMatrix = useCallback(async () => {
    setMatrixLoading(true);
    try {
      setMatrix(await api.getRequirementMatrix());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setMatrixLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (activeTab === 'matrix') void loadMatrix();
  }, [activeTab, loadMatrix]);

  useEffect(() => {
    return () => {
      window.clearTimeout(parentTimer.current);
    };
  }, []);

  const fetchParents = useCallback(async (value: string) => {
    setParentLoading(true);
    try {
      const res = await api.listRequirements({ search: value || undefined, pageSize: 20 });
      setParentOptions(res.items);
    } catch {
      setParentOptions([]);
    } finally {
      setParentLoading(false);
    }
  }, []);

  const handleParentSearch = (value: string) => {
    window.clearTimeout(parentTimer.current);
    parentTimer.current = window.setTimeout(() => {
      void fetchParents(value);
    }, 300);
  };

  const openCreate = () => {
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ type: 'FUNCTIONAL', priority: 'MEDIUM' });
    void fetchParents('');
    setModalOpen(true);
  };

  const handleCreate = async () => {
    let values: NewRequirementValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      const created = await api.createRequirement({
        title: values.title.trim(),
        statement: values.statement.trim(),
        type: values.type,
        priority: values.priority,
        parentId: values.parentId,
        rationale: values.rationale?.trim() || undefined,
        acceptance: values.acceptance?.trim() || undefined,
      });
      message.success(`${created.reqNumber} created`);
      setModalOpen(false);
      navigate(`/requirements/${created.id}`);
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<RequirementSummary> = [
    {
      title: 'REQ #',
      key: 'reqNumber',
      width: 130,
      render: (_, req) => <Link to={`/requirements/${req.id}`}>{req.reqNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_, req) => <ReqTypeTag type={req.type} />,
    },
    {
      title: 'Priority',
      key: 'priority',
      width: 110,
      render: (_, req) => <EcnPriorityTag priority={req.priority} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, req) => <ReqStatusTag status={req.status} />,
    },
    {
      title: 'Links',
      key: 'links',
      width: 80,
      align: 'right',
      render: (_, req) => req.linkedParts + req.linkedDocuments,
    },
    {
      title: 'Children',
      key: 'children',
      width: 90,
      align: 'right',
      render: (_, req) => req.childCount,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 150,
      render: (_, req) => formatDate(req.createdAt),
    },
  ];

  const listTab = (
    <div>
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
          style={{ width: 150 }}
          options={REQ_STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <Select
          placeholder="Type"
          allowClear
          style={{ width: 160 }}
          options={REQ_TYPE_OPTIONS}
          value={type}
          onChange={(value) => {
            setType(value);
            setPage(1);
          }}
        />
      </Space>

      <Table<RequirementSummary>
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
          showTotal: (t) => `${t} requirements`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />
    </div>
  );

  const totals = matrix?.totals;
  const uncovered = totals?.uncovered ?? 0;

  const matrixColumns: ColumnsType<RequirementMatrixRow> = [
    {
      title: 'Requirement',
      key: 'requirement',
      ellipsis: true,
      render: (_, row) => (
        <Space size={8}>
          <Link to={`/requirements/${row.requirement.id}`}>{row.requirement.reqNumber}</Link>
          <Typography.Text type="secondary">{row.requirement.title}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) => <ReqStatusTag status={row.requirement.status} />,
    },
    {
      title: 'Satisfied by',
      key: 'parts',
      render: (_, row) =>
        row.parts.length > 0 ? (
          <Space size={8} wrap>
            {row.parts.map((p) => (
              <Link key={p.id} to={`/parts/${p.id}`}>
                {p.partNumber}
              </Link>
            ))}
          </Space>
        ) : (
          <Typography.Text type="danger">Not covered</Typography.Text>
        ),
    },
    {
      title: 'Documents',
      key: 'documents',
      width: 110,
      align: 'right',
      render: (_, row) => row.documents,
    },
  ];

  const matrixTab = (
    <div>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Requirements" value={totals?.total ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Approved" value={totals?.approved ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="Covered by parts"
              value={totals?.covered ?? 0}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="Uncovered"
              value={uncovered}
              valueStyle={uncovered > 0 ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Table<RequirementMatrixRow>
        size="middle"
        rowKey={(row) => row.requirement.id}
        columns={matrixColumns}
        dataSource={matrix?.rows ?? []}
        loading={matrixLoading}
        pagination={false}
        onRow={(row) =>
          row.parts.length === 0 ? { style: { background: '#fff1f0' } } : {}
        }
      />
    </div>
  );

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
          Requirements
        </Typography.Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New requirement
          </Button>
        )}
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'list', label: 'Requirements', children: listTab },
          { key: 'matrix', label: 'Traceability matrix', children: matrixTab },
        ]}
      />

      <Modal
        title="New requirement"
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
              { required: true, whitespace: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input placeholder="Short requirement title" />
          </Form.Item>
          <Form.Item
            name="statement"
            label="Statement"
            rules={[
              { required: true, whitespace: true, message: 'Statement is required' },
              { max: 4000, message: 'At most 4000 characters' },
            ]}
          >
            <Input.TextArea rows={4} placeholder="The system shall…" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="type" label="Type" style={{ width: 180 }}>
              <Select options={REQ_TYPE_OPTIONS} />
            </Form.Item>
            <Form.Item name="priority" label="Priority" style={{ width: 180 }}>
              <Select options={ECN_PRIORITY_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item name="parentId" label="Parent requirement (optional)">
            <Select
              showSearch
              allowClear
              placeholder="Search by REQ number or title"
              filterOption={false}
              onSearch={handleParentSearch}
              loading={parentLoading}
              options={parentOptions.map((r) => ({
                value: r.id,
                label: `${r.reqNumber} — ${r.title}`,
              }))}
              notFoundContent={parentLoading ? 'Searching…' : 'No requirements found'}
            />
          </Form.Item>
          <Form.Item name="rationale" label="Rationale">
            <Input.TextArea rows={2} placeholder="Why does this requirement exist? (optional)" />
          </Form.Item>
          <Form.Item name="acceptance" label="Acceptance criteria">
            <Input.TextArea rows={2} placeholder="How is this requirement verified? (optional)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
