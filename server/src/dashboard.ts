import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { addDays, getSetting, setSetting, todayTr } from './db.js';
import { invoiceStates } from './invoices.js';
import { daySchema } from './lib.js';

/**
 * Genel bakış (panel). Satış, adet ve katkı irsaliye (sevk) tarihine göre — raporlarla aynı tanım:
 * satış = sevk edilen satış ürünlerinin KDV hariç tutarı; net katkı = satış − satılan malın maliyeti
 * − promosyon gideri (bedelsiz stand/etiket maliyeti + elle girilen pazarlama giderleri).
 * "Sipariş verdi / vermedi" ise sipariş tarihine göre. Ürün sayısından bağımsız çalışır (çok rozet).
 */

const SALE_LINES = `
  FROM dispatch_lines dl
  JOIN dispatches d ON d.id = dl.dispatch_id AND NOT d.cancelled
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN stock_moves m ON m.dispatch_line_id = dl.id`;

/** Tamamen iptal edilmemiş sipariş (kapatılmış ama kısmen sevk edilmiş sayılır) */
const LIVE_ORDER = `(NOT o.cancelled OR EXISTS (SELECT 1 FROM dispatches dd WHERE dd.order_id = o.id AND NOT dd.cancelled))`;

const TARGET_KEY = 'dash_monthly_target';
const SILENT_DAYS = 14;
const STOCK_WARN_DAYS = 15;

