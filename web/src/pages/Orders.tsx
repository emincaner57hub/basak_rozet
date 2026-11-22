import { useEffect, useMemo, useState } from 'react';
import { api, CHANNEL_LABEL, ORDER_STATUS, type CatalogItem, type Channel, type Customer, type ImportPreview, type OrderDetail, type OrderFilter, type OrderSummary } from '../api';
import { Link, queryParam, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, IntInput, MoneyInput, Page, SearchSelect, Stat, fileToBase64, useLoad, useToast } from '../ui';
import { fmtNum, formatTL, today, trDate } from '../money';

export function OrdersTable({
  rows,
  showCustomer = true,
  selected,
  onToggle,
}: {
  rows: OrderSummary[];
  showCustomer?: boolean;
  /** Verilirse solda seçim kutuları çıkar (yalnız teslim edilebilir siparişler seçilir) */
  selected?: Set<number>;
  onToggle?: (ids: number[], on: boolean) => void;
}) {
  const { go } = useNav();
  const selecting = !!selected && !!onToggle;
  const selectable = rows.filter((o) => o.deliverable);
  const allOn = selectable.length > 0 && selectable.every((o) => selected?.has(o.id));
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            {selecting && (
              <th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Teslim edilebilenlerin tümünü seç"
                  title="Sevk edilmiş siparişlerin tümünü seç"
                  disabled={!selectable.length}
                  checked={allOn}
                  onChange={(e) => onToggle!(selectable.map((o) => o.id), e.target.checked)}
                />
              </th>
            )}
            <th>Sipariş</th>
            <th>Tarih</th>
            {showCustomer && <th>Müşteri</th>}
            <th>Kanal</th>
            <th className="text-right">Adet</th>
            <th className="text-right">Sevk</th>
            <th className="text-right">Tutar</th>
            <th>Durum</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const on = !!selected?.has(o.id);
            return (
              <tr
                key={o.id}
                className={`clickable ${selecting && !o.deliverable ? 'opacity-50' : ''} ${on ? 'bg-brand/5' : ''}`}
                onClick={() => (selecting ? o.deliverable && onToggle!([o.id], !on) : go(`/siparisler/${o.id}`))}
              >
                {selecting && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`${o.no} seç`}
                      title={o.deliverable ? undefined : o.status === 'delivered' ? 'Zaten teslim edildi' : 'Önce sevk edilmeli'}
                      disabled={!o.deliverable}
                      checked={on}
                      onChange={(e) => onToggle!([o.id], e.target.checked)}
                    />
                  </td>
                )}
                <td className="whitespace-nowrap font-medium">
                  {o.no}
                  {o.customerRef && <div className="text-xs font-normal text-muted">Ref: {o.customerRef}</div>}
                </td>
                <td>
                  {trDate(o.date)}
                  {o.requestedDate && <div className="text-xs text-muted">istenen {trDate(o.requestedDate)}</div>}
                </td>
                {showCustomer && (
                  <td>
                    {o.chainName && <div className="text-xs text-muted">{o.chainName}</div>}
                    {o.customerName}
                  </td>
                )}
                <td className="text-xs">
                  {CHANNEL_LABEL[o.channel]}
                  {o.portalUser && <div className="text-muted">{o.portalUser}</div>}
                  {o.isNew && (
                    <span className="ml-0 mt-0.5 inline-block">
                      <Badge tone="warn">yeni</Badge>
                    </span>
                  )}
                </td>
                <td className="tabular text-right">{fmtNum(o.qty)}</td>
                <td className="tabular text-right">{fmtNum(o.shipped)}</td>
                <td className="tabular text-right">{formatTL(o.total)}</td>
                <td>
                  <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>
                  {o.deliveredAt && <div className="mt-0.5 text-xs text-muted">{trDate(o.deliveredAt)}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <Empty>Sipariş yok.</Empty>}
    </>
  );
}

const STATUS_FILTERS: [OrderFilter, string][] = [
  ['pending', 'Bekleyenler (açık + kısmi)'],
  ['open', 'Açık'],
  ['partial', 'Kısmi sevk'],
  ['shipped', 'Sevk edildi'],
  ['delivered', 'Teslim edildi'],
  ['closed', 'Kapandı'],
  ['cancelled', 'İptal'],
  ['all', 'Tümü'],
];

