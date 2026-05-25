import { useState, useCallback } from 'react';
import {
  fetchReferenceManifest,
  verifyFrontend,
  type FrontendReport,
  type ManifestV1,
} from './verify';

// Canonical upstream repo — hardcoded so it cannot be redirected by query
// param or by anything the mirror under test serves. If you fork CAW, you
// should fork this verifier and change this constant; do not point a verifier
// you control at someone else's repo.
const UPSTREAM_REPO = 'https://github.com/gilgamesh-caw/caw-nfts';
const MANIFEST_URL = 'https://raw.githubusercontent.com/gilgamesh-caw/caw-nfts/master/docs/manifests/latest.json';

type Phase = 'idle' | 'fetching-reference' | 'verifying' | 'done' | 'error';

export default function App() {
  const [mirrorUrl, setMirrorUrl] = useState('https://test.caw.social');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ done: number; total: number; path: string } | null>(null);
  const [report, setReport] = useState<FrontendReport | null>(null);
  const [reference, setReference] = useState<ManifestV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setReport(null);
    setProgress(null);
    try {
      setPhase('fetching-reference');
      const ref = await fetchReferenceManifest(MANIFEST_URL);
      setReference(ref);
      setPhase('verifying');
      const r = await verifyFrontend(mirrorUrl, ref, {
        onProgress: (done, total, path) => setProgress({ done, total, path }),
      });
      setReport(r);
      setPhase('done');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [mirrorUrl]);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>CAW Mirror Verifier</h1>
        <p style={styles.subtitle}>
          Check that a CAW mirror is serving the same frontend bundle as the
          canonical upstream repo. Reference:{' '}
          <a href={UPSTREAM_REPO} style={styles.link} target="_blank" rel="noreferrer">
            {UPSTREAM_REPO.replace('https://github.com/', '')}
          </a>
        </p>
      </header>

      <section style={styles.section}>
        <label style={styles.label}>
          Mirror URL
          <input
            type="text"
            value={mirrorUrl}
            onChange={(e) => setMirrorUrl(e.target.value)}
            placeholder="https://test.caw.social"
            style={styles.input}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <button
          onClick={run}
          disabled={phase === 'fetching-reference' || phase === 'verifying' || !mirrorUrl.trim()}
          style={{
            ...styles.button,
            opacity: (phase === 'fetching-reference' || phase === 'verifying') ? 0.6 : 1,
            cursor: (phase === 'fetching-reference' || phase === 'verifying') ? 'wait' : 'pointer',
          }}
        >
          {phase === 'fetching-reference' ? 'Fetching reference…'
            : phase === 'verifying' ? 'Verifying…'
            : 'Verify'}
        </button>
      </section>

      {phase === 'verifying' && progress && (
        <section style={styles.section}>
          <ProgressBar done={progress.done} total={progress.total} />
          <p style={styles.progressLabel}>
            {progress.done} / {progress.total} — {progress.path}
          </p>
        </section>
      )}

      {error && (
        <section style={styles.errorBox}>
          <strong>Error:</strong> {error}
        </section>
      )}

      {report && <ReportView report={report} reference={reference} />}

      <footer style={styles.footer}>
        <p style={styles.footerText}>
          This verifier hashes the files the mirror serves and compares them to a
          manifest published in the upstream repo. It does <strong>not</strong>{' '}
          send credentials, set cookies, or modify anything. The only network
          traffic is anonymous fetches: one JSON manifest from GitHub, plus one
          fetch per file in the bundle from the mirror.
        </p>
        <p style={styles.footerText}>
          The verifier's own source is at <a href={UPSTREAM_REPO} style={styles.link} target="_blank" rel="noreferrer">{UPSTREAM_REPO.replace('https://github.com/', '')}</a> under{' '}
          <code style={styles.code}>client/src/services/Verifier</code>. Audit it before trusting the output.
        </p>
      </footer>
    </main>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={styles.progressBar}>
      <div style={{ ...styles.progressFill, width: `${pct}%` }} />
    </div>
  );
}

