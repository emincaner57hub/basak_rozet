import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { addDays, todayTr } from './db.js';
import { BALANCE_SQL } from './customers.js';
import { daySchema, fail, idParam, nextNo, optText, vatOf, type Row } from './lib.js';

/**
 * Fatura: bir müşterinin (fatura kesilen) faturalanmamış irsaliyelerinden kesilir; satırlar ürün ve
 * fiyata göre toplanır. Tahsilatlar faturaları eskiden yeniye kapatır (FIFO).
 */

export interface InvoiceState {
  id: number;
  paid: number;
  remaining: number;
  status: 'paid' | 'partial' | 'open';
  overdue: boolean;
  daysOverdue: number;
}

/** Müşterinin faturalarının ödeme durumu: açılış borcu ve faturalar sırayla tahsilattan kapanır */
export async function invoiceStates(q: Queryable, customerId: number, today: string): Promise<Map<number, InvoiceState>> {
  const [c] = await q.query<{ opening_balance: number; opening_date: string | null }>('SELECT opening_balance, opening_date FROM customers WHERE id = $1', [customerId]);
  const from = c?.opening_date ?? null;
  const invoices = await q.query<{ id: number; total: number; due_date: string }>(
    `SELECT id, total, due_date FROM invoices WHERE customer_id = $1 AND NOT cancelled AND ($2::date IS NULL OR date >= $2) ORDER BY date, id`,
    [customerId, from],
  );
  const [{ paid }] = await q.query<{ paid: number }>(`SELECT COALESCE(SUM(amount),0) paid FROM payments WHERE customer_id = $1 AND ($2::date IS NULL OR date >= $2)`, [
    customerId,
    from,
  ]);
  // Açılış borcu önce kapanır; açılış alacağı (eksi) ödeme gibi kullanılır
  let pool = paid - (c?.opening_balance ?? 0);
  const out = new Map<number, InvoiceState>();
  for (const inv of invoices) {
    const use = Math.max(0, Math.min(pool, inv.total));
    pool -= use;
    const remaining = inv.total - use;
    const daysOverdue = remaining > 0 && inv.due_date < today ? Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86_400_000) : 0;
    out.set(inv.id, { id: inv.id, paid: use, remaining, status: remaining === 0 ? 'paid' : use > 0 ? 'partial' : 'open', overdue: daysOverdue > 0, daysOverdue });
  }
  return out;
}

