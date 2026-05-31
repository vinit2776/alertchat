import { useState, useRef, useCallback } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

// ── Types ──────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4;

interface DocState {
  file:      File | null;
  status:    'idle' | 'uploading' | 'done' | 'error';
  docType:   string;
  fields:    Record<string, string>;
  message:   string;
}

interface ClaimsState {
  hasClaim:    boolean | null;
  claimCount:  string;
  totalAmount: string;
}

type Preference =
  | 'cheapest_premium' | 'private_insurer' | 'govt_insurer'
  | 'cashless_network' | 'higher_idv'
  | 'addon_zero_dep'   | 'addon_engine_protect'
  | 'addon_rsa'        | 'addon_personal_accident';

const PREFERENCE_OPTIONS: { key: Preference; label: string; icon: string }[] = [
  { key: 'cheapest_premium',        label: 'Lowest premium',                icon: '💰' },
  { key: 'private_insurer',         label: 'Private insurer (ICICI, HDFC…)', icon: '🏦' },
  { key: 'govt_insurer',            label: 'Government insurer (New India, United…)', icon: '🏛️' },
  { key: 'cashless_network',        label: 'Large cashless garage network',  icon: '🔑' },
  { key: 'higher_idv',              label: 'Higher IDV (better claim payout)', icon: '📈' },
  { key: 'addon_zero_dep',          label: 'Zero Depreciation cover',        icon: '🛡️' },
  { key: 'addon_engine_protect',    label: 'Engine Protection cover',        icon: '⚙️' },
  { key: 'addon_rsa',               label: 'Roadside Assistance (RSA)',      icon: '🚗' },
  { key: 'addon_personal_accident', label: 'Personal Accident cover',        icon: '🏥' },
];

// Display-friendly labels for extracted fields
const FIELD_LABELS: Record<string, string> = {
  registration_number:    'Registration No.',
  make:                   'Make',
  model:                  'Model',
  manufacturing_year:     'Year',
  fuel_type:              'Fuel Type',
  ncb_percentage:         'NCB %',
  previous_policy_expiry: 'Policy Expiry',
  owner_mobile:           'Mobile No.',
  owner_email:            'Email',
  owner_name:             'Owner Name',
};

