import { useState, useEffect } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

interface AppUser {
  id:                   string;
  username:             string;
  email:                string;
  role:                 'super_admin' | 'chat_user';
  enabled:              boolean;
  last_login:           string | null;
  created_at:           string;
  created_by_username:  string | null;
}

interface AuditEvent {
  ts:           string;
  session_id:   string;
  portal_id:    string | null;
  ins_type:     string | null;
  action:       string;
  outcome:      string;
  duration_ms:  number | null;
}

interface Props {
  token:         string;
  onBack:        () => void;
  currentUserId: string;
}

export default function UserManagement({ token, onBack, currentUserId }: Props) {
  const [users, setUsers]               = useState<AppUser[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [showCreate, setShowCreate]     = useState(false);
  const [auditUser, setAuditUser]       = useState<AppUser | null>(null);
  const [auditEvents, setAuditEvents]   = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [resetTarget, setResetTarget]   = useState<AppUser | null>(null);
  const [newPwd, setNewPwd]             = useState('');
  const [busy, setBusy]                 = useState(false);

  async function loadUsers() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setUsers(data.users);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadUsers(); }, []);

  async function toggleEnabled(u: AppUser) {
    setBusy(true);
    try {
      const res  = await fetch(`${autoBase}/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !u.enabled }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, enabled: !u.enabled } : x));
    } catch (e: any) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function deleteUser(u: AppUser) {
    if (!confirm(`Delete "${u.username}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res  = await fetch(`${autoBase}/api/users/${u.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setUsers(prev => prev.filter(x => x.id !== u.id));
    } catch (e: any) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function openAudit(u: AppUser) {
    setAuditUser(u); setAuditLoading(true); setAuditEvents([]);
    try {
      const res  = await fetch(`${autoBase}/api/users/${u.id}/audit?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setAuditEvents(data.events);
    } catch (e: any) { alert(e.message); }
    finally { setAuditLoading(false); }
  }

  async function submitResetPwd() {
    if (!resetTarget || newPwd.length < 8) return;
    setBusy(true);
    try {
      const res  = await fetch(`${autoBase}/api/users/${resetTarget.id}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: newPwd }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setResetTarget(null); setNewPwd('');
      alert('Password reset successfully');
    } catch (e: any) { alert(e.message); }
    finally { setBusy(false); }
  }

  const superAdmins = users.filter(u => u.role === 'super_admin');
  const chatUsers   = users.filter(u => u.role === 'chat_user');

  // ── Audit drawer ──────────────────────────────────────────────────────────
  if (auditUser) {
    return (
      <div style={s.shell}>
        <div style={s.header}>
          <button style={s.backBtn} onClick={() => setAuditUser(null)}>← Users</button>
          <div style={s.headerTitle}>Audit Trail — {auditUser.username}</div>
          <div style={s.badge}>{auditUser.role === 'super_admin' ? '🔑 Super Admin' : '💬 Chat User'}</div>
        </div>
        <div style={s.body}>
          {auditLoading && <div style={s.empty}>Loading…</div>}
          {!auditLoading && auditEvents.length === 0 && <div style={s.empty}>No activity recorded yet.</div>}
          {!auditLoading && auditEvents.length > 0 && (
            <table style={s.table}>
              <thead>
                <tr>{['Time','Action','Outcome','Portal','Insurance','Duration'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {auditEvents.map((e, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#f9f9f9' : '#fff' }}>
                    <td style={s.td}>{new Date(e.ts).toLocaleString('en-IN')}</td>
                    <td style={s.td}><code style={{ fontSize: 11 }}>{e.action}</code></td>
                    <td style={{ ...s.td, color: e.outcome === 'success' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{e.outcome}</td>
                    <td style={s.td}>{e.portal_id ?? '—'}</td>
                    <td style={s.td}>{e.ins_type ?? '—'}</td>
                    <td style={s.td}>{e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={s.shell}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Admin</button>
        <div style={s.headerTitle}>User Management</div>
        <button style={s.createBtn} onClick={() => setShowCreate(true)}>+ Add User</button>
      </div>

      <div style={s.body}>
        {error && <div style={s.error}>{error}</div>}
        {loading && <div style={s.empty}>Loading users…</div>}

        {!loading && (
          <>
            <UserTable
              title="Super Admins"
              users={superAdmins}
              currentUserId={currentUserId}
              busy={busy}
              onToggle={toggleEnabled}
              onDelete={deleteUser}
              onAudit={openAudit}
              onReset={u => { setResetTarget(u); setNewPwd(''); }}
            />
            <UserTable
              title="Chat Users"
              users={chatUsers}
              currentUserId={currentUserId}
              busy={busy}
              onToggle={toggleEnabled}
              onDelete={deleteUser}
              onAudit={openAudit}
              onReset={u => { setResetTarget(u); setNewPwd(''); }}
            />
          </>
        )}
      </div>

      {/* ── Create user modal ─────────────────────────────────────────── */}
      {showCreate && (
        <CreateUserModal
          token={token}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadUsers(); }}
        />
      )}

      {/* ── Reset password modal ──────────────────────────────────────── */}
      {resetTarget && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Reset password — {resetTarget.username}</div>
            <input style={s.input} type="password" placeholder="New password (min 8 chars)"
              value={newPwd} onChange={e => setNewPwd(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitResetPwd()} autoFocus />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={{ ...s.btn, background: '#1a5276', flex: 1 }}
                onClick={submitResetPwd} disabled={newPwd.length < 8 || busy}>
                {busy ? 'Saving…' : 'Reset Password'}
              </button>
              <button style={{ ...s.btn, background: '#888' }} onClick={() => setResetTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── User table ────────────────────────────────────────────────────────────

function UserTable({ title, users, currentUserId, busy, onToggle, onDelete, onAudit, onReset }: {
  title: string;
  users: AppUser[];
  currentUserId: string;
  busy: boolean;
  onToggle: (u: AppUser) => void;
  onDelete: (u: AppUser) => void;
  onAudit:  (u: AppUser) => void;
  onReset:  (u: AppUser) => void;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={s.sectionTitle}>{title} <span style={s.count}>{users.length}</span></div>
      {users.length === 0 && <div style={s.empty}>None yet.</div>}
      {users.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>{['Username','Email','Status','Last Login','Created By','Actions'].map(h => (
              <th key={h} style={s.th}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const isMe = u.id === currentUserId;
              return (
                <tr key={u.id} style={{ background: i % 2 === 0 ? '#f9f9f9' : '#fff', opacity: u.enabled ? 1 : 0.55 }}>
                  <td style={s.td}>
                    <strong>{u.username}</strong>
                    {isMe && <span style={s.meBadge}> you</span>}
                  </td>
                  <td style={s.td}>{u.email}</td>
                  <td style={s.td}>
                    <span style={{ ...s.statusPill, background: u.enabled ? '#dcfce7' : '#fee2e2', color: u.enabled ? '#16a34a' : '#dc2626' }}>
                      {u.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={s.td}>{u.last_login ? new Date(u.last_login).toLocaleString('en-IN') : 'Never'}</td>
                  <td style={s.td}>{u.created_by_username ?? '—'}</td>
                  <td style={{ ...s.td, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button style={s.actionBtn} onClick={() => onAudit(u)}>📋 Audit</button>
                    <button style={s.actionBtn} onClick={() => onReset(u)}>🔑 Reset pwd</button>
                    {!isMe && (
                      <button
                        style={{ ...s.actionBtn, background: u.enabled ? '#fef3c7' : '#d1fae5', color: u.enabled ? '#92400e' : '#065f46' }}
                        onClick={() => onToggle(u)} disabled={busy}>
                        {u.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                    {!isMe && (
                      <button style={{ ...s.actionBtn, background: '#fee2e2', color: '#dc2626' }}
                        onClick={() => onDelete(u)} disabled={busy}>Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Create user modal ─────────────────────────────────────────────────────

function CreateUserModal({ token, onClose, onCreated }: {
  token: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm]   = useState({ username: '', email: '', password: '', role: 'chat_user' as 'super_admin' | 'chat_user' });
  const [error, setError] = useState('');
  const [busy, setBusy]   = useState(false);

  function update(k: keyof typeof form, v: string) { setForm(p => ({ ...p, [k]: v })); }

  async function submit() {
    setError('');
    if (!form.username || !form.email || !form.password) { setError('All fields required'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true);
    try {
      const res  = await fetch(`${autoBase}/api/users`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      onCreated();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.modalTitle}>Add New User</div>

        {error && <div style={s.error}>{error}</div>}

        <label style={s.label}>Username</label>
        <input style={s.input} placeholder="e.g. ravi_agent" value={form.username}
          onChange={e => update('username', e.target.value)} />

        <label style={s.label}>Email</label>
        <input style={s.input} type="email" placeholder="e.g. ravi@alertinsurance.in" value={form.email}
          onChange={e => update('email', e.target.value)} />

        <label style={s.label}>Password</label>
        <input style={s.input} type="password" placeholder="Minimum 8 characters" value={form.password}
          onChange={e => update('password', e.target.value)} />

        <label style={s.label}>Role</label>
        <select style={s.input} value={form.role} onChange={e => update('role', e.target.value as any)}>
          <option value="chat_user">💬 Chat User — can only use the chat</option>
          <option value="super_admin">🔑 Super Admin — full control</option>
        </select>

        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#92400e', marginTop: 8 }}>
          {form.role === 'chat_user'
            ? 'Chat User: can start quote sessions on enabled insurers only. Cannot access admin or manage users.'
            : 'Super Admin: full access — can manage users, enable/disable insurers, and view all audit trails.'}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button style={{ ...s.btn, background: '#1a5276', flex: 1 }} onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create User'}
          </button>
          <button style={{ ...s.btn, background: '#888' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:       { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1a5276', color: '#fff', padding: '12px 20px', flexShrink: 0 },
  backBtn:     { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { fontWeight: 700, fontSize: 16 },
  badge:       { fontSize: 12, background: 'rgba(255,255,255,0.15)', padding: '4px 10px', borderRadius: 20 },
  createBtn:   { background: '#16a34a', border: 'none', borderRadius: 8, color: '#fff', padding: '7px 14px', cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  body:        { flex: 1, overflowY: 'auto', padding: '24px 28px' },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: '#1a5276', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 },
  count:       { background: '#e8f0f7', color: '#1a5276', borderRadius: 20, padding: '2px 8px', fontSize: 13, fontWeight: 600 },
  table:       { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' } as React.CSSProperties,
  th:          { background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#64748b' } as React.CSSProperties,
  td:          { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', fontSize: 13, verticalAlign: 'middle' } as React.CSSProperties,
  statusPill:  { display: 'inline-block', borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 600 },
  meBadge:     { background: '#dbeafe', color: '#1d4ed8', borderRadius: 20, padding: '1px 6px', fontSize: 11, marginLeft: 4 },
  actionBtn:   { background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, color: '#374151' },
  empty:       { color: '#888', fontSize: 14, padding: '16px 0' },
  error:       { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  modal:       { background: '#fff', borderRadius: 12, padding: '28px 24px', width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', gap: 4 },
  modalTitle:  { fontSize: 17, fontWeight: 700, color: '#1a5276', marginBottom: 12 },
  label:       { fontSize: 12, fontWeight: 600, color: '#555', marginTop: 8 },
  input:       { padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box' } as React.CSSProperties,
  btn:         { padding: '10px 16px', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
