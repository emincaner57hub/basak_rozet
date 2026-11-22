import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { daySchema, fail, idParam, optText, type Row } from './lib.js';

/**
 * Müşteri ağacı: zincir (merkez) → şubeler; tek kafeler zincirsiz.
 * Şubenin faturası merkeze (bill_to = parent) ya da kendisine (franchise) kesilir.
 */

export interface CustomerRow {
  id: number;
  code: string | null;
  name: string;
  kind: 'chain' | 'branch' | 'single';
  parent_id: number | null;
  bill_to: 'self' | 'parent';
  legal_name: string | null;
  tax_id: string | null;
  tax_office: string | null;
  address: string | null;
  city: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  payment_days: number;
  discount: number;
  opening_balance: number;
  opening_date: string | null;
  note: string | null;
  active: boolean;
}

/** Faturanın kesileceği müşteri: merkeze bağlı şube → zincir; diğerleri kendisi */
export async function billToOf(q: Queryable, customerId: number): Promise<CustomerRow> {
  const [c] = await q.query<CustomerRow>('SELECT * FROM customers WHERE id = $1', [customerId]);
  if (!c) throw fail(404, 'Müşteri bulunamadı');
  if (c.kind === 'branch' && c.bill_to === 'parent') {
    const [p] = await q.query<CustomerRow>('SELECT * FROM customers WHERE id = $1', [c.parent_id]);
    return p;
  }
  return c;
}

/** Fiyatın bakılacağı müşteriler: şube → kendi özel fiyatı, yoksa zincirin; zincir/tek kafe → kendisi */
export async function priceScopes(q: Queryable, customerId: number): Promise<number[]> {
  const [c] = await q.query<{ id: number; parent_id: number | null }>('SELECT id, parent_id FROM customers WHERE id = $1', [customerId]);
  if (!c) throw fail(404, 'Müşteri bulunamadı');
  return c.parent_id ? [c.id, c.parent_id] : [c.id];
}

/**
 * Müşteriye uygulanacak indirim (%): kendi kartındaki; şubede 0 ise bağlı olduğu zincirin.
 * 0 = indirim yok.
 */
export async function discountFor(q: Queryable, customerId: number): Promise<number> {
  const [r] = await q.query<{ d: number }>(
    `SELECT COALESCE(NULLIF(c.discount, 0), p.discount, 0) d FROM customers c LEFT JOIN customers p ON p.id = c.parent_id WHERE c.id = $1`,
    [customerId],
  );
  return Number(r?.d ?? 0);
}

/** İndirimli birim fiyat (kuruş, yuvarlanır) */
export const applyDiscount = (price: number, discount: number) => (discount > 0 ? Math.round((price * (100 - discount)) / 100) : price);

/**
 * Müşterinin görebildiği ürünler ve fiyatları (zincire özel ürünler yalnız o zincirde).
 * price: müşteriye satış fiyatı = (özel fiyat, yoksa liste fiyatı) − müşteri indirimi; basePrice: indirimsiz.
 */
export async function catalogFor(q: Queryable, customerId: number) {
  const scopes = await priceScopes(q, customerId);
  const chainId = scopes.length > 1 ? scopes[1] : scopes[0];
  const discount = await discountFor(q, customerId);
  const rows = await q.query<{ id: number; code: string; name: string; kind: string; category: string | null; unit: string; vatRate: number; listPrice: number | null; basePrice: number | null; special: boolean; onHand: number; chainId: number | null; image: string | null; sellable: boolean }>(
    `SELECT p.id, p.code, p.name, p.kind, p.category, p.unit, p.vat_rate "vatRate", p.list_price "listPrice", p.chain_id "chainId", p.image, p.sellable,
            COALESCE((SELECT pr.price FROM prices pr WHERE pr.product_id = p.id AND pr.customer_id = ANY($1::int[])
                      ORDER BY array_position($1::int[], pr.customer_id) LIMIT 1), p.list_price) "basePrice",
            EXISTS (SELECT 1 FROM prices pr WHERE pr.product_id = p.id AND pr.customer_id = ANY($1::int[])) special,
            COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.product_id = p.id), 0) "onHand"
     FROM products p
     WHERE p.active AND (p.chain_id IS NULL OR p.chain_id = $2)
     ORDER BY p.kind DESC, p.category NULLS LAST, p.code`,
    [scopes, chainId],
  );
  return rows.map((r) => {
    const d = r.kind === 'promo' ? 0 : discount;
    return { ...r, discount: d, price: r.basePrice == null ? null : applyDiscount(r.basePrice, d) };
  });
}

/**
 * Cari bakiye ifadesi (c = customers): açılış + faturalar − tahsilatlar; açılış tarihinden
 * önceki belgeler açılışın içinde sayılır. + = müşteri bize borçlu.
 */
