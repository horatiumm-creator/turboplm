import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { RfqInvitation, RfqStatus, SupplierSummary } from '../api/types';
import { formatDate } from './meta';

export default function RfqInvitationsCard({
  rfqId,
  rfqStatus,
  editable,
}: {
  rfqId: number;
  rfqStatus: RfqStatus;
  editable: boolean;
}) {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<RfqInvitation[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number | undefined>(undefined);

  // Invitations may only be added while the RFQ can still gather quotes.
  const canInvite = editable && (rfqStatus === 'DRAFT' || rfqStatus === 'SENT');

  const load = useCallback(async () => {
    try {
      const [invitations, supplierList] = await Promise.all([
        api.listRfqInvitations(rfqId),
        api.listSuppliers().catch(() => []),
      ]);
      setRows(invitations);
      setSuppliers(supplierList.filter((s) => s.active));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load invitations');
    } finally {
      setLoading(false);
    }
  }, [rfqId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const created = await api.inviteSupplier(rfqId, picked);
      setRows((prev) => [...prev, created]);
      setPicked(undefined);
      message.success(`${created.supplier.name} invited`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not invite');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: RfqInvitation) => {
    setBusy(true);
    try {
      await api.revokeInvitation(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      message.success('Invitation revoked');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  };

  const invitedIds = new Set(rows.map((row) => row.supplier.id));

  const columns: ColumnsType<RfqInvitation> = [
    {
      title: 'Supplier',
      key: 'supplier',
      render: (_, row) => (
        <Space size={6}>
          <span>{row.supplier.name}</span>
          <Typography.Text type="secondary">{row.supplier.code}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Portal access',
      key: 'accounts',
      width: 170,
      render: (_, row) =>
        row.activeAccounts > 0 ? (
          <Tag color="green">
            {row.activeAccounts} account{row.activeAccounts === 1 ? '' : 's'}
          </Tag>
        ) : (
          // Without an account the invitation cannot actually be acted on.
          <Tooltip title="Add a portal account for this supplier on the Suppliers page">
            <Tag color="orange">No portal account</Tag>
          </Tooltip>
        ),
    },
    {
      title: 'Responded',
      key: 'responded',
      width: 170,
      render: (_, row) =>
        row.respondedAt ? (
          <Space direction="vertical" size={0}>
            <Tag color="green">Quoted</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDate(row.respondedAt)}
            </Typography.Text>
          </Space>
        ) : (
          <Tag>Awaiting</Tag>
        ),
    },
    { title: 'Invited', key: 'invitedAt', width: 150, render: (_, row) => formatDate(row.invitedAt) },
    ...(editable
      ? [
          {
            title: '',
            key: 'actions',
            width: 60,
            render: (_: unknown, row: RfqInvitation) => (
              <Popconfirm title="Revoke this invitation?" onConfirm={() => void revoke(row)}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={busy} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card
      title="Suppliers invited"
      style={{ marginTop: 16 }}
      extra={
        canInvite && (
          <Space>
            <Select
              placeholder="Choose a supplier"
              style={{ width: 260 }}
              value={picked}
              onChange={setPicked}
              showSearch
              optionFilterProp="label"
              options={suppliers
                .filter((s) => !invitedIds.has(s.id))
                .map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!picked || busy}
              onClick={() => void invite()}
            >
              Invite
            </Button>
          </Space>
        )
      }
    >
      {rfqStatus === 'DRAFT' && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Invited suppliers see this RFQ only once it is sent"
        />
      )}
      <Table<RfqInvitation>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No suppliers invited yet' }}
      />
    </Card>
  );
}
