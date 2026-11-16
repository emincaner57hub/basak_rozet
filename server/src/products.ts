import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { recalc } from './costing.js';
import { daySchema, fail, idParam, optText, type Row } from './lib.js';

const ON_HAND = `COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.product_id = p.id), 0)`;
/** Yolda: sipariş verilmiş, henüz teslim alınmamış partiler */
const ON_ORDER = `COALESCE((SELECT SUM(l.qty) FROM lot_lines l JOIN lots t ON t.id = l.lot_id WHERE l.product_id = p.id AND t.status = 'ordered'), 0)`;
/** Bekleyen sipariş: açık siparişlerin sevk edilmemiş kısmı */
const COMMITTED = `COALESCE((SELECT SUM(GREATEST(ol.qty - COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
                     WHERE dl.order_line_id = ol.id AND NOT d.cancelled), 0), 0))
                   FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.product_id = p.id AND NOT o.cancelled), 0)`;

const productSchema = z.object({
  code: z.string().trim().min(1, 'Ürün kodu girin').max(40),
  name: z.string().trim().min(1, 'Ürün adı girin').max(160),
  kind: z.enum(['sale', 'promo']).default('sale'),
  category: optText(60),
  description: optText(1000),
  unit: z.string().trim().min(1).max(20).default('adet'),
  vatRate: z.number().min(0).max(100).default(20),
  listPrice: z.number().int().min(0).nullish(),
  chainId: z.number().int().positive().nullish(),
  minQty: z.number().int().min(0).nullish(),
  image: z
    .string()
    .max(400_000, 'Görsel çok büyük (en çok ~300 KB)')
    .regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, 'Görsel PNG/JPG/WEBP olmalı')
    .nullish(),
  active: z.boolean().default(true),
  sellable: z.boolean().default(true), // müşteri portalında sipariş verilebilir
});

const mapProduct = (r: Row) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  category: r.category,
  description: r.description,
  unit: r.unit,
  vatRate: r.vat_rate,
  listPrice: r.list_price,
  chainId: r.chain_id,
  chainName: r.chain_name ?? null,
  minQty: r.min_qty,
  image: r.image ?? null,
  active: r.active,
  sellable: r.kind === 'sale' && r.sellable !== false,
  avgCost: r.avg_cost,
  onHand: r.on_hand ?? 0,
  onOrder: r.on_order ?? 0,
  committed: r.committed ?? 0,
});

