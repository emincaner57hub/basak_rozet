import { api, CHANNEL_LABEL } from '../api';
import { Link, useNav } from '../router';
import { Empty, ErrorLine, Page, Stat, useLoad } from '../ui';
import { fmtNum, fmtPct, formatTL, trDate } from '../money';

export default function Dashboard() {
  const { data: d, error } = useLoad(() => api.dashboard(), []);
  const inc = useLoad(() => api.incomingOrders(), []);
  const { go } = useNav();
  if (!d) return <Page title="Panel">{<ErrorLine error={error} />}</Page>;
  const margin = d.month.revenue ? (d.month.gross - d.month.promo) / d.month.revenue : null;
  return (
    <Page
      title="Panel"
      subtitle={`${trDate(d.today)} · bu ay`}
      actions={
        <>
          <button className="btn" onClick={() => go('/siparisler/excel')}>
            Excel'den sipariş
          </button>
          <button className="btn btn-primary" onClick={() => go('/siparisler/yeni')}>
            + Sipariş
          </button>
        </>
      }
    >
      {!!inc.data?.count && (
        <button
          className="mb-4 flex w-full items-center gap-3 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-left"
          onClick={() => go('/siparisler?durum=gelen')}
        >
          <span className="text-2xl">📥</span>
          <span className="flex-1">
            <b>{inc.data.count} yeni sipariş</b> müşteriden geldi
            <span className="block text-sm text-muted">Satın almacıların cepten verdiği, henüz açılmamış siparişler</span>
          </span>
          <span className="font-semibold text-warn">Gör ›</span>
        </button>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sevk bekleyen sipariş" value={fmtNum(d.openOrders.count)} sub={`${fmtNum(d.openOrders.units)} adet`} onClick={() => go('/siparisler')} />
        <Stat
          label="Fatura bekleyen sevkiyat"
          value={formatTL(d.pendingInvoice.net)}
          sub={`${d.pendingInvoice.dispatches} irsaliye · ${d.pendingInvoice.customers} müşteri`}
          tone={d.pendingInvoice.dispatches ? 'warn' : undefined}
          onClick={() => go('/faturalar')}
        />
        <Stat label="Açık alacak" value={formatTL(d.receivables.total)} sub={d.receivables.overdue ? `${formatTL(d.receivables.overdue)} vadesi geçmiş` : 'vadesi geçen yok'} tone={d.receivables.overdue ? 'bad' : undefined} onClick={() => go('/raporlar?r=alacak')} />
        <Stat label="Stok değeri" value={formatTL(d.stock.value)} sub={`${d.lotsInTransit} parti yolda${d.stock.low ? ` · ${d.stock.low} ürün kritik` : ''}`} tone={d.stock.low ? 'warn' : undefined} onClick={() => go('/urunler')} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bu ay satış (KDV hariç)" value={formatTL(d.month.revenue)} sub="sevk tarihine göre" />
        <Stat label="Satılan malın maliyeti" value={formatTL(d.month.cogs)} />
        <Stat label="Stand / etiket gideri" value={formatTL(d.month.promo)} />
        <Stat label="Net katkı" value={formatTL(d.month.gross - d.month.promo)} sub={`marj ${fmtPct(margin)}`} tone="ok" onClick={() => go('/raporlar?r=karlilik')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <h3 className="flex-1 font-semibold">Son siparişler</h3>
            <Link to="/siparisler">Tümü ›</Link>
          </div>
          <table className="tbl">
            <tbody>
              {d.recentOrders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => go(`/siparisler/${o.id}`)}>
                  <td className="whitespace-nowrap font-medium">{o.no}</td>
                  <td>
                    {o.chainName && <span className="text-muted">{o.chainName} · </span>}
                    {o.customerName}
                  </td>
                  <td className="hidden text-xs text-muted sm:table-cell">
                    {trDate(o.date)} · {CHANNEL_LABEL[o.channel]}
                  </td>
                  <td className="tabular text-right">{formatTL(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.recentOrders.length && <Empty>Sipariş yok.</Empty>}
        </div>
        <div className="card overflow-hidden">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <h3 className="flex-1 font-semibold">Vadesi geçen alacaklar</h3>
            <Link to="/raporlar?r=alacak">Rapor ›</Link>
          </div>
          <table className="tbl">
            <tbody>
              {d.receivables.top.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => go(`/musteriler/${r.id}`)}>
                  <td className="font-medium">{r.name}</td>
                  <td className="tabular text-right text-bad">{formatTL(r.overdue)}</td>
                  <td className="tabular text-right text-muted">/ {formatTL(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.receivables.top.length && <Empty>Vadesi geçen alacak yok.</Empty>}
        </div>
      </div>
    </Page>
  );
}
