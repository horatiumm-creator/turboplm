import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  CatalogImportDetail as CatalogImportDetailData,
  CatalogImportRow,
  CatalogImportStatus,
  CatalogMapping,
  CatalogRowStatus,
  CatalogTargetField,
} from '../api/types';
import {
  CATALOG_REQUIRED_TARGETS,
  CATALOG_ROW_STATUS_OPTIONS,
  CATALOG_TARGET_FIELDS,
  CATALOG_TARGET_META,
  CATALOG_UOM_OPTIONS,
  CATEGORY_OPTIONS,
  CatalogFormatTag,
  CatalogImportStatusTag,
  CatalogRowStatusTag,
  formatDate,
  formatMoney,
} from '../components/meta';

type DraftMap = Partial<Record<CatalogTargetField, string>>;

interface MappingFormValues {
  name: string;
  vendor?: string;
}

/** Fields a catalog file routinely lacks and that one literal can supply for every row. */
const DEFAULTABLE: CatalogTargetField[] = [
  'category',
  'uom',
  'manufacturerName',
  'distributorName',
];

const DASH = <Typography.Text type="secondary">—</Typography.Text>;

/** Mirrors `normalizeColumnKey` in the parser, so a preset column that only differs in case
 *  or punctuation still resolves to the column this file actually has. */
const columnKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const trimmedMap = (map: DraftMap): DraftMap => {
  const out: DraftMap = {};
  for (const target of CATALOG_TARGET_FIELDS) {
    const value = map[target]?.trim();
    if (value) out[target] = value;
  }
  return out;
};

const sameMap = (a: DraftMap, b: DraftMap) => {
  const left = trimmedMap(a);
  const right = trimmedMap(b);
  const keys = Object.keys(left) as CatalogTargetField[];
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
};

/**
 * A preset saved from one export is re-applied to the next, where a column may be spelled
 * differently or be missing entirely. Resolve to this file's spelling and report what it
 * could not place, rather than leaving a Select holding a column that does not exist.
 */
function resolveColumns(map: DraftMap, sourceColumns: string[]) {
  const byKey = new Map<string, string>();
  for (const column of sourceColumns) {
    const key = columnKey(column);
    if (key !== '' && !byKey.has(key)) byKey.set(key, column);
  }
  const resolved: DraftMap = {};
  const dropped: string[] = [];
  for (const target of CATALOG_TARGET_FIELDS) {
    const wanted = map[target];
    if (!wanted) continue;
    const actual = byKey.get(columnKey(wanted));
    if (actual) resolved[target] = actual;
    else dropped.push(wanted);
  }
  return { resolved, dropped };
}

/** Where the flow resumes on a cold load. DRAFT has no classification to preview yet. */
const stepForStatus = (status: CatalogImportStatus) => {
  if (status === 'VALIDATED') return 1;
  if (status === 'COMMITTED' || status === 'FAILED') return 2;
  return 0;
};

