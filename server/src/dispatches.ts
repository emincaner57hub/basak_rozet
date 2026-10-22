import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { recalc } from './costing.js';
import { billToOf, catalogFor } from './customers.js';
import { daySchema, fail, idParam, nextNo, optText, type Row } from './lib.js';

/**
 * İrsaliye (sevk): mal şubeye/kafeye gider, stoktan düşer. Fatura, irsaliyenin "fatura kesilecek"
 * müşterisine (merkeze bağlı şubede zincir, franchise'ta şubenin kendisi) sonradan kesilir.
 * Stand ve etiket gibi promosyon malzemesi irsaliyeye 0 fiyatla eklenir; maliyeti müşteri giderine yazılır.
 */

const dispatchSchema = z.object({
  date: daySchema,
  customerId: z.number().int().positive(),
  orderId: z.number().int().positive().nullish(),
  carrier: optText(80),
  trackingNo: optText(80),
  note: optText(1000),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty: z.number().int().positive('Adet girin').max(1_000_000),
        orderLineId: z.number().int().positive().nullish(),
        unitPrice: z.number().int().min(0).nullish(),
      }),
    )
    .min(1, 'En az bir satır girin')
    .max(500),
});

export async function dispatchDetail(q: Queryable, id: number) {
  const [d] = await q.query<Row>(
    `SELECT d.id, d.no, d.date, d.cancelled, d.carrier, d.tracking_no "trackingNo", d.note, d.created_at "createdAt",
            d.order_id "orderId", o.no "orderNo", o.customer_ref "customerRef", d.invoice_id "invoiceId", i.no "invoiceNo",
            d.customer_id "customerId", c.name "customerName", c.legal_name "customerLegalName", c.address "customerAddress", c.city "customerCity",
            c.phone "customerPhone", c.contact_name "customerContact", ch.name "chainName",
            d.bill_to_id "billToId", b.name "billToName", b.legal_name "billToLegalName", b.tax_id "billToTaxId", b.tax_office "billToTaxOffice", b.address "billToAddress", b.city "billToCity"
     FROM dispatches d JOIN customers c ON c.id = d.customer_id LEFT JOIN customers ch ON ch.id = c.parent_id
     JOIN customers b ON b.id = d.bill_to_id LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN invoices i ON i.id = d.invoice_id
     WHERE d.id = $1`,
    [id],
  );
  if (!d) throw fail(404, 'İrsaliye bulunamadı');
  const lines = await q.query<Row & { qty: number; unitPrice: number; unitCost: number | null }>(
    `SELECT dl.id, dl.product_id "productId", p.code, p.name, p.unit, p.vat_rate "vatRate", dl.qty, dl.unit_price "unitPrice", dl.is_promo "isPromo",
            dl.order_line_id "orderLineId", (SELECT m.unit_cost FROM stock_moves m WHERE m.dispatch_line_id = dl.id LIMIT 1) "unitCost"
     FROM dispatch_lines dl JOIN products p ON p.id = dl.product_id WHERE dl.dispatch_id = $1 ORDER BY dl.is_promo, dl.id`,
    [id],
  );
  return { ...d, lines, total: lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) };
}

