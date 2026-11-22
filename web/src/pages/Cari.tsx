import { useState } from 'react';
import { api, COST_TYPE_LABEL, PAY_METHOD, SALE_KIND_LABEL, SUPPLIER_KIND, type EInvoice, type EdmSyncResult, type ManualEntryInput, type PayMethod, type StatementRow } from '../api';
import { Link, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, Modal, MoneyInput, Page, SearchSelect, Tabs, useLoad, useToast } from '../ui';
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
  const [manual, setManual] = useState<EInvoice | 'new' | null>(null);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const live = (data ?? []).filter((e) => !e.cancelled);
  const sum = (k: 'subtotal' | 'vatTotal' | 'total') => live.reduce((s, e) => s + (e.type === 'IADE' ? -e[k] : e[k]), 0);
  return (
    <Page
      title="e-Fatura (EDM)"
      subtitle="EDM'den gelen ve giden faturalar ile elle girilen alış / satışlar; karşı tarafın carisine yazılır"
      actions={
        <>
        <button className="btn" onClick={() => setManual('new')}>
          + Elle {dir === 'out' ? 'satış' : 'alış'}
        </button>
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
        </>
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
      {st?.configured && (
        <div className="mb-3 text-sm">
          <button
            className="btn"
            disabled={diagBusy}
            onClick={async () => {
              setDiagBusy(true);
              try {
                setDiag(await api.edmDiag());
              } catch (e) {
                setDiag({ hata: (e as Error).message });
              } finally {
                setDiagBusy(false);
              }
            }}
          >
            {diagBusy ? 'Deneniyor…' : '🔌 EDM bağlantısını test et'}
          </button>
          {diag && <pre className="card mt-2 overflow-x-auto whitespace-pre-wrap p-3 text-xs">{JSON.stringify(diag, null, 2)}</pre>}
        </div>
      )}
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
              <th>{dir === 'out' ? 'Satış' : 'Maliyet'}</th>
              <th className="text-right">Matrah</th>
              <th className="text-right">KDV</th>
              <th className="text-right">Toplam</th>
              <th>Cari</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((e) => (
              <tr
                key={e.id}
                className={`${e.cancelled ? 'opacity-50' : ''} ${e.source === 'manual' ? 'clickable' : ''}`}
                onClick={e.source === 'manual' ? () => setManual(e) : undefined}
                title={e.source === 'manual' ? 'Düzeltmek için tıklayın' : undefined}
              >
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
                <td className="text-sm">
                  {e.direction === 'out'
                    ? e.saleKind && <Badge tone={e.saleKind === 'kdvli' ? 'warn' : 'brand'}>{SALE_KIND_LABEL[e.saleKind]}</Badge>
                    : e.costType && <span className="text-muted">{COST_TYPE_LABEL[e.costType]}</span>}
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
                    <>
                      <Badge tone="ok">cariye yazıldı</Badge>
                      {e.source === 'manual' && <span className="ml-1 text-xs text-muted">elle</span>}
                    </>
                  )}
                  {e.note && <div className="text-xs text-muted">{e.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Bu aralıkta {dir === 'out' ? 'satış' : 'alış'} yok. EDM'den çekmek ya da elle girmek için sağ üstteki düğmeleri kullanın.</Empty>}
      </div>
      {manual && (
        <ManualEntryDialog
          initial={manual === 'new' ? null : manual}
          direction={manual === 'new' ? dir : manual.direction}
          onClose={() => setManual(null)}
          onSaved={() => {
            setManual(null);
            reload();
          }}
        />
      )}
    </Page>
  );
}

/** Tedarikçi carileri: "sadece borçlu olduklarımız" süzgeci; havale / kredi kartıyla toplu borç kapama */
export function SuppliersCariPage() {
  const { data, error, reload } = useLoad(() => api.supplierBalances(), []);
  const { go } = useNav();
  const toast = useToast();
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [closing, setClosing] = useState<'havale' | 'kart' | null>(null); // toplu kapama modu
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [date, setDate] = useState(today());
  const [confirm, setConfirm] = useState(false);
  const total = (data ?? []).reduce((s, x) => s + x.balance, 0);
  const rows = (data ?? []).filter((s) => !(onlyDebt || closing) || s.balance > 0);
  const pickedRows = rows.filter((s) => picked.has(s.id));
  const pickedSum = pickedRows.reduce((t, s) => t + s.balance, 0);
  const allPicked = rows.length > 0 && rows.every((s) => picked.has(s.id));
  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const start = (m: 'havale' | 'kart') => {
    setClosing(m);
    setPicked(new Set());
    setDate(today());
  };
  const stop = () => {
    setClosing(null);
    setPicked(new Set());
  };
  return (
    <Page
      title="Tedarikçi cari"
      subtitle="Gelen e-faturalar, ödemeler ve düzeltmeler · + bakiye: biz borçluyuz"
      actions={
        closing ? undefined : (
          <>
            <button className="btn" onClick={() => start('havale')}>
              Borcu kapat · Havale
            </button>
            <button className="btn" onClick={() => start('kart')}>
              Borcu kapat · Kredi kartı
            </button>
          </>
        )
      }
    >
      <ErrorLine error={error} />
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted">
          Toplam borcumuz: <b className="text-ink">{formatTL(total)}</b>
        </span>
        {!closing && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} /> Sadece borçlu olduklarımız
          </label>
        )}
      </div>
      {closing && (
        <div className="card mb-3 flex flex-wrap items-center gap-3 border-brand/40 p-3 text-sm">
          <b>{PAY_METHOD[closing]} ile borç kapama</b>
          <span className="text-muted">Kapatılacakları soldan işaretleyin; her birine bugünkü borcu kadar ödeme yazılır.</span>
          <label className="flex items-center gap-1.5">
            Tarih <input type="date" className="input w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <span className="ml-auto">
            {pickedRows.length} tedarikçi · <b>{formatTL(pickedSum)}</b>
          </span>
          <button className="btn" onClick={stop}>
            Vazgeç
          </button>
          <button className="btn btn-primary" disabled={!pickedRows.length || !date} onClick={() => setConfirm(true)}>
            Execute
          </button>
        </div>
      )}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              {closing && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Tümünü seç"
                    checked={allPicked}
                    onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((s) => s.id)) : new Set())}
                  />
                </th>
              )}
              <th>Tedarikçi</th>
              <th>Tür</th>
              <th>VKN / TCKN</th>
              <th className="text-right">e-Fatura</th>
              <th className="text-right">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={`clickable ${closing && picked.has(s.id) ? 'bg-brand/5' : ''}`} onClick={() => (closing ? toggle(s.id) : go(`/tedarikciler/${s.id}`))}>
                {closing && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`${s.name} seç`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                )}
                <td className="font-medium">{s.name}</td>
                <td className="text-sm text-muted">
                  {SUPPLIER_KIND[s.kind]} · {COST_TYPE_LABEL[s.costType]}
                </td>
                <td className="text-sm text-muted">{s.taxId ?? '—'}</td>
                <td className="tabular text-right">{s.invoiceCount || ''}</td>
                <td className={`tabular text-right font-medium ${s.balance > 0 ? 'text-bad' : ''}`}>{formatTL(s.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length && <Empty>{onlyDebt || closing ? 'Borçlu olduğumuz tedarikçi yok.' : 'Tedarikçi yok.'}</Empty>}
      </div>
      {confirm && closing && (
        <Confirm
          title="Borçları kapat"
          yes="Execute"
          text={
            <>
              {trDate(date)} tarihli, <b>{PAY_METHOD[closing]}</b> ile {pickedRows.length} tedarikçiye toplam <b>{formatTL(pickedSum)}</b> ödeme yazılacak:
              <ul className="mt-2 max-h-48 list-disc overflow-y-auto pl-5 text-sm">
                {pickedRows.map((s) => (
                  <li key={s.id}>
                    {s.name}: {formatTL(s.balance)}
                  </li>
                ))}
              </ul>
            </>
          }
          onYes={async () => {
            const r = await api.paySuppliersBulk({ supplierIds: pickedRows.map((s) => s.id), method: closing, date });
            toast(`${r.paid.length} tedarikçinin borcu kapatıldı · ${formatTL(r.total)}${r.skipped.length ? ` · ${r.skipped.length} tanesinde borç yoktu` : ''}`);
            stop();
            reload();
          }}
          onClose={() => setConfirm(false)}
        />
      )}
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

/** Elle alış (tedarikçi) / satış (müşteri) kaydı: EDM'de olmayanlar. Tutarlar kuruş. */
function ManualEntryDialog({ initial, direction, onClose, onSaved }: { initial: EInvoice | null; direction: 'in' | 'out'; onClose: () => void; onSaved: () => void }) {
  const out = direction === 'out';
  const customers = useLoad(() => (out ? api.customers() : Promise.resolve([])), [out]);
  const suppliers = useLoad(() => (out ? Promise.resolve([]) : api.suppliers()), [out]);
  const [date, setDate] = useState(initial?.date ?? today());
  const [no, setNo] = useState(initial?.no ?? '');
  const [partyId, setPartyId] = useState<number | null>((out ? initial?.customerId : initial?.supplierId) ?? null);
  const [type, setType] = useState<'SATIS' | 'IADE'>(initial?.type === 'IADE' ? 'IADE' : 'SATIS');
  const [saleKind, setSaleKind] = useState<'kdvli' | 'faturali'>(initial?.saleKind ?? 'faturali');
  const [subtotal, setSubtotal] = useState<number | null>(initial?.subtotal ?? null);
  const [rate, setRate] = useState(20);
  const [vat, setVat] = useState<number | null>(initial?.vatTotal ?? null);
  const [note, setNote] = useState(initial?.note ?? '');
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const toast = useToast();
  const setNet = (v: number | null) => {
    setSubtotal(v);
    setVat(v == null ? null : Math.round((v * rate) / 100));
  };
  return (
    <Modal
      title={`${initial ? 'Elle kayıt' : 'Yeni elle kayıt'} · ${out ? 'satış (müşteri)' : 'alış (tedarikçi)'}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          {initial && (
            <button className="btn mr-auto" onClick={() => setDel(true)}>
              Sil
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            disabled={!partyId || subtotal == null}
            onClick={async () => {
              const b: ManualEntryInput = {
                direction,
                date,
                no: no || null,
                customerId: out ? partyId : null,
                supplierId: out ? null : partyId,
                type,
                saleKind: out ? saleKind : null,
                subtotal: subtotal ?? 0,
                vatTotal: vat ?? 0,
                note: note || null,
              };
              try {
                await api.saveManualEntry(initial?.id ?? null, b);
                toast('Kaydedildi, cariye yazıldı');
                onSaved();
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
      <div className="grid grid-cols-2 gap-3">
        <Field label={out ? 'Müşteri' : 'Tedarikçi'}>
          {out ? (
            <SearchSelect items={customers.data ?? []} value={partyId} onChange={setPartyId} label={(c) => c.name} />
          ) : (
            <SearchSelect items={suppliers.data ?? []} value={partyId} onChange={setPartyId} label={(s) => s.name} sub={(s) => COST_TYPE_LABEL[s.costType]} />
          )}
        </Field>
        <Field label="Tarih">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {out && (
          <Field label="Satış türü">
            <select className="input" value={saleKind} onChange={(e) => setSaleKind(e.target.value as 'kdvli' | 'faturali')}>
              <option value="faturali">{SALE_KIND_LABEL.faturali}</option>
              <option value="kdvli">{SALE_KIND_LABEL.kdvli}</option>
            </select>
          </Field>
        )}
        <Field label="Belge türü">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as 'SATIS' | 'IADE')}>
            <option value="SATIS">{out ? 'Satış' : 'Alış'}</option>
            <option value="IADE">İade</option>
          </select>
        </Field>
        <Field label="Belge no (boş: otomatik)">
          <input className="input" value={no} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field label="Matrah (KDV hariç)">
          <MoneyInput value={subtotal} onChange={setNet} placeholder="ör. 10.000,00" />
        </Field>
        <Field label="KDV oranı">
          <select
            className="input"
            value={rate}
            onChange={(e) => {
              const r = Number(e.target.value);
              setRate(r);
              if (subtotal != null) setVat(Math.round((subtotal * r) / 100));
            }}
          >
            {[0, 1, 10, 20].map((r) => (
              <option key={r} value={r}>
                %{r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="KDV tutarı">
          <MoneyInput value={vat} onChange={setVat} />
        </Field>
      </div>
      <div className="mt-2 text-sm text-muted">
        Toplam: <b className="text-ink">{formatTL((subtotal ?? 0) + (vat ?? 0))}</b>
      </div>
      <Field label="Not">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {del && initial && (
        <Confirm
          title="Kayıt silinsin mi?"
          text={`${initial.no} cariden de çıkar.`}
          yes="Sil"
          danger
          onClose={() => setDel(false)}
          onYes={async () => {
            await api.deleteManualEntry(initial.id);
            toast('Silindi');
            onSaved();
          }}
        />
      )}
    </Modal>
  );
}
