import { useState } from 'react';
import Dashboard from './pages/Dashboard';
import QuotationPage from './pages/QuotationPage';
import PolicyPage from './pages/PolicyPage';
import StatusPage from './pages/StatusPage';
import PDFPage from './pages/PDFPage';
import AuthStatus from './pages/AuthStatus';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import './App.css';

export type Page = 'dashboard' | 'quotation' | 'policy' | 'status' | 'pdf' | 'auth' | 'chat';

function getStoredToken(): string | null {
  return localStorage.getItem('chi_token');
}

export default function App() {
  const [page, setPage]   = useState<Page>('chat');
  const [token, setToken] = useState<string | null>(getStoredToken);

  function handleLogin(t: string) { setToken(t); }
  function handleLogout() {
    localStorage.removeItem('chi_token');
    setToken(null);
  }

  // Chat page — full-screen, no nav chrome
  if (page === 'chat') {
    if (!token) return <LoginPage onLogin={handleLogin} />;
    return (
      <div style={{ position: 'relative' }}>
        <ChatPage token={token} onLogout={handleLogout} />
        <button
          onClick={() => setPage('dashboard')}
          style={{ position: 'fixed', bottom: 80, right: 20, background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 13, zIndex: 10 }}
        >
          ⚙ Dev Tools
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-logo">
            <span>🏥</span>
            <span className="app-logo-text">Alert Insurance</span>
            <span className="app-badge">UAT</span>
          </div>
          <nav className="app-nav">
            <button className="nav-btn active" onClick={() => setPage('chat')}>💬 Chat</button>
            {(['dashboard', 'quotation', 'policy', 'status', 'pdf', 'auth'] as Page[]).map((p) => (
              <button key={p} onClick={() => setPage(p)} className={`nav-btn${page === p ? ' active' : ''}`}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="app-main">
        {page === 'dashboard' && <Dashboard onNavigate={setPage} />}
        {page === 'quotation' && <QuotationPage />}
        {page === 'policy'    && <PolicyPage />}
        {page === 'status'    && <StatusPage />}
        {page === 'pdf'       && <PDFPage />}
        {page === 'auth'      && <AuthStatus />}
      </main>
    </div>
  );
}
