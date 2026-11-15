import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { BALANCE_SQL, SUPPLIER_BALANCE_SQL } from './customers.js';
import { EdmError, edmConfig, syncEdm, type Fetcher } from './edm.js';
import { daySchema, fail, idParam, optText } from './lib.js';

const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Türkiye

/**
 * Cari: tedarikçi ekstresi ve ödemeleri, cari düzeltme kayıtları (müşteri ve tedarikçi),
 * EDM e-fatura listesi ve eşitleme.
 */
export function registerCari(app: FastifyInstance, { db, edmFetcher }: { db: Db; edmFetcher?: Fetcher }) {
  // ---- Tedarikçi carisi ----
  app.get('/api/suppliers/balances', async () =>
    db.query(
      `SELECT s.id, s.name, s.kind, s.tax_id "taxId", ${SUPPLIER_BALANCE_SQL} balance,
              (SELECT COUNT(*) FROM e_invoices e WHERE e.supplier_id = s.id) "invoiceCount"
       FROM suppliers s ORDER BY s.active DESC, s.name`,
    ),
  );

  app.get('/api/suppliers/:id/statement', async (req) => {
    const id = idParam(req.params);
    const q = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    const [s] = await db.query<{ id: number; name: string; opening_balance: number; opening_date: string | null; balance: number; tax_id: string | null }>(
      `SELECT s.id, s.name, s.tax_id, s.opening_balance, s.opening_date, ${SUPPLIER_BALANCE_SQL} balance FROM suppliers s WHERE s.id = $1`,
      [id],
    );
    if (!s) throw fail(404, 'Tedarikçi bulunamadı');
    // credit = tedarikçinin alacağı (fatura), debit = ödememiz; bakiye + = biz borçluyuz
    const rows = await db.query<{ date: string; kind: string; ref: string; description: string | null; debit: number; credit: number; refId: number | null }>(
      `SELECT * FROM (
         SELECT e.date, 'einvoice' kind, e.no ref, concat_ws(' · ', 'e-Fatura', NULLIF(e.type, 'SATIS')) description,
                CASE WHEN e.type = 'IADE' THEN e.total ELSE 0 END debit, CASE WHEN e.type = 'IADE' THEN 0 ELSE e.total END credit, e.id "refId", e.id ord
           FROM e_invoices e WHERE e.supplier_id = $1 AND e.direction = 'in' AND NOT e.cancelled
         UNION ALL
         SELECT p.date, 'payment', p.method, NULLIF(concat_ws(' · ', p.reference, p.note), ''), p.amount, 0, p.id, p.id
           FROM supplier_payments p WHERE p.supplier_id = $1
         UNION ALL
         SELECT a.date, 'adjust', 'Düzeltme', a.note, GREATEST(-a.amount, 0), GREATEST(a.amount, 0), a.id, a.id
           FROM cari_adjustments a WHERE a.supplier_id = $1
       ) x WHERE $2::date IS NULL OR x.date >= $2::date ORDER BY date, kind DESC, ord`,
      [id, s.opening_date],
    );
    if (s.opening_balance || s.opening_date) {
      rows.unshift({ date: s.opening_date ?? rows[0]?.date ?? today(), kind: 'opening', ref: 'Açılış', description: 'Açılış bakiyesi', debit: Math.max(0, -s.opening_balance), credit: Math.max(0, s.opening_balance), refId: null });
    }
    let run = 0;
    let opening = 0;
    const out = [];
    for (const r of rows) {
      run += r.credit - r.debit;
      if (q.from && r.date < q.from) {
        opening = run;
        continue;
      }
      if (q.to && r.date > q.to) continue;
      out.push({ ...r, balance: run });
    }
    return { supplier: { id: s.id, name: s.name, taxId: s.tax_id, balance: s.balance }, opening, rows: out };
  });

  const payment = z.object({
    supplierId: z.number().int().positive(),
    date: daySchema,
    amount: z.number().int().positive('Tutar girin'),
    method: z.enum(['havale', 'nakit', 'kart', 'cek', 'diger']).default('havale'),
    reference: optText(120),
    note: optText(300),
  });
  app.get('/api/supplier-payments', async (req) => {
    const q = z.object({ supplierId: z.coerce.number().int().optional() }).parse(req.query);
    return db.query(
      `SELECT p.id, p.date, p.amount, p.method, p.reference, p.note, p.supplier_id "supplierId", s.name "supplierName"
       FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE ($1::int IS NULL OR p.supplier_id = $1) ORDER BY p.date DESC, p.id DESC LIMIT 500`,
      [q.supplierId ?? null],
    );
  });
  app.post('/api/supplier-payments', async (req) => {
    const b = payment.parse(req.body);
    const [r] = await db.query<{ id: number }>(
      'INSERT INTO supplier_payments(supplier_id, date, amount, method, reference, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [b.supplierId, b.date, b.amount, b.method, b.reference, b.note],
    );
    return r;
  });
  app.delete('/api/supplier-payments/:id', async (req) => {
    await db.query('DELETE FROM supplier_payments WHERE id = $1', [idParam(req.params)]);
    return { ok: true };
  });

  // ---- Cari düzeltme: "o tarihte bakiye şu olmalı" → fark kaydı ----
  async function balanceAt(kind: 'customer' | 'supplier', id: number, date: string): Promise<number> {
    if (kind === 'customer') {
      const [r] = await db.query<{ b: number }>(
        `SELECT c.opening_balance
           + COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id AND NOT i.cancelled AND i.date <= $2 AND (c.opening_date IS NULL OR i.date >= c.opening_date)), 0)
           - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id AND p.date <= $2 AND (c.opening_date IS NULL OR p.date >= c.opening_date)), 0)
           + COALESCE((SELECT SUM(CASE WHEN e.type = 'IADE' THEN -e.total ELSE e.total END) FROM e_invoices e WHERE e.customer_id = c.id AND e.direction = 'out'
                       AND e.invoice_id IS NULL AND NOT e.cancelled AND e.date <= $2 AND (c.opening_date IS NULL OR e.date >= c.opening_date)), 0)
           + COALESCE((SELECT SUM(a.amount) FROM cari_adjustments a WHERE a.customer_id = c.id AND a.date <= $2 AND (c.opening_date IS NULL OR a.date >= c.opening_date)), 0) b
         FROM customers c WHERE c.id = $1`,
        [id, date],
      );
      if (!r) throw fail(404, 'Müşteri bulunamadı');
      return r.b;
    }
    const [r] = await db.query<{ b: number }>(
      `SELECT s.opening_balance
         + COALESCE((SELECT SUM(CASE WHEN e.type = 'IADE' THEN -e.total ELSE e.total END) FROM e_invoices e WHERE e.supplier_id = s.id AND e.direction = 'in'
                     AND NOT e.cancelled AND e.date <= $2 AND (s.opening_date IS NULL OR e.date >= s.opening_date)), 0)
         - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id AND p.date <= $2 AND (s.opening_date IS NULL OR p.date >= s.opening_date)), 0)
         + COALESCE((SELECT SUM(a.amount) FROM cari_adjustments a WHERE a.supplier_id = s.id AND a.date <= $2 AND (s.opening_date IS NULL OR a.date >= s.opening_date)), 0) b
       FROM suppliers s WHERE s.id = $1`,
      [id, date],
    );
    if (!r) throw fail(404, 'Tedarikçi bulunamadı');
    return r.b;
  }

  app.post('/api/adjustments', async (req) => {
    const b = z
      .object({
        customerId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().optional(),
        date: daySchema,
        targetBalance: z.number().int().optional(), // o tarihteki olması gereken bakiye (kuruş)
        amount: z.number().int().optional(), // ya da doğrudan fark
        note: optText(300),
      })
      .refine((x) => !!x.customerId !== !!x.supplierId, 'Müşteri ya da tedarikçi seçin')
      .refine((x) => x.targetBalance !== undefined || x.amount !== undefined, 'Bakiye ya da tutar girin')
      .parse(req.body);
    const kind = b.customerId ? 'customer' : 'supplier';
    const id = (b.customerId ?? b.supplierId)!;
    const amount = b.targetBalance !== undefined ? b.targetBalance - (await balanceAt(kind, id, b.date)) : b.amount!;
    if (!amount) return { amount: 0, note: 'Bakiye zaten bu' };
    const [r] = await db.query<{ id: number }>(
      'INSERT INTO cari_adjustments(customer_id, supplier_id, date, amount, note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.customerId ?? null, b.supplierId ?? null, b.date, amount, b.note ?? (b.targetBalance !== undefined ? 'Bakiye düzeltme (başlangıç)' : 'Düzeltme')],
    );
    return { id: r.id, amount };
  });
  app.delete('/api/adjustments/:id', async (req) => {
    await db.query('DELETE FROM cari_adjustments WHERE id = $1', [idParam(req.params)]);
    return { ok: true };
  });

  // ---- e-Fatura (EDM) ----
  app.get('/api/e-invoices', async (req) => {
    const q = z
      .object({ direction: z.enum(['in', 'out']).optional(), from: daySchema.optional(), to: daySchema.optional(), q: z.string().trim().max(80).optional() })
      .parse(req.query);
    return db.query(
      `SELECT e.id, e.uuid, e.direction, e.no, e.date, e.type, e.profile, e.party_tax_id "partyTaxId", e.party_name "partyName", e.currency,
              e.subtotal, e.vat_total "vatTotal", e.total, e.status, e.cancelled, e.customer_id "customerId", e.supplier_id "supplierId",
              e.invoice_id "invoiceId", i.no "invoiceNo", COALESCE(c.name, s.name) "accountName"
       FROM e_invoices e LEFT JOIN invoices i ON i.id = e.invoice_id LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN suppliers s ON s.id = e.supplier_id
       WHERE ($1::text IS NULL OR e.direction = $1) AND ($2::date IS NULL OR e.date >= $2) AND ($3::date IS NULL OR e.date <= $3)
         AND ($4::text IS NULL OR e.no ILIKE '%' || $4 || '%' OR e.party_name ILIKE '%' || $4 || '%' OR e.party_tax_id = $4)
       ORDER BY e.date DESC, e.id DESC LIMIT 1000`,
      [q.direction ?? null, q.from ?? null, q.to ?? null, q.q || null],
    );
  });

  app.get('/api/edm/status', async () => {
    const [last] = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'edm_last_sync'`);
    return {
      configured: !!edmConfig(),
      user: process.env.EDM_USER ? !!process.env.EDM_USER : false,
      password: !!process.env.EDM_PASSWORD,
      last: last ? JSON.parse(last.value) : null,
    };
  });

  let running = false;
  app.get('/api/edm/diag', async () => {
    const cfg = edmConfig();
    if (!cfg) return { configured: false };
    const { EdmClient } = await import('./edm.js');
    const c = new EdmClient(cfg, edmFetcher);
    const d: Record<string, unknown> = { configured: true, url: cfg.url, userLength: cfg.user.length, passwordLength: cfg.password.length, ...(await c.diag()) };
    try {
      await c.login();
      d.login = 'ok';
      await c.logout();
    } catch (e) {
      d.login = (e as Error).message;
    }
    d.qualifyUsed = (await c.diag()).qualifyUsed;
    if (d.login !== 'ok') {
      // Hangi EDM sunucusunda servis var ve kullanıcı tanınıyor? (her biri kısa sürede)
      const { EDM_CANDIDATES } = await import('./edm.js');
      const tries: Record<string, string> = {};
      await Promise.all(
        EDM_CANDIDATES.filter((u) => u !== cfg.url).map(async (u) => {
          const t = new EdmClient({ ...cfg, url: u }, edmFetcher);
          try {
            await Promise.race([t.login(), new Promise((_, rej) => setTimeout(() => rej(new Error('zaman aşımı')), 15000))]);
            tries[u] = 'ok';
            await t.logout();
          } catch (e) {
            tries[u] = (e as Error).message;
          }
        }),
      );
      d.digerSunucular = tries;
    }
    return d;
  });

  app.post('/api/edm/sync', async (req) => {
    const b = z.object({ from: daySchema, to: daySchema }).parse(req.body ?? {});
    if (b.from > b.to) throw fail(400, 'Başlangıç bitişten sonra olamaz');
    if (Date.parse(b.to) - Date.parse(b.from) > 400 * 864e5) throw fail(400, 'En çok 400 gün');
    const cfg = edmConfig();
    if (!cfg) throw fail(400, 'EDM_USER ve EDM_PASSWORD tanımlı değil (Render → Environment)');
    if (running) throw fail(409, 'Eşitleme zaten sürüyor');
    running = true;
    try {
      return await syncEdm(db, cfg, b.from, b.to, edmFetcher);
    } catch (e) {
      if (e instanceof EdmError) throw fail(502, e.message);
      throw e;
    } finally {
      running = false;
    }
  });
}

/** Saatlik: son 7 günü EDM'den çek (yapılandırılmışsa) */
export function startEdmSchedule(db: Db) {
  const cfg = edmConfig();
  if (!cfg) return;
  const run = async () => {
    const to = today();
    const from = new Date(Date.parse(to) - 7 * 864e5).toISOString().slice(0, 10);
    try {
      await syncEdm(db, cfg, from, to);
    } catch (e) {
      console.warn('EDM eşitleme:', (e as Error).message);
    }
  };
  setTimeout(run, 60_000);
  setInterval(run, 60 * 60_000);
}
