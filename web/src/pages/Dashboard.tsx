import { useState, type ReactNode } from 'react';
import { api, type Dashboard as Dash, type DashStock } from '../api';
import { Link, useNav } from '../router';
import { ErrorLine, Field, Modal, MoneyInput, useLoad, useToast } from '../ui';
import { fmtNum, formatTL, today, trDate } from '../money';

/**
 * Genel bakış. Satış, adet ve katkı sevk (irsaliye) tarihine göre; ürün sayısından bağımsız
 * (her rozet tasarımı ayrı satır). Dönem seçilir; "son 30 gün" kutuları dönem sonuna göre.
 */

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const SHORT = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const pctText = (n: number) => `%${Math.round(Math.abs(n) * 100).toLocaleString('tr-TR')}`;
const tl0 = (kurus: number) => `₺${Math.round(kurus / 100).toLocaleString('tr-TR')}`;

function rangeLabel(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return `${fd} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  return `${trDate(from)} – ${trDate(to)}`;
}

function preset(k: 'month' | 'lastMonth' | 'last30' | 'year'): [string, string] {
  const t = today();
  const [y, m] = t.split('-').map(Number);
  const iso = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  if (k === 'month') return [iso(y, m, 1), t];
  if (k === 'lastMonth') {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    return [iso(py, pm, 1), iso(py, pm, new Date(Date.UTC(py, pm, 0)).getUTCDate())];
  }
  if (k === 'last30') return [new Date(Date.parse(t) - 29 * 86_400_000).toISOString().slice(0, 10), t];
  return [iso(y, 1, 1), t];
}

// ---------- Simgeler (çizgi) ----------
const P: Record<string, ReactNode> = {
  coins: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
  pin: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M12 13v8" />
    </>
  ),
  bars: <path d="M5 20v-6M10 20V9M15 20v-8M20 20V5" />,
  store: <path d="M4 9l1.5-5h13L20 9M4 9h16M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s2-1.3 2-3M5 12v8h14v-8M10 20v-5h4v5" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 010 6.4M18 14.8c2 .7 3.2 2.5 3.5 5.2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  box: <path d="M4 8l8-4 8 4v8l-8 4-8-4V8zM4 8l8 4 8-4M12 12v8" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  trophy: <path d="M8 4h8v5a4 4 0 01-8 0V4zM8 6H5v1a3 3 0 003 3M16 6h3v1a3 3 0 01-3 3M12 13v4M8.5 20h7M10 17h4v3h-4z" />,
  repeat: <path d="M4 12a8 8 0 0113.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 01-13.7 5.7L4 15.5M4 20v-4.5h4.5" />,
  layers: <path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
};
const Icon = ({ name, className = 'h-6 w-6' }: { name: keyof typeof P; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {P[name]}
  </svg>
);

const Card = ({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) => (
  <div onClick={onClick} className={`card p-4 ${onClick ? 'cursor-pointer hover:border-brand/40' : ''} ${className}`}>
    {children}
  </div>
);
const CardTitle = ({ icon, children, extra }: { icon: keyof typeof P; children: ReactNode; extra?: ReactNode }) => (
  <div className="mb-3 flex items-center gap-2">
    <Icon name={icon} className="h-5 w-5 text-brand" />
    <h3 className="flex-1 font-semibold">{children}</h3>
    {extra}
  </div>
);

function Change({ value, sub }: { value: number | null; sub?: string }) {
  if (value == null) return <span className="text-xs text-muted">{sub ? 'Önceki dönemde satış yok' : ''}</span>;
  const up = value >= 0;
  return (
    <span className={`text-sm ${up ? 'text-ok' : 'text-bad'}`}>
      {up ? '↗' : '↘'} {up ? '+' : '−'}
      {pctText(value)} {sub && <span className="text-xs text-muted">{sub}</span>}
    </span>
  );
}

function Kpi({ icon, label, value, children, onClick }: { icon: keyof typeof P; label: string; value: ReactNode; children?: ReactNode; onClick?: () => void }) {
  return (
    <Card onClick={onClick} className="flex gap-3">
      <Icon name={icon} className="mt-0.5 h-7 w-7 shrink-0 text-brand" />
      <div className="min-w-0">
        <div className="text-sm text-muted">{label}</div>
        <div className="tabular text-xl font-semibold xl:text-2xl">{value}</div>
        <div className="mt-0.5">{children}</div>
      </div>
    </Card>
  );
}

// ---------- Aylık satış trendi: tek ölçü (tutar ya da adet), ay üzerine gelince ikisi birden ----------
function Trend({ rows }: { rows: Dash['trend'] }) {
  const [measure, setMeasure] = useState<'revenue' | 'qty'>('revenue');
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 220;
  const pad = { l: 52, r: 8, t: 12, b: 26 };
  const vals = rows.map((r) => (measure === 'revenue' ? r.revenue / 100 : r.qty));
  const max = Math.max(...vals, 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / rows.length;
  const bw = Math.min(44, slot * 0.55);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const fmtTick = (v: number) => (measure === 'revenue' ? (v >= 1000 ? `${fmtNum(v / 1000)}B` : fmtNum(v)) : fmtNum(v));
  return (
    <Card className="lg:col-span-5">
      <CardTitle
        icon="bars"
        extra={
          <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="Ölçü">
            {(
              [
                ['revenue', 'Tutar (₺)'],
                ['qty', 'Adet'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setMeasure(k)} className={`rounded-md px-2 py-1 ${measure === k ? 'bg-brand text-white' : 'text-muted'}`}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        Aylık Satış Trendi
      </CardTitle>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Son 6 ay satış ${measure === 'revenue' ? 'tutarı' : 'adedi'}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={12} fill="var(--color-muted)">
                {fmtTick(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const v = vals[i];
            const cx = pad.l + slot * i + slot / 2;
            const h = Math.max(0, y(0) - y(v));
            const rr = Math.min(4, h);
            return (
              <g key={r.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill={hover === i ? 'var(--color-brand-soft)' : 'transparent'} />
                {h > 0 && (
                  <path
                    d={`M${cx - bw / 2},${y(0)} V${y(v) + rr} Q${cx - bw / 2},${y(v)} ${cx - bw / 2 + rr},${y(v)} H${cx + bw / 2 - rr} Q${cx + bw / 2},${y(v)} ${cx + bw / 2},${y(v) + rr} V${y(0)} Z`}
                    fill="var(--color-brand)"
                  />
                )}
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--color-muted)">
                  {SHORT[Number(r.month.slice(5)) - 1]}
                </text>
              </g>
            );
          })}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-card px-3 py-2 text-xs shadow"
            style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}
          >
            <div className="font-semibold">
              {MONTHS[Number(rows[hover].month.slice(5)) - 1]} {rows[hover].month.slice(0, 4)}
            </div>
            <div className="tabular">{formatTL(rows[hover].revenue)}</div>
            <div className="tabular text-muted">{fmtNum(rows[hover].qty)} adet</div>
          </div>
        )}
      </div>
    </Card>
  );
}
function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// ---------- Hedef halkası ----------
function Target({ t, onEdit }: { t: Dash['target']; onEdit: () => void }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const ratio = t.period ? t.actual / t.period : 0;
  return (
    <Card className="lg:col-span-3">
      <CardTitle
        icon="target"
        extra={
          <button className="text-xs text-brand hover:underline" onClick={onEdit}>
            {t.monthly ? 'Değiştir' : 'Hedef gir'}
          </button>
        }
      >
        Aylık Hedef Gerçekleşme
      </CardTitle>
      {t.monthly ? (
        <div className="flex flex-col items-center">
          <svg viewBox="0 0 160 160" className="h-44 w-44" role="img" aria-label={`Hedefin ${pctText(ratio)}'i`}>
            <circle cx="80" cy="80" r={r} fill="none" stroke="var(--color-brand-soft)" strokeWidth={14} />
            <circle
              cx="80"
              cy="80"
              r={r}
              fill="none"
              stroke={ratio >= 1 ? 'var(--color-ok)' : 'var(--color-brand)'}
              strokeWidth={14}
              strokeLinecap="round"
              strokeDasharray={`${Math.min(ratio, 1) * c} ${c}`}
              transform="rotate(-90 80 80)"
            />
            <text x="80" y="90" textAnchor="middle" fontSize={30} fontWeight={600} fill="var(--color-ink)">
              {pctText(ratio)}
            </text>
          </svg>
          <div className="tabular mt-1 text-sm">
            {tl0(t.actual)} / {tl0(t.period)}
          </div>
          {t.period !== t.monthly && <div className="text-xs text-muted">aylık hedef × dönemdeki ay sayısı</div>}
        </div>
      ) : (
        <div className="flex h-44 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
          Aylık satış hedefi girilmemiş.
          <button className="btn btn-sm" onClick={onEdit}>
            Hedef gir
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------- Aksiyon listesi ----------
type ActionKey = 'silent' | 'new' | 'stock' | 'due';
function Actions({ a, open }: { a: Dash['actions']; open: (k: ActionKey) => void }) {
  const rows: { key: ActionKey; icon: keyof typeof P; tone: string; n: number; text: string }[] = [
    { key: 'silent', icon: 'clock', tone: 'text-warn', n: a.silent.items.length, text: `şube son ${a.silent.days / 7} haftadır sipariş vermedi` },
    { key: 'new', icon: 'check', tone: 'text-ok', n: a.newPoints.length, text: 'yeni şube aktif oldu' },
    { key: 'stock', icon: 'box', tone: 'text-warn', n: a.runningOut.items.length, text: `ürünün stoğu ${a.runningOut.days} gün içinde tükenebilir` },
    { key: 'due', icon: 'info', tone: 'text-brand', n: a.dueThisWeek.length, text: 'müşterinin ödemesi bu hafta vadesinde' },
  ];
  const count = rows.filter((r) => r.n > 0).length;
  return (
    <Card className="lg:col-span-4">
      <CardTitle icon="bell" extra={<span className="grid h-6 min-w-6 place-items-center rounded-full bg-brand px-1.5 text-xs font-semibold text-white">{count}</span>}>
        Aksiyon Listesi
      </CardTitle>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <button
            key={r.key}
            disabled={!r.n}
            onClick={() => open(r.key)}
            className="flex w-full items-center gap-3 rounded-lg bg-paper px-3 py-2.5 text-left text-sm hover:bg-brand-soft disabled:cursor-default disabled:opacity-60 disabled:hover:bg-paper"
          >
            <Icon name={r.icon} className={`h-5 w-5 shrink-0 ${r.tone}`} />
            <span className="flex-1">
              <b>{fmtNum(r.n)}</b> {r.text}
            </span>
            {r.n > 0 && <span className="text-muted">›</span>}
          </button>
        ))}
      </div>
    </Card>
  );
}

