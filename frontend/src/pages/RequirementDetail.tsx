import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  LinkOutlined,
  StopOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  EcnPriority,
  RequirementDetail as RequirementDetailDto,
  RequirementLinkDetail,
  RequirementSummary,
  RequirementType,
} from '../api/types';
import {
  ECN_PRIORITY_OPTIONS,
  EcnPriorityTag,
  REQ_TYPE_OPTIONS,
  ReqStatusTag,
  ReqTypeTag,
  formatDate,
} from '../components/meta';

interface EditFormValues {
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

interface PartOption {
  id: number;
  partNumber: string;
  name: string;
}

interface DocOption {
  id: number;
  docNumber: string;
  title: string;
}

export default function RequirementDetail() {
  const { id: idParam } = useParams();
  const reqId = Number(idParam);
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [req, setReq] = useState<RequirementDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();
  const [parentOptions, setParentOptions] = useState<ReqOption[]>([]);
  const [parentLoading, setParentLoading] = useState(false);
  const parentTimer = useRef<number | undefined>(undefined);

  // Link pickers
  const [addPartId, setAddPartId] = useState<number | undefined>(undefined);
  const [linkingPart, setLinkingPart] = useState(false);
  const [partOptions, setPartOptions] = useState<PartOption[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const partTimer = useRef<number | undefined>(undefined);

  const [addDocId, setAddDocId] = useState<number | undefined>(undefined);
  const [linkingDoc, setLinkingDoc] = useState(false);
  const [docOptions, setDocOptions] = useState<DocOption[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const docTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (!Number.isInteger(reqId) || reqId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const detail = await api.getRequirement(reqId);
      setReq(detail);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [reqId, message]);

  useEffect(() => {
    setReq(null);
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(parentTimer.current);
      window.clearTimeout(partTimer.current);
      window.clearTimeout(docTimer.current);
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

  const fetchDocs = useCallback(async (value: string) => {
    setDocLoading(true);
    try {
      const res = await api.listDocuments({ search: value || undefined, pageSize: 20 });
      setDocOptions(res.items);
    } catch {
      setDocOptions([]);
    } finally {
      setDocLoading(false);
    }
  }, []);

  const handleDocSearch = (value: string) => {
    window.clearTimeout(docTimer.current);
    docTimer.current = window.setTimeout(() => {
      void fetchDocs(value);
    }, 300);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !req) {
    return (
      <Empty description="Requirement not found">
        <Link to="/requirements">Back to requirements</Link>
      </Empty>
    );
  }

  const isViewer = user?.role === 'VIEWER';
  const isDraft = req.status === 'DRAFT';

  const openEdit = () => {
    setEditError(null);
    setParentOptions(req.parent ? [req.parent] : []);
    editForm.setFieldsValue({
      title: req.title,
      statement: req.statement,
      type: req.type,
      priority: req.priority,
      parentId: req.parent?.id,
      rationale: req.rationale ?? undefined,
      acceptance: req.acceptance ?? undefined,
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    let values: EditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await api.updateRequirement(req.id, {
        title: values.title.trim(),
        statement: values.statement.trim(),
        type: values.type,
        priority: values.priority,
        parentId: values.parentId ?? null,
        rationale: values.rationale?.trim() ? values.rationale.trim() : null,
        acceptance: values.acceptance?.trim() ? values.acceptance.trim() : null,
      });
      setReq(updated);
      setEditOpen(false);
      message.success('Requirement updated');
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  const approve = () => {
    modal.confirm({
      title: 'Approve requirement',
      content: `Approve ${req.reqNumber}? Approved requirements can no longer be edited.`,
      okText: 'Approve',
      onOk: async () => {
        try {
          const updated = await api.transitionRequirement(req.id, 'approve');
          setReq(updated);
          message.success('Requirement approved');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
          await load();
        }
      },
    });
  };

  const obsolete = () => {
    modal.confirm({
      title: 'Mark as obsolete',
      content: `Mark ${req.reqNumber} as obsolete? It is kept for traceability but should no longer be implemented.`,
      okText: 'Mark obsolete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const updated = await api.transitionRequirement(req.id, 'obsolete');
          setReq(updated);
          message.success('Requirement marked obsolete');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
          await load();
        }
      },
    });
  };

  const remove = () => {
    modal.confirm({
      title: 'Delete requirement',
      content: `Delete ${req.reqNumber} — ${req.title}? Only draft requirements without children can be deleted.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteRequirement(req.id);
          message.success(`${req.reqNumber} deleted`);
          navigate('/requirements');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const linkPart = async () => {
    if (addPartId === undefined) return;
    setLinkingPart(true);
    try {
      const updated = await api.addRequirementLink(req.id, { partId: addPartId });
      setReq(updated);
      setAddPartId(undefined);
      message.success('Part linked');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLinkingPart(false);
    }
  };

  const linkDoc = async () => {
    if (addDocId === undefined) return;
    setLinkingDoc(true);
    try {
      const updated = await api.addRequirementLink(req.id, { documentId: addDocId });
      setReq(updated);
      setAddDocId(undefined);
      message.success('Document linked');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLinkingDoc(false);
    }
  };

  const unlink = (link: RequirementLinkDetail) => {
    const label = link.part
      ? `${link.part.partNumber} — ${link.part.name}`
      : link.document
        ? `${link.document.docNumber} — ${link.document.title}`
        : 'this link';
    modal.confirm({
      title: 'Remove link',
      content: `Remove ${label} from this requirement?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.removeRequirementLink(link.id);
          message.success('Link removed');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const childColumns: ColumnsType<RequirementSummary> = [
    {
      title: 'REQ #',
      key: 'reqNumber',
      width: 140,
      render: (_, child) => <Link to={`/requirements/${child.id}`}>{child.reqNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_, child) => <ReqTypeTag type={child.type} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, child) => <ReqStatusTag status={child.status} />,
    },
  ];

  const linkColumns: ColumnsType<RequirementLinkDetail> = [
    {
      title: 'Type',
      key: 'type',
      width: 120,
      render: (_, link) =>
        link.part ? <Tag color="geekblue">Part</Tag> : <Tag color="purple">Document</Tag>,
    },
    {
      title: 'Target',
      key: 'target',
      ellipsis: true,
      render: (_, link) =>
        link.part ? (
          <Link to={`/parts/${link.part.id}`}>
            {link.part.partNumber} — {link.part.name}
          </Link>
        ) : link.document ? (
          <Link to={`/documents/${link.document.id}`}>
            {link.document.docNumber} — {link.document.title}
          </Link>
        ) : (
          '—'
        ),
    },
  ];
  if (!isViewer) {
    linkColumns.push({
      title: 'Actions',
      key: 'actions',
      width: 110,
      render: (_, link) => (
        <Button
          type="link"
          size="small"
          danger
          icon={<DisconnectOutlined />}
          onClick={() => unlink(link)}
        >
          Unlink
        </Button>
      ),
    });
  }

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space direction="vertical" size={4}>
            <Space size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {req.reqNumber} — {req.title}
              </Typography.Title>
              <ReqStatusTag status={req.status} />
              <ReqTypeTag type={req.type} />
              <EcnPriorityTag priority={req.priority} />
            </Space>
            <Typography.Text type="secondary">Requirement</Typography.Text>
          </Space>
          {!isViewer && (
            <Space wrap>
              {isDraft && (
                <Button icon={<EditOutlined />} onClick={openEdit}>
                  Edit
                </Button>
              )}
              {isDraft && (
                <Button type="primary" icon={<CheckOutlined />} onClick={approve}>
                  Approve
                </Button>
              )}
              {req.status === 'APPROVED' && (
                <Button danger icon={<StopOutlined />} onClick={obsolete}>
                  Mark obsolete
                </Button>
              )}
              {isDraft && (
                <Button danger icon={<DeleteOutlined />} onClick={remove}>
                  Delete
                </Button>
              )}
            </Space>
          )}
        </div>
        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Created by">{req.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="Created">{formatDate(req.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="Parent requirement">
            {req.parent ? (
              <Link to={`/requirements/${req.parent.id}`}>
                {req.parent.reqNumber} — {req.parent.title}
              </Link>
            ) : (
              '—'
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="Definition" style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="middle">
          <Descriptions.Item label="Statement">
            <span style={{ whiteSpace: 'pre-wrap' }}>{req.statement}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Rationale">
            {req.rationale ? <span style={{ whiteSpace: 'pre-wrap' }}>{req.rationale}</span> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Acceptance criteria">
            {req.acceptance ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>{req.acceptance}</span>
            ) : (
              '—'
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="Child requirements" style={{ marginBottom: 16 }}>
        {req.children.length === 0 ? (
          <Typography.Text type="secondary">No child requirements.</Typography.Text>
        ) : (
          <Table<RequirementSummary>
            size="middle"
            rowKey="id"
            columns={childColumns}
            dataSource={req.children}
            pagination={false}
          />
        )}
      </Card>

      <Card title="Linked parts & documents">
        {!isViewer && (
          <Space wrap style={{ marginBottom: 16 }}>
            <Select
              showSearch
              allowClear
              placeholder="Search parts to link"
              style={{ width: 280 }}
              value={addPartId}
              onChange={(value?: number) => setAddPartId(value)}
              filterOption={false}
              onSearch={handlePartSearch}
              onFocus={() => {
                if (partOptions.length === 0) void fetchParts('');
              }}
              loading={partLoading}
              options={partOptions.map((p) => ({
                value: p.id,
                label: `${p.partNumber} — ${p.name}`,
              }))}
              notFoundContent={partLoading ? 'Searching…' : 'No parts found'}
            />
            <Button
              icon={<LinkOutlined />}
              disabled={addPartId === undefined}
              loading={linkingPart}
              onClick={() => void linkPart()}
            >
              Link part
            </Button>
            <Select
              showSearch
              allowClear
              placeholder="Search documents to link"
              style={{ width: 280 }}
              value={addDocId}
              onChange={(value?: number) => setAddDocId(value)}
              filterOption={false}
              onSearch={handleDocSearch}
              onFocus={() => {
                if (docOptions.length === 0) void fetchDocs('');
              }}
              loading={docLoading}
              options={docOptions.map((d) => ({
                value: d.id,
                label: `${d.docNumber} — ${d.title}`,
              }))}
              notFoundContent={docLoading ? 'Searching…' : 'No documents found'}
            />
            <Button
              icon={<LinkOutlined />}
              disabled={addDocId === undefined}
              loading={linkingDoc}
              onClick={() => void linkDoc()}
            >
              Link document
            </Button>
          </Space>
        )}
        {req.links.length === 0 ? (
          <Typography.Text type="secondary">
            No parts or documents linked to this requirement yet.
          </Typography.Text>
        ) : (
          <Table<RequirementLinkDetail>
            size="middle"
            rowKey="id"
            columns={linkColumns}
            dataSource={req.links}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title="Edit requirement"
        open={editOpen}
        onOk={() => void saveEdit()}
        okText="Save"
        confirmLoading={editSaving}
        onCancel={() => setEditOpen(false)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[
              { required: true, whitespace: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="statement"
            label="Statement"
            rules={[
              { required: true, whitespace: true, message: 'Statement is required' },
              { max: 4000, message: 'At most 4000 characters' },
            ]}
          >
            <Input.TextArea rows={4} />
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
              options={parentOptions
                .filter((r) => r.id !== req.id)
                .map((r) => ({ value: r.id, label: `${r.reqNumber} — ${r.title}` }))}
              notFoundContent={parentLoading ? 'Searching…' : 'No requirements found'}
            />
          </Form.Item>
          <Form.Item name="rationale" label="Rationale">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="acceptance" label="Acceptance criteria">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
