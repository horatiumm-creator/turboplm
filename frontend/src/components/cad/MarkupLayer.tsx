import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AimOutlined,
  BorderOuterOutlined,
  CheckCircleOutlined,
  CommentOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import * as api from '../../api/client';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type { MarkupDetail, MarkupKind, MarkupTransition } from '../../api/types';
import { MARKUP_KIND_META, MarkupKindTag, MarkupStatusTag, formatDate } from '../meta';

/**
 * Rule K4 — the design-review overlay.
 *
 * The layer wraps the viewer instead of reaching into it: `children` is rendered untouched and
 * the overlay is a *sibling* positioned over the rendered content element, so `CadViewer` needs
 * no changes and keeps its own orbit / scroll behaviour. While no markup is being placed the
 * overlay does not accept pointer events at all, which is what "must not modify CadViewer's
 * behaviour when no markup is active" means in practice.
 */
export interface MarkupLayerProps {
  documentVersionId: number;
  /** The kind a click places. Existing markups of every kind are still shown. */
  kind: MarkupKind;
  readOnly: boolean;
  /** The viewer to overlay. Optional: a NOTE thread needs no geometry and no viewer. */
  children?: ReactNode;
  /** The drawing page the 2D anchors belong to; the toolbar can move it. */
  initialPage?: number;
}

interface ComposeValues {
  body: string;
}

/** A 2D anchor read back off the wire. `w`/`h` are null for a POINT_2D. */
interface Anchor2d {
  page: number;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
}

interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A drag in progress, in normalized coordinates. */
interface DragRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What the compose modal is about to POST once the author has said something. */
interface Draft {
  kind: MarkupKind;
  geometry: Record<string, unknown>;
  /** Human summary of where it landed, shown in the modal so the anchor is confirmable. */
  where: string;
}

const TWO_D_KINDS: MarkupKind[] = ['BOX_2D', 'POINT_2D'];

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Normalized coordinates go over the wire with six decimals: enough to be pixel-exact on any
 * screen, and short enough that the JSON stays readable. Out-of-range values are a 400 rather
 * than being clamped server-side, so the clamp happens here, on the way in.
 */
const norm = (n: number) => Math.round(clamp01(n) * 1e6) / 1e6;

function anchorOf(markup: MarkupDetail): Anchor2d | null {
  if (!TWO_D_KINDS.includes(markup.kind)) return null;
  const g = markup.geometry;
  if (typeof g.page !== 'number' || typeof g.x !== 'number' || typeof g.y !== 'number') return null;
  return {
    page: g.page,
    x: g.x,
    y: g.y,
    w: typeof g.w === 'number' ? g.w : null,
    h: typeof g.h === 'number' ? g.h : null,
  };
}

/** The stored camera of a PIN_3D, for the "look at what I was looking at" readout. */
function pin3dPoint(markup: MarkupDetail): number[] | null {
  const point = markup.geometry.point;
  if (!Array.isArray(point) || point.length !== 3) return null;
  return point.every((n) => typeof n === 'number') ? (point as number[]) : null;
}

/** RESOLVED and WONT_FIX are both settled points: an old review should not clutter a current one. */
const isSettled = (markup: MarkupDetail) => markup.status !== 'OPEN';