export const BALANCE_SQL = `(
  c.opening_balance
  + COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id AND NOT i.cancelled AND (c.opening_date IS NULL OR i.date >= c.opening_date)), 0)
  - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id AND (c.opening_date IS NULL OR p.date >= c.opening_date)), 0)
  + COALESCE((SELECT SUM(CASE WHEN e.type = 'IADE' THEN -e.total ELSE e.total END) FROM e_invoices e
              WHERE e.customer_id = c.id AND e.direction = 'out' AND e.invoice_id IS NULL AND NOT e.cancelled AND (c.opening_date IS NULL OR e.date >= c.opening_date)), 0)
  + COALESCE((SELECT SUM(a.amount) FROM cari_adjustments a WHERE a.customer_id = c.id AND (c.opening_date IS NULL OR a.date >= c.opening_date)), 0)
)`;

/**
 * Tedarikçi cari bakiyesi (s = suppliers): açılış + gelen e-faturalar − ödemeler + düzeltmeler. + = biz borçluyuz.
 */
export const SUPPLIER_BALANCE_SQL = `(
  s.opening_balance
  + COALESCE((SELECT SUM(CASE WHEN e.type = 'IADE' THEN -e.total ELSE e.total END) FROM e_invoices e
              WHERE e.supplier_id = s.id AND e.direction = 'in' AND NOT e.cancelled AND (s.opening_date IS NULL OR e.date >= s.opening_date)), 0)
  - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id AND (s.opening_date IS NULL OR p.date >= s.opening_date)), 0)
  + COALESCE((SELECT SUM(a.amount) FROM cari_adjustments a WHERE a.supplier_id = s.id AND (s.opening_date IS NULL OR a.date >= s.opening_date)), 0)
)`;

const customerSchema = z
  .object({
    code: optText(30),
    name: z.string().trim().min(1, 'Ad girin').max(120),
    kind: z.enum(['chain', 'branch', 'single']),
    parentId: z.number().int().positive().nullish(),
    billTo: z.enum(['self', 'parent']).default('self'),
    legalName: optText(200),
    taxId: z
      .string()
      .trim()
      .regex(/^(\d{10}|\d{11})?$/, 'Vergi no 10 (VKN) ya da 11 (TCKN) hane olmalı')
      .nullish()
      .transform((v) => v || null),
    taxOffice: optText(80),
    address: optText(400),
    city: optText(80),
    contactName: optText(100),
    phone: optText(40),
    email: optText(120),
    paymentDays: z.number().int().min(0).max(365).default(30),
    /** İndirim %: satışta fiyata uygulanır; 0 = indirim yok */
    discount: z.number().min(0, 'İndirim 0 ile 99,99 arası olmalı').max(99.99, 'İndirim 0 ile 99,99 arası olmalı').default(0).transform((v) => Math.round(v * 100) / 100),
    openingBalance: z.number().int().default(0),
    openingDate: daySchema.nullish(),
    note: optText(1000),
    active: z.boolean().default(true),
  })
  .refine((c) => (c.kind === 'branch') === !!c.parentId, { message: 'Şube bir zincire bağlı olmalı; zincir ve tek kafe bağlanmaz' })
  .refine((c) => c.kind === 'branch' || c.billTo === 'self', { message: 'Yalnız şube faturayı merkeze kesebilir' });

const mapCustomer = (r: Row) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  parentId: r.parent_id,
  parentName: r.parent_name ?? null,
  billTo: r.bill_to,
  legalName: r.legal_name,
  taxId: r.tax_id,
  taxOffice: r.tax_office,
  address: r.address,
  city: r.city,
  contactName: r.contact_name,
  phone: r.phone,
  email: r.email,
  paymentDays: r.payment_days,
  discount: Number(r.discount ?? 0),
  /** Şubenin bağlı olduğu zincirin indirimi (şubede 0 ise bu uygulanır) */
  parentDiscount: r.parent_discount == null ? null : Number(r.parent_discount),
  openingBalance: r.opening_balance,
  openingDate: r.opening_date,
  note: r.note,
  active: r.active,
  branchCount: r.branch_count ?? 0,
  balance: r.balance ?? null,
  /** Faturası kendisine kesilen müşteri (cari burada tutulur) */
  billable: r.kind !== 'branch' || r.bill_to === 'self',
});

