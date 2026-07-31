import { useCallback, useEffect, useState } from 'react';
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
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  DisconnectOutlined,
  DownloadOutlined,
  EditOutlined,
  ImportOutlined,
  KeyOutlined,
  LockOutlined,
  UnlockOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import ItemAccessCard from '../components/ItemAccessCard';
import { useAuth } from '../auth/AuthContext';
import type {
  DocumentCategory,
  DocumentDetail as DocumentDetailDto,
  DocumentLinkDetail,
  DocumentVersionDetail,
} from '../api/types';
import {
  ConversionStatusTag,
  DOC_CATEGORY_OPTIONS,
  DocCategoryTag,
  DocumentLockTag,
  formatBytes,
  formatDate,
  lockReason,
} from '../components/meta';
import { isConvertible } from '../components/cad/preview';
import DocumentMarkupPanel from '../components/DocumentMarkupPanel';

interface EditFormValues {
  title: string;
  category: DocumentCategory;
  description?: string;
}

interface VersionFormValues {
  file?: UploadFile[];
  note?: string;
}

interface CheckoutFormValues {
  note?: string;
}

interface BreakLockFormValues {
  reason: string;
}

const normFile = (e: { fileList: UploadFile[] }) => e?.fileList;

const LINK_TYPE_LABEL: Record<DocumentLinkDetail['target']['type'], string> = {
  PART: 'Part',
  REVISION: 'Revision',
  ECN: 'ECN',
};

