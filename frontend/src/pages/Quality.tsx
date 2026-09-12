import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  CapaStatus,
  CapaSummary,
  NcrSeverity,
  NcrStatus,
  NcrSummary,
  PartRef,
  UserSummary,
} from '../api/types';
import {
  CAPA_STATUS_OPTIONS,
  CapaStatusTag,
  ECN_DISPOSITION_META,
  formatDate,
  NCR_SEVERITY_OPTIONS,
  NCR_STATUS_OPTIONS,
  NcrSeverityTag,
  NcrStatusTag,
} from '../components/meta';

interface NcrFormValues {
  title: string;
  description: string;
  severity: NcrSeverity;
  partId?: number;
  quantityAffected?: number;
  lotOrSerial?: string;
}

interface CapaFormValues {
  title: string;
  problem: string;
  ownerId: number;
  dueDate?: Dayjs | null;
}

export default function Quality() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  // ---- nonconformances -----------------------------------------------------
  const [ncrs, setNcrs] = useState<NcrSummary[]>([]);
  const [ncrTotal, setNcrTotal] = useState(0);
  const [ncrLoading, setNcrLoading] = useState(false);
  const [ncrPage, setNcrPage] = useState(1);
  const [ncrPageSize, setNcrPageSize] = useState(20);
  const [ncrStatus, setNcrStatus] = useState<NcrStatus | undefined>(undefined);
  const [ncrSearch, setNcrSearch] = useState('');
  const ncrReq = useRef(0);

  const loadNcrs = useCallback(async () => {
    const id = ++ncrReq.current;
    setNcrLoading(true);
    try {
      const res = await api.listNcrs({
        status: ncrStatus,
        search: ncrSearch || undefined,
        page: ncrPage,
        pageSize: ncrPageSize,
      });
      if (ncrReq.current !== id) return; // a newer request has superseded this one
      setNcrs(res.items);
      setNcrTotal(res.total);
    } catch (err) {
      if (ncrReq.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (ncrReq.current === id) setNcrLoading(false);
    }
  }, [ncrStatus, ncrSearch, ncrPage, ncrPageSize, message]);

  useEffect(() => {
    void loadNcrs();
  }, [loadNcrs]);

  // ---- corrective actions --------------------------------------------------
  const [capas, setCapas] = useState<CapaSummary[]>([]);
  const [capaTotal, setCapaTotal] = useState(0);
  const [capaLoading, setCapaLoading] = useState(false);
  const [capaPage, setCapaPage] = useState(1);
  const [capaPageSize, setCapaPageSize] = useState(20);
  const [capaStatus, setCapaStatus] = useState<CapaStatus | undefined>(undefined);
  const capaReq = useRef(0);

  const loadCapas = useCallback(async () => {
    const id = ++capaReq.current;
    setCapaLoading(true);
    try {
      const res = await api.listCapas({ status: capaStatus, page: capaPage, pageSize: capaPageSize });
      if (capaReq.current !== id) return;
      setCapas(res.items);
      setCapaTotal(res.total);
    } catch (err) {
      if (capaReq.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (capaReq.current === id) setCapaLoading(false);
    }
  }, [capaStatus, capaPage, capaPageSize, message]);

  useEffect(() => {
    void loadCapas();
  }, [loadCapas]);

  // ---- create NCR ----------------------------------------------------------
  const [ncrOpen, setNcrOpen] = useState(false);
  const [ncrError, setNcrError] = useState<string | null>(null);
  const [ncrSaving, setNcrSaving] = useState(false);
  const [ncrForm] = Form.useForm<NcrFormValues>();
  const [partOptions, setPartOptions] = useState<PartRef[]>([]);
  const [partLoading, setPartLoading] = useState(false);
  const partTimer = useRef<number | undefined>(undefined);

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
    window.clearTimeout(partTimer.current);
    partTimer.current = window.setTimeout(() => void fetchParts(value), 300);
  };

  useEffect(() => () => window.clearTimeout(partTimer.current), []);

  const openNcr = () => {
    setNcrError(null);
    ncrForm.resetFields();
    ncrForm.setFieldsValue({ severity: 'MINOR' });
    void fetchParts('');
    setNcrOpen(true);
  };

  const saveNcr = async () => {
    let values: NcrFormValues;
    try {
      values = await ncrForm.validateFields();
    } catch {
      return;
    }
    setNcrSaving(true);
    setNcrError(null);
    try {
      const created = await api.createNcr({
        title: values.title.trim(),
        description: values.description.trim(),
        severity: values.severity,
        partId: values.partId,
        quantityAffected: values.quantityAffected ?? undefined,
        lotOrSerial: values.lotOrSerial?.trim() || undefined,
      });
      message.success(`${created.ncrNumber} raised`);
      setNcrOpen(false);
      navigate(`/ncrs/${created.id}`);
    } catch (err) {
      setNcrError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setNcrSaving(false);
    }
  };

  // ---- create CAPA ---------------------------------------------------------
  const [capaOpen, setCapaOpen] = useState(false);
  const [capaError, setCapaError] = useState<string | null>(null);
  const [capaSaving, setCapaSaving] = useState(false);
  const [capaForm] = Form.useForm<CapaFormValues>();
  const [users, setUsers] = useState<UserSummary[]>([]);

  const openCapa = () => {
    setCapaError(null);
    capaForm.resetFields();
    setCapaOpen(true);
    void (async () => {
      try {
        setUsers(await api.listUsers());
      } catch {
        setUsers([]);
      }
    })();
  };

  const saveCapa = async () => {
    let values: CapaFormValues;
    try {
      values = await capaForm.validateFields();
    } catch {
      return;
    }
    setCapaSaving(true);
    setCapaError(null);
    try {
      const created = await api.createCapa({
        title: values.title.trim(),
        problem: values.problem.trim(),
        ownerId: values.ownerId,
        dueDate: values.dueDate ? values.dueDate.toISOString() : undefined,
      });
      message.success(`${created.capaNumber} created`);
      setCapaOpen(false);
      navigate(`/capas/${created.id}`);
    } catch (err) {
      setCapaError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCapaSaving(false);
    }
  };

  // ---- columns -------------------------------------------------------------
  const ncrColumns: ColumnsType<NcrSummary> = [
    {
      title: 'NCR #',
      key: 'ncrNumber',
      width: 130,
      render: (_, r) => <Link to={`/ncrs/${r.id}`}>{r.ncrNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Part',
      key: 'part',
      width: 150,
      render: (_, r) => (r.part ? <Link to={`/parts/${r.part.id}`}>{r.part.partNumber}</Link> : '—'),
    },
    {
      title: 'Severity',
      key: 'severity',
      width: 110,
      render: (_, r) => <NcrSeverityTag severity={r.severity} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => <NcrStatusTag status={r.status} />,
    },
    {
      title: 'Disposition',
      key: 'disposition',
      width: 140,
      render: (_, r) => (r.disposition ? ECN_DISPOSITION_META[r.disposition].label : '—'),
    },
    {
      title: 'CAPA',
      key: 'capa',
      width: 120,
      render: (_, r) => (r.capa ? <Link to={`/capas/${r.capa.id}`}>{r.capa.capaNumber}</Link> : '—'),
    },
    { title: 'Raised', key: 'createdAt', width: 150, render: (_, r) => formatDate(r.createdAt) },
  ];

  const capaColumns: ColumnsType<CapaSummary> = [
    {
      title: 'CAPA #',
      key: 'capaNumber',
      width: 130,
      render: (_, r) => <Link to={`/capas/${r.id}`}>{r.capaNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, r) => <CapaStatusTag status={r.status} />,
    },
    { title: 'Owner', key: 'owner', width: 150, render: (_, r) => r.owner.name },
    {
      title: 'Linked NCRs',
      dataIndex: 'ncrCount',
      key: 'ncrCount',
      width: 120,
      align: 'right',
    },
    { title: 'Due', key: 'dueDate', width: 150, render: (_, r) => formatDate(r.dueDate) },
    { title: 'Created', key: 'createdAt', width: 150, render: (_, r) => formatDate(r.createdAt) },
  ];

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        Quality
      </Typography.Title>

      <Tabs
        defaultActiveKey="ncrs"
        items={[
          {
            key: 'ncrs',
            label: 'Nonconformances',
            children: (
              <>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    marginBottom: 16,
                  }}
                >
                  <Space wrap>
                    <Input.Search
                      placeholder="Search number or title"
                      allowClear
                      style={{ width: 260 }}
                      onSearch={(v) => {
                        setNcrSearch(v.trim());
                        setNcrPage(1);
                      }}
                    />
                    <Select
                      placeholder="Status"
                      allowClear
                      style={{ width: 160 }}
                      options={NCR_STATUS_OPTIONS}
                      value={ncrStatus}
                      onChange={(v) => {
                        setNcrStatus(v);
                        setNcrPage(1);
                      }}
                    />
                  </Space>
                  {canEdit && (
                    <Button type="primary" icon={<PlusOutlined />} onClick={openNcr}>
                      Raise NCR
                    </Button>
                  )}
                </div>
                <Table<NcrSummary>
                  size="middle"
                  rowKey="id"
                  columns={ncrColumns}
                  dataSource={ncrs}
                  loading={ncrLoading}
                  pagination={{
                    current: ncrPage,
                    pageSize: ncrPageSize,
                    total: ncrTotal,
                    showSizeChanger: true,
                    showTotal: (t) => `${t} nonconformances`,
                    onChange: (p, size) => {
                      setNcrPage(size !== ncrPageSize ? 1 : p);
                      setNcrPageSize(size);
                    },
                  }}
                />
              </>
            ),
          },
          {
            key: 'capas',
            label: 'Corrective actions',
            children: (
              <>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    marginBottom: 16,
                  }}
                >
                  <Select
                    placeholder="Status"
                    allowClear
                    style={{ width: 180 }}
                    options={CAPA_STATUS_OPTIONS}
                    value={capaStatus}
                    onChange={(v) => {
                      setCapaStatus(v);
                      setCapaPage(1);
                    }}
                  />
                  {canEdit && (
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCapa}>
                      New CAPA
                    </Button>
                  )}
                </div>
                <Table<CapaSummary>
                  size="middle"
                  rowKey="id"
                  columns={capaColumns}
                  dataSource={capas}
                  loading={capaLoading}
                  pagination={{
                    current: capaPage,
                    pageSize: capaPageSize,
                    total: capaTotal,
                    showSizeChanger: true,
                    showTotal: (t) => `${t} corrective actions`,
                    onChange: (p, size) => {
                      setCapaPage(size !== capaPageSize ? 1 : p);
                      setCapaPageSize(size);
                    },
                  }}
                />
              </>
            ),
          },
        ]}
      />

      <Modal
        title="Raise a nonconformance"
        open={ncrOpen}
        onOk={() => void saveNcr()}
        okText="Raise"
        confirmLoading={ncrSaving}
        onCancel={() => setNcrOpen(false)}
        forceRender
      >
        {ncrError && <Alert type="error" showIcon message={ncrError} style={{ marginBottom: 16 }} />}
        <Form form={ncrForm} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[{ required: true, message: 'Title is required' }, { max: 200 }]}
          >
            <Input placeholder="What was found?" />
          </Form.Item>
          <Form.Item
            name="description"
            label="Description"
            rules={[{ required: true, message: 'Describe the nonconformance' }]}
          >
            <Input.TextArea rows={3} placeholder="What is wrong, where was it detected?" />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="severity" label="Severity" style={{ width: 170 }}>
              <Select options={NCR_SEVERITY_OPTIONS} />
            </Form.Item>
            <Form.Item name="quantityAffected" label="Quantity affected" style={{ width: 170 }}>
              <InputNumber min={0.001} style={{ width: '100%' }} placeholder="optional" />
            </Form.Item>
            <Form.Item name="lotOrSerial" label="Lot / serial" style={{ flex: 1 }}>
              <Input placeholder="optional" />
            </Form.Item>
          </Space>
          <Form.Item name="partId" label="Affected part" tooltip="Required to raise an ECN later">
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
        title="New corrective action"
        open={capaOpen}
        onOk={() => void saveCapa()}
        okText="Create"
        confirmLoading={capaSaving}
        onCancel={() => setCapaOpen(false)}
        forceRender
      >
        {capaError && (
          <Alert type="error" showIcon message={capaError} style={{ marginBottom: 16 }} />
        )}
        <Form form={capaForm} layout="vertical">
          <Form.Item
            name="title"
            label="Title"
            rules={[{ required: true, message: 'Title is required' }, { max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="problem"
            label="Problem statement"
            rules={[{ required: true, message: 'Describe the problem' }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="ownerId"
              label="Owner"
              rules={[{ required: true, message: 'Select an owner' }]}
              style={{ flex: 1 }}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
            </Form.Item>
            <Form.Item name="dueDate" label="Due date" style={{ width: 190 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
