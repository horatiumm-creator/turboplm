import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SendOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  PartRef,
  RfqDetail as RfqDetailData,
  RfqLineDetail,
  RfqQuoteDetail,
  SupplierSummary,
} from '../api/types';
import { formatDate, formatMoney, RfqStatusTag } from '../components/meta';
import RfqInvitationsCard from '../components/RfqInvitationsCard';

interface RfqFormValues {
  title: string;
  description?: string;
  dueDate?: Dayjs | null;
}

interface LineFormValues {
  partId: number;
  quantity: number;
  targetPrice?: number;
  notes?: string;
}

interface QuoteFormValues {
  supplierId: number;
  unitPrice: number;
  currency?: string;
  leadTimeDays?: number;
  moq?: number;
  notes?: string;
}

export default function RfqDetail() {
  const { id } = useParams<{ id: string }>();
  const rfqId = Number(id);
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [rfq, setRfq] = useState<RfqDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRfq(await api.getRfq(rfqId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setSuppliers(await api.listSuppliers());
      } catch {
        setSuppliers([]);
      }
    })();
  }, []);

  // Mutating endpoints return the whole RFQ, so one setter keeps the page in sync.
  const apply = async (action: () => Promise<RfqDetailData>, success: string) => {
    setBusy(true);
    try {
      setRfq(await action());
      message.success(success);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const removeAndReload = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      setRfq(await api.getRfq(rfqId));
      message.success(success);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  // ---- edit header ---------------------------------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<RfqFormValues>();

  const openEdit = () => {
    if (!rfq) return;
    setEditError(null);
    editForm.setFieldsValue({
      title: rfq.title,
      description: rfq.description ?? undefined,
      dueDate: rfq.dueDate ? dayjs(rfq.dueDate) : null,
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    let values: RfqFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      setRfq(
        await api.updateRfq(rfqId, {
          title: values.title.trim(),
          description: values.description?.trim() || null,
          dueDate: values.dueDate ? values.dueDate.toISOString() : null,
        })
      );
      message.success('RFQ updated');
      setEditOpen(false);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  // ---- add line ------------------------------------------------------------
  const [lineOpen, setLineOpen] = useState(false);
  const [lineError, setLineError] = useState<string | null>(null);
  const [lineSaving, setLineSaving] = useState(false);
  const [lineForm] = Form.useForm<LineFormValues>();
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

  useEffect(() => () => window.clearTimeout(partTimer.current), []);

  const openLine = () => {
    setLineError(null);
    lineForm.resetFields();
    lineForm.setFieldsValue({ quantity: 100 });
    void fetchParts('');
    setLineOpen(true);
  };

  const saveLine = async () => {
    let values: LineFormValues;
    try {
      values = await lineForm.validateFields();
    } catch {
      return;
    }
    setLineSaving(true);
    setLineError(null);
    try {
      setRfq(
        await api.addRfqLine(rfqId, {
          partId: values.partId,
          quantity: values.quantity,
          targetPrice: values.targetPrice ?? undefined,
          notes: values.notes?.trim() || undefined,
        })
      );
      message.success('Line added');
      setLineOpen(false);
    } catch (err) {
      setLineError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLineSaving(false);
    }
  };

  // ---- record quote --------------------------------------------------------
  const [quoteLine, setQuoteLine] = useState<RfqLineDetail | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteForm] = Form.useForm<QuoteFormValues>();

  const openQuote = (line: RfqLineDetail) => {
    setQuoteError(null);
    quoteForm.resetFields();
    quoteForm.setFieldsValue({ currency: 'USD' });
    setQuoteLine(line);
  };

  const saveQuote = async () => {
    if (!quoteLine) return;
    let values: QuoteFormValues;
    try {
      values = await quoteForm.validateFields();
    } catch {
      return;
    }
    setQuoteSaving(true);
    setQuoteError(null);
    try {
      setRfq(
        await api.addQuote(quoteLine.id, {
          supplierId: values.supplierId,
          unitPrice: values.unitPrice,
          currency: values.currency?.trim() || undefined,
          leadTimeDays: values.leadTimeDays ?? undefined,
          moq: values.moq ?? undefined,
          notes: values.notes?.trim() || undefined,
        })
      );
      message.success('Quote recorded');
      setQuoteLine(null);
    } catch (err) {
      setQuoteError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setQuoteSaving(false);
    }
  };

  const activeSupplierOptions = useMemo(
    () =>
      suppliers
        .filter((s) => s.active)
        .map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })),
    [suppliers]
  );

  // ---- quote comparison ----------------------------------------------------
  const quoteColumns = (line: RfqLineDetail): ColumnsType<RfqQuoteDetail> => [
    {
      title: 'Supplier',
      key: 'supplier',
      render: (_, q) => (
        <Space size={6} wrap>
          <span>{q.supplier.name}</span>
          <Typography.Text type="secondary">{q.supplier.code}</Typography.Text>
          {q.isLowest && <Tag color="green">lowest</Tag>}
          {line.awardedSupplier?.id === q.supplier.id && <Tag color="gold">awarded</Tag>}
        </Space>
      ),
    },
    {
      title: 'Unit price',
      key: 'unitPrice',
      width: 130,
      align: 'right',
      render: (_, q) => (
        <Typography.Text strong={q.isLowest}>
          {q.unitPrice.toLocaleString('en-US', { style: 'currency', currency: q.currency })}
        </Typography.Text>
      ),
    },
    {
      title: `Extended (×${line.quantity})`,
      key: 'extendedPrice',
      width: 150,
      align: 'right',
      render: (_, q) =>
        q.extendedPrice.toLocaleString('en-US', { style: 'currency', currency: q.currency }),
    },
    {
      title: 'Lead time',
      key: 'leadTimeDays',
      width: 110,
      align: 'right',
      render: (_, q) => (q.leadTimeDays === null ? '—' : `${q.leadTimeDays} d`),
    },
    {
      title: 'MOQ',
      key: 'moq',
      width: 90,
      align: 'right',
      render: (_, q) => (q.moq === null ? '—' : q.moq.toLocaleString()),
    },
    { title: 'Notes', key: 'notes', ellipsis: true, render: (_, q) => q.notes ?? '—' },
    ...(canEdit
      ? [
          {
            title: '',
            key: 'actions',
            width: 130,
            render: (_: unknown, q: RfqQuoteDetail) => (
              <Space size={4}>
                {!line.awardedSupplier && (
                  <Button
                    type="link"
                    size="small"
                    icon={<TrophyOutlined />}
                    disabled={busy}
                    onClick={() =>
                      void apply(
                        () => api.awardRfqLine(line.id, q.supplier.id),
                        `${line.part.partNumber} awarded to ${q.supplier.name}`
                      )
                    }
                  >
                    Award
                  </Button>
                )}
                {!line.awardedSupplier && (
                  <Popconfirm
                    title="Delete this quote?"
                    onConfirm={() =>
                      void removeAndReload(() => api.deleteQuote(q.id), 'Quote deleted')
                    }
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (loadError || !rfq) {
    return <Alert type="error" showIcon message={loadError ?? 'RFQ not found'} />;
  }

  const isDraft = rfq.status === 'DRAFT';
  const quotable = rfq.status === 'SENT' || rfq.status === 'CLOSED';
  const awardedLines = rfq.lines.filter((l) => l.awardedSupplier).length;

  const lineColumns: ColumnsType<RfqLineDetail> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, l) => (
        <Space direction="vertical" size={0}>
          <Link to={`/parts/${l.part.id}`}>{l.part.partNumber}</Link>
          <Typography.Text type="secondary">{l.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      render: (_, l) => l.quantity.toLocaleString(),
    },
    {
      title: 'Target price',
      key: 'targetPrice',
      width: 130,
      align: 'right',
      render: (_, l) => formatMoney(l.targetPrice),
    },
    {
      title: 'Quotes',
      key: 'quotes',
      width: 100,
      align: 'right',
      render: (_, l) => l.quotes.length,
    },
    {
      title: 'Best price',
      key: 'best',
      width: 130,
      align: 'right',
      render: (_, l) => {
        const lowest = l.quotes.find((q) => q.isLowest);
        if (!lowest) return <Typography.Text type="secondary">—</Typography.Text>;
        return lowest.unitPrice.toLocaleString('en-US', {
          style: 'currency',
          currency: lowest.currency,
        });
      },
    },
    {
      title: 'Awarded',
      key: 'awarded',
      width: 200,
      render: (_, l) =>
        l.awardedSupplier ? (
          <Space direction="vertical" size={0}>
            <Tag color="gold">{l.awardedSupplier.name}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDate(l.awardedAt)}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    ...(canEdit
      ? [
          {
            title: '',
            key: 'actions',
            width: 150,
            render: (_: unknown, l: RfqLineDetail) => (
              <Space size={4}>
                {quotable && (
                  <Button type="link" size="small" onClick={() => openQuote(l)}>
                    Add quote
                  </Button>
                )}
                {isDraft && (
                  <Popconfirm
                    title="Remove this line?"
                    onConfirm={() =>
                      void removeAndReload(() => api.deleteRfqLine(l.id), 'Line removed')
                    }
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          message="Read-only access — you can browse this RFQ but not change it."
          style={{ marginBottom: 16 }}
        />
      )}

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
          <div>
            <Space size={10} wrap align="center">
              <Typography.Title level={3} style={{ margin: 0 }}>
                {rfq.rfqNumber} — {rfq.title}
              </Typography.Title>
              <RfqStatusTag status={rfq.status} />
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4 }}>
              Request for quote · raised by {rfq.createdBy.name} on {formatDate(rfq.createdAt)}
            </Typography.Paragraph>
          </div>
          {canEdit && isDraft && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit
            </Button>
          )}
        </div>

        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }} size="small">
          <Descriptions.Item label="Quotes due">{formatDate(rfq.dueDate)}</Descriptions.Item>
          <Descriptions.Item label="Sent">{formatDate(rfq.sentAt)}</Descriptions.Item>
          <Descriptions.Item label="Closed">{formatDate(rfq.closedAt)}</Descriptions.Item>
          <Descriptions.Item label="Lines">{rfq.lineCount}</Descriptions.Item>
          <Descriptions.Item label="Quotes received">{rfq.quoteCount}</Descriptions.Item>
          <Descriptions.Item label="Lines awarded">
            {awardedLines}/{rfq.lineCount}
          </Descriptions.Item>
          {rfq.description && (
            <Descriptions.Item label="Description" span={3}>
              {rfq.description}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {canEdit && (rfq.status === 'DRAFT' || rfq.status === 'SENT' || rfq.status === 'CLOSED') && (
        <Card style={{ marginBottom: 16 }}>
          <Space wrap>
            {isDraft && (
              <Tooltip title={rfq.lines.length === 0 ? 'Add at least one line first' : undefined}>
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  disabled={busy || rfq.lines.length === 0}
                  onClick={() =>
                    void apply(() => api.transitionRfq(rfqId, 'send'), 'RFQ sent to suppliers')
                  }
                >
                  Send to suppliers
                </Button>
              </Tooltip>
            )}
            {rfq.status === 'SENT' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void apply(() => api.transitionRfq(rfqId, 'close'), 'Quoting closed')
                }
              >
                Close for quotes
              </Button>
            )}
            <Popconfirm
              title="Cancel this RFQ?"
              description="Cancelling is final — the RFQ can no longer be sent or awarded."
              onConfirm={() =>
                void apply(() => api.transitionRfq(rfqId, 'cancel'), 'RFQ cancelled')
              }
            >
              <Button danger disabled={busy}>
                Cancel RFQ
              </Button>
            </Popconfirm>
          </Space>
        </Card>
      )}

      <Card
        title="Lines"
        extra={
          canEdit &&
          isDraft && (
            <Button size="small" icon={<PlusOutlined />} onClick={openLine}>
              Add line
            </Button>
          )
        }
      >
        <Table<RfqLineDetail>
          size="middle"
          rowKey="id"
          columns={lineColumns}
          dataSource={rfq.lines}
          pagination={false}
          locale={{ emptyText: isDraft ? 'Add the parts you want quoted' : 'No lines' }}
          expandable={{
            // Quote comparison lives in the row expansion so the line list stays scannable.
            rowExpandable: (l) => l.quotes.length > 0,
            expandedRowRender: (l) => (
              <Table<RfqQuoteDetail>
                size="small"
                rowKey="id"
                columns={quoteColumns(l)}
                dataSource={l.quotes}
                pagination={false}
                rowClassName={(q) => (q.isLowest ? 'rfq-quote-lowest' : '')}
              />
            ),
          }}
        />
      </Card>

      <RfqInvitationsCard rfqId={rfq.id} rfqStatus={rfq.status} editable={canEdit} />

      <Modal
        title="Edit RFQ"
        open={editOpen}
        onOk={() => void saveEdit()}
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
            rules={[{ required: true, message: 'Title is required' }, { max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="dueDate" label="Quotes due">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Add line"
        open={lineOpen}
        onOk={() => void saveLine()}
        okText="Add"
        confirmLoading={lineSaving}
        onCancel={() => setLineOpen(false)}
        forceRender
      >
        {lineError && (
          <Alert type="error" showIcon message={lineError} style={{ marginBottom: 16 }} />
        )}
        <Form form={lineForm} layout="vertical">
          <Form.Item
            name="partId"
            label="Part"
            rules={[{ required: true, message: 'Select a part' }]}
          >
            <Select
              showSearch
              placeholder="Search by part number or name"
              filterOption={false}
              loading={partLoading}
              onSearch={(v) => {
                window.clearTimeout(partTimer.current);
                partTimer.current = window.setTimeout(() => void fetchParts(v), 300);
              }}
              options={partOptions.map((p) => ({
                value: p.id,
                label: `${p.partNumber} — ${p.name}`,
              }))}
              notFoundContent={partLoading ? 'Searching…' : 'No parts found'}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="quantity"
              label="Quantity"
              style={{ width: 180 }}
              rules={[{ required: true, message: 'Quantity is required' }]}
            >
              <InputNumber min={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="targetPrice" label="Target unit price" style={{ width: 180 }}>
              <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="optional" />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} placeholder="Finish, packaging, tolerances" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={quoteLine ? `Record a quote for ${quoteLine.part.partNumber}` : 'Record a quote'}
        open={quoteLine !== null}
        onOk={() => void saveQuote()}
        okText="Record"
        confirmLoading={quoteSaving}
        onCancel={() => setQuoteLine(null)}
        forceRender
      >
        {quoteError && (
          <Alert type="error" showIcon message={quoteError} style={{ marginBottom: 16 }} />
        )}
        {activeSupplierOptions.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message="No active suppliers yet — add one on the Suppliers page first."
            style={{ marginBottom: 16 }}
          />
        )}
        <Form form={quoteForm} layout="vertical">
          <Form.Item
            name="supplierId"
            label="Supplier"
            rules={[{ required: true, message: 'Select a supplier' }]}
          >
            <Select showSearch optionFilterProp="label" options={activeSupplierOptions} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="unitPrice"
              label="Unit price"
              style={{ width: 150 }}
              rules={[{ required: true, message: 'Unit price is required' }]}
            >
              <InputNumber min={0.0001} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="currency" label="Currency" style={{ width: 110 }}>
              <Input maxLength={3} />
            </Form.Item>
            <Form.Item name="leadTimeDays" label="Lead time (days)" style={{ width: 150 }}>
              <InputNumber min={0} style={{ width: '100%' }} placeholder="optional" />
            </Form.Item>
            <Form.Item name="moq" label="MOQ" style={{ width: 120 }}>
              <InputNumber min={0} style={{ width: '100%' }} placeholder="optional" />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} placeholder="Tooling, validity, terms" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