const pointName = (p: { name: string; chainName: string | null }) => (p.chainName ? `${p.chainName} – ${p.name}` : p.name);

function ActionModal({ k, a, onClose }: { k: ActionKey; a: Dash['actions']; onClose: () => void }) {
  const { go } = useNav();
  const nav = (to: string) => () => {
    onClose();
    go(to);
  };
  const title = { silent: `Son ${a.silent.days / 7} haftadır sipariş vermeyen şubeler`, new: 'Bu dönem ilk kez satış yapılan şubeler', stock: `${a.runningOut.days} gün içinde tükenebilecek ürünler`, due: 'Bu hafta vadesi gelen ödemeler' }[k];
  return (
    <Modal title={title} onClose={onClose} width={560}>
      <table className="tbl">
        <tbody>
          {k === 'silent' &&
            a.silent.items.map((p) => (
              <tr key={p.id} className="clickable" onClick={nav(`/musteriler/${p.id}`)}>
                <td>{pointName(p)}</td>
                <td className="text-right text-muted">son sipariş {trDate(p.lastOrder)}</td>
              </tr>
            ))}
          {k === 'new' &&
            a.newPoints.map((p) => (
              <tr key={p.id} className="clickable" onClick={nav(`/musteriler/${p.id}`)}>
                <td>{pointName(p)}</td>
                <td className="text-right text-muted">ilk sevk {trDate(p.first)}</td>
              </tr>
            ))}
          {k === 'stock' &&
            a.runningOut.items.map((p) => (
              <tr key={p.id} className="clickable" onClick={nav(`/urunler/${p.id}`)}>
                <td>
                  <b>{p.code}</b> {p.name}
                </td>
                <td className="tabular text-right">{fmtNum(p.onHand)} adet</td>
                <td className="tabular text-right font-semibold text-bad">{p.daysLeft} gün</td>
              </tr>
            ))}
          {k === 'due' &&
            a.dueThisWeek.map((c) => (
              <tr key={c.id} className="clickable" onClick={nav(`/musteriler/${c.id}`)}>
                <td>{c.name}</td>
                <td className="text-muted">{trDate(c.dueDate)}</td>
                <td className="tabular text-right font-semibold">{formatTL(c.amount)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Modal>
  );
}

function DaysPill({ s }: { s: DashStock }) {
  if (s.daysLeft == null) return <span className="text-xs text-muted">satış yok</span>;
  const tone = s.daysLeft <= 15 ? 'bg-bad-soft text-bad' : s.daysLeft <= 30 ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok';
  return <span className={`tabular inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{s.daysLeft > 999 ? '999+ gün' : `${fmtNum(s.daysLeft)} gün`}</span>;
}

function Thumb({ image, name }: { image: string | null; name: string }) {
  return image ? (
    <img src={image} alt="" className="h-9 w-9 shrink-0 rounded-lg border border-line object-cover" />
  ) : (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-semibold text-brand" aria-hidden>
      {name.slice(0, 1).toLocaleUpperCase('tr')}
    </span>
  );
}

// ---------- Sayfa ----------
export default function Dashboard() {
  const [range, setRange] = useState<[string, string]>(() => preset('month'));
  const [picker, setPicker] = useState(false);
  const [modal, setModal] = useState<ActionKey | null>(null);
  const [editTarget, setEditTarget] = useState(false);
  const { data: d, error, reload } = useLoad(() => api.dashboard({ from: range[0], to: range[1] }), [range[0], range[1]]);
  const inc = useLoad(() => api.incomingOrders(), []);
  const { go } = useNav();
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 md:px-6 md:py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-semibold">Genel Bakış</h1>
        <div className="relative">
          <button className="btn gap-2" onClick={() => setPicker((x) => !x)} aria-expanded={picker}>
            <Icon name="calendar" className="h-4 w-4" />
            {rangeLabel(range[0], range[1])} <span className="text-muted">▾</span>
          </button>
          {picker && <RangePicker value={range} onChange={(r) => (setRange(r), setPicker(false))} onClose={() => setPicker(false)} />}
        </div>
        <button className="btn btn-primary" onClick={() => go('/siparisler/yeni')}>
          + Sipariş
        </button>
      </div>
      {!!inc.data?.count && (
        <button className="mb-4 flex w-full items-center gap-3 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-left" onClick={() => go('/siparisler?durum=gelen')}>
          <span className="text-2xl">📥</span>
          <span className="flex-1">
            <b>{inc.data.count} yeni sipariş</b> müşteriden geldi
          </span>
          <span className="font-semibold text-warn">Gör ›</span>
        </button>
      )}
      <ErrorLine error={error} />
      {d && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi icon="coins" label="Toplam Satış (KDV Hariç)" value={formatTL(d.kpi.revenue.value)} onClick={() => go('/raporlar')}>
              <Change value={d.kpi.revenue.change} sub="(Geçen aya göre)" />
            </Kpi>
            <Kpi icon="pin" label="Satılan Rozet Adedi" value={`${fmtNum(d.kpi.qty.value)} adet`}>
              <Change value={d.kpi.qty.change} />
            </Kpi>
            <Kpi icon="bars" label="Net Katkı" value={formatTL(d.kpi.net.value)} onClick={() => go('/raporlar?r=karlilik')}>
              <span className="text-sm text-muted">
                Katkı Marjı: <span className="text-ok">{d.kpi.net.margin == null ? '—' : pctText(d.kpi.net.margin)}</span>
              </span>
            </Kpi>
            <Kpi icon="store" label="Aktif Satış Noktası" value={`${fmtNum(d.kpi.points.value)} şube`} onClick={() => d.actions.newPoints.length && setModal('new')}>
              {d.kpi.points.new > 0 && <span className="text-sm text-ok">↗ +{d.kpi.points.new} yeni şube</span>}
            </Kpi>
            <Kpi icon="users" label="Aktif Müşteri" value={`${fmtNum(d.kpi.brands.value)} marka`} onClick={() => go('/musteriler')}>
              {d.kpi.brands.new > 0 && <span className="text-sm text-ok">↗ +{d.kpi.brands.new} yeni müşteri</span>}
            </Kpi>
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-12">
            <Trend rows={d.trend} />
            <Target t={d.target} onEdit={() => setEditTarget(true)} />
            <Actions a={d.actions} open={setModal} />
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
            <Card className="flex gap-3 lg:col-span-3" onClick={d.topBranch ? () => go(`/musteriler/${d.topBranch!.id}`) : undefined}>
              <Icon name="trophy" className="h-10 w-10 shrink-0 text-warn" />
              <div className="min-w-0">
                <div className="text-sm text-muted">En Çok Sipariş Veren Şube</div>
                {d.topBranch ? (
                  <>
                    <div className="truncate text-lg font-semibold">{pointName(d.topBranch)}</div>
                    <div className="text-sm">Son 30 gün: {fmtNum(d.topBranch.qty)} adet</div>
                    <div className="text-sm">Toplam Tutar: {formatTL(d.topBranch.total)}</div>
                  </>
                ) : (
                  <div className="mt-1 text-sm text-muted">Son 30 günde sipariş yok</div>
                )}
              </div>
            </Card>
            <Card className="lg:col-span-3">
              <div className="flex items-start gap-3">
                <Icon name="clock" className="h-8 w-8 shrink-0 text-bad" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-semibold">Son {d.actions.silent.days / 7} Haftadır Sipariş Vermeyen Şubeler</span>
                    <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">{d.actions.silent.items.length} şube</span>
                  </div>
                  {d.actions.silent.items.length ? (
                    <ul className="mt-1.5 space-y-0.5 text-sm">
                      {d.actions.silent.items.slice(0, 3).map((p) => (
                        <li key={p.id} className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
                          <Link to={`/musteriler/${p.id}`} className="truncate hover:underline">
                            {pointName(p)}
                          </Link>
                        </li>
                      ))}
                      {d.actions.silent.items.length > 3 && (
                        <li>
                          <button className="text-ok hover:underline" onClick={() => setModal('silent')}>
                            + {d.actions.silent.items.length - 3} şube daha
                          </button>
                        </li>
                      )}
                    </ul>
                  ) : (
                    <div className="mt-1.5 text-sm text-muted">Hepsi son 2 haftada sipariş verdi.</div>
                  )}
                </div>
              </div>
            </Card>
            <div className="lg:col-span-3">
              <Kpi icon="repeat" label="Tekrar Sipariş Oranı" value={d.repeat.rate == null ? '—' : pctText(d.repeat.rate)}>
                <span className="text-sm text-muted">
                  (Son 3 ay · {d.repeat.repeaters}/{d.repeat.buyers} şube)
                </span>
              </Kpi>
            </div>
            <div className="lg:col-span-3">
              <Kpi icon="store" label="Şube Başı Ort. Satış" value={d.perPointMonthly == null ? '—' : `${fmtNum(d.perPointMonthly)} adet / ay`} />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Card>
              <CardTitle icon="pin" extra={<span className="text-xs text-muted">Son 30 gün</span>}>
                En Çok Satan Rozetler
              </CardTitle>
              {d.topProducts.length ? (
                <div className="space-y-2.5">
                  {d.topProducts.map((p) => (
                    <Link key={p.id} to={`/urunler/${p.id}`} className="flex items-center gap-3 rounded-lg hover:bg-paper">
                      <Thumb image={p.image} name={p.name} />
                      <span className="w-32 truncate text-sm" title={`${p.code} ${p.name}`}>
                        {p.name}
                      </span>
                      <span className="h-2 flex-1 rounded-full bg-paper">
                        <span className="block h-2 rounded-full bg-brand" style={{ width: `${(p.qty / d.topProducts[0].qty) * 100}%` }} />
                      </span>
                      <span className="tabular w-20 text-right text-sm">{fmtNum(p.qty)} adet</span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted">Son 30 günde satış yok.</div>
              )}
            </Card>
            <Card className="overflow-x-auto">
              <CardTitle icon="users">Müşteri / Zincir Performansı</CardTitle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-paper text-left text-xs text-muted">
                    <th className="rounded-l-md px-2 py-1.5 font-medium">Müşteri</th>
                    <th className="px-2 py-1.5 text-right font-medium">Aktif Şube</th>
                    <th className="px-2 py-1.5 text-right font-medium">Satış (Adet)</th>
                    <th className="rounded-r-md px-2 py-1.5 text-right font-medium">Net Katkı (₺)</th>
                  </tr>
                </thead>
                <tbody>
                  {d.brands.map((b) => (
                    <tr key={b.id ?? 'other'} className={`border-b border-line last:border-0 ${b.id ? 'cursor-pointer hover:bg-paper' : ''}`} onClick={() => b.id && go(`/musteriler/${b.id}`)}>
                      <td className="px-2 py-2 font-medium">{b.name}</td>
                      <td className="tabular px-2 py-2 text-right">{fmtNum(b.points)}</td>
                      <td className="tabular px-2 py-2 text-right">{fmtNum(b.qty)}</td>
                      <td className={`tabular px-2 py-2 text-right ${b.net < 0 ? 'text-bad' : ''}`}>{fmtNum(Math.round(b.net / 100))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.brands.length && <div className="py-6 text-center text-sm text-muted">Bu dönemde satış yok.</div>}
            </Card>
            <Card className="overflow-x-auto">
              <CardTitle icon="layers" extra={<span className="text-xs text-muted">ilk 5 ürün</span>}>
                Stok Durumu
              </CardTitle>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-paper text-left text-xs text-muted">
                    <th className="rounded-l-md px-2 py-1.5 font-medium">Ürün</th>
                    <th className="px-2 py-1.5 text-right font-medium">Mevcut Stok</th>
                    <th className="rounded-r-md px-2 py-1.5 text-right font-medium" title="Son 90 günün satış hızıyla">
                      Tahmini Gün
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.stock.map((s) => (
                    <tr key={s.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-paper" onClick={() => go(`/urunler/${s.id}`)}>
                      <td className="px-2 py-2">{s.name}</td>
                      <td className="tabular px-2 py-2 text-right">{fmtNum(s.onHand)}</td>
                      <td className="px-2 py-2 text-right">
                        <DaysPill s={s} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.stock.length && <div className="py-6 text-center text-sm text-muted">Satış ürünü yok.</div>}
            </Card>
          </div>
          <p className="mt-3 text-xs text-muted">
            Satış, adet ve katkı sevk (irsaliye) tarihine göre, KDV hariç. Net katkı = satış − satılan malın maliyeti − stand / etiket ve pazarlama gideri. "Son 30 gün" kutuları seçili dönemin son gününe göre.
          </p>
          {modal && <ActionModal k={modal} a={d.actions} onClose={() => setModal(null)} />}
          {editTarget && (
            <TargetModal
              monthly={d.target.monthly}
              onClose={() => setEditTarget(false)}
              onSaved={() => {
                setEditTarget(false);
                reload();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function RangePicker({ value, onChange, onClose }: { value: [string, string]; onChange: (r: [string, string]) => void; onClose: () => void }) {
  const [from, setFrom] = useState(value[0]);
  const [to, setTo] = useState(value[1]);
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-line bg-card p-3 shadow-lg">
        <div className="mb-3 grid grid-cols-2 gap-1.5">
          {(
            [
              ['month', 'Bu ay'],
              ['lastMonth', 'Geçen ay'],
              ['last30', 'Son 30 gün'],
              ['year', 'Bu yıl'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className="btn btn-sm" onClick={() => onChange(preset(k))}>
              {l}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Başlangıç">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Bitiş">
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-primary mt-3 w-full" disabled={!from || !to || from > to} onClick={() => onChange([from, to])}>
          Uygula
        </button>
      </div>
    </>
  );
}

function TargetModal({ monthly, onClose, onSaved }: { monthly: number; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<number | null>(monthly || null);
  const [err, setErr] = useState('');
  const toast = useToast();
  return (
    <Modal
      title="Aylık satış hedefi"
      onClose={onClose}
      width={380}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await api.setDashboardTarget(v ?? 0);
                toast('Hedef kaydedildi');
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
      <Field label="Aylık satış hedefi (KDV hariç)" hint="Boş bırakılırsa hedef gösterilmez. Birden fazla ayı kapsayan dönemde ay sayısıyla çarpılır.">
        <MoneyInput value={v} onChange={setV} />
      </Field>
    </Modal>
  );
}