export function registerProducts(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/products', async (req) => {
    const q = z.object({ q: z.string().max(80).optional(), all: z.enum(['1']).optional(), kind: z.enum(['sale', 'promo']).optional() }).parse(req.query);
    const rows = await db.query<Row>(
      `SELECT p.*, c.name chain_name, ${ON_HAND} on_hand, ${ON_ORDER} on_order, ${COMMITTED} committed
       FROM products p LEFT JOIN customers c ON c.id = p.chain_id
       WHERE ($1::boolean OR p.active) AND ($2::text IS NULL OR p.kind = $2)
         AND ($3::text IS NULL OR p.code ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%' OR p.category ILIKE '%' || $3 || '%')
       ORDER BY p.kind DESC, p.category NULLS LAST, p.code`,
      [q.all === '1', q.kind ?? null, q.q?.trim() || null],
    );
    return rows.map(mapProduct);
  });

  async function save(id: number | null, body: unknown) {
    const b = productSchema.parse(body);
    const [dup] = await db.query<{ id: number; name: string }>('SELECT id, name FROM products WHERE lower(code) = lower($1)', [b.code]);
    if (dup && dup.id !== id) throw fail(409, `Bu ürün kodu zaten kullanılıyor: ${dup.name}`);
    if (b.chainId) {
      const [c] = await db.query<{ kind: string }>('SELECT kind FROM customers WHERE id = $1', [b.chainId]);
      if (!c || c.kind === 'branch') throw fail(400, 'Özel ürün bir zincire ya da tek kafeye bağlanabilir');
    }
    const vals = [b.code, b.name, b.kind, b.category, b.description, b.unit, b.vatRate, b.kind === 'promo' ? null : (b.listPrice ?? null), b.chainId ?? null, b.minQty ?? null, b.image ?? null, b.active, b.kind === 'sale' && b.sellable];
    if (id) {
      const r = await db.query(
        `UPDATE products SET code=$1, name=$2, kind=$3, category=$4, description=$5, unit=$6, vat_rate=$7, list_price=$8, chain_id=$9, min_qty=$10, image=$11, active=$12, sellable=$13
         WHERE id=$14 RETURNING id`,
        [...vals, id],
      );
      if (!r.length) throw fail(404, 'Ürün bulunamadı');
      return { id };
    }
    const [r] = await db.query<{ id: number }>(
      `INSERT INTO products(code, name, kind, category, description, unit, vat_rate, list_price, chain_id, min_qty, image, active, sellable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      vals,
    );
    return r;
  }
  app.post('/api/products', async (req) => save(null, req.body));
  app.put('/api/products/:id', async (req) => save(idParam(req.params), req.body));
  /** Listeden tek tıkla: müşteri portalında satılabilir */
  app.post('/api/products/:id/sellable', async (req) => {
    const b = z.object({ sellable: z.boolean() }).parse(req.body);
    const r = await db.query("UPDATE products SET sellable = $1 WHERE id = $2 AND kind = 'sale' RETURNING id", [b.sellable, idParam(req.params)]);
    if (!r.length) throw fail(404, 'Satış ürünü bulunamadı');
    return { ok: true };
  });
  app.delete('/api/products/:id', async (req) => {
    const id = idParam(req.params);
    const used = await db.query(
      `SELECT 1 FROM order_lines WHERE product_id = $1 UNION ALL SELECT 1 FROM lot_lines WHERE product_id = $1
       UNION ALL SELECT 1 FROM dispatch_lines WHERE product_id = $1 UNION ALL SELECT 1 FROM stock_moves WHERE product_id = $1 LIMIT 1`,
      [id],
    );
    if (used.length) throw fail(409, 'Bu ürün belgelerde kullanılmış; silinemez, pasif yapın');
    await db.query('DELETE FROM products WHERE id = $1', [id]);
    return { ok: true };
  });

  /** Stok kartı: tüm hareketler, belge ve müşteri bilgisiyle */
  app.get('/api/products/:id/moves', async (req) => {
    const id = idParam(req.params);
    const rows = await db.query<Row & { qty: number }>(
      `SELECT m.id, m.date, m.qty, m.kind, m.unit_cost "unitCost", m.note,
              t.no "lotNo", t.id "lotId", s.name "supplierName",
              d.no "dispatchNo", d.id "dispatchId", c.name "customerName", dl.is_promo "isPromo"
       FROM stock_moves m
       LEFT JOIN lot_lines ll ON ll.id = m.lot_line_id LEFT JOIN lots t ON t.id = ll.lot_id LEFT JOIN suppliers s ON s.id = t.supplier_id
       LEFT JOIN dispatch_lines dl ON dl.id = m.dispatch_line_id LEFT JOIN dispatches d ON d.id = dl.dispatch_id LEFT JOIN customers c ON c.id = d.customer_id
       WHERE m.product_id = $1 ORDER BY m.date, m.id`,
      [id],
    );
    let bal = 0;
    return rows.map((r) => ({ ...r, balance: (bal += r.qty) })).reverse();
  });

  /** Sayım / elle düzeltme: sayılan miktar girilir, fark hareket olarak yazılır. Girişte maliyet verilebilir. */
  app.post('/api/products/:id/adjust', async (req) => {
    const id = idParam(req.params);
    const b = z
      .object({
        date: daySchema,
        counted: z.number().int().min(0).optional(),
        qty: z.number().int().optional(),
        unitCost: z.number().min(0).nullish(),
        note: optText(200),
      })
      .refine((x) => (x.counted != null) !== (x.qty != null), { message: 'Sayılan miktar ya da fark girin' })
      .parse(req.body);
    return db.tx(async (q) => {
      const [p] = await q.query<{ on_hand: number }>(`SELECT ${ON_HAND} on_hand FROM products p WHERE p.id = $1 FOR UPDATE`, [id]);
      if (!p) throw fail(404, 'Ürün bulunamadı');
      const delta = b.counted != null ? b.counted - p.on_hand : b.qty!;
      if (!delta) return { delta: 0 };
      await q.query(`INSERT INTO stock_moves(product_id, date, qty, kind, unit_cost, fixed_cost, note) VALUES ($1,$2,$3,'adjust',$4,$5,$6)`, [
        id,
        b.date,
        delta,
        delta > 0 ? (b.unitCost ?? null) : null,
        delta > 0 && b.unitCost != null,
        b.note ?? (b.counted != null ? `Sayım: ${b.counted}` : null),
      ]);
      await recalc(q, [id]);
      return { delta };
    });
  });

  app.delete('/api/stock-moves/:id', async (req) => {
    const id = idParam(req.params);
    return db.tx(async (q) => {
      const [m] = await q.query<{ product_id: number; kind: string }>('SELECT product_id, kind FROM stock_moves WHERE id = $1', [id]);
      if (!m) throw fail(404, 'Hareket bulunamadı');
      if (m.kind !== 'adjust') throw fail(400, 'Yalnız elle girilen hareket silinebilir; parti ve irsaliye hareketleri belgeden yönetilir');
      await q.query('DELETE FROM stock_moves WHERE id = $1', [id]);
      await recalc(q, [m.product_id]);
      return { ok: true };
    });
  });
}
