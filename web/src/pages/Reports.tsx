import { Fragment, useState } from 'react';
import { api, KIND_LABEL, type SalesReport } from '../api';
import { queryParam, useNav } from '../router';
import { Badge, Empty, ErrorLine, Page, Tabs, useLoad } from '../ui';
import { fmtNum, fmtPct, formatTL, formatUnit, monthStart, today } from '../money';

type R = 'satis' | 'karlilik' | 'stok' | 'alacak';

/** CSV indir (Excel'de açılır; Türkçe karakterler için BOM) */
function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}
const tl = (k: number) => Math.round(k) / 100;

export function ReportsPage() {
  const { path } = useNav();
  const [r, setR] = useState<R>((queryParam(path, 'r') as R) || 'satis');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const dates = (
    <div className="mb-3 flex items-center gap-2">
      <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
      <span className="text-muted">–</span>
      <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
      <button className="btn btn-sm" onClick={() => setFrom(`${today().slice(0, 4)}-01-01`)}>
        Bu yıl
      </button>
      <button className="btn btn-sm" onClick={() => setFrom(monthStart())}>
        Bu ay
      </button>
    </div>
  );
  return (
    <Page title="Raporlar" subtitle="Satış ve kâr sevk (irsaliye) tarihine göre; maliyet gümrük, broker ve kargo dahil gerçek maliyettir">
      <Tabs
        value={r}
        onChange={setR}
        items={[
          ['satis', 'Satış'],
          ['karlilik', 'Müşteri kârlılığı'],
          ['stok', 'Stok'],
          ['alacak', 'Alacak yaşlandırma'],
        ]}
      />
      {(r === 'satis' || r === 'karlilik') && dates}
      {r === 'satis' && <Sales from={from} to={to} />}
      {r === 'karlilik' && <Profit from={from} to={to} />}
      {r === 'stok' && <Stock />}
      {r === 'alacak' && <Receivables />}
    </Page>
  );
}

