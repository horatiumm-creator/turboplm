import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Divider,
  Input,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { ImportIssue, ImportResult, PartRef, RevisionSummary } from '../api/types';
import { LIFECYCLE_META } from '../components/meta';

type ImportTarget = 'parts' | 'bom';

interface PickerState {
  partId?: number;
  partOptions: PartRef[];
  revisions: RevisionSummary[];
  revisionId?: number;
}

const EMPTY_PICKER: PickerState = { partOptions: [], revisions: [] };

const PARTS_COLUMNS = 'partNumber,name,category,uom,unitCost,description';
const BOM_COLUMNS = 'childPartNumber,quantity,uom,findNumber,refDesignators';

const issueColumns: ColumnsType<ImportIssue> = [
  { title: 'Row', dataIndex: 'row', key: 'row', width: 90 },
  { title: 'Issue', dataIndex: 'message', key: 'message' },
];

export default function ErpExchange() {
  const { message } = AntdApp.useApp();

  const [exportPicker, setExportPicker] = useState<PickerState>(EMPTY_PICKER);
  const [importPicker, setImportPicker] = useState<PickerState>(EMPTY_PICKER);

  const [target, setTarget] = useState<ImportTarget>('parts');
  const [csv, setCsv] = useState('');
  /** A dry run must succeed for the CSV/target currently in the form before importing. */
  const [dryRunOk, setDryRunOk] = useState(false);
  const [busy, setBusy] = useState<'validate' | 'import' | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(searchTimer.current);
  }, []);

  const searchParts = useCallback(
    (value: string, setter: React.Dispatch<React.SetStateAction<PickerState>>) => {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            const res = await api.listParts({ search: value || undefined, pageSize: 20 });
            setter((prev) => ({ ...prev, partOptions: res.items }));
          } catch {
            /* options stay as-is */
          }
        })();
      }, 300);
    },
    []
  );

  const pickPart = useCallback(
    async (partId: number, setter: React.Dispatch<React.SetStateAction<PickerState>>) => {
      try {
        const part = await api.getPart(partId);
        setter((prev) => ({
          ...prev,
          partId,
          revisions: part.revisions,
          revisionId: part.revisions[0]?.id,
        }));
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    },
    [message]
  );

  const renderPicker = (
    state: PickerState,
    setter: React.Dispatch<React.SetStateAction<PickerState>>,
    onPicked?: () => void
  ) => (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Select
        showSearch
        placeholder="Search part number or name"
        style={{ width: '100%' }}
        filterOption={false}
        value={state.partId}
        onFocus={() => searchParts('', setter)}
        onSearch={(value) => searchParts(value, setter)}
        onSelect={(value: number) => {
          void pickPart(value, setter);
          onPicked?.();
        }}
        options={state.partOptions.map((p) => ({
          value: p.id,
          label: `${p.partNumber} — ${p.name}`,
        }))}
      />
      <Select
        placeholder="Revision"
        style={{ width: '100%' }}
        value={state.revisionId}
        disabled={state.revisions.length === 0}
        onChange={(value: number) => {
          setter((prev) => ({ ...prev, revisionId: value }));
          onPicked?.();
        }}
        options={state.revisions.map((r) => ({
          value: r.id,
          label: `Rev ${r.revision} — ${LIFECYCLE_META[r.lifecycle].label}`,
        }))}
      />
    </Space>
  );

  // ---- import ----

  const applyCsv = (text: string) => {
    setCsv(text);
    setDryRunOk(false);
  };

  const changeTarget = (next: ImportTarget) => {
    setTarget(next);
    setDryRunOk(false);
  };

  const run = async (dryRun: boolean) => {
    const revisionId = importPicker.revisionId;
    if (!csv.trim()) {
      message.warning('Paste or load some CSV first');
      return;
    }
    if (target === 'bom' && revisionId === undefined) {
      message.warning('Choose the part revision to import the BOM into');
      return;
    }
    setBusy(dryRun ? 'validate' : 'import');
    try {
      const res =
        target === 'bom' && revisionId !== undefined
          ? await api.importBom(revisionId, csv, dryRun)
          : await api.importParts(csv, dryRun);
      setResult(res);
      if (dryRun) {
        setDryRunOk(true);
        message.success(
          res.issues.length > 0
            ? `Dry run finished — ${res.issues.length} issue(s) found`
            : 'Dry run passed — no issues found'
        );
      } else {
        setDryRunOk(false);
        message.success(`Imported — ${res.created} created, ${res.updated} updated`);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const exportRevisionId = exportPicker.revisionId;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        ERP Exchange
      </Typography.Title>

      <Card title="Export">
        <Row gutter={[24, 24]}>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text strong>Item master</Typography.Text>
              <Typography.Text type="secondary">
                Every part with its category, unit of measure, unit cost, latest released
                revision and preferred manufacturer part.
              </Typography.Text>
              <Space wrap>
                <Button icon={<DownloadOutlined />} href={api.erpItemsUrl('csv')}>
                  Items CSV
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  href={api.erpItemsUrl('json')}
                  target="_blank"
                  rel="noreferrer"
                >
                  Items JSON
                </Button>
              </Space>
            </Space>
          </Col>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text strong>Single-level BOM</Typography.Text>
              <Typography.Text type="secondary">
                Pick a part and revision to export its immediate BOM lines for ERP.
              </Typography.Text>
              {renderPicker(exportPicker, setExportPicker)}
              <Space wrap>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={exportRevisionId === undefined}
                  href={
                    exportRevisionId === undefined
                      ? undefined
                      : api.erpBomUrl(exportRevisionId, 'csv')
                  }
                >
                  BOM CSV
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={exportRevisionId === undefined}
                  href={
                    exportRevisionId === undefined
                      ? undefined
                      : api.erpBomUrl(exportRevisionId, 'json')
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  BOM JSON
                </Button>
              </Space>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card title="Import">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Radio.Group
            value={target}
            onChange={(e) => changeTarget(e.target.value as ImportTarget)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'parts', label: 'Parts master' },
              { value: 'bom', label: 'BOM lines' },
            ]}
          />

          {target === 'bom' && (
            <Row gutter={[16, 8]}>
              <Col xs={24} md={12}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text strong>Import into</Typography.Text>
                  {renderPicker(importPicker, setImportPicker, () => setDryRunOk(false))}
                  <Typography.Text type="secondary">
                    The target revision must be In Work.
                  </Typography.Text>
                </Space>
              </Col>
            </Row>
          )}

          <Alert
            type="info"
            showIcon
            message={
              <span>
                Expected header row:{' '}
                <Typography.Text code>
                  {target === 'parts' ? PARTS_COLUMNS : BOM_COLUMNS}
                </Typography.Text>
              </span>
            }
            description={
              target === 'parts'
                ? 'Columns are matched by name (order-independent, case-insensitive); unknown columns are ignored. partNumber and name are required. Known part numbers are updated, new ones are created with revision A.'
                : 'Columns are matched by name (order-independent, case-insensitive). Unknown child part numbers are reported and skipped; existing lines for a child are updated, others are added. Leave findNumber blank to auto-assign.'
            }
          />

          <Input.TextArea
            rows={10}
            value={csv}
            onChange={(e) => applyCsv(e.target.value)}
            placeholder={`${target === 'parts' ? PARTS_COLUMNS : BOM_COLUMNS}\n…`}
            style={{ fontFamily: 'monospace' }}
          />

          <Space wrap>
            <Upload
              accept=".csv"
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  applyCsv(typeof reader.result === 'string' ? reader.result : '');
                  message.success(`Loaded ${file.name}`);
                };
                reader.onerror = () => message.error('Could not read that file');
                reader.readAsText(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>Load CSV file</Button>
            </Upload>
            <Button
              icon={<CheckCircleOutlined />}
              loading={busy === 'validate'}
              disabled={busy === 'import'}
              onClick={() => void run(true)}
            >
              Validate (dry run)
            </Button>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={busy === 'import'}
              disabled={!dryRunOk || busy === 'validate'}
              onClick={() => void run(false)}
            >
              Import
            </Button>
            {!dryRunOk && (
              <Typography.Text type="secondary">
                Run a dry run of the current CSV to enable Import.
              </Typography.Text>
            )}
          </Space>
        </Space>
      </Card>

      {result && (
        <Card
          title="Result"
          extra={
            result.dryRun ? (
              <Tag color="blue">Dry run — nothing was written</Tag>
            ) : (
              <Tag color="green">Imported</Tag>
            )
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}>
              <Statistic title="Rows parsed" value={result.parsed} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title="Created" value={result.created} valueStyle={{ color: '#389e0d' }} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic title="Updated" value={result.updated} valueStyle={{ color: '#0958d9' }} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="Skipped"
                value={result.skipped}
                valueStyle={result.skipped > 0 ? { color: '#d48806' } : undefined}
              />
            </Col>
          </Row>

          <Divider orientation="left" plain>
            Issues
          </Divider>
          <Table<ImportIssue>
            size="small"
            rowKey={(record, index) => `${index}-${record.row}`}
            columns={issueColumns}
            dataSource={result.issues}
            pagination={false}
            locale={{ emptyText: 'No issues' }}
          />
        </Card>
      )}
    </Space>
  );
}
