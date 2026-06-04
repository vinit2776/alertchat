/**
 * Insurance Connections — management page for all connected insurers.
 *
 * Shows each insurer as a card with:
 *   - Connection type badge (Portal / REST API)
 *   - Enable / disable toggle
 *   - Type-specific status (credentials, cache, last tested)
 *   - Type-specific action buttons
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CacheStatus {
  refreshedAt:  string;
  entryCount:   number;
  staleHours:   number;
}

interface SessionStatus {
  portalId:   string;
  sessionId:  string | null;
  capturedAt: string | null;
  lastUsedAt: string | null;
}

interface Company {
  id:                    string;
  name:                  string;
  portalUrl:             string;
  insuranceTypes:        string[];
  playbookVersion:       string;
  enabled:               boolean;
  lastTestedAt:          string | null;
  updatedAt:             string;
  connectorType:         'portal' | 'api';
  credentialsConfigured: boolean;
  credentialNote:        string | null;
  cacheStatus:           CacheStatus | null;
  sessionStatus:         SessionStatus | null;
}

interface CredForm { username: string; password: string; agentCode: string; branchCode: string }

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

  // Live browser login capture modal
  const [liveModal, setLiveModal] = useState<{ id: string; name: string } | null>(null);

  // Credential modal
  const [credModal, setCredModal] = useState<{ id: string; name: string } | null>(null);
  const [credForm,  setCredForm]  = useState<CredForm>({ username: '', password: '', agentCode: '', branchCode: '' });
  const [credSaving, setCredSaving] = useState(false);
  const [credMsg,    setCredMsg]    = useState<{ ok: boolean; text: string } | null>(null);

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

  async function savePortalUrl(id: string, url: string) {
    const res  = await fetch(`${autoBase}/api/admin/companies/${id}/portal-url`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ portalUrl: url }),
    });
    const data = await res.json();
    if (data.success) setCompanies(prev => prev.map(c => c.id === id ? { ...c, portalUrl: url } : c));
    else setMsg(id, false, data.message || 'Failed to save URL');
  }

  function openCredModal(id: string, name: string) {
    setCredForm({ username: '', password: '', agentCode: '', branchCode: '' });
    setCredMsg(null);
    setCredModal({ id, name });
  }

  async function saveCredentials() {
    if (!credModal) return;
    if (!credForm.username || !credForm.password) {
      setCredMsg({ ok: false, text: 'Username and password are required' });
      return;
    }
    setCredSaving(true); setCredMsg(null);
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies/${credModal.id}/credentials`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(credForm),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setCredMsg({ ok: true, text: 'Credentials saved and encrypted successfully' });
      setTimeout(() => { setCredModal(null); load(); }, 1200);
    } catch (err: any) {
      setCredMsg({ ok: false, text: err.message });
    } finally { setCredSaving(false); }
  }

  async function deleteCredentials(id: string) {
    if (!confirm('Remove saved credentials for this portal? You will need to re-enter them to run quotes.')) return;
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies/${id}/credentials`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setMsg(id, true, 'Credentials removed');
      load();
    } catch (err: any) { setMsg(id, false, err.message); }
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
      {/* Live browser login capture modal */}
      {liveModal && (
        <LiveBrowserModal
          token={token}
          portalId={liveModal.id}
          portalName={liveModal.name}
          onClose={() => { setLiveModal(null); load(); }}
        />
      )}

      {/* Credential modal */}
      {credModal && (
        <div style={s.overlay} onClick={() => setCredModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span>Set Credentials — {credModal.name}</span>
              <button style={s.modalClose} onClick={() => setCredModal(null)}>✕</button>
            </div>
            <div style={s.modalBody}>
              <p style={s.modalNote}>
                Credentials are encrypted with AES-256-GCM before storage. They are never returned via the API.
              </p>
              {(['username', 'password', 'agentCode', 'branchCode'] as const).map(field => (
                <div key={field} style={s.fieldRow}>
                  <label style={s.fieldLabel}>
                    {field === 'agentCode' ? 'Agent Code (optional)' :
                     field === 'branchCode' ? 'Branch Code (optional)' :
                     field.charAt(0).toUpperCase() + field.slice(1)}
                    {(field === 'username' || field === 'password') && (
                      <span style={{ color: '#dc2626' }}> *</span>
                    )}
                  </label>
                  <input
                    type={field === 'password' ? 'password' : 'text'}
                    value={credForm[field]}
                    onChange={e => setCredForm(prev => ({ ...prev, [field]: e.target.value }))}
                    placeholder={
                      field === 'username'   ? 'Portal login username' :
                      field === 'password'   ? 'Portal login password' :
                      field === 'agentCode'  ? 'e.g. BRC000025200004' :
                      'e.g. AP1234'
                    }
                    style={s.fieldInput}
                    autoComplete={field === 'password' ? 'new-password' : 'off'}
                  />
                </div>
              ))}
              {credMsg && (
                <div style={{
                  ...s.credMsg,
                  background:  credMsg.ok ? '#f0fdf4' : '#fef2f2',
                  color:       credMsg.ok ? '#15803d' : '#dc2626',
                  borderColor: credMsg.ok ? '#bbf7d0' : '#fecaca',
                }}>
                  {credMsg.text}
                </div>
              )}
              <div style={s.modalActions}>
                <button style={s.modalCancel} onClick={() => setCredModal(null)}>Cancel</button>
                <button
                  style={{ ...s.modalSave, opacity: credSaving ? 0.7 : 1 }}
                  onClick={saveCredentials}
                  disabled={credSaving}
                >
                  {credSaving ? 'Saving…' : 'Save & Encrypt'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
                onSetCredentials={() => openCredModal(c.id, c.name)}
                onDeleteCredentials={() => deleteCredentials(c.id)}
                onOpenLiveBrowser={() => setLiveModal({ id: c.id, name: c.name })}
                onSavePortalUrl={url => savePortalUrl(c.id, url)}
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
  onToggle:            (v: boolean) => void;
  onTestPortal:        () => void;
  onTestApi:           () => void;
  onRefreshCache:      () => void;
  onSetCredentials:    () => void;
  onDeleteCredentials: () => void;
  onOpenLiveBrowser:   () => void;
  onSavePortalUrl:     (url: string) => void;
}

function CompanyCard({
  company: c, toggling, testing, refreshing, actionMsg,
  onToggle, onTestPortal, onTestApi, onRefreshCache, onSetCredentials, onDeleteCredentials, onOpenLiveBrowser, onSavePortalUrl,
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

      {/* Portal URL row */}
      <PortalUrlRow url={c.portalUrl} onSave={onSavePortalUrl} />

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
            {/* Portal: credentials */}
            <StatusRow
              label="Credentials"
              value={c.credentialsConfigured ? 'Configured' : 'Not set'}
              ok={c.credentialsConfigured}
              note={!c.credentialsConfigured ? 'Click "Set Credentials" to add portal login' : undefined}
            />
            {/* Portal: session memory */}
            <SessionMemoryRow session={c.sessionStatus} />
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
              note={!c.lastTestedAt ? 'Run "Test Login" to verify credentials work' : undefined}
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
          <>
            <ActionBtn
              label={c.sessionStatus?.sessionId ? 'Re-Login' : 'Login & Capture'}
              icon="🖥"
              disabled={false}
              onClick={onOpenLiveBrowser}
              primary={!c.sessionStatus?.sessionId}
              title="Open interactive browser — log in manually to capture your session"
            />
            <ActionBtn
              label="Set Credentials"
              icon="🔐"
              disabled={false}
              onClick={onSetCredentials}
              title="Store portal username and password (encrypted)"
            />
            <ActionBtn
              label={testing ? 'Testing…' : 'Test Login'}
              icon="🔑"
              disabled={testing}
              onClick={onTestPortal}
              title="Test login using saved credentials"
            />
            {c.credentialsConfigured && (
              <ActionBtn
                label="Clear"
                icon="🗑"
                disabled={false}
                onClick={onDeleteCredentials}
                title="Remove saved credentials from the vault"
              />
            )}
          </>
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

function PortalUrlRow({ url, onSave }: { url: string; onSave: (url: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState('');

  function startEdit() { setDraft(url); setEditing(true); }
  function cancel()    { setEditing(false); }
  function save()      { if (draft.trim()) { onSave(draft.trim()); } setEditing(false); }

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
          placeholder="https://portal.insurer.com/login"
          style={{ flex: 1, fontSize: 12, padding: '4px 8px', border: '1px solid #6366f1', borderRadius: 6, outline: 'none' }}
        />
        <button onClick={save}   style={{ fontSize: 11, padding: '3px 10px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer' }}>Save</button>
        <button onClick={cancel} style={{ fontSize: 11, padding: '3px 8px',  background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 5, cursor: 'pointer' }}>✕</button>
      </div>
    );
  }

  if (!url) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 500 }}>⚠ No portal URL</span>
        <button onClick={startEdit} style={{ fontSize: 11, padding: '2px 8px', background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 5, cursor: 'pointer' }}>+ Add URL</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <a
        href={url} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 11, color: '#1d4ed8', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
        title={url}
      >
        🔗 {url}
      </a>
      <button onClick={startEdit} style={{ fontSize: 10, padding: '2px 6px', background: '#f0f4f8', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 4, cursor: 'pointer', flexShrink: 0 }}>Edit</button>
    </div>
  );
}

function SessionMemoryRow({ session }: { session: SessionStatus | null }) {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins < 60)  return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  if (!session?.sessionId) {
    return (
      <div style={card.statusRow}>
        <span style={card.statusLabel}>Session memory</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ ...card.statusDot, background: '#f59e0b' }} />
            <span style={{ fontSize: 13, color: '#1f2937', fontWeight: 500 }}>Not built</span>
          </span>
          <span style={card.statusNote}>Run "Test Login" to capture a session</span>
        </div>
      </div>
    );
  }

  const capturedStr = session.capturedAt ? fmt(session.capturedAt) : '—';
  const usedStr     = session.lastUsedAt ? fmt(session.lastUsedAt) : 'never used';
  const capturedFull = session.capturedAt
    ? new Date(session.capturedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  return (
    <div style={card.statusRow}>
      <span style={card.statusLabel}>Session memory</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...card.statusDot, background: '#16a34a' }} />
          <span style={{ fontSize: 13, color: '#1f2937', fontWeight: 500 }}>Built {capturedStr}</span>
        </span>
        <span style={card.statusNote} title={capturedFull}>
          Captured {capturedFull} · last used {usedStr}
        </span>
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

