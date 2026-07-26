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
  Typography,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { EcnPriority, EcrDetail as EcrDetailDto } from '../api/types';
import {
  ECN_PRIORITY_OPTIONS,
  EcnPriorityTag,
  EcrStatusTag,
  formatDate,
} from '../components/meta';

interface HeaderFormValues {
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

interface EcnOption {
  id: number;
  ecnNumber: string;
  title: string;
}

export default function EcrDetail() {
  const { id: idParam } = useParams();
  const ecrId = Number(idParam);
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [ecr, setEcr] = useState<EcrDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Header edit modal
  const [headerOpen, setHeaderOpen] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerSaving, setHeaderSaving] = useState(false);
  const [headerForm] = Form.useForm<HeaderFormValues>();
  const [partOptions, setPartOptions] = useState<PartOption[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const partTimer = useRef<number | undefined>(undefined);

  // "Accept — link existing ECN" modal
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkEcnId, setLinkEcnId] = useState<number | undefined>(undefined);
  const [ecnOptions, setEcnOptions] = useState<EcnOption[]>([]);
  const [ecnLoading, setEcnLoading] = useState(false);
  const ecnTimer = useRef<number | undefined>(undefined);

  // Reject modal
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [rejectSaving, setRejectSaving] = useState(false);
  const [resolution, setResolution] = useState('');

