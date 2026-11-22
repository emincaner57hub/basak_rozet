import { useEffect, type ReactNode } from 'react';
import { api, CHANNEL_LABEL, ORDER_STATUS, type OrderFilter } from '../api';
import { queryParam, useNav } from '../router';
import { useLoad } from '../ui';
import { fmtNum, formatTL, trDate } from '../money';

/** A4 çıktı: irsaliye ve fatura (e-belge değil; kayıt / sevk evrakı olarak) */

function Sheet({ title, no, date, children, ready }: { title: string; no: string; date: string; children: ReactNode; ready: boolean }) {
  const { data: s } = useLoad(() => api.settings(), []);
  useEffect(() => {
    if (ready && s) {
      document.title = `${title} ${no}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [ready, s, title, no]);
  return (
    <div className="min-h-full bg-paper py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] justify-end gap-2">
        <button className="btn" onClick={() => window.close()}>
          Kapat
        </button>
        <button className="btn btn-primary" onClick={() => window.print()}>
          Yazdır
        </button>
      </div>
      <div className="mx-auto max-w-[210mm] bg-white p-[14mm] text-[12px] leading-snug text-black shadow print:max-w-none print:p-0 print:shadow-none">
        <div className="mb-6 flex items-start justify-between border-b-2 border-black pb-3">
          <div>
            <div className="text-lg font-bold">{s?.companyLegalName || s?.companyName}</div>
            <div className="whitespace-pre-line">{s?.companyAddress}</div>
            <div>{[s?.companyPhone, s?.companyEmail].filter(Boolean).join(' · ')}</div>
            {s?.companyTaxId && (
              <div>
                {s.companyTaxOffice} VD · {s.companyTaxId}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tracking-wide">{title}</div>
            <div className="mt-1">
              No: <b>{no}</b>
            </div>
            <div>Tarih: {trDate(date)}</div>
          </div>
        </div>
        {children}
        {title === 'FATURA' && (s?.companyIban || s?.invoiceNote) && (
          <div className="mt-6 border-t border-black/30 pt-2">
            {s?.companyIban && <div>IBAN: {s.companyIban}</div>}
            {s?.invoiceNote && <div className="whitespace-pre-line">{s.invoiceNote}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const Box = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded border border-black/40 p-2">
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-black/60">{title}</div>
    {children}
  </div>
);

export function PrintDispatch({ id }: { id: number }) {
  const { data: d } = useLoad(() => api.dispatch(id), [id]);
  const { data: me } = useLoad(() => api.settings(), []);
  if (!d || !me) return null;
  const firm = d.billToLegalName ?? d.chainName ?? d.billToName;
  const total = d.lines.reduce((s, l) => s + l.qty, 0);
  return (
    <Sheet title="SEVK İRSALİYESİ" no={d.no} date={d.date} ready>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Box title="Teslim edilen firma">
          <div className="font-semibold">{firm}</div>
          {d.chainName && (
            <div>
              Şube: <b>{d.customerName}</b>
            </div>
          )}
          {!d.chainName && d.customerLegalName && d.customerLegalName !== firm && <div>{d.customerName}</div>}
          {d.billToTaxId && (
            <div>
              {d.billToTaxOffice ? `${d.billToTaxOffice} VD · ` : ''}VKN {d.billToTaxId}
            </div>
          )}
        </Box>
        <Box title="Teslim adresi">
          <div>{[d.customerAddress, d.customerCity].filter(Boolean).join(', ') || '—'}</div>
          {(d.customerContact || d.customerPhone) && <div>{[d.customerContact, d.customerPhone].filter(Boolean).join(' · ')}</div>}
        </Box>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1">
        <span>Sevk tarihi: {trDate(d.date)}</span>
        {d.orderNo && <span>Sipariş: {d.orderNo}</span>}
        {d.customerRef && <span>Müşteri ref: {d.customerRef}</span>}
        {d.carrier && <span>Taşıyıcı: {d.carrier}</span>}
        {d.trackingNo && <span>Takip: {d.trackingNo}</span>}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="w-8 py-1">#</th>
            <th className="w-28 py-1">Kod</th>
            <th className="py-1">Ürün</th>
            <th className="w-20 py-1 text-right">Miktar</th>
            <th className="w-14 py-1 pl-2">Birim</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.id} className="border-b border-black/20">
              <td className="py-1.5">{i + 1}</td>
              <td className="py-1.5">{l.code}</td>
              <td className="py-1.5">
                {l.name}
                {l.isPromo && ' (bedelsiz)'}
              </td>
              <td className="py-1.5 text-right font-semibold">{fmtNum(l.qty)}</td>
              <td className="py-1.5 pl-2">{l.unit}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-black">
            <td colSpan={3} className="py-1.5 text-right">
              Toplam
            </td>
            <td className="py-1.5 text-right font-bold">{fmtNum(total)}</td>
            <td className="py-1.5 pl-2">adet</td>
          </tr>
        </tfoot>
      </table>
      {d.note && <div className="mt-3">Not: {d.note}</div>}
      <p className="mt-6 text-[11px]">Yukarıda yazılı ürünler eksiksiz ve hasarsız teslim edilmiş / teslim alınmıştır.</p>
      <div className="mt-3 grid grid-cols-2 gap-6">
        <Signature title="Teslim eden" firm={me.companyLegalName || me.companyName} />
        <Signature title="Teslim alan" firm={d.chainName ? `${firm} · ${d.customerName}` : firm} />
      </div>
    </Sheet>
  );
}

function Signature({ title, firm }: { title: string; firm: string }) {
  const line = (label: string) => (
    <div className="flex items-end gap-2 pt-5">
      <span className="w-16 shrink-0">{label}</span>
      <span className="flex-1 border-b border-dotted border-black" />
    </div>
  );
  return (
    <div className="rounded border border-black/60 p-3">
      <div className="text-[13px] font-bold uppercase tracking-wide">{title}</div>
      <div className="mt-0.5">{firm}</div>
      {line('Ad Soyad')}
      {line('Tarih')}
      {line('İmza')}
    </div>
  );
}

export function PrintInvoice({ id }: { id: number }) {
  const { data: inv } = useLoad(() => api.invoice(id), [id]);
  if (!inv) return null;
  return (
    <Sheet title="FATURA" no={inv.eInvoiceNo ?? inv.no} date={inv.date} ready>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Box title="Sayın">
          <div className="font-semibold">{inv.legalName ?? inv.customerName}</div>
          <div>{[inv.address, inv.city].filter(Boolean).join(', ')}</div>
          <div>
            {inv.taxOffice} VD · {inv.taxId}
          </div>
        </Box>
        <Box title="Fatura">
          <div>Kayıt no: {inv.no}</div>
          {inv.eInvoiceNo && <div>e-Fatura no: {inv.eInvoiceNo}</div>}
          <div>Vade: {trDate(inv.dueDate)}</div>
          <div>İrsaliyeler: {inv.dispatches.map((d) => `${d.no} (${trDate(d.date)})`).join(', ')}</div>
        </Box>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="py-1">Açıklama</th>
            <th className="py-1 text-right">Miktar</th>
            <th className="py-1 text-right">Birim fiyat</th>
            <th className="py-1 text-right">KDV</th>
            <th className="py-1 text-right">Tutar</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id} className="border-b border-black/20">
              <td className="py-1">{l.description}</td>
              <td className="py-1 text-right">{fmtNum(l.qty)}</td>
              <td className="py-1 text-right">{formatTL(l.unitPrice)}</td>
              <td className="py-1 text-right">%{l.vatRate}</td>
              <td className="py-1 text-right">{formatTL(l.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-3 w-64">
        <div className="flex justify-between">
          <span>Ara toplam</span>
          <span>{formatTL(inv.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>KDV</span>
          <span>{formatTL(inv.vatTotal)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-black pt-1 text-sm font-bold">
          <span>Genel toplam</span>
          <span>{formatTL(inv.total)}</span>
        </div>
      </div>
      {inv.note && <div className="mt-4">Not: {inv.note}</div>}
    </Sheet>
  );
}

const FILTER_TEXT: Record<OrderFilter, string> = {
  pending: 'Bekleyenler (açık + kısmi)',
  all: 'Tümü',
  open: 'Açık',
  partial: 'Kısmi sevk',
  shipped: 'Sevk edildi',
  delivered: 'Teslim edildi',
  closed: 'Kapandı',
  cancelled: 'İptal',
};

/** Sipariş listesi çıktısı (yatay A4): ekrandaki süzgeçle; tarayıcıda "PDF olarak kaydet" ile PDF olur */
export function PrintOrders() {
  const { path } = useNav();
  const qp = (k: string) => queryParam(path, k) || undefined;
  const filter = { status: (qp('status') ?? 'pending') as OrderFilter, portal: qp('portal') === '1', q: qp('q'), from: qp('from'), to: qp('to') };
  const key = JSON.stringify(filter);
  const { data: rows } = useLoad(() => api.orders({ ...filter, all: true }), [key]);
  const { data: sum } = useLoad(() => api.orderSummary(filter), [key]);
  const { data: s } = useLoad(() => api.settings(), []);
  const ready = !!(rows && sum && s);
  const range = filter.from || filter.to ? `${filter.from ? trDate(filter.from) : '…'} – ${filter.to ? trDate(filter.to) : '…'}` : 'Tüm tarihler';
  useEffect(() => {
    if (!ready) return;
    document.title = `Siparişler ${range}`;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [ready, range]);
  if (!ready) return null;
  return (
    <div className="min-h-full bg-paper py-6 print:bg-white print:py-0">
      <style>{'@page { size: A4 landscape; margin: 10mm; }'}</style>
      <div className="no-print mx-auto mb-3 flex max-w-[297mm] items-center justify-end gap-2">
        <span className="mr-auto text-sm text-muted">PDF için yazdırma penceresinde hedef olarak "PDF olarak kaydet"i seçin.</span>
        <button className="btn" onClick={() => window.close()}>
          Kapat
        </button>
        <button className="btn btn-primary" onClick={() => window.print()}>
          Yazdır / PDF
        </button>
      </div>
      <div className="mx-auto max-w-[297mm] bg-white p-[10mm] text-[11px] leading-snug text-black shadow print:max-w-none print:p-0 print:shadow-none">
        <div className="mb-3 flex items-end justify-between border-b-2 border-black pb-2">
          <div>
            <div className="text-base font-bold">{s.companyLegalName || s.companyName}</div>
            <div>
              {range} · Durum: {FILTER_TEXT[filter.status]}
              {filter.portal ? ' · Yalnız müşteriden gelen' : ''}
              {filter.q ? ` · Arama: ${filter.q}` : ''}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold tracking-wide">SİPARİŞ LİSTESİ</div>
            <div>Döküm tarihi: {trDate(new Date().toISOString().slice(0, 10))}</div>
          </div>
        </div>
        <div className="mb-3 flex gap-8">
          <div>
            Sipariş: <b>{fmtNum(sum.count)}</b>
          </div>
          <div>
            Toplam adet: <b>{fmtNum(sum.qty)}</b>
          </div>
          <div>
            Toplam satış (KDV hariç): <b>{formatTL(sum.total)}</b>
          </div>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-black text-left">
              <th className="py-1">Sipariş no</th>
              <th className="py-1">Tarih</th>
              <th className="py-1">Müşteri</th>
              <th className="py-1">Kanal</th>
              <th className="py-1">Ref</th>
              <th className="py-1 text-right">Adet</th>
              <th className="py-1 text-right">Sevk</th>
              <th className="py-1 text-right">Tutar</th>
              <th className="py-1 pl-3">Durum</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="break-inside-avoid border-b border-black/20">
                <td className="py-1 font-medium">{o.no}</td>
                <td className="py-1">{trDate(o.date)}</td>
                <td className="py-1">{o.chainName ? `${o.chainName} · ${o.customerName}` : o.customerName}</td>
                <td className="py-1">{CHANNEL_LABEL[o.channel]}</td>
                <td className="py-1">{o.customerRef ?? ''}</td>
                <td className="py-1 text-right">{fmtNum(o.qty)}</td>
                <td className="py-1 text-right">{fmtNum(o.shipped)}</td>
                <td className="py-1 text-right">{formatTL(o.total)}</td>
                <td className="py-1 pl-3">
                  {ORDER_STATUS[o.status].label}
                  {o.deliveredAt ? ` ${trDate(o.deliveredAt)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black font-semibold">
              <td className="py-1" colSpan={5}>
                Toplam (iptal edilen ve kapatılan kısım hariç)
              </td>
              <td className="py-1 text-right">{fmtNum(sum.qty)}</td>
              <td />
              <td className="py-1 text-right">{formatTL(sum.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {!rows.length && <div className="py-6 text-center">Bu süzgeçte sipariş yok.</div>}
      </div>
    </div>
  );
}