/** 'YYYY-MM-DD' ± ay (ay sonu taşarsa ayın son gününe) */
function addMonths(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
const monthsSpanned = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
const pctChange = (cur: number, prev: number) => (prev ? (cur - prev) / prev : null);

export function registerDashboard(app: FastifyInstance, { db, now }: { db: Db; now: () => Date }) {
  /** Dönem toplamları: satış, adet, maliyet, promosyon, aktif nokta / marka */
  async function totals(from: string, to: string) {
    const [t] = await db.query<{ revenue: number; qty: number; cogs: number; promo: number; points: number; brands: number }>(
      `SELECT COALESCE(SUM(dl.qty * dl.unit_price) FILTER (WHERE NOT dl.is_promo),0) revenue,
              COALESCE(SUM(dl.qty) FILTER (WHERE NOT dl.is_promo),0) qty,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE NOT dl.is_promo),0) cogs,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE dl.is_promo),0) promo,
              COUNT(DISTINCT d.customer_id) FILTER (WHERE NOT dl.is_promo) points,
              COUNT(DISTINCT COALESCE(c.parent_id, c.id)) FILTER (WHERE NOT dl.is_promo) brands
       ${SALE_LINES} WHERE d.date BETWEEN $1 AND $2`,
      [from, to],
    );
    const [x] = await db.query<{ amount: number }>('SELECT COALESCE(SUM(amount),0) amount FROM promo_expenses WHERE date BETWEEN $1 AND $2', [from, to]);
    const promo = t.promo + x.amount;
    const net = Math.round(t.revenue - t.cogs - promo);
    return { revenue: t.revenue, qty: t.qty, net, margin: t.revenue ? net / t.revenue : null, points: t.points, brands: t.brands };
  }

  /** İlk satışı (sevk) bu dönemde olan satış noktaları ve markalar */
  async function newcomers(from: string, to: string) {
    const points = await db.query<{ id: number; name: string; chainName: string | null; first: string }>(
      `SELECT c.id, c.name, ch.name "chainName", f.first FROM (
         SELECT d.customer_id id, MIN(d.date) first FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id AND NOT dl.is_promo
         WHERE NOT d.cancelled GROUP BY d.customer_id) f
       JOIN customers c ON c.id = f.id LEFT JOIN customers ch ON ch.id = c.parent_id
       WHERE f.first BETWEEN $1 AND $2 ORDER BY f.first DESC`,
      [from, to],
    );
    const [brands] = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM (
         SELECT COALESCE(c.parent_id, c.id) id, MIN(d.date) first FROM dispatches d JOIN customers c ON c.id = d.customer_id
         JOIN dispatch_lines dl ON dl.dispatch_id = d.id AND NOT dl.is_promo WHERE NOT d.cancelled GROUP BY 1) f
       WHERE f.first BETWEEN $1 AND $2`,
      [from, to],
    );
    return { points, brands: brands.n };
  }

  app.get('/api/dashboard', async (req) => {
    const today = todayTr(now());
    const q = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    const to = q.to ?? today;
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    const days = Math.max(1, daysBetween(from, to));
    const last30 = addDays(to, -29);

    // ---- Üst kartlar: dönem ve geçen ayın aynı günleri ----
    const cur = await totals(from, to);
    const prev = await totals(addMonths(from, -1), addMonths(to, -1));
    const fresh = await newcomers(from, to);

    // ---- Aylık trend: dönem sonundan geriye 6 ay ----
    const trendStart = `${addMonths(`${to.slice(0, 7)}-01`, -5)}`;
    const trendRows = await db.query<{ month: string; revenue: number; qty: number }>(
      `SELECT to_char(d.date, 'YYYY-MM') "month", SUM(dl.qty * dl.unit_price) revenue, SUM(dl.qty) qty
       ${SALE_LINES} WHERE NOT dl.is_promo AND d.date BETWEEN $1 AND $2 GROUP BY 1`,
      [trendStart, to],
    );
    const trend = Array.from({ length: 6 }, (_, i) => {
      const month = addMonths(trendStart, i).slice(0, 7);
      const r = trendRows.find((x) => x.month === month);
      return { month, revenue: r?.revenue ?? 0, qty: r?.qty ?? 0 };
    });

    // ---- Hedef: aylık hedef × dönemin kapsadığı ay sayısı ----
    const monthly = Number(await getSetting(db, TARGET_KEY, '0')) || 0;
    const target = { monthly, period: monthly * monthsSpanned(from, to), actual: cur.revenue };

    // ---- Son 2 haftadır sipariş vermeyen (daha önce sipariş vermiş, aktif) satış noktaları ----
    const silent = await db.query<{ id: number; name: string; chainName: string | null; lastOrder: string }>(
      `SELECT c.id, c.name, ch.name "chainName", MAX(o.date) "lastOrder"
       FROM customers c JOIN orders o ON o.customer_id = c.id AND ${LIVE_ORDER} LEFT JOIN customers ch ON ch.id = c.parent_id
       WHERE c.active AND c.kind <> 'chain'
       GROUP BY c.id, c.name, ch.name HAVING MAX(o.date) < $1
       ORDER BY MAX(o.date) DESC`,
      [addDays(today, -SILENT_DAYS)],
    );

    // ---- Stok: ürün başına mevcut stok ve son 90 günün satış hızıyla kaç gün yeter ----
    const stockRows = await db.query<{ id: number; code: string; name: string; image: string | null; onHand: number; sold90: number }>(
      `SELECT p.id, p.code, p.name, p.image,
              COALESCE((SELECT SUM(qty) FROM stock_moves WHERE product_id = p.id),0) "onHand",
              COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
                        WHERE dl.product_id = p.id AND NOT d.cancelled AND NOT dl.is_promo AND d.date BETWEEN $1 AND $2),0) sold90
       FROM products p WHERE p.active AND p.kind = 'sale'`,
      [addDays(today, -89), today],
    );
    const stock = stockRows
      .map((p) => ({ ...p, daysLeft: p.sold90 > 0 ? Math.max(0, Math.floor(p.onHand / (p.sold90 / 90))) : null }))
      .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || b.sold90 - a.sold90);
    const runningOut = stock.filter((p) => p.daysLeft != null && p.daysLeft <= STOCK_WARN_DAYS);

    // ---- Bu hafta (bugün + 6 gün) vadesi gelen ödenmemiş faturalar ----
    const weekEnd = addDays(today, 6);
    const dueCandidates = await db.query<{ id: number; name: string }>(
      `SELECT DISTINCT c.id, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE NOT i.cancelled AND i.due_date BETWEEN $1 AND $2`,
      [today, weekEnd],
    );
    const dueThisWeek: { id: number; name: string; amount: number; dueDate: string }[] = [];
    for (const c of dueCandidates) {
      const states = await invoiceStates(db, c.id, today);
      const invs = await db.query<{ id: number; due_date: string }>(
        'SELECT id, due_date FROM invoices WHERE customer_id = $1 AND NOT cancelled AND due_date BETWEEN $2 AND $3 ORDER BY due_date',
        [c.id, today, weekEnd],
      );
      const open = invs.filter((i) => (states.get(i.id)?.remaining ?? 0) > 0);
      if (open.length) dueThisWeek.push({ id: c.id, name: c.name, amount: open.reduce((s, i) => s + states.get(i.id)!.remaining, 0), dueDate: open[0].due_date });
    }
    dueThisWeek.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    // ---- En çok sipariş veren satış noktası (son 30 gün, sipariş adedi) ----
    const [topBranch] = await db.query<{ id: number; name: string; chainName: string | null; qty: number; total: number; orders: number }>(
      `SELECT c.id, c.name, ch.name "chainName", SUM(ol.qty) qty, SUM(ol.qty * ol.unit_price) total, COUNT(DISTINCT o.id) orders
       FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN products p ON p.id = ol.product_id AND p.kind = 'sale'
       JOIN customers c ON c.id = o.customer_id LEFT JOIN customers ch ON ch.id = c.parent_id
       WHERE ${LIVE_ORDER} AND o.date BETWEEN $1 AND $2
       GROUP BY c.id, c.name, ch.name ORDER BY qty DESC, total DESC LIMIT 1`,
      [last30, to],
    );

    // ---- Tekrar sipariş oranı (son 3 ay): sipariş verenlerden en az 2 sipariş verenlerin payı ----
    const [repeat] = await db.query<{ buyers: number; repeaters: number }>(
      `SELECT COUNT(*)::int buyers, COUNT(*) FILTER (WHERE n >= 2)::int repeaters FROM (
         SELECT o.customer_id, COUNT(*) n FROM orders o WHERE ${LIVE_ORDER} AND o.date BETWEEN $1 AND $2 GROUP BY o.customer_id) x`,
      [addMonths(to, -3), to],
    );

    // ---- En çok satan rozetler (son 30 gün, sevk) ----
    const topProducts = await db.query<{ id: number; code: string; name: string; category: string | null; image: string | null; qty: number; revenue: number }>(
      `SELECT p.id, p.code, p.name, p.category, p.image, SUM(dl.qty) qty, SUM(dl.qty * dl.unit_price) revenue
       ${SALE_LINES} JOIN products p ON p.id = dl.product_id
       WHERE NOT dl.is_promo AND d.date BETWEEN $1 AND $2
       GROUP BY p.id ORDER BY qty DESC LIMIT 5`,
      [last30, to],
    );

    // ---- Müşteri / zincir performansı (dönem): aktif şube, adet, net katkı ----
    const brandRows = await db.query<{ id: number; name: string; kind: string; points: number; qty: number; revenue: number; cogs: number; promo: number }>(
      `SELECT b.id, b.name, b.kind,
              COUNT(DISTINCT d.customer_id) FILTER (WHERE NOT dl.is_promo) points,
              COALESCE(SUM(dl.qty) FILTER (WHERE NOT dl.is_promo),0) qty,
              COALESCE(SUM(dl.qty * dl.unit_price) FILTER (WHERE NOT dl.is_promo),0) revenue,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE NOT dl.is_promo),0) cogs,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE dl.is_promo),0) promo
       ${SALE_LINES} JOIN customers b ON b.id = COALESCE(c.parent_id, c.id)
       WHERE d.date BETWEEN $1 AND $2 GROUP BY b.id, b.name, b.kind`,
      [from, to],
    );
    const extra = await db.query<{ id: number; amount: number }>(
      `SELECT COALESCE(c.parent_id, c.id) id, SUM(e.amount) amount FROM promo_expenses e JOIN customers c ON c.id = e.customer_id
       WHERE e.date BETWEEN $1 AND $2 GROUP BY 1`,
      [from, to],
    );
    const brands = brandRows
      .map((b) => ({ id: b.id, name: b.name, kind: b.kind, points: b.points, qty: b.qty, revenue: b.revenue, net: Math.round(b.revenue - b.cogs - b.promo - (extra.find((e) => e.id === b.id)?.amount ?? 0)) }))
      .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);
    const topBrands = brands.slice(0, 4);
    const rest = brands.slice(4);
    const other = rest.length
      ? { id: null, name: `Diğer (${rest.length})`, kind: 'other', points: rest.reduce((s, b) => s + b.points, 0), qty: rest.reduce((s, b) => s + b.qty, 0), revenue: rest.reduce((s, b) => s + b.revenue, 0), net: rest.reduce((s, b) => s + b.net, 0) }
      : null;

    return {
      today,
      from,
      to,
      kpi: {
        revenue: { value: cur.revenue, change: pctChange(cur.revenue, prev.revenue) },
        qty: { value: cur.qty, change: pctChange(cur.qty, prev.qty) },
        net: { value: cur.net, margin: cur.margin },
        points: { value: cur.points, new: fresh.points.length },
        brands: { value: cur.brands, new: fresh.brands },
      },
      trend,
      target,
      actions: {
        silent: { days: SILENT_DAYS, items: silent },
        newPoints: fresh.points,
        runningOut: { days: STOCK_WARN_DAYS, items: runningOut },
        dueThisWeek,
      },
      topBranch: topBranch ?? null,
      repeat: { ...repeat, rate: repeat.buyers ? repeat.repeaters / repeat.buyers : null },
      perPointMonthly: cur.points ? Math.round(((cur.qty / cur.points) * 30) / days) : null,
      topProducts,
      brands: other ? [...topBrands, other] : topBrands,
      stock: stock.slice(0, 5),
    };
  });

  app.put('/api/dashboard/target', async (req) => {
    const b = z.object({ monthly: z.number().int().min(0).max(1e13) }).parse(req.body);
    await setSetting(db, TARGET_KEY, String(b.monthly));
    return { ok: true };
  });
}
