import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CatalogFormat, CatalogMapping, CatalogTargetField } from '../api/types';
import {
  CATALOG_FORMAT_OPTIONS,
  CATALOG_REQUIRED_TARGETS,
  CATALOG_TARGET_FIELDS,
  CATALOG_TARGET_META,
  CATALOG_UOM_OPTIONS,
  CATEGORY_OPTIONS,
  CatalogFormatTag,
  CATALOG_FORMAT_META,
  formatDate,
} from '../components/meta';

type DraftMap = Partial<Record<CatalogTargetField, string>>;

interface MappingFormValues {
  name: string;
  vendor?: string;
  format: CatalogFormat;
  headerSignature?: string[];
}

/** Fields a catalog file routinely lacks and that one literal can supply for every row. */
const DEFAULTABLE: CatalogTargetField[] = [
  'category',
  'uom',
  'manufacturerName',
  'distributorName',
];

const trimmedMap = (map: DraftMap): DraftMap => {
  const out: DraftMap = {};
  for (const target of CATALOG_TARGET_FIELDS) {
    const value = map[target]?.trim();
    if (value) out[target] = value;
  }
  return out;
};

export default function CatalogMappingsAdmin() {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const isViewer = user?.role === 'VIEWER';

  const [mappings, setMappings] = useState<CatalogMapping[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogMapping | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<MappingFormValues>();
  const [fieldMap, setFieldMap] = useState<DraftMap>({});
  const [defaults, setDefaults] = useState<DraftMap>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMappings(await api.listCatalogMappings());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const putEntry = (
    setter: React.Dispatch<React.SetStateAction<DraftMap>>,
    target: CatalogTargetField,
    value?: string
  ) => {
    setter((prev) => {
      const next = { ...prev };
      if (value === undefined || value.trim() === '') delete next[target];
      else next[target] = value;
      return next;
    });
  };

  const openCreate = () => {
    setEditing(null);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({ format: 'CSV' });
    setFieldMap({});
    setDefaults({});
    setModalOpen(true);
  };

  const openEdit = (mapping: CatalogMapping) => {
    setEditing(mapping);
    setModalError(null);
    form.resetFields();
    form.setFieldsValue({
      name: mapping.name,
      vendor: mapping.vendor ?? undefined,
      format: mapping.format,
      headerSignature: mapping.headerSignature,
    });
    setFieldMap({ ...mapping.fieldMap });
    setDefaults({ ...(mapping.defaults ?? {}) });
    setModalOpen(true);
  };

  const save = async () => {
    let values: MappingFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const cleanFieldMap = trimmedMap(fieldMap);
    if (Object.keys(cleanFieldMap).length === 0) {
      setModalError('Map at least one target field to a source column');
      return;
    }
    const cleanDefaults = trimmedMap(defaults);
    setSaving(true);
    setModalError(null);
    try {
      if (editing) {
        await api.updateCatalogMapping(editing.id, {
          name: values.name.trim(),
          vendor: values.vendor?.trim() || null,
          format: values.format,
          fieldMap: cleanFieldMap,
          // Explicit null clears the stored literals when the user emptied every default.
          defaults: Object.keys(cleanDefaults).length > 0 ? cleanDefaults : null,
          headerSignature: values.headerSignature ?? [],
        });
        message.success('Mapping updated');
      } else {
        await api.createCatalogMapping({
          name: values.name.trim(),
          vendor: values.vendor?.trim() || undefined,
          format: values.format,
          fieldMap: cleanFieldMap,
          defaults: Object.keys(cleanDefaults).length > 0 ? cleanDefaults : undefined,
          headerSignature: values.headerSignature ?? [],
        });
        message.success('Mapping created');
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (mapping: CatalogMapping) => {
    try {
      await api.deleteCatalogMapping(mapping.id);
      message.success(`${mapping.name} deleted`);
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  const missingRequired = CATALOG_REQUIRED_TARGETS.filter(
    (target) => !fieldMap[target]?.trim() && !defaults[target]?.trim()
  );

  const columns: ColumnsType<CatalogMapping> = [
    {
      title: 'Name',
      key: 'name',
      ellipsis: true,
      render: (_, mapping) => (
        <Space size={6} wrap>
          <Typography.Text strong>{mapping.name}</Typography.Text>
          {mapping.builtIn && (
            <Tooltip title="Shipped with TurboPLM and seeded on every boot — read-only">
              <Tag icon={<LockOutlined />} color="default">
                built-in
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Vendor',
      key: 'vendor',
      width: 160,
      render: (_, mapping) => mapping.vendor ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Format',
      key: 'format',
      width: 130,
      render: (_, mapping) => <CatalogFormatTag format={mapping.format} />,
    },
    {
      title: 'Mapped fields',
      key: 'fieldMap',
      render: (_, mapping) => {
        const targets = CATALOG_TARGET_FIELDS.filter((target) => mapping.fieldMap[target]);
        return (
          <Space size={4} wrap>
            {targets.map((target) => (
              <Tag key={target} color={CATALOG_TARGET_META[target].required ? 'blue' : 'default'}>
                {CATALOG_TARGET_META[target].label}
              </Tag>
            ))}
            {targets.length === 0 && <Typography.Text type="secondary">none</Typography.Text>}
          </Space>
        );
      },
    },
    {
      title: 'Defaults',
      key: 'defaults',
      width: 200,
      render: (_, mapping) => {
        const entries = Object.entries(mapping.defaults ?? {});
        if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space size={4} wrap>
            {entries.map(([target, value]) => (
              <Tag key={target} color="purple">
                {CATALOG_TARGET_META[target as CatalogTargetField].label}: {value}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Header signature',
      key: 'headerSignature',
      width: 150,
      render: (_, mapping) =>
        mapping.headerSignature.length === 0 ? (
          <Typography.Text type="secondary">no auto-detect</Typography.Text>
        ) : (
          <Tooltip title={mapping.headerSignature.join(', ')}>
            <Typography.Text>{mapping.headerSignature.length} column(s)</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: 'Created by',
      key: 'createdBy',
      width: 150,
      render: (_, mapping) =>
        mapping.createdBy?.name ?? <Typography.Text type="secondary">TurboPLM</Typography.Text>,
    },
    { title: 'Created', key: 'createdAt', width: 150, render: (_, m) => formatDate(m.createdAt) },
    ...(isViewer
      ? []
      : ([
          {
            title: 'Actions',
            key: 'actions',
            width: 170,
            render: (_, mapping) =>
              mapping.builtIn ? (
                <Typography.Text type="secondary">read-only</Typography.Text>
              ) : (
                <Space size={0}>
                  <Button
                    type="link"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEdit(mapping)}
                  >
                    Edit
                  </Button>
                  <Popconfirm
                    title="Delete this mapping?"
                    description="Imports that already used it keep their rows; only the preset goes away."
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(mapping)}
                  >
                    <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                      Delete
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ] as ColumnsType<CatalogMapping>)),
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
          Catalog mappings
        </Typography.Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New mapping
          </Button>
        )}
      </div>

      <Alert
        type="info"
        showIcon
        message="A mapping says which column of a vendor's export feeds which part field."
        description="Its header signature is what recognizes that vendor on upload, so the columns come pre-filled. The built-in presets are re-seeded on every boot and cannot be edited — copy one by saving the mapping from an import instead."
        style={{ marginBottom: 16 }}
      />

      <Table<CatalogMapping>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={mappings}
        loading={loading}
        pagination={false}
        expandable={{
          expandedRowRender: (mapping) => (
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} title="Column mapping">
              {CATALOG_TARGET_FIELDS.filter((target) => mapping.fieldMap[target]).map((target) => (
                <Descriptions.Item key={target} label={CATALOG_TARGET_META[target].label}>
                  <Typography.Text code>{mapping.fieldMap[target]}</Typography.Text>
                </Descriptions.Item>
              ))}
            </Descriptions>
          ),
        }}
        locale={{ emptyText: 'No catalog mappings' }}
      />

      <Modal
        title={editing ? `Edit ${editing.name}` : 'New mapping'}
        open={modalOpen}
        onOk={() => void save()}
        okText={editing ? 'Save' : 'Create'}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        width={760}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="name"
              label="Name"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Name is required' }, { max: 120 }]}
            >
              <Input placeholder="Digi-Key — house mapping" />
            </Form.Item>
            <Form.Item name="vendor" label="Vendor" style={{ width: 200 }}>
              <Input placeholder="optional" />
            </Form.Item>
            <Form.Item
              name="format"
              label="Format"
              style={{ width: 160 }}
              rules={[{ required: true, message: 'Pick a format' }]}
            >
              <Select options={CATALOG_FORMAT_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item
            name="headerSignature"
            label="Header signature"
            tooltip="The column headers that identify this vendor's export. Leave empty for a mapping you always pick by hand."
          >
            <Select
              mode="tags"
              open={false}
              placeholder="Type a column header and press Enter"
              tokenSeparators={[',']}
            />
          </Form.Item>
        </Form>

        <Divider orientation="left" plain style={{ marginTop: 0 }}>
          Column mapping
        </Divider>
        {missingRequired.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`Without ${missingRequired
              .map((target) => CATALOG_TARGET_META[target].label)
              .join(' and ')} this mapping cannot validate an import.`}
          />
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 12,
          }}
        >
          {CATALOG_TARGET_FIELDS.map((target) => {
            const meta = CATALOG_TARGET_META[target];
            return (
              <div key={target}>
                <Space size={4} align="center" style={{ marginBottom: 4 }}>
                  {meta.required && <Typography.Text type="danger">*</Typography.Text>}
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {meta.label}
                  </Typography.Text>
                </Space>
                <Input
                  allowClear
                  placeholder="Source column header"
                  value={fieldMap[target] ?? ''}
                  onChange={(e) => putEntry(setFieldMap, target, e.target.value)}
                />
              </div>
            );
          })}
        </div>

        <Divider orientation="left" plain>
          Defaults
        </Divider>
        <Typography.Text type="secondary">
          Used for every row where the mapped column is empty, or where the file carries no such
          column at all.
        </Typography.Text>
        <Space wrap size={16} align="start" style={{ marginTop: 12 }}>
          {DEFAULTABLE.map((target) => {
            const meta = CATALOG_TARGET_META[target];
            const value = defaults[target];
            return (
              <div key={target} style={{ width: 200 }}>
                <Typography.Text strong style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  {meta.label}
                </Typography.Text>
                {target === 'category' || target === 'uom' ? (
                  <Select<string>
                    style={{ width: '100%' }}
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="No default"
                    value={value}
                    options={target === 'category' ? CATEGORY_OPTIONS : CATALOG_UOM_OPTIONS}
                    onChange={(next) => putEntry(setDefaults, target, next ?? undefined)}
                  />
                ) : (
                  <Input
                    allowClear
                    placeholder="No default"
                    value={value ?? ''}
                    onChange={(e) => putEntry(setDefaults, target, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          Format {CATALOG_FORMAT_META.BMECAT_XML.label} mappings name BMEcat elements
          (SUPPLIER_AID, MANUFACTURER_AID …) rather than spreadsheet headers.
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
