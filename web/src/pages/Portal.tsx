import { useEffect, useMemo, useState } from 'react';
import { ORDER_STATUS, type OrderStatus } from '../api';
import { formatTL, today, trDate } from '../money';
import { Badge } from '../ui';

/**
 * Müşteri portalı (cepte, uygulama değil): satın almacı kendi kodu ve şifresiyle girer, atandığı şubelere sipariş verir.
 * Ekip arayüzünden bağımsız; kendi oturumu (/api/portal/*).
 */

interface Branch {
  id: number;
  name: string;
  chainName: string | null;
  city: string | null;
  address: string | null;
}
interface Item {
  id: number;
  code: string;
  name: string;
  category: string | null;
  unit: string;
  vatRate: number;
  price: number;
  image: string | null;
}
interface MyOrder {
  id: number;
  no: string;
  date: string;
  requestedDate: string | null;
  customerRef: string | null;
  customerName: string;
  byName: string | null;
  qty: number;
  shipped: number;
  total: number;
  status: OrderStatus;
}
interface MyOrderDetail extends MyOrder {
  note: string | null;
  lines: { code: string; name: string; unit: string; qty: number; unitPrice: number; shipped: number }[];
}

async function preq<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw Object.assign(new Error(data?.error ?? `Hata (${r.status})`), { status: r.status });
  return data as T;
}

const branchLabel = (b: Branch) => (b.chainName ? `${b.chainName} · ${b.name}` : b.name);
const STATUS_TEXT: Record<OrderStatus, string> = { open: 'Alındı', partial: 'Kısmen gönderildi', shipped: 'Gönderildi', closed: 'Kapandı', cancelled: 'İptal' };

export default function PortalApp() {
  const [state, setState] = useState<'loading' | 'login' | 'ok'>('loading');
  const [me, setMe] = useState<{ name: string; code: string } | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tab, setTab] = useState<'order' | 'mine'>('order');
  const load = () =>
    preq<{ user: { name: string; code: string } | null; customers: Branch[] }>('GET', '/api/portal/session').then(
      (s) => {
        setMe(s.user);
        setBranches(s.customers);
        setState(s.user ? 'ok' : 'login');
      },
      () => setState('login'),
    );
  useEffect(() => {
    document.title = 'Başak Rozet · Sipariş';
    load();
  }, []);
  if (state === 'loading') return null;
  if (state === 'login') return <PortalLogin onDone={load} />;
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col bg-paper pb-[calc(64px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-card px-4 py-3">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight">Başak Rozet</div>
          <div className="truncate text-xs text-muted">{me?.name}</div>
        </div>
        <button className="text-sm text-muted" onClick={() => preq('POST', '/api/portal/logout').finally(() => setState('login'))}>
          Çıkış
        </button>
      </header>
      {tab === 'order' ? <OrderTab branches={branches} onSent={() => setTab('mine')} /> : <MineTab />}
      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-w-xl border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
        {(
          [
            ['order', '🛒', 'Sipariş ver'],
            ['mine', '📦', 'Siparişlerim'],
          ] as const
        ).map(([k, i, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`flex-1 py-2.5 text-xs font-semibold ${tab === k ? 'text-brand' : 'text-muted'}`}>
            <div className="text-xl leading-6">{i}</div>
            {l}
          </button>
        ))}
      </nav>
    </div>
  );
}

function PortalLogin({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center p-5">
      <form
        className="card w-full max-w-sm p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await preq('POST', '/api/portal/login', { code, password });
            onDone();
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
            <div className="text-xs text-muted">Sipariş girişi</div>
          </div>
        </div>
        <label className="label">Kullanıcı kodu</label>
        <input className="input mb-3 text-base" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        <label className="label">Şifre</label>
        <input className="input mb-4 text-base" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="mb-3 text-sm text-bad">{err}</p>}
        <button className="btn btn-primary w-full py-3 text-base" disabled={busy || !code || !password}>
          Giriş
        </button>
      </form>
    </div>
  );
}

