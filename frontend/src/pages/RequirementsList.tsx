import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
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
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  EcnPriority,
  ReqifImportResult,
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
import { Hint } from '../components/Hint';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';

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

  // ---- ReqIF import modal state ----
  // The result is held rather than announced in a toast: `unknownAttributesDropped` is a number the
  // reader may need to act on (go back to the source tool, or ask for those fields to be added
  // here), and a toast that disappears after three seconds is not where you put that.
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ReqifImportResult | null>(null);

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

  const openImport = () => {
    setImportFile(null);
    setImportError(null);
    setImportResult(null);
    setImportOpen(true);
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await api.importRequirementsReqif(importFile);
      setImportResult(result);
      // Refresh behind the modal, so closing it does not reveal a stale table. The matrix is
      // only refetched when it is the visible tab; the tab switch refetches it anyway.
      await load();
      if (activeTab === 'matrix') await loadMatrix();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setImporting(false);
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
        onRow={(row) => (row.parts.length === 0 ? { className: 'req-uncovered' } : {})}
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
        <Space size={8}>
          <span>
            <Button icon={<DownloadOutlined />} href={api.requirementsReqifExportUrl}>
              Export ReqIF
            </Button>
            {/*
              The scope of the export is not what the screen implies. Someone who has narrowed
              the list to four safety requirements and then clicks Export gets the whole set,
              and would have no way to tell from the file that the filters were ignored.
            */}
            <Hint title="What gets exported">
              Every requirement you have access to, as a ReqIF file for exchange with other
              requirements tools. The search and filters above do not narrow it.
            </Hint>
          </span>
          {/* Import writes; a Viewer does not get the button, as everywhere else in the app. */}
          {!isViewer && (
            <Button icon={<UploadOutlined />} onClick={openImport}>
              Import ReqIF
            </Button>
          )}
          {!isViewer && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New requirement
            </Button>
          )}
        </Space>
      </div>

      {isViewer && (
        <ReadOnlyNotice>
          You can read requirements and export them, but not create or import them. An engineer or
          administrator account can.
        </ReadOnlyNotice>
      )}

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

      <Modal
        title="Import ReqIF"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        // Custom footer because this modal has two states. Before the import it needs a Cancel
        // and a submit that is disabled until a file is chosen; after it, the result is the
        // point of the dialog and there is nothing left to confirm — only to read and dismiss.
        footer={
          importResult ? (
            <Button type="primary" onClick={() => setImportOpen(false)}>
              Close
            </Button>
          ) : (
            <Space>
              <Button onClick={() => setImportOpen(false)}>Cancel</Button>
              <Button
                type="primary"
                loading={importing}
                disabled={!importFile}
                onClick={() => void handleImport()}
              >
                Import
              </Button>
            </Space>
          )
        }
      >
        {importError && (
          <Alert type="error" showIcon message={importError} style={{ marginBottom: 16 }} />
        )}

        {importResult ? (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Created">{importResult.created}</Descriptions.Item>
              <Descriptions.Item label="Updated">{importResult.updated}</Descriptions.Item>
              <Descriptions.Item label="Skipped">{importResult.skipped}</Descriptions.Item>
              <Descriptions.Item label="Attributes dropped">
                {importResult.unknownAttributesDropped}
              </Descriptions.Item>
              {/*
                Shown for the same reason as the attribute count, and it is the easier one to
                miss: every requirement in the file can import cleanly while every link in it is
                discarded, which reads as complete success unless the number is on screen.
              */}
              <Descriptions.Item label="Links ignored">
                {importResult.linksIgnored}
              </Descriptions.Item>
            </Descriptions>

            {/*
              Visible, not behind a hint. Dropped attributes are data the customer had before
              the import and does not have after it, and the only person who can decide whether
              that matters is the one reading this — after which this number is gone for good.
              A count of zero is worth stating too: it is the difference between "nothing was
              lost" and "nobody checked".
            */}
            {importResult.unknownAttributesDropped > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`${importResult.unknownAttributesDropped} attribute value${
                  importResult.unknownAttributesDropped === 1 ? ' was' : 's were'
                } discarded`}
                description="The file carries attributes this system has no field for, so their values were not stored. The requirements themselves imported; those extra fields did not come with them. Keep the original file if you need them."
              />
            ) : (
              <Typography.Text type="secondary">
                Every attribute in the file had somewhere to go — nothing was discarded.
              </Typography.Text>
            )}
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary">
              One ReqIF file exported from your requirements tool. Requirements it matches to
              existing ones are updated and the rest are created; you will see the counts here
              when it finishes.
            </Typography.Paragraph>
            <Space size={12} wrap>
              <Upload
                accept=".reqif,.xml"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(file) => {
                  setImportFile(file);
                  setImportError(null);
                  return false; // the POST is ours; antd must not auto-upload
                }}
              >
                <Button icon={<UploadOutlined />}>
                  {importFile ? 'Choose a different file' : 'Choose file'}
                </Button>
              </Upload>
              {importFile && <Typography.Text>{importFile.name}</Typography.Text>}
            </Space>
          </>
        )}
      </Modal>
    </div>
  );
}
