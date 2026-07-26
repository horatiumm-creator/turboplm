import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
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
  UploadOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  DocumentCategory,
  DocumentDetail as DocumentDetailDto,
  DocumentLinkDetail,
  DocumentVersionDetail,
} from '../api/types';
import { DOC_CATEGORY_OPTIONS, DocCategoryTag, formatBytes, formatDate } from '../components/meta';
import { isPreviewable } from '../components/cad/preview';

const CadViewer = lazy(() => import('../components/cad/CadViewer'));

interface EditFormValues {
  title: string;
  category: DocumentCategory;
  description?: string;
}

interface VersionFormValues {
  file?: UploadFile[];
  note?: string;
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

  // New version modal
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionSaving, setVersionSaving] = useState(false);
  const [versionForm] = Form.useForm<VersionFormValues>();

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

      {previewVersion && (
        <Card
          title="Preview"
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
          {isPreviewable(previewVersion.fileName) ? (
            <Suspense
              fallback={
                <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                  <Spin tip="Loading viewer…" />
                </div>
              }
            >
              <CadViewer
                key={previewVersion.id}
                fileUrl={api.documentVersionFileUrl(previewVersion.id, true)}
                fileName={previewVersion.fileName}
                height={480}
              />
            </Suspense>
          ) : (
            <Typography.Text type="secondary">
              No preview for {previewVersion.fileName} — supported: STEP, IGES, BREP, STL,
              glTF/GLB, OBJ, 3MF, PDF and images. Export a neutral format (e.g. STEP) from
              CATIA / SolidWorks / NX to preview it here.
            </Typography.Text>
          )}
        </Card>
      )}

      <Card
        title="Versions"
        style={{ marginBottom: 16 }}
        extra={
          canEdit && (
            <Button icon={<UploadOutlined />} onClick={openVersion}>
              Upload new version
            </Button>
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
    </div>
  );
}
