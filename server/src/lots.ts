import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { lotCosts, recalc, syncLot } from './costing.js';
import { daySchema, fail, idParam, nextNo, optText, type Row } from './lib.js';

/** Tedarikçiler ve alım partileri (Çin ithalatı, Temu / bavul, yerel) */

const COST_TYPES = ['freight', 'customs_duty', 'import_vat', 'broker', 'cargo', 'other'] as const;

const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Ad girin').max(120),
  kind: z.enum(['china', 'temu', 'broker', 'local', 'other']).default('china'),
  contact: optText(200),
  note: optText(500),
  active: z.boolean().default(true),
});

const lotSchema = z.object({
  date: daySchema,
  supplierId: z.number().int().positive().nullish(),
  kind: z.enum(['import', 'temu', 'local']).default('import'),
  currency: z.enum(['USD', 'CNY', 'EUR', 'TRY']).default('USD'),
  fxRate: z.number().positive('Kur girin').max(100000),
  allocation: z.enum(['value', 'qty']).default('value'),
  expectedDate: daySchema.nullish(),
  note: optText(1000),
  lines: z
    .array(z.object({ productId: z.number().int().positive(), qty: z.number().int().positive('Adet girin'), unitPriceFx: z.number().min(0) }))
    .min(1, 'En az bir ürün girin')
    .max(500),
  costs: z
    .array(
      z.object({
        type: z.enum(COST_TYPES),
        description: optText(200),
        amount: z.number().int().min(0),
        supplierId: z.number().int().positive().nullish(),
        date: daySchema.nullish(),
      }),
    )
    .max(50)
    .default([]),
});

async function lotDetail(q: Queryable, id: number) {
  const [lot] = await q.query<Row>(
    `SELECT t.id, t.no, t.date, t.supplier_id "supplierId", s.name "supplierName", t.kind, t.currency, t.fx_rate "fxRate", t.allocation, t.status,
            t.expected_date "expectedDate", t.received_date "receivedDate", t.note
     FROM lots t LEFT JOIN suppliers s ON s.id = t.supplier_id WHERE t.id = $1`,
    [id],
  );
  if (!lot) throw fail(404, 'Parti bulunamadı');
  const lines = await q.query<Row>(
    `SELECT l.id, l.product_id "productId", p.code, p.name, l.qty, l.unit_price_fx "unitPriceFx"
     FROM lot_lines l JOIN products p ON p.id = l.product_id WHERE l.lot_id = $1 ORDER BY l.id`,
    [id],
  );
  const costs = await q.query<Row>(
    `SELECT c.id, c.type, c.description, c.amount, c.supplier_id "supplierId", s.name "supplierName", c.date
     FROM lot_costs c LEFT JOIN suppliers s ON s.id = c.supplier_id WHERE c.lot_id = $1 ORDER BY c.id`,
    [id],
  );
  const calc = await lotCosts(q, id);
  const byLine = new Map(calc.lines.map((l) => [l.lineId, l]));
  return {
    ...lot,
    lines: lines.map((l) => ({ ...l, goods: byLine.get(l.id as number)?.goods ?? 0, extra: byLine.get(l.id as number)?.extra ?? 0, unitCost: byLine.get(l.id as number)?.unitCost ?? 0 })),
    costs,
    totals: { goods: calc.goods, extra: calc.extra, importVat: calc.vat, landed: calc.goods + calc.extra, qty: calc.lines.reduce((s, l) => s + l.qty, 0) },
  };
}

