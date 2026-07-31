import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SafetyOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  SignatureManifest,
  SignatureManifestEntry,
  SignatureMeaning,
  SignedEntityType,
} from '../api/types';
import { formatDate, MEANING_META, SIGNATURE_STATUS_META } from './meta';

interface SignFormValues {
  password?: string;
  confirmEmail?: string;
  comment?: string;
}

export default function SignaturePanel({
  entityType,
  entityId,
  /** Bumped by the parent after any change to the signed content, so the panel refetches. */
  refreshKey = 0,
  onSigned,
}: {
  entityType: SignedEntityType;
  entityId: number;
  refreshKey?: number;
  onSigned?: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  // SSO-only accounts have no password, so they confirm identity by retyping their address.
  const usesPassword = user?.provider !== 'GOOGLE';

  const [manifest, setManifest] = useState<SignatureManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<SignatureMeaning | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SignFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setManifest(await api.getSignatureManifest(entityType, entityId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not load signatures');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, message]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submit = async () => {
    if (!signing) return;
    let values: SignFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setSignError(null);
    try {
      const refreshed = await api.signEntity(entityType, entityId, {
        meaning: signing,
        password: usesPassword ? values.password : undefined,
        confirmEmail: usesPassword ? undefined : values.confirmEmail,
        comment: values.comment?.trim() || undefined,
      });
      setManifest(refreshed);
      message.success(`Signed as ${MEANING_META[signing].label}`);
      setSigning(null);
      onSigned?.();
    } catch (err) {
      setSignError(err instanceof ApiError ? err.message : 'Could not sign');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<SignatureManifestEntry> = [
    {
      title: 'Step',
      key: 'seq',
      width: 70,
      render: (_, entry) => entry.requirement.seq,
    },
    {
      title: 'Meaning',
      key: 'meaning',
      width: 150,
      render: (_, entry) => {
        const meta = MEANING_META[entry.requirement.meaning];
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Who may sign',
      key: 'who',
      width: 170,
      render: (_, entry) =>
        entry.requirement.user ? (
          entry.requirement.user.name
        ) : (
          <Typography.Text type="secondary">any {entry.requirement.role}</Typography.Text>
        ),
    },
    {
      title: 'Signed by',
      key: 'signedBy',
      render: (_, entry) =>
        entry.signature ? (
          <Space direction="vertical" size={0}>
            {/* Printed name, meaning and timestamp together — Part 11 §11.50. */}
            <Typography.Text>{entry.signature.signedName}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {entry.signature.signedRole} · {formatDate(entry.signature.signedAt)}
            </Typography.Text>
            {entry.signature.comment && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} italic>
                “{entry.signature.comment}”
              </Typography.Text>
            )}
          </Space>
        ) : (
          <Typography.Text type="secondary">not signed</Typography.Text>
        ),
    },
    {
      title: 'Method',
      key: 'method',
      width: 130,
      render: (_, entry) =>
        entry.signature ? (
          <Tooltip
            title={
              entry.signature.authMethod === 'PASSWORD'
                ? 'Password re-entered at signing'
                : 'Identity confirmed by retyping the account email (SSO account)'
            }
          >
            <Tag>{entry.signature.authMethod === 'PASSWORD' ? 'Password' : 'SSO confirm'}</Tag>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: '',
      key: 'action',
      width: 110,
      render: (_, entry) =>
        entry.signature ? (
          <Tag color="green">Signed</Tag>
        ) : entry.canSign ? (
          <Button
            size="small"
            type="primary"
            icon={<SafetyOutlined />}
            onClick={() => {
              setSignError(null);
              form.resetFields();
              setSigning(entry.requirement.meaning);
            }}
          >
            Sign
          </Button>
        ) : (
          <Tooltip title="You do not hold the role this step requires">
            <Tag>Pending</Tag>
          </Tooltip>
        ),
    },
  ];

  if (loading && !manifest) {
    return (
      <Card title="Signatures" style={{ marginBottom: 16 }}>
        <Skeleton active />
      </Card>
    );
  }
  if (!manifest) return null;

  // Nothing configured for this entity type: the whole feature is opt-in, so say so
  // quietly rather than showing an empty table.
  if (manifest.entries.length === 0 && manifest.history.length === 0) {
    return null;
  }

  const voided = manifest.history.filter((signature) => signature.status === 'VOIDED');

  return (
    <Card
      title={
        <Space size={8}>
          <span>Signatures</span>
          {manifest.complete ? (
            <Tag color="green">Complete</Tag>
          ) : (
            <Tag color="gold">{manifest.outstanding.length} outstanding</Tag>
          )}
        </Space>
      }
      style={{ marginBottom: 16 }}
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          content {manifest.contentHash.slice(0, 12)}
        </Typography.Text>
      }
    >
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        {!manifest.complete && (
          <Alert
            type="info"
            showIcon
            message={`Cannot be released until signed: ${manifest.outstanding
              .map((meaning) => MEANING_META[meaning].label)
              .join(', ')}`}
          />
        )}

        <Table<SignatureManifestEntry>
          size="small"
          rowKey={(entry) => entry.requirement.id}
          columns={columns}
          dataSource={manifest.entries}
          pagination={false}
        />

        {voided.length > 0 && (
          <>
            <Typography.Text strong>Voided signatures</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              Kept as part of the record: each of these was valid when executed, and stopped
              applying when the signed content changed.
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={voided}
              columns={[
                {
                  title: 'Meaning',
                  key: 'meaning',
                  width: 150,
                  render: (_, row) => MEANING_META[row.meaning].label,
                },
                {
                  title: 'Signed by',
                  key: 'by',
                  render: (_, row) => (
                    <Typography.Text delete>
                      {row.signedName} ({row.signedRole})
                    </Typography.Text>
                  ),
                },
                {
                  title: 'Signed',
                  key: 'at',
                  width: 150,
                  render: (_, row) => formatDate(row.signedAt),
                },
                {
                  title: 'Status',
                  key: 'status',
                  width: 220,
                  render: (_, row) => (
                    <Space size={6}>
                      <Tag color={SIGNATURE_STATUS_META[row.status].color}>
                        {SIGNATURE_STATUS_META[row.status].label}
                      </Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.voidedReason}
                      </Typography.Text>
                    </Space>
                  ),
                },
              ]}
            />
          </>
        )}
      </Space>

      <Modal
        title={signing ? `Sign as ${MEANING_META[signing].label}` : 'Sign'}
        open={signing !== null}
        onOk={() => void submit()}
        okText="Sign"
        confirmLoading={saving}
        onCancel={() => setSigning(null)}
        forceRender
      >
        {signError && <Alert type="error" showIcon message={signError} style={{ marginBottom: 16 }} />}
        <Alert
          type="info"
          showIcon
          message="This is a legally binding electronic signature"
          description={
            signing
              ? `You are signing ${manifest.label} to certify: ${MEANING_META[signing].hint}`
              : undefined
          }
          style={{ marginBottom: 16 }}
        />
        <Form form={form} layout="vertical">
          {usesPassword ? (
            <Form.Item
              name="password"
              label="Your password"
              tooltip="Re-entered at signing time, as an electronic signature requires"
              rules={[{ required: true, message: 'Re-enter your password to sign' }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
          ) : (
            <Form.Item
              name="confirmEmail"
              label="Retype your email address"
              tooltip="Your account signs in through SSO and has no password, so this confirms your identity"
              rules={[{ required: true, message: 'Retype your email address to sign' }]}
            >
              <Input placeholder={user?.email} autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item name="comment" label="Comment (optional)">
            <Input.TextArea rows={2} placeholder="What you checked, or any conditions" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
