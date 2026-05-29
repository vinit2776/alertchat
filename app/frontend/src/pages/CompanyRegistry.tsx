import { useState, useEffect } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

interface Company {
  id:              string;
  name:            string;
  insuranceTypes:  string[];
  playbookVersion: string;
  enabled:         boolean;
  lastTestedAt:    string | null;
  updatedAt:       string;
}

interface Props { token: string; onBack: () => void }

export default function CompanyRegistry({ token, onBack }: Props) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading]     = useState(true);
  const [testing, setTesting]     = useState<string | null>(null);
  const [toggling, setToggling]   = useState<string | null>(null);
  const [error, setError]         = useState('');

  async function loadCompanies() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setCompanies(data.companies);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadCompanies(); }, []);

  async function toggleEnabled(id: string, enabled: boolean) {
    setToggling(id);
    try {
      const res = await fetch(`${autoBase}/api/admin/companies/${id}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setCompanies(prev => prev.map(c => c.id === id ? { ...c, enabled } : c));
    } catch (err: any) { alert(err.message); }
    finally { setToggling(null); }
  }

  async function testCredentials(id: string) {
    setTesting(id);
    try {
      const res  = await fetch(`${autoBase}/api/admin/companies/${id}/test`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      alert(data.result || (data.success ? 'Test passed' : 'Test failed'));
      loadCompanies();
    } catch (err: any) { alert(err.message); }
    finally { setTesting(null); }
  }

  return (
    <div style={s.shell}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>Company Registry</div>
        <button style={s.refreshBtn} onClick={loadCompanies}>↺ Refresh</button>
      </div>

      <div style={s.body}>
        {error && <div style={s.error}>{error}</div>}

        {loading ? <div style={s.empty}>Loading…</div> : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Company', 'Types', 'Playbook', 'Last Tested', 'Enabled', 'Actions'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {companies.map(c => (
                <tr key={c.id} style={s.tr}>
                  <td style={s.td}>
                    <div style={{ fontWeight: 600, color: '#1a5276' }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{c.id}</div>
                  </td>
                  <td style={s.td}>{c.insuranceTypes.map(t => <span key={t} style={s.tag}>{t}</span>)}</td>
                  <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 12 }}>{c.playbookVersion}</td>
                  <td style={s.td}>
                    {c.lastTestedAt
                      ? <span style={{ color: '#16a34a', fontSize: 13 }}>✓ {new Date(c.lastTestedAt).toLocaleDateString('en-IN')}</span>
                      : <span style={{ color: '#888', fontSize: 13 }}>Never</span>}
                  </td>
                  <td style={s.td}>
                    <Toggle
                      checked={c.enabled}
                      loading={toggling === c.id}
                      onChange={v => toggleEnabled(c.id, v)}
                    />
                  </td>
                  <td style={s.td}>
                    <button style={s.testBtn} onClick={() => testCredentials(c.id)} disabled={testing === c.id}>
                      {testing === c.id ? '…' : 'Test Login'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Toggle({ checked, loading, onChange }: { checked: boolean; loading: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={loading}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
        background: checked ? '#16a34a' : '#d1d5db',
        position: 'relative', transition: 'background 0.2s',
        opacity: loading ? 0.6 : 1,
      }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 22 : 3,
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  shell:      { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:     { background: '#1a5276', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 },
  backBtn:    { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { fontWeight: 700, fontSize: 16, flex: 1 },
  refreshBtn: { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  body:       { flex: 1, overflowY: 'auto', padding: 20 },
  error:      { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', marginBottom: 16 },
  empty:      { textAlign: 'center', color: '#888', padding: '40px 0' },
  table:      { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
  th:         { padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#888', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  tr:         { borderBottom: '1px solid #f0f0f0' },
  td:         { padding: '12px 16px', fontSize: 14, verticalAlign: 'middle' },
  tag:        { display: 'inline-block', background: '#e8f0f7', color: '#1a5276', borderRadius: 4, padding: '2px 6px', fontSize: 11, marginRight: 4, fontWeight: 600 },
  testBtn:    { padding: '6px 12px', background: '#f0f4f8', border: '1px solid #ddd', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500 },
};
