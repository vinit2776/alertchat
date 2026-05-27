import { useState, useRef, useEffect } from 'react';
import type { KeyboardEvent } from 'react';

interface QuoteSummary {
  premium: string;
  basePremium: string;
  premiumWithAddOn?: string | null;
  title: string;
  members: number;
  coverType: string;
  sumInsured: number;
  deductible: number;
  tenure: string;
  plan: string;
  gst: string;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  quote?: QuoteSummary | null;
  ts: number;
}

// Raw history sent to API (may contain ContentBlock arrays from Claude)
type RawMsg = { role: 'user' | 'assistant'; content: any };

interface Props {
  token: string;
  onLogout: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || '';
const WELCOME = 'Hello! I\'m your Alert Insurance advisor. I\'ll help you get a health insurance quote — quick and hassle-free.\n\nTo start: how many members would you like to insure?';

export default function ChatPage({ token, onLogout }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', text: WELCOME, ts: Date.now() },
  ]);
  const [history, setHistory] = useState<RawMsg[]>([]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', text, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res  = await fetch(`${apiBase}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ message: text, history }),
      });

      if (res.status === 401) { onLogout(); return; }

      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      setHistory(data.history ?? []);
      setMessages(prev => [...prev, {
        role:  'assistant',
        text:  data.message,
        quote: data.quote ?? null,
        ts:    Date.now(),
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Sorry, something went wrong: ${err.message}`,
        ts:   Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function handleReset() {
    setMessages([{ role: 'assistant', text: WELCOME, ts: Date.now() }]);
    setHistory([]);
    setInput('');
  }

  return (
    <div style={s.shell}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.headerIcon}>🏥</span>
          <div>
            <div style={s.headerTitle}>Alert Insurance</div>
            <div style={s.headerSub}>Quote Advisor</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.iconBtn} onClick={handleReset} title="New quote">↺</button>
          <button style={s.iconBtn} onClick={onLogout}    title="Logout">⎋</button>
        </div>
      </div>

      {/* Messages */}
      <div style={s.feed}>
        {messages.map((msg, i) => (
          <div key={i} style={{ ...s.row, justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {msg.role === 'assistant' && <div style={s.avatar}>🤖</div>}
            <div style={{ maxWidth: '75%' }}>
              <div style={msg.role === 'user' ? s.bubbleUser : s.bubbleBot}>
                {msg.text.split('\n').map((line, j) => (
                  <span key={j}>{line}{j < msg.text.split('\n').length - 1 && <br />}</span>
                ))}
              </div>
              {msg.quote && <QuoteCard quote={msg.quote} />}
              <div style={{ ...s.ts, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ ...s.row, justifyContent: 'flex-start' }}>
            <div style={s.avatar}>🤖</div>
            <div style={s.bubbleBot}><TypingDots /></div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={s.inputBar}>
        <textarea
          style={s.textarea}
          rows={1}
          placeholder="Type a message…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading}
        />
        <button style={{ ...s.sendBtn, opacity: loading || !input.trim() ? 0.5 : 1 }} onClick={send} disabled={loading || !input.trim()}>
          ➤
        </button>
      </div>
    </div>
  );
}

// ── Quote card ────────────────────────────────────────────────────────────

function QuoteCard({ quote }: { quote: QuoteSummary }) {
  return (
    <div style={qc.card}>
      <div style={qc.header}>
        <span>✅</span>
        <span>Care {quote.title} — Premium Quote</span>
      </div>
      <div style={qc.body}>
        <Row label="Premium (excl. GST)" value={`₹${quote.basePremium}`} />
        <Row label={`Premium incl. ${quote.gst}% GST`} value={`₹${quote.premium}`} bold />
        {quote.premiumWithAddOn && <Row label="With Add-on Benefits" value={`₹${quote.premiumWithAddOn}`} />}
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }} />
        <Row label="Members"       value={String(quote.members)} />
        <Row label="Cover Type"    value={quote.coverType} />
        <Row label="Sum Insured"   value={`₹${quote.sumInsured} Lakhs`} />
        <Row label="Deductible"    value={`₹${quote.deductible} Lakhs`} />
        <Row label="Tenure"        value={quote.tenure} />
        <Row label="Plan"          value={quote.plan} />
      </div>
      <div style={qc.footer}>
        <button style={qc.cta}>Proceed to Buy →</button>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ color: '#666', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500, fontSize: bold ? 16 : 13, color: bold ? '#1a5276' : '#2c3e50' }}>{value}</span>
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
      <style>{`@keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }`}</style>
    </span>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  shell:    { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f0f4f8', fontFamily: 'system-ui, sans-serif' },
  header:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1a5276', color: '#fff', padding: '12px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon:  { fontSize: 28 },
  headerTitle: { fontWeight: 700, fontSize: 16 },
  headerSub:   { fontSize: 12, opacity: 0.8 },
  iconBtn:  { background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 18, padding: '6px 12px', cursor: 'pointer' },
  feed:     { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  row:      { display: 'flex', gap: 8, alignItems: 'flex-end' },
  avatar:   { fontSize: 22, flexShrink: 0, marginBottom: 4 },
  bubbleUser: {
    background: '#1a5276', color: '#fff', padding: '10px 14px',
    borderRadius: '16px 16px 4px 16px', fontSize: 15, lineHeight: 1.5, wordBreak: 'break-word',
  },
  bubbleBot: {
    background: '#fff', color: '#2c3e50', padding: '10px 14px',
    borderRadius: '16px 16px 16px 4px', fontSize: 15, lineHeight: 1.5,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)', wordBreak: 'break-word',
  },
  ts: { fontSize: 11, color: '#aaa', marginTop: 4 },
  inputBar: {
    display: 'flex', gap: 8, padding: '12px 20px', background: '#fff',
    borderTop: '1px solid #e5e7eb', boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
  },
  textarea: {
    flex: 1, padding: '10px 14px', border: '1.5px solid #ddd', borderRadius: 24,
    fontSize: 15, resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.5,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: '50%', background: '#1a5276', color: '#fff',
    border: 'none', fontSize: 18, cursor: 'pointer', flexShrink: 0,
  },
};

const qc: Record<string, React.CSSProperties> = {
  card:   { background: '#fff', borderRadius: 12, border: '1px solid #c8dff0', marginTop: 8, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  header: { background: '#1a5276', color: '#fff', padding: '10px 16px', fontWeight: 600, fontSize: 14, display: 'flex', gap: 8, alignItems: 'center' },
  body:   { padding: '14px 16px' },
  footer: { padding: '0 16px 14px' },
  cta:    { width: '100%', padding: '10px', background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
};
