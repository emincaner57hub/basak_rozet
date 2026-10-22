import { useEffect, useMemo, useState } from 'react';
import { api, type CatalogItem, type OrderDetail } from '../api';
import { Link, queryParam, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, IntInput, Modal, Page, SearchSelect, useLoad, useToast } from '../ui';
import { fmtNum, formatTL, formatUnit, today, trDate } from '../money';

export function DispatchesPage() {
  const [filter, setFilter] = useState<'all' | '0'>('all');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQd(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error } = useLoad(() => api.dispatches({ invoiced: filter === '0' ? '0' : undefined, q: qd }), [filter, qd]);
  const { go } = useNav();
  return (
    <Page
      title="İrsaliyeler"
      subtitle="Sevk edilen mal stoktan düşer; fatura sonra, faturanın kesileceği müşteriye toplu kesilir"
      actions={
        <button className="btn btn-primary" onClick={() => go('/sevkiyat/yeni')}>
          + Siparişsiz irsaliye
        </button>
      }
    >
      <ErrorLine error={error} />
      <div className="mb-3 flex items-center gap-2">
        <div className="flex rounded-lg border border-line bg-card p-0.5">
          {(
            [
              ['all', 'Tümü'],
              ['0', 'Faturalanmayanlar'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => setFilter(v)} className={`rounded-md px-3 py-1.5 text-sm ${filter === v ? 'bg-brand text-white' : 'text-muted'}`}>
              {l}
            </button>
          ))}
        </div>
        <input className="input max-w-xs" placeholder="İrsaliye no, müşteri…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>İrsaliye</th>
              <th>Tarih</th>
              <th>Sevk yeri</th>
              <th>Fatura kesilecek</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Tutar</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.id} className={`clickable ${d.cancelled ? 'opacity-50' : ''}`} onClick={() => go(`/sevkiyat/${d.id}`)}>
                <td className="whitespace-nowrap font-medium">
                  {d.no}
                  {d.orderNo && <div className="text-xs font-normal text-muted">{d.orderNo}</div>}
                </td>
                <td>{trDate(d.date)}</td>
                <td>
                  {d.chainName && <div className="text-xs text-muted">{d.chainName}</div>}
                  {d.customerName}
                </td>
                <td className="text-sm">{d.billToName}</td>
                <td className="tabular text-right">
                  {fmtNum(d.qty)}
                  {d.promoQty > 0 && <div className="text-[11px] text-muted">+{d.promoQty} promosyon</div>}
                </td>
                <td className="tabular text-right">{formatTL(d.total)}</td>
                <td>{d.cancelled ? <Badge>İptal</Badge> : d.invoiceNo ? <Badge tone="ok">{d.invoiceNo}</Badge> : <Badge tone="warn">Faturalanmadı</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>İrsaliye yok. Sipariş sayfasından “Sevk et” ile oluşturulur.</Empty>}
      </div>
    </Page>
  );
}

type DLine = { key: number; productId: number | null; qty: number | null; orderLineId?: number; max?: number; ordered?: number };
let k = 1;

