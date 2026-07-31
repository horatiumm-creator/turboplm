import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type {
  CadAssembly,
  CadAssemblyNode,
  CadDiffChange,
  CadStructureDiff,
  CadStructureDiffRow,
  CbomReconciliation,
  CbomReconciliationRow,
  CbomReconStatus,
  DocumentSummary,
  RevisionDetail,
} from '../../api/types';
import { formatDate } from '../meta';

/** Only these formats carry a readable product hierarchy. */
const READABLE = /\.(step|stp|iges|igs|brep|brp)$/i;

const RECON_META: Record<CbomReconStatus, { label: string; color: string; hint: string }> = {
  QTY_MISMATCH: {
    label: 'Quantity differs',
    color: 'gold',
    hint: 'The model and the eBOM disagree on how many are used',
  },
  MISSING_IN_EBOM: {
    label: 'Not on eBOM',
    color: 'red',
    hint: 'Modelled in CAD but never released to the eBOM',
  },
  EXTRA_IN_EBOM: {
    label: 'Not in model',
    color: 'volcano',
    hint: 'On the eBOM but absent from the CAD assembly',
  },
  UNMATCHED: {
    label: 'No part',
    color: 'default',
    hint: 'No part matches this CAD product name, so it cannot be compared',
  },
  MATCH: { label: 'Aligned', color: 'green', hint: 'The model and the eBOM agree' },
};

const DIFF_META: Record<CadDiffChange, { label: string; color: string }> = {
  ADDED: { label: 'Added', color: 'green' },
  REMOVED: { label: 'Removed', color: 'red' },
  QTY_CHANGED: { label: 'Quantity', color: 'gold' },
  UNCHANGED: { label: 'Unchanged', color: 'default' },
};

interface TreeRow {
  key: string;
  node: CadAssemblyNode;
  children?: TreeRow[];
}

