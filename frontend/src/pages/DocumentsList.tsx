import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { App as AntdApp, Button, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { DocumentCategory, DocumentSummary } from '../api/types';
import { DocumentUploadModal, type DocumentUploadInput } from '../components/DocumentsCard';
import { DOC_CATEGORY_OPTIONS, DocCategoryTag, formatBytes, formatDate } from '../components/meta';

export default function DocumentsList() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<DocumentCategory | undefined>(undefined);

  const [modalOpen, setModalOpen] = useState(false);

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listDocuments({
        search: search || undefined,
        category,
        page,
        pageSize,
      });
      // Drop stale responses: an older request must not overwrite a newer one.
      if (requestRef.current !== requestId) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (requestRef.current === requestId) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [search, category, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (input: DocumentUploadInput) => {
    const created = await api.createDocument(input);
    message.success(`${created.docNumber} created`);
    navigate(`/documents/${created.id}`);
  };

  const columns: ColumnsType<DocumentSummary> = [
    {
      title: 'Document #',
      key: 'docNumber',
      width: 130,
      render: (_, doc) => <Link to={`/documents/${doc.id}`}>{doc.docNumber}</Link>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Category',
      key: 'category',
      width: 140,
      render: (_, doc) => <DocCategoryTag category={doc.category} />,
    },
    {
      title: 'Versions',
      dataIndex: 'versionCount',
      key: 'versionCount',
      width: 100,
      align: 'right',
    },
    {
      title: 'Latest file',
      key: 'latestFile',
      width: 280,
      render: (_, doc) =>
        doc.latestVersion ? (
          <Space size={8}>
            <Typography.Text ellipsis style={{ maxWidth: 190 }}>
              {doc.latestVersion.fileName}
            </Typography.Text>
            <Typography.Text type="secondary">
              {formatBytes(doc.latestVersion.sizeBytes)}
            </Typography.Text>
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Created by',
      key: 'createdBy',
      width: 140,
      render: (_, doc) => doc.createdBy.name,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 150,
      render: (_, doc) => formatDate(doc.createdAt),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          Documents
        </Typography.Title>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            New document
          </Button>
        )}
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Search number or title"
          allowClear
          style={{ width: 280 }}
          onSearch={(value) => {
            setSearch(value.trim());
            setPage(1);
          }}
        />
        <Select
          placeholder="Category"
          allowClear
          style={{ width: 170 }}
          options={DOC_CATEGORY_OPTIONS}
          value={category}
          onChange={(value) => {
            setCategory(value);
            setPage(1);
          }}
        />
      </Space>

      <Table<DocumentSummary>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `${t} documents`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <DocumentUploadModal
        open={modalOpen}
        modalTitle="New document"
        okText="Create"
        onClose={() => setModalOpen(false)}
        onSubmit={handleCreate}
      />
    </div>
  );
}