export function registerLots(app: FastifyInstance, { db }: { db: Db }) {
  // ---- Tedarikçiler ----
  app.get('/api/suppliers', async () =>
    db.query(`SELECT id, name, kind, contact, note, active, (SELECT COUNT(*) FROM lots t WHERE t.supplier_id = s.id) "lotCount" FROM suppliers s ORDER BY active DESC, name`),
  );
  async function saveSupplier(id: number | null, body: unknown) {
    const b = supplierSchema.parse(body);
    if (id) {
      await db.query('UPDATE suppliers SET name=$1, kind=$2, contact=$3, note=$4, active=$5 WHERE id=$6', [b.name, b.kind, b.contact, b.note, b.active, id]);
      return { id };
    }
    const [r] = await db.query<{ id: number }>('INSERT INTO suppliers(name, kind, contact, note, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
      b.name,
      b.kind,
      b.contact,
      b.note,
      b.active,
    ]);
    return r;
  }
  app.post('/api/suppliers', async (req) => saveSupplier(null, req.body));
  app.put('/api/suppliers/:id', async (req) => saveSupplier(idParam(req.params), req.body));

  // ---- Partiler ----
  app.get('/api/lots', async () => {
    const lots = await db.query<Row & { id: number }>(
      `SELECT t.id, t.no, t.date, t.kind, t.currency, t.fx_rate "fxRate", t.status, t.expected_date "expectedDate", t.received_date "receivedDate",
              s.name "supplierName", (SELECT COALESCE(SUM(qty),0) FROM lot_lines WHERE lot_id = t.id) qty,
              (SELECT COUNT(*) FROM lot_lines WHERE lot_id = t.id) "lineCount"
       FROM lots t LEFT JOIN suppliers s ON s.id = t.supplier_id ORDER BY t.date DESC, t.id DESC`,
    );
    const out = [];
    for (const l of lots) {
      const c = await lotCosts(db, l.id);
      out.push({ ...l, goods: c.goods, extra: c.extra, landed: c.goods + c.extra, importVat: c.vat });
    }
    return out;
  });
  app.get('/api/lots/:id', async (req) => lotDetail(db, idParam(req.params)));

  async function saveLot(id: number | null, body: unknown) {
    const b = lotSchema.parse(body);
    if (b.currency === 'TRY') b.fxRate = 1;
    return db.tx(async (q) => {
      const products = await q.query<{ id: number }>('SELECT id FROM products WHERE id = ANY($1::int[])', [b.lines.map((l) => l.productId)]);
      if (products.length !== new Set(b.lines.map((l) => l.productId)).size) throw fail(400, 'Bilinmeyen ürün');
      let lotId = id;
      let oldProducts: number[] = [];
      if (id) {
        oldProducts = (await q.query<{ product_id: number }>('SELECT DISTINCT product_id FROM lot_lines WHERE lot_id = $1', [id])).map((r) => r.product_id);
        const r = await q.query(
          `UPDATE lots SET date=$1, supplier_id=$2, kind=$3, currency=$4, fx_rate=$5, allocation=$6, expected_date=$7, note=$8 WHERE id=$9 RETURNING id`,
          [b.date, b.supplierId ?? null, b.kind, b.currency, b.fxRate, b.allocation, b.expectedDate ?? null, b.note, id],
        );
        if (!r.length) throw fail(404, 'Parti bulunamadı');
        // Satırlar yeniden yazılır (eski stok girişleri syncLot ile güncellenir)
        await q.query('DELETE FROM stock_moves WHERE lot_line_id IN (SELECT id FROM lot_lines WHERE lot_id = $1)', [id]);
        await q.query('DELETE FROM lot_lines WHERE lot_id = $1', [id]);
        await q.query('DELETE FROM lot_costs WHERE lot_id = $1', [id]);
      } else {
        const no = await nextNo(q, 'lots', 'ALM', b.date);
        [{ id: lotId }] = await q.query<{ id: number }>(
          `INSERT INTO lots(no, date, supplier_id, kind, currency, fx_rate, allocation, expected_date, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [no, b.date, b.supplierId ?? null, b.kind, b.currency, b.fxRate, b.allocation, b.expectedDate ?? null, b.note],
        );
      }
      for (const l of b.lines) {
        await q.query('INSERT INTO lot_lines(lot_id, product_id, qty, unit_price_fx) VALUES ($1,$2,$3,$4)', [lotId, l.productId, l.qty, l.unitPriceFx]);
      }
      for (const c of b.costs) {
        if (!c.amount) continue;
        await q.query('INSERT INTO lot_costs(lot_id, type, description, amount, supplier_id, date) VALUES ($1,$2,$3,$4,$5,$6)', [
          lotId,
          c.type,
          c.description,
          c.amount,
          c.supplierId ?? null,
          c.date ?? null,
        ]);
      }
      await syncLot(q, lotId!);
      if (oldProducts.length) await recalc(q, oldProducts);
      return { id: lotId };
    });
  }
  app.post('/api/lots', async (req) => saveLot(null, req.body));
  app.put('/api/lots/:id', async (req) => saveLot(idParam(req.params), req.body));

  /** Teslim al: stoka girer (tarih = teslim tarihi). Geri al: stok girişleri silinir. */
  app.post('/api/lots/:id/receive', async (req) => {
    const id = idParam(req.params);
    const b = z.object({ date: daySchema }).parse(req.body);
    return db.tx(async (q) => {
      const r = await q.query(`UPDATE lots SET status = 'received', received_date = $1 WHERE id = $2 RETURNING id`, [b.date, id]);
      if (!r.length) throw fail(404, 'Parti bulunamadı');
      await syncLot(q, id);
      return { ok: true };
    });
  });
  app.post('/api/lots/:id/unreceive', async (req) => {
    const id = idParam(req.params);
    return db.tx(async (q) => {
      await q.query(`UPDATE lots SET status = 'ordered', received_date = NULL WHERE id = $1`, [id]);
      await syncLot(q, id);
      return { ok: true };
    });
  });
  app.delete('/api/lots/:id', async (req) => {
    const id = idParam(req.params);
    const [l] = await db.query<{ status: string }>('SELECT status FROM lots WHERE id = $1', [id]);
    if (!l) throw fail(404, 'Parti bulunamadı');
    if (l.status === 'received') throw fail(400, 'Teslim alınmış parti silinemez; önce teslimi geri alın');
    await db.query('DELETE FROM lots WHERE id = $1', [id]);
    return { ok: true };
  });
}