export default function CatalogImportDetail() {
  const { id } = useParams<{ id: string }>();
  const importId = Number(id);
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const canEdit = user?.role !== 'VIEWER';

  const [imp, setImp] = useState<CatalogImportDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<CatalogMapping[]>([]);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<'validate' | 'commit' | null>(null);

  const [fieldMap, setFieldMap] = useState<DraftMap>({});
  const [defaults, setDefaults] = useState<DraftMap>({});
  const [presetId, setPresetId] = useState<number | undefined>(undefined);

  const [createMissingManufacturers, setCreateMissingManufacturers] = useState(true);
  const [updateExisting, setUpdateExisting] = useState(false);

  const detailReq = useRef(0);
  const load = useCallback(
    async (opts: { spinner?: boolean } = {}) => {
      const requestId = ++detailReq.current;
      if (opts.spinner) setLoading(true);
      try {
        const next = await api.getCatalogImport(importId);
        // Drop stale responses: an older request must not overwrite a newer one.
        if (detailReq.current !== requestId) return;
        setImp(next);
        setLoadError(null);
      } catch (err) {
        if (detailReq.current === requestId) {
          setLoadError(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      } finally {
        if (detailReq.current === requestId && opts.spinner) setLoading(false);
      }
    },
    [importId]
  );

  /** Resuming the flow and pre-filling the mapping are each a one-shot per import. */
  const stepSeededRef = useRef(0);
  const presetSeededRef = useRef(0);

  useEffect(() => {
    stepSeededRef.current = 0;
    presetSeededRef.current = 0;
    void load({ spinner: true });
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setMappings(await api.listCatalogMappings());
      } catch {
        setMappings([]);
      } finally {
        setMappingsLoaded(true);
      }
    })();
  }, []);

  // Kept apart from the preset seeding below so a slow mapping list cannot leave the user
  // looking at the Map step of an import that is already validated.
  useEffect(() => {
    if (!imp || stepSeededRef.current === imp.id) return;
    stepSeededRef.current = imp.id;
    setStep(stepForStatus(imp.status));
  }, [imp]);

  useEffect(() => {
    if (!imp || !mappingsLoaded || presetSeededRef.current === imp.id) return;
    presetSeededRef.current = imp.id;
    // The mapping the import already used wins over the detected preset: re-validating must
    // start from what produced the rows on screen.
    const startFrom = imp.mapping?.id ?? imp.suggestedMappingId;
    const preset = mappings.find((m) => m.id === startFrom);
    if (preset) {
      setPresetId(preset.id);
      setFieldMap(resolveColumns(preset.fieldMap, imp.sourceColumns).resolved);
      setDefaults(preset.defaults ?? {});
    }
  }, [imp, mappings, mappingsLoaded]);

  // ---- staged rows ---------------------------------------------------------
  const [rows, setRows] = useState<CatalogImportRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowLoading, setRowLoading] = useState(false);
  const [rowPage, setRowPage] = useState(1);
  const [rowPageSize, setRowPageSize] = useState(20);
  const [rowStatus, setRowStatus] = useState<CatalogRowStatus | undefined>(undefined);
  /** Bumped by validate and commit, which re-classify every row. */
  const [rowsVersion, setRowsVersion] = useState(0);

  const rowReq = useRef(0);
  const loadRows = useCallback(async () => {
    const requestId = ++rowReq.current;
    setRowLoading(true);
    try {
      const res = await api.listCatalogImportRows(importId, {
        status: rowStatus,
        page: rowPage,
        pageSize: rowPageSize,
      });
      if (rowReq.current !== requestId) return;
      setRows(res.items);
      setRowTotal(res.total);
    } catch (err) {
      if (rowReq.current === requestId) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (rowReq.current === requestId) setRowLoading(false);
    }
    // rowsVersion is a refetch trigger, not an argument.
  }, [importId, rowStatus, rowPage, rowPageSize, rowsVersion, message]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  // ---- mapping controls ---------------------------------------------------
  const sourceColumns = imp?.sourceColumns ?? [];
  const columnOptions = useMemo(
    () => sourceColumns.map((column) => ({ value: column, label: column })),
    [sourceColumns]
  );
  const mappingOptions = useMemo(
    () =>
      mappings.map((m) => ({
        value: m.id,
        label: m.builtIn ? `${m.name} (built-in)` : m.name,
      })),
    [mappings]
  );

  /** Source column -> the target it feeds, so the sample table can label its own headers. */
  const targetByColumn = useMemo(() => {
    const out = new Map<string, CatalogTargetField>();
    for (const target of CATALOG_TARGET_FIELDS) {
      const column = fieldMap[target];
      if (column && !out.has(column)) out.set(column, target);
    }
    return out;
  }, [fieldMap]);

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

  const sampleFor = (column?: string) => {
    if (!column || !imp) return null;
    const values = imp.sampleRows
      .map((row) => (row[column] ?? '').trim())
      .filter((value) => value !== '');
    return values.length > 0 ? values.slice(0, 3).join(' · ') : null;
  };

  const applyPreset = (nextId?: number) => {
    setPresetId(nextId);
    if (nextId === undefined || !imp) return;
    const preset = mappings.find((m) => m.id === nextId);
    if (!preset) return;
    const { resolved, dropped } = resolveColumns(preset.fieldMap, imp.sourceColumns);
    setFieldMap(resolved);
    setDefaults(preset.defaults ?? {});
    if (dropped.length > 0) {
      message.warning(
        `This file has no column named ${dropped.join(', ')} — those targets are left unmapped.`
      );
    }
  };

  const missingRequired = CATALOG_REQUIRED_TARGETS.filter(
    (target) => !fieldMap[target]?.trim() && !defaults[target]?.trim()
  );

  const runValidate = async () => {
    if (!imp) return;
    if (missingRequired.length > 0) {
      message.warning(
        `Map the required target field${missingRequired.length > 1 ? 's' : ''} ${missingRequired
          .map((target) => CATALOG_TARGET_META[target].label)
          .join(' and ')}`
      );
      return;
    }
    const cleanFieldMap = trimmedMap(fieldMap);
    const cleanDefaults = trimmedMap(defaults);
    const preset = mappings.find((m) => m.id === presetId);
    // The import records a mapping only while the draft still *is* that mapping: an edited
    // preset filed under the vendor's name would misdescribe what was imported.
    const untouched =
      preset !== undefined &&
      sameMap(preset.fieldMap, cleanFieldMap) &&
      sameMap(preset.defaults ?? {}, cleanDefaults);

    setBusy('validate');
    try {
      const next = await api.validateCatalogImport(importId, {
        mappingId: untouched ? preset.id : undefined,
        fieldMap: cleanFieldMap,
        // Always explicit: an absent `defaults` would let a preset reinstate a literal the
        // user has just cleared.
        defaults: cleanDefaults,
      });
      setImp(next);
      setRowStatus(undefined);
      setRowPage(1);
      setRowsVersion((v) => v + 1);
      setStep(1);
      message.success(
        `Validated — ${next.counts.new} to create, ${next.counts.update} to update, ${next.counts.invalid} invalid`
      );
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const runCommit = async () => {
    setBusy('commit');
    try {
      const next = await api.commitCatalogImport(importId, {
        createMissingManufacturers,
        updateExisting,
      });
      setImp(next);
      setRowsVersion((v) => v + 1);
      setStep(2);
      if (next.counts.failed > 0) {
        message.warning(
          `Committed ${next.counts.committed} row(s); ${next.counts.failed} failed to commit`
        );
      } else {
        message.success(`Committed — ${next.counts.committed} row(s) written`);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const setSkip = async (row: CatalogImportRow, skip: boolean) => {
    try {
      const updated = await api.updateCatalogImportRow(row.id, skip ? 'SKIPPED' : 'NEW');
      // Patched in place rather than refetched, so the row stays put and the toggle can be
      // undone without hunting for it again.
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // The import's counters moved with the row, and the commit summary reads them.
      await load();
      message.success(
        skip ? `Line ${row.lineNumber} skipped` : `Line ${row.lineNumber} back in the import`
      );
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  };

  // ---- save the current mapping -------------------------------------------
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveForm] = Form.useForm<MappingFormValues>();

  const openSaveMapping = () => {
    if (!imp) return;
    setSaveError(null);
    saveForm.resetFields();
    saveForm.setFieldsValue({ vendor: imp.detectedVendor ?? undefined });
    setSaveOpen(true);
  };

  const saveMapping = async () => {
    if (!imp) return;
    let values: MappingFormValues;
    try {
      values = await saveForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const created = await api.createCatalogMapping({
        name: values.name.trim(),
        vendor: values.vendor?.trim() || undefined,
        format: imp.format,
        fieldMap: trimmedMap(fieldMap),
        defaults: trimmedMap(defaults),
        // This file's headers are what should recognize the next export from this vendor.
        headerSignature: imp.sourceColumns,
      });
      setMappings(await api.listCatalogMappings());
      setPresetId(created.id);
      setSaveOpen(false);
      message.success(`Mapping "${created.name}" saved`);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (loadError || !imp) {
    return <Alert type="error" showIcon message={loadError ?? 'Catalog import not found'} />;
  }

  const counts = imp.counts;
  /** A committed import is the record of what entered the system: mapping and rows freeze. */
  const locked = imp.status === 'COMMITTED';
  // Commit is unreachable until a validate has classified the rows — nobody should ever be
  // one click from writing thousands of parts.
  const maxStep = imp.status === 'DRAFT' || imp.status === 'CANCELLED' ? 0 : 2;
  const eligible = counts.new + (updateExisting ? counts.update : 0);
  const notWritten = counts.duplicate + counts.invalid + counts.skipped;

  const goTo = (next: number) => {
    if (next > maxStep) {
      message.warning(
        next === 2 ? 'Validate the import before committing' : 'Map the columns and validate first'
      );
      return;
    }
    setStep(next);
  };

  const sampleColumns: ColumnsType<Record<string, string>> = imp.sourceColumns.map((column) => {
    const target = targetByColumn.get(column);
    return {
      key: column,
      dataIndex: column,
      width: 200,
      ellipsis: true,
      title: (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>{column}</Typography.Text>
          {target ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {CATALOG_TARGET_META[target].label}
            </Tag>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              not mapped
            </Typography.Text>
          )}
        </Space>
      ),
      render: (value: string | undefined) => (value && value.trim() !== '' ? value : DASH),
    };
  });

  const rowColumns: ColumnsType<CatalogImportRow> = [
    { title: 'Line', dataIndex: 'lineNumber', key: 'lineNumber', width: 80, align: 'right' },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) => <CatalogRowStatusTag status={row.status} />,
    },
    {
      title: 'Name',
      key: 'name',
      ellipsis: true,
      render: (_, row) => row.mapped?.name ?? DASH,
    },
    {
      title: 'MPN',
      key: 'mpn',
      width: 170,
      ellipsis: true,
      render: (_, row) => row.mapped?.mpn ?? DASH,
    },
    {
      title: 'Manufacturer',
      key: 'manufacturerName',
      width: 160,
      ellipsis: true,
      render: (_, row) => row.mapped?.manufacturerName ?? DASH,
    },
    {
      title: 'Part number',
      key: 'partNumber',
      width: 150,
      render: (_, row) => {
        if (row.part) return <Link to={`/parts/${row.part.id}`}>{row.part.partNumber}</Link>;
        if (row.mapped?.partNumber) return row.mapped.partNumber;
        // Only a row that will create a part gets a generated number; the others either
        // amend a part that already has one or are never written at all.
        return row.status === 'NEW' ? (
          <Typography.Text type="secondary">generated</Typography.Text>
        ) : (
          DASH
        );
      },
    },
    {
      title: 'Unit cost',
      key: 'unitCost',
      width: 110,
      align: 'right',
      render: (_, row) => formatMoney(row.mapped?.unitCost),
    },
    {
      title: 'Message',
      key: 'message',
      ellipsis: true,
      render: (_, row) =>
        row.message ? (
          <Typography.Text type={row.status === 'INVALID' ? 'danger' : 'warning'}>
            {row.message}
          </Typography.Text>
        ) : (
          DASH
        ),
    },
    ...(canEdit && !locked
      ? ([
          {
            title: '',
            key: 'actions',
            width: 110,
            render: (_, row) => {
              if (row.status === 'COMMITTED') return null;
              if (row.status === 'SKIPPED') {
                return (
                  <Tooltip title="Puts the row back as New — re-validate to restore its original classification.">
                    <Button
                      type="link"
                      size="small"
                      icon={<UndoOutlined />}
                      onClick={() => void setSkip(row, false)}
                    >
                      Unskip
                    </Button>
                  </Tooltip>
                );
              }
              // INVALID and DUPLICATE rows are never written anyway, and skipping one only to
              // unskip it would relabel it NEW — which would write it.
              const pointless = row.status === 'INVALID' || row.status === 'DUPLICATE';
              return (
                <Tooltip
                  title={pointless ? `${row.status === 'INVALID' ? 'Invalid' : 'Duplicate'} rows are never written` : undefined}
                >
                  <Button
                    type="link"
                    size="small"
                    icon={<StopOutlined />}
                    disabled={pointless}
                    onClick={() => void setSkip(row, true)}
                  >
                    Skip
                  </Button>
                </Tooltip>
              );
            },
          },
        ] as ColumnsType<CatalogImportRow>)
      : []),
  ];

  return (
    <div>
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          message="Read-only access — you can review this import but not map, validate or commit it."
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Space size={10} wrap align="center">
              <Typography.Title level={3} style={{ margin: 0 }}>
                {imp.fileName}
              </Typography.Title>
              <CatalogImportStatusTag status={imp.status} />
              <CatalogFormatTag format={imp.format} />
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4 }}>
              Vendor catalog import · uploaded by {imp.createdBy.name} on{' '}
              {formatDate(imp.createdAt)}
            </Typography.Paragraph>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              Refresh
            </Button>
            <Link to="/catalog-imports">
              <Button>All imports</Button>
            </Link>
          </Space>
        </div>

        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label="Source rows">{counts.rows}</Descriptions.Item>
          <Descriptions.Item label="Source columns">{imp.sourceColumns.length}</Descriptions.Item>
          <Descriptions.Item label="Detected vendor">{imp.detectedVendor ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Mapping">
            {imp.mapping?.name ?? (imp.validatedAt ? 'One-off column mapping' : '—')}
          </Descriptions.Item>
          <Descriptions.Item label="Validated">{formatDate(imp.validatedAt)}</Descriptions.Item>
          <Descriptions.Item label="Committed">{formatDate(imp.committedAt)}</Descriptions.Item>
        </Descriptions>

        {imp.error && (
          <Alert
            type={imp.status === 'FAILED' ? 'error' : 'warning'}
            showIcon
            message={imp.error}
            style={{ marginTop: 8 }}
          />
        )}
      </Card>

      <Steps
        current={step}
        // On the last step the outcome colours the tracker: green when everything landed,
        // red when the commit wrote nothing at all.
        status={
          step === 2 && imp.status === 'COMMITTED'
            ? 'finish'
            : step === 2 && imp.status === 'FAILED'
              ? 'error'
              : 'process'
        }
        onChange={goTo}
        style={{ marginBottom: 16 }}
        items={[
          { title: 'Map', description: "Match this file's columns to part fields" },
          {
            title: 'Preview',
            description: 'Every row classified — still nothing written',
            disabled: maxStep < 1,
          },
          {
            title: 'Commit',
            description: 'Create and amend parts',
            disabled: maxStep < 2,
          },
        ]}
      />

      {step === 0 && (
        <Card title="Map the columns">
          <Space direction="vertical" size={16} style={{ display: 'flex' }}>
            {locked && (
              <Alert
                type="info"
                showIcon
                message="This import is committed — the mapping is kept as a record and can no longer be changed."
              />
            )}
            {!locked && imp.suggestedMappingId !== null && (
              <Alert
                type="success"
                showIcon
                message={
                  imp.detectedVendor
                    ? `Recognized a ${imp.detectedVendor} export — its preset is pre-filled below.`
                    : 'A built-in preset matches these headers and is pre-filled below.'
                }
                description="Check every column against the sample rows before validating."
              />
            )}
            {!locked && imp.validatedAt !== null && imp.mapping === null && (
              <Alert
                type="warning"
                showIcon
                message="This import was validated with a one-off mapping, which is not stored."
                description="The rows below still show its result. Re-pick the columns if you want to validate again."
              />
            )}

            <Space wrap align="center">
              <Typography.Text strong>Start from</Typography.Text>
              <Select<number>
                style={{ width: 300 }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="A saved mapping"
                value={presetId}
                options={mappingOptions}
                disabled={!canEdit || locked}
                onChange={(value) => applyPreset(value ?? undefined)}
              />
              {canEdit && !locked && (
                <Button
                  icon={<SaveOutlined />}
                  disabled={Object.keys(trimmedMap(fieldMap)).length === 0}
                  onClick={openSaveMapping}
                >
                  Save as mapping
                </Button>
              )}
            </Space>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 16,
              }}
            >
              {CATALOG_TARGET_FIELDS.map((target) => {
                const meta = CATALOG_TARGET_META[target];
                const chosen = fieldMap[target];
                const literal = defaults[target];
                const sample = sampleFor(chosen);
                return (
                  <div key={target}>
                    <Space size={4} align="center" style={{ marginBottom: 4 }}>
                      {meta.required && <Typography.Text type="danger">*</Typography.Text>}
                      <Typography.Text strong>{meta.label}</Typography.Text>
                      {!chosen && literal && <Tag color="purple">default: {literal}</Tag>}
                    </Space>
                    <Select<string>
                      style={{ width: '100%' }}
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder={meta.required ? 'Required — pick a column' : 'Not mapped'}
                      value={chosen}
                      options={columnOptions}
                      disabled={!canEdit || locked}
                      status={meta.required && !chosen && !literal ? 'error' : undefined}
                      onChange={(value) => putEntry(setFieldMap, target, value ?? undefined)}
                    />
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginTop: 4 }}
                    >
                      {sample ? `e.g. ${sample}` : meta.hint}
                    </Typography.Text>
                  </div>
                );
              })}
            </div>

            <Divider orientation="left" plain style={{ marginBottom: 0 }}>
              Defaults
            </Divider>
            <Typography.Text type="secondary">
              A default is used for every row where the mapped column is empty, or where the file
              carries no such column at all.
            </Typography.Text>
            <Space wrap size={16} align="start">
              {DEFAULTABLE.map((target) => {
                const meta = CATALOG_TARGET_META[target];
                const value = defaults[target];
                return (
                  <div key={target} style={{ width: 210 }}>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
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
                        disabled={!canEdit || locked}
                        onChange={(next) => putEntry(setDefaults, target, next ?? undefined)}
                      />
                    ) : (
                      <Input
                        allowClear
                        placeholder="No default"
                        value={value ?? ''}
                        disabled={!canEdit || locked}
                        onChange={(e) => putEntry(setDefaults, target, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </Space>

            <Divider orientation="left" plain style={{ marginBottom: 0 }}>
              First rows of the file
            </Divider>
            <Table<Record<string, string>>
              size="small"
              rowKey={(_row, index) => String(index ?? 0)}
              columns={sampleColumns}
              dataSource={imp.sampleRows}
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: 'No sample rows' }}
            />

            {canEdit && !locked && (
              <Space wrap>
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  loading={busy === 'validate'}
                  disabled={missingRequired.length > 0}
                  onClick={() => void runValidate()}
                >
                  {imp.validatedAt ? 'Re-validate' : 'Validate'}
                </Button>
                <Typography.Text type="secondary">
                  {missingRequired.length > 0
                    ? `Map ${missingRequired
                        .map((target) => CATALOG_TARGET_META[target].label)
                        .join(' and ')} to continue.`
                    : 'Validating classifies every row and writes nothing.'}
                </Typography.Text>
              </Space>
            )}
          </Space>
        </Card>
      )}

      {step === 1 && (
        <Card title="Preview what will happen">
          <Space direction="vertical" size={16} style={{ display: 'flex' }}>
            {imp.status === 'VALIDATED' && (
              <Alert
                type="info"
                showIcon
                message="Nothing has been written yet — this is how the current mapping classifies the staged rows."
              />
            )}

            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={6}>
                <Statistic title="Source rows" value={counts.rows} />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="New parts"
                  value={counts.new}
                  valueStyle={counts.new > 0 ? { color: '#389e0d' } : undefined}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="Amendments"
                  value={counts.update}
                  valueStyle={counts.update > 0 ? { color: '#0958d9' } : undefined}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="Duplicates in file"
                  value={counts.duplicate}
                  valueStyle={counts.duplicate > 0 ? { color: '#d48806' } : undefined}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="Invalid"
                  value={counts.invalid}
                  valueStyle={counts.invalid > 0 ? { color: '#cf1322' } : undefined}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic title="Skipped" value={counts.skipped} />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="Committed"
                  value={counts.committed}
                  valueStyle={counts.committed > 0 ? { color: '#389e0d' } : undefined}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="Failed"
                  value={counts.failed}
                  valueStyle={counts.failed > 0 ? { color: '#cf1322' } : undefined}
                />
              </Col>
            </Row>

            <Space wrap>
              <Select<CatalogRowStatus>
                placeholder="Status"
                allowClear
                style={{ width: 180 }}
                options={CATALOG_ROW_STATUS_OPTIONS}
                value={rowStatus}
                onChange={(value) => {
                  setRowStatus(value ?? undefined);
                  setRowPage(1);
                }}
              />
              <Typography.Text type="secondary">
                Expand a row to see the source values it came from.
              </Typography.Text>
            </Space>

            <Table<CatalogImportRow>
              size="small"
              rowKey="id"
              columns={rowColumns}
              dataSource={rows}
              loading={rowLoading}
              scroll={{ x: 'max-content' }}
              expandable={{
                expandedRowRender: (row) => (
                  <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                    {row.mapped && (
                      <Descriptions
                        size="small"
                        column={{ xs: 1, sm: 2, lg: 3 }}
                        title="Mapped values"
                      >
                        <Descriptions.Item label="Description">
                          {row.mapped.description ?? '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Category">
                          {row.mapped.category ?? '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Unit of measure">
                          {row.mapped.uom ?? '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Distributor">
                          {row.mapped.distributorName ?? '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Distributor part number">
                          {row.mapped.distributorPartNumber ?? '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Manufacturer part">
                          {row.manufacturerPart
                            ? `${row.manufacturerPart.manufacturer} ${row.manufacturerPart.mpn}`
                            : '—'}
                        </Descriptions.Item>
                      </Descriptions>
                    )}
                    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} title="Source row">
                      {Object.entries(row.raw).map(([column, value]) => (
                        <Descriptions.Item key={column} label={column}>
                          {value.trim() === '' ? '—' : value}
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                  </Space>
                ),
              }}
              pagination={{
                current: rowPage,
                pageSize: rowPageSize,
                total: rowTotal,
                showSizeChanger: true,
                showTotal: (t) => `${t} rows`,
                onChange: (nextPage, nextSize) => {
                  setRowPage(nextSize !== rowPageSize ? 1 : nextPage);
                  setRowPageSize(nextSize);
                },
              }}
              locale={{ emptyText: rowStatus ? 'No rows with that status' : 'No staged rows' }}
            />

            <Space wrap>
              <Button onClick={() => goTo(0)}>Back to mapping</Button>
              {canEdit && (
                <Button
                  type="primary"
                  disabled={imp.status !== 'VALIDATED'}
                  onClick={() => goTo(2)}
                >
                  Continue to commit
                </Button>
              )}
              {imp.status !== 'VALIDATED' && imp.status !== 'COMMITTED' && (
                <Typography.Text type="secondary">
                  Re-validate the import to enable the commit step.
                </Typography.Text>
              )}
            </Space>
          </Space>
        </Card>
      )}

      {step === 2 && (
        <Card title="Commit">
          <Space direction="vertical" size={16} style={{ display: 'flex' }}>
            {imp.status === 'VALIDATED' ? (
              <>
                <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                  <Space align="start" size={12}>
                    <Switch
                      checked={createMissingManufacturers}
                      disabled={!canEdit}
                      onChange={setCreateMissingManufacturers}
                    />
                    <div>
                      <Typography.Text strong>
                        Create manufacturers that do not exist yet
                      </Typography.Text>
                      <div>
                        <Typography.Text type="secondary">
                          Off: a row naming an unknown manufacturer fails on its own and the rest
                          still commit.
                        </Typography.Text>
                      </div>
                    </div>
                  </Space>
                  <Space align="start" size={12}>
                    <Switch checked={updateExisting} disabled={!canEdit} onChange={setUpdateExisting} />
                    <div>
                      <Typography.Text strong>
                        Amend the{' '}
                        {counts.update === 1 ? 'row' : `${counts.update} rows`} that already have a
                        manufacturer part
                      </Typography.Text>
                      <div>
                        <Typography.Text type="secondary">
                          Off: only new rows are written and existing parts are left exactly as
                          they are.
                        </Typography.Text>
                      </div>
                    </div>
                  </Space>
                </Space>

                <Alert
                  type={eligible > 0 ? 'warning' : 'info'}
                  showIcon
                  message={
                    eligible > 0
                      ? `Committing will write ${eligible} row(s).`
                      : 'Nothing is eligible to commit.'
                  }
                  description={
                    <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                      <li>
                        <b>{counts.new}</b> new part{counts.new === 1 ? '' : 's'} created, each with
                        its manufacturer and manufacturer part. Rows without a part number in the
                        file get a generated one.
                      </li>
                      <li>
                        {updateExisting ? (
                          <>
                            <b>{counts.update}</b> existing manufacturer part
                            {counts.update === 1 ? '' : 's'} amended from the file.
                          </>
                        ) : (
                          <>
                            <b>{counts.update}</b> row{counts.update === 1 ? '' : 's'} match an
                            existing manufacturer part and will be left untouched.
                          </>
                        )}
                      </li>
                      <li>
                        <b>{notWritten}</b> row{notWritten === 1 ? '' : 's'} never written:{' '}
                        {counts.duplicate} duplicate, {counts.invalid} invalid, {counts.skipped}{' '}
                        skipped.
                      </li>
                      <li>
                        {createMissingManufacturers
                          ? 'Manufacturers named in the file that do not exist yet are created.'
                          : 'Rows naming a manufacturer that does not exist will fail; the others still commit.'}
                      </li>
                    </ul>
                  }
                />

                {canEdit && (
                  <Space wrap>
                    <Popconfirm
                      title={`Commit ${eligible} row(s)?`}
                      description="Parts, manufacturers and manufacturer parts are written. Deleting the import afterwards will not undo it."
                      okText="Commit"
                      disabled={eligible === 0}
                      onConfirm={() => void runCommit()}
                    >
                      <Button
                        type="primary"
                        icon={<CloudUploadOutlined />}
                        loading={busy === 'commit'}
                        disabled={eligible === 0}
                      >
                        Commit {eligible} row(s)
                      </Button>
                    </Popconfirm>
                    <Button onClick={() => goTo(1)}>Back to preview</Button>
                    {eligible === 0 && (
                      <Typography.Text type="secondary">
                        {counts.update > 0
                          ? 'Switch on amending to write the rows that match existing parts.'
                          : 'No new rows to write — check the mapping and re-validate.'}
                      </Typography.Text>
                    )}
                  </Space>
                )}
              </>
            ) : (
              <>
                <Alert
                  type={
                    imp.status === 'FAILED'
                      ? 'error'
                      : counts.failed > 0
                        ? 'warning'
                        : 'success'
                  }
                  showIcon
                  message={
                    imp.status === 'FAILED'
                      ? 'Nothing was committed'
                      : counts.failed > 0
                        ? `Committed ${counts.committed} row(s), ${counts.failed} failed`
                        : `Committed ${counts.committed} row(s)`
                  }
                  description={
                    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
                      {imp.error && <span>{imp.error}</span>}
                      <span>
                        {counts.committed} row{counts.committed === 1 ? '' : 's'} wrote a part and a
                        manufacturer part
                        {imp.committedAt ? ` on ${formatDate(imp.committedAt)}` : ''}.
                        {counts.failed > 0
                          ? ' The failed rows kept their status and carry the reason in the preview.'
                          : ''}
                      </span>
                      {imp.status === 'COMMITTED' && (
                        <span>
                          This import is now the record of what entered the system: it can no
                          longer be validated, changed or deleted.
                        </span>
                      )}
                      {imp.status === 'FAILED' && (
                        <span>
                          Fix the mapping or the source data, then validate the import again.
                        </span>
                      )}
                    </Space>
                  }
                />
                <Space wrap>
                  <Button
                    onClick={() => {
                      setRowStatus(undefined);
                      setRowPage(1);
                      goTo(1);
                    }}
                  >
                    Show the rows
                  </Button>
                  {!locked && <Button onClick={() => goTo(0)}>Back to mapping</Button>}
                </Space>
              </>
            )}
          </Space>
        </Card>
      )}

      <Modal
        title="Save as mapping"
        open={saveOpen}
        onOk={() => void saveMapping()}
        okText="Save"
        confirmLoading={saving}
        onCancel={() => setSaveOpen(false)}
        forceRender
      >
        {saveError && (
          <Alert type="error" showIcon message={saveError} style={{ marginBottom: 16 }} />
        )}
        <Form form={saveForm} layout="vertical">
          <Form.Item
            name="name"
            label="Mapping name"
            rules={[{ required: true, message: 'Name is required' }, { max: 120 }]}
          >
            <Input placeholder="Digi-Key — house mapping" />
          </Form.Item>
          <Form.Item name="vendor" label="Vendor">
            <Input placeholder="optional" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          The columns and defaults above are saved together with this file's{' '}
          {imp.sourceColumns.length} header{imp.sourceColumns.length === 1 ? '' : 's'} as the
          signature that recognizes this vendor next time.
        </Typography.Text>
      </Modal>
    </div>
  );
}
