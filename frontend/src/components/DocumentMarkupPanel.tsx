import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Alert, Segmented, Space, Spin, Tooltip, Typography } from 'antd';
import * as api from '../api/client';
import type { DocumentVersionDetail, MarkupKind } from '../api/types';
import { MARKUP_KIND_META } from './meta';
import MarkupLayer from './cad/MarkupLayer';
import { isPreviewable, previewKind } from './cad/preview';

const CadViewer = lazy(() => import('./cad/CadViewer'));

/**
 * Rule K4 — the composed design-review unit: viewer + overlay + thread, exported self-contained
 * so the page owner and the markup owner never edit the same file. `CadViewer` is composed
 * around, never modified: it is handed to `MarkupLayer` as children and renders exactly as it
 * does on its own.
 */
export interface DocumentMarkupPanelProps {
  /** Markups anchor to a version, never to a document (rule K1), so the version is the input. */
  version: DocumentVersionDetail;
  /** Forces the read-only thread regardless of role — e.g. an archived version. */
  readOnly?: boolean;
  height?: number;
}

/**
 * Which anchor kinds make sense for this file. A 2D box or point carries a page number and
 * normalized sheet coordinates, which mean nothing on a model that the user can orbit; a 3D pin
 * means nothing on a drawing. Offering only the applicable ones keeps the server from having to
 * refuse the obvious mistake.
 */
function kindsFor(version: DocumentVersionDetail): MarkupKind[] {
  const kind = version.hasGlb ? 'model3d' : previewKind(version.fileName);
  if (kind === 'model3d') return ['PIN_3D', 'NOTE'];
  // An image renders as an <img> we can measure, so normalized coordinates hold. A PDF renders
  // in an <iframe> whose internal scroll and page size we cannot see: coordinates normalized
  // against the frame detach from the drawing the moment it is scrolled or the window resizes,
  // which defeats the entire reason rule K1 normalizes them. Until PDFs are rendered natively,
  // a drawing takes version-level notes only — an anchor that lies about where it points is
  // worse than no anchor.
  if (kind === 'image') return ['POINT_2D', 'BOX_2D', 'NOTE'];
  if (kind === 'pdf') return ['NOTE'];
  return ['NOTE'];
}

export default function DocumentMarkupPanel({
  version,
  readOnly = false,
  height = 480,
}: DocumentMarkupPanelProps) {
  // Keyed on what actually decides the answer, not on the version object: the page refetches
  // while a CAD conversion is pending, and a fresh object each poll would reset the selection.
  const kinds = useMemo(() => kindsFor(version), [version.fileName, version.hasGlb]);
  const [kind, setKind] = useState<MarkupKind>(kinds[0]);

  // A different version can be a different file type, so the selection follows the file.
  useEffect(() => {
    setKind(kinds[0]);
  }, [kinds]);

  const viewable = isPreviewable(version.fileName) || version.hasGlb;

  const viewer = viewable ? (
    <Suspense
      fallback={
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin tip="Loading viewer…" />
        </div>
      }
    >
      <CadViewer
        // Remount when the derivative appears so the viewer picks it up.
        key={`${version.id}-${version.hasGlb ? 'glb' : 'src'}`}
        fileUrl={api.documentVersionFileUrl(version.id, true)}
        fileName={version.fileName}
        height={height}
        glbUrl={version.hasGlb ? api.documentVersionGlbUrl(version.id) : undefined}
      />
    </Suspense>
  ) : undefined;

  return (
    <div>
      <Space wrap size={12} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Anchor
        </Typography.Text>
        <Segmented
          size="small"
          value={kind}
          onChange={(value) => setKind(value as MarkupKind)}
          options={kinds.map((value) => ({
            value,
            label: (
              <Tooltip title={MARKUP_KIND_META[value].hint}>
                <span>{MARKUP_KIND_META[value].label}</span>
              </Tooltip>
            ),
          }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          v{version.version} · {version.fileName}
        </Typography.Text>
      </Space>

      {kind === 'PIN_3D' && !readOnly && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="3D pins cannot be placed from this panel yet"
          description="A pin stores a model-space point and the camera that framed it, which only the 3D viewer can supply. Existing pins are listed in the thread; use a note until the viewer exposes a pick callback."
        />
      )}
      {!viewable && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`No viewer for ${version.fileName} — version-level notes only`}
          description="Positioned markups need a rendered drawing or model. Export a neutral format (e.g. STEP) or a PDF to anchor comments to geometry."
        />
      )}

      <MarkupLayer documentVersionId={version.id} kind={kind} readOnly={readOnly}>
        {viewer}
      </MarkupLayer>
    </div>
  );
}
