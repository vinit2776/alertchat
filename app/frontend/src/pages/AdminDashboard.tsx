import { useState, useEffect } from 'react';

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

type AdminView = 'dashboard' | 'sessions' | 'companies' | 'quotes';

interface Props {
  token: string;
  onBack: () => void;
}

export default function AdminDashboard({ token, onBack }: Props) {
  const [view, setView]           = useState<AdminView>('dashboard');
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

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

  useEffect(() => { loadAnalytics(); }, []);

  const nav: Array<{ key: AdminView; label: string }> = [
    { key: 'dashboard', label: '📊 Overview' },
    { key: 'sessions',  label: '📋 Sessions' },
    { key: 'companies', label: '🏢 Companies' },
    { key: 'quotes',    label: '📄 Quotes' },
  ];

  return (
    <div style={s.shell}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>Admin Dashboard</div>
        {analytics && (
          <div style={s.liveBadge}>● {analytics.liveSessions} live</div>
        )}
      </div>

      <div style={s.layout}>
        <nav style={s.sidebar}>
          {nav.map(n => (
            <button key={n.key} style={{ ...s.navBtn, ...(view === n.key ? s.navActive : {}) }}
              onClick={() => setView(n.key)}>
              {n.label}
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
          {view === 'sessions'  && <SessionsPanel  token={token} />}
          {view === 'companies' && <CompaniesPanel token={token} />}
          {view === 'quotes'    && <QuotesPanel    token={token} />}
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

// ── Styles ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:      { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:     { background: '#1a5276', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 },
  backBtn:    { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { fontWeight: 700, fontSize: 16, flex: 1 },
  liveBadge:  { fontSize: 13, color: '#86efac', fontWeight: 600 },
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
