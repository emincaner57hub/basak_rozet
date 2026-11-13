import { useEffect, useState, type ReactNode } from 'react';
import { api, type User } from './api';
import { Router, match, useNav, Link } from './router';
import { ToastHost } from './ui';
import Dashboard from './pages/Dashboard';
import { OrdersPage, OrderPage, OrderNewPage, ExcelImportPage } from './pages/Orders';
import { DispatchesPage, DispatchPage, DispatchNewPage } from './pages/Dispatches';
import { InvoicesPage, InvoicePage, EdmImportPage, InvoiceNewPage } from './pages/Invoices';
import { PaymentsPage } from './pages/Payments';
import { CustomersPage, CustomerPage } from './pages/Customers';
import { ProductsPage, ProductPage } from './pages/Products';
import { LotsPage, LotPage } from './pages/Lots';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { PrintDispatch, PrintInvoice } from './pages/Print';

const NAV: { to: string; label: string; icon: string; group?: string }[] = [
  { to: '/', label: 'Panel', icon: '◧' },
  { to: '/siparisler', label: 'Siparişler', icon: '✎', group: 'Satış' },
  { to: '/sevkiyat', label: 'İrsaliyeler', icon: '⇪', group: 'Satış' },
  { to: '/faturalar', label: 'Faturalar', icon: '₺', group: 'Satış' },
  { to: '/tahsilat', label: 'Tahsilat', icon: '⇩', group: 'Satış' },
  { to: '/musteriler', label: 'Müşteriler', icon: '☕', group: 'Kayıtlar' },
  { to: '/urunler', label: 'Ürünler ve stok', icon: '✪', group: 'Kayıtlar' },
  { to: '/alimlar', label: 'Alımlar', icon: '✈', group: 'Kayıtlar' },
  { to: '/raporlar', label: 'Raporlar', icon: '▤', group: 'Analiz' },
  { to: '/ayarlar', label: 'Ayarlar', icon: '⚙', group: 'Analiz' },
];

function Routes() {
  const { path } = useNav();
  const m = (p: string) => match(p, path);
  let r: ReturnType<typeof match>;
  if ((r = m('/yazdir/irsaliye/:id'))) return <PrintDispatch id={Number(r.id)} />;
  if ((r = m('/yazdir/fatura/:id'))) return <PrintInvoice id={Number(r.id)} />;
  let page: ReactNode = <Dashboard />;
  if (m('/siparisler')) page = <OrdersPage />;
  else if (m('/siparisler/yeni')) page = <OrderNewPage />;
  else if (m('/siparisler/excel')) page = <ExcelImportPage />;
  else if ((r = m('/siparisler/:id'))) page = <OrderPage id={Number(r.id)} />;
  else if (m('/sevkiyat')) page = <DispatchesPage />;
  else if (m('/sevkiyat/yeni')) page = <DispatchNewPage />;
  else if ((r = m('/sevkiyat/:id'))) page = <DispatchPage id={Number(r.id)} />;
  else if (m('/faturalar')) page = <InvoicesPage />;
  else if (m('/faturalar/yeni')) page = <InvoiceNewPage />;
  else if (m('/faturalar/edm')) page = <EdmImportPage />;
  else if ((r = m('/faturalar/:id'))) page = <InvoicePage id={Number(r.id)} />;
  else if (m('/tahsilat')) page = <PaymentsPage />;
  else if (m('/musteriler')) page = <CustomersPage />;
  else if ((r = m('/musteriler/:id'))) page = <CustomerPage id={Number(r.id)} />;
  else if (m('/urunler')) page = <ProductsPage />;
  else if ((r = m('/urunler/:id'))) page = <ProductPage id={Number(r.id)} />;
  else if (m('/alimlar')) page = <LotsPage />;
  else if (m('/alimlar/yeni')) page = <LotPage id={null} />;
  else if ((r = m('/alimlar/:id'))) page = <LotPage id={Number(r.id)} />;
  else if (m('/raporlar')) page = <ReportsPage />;
  else if (m('/ayarlar')) page = <SettingsPage />;
  return <Shell>{page}</Shell>;
}

let currentUser: User | null = null;
export const getUser = () => currentUser;

function Shell({ children }: { children: ReactNode }) {
  const { path } = useNav();
  const active = (to: string) => (to === '/' ? path.split('?')[0] === '/' : path.startsWith(to));
  let lastGroup: string | undefined;
  return (
    <div className="flex min-h-full">
      <aside className="no-print sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-card">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <div className="text-[15px] font-semibold leading-tight">Başak Rozet</div>
            <div className="text-[11px] text-muted">sipariş · stok · cari</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3 scroll-thin">
          {NAV.map((n) => {
            const head = n.group && n.group !== lastGroup ? n.group : null;
            lastGroup = n.group;
            return (
              <div key={n.to}>
                {head && <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted/80">{head}</div>}
                <Link
                  to={n.to}
                  className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${active(n.to) ? 'bg-brand-soft font-semibold text-brand' : 'text-ink/80 hover:bg-paper'}`}
                >
                  <span className="w-4 text-center opacity-70">{n.icon}</span>
                  {n.label}
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="border-t border-line px-4 py-3 text-xs">
          <div className="truncate font-medium">{currentUser?.name}</div>
          <div className="flex items-center justify-between text-muted">
            <span className="truncate">{currentUser?.email}</span>
            <button className="hover:text-bad" onClick={() => api.logout().finally(() => location.assign('/'))}>
              Çıkış
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function Login({ onDone }: { onDone: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        className="card w-full max-w-sm p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            onDone((await api.login(email, password)).user);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <div>
            <div className="text-lg font-semibold">Başak Rozet</div>
            <div className="text-xs text-muted">Giriş yapın</div>
          </div>
        </div>
        <label className="label">E-posta</label>
        <input className="input mb-3" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <label className="label">Şifre</label>
        <input className="input mb-4" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="mb-3 text-sm text-bad">{err}</p>}
        <button className="btn btn-primary w-full" disabled={busy || !email || !password}>
          Giriş
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<'loading' | 'login' | 'ok'>('loading');
  useEffect(() => {
    api.session().then(
      (s) => {
        currentUser = s.user;
        setState(s.user ? 'ok' : 'login');
      },
      () => setState('login'),
    );
    const on = () => setState('login');
    window.addEventListener('rozet:unauthorized', on);
    return () => window.removeEventListener('rozet:unauthorized', on);
  }, []);
  if (state === 'loading') return null;
  if (state === 'login')
    return (
      <Login
        onDone={(u) => {
          currentUser = u;
          setState('ok');
        }}
      />
    );
  return (
    <ToastHost>
      <Router>
        <Routes />
      </Router>
    </ToastHost>
  );
}
