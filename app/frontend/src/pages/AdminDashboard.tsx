import { useState, useEffect, useRef } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

interface Analytics {
  overview: {
    sessions_total:    number;
    sessions_today:    number;
    sessions_7d:       number;
    quotes_generated:  number;
    avg_session_ms:    number | null;
  };
  byPortal:   Array<{ portal_id: string; sessions: number; quotes: number }>;
  byDay:      Array<{ day: string; sessions: number }>;
  topFailures: Array<{ action: string; reason: string | null; cnt: number }>;
  liveSessions: number;
}

type AdminView = 'dashboard' | 'sessions' | 'companies' | 'quotes' | 'ai-costs' | 'failed-quotes' | 'portal-sessions';

interface Props {
  token: string;
  onBack: () => void;
  onCompanies?: () => void;
  onUsers?: () => void;
}

export default function AdminDashboard({ token, onBack, onCompanies, onUsers }: Props) {
  const [view, setView]               = useState<AdminView>('dashboard');
  const [analytics, setAnalytics]     = useState<Analytics | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [failedCount, setFailedCount] = useState<number>(0);

  async function loadAnalytics() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/analytics`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setAnalytics(data);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function loadFailedCount() {
    try {
      const res  = await fetch(`${autoBase}/api/admin/failed-quotes/count`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setFailedCount(data.count ?? 0);
    } catch { /* badge is non-critical */ }
  }

  useEffect(() => {
    loadAnalytics();
    loadFailedCount();
    // refresh failed count every 30 s so admins see new failures without manual refresh
    const t = setInterval(loadFailedCount, 30_000);
    return () => clearInterval(t);
  }, []);

  const nav: Array<{ key: AdminView; label: string; badge?: number }> = [
    { key: 'dashboard',       label: '📊 Overview' },
    { key: 'portal-sessions', label: '🔑 Portal Sessions' },
    { key: 'failed-quotes',   label: '🚨 Failed Quotes', badge: failedCount },
    { key: 'sessions',        label: '📋 Sessions' },
    { key: 'companies',       label: '🏢 Companies' },
    { key: 'quotes',          label: '📄 Quotes' },
    { key: 'ai-costs',        label: '🤖 AI Costs' },
  ];

  return (
    <div style={s.shell}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>Admin Dashboard</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {onUsers && <button style={s.headerBtn} onClick={onUsers}>👥 Users</button>}
          {onCompanies && <button style={s.headerBtn} onClick={onCompanies}>🏢 Companies</button>}
          {analytics && <div style={s.liveBadge}>● {analytics.liveSessions} live</div>}
        </div>
      </div>

      <div style={s.layout}>
        <nav style={s.sidebar}>
          {nav.map(n => (
            <button key={n.key} style={{ ...s.navBtn, ...(view === n.key ? s.navActive : {}) }}
              onClick={() => setView(n.key)}>
              <span>{n.label}</span>
              {n.badge != null && n.badge > 0 && (
                <span style={{ marginLeft: 6, background: '#dc2626', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>
                  {n.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <main style={s.content}>
          {error && <div style={s.error}>{error}</div>}

          {view === 'dashboard' && (
            loading ? <div style={s.empty}>Loading analytics…</div> :
            analytics?.overview ? <OverviewPanel a={analytics} /> :
            <div style={s.empty}>No analytics data yet.{!error && ' (Database may not be connected.)'}</div>
          )}
          {view === 'sessions'      && <SessionsPanel     token={token} />}
          {view === 'companies'     && <CompaniesPanel    token={token} />}
          {view === 'quotes'        && <QuotesPanel       token={token} />}
          {view === 'ai-costs'      && <AiCostsPanel      token={token} />}
          {view === 'portal-sessions' && <PortalSessionsPanel token={token} />}
          {view === 'failed-quotes' && <FailedQuotesPanel token={token} onResolved={loadFailedCount} />}
        </main>
      </div>
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

function OverviewPanel({ a }: { a: Analytics }) {
  const ov_data = a.overview ?? { sessions_total: 0, sessions_today: 0, sessions_7d: 0, quotes_generated: 0, avg_session_ms: null };
  const successRate = ov_data.sessions_total > 0
    ? Math.round((ov_data.quotes_generated / ov_data.sessions_total) * 100)
    : 0;
  const avgSec = ov_data.avg_session_ms != null
    ? Math.round(ov_data.avg_session_ms / 1000)
    : null;

  return (
    <div>
      <div style={ov.grid}>
        <StatCard label="Sessions Today"   value={ov_data.sessions_today}  />
        <StatCard label="Sessions (7 days)" value={ov_data.sessions_7d}    />
        <StatCard label="Quotes Generated" value={ov_data.quotes_generated} />
        <StatCard label="Success Rate"     value={`${successRate}%`}          />
        <StatCard label="Active Now"        value={a.liveSessions}             highlight />
        {avgSec != null && <StatCard label="Avg Session" value={`${avgSec}s`} />}
      </div>

      {a.byPortal.length > 0 && (
        <div style={ov.section}>
          <div style={ov.sectionTitle}>By Insurer</div>
          <table style={ov.table}>
            <thead><tr>
              {['Portal', 'Sessions', 'Quotes', 'Success Rate'].map(h => <th key={h} style={ov.th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {a.byPortal.map(row => (
                <tr key={row.portal_id} style={ov.tr}>
                  <td style={ov.td}>{row.portal_id}</td>
                  <td style={ov.td}>{row.sessions}</td>
                  <td style={ov.td}>{row.quotes}</td>
                  <td style={ov.td}>{row.sessions > 0 ? Math.round((row.quotes / row.sessions) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {a.topFailures.length > 0 && (
        <div style={ov.section}>
          <div style={ov.sectionTitle}>Top Failures</div>
          {a.topFailures.map((f, i) => (
            <div key={i} style={ov.failRow}>
              <span style={ov.failAction}>{f.action}</span>
              <span style={ov.failReason}>{f.reason || 'unknown error'}</span>
              <span style={ov.failCnt}>{f.cnt}×</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div style={{ ...ov.statCard, ...(highlight ? ov.statHighlight : {}) }}>
      <div style={ov.statValue}>{value}</div>
      <div style={ov.statLabel}>{label}</div>
    </div>
  );
}

// ── Sessions panel ─────────────────────────────────────────────────────────

function SessionsPanel({ token }: { token: string }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res  = await fetch(`${autoBase}/api/admin/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setSessions(data.sessions || []);
      setLoading(false);
    })();
  }, []);

  async function loadTimeline(sessionId: string) {
    setSelected(sessionId);
    const res  = await fetch(`${autoBase}/api/admin/sessions/${sessionId}/timeline`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setTimeline(data.timeline || []);
  }

  if (selected) {
    return (
      <div>
        <button style={sp.backBtn} onClick={() => setSelected(null)}>← All Sessions</button>
        <div style={sp.timelineTitle}>Session {selected.slice(0, 8)}…</div>
        {timeline.map((ev, i) => (
          <div key={i} style={sp.event}>
            <div style={sp.eventTime}>{new Date(ev.ts).toLocaleTimeString('en-IN')}</div>
            <div style={{ ...sp.eventDot, background: ev.outcome === 'failure' ? '#e74c3c' : '#16a34a' }} />
            <div style={sp.eventBody}>
              <span style={sp.action}>{ev.action}</span>
              {ev.portal_id && <span style={sp.meta}> {ev.portal_id}</span>}
              {ev.outcome === 'failure' && <span style={sp.fail}> ✗ failed</span>}
              {ev.meta && (
                <div style={sp.metaDetail}>
                  {Object.entries(ev.meta as Record<string, unknown>).slice(0, 4).map(([k, v]) => (
                    <span key={k} style={sp.metaItem}>{k}: {String(v)}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (loading) return <div style={s.empty}>Loading sessions…</div>;

  return (
    <table style={ov.table}>
      <thead><tr>
        {['User', 'Started', 'Portal', 'Events', 'Quote', 'Actions'].map(h => <th key={h} style={ov.th}>{h}</th>)}
      </tr></thead>
      <tbody>
        {sessions.map((sess: any) => (
          <tr key={sess.session_id} style={ov.tr}>
            <td style={ov.td}><span style={{ fontSize: 12 }}>{sess.user_email}</span></td>
            <td style={ov.td}><span style={{ fontSize: 12 }}>{new Date(sess.started_at).toLocaleString('en-IN')}</span></td>
            <td style={ov.td}>{sess.portal_id || '—'}</td>
            <td style={ov.td}>{sess.event_count}</td>
            <td style={ov.td}>{sess.quote_generated ? '✅' : '—'}</td>
            <td style={ov.td}>
              <button style={sp.viewBtn} onClick={() => loadTimeline(sess.session_id)}>Timeline</button>
            </td>
          </tr>
        ))}
        {sessions.length === 0 && (
          <tr><td colSpan={6} style={{ ...ov.td, textAlign: 'center', color: '#888' }}>No sessions yet</td></tr>
        )}
      </tbody>
    </table>
  );
}

// ── Companies panel (inline lightweight version) ───────────────────────────

function CompaniesPanel({ token }: { token: string }) {
  const [companies, setCompanies] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const res  = await fetch(`${autoBase}/api/admin/companies`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setCompanies(data.companies || []);
    })();
  }, []);

  async function toggle(id: string, enabled: boolean) {
    await fetch(`${autoBase}/api/admin/companies/${id}/enabled`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled }),
    });
    setCompanies(prev => prev.map(c => c.id === id ? { ...c, enabled } : c));
  }

  return (
    <table style={ov.table}>
      <thead><tr>
        {['Company', 'Types', 'Enabled'].map(h => <th key={h} style={ov.th}>{h}</th>)}
      </tr></thead>
      <tbody>
        {companies.map(c => (
          <tr key={c.id} style={ov.tr}>
            <td style={ov.td}><b>{c.name}</b></td>
            <td style={ov.td}>{c.insuranceTypes.join(', ')}</td>
            <td style={ov.td}>
              <button
                onClick={() => toggle(c.id, !c.enabled)}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: c.enabled ? '#16a34a' : '#d1d5db', color: c.enabled ? '#fff' : '#333', fontWeight: 600, fontSize: 12 }}>
                {c.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Quotes panel ───────────────────────────────────────────────────────────

function QuotesPanel({ token }: { token: string }) {
  const [quotes, setQuotes]   = useState<any[]>([]);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(true);

  async function load(reg?: string) {
    setLoading(true);
    const qs  = reg ? `?regNumber=${encodeURIComponent(reg)}` : '';
    const res = await fetch(`${autoBase}/api/admin/quotes${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setQuotes(data.quotes || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <form onSubmit={e => { e.preventDefault(); load(search); }} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by reg. number…"
          style={{ flex: 1, padding: '8px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 14 }} />
        <button type="submit" style={{ padding: '8px 16px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Search</button>
      </form>
      {loading ? <div style={s.empty}>Loading…</div> : (
        <table style={ov.table}>
          <thead><tr>
            {['User', 'Portal', 'Reg #', 'Premium', 'Created'].map(h => <th key={h} style={ov.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {quotes.map((q: any) => (
              <tr key={q.id} style={ov.tr}>
                <td style={ov.td}><span style={{ fontSize: 12 }}>{q.user_id}</span></td>
                <td style={ov.td}>{q.portal_name || q.portal_id}</td>
                <td style={{ ...ov.td, fontFamily: 'monospace', fontSize: 12 }}>{q.reg_number || '—'}</td>
                <td style={ov.td}>{q.premium ? `₹${Number(q.premium).toLocaleString('en-IN')}` : '—'}</td>
                <td style={ov.td}><span style={{ fontSize: 12 }}>{new Date(q.created_at).toLocaleDateString('en-IN')}</span></td>
              </tr>
            ))}
            {quotes.length === 0 && (
              <tr><td colSpan={5} style={{ ...ov.td, textAlign: 'center', color: '#888' }}>No quotes found</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── AI Costs Panel ────────────────────────────────────────────────────────

interface AiSummary {
  observationCount: number; sessionCount: number;
  totalInputTokens: number; totalOutputTokens: number; totalTokens: number;
  estimatedCostUsd: number; avgCostPerSession: number; avgCostPerQuote: number | null;
}
interface AiFeature {
  name: string; count: number;
  inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number;
}
interface AiSession {
  sessionId: string; userId: string; userEmail: string; insType: string;
  quoteGenerated: boolean; firstSeen: string;
  inputTokens: number; outputTokens: number; totalTokens: number;
  estimatedCostUsd: number; features: string[];
}

const FEATURE_LABELS: Record<string, string> = {
  'chat-collect':  'Chat (collect)',
  'chat-confirm':  'Chat (confirm)',
  'ocr':           'OCR',
  'captcha-solve': 'Captcha',
};

function fmt$(n: number) {
  if (n < 0.001) return '<$0.001';
  if (n < 1)     return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}
function fmtTok(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function AiCostsPanel({ token }: { token: string }) {
  const [data, setData]     = useState<{ summary: AiSummary; byFeature: AiFeature[]; sessions: AiSession[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setError('');
      try {
        const res  = await fetch(`${autoBase}/api/admin/ai-analytics`, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Failed to load');
        if (!json.enabled) { setError('Langfuse not configured — add LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to Railway.'); return; }
        setData(json);
      } catch (e: any) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, [token]);

  if (loading) return <div style={s.empty}>Loading AI cost analytics…</div>;
  if (error)   return <div style={{ ...s.error, marginTop: 0 }}>{error}</div>;
  if (!data)   return null;

  const { summary: sm, byFeature, sessions } = data;
  const maxCost = Math.max(...sessions.map(s => s.estimatedCostUsd), 0.000001);

  return (
    <div>
      {/* Summary cards */}
      <div style={ac.grid}>
        <AcCard label="Sessions (7d)"      value={sm.sessionCount}                      />
        <AcCard label="Total tokens"       value={fmtTok(sm.totalTokens)}               />
        <AcCard label="Est. cost (7d)"     value={fmt$(sm.estimatedCostUsd)} highlight  />
        <AcCard label="Cost / session"     value={fmt$(sm.avgCostPerSession)}            />
        <AcCard label="Cost / quote"       value={sm.avgCostPerQuote != null ? fmt$(sm.avgCostPerQuote) : '—'} />
        <AcCard label="LLM calls"          value={sm.observationCount}                  />
      </div>

      {/* Token breakdown bar */}
      {sm.totalTokens > 0 && (
        <div style={ac.section}>
          <div style={ac.sectionTitle}>Token split — input vs output</div>
          <div style={ac.barTrack}>
            <div style={{ ...ac.barFill, width: `${(sm.totalInputTokens / sm.totalTokens) * 100}%`, background: '#1a56db' }} />
            <div style={{ ...ac.barFill, width: `${(sm.totalOutputTokens / sm.totalTokens) * 100}%`, background: '#7c3aed' }} />
          </div>
          <div style={ac.barLegend}>
            <span><span style={{ ...ac.dot, background: '#1a56db' }} />Input {fmtTok(sm.totalInputTokens)} ({Math.round(sm.totalInputTokens / sm.totalTokens * 100)}%)</span>
            <span><span style={{ ...ac.dot, background: '#7c3aed' }} />Output {fmtTok(sm.totalOutputTokens)} ({Math.round(sm.totalOutputTokens / sm.totalTokens * 100)}%)</span>
          </div>
        </div>
      )}

      {/* Cost by feature */}
      {byFeature.length > 0 && (
        <div style={ac.section}>
          <div style={ac.sectionTitle}>Cost by feature</div>
          {byFeature.map(f => {
            const pct = sm.estimatedCostUsd > 0 ? (f.estimatedCostUsd / sm.estimatedCostUsd) * 100 : 0;
            return (
              <div key={f.name} style={ac.featureRow}>
                <div style={ac.featureName}>{FEATURE_LABELS[f.name] ?? f.name}</div>
                <div style={ac.featureBar}>
                  <div style={{ ...ac.featureBarFill, width: `${Math.max(pct, 1)}%` }} />
                </div>
                <div style={ac.featureCost}>{fmt$(f.estimatedCostUsd)}</div>
                <div style={ac.featureMeta}>{fmtTok(f.totalTokens)} tok · {f.count} calls</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-session table */}
      <div style={ac.section}>
        <div style={ac.sectionTitle}>Per-session breakdown ({sessions.length} sessions)</div>
        <table style={{ ...ov.table, boxShadow: 'none', borderRadius: 0 }}>
          <thead><tr>
            {['Session', 'User', 'Type', 'Date', 'Quote', 'Tokens', 'Cost', 'Cost bar'].map(h => (
              <th key={h} style={ov.th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {sessions.map(sess => (
              <>
                <tr key={sess.sessionId} style={{ ...ov.tr, cursor: 'pointer' }}
                  onClick={() => setExpanded(expanded === sess.sessionId ? null : sess.sessionId)}>
                  <td style={{ ...ov.td, fontFamily: 'monospace', fontSize: 11 }}>
                    {sess.sessionId.slice(0, 8)}…
                    <span style={{ marginLeft: 4, color: '#94a3b8', fontSize: 10 }}>{expanded === sess.sessionId ? '▲' : '▼'}</span>
                  </td>
                  <td style={{ ...ov.td, fontSize: 12 }}>{sess.userEmail}</td>
                  <td style={ov.td}><span style={ac.insTag}>{sess.insType}</span></td>
                  <td style={{ ...ov.td, fontSize: 12, color: '#888' }}>{new Date(sess.firstSeen).toLocaleDateString('en-IN')}</td>
                  <td style={ov.td}>{sess.quoteGenerated ? '✅' : <span style={{ color: '#94a3b8' }}>—</span>}</td>
                  <td style={{ ...ov.td, fontFamily: 'monospace', fontSize: 12 }}>{fmtTok(sess.totalTokens)}</td>
                  <td style={{ ...ov.td, fontWeight: 600, color: '#1a5276' }}>{fmt$(sess.estimatedCostUsd)}</td>
                  <td style={{ ...ov.td, width: 100, paddingRight: 16 }}>
                    <div style={ac.miniBarTrack}>
                      <div style={{ ...ac.miniBarFill, width: `${(sess.estimatedCostUsd / maxCost) * 100}%` }} />
                    </div>
                  </td>
                </tr>
                {expanded === sess.sessionId && (
                  <tr key={`${sess.sessionId}-detail`}>
                    <td colSpan={8} style={{ padding: '8px 16px 12px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12 }}>
                        <span><b>Session ID:</b> <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{sess.sessionId}</code></span>
                        <span><b>Input:</b> {fmtTok(sess.inputTokens)} tok</span>
                        <span><b>Output:</b> {fmtTok(sess.outputTokens)} tok</span>
                        <span><b>Features:</b> {sess.features.map(f => FEATURE_LABELS[f] ?? f).join(', ')}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {sessions.length === 0 && (
              <tr><td colSpan={8} style={{ ...ov.td, textAlign: 'center', color: '#888' }}>No sessions traced yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
        Costs estimated using list pricing: Sonnet 4.6 $3/$15 per 1M tokens input/output · Haiku 4.5 $0.80/$4. Last 7 days.
      </div>
    </div>
  );
}

function AcCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div style={{ ...ov.statCard, ...(highlight ? { background: '#1e3a5f', color: '#fff' } : {}) }}>
      <div style={{ ...ov.statValue, fontSize: 22 }}>{value}</div>
      <div style={{ ...ov.statLabel, color: highlight ? 'rgba(255,255,255,0.7)' : '#888' }}>{label}</div>
    </div>
  );
}

const ac: Record<string, React.CSSProperties> = {
  grid:          { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 12, marginBottom: 20 },
  section:       { background: '#fff', borderRadius: 12, padding: '16px 20px', marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  sectionTitle:  { fontWeight: 700, color: '#1a5276', marginBottom: 14, fontSize: 14 },
  barTrack:      { display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: '#f0f4f8', marginBottom: 8 },
  barFill:       { height: '100%', transition: 'width 0.3s' },
  barLegend:     { display: 'flex', gap: 20, fontSize: 12, color: '#555' },
  dot:           { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
  featureRow:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 },
  featureName:   { width: 130, fontSize: 13, fontWeight: 600, color: '#374151', flexShrink: 0 },
  featureBar:    { flex: 1, height: 8, background: '#f0f4f8', borderRadius: 4, overflow: 'hidden' },
  featureBarFill: { height: '100%', background: '#1a56db', borderRadius: 4, transition: 'width 0.3s' },
  featureCost:   { width: 70, textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: '#1a5276', fontWeight: 700 },
  featureMeta:   { width: 130, fontSize: 11, color: '#94a3b8', textAlign: 'right' },
  miniBarTrack:  { height: 6, background: '#f0f4f8', borderRadius: 3, overflow: 'hidden' },
  miniBarFill:   { height: '100%', background: '#1a56db', borderRadius: 3, transition: 'width 0.3s' },
  insTag:        { background: '#dbeafe', color: '#1e40af', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4 },
};

// ── Failed Quotes Panel (manual handoff for portal failures) ─────────────

interface FailedQuote {
  id: string; session_id: string; user_id: string;
  portal_id: string; portal_name: string; ins_type: string;
  reg_number: string | null; vehicle_make: string | null; vehicle_model: string | null;
  premium: number | null; idv: number | null;
  quote_data: { errorMessage?: string; [key: string]: unknown };
  created_at: string;
  user_email?: string;
}

const PORTAL_URLS: Record<string, string> = {
  uiic: 'https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login',
};

function FailedQuotesPanel({ token, onResolved }: { token: string; onResolved: () => void }) {
  const [items, setItems]       = useState<FailedQuote[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [taking, setTaking]     = useState<FailedQuote | null>(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/failed-quotes`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setItems(data.failures ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function dismiss(id: string) {
    if (!confirm('Dismiss this failed quote without entering a premium?')) return;
    const res  = await fetch(`${autoBase}/api/admin/quotes/${id}/dismiss`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    if ((await res.json()).success) { load(); onResolved(); }
  }

  if (loading) return <div style={s.empty}>Loading failed quotes…</div>;
  if (error)   return <div style={{ ...s.error, marginTop: 0 }}>{error}</div>;

  return (
    <div>
      <div style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
        <b>What is this?</b> Portal automation failed for these quotes (login lockout, bot detection, captcha misread, etc.).
        Open the portal yourself, complete the quote manually, then click <b>Take Over</b> and enter the premium you got.
        The quote will be saved as if the automation had succeeded.
      </div>

      {items.length === 0 ? (
        <div style={{ ...s.empty, textAlign: 'center' }}>
          ✅ No failed quotes — all portal attempts in the last 7 days succeeded.
        </div>
      ) : (
        <table style={ov.table}>
          <thead><tr>
            {['When', 'User', 'Insurer', 'Vehicle', 'Error', 'Action'].map(h => <th key={h} style={ov.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {items.map(q => (
              <tr key={q.id} style={ov.tr}>
                <td style={{ ...ov.td, fontSize: 12, color: '#475569' }}>
                  {new Date(q.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td style={{ ...ov.td, fontSize: 12 }}>{q.user_email ?? q.user_id.slice(0, 8)}</td>
                <td style={ov.td}><span style={fq.insBadge}>{q.portal_id.toUpperCase()}</span></td>
                <td style={{ ...ov.td, fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>{q.reg_number ?? '—'}</div>
                  <div style={{ color: '#64748b' }}>{[q.vehicle_make, q.vehicle_model].filter(Boolean).join(' ') || '—'}</div>
                </td>
                <td style={{ ...ov.td, fontSize: 11, color: '#dc2626', maxWidth: 280 }}>
                  {(q.quote_data?.errorMessage as string ?? '').split('\n')[0].slice(0, 100)}
                </td>
                <td style={ov.td}>
                  <button style={fq.takeBtn} onClick={() => setTaking(q)}>🛠 Take Over</button>
                  <button style={fq.dismissBtn} onClick={() => dismiss(q.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {taking && (
        <TakeOverModal
          token={token}
          quote={taking}
          portalUrl={PORTAL_URLS[taking.portal_id] ?? ''}
          onClose={() => setTaking(null)}
          onSaved={() => { setTaking(null); load(); onResolved(); }}
        />
      )}
    </div>
  );
}

/* ── Cookie Handoff Modal ─────────────────────────────────────────────────
 * Three stages, all visible at once:
 *   1. Log in to portal (manual, in your own tab)
 *   2. Click the extension button (waits for cookies_received SSE event)
 *   3. Replay the quote (waits for replay_complete | replay_failed | session_expired)
 * Retry buttons appear next to each stage on failure. */
type Stage = 'pending' | 'active' | 'ok' | 'fail';
interface StageState { status: Stage; message?: string }

/** Lightweight wrapper that lets PortalSessionsPanel reuse the modal without
 *  needing a real failed quote — synthesises a minimal FailedQuote shape. */
function StandaloneCookieModal({ token, portalId, portalName, portalUrl, onClose, onCaptured }: {
  token: string; portalId: string; portalName: string; portalUrl: string;
  onClose: () => void; onCaptured: () => void;
}) {
  const stubQuote: FailedQuote = {
    id: `standalone-${portalId}`, session_id: '', user_id: '',
    portal_id: portalId, portal_name: portalName, ins_type: '—',
    reg_number: null, vehicle_make: null, vehicle_model: null,
    premium: null, idv: null,
    quote_data: { errorMessage: 'Session capture only — no quote attached.' },
    created_at: new Date().toISOString(),
  };
  return (
    <TakeOverModal token={token} quote={stubQuote} portalUrl={portalUrl}
      standalone onClose={onClose} onSaved={() => { onCaptured(); onClose(); }} />
  );
}

function TakeOverModal({ token, quote, portalUrl, onClose, onSaved, standalone }: {
  token: string; quote: FailedQuote; portalUrl: string;
  onClose: () => void; onSaved: () => void;
  standalone?: boolean;
}) {
  const [handoffId, setHandoffId]   = useState<string | null>(null);
  const [stage1, setStage1]         = useState<StageState>({ status: 'active', message: `Open ${quote.portal_id.toUpperCase()} in a new tab and log in normally.` });
  const [stage2, setStage2]         = useState<StageState>({ status: 'pending', message: 'Waiting for the extension to send cookies…' });
  const [stage3, setStage3]         = useState<StageState>({ status: 'pending' });
  const [premium, setPremium]       = useState<number | null>(null);
  const [idv, setIdv]               = useState<number | null>(null);
  const [error, setError]           = useState('');
  const sseRef                       = useRef<EventSource | null>(null);

  // Start the handoff (create handoffId on mount)
  async function startHandoff() {
    setError('');
    setStage1({ status: 'active', message: `Open ${quote.portal_id.toUpperCase()} in a new tab and log in normally.` });
    setStage2({ status: 'pending', message: 'Waiting for the extension to send cookies…' });
    setStage3({ status: 'pending' });
    setPremium(null); setIdv(null);

    try {
      // Standalone mode: pass portalId; otherwise pass the quoteResultId (which the
      // backend uses to also load confirmedFields for an auto-replay).
      const body = standalone
        ? { portalId: quote.portal_id }
        : { quoteResultId: quote.id };
      const res  = await fetch(`${autoBase}/api/admin/handoff/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:   JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message ?? 'Failed to start handoff');
      setHandoffId(data.handoffId);
    } catch (e: any) {
      setError(e.message);
      setStage1({ status: 'fail', message: e.message });
    }
  }

  useEffect(() => { startHandoff(); /* once per mount */ }, []);

  // Open SSE channel once we have a handoffId
  useEffect(() => {
    if (!handoffId) return;

    const url = `${autoBase}/api/admin/handoff/${handoffId}/events?token=${encodeURIComponent(token)}`;
    // Note: EventSource does not support custom headers, so we pass the JWT in
    // the query string. The backend accepts it via middleware fallback.
    const es  = new EventSource(url, { withCredentials: false });
    sseRef.current = es;

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as { type: string; message?: string; cookieCount?: number; result?: any };

        if (ev.type === 'cookies_received') {
          setStage1({ status: 'ok', message: `Logged in — ${ev.cookieCount ?? '?'} cookies captured` });
          setStage2({ status: 'ok', message: `✓ ${ev.cookieCount ?? 0} cookies received` });
          setStage3({ status: 'active', message: 'Replaying quote…' });
        } else if (ev.type === 'replay_started') {
          setStage3({ status: 'active', message: ev.message ?? 'Replaying quote…' });
        } else if (ev.type === 'replay_step') {
          setStage3({ status: 'active', message: ev.message ?? 'Working…' });
        } else if (ev.type === 'replay_complete') {
          const r = ev.result ?? {};
          if (r.success) {
            setStage3({ status: 'ok', message: ev.message ?? 'Done' });
            setPremium(r.premium ?? null);
            setIdv(r.idv ?? null);
          } else {
            setStage3({ status: 'fail', message: r.errorMessage ?? ev.message ?? 'Replay failed' });
          }
        } else if (ev.type === 'replay_failed') {
          setStage3({ status: 'fail', message: ev.message ?? 'Replay failed' });
        } else if (ev.type === 'session_expired') {
          setStage1({ status: 'fail', message: 'Session expired — please log in again' });
          setStage2({ status: 'fail', message: ev.message ?? 'Session expired' });
          setStage3({ status: 'pending' });
        }
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => { /* keep stream open; backend closes when done */ };

    return () => { es.close(); sseRef.current = null; };
  }, [handoffId, token]);

  const isDone = stage3.status === 'ok';
  const isFail = stage1.status === 'fail' || stage2.status === 'fail' || stage3.status === 'fail';

  return (
    <div style={fq.modalBackdrop} onClick={onClose}>
      <div style={fq.modal} onClick={e => e.stopPropagation()}>
        <div style={fq.modalHeader}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>🛠 Take Over — {quote.portal_id.toUpperCase()}</div>
          <button style={fq.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={fq.modalBody}>
          {/* Vehicle context */}
          <div style={fq.vehicleCard}>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Vehicle</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginTop: 4 }}>{quote.reg_number ?? '—'}</div>
            <div style={{ color: '#475569', fontSize: 13 }}>
              {[quote.vehicle_make, quote.vehicle_model].filter(Boolean).join(' ') || '—'} · {quote.ins_type}
            </div>
          </div>

          {/* Handoff ID for the extension */}
          {handoffId && (
            <div style={fq.handoffPill}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Handoff ID (paste in extension)</span>
              <code style={fq.handoffCode}
                onClick={() => navigator.clipboard.writeText(handoffId)}
                title="Click to copy">{handoffId}</code>
            </div>
          )}

          {/* 3-stage tracker */}
          <StageRow num={1} label="Open portal and log in" state={stage1}
            action={portalUrl && (
              <a href={portalUrl} target="_blank" rel="noreferrer" style={fq.portalLink}>↗ Open {quote.portal_id.toUpperCase()}</a>
            )} />
          <StageRow num={2} label="Click Alert Insurance extension" state={stage2}
            action={stage2.status === 'fail' && (
              <button style={fq.retryBtn} onClick={startHandoff}>↻ Retry</button>
            )} />
          <StageRow num={3} label="Replay quote (automatic)" state={stage3}
            action={stage3.status === 'fail' && (
              <button style={fq.retryBtn} onClick={startHandoff}>↻ Restart</button>
            )} />

          {/* Result panel */}
          {isDone && (
            <div style={fq.resultPanel}>
              <div style={{ fontSize: 24, fontWeight: 800 }}>₹{premium?.toLocaleString('en-IN') ?? '—'}</div>
              <div style={{ fontSize: 12, color: '#065f46', marginTop: 2 }}>
                Premium captured · IDV ₹{idv?.toLocaleString('en-IN') ?? '—'}
              </div>
            </div>
          )}

          {error && <div style={{ ...s.error, marginTop: 12 }}>{error}</div>}

          {/* Manual cookie paste fallback — for testing without the extension */}
          {handoffId && stage3.status !== 'ok' && stage3.status !== 'active' && (
            <details style={{ marginTop: 12, fontSize: 12, color: '#475569', background: '#f8fafc', padding: '10px 12px', borderRadius: 8, border: '1px dashed #cbd5e0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>📋 Paste cookies manually (no extension)</summary>
              <PasteCookiesFallback token={token} handoffId={handoffId} portalId={quote.portal_id} />
            </details>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
            <details style={{ fontSize: 11, color: '#64748b' }}>
              <summary style={{ cursor: 'pointer' }}>Enter premium manually instead</summary>
              <ManualEntryFallback token={token} quote={quote} onSaved={onSaved} />
            </details>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={fq.cancelBtn} onClick={onClose}>{isDone || isFail ? 'Close' : 'Cancel'}</button>
              {isDone && (
                <button style={fq.saveBtn} onClick={onSaved}>✓ Done</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Lets the admin paste a raw Cookie header (or cookies-as-JSON) into the modal
 *  to drive the replay without installing the Chrome extension. */
function PasteCookiesFallback({ token, handoffId, portalId }: {
  token: string; handoffId: string; portalId: string;
}) {
  const [raw, setRaw]   = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState('');

  const portalDomain: Record<string, string> = {
    uiic:        '.uiic.in',
    iciclombard: '.iciclombard.com',
    tataaig:     '.tataaig.com',
    bajaj:       '.bajajallianz.com',
    hdfcergo:    '.hdfcergo.com',
    newindia:    '.newindia.co.in',
  };
  const domain = portalDomain[portalId] ?? `.${portalId}.in`;

  function parseCookies(input: string): { name: string; value: string }[] {
    const text = input.trim();
    if (!text) return [];
    // Try JSON array first (e.g. DevTools "Copy value" or extension export)
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        const arr   = Array.isArray(parsed) ? parsed : [parsed];
        return arr
          .filter((c: any) => c && c.name && c.value != null)
          .map((c: any) => ({ name: String(c.name), value: String(c.value) }));
      } catch { /* fall through to header parse */ }
    }
    // Otherwise treat as raw Cookie header: "a=1; b=2; c=3"
    return text.split(/;\s*/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => {
        const eq = p.indexOf('=');
        return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
      })
      .filter(c => c.name);
  }

  async function send() {
    const pairs = parseCookies(raw);
    if (pairs.length === 0) { setMsg('No cookies parsed — paste failed.'); return; }

    setBusy(true); setMsg(`Sending ${pairs.length} cookies…`);
    try {
      const cookies = pairs.map(p => ({
        name:     p.name,
        value:    p.value,
        domain,
        path:     '/',
        expires:  -1,
        httpOnly: false,    // Playwright doesn't enforce on sending — safe default
        secure:   true,
        sameSite: 'Lax' as const,
      }));

      const res  = await fetch(`${autoBase}/api/admin/portal-sessions`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ handoffId, portalId, cookies }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setMsg(`✓ Sent ${cookies.length} cookies — watch the stages above for replay status.`);
      setRaw('');
    } catch (e: any) {
      setMsg(`Failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <ol style={{ fontSize: 11, color: '#475569', paddingLeft: 18, lineHeight: 1.7, marginBottom: 8 }}>
        <li>In your portal tab, open DevTools (F12) → <b>Network</b> tab</li>
        <li>Click any request to <code>{domain.replace('.', '')}</code></li>
        <li>Find <b>Request Headers</b> → <code>Cookie:</code> → right-click → <b>Copy value</b></li>
        <li>Paste the raw <code>name=value; name=value</code> string below</li>
      </ol>
      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={`JSESSIONID=abc...; otherCookie=xyz; …`}
        style={{ width: '100%', minHeight: 80, fontFamily: 'monospace', fontSize: 11, padding: 8, border: '1.5px solid #cbd5e0', borderRadius: 6, boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button onClick={send} disabled={busy || !raw.trim()}
          style={{ background: '#1a56db', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: busy || !raw.trim() ? 0.5 : 1 }}>
          {busy ? 'Sending…' : '📤 Send cookies'}
        </button>
        {msg && <span style={{ fontSize: 11, color: msg.startsWith('✓') ? '#065f46' : '#dc2626' }}>{msg}</span>}
      </div>
    </div>
  );
}

function StageRow({ num, label, state, action }: {
  num: number; label: string; state: StageState; action?: React.ReactNode;
}) {
  const colors: Record<Stage, { bg: string; fg: string; icon: string }> = {
    pending: { bg: '#f1f5f9', fg: '#94a3b8', icon: String(num) },
    active:  { bg: '#dbeafe', fg: '#1e40af', icon: '⏳' },
    ok:      { bg: '#d1fae5', fg: '#065f46', icon: '✓' },
    fail:    { bg: '#fee2e2', fg: '#991b1b', icon: '✕' },
  };
  const c = colors[state.status];
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 10, background: c.bg, marginBottom: 8, alignItems: 'center' }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', color: c.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
        {c.icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: c.fg, fontSize: 13 }}>{label}</div>
        {state.message && <div style={{ fontSize: 11, color: c.fg, opacity: 0.85, marginTop: 2 }}>{state.message}</div>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

function ManualEntryFallback({ token, quote, onSaved }: { token: string; quote: FailedQuote; onSaved: () => void }) {
  const [premium, setPremium] = useState('');
  const [idv, setIdv]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  async function submit() {
    const p = parseFloat(premium);
    if (!p || p <= 0) { setErr('Enter a valid premium'); return; }
    setBusy(true); setErr('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/quotes/${quote.id}/manual-entry`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ premium: p, idv: idv ? parseFloat(idv) : undefined }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      onSaved();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
      <input style={{ ...fq.input, width: 100, padding: '6px 8px', fontSize: 12 }}
        placeholder="Premium ₹" value={premium} onChange={e => setPremium(e.target.value)} inputMode="decimal" />
      <input style={{ ...fq.input, width: 90, padding: '6px 8px', fontSize: 12 }}
        placeholder="IDV ₹" value={idv} onChange={e => setIdv(e.target.value)} inputMode="decimal" />
      <button style={{ ...fq.saveBtn, padding: '6px 10px', fontSize: 12 }} onClick={submit} disabled={busy}>
        {busy ? '…' : 'Save'}
      </button>
      {err && <span style={{ color: '#dc2626', fontSize: 10, marginLeft: 4 }}>{err}</span>}
    </div>
  );
}

const fq: Record<string, React.CSSProperties> = {
  insBadge:      { background: '#dbeafe', color: '#1e40af', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 },
  takeBtn:       { background: '#1a56db', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 6 },
  dismissBtn:    { background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: 16 },
  modal:         { background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', maxHeight: '90vh', overflow: 'hidden' },
  modalHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' },
  modalBody:     { padding: 20, overflowY: 'auto' },
  closeBtn:      { background: 'transparent', border: 'none', fontSize: 20, color: '#64748b', cursor: 'pointer' },
  vehicleCard:   { background: '#f1f5f9', borderRadius: 8, padding: '12px 14px', marginBottom: 16 },
  steps:         { paddingLeft: 22, lineHeight: 1.8, color: '#374151', marginBottom: 16, fontSize: 13 },
  portalLink:    { display: 'inline-block', marginLeft: 8, background: '#1a56db', color: '#fff', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: 'none' },
  label:         { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 },
  input:         { width: '100%', padding: '8px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' },
  cancelBtn:     { background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, cursor: 'pointer' },
  saveBtn:       { background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 700, cursor: 'pointer' },
  handoffPill:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fef9c3', border: '1px dashed #ca8a04', borderRadius: 8, padding: '8px 12px', marginBottom: 16, gap: 10 },
  handoffCode:   { background: '#fff', padding: '4px 10px', borderRadius: 6, fontFamily: 'monospace', fontSize: 12, color: '#854d0e', fontWeight: 700, cursor: 'pointer', userSelect: 'all' },
  retryBtn:      { background: '#fff', color: '#1a56db', border: '1.5px solid #1a56db', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  resultPanel:   { marginTop: 16, padding: '14px 16px', background: 'linear-gradient(135deg, #d1fae5, #a7f3d0)', borderRadius: 12, textAlign: 'center', border: '1px solid #6ee7b7' },
};

// ── Portal Sessions Panel ──────────────────────────────────────────────────
//
// One card per insurer the admin has access to. Shows:
//   - 🟢 Active session captured  → quotes will use it automatically
//   - ⚪ No session                → quotes will be blocked until captured
//
// Per-portal actions: 📤 Capture Session  ·  ✕ Revoke

interface PortalSessionStatus {
  portalId:   string;
  portalName: string;
  hasSession: boolean;
  sessionId:  string | null;
  capturedAt: string | null;
  lastUsedAt: string | null;
}

const PORTAL_URLS_PS: Record<string, string> = {
  uiic: 'https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login',
};

function PortalSessionsPanel({ token }: { token: string }) {
  const [items, setItems]       = useState<PortalSessionStatus[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [capturing, setCapturing] = useState<PortalSessionStatus | null>(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/portal-sessions`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setItems(data.portals ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function revoke(portalId: string) {
    if (!confirm(`Revoke session for ${portalId.toUpperCase()}? Quotes will fail until you capture a new one.`)) return;
    await fetch(`${autoBase}/api/admin/portal-sessions/${portalId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    load();
  }

  if (loading) return <div style={s.empty}>Loading portal sessions…</div>;
  if (error)   return <div style={{ ...s.error, marginTop: 0 }}>{error}</div>;

  return (
    <div>
      <div style={{ background: '#dbeafe', border: '1px solid #bfdbfe', color: '#1e40af', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
        <b>How this works:</b> Insurer portals block headless logins. Capture your portal session once (you log in via your own browser, paste cookies here)
        and every quote will reuse it silently. When a session expires, refresh it from this page.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {items.map(p => {
          const ageMin   = p.capturedAt ? Math.floor((Date.now() - new Date(p.capturedAt).getTime()) / 60_000) : null;
          const ageLabel = ageMin == null
            ? '—'
            : ageMin < 60 ? `${ageMin} min ago`
            : ageMin < 24 * 60 ? `${Math.floor(ageMin / 60)} h ago`
            : `${Math.floor(ageMin / (24 * 60))} d ago`;
          return (
            <div key={p.portalId} style={ps.card}>
              <div style={ps.cardHead}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{p.portalName}</div>
                <div style={{ ...ps.dot, background: p.hasSession ? '#10b981' : '#94a3b8' }} />
              </div>
              <div style={ps.statusLabel}>
                {p.hasSession ? `🟢 Active · captured ${ageLabel}` : '⚪ No session captured'}
              </div>
              {p.lastUsedAt && (
                <div style={ps.lastUsed}>Last used in a quote: {new Date(p.lastUsedAt).toLocaleString('en-IN')}</div>
              )}
              <div style={ps.actions}>
                <button style={ps.captureBtn} onClick={() => setCapturing(p)}>
                  {p.hasSession ? '↻ Refresh Session' : '📤 Capture Session'}
                </button>
                {p.hasSession && (
                  <button style={ps.revokeBtn} onClick={() => revoke(p.portalId)} title="Revoke">✕</button>
                )}
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div style={s.empty}>No portal insurers enabled. Add one in 🏢 Companies first.</div>
        )}
      </div>

      {capturing && (
        <StandaloneCookieModal
          token={token}
          portalId={capturing.portalId}
          portalName={capturing.portalName}
          portalUrl={PORTAL_URLS_PS[capturing.portalId] ?? ''}
          onClose={() => setCapturing(null)}
          onCaptured={load}
        />
      )}
    </div>
  );
}

const ps: Record<string, React.CSSProperties> = {
  card:        { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHead:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  dot:         { width: 10, height: 10, borderRadius: '50%' },
  statusLabel: { fontSize: 13, color: '#475569', marginBottom: 4 },
  lastUsed:    { fontSize: 11, color: '#94a3b8', marginBottom: 12 },
  actions:     { display: 'flex', gap: 6, marginTop: 12 },
  captureBtn:  { flex: 1, background: '#1a56db', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  revokeBtn:   { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: '9px 12px', fontSize: 13, cursor: 'pointer' },
};

// ── Styles ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:      { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:     { background: '#1a5276', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 },
  backBtn:    { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { fontWeight: 700, fontSize: 16, flex: 1 },
  liveBadge:  { fontSize: 13, color: '#86efac', fontWeight: 600 },
  headerBtn:  { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 13 },
  layout:     { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar:    { width: 180, background: '#fff', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', padding: '12px 0', flexShrink: 0 },
  navBtn:     { padding: '10px 20px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 14, color: '#555' },
  navActive:  { background: '#e8f0f7', color: '#1a5276', fontWeight: 600 },
  content:    { flex: 1, overflowY: 'auto', padding: 24 },
  error:      { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', marginBottom: 16 },
  empty:      { textAlign: 'center', color: '#888', padding: '40px 0' },
};

const ov: Record<string, React.CSSProperties> = {
  grid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 },
  statCard:     { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  statHighlight: { background: '#1a5276', color: '#fff' },
  statValue:    { fontSize: 28, fontWeight: 700, color: 'inherit' },
  statLabel:    { fontSize: 12, color: '#888', marginTop: 4 },
  section:      { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  sectionTitle: { fontWeight: 700, color: '#1a5276', marginBottom: 12 },
  table:        { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  th:           { padding: '10px 16px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#888', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  tr:           { borderBottom: '1px solid #f0f0f0' },
  td:           { padding: '10px 16px', fontSize: 14 },
  failRow:      { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid #f0f0f0' },
  failAction:   { fontFamily: 'monospace', fontSize: 12, color: '#1a5276', minWidth: 160 },
  failReason:   { flex: 1, fontSize: 13, color: '#555' },
  failCnt:      { fontWeight: 700, color: '#e74c3c', fontSize: 13 },
};

const sp: Record<string, React.CSSProperties> = {
  backBtn:       { background: '#f0f4f8', border: '1px solid #ddd', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, marginBottom: 16 },
  timelineTitle: { fontWeight: 700, color: '#1a5276', marginBottom: 16, fontSize: 16 },
  event:         { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10, paddingLeft: 4 },
  eventTime:     { width: 80, fontSize: 11, color: '#888', flexShrink: 0, paddingTop: 2 },
  eventDot:      { width: 10, height: 10, borderRadius: '50%', marginTop: 4, flexShrink: 0 },
  eventBody:     { flex: 1 },
  action:        { fontFamily: 'monospace', fontSize: 13, color: '#1a5276', fontWeight: 600 },
  meta:          { fontSize: 12, color: '#888', marginLeft: 8 },
  fail:          { fontSize: 12, color: '#e74c3c', fontWeight: 600 },
  metaDetail:    { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  metaItem:      { background: '#f0f4f8', borderRadius: 4, padding: '2px 6px', fontSize: 11, color: '#555' },
  viewBtn:       { padding: '4px 10px', background: '#e8f0f7', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#1a5276', fontWeight: 600 },
};