// ── Live Browser Modal ────────────────────────────────────────────────────────

const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

interface LiveBrowserProps {
  token:      string;
  portalId:   string;
  portalName: string;
  onClose:    () => void;
}

function LiveBrowserModal({ token, portalId, portalName, onClose }: LiveBrowserProps) {
  const [sessionId,  setSessionId]  = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [status,     setStatus]     = useState('Opening browser…');
  const [captured,   setCaptured]   = useState(false);
  const [error,      setError]      = useState('');
  const imgRef    = useRef<HTMLImageElement>(null);
  const sseRef    = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);

  const apiPost = useCallback(async (path: string, body: unknown) => {
    return fetch(`${autoBase}/api/admin/live-browser${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(r => r.json());
  }, [token]);

  // Start session on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('Opening portal browser…');
      try {
        const data = await apiPost('/start', { portalId });
        if (cancelled) return;
        if (!data.success) { setError(data.message || 'Failed to start browser'); return; }
        setSessionId(data.sessionId);
        sessionRef.current = data.sessionId;
        if (data.screenshot) setScreenshot(data.screenshot);
        setStatus('Browser ready — log in below');
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [portalId, apiPost]);

  // Open SSE stream once sessionId is known
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(
      `${autoBase}/api/admin/live-browser/${sessionId}/stream?token=${encodeURIComponent(token)}`,
    );
    sseRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      const evt = JSON.parse(e.data);
      if (evt.type === 'frame') {
        setScreenshot(evt.image);
      } else if (evt.type === 'session_captured') {
        setCaptured(true);
        setStatus(`✓ ${evt.message}`);
        es.close();
      } else if (evt.type === 'session_closed') {
        if (!captured) setStatus(`Session closed (${evt.reason})`);
        es.close();
      }
    };

    es.onerror = () => setStatus('Stream interrupted — actions still work');

    return () => { es.close(); };
  }, [sessionId, captured]);

  // Close live browser on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        fetch(`${autoBase}/api/admin/live-browser/${sessionRef.current}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    };
  }, [token]);

  // Map click on displayed image → viewport coordinates → POST to backend
  async function handleImageClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!sessionId || captured) return;
    const rect = imgRef.current!.getBoundingClientRect();
    const scaleX = VIEWPORT_W / rect.width;
    const scaleY = VIEWPORT_H / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top)  * scaleY);
    const data = await apiPost(`/${sessionId}/click`, { x, y });
    if (data.screenshot) setScreenshot(data.screenshot);
  }

  // Keyboard: capture when overlay div is focused
  async function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!sessionId || captured) return;
    e.preventDefault();

    // Map common keys to Playwright key names
    const KEY_MAP: Record<string, string> = {
      Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
      Escape: 'Escape', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', Home: 'Home', End: 'End',
    };

    if (e.key in KEY_MAP) {
      const data = await apiPost(`/${sessionId}/key`, { key: KEY_MAP[e.key] });
      if (data.screenshot) setScreenshot(data.screenshot);
    } else if (e.key.length === 1) {
      const data = await apiPost(`/${sessionId}/type`, { text: e.key });
      if (data.screenshot) setScreenshot(data.screenshot);
    }
  }

  return (
    <div style={lb.overlay}>
      <div style={lb.modal}>
        {/* Header */}
        <div style={lb.header}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>
              {captured ? '✓ Session Captured' : `Login — ${portalName}`}
            </span>
            <span style={{ fontSize: 12, color: captured ? '#86efac' : 'rgba(255,255,255,0.7)' }}>
              {status}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {captured && (
              <button style={lb.doneBtn} onClick={onClose}>Done</button>
            )}
            <button style={lb.closeBtn} onClick={onClose} title="Close">✕</button>
          </div>
        </div>

        {/* Instruction bar */}
        {!captured && !error && (
          <div style={lb.instructions}>
            <span>🖱 Click to interact</span>
            <span style={{ margin: '0 12px', color: '#cbd5e1' }}>·</span>
            <span>⌨️ Click the browser first, then type</span>
            <span style={{ margin: '0 12px', color: '#cbd5e1' }}>·</span>
            <span>Session captures automatically after login</span>
          </div>
        )}

        {/* Browser viewport */}
        <div
          style={lb.viewport}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          title="Click to focus keyboard input"
        >
          {error ? (
            <div style={lb.errorMsg}>{error}</div>
          ) : screenshot ? (
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${screenshot}`}
              style={{
                width: '100%', height: '100%', objectFit: 'contain',
                cursor: captured ? 'default' : 'crosshair',
                display: 'block',
              }}
              onClick={handleImageClick}
              alt="Portal browser"
              draggable={false}
            />
          ) : (
            <div style={lb.loadingMsg}>
              <span style={{ fontSize: 32, marginBottom: 12 }}>⏳</span>
              Opening browser…
            </div>
          )}
          {captured && (
            <div style={lb.capturedOverlay}>
              <span style={{ fontSize: 40 }}>✓</span>
              <span style={{ fontSize: 18, fontWeight: 700 }}>Session Captured</span>
              <span style={{ fontSize: 13, color: '#86efac', textAlign: 'center' }}>{status}</span>
              <button style={lb.doneBtn} onClick={onClose}>Close & Refresh</button>
            </div>
          )}
        </div>
      </div>
    </div>
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

  // Credential modal
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal:        { background: '#fff', borderRadius: 16, width: 460, maxWidth: '92vw', boxShadow: '0 8px 40px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column' },
  modalHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px 14px', borderBottom: '1px solid #f3f4f6', fontWeight: 700, fontSize: 16, color: '#111827' },
  modalClose:   { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#6b7280', padding: '2px 6px', borderRadius: 6 },
  modalBody:    { padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 },
  modalNote:    { margin: 0, fontSize: 12, color: '#6b7280', background: '#f8fafc', borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 },
  fieldRow:     { display: 'flex', flexDirection: 'column', gap: 5 },
  fieldLabel:   { fontSize: 13, fontWeight: 600, color: '#374151' },
  fieldInput:   { border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 14, outline: 'none', fontFamily: 'inherit' },
  credMsg:      { borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 500, border: '1px solid' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 },
  modalCancel:  { background: '#f3f4f6', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontSize: 14, color: '#374151', fontWeight: 500 },
  modalSave:    { background: '#1a5276', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontSize: 14, color: '#fff', fontWeight: 600 },
};

// Live browser modal styles
const lb: Record<string, React.CSSProperties> = {
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  modal:    { background: '#0f172a', borderRadius: 14, display: 'flex', flexDirection: 'column', width: '90vw', maxWidth: 1000, maxHeight: '94vh', boxShadow: '0 24px 80px rgba(0,0,0,0.6)', overflow: 'hidden' },
  header:   { background: '#1e293b', padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, borderBottom: '1px solid #334155' },
  instructions: { background: '#1e3a5f', padding: '8px 18px', fontSize: 12, color: '#93c5fd', display: 'flex', alignItems: 'center', flexShrink: 0 },
  viewport: { flex: 1, position: 'relative', overflow: 'hidden', background: '#000', minHeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none', cursor: 'crosshair' },
  loadingMsg: { display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#94a3b8', fontSize: 14, gap: 4 },
  errorMsg:   { color: '#f87171', padding: 24, textAlign: 'center', fontSize: 14 },
  capturedOverlay: {
    position: 'absolute', inset: 0, background: 'rgba(0,30,0,0.85)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 12, color: '#4ade80', fontSize: 14,
  },
  closeBtn: { background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6, color: '#fff', padding: '4px 10px', cursor: 'pointer', fontSize: 16 },
  doneBtn:  { background: '#16a34a', border: 'none', borderRadius: 8, color: '#fff', padding: '8px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 700 },
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
