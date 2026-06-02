/**
 * Insurance Connections — management page for all connected insurers.
 *
 * Shows each insurer as a card with:
 *   - Connection type badge (Portal / REST API)
 *   - Enable / disable toggle
 *   - Type-specific status (credentials, cache, last tested)
 *   - Type-specific action buttons
 */

import { useState, useEffect, useCallback } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CacheStatus {
  refreshedAt:  string;
  entryCount:   number;
  staleHours:   number;
}

interface Company {
  id:                    string;
  name:                  string;
  insuranceTypes:        string[];
  playbookVersion:       string;
  enabled:               boolean;
  lastTestedAt:          string | null;
  updatedAt:             string;
  connectorType:         'portal' | 'api';
  credentialsConfigured: boolean;
  credentialNote:        string | null;
  cacheStatus:           CacheStatus | null;
}

interface Props { token: string; onBack: () => void }

// ── Connector type colours / labels ───────────────────────────────────────────

const CONNECTOR_META: Record<string, { label: string; icon: string; bg: string; color: string }> = {
  portal: { label: 'Portal (Browser)',  icon: '🌐', bg: '#eff6ff', color: '#1d4ed8' },
  api:    { label: 'REST API',          icon: '⚡', bg: '#f0fdf4', color: '#15803d' },
};

// ── Main component ────────────────────────────────────────────────────────────

