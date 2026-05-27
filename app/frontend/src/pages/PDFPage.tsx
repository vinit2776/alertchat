import { useState } from 'react';
import { chiApi } from '../api/chi';

export default function PDFPage() {
  const [policyNum, setPolicyNum] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetch = async () => {
    if (!policyNum.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = await chiApi.getPolicyPDF(policyNum.trim());
      setResult(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'PDF fetch failed');
    } finally { setLoading(false); }
  };

  const downloadPDF = () => {
    const b64 = result?.data?.intFaveoGetPolicyPDFIO?.pdfBase64;
    if (!b64) return;
    const link = document.createElement('a');
    link.href = `data:application/pdf;base64,${b64}`;
    link.download = `policy-${policyNum}.pdf`;
    link.click();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Get Policy PDF</div>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Policy Number</label>
            <input className="form-input" placeholder="e.g. 13092104" value={policyNum} onChange={e => setPolicyNum(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetch()} />
          </div>
          <button className="btn btn-primary" onClick={fetch} disabled={loading || !policyNum.trim()}>
            {loading ? 'Fetching…' : 'Get PDF'}
          </button>
        </div>
        {error && <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
      </div>

      {result && (
        <div className="card">
          <div className="card-title">Policy PDF</div>
          {result?.data?.intFaveoGetPolicyPDFIO?.pdfBase64 ? (
            <div>
              <div className="alert alert-success">PDF retrieved successfully.</div>
              <button className="btn btn-success" onClick={downloadPDF}>⬇ Download Policy Schedule</button>
              <div style={{ marginTop: 16 }}>
                <iframe
                  src={`data:application/pdf;base64,${result.data.intFaveoGetPolicyPDFIO.pdfBase64}`}
                  style={{ width: '100%', height: 600, borderRadius: 8, border: '1px solid #e2e8f0' }}
                  title="Policy PDF"
                />
              </div>
            </div>
          ) : result?.data?.intFaveoGetPolicyPDFIO?.pdfUrl ? (
            <div>
              <div className="alert alert-success">PDF URL available.</div>
              <a href={result.data.intFaveoGetPolicyPDFIO.pdfUrl} target="_blank" rel="noreferrer"
                className="btn btn-success">Open PDF</a>
            </div>
          ) : (
            <pre className="response-box">{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
