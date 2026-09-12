import { useCallback, useEffect, useState } from 'react';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';
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
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  EditOutlined,
  RedoOutlined,
  SafetyOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CapaSummary, EcnDisposition, NcrDetail as NcrDetailDto, NcrSeverity } from '../api/types';
import {
  ECN_DISPOSITION_META,
  ECN_DISPOSITION_OPTIONS,
  EcnStatusTag,
  formatDate,
  LifecycleTag,
  NCR_SEVERITY_OPTIONS,
  NcrSeverityTag,
  NcrStatusTag,
} from '../components/meta';

interface EditValues {
  title: string;
  description: string;
  severity: NcrSeverity;
  disposition?: EcnDisposition | null;
  quantityAffected?: number | null;
  lotOrSerial?: string | null;
}

export default function NcrDetail() {
  const { id: idParam } = useParams();
  const ncrId = Number(idParam);
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [ncr, setNcr] = useState<NcrDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<EditValues>();

  const [capas, setCapas] = useState<CapaSummary[]>([]);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(ncrId) || ncrId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      setNcr(await api.getNcr(ncrId));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [ncrId, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Open CAPAs, for the linker.
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listCapas({ pageSize: 100 });
        setCapas(res.items.filter((c) => c.status !== 'CLOSED'));
      } catch {
        setCapas([]);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !ncr) {
    return (
      <Empty description="Nonconformance not found">
        <Link to="/quality">Back to quality</Link>
      </Empty>
    );
  }

  const canEdit = user?.role !== 'VIEWER';
  const isClosed = ncr.status === 'CLOSED';
  const editable = canEdit && !isClosed;

  const transition = (action: 'contain' | 'close' | 'reopen', title: string, content: string) => {
    modal.confirm({
      title,
      content,
      okText: title,
      okButtonProps: action === 'reopen' ? { danger: true } : undefined,
      onOk: async () => {
        setActing(true);
        try {
          setNcr(await api.transitionNcr(ncr.id, action));
          message.success(`${ncr.ncrNumber} ${action === 'reopen' ? 'reopened' : `${action}ed`}`);
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

  const escalate = () => {
    modal.confirm({
      title: 'Raise an engineering change',
      content: `Create a draft ECN for ${ncr.part?.partNumber ?? 'this part'} and link it to ${ncr.ncrNumber}?`,
      okText: 'Raise ECN',
      onOk: async () => {
        setActing(true);
        try {
          const updated = await api.escalateNcrToEcn(ncr.id);
          setNcr(updated);
          message.success(`${updated.ecn?.ecnNumber ?? 'ECN'} created from ${updated.ncrNumber}`);
        } catch (err) {
          modal.error({
            title: 'Cannot raise an ECN',
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
        } finally {
          setActing(false);
        }
      },
    });
  };

  const openEdit = () => {
    setEditError(null);
    form.setFieldsValue({
      title: ncr.title,
      description: ncr.description,
      severity: ncr.severity,
      disposition: ncr.disposition,
      quantityAffected: ncr.quantityAffected,
      lotOrSerial: ncr.lotOrSerial,
    });
    setEditOpen(true);
  };

  const save = async () => {
    let values: EditValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      setNcr(
        await api.updateNcr(ncr.id, {
          title: values.title.trim(),
          description: values.description.trim(),
          severity: values.severity,
          disposition: values.disposition ?? null,
          quantityAffected: values.quantityAffected ?? null,
          lotOrSerial: values.lotOrSerial?.trim() ? values.lotOrSerial.trim() : null,
        })
      );
      setEditOpen(false);
      message.success('Nonconformance updated');
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const linkCapa = async (capaId: number | null) => {
    setLinking(true);
    try {
      setNcr(await api.updateNcr(ncr.id, { capaId }));
      message.success(capaId ? 'Linked to corrective action' : 'Unlinked');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLinking(false);
    }
  };

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space direction="vertical" size={4}>
            <Space size={12} wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {ncr.ncrNumber} — {ncr.title}
              </Typography.Title>
              <NcrStatusTag status={ncr.status} />
              <NcrSeverityTag severity={ncr.severity} />
            </Space>
            <Typography.Text type="secondary">
              Nonconformance report · raised by {ncr.createdBy.name} on {formatDate(ncr.createdAt)}
            </Typography.Text>
          </Space>
          {editable && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
          )}
        </div>

        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Affected part">
            {ncr.part ? (
              <Link to={`/parts/${ncr.part.id}`}>
                {ncr.part.partNumber} — {ncr.part.name}
              </Link>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Revision">
            {ncr.partRevision ? (
              <Space size={4}>
                <span>Rev {ncr.partRevision.revision}</span>
                <LifecycleTag lifecycle={ncr.partRevision.lifecycle} />
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Quantity affected">
            {ncr.quantityAffected ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Lot / serial">{ncr.lotOrSerial ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Disposition">
            {ncr.disposition ? ECN_DISPOSITION_META[ncr.disposition].label : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Engineering change">
            {ncr.ecn ? (
              <Space size={6}>
                <Link to={`/ecns/${ncr.ecn.id}`}>{ncr.ecn.ecnNumber}</Link>
                <EcnStatusTag status={ncr.ecn.status} />
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Closed">
            {ncr.closedAt ? `${formatDate(ncr.closedAt)} by ${ncr.closedBy?.name ?? '—'}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {ncr.description}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {canEdit && (
        <Card style={{ marginBottom: 16 }} styles={{ body: { display: 'flex', gap: 8, flexWrap: 'wrap' } }}>
          {ncr.status === 'OPEN' && (
            <Button
              icon={<SafetyOutlined />}
              loading={acting}
              onClick={() =>
                transition('contain', 'Contain', 'Mark this nonconformance as contained?')
              }
            >
              Contain
            </Button>
          )}
          {!isClosed && (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={acting}
              onClick={() =>
                transition('close', 'Close', 'Close this nonconformance? A disposition is required.')
              }
            >
              Close
            </Button>
          )}
          {isClosed && (
            <Button
              danger
              icon={<RedoOutlined />}
              loading={acting}
              onClick={() => transition('reopen', 'Reopen', 'Reopen this nonconformance?')}
            >
              Reopen
            </Button>
          )}
          {!ncr.ecn && ncr.part && !isClosed && (
            <Button icon={<SwapOutlined />} loading={acting} onClick={escalate}>
              Raise ECN from this NCR
            </Button>
          )}
        </Card>
      )}

      {!canEdit && (
        <ReadOnlyNotice>An engineer account is needed to act on this nonconformance.</ReadOnlyNotice>
      )}

      <Card title="Corrective action">
        {ncr.capa ? (
          <Space wrap>
            <Typography.Text>
              Linked to <Link to={`/capas/${ncr.capa.id}`}>{ncr.capa.capaNumber}</Link>
            </Typography.Text>
            {editable && (
              <Button size="small" loading={linking} onClick={() => void linkCapa(null)}>
                Unlink
              </Button>
            )}
          </Space>
        ) : editable ? (
          <Space wrap>
            <Typography.Text type="secondary">
              Link this nonconformance to a corrective action:
            </Typography.Text>
            <Select
              style={{ minWidth: 320 }}
              placeholder="Select an open CAPA"
              loading={linking}
              onChange={(v: number) => void linkCapa(v)}
              options={capas.map((c) => ({ value: c.id, label: `${c.capaNumber} — ${c.title}` }))}
              notFoundContent="No open corrective actions"
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">Not linked to a corrective action.</Typography.Text>
        )}
      </Card>

      <Modal
        title="Edit nonconformance"
        open={editOpen}
        onOk={() => void save()}
        okText="Save"
        confirmLoading={saving}
        onCancel={() => setEditOpen(false)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true }, { max: 200 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="severity" label="Severity" style={{ width: 160 }}>
              <Select options={NCR_SEVERITY_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="disposition"
              label="Disposition"
              tooltip="Required before the nonconformance can be closed"
              style={{ flex: 1 }}
            >
              <Select allowClear options={ECN_DISPOSITION_OPTIONS} placeholder="Not decided" />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="quantityAffected" label="Quantity affected" style={{ width: 180 }}>
              <InputNumber min={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="lotOrSerial" label="Lot / serial" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
