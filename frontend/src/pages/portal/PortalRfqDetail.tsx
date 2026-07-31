import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type { PortalRfqDetail as PortalRfq, PortalRfqLine } from '../../api/types';
import { formatDate, RfqStatusTag } from '../../components/meta';

interface QuoteValues {
  unitPrice: number;
  currency?: string;
  leadTimeDays?: number;
  moq?: number;
  notes?: string;
}

export default function PortalRfqDetail() {
  const { id } = useParams<{ id: string }>();
  const rfqId = Number(id);
  const { message } = AntdApp.useApp();

  const [rfq, setRfq] = useState<PortalRfq | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [quoting, setQuoting] = useState<PortalRfqLine | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<QuoteValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRfq(await api.portalGetRfq(rfqId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this request');
    } finally {
      setLoading(false);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openQuote = (line: PortalRfqLine) => {
    setQuoteError(null);
    form.resetFields();
    // Editing an existing quote starts from what they submitted before.
    form.setFieldsValue(
      line.myQuote
        ? {
            unitPrice: line.myQuote.unitPrice,
            currency: line.myQuote.currency,
            leadTimeDays: line.myQuote.leadTimeDays ?? undefined,
            moq: line.myQuote.moq ?? undefined,
            notes: line.myQuote.notes ?? undefined,
          }
        : { currency: 'USD' }
    );
    setQuoting(line);
  };

  const submitQuote = async () => {
    if (!quoting) return;
    let values: QuoteValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setQuoteError(null);
    try {
      setRfq(
        await api.portalSubmitQuote(quoting.id, {
          unitPrice: values.unitPrice,
          currency: values.currency?.trim() || undefined,
          leadTimeDays: values.leadTimeDays ?? undefined,
          moq: values.moq ?? undefined,
          notes: values.notes?.trim() || undefined,
        })
      );
      message.success('Quote submitted');
      setQuoting(null);
    } catch (err) {
      setQuoteError(err instanceof ApiError ? err.message : 'Could not submit the quote');
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (quoteId: number) => {
    setBusy(true);
    try {
      setRfq(await api.portalWithdrawQuote(quoteId));
      message.success('Quote withdrawn');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not withdraw the quote');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (loadError || !rfq) {
    return (
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <Alert type="error" showIcon message={loadError ?? 'Not found'} />
        <Link to="/portal">Back to requests</Link>
      </Space>
    );
  }

  const columns: ColumnsType<PortalRfqLine> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, line) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{line.part.partNumber}</Typography.Text>
          <Typography.Text type="secondary">{line.part.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Quantity',
      key: 'quantity',
      width: 120,
      align: 'right',
      render: (_, line) => `${line.quantity.toLocaleString()} ${line.part.uom}`,
    },
    {
      title: 'Your price',
      key: 'price',
      width: 150,
      align: 'right',
      render: (_, line) =>
        line.myQuote ? (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <Typography.Text strong>
              {line.myQuote.unitPrice.toLocaleString('en-US', {
                style: 'currency',
                currency: line.myQuote.currency,
              })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {line.myQuote.extendedPrice.toLocaleString('en-US', {
                style: 'currency',
                currency: line.myQuote.currency,
              })}{' '}
              total
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">not quoted</Typography.Text>
        ),
    },
    {
      title: 'Lead time',
      key: 'lead',
      width: 110,
      align: 'right',
      render: (_, line) =>
        line.myQuote?.leadTimeDays === null || line.myQuote === null
          ? '—'
          : `${line.myQuote.leadTimeDays} d`,
    },
    {
      title: 'Outcome',
      key: 'outcome',
      width: 150,
      render: (_, line) =>
        !line.awarded ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : line.awardedToMe ? (
          <Tag color="green">Awarded to you</Tag>
        ) : (
          // Deliberately does not name who won.
          <Tag>Awarded elsewhere</Tag>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_, line) =>
        rfq.open && !line.awarded ? (
          <Space size={4}>
            <Button size="small" type="primary" onClick={() => openQuote(line)} disabled={busy}>
              {line.myQuote ? 'Update quote' : 'Submit quote'}
            </Button>
            {line.myQuote && (
              <Popconfirm
                title="Withdraw this quote?"
                onConfirm={() => void withdraw(line.myQuote!.id)}
              >
                <Button size="small" danger type="text" disabled={busy}>
                  Withdraw
                </Button>
              </Popconfirm>
            )}
          </Space>
        ) : null,
    },
  ];

  return (
    <div>
      <Link to="/portal">← Back to requests</Link>

      <Card style={{ marginTop: 12, marginBottom: 16 }}>
        <Space size={10} wrap align="center">
          <Typography.Title level={3} style={{ margin: 0 }}>
            {rfq.rfqNumber} — {rfq.title}
          </Typography.Title>
          <RfqStatusTag status={rfq.status} />
        </Space>
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label="Quotes due">{formatDate(rfq.dueDate)}</Descriptions.Item>
          <Descriptions.Item label="Received">{formatDate(rfq.sentAt)}</Descriptions.Item>
          <Descriptions.Item label="Lines">{rfq.lines.length}</Descriptions.Item>
          {rfq.description && (
            <Descriptions.Item label="Scope" span={3}>
              {rfq.description}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {!rfq.open && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="This request is no longer accepting quotes"
          description="You can still see what you submitted."
        />
      )}

      <Card title="Lines">
        <Table<PortalRfqLine>
          size="middle"
          rowKey="id"
          columns={columns}
          dataSource={rfq.lines}
          pagination={false}
        />
      </Card>

      <Modal
        title={quoting ? `Quote for ${quoting.part.partNumber}` : 'Quote'}
        open={quoting !== null}
        onOk={() => void submitQuote()}
        okText="Submit"
        confirmLoading={saving}
        onCancel={() => setQuoting(null)}
        forceRender
      >
        {quoteError && (
          <Alert type="error" showIcon message={quoteError} style={{ marginBottom: 16 }} />
        )}
        {quoting && (
          <Typography.Paragraph type="secondary">
            {quoting.part.name} · quantity {quoting.quantity.toLocaleString()} {quoting.part.uom}
          </Typography.Paragraph>
        )}
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="unitPrice"
              label="Unit price"
              style={{ width: 160 }}
              rules={[{ required: true, message: 'Enter your unit price' }]}
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
            <Input.TextArea rows={3} placeholder="Tooling, validity, payment terms" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