function OrderTab({ branches, onSent }: { branches: Branch[]; onSent: () => void }) {
  const [branchId, setBranchId] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('portal.branch'));
      return branches.some((b) => b.id === v) ? v : (branches[0]?.id ?? null);
    } catch {
      return branches[0]?.id ?? null;
    }
  });
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Record<number, number>>({});
  const [review, setReview] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!branchId) return;
    try {
      localStorage.setItem('portal.branch', String(branchId));
    } catch {
      /* özel pencere */
    }
    setItems(null);
    setErr('');
    preq<Item[]>('GET', `/api/portal/catalog?customerId=${branchId}`).then(setItems, (e) => setErr(e.message));
  }, [branchId]);
  const shown = useMemo(() => {
    const s = q.trim().toLocaleLowerCase('tr');
    return (items ?? []).filter((p) => !s || `${p.code} ${p.name} ${p.category ?? ''}`.toLocaleLowerCase('tr').includes(s));
  }, [items, q]);
  const lines = (items ?? []).filter((p) => cart[p.id] > 0);
  const total = lines.reduce((s, p) => s + p.price * cart[p.id], 0);
  const count = lines.reduce((s, p) => s + cart[p.id], 0);
  const setQty = (id: number, n: number) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(100000, Math.round(n || 0))) }));

  if (!branches.length) return <div className="card m-4 p-5 text-sm">Size henüz şube atanmamış. Başak Rozet'e haber verin.</div>;
  if (done)
    return (
      <div className="card m-4 p-6 text-center">
        <div className="mb-2 text-4xl">✅</div>
        <div className="text-lg font-semibold">Siparişiniz alındı</div>
        <div className="mt-1 text-muted">
          Sipariş no <b className="text-ink">{done}</b>
        </div>
        <button className="btn btn-primary mt-5 w-full py-3" onClick={onSent}>
          Siparişlerime git
        </button>
        <button className="btn mt-2 w-full py-3" onClick={() => setDone(null)}>
          Yeni sipariş
        </button>
      </div>
    );
  const branch = branches.find((b) => b.id === branchId);
  return (
    <div className="flex-1">
      <div className="sticky top-[57px] z-10 space-y-2 border-b border-line bg-paper px-4 py-3">
        {branches.length > 1 ? (
          <select
            className="input text-base"
            value={branchId ?? ''}
            onChange={(e) => {
              if (count && !confirm('Şube değişince sepet boşalır. Devam?')) return;
              setCart({});
              setBranchId(Number(e.target.value));
            }}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchLabel(b)}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-sm">
            Teslim: <b>{branch && branchLabel(branch)}</b>
          </div>
        )}
        <input className="input text-base" placeholder="Ürün ara…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <p className="m-4 text-sm text-bad">{err}</p>}
      {!items && !err && <p className="m-4 text-sm text-muted">Yükleniyor…</p>}
      <ul className="divide-y divide-line">
        {shown.map((p) => {
          const n = cart[p.id] ?? 0;
          return (
            <li key={p.id} className={`flex items-center gap-3 px-4 py-3 ${n ? 'bg-brand-soft/40' : 'bg-card'}`}>
              {p.image ? <img src={p.image} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" /> : <div className="h-14 w-14 shrink-0 rounded-lg bg-paper" />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="text-xs text-muted">
                  {p.code} · {formatTL(p.price)} / {p.unit} <span className="opacity-70">+KDV</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center">
                {n > 0 && (
                  <button className="h-10 w-10 rounded-l-lg border border-line bg-card text-xl" onClick={() => setQty(p.id, n - 1)} aria-label="Azalt">
                    −
                  </button>
                )}
                {n > 0 && (
                  <input
                    className="h-10 w-14 border-y border-line bg-card text-center text-base tabular-nums"
                    inputMode="numeric"
                    value={n}
                    onChange={(e) => setQty(p.id, Number(e.target.value.replace(/\D/g, '')))}
                  />
                )}
                <button className={`h-10 w-10 border border-line text-xl ${n ? 'rounded-r-lg bg-card' : 'rounded-lg bg-brand text-white'}`} onClick={() => setQty(p.id, n + 1)} aria-label="Ekle">
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {items && !shown.length && <p className="m-4 text-sm text-muted">Ürün bulunamadı.</p>}
      {count > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mx-auto max-w-xl px-3 pb-2">
          <button className="btn btn-primary flex w-full items-center justify-between py-3.5 text-base shadow-lg" onClick={() => setReview(true)}>
            <span>
              {lines.length} ürün · {count} adet
            </span>
            <span>{formatTL(total)} + KDV ›</span>
          </button>
        </div>
      )}
      {review && branch && (
        <Review
          branch={branch}
          lines={lines.map((p) => ({ ...p, qty: cart[p.id] }))}
          onClose={() => setReview(false)}
          onDone={(no) => {
            setCart({});
            setReview(false);
            setDone(no);
          }}
        />
      )}
    </div>
  );
}

function Review({ branch, lines, onClose, onDone }: { branch: Branch; lines: (Item & { qty: number })[]; onClose: () => void; onDone: (no: string) => void }) {
  const [requestedDate, setRequestedDate] = useState(today(1));
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const net = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const vat = lines.reduce((s, l) => s + Math.round((l.price * l.qty * l.vatRate) / 100), 0);
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={onClose}>
      <div className="mx-auto max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-card p-5 pb-[calc(20px+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 text-lg font-semibold">Siparişi onayla</h2>
          <button className="text-2xl text-muted" onClick={onClose} aria-label="Kapat">
            ×
          </button>
        </div>
        <div className="mb-3 text-sm">
          Teslim: <b>{branchLabel(branch)}</b>
          {branch.address && <div className="text-xs text-muted">{branch.address}</div>}
        </div>
        <ul className="mb-3 divide-y divide-line rounded-lg border border-line text-sm">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate">
                {l.qty} × {l.name}
              </span>
              <span className="tabular-nums">{formatTL(l.price * l.qty)}</span>
            </li>
          ))}
          <li className="flex justify-between px-3 py-2 text-muted">
            <span>KDV</span>
            <span className="tabular-nums">{formatTL(vat)}</span>
          </li>
          <li className="flex justify-between px-3 py-2 font-semibold">
            <span>Toplam</span>
            <span className="tabular-nums">{formatTL(net + vat)}</span>
          </li>
        </ul>
        <label className="label">İstenen teslim tarihi</label>
        <input className="input mb-3 text-base" type="date" min={today()} value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
        <label className="label">Sipariş referansınız (isteğe bağlı)</label>
        <input className="input mb-3 text-base" value={ref} onChange={(e) => setRef(e.target.value)} />
        <label className="label">Not (isteğe bağlı)</label>
        <textarea className="input mb-4 text-base" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        {err && <p className="mb-3 text-sm text-bad">{err}</p>}
        <button
          className="btn btn-primary w-full py-3.5 text-base"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              const r = await preq<{ no: string }>('POST', '/api/portal/orders', {
                customerId: branch.id,
                requestedDate: requestedDate || null,
                customerRef: ref || null,
                note: note || null,
                lines: lines.map((l) => ({ productId: l.id, qty: l.qty })),
              });
              onDone(r.no);
            } catch (e) {
              setErr((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? 'Gönderiliyor…' : 'Siparişi gönder'}
        </button>
      </div>
    </div>
  );
}