export default function CompanyRegistry({ token, onBack }: Props) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  // Per-company action state
  const [toggling,    setToggling]    = useState<string | null>(null);
  const [testing,     setTesting]     = useState<string | null>(null);
  const [refreshing,  setRefreshing]  = useState<string | null>(null);
  const [actionMsg,   setActionMsg]   = useState<Record<string, { ok: boolean; text: string }>>({});

  const setMsg = (id: string, ok: boolean, text: string) =>
    setActionMsg(prev => ({ ...prev, [id]: { ok, text } }));

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      // Sort: portal first, then api; alphabetical within each group
      const sorted = [...data.companies].sort((a: Company, b: Company) => {
        if (a.connectorType !== b.connectorType)
          return a.connectorType === 'portal' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setCompanies(sorted);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function toggleEnabled(id: string, enabled: boolean) {
    setToggling(id);
    try {
      const res = await fetch(`${autoBase}/api/admin/companies/${id}/enabled`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setCompanies(prev => prev.map(c => c.id === id ? { ...c, enabled } : c));
    } catch (err: any) {
      setMsg(id, false, err.message);
    } finally { setToggling(null); }
  }

  async function testPortalLogin(id: string) {
    setTesting(id); setMsg(id, true, 'Testing portal login…');
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies/${id}/test`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.captchaRequired) {
        setMsg(id, false, 'Captcha required — open full Company Registry for manual input');
      } else if (data.success) {
        setMsg(id, true, `✓ Login OK — ${data.pageTitle}`);
        load(); // refresh lastTestedAt
      } else {
        setMsg(id, false, data.message || 'Test failed');
      }
    } catch (err: any) { setMsg(id, false, err.message); }
    finally { setTesting(null); }
  }

  async function testBajajApi(id: string) {
    setTesting(id); setMsg(id, true, 'Testing Bajaj API…');
    try {
      const res  = await fetch(`${autoBase}/api/admin/bajaj/test-api`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setMsg(id, data.success, data.message || (data.success ? 'API OK' : 'Failed'));
    } catch (err: any) { setMsg(id, false, err.message); }
    finally { setTesting(null); }
  }

  async function refreshBajajCache(id: string) {
    setRefreshing(id); setMsg(id, true, 'Fetching vehicle master from Bajaj API…');
    try {
      const res  = await fetch(`${autoBase}/api/admin/bajaj/refresh-vehicles`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setMsg(id, true, `✓ Cache refreshed — ${data.added.toLocaleString()} vehicles loaded`);
        load(); // refresh cacheStatus
      } else {
        setMsg(id, false, data.message || `Refresh failed. Errors: ${data.errors?.join(', ')}`);
      }
    } catch (err: any) { setMsg(id, false, err.message); }
    finally { setRefreshing(null); }
  }

  return (
    <div style={s.shell}>
      {/* Header */}
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>
          <span style={{ marginRight: 8 }}>🔗</span>
          Insurance Connections
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={s.headerSub}>{companies.length} insurer{companies.length !== 1 ? 's' : ''}</span>
          <button style={s.refreshBtn} onClick={load} disabled={loading}>
            {loading ? '…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      <div style={s.body}>
        {error && <div style={s.errorBanner}>{error}</div>}

        {loading ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>⌛</div>
            Loading insurance connections…
          </div>
        ) : companies.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>🏢</div>
            No insurance companies registered yet.
          </div>
        ) : (
          <div style={s.grid}>
            {companies.map(c => (
              <CompanyCard
                key={c.id}
                company={c}
                toggling={toggling === c.id}
                testing={testing   === c.id}
                refreshing={refreshing === c.id}
                actionMsg={actionMsg[c.id]}
                onToggle={v => toggleEnabled(c.id, v)}
                onTestPortal={() => testPortalLogin(c.id)}
                onTestApi={() => testBajajApi(c.id)}
                onRefreshCache={() => refreshBajajCache(c.id)}
              />
            ))}
          </div>
        )}

        {/* Legend */}
        {!loading && companies.length > 0 && (
          <div style={s.legend}>
            {Object.entries(CONNECTOR_META).map(([type, meta]) => (
              <span key={type} style={s.legendItem}>
                <span style={{ ...s.typeBadge, background: meta.bg, color: meta.color }}>
                  {meta.icon} {meta.label}
                </span>
              </span>
            ))}
            <span style={s.legendNote}>
              Portal connectors use browser automation · API connectors call the insurer's REST API directly
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Company card ──────────────────────────────────────────────────────────────

interface CardProps {
  company:    Company;
  toggling:   boolean;
  testing:    boolean;
  refreshing: boolean;
  actionMsg?: { ok: boolean; text: string };
  onToggle:        (v: boolean) => void;
  onTestPortal:    () => void;
  onTestApi:       () => void;
  onRefreshCache:  () => void;
}

function CompanyCard({
  company: c, toggling, testing, refreshing, actionMsg,
  onToggle, onTestPortal, onTestApi, onRefreshCache,
}: CardProps) {
  const meta  = CONNECTOR_META[c.connectorType] ?? CONNECTOR_META.portal;
  const isApi = c.connectorType === 'api';

  const cacheOk     = c.cacheStatus && c.cacheStatus.entryCount > 0;
  const cacheStale  = c.cacheStatus && c.cacheStatus.staleHours > 24;

  return (
    <div style={{ ...card.shell, ...(c.enabled ? {} : card.shellDisabled) }}>
      {/* Card header row */}
      <div style={card.header}>
        <div style={card.identity}>
          <div style={card.nameRow}>
            <span style={card.name}>{c.name}</span>
          </div>
          <span style={card.id}>{c.id}</span>
        </div>

        {/* Enable / Disable toggle */}
        <div style={card.toggleWrap}>
          <span style={{ fontSize: 11, color: c.enabled ? '#15803d' : '#9ca3af', fontWeight: 600 }}>
            {c.enabled ? 'ENABLED' : 'DISABLED'}
          </span>
          <Toggle checked={c.enabled} loading={toggling} onChange={onToggle} />
        </div>
      </div>

      {/* Connection type badge */}
      <div style={card.typeLine}>
        <span style={{ ...card.typeBadge, background: meta.bg, color: meta.color }}>
          {meta.icon} {meta.label}
        </span>
        {c.insuranceTypes.map(t => (
          <span key={t} style={card.insBadge}>{t}</span>
        ))}
      </div>

      <div style={card.divider} />

      {/* Status section — type-specific */}
      <div style={card.statusGrid}>
        {isApi ? (
          <>
            {/* API: credentials */}
            <StatusRow
              label="Credentials"
              value={c.credentialsConfigured ? 'Configured' : 'Not configured'}
              ok={c.credentialsConfigured}
              note={c.credentialNote ?? undefined}
            />
            {/* API: vehicle cache (Bajaj) */}
            {c.cacheStatus && (
              <StatusRow
                label="Vehicle cache"
                value={
                  cacheOk
                    ? `${c.cacheStatus.entryCount.toLocaleString()} vehicles`
                    : 'Empty — needs refresh'
                }
                ok={!!(cacheOk && !cacheStale)}
                warn={!!(cacheOk && cacheStale)}
                note={
                  cacheOk
                    ? (cacheStale ? `Last refreshed ${c.cacheStatus.staleHours}h ago — consider refreshing` : `Last refreshed ${c.cacheStatus.refreshedAt.slice(0, 10)}`)
                    : 'Run "Refresh Cache" after configuring credentials'
                }
              />
            )}
          </>
        ) : (
          <>
            {/* Portal: playbook version */}
            <StatusRow
              label="Playbook"
              value={`v${c.playbookVersion}`}
              ok={true}
            />
            {/* Portal: last tested */}
            <StatusRow
              label="Last tested"
              value={c.lastTestedAt
                ? new Date(c.lastTestedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                : 'Never'}
              ok={!!c.lastTestedAt}
              note={!c.lastTestedAt ? 'Run "Test Login" to verify credentials' : undefined}
            />
          </>
        )}
      </div>

      {/* Action feedback message */}
      {actionMsg && (
        <div style={{
          ...card.msgBanner,
          background: actionMsg.ok ? '#f0fdf4' : '#fef2f2',
          color:      actionMsg.ok ? '#15803d' : '#dc2626',
          borderColor: actionMsg.ok ? '#bbf7d0' : '#fecaca',
        }}>
          {actionMsg.text}
        </div>
      )}

      {/* Action buttons */}
      <div style={card.actions}>
        {isApi ? (
          <>
            <ActionBtn
              label={testing ? 'Testing…' : 'Test API'}
              icon="🔌"
              disabled={testing || !c.credentialsConfigured}
              onClick={onTestApi}
              title={!c.credentialsConfigured ? 'Configure credentials first' : 'Verify API credentials with a test call'}
            />
            {c.cacheStatus !== null && (
              <ActionBtn
                label={refreshing ? 'Refreshing…' : 'Refresh Cache'}
                icon="♻️"
                disabled={refreshing || !c.credentialsConfigured}
                onClick={onRefreshCache}
                primary={!cacheOk}
                title={!c.credentialsConfigured ? 'Configure credentials first' : 'Download vehicle master from Bajaj API'}
              />
            )}
          </>
        ) : (
          <ActionBtn
            label={testing ? 'Testing…' : 'Test Login'}
            icon="🔑"
            disabled={testing}
            onClick={onTestPortal}
            title="Log into portal and verify the session works"
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({ checked, loading, onChange }: { checked: boolean; loading: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={loading}
      title={checked ? 'Click to disable' : 'Click to enable'}
      style={{
        width: 48, height: 26, borderRadius: 13, border: 'none', cursor: loading ? 'default' : 'pointer',
        background: checked ? '#16a34a' : '#d1d5db',
        position: 'relative', transition: 'background 0.2s',
        opacity: loading ? 0.6 : 1, flexShrink: 0,
      }}>
      <span style={{
        position: 'absolute', top: 4, left: checked ? 24 : 4,
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, color: '#888',
      }}>
        {loading && '…'}
      </span>
    </button>
  );
}

function StatusRow({ label, value, ok, warn, note }: {
  label: string; value: string; ok: boolean; warn?: boolean; note?: string;
}) {
  const dotColor = ok && !warn ? '#16a34a' : warn ? '#f59e0b' : '#ef4444';
  return (
    <div style={card.statusRow}>
      <span style={card.statusLabel}>{label}</span>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...card.statusDot, background: dotColor }} />
          <span style={{ fontSize: 13, color: '#1f2937', fontWeight: 500 }}>{value}</span>
        </span>
        {note && <span style={card.statusNote}>{note}</span>}
      </div>
    </div>
  );
}

function ActionBtn({ label, icon, disabled, onClick, primary, title }: {
  label: string; icon: string; disabled: boolean; onClick: () => void; primary?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 14px', borderRadius: 8, border: 'none', cursor: disabled ? 'default' : 'pointer',
        fontSize: 13, fontWeight: 500,
        background: primary ? '#1a5276' : disabled ? '#f3f4f6' : '#f0f4f8',
        color:      primary ? '#fff'    : disabled ? '#9ca3af' : '#374151',
        opacity: disabled ? 0.7 : 1,
        transition: 'background 0.15s',
      }}>
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:       { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:      { background: '#1a5276', color: '#fff', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 },
  backBtn:     { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { flex: 1, fontWeight: 700, fontSize: 17 },
  headerSub:   { fontSize: 13, color: 'rgba(255,255,255,0.65)' },
  refreshBtn:  { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 14px', cursor: 'pointer', fontSize: 13 },
  body:        { flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 },
  errorBanner: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px' },
  emptyState:  { textAlign: 'center' as const, color: '#888', padding: '60px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  emptyIcon:   { fontSize: 40 },
  grid:        { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 },
  legend:      { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const, paddingTop: 8 },
  legendItem:  {},
  legendNote:  { fontSize: 12, color: '#94a3b8', marginLeft: 4 },
  typeBadge:   { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 },
};

const card: Record<string, React.CSSProperties> = {
  shell:        {
    background: '#fff', borderRadius: 14,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.04)',
    display: 'flex', flexDirection: 'column', padding: '20px',
    gap: 12, transition: 'box-shadow 0.2s',
  },
  shellDisabled: { opacity: 0.72 },

  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  identity:     { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
  nameRow:      { display: 'flex', alignItems: 'center', gap: 8 },
  name:         { fontWeight: 700, fontSize: 16, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  id:           { fontFamily: 'monospace', fontSize: 11, color: '#6b7280', letterSpacing: '0.3px' },
  toggleWrap:   { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 },

  typeLine:     { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  typeBadge:    { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 },
  insBadge:     { background: '#e0e7ff', color: '#3730a3', padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' },

  divider:      { height: 1, background: '#f3f4f6', margin: '0 -4px' },

  statusGrid:   { display: 'flex', flexDirection: 'column', gap: 10 },
  statusRow:    { display: 'flex', alignItems: 'flex-start', gap: 12 },
  statusLabel:  { width: 110, fontSize: 12, color: '#6b7280', fontWeight: 500, flexShrink: 0, paddingTop: 1 },
  statusDot:    { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0, marginTop: 3 },
  statusNote:   { fontSize: 11, color: '#9ca3af', marginLeft: 14 },

  msgBanner:    { borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 500, border: '1px solid', lineHeight: 1.5 },

  actions:      { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 },
};
