import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CatalogImportSummary, CatalogRowStatus } from '../api/types';
import {
  CATALOG_ROW_STATUS_META,
  CatalogFormatTag,
  CatalogImportStatusTag,
  formatDate,
} from '../components/meta';

/** What rule V2 accepts; anything else is refused with 400 `Unsupported file type`. */
const ACCEPTED = '.csv,.tsv,.xml';

export default function CatalogImports() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [items, setItems] = useState<CatalogImportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [uploading, setUploading] = useState(false);

  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await api.listCatalogImports({ page, pageSize });
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
  }, [page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const created = await api.uploadCatalogImport(file);
      message.success(`${created.fileName} staged — ${created.counts.rows} row(s) read`);
      navigate(`/catalog-imports/${created.id}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (record: CatalogImportSummary) => {
    try {
      await api.deleteCatalogImport(record.id);
      message.success(`${record.fileName} deleted`);
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  const columns: ColumnsType<CatalogImportSummary> = [
    {
      title: 'File',
      key: 'fileName',
      ellipsis: true,
      render: (_, record) => (
        <Link to={`/catalog-imports/${record.id}`}>{record.fileName}</Link>
      ),
    },
    {
      title: 'Format',
      key: 'format',
      width: 130,
      render: (_, record) => <CatalogFormatTag format={record.format} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 150,
      render: (_, record) => (
        <Space size={4}>
          <CatalogImportStatusTag status={record.status} />
          {record.error && (
            <Tooltip title={record.error}>
              <WarningOutlined style={{ color: '#d4380d' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Vendor',
      key: 'detectedVendor',
      width: 140,
      render: (_, record) =>
        record.detectedVendor ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Mapping',
      key: 'mapping',
      width: 180,
      ellipsis: true,
      render: (_, record) =>
        record.mapping?.name ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    { title: 'Rows', key: 'rows', width: 80, align: 'right', render: (_, r) => r.counts.rows },
    {
      title: 'Classification',
      key: 'counts',
      render: (_, record) => {
        const { counts } = record;
        // Only the non-zero buckets: a row of eight zeroes tells the user nothing.
        const buckets: [CatalogRowStatus, number][] = [
          ['NEW', counts.new],
          ['UPDATE', counts.update],
          ['DUPLICATE', counts.duplicate],
          ['INVALID', counts.invalid],
          ['SKIPPED', counts.skipped],
          ['COMMITTED', counts.committed],
        ];
        const shown = buckets.filter(([, value]) => value > 0);
        if (shown.length === 0) {
          return <Typography.Text type="secondary">Not validated yet</Typography.Text>;
        }
        return (
          <Space size={4} wrap>
            {shown.map(([status, value]) => (
              <Tag key={status} color={CATALOG_ROW_STATUS_META[status].color}>
                {value} {CATALOG_ROW_STATUS_META[status].label.toLowerCase()}
              </Tag>
            ))}
            {counts.failed > 0 && <Tag color="red">{counts.failed} failed</Tag>}
          </Space>
        );
      },
    },
    {
      title: 'Uploaded by',
      key: 'createdBy',
      width: 150,
      render: (_, record) => record.createdBy.name,
    },
    {
      title: 'Uploaded',
      key: 'createdAt',
      width: 150,
      render: (_, record) => formatDate(record.createdAt),
    },
    ...(canEdit
      ? ([
          {
            title: '',
            key: 'actions',
            width: 60,
            render: (_, record) =>
              // A committed import is the record of what entered the system (rule V2).
              record.status === 'COMMITTED' ? (
                <Tooltip title="A committed import cannot be deleted">
                  <Button type="text" size="small" disabled icon={<DeleteOutlined />} />
                </Tooltip>
              ) : (
                <Popconfirm
                  title="Delete this import?"
                  description="The staged rows are discarded. Nothing that was already committed is affected."
                  okText="Delete"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(record)}
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
          },
        ] as ColumnsType<CatalogImportSummary>)
      : []),
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
          Catalog import
        </Typography.Title>
        {canEdit && (
          <Upload
            accept={ACCEPTED}
            maxCount={1}
            showUploadList={false}
            beforeUpload={(file) => {
              void upload(file);
              return false; // the POST is ours; antd must not auto-upload
            }}
          >
            <Button type="primary" icon={<UploadOutlined />} loading={uploading}>
              Upload catalog file
            </Button>
          </Upload>
        )}
      </div>

      {!canEdit && (
        <Alert
          type="info"
          showIcon
          message="Read-only access — you can browse catalog imports but not upload or commit them."
          style={{ marginBottom: 16 }}
        />
      )}

      <Alert
        type="info"
        showIcon
        message="CSV, TSV or BMEcat XML, up to 25 MB. Save an Excel workbook as CSV first."
        description="Uploading only stages the file: every source row is kept verbatim and nothing is written to parts, manufacturers or manufacturer parts until you map the columns, validate and commit."
        style={{ marginBottom: 16 }}
      />

      <Table<CatalogImportSummary>
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
          showTotal: (t) => `${t} imports`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
        locale={{ emptyText: 'No catalog imports yet' }}
      />
    </div>
  );
}
