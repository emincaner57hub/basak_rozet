import { useEffect, useMemo, useState } from 'react';
import { api, INVOICE_STATUS, type DispatchSummary } from '../api';
import { Link, queryParam, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, Modal, Page, SearchSelect, Stat, useLoad, useToast } from '../ui';
import { fmtNum, formatTL, today, trDate } from '../money';
import { PaymentDialog } from './Payments';

export function InvoicesPage() {
  const [status, setStatus] = useState<'all' | 'open' | 'overdue'>('all');
  const { data, error } = useLoad(() => api.invoices({ status }), [status]);
  const pending = useLoad(() => api.pendingInvoices(), []);
  const { go } = useNav();
  const open = (data ?? []).reduce((s, i) => s + i.remaining, 0);
  return (
    <Page
      title="Faturalar"
      subtitle="İrsaliyelerden kesilir; tahsilatlar faturaları eskiden yeniye kapatır"
      actions={
        <button className="btn btn-primary" onClick={() => go('/faturalar/yeni')}>
          + Fatura kes
        </button>
      }
    >
      <ErrorLine error={error} />
      {pending.data && pending.data.length > 0 && (
        <div className="card mb-4 overflow-hidden">
          <div className="border-b border-line bg-warn-soft px-4 py-2 text-sm font-semibold text-warn">Fatura bekleyen sevkiyatlar</div>
          <table className="tbl">
            <tbody>
              {pending.data.map((p) => (
                <tr key={p.customerId}>
                  <td className="font-medium">{p.name}</td>
                  <td className="text-sm text-muted">
                    {p.dispatchCount} irsaliye · en eski {trDate(p.oldest)}
                  </td>
                  <td className="tabular text-right">{formatTL(p.net)} + KDV</td>
                  <td className="w-32 text-right">
                    <button className="btn btn-sm btn-primary" onClick={() => go(`/faturalar/yeni?musteri=${p.customerId}`)}>
                      Fatura kes
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex rounded-lg border border-line bg-card p-0.5">
          {(
            [
              ['all', 'Tümü'],
              ['open', 'Ödenmemiş'],
              ['overdue', 'Vadesi geçmiş'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => setStatus(v)} className={`rounded-md px-3 py-1.5 text-sm ${status === v ? 'bg-brand text-white' : 'text-muted'}`}>
              {l}
            </button>
          ))}
        </div>
        {status !== 'all' && <span className="text-sm text-muted">Kalan toplam: <b className="text-ink">{formatTL(open)}</b></span>}
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Fatura</th>
              <th>Tarih</th>
              <th>Müşteri</th>
              <th>Vade</th>
              <th className="text-right">Toplam</th>
              <th className="text-right">Kalan</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id} className={`clickable ${i.cancelled ? 'opacity-50' : ''}`} onClick={() => go(`/faturalar/${i.id}`)}>
                <td className="whitespace-nowrap font-medium">
                  {i.no}
                  {i.eInvoiceNo && <div className="text-xs font-normal text-muted">e-Fatura {i.eInvoiceNo}</div>}
                </td>
                <td>{trDate(i.date)}</td>
                <td>{i.customerName}</td>
                <td className={i.daysOverdue ? 'font-semibold text-bad' : ''}>
                  {trDate(i.dueDate)}
                  {i.daysOverdue > 0 && <div className="text-xs">{i.daysOverdue} gün gecikti</div>}
                </td>
                <td className="tabular text-right">{formatTL(i.total)}</td>
                <td className="tabular text-right">{i.remaining ? formatTL(i.remaining) : '—'}</td>
                <td>
                  <Badge tone={i.daysOverdue ? 'bad' : INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Fatura yok.</Empty>}
      </div>
    </Page>
  );
}

export function InvoiceNewPage() {
  const { path, go } = useNav();
  const toast = useToast();
  const customers = useLoad(() => api.customers(), []);
  const pending = useLoad(() => api.pendingInvoices(), []);
  const [customerId, setCustomerId] = useState<number | null>(Number(queryParam(path, 'musteri')) || null);
  const [list, setList] = useState<DispatchSummary[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!customerId) return setList([]);
    api.dispatches({ invoiced: '0', billToId: customerId }).then((l) => {
      setList(l);
      setSel(new Set(l.map((d) => d.id)));
    });
  }, [customerId]);
  const billable = (customers.data ?? []).filter((c) => c.billable);
  const cust = billable.find((c) => c.id === customerId);
  const net = list.filter((d) => sel.has(d.id)).reduce((s, d) => s + d.total, 0);
  const pendingIds = useMemo(() => new Set((pending.data ?? []).map((p) => p.customerId)), [pending.data]);
  return (
    <Page title="Fatura kes" back={<Link to="/faturalar">‹ Faturalar</Link>} subtitle="Faturalanmamış irsaliyeler seçilir; satırlar ürün ve fiyat bazında toplanır, promosyon satırları faturaya girmez">
      <div className="card mb-4 grid grid-cols-4 gap-3 p-4">
        <Field label="Fatura kesilecek müşteri" className="col-span-2">
          <SearchSelect
            items={[...billable].sort((a, b) => Number(pendingIds.has(b.id)) - Number(pendingIds.has(a.id)))}
            value={customerId}
            onChange={(id) => setCustomerId(id)}
            label={(c) => c.name}
            sub={(c) => (pendingIds.has(c.id) ? 'Fatura bekleyen irsaliyesi var' : c.kind === 'chain' ? 'Zincir (merkez)' : c.kind === 'branch' ? 'Franchise' : 'Tek kafe')}
          />
        </Field>
        <Field label="Fatura tarihi">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Vade" hint={cust ? `${cust.paymentDays} gün` : undefined}>
          <input className="input" disabled value={cust ? trDate(new Date(Date.parse(date) + cust.paymentDays * 86_400_000).toISOString()) : ''} />
        </Field>
        <Field label="Not" className="col-span-4">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {cust && !cust.taxId && <ErrorLine error={`${cust.name} için vergi numarası girilmemiş. Müşteri kartından ekleyin.`} />}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-10">
                <input type="checkbox" checked={list.length > 0 && sel.size === list.length} onChange={(e) => setSel(new Set(e.target.checked ? list.map((d) => d.id) : []))} />
              </th>
              <th>İrsaliye</th>
              <th>Tarih</th>
              <th>Sevk yeri</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Tutar (KDV hariç)</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={sel.has(d.id)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(d.id);
                      else n.delete(d.id);
                      setSel(n);
                    }}
                  />
                </td>
                <td className="font-medium">
                  <Link to={`/sevkiyat/${d.id}`}>{d.no}</Link>
                </td>
                <td>{trDate(d.date)}</td>
                <td>{d.customerName}</td>
                <td className="tabular text-right">{fmtNum(d.qty)}</td>
                <td className="tabular text-right">{formatTL(d.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {customerId && !list.length && <Empty>Bu müşterinin faturalanmamış irsaliyesi yok.</Empty>}
        {!customerId && <Empty>Müşteri seçin.</Empty>}
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {err && <span className="mr-auto text-sm text-bad">{err}</span>}
        <span className="text-sm text-muted">
          {sel.size} irsaliye · <b className="text-ink">{formatTL(net)}</b> + KDV
        </span>
        <button
          className="btn btn-primary"
          disabled={!sel.size || busy || !cust?.taxId}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              const r = await api.createInvoice({ customerId: customerId!, date, dispatchIds: [...sel], note: note || null });
              toast(`${r.no} kesildi · ${formatTL(r.total)}`);
              go(`/faturalar/${r.id}`);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Faturayı oluştur
        </button>
      </div>
    </Page>
  );
}

export function InvoicePage({ id }: { id: number }) {
  const { data: inv, error, reload } = useLoad(() => api.invoice(id), [id]);
  const [cancel, setCancel] = useState(false);
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  if (!inv) return <Page title="…">{<ErrorLine error={error} />}</Page>;
  return (
    <Page
      back={<Link to="/faturalar">‹ Faturalar</Link>}
      title={
        <span className="flex items-center gap-2">
          {inv.no} <Badge tone={inv.daysOverdue ? 'bad' : INVOICE_STATUS[inv.status].tone}>{INVOICE_STATUS[inv.status].label}</Badge>
        </span>
      }
      subtitle={
        <>
          <Link to={`/musteriler/${inv.customerId}`}>{inv.customerName}</Link> · {trDate(inv.date)} · vade {trDate(inv.dueDate)}
          {inv.daysOverdue > 0 && <span className="font-semibold text-bad"> · {inv.daysOverdue} gün gecikti</span>}
        </>
      }
      actions={
        <>
          <a className="btn" href={`/yazdir/fatura/${inv.id}`} target="_blank" rel="noreferrer">
            Yazdır
          </a>
          {!inv.cancelled && inv.remaining > 0 && (
            <button className="btn btn-primary" onClick={() => setPay(true)}>
              Tahsilat gir
            </button>
          )}
          <button className="btn" onClick={() => setEdit(true)}>
            e-Fatura no / not
          </button>
          {!inv.cancelled && (
            <button className="btn btn-danger" onClick={() => setCancel(true)}>
              İptal et
            </button>
          )}
        </>
      }
    >
      <div className="mb-4 grid grid-cols-4 gap-3">
        <Stat label="Toplam" value={formatTL(inv.total)} sub={`${formatTL(inv.subtotal)} + KDV ${formatTL(inv.vatTotal)}`} />
        <Stat label="Ödenen" value={formatTL(inv.paid)} tone={inv.paid ? 'ok' : undefined} />
        <Stat label="Kalan" value={formatTL(inv.remaining)} tone={inv.remaining ? (inv.daysOverdue ? 'bad' : 'warn') : undefined} />
        <Stat label="e-Fatura no" value={inv.eInvoiceNo ?? '—'} sub={inv.eInvoiceNo ? '' : 'Entegratörde kestikten sonra girin'} />
      </div>
      <div className="card mb-4 overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Açıklama</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Birim fiyat</th>
              <th className="text-right">Tutar</th>
              <th className="text-right">KDV</th>
              <th className="text-right">Toplam</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="tabular text-right">{fmtNum(l.qty)}</td>
                <td className="tabular text-right">{formatTL(l.unitPrice)}</td>
                <td className="tabular text-right">{formatTL(l.net)}</td>
                <td className="tabular text-right text-muted">
                  %{l.vatRate} · {formatTL(l.vat)}
                </td>
                <td className="tabular text-right">{formatTL(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4 text-sm">
          <div className="label">Fatura bilgileri</div>
          <div className="font-semibold">{inv.legalName ?? inv.customerName}</div>
          <div className="text-muted">
            {inv.taxOffice} VD · {inv.taxId}
          </div>
          <div className="text-muted">{[inv.address, inv.city].filter(Boolean).join(', ')}</div>
          {inv.note && <div className="mt-2">Not: {inv.note}</div>}
        </div>
        <div className="card p-4 text-sm">
          <div className="label">İrsaliyeler</div>
          {inv.dispatches.map((d) => (
            <div key={d.id} className="flex justify-between py-0.5">
              <Link to={`/sevkiyat/${d.id}`}>{d.no}</Link>
              <span className="text-muted">
                {trDate(d.date)} · {d.customerName}
              </span>
            </div>
          ))}
        </div>
      </div>
      {cancel && (
        <Confirm
          title="Faturayı iptal et"
          text="Fatura iptal edilir, irsaliyeleri tekrar faturalanabilir hale gelir. e-Fatura kesildiyse entegratörde de iptal etmeyi unutmayın."
          danger
          yes="İptal et"
          onClose={() => setCancel(false)}
          onYes={async () => {
            await api.cancelInvoice(inv.id);
            reload();
          }}
        />
      )}
      {pay && <PaymentDialog customerId={inv.customerId} amount={inv.remaining} reference={inv.no} onClose={() => setPay(false)} onSaved={reload} />}
      {edit && <EditDialog inv={inv} onClose={() => setEdit(false)} onSaved={reload} />}
    </Page>
  );
}

function EditDialog({ inv, onClose, onSaved }: { inv: { id: number; eInvoiceNo: string | null; note: string | null; dueDate: string }; onClose: () => void; onSaved: () => void }) {
  const [no, setNo] = useState(inv.eInvoiceNo ?? '');
  const [note, setNote] = useState(inv.note ?? '');
  const [due, setDue] = useState(inv.dueDate);
  return (
    <Modal
      title="Fatura bilgisi"
      onClose={onClose}
      width={440}
      footer={
        <button
          className="btn btn-primary"
          onClick={async () => {
            await api.updateInvoice(inv.id, { eInvoiceNo: no || null, note: note || null, dueDate: due });
            onSaved();
            onClose();
          }}
        >
          Kaydet
        </button>
      }
    >
      <Field label="e-Fatura / e-Arşiv numarası" className="mb-2">
        <input className="input" value={no} onChange={(e) => setNo(e.target.value)} placeholder="ör. ABC2026000000123" />
      </Field>
      <Field label="Vade tarihi" className="mb-2">
        <input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label="Not">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
