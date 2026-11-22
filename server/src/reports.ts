import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { todayTr } from './db.js';
import { BALANCE_SQL } from './customers.js';
import { invoiceStates } from './invoices.js';
import { daySchema, type Row } from './lib.js';

/**
 * Raporlar. Satış ve kâr irsaliye (sevk) tarihine göre hesaplanır: gelir = sevk edilen ürünün
 * KDV hariç tutarı, maliyet = sevk anındaki ortalama maliyet. Promosyon (stand, etiket) satırlarının
 * maliyeti ve elle girilen pazarlama giderleri müşterinin "promosyon gideri"dir.
 */

const LINES = `
  FROM dispatch_lines dl
  JOIN dispatches d ON d.id = dl.dispatch_id AND NOT d.cancelled
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN customers ch ON ch.id = c.parent_id
  JOIN products p ON p.id = dl.product_id
  LEFT JOIN stock_moves m ON m.dispatch_line_id = dl.id
  WHERE d.date BETWEEN $1 AND $2`;

export function registerReports(app: FastifyInstance, { db, now }: { db: Db; now: () => Date }) {
  const range = (q: unknown) => {
    const r = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(q);
    const today = todayTr(now());
    return { from: r.from ?? `${today.slice(0, 7)}-01`, to: r.to ?? today };
  };

  /** Satış: müşteri / zincir / ürün / ay bazında ciro, maliyet, brüt kâr */
  app.get('/api/reports/sales', async (req) => {
    const { from, to } = range(req.query);
    const { group } = z.object({ group: z.enum(['customer', 'chain', 'product', 'month']).default('chain') }).parse(req.query);
    const key = {
      customer: `c.id, COALESCE(ch.name || ' · ', '') || c.name`,
      chain: `COALESCE(ch.id, c.id), COALESCE(ch.name, c.name)`,
      product: `p.id, p.code || ' ' || p.name`,
      month: `0, to_char(d.date, 'YYYY-MM')`,
    }[group];
    const rows = await db.query<Row & { revenue: number; cogs: number }>(
      `SELECT ${key.split(', ')[0]} id, ${key.slice(key.indexOf(', ') + 2)} label,
              SUM(dl.qty) qty, SUM(dl.qty * dl.unit_price) revenue, COALESCE(SUM(dl.qty * m.unit_cost),0) cogs,
              COUNT(DISTINCT d.id) dispatches
       ${LINES} AND NOT dl.is_promo
       GROUP BY 1, 2 ORDER BY ${group === 'month' ? '2' : 'revenue DESC'}`,
      [from, to],
    );
    return { from, to, group, rows: rows.map((r) => ({ ...r, cogs: Math.round(r.cogs), gross: Math.round(r.revenue - r.cogs) })) };
  });

  /** Müşteri kârlılığı: zincir/tek kafe bazında, şube kırılımıyla; promosyon giderleri düşülür */
  app.get('/api/reports/profitability', async (req) => {
    const { from, to } = range(req.query);
    const rows = await db.query<{ id: number; name: string; parent_id: number | null; parent_name: string | null; revenue: number; cogs: number; promo: number; qty: number }>(
      `SELECT c.id, c.name, c.parent_id, ch.name parent_name,
              COALESCE(SUM(dl.qty * dl.unit_price) FILTER (WHERE NOT dl.is_promo),0) revenue,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE NOT dl.is_promo),0) cogs,
              COALESCE(SUM(dl.qty * m.unit_cost) FILTER (WHERE dl.is_promo),0) promo,
              COALESCE(SUM(dl.qty) FILTER (WHERE NOT dl.is_promo),0) qty
       ${LINES} GROUP BY c.id, c.name, c.parent_id, ch.name`,
      [from, to],
    );
    const extra = await db.query<{ customer_id: number; amount: number }>(
      `SELECT customer_id, SUM(amount) amount FROM promo_expenses WHERE date BETWEEN $1 AND $2 GROUP BY customer_id`,
      [from, to],
    );
    const names = await db.query<{ id: number; name: string; kind: string; parent_id: number | null }>('SELECT id, name, kind, parent_id FROM customers');
    const byId = new Map(names.map((n) => [n.id, n]));
    type Node = { id: number; name: string; revenue: number; cogs: number; promo: number; qty: number; branches: Omit<Node, 'branches'>[] };
    const groups = new Map<number, Node>();
    const leaf = (id: number) => {
      const c = byId.get(id)!;
      const top = c.parent_id ?? c.id;
      const g = groups.get(top) ?? { id: top, name: byId.get(top)!.name, revenue: 0, cogs: 0, promo: 0, qty: 0, branches: [] };
      groups.set(top, g);
      let b = c.parent_id ? g.branches.find((x) => x.id === id) : undefined;
      if (c.parent_id && !b) {
        b = { id, name: c.name, revenue: 0, cogs: 0, promo: 0, qty: 0 };
        g.branches.push(b);
      }
      return { g, b };
    };
    const addTo = (id: number, v: { revenue?: number; cogs?: number; promo?: number; qty?: number }) => {
      const { g, b } = leaf(id);
      for (const t of [g, b].filter(Boolean) as Omit<Node, 'branches'>[]) {
        t.revenue += v.revenue ?? 0;
        t.cogs += v.cogs ?? 0;
        t.promo += v.promo ?? 0;
        t.qty += v.qty ?? 0;
      }
    };
    for (const r of rows) addTo(r.id, r);
    for (const e of extra) addTo(e.customer_id, { promo: e.amount });
    const fin = <T extends { revenue: number; cogs: number; promo: number }>(n: T) => {
      const gross = n.revenue - n.cogs;
      const net = gross - n.promo;
      return { ...n, cogs: Math.round(n.cogs), promo: Math.round(n.promo), gross: Math.round(gross), net: Math.round(net), margin: n.revenue ? net / n.revenue : null };
    };
    return {
      from,
      to,
      rows: [...groups.values()]
        .map((g) => ({ ...fin(g), kind: byId.get(g.id)!.kind, branches: g.branches.map(fin).sort((a, b) => b.net - a.net) }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  });

  app.get('/api/reports/stock', async () =>
    db.query(
      `SELECT p.id, p.code, p.name, p.kind, p.category, p.min_qty "minQty", p.avg_cost "avgCost",
              COALESCE((SELECT SUM(qty) FROM stock_moves WHERE product_id = p.id),0) "onHand",
              COALESCE((SELECT SUM(l.qty) FROM lot_lines l JOIN lots t ON t.id = l.lot_id WHERE l.product_id = p.id AND t.status = 'ordered'),0) "onOrder",
              COALESCE((SELECT SUM(-m.qty) FROM stock_moves m WHERE m.product_id = p.id AND m.kind = 'dispatch' AND m.date >= CURRENT_DATE - 90),0) "sold90"
       FROM products p WHERE p.active ORDER BY p.kind DESC, p.code`,
    ),
  );

  async function receivablesReport(today: string) {
    const customers = await db.query<{ id: number; name: string; kind: string; balance: number; payment_days: number }>(
      `SELECT c.id, c.name, c.kind, c.payment_days, ${BALANCE_SQL} balance FROM customers c WHERE c.kind <> 'branch' OR c.bill_to = 'self'`,
    );
    const out = [];
    for (const c of customers) {
      if (!c.balance) continue;
      const states = await invoiceStates(db, c.id, today);
      const b = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
      for (const s of states.values()) {
        if (!s.remaining) continue;
        const d = s.daysOverdue;
        if (d <= 0) b.current += s.remaining;
        else if (d <= 30) b.d30 += s.remaining;
        else if (d <= 60) b.d60 += s.remaining;
        else if (d <= 90) b.d90 += s.remaining;
        else b.older += s.remaining;
      }
      const invoiced = b.current + b.d30 + b.d60 + b.d90 + b.older;
      out.push({ id: c.id, name: c.name, kind: c.kind, balance: c.balance, ...b, other: c.balance - invoiced, overdue: b.d30 + b.d60 + b.d90 + b.older });
    }
    return out.sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
  }
  app.get('/api/reports/receivables', async () => receivablesReport(todayTr(now())));
}
