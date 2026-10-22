import { useEffect, type ReactNode } from 'react';
import { api } from '../api';
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
  if (!d) return null;
  return (
    <Sheet title="SEVK İRSALİYESİ" no={d.no} date={d.date} ready>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Box title="Teslim yeri">
          <div className="font-semibold">{d.chainName ? `${d.chainName} · ${d.customerName}` : d.customerName}</div>
          <div>{[d.customerAddress, d.customerCity].filter(Boolean).join(', ')}</div>
          <div>{[d.customerContact, d.customerPhone].filter(Boolean).join(' · ')}</div>
        </Box>
        <Box title="Alıcı (fatura)">
          <div className="font-semibold">{d.billToLegalName ?? d.billToName}</div>
          <div>{[d.billToAddress, d.billToCity].filter(Boolean).join(', ')}</div>
          {d.billToTaxId && (
            <div>
              {d.billToTaxOffice} VD · {d.billToTaxId}
            </div>
          )}
        </Box>
      </div>
      <div className="mb-3 flex gap-6">
        <span>Sevk tarihi: {trDate(d.date)}</span>
        {d.orderNo && <span>Sipariş: {d.orderNo}</span>}
        {d.customerRef && <span>Müşteri ref: {d.customerRef}</span>}
        {d.carrier && <span>Taşıyıcı: {d.carrier}</span>}
        {d.trackingNo && <span>Takip: {d.trackingNo}</span>}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="py-1">#</th>
            <th className="py-1">Kod</th>
            <th className="py-1">Açıklama</th>
            <th className="py-1 text-right">Miktar</th>
            <th className="py-1 pl-2">Birim</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.id} className="border-b border-black/20">
              <td className="py-1">{i + 1}</td>
              <td className="py-1">{l.code}</td>
              <td className="py-1">
                {l.name}
                {l.isPromo && ' (promosyon, bedelsiz)'}
              </td>
              <td className="py-1 text-right">{fmtNum(l.qty)}</td>
              <td className="py-1 pl-2">{l.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-right">Toplam: {fmtNum(d.lines.reduce((s, l) => s + l.qty, 0))} adet</div>
      {d.note && <div className="mt-3">Not: {d.note}</div>}
      <div className="mt-16 grid grid-cols-2 gap-10 text-center">
        <div className="border-t border-black pt-1">Teslim eden</div>
        <div className="border-t border-black pt-1">Teslim alan (ad, imza)</div>
      </div>
    </Sheet>
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