const REQUIRED_MOTOR = [
  'registration_number', 'make', 'model', 'manufacturing_year',
  'fuel_type', 'ncb_percentage', 'previous_policy_expiry',
  'owner_mobile', 'owner_email',
];

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  token:     string;
  sessionId: string;
  insType:   string;
  onComplete: (confirmedFields: Record<string, string>, missing: string[]) => void;
  onBack:    () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function InsuranceWizard({ token, sessionId, insType, onComplete, onBack }: Props) {
  const [step, setStep]               = useState<Step>(1);
  const [claims, setClaims]           = useState<ClaimsState>({ hasClaim: null, claimCount: '1', totalAmount: '' });
  const [preferences, setPreferences] = useState<Preference[]>(['cheapest_premium']);
  const [manualFields, setManualFields] = useState<Record<string, string>>({});
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');

  const [rcFront, setRcFront]   = useState<DocState>(emptyDoc());
  const [rcBack, setRcBack]     = useState<DocState>(emptyDoc());
  const [policy, setPolicy]     = useState<DocState>(emptyDoc());

  const rcFrontRef = useRef<HTMLInputElement>(null);
  const rcBackRef  = useRef<HTMLInputElement>(null);
  const policyRef  = useRef<HTMLInputElement>(null);

  // All extracted fields merged from all uploaded docs
  const allExtracted: Record<string, string> = {
    ...rcFront.fields,
    ...rcBack.fields,
    ...policy.fields,
  };

  // NCB auto-set from claims
  const effectiveFields = { ...allExtracted, ...manualFields };
  if (claims.hasClaim === true)  effectiveFields.ncb_percentage = '0';
  if (claims.hasClaim === false && !effectiveFields.ncb_percentage) {
    // Leave blank — user fills in review
  }

  const required = insType === 'motor' ? REQUIRED_MOTOR : [];
  const missing  = required.filter(f => !effectiveFields[f]);

  // ── Upload a document ────────────────────────────────────────────────────

  const uploadDoc = useCallback(async (
    file: File,
    setter: React.Dispatch<React.SetStateAction<DocState>>,
  ) => {
    setter(prev => ({ ...prev, file, status: 'uploading', message: 'Reading document…' }));
    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(`${autoBase}/api/documents/upload/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setter({ file, status: 'done', docType: data.docType, fields: data.fields ?? {}, message: data.message });
    } catch (err: any) {
      setter(prev => ({ ...prev, status: 'error', message: err.message }));
    }
  }, [sessionId, token]);

  function togglePref(p: Preference) {
    setPreferences(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
  }

  // ── Submit wizard ─────────────────────────────────────────────────────────

  async function submit() {
    setSubmitting(true); setError('');
    try {
      const res  = await fetch(`${autoBase}/api/wizard/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claimsInfo: {
            hasClaim:    claims.hasClaim ?? false,
            claimCount:  claims.claimCount ? parseInt(claims.claimCount) : undefined,
            totalAmount: claims.totalAmount ? parseFloat(claims.totalAmount) : undefined,
          },
          preferences,
          manualFields,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      onComplete(data.confirmedFields, data.missing ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render steps ──────────────────────────────────────────────────────────

  return (
    <div style={s.shell}>
      {/* Header */}
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.headerTitle}>Motor Insurance Renewal Quote</div>
        <div style={s.headerSub}>Step {step} of 4</div>
      </div>

      {/* Step indicators */}
      <div style={s.steps}>
        {(['Documents', 'Claims', 'Preferences', 'Review'] as const).map((label, i) => {
          const n = (i + 1) as Step;
          const done = step > n;
          const active = step === n;
          return (
            <div key={n} style={s.stepItem}>
              <div style={{ ...s.stepDot, background: done ? '#16a34a' : active ? '#1a5276' : '#cbd5e1', color: '#fff', cursor: done ? 'pointer' : 'default' }}
                onClick={() => done && setStep(n)}>
                {done ? '✓' : n}
              </div>
              <div style={{ ...s.stepLabel, color: active ? '#1a5276' : done ? '#16a34a' : '#94a3b8', fontWeight: active ? 700 : 400 }}>
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div style={s.body}>

        {/* ── STEP 1: Documents ── */}
        {step === 1 && (
          <div style={s.card}>
            <div style={s.cardTitle}>📄 Upload Your Documents</div>
            <div style={s.cardSub}>We'll extract all vehicle details automatically. The more you upload, the fewer questions we ask.</div>

            <DocUploadRow
              label="RC — Front"
              hint="Registration Certificate (front side)"
              required
              state={rcFront}
              inputRef={rcFrontRef}
              onFile={f => uploadDoc(f, setRcFront)}
            />
            <DocUploadRow
              label="RC — Back"
              hint="Reverse side of RC"
              state={rcBack}
              inputRef={rcBackRef}
              onFile={f => uploadDoc(f, setRcBack)}
            />
            <DocUploadRow
              label="Expiring Policy Schedule"
              hint="Helps us get expiry date, NCB, and IDV"
              state={policy}
              inputRef={policyRef}
              onFile={f => uploadDoc(f, setPolicy)}
            />

            {/* Show summary of extracted fields */}
            {Object.keys(allExtracted).length > 0 && (
              <div style={s.extractedBox}>
                <div style={s.extractedTitle}>✅ Extracted so far</div>
                <div style={s.extractedGrid}>
                  {Object.entries(allExtracted).filter(([k]) => FIELD_LABELS[k]).map(([k, v]) => (
                    <div key={k} style={s.extractedRow}>
                      <span style={s.extractedKey}>{FIELD_LABELS[k] ?? k}</span>
                      <span style={s.extractedVal}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              style={{ ...s.nextBtn, opacity: rcFront.status === 'idle' ? 0.5 : 1 }}
              disabled={rcFront.status === 'idle'}
              onClick={() => setStep(2)}>
              Continue →
            </button>
            {rcFront.status === 'idle' && (
              <div style={s.hint}>RC front is required to continue</div>
            )}
          </div>
        )}

        {/* ── STEP 2: Claims ── */}
        {step === 2 && (
          <div style={s.card}>
            <div style={s.cardTitle}>🚗 Any claims in your expiring policy?</div>
            <div style={s.cardSub}>This determines your No Claim Bonus (NCB). A claim resets NCB to 0%.</div>

            <div style={s.claimOptions}>
              <button
                style={{ ...s.claimBtn, ...(claims.hasClaim === false ? s.claimBtnActive : {}) }}
                onClick={() => setClaims(p => ({ ...p, hasClaim: false }))}>
                <span style={{ fontSize: 24 }}>🎉</span>
                <strong>No claims</strong>
                <span style={{ fontSize: 12, color: '#666' }}>NCB will be applied</span>
              </button>
              <button
                style={{ ...s.claimBtn, ...(claims.hasClaim === true ? s.claimBtnActive : {}) }}
                onClick={() => setClaims(p => ({ ...p, hasClaim: true }))}>
                <span style={{ fontSize: 24 }}>📋</span>
                <strong>Yes, I made a claim</strong>
                <span style={{ fontSize: 12, color: '#666' }}>NCB resets to 0%</span>
              </button>
            </div>

            {claims.hasClaim === true && (
              <div style={s.claimDetails}>
                <div style={s.claimRow}>
                  <label style={s.claimLabel}>Number of claims</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['1', '2', '3+'].map(n => (
                      <button key={n}
                        style={{ ...s.countBtn, ...(claims.claimCount === n ? s.countBtnActive : {}) }}
                        onClick={() => setClaims(p => ({ ...p, claimCount: n }))}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={s.claimRow}>
                  <label style={s.claimLabel}>Total claim amount (₹)</label>
                  <input
                    style={s.claimInput}
                    type="number"
                    placeholder="e.g. 85000"
                    value={claims.totalAmount}
                    onChange={e => setClaims(p => ({ ...p, totalAmount: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {claims.hasClaim === false && (
              <div style={s.ncbInfo}>
                <span style={{ fontSize: 18 }}>✅</span>
                <span>NCB from your previous policy will be verified and applied. If NCB % is not on your policy document, you can enter it in the next step.</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
              <button style={s.backStepBtn} onClick={() => setStep(1)}>← Back</button>
              <button
                style={{ ...s.nextBtn, flex: 1, opacity: claims.hasClaim === null ? 0.5 : 1 }}
                disabled={claims.hasClaim === null}
                onClick={() => setStep(3)}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Preferences ── */}
        {step === 3 && (
          <div style={s.card}>
            <div style={s.cardTitle}>⭐ Your Preferences</div>
            <div style={s.cardSub}>Select what matters most. We'll prioritise these when comparing quotes.</div>

            <div style={s.prefGrid}>
              {PREFERENCE_OPTIONS.map(p => {
                const active = preferences.includes(p.key);
                return (
                  <button key={p.key}
                    style={{ ...s.prefBtn, ...(active ? s.prefBtnActive : {}) }}
                    onClick={() => togglePref(p.key)}>
                    <span style={{ fontSize: 20 }}>{p.icon}</span>
                    <span style={{ fontSize: 13, lineHeight: 1.3 }}>{p.label}</span>
                    {active && <span style={s.prefCheck}>✓</span>}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
              <button style={s.backStepBtn} onClick={() => setStep(2)}>← Back</button>
              <button style={{ ...s.nextBtn, flex: 1 }} onClick={() => setStep(4)}>
                Review Details →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Review ── */}
        {step === 4 && (
          <div style={s.card}>
            <div style={s.cardTitle}>🔍 Review Your Details</div>
            <div style={s.cardSub}>Check everything is correct. Edit any field by clicking it.</div>

            {/* Extracted + editable fields */}
            <div style={s.reviewGrid}>
              {REQUIRED_MOTOR.map(field => {
                const val = effectiveFields[field] ?? '';
                const isManual = manualFields[field] !== undefined;
                const isMissing = !val;
                return (
                  <div key={field} style={{ ...s.reviewRow, ...(isMissing ? s.reviewRowMissing : {}) }}>
                    <div style={s.reviewLabel}>
                      {isMissing && <span style={{ color: '#dc2626' }}>* </span>}
                      {FIELD_LABELS[field] ?? field}
                      {field === 'ncb_percentage' && claims.hasClaim === true && (
                        <span style={s.autoTag}> auto (claim)</span>
                      )}
                    </div>
                    <input
                      style={{ ...s.reviewInput, ...(isMissing ? s.reviewInputMissing : {}), ...(isManual ? s.reviewInputManual : {}) }}
                      value={isManual ? manualFields[field] : val}
                      placeholder={isMissing ? 'Required — please enter' : ''}
                      readOnly={field === 'ncb_percentage' && claims.hasClaim === true}
                      onChange={e => setManualFields(prev => ({ ...prev, [field]: e.target.value }))}
                    />
                  </div>
                );
              })}
            </div>

            {/* Preference summary */}
            {preferences.length > 0 && (
              <div style={s.prefSummary}>
                <span style={s.prefSummaryTitle}>Your preferences: </span>
                {preferences.map(p => {
                  const opt = PREFERENCE_OPTIONS.find(o => o.key === p);
                  return opt ? <span key={p} style={s.prefTag}>{opt.icon} {opt.label}</span> : null;
                })}
              </div>
            )}

            {error && <div style={s.error}>{error}</div>}

            {missing.filter(f => !manualFields[f]).length > 0 && (
              <div style={s.missingWarning}>
                ⚠️ Please fill in the highlighted fields before getting quotes.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button style={s.backStepBtn} onClick={() => setStep(3)}>← Back</button>
              <button
                style={{ ...s.quoteBtn, opacity: (submitting || missing.filter(f => !manualFields[f]).length > 0) ? 0.6 : 1 }}
                disabled={submitting || missing.filter(f => !manualFields[f]).length > 0}
                onClick={submit}>
                {submitting ? '⏳ Preparing…' : '🚀 Get Quotes Now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Doc upload row component ───────────────────────────────────────────────

function DocUploadRow({ label, hint, required, state, inputRef, onFile }: {
  label:    string;
  hint:     string;
  required?: boolean;
  state:    DocState;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFile:   (f: File) => void;
}) {
  return (
    <div style={dr.row}>
      <div style={dr.meta}>
        <div style={dr.label}>
          {label}
          {required && <span style={{ color: '#dc2626' }}> *</span>}
        </div>
        <div style={dr.hint}>{hint}</div>
      </div>

      <div style={dr.right}>
        {state.status === 'idle' && (
          <>
            <label style={dr.uploadBtn}>
              📷 Upload
              <input ref={inputRef} type="file" accept="image/*,image/heic,application/pdf"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            </label>
          </>
        )}
        {state.status === 'uploading' && <span style={dr.status}>⏳ Reading…</span>}
        {state.status === 'done' && (
          <div style={dr.done}>
            <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ {state.docType}</span>
            <span style={{ fontSize: 11, color: '#555' }}>{Object.keys(state.fields).length} fields extracted</span>
            <button style={dr.reupload} onClick={() => inputRef.current?.click()}>
              Replace
              <input ref={inputRef} type="file" accept="image/*,image/heic,application/pdf"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            </button>
          </div>
        )}
        {state.status === 'error' && (
          <div style={dr.done}>
            <span style={{ color: '#dc2626' }}>❌ {state.message}</span>
            <button style={dr.reupload} onClick={() => inputRef.current?.click()}>
              Retry
              <input ref={inputRef} type="file" accept="image/*,image/heic,application/pdf"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyDoc(): DocState {
  return { file: null, status: 'idle', docType: '', fields: {}, message: '' };
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:      { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1a5276', color: '#fff', padding: '12px 20px', flexShrink: 0 },
  backBtn:    { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 14 },
  headerTitle:{ fontWeight: 700, fontSize: 16 },
  headerSub:  { fontSize: 12, opacity: 0.75 },
  steps:      { display: 'flex', justifyContent: 'center', gap: 32, padding: '16px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 },
  stepItem:   { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  stepDot:    { width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 },
  stepLabel:  { fontSize: 11 },
  body:       { flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  card:       { background: '#fff', borderRadius: 14, padding: '24px', width: '100%', maxWidth: 560, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' },
  cardTitle:  { fontSize: 18, fontWeight: 700, color: '#1a5276', marginBottom: 6 },
  cardSub:    { fontSize: 13, color: '#64748b', marginBottom: 20, lineHeight: 1.5 },
  nextBtn:    { background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, padding: '12px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer', width: '100%', marginTop: 8 },
  backStepBtn:{ background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, padding: '12px 18px', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  quoteBtn:   { flex: 1, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '14px 24px', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  hint:       { fontSize: 12, color: '#94a3b8', textAlign: 'center' as const, marginTop: 8 },
  extractedBox:  { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '12px', marginBottom: 16 },
  extractedTitle:{ fontSize: 12, fontWeight: 600, color: '#16a34a', marginBottom: 8 },
  extractedGrid: { display: 'flex', flexDirection: 'column', gap: 4 },
  extractedRow:  { display: 'flex', justifyContent: 'space-between' },
  extractedKey:  { fontSize: 12, color: '#555' },
  extractedVal:  { fontSize: 12, fontWeight: 600, color: '#1a5276' },
  claimOptions:  { display: 'flex', gap: 12, marginBottom: 16 },
  claimBtn:      { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '16px 12px', border: '2px solid #e2e8f0', borderRadius: 12, background: '#f8fafc', cursor: 'pointer' },
  claimBtnActive:{ borderColor: '#1a5276', background: '#e8f0f7' },
  claimDetails:  { background: '#f8fafc', borderRadius: 10, padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 },
  claimRow:      { display: 'flex', flexDirection: 'column', gap: 6 },
  claimLabel:    { fontSize: 13, fontWeight: 600, color: '#444' },
  claimInput:    { padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 14 },
  countBtn:      { padding: '8px 16px', border: '1.5px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500 },
  countBtnActive:{ borderColor: '#1a5276', background: '#e8f0f7', color: '#1a5276', fontWeight: 700 },
  ncbInfo:       { display: 'flex', gap: 10, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px', fontSize: 13, color: '#166534', alignItems: 'flex-start', lineHeight: 1.5 },
  prefGrid:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  prefBtn:       { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '12px 8px', border: '1.5px solid #e2e8f0', borderRadius: 10, background: '#f8fafc', cursor: 'pointer', textAlign: 'center' as const, position: 'relative' as const },
  prefBtnActive: { borderColor: '#1a5276', background: '#e8f0f7' },
  prefCheck:     { position: 'absolute' as const, top: 6, right: 8, color: '#1a5276', fontSize: 14, fontWeight: 700 },
  reviewGrid:    { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  reviewRow:     { display: 'flex', alignItems: 'center', gap: 8 },
  reviewRowMissing:  { background: '#fef2f2', borderRadius: 8, padding: '4px 8px', margin: '0 -8px' },
  reviewLabel:   { fontSize: 12, fontWeight: 600, color: '#555', width: 130, flexShrink: 0 },
  reviewInput:   { flex: 1, padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, background: '#f8fafc' },
  reviewInputMissing:{ borderColor: '#fca5a5', background: '#fff' },
  reviewInputManual: { borderColor: '#1a5276', background: '#e8f0f7' },
  autoTag:       { fontSize: 10, background: '#dbeafe', color: '#1d4ed8', borderRadius: 4, padding: '1px 5px', marginLeft: 4 },
  prefSummary:   { background: '#f0f4f8', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.8, marginBottom: 8 },
  prefSummaryTitle: { fontWeight: 600, color: '#1a5276', marginRight: 6 },
  prefTag:       { display: 'inline-block', background: '#e8f0f7', borderRadius: 20, padding: '2px 8px', margin: '2px 3px', color: '#1a5276', fontWeight: 500 },
  missingWarning:{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#92400e', marginBottom: 8 },
  error:         { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#dc2626', marginBottom: 8 },
};

const dr: Record<string, React.CSSProperties> = {
  row:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f1f5f9' },
  meta:      { flex: 1 },
  label:     { fontSize: 14, fontWeight: 600, color: '#1a5276', marginBottom: 2 },
  hint:      { fontSize: 12, color: '#888' },
  right:     { flexShrink: 0, marginLeft: 12 },
  uploadBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, background: '#e8f0f7', border: '1.5px solid #1a5276', borderRadius: 8, color: '#1a5276', fontWeight: 600, fontSize: 13, padding: '7px 14px', cursor: 'pointer' },
  status:    { fontSize: 13, color: '#888' },
  done:      { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  reupload:  { fontSize: 11, color: '#888', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' },
};