function ReportView({ report, reference }: { report: FrontendReport; reference: ManifestV1 | null }) {
  const [showAll, setShowAll] = useState(false);
  const failing = report.files.filter(f => f.status !== 'match' && f.status !== 'extra');
  const extra = report.files.filter(f => f.status === 'extra');
  const visible = showAll ? report.files : failing;

  return (
    <section style={styles.section}>
      <div style={{
        ...styles.verdict,
        background: report.ok ? '#dcfce7' : '#fee2e2',
        color: report.ok ? '#14532d' : '#7f1d1d',
        borderColor: report.ok ? '#86efac' : '#fca5a5',
      }}>
        <div style={styles.verdictTitle}>
          {report.ok ? '✓ Frontend bundle matches reference' : '✗ Frontend bundle differs from reference'}
        </div>
        <div style={styles.verdictMeta}>
          <span>Mirror: <code style={styles.code}>{report.mirrorUrl}</code></span>
          {report.mirrorClientVersion && (
            <span>Mirror build: <code style={styles.code}>{report.mirrorClientVersion}</code></span>
          )}
          {report.referenceClientVersion && (
            <span>Reference build: <code style={styles.code}>{report.referenceClientVersion}</code></span>
          )}
          {reference?.builtAt && (
            <span>Reference built: <code style={styles.code}>{reference.builtAt}</code></span>
          )}
        </div>
      </div>

      <div style={styles.summaryRow}>
        <Stat label="Matched"     value={report.summary.matched}    color="#15803d" />
        <Stat label="Mismatched"  value={report.summary.mismatched} color="#b91c1c" />
        <Stat label="Missing"     value={report.summary.missing}    color="#b91c1c" />
        <Stat label="Errored"     value={report.summary.errored}    color="#b45309" />
        <Stat label="Extra"       value={report.summary.extra}      color="#6b7280" />
      </div>

      {report.mirrorClientVersion && report.referenceClientVersion
        && report.mirrorClientVersion !== report.referenceClientVersion && (
        <p style={styles.note}>
          ⓘ Mirror build (<code style={styles.code}>{report.mirrorClientVersion}</code>) differs from reference build
          (<code style={styles.code}>{report.referenceClientVersion}</code>). Hash mismatches are expected when the
          mirror hasn't deployed the latest commit yet. Re-run after a deploy to confirm.
        </p>
      )}

      {(failing.length > 0 || extra.length > 0) && (
        <details open style={styles.details}>
          <summary style={styles.summary}>
            {showAll ? 'All files' : `Failing files (${failing.length})`}
            <button
              onClick={(e) => { e.preventDefault(); setShowAll(s => !s); }}
              style={styles.linkButton}
            >
              {showAll ? 'show failing only' : 'show all'}
            </button>
          </summary>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Path</th>
                <th style={styles.th}>Expected</th>
                <th style={styles.th}>Actual</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(f => (
                <tr key={f.path}>
                  <td style={styles.td}><StatusBadge status={f.status} /></td>
                  <td style={styles.tdPath}>{f.path}</td>
                  <td style={styles.tdHash}>{'expectedHash' in f ? shorten(f.expectedHash) : '—'}</td>
                  <td style={styles.tdHash}>{'actualHash' in f ? shorten(f.actualHash) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={styles.stat}>
      <div style={{ ...styles.statValue, color }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    match:      { bg: '#dcfce7', fg: '#14532d', label: 'match' },
    mismatch:   { bg: '#fee2e2', fg: '#7f1d1d', label: 'mismatch' },
    missing:    { bg: '#fee2e2', fg: '#7f1d1d', label: 'missing' },
    error:      { bg: '#fef3c7', fg: '#78350f', label: 'error' },
    extra:      { bg: '#f3f4f6', fg: '#374151', label: 'extra' },
  };
  const p = palette[status] || { bg: '#f3f4f6', fg: '#374151', label: status };
  return (
    <span style={{
      background: p.bg, color: p.fg,
      padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
    }}>{p.label}</span>
  );
}

function shorten(hash: string | undefined): string {
  if (!hash) return '—';
  // "sha256-<64 hex>" → first 16 chars after prefix is plenty for eyeballing
  // diffs in the table; the full value is available in the table HTML if
  // someone wants to copy it.
  const m = /^sha256-([0-9a-f]+)$/i.exec(hash);
  if (m) return `${m[1].slice(0, 16)}…`;
  return hash.slice(0, 24);
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 960,
    margin: '0 auto',
    padding: '32px 24px',
    fontSize: 14,
    lineHeight: 1.55,
  },
  header: {
    marginBottom: 32,
  },
  h1: {
    fontSize: 24,
    fontWeight: 700,
    margin: '0 0 8px 0',
  },
  subtitle: {
    margin: 0,
    color: '#666',
  },
  section: {
    marginBottom: 24,
  },
  label: {
    display: 'block',
    fontWeight: 600,
    marginBottom: 8,
  },
  input: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    fontSize: 14,
    fontFamily: 'inherit',
    border: '1px solid #ccc',
    borderRadius: 6,
    marginTop: 6,
    background: 'transparent',
    color: 'inherit',
  },
  button: {
    marginTop: 12,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 600,
    border: 'none',
    borderRadius: 6,
    background: '#111',
    color: '#fff',
  },
  progressBar: {
    width: '100%',
    height: 6,
    background: '#e5e7eb',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: '#111',
    transition: 'width 0.2s',
  },
  progressLabel: {
    fontSize: 12,
    color: '#666',
    margin: '8px 0 0 0',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  errorBox: {
    padding: 16,
    background: '#fee2e2',
    border: '1px solid #fca5a5',
    borderRadius: 6,
    color: '#7f1d1d',
  },
  verdict: {
    padding: 20,
    borderRadius: 8,
    border: '1px solid',
    marginBottom: 16,
  },
  verdictTitle: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 8,
  },
  verdictMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 16px',
    fontSize: 12,
  },
  summaryRow: {
    display: 'flex',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  stat: {
    flex: '1 1 100px',
    padding: 12,
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    textAlign: 'center',
  },
  statValue: {
    fontSize: 22,
    fontWeight: 700,
  },
  statLabel: {
    fontSize: 11,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  note: {
    padding: 12,
    background: '#fef3c7',
    border: '1px solid #fde68a',
    borderRadius: 6,
    color: '#78350f',
    fontSize: 13,
  },
  details: {
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '8px 12px',
  },
  summary: {
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    fontSize: 12,
    textDecoration: 'underline',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    marginTop: 12,
    fontSize: 12,
  },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid #e5e7eb',
    fontSize: 11,
    textTransform: 'uppercase',
    color: '#666',
  },
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid #f3f4f6',
    verticalAlign: 'top',
  },
  tdPath: {
    padding: '6px 8px',
    borderBottom: '1px solid #f3f4f6',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    wordBreak: 'break-all',
  },
  tdHash: {
    padding: '6px 8px',
    borderBottom: '1px solid #f3f4f6',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    color: '#666',
  },
  footer: {
    marginTop: 48,
    paddingTop: 24,
    borderTop: '1px solid #e5e7eb',
    color: '#666',
    fontSize: 13,
  },
  footerText: {
    margin: '0 0 12px 0',
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    fontSize: '0.9em',
    background: 'rgba(0,0,0,0.04)',
    padding: '1px 6px',
    borderRadius: 3,
  },
  link: {
    color: '#2563eb',
    textDecoration: 'underline',
  },
};
