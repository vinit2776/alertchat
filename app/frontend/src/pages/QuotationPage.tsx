import { useState } from 'react';
import { chiApi } from '../api/chi';

const DEFAULT_FIELDS = {
  field_1: '2',
  field_10: '0',
  field_9: 'Floater',
  field_3: '36 to 40 Years',
  field_23: 'Enhance 2',
  field_11: 5,
  field_2: 45,
  field_4: '1 Year',
  outPutField: 'field_8',
  field_14: 1,
};

export default function QuotationPage() {
  const [fields, setFields] = useState(DEFAULT_FIELDS as Record<string, string | number>);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const update = (k: string, v: string) => {
    setFields(prev => ({ ...prev, [k]: isNaN(Number(v)) ? v : Number(v) }));
  };

  const submit = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = await chiApi.getQuotation(fields);
      setResult(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Quotation request failed');
    } finally { setLoading(false); }
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Care Enhance — Get Quotation</div>
        <div className="alert alert-info">
          This API uses a separate <code>api_key</code> / <code>auth_secret</code> / <code>abacusId</code> and is only available for <strong>Care Enhance</strong>.
        </div>

        <div className="form-row-3">
          {Object.entries(fields).map(([k, v]) => (
            <div className="form-group" key={k}>
              <label className="form-label">{k}</label>
              <input className="form-input" value={String(v)} onChange={e => update(k, e.target.value)} />
            </div>
          ))}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <button className="btn btn-primary" onClick={submit} disabled={loading}>
          {loading ? 'Getting Quote…' : 'Get Quotation'}
        </button>
      </div>

      {result && (
        <div className="card">
          <div className="card-title">Quotation Response</div>
          {result.data?.abacusData && (
            <div style={{ marginBottom: 16 }}>
              <span className="badge badge-green" style={{ marginRight: 8 }}>Success</span>
              <strong>{result.data.abacusData.title}</strong>
              {' — GST: '}{result.data.abacusData.serviceTax}%
            </div>
          )}
          <pre className="response-box">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
