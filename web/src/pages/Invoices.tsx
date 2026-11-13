import { useEffect, useMemo, useState } from 'react';
import { api, KIND_LABEL, EDM_PROFILE, EDM_TONE, edmTone, INVOICE_STATUS, type DispatchSummary, type EdmInvoice, type EdmImportResult, type OnboardingPreview } from '../api';
import { Link, queryParam, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, Modal, Page, SearchSelect, Stat, fileToBase64, useLoad, useToast } from '../ui';
import { fmtNum, formatTL, monthStart, today, trDate } from '../money';
import { PaymentDialog } from './Payments';

export function InvoicesPage() {
  const [status, setStatus] = useState<'all' | 'open' | 'overdue'>('all');
  const { data, error, reload } = useLoad(() => api.invoices({ status }), [status]);
  const pending = useLoad(() => api.pendingInvoices(), []);
  const edm = useLoad(() => api.edmSettings(), []);
  const { go } = useNav();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const waiting = (data ?? []).some((i) => i.eUuid && !i.cancelled && ['wait', 'none'].includes(edmTone(i.eStatus)));
  const open = (data ?? []).reduce((s, i) => s + i.remaining, 0);
  return (
    <Page
      title="Faturalar"
      subtitle="İrsaliyelerden kesilir; tahsilatlar faturaları eskiden yeniye kapatır"
      actions={
        <>
          {edm.data?.enabled && waiting && (
            <button
              className="btn"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  const r = await api.edmRefresh();
                  toast(`${r.checked} faturanın EDM durumu sorgulandı${r.changed ? ` · ${r.changed} değişti` : ''}`);
                  reload();
                } catch (e) {
                  toast((e as Error).message, 'bad');
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? 'Sorgulanıyor…' : 'EDM durumlarını yenile'}
            </button>
          )}
          {edm.data?.enabled && (
            <button className="btn" onClick={() => go('/faturalar/edm')}>
              EDM'den al
            </button>
          )}
          <button className="btn btn-primary" onClick={() => go('/faturalar/yeni')}>
            + Fatura kes
          </button>
        </>
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
                  {i.eUuid && !i.cancelled && edmTone(i.eStatus) !== 'ok' && (
                    <div className="mt-0.5">
                      <Badge tone={i.eError ? 'bad' : EDM_TONE[edmTone(i.eStatus)].tone}>{i.eError ? 'EDM hata' : EDM_TONE[edmTone(i.eStatus)].label}</Badge>
                    </div>
                  )}
                  {!i.eUuid && i.eError && (
                    <div className="mt-0.5">
                      <Badge tone="bad">EDM'ye gönderilemedi</Badge>
                    </div>
                  )}
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
  const edm = useLoad(() => api.edmSettings(), []);
  const toast = useToast();
  const [edmBusy, setEdmBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  if (!inv) return <Page title="…">{<ErrorLine error={error} />}</Page>;
  const tone = edmTone(inv.eStatus);
  const canSend = !!edm.data?.enabled && !inv.cancelled && (!inv.eUuid || tone === 'bad' || (tone === 'none' && !!inv.eError));
  const edmRun = async (fn: () => Promise<string>) => {
    setEdmBusy(true);
    try {
      toast(await fn());
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setEdmBusy(false);
      reload();
    }
  };
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
          {inv.eSource === 'edm' && <span> · EDM'den alındı (irsaliyesiz)</span>}
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
          {canSend && (
            <button className="btn btn-primary" disabled={edmBusy} onClick={() => setConfirmSend(true)}>
              {edmBusy ? 'Gönderiliyor…' : "EDM'ye gönder"}
            </button>
          )}
          {edm.data?.enabled && inv.eUuid && (
            <button className="btn" disabled={edmBusy} onClick={() => edmRun(async () => `EDM durumu: ${(await api.edmStatus(inv.id)).status || '—'}`)}>
              EDM durumu
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
        <Stat
          label="e-Fatura no"
          value={inv.eInvoiceNo ?? '—'}
          sub={
            inv.eUuid ? (
              <span className="flex flex-wrap items-center gap-1">
                {inv.eProfile && <span>{EDM_PROFILE[inv.eProfile] ?? inv.eProfile}</span>}
                <Badge tone={EDM_TONE[tone].tone}>{EDM_TONE[tone].label}</Badge>
              </span>
            ) : edm.data?.enabled ? (
              "EDM'ye gönderilmedi"
            ) : (
              'Entegratörde kestikten sonra girin'
            )
          }
        />
      </div>
      {inv.eError && <ErrorLine error={`EDM: ${inv.eError}`} />}
      {inv.eUuid && (
        <div className="mb-4 text-xs text-muted">
          ETTN {inv.eUuid}
          {inv.eStatus && ` · ${inv.eStatus}`}
          {inv.eStatusDesc && ` · ${inv.eStatusDesc}`}
        </div>
      )}
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
          {!inv.dispatches.length && <div className="text-muted">İrsaliye yok</div>}
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
          text={
            inv.eUuid
              ? "Fatura Rozet'te iptal edilir, irsaliyeleri tekrar faturalanabilir hale gelir. Bu fatura EDM'ye gönderildi: GİB'deki e-Fatura / e-Arşiv iptali EDM portalından ayrıca yapılmalıdır."
              : 'Fatura iptal edilir, irsaliyeleri tekrar faturalanabilir hale gelir. e-Fatura kesildiyse entegratörde de iptal etmeyi unutmayın.'
          }
          danger
          yes="İptal et"
          onClose={() => setCancel(false)}
          onYes={async () => {
            await api.cancelInvoice(inv.id);
            reload();
          }}
        />
      )}
      {confirmSend && (
        <Confirm
          title="EDM'ye gönder"
          text={
            <>
              {inv.no} · {formatTL(inv.total)} faturası {inv.customerName} için EDM'ye gönderilecek. Alıcı e-Fatura mükellefiyse e-Fatura, değilse e-Arşiv olarak kesilir ve GİB'e iletilir.
              {edm.data?.env === 'test' && <b> (Test ortamı)</b>}
            </>
          }
          yes="Gönder"
          onClose={() => setConfirmSend(false)}
          onYes={() =>
            edmRun(async () => {
              const r = await api.edmSend(inv.id);
              return r.already ? 'Fatura EDM’de zaten vardı; bilgiler güncellendi' : `EDM'ye gönderildi${r.eInvoiceNo ? ` · ${r.eInvoiceNo}` : ''}${r.profile ? ` · ${EDM_PROFILE[r.profile] ?? r.profile}` : ''}`;
            })
          }
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

/** EDM'deki giden faturaları Rozet'le eşleştirir ya da irsaliyesiz fatura olarak içe alır */
export function EdmImportPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const { data, error, reload } = useLoad(() => api.edmInvoices(range), [range.from, range.to]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<EdmImportResult[] | null>(null);
  const toast = useToast();
  const rows = data?.invoices ?? [];
  const selectable = (r: EdmInvoice) => r.state !== 'linked' && r.tone !== 'bad' && r.currency === 'TRY';
  useEffect(() => setSel(new Set(rows.filter(selectable).map((r) => r.uuid))), [data]);
  const counts = { linked: rows.filter((r) => r.state === 'linked').length, candidate: rows.filter((r) => r.state === 'candidate').length, new: rows.filter((r) => r.state === 'new').length };
  return (
    <Page
      title="EDM'den faturaları al"
      back={<Link to="/faturalar">‹ Faturalar</Link>}
      subtitle="EDM'de kesilmiş giden faturalar listelenir. Rozet'te karşılığı olanlar eşleştirilir (e-Fatura no ve ETTN yazılır); olmayanlar irsaliyesiz fatura olarak cariye işlenir, stok değişmez."
      actions={
        <Link to="/faturalar/edm/kurulum" className="btn">
          İlk kurulum (Excel ile müşteriler)
        </Link>
      }
    >
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="EDM'de oluşturulma: başlangıç">
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Bitiş">
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button className="btn" onClick={() => (from === range.from && to === range.to ? reload() : setRange({ from, to }))}>
          Listele
        </button>
        {data && (
          <span className="ml-auto text-sm text-muted">
            {rows.length} fatura · {counts.linked} bağlı · {counts.candidate} eşleşen · {counts.new} yeni
          </span>
        )}
      </div>
      <ErrorLine error={error} />
      {results && (
        <div className="card mb-4 p-4 text-sm">
          <div className="label">Sonuç</div>
          {results.map((r) => (
            <div key={r.uuid} className={r.ok ? '' : 'text-bad'}>
              {r.ok ? '✓' : '✗'} {r.no ? <Link to={`/faturalar/${r.invoiceId}`}>{r.no}</Link> : r.uuid}
              {r.customerCreated && ' · yeni müşteri açıldı (müşteri kartını kontrol edin)'}
              {r.message && ` · ${r.message}`}
            </div>
          ))}
        </div>
      )}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-10">
                <input
                  type="checkbox"
                  checked={rows.some(selectable) && rows.filter(selectable).every((r) => sel.has(r.uuid))}
                  onChange={(e) => setSel(new Set(e.target.checked ? rows.filter(selectable).map((r) => r.uuid) : []))}
                />
              </th>
              <th>EDM no</th>
              <th>Tarih</th>
              <th>Alıcı</th>
              <th className="text-right">Toplam</th>
              <th>EDM durumu</th>
              <th>Rozet'te</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.uuid} className={r.state === 'linked' ? 'opacity-60' : ''}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!selectable(r)}
                    checked={sel.has(r.uuid)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(r.uuid);
                      else n.delete(r.uuid);
                      setSel(n);
                    }}
                  />
                </td>
                <td className="whitespace-nowrap font-medium">
                  {r.id || '—'}
                  <div className="text-xs font-normal text-muted">{r.profile ? (EDM_PROFILE[r.profile] ?? r.profile) : ''}</div>
                </td>
                <td>{r.issueDate ? trDate(r.issueDate) : '—'}</td>
                <td>
                  {r.customerName ?? '—'}
                  <div className="text-xs text-muted">{r.taxId}</div>
                </td>
                <td className="tabular text-right">
                  {formatTL(r.total)}
                  {r.currency !== 'TRY' && <div className="text-xs text-bad">{r.currency} — alınamaz</div>}
                </td>
                <td>
                  <Badge tone={EDM_TONE[r.tone].tone}>{r.tone === 'bad' ? 'Hatalı' : r.tone === 'ok' ? 'Başarılı' : 'İşleniyor'}</Badge>
                  <div className="text-xs text-muted">{r.statusDescription || r.status}</div>
                </td>
                <td className="text-sm">
                  {r.state === 'linked' && r.invoice && (
                    <>
                      <Link to={`/faturalar/${r.invoice.id}`}>{r.invoice.no}</Link> <span className="text-muted">bağlı</span>
                    </>
                  )}
                  {r.state === 'candidate' && r.invoice && (
                    <>
                      <Link to={`/faturalar/${r.invoice.id}`}>{r.invoice.no}</Link> <span className="text-muted">ile eşleşecek</span>
                    </>
                  )}
                  {r.state === 'new' && <span>{r.customer ? `Yeni fatura · ${r.customer.name}` : 'Yeni fatura · yeni müşteri açılır'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length && <Empty>Bu aralıkta EDM'de giden fatura yok.</Empty>}
        {!data && !error && <Empty>EDM'den getiriliyor…</Empty>}
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        <span className="text-sm text-muted">{sel.size} fatura seçili</span>
        <button
          className="btn btn-primary"
          disabled={!sel.size || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const items = rows
                .filter((r) => sel.has(r.uuid))
                .map((r) => (r.state === 'candidate' && r.invoice ? { uuid: r.uuid, id: r.id, action: 'link' as const, invoiceId: r.invoice.id } : { uuid: r.uuid, id: r.id, action: 'create' as const }));
              const { results } = await api.edmImport(items);
              setResults(results);
              const ok = results.filter((x) => x.ok).length;
              toast(`${ok}/${results.length} fatura aktarıldı`, ok === results.length ? undefined : 'bad');
              reload();
            } catch (e) {
              toast((e as Error).message, 'bad');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Aktarılıyor…' : 'Seçilenleri Rozet’e al'}
        </button>
      </div>
    </Page>
  );
}

/**
 * İlk kurulum: EDM'deki geçmiş giden faturalardan müşteri listesi Excel'e alınır; kullanıcı türleri
 * (zincir / tek kafe / franchise şube / atla) işaretleyip geri yükler.
 */
export function EdmOnboardingPage() {
  const year = (() => {
    const d = new Date(today());
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const [from, setFrom] = useState(year);
  const [to, setTo] = useState(today());
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ customersCreated: number; invoicesImported: number; invoicesFailed: { id: string; message: string }[] } | null>(null);
  const toast = useToast();
  const { go } = useNav();

  const download = async () => {
    setDownloading(true);
    setErr('');
    try {
      const r = await fetch(api.onboardingExportUrl({ from, to }), { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Hata (${r.status})`);
      const [c, i] = (r.headers.get('x-rozet-counts') ?? '').split(';');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `edm-ilk-kurulum-${from}-${to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      if (c) toast(`${c} firma, ${i} fatura Excel'e alındı`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  const load = async (f: { name: string; data: string }) => {
    setBusy(true);
    setErr('');
    setDone(null);
    try {
      setPreview(await api.onboardingPreview(f.data));
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = preview?.summary;
  const kindLabel = (k: OnboardingPreview['customers'][number]['kind']) => (k === 'skip' ? 'Atla' : k === 'branch' ? 'Franchise şube' : KIND_LABEL[k]);
  return (
    <Page
      title="EDM ilk kurulum"
      back={<Link to="/faturalar/edm">‹ EDM'den al</Link>}
      subtitle="Geçmişte EDM'den kesilen faturalardaki firmalar Excel'e alınır. Siz her firmanın zincir mi, tek kafe mi olduğunu işaretlersiniz; dosyayı yükleyince müşteriler (ve isterseniz geçmiş faturalar) Rozet'e açılır."
    >
      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">1. Excel'i indirin</h3>
          <p className="mb-3 text-xs text-muted">EDM'de bu aralıkta oluşturulmuş giden faturalar taranır. Çok fatura varsa birkaç dakika sürebilir.</p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Field label="Başlangıç">
              <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Bitiş">
              <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <button className="btn btn-primary w-full" disabled={downloading} onClick={download}>
            {downloading ? "EDM'den okunuyor…" : "Excel'i indir"}
          </button>
        </div>
        <div className="card p-4 text-sm">
          <h3 className="mb-1 font-semibold">2. Türleri işaretleyin</h3>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
            <li>
              <b className="text-ink">Müşteriler</b> sayfasında <b className="text-ink">Tür</b> sütunu: Tek kafe (hazır gelir), Zincir, Franchise şube ya da Atla.
            </li>
            <li>Franchise şube için <b className="text-ink">Bağlı zincir</b> sütununa zincirin vergi nosunu ya da kısa adını yazın.</li>
            <li>Kısa ad, kod ve vade sütunlarını isterseniz düzeltin.</li>
            <li>
              Cari için <b className="text-ink">Açılış bakiyesi</b> ve <b className="text-ink">Açılış tarihi</b> girin; o tarihten önceki faturalar bakiyeye eklenmez.
            </li>
            <li>
              <b className="text-ink">Faturalar</b> sayfasında alınmasını istemediklerinizi Hayır yapın.
            </li>
          </ul>
        </div>
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">3. Dosyayı yükleyin</h3>
          <p className="mb-3 text-xs text-muted">Önce önizleme gösterilir; onaylamadan hiçbir şey kaydedilmez.</p>
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
              e.target.value = '';
            }}
          />
          {busy && <p className="mt-2 text-sm text-muted">Okunuyor…</p>}
          {file && !busy && (
            <button className="btn btn-sm mt-2" onClick={() => load(file)}>
              {file.name} · tekrar oku
            </button>
          )}
        </div>
      </div>
      <ErrorLine error={err} />
      {done && (
        <div className="card mb-4 p-4 text-sm">
          <div className="font-semibold">
            {done.customersCreated} müşteri açıldı · {done.invoicesImported} fatura içe alındı
          </div>
          {done.invoicesFailed.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-bad">
              {done.invoicesFailed.map((f) => (
                <li key={f.id}>
                  {f.id}: {f.message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-sm" onClick={() => go('/musteriler')}>
              Müşterilere git
            </button>
            <button className="btn btn-sm" onClick={() => go('/faturalar')}>
              Faturalara git
            </button>
          </div>
        </div>
      )}
      {preview && s && (
        <>
          {preview.errors.length > 0 && (
            <div className="mb-4 rounded-xl border border-bad/30 bg-bad-soft p-3 text-sm">
              <div className="mb-1 font-semibold text-bad">{preview.errors.length} sorun var — Excel'de düzeltip dosyayı tekrar seçin</div>
              <ul className="list-disc pl-5 text-bad">
                {preview.errors.slice(0, 40).map((e, i) => (
                  <li key={i}>
                    {e.sheet}
                    {e.row ? `, satır ${e.row}` : ''}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mb-4 grid grid-cols-4 gap-3">
            <Stat label="Açılacak müşteri" value={fmtNum(s.create)} sub={`${s.chains} zincir · ${s.singles} tek kafe · ${s.branches} franchise`} />
            <Stat label="Zaten kayıtlı" value={fmtNum(s.existing)} sub="değiştirilmez" />
            <Stat label="Atlanacak" value={fmtNum(s.skip)} />
            <Stat label="İçe alınacak fatura" value={fmtNum(s.invoicesToImport)} sub={formatTL(s.invoicesTotal)} />
          </div>
          {s.invoicesToImport > 0 && s.withOpening < s.create && (
            <div className="mb-4 rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
              {s.create - s.withOpening} yeni müşteride açılış bakiyesi yok: bu müşterilerin içe alınan bütün faturaları ödenmemiş görünecek. Ödenmişse Excel'de açılış bakiyesi ve tarihi girin ya da sonra tahsilat girin.
            </div>
          )}
          <div className="card mb-4 overflow-hidden">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Satır</th>
                  <th>Kısa ad</th>
                  <th>Vergi no</th>
                  <th>Tür</th>
                  <th>Zincir</th>
                  <th className="text-right">Vade</th>
                  <th className="text-right">Açılış</th>
                  <th>Rozet'te</th>
                </tr>
              </thead>
              <tbody>
                {preview.customers.map((c) => (
                  <tr key={c.taxId} className={c.kind === 'skip' || c.existingId ? 'opacity-60' : ''}>
                    <td className="text-muted">{c.row}</td>
                    <td className="font-medium">
                      {c.name}
                      {c.legalName && c.legalName !== c.name && <div className="text-xs font-normal text-muted">{c.legalName}</div>}
                    </td>
                    <td className="tabular">{c.taxId}</td>
                    <td>
                      <Badge tone={c.kind === 'chain' ? 'brand' : c.kind === 'skip' ? 'muted' : c.kind === 'branch' ? 'warn' : 'ok'}>{kindLabel(c.kind)}</Badge>
                    </td>
                    <td>{c.parentName ?? ''}</td>
                    <td className="tabular text-right">{c.paymentDays} gün</td>
                    <td className="tabular text-right">{c.openingDate ? `${formatTL(c.openingBalance)} · ${trDate(c.openingDate)}` : '—'}</td>
                    <td className="text-sm">{c.existingId ? <Link to={`/musteriler/${c.existingId}`}>{c.existingName}</Link> : c.kind === 'skip' ? 'Alınmayacak' : 'Yeni'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!preview.customers.length && <Empty>Dosyada müşteri yok.</Empty>}
          </div>
          <div className="flex items-center justify-end gap-3">
            <span className="text-sm text-muted">
              {s.create} müşteri · {s.invoicesToImport} fatura
            </span>
            <button className="btn btn-primary" disabled={preview.errors.length > 0 || (!s.create && !s.invoicesToImport)} onClick={() => setConfirm(true)}>
              Rozet'e al
            </button>
          </div>
        </>
      )}
      {confirm && file && s && (
        <Confirm
          title="İlk kurulumu tamamla"
          text={`${s.create} müşteri açılacak${s.invoicesToImport ? `, ${s.invoicesToImport} fatura (${formatTL(s.invoicesTotal)}) EDM'den okunup cariye işlenecek` : ''}. Stok değişmez.`}
          yes="Rozet'e al"
          onClose={() => setConfirm(false)}
          onYes={async () => {
            const r = await api.onboardingImport(file.data);
            setDone(r);
            setPreview(null);
            toast(`${r.customersCreated} müşteri, ${r.invoicesImported} fatura alındı`, r.invoicesFailed.length ? 'bad' : undefined);
          }}
        />
      )}
    </Page>
  );
}