  const load = useCallback(async () => {
    if (!Number.isInteger(ecrId) || ecrId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const detail = await api.getEcr(ecrId);
      setEcr(detail);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [ecrId, message]);

  useEffect(() => {
    setEcr(null);
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(partTimer.current);
      window.clearTimeout(ecnTimer.current);
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

  const fetchEcns = useCallback(async (value: string) => {
    setEcnLoading(true);
    try {
      const res = await api.listEcns({ search: value || undefined, pageSize: 20 });
      setEcnOptions(res.items);
    } catch {
      setEcnOptions([]);
    } finally {
      setEcnLoading(false);
    }
  }, []);

  const handleEcnSearch = (value: string) => {
    window.clearTimeout(ecnTimer.current);
    ecnTimer.current = window.setTimeout(() => {
      void fetchEcns(value);
    }, 300);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !ecr) {
    return (
      <Empty description="Change request not found">
        <Link to="/ecrs">Back to change requests</Link>
      </Empty>
    );
  }

  const isOpen = ecr.status === 'OPEN';
  const isViewer = user?.role === 'VIEWER';

  const openHeaderEdit = () => {
    setHeaderError(null);
    setPartOptions(ecr.part ? [ecr.part] : []);
    headerForm.setFieldsValue({
      title: ecr.title,
      priority: ecr.priority,
      description: ecr.description ?? undefined,
      partId: ecr.part?.id,
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
      const updated = await api.updateEcr(ecr.id, {
        title: values.title.trim(),
        priority: values.priority,
        description: values.description?.trim() ? values.description.trim() : null,
        partId: values.partId ?? null,
      });
      setEcr(updated);
      setHeaderOpen(false);
      message.success('Change request updated');
    } catch (err) {
      setHeaderError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setHeaderSaving(false);
    }
  };

  const acceptAndCreate = () => {
    modal.confirm({
      title: 'Accept & create ECN',
      content: `Accepting will create a draft ECN from this request${
        ecr.part ? ` with ${ecr.part.partNumber} added as an affected part` : ''
      } and link it here. You can then work the change through the ECN.`,
      okText: 'Accept',
      onOk: async () => {
        try {
          const updated = await api.acceptEcr(ecr.id, {});
          setEcr(updated);
          const ecnRef = updated.ecn;
          if (ecnRef) {
            modal.success({
              title: 'Change request accepted',
              content: `Draft ${ecnRef.ecnNumber} was created and linked to this request.`,
              okCancel: true,
              okText: 'Open ECN',
              cancelText: 'Close',
              onOk: () => navigate(`/ecns/${ecnRef.id}`),
            });
          } else {
            message.success('Change request accepted');
          }
        } catch (err) {
          modal.error({
            title: 'Cannot accept',
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        }
      },
    });
  };

  const openLinkEcn = () => {
    setLinkError(null);
    setLinkEcnId(undefined);
    void fetchEcns('');
    setLinkOpen(true);
  };

  const saveLinkEcn = async () => {
    if (linkEcnId === undefined) {
      setLinkError('Select an ECN');
      return;
    }
    setLinkSaving(true);
    setLinkError(null);
    try {
      const updated = await api.acceptEcr(ecr.id, { ecnId: linkEcnId });
      setEcr(updated);
      setLinkOpen(false);
      message.success(
        `Accepted — linked to ${updated.ecn ? updated.ecn.ecnNumber : 'the ECN'}`
      );
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLinkSaving(false);
    }
  };

  const openReject = () => {
    setRejectError(null);
    setResolution('');
    setRejectOpen(true);
  };

  const saveReject = async () => {
    const text = resolution.trim();
    if (!text) {
      setRejectError('Resolution is required');
      return;
    }
    setRejectSaving(true);
    setRejectError(null);
    try {
      const updated = await api.rejectEcr(ecr.id, text);
      setEcr(updated);
      setRejectOpen(false);
      message.success('Change request rejected');
    } catch (err) {
      setRejectError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setRejectSaving(false);
    }
  };

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
                {ecr.ecrNumber} — {ecr.title}
              </Typography.Title>
              <EcrStatusTag status={ecr.status} />
              <EcnPriorityTag priority={ecr.priority} />
            </Space>
            <Typography.Text type="secondary">Engineering change request</Typography.Text>
          </Space>
          {isOpen && !isViewer && (
            <Button icon={<EditOutlined />} onClick={openHeaderEdit}>
              Edit
            </Button>
          )}
        </div>
        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Created by">{ecr.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="Created">{formatDate(ecr.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="Related part">
            {ecr.part ? (
              <Link to={`/parts/${ecr.part.id}`}>
                {ecr.part.partNumber} — {ecr.part.name}
              </Link>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Resolution">{ecr.resolution ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Resolved by">
            {ecr.resolvedBy ? `${ecr.resolvedBy.name} · ${formatDate(ecr.resolvedAt)}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {ecr.description ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {ecr.status === 'ACCEPTED' && ecr.ecn && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            <span>
              Accepted — this request is tracked as{' '}
              <Link to={`/ecns/${ecr.ecn.id}`}>{ecr.ecn.ecnNumber}</Link>.
            </span>
          }
        />
      )}

      {isOpen && !isViewer && (
        <Card
          style={{ marginBottom: 16 }}
          styles={{ body: { display: 'flex', gap: 8, flexWrap: 'wrap' } }}
        >
          <Button type="primary" icon={<CheckOutlined />} onClick={acceptAndCreate}>
            Accept &amp; create ECN
          </Button>
          <Button icon={<LinkOutlined />} onClick={openLinkEcn}>
            Accept — link existing ECN
          </Button>
          <Button danger icon={<CloseOutlined />} onClick={openReject}>
            Reject
          </Button>
        </Card>
      )}

      <Modal
        title="Edit change request"
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
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
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

      <Modal
        title="Accept — link existing ECN"
        open={linkOpen}
        onOk={() => void saveLinkEcn()}
        okText="Accept"
        confirmLoading={linkSaving}
        onCancel={() => setLinkOpen(false)}
      >
        {linkError && (
          <Alert type="error" showIcon message={linkError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          Accept this request and track it under an engineering change that already exists.
        </Typography.Paragraph>
        <Select
          showSearch
          placeholder="Search by ECN number or title"
          style={{ width: '100%' }}
          value={linkEcnId}
          onChange={(value: number) => setLinkEcnId(value)}
          filterOption={false}
          onSearch={handleEcnSearch}
          loading={ecnLoading}
          options={ecnOptions.map((e) => ({
            value: e.id,
            label: `${e.ecnNumber} — ${e.title}`,
          }))}
          notFoundContent={ecnLoading ? 'Searching…' : 'No ECNs found'}
        />
      </Modal>

      <Modal
        title="Reject change request"
        open={rejectOpen}
        onOk={() => void saveReject()}
        okText="Reject"
        okButtonProps={{ danger: true }}
        confirmLoading={rejectSaving}
        onCancel={() => setRejectOpen(false)}
      >
        {rejectError && (
          <Alert type="error" showIcon message={rejectError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          Explain why this request will not be implemented — the resolution is recorded on the
          request.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="Resolution (required)"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
        />
      </Modal>
    </div>
  );
}
