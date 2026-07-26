import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type {
  AmlStatus,
  ManufacturerPartDetail,
  ManufacturerSummary,
  PartDetail,
} from '../../api/types';
import { AML_STATUS_OPTIONS, AmlStatusTag, formatMoney } from '../meta';
import { useAuth } from '../../auth/AuthContext';

interface MpFormValues {
  manufacturerId?: number;
  mpn: string;
  status: AmlStatus;
  description?: string;
}

export default function SourcingTab({
  part,
  editable,
}: {
  part: PartDetail;
  editable: boolean;
}): JSX.Element {
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = editable && user?.role !== 'VIEWER';

  const [rows, setRows] = useState<ManufacturerPartDetail[]>([]);
  const [loading, setLoading] = useState(false);

  // Unit cost inline edit
  const [unitCost, setUnitCost] = useState<number | null>(part.unitCost);
  const [costEditing, setCostEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<number | null>(null);
  const [costSaving, setCostSaving] = useState(false);

  // Add / edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ManufacturerPartDetail | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [manufacturers, setManufacturers] = useState<ManufacturerSummary[]>([]);
  const [mfrLoading, setMfrLoading] = useState(false);
  const [newMfrName, setNewMfrName] = useState('');
  const [creatingMfr, setCreatingMfr] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const [form] = Form.useForm<MpFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.getPartManufacturerParts(part.id));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [part.id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setUnitCost(part.unitCost);
    setCostEditing(false);
  }, [part.id, part.unitCost]);

  useEffect(() => {
    return () => {
      window.clearTimeout(searchTimer.current);
    };
  }, []);

  const fetchManufacturers = useCallback(async (search: string) => {
    setMfrLoading(true);
    try {
      setManufacturers(await api.listManufacturers(search || undefined));
    } catch {
      setManufacturers([]);
    } finally {
      setMfrLoading(false);
    }
  }, []);

  const handleManufacturerSearch = (value: string) => {
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void fetchManufacturers(value);
    }, 300);
  };

  const createNewManufacturer = async () => {
    const name = newMfrName.trim();
    if (!name) {
      message.warning('Enter a manufacturer name first');
      return;
    }
    setCreatingMfr(true);
    try {
      const created = await api.createManufacturer({ name });
      setManufacturers((prev) => [created, ...prev.filter((m) => m.id !== created.id)]);
      form.setFieldsValue({ manufacturerId: created.id });
      setNewMfrName('');
      message.success(`Manufacturer "${created.name}" created`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCreatingMfr(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setModalError(null);
    setNewMfrName('');
    form.resetFields();
    form.setFieldsValue({ status: 'APPROVED' });
    void fetchManufacturers('');
    setModalOpen(true);
  };

  const openEdit = (row: ManufacturerPartDetail) => {
    setEditing(row);
    setModalError(null);
    setNewMfrName('');
    form.resetFields();
    setManufacturers([row.manufacturer]);
    form.setFieldsValue({
      manufacturerId: row.manufacturer.id,
      mpn: row.mpn,
      status: row.status,
      description: row.description ?? undefined,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    let values: MpFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      if (editing) {
        await api.updateManufacturerPart(editing.id, {
          mpn: values.mpn.trim(),
          status: values.status,
          description: values.description?.trim() ? values.description.trim() : null,
        });
        message.success('Manufacturer part updated');
      } else {
        await api.addManufacturerPart(part.id, {
          manufacturerId: values.manufacturerId!,
          mpn: values.mpn.trim(),
          status: values.status,
          description: values.description?.trim() || undefined,
        });
        message.success('Manufacturer part added');
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = (row: ManufacturerPartDetail) => {
    modal.confirm({
      title: 'Remove manufacturer part',
      content: `Remove ${row.manufacturer.name} ${row.mpn} from the approved manufacturer list?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteManufacturerPart(row.id);
          message.success('Manufacturer part removed');
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const startCostEdit = () => {
    setCostDraft(unitCost);
    setCostEditing(true);
  };

  const saveCost = async () => {
    setCostSaving(true);
    try {
      const updated = await api.updatePart(part.id, { unitCost: costDraft });
      setUnitCost(updated.unitCost);
      setCostEditing(false);
      message.success('Unit cost updated');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setCostSaving(false);
    }
  };

  const columns: ColumnsType<ManufacturerPartDetail> = [
    {
      title: 'Manufacturer',
      key: 'manufacturer',
      render: (_, row) => (
        <Space size={8}>
          <Typography.Text strong>{row.manufacturer.name}</Typography.Text>
          {row.manufacturer.website && (
            <Typography.Link
              href={row.manufacturer.website}
              target="_blank"
              rel="noopener noreferrer"
              title={row.manufacturer.website}
            >
              <LinkOutlined />
            </Typography.Link>
          )}
        </Space>
      ),
    },
    {
      title: 'MPN',
      key: 'mpn',
      render: (_, row) => <Typography.Text code>{row.mpn}</Typography.Text>,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, row) => <AmlStatusTag status={row.status} />,
    },
    {
      title: 'Description',
      key: 'description',
      ellipsis: true,
      render: (_, row) => row.description ?? '—',
    },
    ...(canEdit
      ? ([
          {
            title: 'Actions',
            key: 'actions',
            width: 150,
            render: (_, row) => (
              <Space size={0}>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEdit(row)}
                >
                  Edit
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => confirmDelete(row)}
                >
                  Delete
                </Button>
              </Space>
            ),
          },
        ] as ColumnsType<ManufacturerPartDetail>)
      : []),
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Space size={8}>
          <Typography.Text type="secondary">Unit cost:</Typography.Text>
          {costEditing ? (
            <Space.Compact>
              <InputNumber<number>
                min={0}
                value={costDraft}
                onChange={(value) => setCostDraft(value)}
                placeholder="no cost"
                style={{ width: 140 }}
                autoFocus
              />
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={costSaving}
                onClick={() => void saveCost()}
              />
              <Button
                icon={<CloseOutlined />}
                disabled={costSaving}
                onClick={() => setCostEditing(false)}
              />
            </Space.Compact>
          ) : (
            <>
              <Typography.Text strong>{formatMoney(unitCost)}</Typography.Text>
              {canEdit && (
                <Button type="link" size="small" icon={<EditOutlined />} onClick={startCostEdit}>
                  Edit
                </Button>
              )}
            </>
          )}
        </Space>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            Add manufacturer part
          </Button>
        )}
      </div>

      <Table<ManufacturerPartDetail>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{ emptyText: 'No approved manufacturer parts for this part yet.' }}
      />

      <Modal
        title={editing ? 'Edit manufacturer part' : 'Add manufacturer part'}
        open={modalOpen}
        onOk={() => void handleSubmit()}
        okText={editing ? 'Save' : 'Add'}
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        forceRender
      >
        {modalError && (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 16 }} />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="manufacturerId"
            label="Manufacturer"
            rules={[{ required: true, message: 'Select a manufacturer' }]}
          >
            <Select
              showSearch
              disabled={editing !== null}
              placeholder="Search manufacturers"
              filterOption={false}
              onSearch={handleManufacturerSearch}
              loading={mfrLoading}
              options={manufacturers.map((m) => ({ value: m.id, label: m.name }))}
              notFoundContent={mfrLoading ? 'Searching…' : 'No manufacturers found'}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '8px 0' }} />
                  <Space.Compact style={{ width: '100%', padding: '0 8px 8px' }}>
                    <Input
                      size="small"
                      placeholder="New manufacturer name"
                      value={newMfrName}
                      onChange={(e) => setNewMfrName(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      loading={creatingMfr}
                      onClick={() => void createNewManufacturer()}
                    >
                      New manufacturer
                    </Button>
                  </Space.Compact>
                </>
              )}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="mpn"
              label="Manufacturer part number"
              style={{ flex: 1 }}
              rules={[
                { required: true, whitespace: true, message: 'MPN is required' },
                { max: 80, message: 'At most 80 characters' },
              ]}
            >
              <Input placeholder="e.g. LM317T" />
            </Form.Item>
            <Form.Item name="status" label="Status" style={{ width: 160 }}>
              <Select options={AML_STATUS_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