/** Hızlı tarih aralıkları */
function presetRange(k: 'month' | 'lastMonth' | 'year'): [string, string] {
  const [y, m] = today().split('-').map(Number);
  const iso = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (k === 'month') return [iso(y, m, 1), iso(y, m, last(y, m))];
  if (k === 'lastMonth') {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    return [iso(py, pm, 1), iso(py, pm, last(py, pm))];
  }
  return [iso(y, 1, 1), iso(y, 12, 31)];
}

export function OrdersPage() {
  const { path, go } = useNav();
  const toast = useToast();
  const incoming = queryParam(path, 'durum') === 'gelen';
  const [status, setStatus] = useState<OrderFilter>(incoming ? 'all' : 'pending');
  const [portal, setPortal] = useState(incoming);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQd(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (queryParam(path, 'durum') === 'gelen') {
      setPortal(true);
      setStatus('all');
    }
  }, [path]);
  const filter = { status, portal, q: qd, from: from || undefined, to: to || undefined };
  const deps = [status, portal, qd, from, to];
  const { data, error, reload } = useLoad(() => api.orders(filter), deps);
  const sum = useLoad(() => api.orderSummary(filter), deps);
  const newCount = data?.filter((o) => o.isNew).length ?? 0;
  const toggle = (ids: number[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) on ? n.add(id) : n.delete(id);
      return n;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setErr('');
  };
  async function deliver() {
    setBusy(true);
    setErr('');
    try {
      const r = await api.deliverOrders([...selected]);
      toast(`${r.count} sipariş teslim edildi`);
      stopSelecting();
      reload();
      sum.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const rangeText = from || to ? `${from ? trDate(from) : '…'} – ${to ? trDate(to) : '…'}` : 'Tüm tarihler';
  return (
    <Page
      title="Siparişler"
      subtitle={
        portal
          ? `Müşterilerin satın almacılarının cepten verdiği siparişler${newCount ? ` · ${newCount} yeni (açılmamış)` : ''}`
          : "Panelden, telefon / WhatsApp ile girilen, Excel'den yüklenen ya da müşterinin cepten verdiği siparişler"
      }
      actions={
        selecting ? (
          <>
            <button className="btn" onClick={stopSelecting}>
              Vazgeç
            </button>
            <button className="btn btn-primary" disabled={!selected.size || busy} onClick={deliver}>
              Teslim edildi yap{selected.size ? ` (${selected.size})` : ''}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setSelecting(true)}>
              Teslim et
            </button>
            <button className="btn" onClick={() => go('/siparisler/excel')}>
              Excel'den yükle
            </button>
            <button className="btn btn-primary" onClick={() => go('/siparisler/yeni')}>
              + Yeni sipariş
            </button>
          </>
        )
      }
    >
      <ErrorLine error={error} />
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Stat label="Toplam adet" value={sum.data ? fmtNum(sum.data.qty) : '…'} sub={`${rangeText} · ${sum.data ? fmtNum(sum.data.count) : '…'} sipariş`} />
        <Stat label="Toplam satış (KDV hariç)" value={sum.data ? formatTL(sum.data.total) : '…'} sub="İptal edilen ve kapatılan kısım hariç" />
        <Stat label="Durum" value={STATUS_FILTERS.find(([v]) => v === status)?.[1] ?? ''} sub={portal ? 'Yalnız müşteriden gelenler' : 'Tüm kanallar'} />
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Başlangıç">
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Bitiş">
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="flex gap-1 pb-0.5">
          {(
            [
              ['month', 'Bu ay'],
              ['lastMonth', 'Geçen ay'],
              ['year', 'Bu yıl'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              className="btn btn-sm"
              onClick={() => {
                const [a, b] = presetRange(k);
                setFrom(a);
                setTo(b);
              }}
            >
              {l}
            </button>
          ))}
          {(from || to) && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Tüm tarihler
            </button>
          )}
        </div>
        <Field label="Durum">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as OrderFilter)}>
            {STATUS_FILTERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-1.5 pb-2 text-sm">
          <input type="checkbox" checked={portal} onChange={(e) => setPortal(e.target.checked)} /> Yalnız müşteriden gelen
        </label>
        <input className="input max-w-xs" placeholder="Sipariş no, müşteri, zincir, referans…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {selecting && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-brand/10 px-3 py-2 text-sm">
          <span>
            Teslim edilen siparişleri soldan işaretleyin, sonra <b>Teslim edildi yap</b>'a basın. Yalnız sevk edilmiş siparişler seçilebilir.
          </span>
          {status !== 'shipped' && (
            <button className="btn btn-sm ml-auto" onClick={() => setStatus('shipped')}>
              Yalnız sevk edilenleri göster
            </button>
          )}
        </div>
      )}
      {err && <div className="mb-3 text-sm text-bad">{err}</div>}
      <div className="card overflow-x-auto">{data && <OrdersTable rows={data} selected={selecting ? selected : undefined} onToggle={selecting ? toggle : undefined} />}</div>
      {data && data.length >= 500 && <div className="mt-2 text-xs text-muted">İlk 500 sipariş gösteriliyor; toplamlar tüm süzgece göre.</div>}
    </Page>
  );
}

