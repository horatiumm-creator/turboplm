import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Spin,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DisconnectOutlined,
  DownloadOutlined,
  EyeOutlined,
  LinkOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { DocumentCategory, DocumentSummary, EntityDocument } from '../api/types';
import { DOC_CATEGORY_OPTIONS, DocCategoryTag, formatBytes } from './meta';
import { isPreviewable } from './cad/preview';

const CadViewer = lazy(() => import('./cad/CadViewer'));

// ---- Shared "upload a new document" modal (also used by the /documents list page) ----

export interface DocumentUploadInput {
  file: File;
  title: string;
  category: DocumentCategory;
  description?: string;
}

interface UploadFormValues {
  file?: UploadFile[];
  title: string;
  category: DocumentCategory;
  description?: string;
}

const normFile = (e: { fileList: UploadFile[] }) => e?.fileList;

export function DocumentUploadModal(props: {
  open: boolean;
  modalTitle: string;
  okText?: string;
  onClose: () => void;
  /** Throwing an ApiError keeps the modal open and surfaces the message. */
  onSubmit: (input: DocumentUploadInput) => Promise<void>;
}) {
  const [form] = Form.useForm<UploadFormValues>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.open) {
      form.resetFields();
      setError(null);
    }
  }, [props.open, form]);

  const handleOk = async () => {
    let values: UploadFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const file = values.file?.[0]?.originFileObj;
    if (!file) {
      setError('Choose a file to upload');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onSubmit({
        file,
        title: values.title.trim(),
        category: values.category,
        description: values.description?.trim() || undefined,
      });
      props.onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={props.modalTitle}
      open={props.open}
      onOk={() => void handleOk()}
      okText={props.okText ?? 'Upload'}
      confirmLoading={saving}
      onCancel={props.onClose}
      forceRender
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical">
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
        <Form.Item
          name="title"
          label="Title"
          rules={[
            { required: true, message: 'Title is required' },
            { max: 200, message: 'At most 200 characters' },
          ]}
        >
          <Input placeholder="Document title" />
        </Form.Item>
        <Form.Item
          name="category"
          label="Category"
          initialValue="OTHER"
          rules={[{ required: true, message: 'Category is required' }]}
        >
          <Select options={DOC_CATEGORY_OPTIONS} />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={2} placeholder="What is this document? (optional)" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---- Documents card, reusable on parts, revisions and ECNs ----

export default function DocumentsCard(props: {
  title?: string;
  partId?: number;
  revisionId?: number;
  ecnId?: number; // exactly one of partId / revisionId / ecnId is set
  editable: boolean;
}) {
  const { partId, revisionId, ecnId, editable } = props;
  const { message, modal } = AntdApp.useApp();

  const [docs, setDocs] = useState<EntityDocument[]>([]);
  const [loading, setLoading] = useState(true);

  // Attach-existing modal
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachSaving, setAttachSaving] = useState(false);
  const [attachDocId, setAttachDocId] = useState<number | undefined>(undefined);
  const [docOptions, setDocOptions] = useState<DocumentSummary[]>([]);
  const [docSearchLoading, setDocSearchLoading] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);

  // Upload-new modal
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState<{
    versionId: number;
    fileName: string;
    title: string;
  } | null>(null);

  const entityName = partId !== undefined ? 'part' : revisionId !== undefined ? 'revision' : 'ECN';

  const linkTarget = useCallback(
    () =>
      partId !== undefined
        ? { partId }
        : revisionId !== undefined
          ? { partRevisionId: revisionId }
          : { ecnId },
    [partId, revisionId, ecnId]
  );

  const load = useCallback(async () => {
    try {
      let res: EntityDocument[] = [];
      if (partId !== undefined) res = await api.getPartDocuments(partId);
      else if (revisionId !== undefined) res = await api.getRevisionDocuments(revisionId);
      else if (ecnId !== undefined) res = await api.getEcnDocuments(ecnId);
      setDocs(res);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [partId, revisionId, ecnId, message]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimer.current);
    };
  }, []);

  const fetchDocOptions = useCallback(async (search: string) => {
    setDocSearchLoading(true);
    try {
      const res = await api.listDocuments({ search: search || undefined, pageSize: 20 });
      setDocOptions(res.items);
    } catch {
      setDocOptions([]);
    } finally {
      setDocSearchLoading(false);
    }
  }, []);

  const handleDocSearch = (value: string) => {
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void fetchDocOptions(value);
    }, 300);
  };

  const openAttach = () => {
    setAttachError(null);
    setAttachDocId(undefined);
    void fetchDocOptions('');
    setAttachOpen(true);
  };

  const saveAttach = async () => {
    if (attachDocId === undefined) {
      setAttachError('Select a document');
      return;
    }
    setAttachSaving(true);
    setAttachError(null);
    try {
      await api.addDocumentLink(attachDocId, linkTarget());
      message.success('Document attached');
      setAttachOpen(false);
      await load();
    } catch (err) {
      // Surfaces 409s like "Document is already linked to this target".
      setAttachError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setAttachSaving(false);
    }
  };

  const handleUpload = async (input: DocumentUploadInput) => {
    const created = await api.createDocument(input);
    await api.addDocumentLink(created.id, linkTarget());
    message.success(`${created.docNumber} uploaded and attached`);
    await load();
  };

  const unlink = (entry: EntityDocument) => {
    modal.confirm({
      title: 'Unlink document',
      content: `Remove ${entry.document.docNumber} — ${entry.document.title} from this ${entityName}? The document itself is kept.`,
      okText: 'Unlink',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.removeDocumentLink(entry.linkId);
          message.success('Document unlinked');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const columns: ColumnsType<EntityDocument> = [
    {
      title: 'Document #',
      key: 'docNumber',
      width: 130,
      render: (_, entry) => (
        <Link to={`/documents/${entry.document.id}`}>{entry.document.docNumber}</Link>
      ),
    },
    {
      title: 'Title',
      key: 'title',
      ellipsis: true,
      render: (_, entry) => entry.document.title,
    },
    {
      title: 'Category',
      key: 'category',
      width: 130,
      render: (_, entry) => <DocCategoryTag category={entry.document.category} />,
    },
    {
      title: 'Latest version',
      key: 'latest',
      render: (_, entry) =>
        entry.document.latestVersion ? (
          <Space size={8} wrap>
            <Tag>v{entry.document.latestVersion.version}</Tag>
            <Typography.Text>{entry.document.latestVersion.fileName}</Typography.Text>
            <Typography.Text type="secondary">
              {formatBytes(entry.document.latestVersion.sizeBytes)}
            </Typography.Text>
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: editable ? 210 : 130,
      render: (_, entry) => (
        <Space size={0} wrap>
          {entry.document.latestVersion && isPreviewable(entry.document.latestVersion.fileName) && (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() =>
                setPreview({
                  versionId: entry.document.latestVersion!.id,
                  fileName: entry.document.latestVersion!.fileName,
                  title: `${entry.document.docNumber} — ${entry.document.title}`,
                })
              }
            >
              View
            </Button>
          )}
          {entry.document.latestVersion && (
            <Button
              type="link"
              size="small"
              icon={<DownloadOutlined />}
              href={api.documentVersionFileUrl(entry.document.latestVersion.id)}
            >
              Download
            </Button>
          )}
          {editable && (
            <Button
              type="link"
              size="small"
              danger
              icon={<DisconnectOutlined />}
              onClick={() => unlink(entry)}
            >
              Unlink
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={props.title ?? 'Documents'}
      extra={
        editable && (
          <Space>
            <Button icon={<LinkOutlined />} onClick={openAttach}>
              Attach existing
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
              Upload new
            </Button>
          </Space>
        )
      }
    >
      {!loading && docs.length === 0 ? (
        <Typography.Text type="secondary">
          No documents attached to this {entityName}.
        </Typography.Text>
      ) : (
        <Table<EntityDocument>
          size="middle"
          rowKey="linkId"
          loading={loading}
          columns={columns}
          dataSource={docs}
          pagination={false}
        />
      )}

      <Modal
        title="Attach existing document"
        open={attachOpen}
        onOk={() => void saveAttach()}
        okText="Attach"
        confirmLoading={attachSaving}
        onCancel={() => setAttachOpen(false)}
      >
        {attachError && (
          <Alert type="error" showIcon message={attachError} style={{ marginBottom: 16 }} />
        )}
        <Select
          showSearch
          placeholder="Search by document number or title"
          style={{ width: '100%' }}
          value={attachDocId}
          onChange={(value: number) => setAttachDocId(value)}
          filterOption={false}
          onSearch={handleDocSearch}
          loading={docSearchLoading}
          options={docOptions.map((d) => ({
            value: d.id,
            label: `${d.docNumber} — ${d.title}`,
          }))}
          notFoundContent={docSearchLoading ? 'Searching…' : 'No documents found'}
        />
      </Modal>

      <DocumentUploadModal
        open={uploadOpen}
        modalTitle="Upload new document"
        okText="Upload"
        onClose={() => setUploadOpen(false)}
        onSubmit={handleUpload}
      />

      <Modal
        title={preview?.title}
        open={preview !== null}
        onCancel={() => setPreview(null)}
        footer={null}
        width={960}
        destroyOnClose
      >
        {preview && (
          <Suspense
            fallback={
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                <Spin tip="Loading viewer…" />
              </div>
            }
          >
            <CadViewer
              fileUrl={api.documentVersionFileUrl(preview.versionId, true)}
              fileName={preview.fileName}
              height={520}
            />
          </Suspense>
        )}
      </Modal>
    </Card>
  );
}
