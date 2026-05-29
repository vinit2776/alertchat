import { useState, useRef, useEffect, useCallback } from 'react';
import type { KeyboardEvent, DragEvent } from 'react';

const autoBase = (import.meta as any).env.VITE_AUTOMATION_URL || 'http://localhost:4001';

type InsuranceType = 'motor' | 'health' | 'property' | 'travel';

interface Company { id: string; name: string; logoUrl: string }

interface Message {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts:   number;
}

interface ConfirmedFields { [key: string]: string }

interface Props {
  token: string;
  onLogout: () => void;
  onShowHistory: () => void;
  onShowAdmin?: () => void;
  isAdmin: boolean;
}

const INS_LABELS: Record<InsuranceType, string> = {
  motor:    '🚗 Motor',
  health:   '🏥 Health',
  property: '🏠 Property',
  travel:   '✈️ Travel',
};

export default function PortalChatPage({ token, onLogout, onShowHistory, onShowAdmin, isAdmin }: Props) {
  const [phase, setPhase]               = useState<'setup' | 'uploading' | 'chat'>('setup');
  const [insType, setInsType]           = useState<InsuranceType>('motor');
  const [companies, setCompanies]       = useState<Company[]>([]);
  const [selectedIds, setSelectedIds]   = useState<string[]>([]);
  const [sessionId, setSessionId]       = useState<string | null>(null);
  const [pendingWelcome, setPendingWelcome] = useState<string>('');
  const [messages, setMessages]         = useState<Message[]>([]);
  const [input, setInput]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [uploadDone, setUploadDone]     = useState(false);
  const [dragOver, setDragOver]         = useState(false);
  const [confirmedFields, setConfirmedFields] = useState<ConfirmedFields | null>(null);
  const [quoteRunning, setQuoteRunning]         = useState(false);
  const [quoteResults, setQuoteResults]         = useState<any[] | null>(null);
  const [captchaState, setCaptchaState]         = useState<{ portalId: string; imageBase64: string; captchaToken: string } | null>(null);
  const [captchaInput, setCaptchaInput]         = useState('');
  const bottomRef     = useRef<HTMLDivElement>(null);
  const fileRef       = useRef<HTMLInputElement>(null);
  const progressRef   = useRef<EventSource | null>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  // Close any open SSE stream on unmount
  useEffect(() => () => { progressRef.current?.close(); }, []);

  async function loadCompanies(type: InsuranceType) {
    try {
      const res  = await apiGet(`/api/admin/companies`);
      const all: Company[] = (res.companies || [])
        .filter((c: any) => c.enabled && c.insuranceTypes.includes(type));
      setCompanies(all);
      setSelectedIds(all.map((c: Company) => c.id));
    } catch {
      setCompanies([]);
    }
  }

  useEffect(() => { loadCompanies(insType); }, [insType]);

  function toggleCompany(id: string) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function startSession() {
    if (!selectedIds.length) return;
    setLoading(true);
    try {
      const data = await apiPost('/api/chat/session', { insuranceType: insType, selectedCompanyIds: selectedIds });
      setSessionId(data.sessionId);
      if (insType === 'motor') {
        // RC upload is mandatory for motor — go to upload screen first.
        // Store the welcome so we can show it once upload is done.
        setPendingWelcome(data.welcome);
        setPhase('uploading');
      } else {
        setMessages([{ role: 'assistant', text: data.welcome, ts: Date.now() }]);
        setPhase('chat');
      }
    } catch (err: any) {
      alert(`Failed to start session: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading || !sessionId) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text, ts: Date.now() }]);
    setLoading(true);
    try {
      const data = await apiPost(`/api/chat/${sessionId}/message`, { message: text });
      setMessages(prev => [...prev, { role: 'assistant', text: data.message, ts: Date.now() }]);
      if (data.fieldsReady && data.confirmedFields) {
        setConfirmedFields(data.confirmedFields);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'system', text: `Error: ${err.message}`, ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }

  const uploadFile = useCallback(async (file: File) => {
    if (!sessionId) return;
    setUploading(true);

    // In the uploading phase we haven't entered chat yet — show nothing in messages yet
    if (phase !== 'uploading') {
      setMessages(prev => [...prev, { role: 'system', text: `Uploading ${file.name}…`, ts: Date.now() }]);
    }

    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(`${autoBase}/api/documents/upload/${sessionId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      // Prompt Claude to continue after OCR
      const follow = await apiPost(`/api/chat/${sessionId}/message`, {
        message: `I uploaded the ${data.docType}. What else do you need?`,
      });

      if (phase === 'uploading') {
        // First RC upload — transition to chat with all messages in order:
        // 1. Advisor welcome  2. OCR summary  3. Claude's first question
        setMessages([
          { role: 'assistant', text: pendingWelcome,  ts: Date.now() - 2 },
          { role: 'assistant', text: data.message,    ts: Date.now() - 1 },
          { role: 'assistant', text: follow.message,  ts: Date.now() },
        ]);
        setUploadDone(true);
        setPhase('chat');
      } else {
        setMessages(prev => [...prev,
          { role: 'assistant', text: data.message,   ts: Date.now() },
          { role: 'assistant', text: follow.message, ts: Date.now() + 1 },
        ]);
      }
    } catch (err: any) {
      if (phase === 'uploading') {
        // Stay on upload screen but show the error
        alert(`Upload failed: ${err.message}`);
      } else {
        setMessages(prev => [...prev, { role: 'system', text: `Upload failed: ${err.message}`, ts: Date.now() }]);
      }
    } finally {
      setUploading(false);
    }
  }, [sessionId, token, phase, pendingWelcome]);

  function handleFileDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function runQuotes() {
    if (!sessionId || quoteRunning) return;
    setQuoteRunning(true);
    setQuoteResults(null);
    setCaptchaState(null);

    // ── Open SSE progress stream BEFORE the POST so we catch every event ──
    const sseUrl = `${autoBase}/api/quotes/${sessionId}/progress?token=${encodeURIComponent(token)}`;
    const sse = new EventSource(sseUrl);
    progressRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as { type: string; message?: string; portalName?: string };
        if (!event.message) return;  // ignore 'connected' and 'ping'
        setMessages(prev => [...prev, {
          role:  'assistant' as const,
          text:  event.message!,
          ts:    Date.now(),
        }]);
      } catch { /* ignore parse errors */ }
    };

    sse.onerror = () => { sse.close(); progressRef.current = null; };

    try {
      const res  = await fetch(`${autoBase}/api/quotes/${sessionId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message ?? 'Quote request failed');
      const results: any[] = data.results ?? [];
      // Check if any result requires captcha
      const captchaResult = results.find((r: any) => r.captchaRequired);
      if (captchaResult) {
        setCaptchaState({
          portalId:        captchaResult.portalId,
          imageBase64:     captchaResult.captchaImageBase64,
          captchaToken:    captchaResult.captchaToken ?? '',
        });
      }
      setQuoteResults(results);
    } catch (err: any) {
      setQuoteResults([{ success: false, errorMessage: err.message, portalId: 'unknown', portalName: 'Error' }]);
    } finally {
      setQuoteRunning(false);
      // POST completed — close the SSE stream
      sse.close();
      progressRef.current = null;
    }
  }

  async function submitCaptcha() {
    if (!sessionId || !captchaState || !captchaInput.trim()) return;
    setQuoteRunning(true);
    try {
      const res  = await fetch(`${autoBase}/api/quotes/${sessionId}/captcha`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalId: captchaState.portalId, captchaToken: captchaState.captchaToken, captchaText: captchaInput.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message ?? 'Captcha submission failed');
      setQuoteResults(prev => {
        const updated = (prev ?? []).map((r: any) =>
          r.portalId === captchaState.portalId ? (data.result ?? r) : r
        );
        return updated;
      });
      setCaptchaState(null);
      setCaptchaInput('');
    } catch (err: any) {
      alert(`Captcha error: ${err.message}`);
    } finally {
      setQuoteRunning(false);
    }
  }

  function reset() {
    progressRef.current?.close();
    progressRef.current = null;
    setPhase('setup'); setSessionId(null); setMessages([]);
    setPendingWelcome(''); setUploadDone(false);
    setConfirmedFields(null); setQuoteResults(null); setCaptchaState(null);
    setCaptchaInput(''); setInput('');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function apiGet(path: string) {
    const res = await fetch(`${autoBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onLogout(); throw new Error('Unauthorized'); }
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    return data;
  }

  async function apiPost(path: string, body: object) {
    const res = await fetch(`${autoBase}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { onLogout(); throw new Error('Unauthorized'); }
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    return data;
  }

  // ── Setup Phase ────────────────────────────────────────────────────────────

  if (phase === 'setup') {
    return (
      <div style={s.shell}>
        <Header title="New Quote" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} />
        <div style={s.setupBody}>
          <div style={s.setupCard}>
            <div style={s.setupTitle}>Get Insurance Quotes</div>
            <div style={s.setupSub}>Select type and insurers</div>

            <label style={s.label}>Insurance Type</label>
            <div style={s.typeGrid}>
              {(Object.keys(INS_LABELS) as InsuranceType[]).map(t => (
                <button key={t} style={{ ...s.typeBtn, ...(insType === t ? s.typeBtnActive : {}) }}
                  onClick={() => setInsType(t)}>
                  {INS_LABELS[t]}
                </button>
              ))}
            </div>

            <label style={s.label}>
              Insurance Companies
              {companies.length === 0 && <span style={{ color: '#e74c3c', fontWeight: 400, marginLeft: 8 }}>None enabled — admin must enable companies first</span>}
            </label>
            <div style={s.companyList}>
              {companies.map(c => (
                <label key={c.id} style={s.companyItem}>
                  <input type="checkbox" checked={selectedIds.includes(c.id)}
                    onChange={() => toggleCompany(c.id)} style={{ marginRight: 8 }} />
                  {c.name}
                </label>
              ))}
              {companies.length === 0 && (
                <div style={{ color: '#888', fontSize: 13, padding: '8px 0' }}>
                  No {insType} insurers enabled yet.
                  {isAdmin && <span> Go to <strong>Admin → Companies</strong> to enable them.</span>}
                </div>
              )}
            </div>

            <button style={{ ...s.startBtn, opacity: selectedIds.length && !loading ? 1 : 0.5 }}
              onClick={startSession} disabled={!selectedIds.length || loading}>
              {loading ? 'Starting…' : `Start Quote (${selectedIds.length} insurer${selectedIds.length !== 1 ? 's' : ''})`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Uploading Phase (motor only — RC required before chat) ────────────────

  if (phase === 'uploading') {
    return (
      <div style={s.shell}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}>

        <Header title="Upload RC" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} />

        {dragOver && (
          <div style={s.dropOverlay}>
            <div style={s.dropBox}>📄 Drop RC to upload</div>
          </div>
        )}

        <div style={s.uploadScreen}>
          <div style={s.uploadCard}>
            <div style={s.uploadIcon}>📄</div>
            <div style={s.uploadTitle}>Upload Vehicle RC</div>
            <div style={s.uploadSub}>
              This is required to auto-fill vehicle details and reduce the number of questions.
              A clear photo or scan of your Registration Certificate is all you need.
            </div>

            {uploading ? (
              <div style={s.uploadSpinner}>
                <TypingDots />
                <span style={{ marginLeft: 10, color: '#555' }}>Reading RC details…</span>
              </div>
            ) : (
              <>
                <label htmlFor="rc-upload-main" style={s.uploadZone}>
                  <span style={{ fontSize: 32 }}>📷</span>
                  <span style={{ marginTop: 8, fontWeight: 600, color: '#1a5276' }}>Tap to choose RC photo</span>
                  <span style={{ fontSize: 12, color: '#888', marginTop: 4 }}>JPG, PNG, HEIC or PDF · or drag & drop</span>
                </label>
                <input id="rc-upload-main" type="file" accept="image/*,image/heic,application/pdf"
                  style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Chat Phase ─────────────────────────────────────────────────────────────

  return (
    <div style={s.shell}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleFileDrop}>

      <Header title="Quote Chat" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} />

      {dragOver && (
        <div style={s.dropOverlay}>
          <div style={s.dropBox}>📄 Drop document to upload</div>
        </div>
      )}

      <div style={s.feed}>
        {messages.map((msg, i) => (
          <div key={i} style={{ ...s.row, justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {msg.role !== 'user' && <div style={s.avatar}>{msg.role === 'system' ? 'ℹ️' : '🤖'}</div>}
            <div style={msg.role === 'user' ? s.bubbleUser : msg.role === 'system' ? s.bubbleSystem : s.bubbleBot}>
              {msg.text.split('\n').map((line, j, arr) => (
                <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
              ))}
            </div>
          </div>
        ))}

        {(loading || uploading) && (
          <div style={{ ...s.row, justifyContent: 'flex-start' }}>
            <div style={s.avatar}>🤖</div>
            <div style={s.bubbleBot}><TypingDots /></div>
          </div>
        )}

        {confirmedFields && (
          <ConfirmationCard
            fields={confirmedFields}
            onRunQuotes={runQuotes}
            running={quoteRunning}
            done={!!quoteResults}
          />
        )}
        {quoteRunning && !messages.some(m => m.role === 'assistant' && (m.text.startsWith('✓') || m.text.startsWith('→'))) && (
          <div style={{ ...s.row, justifyContent: 'flex-start' }}>
            <div style={s.avatar}>🤖</div>
            <div style={s.bubbleBot}><TypingDots /> Connecting to portal…</div>
          </div>
        )}
        {quoteResults && quoteResults.map((r: any, i: number) => (
          <QuoteResultCard key={i} result={r} />
        ))}
        {captchaState && (
          <CaptchaChallenge
            imageBase64={captchaState.imageBase64}
            value={captchaInput}
            onChange={setCaptchaInput}
            onSubmit={submitCaptcha}
            loading={quoteRunning}
          />
        )}
        <div ref={bottomRef} />
      </div>

      <div style={s.inputBar}>
        <label htmlFor="doc-upload" style={{ ...s.uploadBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          title="Upload RC, PAN, Aadhaar or policy document">
          📎
        </label>
        <input id="doc-upload" ref={fileRef} type="file" accept="image/*,image/heic,application/pdf"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />

        <textarea style={s.textarea} rows={1} placeholder="Type a message or drag & drop a document…"
          value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
          disabled={loading || uploading} />

        <button style={{ ...s.sendBtn, opacity: loading || uploading || !input.trim() ? 0.5 : 1 }}
          onClick={send} disabled={loading || uploading || !input.trim()}>➤</button>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Header({ title, onLogout, onReset, onHistory, onAdmin, showAdmin }: {
  title: string; onLogout: () => void; onReset: () => void; onHistory: () => void; onAdmin?: () => void; showAdmin: boolean;
}) {
  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        <span style={s.headerIcon}>🚗</span>
        <div>
          <div style={s.headerTitle}>Alert Insurance</div>
          <div style={s.headerSub}>{title}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={s.iconBtn} onClick={onHistory} title="Quote history">📋</button>
        {showAdmin && <button style={s.iconBtn} onClick={onAdmin} title="Admin">⚙️</button>}
        <button style={s.iconBtn} onClick={onReset}   title="New quote">↺</button>
        <button style={s.iconBtn} onClick={onLogout}  title="Logout">⎋</button>
      </div>
    </div>
  );
}

function ConfirmationCard({ fields, onRunQuotes, running, done }: {
  fields: ConfirmedFields;
  onRunQuotes: () => void;
  running: boolean;
  done: boolean;
}) {
  // Skip internal computed/auto fields from display
  const displayEntries = Object.entries(fields).filter(([k]) =>
    !['idv_auto_computed', 'business_type', 'vehicle_type_code', 'cc_band',
      'vehicle_zone', 'risk_start_date', 'is_electric'].includes(k)
  );
  return (
    <div style={cf.card}>
      <div style={cf.header}>✅ All details collected — ready to get quotes</div>
      <div style={cf.body}>
        {displayEntries.map(([k, v]) => (
          <div key={k} style={cf.row}>
            <span style={cf.key}>{k.replace(/_/g, ' ')}</span>
            <span style={cf.val}>{v}</span>
          </div>
        ))}
      </div>
      {!done && (
        <div style={{ padding: '12px 16px' }}>
          <button
            style={{ ...cf.runBtn, opacity: running ? 0.6 : 1, cursor: running ? 'default' : 'pointer' }}
            onClick={onRunQuotes}
            disabled={running}
          >
            {running ? '⏳ Fetching quotes…' : '🚀 Get Quotes Now'}
          </button>
        </div>
      )}
    </div>
  );
}

function QuoteResultCard({ result }: { result: any }) {
  const success = result.success;
  return (
    <div style={qr.card}>
      <div style={{ ...qr.header, background: success ? '#15803d' : '#dc2626' }}>
        {success ? '✅' : '❌'} {result.portalName ?? result.portalId}
        {result.durationMs > 0 && <span style={qr.duration}>{(result.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      <div style={qr.body}>
        {success ? (
          <>
            {result.premium != null && (
              <div style={qr.highlight}>
                <span style={qr.label}>Premium</span>
                <span style={qr.bigValue}>₹{Number(result.premium).toLocaleString('en-IN')}</span>
              </div>
            )}
            {result.idv != null && (
              <div style={qr.row}>
                <span style={qr.label}>IDV</span>
                <span style={qr.value}>₹{Number(result.idv).toLocaleString('en-IN')}</span>
              </div>
            )}
            {result.rawData && Object.keys(result.rawData).length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>Full details</summary>
                <pre style={{ fontSize: 11, marginTop: 4, color: '#555', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(result.rawData, null, 2)}
                </pre>
              </details>
            )}
          </>
        ) : (
          <div style={qr.error}>{result.errorMessage ?? 'Quote generation failed'}</div>
        )}
      </div>
    </div>
  );
}

function CaptchaChallenge({ imageBase64, value, onChange, onSubmit, loading }: {
  imageBase64: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <div style={cap.card}>
      <div style={cap.header}>🔐 Captcha Required — Please enter the text shown below</div>
      <div style={cap.body}>
        <img src={`data:image/png;base64,${imageBase64}`} alt="captcha" style={cap.img} />
        <input
          style={cap.input}
          placeholder="Type captcha text…"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          disabled={loading}
          autoFocus
        />
        <button style={{ ...cap.btn, opacity: loading ? 0.6 : 1 }} onClick={onSubmit} disabled={loading}>
          {loading ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%', background: '#1a5276',
          animation: `bounce 1.2s ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}`}</style>
    </span>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:     { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif', position: 'relative' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1a5276', color: '#fff', padding: '12px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon: { fontSize: 26 },
  headerTitle: { fontWeight: 700, fontSize: 16 },
  headerSub:   { fontSize: 12, opacity: 0.8 },
  iconBtn:   { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 16, padding: '6px 10px', cursor: 'pointer' },
  setupBody: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto' },
  setupCard: { background: '#fff', borderRadius: 16, padding: '32px 28px', width: '100%', maxWidth: 480, boxShadow: '0 4px 24px rgba(0,0,0,0.1)' },
  setupTitle: { fontSize: 20, fontWeight: 700, color: '#1a5276', marginBottom: 4 },
  setupSub:   { fontSize: 13, color: '#888', marginBottom: 24 },
  label:     { display: 'block', fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 8 },
  typeGrid:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 },
  typeBtn:   { padding: '10px 8px', border: '1.5px solid #ddd', borderRadius: 8, background: '#f9f9f9', cursor: 'pointer', fontSize: 14, fontWeight: 500 },
  typeBtnActive: { borderColor: '#1a5276', background: '#e8f0f7', color: '#1a5276', fontWeight: 700 },
  companyList: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24, maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: '8px 12px' },
  companyItem: { display: 'flex', alignItems: 'center', fontSize: 14, cursor: 'pointer', padding: '4px 0' },
  startBtn:  { width: '100%', padding: '13px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  uploadScreen: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
  uploadCard:   { background: '#fff', borderRadius: 16, padding: '36px 28px', width: '100%', maxWidth: 440, boxShadow: '0 4px 24px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' },
  uploadIcon:   { fontSize: 52, marginBottom: 8 },
  uploadTitle:  { fontSize: 20, fontWeight: 700, color: '#1a5276', marginBottom: 8 },
  uploadSub:    { fontSize: 14, color: '#666', lineHeight: 1.5, marginBottom: 24 },
  uploadZone:   { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 120, border: '2px dashed #1a5276', borderRadius: 12, padding: 20, cursor: 'pointer', background: '#f0f7ff', gap: 4 } as React.CSSProperties,
  uploadSpinner: { display: 'flex', alignItems: 'center', padding: '20px 0' },
  feed:      { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  row:       { display: 'flex', gap: 8, alignItems: 'flex-end' },
  avatar:    { fontSize: 22, flexShrink: 0, marginBottom: 4 },
  bubbleUser: { background: '#1a5276', color: '#fff', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', fontSize: 15, lineHeight: 1.5, wordBreak: 'break-word', maxWidth: '75%' },
  bubbleBot:  { background: '#fff', color: '#2c3e50', padding: '10px 14px', borderRadius: '16px 16px 16px 4px', fontSize: 15, lineHeight: 1.5, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', wordBreak: 'break-word', maxWidth: '75%' },
  bubbleSystem: { background: '#fef9c3', color: '#854d0e', padding: '8px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word', maxWidth: '75%' },
  inputBar:  { display: 'flex', gap: 8, padding: '12px 20px', background: '#fff', borderTop: '1px solid #e5e7eb', boxShadow: '0 -2px 8px rgba(0,0,0,0.06)', flexShrink: 0 },
  uploadBtn: { background: '#f0f4f8', border: '1.5px solid #ddd', borderRadius: 10, fontSize: 20, padding: '6px 10px', cursor: 'pointer', flexShrink: 0 },
  textarea:  { flex: 1, padding: '10px 14px', border: '1.5px solid #ddd', borderRadius: 24, fontSize: 15, resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.5 },
  sendBtn:   { width: 44, height: 44, borderRadius: '50%', background: '#1a5276', color: '#fff', border: 'none', fontSize: 18, cursor: 'pointer', flexShrink: 0 },
  dropOverlay: { position: 'absolute', inset: 0, background: 'rgba(26,82,118,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  dropBox:   { background: '#fff', borderRadius: 16, padding: '40px 60px', fontSize: 22, fontWeight: 600, color: '#1a5276' },
};

const cf: Record<string, React.CSSProperties> = {
  card:   { background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  header: { background: '#16a34a', color: '#fff', padding: '10px 16px', fontWeight: 600, fontSize: 14 },
  body:   { padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  row:    { display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #dcfce7' },
  key:    { color: '#555', fontSize: 12, textTransform: 'capitalize' as const },
  val:    { color: '#1a5276', fontSize: 12, fontWeight: 600 },
  runBtn: { width: '100%', padding: '12px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700 },
};

const qr: Record<string, React.CSSProperties> = {
  card:      { background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  header:    { color: '#fff', padding: '10px 16px', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between' },
  duration:  { fontWeight: 400, fontSize: 12, opacity: 0.85 },
  body:      { padding: '12px 16px' },
  highlight: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f1f5f9' },
  row:       { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  label:     { color: '#64748b', fontSize: 12 },
  bigValue:  { color: '#1a5276', fontSize: 22, fontWeight: 700 },
  value:     { color: '#1a5276', fontSize: 13, fontWeight: 600 },
  error:     { color: '#dc2626', fontSize: 13 },
};

const cap: Record<string, React.CSSProperties> = {
  card:   { background: '#fefce8', border: '1.5px solid #fde047', borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  header: { background: '#ca8a04', color: '#fff', padding: '10px 16px', fontWeight: 600, fontSize: 14 },
  body:   { padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 },
  img:    { maxWidth: '100%', borderRadius: 6, border: '1px solid #ddd' },
  input:  { padding: '10px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 15, outline: 'none', fontFamily: 'monospace', letterSpacing: 2 },
  btn:    { padding: '10px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