// ---------- Sipariş formu (yeni ve düzenleme) ----------
type Line = { key: number; id?: number; productId: number | null; qty: number | null; unitPrice: number | null; shipped?: number };
let lineKey = 1;

function OrderForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: OrderDetail;
  onSaved: (id: number) => void;
  onCancel: () => void;
}) {
  const { path } = useNav();
  const customers = useLoad(() => api.customers(), []);
  const [customerId, setCustomerId] = useState<number | null>(initial?.customerId ?? (Number(queryParam(path, 'musteri')) || null));
  const [date, setDate] = useState(initial?.date ?? today());
  const [channel, setChannel] = useState<Channel>(initial?.channel ?? 'phone');
  const [requestedDate, setRequestedDate] = useState(initial?.requestedDate ?? '');
  const [customerRef, setCustomerRef] = useState(initial?.customerRef ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [lines, setLines] = useState<Line[]>(
    initial?.lines.map((l) => ({ key: lineKey++, id: l.id, productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, shipped: l.shipped })) ?? [{ key: lineKey++, productId: null, qty: null, unitPrice: null }],
  );
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!customerId) return setCatalog([]);
    api.catalog(customerId).then(setCatalog, (e) => setErr(e.message));
  }, [customerId]);
  const shipTo = (customers.data ?? []).filter((c) => c.kind !== 'chain' && c.active);
  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const upd = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const totals = lines.reduce(
    (s, l) => {
      const p = l.productId ? byId.get(l.productId) : undefined;
      const net = (l.qty ?? 0) * (l.unitPrice ?? 0);
      return { net: s.net + net, vat: s.vat + Math.round((net * (p?.vatRate ?? 20)) / 100), qty: s.qty + (l.qty ?? 0) };
    },
    { net: 0, vat: 0, qty: 0 },
  );
  const valid = customerId && lines.some((l) => l.productId && l.qty) && lines.every((l) => !l.productId || (l.qty && l.unitPrice != null));

  async function save() {
    setBusy(true);
    setErr('');
    const body = {
      date,
      channel,
      requestedDate: requestedDate || null,
      customerRef: customerRef || null,
      note: note || null,
      lines: lines.filter((l) => l.productId && l.qty).map((l) => ({ id: l.id, productId: l.productId!, qty: l.qty!, unitPrice: l.unitPrice })),
    };
    try {
      if (initial) {
        await api.updateOrder(initial.id, body);
        onSaved(initial.id);
      } else onSaved((await api.createOrder({ ...body, customerId: customerId! })).id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const customerLabel = (c: Customer) => (c.parentName ? `${c.parentName} · ${c.name}` : c.name);
  return (
    <>
      <div className="card mb-4 grid grid-cols-6 gap-3 p-4">
        <Field label="Müşteri (sevk yeri) *" className="col-span-3">
          <SearchSelect
            items={shipTo}
            value={customerId}
            disabled={!!initial}
            onChange={(id) => {
              setCustomerId(id);
              setLines([{ key: lineKey++, productId: null, qty: null, unitPrice: null }]);
            }}
            label={customerLabel}
            sub={(c) => [c.code, c.city, c.kind === 'branch' ? (c.billTo === 'parent' ? 'fatura merkeze' : 'franchise') : null].filter(Boolean).join(' · ')}
            placeholder="Şube ya da kafe ara…"
            ariaLabel="Müşteri"
          />
        </Field>
        <Field label="Tarih">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Kanal">
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {(Object.keys(CHANNEL_LABEL) as Channel[])
              .filter((c) => c !== 'portal')
              .map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
          </select>
        </Field>
        <Field label="İstenen teslim">
          <input type="date" className="input" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
        </Field>
        <Field label="Müşteri referansı" className="col-span-2">
          <input className="input" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} placeholder="ör. satın alma no" />
        </Field>
        <Field label="Not" className="col-span-4">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      <div className="card overflow-visible">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '42%' }}>Ürün</th>
              <th className="text-right">Stok</th>
              <th className="w-28 text-right">Adet</th>
              <th className="w-36 text-right">Birim fiyat (KDV hariç)</th>
              <th className="text-right">Tutar</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const p = l.productId ? byId.get(l.productId) : undefined;
              const used = new Set(lines.filter((x) => x.key !== l.key).map((x) => x.productId));
              return (
                <tr key={l.key}>
                  <td>
                    <SearchSelect
                      items={catalog.filter((c) => !used.has(c.id))}
                      value={l.productId}
                      disabled={!customerId}
                      onChange={(id, item) => upd(l.key, { productId: id, unitPrice: item ? (item.kind === 'promo' ? 0 : item.price) : null, qty: l.qty ?? null })}
                      label={(c) => `${c.code} · ${c.name}`}
                      sub={(c) => `${c.kind === 'promo' ? 'Promosyon · ' : ''}${c.special ? 'Özel fiyat ' : ''}${c.discount ? `%${fmtDisc(c.discount)} indirimli ` : ''}${formatTL(c.price)} · stok ${fmtNum(c.onHand)}`}
                      filter={(c, s) => `${c.code} ${c.name} ${c.category ?? ''}`.toLocaleLowerCase('tr').includes(s)}
                      placeholder={customerId ? 'Ürün kodu ya da adı…' : 'Önce müşteri seçin'}
                      ariaLabel="Ürün"
                    />
                    {p && (p.special || p.discount > 0) && (
                      <span className="mt-0.5 block text-[11px] text-brand">
                        {[p.special ? `Özel fiyat (liste ${formatTL(p.listPrice)})` : null, p.discount > 0 ? `%${fmtDisc(p.discount)} müşteri indirimi (${formatTL(p.basePrice)} yerine)` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className={`tabular text-right text-xs ${p && l.qty && p.onHand < l.qty ? 'font-semibold text-warn' : 'text-muted'}`}>{p ? fmtNum(p.onHand) : ''}</td>
                  <td>
                    <IntInput value={l.qty} onChange={(v) => upd(l.key, { qty: v })} ariaLabel="Adet" />
                    {l.shipped ? <span className="block text-right text-[11px] text-muted">sevk {l.shipped}</span> : null}
                  </td>
                  <td>
                    <MoneyInput value={l.unitPrice} onChange={(v) => upd(l.key, { unitPrice: v })} ariaLabel="Birim fiyat" />
                  </td>
                  <td className="tabular text-right">{formatTL((l.qty ?? 0) * (l.unitPrice ?? 0))}</td>
                  <td className="w-10 text-right">
                    <button
                      className="px-1 text-lg text-bad disabled:opacity-30"
                      disabled={!!l.shipped}
                      aria-label="Satırı sil"
                      onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [{ key: lineKey++, productId: null, qty: null, unitPrice: null }]))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-start justify-between gap-4 p-3">
          <button className="btn btn-sm" disabled={!customerId} onClick={() => setLines((ls) => [...ls, { key: lineKey++, productId: null, qty: null, unitPrice: null }])}>
            + Satır
          </button>
          <div className="w-64 text-sm">
            <Row k={`Ara toplam (${fmtNum(totals.qty)} adet)`} v={formatTL(totals.net)} />
            <Row k="KDV" v={formatTL(totals.vat)} />
            <Row k="Genel toplam" v={formatTL(totals.net + totals.vat)} bold />
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {err && <span className="mr-auto text-sm text-bad">{err}</span>}
        <button className="btn" onClick={onCancel}>
          Vazgeç
        </button>
        <button className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          {initial ? 'Değişiklikleri kaydet' : 'Siparişi kaydet'}
        </button>
      </div>
    </>
  );
}

const Row = ({ k, v, bold }: { k: string; v: string; bold?: boolean }) => (
  <div className={`flex justify-between py-0.5 ${bold ? 'border-t border-line pt-1.5 font-semibold' : 'text-muted'}`}>
    <span>{k}</span>
    <span className="tabular">{v}</span>
  </div>
);

export function OrderNewPage() {
  const { go } = useNav();
  const toast = useToast();
  return (
    <Page title="Yeni sipariş" back={<Link to="/siparisler">‹ Siparişler</Link>}>
      <OrderForm
        onCancel={() => history.back()}
        onSaved={(id) => {
          toast('Sipariş kaydedildi');
          go(`/siparisler/${id}`);
        }}
      />
    </Page>
  );
}

export function OrderPage({ id }: { id: number }) {
  const { data: o, error, reload } = useLoad(() => api.order(id), [id]);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'close' | 'reopen' | 'delete' | 'deliver' | 'undeliver' | null>(null);
  const { go } = useNav();
  const toast = useToast();
  if (!o) return <Page title="…">{<ErrorLine error={error} />}</Page>;
  const remaining = o.lines.reduce((s, l) => s + l.remaining, 0);
  if (editing)
    return (
      <Page title={`${o.no} · düzenle`} back={<Link to={`/siparisler/${o.id}`}>‹ {o.no}</Link>}>
        <OrderForm
          initial={o}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
            toast('Sipariş güncellendi');
          }}
        />
      </Page>
    );
  return (
    <Page
      back={<Link to="/siparisler">‹ Siparişler</Link>}
      title={
        <span className="flex items-center gap-2">
          {o.no} <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>
        </span>
      }
      subtitle={
        <>
          <Link to={`/musteriler/${o.customerId}`}>{o.chainName ? `${o.chainName} · ${o.customerName}` : o.customerName}</Link> · {trDate(o.date)} · {CHANNEL_LABEL[o.channel]}
          {o.portalUser && (
            <>
              {' '}
              · satın almacı <b>{o.portalUser}</b>
              {o.portalPhone && (
                <>
                  {' '}
                  (<a href={`tel:${o.portalPhone}`}>{o.portalPhone}</a>)
                </>
              )}
            </>
          )}
          {o.requestedDate && ` · istenen teslim ${trDate(o.requestedDate)}`}
          {o.deliveredAt && ` · teslim edildi ${trDate(o.deliveredAt)}`}
          {o.customerRef && ` · ref ${o.customerRef}`}
        </>
      }
      actions={
        <>
          {remaining > 0 && !o.cancelled && (
            <button className="btn btn-primary" onClick={() => go(`/sevkiyat/yeni?siparis=${o.id}`)}>
              Sevk et (irsaliye)
            </button>
          )}
          {(o.status === 'shipped' || o.status === 'closed') && (
            <button className="btn btn-primary" onClick={() => setConfirm('deliver')}>
              Teslim edildi
            </button>
          )}
          {o.status === 'delivered' && (
            <button className="btn" onClick={() => setConfirm('undeliver')}>
              Teslimi geri al
            </button>
          )}
          {!o.cancelled && o.status !== 'shipped' && o.status !== 'delivered' && (
            <button className="btn" onClick={() => setEditing(true)}>
              Düzenle
            </button>
          )}
          {!o.cancelled && remaining > 0 && (
            <button className="btn" onClick={() => setConfirm('close')}>
              {o.status === 'partial' ? 'Kalanı kapat' : 'İptal et'}
            </button>
          )}
          {o.cancelled && (
            <button className="btn" onClick={() => setConfirm('reopen')}>
              Yeniden aç
            </button>
          )}
          {!o.dispatches.length && (
            <button className="btn btn-danger" onClick={() => setConfirm('delete')}>
              Sil
            </button>
          )}
        </>
      }
    >
      {o.note && <div className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Not: {o.note}</div>}
      <div className="card mb-4 overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ürün</th>
              <th className="text-right">Sipariş</th>
              <th className="text-right">Sevk edilen</th>
              <th className="text-right">Kalan</th>
              <th className="text-right">Stok</th>
              <th className="text-right">Birim fiyat</th>
              <th className="text-right">Tutar</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <span className="font-medium">{l.code}</span> {l.name} {l.kind === 'promo' && <Badge>Promosyon</Badge>}
                </td>
                <td className="tabular text-right">{fmtNum(l.qty)}</td>
                <td className="tabular text-right">{fmtNum(l.shipped)}</td>
                <td className={`tabular text-right ${l.remaining ? 'font-semibold' : 'text-muted'}`}>{fmtNum(l.remaining)}</td>
                <td className={`tabular text-right ${l.remaining > l.onHand ? 'text-warn' : 'text-muted'}`}>{fmtNum(l.onHand)}</td>
                <td className="tabular text-right">{formatTL(l.unitPrice)}</td>
                <td className="tabular text-right">{formatTL(l.qty * l.unitPrice)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} className="px-3 py-2 text-right text-sm text-muted">
                Toplam (KDV hariç)
              </td>
              <td className="tabular px-3 py-2 text-right font-semibold">{formatTL(o.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <h3 className="mb-2 text-sm font-semibold">İrsaliyeler</h3>
      <div className="card overflow-hidden">
        <table className="tbl">
          <tbody>
            {o.dispatches.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => go(`/sevkiyat/${d.id}`)}>
                <td className="font-medium">{d.no}</td>
                <td>{trDate(d.date)}</td>
                <td className="tabular text-right">{fmtNum(d.qty)} adet</td>
                <td>{d.cancelled ? <Badge>İptal</Badge> : d.invoiceNo ? <Badge tone="ok">Fatura {d.invoiceNo}</Badge> : <Badge tone="warn">Faturalanmadı</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!o.dispatches.length && <Empty>Henüz sevk yok.</Empty>}
      </div>
      {confirm && (
        <Confirm
          title={
            confirm === 'delete'
              ? 'Siparişi sil'
              : confirm === 'reopen'
                ? 'Siparişi yeniden aç'
                : confirm === 'deliver'
                  ? 'Teslim edildi'
                  : confirm === 'undeliver'
                    ? 'Teslimi geri al'
                    : 'Siparişi kapat'
          }
          text={
            confirm === 'delete'
              ? 'Sipariş tamamen silinir.'
              : confirm === 'reopen'
                ? 'Sevk edilmeyen kısım yeniden bekleyenlere döner.'
                : confirm === 'deliver'
                  ? 'Sipariş bugünün tarihiyle teslim edildi olarak işaretlenir.'
                  : confirm === 'undeliver'
                    ? 'Sipariş yeniden "sevk edildi" durumuna döner.'
                    : 'Sevk edilmeyen kısım iptal edilir; sevk edilenler kalır.'
          }
          danger={confirm === 'delete' || confirm === 'close'}
          onClose={() => setConfirm(null)}
          onYes={async () => {
            if (confirm === 'delete') {
              await api.deleteOrder(o.id);
              go('/siparisler');
            } else if (confirm === 'deliver') {
              await api.deliverOrders([o.id]);
              reload();
            } else if (confirm === 'undeliver') {
              await api.undeliverOrder(o.id);
              reload();
            } else {
              await api.closeOrder(o.id, confirm === 'close');
              reload();
            }
          }}
        />
      )}
    </Page>
  );
}

// ---------- Excel ----------
export function ExcelImportPage() {
  const customers = useLoad(() => api.customers(), []);
  const [chainId, setChainId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [date, setDate] = useState(today());
  const [requestedDate, setRequestedDate] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const { go } = useNav();
  const toast = useToast();
  const chains = (customers.data ?? []).filter((c) => c.kind === 'chain');
  const singles = (customers.data ?? []).filter((c) => c.kind !== 'chain');

  async function load(f: { name: string; data: string } | null, chain = chainId, cust = customerId) {
    setPreview(null);
    setErr('');
    if (!f) return;
    setBusy(true);
    try {
      setPreview(await api.importPreview({ data: f.data, chainId: chain, customerId: cust }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const total = preview?.orders.reduce((s, o) => s + o.total, 0) ?? 0;
  const units = preview?.orders.reduce((s, o) => s + o.lines.reduce((a, l) => a + l.qty, 0), 0) ?? 0;

  return (
    <Page title="Excel'den sipariş yükle" back={<Link to="/siparisler">‹ Siparişler</Link>} subtitle="Zincirin gönderdiği tablodan her şube için ayrı sipariş açılır">
      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">1. Kimin dosyası?</h3>
          <p className="mb-3 text-xs text-muted">Zincir seçerseniz şube adları yalnız o zincirde aranır. Tek kafe dosyasında kafeyi seçin.</p>
          <Field label="Zincir" className="mb-2">
            <SearchSelect
              items={chains}
              value={chainId}
              onChange={(id) => {
                setChainId(id);
                setCustomerId(null);
                load(file, id, null);
              }}
              label={(c) => c.name}
              placeholder="(isteğe bağlı)"
            />
          </Field>
          <Field label="ya da tek müşteri">
            <SearchSelect
              items={singles}
              value={customerId}
              onChange={(id) => {
                setCustomerId(id);
                setChainId(null);
                load(file, null, id);
              }}
              label={(c) => (c.parentName ? `${c.parentName} · ${c.name}` : c.name)}
              placeholder="(isteğe bağlı)"
            />
          </Field>
        </div>
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">2. Şablon (isteğe bağlı)</h3>
          <p className="mb-3 text-xs text-muted">
            Satırlarda şubeler, sütunlarda ürün kodları olan boş tablo. Zincire gönderin, doldurup geri yollasınlar. Kendi formatları da olur: “Şube · Ürün kodu · Adet” sütunlu liste ya da şube × ürün tablosu.
          </p>
          <a className="btn" href={api.templateUrl(chainId)}>
            Şablonu indir{chainId ? ` (${chains.find((c) => c.id === chainId)?.name})` : ''}
          </a>
        </div>
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">3. Dosyayı seçin</h3>
          <p className="mb-3 text-xs text-muted">Excel (.xlsx). İlk sayfa okunur.</p>
          <input
            type="file"
            accept=".xlsx"
            className="block w-full text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const v = { name: f.name, data: await fileToBase64(f) };
              setFile(v);
              load(v);
            }}
          />
          {busy && <p className="mt-2 text-sm text-muted">Okunuyor…</p>}
        </div>
      </div>
      <ErrorLine error={err} />
      {preview && (
        <>
          {preview.errors.length > 0 && (
            <div className="mb-4 rounded-xl border border-bad/30 bg-bad-soft p-3 text-sm">
              <div className="mb-1 font-semibold text-bad">{preview.errors.length} sorun var — düzeltip dosyayı tekrar seçin</div>
              <ul className="list-disc pl-5 text-bad">
                {preview.errors.slice(0, 30).map((e, i) => (
                  <li key={i}>
                    {e.row ? `Satır ${e.row}: ` : ''}
                    {e.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">İpucu: Müşteri ekranında şubelere kod verirseniz eşleştirme kesinleşir. Ürünler ürün koduyla ya da tam adıyla eşleşir.</p>
            </div>
          )}
          <div className="card mb-4 overflow-hidden">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm">
              <b>{preview.orders.length} sipariş</b>
              <span className="text-muted">
                {fmtNum(units)} adet · {formatTL(total)} (KDV hariç) · {preview.format === 'wide' ? 'şube × ürün tablosu' : 'satır listesi'}
              </span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Müşteri</th>
                  <th>Ürünler</th>
                  <th className="text-right">Adet</th>
                  <th className="text-right">Tutar</th>
                </tr>
              </thead>
              <tbody>
                {preview.orders.map((o) => (
                  <tr key={o.customerId}>
                    <td className="font-medium">{o.customerName}</td>
                    <td className="text-xs">{o.lines.map((l) => `${l.code} × ${l.qty}`).join(', ')}</td>
                    <td className="tabular text-right">{fmtNum(o.lines.reduce((s, l) => s + l.qty, 0))}</td>
                    <td className="tabular text-right">{formatTL(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card flex flex-wrap items-end gap-3 p-4">
            <Field label="Sipariş tarihi">
              <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="İstenen teslim">
              <input type="date" className="input" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
            </Field>
            <Field label="Not" className="min-w-[240px] flex-1">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ör. Kasım siparişi" />
            </Field>
            <button
              className="btn btn-primary"
              disabled={busy || !!preview.errors.length || !preview.orders.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.importOrders({ data: file!.data, chainId, customerId, date, requestedDate: requestedDate || null, note: note || null });
                  toast(`${r.orders.length} sipariş oluşturuldu`);
                  go('/siparisler');
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {preview.orders.length} siparişi oluştur
            </button>
          </div>
        </>
      )}
    </Page>
  );
}

const fmtDisc = (n: number) => n.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
