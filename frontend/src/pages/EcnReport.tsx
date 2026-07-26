import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { App as AntdApp, Button, Empty, Spin } from 'antd';
import { ArrowLeftOutlined, PrinterOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import type { EcnDetail, EcnImpactEntry } from '../api/types';
import {
  ECN_DISPOSITION_META,
  ECN_PRIORITY_META,
  ECN_REVIEW_DECISION_META,
  ECN_STATUS_META,
  formatDate,
} from '../components/meta';

const pageStyle: CSSProperties = {
  background: '#fff',
  minHeight: '100vh',
  padding: '32px 24px 64px',
  color: '#1f1f1f',
};

const sheetStyle: CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
  fontSize: 14,
  lineHeight: 1.6,
};

const letterheadStyle: CSSProperties = {
  borderBottom: '3px solid #1f1f1f',
  paddingBottom: 8,
  marginBottom: 24,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: '#434343',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: '#434343',
  borderBottom: '1px solid #d9d9d9',
  paddingBottom: 4,
  margin: '32px 0 12px',
};

const metaLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: '#8c8c8c',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const cellStyle: CSSProperties = {
  border: '1px solid #bfbfbf',
  padding: '6px 10px',
  textAlign: 'left',
  verticalAlign: 'top',
};

const headCellStyle: CSSProperties = {
  ...cellStyle,
  background: '#f5f5f5',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={metaLabelStyle}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

export default function EcnReport() {
  const { id: idParam } = useParams();
  const ecnId = Number(idParam);
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  const [ecn, setEcn] = useState<EcnDetail | null>(null);
  const [impact, setImpact] = useState<EcnImpactEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(ecnId) || ecnId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const [detail, impactEntries] = await Promise.all([
        api.getEcn(ecnId),
        api.getEcnImpact(ecnId).catch(() => null),
      ]);
      setEcn(detail);
      setImpact(impactEntries);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else message.error(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [ecnId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div style={{ ...pageStyle, display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !ecn) {
    return (
      <div style={{ ...pageStyle, paddingTop: 120 }}>
        <Empty description="Engineering change not found">
          <Link to="/ecns">Back to changes</Link>
        </Empty>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <div style={sheetStyle}>
        <div
          className="no-print"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16 }}
        >
          <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print
          </Button>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
            Back
          </Button>
        </div>

        <div style={letterheadStyle}>TurboPLM — Engineering Change Notice</div>

        <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.2 }}>{ecn.ecnNumber}</div>
        <div style={{ fontSize: 18, marginTop: 4, marginBottom: 24 }}>{ecn.title}</div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '12px 24px',
            border: '1px solid #d9d9d9',
            borderRadius: 4,
            padding: 16,
          }}
        >
          <MetaItem label="Status">{ECN_STATUS_META[ecn.status].label}</MetaItem>
          <MetaItem label="Priority">{ECN_PRIORITY_META[ecn.priority].label}</MetaItem>
          <MetaItem label="Effectivity date">{formatDate(ecn.effectivityDate)}</MetaItem>
          <MetaItem label="Created">
            {ecn.createdBy.name} · {formatDate(ecn.createdAt)}
          </MetaItem>
          <MetaItem label="Approved">
            {ecn.approvedBy ? `${ecn.approvedBy.name} · ${formatDate(ecn.approvedAt)}` : '—'}
          </MetaItem>
          <MetaItem label="Released">{formatDate(ecn.releasedAt)}</MetaItem>
        </div>

        <div style={sectionTitleStyle}>Reason for change</div>
        <p style={{ margin: 0 }}>{ecn.reason ?? '—'}</p>

        <div style={sectionTitleStyle}>Description</div>
        <p style={{ margin: 0 }}>{ecn.description ?? '—'}</p>

        <div style={sectionTitleStyle}>Affected items</div>
        {ecn.items.length === 0 ? (
          <p style={{ margin: 0, color: '#595959' }}>No affected items on this change.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headCellStyle}>Part</th>
                <th style={headCellStyle}>From rev → To rev</th>
                <th style={headCellStyle}>Change description</th>
                <th style={headCellStyle}>Disposition</th>
              </tr>
            </thead>
            <tbody>
              {ecn.items.map((item) => (
                <tr key={item.id}>
                  <td style={cellStyle}>
                    <strong>{item.part.partNumber}</strong> — {item.part.name}
                  </td>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                    {item.fromRevision?.revision ?? '—'} → {item.toRevision?.revision ?? '—'}
                  </td>
                  <td style={cellStyle}>{item.changeDescription ?? '—'}</td>
                  <td style={cellStyle}>{ECN_DISPOSITION_META[item.disposition].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={sectionTitleStyle}>Approvals</div>
        {ecn.reviews.length === 0 ? (
          <p style={{ margin: 0, color: '#595959' }}>No reviewers assigned.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headCellStyle}>Reviewer</th>
                <th style={headCellStyle}>Decision</th>
                <th style={headCellStyle}>Comment</th>
                <th style={headCellStyle}>Decided</th>
              </tr>
            </thead>
            <tbody>
              {ecn.reviews.map((review) => (
                <tr key={review.id}>
                  <td style={cellStyle}>{review.reviewer.name}</td>
                  <td style={cellStyle}>{ECN_REVIEW_DECISION_META[review.decision].label}</td>
                  <td style={cellStyle}>{review.comment ?? '—'}</td>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                    {formatDate(review.decidedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={sectionTitleStyle}>Where used impact</div>
        {!impact || impact.length === 0 ? (
          <p style={{ margin: 0, color: '#595959' }}>No impact information.</p>
        ) : (
          <div>
            {impact.map((entry) => (
              <div key={entry.part.id} style={{ marginBottom: 8 }}>
                <div>
                  <strong>{entry.part.partNumber}</strong> — {entry.part.name}
                  {entry.toRevision ? ` (working rev ${entry.toRevision.revision})` : ''}
                </div>
                {entry.usedIn.length === 0 ? (
                  <div style={{ color: '#595959', paddingLeft: 16 }}>
                    Not used in any parent assembly.
                  </div>
                ) : (
                  <ul style={{ margin: '2px 0 0', paddingLeft: 32 }}>
                    {entry.usedIn.map((usage) => (
                      <li key={usage.line.id}>
                        {usage.parentPart.partNumber} — {usage.parentPart.name} (rev{' '}
                        {usage.parentRevision.revision}, qty {usage.line.quantity}{' '}
                        {usage.line.uom})
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            marginTop: 48,
            borderTop: '1px solid #d9d9d9',
            paddingTop: 8,
            fontSize: 11,
            color: '#8c8c8c',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Generated by TurboPLM</span>
          <span>
            {ecn.ecnNumber} · {formatDate(new Date().toISOString())}
          </span>
        </div>
      </div>
    </div>
  );
}
