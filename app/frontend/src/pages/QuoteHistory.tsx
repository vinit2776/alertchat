import { useState, useEffect } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

interface Quote {
  id:           string;
  portalName:   string;
  insType:      string;
  regNumber:    string | null;
  vehicleMake:  string | null;
  vehicleModel: string | null;
  premium:      number | null;
  idv:          number | null;
  createdAt:    string;
  expiresAt:    string;
}

interface Props { token: string; onBack: () => void }

export default function QuoteHistory({ token, onBack }: Props) {
  const [quotes, setQuotes]   = useState<Quote[]>([]);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  async function load(q?: string) {
    setLoading(true); setError('');
    try {
      const qs  = q ? `?search=${encodeURIComponent(q)}` : '';
      const res = await fetch(`${autoBase}/api/history${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setQuotes(data.quotes);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    load(search);
  }

  function daysLeft(expiresAt: string) {
    const diff = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
  }

  return (
    <div style={s.shell}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>Quote History</div>
        <div style={s.headerSub}>Last 7 days</div>
      </div>

      <div style={s.body}>
        <form onSubmit={handleSearch} style={s.searchBar}>
          <input
            style={s.searchInput}
            placeholder="Search by reg. number, vehicle, or insurer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button type="submit" style={s.searchBtn}>Search</button>
          {search && <button type="button" style={s.clearBtn} onClick={() => { setSearch(''); load(); }}>✕</button>}
        </form>

        {error && <div style={s.error}>{error}</div>}

        {loading ? (
          <div style={s.empty}>Loading…</div>
        ) : quotes.length === 0 ? (
          <div style={s.empty}>
            {search ? 'No results for your search.' : 'No quotes in the last 7 days. Start a new chat to get quotes.'}
          </div>
        ) : (
          <div style={s.list}>
            {quotes.map(q => (
              <div key={q.id} style={s.card}>
                <div style={s.cardTop}>
                  <div>
                    <div style={s.cardPortal}>{q.portalName}</div>
                    <div style={s.cardVehicle}>
                      {[q.vehicleMake, q.vehicleModel].filter(Boolean).join(' ') || q.insType}
                      {q.regNumber && <span style={s.reg}> · {q.regNumber}</span>}
                    </div>
                  </div>
                  <div style={s.cardRight}>
                    {q.premium != null && <div style={s.premium}>₹{q.premium.toLocaleString('en-IN')}</div>}
                    {q.idv      != null && <div style={s.idv}>IDV ₹{q.idv.toLocaleString('en-IN')}</div>}
                  </div>
                </div>
                <div style={s.cardMeta}>
                  <span>{new Date(q.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  <span style={{ color: daysLeft(q.expiresAt) <= 1 ? '#e74c3c' : '#888' }}>
                    Expires in {daysLeft(q.expiresAt)}d
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  shell:       { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:      { background: '#1a5276', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 },
  backBtn:     { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle: { fontWeight: 700, fontSize: 16, flex: 1 },
  headerSub:   { fontSize: 12, opacity: 0.8 },
  body:        { flex: 1, overflowY: 'auto', padding: '20px' },
  searchBar:   { display: 'flex', gap: 8, marginBottom: 16 },
  searchInput: { flex: 1, padding: '10px 14px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 14, outline: 'none' },
  searchBtn:   { padding: '10px 18px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  clearBtn:    { padding: '10px 12px', background: '#eee', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 },
  error:       { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 14 },
  empty:       { textAlign: 'center', color: '#888', padding: '40px 0', fontSize: 15 },
  list:        { display: 'flex', flexDirection: 'column', gap: 10 },
  card:        { background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
  cardTop:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  cardPortal:  { fontWeight: 600, fontSize: 14, color: '#1a5276' },
  cardVehicle: { fontSize: 13, color: '#555', marginTop: 2 },
  reg:         { fontFamily: 'monospace', color: '#1a5276' },
  cardRight:   { textAlign: 'right' },
  premium:     { fontWeight: 700, fontSize: 18, color: '#1a5276' },
  idv:         { fontSize: 12, color: '#888', marginTop: 2 },
  cardMeta:    { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#aaa', borderTop: '1px solid #f0f0f0', paddingTop: 8 },
};
