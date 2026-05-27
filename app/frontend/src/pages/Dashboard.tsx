import { useEffect, useState } from 'react';
import { chiApi } from '../api/chi';
import type { Page } from '../App';

interface Product { code: string; name: string; productId: string; hasQuotation: boolean; }

const ICONS: Record<string, string> = {
  CARE: '💊', CARE_FREEDOM: '🆓', CARE_SUPREME: '👑',
  CARE_ENHANCE: '⚡', CARE_ADVANTAGE: '🎯', CARE_HEART: '❤️', ULTIMATE_CARE: '🌟',
};

export default function Dashboard({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    chiApi.getProducts().then(r => setProducts(r.data.data)).catch(() => {});
  }, []);

  return (
    <div>
      <div className="card">
        <div className="card-title">Care Health Insurance — Integration Portal</div>
        <div className="alert alert-warn" style={{ marginBottom: 0 }}>
          ⚠️ Running in <strong>UAT mode</strong>. Add your CHI credentials to <code>backend/.env</code> to make live API calls.
        </div>
      </div>

      <div className="card">
        <p className="section-heading">Products</p>
        <div className="product-grid">
          {products.map(p => (
            <div key={p.code} className="product-card" onClick={() => onNavigate('policy')}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>{ICONS[p.code] || '📋'}</div>
              <div className="product-card-name">{p.name}</div>
              <div className="product-card-id">ID: {p.productId}</div>
              {p.hasQuotation && <div className="product-card-quote">Quotation available</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <p className="section-heading">Policy Issuance Flow</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['1', 'Auth', 'Generate partner token + 25-use token pool', 'auth'],
            ['2', 'Quotation', 'Get premium quote (Care Enhance only)', 'quotation'],
            ['3', 'Create Policy', 'Submit proposal with member & KYC details', 'policy'],
            ['4', 'Payment', 'Redirect to CHI payment gateway', 'policy'],
            ['5', 'Status', 'Poll for policy status post-payment', 'status'],
            ['6', 'PDF', 'Download policy schedule PDF', 'pdf'],
          ].map(([num, title, desc, page]) => (
            <div key={num} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', background: '#f8fafc', borderRadius: 8, cursor: 'pointer' }}
              onClick={() => onNavigate(page as Page)}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#1a56db', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{num}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>{desc}</div>
              </div>
              <div style={{ marginLeft: 'auto', color: '#94a3b8' }}>→</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