export default function DocumentDetail() {
  const { id: idParam } = useParams();
  const docId = Number(idParam);
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [doc, setDoc] = useState<DocumentDetailDto | null>(null);
  const [previewVersionId, setPreviewVersionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  /** revision id → owning part id, for building /parts/:id?rev= links. */
  const [revPartMap, setRevPartMap] = useState<Record<number, number>>({});

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<EditFormValues>();

  // CAD derivative re-conversion
  const [converting, setConverting] = useState(false);

  // New version modal
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionSaving, setVersionSaving] = useState(false);
  const [versionForm] = Form.useForm<VersionFormValues>();

  // Vault: check-out, check-in, cancel, break-lock (rules D1-D3)
  const [lockBusy, setLockBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutSaving, setCheckoutSaving] = useState(false);
  const [checkoutForm] = Form.useForm<CheckoutFormValues>();
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const [checkinSaving, setCheckinSaving] = useState(false);
  const [checkinForm] = Form.useForm<VersionFormValues>();
  const [breakOpen, setBreakOpen] = useState(false);
  const [breakError, setBreakError] = useState<string | null>(null);
  const [breakSaving, setBreakSaving] = useState(false);
  const [breakForm] = Form.useForm<BreakLockFormValues>();

  const load = useCallback(async () => {
    if (!Number.isInteger(docId) || docId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const detail = await api.getDocument(docId);
      setDoc(detail);
      setNotFound(false);
      const revisionIds = detail.links
        .filter((link) => link.target.type === 'REVISION')
        .map((link) => link.target.id);
      if (revisionIds.length > 0) {
        const pairs = await Promise.all(
          revisionIds.map(async (revisionId) => {
            try {
              const revision = await api.getRevision(revisionId);
              return [revisionId, revision.partId] as const;
            } catch {
              return null;
            }
          })
        );
        const map: Record<number, number> = {};
        for (const pair of pairs) if (pair) map[pair[0]] = pair[1];
        setRevPartMap(map);
      } else {
        setRevPartMap({});
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [docId, message]);

  useEffect(() => {
    setDoc(null);
    setLoading(true);
    void load();
  }, [load]);

  // Conversion runs out-of-process after the upload responds, so poll while any
  // version is still PENDING and stop as soon as they all settle.
  const pendingConversion = doc?.versions.some((v) => v.conversionStatus === 'PENDING') ?? false;
  useEffect(() => {
    if (!pendingConversion) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [pendingConversion, load]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !doc) {
    return (
      <Empty description="Document not found">
        <Link to="/documents">Back to documents</Link>
      </Empty>
    );
  }

  const canEdit = user?.role !== 'VIEWER';
  const previewVersion =
    doc.versions.find((v) => v.id === previewVersionId) ?? doc.latestVersion ?? null;
  const canDelete =
    user !== null &&
    user.role !== 'VIEWER' &&
    (user.role === 'ADMIN' || user.id === doc.createdBy.id);

  // Rule D1/D2 — the vault. `isMine` outranks expiry everywhere a write is gated: the server
  // keys check-in and upload on whom the row names, and an expired lock only means somebody
  // else *may* take it. Expiry does open the lock up, so it also decides who may check out.
  const lock = doc.lock;
  const lockIsMine = lock !== null && lock.isMine;
  const lockTakeable = lock === null || lock.expired;
  const heldByOther = lock !== null && !lock.isMine && !lock.expired;
  /** Non-null exactly when the version upload would be refused, and says why (rule D3). */
  const uploadBlocked = lockReason(lock, doc.docNumber);

  const convertVersion = async (versionId: number) => {
    setConverting(true);
    try {
      const updated = await api.convertDocumentVersion(versionId);
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              versions: prev.versions.map((v) => (v.id === updated.id ? updated : v)),
              latestVersion:
                prev.latestVersion?.id === updated.id ? updated : prev.latestVersion,
            }
          : prev
      );
      if (updated.conversionStatus === 'DONE') message.success('Derivative generated');
      else message.warning(updated.conversionError ?? 'Conversion did not produce geometry');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setConverting(false);
    }
  };

  const openEdit = () => {
    setEditError(null);
    editForm.setFieldsValue({
      title: doc.title,
      category: doc.category,
      description: doc.description ?? undefined,
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
      const updated = await api.updateDocument(doc.id, {
        title: values.title.trim(),
        category: values.category,
        description: values.description?.trim() ? values.description.trim() : null,
      });
      setDoc(updated);
      setEditOpen(false);
      message.success('Document updated');
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  const deleteDoc = () => {
    modal.confirm({
      title: 'Delete document',
      content: `Delete ${doc.docNumber} — ${doc.title}? All versions and links will be removed. This cannot be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteDocument(doc.id);
          message.success('Document deleted');
          navigate('/documents');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const openVersion = () => {
    setVersionError(null);
    versionForm.resetFields();
    setVersionOpen(true);
  };

  const saveVersion = async () => {
    let values: VersionFormValues;
    try {
      values = await versionForm.validateFields();
    } catch {
      return;
    }
    const file = values.file?.[0]?.originFileObj;
    if (!file) {
      setVersionError('Choose a file to upload');
      return;
    }
    setVersionSaving(true);
    setVersionError(null);
    try {
      const updated = await api.addDocumentVersion(doc.id, file, values.note?.trim() || undefined);
      setDoc(updated);
      setVersionOpen(false);
      message.success('New version uploaded');
    } catch (err) {
      setVersionError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setVersionSaving(false);
    }
  };

  // ---- vault (rules D1-D3) -------------------------------------------------

  const openCheckout = () => {
    setCheckoutError(null);
    checkoutForm.resetFields();
    setCheckoutOpen(true);
  };

  const saveCheckout = async () => {
    let values: CheckoutFormValues;
    try {
      values = await checkoutForm.validateFields();
    } catch {
      return;
    }
    setCheckoutSaving(true);
    setCheckoutError(null);
    // Taken before the call: once it returns, the lock names the caller, so the only place the
    // previous holder is still known is the state we are replacing. Rule D1 says taking an
    // expired lock is never silent.
    const previous = doc.lock;
    try {
      const updated = await api.checkoutDocument(doc.id, values.note?.trim() || undefined);
      setDoc(updated);
      setCheckoutOpen(false);
      if (previous && !previous.isMine) {
        message.warning(`Took over ${previous.user.name}'s expired check-out of ${updated.docNumber}`);
      } else {
        message.success(`${updated.docNumber} checked out`);
      }
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCheckoutSaving(false);
    }
  };

  const cancelCheckout = () => {
    modal.confirm({
      title: 'Cancel check-out',
      content: `Release the lock on ${doc.docNumber} without producing a version? Anything edited outside the vault is not recorded.`,
      okText: 'Cancel check-out',
      okButtonProps: { danger: true },
      onOk: async () => {
        setLockBusy(true);
        try {
          const updated = await api.cancelDocumentCheckout(doc.id);
          setDoc(updated);
          message.success(`${updated.docNumber} released`);
        } catch (err) {
          // "not checked out by you", "changed concurrently" — the server's wording explains
          // itself, and the reload below pulls the bar back in sync.
          modal.error({
            title: 'Could not cancel the check-out',
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        } finally {
          setLockBusy(false);
        }
      },
    });
  };

  const openCheckin = () => {
    setCheckinError(null);
    checkinForm.resetFields();
    setCheckinOpen(true);
  };

  const saveCheckin = async () => {
    let values: VersionFormValues;
    try {
      values = await checkinForm.validateFields();
    } catch {
      return;
    }
    const file = values.file?.[0]?.originFileObj;
    if (!file) {
      setCheckinError('Choose a file to check in');
      return;
    }
    setCheckinSaving(true);
    setCheckinError(null);
    try {
      const updated = await api.checkinDocument(doc.id, file, values.note?.trim() || undefined);
      setDoc(updated);
      setCheckinOpen(false);
      message.success(`${updated.docNumber} checked in as v${updated.latestVersion?.version ?? '?'}`);
    } catch (err) {
      setCheckinError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCheckinSaving(false);
    }
  };

  const openBreakLock = () => {
    setBreakError(null);
    breakForm.resetFields();
    setBreakOpen(true);
  };

  const saveBreakLock = async () => {
    let values: BreakLockFormValues;
    try {
      values = await breakForm.validateFields();
    } catch {
      return;
    }
    setBreakSaving(true);
    setBreakError(null);
    const previous = doc.lock;
    try {
      const updated = await api.breakDocumentLock(doc.id, values.reason.trim());
      setDoc(updated);
      setBreakOpen(false);
      message.success(
        previous ? `${previous.user.name}'s lock was broken` : 'The lock was released'
      );
    } catch (err) {
      setBreakError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBreakSaving(false);
    }
  };

  const removeLink = (link: DocumentLinkDetail) => {
    modal.confirm({
      title: 'Remove link',
      content: `Remove the link to ${link.target.label}? The document itself is kept.`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.removeDocumentLink(link.id);
          message.success('Link removed');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const targetPath = (target: DocumentLinkDetail['target']): string | null => {
    if (target.type === 'PART') return `/parts/${target.id}`;
    if (target.type === 'ECN') return `/ecns/${target.id}`;
    const partId = revPartMap[target.id];
    return partId !== undefined ? `/parts/${partId}?rev=${target.id}` : null;
  };

  const versionColumns: ColumnsType<DocumentVersionDetail> = [
    {
      title: 'Version',
      key: 'version',
      width: 90,
      render: (_, v) => <Tag>v{v.version}</Tag>,
    },
    {
      title: 'File',
      dataIndex: 'fileName',
      key: 'fileName',
      ellipsis: true,
    },
    {
      title: 'Size',
      key: 'size',
      width: 100,
      align: 'right',
      render: (_, v) => formatBytes(v.sizeBytes),
    },
    {
      title: 'CAD',
      key: 'conversion',
      width: 160,
      render: (_, v) =>
        isConvertible(v.fileName) ? <ConversionStatusTag status={v.conversionStatus} /> : '—',
    },
    {
      title: 'Note',
      key: 'note',
      ellipsis: true,
      render: (_, v) => v.note ?? '—',
    },
    {
      title: 'Uploaded by',
      key: 'uploadedBy',
      width: 140,
      render: (_, v) => v.uploadedBy.name,
    },
    {
      title: 'Uploaded',
      key: 'createdAt',
      width: 150,
      render: (_, v) => formatDate(v.createdAt),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_, v) => (
        <Button
          type="link"
          size="small"
          icon={<DownloadOutlined />}
          href={api.documentVersionFileUrl(v.id)}
        >
          Download
        </Button>
      ),
    },
  ];

  const linkColumns: ColumnsType<DocumentLinkDetail> = [
    {
      title: 'Type',
      key: 'type',
      width: 110,
      render: (_, link) => <Tag>{LINK_TYPE_LABEL[link.target.type]}</Tag>,
    },
    {
      title: 'Linked to',
      key: 'label',
      render: (_, link) => {
        const path = targetPath(link.target);
        return path ? (
          <Link to={path}>{link.target.label}</Link>
        ) : (
          <Typography.Text>{link.target.label}</Typography.Text>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, link) =>
        canEdit ? (
          <Button
            type="link"
            size="small"
            danger
            icon={<DisconnectOutlined />}
            onClick={() => removeLink(link)}
          >
            Remove
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

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
                {doc.docNumber} — {doc.title}
              </Typography.Title>
              <DocCategoryTag category={doc.category} />
            </Space>
            <Typography.Text type="secondary">
              Document · {doc.versionCount} version{doc.versionCount === 1 ? '' : 's'}
            </Typography.Text>
          </Space>
          <Space>
            {canEdit && (
              <Button icon={<EditOutlined />} onClick={openEdit}>
                Edit
              </Button>
            )}
            {canDelete && (
              <Button danger icon={<DeleteOutlined />} onClick={deleteDoc}>
                Delete
              </Button>
            )}
          </Space>
        </div>
        <Descriptions size="middle" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="Created by">{doc.createdBy.name}</Descriptions.Item>
          <Descriptions.Item label="Created">{formatDate(doc.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="Latest file">
            {doc.latestVersion
              ? `${doc.latestVersion.fileName} (${formatBytes(doc.latestVersion.sizeBytes)})`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {doc.description ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Space size={12} wrap>
            <DocumentLockTag lock={lock} />
            <Typography.Text type="secondary">
              {lock === null
                ? 'Nobody holds this document — check it out to reserve the next version.'
                : lock.isMine
                  ? `You checked it out ${formatDate(lock.lockedAt)}${
                      lock.expiresAt
                        ? `${lock.expired ? ', lapsed ' : ', expires '}${formatDate(lock.expiresAt)}`
                        : ''
                    }.`
                  : `Checked out by ${lock.user.name} since ${formatDate(lock.lockedAt)}${
                      lock.expired ? ' — the lock has lapsed, so anyone may take it' : ''
                    }.`}
            </Typography.Text>
            {lock?.note && (
              <Typography.Text italic type="secondary">
                “{lock.note}”
              </Typography.Text>
            )}
          </Space>
          <Space wrap>
            {canEdit && lockIsMine && (
              <Button type="primary" icon={<ImportOutlined />} onClick={openCheckin}>
                Check in
              </Button>
            )}
            {canEdit && lockTakeable && (
              <Button
                type={lockIsMine ? 'default' : 'primary'}
                icon={<LockOutlined />}
                onClick={openCheckout}
              >
                {lockIsMine ? 'Refresh check-out' : 'Check out'}
              </Button>
            )}
            {canEdit && lockIsMine && (
              <Button icon={<UnlockOutlined />} loading={lockBusy} onClick={cancelCheckout}>
                Cancel check-out
              </Button>
            )}
            {heldByOther && user?.role === 'ADMIN' && (
              <Button danger icon={<KeyOutlined />} onClick={openBreakLock}>
                Break lock
              </Button>
            )}
            {heldByOther && user?.role !== 'ADMIN' && (
              <Typography.Text type="secondary">
                An administrator can break the lock if it is blocking you.
              </Typography.Text>
            )}
          </Space>
        </div>
        {!canEdit && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="Read-only access — a Viewer can read the vault state but not check documents out."
          />
        )}
      </Card>

      {previewVersion && (
        <Card
          title="Preview & design review"
          style={{ marginBottom: 16 }}
          extra={
            doc.versions.length > 1 && (
              <Select
                size="small"
                style={{ minWidth: 220 }}
                value={previewVersion.id}
                onChange={(value: number) => setPreviewVersionId(value)}
                options={doc.versions.map((v) => ({
                  value: v.id,
                  label: `v${v.version} — ${v.fileName}`,
                }))}
              />
            )
          }
        >
          {isConvertible(previewVersion.fileName) && (
            <Space wrap size={12} style={{ marginBottom: 12 }}>
              <ConversionStatusTag status={previewVersion.conversionStatus} />
              {previewVersion.triangleCount !== null && (
                <Typography.Text type="secondary">
                  {previewVersion.triangleCount.toLocaleString()} triangles
                </Typography.Text>
              )}
              {previewVersion.boundingBox && (
                <Typography.Text type="secondary">
                  {previewVersion.boundingBox.size.map((n) => n.toFixed(1)).join(' × ')} mm
                </Typography.Text>
              )}
              {previewVersion.conversionError && (
                <Typography.Text type="danger">{previewVersion.conversionError}</Typography.Text>
              )}
              {canEdit &&
                (previewVersion.conversionStatus === 'SKIPPED' ||
                  previewVersion.conversionStatus === 'FAILED') && (
                  <Button
                    size="small"
                    loading={converting}
                    onClick={() => void convertVersion(previewVersion.id)}
                  >
                    Convert now
                  </Button>
                )}
            </Space>
          )}
          {/*
            The viewer is composed inside the markup panel (rule K4) rather than rendered here:
            two viewers on one page would download the same geometry twice, and the overlay has
            to sit on the element that actually renders it.
          */}
          <DocumentMarkupPanel
            key={previewVersion.id}
            version={previewVersion}
            readOnly={!canEdit}
          />
        </Card>
      )}

      <Card
        title="Versions"
        style={{ marginBottom: 16 }}
        extra={
          canEdit && (
            <Space>
              {/*
                Rule D3 — the control is disabled with the reason in a tooltip rather than
                letting the user pick a file and then fail on the 409.
              */}
              <Tooltip title={uploadBlocked ?? ''}>
                {/* A disabled antd Button swallows mouse events, so the span carries the hover. */}
                <span>
                  <Button
                    icon={<UploadOutlined />}
                    disabled={uploadBlocked !== null}
                    onClick={openVersion}
                  >
                    Upload new version
                  </Button>
                </span>
              </Tooltip>
              {lockIsMine && (
                <Button icon={<ImportOutlined />} onClick={openCheckin}>
                  Check in
                </Button>
              )}
            </Space>
          )
        }
      >
        <Table<DocumentVersionDetail>
          size="middle"
          rowKey="id"
          columns={versionColumns}
          dataSource={doc.versions}
          pagination={false}
        />
      </Card>

      <Card title="Linked to">
        {doc.links.length === 0 ? (
          <Typography.Text type="secondary">
            Not linked to any part, revision or ECN. Attach it from a part, revision or ECN page.
          </Typography.Text>
        ) : (
          <Table<DocumentLinkDetail>
            size="middle"
            rowKey="id"
            columns={linkColumns}
            dataSource={doc.links}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title="Edit document"
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
              { required: true, message: 'Title is required' },
              { max: 200, message: 'At most 200 characters' },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="category"
            label="Category"
            rules={[{ required: true, message: 'Category is required' }]}
          >
            <Select options={DOC_CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Upload new version"
        open={versionOpen}
        onOk={() => void saveVersion()}
        okText="Upload"
        confirmLoading={versionSaving}
        onCancel={() => setVersionOpen(false)}
        forceRender
      >
        {versionError && (
          <Alert type="error" showIcon message={versionError} style={{ marginBottom: 16 }} />
        )}
        <Form form={versionForm} layout="vertical">
          <Form.Item
            name="file"
            label="File"
            valuePropName="fileList"
            getValueFromEvent={normFile}
            rules={[{ required: true, message: 'Choose a file' }]}
          >
            <Upload beforeUpload={() => false} maxCount={1}>
              <Button icon={<UploadOutlined />}>Choose file</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="note" label="Version note">
            <Input.TextArea rows={2} placeholder="What changed in this version? (optional)" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={lockIsMine ? 'Refresh your check-out' : `Check out ${doc.docNumber}`}
        open={checkoutOpen}
        onOk={() => void saveCheckout()}
        okText={lockIsMine ? 'Refresh' : 'Check out'}
        confirmLoading={checkoutSaving}
        onCancel={() => setCheckoutOpen(false)}
        forceRender
      >
        {checkoutError && (
          <Alert type="error" showIcon message={checkoutError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          A check-out reserves the right to produce the next version. It lapses after seven days,
          after which anyone may take it.
        </Typography.Paragraph>
        <Form form={checkoutForm} layout="vertical">
          <Form.Item name="note" label="Note" tooltip="Tells colleagues what you are editing">
            <Input.TextArea rows={2} placeholder="Reworking the mounting holes (optional)" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`Check in ${doc.docNumber}`}
        open={checkinOpen}
        onOk={() => void saveCheckin()}
        okText="Check in"
        confirmLoading={checkinSaving}
        onCancel={() => setCheckinOpen(false)}
        forceRender
      >
        {checkinError && (
          <Alert type="error" showIcon message={checkinError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          The file becomes v{(doc.latestVersion?.version ?? 0) + 1} and the lock is released in the
          same transaction.
        </Typography.Paragraph>
        <Form form={checkinForm} layout="vertical">
          <Form.Item
            name="file"
            label="File"
            valuePropName="fileList"
            getValueFromEvent={normFile}
            rules={[{ required: true, message: 'Choose a file' }]}
          >
            <Upload beforeUpload={() => false} maxCount={1}>
              <Button icon={<UploadOutlined />}>Choose file</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="note" label="Version note">
            <Input.TextArea rows={2} placeholder="What changed in this version? (optional)" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Break the lock"
        open={breakOpen}
        onOk={() => void saveBreakLock()}
        okText="Break lock"
        okButtonProps={{ danger: true }}
        confirmLoading={breakSaving}
        onCancel={() => setBreakOpen(false)}
        forceRender
      >
        {breakError && (
          <Alert type="error" showIcon message={breakError} style={{ marginBottom: 16 }} />
        )}
        <Typography.Paragraph type="secondary">
          {lock
            ? `${lock.user.name} is holding ${doc.docNumber}. Breaking the lock notifies them and the reason is kept with the document.`
            : 'The document is not locked.'}
        </Typography.Paragraph>
        <Form form={breakForm} layout="vertical">
          <Form.Item
            name="reason"
            label="Reason"
            rules={[
              { required: true, message: 'A reason is required — the audit trail must explain itself' },
              { max: 1000, message: 'At most 1000 characters' },
            ]}
          >
            <Input.TextArea rows={3} placeholder="Why the lock has to go" />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 16 }}>
        <ItemAccessCard entityType="DOCUMENT" entityId={doc.id} />
      </div>
    </div>
  );
}
