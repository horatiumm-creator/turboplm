import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { BomCompareResult, PartRef, RevisionSummary } from '../api/types';
import CompareResultView from '../components/CompareResultView';
import { LIFECYCLE_META } from '../components/meta';

interface SidePickerState {
  partId?: number;
  partOptions: PartRef[];
  revisions: RevisionSummary[];
  revisionId?: number;
}

export default function BomCompare() {
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const [left, setLeft] = useState<SidePickerState>({ partOptions: [], revisions: [] });
  const [right, setRight] = useState<SidePickerState>({ partOptions: [], revisions: [] });
  const [result, setResult] = useState<BomCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const hydratedRef = useRef(false);

  const searchParts = useCallback(
    (value: string, setter: React.Dispatch<React.SetStateAction<SidePickerState>>) => {
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
    async (partId: number, setter: React.Dispatch<React.SetStateAction<SidePickerState>>) => {
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

  const runCompare = useCallback(
    async (leftRevId: number, rightRevId: number) => {
      setLoading(true);
      try {
        const res = await api.compareBom(leftRevId, rightRevId);
        setResult(res);
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setLoading(false);
      }
    },
    [message]
  );

  // Hydrate from ?left=&right= once (e.g. arriving from an ECN item).
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const l = Number(searchParams.get('left'));
    const r = Number(searchParams.get('right'));
    if (!Number.isInteger(l) || l <= 0 || !Number.isInteger(r) || r <= 0) return;
    void (async () => {
      setLoading(true);
      try {
        const res = await api.compareBom(l, r);
        setResult(res);
        const [leftPart, rightPart] = await Promise.all([
          api.getPart(res.left.part.id),
          api.getPart(res.right.part.id),
        ]);
        setLeft({
          partId: leftPart.id,
          partOptions: [leftPart],
          revisions: leftPart.revisions,
          revisionId: l,
        });
        setRight({
          partId: rightPart.id,
          partOptions: [rightPart],
          revisions: rightPart.revisions,
          revisionId: r,
        });
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setLoading(false);
      }
    })();
  }, [searchParams, message]);

  useEffect(() => {
    return () => window.clearTimeout(searchTimer.current);
  }, []);

  const compareDisabled = left.revisionId === undefined || right.revisionId === undefined;

  const onCompare = () => {
    if (left.revisionId === undefined || right.revisionId === undefined) return;
    setSearchParams({ left: String(left.revisionId), right: String(right.revisionId) });
    void runCompare(left.revisionId, right.revisionId);
  };

  const picker = (
    label: string,
    state: SidePickerState,
    setter: React.Dispatch<React.SetStateAction<SidePickerState>>
  ) => (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>{label}</Typography.Text>
      <Select
        showSearch
        placeholder="Search part number or name"
        style={{ width: '100%' }}
        filterOption={false}
        value={state.partId}
        onFocus={() => searchParts('', setter)}
        onSearch={(value) => searchParts(value, setter)}
        onSelect={(value: number) => void pickPart(value, setter)}
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
        onChange={(value: number) => setter((prev) => ({ ...prev, revisionId: value }))}
        options={state.revisions.map((r) => ({
          value: r.id,
          label: `Rev ${r.revision} — ${LIFECYCLE_META[r.lifecycle].label}`,
        }))}
      />
    </Space>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        BOM Compare
      </Typography.Title>

      <Card>
        <Row gutter={[16, 16]} align="bottom">
          <Col xs={24} md={10}>
            {picker('Left side', left, setLeft)}
          </Col>
          <Col xs={24} md={10}>
            {picker('Right side', right, setRight)}
          </Col>
          <Col xs={24} md={4}>
            <Button
              type="primary"
              icon={<SwapOutlined />}
              block
              disabled={compareDisabled}
              loading={loading}
              onClick={onCompare}
            >
              Compare
            </Button>
          </Col>
        </Row>
      </Card>

      {loading && !result && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      )}

      {result && (
        <Spin spinning={loading}>
          <CompareResultView
            summary={result.summary}
            nodes={result.nodes}
            leftTitle={`${result.left.part.partNumber} rev ${result.left.revision.revision}`}
            rightTitle={`${result.right.part.partNumber} rev ${result.right.revision.revision}`}
          />
        </Spin>
      )}

      {!result && !loading && (
        <Empty description="Pick a part and revision on each side, then Compare. You can compare two revisions of the same part or two different products." />
      )}
    </Space>
  );
}
