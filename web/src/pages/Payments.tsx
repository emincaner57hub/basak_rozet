import { useState } from 'react';
import { api, PAY_METHOD, type PayMethod } from '../api';
import { Link, useNav } from '../router';
import { Confirm, Empty, ErrorLine, Field, Modal, MoneyInput, Page, SearchSelect, useLoad, useToast } from '../ui';
import { formatTL, monthStart, today, trDate } from '../money';

export function PaymentsPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error, reload } = useLoad(() => api.payments({ from, to }), [from, to]);
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<number | null>(null);
  const total = (data ?? []).reduce((s, p) => s + p.amount, 0);
  return (
    <Page
      title="Tahsilat"
      subtitle="Havale ve diğer tahsilatlar; müşterinin en eski faturasından başlayarak kapatır"
      actions={
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + Tahsilat
        </button>
      }
    >
      <ErrorLine error={error} />
      <div className="mb-3 flex items-center gap-2">
        <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted">–</span>
        <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="ml-2 text-sm text-muted">
          Toplam: <b className="text-ink">{formatTL(total)}</b>
        </span>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Müşteri</th>
              <th>Şekil</th>
              <th>Referans / not</th>
              <th className="text-right">Tutar</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{trDate(p.date)}</td>
                <td>
                  <Link to={`/musteriler/${p.customerId}`}>{p.customerName}</Link>
                </td>
                <td>{PAY_METHOD[p.method]}</td>
                <td className="text-sm text-muted">{[p.reference, p.note].filter(Boolean).join(' · ') || '—'}</td>
                <td className="tabular text-right font-medium">{formatTL(p.amount)}</td>
                <td className="w-16 text-right">
                  <button className="btn btn-sm btn-danger" onClick={() => setDel(p.id)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Bu aralıkta tahsilat yok.</Empty>}
      </div>
      {adding && <PaymentDialog onClose={() => setAdding(false)} onSaved={reload} />}
      {del && (
        <Confirm
          title="Tahsilatı sil"
          text="Tahsilat silinir; faturaların ödeme durumu yeniden hesaplanır."
          danger
          yes="Sil"
          onClose={() => setDel(null)}
          onYes={async () => {
            await api.deletePayment(del);
            reload();
          }}
        />
      )}
    </Page>
  );
}

export function PaymentDialog({ customerId, amount, reference, onClose, onSaved }: { customerId?: number; amount?: number; reference?: string; onClose: () => void; onSaved: () => void }) {
  const customers = useLoad(() => api.customers(), []);
  const [cid, setCid] = useState<number | null>(customerId ?? null);
  const [date, setDate] = useState(today());
  const [value, setValue] = useState<number | null>(amount ?? null);
  const [method, setMethod] = useState<PayMethod>('havale');
  const [ref, setRef] = useState(reference ?? '');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const billable = (customers.data ?? []).filter((c) => c.billable);
  const cust = billable.find((c) => c.id === cid);
  return (
    <Modal
      title="Tahsilat"
      onClose={onClose}
      width={480}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            disabled={!cid || !value || value <= 0}
            onClick={async () => {
              try {
                await api.createPayment({ customerId: cid!, date, amount: value!, method, reference: ref || null, note: note || null });
                toast('Tahsilat kaydedildi');
                onSaved();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Kaydet
          </button>
        </>
      }
    >
      <Field label="Müşteri (cari)" className="mb-2" hint={cust ? `Güncel bakiye: ${formatTL(cust.balance)}` : 'Merkeze bağlı şubelerin tahsilatı zincire girilir'}>
        <SearchSelect items={billable} value={cid} onChange={(id) => setCid(id)} label={(c) => c.name} disabled={!!customerId} />
      </Field>
      <div className="mb-2 grid grid-cols-2 gap-3">
        <Field label="Tarih">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Tutar">
          <MoneyInput value={value} onChange={setValue} />
        </Field>
      </div>
      <Field label="Şekil" className="mb-2">
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
          {(Object.keys(PAY_METHOD) as PayMethod[]).map((m) => (
            <option key={m} value={m}>
              {PAY_METHOD[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Referans (dekont, banka)" className="mb-2">
        <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
      <Field label="Not">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** Cari ekstre (müşteri sayfasında) */
export function StatementView({ customerId }: { customerId: number }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, reload } = useLoad(() => api.statement(customerId, { from: from || undefined, to: to || undefined }), [customerId, from, to]);
  const [adding, setAdding] = useState(false);
  const { go } = useNav();
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted">–</span>
        <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn ml-auto" onClick={() => window.print()}>
          Yazdır
        </button>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + Tahsilat
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Belge</th>
              <th>Açıklama</th>
              <th className="text-right">Borç</th>
              <th className="text-right">Alacak</th>
              <th className="text-right">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {from && data && (
              <tr>
                <td colSpan={5} className="text-muted">
                  Dönem başı
                </td>
                <td className="tabular text-right">{formatTL(data.opening)}</td>
              </tr>
            )}
            {data?.rows.map((r, i) => (
              <tr key={i} className={r.kind === 'invoice' ? 'clickable' : ''} onClick={() => r.kind === 'invoice' && r.refId && go(`/faturalar/${r.refId}`)}>
                <td>{trDate(r.date)}</td>
                <td className="font-medium">{r.kind === 'payment' ? PAY_METHOD[r.ref as PayMethod] ?? r.ref : r.ref}</td>
                <td className="text-sm text-muted">{r.kind === 'invoice' ? (r.description ? `e-Fatura ${r.description}` : 'Fatura') : (r.description ?? '')}</td>
                <td className="tabular text-right">{r.debit ? formatTL(r.debit) : ''}</td>
                <td className="tabular text-right">{r.credit ? formatTL(r.credit) : ''}</td>
                <td className="tabular text-right font-medium">{formatTL(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.rows.length && <Empty>Hareket yok.</Empty>}
      </div>
      {adding && <PaymentDialog customerId={customerId} onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}