function toRows(nodes: CadAssemblyNode[], prefix: string): TreeRow[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${node.name}-${index}`;
    return {
      key,
      node,
      children: node.children.length > 0 ? toRows(node.children, `${key}/`) : undefined,
    };
  });
}

export default function CbomTab({ revision }: { revision: RevisionDetail }) {
  const { message } = AntdApp.useApp();

  /** Every readable CAD version across the linked documents, newest first. */
  const [versions, setVersions] = useState<
    { id: number; label: string; createdAt: string }[]
  >([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [versionId, setVersionId] = useState<number | undefined>(undefined);

  const [assembly, setAssembly] = useState<CadAssembly | null>(null);
  const [loadingAssembly, setLoadingAssembly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [recon, setRecon] = useState<CbomReconciliation | null>(null);
  const [reconError, setReconError] = useState<string | null>(null);

  const [compareId, setCompareId] = useState<number | undefined>(undefined);
  const [diff, setDiff] = useState<CadStructureDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // CAD models can hang off either the part or this specific revision.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingDocs(true);
      try {
        const [onPart, onRevision] = await Promise.all([
          api.getPartDocuments(revision.part.id),
          api.getRevisionDocuments(revision.id),
        ]);
        if (cancelled) return;

        const candidates: DocumentSummary[] = [];
        const seen = new Set<number>();
        for (const entry of [...onPart, ...onRevision]) {
          const doc = entry.document;
          if (seen.has(doc.id)) continue;
          seen.add(doc.id);
          if (doc.latestVersion && READABLE.test(doc.latestVersion.fileName)) candidates.push(doc);
        }

        // Comparing v1 against v2 of the same model is the point of the diff, so every
        // version has to be listed — the summary only carries the latest one.
        const details = await Promise.all(
          candidates.map((doc) => api.getDocument(doc.id).catch(() => null))
        );
        if (cancelled) return;
        const all = details
          .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
          .flatMap((doc) =>
            doc.versions
              .filter((version) => READABLE.test(version.fileName))
              .map((version) => ({
                id: version.id,
                label: `${doc.docNumber} v${version.version} — ${version.fileName}`,
                createdAt: version.createdAt,
              }))
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        setVersions(all);
        if (all[0]) setVersionId(all[0].id);
      } catch (err) {
        if (!cancelled) {
          message.error(err instanceof ApiError ? err.message : 'Could not list CAD documents');
        }
      } finally {
        if (!cancelled) setLoadingDocs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision.id, revision.part.id, message]);

  const loadAssembly = useCallback(
    async (id: number, refresh = false) => {
      setLoadingAssembly(true);
      setReconError(null);
      try {
        const [tree, reconciliation] = await Promise.all([
          refresh ? api.refreshCadAssembly(id) : api.getCadAssembly(id),
          api
            .getCbomReconciliation(revision.id, id)
            .catch((err: unknown) => {
              setReconError(err instanceof ApiError ? err.message : 'Could not compare');
              return null;
            }),
        ]);
        setAssembly(tree);
        setRecon(reconciliation);
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : 'Could not read the CAD structure');
      } finally {
        setLoadingAssembly(false);
      }
    },
    [revision.id, message]
  );

  useEffect(() => {
    if (versionId !== undefined) void loadAssembly(versionId);
  }, [versionId, loadAssembly]);

  const refresh = async () => {
    if (versionId === undefined) return;
    setRefreshing(true);
    try {
      await loadAssembly(versionId, true);
      message.success('Structure re-read from the CAD file');
    } finally {
      setRefreshing(false);
    }
  };

  const runDiff = useCallback(
    async (fromId: number, toId: number) => {
      setLoadingDiff(true);
      setDiffError(null);
      setDiff(null);
      try {
        setDiff(await api.getCadDiff(fromId, toId));
      } catch (err) {
        setDiffError(err instanceof ApiError ? err.message : 'Could not compare the versions');
      } finally {
        setLoadingDiff(false);
      }
    },
    []
  );

  useEffect(() => {
    if (compareId !== undefined && versionId !== undefined) void runDiff(compareId, versionId);
    else setDiff(null);
  }, [compareId, versionId, runDiff]);

  const versionOptions = useMemo(
    () => versions.map((version) => ({ value: version.id, label: version.label })),
    [versions]
  );

  const treeRows = useMemo(
    () => (assembly?.root ? toRows([assembly.root], '') : []),
    [assembly]
  );

  const treeColumns: ColumnsType<TreeRow> = [
    {
      title: 'CAD product',
      key: 'name',
      render: (_, row) => <Typography.Text>{row.node.name}</Typography.Text>,
    },
    {
      title: 'Qty',
      key: 'instances',
      width: 90,
      align: 'right',
      render: (_, row) => row.node.instances,
    },
    {
      title: 'Matched part',
      key: 'match',
      render: (_, row) =>
        row.node.match ? (
          <Space size={6} wrap>
            <Link to={`/parts/${row.node.match.part.id}`}>{row.node.match.part.partNumber}</Link>
            <Typography.Text type="secondary">{row.node.match.part.name}</Typography.Text>
            {row.node.match.by === 'NAME' && <Tag>by name</Tag>}
          </Space>
        ) : (
          <Tooltip title="No part matches this product name — create one or rename the part to match">
            <Tag>unmatched</Tag>
          </Tooltip>
        ),
    },
  ];

  const reconColumns: ColumnsType<CbomReconciliationRow> = [
    {
      title: 'Part',
      key: 'part',
      render: (_, row) =>
        row.part ? (
          <Space size={6} wrap>
            <Link to={`/parts/${row.part.id}`}>{row.part.partNumber}</Link>
            <Typography.Text type="secondary">{row.part.name}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{row.cadName}</Typography.Text>
        ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 160,
      render: (_, row) => {
        const meta = RECON_META[row.status];
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'cBOM',
      key: 'cad',
      width: 90,
      align: 'right',
      render: (_, row) => row.cadQuantity ?? '—',
    },
    {
      title: 'eBOM',
      key: 'ebom',
      width: 90,
      align: 'right',
      render: (_, row) => row.ebomQuantity ?? '—',
    },
  ];

  const diffColumns: ColumnsType<CadStructureDiffRow> = [
    {
      title: 'Change',
      key: 'change',
      width: 120,
      render: (_, row) => {
        const meta = DIFF_META[row.change];
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: 'Occurrence',
      key: 'path',
      render: (_, row) => <Typography.Text code>{row.path}</Typography.Text>,
    },
    {
      title: 'Was',
      key: 'from',
      width: 90,
      align: 'right',
      render: (_, row) => row.fromQuantity ?? '—',
    },
    {
      title: 'Now',
      key: 'to',
      width: 90,
      align: 'right',
      render: (_, row) => row.toQuantity ?? '—',
    },
  ];

  if (loadingDocs) return <Skeleton active />;

  if (versionOptions.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>No readable CAD model is linked to this part</Typography.Text>
              <Typography.Text type="secondary">
                Attach a STEP, IGES or BREP file on the Documents tab — the cBOM is read from it.
              </Typography.Text>
            </Space>
          }
        />
      </Card>
    );
  }

  const reconDefects = recon
    ? recon.counts.qtyMismatch + recon.counts.missingInEbom + recon.counts.extraInEbom
    : 0;

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card
        title="CAD structure"
        extra={
          <Space>
            <Select
              size="small"
              style={{ minWidth: 300 }}
              options={versionOptions}
              value={versionId}
              onChange={setVersionId}
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              Re-read
            </Button>
          </Space>
        }
      >
        {loadingAssembly && !assembly ? (
          <Skeleton active />
        ) : !assembly ? null : assembly.status !== 'DONE' ? (
          <Alert
            type={assembly.status === 'FAILED' ? 'error' : 'info'}
            showIcon
            message={
              assembly.status === 'FAILED'
                ? 'The CAD kernel could not read this file'
                : 'This file carries no readable product structure'
            }
            description={assembly.reason}
          />
        ) : (
          <Space direction="vertical" size={12} style={{ display: 'flex' }}>
            <Space size={16} wrap>
              <Typography.Text type="secondary">
                {assembly.nodeCount} product{assembly.nodeCount === 1 ? '' : 's'} ·{' '}
                {assembly.maxDepth} level{assembly.maxDepth === 1 ? '' : 's'}
              </Typography.Text>
              {assembly.extractedAt && (
                <Typography.Text type="secondary">
                  read {formatDate(assembly.extractedAt)}
                </Typography.Text>
              )}
            </Space>
            <Table<TreeRow>
              size="small"
              rowKey="key"
              columns={treeColumns}
              dataSource={treeRows}
              loading={loadingAssembly}
              pagination={false}
              expandable={{ defaultExpandAllRows: true }}
            />
          </Space>
        )}
      </Card>

      <Card title="cBOM ↔ eBOM">
        {reconError ? (
          <Alert type="info" showIcon message={reconError} />
        ) : !recon ? (
          <Skeleton active />
        ) : recon.rows.length === 0 ? (
          <Alert
            type="info"
            showIcon
            message="Nothing to compare"
            description="The CAD assembly has no top-level products and this revision has no eBOM lines."
          />
        ) : (
          <Space direction="vertical" size={12} style={{ display: 'flex' }}>
            {reconDefects === 0 ? (
              <Alert
                type="success"
                showIcon
                message="The eBOM matches the CAD model"
                description={`${recon.counts.match} product(s) aligned${
                  recon.counts.unmatched > 0
                    ? `, ${recon.counts.unmatched} CAD product(s) with no matching part`
                    : ''
                }.`}
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                message={`${reconDefects} difference${reconDefects === 1 ? '' : 's'} between design and engineering`}
                description={
                  <Space size={12} wrap>
                    {recon.counts.missingInEbom > 0 && (
                      <span>{recon.counts.missingInEbom} modelled but not on the eBOM</span>
                    )}
                    {recon.counts.qtyMismatch > 0 && (
                      <span>{recon.counts.qtyMismatch} quantity disagreement(s)</span>
                    )}
                    {recon.counts.extraInEbom > 0 && (
                      <span>{recon.counts.extraInEbom} on the eBOM but not modelled</span>
                    )}
                  </Space>
                }
              />
            )}
            <Table<CbomReconciliationRow>
              size="small"
              rowKey={(row) => `${row.part?.id ?? row.cadName}`}
              columns={reconColumns}
              dataSource={recon.rows}
              pagination={false}
            />
          </Space>
        )}
      </Card>

      <Card
        title="Compare CAD versions"
        extra={
          <Select
            size="small"
            allowClear
            style={{ minWidth: 300 }}
            placeholder="Compare against…"
            options={versionOptions.filter((option) => option.value !== versionId)}
            value={compareId}
            onChange={setCompareId}
          />
        }
      >
        {compareId === undefined ? (
          <Typography.Text type="secondary">
            Pick an earlier CAD version to see what changed in the model.
          </Typography.Text>
        ) : loadingDiff ? (
          <Skeleton active />
        ) : diffError ? (
          <Alert type="info" showIcon message={diffError} />
        ) : !diff ? null : (
          <Space direction="vertical" size={12} style={{ display: 'flex' }}>
            <Space size={12} wrap>
              <Typography.Text type="secondary">
                <SwapOutlined /> {diff.from.docNumber} v{diff.from.version} → {diff.to.docNumber} v
                {diff.to.version}
              </Typography.Text>
              <Tag color="green">{diff.counts.added} added</Tag>
              <Tag color="red">{diff.counts.removed} removed</Tag>
              <Tag color="gold">{diff.counts.qtyChanged} quantity</Tag>
              <Tag>{diff.counts.unchanged} unchanged</Tag>
            </Space>
            {diff.rootRenamed && (
              <Alert
                type="info"
                showIcon
                message={`The top assembly was renamed: ${diff.from.rootName} → ${diff.to.rootName}`}
                description="Occurrence paths are relative to the root, so the structure below is still compared normally."
              />
            )}
            <Table<CadStructureDiffRow>
              size="small"
              rowKey="path"
              columns={diffColumns}
              dataSource={diff.rows}
              pagination={false}
            />
          </Space>
        )}
      </Card>
    </Space>
  );
}