export async function invoiceDetail(q: Queryable, id: number, today: string) {
  const [inv] = await q.query<Row & { customerId: number }>(
    `SELECT i.id, i.no, i.date, i.due_date "dueDate", i.subtotal, i.vat_total "vatTotal", i.total, i.cancelled, i.e_invoice_no "eInvoiceNo", i.e_uuid "eUuid", i.e_profile "eProfile", i.e_status "eStatus", i.e_status_desc "eStatusDesc", i.e_error "eError", i.e_sent_at "eSentAt", i.e_source "eSource", i.note,
            i.customer_id "customerId", c.name "customerName", c.legal_name "legalName", c.tax_id "taxId", c.tax_office "taxOffice", c.address, c.city
     FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
    [id],
  );
  if (!inv) throw fail(404, 'Fatura bulunamadı');
  const lines = await q.query(
    `SELECT id, product_id "productId", description, qty, unit_price "unitPrice", vat_rate "vatRate", net, vat, total FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`,
    [id],
  );
  const dispatches = await q.query(
    `SELECT d.id, d.no, d.date, c.name "customerName" FROM dispatches d JOIN customers c ON c.id = d.customer_id WHERE d.invoice_id = $1 ORDER BY d.date, d.id`,
    [id],
  );
  const st = (await invoiceStates(q, inv.customerId, today)).get(id);
  return { ...inv, lines, dispatches, paid: st?.paid ?? 0, remaining: inv.cancelled ? 0 : (st?.remaining ?? 0), status: inv.cancelled ? 'cancelled' : (st?.status ?? 'open'), daysOverdue: st?.daysOverdue ?? 0 };
}

export function registerInvoices(app: FastifyInstance, { db, now }: { db: Db; now: () => Date }) {
  const today = () => todayTr(now());

  /** Fatura bekleyenler: faturalanmamış irsaliyesi olan müşteriler */
  app.get('/api/invoices/pending', async () =>
    db.query(
      `SELECT b.id "customerId", b.name, b.kind, COUNT(DISTINCT d.id) "dispatchCount", MIN(d.date) "oldest",
              COALESCE(SUM(dl.qty * dl.unit_price), 0) net
       FROM dispatches d JOIN customers b ON b.id = d.bill_to_id JOIN dispatch_lines dl ON dl.dispatch_id = d.id
       WHERE d.invoice_id IS NULL AND NOT d.cancelled
       GROUP BY b.id, b.name, b.kind ORDER BY MIN(d.date)`,
    ),
  );

  app.get('/api/invoices', async (req) => {
    const q = z
      .object({ customerId: z.coerce.number().int().optional(), status: z.enum(['open', 'overdue', 'all']).default('all'), from: daySchema.optional(), to: daySchema.optional() })
      .parse(req.query);
    const rows = await db.query<Row & { id: number; customerId: number; cancelled: boolean }>(
      `SELECT i.id, i.no, i.date, i.due_date "dueDate", i.subtotal, i.vat_total "vatTotal", i.total, i.cancelled, i.e_invoice_no "eInvoiceNo", i.e_uuid "eUuid", i.e_profile "eProfile", i.e_status "eStatus", i.e_status_desc "eStatusDesc", i.e_error "eError", i.e_sent_at "eSentAt", i.e_source "eSource",
              i.customer_id "customerId", c.name "customerName", c.kind "customerKind",
              (SELECT COUNT(*) FROM dispatches d WHERE d.invoice_id = i.id) "dispatchCount"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE ($1::int IS NULL OR i.customer_id = $1) AND ($2::date IS NULL OR i.date >= $2) AND ($3::date IS NULL OR i.date <= $3)
       ORDER BY i.date DESC, i.id DESC LIMIT 1000`,
      [q.customerId ?? null, q.from ?? null, q.to ?? null],
    );
    const states = new Map<number, Map<number, InvoiceState>>();
    for (const cid of new Set(rows.map((r) => r.customerId))) states.set(cid, await invoiceStates(db, cid, today()));
    const out = rows.map((r) => {
      const st = states.get(r.customerId)?.get(r.id);
      return {
        ...r,
        paid: st?.paid ?? 0,
        remaining: r.cancelled ? 0 : (st?.remaining ?? 0),
        status: r.cancelled ? 'cancelled' : (st?.status ?? 'open'),
        daysOverdue: st?.daysOverdue ?? 0,
      };
    });
    if (q.status === 'open') return out.filter((r) => r.status === 'open' || r.status === 'partial');
    if (q.status === 'overdue') return out.filter((r) => r.daysOverdue > 0);
    return out;
  });

  app.get('/api/invoices/:id', async (req) => invoiceDetail(db, idParam(req.params), today()));

  app.post('/api/invoices', async (req) => {
    const b = z
      .object({ customerId: z.number().int().positive(), date: daySchema, dispatchIds: z.array(z.number().int().positive()).min(1, 'İrsaliye seçin').max(500), note: optText(1000) })
      .parse(req.body);
    return db.tx(async (q) => {
      const [c] = await q.query<{ name: string; kind: string; bill_to: string; tax_id: string | null; payment_days: number }>(
        'SELECT name, kind, bill_to, tax_id, payment_days FROM customers WHERE id = $1',
        [b.customerId],
      );
      if (!c) throw fail(404, 'Müşteri bulunamadı');
      if (c.kind === 'branch' && c.bill_to === 'parent') throw fail(400, 'Bu şubenin faturası merkeze kesilir');
      if (!c.tax_id) throw fail(400, `${c.name} için vergi numarası girilmemiş; fatura kesilemez`);
      const ds = await q.query<{ id: number; bill_to_id: number; invoice_id: number | null; cancelled: boolean; no: string }>(
        'SELECT id, bill_to_id, invoice_id, cancelled, no FROM dispatches WHERE id = ANY($1::int[]) FOR UPDATE',
        [b.dispatchIds],
      );
      if (ds.length !== new Set(b.dispatchIds).size) throw fail(400, 'Bilinmeyen irsaliye');
      for (const d of ds) {
        if (d.bill_to_id !== b.customerId) throw fail(400, `${d.no} bu müşteriye faturalanamaz`);
        if (d.cancelled) throw fail(400, `${d.no} iptal edilmiş`);
        if (d.invoice_id) throw fail(400, `${d.no} zaten faturalanmış`);
      }
      // Satırlar: promosyon hariç, ürün + fiyat bazında toplanır
      const agg = await q.query<{ product_id: number; name: string; code: string; vat_rate: number; unit_price: number; qty: number }>(
        `SELECT dl.product_id, p.name, p.code, p.vat_rate, dl.unit_price, SUM(dl.qty) qty
         FROM dispatch_lines dl JOIN products p ON p.id = dl.product_id
         WHERE dl.dispatch_id = ANY($1::int[]) AND NOT dl.is_promo
         GROUP BY dl.product_id, p.name, p.code, p.vat_rate, dl.unit_price ORDER BY p.code, dl.unit_price`,
        [b.dispatchIds],
      );
      if (!agg.length) throw fail(400, 'Seçilen irsaliyelerde faturalanacak ürün yok (yalnız promosyon)');
      const lines = agg.map((a) => {
        const net = a.qty * a.unit_price;
        const vat = vatOf(net, a.vat_rate);
        return { ...a, net, vat, total: net + vat };
      });
      const subtotal = lines.reduce((s, l) => s + l.net, 0);
      const vatTotal = lines.reduce((s, l) => s + l.vat, 0);
      const no = await nextNo(q, 'invoices', 'FTR', b.date);
      const [{ id }] = await q.query<{ id: number }>(
        `INSERT INTO invoices(no, date, customer_id, due_date, subtotal, vat_total, total, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [no, b.date, b.customerId, addDays(b.date, c.payment_days), subtotal, vatTotal, subtotal + vatTotal, b.note],
      );
      for (const l of lines) {
        await q.query(
          `INSERT INTO invoice_lines(invoice_id, product_id, description, qty, unit_price, vat_rate, net, vat, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, l.product_id, `${l.code} ${l.name}`, l.qty, l.unit_price, l.vat_rate, l.net, l.vat, l.total],
        );
      }
      await q.query('UPDATE dispatches SET invoice_id = $1 WHERE id = ANY($2::int[])', [id, b.dispatchIds]);
      return { id, no, total: subtotal + vatTotal };
    });
  });

  app.post('/api/invoices/:id/cancel', async (req) => {
    const id = idParam(req.params);
    return db.tx(async (q) => {
      const r = await q.query('UPDATE invoices SET cancelled = TRUE WHERE id = $1 RETURNING id', [id]);
      if (!r.length) throw fail(404, 'Fatura bulunamadı');
      await q.query('UPDATE dispatches SET invoice_id = NULL WHERE invoice_id = $1', [id]);
      return { ok: true };
    });
  });

  /** e-Fatura numarası (entegratörde kesildikten sonra) ve not */
  app.put('/api/invoices/:id', async (req) => {
    const b = z.object({ eInvoiceNo: optText(40), note: optText(1000), dueDate: daySchema.optional() }).parse(req.body);
    const id = idParam(req.params);
    await db.query('UPDATE invoices SET e_invoice_no = $1, note = $2, due_date = COALESCE($3, due_date) WHERE id = $4', [b.eInvoiceNo, b.note, b.dueDate ?? null, id]);
    return { ok: true };
  });

  // ---- Tahsilat ----
  app.get('/api/payments', async (req) => {
    const q = z.object({ customerId: z.coerce.number().int().optional(), from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    return db.query(
      `SELECT p.id, p.date, p.amount, p.method, p.reference, p.note, p.customer_id "customerId", c.name "customerName"
       FROM payments p JOIN customers c ON c.id = p.customer_id
       WHERE ($1::int IS NULL OR p.customer_id = $1) AND ($2::date IS NULL OR p.date >= $2) AND ($3::date IS NULL OR p.date <= $3)
       ORDER BY p.date DESC, p.id DESC LIMIT 1000`,
      [q.customerId ?? null, q.from ?? null, q.to ?? null],
    );
  });
  app.post('/api/payments', async (req) => {
    const b = z
      .object({
        customerId: z.number().int().positive(),
        date: daySchema,
        amount: z.number().int().positive('Tutar girin'),
        method: z.enum(['havale', 'nakit', 'kart', 'cek', 'diger']).default('havale'),
        reference: optText(120),
        note: optText(500),
      })
      .parse(req.body);
    const [c] = await db.query<{ kind: string; bill_to: string }>('SELECT kind, bill_to FROM customers WHERE id = $1', [b.customerId]);
    if (!c) throw fail(404, 'Müşteri bulunamadı');
    if (c.kind === 'branch' && c.bill_to === 'parent') throw fail(400, 'Bu şubenin carisi merkezde tutulur; tahsilatı zincire girin');
    const [r] = await db.query<{ id: number }>('INSERT INTO payments(customer_id, date, amount, method, reference, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
      b.customerId,
      b.date,
      b.amount,
      b.method,
      b.reference,
      b.note,
    ]);
    return r;
  });
  app.delete('/api/payments/:id', async (req) => {
    await db.query('DELETE FROM payments WHERE id = $1', [idParam(req.params)]);
    return { ok: true };
  });

  /** Cari ekstre: açılış, faturalar (borç), tahsilatlar (alacak), yürüyen bakiye */
  app.get('/api/customers/:id/statement', async (req) => {
    const id = idParam(req.params);
    const q = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    const [c] = await db.query<Row & { opening_balance: number; opening_date: string | null }>(
      `SELECT c.id, c.name, c.kind, c.bill_to, c.opening_balance, c.opening_date, ${BALANCE_SQL} balance FROM customers c WHERE c.id = $1`,
      [id],
    );
    if (!c) throw fail(404, 'Müşteri bulunamadı');
    const rows = await db.query<{ date: string; kind: string; ref: string; description: string | null; debit: number; credit: number; refId: number | null }>(
      `SELECT * FROM (
         SELECT i.date, 'invoice' kind, i.no ref, i.e_invoice_no description, i.total debit, 0 credit, i.id "refId", i.id ord
           FROM invoices i WHERE i.customer_id = $1 AND NOT i.cancelled
         UNION ALL
         SELECT p.date, 'payment', p.method, NULLIF(concat_ws(' · ', p.reference, p.note), ''), 0, p.amount, p.id, p.id
           FROM payments p WHERE p.customer_id = $1
       ) x WHERE $2::date IS NULL OR x.date >= $2::date ORDER BY date, kind DESC, ord`,
      [id, c.opening_date],
    );
    if (c.opening_balance || c.opening_date) {
      rows.unshift({
        date: c.opening_date ?? rows[0]?.date ?? today(),
        kind: 'opening',
        ref: 'Açılış',
        description: 'Açılış bakiyesi',
        debit: Math.max(0, c.opening_balance),
        credit: Math.max(0, -c.opening_balance),
        refId: null,
      });
    }
    let run = 0;
    let opening = 0;
    const out = [];
    for (const r of rows) {
      run += r.debit - r.credit;
      if (q.from && r.date < q.from) {
        opening = run;
        continue;
      }
      if (q.to && r.date > q.to) continue;
      out.push({ ...r, balance: run });
    }
    return { customer: { id: c.id, name: c.name, balance: c.balance }, opening, rows: out };
  });

  // ---- Müşteriye yapılan pazarlama gideri (stoktan çıkmayan) ----
  app.get('/api/promo-expenses', async (req) => {
    const q = z.object({ customerId: z.coerce.number().int().optional() }).parse(req.query);
    return db.query(
      `SELECT e.id, e.date, e.description, e.amount, e.customer_id "customerId", c.name "customerName"
       FROM promo_expenses e JOIN customers c ON c.id = e.customer_id WHERE ($1::int IS NULL OR e.customer_id = $1 OR c.parent_id = $1)
       ORDER BY e.date DESC, e.id DESC`,
      [q.customerId ?? null],
    );
  });
  app.post('/api/promo-expenses', async (req) => {
    const b = z
      .object({ customerId: z.number().int().positive(), date: daySchema, description: z.string().trim().min(1, 'Açıklama girin').max(200), amount: z.number().int().positive('Tutar girin') })
      .parse(req.body);
    const [r] = await db.query<{ id: number }>('INSERT INTO promo_expenses(customer_id, date, description, amount) VALUES ($1,$2,$3,$4) RETURNING id', [
      b.customerId,
      b.date,
      b.description,
      b.amount,
    ]);
    return r;
  });
  app.delete('/api/promo-expenses/:id', async (req) => {
    await db.query('DELETE FROM promo_expenses WHERE id = $1', [idParam(req.params)]);
    return { ok: true };
  });
}