export function registerDispatches(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/dispatches', async (req) => {
    const q = z
      .object({
        invoiced: z.enum(['0', '1']).optional(),
        billToId: z.coerce.number().int().optional(),
        from: daySchema.optional(),
        to: daySchema.optional(),
        q: z.string().max(80).optional(),
      })
      .parse(req.query);
    return db.query(
      `SELECT d.id, d.no, d.date, d.cancelled, d.order_id "orderId", o.no "orderNo", d.invoice_id "invoiceId", i.no "invoiceNo",
              c.name "customerName", ch.name "chainName", b.id "billToId", b.name "billToName", d.carrier, d.tracking_no "trackingNo",
              (SELECT COALESCE(SUM(qty),0) FROM dispatch_lines WHERE dispatch_id = d.id AND NOT is_promo) qty,
              (SELECT COALESCE(SUM(qty),0) FROM dispatch_lines WHERE dispatch_id = d.id AND is_promo) "promoQty",
              (SELECT COALESCE(SUM(qty * unit_price),0) FROM dispatch_lines WHERE dispatch_id = d.id) total
       FROM dispatches d JOIN customers c ON c.id = d.customer_id LEFT JOIN customers ch ON ch.id = c.parent_id JOIN customers b ON b.id = d.bill_to_id
       LEFT JOIN orders o ON o.id = d.order_id LEFT JOIN invoices i ON i.id = d.invoice_id
       WHERE ($1::text IS NULL OR ($1 = '1') = (d.invoice_id IS NOT NULL))
         AND ($1::text IS NULL OR NOT d.cancelled)
         AND ($2::int IS NULL OR d.bill_to_id = $2)
         AND ($3::date IS NULL OR d.date >= $3) AND ($4::date IS NULL OR d.date <= $4)
         AND ($5::text IS NULL OR d.no ILIKE '%' || $5 || '%' OR c.name ILIKE '%' || $5 || '%' OR ch.name ILIKE '%' || $5 || '%')
       ORDER BY d.date DESC, d.id DESC LIMIT 500`,
      [q.invoiced ?? null, q.billToId ?? null, q.from ?? null, q.to ?? null, q.q?.trim() || null],
    );
  });

  app.get('/api/dispatches/:id', async (req) => dispatchDetail(db, idParam(req.params)));

  app.post('/api/dispatches', async (req) => {
    const b = dispatchSchema.parse(req.body);
    return db.tx(async (q) => {
      const billTo = await billToOf(q, b.customerId);
      const [ship] = await q.query<{ kind: string }>('SELECT kind FROM customers WHERE id = $1', [b.customerId]);
      if (ship.kind === 'chain') throw fail(400, 'İrsaliye zincire değil, şubeye kesilir');
      const catalog = new Map((await catalogFor(q, b.customerId)).map((p) => [p.id, p]));
      // Sipariş satırları: kalan miktarı aşmasın, fiyat siparişten gelsin
      const orderLines = new Map<number, { product_id: number; unit_price: number; remaining: number }>();
      if (b.orderId) {
        const [o] = await q.query<{ customer_id: number }>('SELECT customer_id FROM orders WHERE id = $1 FOR UPDATE', [b.orderId]);
        if (!o) throw fail(404, 'Sipariş bulunamadı');
        if (o.customer_id !== b.customerId) throw fail(400, 'Sipariş bu müşteriye ait değil');
        const ols = await q.query<{ id: number; product_id: number; unit_price: number; qty: number; shipped: number }>(
          `SELECT ol.id, ol.product_id, ol.unit_price, ol.qty,
                  COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.order_line_id = ol.id AND NOT d.cancelled), 0) shipped
           FROM order_lines ol WHERE ol.order_id = $1`,
          [b.orderId],
        );
        for (const l of ols) orderLines.set(l.id, { product_id: l.product_id, unit_price: l.unit_price, remaining: l.qty - l.shipped });
      }
      const date = b.date;
      const no = await nextNo(q, 'dispatches', 'IRS', date);
      const [{ id }] = await q.query<{ id: number }>(
        `INSERT INTO dispatches(no, date, customer_id, bill_to_id, order_id, carrier, tracking_no, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [no, date, b.customerId, billTo.id, b.orderId ?? null, b.carrier, b.trackingNo, b.note],
      );
      const touched: number[] = [];
      for (const l of b.lines) {
        const p = catalog.get(l.productId);
        if (!p) throw fail(400, `Ürün bu müşteriye gönderilemez ya da pasif (#${l.productId})`);
        const promo = p.kind === 'promo';
        let price = promo ? 0 : (l.unitPrice ?? p.price);
        if (l.orderLineId) {
          const ol = orderLines.get(l.orderLineId);
          if (!ol || ol.product_id !== l.productId) throw fail(400, 'Sipariş satırı eşleşmiyor');
          if (l.qty > ol.remaining) throw fail(400, `${p.code}: siparişte kalan ${ol.remaining} adetten fazla sevk edilemez`);
          ol.remaining -= l.qty;
          if (!promo) price = l.unitPrice ?? ol.unit_price;
        }
        if (price == null) throw fail(400, `${p.code} için fiyat tanımlı değil`);
        const [{ id: lineId }] = await q.query<{ id: number }>(
          'INSERT INTO dispatch_lines(dispatch_id, product_id, order_line_id, qty, unit_price, is_promo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [id, l.productId, l.orderLineId ?? null, l.qty, price, promo],
        );
        await q.query(`INSERT INTO stock_moves(product_id, date, qty, kind, dispatch_line_id) VALUES ($1,$2,$3,'dispatch',$4)`, [l.productId, date, -l.qty, lineId]);
        touched.push(l.productId);
      }
      await recalc(q, touched);
      return { id, no };
    });
  });

  /** İptal: stok geri girer. Faturalanmış irsaliye iptal edilemez (önce faturayı iptal edin). */
  app.post('/api/dispatches/:id/cancel', async (req) => {
    const id = idParam(req.params);
    return db.tx(async (q) => {
      const [d] = await q.query<{ invoice_id: number | null; cancelled: boolean }>('SELECT invoice_id, cancelled FROM dispatches WHERE id = $1 FOR UPDATE', [id]);
      if (!d) throw fail(404, 'İrsaliye bulunamadı');
      if (d.cancelled) return { ok: true };
      if (d.invoice_id) throw fail(400, 'Faturalanmış irsaliye iptal edilemez; önce faturayı iptal edin');
      const products = await q.query<{ product_id: number }>('SELECT DISTINCT product_id FROM dispatch_lines WHERE dispatch_id = $1', [id]);
      await q.query('DELETE FROM stock_moves WHERE dispatch_line_id IN (SELECT id FROM dispatch_lines WHERE dispatch_id = $1)', [id]);
      await q.query('UPDATE dispatches SET cancelled = TRUE WHERE id = $1', [id]);
      await recalc(
        q,
        products.map((p) => p.product_id),
      );
      return { ok: true };
    });
  });

  app.put('/api/dispatches/:id/shipping', async (req) => {
    const b = z.object({ carrier: optText(80), trackingNo: optText(80), note: optText(1000) }).parse(req.body);
    await db.query('UPDATE dispatches SET carrier=$1, tracking_no=$2, note=$3 WHERE id=$4', [b.carrier, b.trackingNo, b.note, idParam(req.params)]);
    return { ok: true };
  });
}