export function registerCustomers(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/customers', async (req) => {
    const q = z.object({ q: z.string().max(80).optional(), all: z.enum(['1']).optional() }).parse(req.query);
    const rows = await db.query<Row>(
      `SELECT c.*, p.name parent_name, p.discount parent_discount,
              (SELECT COUNT(*) FROM customers b WHERE b.parent_id = c.id) branch_count,
              CASE WHEN c.kind <> 'branch' OR c.bill_to = 'self' THEN ${BALANCE_SQL} END balance
       FROM customers c LEFT JOIN customers p ON p.id = c.parent_id
       WHERE ($1::boolean OR c.active)
         AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.code ILIKE $2 || '%' OR c.tax_id LIKE $2 || '%' OR p.name ILIKE '%' || $2 || '%')
       ORDER BY COALESCE(p.name, c.name), c.parent_id NULLS FIRST, c.name`,
      [q.all === '1', q.q?.trim() || null],
    );
    return rows.map(mapCustomer);
  });

  app.get('/api/customers/:id', async (req) => {
    const id = idParam(req.params);
    const [c] = await db.query<Row>(
      `SELECT c.*, p.name parent_name, p.discount parent_discount, CASE WHEN c.kind <> 'branch' OR c.bill_to = 'self' THEN ${BALANCE_SQL} END balance
       FROM customers c LEFT JOIN customers p ON p.id = c.parent_id WHERE c.id = $1`,
      [id],
    );
    if (!c) throw fail(404, 'Müşteri bulunamadı');
    const branches = await db.query<Row>(
      `SELECT c.*, CASE WHEN c.bill_to = 'self' THEN ${BALANCE_SQL} END balance FROM customers c WHERE c.parent_id = $1 ORDER BY c.name`,
      [id],
    );
    return { ...mapCustomer(c), branches: branches.map(mapCustomer) };
  });

  async function save(id: number | null, body: unknown) {
    const b = customerSchema.parse(body);
    return db.tx(async (q) => {
      if (b.parentId) {
        const [p] = await q.query<{ kind: string }>('SELECT kind FROM customers WHERE id = $1', [b.parentId]);
        if (!p || p.kind !== 'chain') throw fail(400, 'Şube yalnız bir zincire bağlanabilir');
      }
      if (b.code) {
        const [dup] = await q.query<{ id: number; name: string }>('SELECT id, name FROM customers WHERE lower(code) = lower($1)', [b.code]);
        if (dup && dup.id !== id) throw fail(409, `Bu kod zaten kullanılıyor: ${dup.name}`);
      }
      if (id) {
        const [cur] = await q.query<{ kind: string }>('SELECT kind FROM customers WHERE id = $1', [id]);
        if (!cur) throw fail(404, 'Müşteri bulunamadı');
        if (cur.kind === 'chain' && b.kind !== 'chain' && (await q.query('SELECT 1 FROM customers WHERE parent_id = $1', [id])).length) {
          throw fail(400, 'Şubesi olan zincirin türü değiştirilemez');
        }
      }
      const vals = [
        b.code, b.name, b.kind, b.parentId ?? null, b.billTo, b.legalName, b.taxId, b.taxOffice, b.address, b.city, b.contactName,
        b.phone, b.email, b.paymentDays, b.openingBalance, b.openingDate ?? null, b.note, b.active, b.discount,
      ];
      if (id) {
        await q.query(
          `UPDATE customers SET code=$1, name=$2, kind=$3, parent_id=$4, bill_to=$5, legal_name=$6, tax_id=$7, tax_office=$8, address=$9, city=$10,
             contact_name=$11, phone=$12, email=$13, payment_days=$14, opening_balance=$15, opening_date=$16, note=$17, active=$18, discount=$19 WHERE id=$20`,
          [...vals, id],
        );
        return { id };
      }
      const [r] = await q.query<{ id: number }>(
        `INSERT INTO customers(code, name, kind, parent_id, bill_to, legal_name, tax_id, tax_office, address, city, contact_name, phone, email,
           payment_days, opening_balance, opening_date, note, active, discount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        vals,
      );
      return r;
    });
  }
  app.post('/api/customers', async (req) => save(null, req.body));
  app.put('/api/customers/:id', async (req) => save(idParam(req.params), req.body));
  app.delete('/api/customers/:id', async (req) => {
    const id = idParam(req.params);
    const used = await db.query(
      `SELECT 1 FROM orders WHERE customer_id = $1 UNION ALL SELECT 1 FROM dispatches WHERE customer_id = $1 OR bill_to_id = $1
       UNION ALL SELECT 1 FROM invoices WHERE customer_id = $1 UNION ALL SELECT 1 FROM payments WHERE customer_id = $1
       UNION ALL SELECT 1 FROM customers WHERE parent_id = $1 LIMIT 1`,
      [id],
    );
    if (used.length) throw fail(409, 'Bu müşterinin belgeleri ya da şubeleri var; silinemez, pasif yapın');
    await db.query('DELETE FROM customers WHERE id = $1', [id]);
    return { ok: true };
  });

  app.get('/api/customers/:id/catalog', async (req) => catalogFor(db, idParam(req.params)));

  // ---- Özel fiyatlar ----
  app.get('/api/customers/:id/prices', async (req) =>
    db.query(
      `SELECT pr.product_id "productId", p.code, p.name, p.list_price "listPrice", pr.price
       FROM prices pr JOIN products p ON p.id = pr.product_id WHERE pr.customer_id = $1 ORDER BY p.code`,
      [idParam(req.params)],
    ),
  );
  app.put('/api/customers/:id/prices/:productId', async (req) => {
    const id = idParam(req.params);
    const productId = idParam(req.params, 'productId');
    const b = z.object({ price: z.number().int().min(0).nullable() }).parse(req.body);
    if (b.price == null) await db.query('DELETE FROM prices WHERE customer_id = $1 AND product_id = $2', [id, productId]);
    else
      await db.query(
        'INSERT INTO prices(customer_id, product_id, price) VALUES ($1,$2,$3) ON CONFLICT (customer_id, product_id) DO UPDATE SET price = EXCLUDED.price',
        [id, productId, b.price],
      );
    return { ok: true };
  });
}
