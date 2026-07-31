import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Modal,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import type {
  CadBomChange,
  CadBomProposal,
  CadBomProposalLine,
  DocumentSummary,
  RevisionDetail,
} from '../../api/types';

const CHANGE_META: Record<CadBomChange, { label: string; color: string; hint: string }> = {
  ADD: { label: 'Add', color: 'green', hint: 'In the CAD assembly, not yet on the eBOM' },
  QTY_CHANGE: { label: 'Quantity', color: 'gold', hint: 'On the eBOM with a different quantity' },
  REMOVE: { label: 'Remove', color: 'red', hint: 'On the eBOM but absent from the CAD assembly' },
  UNMATCHED: { label: 'No part', color: 'default', hint: 'No part matches this CAD product name' },
  UNCHANGED: { label: 'Unchanged', color: 'blue', hint: 'Already correct' },
};

/** Only these formats carry a readable product hierarchy. */
const READABLE = /\.(step|stp|iges|igs|brep|brp)$/i;

export default function CadImportModal({
  revision,
  open,
  onClose,
  onApplied,
}: {
  revision: RevisionDetail;
  open: boolean;
  onClose: () => void;
  /** Called after a successful apply so the caller can reload the BOM. */
  onApplied: () => void;
}) {
  const { message } = AntdApp.useApp();

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [versionId, setVersionId] = useState<number | undefined>(undefined);

  const [proposal, setProposal] = useState<CadBomProposal | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [loadingProposal, setLoadingProposal] = useState(false);
  const [applying, setApplying] = useState(false);

  const [removeMissing, setRemoveMissing] = useState(false);
  const [createMissingParts, setCreateMissingParts] = useState(false);
  const [recursive, setRecursive] = useState(false);

  // CAD models can hang off either the part or this specific revision.
  const loadDocuments = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const [onPart, onRevision] = await Promise.all([
        api.getPartDocuments(revision.part.id),
        api.getRevisionDocuments(revision.id),
      ]);
      const seen = new Set<number>();
      const readable: DocumentSummary[] = [];
      for (const entry of [...onPart, ...onRevision]) {
        const doc = entry.document;
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        if (doc.latestVersion && READABLE.test(doc.latestVersion.fileName)) readable.push(doc);
      }
      setDocuments(readable);
      if (readable.length === 1 && readable[0].latestVersion) {
        setVersionId(readable[0].latestVersion.id);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Could not list CAD documents');
    } finally {
      setLoadingDocs(false);
    }
  }, [revision.id, revision.part.id, message]);

  useEffect(() => {
    if (!open) return;
    setProposal(null);
    setProposalError(null);
    setRemoveMissing(false);
    setCreateMissingParts(false);
    setRecursive(false);
    void loadDocuments();
  }, [open, loadDocuments]);

  const preview = useCallback(
    async (id: number, deep: boolean) => {
      setLoadingProposal(true);
      setProposalError(null);
      setProposal(null);
      try {
        // A dry run writes nothing, so it is safe to fire on every selection.
        setProposal(
          await api.bomFromCad(revision.id, { documentVersionId: id, recursive: deep })
        );
      } catch (err) {
        setProposalError(err instanceof ApiError ? err.message : 'Could not read the assembly');
      } finally {
        setLoadingProposal(false);
      }
    },
    [revision.id]
  );

  useEffect(() => {
    if (open && versionId !== undefined) void preview(versionId, recursive);
  }, [open, versionId, recursive, preview]);

  const apply = async () => {
    if (versionId === undefined) return;
    setApplying(true);
    try {
      const result = await api.bomFromCad(revision.id, {
        documentVersionId: versionId,
        apply: true,
        removeMissing,
        createMissingParts,
        recursive,
      });
      const { add, qtyChange, remove } = result.totals;
      const applied = add + qtyChange + (removeMissing ? remove : 0);
      message.success(
        applied === 0 ? 'eBOM already matches the CAD assembly' : `${applied} eBOM line(s) updated`
      );
      setProposal(result);
      onApplied();
      onClose();
    } catch (err) {
      setProposalError(err instanceof ApiError ? err.message : 'Could not apply the proposal');
    } finally {
      setApplying(false);
    }
  };

  const options = useMemo(
    () =>
      documents
        .filter((doc) => doc.latestVersion)
        .map((doc) => ({
          value: doc.latestVersion!.id,
          label: `${doc.docNumber} — ${doc.latestVersion!.fileName} (v${doc.latestVersion!.version})`,
        })),
    [documents]
  );

  const columns: ColumnsType<CadBomProposalLine> = [
    {
      title: 'Change',
      key: 'change',
      width: 120,
      render: (_, line) => {
        const meta = CHANGE_META[line.change];
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: 'CAD product',
      key: 'cadName',
      render: (_, line) => line.cadName ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Part',
      key: 'part',
      render: (_, line) =>
        line.part ? (
          <Space size={6} wrap>
            <Link to={`/parts/${line.part.id}`}>{line.part.partNumber}</Link>
            <Typography.Text type="secondary">{line.part.name}</Typography.Text>
            {line.matchedBy === 'NAME' && <Tag>matched by name</Tag>}
          </Space>
        ) : (
          <Typography.Text type="secondary">no match</Typography.Text>
        ),
    },
    {
      title: 'CAD qty',
      key: 'cadQuantity',
      width: 90,
      align: 'right',
      render: (_, line) => line.cadQuantity ?? '—',
    },
    {
      title: 'eBOM qty',
      key: 'bomQuantity',
      width: 100,
      align: 'right',
      render: (_, line) => line.bomQuantity ?? '—',
    },
  ];

  const counts = proposal?.totals;
  const writes = counts ? counts.add + counts.qtyChange + (removeMissing ? counts.remove : 0) : 0;

  return (
    <Modal
      title="Import eBOM from CAD"
      open={open}
      onCancel={onClose}
      width={860}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="apply"
          type="primary"
          loading={applying}
          disabled={!proposal || (writes === 0 && !createMissingParts)}
          onClick={() => void apply()}
        >
          {writes === 0 && createMissingParts
            ? 'Create parts and add them'
            : `Apply ${writes} change${writes === 1 ? '' : 's'}`}
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          The assembly&#39;s top level becomes this revision&#39;s eBOM. Products are matched to
          parts by part number first, then by name.
        </Typography.Text>

        {!loadingDocs && options.length === 0 && (
          <Alert
            type="info"
            showIcon
            message="No readable CAD model is linked to this part"
            description="Attach a STEP, IGES or BREP file on the Documents tab, then come back."
          />
        )}

        {options.length > 0 && (
          <Select
            style={{ width: '100%' }}
            placeholder="Choose a CAD model"
            loading={loadingDocs}
            options={options}
            value={versionId}
            onChange={setVersionId}
          />
        )}

        {loadingProposal && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Spin tip="Reading the assembly structure…" />
          </div>
        )}

        {proposalError && <Alert type="error" showIcon message={proposalError} />}

        {proposal && counts && (
          <>
            <Space size={24} wrap>
              <Statistic title="Assembly" value={proposal.assemblyName} />
              <Statistic title="Add" value={counts.add} />
              <Statistic title="Quantity" value={counts.qtyChange} />
              <Statistic title="Remove" value={counts.remove} />
              <Statistic title="No part" value={counts.unmatched} />
              <Statistic title="Unchanged" value={counts.unchanged} />
            </Space>

            {proposal.deeperNodeCount > 0 && (
              <Alert
                type="info"
                showIcon
                message={`${proposal.deeperNodeCount} deeper CAD node(s) were not imported`}
                description="Sub-assembly contents belong to those parts' own eBOMs — import them from each child part."
              />
            )}

            <Space direction="vertical" size={4}>
              <Checkbox checked={recursive} onChange={(e) => setRecursive(e.target.checked)}>
                Import every level — each sub-assembly into its own part&#39;s In Work revision
              </Checkbox>
              <Checkbox
                checked={createMissingParts}
                disabled={counts.unmatched === 0}
                onChange={(e) => setCreateMissingParts(e.target.checked)}
              >
                Create parts for the {counts.unmatched} unmatched product(s) and add them
              </Checkbox>
              <Checkbox
                checked={removeMissing}
                disabled={counts.remove === 0}
                onChange={(e) => setRemoveMissing(e.target.checked)}
              >
                Remove the {counts.remove} eBOM line(s) absent from the CAD assembly
              </Checkbox>
              {counts.remove > 0 && !removeMissing && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Left unchecked so a partial CAD export cannot strip your eBOM.
                </Typography.Text>
              )}
            </Space>

            {proposal.skippedAssemblies.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${proposal.skippedAssemblies.length} sub-assembly(ies) could not be imported`}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {proposal.skippedAssemblies.map((skipped) => (
                      <li key={skipped.cadName}>
                        <strong>{skipped.cadName}</strong> — {skipped.reason}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}

            {proposal.levels.map((level) => (
              <div key={`${level.revision.id}-${level.assemblyName}`}>
                {proposal.levels.length > 1 && (
                  <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
                    {level.assemblyName}
                    {level.part ? (
                      <Typography.Text type="secondary">
                        {' '}
                        → {level.part.partNumber} rev {level.revision.revision}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary"> → this revision</Typography.Text>
                    )}
                  </Typography.Text>
                )}
                <Table<CadBomProposalLine>
                  size="small"
                  rowKey={(line) => `${line.change}-${line.part?.id ?? line.cadName}`}
                  columns={columns}
                  dataSource={level.lines}
                  pagination={false}
                />
              </div>
            ))}
          </>
        )}
      </Space>
    </Modal>
  );
}
