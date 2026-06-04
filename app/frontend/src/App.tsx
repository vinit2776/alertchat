import { useState } from 'react';
import LoginPage       from './pages/LoginPage';
import PortalChatPage  from './pages/PortalChatPage';
import QuoteHistory    from './pages/QuoteHistory';
import AdminDashboard  from './pages/AdminDashboard';
import CompanyRegistry from './pages/CompanyRegistry';
import UserManagement  from './pages/UserManagement';
import Dashboard       from './pages/Dashboard';
import QuotationPage   from './pages/QuotationPage';
import PolicyPage      from './pages/PolicyPage';
import StatusPage      from './pages/StatusPage';
import PDFPage         from './pages/PDFPage';
import AuthStatus      from './pages/AuthStatus';
import ChatPage        from './pages/ChatPage';
import './App.css';

export type Page =
  | 'chat'            // portal automation chat
  | 'history'         // 7-day quote history
  | 'admin'           // admin dashboard (super_admin)
  | 'admin-companies' // insurance company registry (super_admin)
  | 'admin-users'     // user management (super_admin)
  | 'legacy-chat'     // old CHI health direct chat
  | 'dashboard' | 'quotation' | 'policy' | 'status' | 'pdf' | 'auth';

export interface UserInfo { role: string; username: string; email?: string; id?: string }

function getStoredToken(): string | null { return localStorage.getItem('chi_token'); }
function getStoredUser(): UserInfo | null {
  const raw = localStorage.getItem('chi_user');
  return raw ? JSON.parse(raw) : null;
}

export default function App() {
  const [page, setPage]   = useState<Page>('chat');
  const [token, setToken] = useState<string | null>(getStoredToken);
  const [user, setUser]   = useState<UserInfo | null>(getStoredUser);

  function handleLogin(t: string, u: UserInfo) {
    localStorage.setItem('chi_token', t);
    localStorage.setItem('chi_user', JSON.stringify(u));
    setToken(t); setUser(u);
  }

  function handleLogout() {
    localStorage.removeItem('chi_token');
    localStorage.removeItem('chi_user');
    setToken(null); setUser(null); setPage('chat');
  }

  const isSuperAdmin = user?.role === 'super_admin';

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // ── Chat user — only sees chat + history ────────────────────────────────
  if (!isSuperAdmin) {
    if (page === 'history') {
      return <QuoteHistory token={token} onBack={() => setPage('chat')} />;
    }
    return (
      <PortalChatPage token={token} onLogout={handleLogout}
        onShowHistory={() => setPage('history')}
        isAdmin={false} />
    );
  }

  // ── Super admin — full access ───────────────────────────────────────────
  if (page === 'chat') {
    return <PortalChatPage token={token} onLogout={handleLogout}
      onShowHistory={() => setPage('history')}
      onShowAdmin={() => setPage('admin')}
      isAdmin={true} />;
  }
  if (page === 'history') {
    return <QuoteHistory token={token} onBack={() => setPage('chat')} />;
  }
  if (page === 'admin') {
    return <AdminDashboard token={token}
      onBack={() => setPage('chat')}
      onCompanies={() => setPage('admin-companies')}
      onUsers={() => setPage('admin-users')} />;
  }
  if (page === 'admin-companies') {
    return <CompanyRegistry token={token} onBack={() => setPage('admin')} />;
  }
  if (page === 'admin-users') {
    return <UserManagement token={token} onBack={() => setPage('admin')} currentUserId={user?.id ?? ''} />;
  }
  if (page === 'legacy-chat') {
    return (
      <div style={{ position: 'relative' }}>
        <ChatPage token={token} onLogout={handleLogout} />
        <button onClick={() => setPage('chat')}
          style={{ position: 'fixed', bottom: 80, right: 20, background: '#1a5276', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 13, zIndex: 10 }}>
          ← Portal Chat
        </button>
      </div>
    );
  }

  // Dev tools pages (with nav bar)
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-logo">
            <span>🚗</span>
            <span className="app-logo-text">Alert Insurance</span>
            <span className="app-badge">UAT</span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontWeight: 400, letterSpacing: '0.3px' }}>
              {__BUILD_HASH__} · {__BUILD_DATE__}
            </span>
          </div>
          <nav className="app-nav">
            <button className="nav-btn active" onClick={() => setPage('chat')}>💬 Chat</button>
            <button className="nav-btn" onClick={() => setPage('admin')}>⚙️ Admin</button>
            <button className="nav-btn" onClick={() => setPage('history')}>📋 History</button>
            {(['dashboard', 'quotation', 'policy', 'status', 'pdf', 'auth', 'legacy-chat'] as Page[]).map(p => (
              <button key={p} onClick={() => setPage(p)} className={`nav-btn${page === p ? ' active' : ''}`}>
                {p === 'legacy-chat' ? 'CHI Chat' : p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
            <button className="nav-btn" onClick={handleLogout} style={{ marginLeft: 8, color: '#e74c3c' }}>Logout</button>
          </nav>
        </div>
      </header>
      <main className="app-main">
        {page === 'dashboard'  && <Dashboard onNavigate={setPage} />}
        {page === 'quotation'  && <QuotationPage />}
        {page === 'policy'     && <PolicyPage />}
        {page === 'status'     && <StatusPage />}
        {page === 'pdf'        && <PDFPage />}
        {page === 'auth'       && <AuthStatus />}
      </main>
    </div>
  );
}
