import { useState, useEffect } from 'react';
import { chiApi } from '../api/chi';

export default function AuthStatus() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = async () => {
    try {
      const r = await chiApi.getAuthStatus();
      setStatus(r.data.data);
      setError('');
    } catch { setError('Could not reach backend. Is it running?'); }
  };

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await chiApi.refreshTokenPool();
      setStatus(r.data.data.pool);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Token refresh failed — check credentials in .env');
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchStatus(); }, []);

  return (
    <div>
      <div className="card">
        <div className="card-title">Auth — Token Pool Status</div>

        {error && <div className="alert alert-error">{error}</div>}

        {status && (
          <div className="token-bar">
            <div className={`token-dot${status.active ? ' active' : ''}`} />
            <span>{status.active ? 'Active session' : 'No active session'}</span>
            {status.active && <>
              <span className="badge badge-blue">{status.tokensRemaining} tokens left</span>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>Expires: {new Date(status.expiresAt).toLocaleTimeString()}</span>
            </>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh Token Pool'}
          </button>
          <button className="btn btn-secondary" onClick={fetchStatus}>Check Status</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">How Authentication Works</div>
        <div style={{ fontSize: 14, color: '#4a5568', lineHeight: 1.7 }}>
          <p>1. <strong>GeneratePartnerToken</strong> is called with your <code>partnerId</code> + <code>securityKey</code>.</p>
          <p style={{ marginTop: 8 }}>2. CHI returns a <strong>JWT sessionId</strong> and a pool of <strong>25 one-time tokens</strong> (keys 1–25).</p>
          <p style={{ marginTop: 8 }}>3. Every subsequent API call consumes one token from the pool. When the pool is empty, the token pool is automatically refreshed.</p>
          <p style={{ marginTop: 8 }}>4. Sessions expire after <strong>2 hours</strong>. This app auto-refreshes at 90 minutes.</p>
          <p style={{ marginTop: 8 }}>5. <strong>Care Enhance quotation</strong> uses a separate <code>api_key</code> / <code>auth_secret</code> flow.</p>
        </div>
      </div>
    </div>
  );
}
