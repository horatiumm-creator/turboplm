import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  PrinterOutlined,
  RocketOutlined,
  SendOutlined,
  StopOutlined,
  SwapOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import ItemAccessCard from '../components/ItemAccessCard';
import { useAuth } from '../auth/AuthContext';
import DocumentsCard from '../components/DocumentsCard';
import SignaturePanel from '../components/SignaturePanel';
import type {
  EcnDetail as EcnDetailDto,
  EcnDisposition,
  EcnImpactEntry,
  EcnItemDetail,
  EcnPriority,
  EcnTransitionAction,
  EcnWorkflowDetail,
  PartRef,
  UserSummary,
  WorkflowTaskDetail,
  WorkflowTemplateDetail,
} from '../api/types';
import {
  ECN_DISPOSITION_META,
  ECN_DISPOSITION_OPTIONS,
  ECN_PRIORITY_OPTIONS,
  EcnPriorityTag,
  EcnReviewDecisionTag,
  EcnStatusTag,
  formatDate,
  LifecycleTag,
  TaskDecisionTag,
  WORKFLOW_RULE_META,
  WorkflowStatusTag,
} from '../components/meta';

interface HeaderFormValues {
  title: string;
  priority: EcnPriority;
  reason?: string;
  description?: string;
  effectivityDate?: Dayjs | null;
}

interface ItemFormValues {
  partId?: number;
  changeDescription?: string;
  disposition: EcnDisposition;
}

