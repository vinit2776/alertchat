import { useState, useRef, useEffect, useCallback } from 'react';
import type { KeyboardEvent, DragEvent } from 'react';
import InsuranceWizard from './InsuranceWizard';

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
  const [phase, setPhase]               = useState<'setup' | 'wizard' | 'quoting' | 'chat'>('setup');
  const [insType, setInsType]           = useState<InsuranceType>('motor');
  const [companies, setCompanies]       = useState<Company[]>([]);
  const [selectedIds, setSelectedIds]   = useState<string[]>([]);
  const [sessionId, setSessionId]       = useState<string | null>(null);
  const [, setPendingWelcome] = useState<string>('');
  const [messages, setMessages]         = useState<Message[]>([]);
  const [input, setInput]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [dragOver, setDragOver]         = useState(false);
  const [confirmedFields, setConfirmedFields] = useState<ConfirmedFields | null>(null);
  const [quoteRunning, setQuoteRunning]         = useState(false);
  const [quoteResults, setQuoteResults]         = useState<any[] | null>(null);
  const [captchaState, setCaptchaState]         = useState<{ portalId: string; imageBase64: string; captchaToken: string } | null>(null);
  const [captchaInput, setCaptchaInput]         = useState('');
  // Per-portal payment-link state, keyed by portalId
  const [paymentByPortal, setPaymentByPortal]   = useState<Record<string, {
    status: 'idle' | 'loading' | 'done' | 'error';
    paymentUrl?: string;
    confirmationNumber?: string;
    errorMessage?: string;
  }>>({});
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
        // Motor → wizard flow (documents + claims + preferences + review)
        setPendingWelcome(data.welcome);
        setPhase('wizard');
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
    setMessages(prev => [...prev, { role: 'system', text: `Uploading ${file.name}…`, ts: Date.now() }]);

    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(`${autoBase}/api/documents/upload/${sessionId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      const follow = await apiPost(`/api/chat/${sessionId}/message`, {
        message: `I uploaded the ${data.docType}. What else do you need?`,
      });

      setMessages(prev => [...prev,
        { role: 'assistant', text: data.message,   ts: Date.now() },
        { role: 'assistant', text: follow.message, ts: Date.now() + 1 },
      ]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'system', text: `Upload failed: ${err.message}`, ts: Date.now() }]);
    } finally {
      setUploading(false);
    }
  }, [sessionId, token]);

  function handleFileDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Called immediately after wizard completes — async, SSE-driven.
  // Quote work runs in the BACKGROUND on the server (avoids Cloudflare's
  // 100s HTTP timeout on the POST). Results stream over SSE.
  async function runQuotesFromWizard(sid: string, _fields: Record<string, string>) {
    setQuoteRunning(true); setQuoteResults([]); setCaptchaState(null);

    const sseUrl = `${autoBase}/api/quotes/${sid}/progress?token=${encodeURIComponent(token)}`;
    const sse = new EventSource(sseUrl);
    progressRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as {
          type: string; message?: string;
          portalId?: string; portalName?: string;
          result?: any;
        };
        // Step-by-step status (login, step, error) → chat bubble
        if (event.message && event.type !== 'quote_complete' && event.type !== 'all_complete' && event.type !== 'captcha_required') {
          setMessages(prev => [...prev, { role: 'assistant' as const, text: event.message!, ts: Date.now() }]);
        }
        // Per-portal completion → append the quote card
        if (event.type === 'quote_complete' && event.result) {
          setQuoteResults(prev => [...(prev ?? []), event.result]);
          // Trigger immediate refresh of the 🚨 failed-quote pill if this attempt failed
          if (event.result?.success === false) {
            window.dispatchEvent(new Event('failures-may-have-changed'));
          }
        }
        // Captcha challenge for this portal
        if (event.type === 'captcha_required' && event.result) {
          setCaptchaState({
            portalId:        event.result.portalId,
            imageBase64:     event.result.captchaImageBase64,
            captchaToken:    event.result.captchaToken ?? '',
          });
          setQuoteResults(prev => [...(prev ?? []), event.result]);
        }
        // All portals done — close the stream
        if (event.type === 'all_complete') {
          setQuoteRunning(false);
          sse.close(); progressRef.current = null;
          // Final refresh of the pill so any straggling failure is reflected
          window.dispatchEvent(new Event('failures-may-have-changed'));
        }
      } catch { /* ignore */ }
    };

    sse.onerror = () => {
      // SSE may temporarily drop — only close if user navigated away
      // (the natural retry behaviour of EventSource handles transient errors)
    };

    // Fire the POST to kick off background work. It returns within ~100ms.
    try {
      const res  = await fetch(`${autoBase}/api/quotes/${sid}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message ?? 'Quote could not be started');
      }
      // POST succeeded — work is now running in background. Results stream over SSE.
    } catch (err: any) {
      setQuoteRunning(false);
      setQuoteResults([{ success: false, errorMessage: err.message, portalId: 'unknown', portalName: 'Error' }]);
      sse.close(); progressRef.current = null;
    }
  }

  async function runQuotes() {
    if (!sessionId || quoteRunning) return;
    setQuoteRunning(true);
    setQuoteResults([]);
    setCaptchaState(null);

    const sseUrl = `${autoBase}/api/quotes/${sessionId}/progress?token=${encodeURIComponent(token)}`;
    const sse = new EventSource(sseUrl);
    progressRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as {
          type: string; message?: string;
          portalId?: string; portalName?: string;
          result?: any;
        };
        if (event.message && event.type !== 'quote_complete' && event.type !== 'all_complete' && event.type !== 'captcha_required') {
          setMessages(prev => [...prev, { role: 'assistant' as const, text: event.message!, ts: Date.now() }]);
        }
        if (event.type === 'quote_complete' && event.result) {
          setQuoteResults(prev => [...(prev ?? []), event.result]);
        }
        if (event.type === 'captcha_required' && event.result) {
          setCaptchaState({
            portalId:        event.result.portalId,
            imageBase64:     event.result.captchaImageBase64,
            captchaToken:    event.result.captchaToken ?? '',
          });
          setQuoteResults(prev => [...(prev ?? []), event.result]);
        }
        if (event.type === 'all_complete') {
          setQuoteRunning(false);
          sse.close(); progressRef.current = null;
        }
      } catch { /* ignore parse errors */ }
    };

    sse.onerror = () => { /* EventSource auto-retries */ };

    try {
      const res  = await fetch(`${autoBase}/api/quotes/${sessionId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message ?? 'Quote request failed');
      // Results stream via SSE — nothing to do here
    } catch (err: any) {
      setQuoteRunning(false);
      setQuoteResults([{ success: false, errorMessage: err.message, portalId: 'unknown', portalName: 'Error' }]);
      sse.close();
      progressRef.current = null;
    }
  }

  async function proceedBuy(portalId: string) {
    if (!sessionId) return;
    setPaymentByPortal(p => ({ ...p, [portalId]: { status: 'loading' } }));
    try {
      const res  = await fetch(`${autoBase}/api/quotes/${sessionId}/proceed/${portalId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success && data.paymentUrl) {
        setPaymentByPortal(p => ({ ...p, [portalId]: {
          status: 'done',
          paymentUrl: data.paymentUrl,
          confirmationNumber: data.confirmationNumber ?? undefined,
        }}));
      } else {
        setPaymentByPortal(p => ({ ...p, [portalId]: {
          status: 'error',
          errorMessage: data.errorMessage ?? data.message ?? 'Could not generate payment link',
        }}));
      }
    } catch (err: any) {
      setPaymentByPortal(p => ({ ...p, [portalId]: { status: 'error', errorMessage: err.message } }));
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
    setPendingWelcome('');
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
        <Header title="New Quote" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} token={token} />
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

  // ── Wizard Phase (motor only) ─────────────────────────────────────────────

  if (phase === 'wizard' && sessionId) {
    return (
      <InsuranceWizard
        token={token}
        sessionId={sessionId}
        insType={insType}
        onBack={reset}
        onComplete={(confirmedFields, _missing) => {
          setConfirmedFields(confirmedFields);
          setPhase('quoting');
          // Auto-trigger quotes immediately
          runQuotesFromWizard(sessionId, confirmedFields);
        }}
      />
    );
  }

  // ── Quoting Phase (wizard → automation running) ────────────────────────────

  if (phase === 'quoting') {
    return (
      <div style={s.shell}>
        <Header title="Getting Quotes" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} token={token} />
        <div style={s.feed}>

          {/* Progress steps from SSE */}
          {messages.map((msg, i) => (
            <div key={i} style={{ ...s.row, justifyContent: 'flex-start' }}>
              <div style={s.avatar}>🤖</div>
              <div style={s.bubbleBot}>{msg.text}</div>
            </div>
          ))}

          {quoteRunning && !messages.some(m => m.text.startsWith('✓') || m.text.startsWith('→')) && (
            <div style={{ ...s.row, justifyContent: 'flex-start' }}>
              <div style={s.avatar}>🤖</div>
              <div style={s.bubbleBot}><TypingDots /> Connecting to portal…</div>
            </div>
          )}
          {quoteRunning && messages.length > 0 && (
            <div style={{ ...s.row, justifyContent: 'flex-start' }}>
              <div style={s.avatar}>🤖</div>
              <div style={s.bubbleBot}><TypingDots /></div>
            </div>
          )}

          {/* Results */}
          {quoteResults && quoteResults.map((r: any, i: number) => (
            <QuoteResultCard key={i} result={r} onProceed={proceedBuy} paymentState={paymentByPortal[r.portalId]}
              onTakeOver={isAdmin && r.success === false && onShowAdmin ? () => onShowAdmin() : undefined} />
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

          {/* Done — offer to start new quote */}
          {quoteResults && !quoteRunning && (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <button style={{ background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: 'pointer', fontSize: 14 }}
                onClick={reset}>
                ↺ New Quote
              </button>
            </div>
          )}

          <div ref={bottomRef} />
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

      <Header title="Quote Chat" onLogout={onLogout} onReset={reset} onHistory={onShowHistory} onAdmin={onShowAdmin} showAdmin={isAdmin} token={token} />

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
          <QuoteResultCard key={i} result={r} onProceed={proceedBuy} paymentState={paymentByPortal[r.portalId]} />
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

function Header({ title, onLogout, onReset, onHistory, onAdmin, showAdmin, token }: {
  title: string; onLogout: () => void; onReset: () => void; onHistory: () => void; onAdmin?: () => void; showAdmin: boolean; token?: string;
}) {
  const [failedCount, setFailedCount] = useState(0);
  useEffect(() => {
    if (!showAdmin || !token) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`${autoBase}/api/admin/failed-quotes/count`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!cancelled && data.success) setFailedCount(data.count ?? 0);
      } catch { /* silent */ }
    }
    poll();
    // 10 s during active sessions — fast enough to feel live
    const t = setInterval(poll, 10_000);
    // Also refresh immediately on a custom event (e.g. when a quote fails)
    const refresh = () => poll();
    window.addEventListener('failures-may-have-changed', refresh);
    // Refresh when tab regains focus (browser-tab switch case)
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener('failures-may-have-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [showAdmin, token]);

  return (
    <div style={s.header}>
      <div style={s.headerLeft}>
        <span style={s.headerIcon}>🚗</span>
        <div>
          <div style={s.headerTitle}>Alert Insurance</div>
          <div style={s.headerSub}>{title}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>
            {__BUILD_HASH__} · {__BUILD_DATE__}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {showAdmin && failedCount > 0 && (
          <button
            onClick={onAdmin}
            title={`${failedCount} portal quote${failedCount > 1 ? 's' : ''} need manual entry`}
            style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 16, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            🚨 {failedCount} failed
          </button>
        )}
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

function QuoteResultCard({ result, onProceed, paymentState, onTakeOver }: {
  result:        any;
  onProceed?:    (portalId: string) => void;
  paymentState?: { status: 'idle' | 'loading' | 'done' | 'error'; paymentUrl?: string; confirmationNumber?: string; errorMessage?: string };
  onTakeOver?:   () => void;
}) {
  const success = result.success;
  const ps = paymentState ?? { status: 'idle' as const };
  const rupee = (n: any) => `₹${Number(n).toLocaleString('en-IN')}`;

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
                <span style={qr.label}>Net Premium</span>
                <span style={qr.bigValue}>{rupee(result.premium)}</span>
              </div>
            )}
            {result.idv != null && (
              <div style={qr.row}>
                <span style={qr.label}>IDV</span>
                <span style={qr.value}>{rupee(result.idv)}</span>
              </div>
            )}

            {/* Premium breakdown — only renders rows that have data */}
            {(result.odPremium != null || result.tpPremium != null || result.gstAmount != null) && (
              <div style={qr.section}>
                <div style={qr.sectionTitle}>Premium Breakdown</div>
                {result.odPremium != null && (
                  <div style={qr.row}><span style={qr.label}>Own Damage (OD)</span><span style={qr.value}>{rupee(result.odPremium)}</span></div>
                )}
                {result.tpPremium != null && (
                  <div style={qr.row}><span style={qr.label}>Third Party (TP)</span><span style={qr.value}>{rupee(result.tpPremium)}</span></div>
                )}
                {result.ncbAmount != null && (
                  <div style={qr.row}><span style={qr.label}>NCB Discount</span><span style={{ ...qr.value, color: '#16a34a' }}>− {rupee(result.ncbAmount)}</span></div>
                )}
                {result.gstAmount != null && (
                  <div style={qr.row}><span style={qr.label}>GST</span><span style={qr.value}>{rupee(result.gstAmount)}</span></div>
                )}
              </div>
            )}

            {/* Add-ons — only renders rows that have data */}
            {(result.addonZeroDep != null || result.addonEngine != null || result.addonRsa != null || result.addonPa != null) && (
              <div style={qr.section}>
                <div style={qr.sectionTitle}>Add-ons</div>
                {result.addonZeroDep != null && (
                  <div style={qr.row}><span style={qr.label}>🛡️ Zero Depreciation</span><span style={qr.value}>{rupee(result.addonZeroDep)}</span></div>
                )}
                {result.addonEngine != null && (
                  <div style={qr.row}><span style={qr.label}>⚙️ Engine Protect</span><span style={qr.value}>{rupee(result.addonEngine)}</span></div>
                )}
                {result.addonRsa != null && (
                  <div style={qr.row}><span style={qr.label}>🚗 Roadside Assistance</span><span style={qr.value}>{rupee(result.addonRsa)}</span></div>
                )}
                {result.addonPa != null && (
                  <div style={qr.row}><span style={qr.label}>🏥 Personal Accident</span><span style={qr.value}>{rupee(result.addonPa)}</span></div>
                )}
              </div>
            )}

            {/* Cashless + quote ref */}
            {(result.cashlessCount != null || result.quoteRef) && (
              <div style={qr.metaRow}>
                {result.cashlessCount != null && <span style={qr.metaBadge}>🔑 {result.cashlessCount} cashless garages</span>}
                {result.quoteRef && <span style={qr.metaBadge}>Quote #{result.quoteRef}</span>}
              </div>
            )}

            {/* Proceed to Buy */}
            {result.supportsProceed && ps.status === 'idle' && onProceed && (
              <button style={qr.proceedBtn} onClick={() => onProceed(result.portalId)}>
                💳 Get Payment Link
              </button>
            )}
            {ps.status === 'loading' && (
              <div style={qr.proceedLoading}><TypingDots /><span style={{ marginLeft: 10 }}>Generating payment link…</span></div>
            )}
            {ps.status === 'done' && ps.paymentUrl && (
              <PaymentLinkCard paymentUrl={ps.paymentUrl} confirmationNumber={ps.confirmationNumber} portalName={result.portalName ?? result.portalId} />
            )}
            {ps.status === 'error' && (
              <div style={qr.proceedError}>⚠️ {ps.errorMessage ?? 'Could not generate payment link'}</div>
            )}

            {result.rawData && Object.keys(result.rawData).length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>Raw extracted text</summary>
                <pre style={{ fontSize: 11, marginTop: 4, color: '#555', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(result.rawData, null, 2)}
                </pre>
              </details>
            )}
          </>
        ) : (
          <>
            <div style={qr.error}>{result.errorMessage ?? 'Quote generation failed'}</div>
            {onTakeOver && (
              <button onClick={onTakeOver}
                style={{ marginTop: 12, width: '100%', background: result.needsSession ? '#0c4a6e' : '#1a56db', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 14px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                {result.needsSession
                  ? (result.sessionExpired
                      ? '🔑 Refresh Portal Session'
                      : '🔑 Capture Portal Session')
                  : '🛠 Take Over (Cookie Handoff)'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Payment Link Card ──────────────────────────────────────────────────────

function PaymentLinkCard({ paymentUrl, confirmationNumber, portalName }: {
  paymentUrl:          string;
  confirmationNumber?: string;
  portalName:          string;
}) {
  const [copied, setCopied] = useState(false);

  const message = `Hi! Your motor insurance renewal quote from ${portalName} is ready.\n\n${confirmationNumber ? `Reference: ${confirmationNumber}\n` : ''}Please complete payment using this secure link:\n${paymentUrl}\n\n— Alert Insurance`;
  const waUrl    = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const mailUrl  = `mailto:?subject=${encodeURIComponent('Your insurance renewal payment link')}&body=${encodeURIComponent(message)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  return (
    <div style={pl.card}>
      <div style={pl.title}>💳 Payment Link Ready</div>
      <div style={pl.hint}>Share this link with the customer to complete payment</div>

      {confirmationNumber && (
        <div style={pl.refBox}>
          <span style={pl.refLabel}>Reference</span>
          <span style={pl.refValue}>{confirmationNumber}</span>
        </div>
      )}

      <div style={pl.urlBox}>
        <input style={pl.urlInput} value={paymentUrl} readOnly onClick={e => (e.target as HTMLInputElement).select()} />
        <button style={pl.copyBtn} onClick={copy}>{copied ? '✓ Copied' : '📋 Copy'}</button>
      </div>

      <div style={pl.actions}>
        <a href={waUrl} target="_blank" rel="noopener noreferrer" style={{ ...pl.shareBtn, background: '#25D366' }}>💬 WhatsApp</a>
        <a href={mailUrl} style={{ ...pl.shareBtn, background: '#3b82f6' }}>📧 Email</a>
      </div>

      <div style={pl.footer}>
        Payment link valid for the customer to use. Policy PDF will be emailed to them by {portalName} after successful payment.
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
  section:      { marginTop: 12, padding: '8px 10px', background: '#f8fafc', borderRadius: 8 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase' as const, letterSpacing: 0.5, marginBottom: 4 },
  metaRow:      { display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginTop: 10 },
  metaBadge:    { background: '#f1f5f9', color: '#475569', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 500 },
  proceedBtn:   { display: 'block', width: '100%', marginTop: 14, padding: '12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  proceedLoading: { display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 14, padding: '10px', background: '#f0fdf4', borderRadius: 8, fontSize: 13, color: '#16a34a' },
  proceedError:   { marginTop: 14, padding: '10px 12px', background: '#fef2f2', color: '#dc2626', borderRadius: 8, fontSize: 13 },
};

const pl: Record<string, React.CSSProperties> = {
  card:     { marginTop: 14, background: '#f0f9ff', border: '1.5px solid #38bdf8', borderRadius: 10, padding: '14px' },
  title:    { fontSize: 14, fontWeight: 700, color: '#0c4a6e', marginBottom: 2 },
  hint:     { fontSize: 12, color: '#0369a1', marginBottom: 12 },
  refBox:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', borderRadius: 6, padding: '8px 12px', marginBottom: 8 },
  refLabel: { fontSize: 12, color: '#64748b' },
  refValue: { fontSize: 13, fontWeight: 700, color: '#0c4a6e', fontFamily: 'monospace' },
  urlBox:   { display: 'flex', gap: 6, marginBottom: 10 },
  urlInput: { flex: 1, padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', color: '#0c4a6e', background: '#fff' },
  copyBtn:  { padding: '8px 14px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' as const },
  actions:  { display: 'flex', gap: 8, marginBottom: 10 },
  shareBtn: { flex: 1, textAlign: 'center' as const, padding: '10px', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none' },
  footer:   { fontSize: 11, color: '#475569', textAlign: 'center' as const, lineHeight: 1.4 },
};

const cap: Record<string, React.CSSProperties> = {
  card:   { background: '#fefce8', border: '1.5px solid #fde047', borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  header: { background: '#ca8a04', color: '#fff', padding: '10px 16px', fontWeight: 600, fontSize: 14 },
  body:   { padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 },
  img:    { maxWidth: '100%', borderRadius: 6, border: '1px solid #ddd' },
  input:  { padding: '10px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 15, outline: 'none', fontFamily: 'monospace', letterSpacing: 2 },
  btn:    { padding: '10px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