function Sales({ from, to }: { from: string; to: string }) {
  const [group, setGroup] = useState<SalesReport['group']>('chain');
  const { data, error } = useLoad(() => api.salesReport({ from, to, group }), [from, to, group]);
  const tot = (data?.rows ?? []).reduce((s, r) => ({ qty: s.qty + r.qty, revenue: s.revenue + r.revenue, cogs: s.cogs + r.cogs, gross: s.gross + r.gross }), { qty: 0, revenue: 0, cogs: 0, gross: 0 });
  return (
    <>
      <ErrorLine error={error} />
      <div className="mb-3 flex items-center gap-2">
        <div className="flex rounded-lg border border-line bg-card p-0.5">
          {(
            [
              ['chain', 'Zincir / kafe'],
              ['customer', 'Şube'],
              ['product', 'Ürün'],
              ['month', 'Ay'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => setGroup(v)} className={`rounded-md px-3 py-1.5 text-sm ${group === v ? 'bg-brand text-white' : 'text-muted'}`}>
              {l}
            </button>
          ))}
        </div>
        <button
          className="btn btn-sm ml-auto"
          onClick={() => downloadCsv(`satis-${from}-${to}.csv`, [['', 'Adet', 'Ciro', 'Maliyet', 'Brüt kâr'], ...(data?.rows ?? []).map((x) => [x.label, x.qty, tl(x.revenue), tl(x.cogs), tl(x.gross)])])}
        >
          Excel (CSV)
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>{{ chain: 'Zincir / kafe', customer: 'Şube / kafe', product: 'Ürün', month: 'Ay' }[group]}</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Ciro (KDV hariç)</th>
              <th className="text-right">Maliyet</th>
              <th className="text-right">Brüt kâr</th>
              <th className="text-right">Marj</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((x) => (
              <tr key={`${x.id}-${x.label}`}>
                <td className="font-medium">{x.label}</td>
                <td className="tabular text-right">{fmtNum(x.qty)}</td>
                <td className="tabular text-right">{formatTL(x.revenue)}</td>
                <td className="tabular text-right text-muted">{formatTL(x.cogs)}</td>
                <td className="tabular text-right font-medium">{formatTL(x.gross)}</td>
                <td className="tabular text-right">{fmtPct(x.revenue ? x.gross / x.revenue : null)}</td>
              </tr>
            ))}
          </tbody>
          {data && data.rows.length > 0 && (
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2">Toplam</td>
                <td className="tabular px-3 py-2 text-right">{fmtNum(tot.qty)}</td>
                <td className="tabular px-3 py-2 text-right">{formatTL(tot.revenue)}</td>
                <td className="tabular px-3 py-2 text-right">{formatTL(tot.cogs)}</td>
                <td className="tabular px-3 py-2 text-right">{formatTL(tot.gross)}</td>
                <td className="tabular px-3 py-2 text-right">{fmtPct(tot.revenue ? tot.gross / tot.revenue : null)}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {data && !data.rows.length && <Empty>Bu aralıkta sevk yok.</Empty>}
      </div>
    </>
  );
}

function Profit({ from, to }: { from: string; to: string }) {
  const { data, error } = useLoad(() => api.profitReport({ from, to }), [from, to]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <>
      <ErrorLine error={error} />
      <p className="mb-3 text-sm text-muted">Net katkı = ciro − ürün maliyeti − stand/etiket gibi promosyon maliyeti ve müşteriye girilen pazarlama giderleri.</p>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Müşteri</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Ciro</th>
              <th className="text-right">Ürün maliyeti</th>
              <th className="text-right">Brüt kâr</th>
              <th className="text-right">Promosyon</th>
              <th className="text-right">Net katkı</th>
              <th className="text-right">Net marj</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((g) => (
              <Fragment key={g.id}>
                <tr
                  className={g.branches.length ? 'clickable' : ''}
                  onClick={() => {
                    const n = new Set(open);
                    if (n.has(g.id)) n.delete(g.id);
                    else n.add(g.id);
                    setOpen(n);
                  }}
                >
                  <td className="font-semibold">
                    {g.branches.length > 0 && <span className="mr-1 text-muted">{open.has(g.id) ? '▾' : '▸'}</span>}
                    {g.name} <Badge>{KIND_LABEL[g.kind]}</Badge>
                  </td>
                  <ProfitCells r={g} />
                </tr>
                {open.has(g.id) &&
                  g.branches.map((b) => (
                    <tr key={b.id} className="bg-paper/40">
                      <td className="pl-9">{b.name}</td>
                      <ProfitCells r={b} />
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {data && !data.rows.length && <Empty>Bu aralıkta sevk yok.</Empty>}
      </div>
    </>
  );
}
function ProfitCells({ r }: { r: { qty: number; revenue: number; cogs: number; gross: number; promo: number; net: number; margin: number | null } }) {
  return (
    <>
      <td className="tabular text-right">{fmtNum(r.qty)}</td>
      <td className="tabular text-right">{formatTL(r.revenue)}</td>
      <td className="tabular text-right text-muted">{formatTL(r.cogs)}</td>
      <td className="tabular text-right">{formatTL(r.gross)}</td>
      <td className={`tabular text-right ${r.promo ? 'text-warn' : 'text-muted'}`}>{r.promo ? `−${formatTL(r.promo)}` : '—'}</td>
      <td className={`tabular text-right font-semibold ${r.net < 0 ? 'text-bad' : ''}`}>{formatTL(r.net)}</td>
      <td className="tabular text-right">{fmtPct(r.margin)}</td>
    </>
  );
}

function Stock() {
  const { data, error } = useLoad(() => api.stockReport(), []);
  const value = (data ?? []).reduce((s, r) => s + Math.max(r.onHand, 0) * (r.avgCost ?? 0), 0);
  return (
    <>
      <ErrorLine error={error} />
      <div className="mb-3 flex items-center">
        <span className="text-sm text-muted">
          Toplam stok değeri: <b className="text-ink">{formatTL(value)}</b>
        </span>
        <button
          className="btn btn-sm ml-auto"
          onClick={() =>
            downloadCsv('stok.csv', [
              ['Kod', 'Ürün', 'Stok', 'Ort. maliyet', 'Değer', 'Yolda', 'Son 90 gün satış'],
              ...(data ?? []).map((r) => [r.code, r.name, r.onHand, r.avgCost == null ? null : tl(r.avgCost), tl(Math.max(r.onHand, 0) * (r.avgCost ?? 0)), r.onOrder, r.sold90]),
            ])
          }
        >
          Excel (CSV)
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ürün</th>
              <th className="text-right">Stok</th>
              <th className="text-right">Ort. maliyet</th>
              <th className="text-right">Değer</th>
              <th className="text-right">Yolda</th>
              <th className="text-right">Son 90 gün</th>
              <th className="text-right">Kaç gün yeter</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => {
              const perDay = r.sold90 / 90;
              const days = perDay > 0 ? Math.floor(Math.max(r.onHand, 0) / perDay) : null;
              const low = r.minQty != null && r.onHand <= r.minQty;
              return (
                <tr key={r.id}>
                  <td>
                    <b>{r.code}</b> {r.name} {r.kind === 'promo' && <Badge>Promosyon</Badge>}
                  </td>
                  <td className={`tabular text-right font-semibold ${r.onHand < 0 ? 'text-bad' : low ? 'text-warn' : ''}`}>{fmtNum(r.onHand)}</td>
                  <td className="tabular text-right text-muted">{formatUnit(r.avgCost)}</td>
                  <td className="tabular text-right">{formatTL(Math.max(r.onHand, 0) * (r.avgCost ?? 0))}</td>
                  <td className="tabular text-right text-muted">{r.onOrder ? fmtNum(r.onOrder) : '—'}</td>
                  <td className="tabular text-right">{fmtNum(r.sold90)}</td>
                  <td className={`tabular text-right ${days != null && days < 30 ? 'font-semibold text-warn' : 'text-muted'}`}>{days == null ? '—' : `${days} gün`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Receivables() {
  const { data, error } = useLoad(() => api.receivables(), []);
  const { go } = useNav();
  const sum = (k: 'balance' | 'current' | 'd30' | 'd60' | 'd90' | 'older') => (data ?? []).reduce((s, r) => s + r[k], 0);
  return (
    <>
      <ErrorLine error={error} />
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Müşteri (cari)</th>
              <th className="text-right">Bakiye</th>
              <th className="text-right">Vadesi gelmemiş</th>
              <th className="text-right">1–30 gün</th>
              <th className="text-right">31–60</th>
              <th className="text-right">61–90</th>
              <th className="text-right">90+</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => go(`/musteriler/${r.id}`)}>
                <td className="font-medium">
                  {r.name} <Badge>{r.kind === 'branch' ? 'Franchise' : KIND_LABEL[r.kind]}</Badge>
                </td>
                <td className="tabular text-right font-semibold">{formatTL(r.balance)}</td>
                <td className="tabular text-right">{r.current ? formatTL(r.current) : '—'}</td>
                <td className={`tabular text-right ${r.d30 ? 'text-warn' : 'text-muted'}`}>{r.d30 ? formatTL(r.d30) : '—'}</td>
                <td className={`tabular text-right ${r.d60 ? 'text-bad' : 'text-muted'}`}>{r.d60 ? formatTL(r.d60) : '—'}</td>
                <td className={`tabular text-right ${r.d90 ? 'text-bad' : 'text-muted'}`}>{r.d90 ? formatTL(r.d90) : '—'}</td>
                <td className={`tabular text-right ${r.older ? 'font-semibold text-bad' : 'text-muted'}`}>{r.older ? formatTL(r.older) : '—'}</td>
              </tr>
            ))}
          </tbody>
          {data && data.length > 0 && (
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2">Toplam</td>
                {(['balance', 'current', 'd30', 'd60', 'd90', 'older'] as const).map((k) => (
                  <td key={k} className="tabular px-3 py-2 text-right">
                    {formatTL(sum(k))}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
        {data && !data.length && <Empty>Açık alacak yok.</Empty>}
      </div>
    </>
  );
}
