import { useState } from 'react';
import { api, PAY_METHOD, SUPPLIER_KIND, type EdmSyncResult, type PayMethod, type StatementRow } from '../api';
import { Link, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, Modal, MoneyInput, Page, Tabs, useLoad, useToast } from '../ui';
import { formatTL, monthStart, today, trDate } from '../money';

const syncText = (r: EdmSyncResult) =>
  `${r.out} giden, ${r.in} gelen fatura okundu · ${r.new} yeni` +
  (r.newCustomers ? ` · ${r.newCustomers} müşteri açıldı` : '') +
  (r.newSuppliers ? ` · ${r.newSuppliers} tedarikçi açıldı` : '') +
  (r.matched ? ` · ${r.matched} uygulama faturasıyla eşleşti` : '') +
  (r.errors.length ? ` · ${r.errors.length} hata` : '');

/** EDM'den gelen ve giden e-faturalar; eşitleme */
export function EInvoicesPage() {
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad(() => api.eInvoices({ direction: dir, from, to, q: q || undefined }), [dir, from, to, q]);
  const status = useLoad(() => api.edmStatus(), []);
  const [busy, setBusy] = useState(false);
  const [syncErr, setSyncErr] = useState('');
  const toast = useToast();
  const st = status.data;
  const live = (data ?? []).filter((e) => !e.cancelled);
  const sum = (k: 'subtotal' | 'vatTotal' | 'total') => live.reduce((s, e) => s + (e.type === 'IADE' ? -e[k] : e[k]), 0);
  return (
    <Page
      title="e-Fatura (EDM)"
      subtitle="EDM'den gelen ve giden faturalar; karşı taraf vergi numarasıyla cariye yazılır"
      actions={
        <button
          className="btn btn-primary"
          disabled={busy || !st?.configured}
          onClick={async () => {
            setBusy(true);
            setSyncErr('');
            try {
              const r = await api.edmSync(from, to);
              toast(syncText(r));
              reload();
              status.reload();
            } catch (e) {
              setSyncErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'EDM okunuyor…' : `⇩ EDM'den çek (${trDate(from)} – ${trDate(to)})`}
        </button>
      }
    >
      {st && !st.configured && (
        <div className="card mb-3 border-bad/40 p-3 text-sm">
          EDM bağlantısı tanımlı değil: Render → Environment'a <b>EDM_USER</b> {st.user ? '✓' : '✗'} ve <b>EDM_PASSWORD</b> {st.password ? '✓' : '✗'} girilmeli.
        </div>
      )}
      {st?.last && (
        <div className="mb-3 text-sm text-muted">
          Son eşitleme: {new Date(st.last.at).toLocaleString('tr-TR')} ({trDate(st.last.from)} – {trDate(st.last.to)}) · {syncText(st.last)}. Her saat son 7 gün kendiliğinden çekilir.
          {st.last.errors.length > 0 && <div className="text-bad">{st.last.errors.slice(0, 5).join(' · ')}</div>}
        </div>
      )}
      <ErrorLine error={syncErr || error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs
          value={dir}
          onChange={setDir}
          items={[
            ['out', 'Giden (satış)'],
            ['in', 'Gelen (alış)'],
          ]}
        />
        <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted">–</span>
        <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <input className="input w-56" placeholder="No, unvan ya da VKN" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ml-auto text-sm text-muted">
          Matrah <b className="text-ink">{formatTL(sum('subtotal'))}</b> · KDV <b className="text-ink">{formatTL(sum('vatTotal'))}</b> · Toplam <b className="text-ink">{formatTL(sum('total'))}</b>
        </span>
      </div>
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Fatura no</th>
              <th>{dir === 'out' ? 'Müşteri' : 'Tedarikçi'}</th>
              <th>VKN / TCKN</th>
              <th>Tür</th>
              <th className="text-right">Matrah</th>
              <th className="text-right">KDV</th>
              <th className="text-right">Toplam</th>
              <th>Cari</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id} className={e.cancelled ? 'opacity-50' : ''}>
                <td>{trDate(e.date)}</td>
                <td className="font-mono text-xs">{e.no}</td>
                <td>
                  {e.customerId ? (
                    <Link to={`/musteriler/${e.customerId}`}>{e.accountName ?? e.partyName}</Link>
                  ) : e.supplierId ? (
                    <Link to={`/tedarikciler/${e.supplierId}`}>{e.accountName ?? e.partyName}</Link>
                  ) : (
                    e.partyName
                  )}
                </td>
                <td className="text-sm text-muted">{e.partyTaxId}</td>
                <td>
                  {e.type === 'IADE' ? <Badge tone="warn">İade</Badge> : <span className="text-sm text-muted">{e.type ?? ''}</span>}
                  {e.currency !== 'TRY' && <span className="ml-1 text-xs text-muted">{e.currency}</span>}
                </td>
                <td className="tabular text-right">{formatTL(e.subtotal)}</td>
                <td className="tabular text-right">{formatTL(e.vatTotal)}</td>
                <td className="tabular text-right font-medium">{formatTL(e.total)}</td>
                <td className="text-sm">
                  {e.cancelled ? (
                    <Badge tone="bad">{e.status ?? 'reddedildi'}</Badge>
                  ) : e.invoiceId ? (
                    <Link to={`/faturalar/${e.invoiceId}`} className="text-muted">
                      {e.invoiceNo} ile eşleşti
                    </Link>
                  ) : (
                    <Badge tone="ok">cariye yazıldı</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Bu aralıkta {dir === 'out' ? 'giden' : 'gelen'} e-fatura yok. EDM'den çekmek için sağ üstteki düğmeyi kullanın.</Empty>}
      </div>
    </Page>
  );
}

/** Tedarikçi carileri */
export function SuppliersCariPage() {
  const { data, error } = useLoad(() => api.supplierBalances(), []);
  const { go } = useNav();
  const total = (data ?? []).reduce((s, x) => s + x.balance, 0);
  return (
    <Page title="Tedarikçi cari" subtitle="Gelen e-faturalar, ödemeler ve düzeltmeler · + bakiye: biz borçluyuz">
      <ErrorLine error={error} />
      <div className="mb-3 text-sm text-muted">
        Toplam borcumuz: <b className="text-ink">{formatTL(total)}</b>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tedarikçi</th>
              <th>Tür</th>
              <th>VKN / TCKN</th>
              <th className="text-right">e-Fatura</th>
              <th className="text-right">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => go(`/tedarikciler/${s.id}`)}>
                <td className="font-medium">{s.name}</td>
                <td className="text-sm text-muted">{SUPPLIER_KIND[s.kind]}</td>
                <td className="text-sm text-muted">{s.taxId ?? '—'}</td>
                <td className="tabular text-right">{s.invoiceCount || ''}</td>
                <td className={`tabular text-right font-medium ${s.balance > 0 ? 'text-bad' : ''}`}>{formatTL(s.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Tedarikçi yok.</Empty>}
      </div>
    </Page>
  );
}

const rowLabel = (r: StatementRow) =>
  r.kind === 'payment' ? PAY_METHOD[r.ref as PayMethod] ?? r.ref : r.kind === 'einvoice' ? r.ref : r.ref;

/** Tedarikçi ekstresi */
export function SupplierCariPage({ id }: { id: number }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, reload } = useLoad(() => api.supplierStatement(id, { from: from || undefined, to: to || undefined }), [id, from, to]);
  const [paying, setPaying] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [del, setDel] = useState<StatementRow | null>(null);
  return (
    <Page
      title={data?.supplier.name ?? 'Tedarikçi'}
      subtitle={`${data?.supplier.taxId ? `VKN/TCKN ${data.supplier.taxId} · ` : ''}Bakiye ${formatTL(data?.supplier.balance)} (+ biz borçluyuz)`}
      back={<Link to="/tedarikciler">← Tedarikçi cari</Link>}
      actions={
        <>
          <button className="btn" onClick={() => setAdjusting(true)}>
            Bakiye düzeltme
          </button>
          <button className="btn btn-primary" onClick={() => setPaying(true)}>
            + Ödeme
          </button>
        </>
      }
    >
      <ErrorLine error={error} />
      <StatementTable
        rows={data?.rows}
        opening={from ? data?.opening : undefined}
        from={from}
        to={to}
        setFrom={setFrom}
        setTo={setTo}
        debitLabel="Borç (ödeme)"
        creditLabel="Alacak (fatura)"
        onDelete={(r) => setDel(r)}
      />
      {paying && <SupplierPaymentDialog supplierId={id} onClose={() => setPaying(false)} onSaved={reload} />}
      {adjusting && <AdjustDialog target={{ supplierId: id }} current={data?.supplier.balance ?? 0} onClose={() => setAdjusting(false)} onSaved={reload} />}
      {del && (
        <Confirm
          title={del.kind === 'payment' ? 'Ödemeyi sil' : 'Düzeltmeyi sil'}
          text={`${trDate(del.date)} · ${formatTL(del.debit || del.credit)}`}
          danger
          yes="Sil"
          onClose={() => setDel(null)}
          onYes={async () => {
            if (del.kind === 'payment') await api.deleteSupplierPayment(del.refId!);
            else await api.deleteAdjustment(del.refId!);
            reload();
          }}
        />
      )}
    </Page>
  );
}

/** Ekstre tablosu (müşteri ve tedarikçi) */
export function StatementTable({
  rows,
  opening,
  from,
  to,
  setFrom,
  setTo,
  debitLabel = 'Borç',
  creditLabel = 'Alacak',
  onRow,
  onDelete,
  actions,
}: {
  rows?: StatementRow[];
  opening?: number;
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  debitLabel?: string;
  creditLabel?: string;
  onRow?: (r: StatementRow) => void;
  onDelete?: (r: StatementRow) => void;
  actions?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-muted">–</span>
        <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn ml-auto" onClick={() => window.print()}>
          Yazdır
        </button>
        {actions}
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Belge</th>
              <th>Açıklama</th>
              <th className="text-right">{debitLabel}</th>
              <th className="text-right">{creditLabel}</th>
              <th className="text-right">Bakiye</th>
              {onDelete && <th />}
            </tr>
          </thead>
          <tbody>
            {opening !== undefined && (
              <tr>
                <td colSpan={5} className="text-muted">
                  Dönem başı
                </td>
                <td className="tabular text-right">{formatTL(opening)}</td>
                {onDelete && <td />}
              </tr>
            )}
            {rows?.map((r, i) => (
              <tr key={i} className={onRow && r.kind === 'invoice' ? 'clickable' : ''} onClick={() => onRow?.(r)}>
                <td>{trDate(r.date)}</td>
                <td className={`font-medium ${r.kind === 'einvoice' ? 'font-mono text-xs' : ''}`}>{rowLabel(r)}</td>
                <td className="text-sm text-muted">
                  {r.kind === 'invoice' ? (r.description ? `e-Fatura ${r.description}` : 'Fatura') : r.kind === 'adjust' ? <Badge tone="warn">{r.description ?? 'Düzeltme'}</Badge> : (r.description ?? '')}
                </td>
                <td className="tabular text-right">{r.debit ? formatTL(r.debit) : ''}</td>
                <td className="tabular text-right">{r.credit ? formatTL(r.credit) : ''}</td>
                <td className="tabular text-right font-medium">{formatTL(r.balance)}</td>
                {onDelete && (
                  <td className="w-14 text-right">
                    {(r.kind === 'payment' || r.kind === 'adjust') && r.refId && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(r);
                        }}
                      >
                        Sil
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <Empty>Hareket yok.</Empty>}
      </div>
    </div>
  );
}

/** "Bu tarihte bakiye şu olmalı" → fark düzeltme kaydı (kullanmaya başlarken açılış mutabakatı) */
export function AdjustDialog({ target, current, onClose, onSaved }: { target: { customerId?: number; supplierId?: number }; current: number; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const sup = !!target.supplierId;
  return (
    <Modal
      title="Bakiye düzeltme"
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
            disabled={balance == null}
            onClick={async () => {
              try {
                const r = await api.addAdjustment({ ...target, date, targetBalance: balance!, note: note || null });
                toast(r.amount ? `Düzeltme kaydı: ${formatTL(r.amount)}` : 'Bakiye zaten bu');
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
      <p className="mb-3 text-sm text-muted">
        Seçtiğiniz tarihteki <b>olması gereken bakiyeyi</b> girin; sistem aradaki farkı düzeltme kaydı olarak yazar. Şu anki bakiye: <b>{formatTL(current)}</b>.{' '}
        {sup ? 'Artı: biz tedarikçiye borçluyuz, eksi: tedarikçi bize borçlu (avans).' : 'Artı: müşteri bize borçlu, eksi: müşterinin alacağı (avans).'}
      </p>
      <div className="mb-2 grid grid-cols-2 gap-3">
        <Field label="Tarih">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Olması gereken bakiye">
          <MoneyInput value={balance} onChange={setBalance} placeholder="ör. 12.500,00" />
        </Field>
      </div>
      <Field label="Not">
        <input className="input" value={note} placeholder="ör. Kullanmaya başlarken mutabakat" onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function SupplierPaymentDialog({ supplierId, onClose, onSaved }: { supplierId: number; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(today());
  const [value, setValue] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>('havale');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  return (
    <Modal
      title="Tedarikçiye ödeme"
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
            disabled={!value || value <= 0}
            onClick={async () => {
              try {
                await api.addSupplierPayment({ supplierId, date, amount: value!, method, reference: ref || null, note: note || null });
                toast('Ödeme kaydedildi');
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