export default function MarkupLayer({
  documentVersionId,
  kind,
  readOnly,
  children,
  initialPage = 1,
}: MarkupLayerProps) {
  const { message, modal } = AntdApp.useApp();
  const { user } = useAuth();

  const [markups, setMarkups] = useState<MarkupDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [page, setPage] = useState(initialPage);
  const [placing, setPlacing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Compose (a new markup) and edit (the opening comment of an existing one).
  const [draft, setDraft] = useState<Draft | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeSaving, setComposeSaving] = useState(false);
  const [composeForm] = Form.useForm<ComposeValues>();
  const [editing, setEditing] = useState<MarkupDetail | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm<ComposeValues>();

  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({});

  const canWrite = !readOnly && user !== null && user.role !== 'VIEWER';
  const placeable = TWO_D_KINDS.includes(kind);

  // ---- data ---------------------------------------------------------------
  // Every status is fetched once and the "show resolved" toggle filters in the browser: the
  // toggle is a view of the same review, not a different question for the server.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const items = await api.listMarkups(documentVersionId);
      if (reqRef.current !== id) return; // a newer request has superseded this one
      setMarkups(items);
    } catch (err) {
      if (reqRef.current === id) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }, [documentVersionId, message]);

  useEffect(() => {
    setMarkups([]);
    setSelectedId(null);
    setPlacing(false);
    void load();
  }, [load]);

  // Disarm on a kind change. NOTE has nothing to place, so its toggle is not rendered — and
  // an armed overlay with no visible way to disarm it swallowed every click and scroll over
  // the viewer permanently.
  useEffect(() => {
    setPlacing(false);
  }, [kind]);

  // ---- where the overlay sits ---------------------------------------------
  // Normalized 0-1 coordinates only survive a zoom or a resize if they are measured against
  // the element that actually renders the content — the canvas, iframe or img inside the
  // viewer, NOT the card around it, which also holds the viewer's own toolbar. The overlay is
  // parked exactly over that element and re-measured whenever it moves or changes size.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<PixelBox | null>(null);
  const boxRef = useRef<PixelBox | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame) return;

    let observed: Element | null = null;

    const measure = () => {
      const content = frame.querySelector('canvas, iframe, img') as HTMLElement | null;
      if (!content) {
        observed = null;
        if (boxRef.current !== null) {
          boxRef.current = null;
          setBox(null);
        }
        return;
      }
      if (content !== observed) {
        if (observed) resizeObserver.unobserve(observed);
        observed = content;
        resizeObserver.observe(content);
      }
      const stageRect = stage.getBoundingClientRect();
      const rect = content.getBoundingClientRect();
      const next: PixelBox = {
        left: rect.left - stageRect.left,
        top: rect.top - stageRect.top,
        width: rect.width,
        height: rect.height,
      };
      const prev = boxRef.current;
      // Sub-pixel churn would re-render on every observer tick for no visible gain.
      const same =
        prev !== null &&
        Math.abs(prev.left - next.left) < 0.5 &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5 &&
        Math.abs(prev.height - next.height) < 0.5;
      if (!same) {
        boxRef.current = next;
        setBox(next);
      }
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(frame);
    // The viewer swaps its own children in (spinner → canvas, or a new derivative), and the
    // overlay is a sibling of `frame` so watching this subtree cannot feed itself.
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(frame, { childList: true, subtree: true });
    measure();
    // A late-loading iframe or img resizes without mutating, and Safari fires no resize for a
    // scroll-induced reflow, so a cheap poll backstops both.
    const timer = window.setInterval(measure, 1000);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.clearInterval(timer);
    };
  }, [children]);

  // ---- placing a new anchor ----------------------------------------------
  const toNormalized = (event: { clientX: number; clientY: number }) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: norm((event.clientX - rect.left) / rect.width),
      y: norm((event.clientY - rect.top) / rect.height),
    };
  };

  const openCompose = (next: Draft) => {
    setComposeError(null);
    composeForm.resetFields();
    setDraft(next);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing || !canWrite) return;
    const at = toNormalized(event);
    if (!at) return;
    if (kind === 'POINT_2D') {
      openCompose({
        kind,
        geometry: { page, x: at.x, y: at.y },
        where: `page ${page} at ${(at.x * 100).toFixed(1)}% / ${(at.y * 100).toFixed(1)}%`,
      });
      setPlacing(false);
      return;
    }
    if (kind === 'BOX_2D') {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ x0: at.x, y0: at.y, x1: at.x, y1: at.y });
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const at = toNormalized(event);
    if (!at) return;
    setDrag({ ...drag, x1: at.x, y1: at.y });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const at = toNormalized(event) ?? { x: drag.x1, y: drag.y1 };
    setDrag(null);
    const x = Math.min(drag.x0, at.x);
    const y = Math.min(drag.y0, at.y);
    // The server refuses w/h outside 0-1, and x+w may not leave the sheet either, so the
    // extent is trimmed to what is left of the page rather than sent and rejected.
    const w = norm(Math.min(Math.abs(at.x - drag.x0), 1 - x));
    const h = norm(Math.min(Math.abs(at.y - drag.y0), 1 - y));
    if (w < 0.005 || h < 0.005) {
      message.info('Drag a box over the area you want to mark up');
      return;
    }
    openCompose({
      kind: 'BOX_2D',
      geometry: { page, x: norm(x), y: norm(y), w, h },
      where: `page ${page}, ${(w * 100).toFixed(1)}% × ${(h * 100).toFixed(1)}% box`,
    });
    setPlacing(false);
  };

  const startNote = () =>
    openCompose({ kind: 'NOTE', geometry: {}, where: 'the whole version — no position' });

  const saveCompose = async () => {
    if (!draft) return;
    let values: ComposeValues;
    try {
      values = await composeForm.validateFields();
    } catch {
      return;
    }
    setComposeSaving(true);
    setComposeError(null);
    try {
      const created = await api.createMarkup(documentVersionId, {
        kind: draft.kind,
        geometry: draft.geometry,
        body: values.body.trim(),
      });
      setDraft(null);
      message.success('Markup added');
      setSelectedId(created.id);
      await load();
    } catch (err) {
      setComposeError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setComposeSaving(false);
    }
  };

  // ---- thread actions ----------------------------------------------------
  const addComment = async (markup: MarkupDetail) => {
    const body = (commentDrafts[markup.id] ?? '').trim();
    if (!body) {
      message.info('Write something before replying');
      return;
    }
    setBusyId(markup.id);
    try {
      await api.addMarkupComment(markup.id, body);
      setCommentDrafts((prev) => ({ ...prev, [markup.id]: '' }));
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusyId(null);
    }
  };

  const transition = async (markup: MarkupDetail, action: MarkupTransition) => {
    setBusyId(markup.id);
    try {
      await api.transitionMarkup(markup.id, action);
      await load();
    } catch (err) {
      // A refusal here is either a stale status or a concurrent change; both explain
      // themselves, so the server's wording is shown as-is.
      modal.error({
        title: `Cannot ${action} this markup`,
        content: err instanceof ApiError ? err.message : 'Something went wrong',
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const escalate = (markup: MarkupDetail) => {
    modal.confirm({
      title: 'Raise an ECR from this markup',
      content:
        'A change request is opened carrying this thread and a link back to the markup. The markup keeps its own status.',
      okText: 'Raise ECR',
      onOk: async () => {
        try {
          const updated = await api.escalateMarkup(markup.id);
          message.success(`${updated.ecr?.ecrNumber ?? 'ECR'} raised`);
          await load();
        } catch (err) {
          modal.error({
            title: 'Could not raise an ECR',
            content: err instanceof ApiError ? err.message : 'Something went wrong',
          });
          await load();
        }
      },
    });
  };

  const remove = (markup: MarkupDetail) => {
    modal.confirm({
      title: 'Delete markup',
      content: 'The markup and its whole thread are removed. This cannot be undone.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteMarkup(markup.id);
          message.success('Markup deleted');
          if (selectedId === markup.id) setSelectedId(null);
          await load();
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Something went wrong');
        }
      },
    });
  };

  const openEdit = (markup: MarkupDetail) => {
    setEditError(null);
    editForm.setFieldsValue({ body: markup.comments[0]?.body ?? '' });
    setEditing(markup);
  };

  const saveEdit = async () => {
    if (!editing) return;
    let values: ComposeValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await api.updateMarkup(editing.id, { body: values.body.trim() });
      setEditing(null);
      message.success('Markup updated');
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  // ---- derived lists ------------------------------------------------------
  /** Numbering follows the wire order (oldest first) so the overlay and the panel agree. */
  const numbered = useMemo(
    () => markups.map((markup, index) => ({ markup, index: index + 1 })),
    [markups]
  );
  const visible = useMemo(
    () => numbered.filter((entry) => showResolved || !isSettled(entry.markup)),
    [numbered, showResolved]
  );
  const settledCount = markups.filter(isSettled).length;
  const openCount = markups.length - settledCount;
  const drawable = visible.filter((entry) => {
    const anchor = anchorOf(entry.markup);
    return anchor !== null && anchor.page === page;
  });

  const canManage = (markup: MarkupDetail) =>
    canWrite && (user?.role === 'ADMIN' || user?.id === markup.createdBy.id);

  // ---- overlay ------------------------------------------------------------
  const dragStyle = ((): CSSProperties | null => {
    if (!drag) return null;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    return {
      position: 'absolute',
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
      height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
      border: '2px dashed #1677ff',
      background: 'rgba(22, 119, 255, 0.12)',
      pointerEvents: 'none',
    };
  })();

  const overlay = box && (
    <div
      ref={overlayRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // Inert unless a markup is being placed, so the viewer underneath keeps every gesture.
        pointerEvents: placing ? 'auto' : 'none',
        cursor: placing ? 'crosshair' : 'default',
        touchAction: placing ? 'none' : undefined,
        outline: placing ? '2px solid #1677ff' : undefined,
        outlineOffset: -2,
      }}
    >
      {drawable.map(({ markup, index }) => {
        const anchor = anchorOf(markup);
        if (!anchor) return null;
        const settled = isSettled(markup);
        const selected = selectedId === markup.id;
        const accent = settled ? '#8c8c8c' : '#cf1322';
        const common: CSSProperties = {
          position: 'absolute',
          // Markers stay clickable while the rest of the overlay is inert: selecting a point
          // is the only reason to reach through, and the targets are small.
          pointerEvents: placing ? 'none' : 'auto',
          cursor: 'pointer',
          opacity: settled ? 0.45 : 1,
          boxShadow: selected ? '0 0 0 3px rgba(22, 119, 255, 0.45)' : undefined,
        };
        if (anchor.w !== null && anchor.h !== null) {
          return (
            <Tooltip key={markup.id} title={markup.comments[0]?.body ?? `Markup #${index}`}>
              <div
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setSelectedId(markup.id);
                }}
                style={{
                  ...common,
                  left: `${anchor.x * 100}%`,
                  top: `${anchor.y * 100}%`,
                  width: `${anchor.w * 100}%`,
                  height: `${anchor.h * 100}%`,
                  border: `2px solid ${accent}`,
                  background: settled ? 'rgba(140,140,140,0.10)' : 'rgba(207,19,34,0.10)',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: -10,
                    left: -10,
                    minWidth: 20,
                    height: 20,
                    padding: '0 5px',
                    borderRadius: 10,
                    background: accent,
                    color: '#fff',
                    fontSize: 11,
                    lineHeight: '20px',
                    textAlign: 'center',
                  }}
                >
                  {index}
                </span>
              </div>
            </Tooltip>
          );
        }
        return (
          <Tooltip key={markup.id} title={markup.comments[0]?.body ?? `Markup #${index}`}>
            <div
              onPointerDown={(event) => {
                event.stopPropagation();
                setSelectedId(markup.id);
              }}
              style={{
                ...common,
                left: `${anchor.x * 100}%`,
                top: `${anchor.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                minWidth: 22,
                height: 22,
                padding: '0 6px',
                borderRadius: 11,
                background: accent,
                border: '2px solid #fff',
                color: '#fff',
                fontSize: 12,
                lineHeight: '18px',
                textAlign: 'center',
              }}
            >
              {index}
            </div>
          </Tooltip>
        );
      })}
      {dragStyle && <div style={dragStyle} />}
    </div>
  );

  // ---- toolbar ------------------------------------------------------------
  const placeHint = placeable
    ? `Click the ${kind === 'BOX_2D' ? 'drawing and drag a box' : 'drawing'} to anchor a markup`
    : MARKUP_KIND_META[kind].hint;

  const toolbar = (
    <Space wrap size={12} style={{ marginBottom: 8 }}>
      {canWrite && placeable && (
        <Button
          size="small"
          type={placing ? 'primary' : 'default'}
          icon={kind === 'BOX_2D' ? <BorderOuterOutlined /> : <AimOutlined />}
          onClick={() => setPlacing((prev) => !prev)}
        >
          {placing ? 'Cancel placing' : `Place ${MARKUP_KIND_META[kind].label}`}
        </Button>
      )}
      {canWrite && (
        <Button size="small" icon={<CommentOutlined />} onClick={startNote}>
          Add note
        </Button>
      )}
      {placeable && (
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Page
          </Typography.Text>
          <Tooltip title="Which sheet the anchors below belong to — a 2D markup is stored against a page">
            <InputNumber
              size="small"
              min={1}
              precision={0}
              style={{ width: 72 }}
              value={page}
              onChange={(value) => setPage(typeof value === 'number' && value >= 1 ? value : 1)}
            />
          </Tooltip>
        </Space>
      )}
      <Space size={6}>
        <Switch size="small" checked={showResolved} onChange={setShowResolved} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Show resolved ({settledCount})
        </Typography.Text>
      </Space>
      <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
        Refresh
      </Button>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {placing ? placeHint : `${openCount} open`}
      </Typography.Text>
    </Space>
  );

  // ---- thread panel -------------------------------------------------------
  const thread = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {readOnly && (
        <Alert
          type="info"
          showIcon
          message="Read-only — you can follow this review but not add to it."
        />
      )}
      {!readOnly && user?.role === 'VIEWER' && (
        <Alert
          type="info"
          showIcon
          message="Read-only access — a Viewer can read markups but not create, comment or resolve."
        />
      )}
      {visible.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            markups.length === 0
              ? 'No markups on this version yet'
              : `All ${settledCount} markups are settled — switch "Show resolved" on to see them`
          }
        />
      ) : (
        visible.map(({ markup, index }) => {
          const anchor = anchorOf(markup);
          const point = pin3dPoint(markup);
          const settled = isSettled(markup);
          const selected = selectedId === markup.id;
          return (
            <div
              key={markup.id}
              onClick={() => setSelectedId(markup.id)}
              style={{
                border: `1px solid ${selected ? '#1677ff' : '#e3e7ee'}`,
                borderRadius: 8,
                padding: 12,
                background: settled ? '#fafafa' : '#fff',
                opacity: settled ? 0.7 : 1,
                cursor: 'pointer',
              }}
            >
              <Space wrap size={6} style={{ marginBottom: 6 }}>
                <Tag color={settled ? 'default' : 'red'}>#{index}</Tag>
                <MarkupKindTag kind={markup.kind} />
                <MarkupStatusTag status={markup.status} />
                {anchor && <Tag>page {anchor.page}</Tag>}
                {anchor && anchor.page !== page && <Tag color="gold">other page</Tag>}
                {markup.kind === 'PIN_3D' && (
                  <Tooltip
                    title={
                      point
                        ? `Model point ${point.map((n) => n.toFixed(2)).join(', ')} — the stored camera is not restorable from this panel`
                        : 'Anchored in 3D'
                    }
                  >
                    <Tag>3D anchor</Tag>
                  </Tooltip>
                )}
                {markup.ecr && (
                  <Link to={`/ecrs/${markup.ecr.id}`} onClick={(e) => e.stopPropagation()}>
                    <Tag color="blue" icon={<ExportOutlined />}>
                      {markup.ecr.ecrNumber}
                    </Tag>
                  </Link>
                )}
              </Space>
              <Typography.Paragraph style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                {markup.comments[0]?.body ?? <Typography.Text type="secondary">—</Typography.Text>}
              </Typography.Paragraph>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {markup.createdBy.name} · {formatDate(markup.createdAt)}
                {markup.resolvedBy &&
                  ` · ${markup.status === 'WONT_FIX' ? 'closed' : 'resolved'} by ${markup.resolvedBy.name} ${formatDate(markup.resolvedAt)}`}
              </Typography.Text>

              {markup.comments.length > 1 && (
                <div style={{ marginTop: 10, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  {markup.comments.slice(1).map((comment) => (
                    <div key={comment.id} style={{ marginBottom: 8 }}>
                      <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                        {comment.body}
                      </Typography.Text>
                      <br />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {comment.createdBy.name} · {formatDate(comment.createdAt)}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )}

              {canWrite && (
                <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                  <Input.TextArea
                    rows={2}
                    maxLength={4000}
                    placeholder="Reply…"
                    value={commentDrafts[markup.id] ?? ''}
                    onChange={(e) =>
                      setCommentDrafts((prev) => ({ ...prev, [markup.id]: e.target.value }))
                    }
                  />
                  <Space wrap size={6} style={{ marginTop: 8 }}>
                    <Button
                      size="small"
                      type="primary"
                      loading={busyId === markup.id}
                      onClick={() => void addComment(markup)}
                    >
                      Reply
                    </Button>
                    {markup.status === 'OPEN' ? (
                      <>
                        <Button
                          size="small"
                          icon={<CheckCircleOutlined />}
                          loading={busyId === markup.id}
                          onClick={() => void transition(markup, 'resolve')}
                        >
                          Resolve
                        </Button>
                        <Button
                          size="small"
                          icon={<StopOutlined />}
                          loading={busyId === markup.id}
                          onClick={() => void transition(markup, 'wont-fix')}
                        >
                          Won&apos;t fix
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={busyId === markup.id}
                        onClick={() => void transition(markup, 'reopen')}
                      >
                        Reopen
                      </Button>
                    )}
                    {!markup.ecr && (
                      <Button
                        size="small"
                        icon={<ExportOutlined />}
                        onClick={() => escalate(markup)}
                      >
                        Raise ECR
                      </Button>
                    )}
                    {canManage(markup) && (
                      <>
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openEdit(markup)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => remove(markup)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </Space>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 460px', minWidth: 300 }}>
        {toolbar}
        <div ref={stageRef} style={{ position: 'relative' }}>
          <div ref={frameRef}>{children}</div>
          {overlay}
        </div>
        {!box && children !== undefined && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Anchors appear once the viewer has rendered.
          </Typography.Text>
        )}
      </div>
      <div style={{ flex: '1 1 320px', minWidth: 280, maxWidth: 520 }}>
        <Spin spinning={loading && markups.length === 0}>{thread}</Spin>
      </div>

      <Modal
        title={`New ${draft ? MARKUP_KIND_META[draft.kind].label : 'markup'}`}
        open={draft !== null}
        onOk={() => void saveCompose()}
        okText="Add markup"
        confirmLoading={composeSaving}
        onCancel={() => setDraft(null)}
        forceRender
      >
        {composeError && (
          <Alert type="error" showIcon message={composeError} style={{ marginBottom: 16 }} />
        )}
        {draft && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Anchored to {draft.where}.
          </Typography.Paragraph>
        )}
        <Form form={composeForm} layout="vertical">
          <Form.Item
            name="body"
            label="Comment"
            rules={[
              { required: true, message: 'Say what is wrong — an anchor with nothing said is noise' },
              { max: 4000, message: 'At most 4000 characters' },
            ]}
          >
            <Input.TextArea rows={4} placeholder="What should be changed here?" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Edit opening comment"
        open={editing !== null}
        onOk={() => void saveEdit()}
        okText="Save"
        confirmLoading={editSaving}
        onCancel={() => setEditing(null)}
        forceRender
      >
        {editError && (
          <Alert type="error" showIcon message={editError} style={{ marginBottom: 16 }} />
        )}
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="body"
            label="Comment"
            rules={[
              { required: true, message: 'The opening comment cannot be emptied' },
              { max: 4000, message: 'At most 4000 characters' },
            ]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