function MineTab() {
  const [rows, setRows] = useState<MyOrder[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<MyOrderDetail | null>(null);
  useEffect(() => {
    preq<MyOrder[]>('GET', '/api/portal/orders').then(setRows, (e) => setErr(e.message));
  }, []);
  if (open)
    return (
      <div className="p-4">
        <button className="mb-3 text-sm text-brand" onClick={() => setOpen(null)}>
          ‹ Siparişlerim
        </button>
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-lg font-semibold">{open.no}</div>
            <Badge tone={ORDER_STATUS[open.status].tone}>{STATUS_TEXT[open.status]}</Badge>
          </div>
          <div className="text-sm text-muted">
            {open.customerName} · {trDate(open.date)}
            {open.requestedDate && ` · istenen ${trDate(open.requestedDate)}`}
          </div>
          {open.note && <div className="mt-2 text-sm">Not: {open.note}</div>}
          <ul className="mt-3 divide-y divide-line text-sm">
            {open.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2 py-2">
                <span className="min-w-0">
                  {l.name}
                  <div className="text-xs text-muted">
                    {l.qty} {l.unit} · gönderilen {Math.min(l.shipped, l.qty)}
                  </div>
                </span>
                <span className="tabular-nums">{formatTL(l.qty * l.unitPrice)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  return (
    <div className="p-4">
      {err && <p className="text-sm text-bad">{err}</p>}
      {rows && !rows.length && <div className="card p-5 text-sm text-muted">Henüz siparişiniz yok.</div>}
      <ul className="space-y-2">
        {rows?.map((o) => (
          <li key={o.id}>
            <button
              className="card flex w-full items-center gap-3 p-4 text-left"
              onClick={() => preq<MyOrderDetail>('GET', `/api/portal/orders/${o.id}`).then(setOpen, (e) => setErr(e.message))}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {o.no} <span className="text-sm font-normal text-muted">· {trDate(o.date)}</span>
                </div>
                <div className="truncate text-sm text-muted">
                  {o.customerName} · {o.qty} adet{o.byName ? ` · ${o.byName}` : ''}
                </div>
              </div>
              <div className="text-right">
                <Badge tone={ORDER_STATUS[o.status].tone}>{STATUS_TEXT[o.status]}</Badge>
                <div className="mt-1 text-sm tabular-nums">{formatTL(o.total)}</div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