export default function EcnDetail() {
  const { id: idParam } = useParams();
  const ecnId = Number(idParam);
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();

  const { user } = useAuth();
  const [ecn, setEcn] = useState<EcnDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);
  const [startingItemId, setStartingItemId] = useState<number | null>(null);
  const [impact, setImpact] = useState<EcnImpactEntry[] | null>(null);
  const [workflow, setWorkflow] = useState<EcnWorkflowDetail | null>(null);

  // Submit-for-review modal (workflow template choice)
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplateDetail[]>([]);
  const [submitTemplateId, setSubmitTemplateId] = useState<number | undefined>(undefined);

  // My workflow-task decision state
  const [taskComment, setTaskComment] = useState('');
  const [taskDeciding, setTaskDeciding] = useState(false);

  // Reviewer modal + my-decision state
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerError, setReviewerError] = useState<string | null>(null);
  const [reviewerSaving, setReviewerSaving] = useState(false);
  const [reviewerId, setReviewerId] = useState<number | undefined>(undefined);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [myComment, setMyComment] = useState('');
  const [deciding, setDeciding] = useState(false);

  // Header edit modal
  const [headerOpen, setHeaderOpen] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerSaving, setHeaderSaving] = useState(false);
  const [headerForm] = Form.useForm<HeaderFormValues>();

  // Item add/edit modal
  const [itemOpen, setItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<EcnItemDetail | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemSaving, setItemSaving] = useState(false);
  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const [itemForm] = Form.useForm<ItemFormValues>();

  // Bumped whenever the ECN reloads: an item change may have voided signatures, and the
  // panel has to re-read the manifest to notice.
  const [signatureKey, setSignatureKey] = useState(0);

  const load = useCallback(async () => {
    if (!Number.isInteger(ecnId) || ecnId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const [detail, impactEntries, workflowDetail] = await Promise.all([
        api.getEcn(ecnId),
        api.getEcnImpact(ecnId).catch(() => null),
        api.getEcnWorkflow(ecnId).catch(() => null),
      ]);
      setEcn(detail);
      setSignatureKey((key) => key + 1);
      setImpact(impactEntries);
      setWorkflow(workflowDetail);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [ecnId, message]);

  useEffect(() => {
    setEcn(null);
    setWorkflow(null);
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimer.current);
    };
  }, []);

  const fetchParts = useCallback(async (search: string) => {
    setPartLoading(true);
    try {
      const res = await api.listParts({ search: search || undefined, pageSize: 20 });
      setPartOptions(res.items);
    } catch {
      setPartOptions([]);
    } finally {
      setPartLoading(false);
    }
  }, []);

  const handlePartSearch = (value: string) => {
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void fetchParts(value);
    }, 300);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !ecn) {
    return (
      <Empty description="Engineering change not found">
        <Link to="/ecns">Back to changes</Link>
      </Empty>
    );
  }

  // Viewers get a read-only page: the server rejects their writes anyway, so the
  // controls should not be offered in the first place.
  const canEdit = user?.role !== 'VIEWER';
  const isDraft = canEdit && ecn.status === 'DRAFT';
  const itemsEditable = canEdit && (ecn.status === 'DRAFT' || ecn.status === 'IN_REVIEW');
  const deletable = isDraft && ecn.items.every((item) => item.toRevision === null);

  const transition = (action: EcnTransitionAction, title: string, content: React.ReactNode) => {
    modal.confirm({
      title,
      content,
      okText: title,
      okButtonProps: action === 'cancel' ? { danger: true } : undefined,
      onOk: async () => {
        setActing(true);
        try {
          const updated = await api.transitionEcn(ecn.id, action);
          setEcn(updated);
      setSignatureKey((key) => key + 1);
          setSignatureKey((key) => key + 1);
          message.success(`${updated.ecnNumber} is now ${updated.status.replace('_', ' ')}`);
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

  const openSubmit = () => {
    setSubmitError(null);
    setSubmitTemplateId(undefined);
    setSubmitOpen(true);
    void (async () => {
      try {
        const all = await api.listWorkflowTemplates();
        setTemplates(all.filter((t) => t.active));
      } catch {
        setTemplates([]);
      }
    })();
  };

  const confirmSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await api.transitionEcn(ecn.id, 'submit', {
        workflowTemplateId: submitTemplateId,
      });
      setEcn(updated);
      setSubmitOpen(false);
      message.success(`${updated.ecnNumber} is now ${updated.status.replace('_', ' ')}`);
      await load();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const openHeaderEdit = () => {
    setHeaderError(null);
    headerForm.setFieldsValue({
      title: ecn.title,
      priority: ecn.priority,
      reason: ecn.reason ?? undefined,
      description: ecn.description ?? undefined,
      effectivityDate: ecn.effectivityDate ? dayjs(ecn.effectivityDate) : null,
    });
    setHeaderOpen(true);
  };

  const saveHeader = async () => {
    let values: HeaderFormValues;
    try {
      values = await headerForm.validateFields();
    } catch {
      return;
    }
    setHeaderSaving(true);
    setHeaderError(null);
    try {
      const updated = await api.updateEcn(ecn.id, {
        title: values.title.trim(),
        priority: values.priority,
        reason: values.reason?.trim() ? values.reason.trim() : null,
        description: values.description?.trim() ? values.description.trim() : null,
        effectivityDate: values.effectivityDate ? values.effectivityDate.toISOString() : null,
      });
      setEcn(updated);
      setHeaderOpen(false);
      message.success('ECN updated');
    } catch (err) {
      setHeaderError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setHeaderSaving(false);
    }
  };

  const openAddItem = () => {
    setEditingItem(null);
    setItemError(null);
    itemForm.resetFields();
    itemForm.setFieldsValue({ disposition: 'USE_AS_IS' });
    void fetchParts('');
    setItemOpen(true);
  };

  const openEditItem = (item: EcnItemDetail) => {
    setEditingItem(item);
    setItemError(null);
    itemForm.resetFields();
    setPartOptions([item.part]);
    itemForm.setFieldsValue({
      partId: item.part.id,
      changeDescription: item.changeDescription ?? undefined,
      disposition: item.disposition,
    });
    setItemOpen(true);
  };

  const saveItem = async () => {
    let values: ItemFormValues;
    try {
      values = await itemForm.validateFields();
    } catch {
      return;
    }
    setItemSaving(true);
    setItemError(null);
    try {
      if (editingItem) {
        await api.updateEcnItem(editingItem.id, {
          changeDescription: values.changeDescription?.trim()
            ? values.changeDescription.trim()
            : null,
          disposition: values.disposition,
        });
        message.success('Item updated');
      } else {
        await api.addEcnItem(ecn.id, {
          partId: values.partId!,
          changeDescription: values.changeDescription?.trim() || undefined,
          disposition: values.disposition,
        });
        message.success('Part added to the change');
      }
      setItemOpen(false);
      await load();
    } catch (err) {
      setItemError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setItemSaving(false);
    }
  };

  const startChange = async (item: EcnItemDetail) => {
    if (startingItemId !== null) return;
    setStartingItemId(item.id);
    try {
      await api.startEcnItemChange(item.id);
      message.success(`Working revision ready for ${item.part.partNumber}`);
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setStartingItemId(null);
    }
  };

  const removeItem = (item: EcnItemDetail) => {
    modal.confirm({
      title: 'Remove affected part',
      content: `Remove ${item.part.partNumber} — ${item.part.name} from this ECN?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteEcnItem(item.id);
          message.success('Part removed from the change');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const openAddReviewer = () => {
    setReviewerError(null);
    setReviewerId(undefined);
    setReviewerOpen(true);
    void (async () => {
      try {
        setUsers(await api.listUsers());
      } catch {
        setUsers([]);
      }
    })();
  };

  const saveReviewer = async () => {
    if (reviewerId === undefined) {
      setReviewerError('Select a user');
      return;
    }
    setReviewerSaving(true);
    setReviewerError(null);
    try {
      await api.addEcnReviewer(ecn.id, reviewerId);
      message.success('Reviewer added');
      setReviewerOpen(false);
      await load();
    } catch (err) {
      setReviewerError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setReviewerSaving(false);
    }
  };

  const removeReview = (reviewId: number) => {
    modal.confirm({
      title: 'Remove reviewer',
      okText: 'Remove',
      okButtonProps: { danger: true },
      content: 'Remove this reviewer from the ECN?',
      onOk: async () => {
        try {
          await api.removeEcnReview(reviewId);
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const decide = async (reviewId: number, decision: 'approve' | 'reject') => {
    setDeciding(true);
    try {
      await api.decideEcnReview(reviewId, decision, myComment.trim() || undefined);
      message.success(decision === 'approve' ? 'Approved' : 'Changes requested');
      setMyComment('');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setDeciding(false);
    }
  };

  const decideTask = async (taskId: number, decision: 'approve' | 'reject') => {
    setTaskDeciding(true);
    try {
      await api.decideWorkflowTask(taskId, decision, taskComment.trim() || undefined);
      message.success(decision === 'approve' ? 'Approved' : 'Changes requested');
      setTaskComment('');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setTaskDeciding(false);
    }
    await load();
  };

  const deleteEcn = () => {
    modal.confirm({
      title: 'Delete ECN',
      content: `Delete ${ecn.ecnNumber} — ${ecn.title}? This cannot be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteEcn(ecn.id);
          message.success('ECN deleted');
          navigate('/ecns');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const itemColumns: ColumnsType<EcnItemDetail> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, item) => (
        <Space size={8}>
          <Link to={`/parts/${item.part.id}`}>{item.part.partNumber}</Link>
          <Typography.Text type="secondary">{item.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'From rev',
      key: 'from',
      width: 100,
      render: (_, item) => (item.fromRevision ? <Tag>{item.fromRevision.revision}</Tag> : '—'),
    },
    {
      title: 'To rev',
      key: 'to',
      width: 190,
      render: (_, item) =>
        item.toRevision ? (
          <Space size={4}>
            <Tag color="blue">{item.toRevision.revision}</Tag>
            <LifecycleTag lifecycle={item.toRevision.lifecycle} />
          </Space>
        ) : (
          <Typography.Text type="secondary">not started</Typography.Text>
        ),
    },
    {
      title: 'Change description',
      key: 'changeDescription',
      ellipsis: true,
      render: (_, item) => item.changeDescription ?? '—',
    },
    {
      title: 'Disposition',
      key: 'disposition',
      width: 140,
      render: (_, item) => ECN_DISPOSITION_META[item.disposition].label,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 260,
      render: (_, item) => (
        <Space size={0} wrap>
          {!item.toRevision && itemsEditable && (
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={startingItemId === item.id}
              disabled={startingItemId !== null && startingItemId !== item.id}
              onClick={() => void startChange(item)}
            >
              Start change
            </Button>
          )}
          {item.toRevision && (
            <Link to={`/parts/${item.part.id}?rev=${item.toRevision.id}`}>
              <Button type="link" size="small">
                Open revision
              </Button>
            </Link>
          )}
          {item.fromRevision && item.toRevision && (
            <Link to={`/compare?left=${item.fromRevision.id}&right=${item.toRevision.id}`}>
              <Button type="link" size="small" icon={<SwapOutlined />}>
                Compare
              </Button>
            </Link>
          )}
          {itemsEditable && (
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditItem(item)}
            >
              Edit
            </Button>
          )}
          {isDraft && (
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeItem(item)}
            >
              Remove
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const workflowSteps = workflow
    ? [...new Set(workflow.tasks.map((t) => t.seq))]
        .sort((a, b) => a - b)
        .map((seq) => {
          const stepTasks = workflow.tasks.filter((t) => t.seq === seq);
          const rejected =
            workflow.status === 'REJECTED' &&
            stepTasks.some((t) => t.decision === 'REJECTED');
          const finished = stepTasks.every((t) => t.decision !== 'PENDING');
          const status: 'error' | 'finish' | 'process' | 'wait' = rejected
            ? 'error'
            : finished
              ? 'finish'
              : seq === workflow.currentSeq && workflow.status === 'RUNNING'
                ? 'process'
                : 'wait';
          return {
            title: stepTasks[0]?.stepName ?? `Step ${seq}`,
            description: stepTasks[0] ? WORKFLOW_RULE_META[stepTasks[0].rule].label : undefined,
            status,
          };
        })
    : [];

  const myTask =
    workflow && workflow.status === 'RUNNING'
      ? (workflow.tasks.find(
          (t) =>
            t.user.id === user?.id &&
            t.decision === 'PENDING' &&
            t.seq === workflow.currentSeq
        ) ?? null)
      : null;

  const workflowTasks = workflow?.tasks ?? [];
  const taskColumns: ColumnsType<WorkflowTaskDetail> = [
    {
      title: 'Step',
      key: 'step',
      width: 220,
      onCell: (task, index) => {
        const i = index ?? 0;
        if (i > 0 && workflowTasks[i - 1]?.seq === task.seq) return { rowSpan: 0 };
        return { rowSpan: workflowTasks.filter((t) => t.seq === task.seq).length };
      },
      render: (_, task) => (
        <Space size={6}>
          <Typography.Text strong>{task.seq}.</Typography.Text>
          {task.stepName}
        </Space>
      ),
    },
    {
      title: 'User',
      key: 'user',
      render: (_, task) => task.user.name,
    },
    {
      title: 'Decision',
      key: 'decision',
      width: 150,
      render: (_, task) => <TaskDecisionTag decision={task.decision} />,
    },
    {
      title: 'Comment',
      key: 'comment',
      ellipsis: true,
      render: (_, task) => task.comment ?? '—',
    },
    {
      title: 'Decided',
      key: 'decidedAt',
      width: 160,
      render: (_, task) => formatDate(task.decidedAt),
    },
  ];

  const releaseSummary = (
    <div>
      <p>The following revisions will be released together:</p>
      <ul>
        {ecn.items.map((item) => (
          <li key={item.id}>
            {item.part.partNumber}: rev {item.fromRevision?.revision ?? '—'} →{' '}
            rev {item.toRevision?.revision ?? '?'}
          </li>
        ))}
      </ul>
      <p>Effectivity date: {ecn.effectivityDate ? formatDate(ecn.effectivityDate) : 'today'}.</p>
    </div>
  );

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
                {ecn.ecnNumber} — {ecn.title}
              </Typography.Title>
              <EcnStatusTag status={ecn.status} />
              <EcnPriorityTag priority={ecn.priority} />
            </Space>
            <Typography.Text type="secondary">
              Engineering change notice · {ecn.items.length} affected part
              {ecn.items.length === 1 ? '' : 's'}
            </Typography.Text>
          </Space>
          <Space>
            <Link to={`/ecns/${ecn.id}/report`}>
              <Button icon={<PrinterOutlined />}>Print notice</Button>
            </Link>
            {isDraft && (
              <Button icon={<EditOutlined />} onClick={openHeaderEdit}>
                Edit
              </Button>
            )}
            {deletable && (
              <Button danger icon={<DeleteOutlined />} onClick={deleteEcn}>
                Delete
              </Button>
            )}
          </Space>
        </div>
        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Created by">{ecn.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="Created">{formatDate(ecn.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="Effectivity date">
            {formatDate(ecn.effectivityDate)}
          </Descriptions.Item>
          <Descriptions.Item label="Approved by">
            {ecn.approvedBy ? `${ecn.approvedBy.name} · ${formatDate(ecn.approvedAt)}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Released">{formatDate(ecn.releasedAt)}</Descriptions.Item>
          <Descriptions.Item label="Reason">{ecn.reason ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {ecn.description ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        style={{ marginBottom: 16 }}
        styles={{ body: { display: 'flex', gap: 8, flexWrap: 'wrap' } }}
      >
        {canEdit && ecn.status === 'DRAFT' && (
          <>
            <Button type="primary" icon={<SendOutlined />} onClick={openSubmit}>
              Submit for review
            </Button>
            <Button
              danger
              icon={<StopOutlined />}
              onClick={() =>
                transition('cancel', 'Cancel ECN', 'Cancel this engineering change?')
              }
            >
              Cancel ECN
            </Button>
          </>
        )}
        {canEdit && ecn.status === 'IN_REVIEW' && (
          <>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={acting}
              onClick={() =>
                transition(
                  'approve',
                  'Approve',
                  'Approve this change? Every affected part must have a working revision.'
                )
              }
            >
              Approve
            </Button>
            <Button
              icon={<CloseOutlined />}
              onClick={() => transition('reject', 'Reject', 'Send this change back to draft?')}
            >
              Reject
            </Button>
            <Button
              danger
              icon={<StopOutlined />}
              onClick={() =>
                transition('cancel', 'Cancel ECN', 'Cancel this engineering change?')
              }
            >
              Cancel ECN
            </Button>
          </>
        )}
        {canEdit && ecn.status === 'APPROVED' && (
          <>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={acting}
              onClick={() => transition('release', 'Release changes', releaseSummary)}
            >
              Release changes
            </Button>
            <Button
              danger
              icon={<StopOutlined />}
              onClick={() =>
                transition('cancel', 'Cancel ECN', 'Cancel this engineering change?')
              }
            >
              Cancel ECN
            </Button>
          </>
        )}
        {!canEdit && (
          <Typography.Text type="secondary">
            Read-only access — an engineer account is needed to act on this change.
          </Typography.Text>
        )}
        {canEdit && (ecn.status === 'RELEASED' || ecn.status === 'CANCELLED') && (
          <Typography.Text type="secondary">
            This change is {ecn.status === 'RELEASED' ? 'released' : 'cancelled'} — no further
            actions.
          </Typography.Text>
        )}
      </Card>

      {workflow ? (
        <Card
          title={
            <Space size={8}>
              Approval workflow
              <WorkflowStatusTag status={workflow.status} />
              <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
                {workflow.templateName}
              </Typography.Text>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Steps
            size="small"
            current={workflow.currentSeq - 1}
            items={workflowSteps}
            style={{ marginBottom: 24 }}
          />
          <Table<WorkflowTaskDetail>
            size="middle"
            rowKey="id"
            pagination={false}
            columns={taskColumns}
            dataSource={workflow.tasks}
          />
          {myTask && (
            <div
              style={{
                marginTop: 16,
                padding: 16,
                background: '#f5f8ff',
                borderRadius: 8,
              }}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text strong>
                  Your approval — step {myTask.seq}: {myTask.stepName}
                </Typography.Text>
                <Input.TextArea
                  rows={2}
                  placeholder="Comment (optional)"
                  value={taskComment}
                  onChange={(e) => setTaskComment(e.target.value)}
                />
                <Space>
                  <Button
                    type="primary"
                    icon={<CheckOutlined />}
                    loading={taskDeciding}
                    onClick={() => void decideTask(myTask.id, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    danger
                    icon={<CloseOutlined />}
                    loading={taskDeciding}
                    onClick={() => void decideTask(myTask.id, 'reject')}
                  >
                    Request changes
                  </Button>
                </Space>
              </Space>
            </div>
          )}
        </Card>
      ) : (
      <Card
        title="Reviewers"
        style={{ marginBottom: 16 }}
        extra={
          itemsEditable && (
            <Button icon={<UserAddOutlined />} onClick={openAddReviewer}>
              Add reviewer
            </Button>
          )
        }
      >
        {ecn.reviews.length === 0 ? (
          <Typography.Text type="secondary">
            No reviewers assigned — the ECN can be approved directly. Add reviewers to require
            their sign-off.
          </Typography.Text>
        ) : (
          <Table
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={ecn.reviews}
            columns={[
              {
                title: 'Reviewer',
                key: 'reviewer',
                render: (_, review) => review.reviewer.name,
              },
              {
                title: 'Decision',
                key: 'decision',
                width: 170,
                render: (_, review) => <EcnReviewDecisionTag decision={review.decision} />,
              },
              {
                title: 'Comment',
                key: 'comment',
                ellipsis: true,
                render: (_, review) => review.comment ?? '—',
              },
              {
                title: 'Decided',
                key: 'decidedAt',
                width: 160,
                render: (_, review) => formatDate(review.decidedAt),
              },
              {
                title: 'Actions',
                key: 'actions',
                width: 120,
                render: (_, review) =>
                  itemsEditable && review.decision === 'PENDING' ? (
                    <Button
                      type="link"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => removeReview(review.id)}
                    >
                      Remove
                    </Button>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
            ]}
          />
        )}
        {ecn.status === 'IN_REVIEW' &&
          (() => {
            const mine = ecn.reviews.find((review) => review.reviewer.id === user?.id);
            if (!mine) return null;
            return (
              <div
                style={{
                  marginTop: 16,
                  padding: 16,
                  background: '#f5f8ff',
                  borderRadius: 8,
                }}
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Typography.Text strong>
                    Your review{' '}
                    {mine.decision !== 'PENDING' && (
                      <EcnReviewDecisionTag decision={mine.decision} />
                    )}
                  </Typography.Text>
                  <Input.TextArea
                    rows={2}
                    placeholder="Review comment (optional)"
                    value={myComment}
                    onChange={(e) => setMyComment(e.target.value)}
                  />
                  <Space>
                    <Button
                      type="primary"
                      icon={<CheckOutlined />}
                      loading={deciding}
                      onClick={() => void decide(mine.id, 'approve')}
                    >
                      Approve
                    </Button>
                    <Button
                      danger
                      icon={<CloseOutlined />}
                      loading={deciding}
                      onClick={() => void decide(mine.id, 'reject')}
                    >
                      Request changes
                    </Button>
                  </Space>
                </Space>
              </div>
            );
          })()}
      </Card>
      )}

      <Card
        title="Affected parts"
        style={{ marginBottom: 16 }}
        extra={
          isDraft && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openAddItem}>
              Add part
            </Button>
          )
        }
      >
        {ecn.items.length === 0 ? (
          <Empty description="Add the parts affected by this change." />
        ) : (
          <Table<EcnItemDetail>
            size="middle"
            rowKey="id"
            columns={itemColumns}
            dataSource={ecn.items}
            pagination={false}
          />
        )}
      </Card>

      <Card title="Change impact — where the affected parts are used">
        {!impact || impact.length === 0 ? (
          <Typography.Text type="secondary">
            No affected parts yet — impact appears once parts are added.
          </Typography.Text>
        ) : (
          <Table<EcnImpactEntry>
            size="middle"
            rowKey={(entry) => entry.part.id}
            pagination={false}
            dataSource={impact}
            columns={[
              {
                title: 'Affected part',
                key: 'part',
                render: (_, entry) => (
                  <Space size={8}>
                    <Link to={`/parts/${entry.part.id}`}>{entry.part.partNumber}</Link>
                    <Typography.Text type="secondary">{entry.part.name}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: 'Working rev',
                key: 'toRev',
                width: 120,
                render: (_, entry) =>
                  entry.toRevision ? <Tag color="blue">{entry.toRevision.revision}</Tag> : '—',
              },
              {
                title: 'Used in',
                key: 'usedIn',
                width: 110,
                render: (_, entry) =>
                  entry.usedIn.length === 0 ? (
                    <Typography.Text type="secondary">nowhere</Typography.Text>
                  ) : (
                    `${entry.usedIn.length} place${entry.usedIn.length === 1 ? '' : 's'}`
                  ),
              },
            ]}
            expandable={{
              defaultExpandAllRows: true,
              rowExpandable: (entry) => entry.usedIn.length > 0,
              expandedRowRender: (entry) => (
                <Table
                  size="small"
                  rowKey={(row) => row.line.id}
                  pagination={false}
                  dataSource={entry.usedIn}
                  columns={[
                    {
                      title: 'Parent assembly',
                      key: 'parent',
                      render: (_, row) => (
                        <Link to={`/parts/${row.parentPart.id}?rev=${row.parentRevision.id}`}>
                          {row.parentPart.partNumber} — {row.parentPart.name}
                        </Link>
                      ),
                    },
                    {
                      title: 'Parent rev',
                      key: 'rev',
                      width: 170,
                      render: (_, row) => (
                        <Space size={4}>
                          <Tag>{row.parentRevision.revision}</Tag>
                          <LifecycleTag lifecycle={row.parentRevision.lifecycle} />
                        </Space>
                      ),
                    },
                    {
                      title: 'Qty',
                      key: 'qty',
                      width: 100,
                      align: 'right',
                      render: (_, row) => `${row.line.quantity} ${row.line.uom}`,
                    },
                  ]}
                />
              ),
            }}
          />
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <SignaturePanel
          entityType="ECN"
          entityId={ecn.id}
          refreshKey={signatureKey}
          onSigned={() => void load()}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <DocumentsCard title="Documents" ecnId={ecn.id} editable={user?.role !== 'VIEWER'} />
      </div>

      <Modal
        title="Submit for review"
        open={submitOpen}
        onOk={() => void confirmSubmit()}
        okText="Submit"
        confirmLoading={submitting}
        onCancel={() => setSubmitOpen(false)}
      >
        {submitError && (
          <Alert type="error" showIcon message={submitError} style={{ marginBottom: 16 }} />
        )}
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text>
            Send this change to review. Pick an approval workflow to route sign-offs through
            its steps, or keep the flat reviewer list.
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            value={submitTemplateId}
            onChange={(value) => setSubmitTemplateId(value)}
            placeholder="No workflow — flat reviewers"
            options={[
              { value: undefined, label: 'No workflow — flat reviewers' },
              ...templates.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        </Space>
      </Modal>

      <Modal
        title="Add reviewer"
        open={reviewerOpen}
        onOk={() => void saveReviewer()}
        okText="Add"
        confirmLoading={reviewerSaving}
        onCancel={() => setReviewerOpen(false)}
      >
        {reviewerError && (
          <Alert type="error" showIcon message={reviewerError} style={{ marginBottom: 16 }} />
        )}
        <Select
          showSearch
          placeholder="Select a user"
          style={{ width: '100%' }}
          value={reviewerId}
          onChange={(value: number) => setReviewerId(value)}
          optionFilterProp="label"
          options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
        />
      </Modal>

      <Modal
        title="Edit engineering change"
        open={headerOpen}
        onOk={() => void saveHeader()}
        okText="Save"
        confirmLoading={headerSaving}
        onCancel={() => setHeaderOpen(false)}
        forceRender
      >
        {headerError && (
          <Alert type="error" showIcon message={headerError} style={{ marginBottom: 16 }} />
        )}
        <Form form={headerForm} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[
              { required: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="priority" label="Priority" style={{ width: 180 }}>
              <Select options={ECN_PRIORITY_OPTIONS} />
            </Form.Item>
            <Form.Item name="effectivityDate" label="Effectivity date" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="reason" label="Reason for change">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingItem ? 'Edit affected part' : 'Add affected part'}
        open={itemOpen}
        onOk={() => void saveItem()}
        okText={editingItem ? 'Save' : 'Add'}
        confirmLoading={itemSaving}
        onCancel={() => setItemOpen(false)}
        forceRender
      >
        {itemError && (
          <Alert type="error" showIcon message={itemError} style={{ marginBottom: 16 }} />
        )}
        <Form form={itemForm} layout="vertical">
          <Form.Item
            name="partId"
            label="Part"
            rules={[{ required: true, message: 'Select a part' }]}
          >
            <Select
              showSearch
              disabled={editingItem !== null}
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
          <Form.Item name="changeDescription" label="Change description">
            <Input.TextArea rows={3} placeholder="What changes on this part?" />
          </Form.Item>
          <Form.Item
            name="disposition"
            label="Disposition of existing stock"
            tooltip="What manufacturing should do with parts already built to the old revision."
          >
            <Select options={ECN_DISPOSITION_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 16 }}>
        <ItemAccessCard entityType="ECN" entityId={ecn.id} />
      </div>
    </div>
  );
}
