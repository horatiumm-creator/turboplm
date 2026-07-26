import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type {
  PartCategory,
  PartDetail as PartDetailDto,
  RevisionDetail,
  RevisionSummary,
  TransitionAction,
} from '../api/types';
import {
  CategoryTag,
  CATEGORY_OPTIONS,
  ECN_STATUS_META,
  formatDate,
  LifecycleTag,
  LIFECYCLE_META,
} from '../components/meta';
import BomTab from '../components/part/BomTab';
import WhereUsedTab from '../components/part/WhereUsedTab';
import ProcessTab from '../components/part/ProcessTab';
import OptionsTab from '../components/part/OptionsTab';
import SourcingTab from '../components/part/SourcingTab';
import CostTab from '../components/part/CostTab';
import RequirementsTab from '../components/part/RequirementsTab';
import AttributesPanel from '../components/part/AttributesPanel';
import DocumentsCard from '../components/DocumentsCard';
import { useAuth } from '../auth/AuthContext';

interface EditPartFormValues {
  name: string;
  description?: string;
  category: PartCategory;
  uom: string;
}

export default function PartDetailPage() {
  const params = useParams<{ id: string }>();
  const partId = Number(params.id);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [part, setPart] = useState<PartDetailDto | null>(null);
  const [partLoading, setPartLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [revision, setRevision] = useState<RevisionDetail | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<EditPartFormValues>();

  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);

  // ---- data loading -------------------------------------------------------

  const fetchPart = useCallback(async () => {
    try {
      setPart(await api.getPart(partId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }, [partId]);

  useEffect(() => {
    setPart(null);
    setRevision(null);
    if (!Number.isFinite(partId)) {
      setLoadError('Invalid part id');
      setPartLoading(false);
      return;
    }
    setPartLoading(true);
    void fetchPart().finally(() => setPartLoading(false));
  }, [partId, fetchPart]);

  const revParam = searchParams.get('rev');
  const selectedRevId = useMemo(() => {
    if (!part) return undefined;
    const parsed = revParam !== null ? Number(revParam) : NaN;
    if (Number.isFinite(parsed) && part.revisions.some((r) => r.id === parsed)) {
      return parsed;
    }
    return part.revisions[0]?.id;
  }, [part, revParam]);

  const revRequestRef = useRef(0);
  const refetchRevision = useCallback(async () => {
    if (selectedRevId === undefined) return;
    const requestId = ++revRequestRef.current;
    try {
      const loaded = await api.getRevision(selectedRevId);
      // Drop stale responses: an older load must not overwrite a newer one.
      if (revRequestRef.current === requestId) setRevision(loaded);
    } catch (err) {
      if (revRequestRef.current === requestId) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    }
  }, [selectedRevId, message]);

  useEffect(() => {
    if (selectedRevId === undefined) return;
    setRevisionLoading(true);
    void refetchRevision().finally(() => setRevisionLoading(false));
  }, [selectedRevId, refetchRevision]);

  useEffect(() => {
    setNoteDraft(revision?.changeNote ?? '');
  }, [revision?.id, revision?.changeNote]);

  const handleChanged = useCallback(() => {
    void refetchRevision();
    void fetchPart();
  }, [refetchRevision, fetchPart]);

  // ---- helpers ------------------------------------------------------------

  const showError = useCallback(
    (err: unknown, title: string) => {
      if (err instanceof ApiError && err.status === 409) {
        modal.error({ title, content: err.message });
      } else {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    },
    [modal, message]
  );

  const selectRevision = useCallback(
    (revId: number) => {
      setSearchParams({ rev: String(revId) });
    },
    [setSearchParams]
  );

  // ---- part actions -------------------------------------------------------

  const openEdit = () => {
    if (!part) return;
    editForm.setFieldsValue({
      name: part.name,
      description: part.description ?? '',
      category: part.category,
      uom: part.uom,
    });
    setEditOpen(true);
  };

  const handleEditOk = async () => {
    if (!part) return;
    let values: EditPartFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return; // antd highlights invalid fields
    }
    setEditSaving(true);
    try {
      await api.updatePart(part.id, {
        name: values.name,
        description: values.description ?? '',
        category: values.category,
        uom: values.uom,
      });
      message.success('Part updated');
      setEditOpen(false);
      await fetchPart();
    } catch (err) {
      showError(err, 'Cannot update part');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = () => {
    if (!part) return;
    modal.confirm({
      title: 'Delete part',
      content: `Delete ${part.partNumber} — ${part.name}? All revisions, BOM lines and process plans of this part will be removed.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deletePart(part.id);
          message.success('Part deleted');
          navigate('/parts');
        } catch (err) {
          showError(err, 'Cannot delete part');
        }
      },
    });
  };

  // ---- revision actions ---------------------------------------------------

  const doTransition = (
    action: TransitionAction,
    opts: { title: string; content: string; okText: string; success: string; danger?: boolean }
  ) => {
    if (!revision) return;
    const revId = revision.id;
    modal.confirm({
      title: opts.title,
      content: opts.content,
      okText: opts.okText,
      okButtonProps: opts.danger ? { danger: true } : undefined,
      onOk: async () => {
        try {
          await api.transitionRevision(revId, action);
          message.success(opts.success);
          await Promise.all([fetchPart(), refetchRevision()]);
        } catch (err) {
          showError(err, opts.title);
        }
      },
    });
  };

  const handleNewRevision = () => {
    if (!part) return;
    modal.confirm({
      title: 'Create new revision',
      content: `Create the next revision of ${part.partNumber}? The BOM and process plan of the previous revision will be copied.`,
      okText: 'Create',
      onOk: async () => {
        try {
          const newRev = await api.createRevision(part.id);
          message.success(`Revision ${newRev.revision} created`);
          await fetchPart();
          setSearchParams({ rev: String(newRev.id) });
        } catch (err) {
          showError(err, 'Cannot create revision');
        }
      },
    });
  };

  const saveChangeNote = async () => {
    if (!revision) return;
    setNoteSaving(true);
    try {
      await api.updateRevision(revision.id, {
        changeNote: noteDraft.trim() === '' ? null : noteDraft,
      });
      message.success('Change note saved');
      await refetchRevision();
    } catch (err) {
      showError(err, 'Cannot save change note');
    } finally {
      setNoteSaving(false);
    }
  };

  // ---- render -------------------------------------------------------------

  if (partLoading && !part) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }

  if (!part) {
    return (
      <Result
        status="warning"
        title="Could not load part"
        subTitle={loadError ?? 'Something went wrong'}
        extra={
          <Button type="primary" onClick={() => navigate('/parts')}>
            Back to parts
          </Button>
        }
      />
    );
  }

  const revisionOptions = part.revisions.map((r) => ({
    value: r.id,
    label: `Rev ${r.revision} — ${LIFECYCLE_META[r.lifecycle].label}`,
  }));

  const managedByActiveEcn =
    revision?.ecn != null &&
    (revision.ecn.status === 'DRAFT' ||
      revision.ecn.status === 'IN_REVIEW' ||
      revision.ecn.status === 'APPROVED');

  const historyColumns: ColumnsType<RevisionSummary> = [
    {
      title: 'Rev',
      dataIndex: 'revision',
      key: 'revision',
      render: (_, r) => (
        <Space size={8}>
          <Typography.Link onClick={() => selectRevision(r.id)}>Rev {r.revision}</Typography.Link>
          {r.id === selectedRevId && <Tag color="processing">Viewing</Tag>}
        </Space>
      ),
    },
    {
      title: 'Lifecycle',
      dataIndex: 'lifecycle',
      key: 'lifecycle',
      render: (_, r) => <LifecycleTag lifecycle={r.lifecycle} />,
    },
    {
      title: 'Change note',
      dataIndex: 'changeNote',
      key: 'changeNote',
      ellipsis: true,
      render: (_, r) => r.changeNote || '—',
    },
    {
      title: 'Created by',
      dataIndex: 'createdBy',
      key: 'createdBy',
      render: (_, r) => r.createdBy.name,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (_, r) => formatDate(r.createdAt),
    },
    {
      title: 'Released',
      dataIndex: 'releasedAt',
      key: 'releasedAt',
      render: (_, r) => formatDate(r.releasedAt),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <Space align="center" size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {part.partNumber} — {part.name}
              </Typography.Title>
              <CategoryTag category={part.category} />
            </Space>
            {canEdit && (
              <Space>
                <Button icon={<EditOutlined />} onClick={openEdit}>
                  Edit
                </Button>
                <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>
                  Delete
                </Button>
              </Space>
            )}
          </div>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
            <Descriptions.Item label="Unit of measure">{part.uom}</Descriptions.Item>
            <Descriptions.Item label="Description">{part.description || '—'}</Descriptions.Item>
            <Descriptions.Item label="Created by">{part.createdBy.name}</Descriptions.Item>
            <Descriptions.Item label="Created">{formatDate(part.createdAt)}</Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Card>
        {revision && managedByActiveEcn && revision.ecn && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <span>
                This revision is managed by{' '}
                <Link to={`/ecns/${revision.ecn.id}`}>{revision.ecn.ecnNumber}</Link> (
                {ECN_STATUS_META[revision.ecn.status].label}) — progress the change through the
                ECN.
              </span>
            }
          />
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <Space wrap>
            <Typography.Text strong>Revision</Typography.Text>
            <Select
              value={selectedRevId}
              options={revisionOptions}
              onChange={selectRevision}
              style={{ minWidth: 220 }}
              loading={revisionLoading}
            />
            {revision && <LifecycleTag lifecycle={revision.lifecycle} />}
            {revision?.releasedAt && (
              <Typography.Text type="secondary">
                Released {formatDate(revision.releasedAt)}
              </Typography.Text>
            )}
          </Space>
          {revision && canEdit && (
            <Space wrap>
              {!managedByActiveEcn && revision.lifecycle === 'IN_WORK' && (
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() =>
                    doTransition('submit', {
                      title: 'Submit for review',
                      content: `Submit revision ${revision.revision} of ${part.partNumber} for review?`,
                      okText: 'Submit',
                      success: `Revision ${revision.revision} submitted for review`,
                    })
                  }
                >
                  Submit for review
                </Button>
              )}
              {!managedByActiveEcn && revision.lifecycle === 'IN_REVIEW' && (
                <>
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    onClick={() =>
                      doTransition('approve', {
                        title: 'Approve & release',
                        content: `Release revision ${revision.revision} of ${part.partNumber}? Released revisions can no longer be edited.`,
                        okText: 'Approve & release',
                        success: `Revision ${revision.revision} released`,
                      })
                    }
                  >
                    Approve & release
                  </Button>
                  <Button
                    danger
                    icon={<CloseCircleOutlined />}
                    onClick={() =>
                      doTransition('reject', {
                        title: 'Reject revision',
                        content: `Reject revision ${revision.revision} of ${part.partNumber} and send it back to In Work?`,
                        okText: 'Reject',
                        success: `Revision ${revision.revision} sent back to In Work`,
                        danger: true,
                      })
                    }
                  >
                    Reject
                  </Button>
                </>
              )}
              {!managedByActiveEcn && revision.lifecycle === 'RELEASED' && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() =>
                    doTransition('obsolete', {
                      title: 'Mark obsolete',
                      content: `Mark revision ${revision.revision} of ${part.partNumber} as obsolete?`,
                      okText: 'Mark obsolete',
                      success: `Revision ${revision.revision} marked obsolete`,
                      danger: true,
                    })
                  }
                >
                  Mark obsolete
                </Button>
              )}
              {(part.revisions[0]?.lifecycle === 'RELEASED' ||
                part.revisions[0]?.lifecycle === 'OBSOLETE') && (
                <Button type="primary" icon={<PlusOutlined />} onClick={handleNewRevision}>
                  New revision
                </Button>
              )}
            </Space>
          )}
        </div>

        <Spin spinning={revisionLoading}>
          {revision ? (
            <Tabs
              defaultActiveKey="overview"
              destroyInactiveTabPane
              items={[
                {
                  key: 'overview',
                  label: 'Overview',
                  children: (
                    <Descriptions bordered size="middle" column={{ xs: 1, sm: 2 }}>
                      <Descriptions.Item label="Revision">Rev {revision.revision}</Descriptions.Item>
                      <Descriptions.Item label="Lifecycle">
                        <LifecycleTag lifecycle={revision.lifecycle} />
                      </Descriptions.Item>
                      <Descriptions.Item label="BOM lines">
                        {revision.bomLineCount}
                      </Descriptions.Item>
                      <Descriptions.Item label="Process plan">
                        {revision.hasProcessPlan ? 'Yes' : 'No'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Created by">
                        {revision.createdBy.name}
                      </Descriptions.Item>
                      <Descriptions.Item label="Created">
                        {formatDate(revision.createdAt)}
                      </Descriptions.Item>
                      <Descriptions.Item label="Released">
                        {formatDate(revision.releasedAt)}
                      </Descriptions.Item>
                      {revision.ecn && (
                        <Descriptions.Item label="ECN">
                          <Link to={`/ecns/${revision.ecn.id}`}>{revision.ecn.ecnNumber}</Link>{' '}
                          ({ECN_STATUS_META[revision.ecn.status].label})
                        </Descriptions.Item>
                      )}
                      <Descriptions.Item label="Change note" span={2}>
                        {canEdit && revision.lifecycle === 'IN_WORK' ? (
                          <Space direction="vertical" style={{ width: '100%' }}>
                            <Input.TextArea
                              rows={3}
                              value={noteDraft}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              placeholder="Describe what changed in this revision"
                            />
                            <Button
                              type="primary"
                              size="small"
                              loading={noteSaving}
                              disabled={noteDraft === (revision.changeNote ?? '')}
                              onClick={() => void saveChangeNote()}
                            >
                              Save change note
                            </Button>
                          </Space>
                        ) : (
                          revision.changeNote || '—'
                        )}
                      </Descriptions.Item>
                    </Descriptions>
                  ),
                },
                ...(part.attributes.length > 0 || user?.role === 'ADMIN'
                  ? [
                      {
                        key: 'attributes',
                        label: 'Attributes',
                        children: (
                          <AttributesPanel part={part} onChanged={() => void fetchPart()} />
                        ),
                      },
                    ]
                  : []),
                {
                  key: 'bom',
                  label: 'Bill of Materials',
                  children: (
                    <BomTab
                      revision={revision}
                      editable={canEdit && revision.lifecycle === 'IN_WORK'}
                      onChanged={handleChanged}
                    />
                  ),
                },
                {
                  key: 'where-used',
                  label: 'Where Used',
                  children: <WhereUsedTab partId={part.id} />,
                },
                {
                  key: 'process',
                  label: 'Manufacturing',
                  children: (
                    <ProcessTab
                      revision={revision}
                      editable={canEdit && revision.lifecycle === 'IN_WORK'}
                      onChanged={handleChanged}
                    />
                  ),
                },
                {
                  key: 'options',
                  label: 'Options',
                  children: (
                    <OptionsTab part={part} editable={canEdit} onChanged={handleChanged} />
                  ),
                },
                {
                  key: 'documents',
                  label: 'Documents',
                  children: (
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                      <DocumentsCard title="Part documents" partId={part.id} editable={canEdit} />
                      <DocumentsCard
                        title={`Rev ${revision.revision} documents`}
                        revisionId={revision.id}
                        editable={canEdit}
                      />
                    </Space>
                  ),
                },
                {
                  key: 'sourcing',
                  label: 'Sourcing',
                  children: <SourcingTab part={part} editable={canEdit} />,
                },
                {
                  key: 'cost',
                  label: 'Cost',
                  children: <CostTab revision={revision} />,
                },
                {
                  key: 'requirements',
                  label: 'Requirements',
                  children: <RequirementsTab part={part} />,
                },
                {
                  key: 'history',
                  label: 'History',
                  children: (
                    <Table<RevisionSummary>
                      size="middle"
                      rowKey="id"
                      columns={historyColumns}
                      dataSource={part.revisions}
                      pagination={false}
                    />
                  ),
                },
              ]}
            />
          ) : (
            <Skeleton active />
          )}
        </Spin>
      </Card>

      <Modal
        title="Edit part"
        open={editOpen}
        onOk={() => void handleEditOk()}
        onCancel={() => setEditOpen(false)}
        confirmLoading={editSaving}
        okText="Save"
      >
        <Form form={editForm} layout="vertical" name="edit-part">
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Name is required' }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="category"
            label="Category"
            rules={[{ required: true, message: 'Category is required' }]}
          >
            <Select options={CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="uom"
            label="Unit of measure"
            rules={[{ required: true, message: 'Unit of measure is required' }]}
          >
            <Input maxLength={16} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
