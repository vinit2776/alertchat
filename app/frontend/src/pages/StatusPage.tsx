import { useState } from 'react';
import { chiApi } from '../api/chi';

function statusBadge(s: string) {
  if (!s) return <span className="badge badge-gray">Unknown</span>;
  if (s.toLowerCase().includes('active') || s.toLowerCase().includes('inforce'))
    return <span className="badge badge-green">{s}</span>;
  if (s.toLowerCase().includes('pending'))
    return <span className="badge badge-yellow">{s}</span>;
  if (s.toLowerCase().includes('cancel') || s.toLowerCase().includes('lapse'))
    return <span className="badge badge-red">{s}</span>;
  return <span className="badge badge-blue">{s}</span>;
}

export default function StatusPage() {
  const [proposalNum, setProposalNum] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const check = async () => {
    if (!proposalNum.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = await chiApi.getPolicyStatus(proposalNum.trim());
      setResult(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Status check failed');
    } finally { setLoading(false); }
  };

  const io = result?.data?.intGetPolicyStatusIO;

  return (
    <div>
      <div className="card">
        <div className="card-title">Get Policy Status</div>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Proposal Number</label>
            <input className="form-input" placeholder="e.g. 1120008703919" value={proposalNum} onChange={e => setProposalNum(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && check()} />
          </div>
          <button className="btn btn-primary" onClick={check} disabled={loading || !proposalNum.trim()}>
            {loading ? 'Checking…' : 'Check Status'}
          </button>
        </div>
        {error && <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
      </div>

      {io && (
        <div className="card">
          <div className="card-title">Policy Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 14 }}>
            {[
              ['Proposal #', io.proposalNum],
              ['Policy #', io.policyNum],
              ['Status', io.policyStatus ? statusBadge(io.policyStatus) : '—'],
              ['Premium', io.policyPremium ? `₹ ${io.policyPremium.toLocaleString('en-IN')}` : '—'],
              ['Commencement', io.policyCommencementDt || '—'],
              ['Maturity', io.policyMaturityDt || '—'],
              ['Application Date', io.applicationDate || '—'],
              ['Mobile', io.mobileNumber || '—'],
            ].map(([label, val]) => (
              <div key={String(label)} style={{ padding: '12px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                <div style={{ fontWeight: 600 }}>{val as React.ReactNode}</div>
              </div>
            ))}
          </div>

          {io.transactionId?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Transaction IDs</div>
              {io.transactionId.map((t: string) => (
                <span key={t} className="badge badge-gray" style={{ marginRight: 6 }}>{t}</span>
              ))}
            </div>
          )}

          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#64748b' }}>Raw JSON</summary>
            <pre className="response-box" style={{ marginTop: 10 }}>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