export function DispatchNewPage() {
  const { path, go } = useNav();
  const toast = useToast();
  const orderId = Number(queryParam(path, 'siparis')) || null;
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const customers = useLoad(() => api.customers(), []);
  const [customerId, setCustomerId] = useState<number | null>(Number(queryParam(path, 'musteri')) || null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [lines, setLines] = useState<DLine[]>([]);
  const [date, setDate] = useState(today());
  const [carrier, setCarrier] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    api.order(orderId).then((o) => {
      setOrder(o);
      setCustomerId(o.customerId);
      setLines(o.lines.filter((l) => l.remaining > 0).map((l) => ({ key: k++, productId: l.productId, qty: Math.min(l.remaining, Math.max(l.onHand, 0)) || l.remaining, orderLineId: l.id, max: l.remaining, ordered: l.qty })));
    }, (e) => setErr(e.message));
  }, [orderId]);
  useEffect(() => {
    if (customerId) api.catalog(customerId).then(setCatalog, (e) => setErr(e.message));
  }, [customerId]);
  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const upd = (key: number, patch: Partial<DLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const promos = catalog.filter((p) => p.kind === 'promo');
  const shipTo = (customers.data ?? []).filter((c) => c.kind !== 'chain' && c.active);
  const cust = (customers.data ?? []).find((c) => c.id === customerId);
  const valid = customerId && lines.some((l) => l.productId && l.qty) && lines.every((l) => !l.productId || !l.qty || !l.max || l.qty <= l.max);
  const net = lines.reduce((s, l) => {
    const p = l.productId ? byId.get(l.productId) : null;
    const price = l.orderLineId ? (order?.lines.find((x) => x.id === l.orderLineId)?.unitPrice ?? 0) : p?.kind === 'promo' ? 0 : (p?.price ?? 0);
    return s + (l.qty ?? 0) * price;
  }, 0);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      const r = await api.createDispatch({
        date,
        customerId: customerId!,
        orderId,
        carrier: carrier || null,
        trackingNo: trackingNo || null,
        note: note || null,
        lines: lines.filter((l) => l.productId && l.qty).map((l) => ({ productId: l.productId!, qty: l.qty!, orderLineId: l.orderLineId ?? null })),
      });
      toast(`${r.no} oluşturuldu, stoktan düştü`);
      go(`/sevkiyat/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title={order ? `${order.no} · sevk` : 'Yeni irsaliye'}
      back={order ? <Link to={`/siparisler/${order.id}`}>‹ {order.no}</Link> : <Link to="/sevkiyat">‹ İrsaliyeler</Link>}
      subtitle={cust && (cust.kind === 'branch' ? `Fatura: ${cust.billTo === 'parent' ? `${cust.parentName} (merkez)` : `${cust.name} (franchise)`}` : `Fatura: ${cust.name}`)}
    >
      <div className="card mb-4 grid grid-cols-5 gap-3 p-4">
        <Field label="Sevk yeri" className="col-span-2">
          <SearchSelect
            items={shipTo}
            value={customerId}
            disabled={!!orderId}
            onChange={(id) => {
              setCustomerId(id);
              setLines([]);
            }}
            label={(c) => (c.parentName ? `${c.parentName} · ${c.name}` : c.name)}
            placeholder="Şube / kafe"
          />
        </Field>
        <Field label="Sevk tarihi">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Kargo firması">
          <input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="ör. Yurtiçi" />
        </Field>
        <Field label="Takip no">
          <input className="input" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
        </Field>
        <Field label="Not" className="col-span-5">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="card overflow-visible">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '45%' }}>Ürün</th>
              <th className="text-right">Sipariş / kalan</th>
              <th className="text-right">Stok</th>
              <th className="w-28 text-right">Sevk adedi</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const p = l.productId ? byId.get(l.productId) : undefined;
              const over = l.max != null && (l.qty ?? 0) > l.max;
              return (
                <tr key={l.key}>
                  <td>
                    {l.orderLineId ? (
                      <span>
                        <b>{p?.code}</b> {p?.name}
                      </span>
                    ) : (
                      <SearchSelect
                        items={catalog}
                        value={l.productId}
                        onChange={(id) => upd(l.key, { productId: id })}
                        label={(c) => `${c.code} · ${c.name}`}
                        sub={(c) => `${c.kind === 'promo' ? 'Promosyon (0 ₺) · ' : ''}stok ${fmtNum(c.onHand)}`}
                        placeholder="Ürün ya da promosyon…"
                      />
                    )}
                    {p?.kind === 'promo' && <Badge tone="brand">Promosyon · faturaya girmez, müşteri giderine yazılır</Badge>}
                  </td>
                  <td className="tabular text-right text-muted">{l.max != null ? `${fmtNum(l.ordered)} / ${fmtNum(l.max)}` : '—'}</td>
                  <td className={`tabular text-right ${p && (l.qty ?? 0) > p.onHand ? 'font-semibold text-warn' : 'text-muted'}`}>{p ? fmtNum(p.onHand) : ''}</td>
                  <td>
                    <IntInput value={l.qty} onChange={(v) => upd(l.key, { qty: v })} className={over ? 'border-bad' : ''} ariaLabel="Sevk adedi" />
                  </td>
                  <td className="w-10 text-right">
                    <button className="px-1 text-lg text-bad" aria-label="Satırı sil" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <button className="btn btn-sm" disabled={!customerId} onClick={() => setLines((ls) => [...ls, { key: k++, productId: null, qty: 1 }])}>
            + Ürün satırı
          </button>
          {promos.map((p) => (
            <button key={p.id} className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { key: k++, productId: p.id, qty: 1 }])}>
              + {p.name}
            </button>
          ))}
          <span className="ml-auto text-sm text-muted">
            İrsaliye tutarı (KDV hariç): <b className="tabular text-ink">{formatTL(net)}</b>
          </span>
        </div>
      </div>
      {lines.some((l) => {
        const p = l.productId ? byId.get(l.productId) : undefined;
        return p && (l.qty ?? 0) > p.onHand;
      }) && <p className="mt-3 text-sm text-warn">Bazı ürünlerde stok yetersiz görünüyor. Kaydederseniz stok eksiye düşer (alım partisi henüz girilmemiş olabilir).</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        {err && <span className="mr-auto text-sm text-bad">{err}</span>}
        <button className="btn" onClick={() => history.back()}>
          Vazgeç
        </button>
        <button className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          İrsaliyeyi oluştur
        </button>
      </div>
    </Page>
  );
}

export function DispatchPage({ id }: { id: number }) {
  const { data: d, error, reload } = useLoad(() => api.dispatch(id), [id]);
  const [cancel, setCancel] = useState(false);
  const [ship, setShip] = useState(false);
  const { go } = useNav();
  if (!d) return <Page title="…">{<ErrorLine error={error} />}</Page>;
  const sale = d.lines.filter((l) => !l.isPromo);
  const promo = d.lines.filter((l) => l.isPromo);
  const cost = sale.reduce((s, l) => s + l.qty * (l.unitCost ?? 0), 0);
  const promoCost = promo.reduce((s, l) => s + l.qty * (l.unitCost ?? 0), 0);
  return (
    <Page
      back={<Link to="/sevkiyat">‹ İrsaliyeler</Link>}
      title={
        <span className="flex items-center gap-2">
          {d.no} {d.cancelled ? <Badge>İptal</Badge> : d.invoiceNo ? <Badge tone="ok">Fatura {d.invoiceNo}</Badge> : <Badge tone="warn">Faturalanmadı</Badge>}
        </span>
      }
      subtitle={
        <>
          {trDate(d.date)}
          {d.orderNo && (
            <>
              {' · '}
              <Link to={`/siparisler/${d.orderId}`}>{d.orderNo}</Link>
            </>
          )}
          {d.carrier && ` · ${d.carrier}`}
          {d.trackingNo && ` · takip ${d.trackingNo}`}
        </>
      }
      actions={
        <>
          <a className="btn" href={`/yazdir/irsaliye/${d.id}`} target="_blank" rel="noreferrer">
            Yazdır
          </a>
          {!d.cancelled && !d.invoiceId && (
            <button className="btn btn-primary" onClick={() => go(`/faturalar/yeni?musteri=${d.billToId}`)}>
              Fatura kes
            </button>
          )}
          {d.invoiceId && (
            <button className="btn" onClick={() => go(`/faturalar/${d.invoiceId}`)}>
              Faturayı aç
            </button>
          )}
          <button className="btn" onClick={() => setShip(true)}>
            Kargo bilgisi
          </button>
          {!d.cancelled && !d.invoiceId && (
            <button className="btn btn-danger" onClick={() => setCancel(true)}>
              İptal et
            </button>
          )}
        </>
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className="card p-4 text-sm">
          <div className="label">Sevk yeri</div>
          <div className="font-semibold">{d.chainName ? `${d.chainName} · ${d.customerName}` : d.customerName}</div>
          <div className="text-muted">{[d.customerAddress, d.customerCity].filter(Boolean).join(', ') || 'Adres girilmemiş'}</div>
          {(d.customerContact || d.customerPhone) && <div className="text-muted">{[d.customerContact, d.customerPhone].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="card p-4 text-sm">
          <div className="label">Fatura kesilecek</div>
          <Link to={`/musteriler/${d.billToId}`}>{d.billToLegalName ?? d.billToName}</Link>
          <div className="text-muted">{d.billToTaxId ? `${d.billToTaxOffice ?? ''} VD · ${d.billToTaxId}` : 'Vergi no eksik'}</div>
        </div>
        <div className="card p-4 text-sm">
          <div className="label">Tutar ve maliyet</div>
          <div className="flex justify-between">
            <span>Satış (KDV hariç)</span>
            <b className="tabular">{formatTL(d.total)}</b>
          </div>
          <div className="flex justify-between text-muted">
            <span>Ürün maliyeti</span>
            <span className="tabular">{formatTL(cost)}</span>
          </div>
          <div className="flex justify-between text-muted">
            <span>Promosyon maliyeti</span>
            <span className="tabular">{formatTL(promoCost)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold">
            <span>Brüt kâr</span>
            <span className="tabular">{formatTL(d.total - cost - promoCost)}</span>
          </div>
        </div>
      </div>
      {d.note && <div className="mb-3 rounded-lg bg-paper px-3 py-2 text-sm">Not: {d.note}</div>}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ürün</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Birim fiyat</th>
              <th className="text-right">Tutar</th>
              <th className="text-right">Birim maliyet</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <b>{l.code}</b> {l.name} {l.isPromo && <Badge tone="brand">Promosyon</Badge>}
                </td>
                <td className="tabular text-right">{fmtNum(l.qty)}</td>
                <td className="tabular text-right">{formatTL(l.unitPrice)}</td>
                <td className="tabular text-right">{formatTL(l.qty * l.unitPrice)}</td>
                <td className="tabular text-right text-muted">{formatUnit(l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cancel && (
        <Confirm
          title="İrsaliyeyi iptal et"
          text="Ürünler stoka geri girer, sipariş tekrar sevk bekler."
          danger
          yes="İptal et"
          onClose={() => setCancel(false)}
          onYes={async () => {
            await api.cancelDispatch(d.id);
            reload();
          }}
        />
      )}
      {ship && <ShippingDialog d={d} onClose={() => setShip(false)} onSaved={reload} />}
    </Page>
  );
}

function ShippingDialog({ d, onClose, onSaved }: { d: { id: number; carrier: string | null; trackingNo: string | null; note: string | null }; onClose: () => void; onSaved: () => void }) {
  const [carrier, setCarrier] = useState(d.carrier ?? '');
  const [trackingNo, setTrackingNo] = useState(d.trackingNo ?? '');
  const [note, setNote] = useState(d.note ?? '');
  return (
    <Modal
      title="Kargo bilgisi"
      onClose={onClose}
      width={440}
      footer={
        <button
          className="btn btn-primary"
          onClick={async () => {
            await api.updateShipping(d.id, { carrier: carrier || null, trackingNo: trackingNo || null, note: note || null });
            onSaved();
            onClose();
          }}
        >
          Kaydet
        </button>
      }
    >
      <Field label="Kargo firması" className="mb-2">
        <input className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
      </Field>
      <Field label="Takip no" className="mb-2">
        <input className="input" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
      </Field>
      <Field label="Not">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
