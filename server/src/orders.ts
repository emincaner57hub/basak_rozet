import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { todayTr } from './db.js';
import { catalogFor } from './customers.js';
import { daySchema, fail, idParam, nextNo, optText, type Row } from './lib.js';

/**
 * Siparişler: panelden, telefon/WhatsApp ile ya da Excel'den. Sevk adresi müşteridir (şube ya da tek kafe).
 * Durum satırlardan çıkar: açık → kısmi sevk → sevk edildi; kapatılan sipariş "kapandı".
 */

const SHIPPED = (ol: string) =>
  `COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.order_line_id = ${ol}.id AND NOT d.cancelled), 0)`;

const lineSchema = z.object({
  productId: z.number().int().positive(),
  qty: z.number().int().positive('Adet girin').max(1_000_000),
  /** Verilmezse müşterinin fiyatı (özel fiyat, yoksa liste fiyatı) */
  unitPrice: z.number().int().min(0).nullish(),
});
export const orderSchema = z.object({
  customerId: z.number().int().positive(),
  date: daySchema,
  channel: z.enum(['panel', 'phone', 'whatsapp', 'email', 'excel', 'portal']).default('panel'),
  requestedDate: daySchema.nullish(),
  customerRef: optText(80),
  note: optText(1000),
  lines: z.array(lineSchema).min(1, 'En az bir ürün girin').max(500),
});

/** Satırları müşterinin kataloğuna göre doğrular ve fiyatlandırır */
async function priceLines(q: Queryable, customerId: number, lines: z.infer<typeof lineSchema>[]) {
  const [c] = await q.query<{ kind: string; active: boolean; name: string }>('SELECT kind, active, name FROM customers WHERE id = $1', [customerId]);
  if (!c) throw fail(404, 'Müşteri bulunamadı');
  if (c.kind === 'chain') throw fail(400, 'Sipariş zincirin kendisine değil, şubesine girilir (sevk adresi şubedir)');
  const catalog = new Map((await catalogFor(q, customerId)).map((p) => [p.id, p]));
  return lines.map((l) => {
    const p = catalog.get(l.productId);
    if (!p) throw fail(400, `Ürün bu müşteriye satılamaz ya da pasif (#${l.productId})`);
    const price = p.kind === 'promo' ? 0 : (l.unitPrice ?? p.price);
    if (price == null) throw fail(400, `${p.code} için fiyat tanımlı değil; ürüne liste fiyatı ya da müşteriye özel fiyat girin`);
    return { ...l, unitPrice: price };
  });
}

export async function createOrder(q: Queryable, b: z.infer<typeof orderSchema>, userId: number | null, batch: string | null = null) {
  const lines = await priceLines(q, b.customerId, b.lines);
  const no = await nextNo(q, 'orders', 'SIP', b.date);
  const [{ id }] = await q.query<{ id: number }>(
    `INSERT INTO orders(no, date, customer_id, channel, requested_date, customer_ref, note, batch, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [no, b.date, b.customerId, b.channel, b.requestedDate ?? null, b.customerRef, b.note, batch, userId],
  );
  for (const [i, l] of lines.entries()) {
    await q.query('INSERT INTO order_lines(order_id, product_id, qty, unit_price, sort) VALUES ($1,$2,$3,$4,$5)', [id, l.productId, l.qty, l.unitPrice, i]);
  }
  return { id, no };
}

export async function orderDetail(q: Queryable, id: number) {
  const [o] = await q.query<Row>(
    `SELECT o.id, o.no, o.date, o.customer_id "customerId", c.name "customerName", c.kind "customerKind", ch.name "chainName",
            o.channel, o.cancelled, o.requested_date "requestedDate", o.customer_ref "customerRef", o.note, o.batch, o.created_at "createdAt",
            pu.name "portalUser", pu.phone "portalPhone"
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN customers ch ON ch.id = c.parent_id
          LEFT JOIN portal_users pu ON pu.id = o.portal_user_id WHERE o.id = $1`,
    [id],
  );
  if (!o) throw fail(404, 'Sipariş bulunamadı');
  const lines = await q.query<Row & { qty: number; shipped: number; unitPrice: number }>(
    `SELECT ol.id, ol.product_id "productId", p.code, p.name, p.kind, p.vat_rate "vatRate", ol.qty, ol.unit_price "unitPrice", ${SHIPPED('ol')} shipped,
            COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.product_id = p.id), 0) "onHand"
     FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = $1 ORDER BY ol.sort, ol.id`,
    [id],
  );
  const dispatches = await q.query(
    `SELECT d.id, d.no, d.date, d.cancelled, d.invoice_id "invoiceId", i.no "invoiceNo",
            (SELECT COALESCE(SUM(qty),0) FROM dispatch_lines WHERE dispatch_id = d.id AND NOT is_promo) qty
     FROM dispatches d LEFT JOIN invoices i ON i.id = d.invoice_id WHERE d.order_id = $1 ORDER BY d.id`,
    [id],
  );
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const shipped = lines.reduce((s, l) => s + Math.min(l.shipped, l.qty), 0);
  return {
    ...o,
    status: statusOf(o.cancelled as boolean, qty, shipped),
    lines: lines.map((l) => ({ ...l, remaining: Math.max(0, l.qty - l.shipped) })),
    dispatches,
    total: lines.reduce((s, l) => s + l.qty * l.unitPrice, 0),
  };
}

export const statusOf = (cancelled: boolean, qty: number, shipped: number) =>
  shipped >= qty && qty > 0 ? 'shipped' : cancelled ? (shipped > 0 ? 'closed' : 'cancelled') : shipped > 0 ? 'partial' : 'open';

// ---------- Excel ----------
const norm = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/\s+/g, ' ');
const isCustomerHeader = (h: string) => /şube|sube|müşteri|musteri|kafe|cafe|mağaza|magaza|lokasyon|nokta|branch|store/.test(h);
const isCustomerCodeHeader = (h: string) => isCustomerHeader(h) && /kod|code|no/.test(h);
const isProductHeader = (h: string) => /ürün|urun|kod|code|model|sku|rozet|tasarım|tasarim/.test(h) && !isCustomerHeader(h);
const isQtyHeader = (h: string) => /adet|miktar|qty|quantity|sayı|sayi/.test(h);

export interface ImportPreview {
  format: 'long' | 'wide';
  orders: { customerId: number; customerName: string; lines: { productId: number; code: string; name: string; qty: number; unitPrice: number | null }[]; total: number }[];
  errors: { row: number | null; message: string }[];
  rows: number;
}

/** Excel dosyasını okur, müşteri ve ürünleri eşleştirir; hiçbir şey kaydetmez */
export async function parseOrderFile(q: Queryable, data: Buffer, opts: { chainId?: number | null; customerId?: number | null }): Promise<ImportPreview> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw fail(400, 'Dosya okunamadı. Excel (.xlsx) dosyası yükleyin.');
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw fail(400, 'Dosyada veri yok');
  const cell = (v: ExcelJS.CellValue): unknown => {
    if (v && typeof v === 'object') {
      if ('result' in v) return (v as { result: unknown }).result;
      if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
      if ('text' in v) return (v as { text: string }).text;
    }
    return v;
  };
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cell);
    grid[n - 1] = vals;
  });
  const headerIdx = grid.findIndex((r) => r && r.some((v) => String(v ?? '').trim()));
  if (headerIdx < 0) throw fail(400, 'Başlık satırı bulunamadı');
  const headers = grid[headerIdx].map(norm);

  // Eşleştirme sözlükleri
  const customers = await q.query<{ id: number; code: string | null; name: string; kind: string; parent_id: number | null; parent_name: string | null }>(
    `SELECT c.id, c.code, c.name, c.kind, c.parent_id, p.name parent_name FROM customers c LEFT JOIN customers p ON p.id = c.parent_id
     WHERE c.active AND c.kind <> 'chain' AND ($1::int IS NULL OR c.parent_id = $1)`,
    [opts.chainId ?? null],
  );
  const byCode = new Map(customers.filter((c) => c.code).map((c) => [norm(c.code), c]));
  const byName = new Map<string, (typeof customers)[number][]>();
  for (const c of customers) {
    for (const key of [norm(c.name), c.parent_name ? norm(`${c.parent_name} ${c.name}`) : '', c.parent_name ? norm(`${c.parent_name} - ${c.name}`) : ''].filter(Boolean)) {
      byName.set(key, [...(byName.get(key) ?? []), c]);
    }
  }
  const products = await q.query<{ id: number; code: string; name: string }>('SELECT id, code, name FROM products WHERE active');
  const prodByKey = new Map<string, (typeof products)[number]>();
  for (const p of products) {
    prodByKey.set(norm(p.code), p);
    if (!prodByKey.has(norm(p.name))) prodByKey.set(norm(p.name), p);
  }
  const errors: ImportPreview['errors'] = [];
  type Cust = (typeof customers)[number];
  const findCustomer = (code: unknown, name: unknown, row: number): Cust | null => {
    if (opts.customerId) return customers.find((c) => c.id === opts.customerId) ?? null;
    const c: Cust | undefined = (code ? byCode.get(norm(code)) : undefined) ?? (name ? byCode.get(norm(name)) : undefined);
    if (c) return c;
    const hits = name ? (byName.get(norm(name)) ?? []) : [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) errors.push({ row, message: `"${name}" birden fazla şubeyle eşleşiyor; şube kodu kullanın` });
    else errors.push({ row, message: `Müşteri bulunamadı: ${String(code || name || '(boş)')}` });
    return null;
  };

  const wanted = new Map<number, Map<number, number>>(); // müşteri → ürün → adet
  const add = (customerId: number, productId: number, qty: number) => {
    const m = wanted.get(customerId) ?? new Map<number, number>();
    m.set(productId, (m.get(productId) ?? 0) + qty);
    wanted.set(customerId, m);
  };
  const qtyOf = (v: unknown, row: number, what: string) => {
    if (v == null || String(v).trim() === '') return 0;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      errors.push({ row, message: `${what}: adet tam sayı olmalı (${String(v)})` });
      return 0;
    }
    return n;
  };

  const productCol = headers.findIndex(isProductHeader);
  const qtyCol = headers.findIndex(isQtyHeader);
  const custCodeCol = headers.findIndex(isCustomerCodeHeader);
  const custNameCol = headers.findIndex((h, i) => isCustomerHeader(h) && i !== custCodeCol);
  const format: 'long' | 'wide' = productCol >= 0 && qtyCol >= 0 ? 'long' : 'wide';
  let rows = 0;

  if (format === 'long') {
    if (custCodeCol < 0 && custNameCol < 0 && !opts.customerId) {
      throw fail(400, 'Dosyada şube/müşteri sütunu yok. Tek kafe siparişi ise yüklemeden önce müşteriyi seçin.');
    }
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row || !row.some((v) => String(v ?? '').trim())) continue;
      rows++;
      const excelRow = r + 1;
      const c = findCustomer(custCodeCol >= 0 ? row[custCodeCol] : null, custNameCol >= 0 ? row[custNameCol] : null, excelRow);
      const pv = row[productCol];
      const p = prodByKey.get(norm(pv));
      if (!p) errors.push({ row: excelRow, message: `Ürün bulunamadı: ${String(pv ?? '(boş)')}` });
      const qty = qtyOf(row[qtyCol], excelRow, String(pv ?? ''));
      if (c && p && qty > 0) add(c.id, p.id, qty);
    }
  } else {
    // Geniş tablo: satırlar şube, sütunlar ürün kodu
    const custCols = headers.map((h, i) => (isCustomerHeader(h) ? i : -1)).filter((i) => i >= 0);
    const firstCol = custCols.length ? -1 : 0;
    const prodCols: { col: number; product: (typeof products)[number] }[] = [];
    headers.forEach((h, i) => {
      if (custCols.includes(i) || i === firstCol || !h) return;
      const p = prodByKey.get(h);
      if (p) prodCols.push({ col: i, product: p });
      else if (!/toplam|total|not|açıklama|aciklama/.test(h)) errors.push({ row: headerIdx + 1, message: `Sütun bir ürünle eşleşmedi: "${grid[headerIdx][i]}"` });
    });
    if (!prodCols.length) throw fail(400, 'Ürün sütunu bulunamadı. Başlık satırında ürün kodları olmalı (ya da "Ürün kodu" ve "Adet" sütunları).');
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row || !row.some((v) => String(v ?? '').trim())) continue;
      const qtys = prodCols.map((pc) => ({ ...pc, qty: qtyOf(row[pc.col], r + 1, pc.product.code) }));
      if (!qtys.some((x) => x.qty > 0)) continue;
      rows++;
      const code = custCodeCol >= 0 ? row[custCodeCol] : null;
      const name = custNameCol >= 0 ? row[custNameCol] : firstCol === 0 ? row[0] : null;
      const c = findCustomer(code, name, r + 1);
      if (c) for (const x of qtys) if (x.qty > 0) add(c.id, x.product.id, x.qty);
    }
  }

  const orders: ImportPreview['orders'] = [];
  for (const [customerId, m] of wanted) {
    const cust = customers.find((c) => c.id === customerId)!;
    const catalog = new Map((await catalogFor(q, customerId)).map((p) => [p.id, p]));
    const lines = [...m].map(([productId, qty]) => {
      const p = products.find((x) => x.id === productId)!;
      const cp = catalog.get(productId);
      if (!cp) errors.push({ row: null, message: `${p.code} ${cust.name} için satılabilir değil (başka zincire özel ya da pasif)` });
      else if (cp.price == null && cp.kind !== 'promo') errors.push({ row: null, message: `${p.code} için fiyat tanımlı değil` });
      return { productId, code: p.code, name: p.name, qty, unitPrice: cp ? (cp.kind === 'promo' ? 0 : cp.price) : null };
    });
    orders.push({
      customerId,
      customerName: cust.parent_name ? `${cust.parent_name} · ${cust.name}` : cust.name,
      lines,
      total: lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0),
    });
  }
  orders.sort((a, b) => a.customerName.localeCompare(b.customerName, 'tr'));
  return { format, orders, errors, rows };
}

/** Zincir için boş sipariş şablonu: satırlar şubeler, sütunlar zincirin görebildiği ürünler */
export async function orderTemplate(q: Queryable, chainId: number | null) {
  const branches = chainId
    ? await q.query<{ code: string | null; name: string; id: number }>(`SELECT id, code, name FROM customers WHERE parent_id = $1 AND active ORDER BY name`, [chainId])
    : [];
  const products = await q.query<{ code: string; name: string }>(
    `SELECT code, name FROM products WHERE active AND kind = 'sale' AND (chain_id IS NULL OR chain_id = $1) ORDER BY category NULLS LAST, code`,
    [chainId],
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sipariş');
  ws.addRow(['Şube kodu', 'Şube', ...products.map((p) => p.code)]);
  ws.getRow(1).font = { bold: true };
  for (const b of branches) ws.addRow([b.code ?? '', b.name]);
  ws.columns.forEach((c, i) => (c.width = i === 1 ? 28 : 14));
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  const ps = wb.addWorksheet('Ürünler');
  ps.addRow(['Ürün kodu', 'Ürün adı']);
  ps.getRow(1).font = { bold: true };
  for (const p of products) ps.addRow([p.code, p.name]);
  ps.columns = [{ width: 16 }, { width: 40 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function registerOrders(app: FastifyInstance, { db, currentUser, now }: { db: Db; currentUser: (r: object) => { id: number } | null; now: () => Date }) {
  app.get('/api/orders', async (req) => {
    const q = z
      .object({ status: z.enum(['open', 'all', 'portal']).default('open'), customerId: z.coerce.number().int().optional(), q: z.string().max(80).optional() })
      .parse(req.query);
    const rows = await db.query<Row & { cancelled: boolean; qty: number; shipped: number }>(
      `SELECT o.id, o.no, o.date, o.channel, o.cancelled, o.requested_date "requestedDate", o.customer_ref "customerRef", o.batch,
              c.id "customerId", c.name "customerName", ch.name "chainName", pu.name "portalUser",
              (o.portal_user_id IS NOT NULL AND o.seen_at IS NULL) "isNew",
              (SELECT COALESCE(SUM(ol.qty),0) FROM order_lines ol WHERE ol.order_id = o.id) qty,
              (SELECT COALESCE(SUM(LEAST(ol.qty, ${SHIPPED('ol')})),0) FROM order_lines ol WHERE ol.order_id = o.id) shipped,
              (SELECT COALESCE(SUM(ol.qty * ol.unit_price),0) FROM order_lines ol WHERE ol.order_id = o.id) total
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN customers ch ON ch.id = c.parent_id
            LEFT JOIN portal_users pu ON pu.id = o.portal_user_id
       WHERE ($1::int IS NULL OR o.customer_id = $1 OR c.parent_id = $1)
         AND ($3::bool IS NOT TRUE OR o.portal_user_id IS NOT NULL)
         AND ($2::text IS NULL OR o.no ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%' OR ch.name ILIKE '%' || $2 || '%' OR o.customer_ref ILIKE '%' || $2 || '%')
       ORDER BY o.date DESC, o.id DESC LIMIT 500`,
      [q.customerId ?? null, q.q?.trim() || null, q.status === 'portal'],
    );
    const out = rows.map((r) => ({ ...r, status: statusOf(r.cancelled, r.qty, r.shipped) }));
    return q.status === 'open' ? out.filter((r) => r.status === 'open' || r.status === 'partial') : out;
  });

  /** Portaldan gelip henüz açılmamış siparişler (menü rozeti, panel) */
  app.get('/api/orders/incoming', async () => {
    const [r] = await db.query<{ n: number }>('SELECT COUNT(*)::int n FROM orders WHERE portal_user_id IS NOT NULL AND seen_at IS NULL AND NOT cancelled');
    return { count: r.n };
  });

  app.get('/api/orders/:id', async (req) => {
    const id = idParam(req.params);
    const d = await orderDetail(db, id);
    await db.query('UPDATE orders SET seen_at = now() WHERE id = $1 AND portal_user_id IS NOT NULL AND seen_at IS NULL', [id]);
    return d;
  });

  app.post('/api/orders', async (req) => {
    const b = orderSchema.parse(req.body);
    return db.tx((q) => createOrder(q, b, currentUser(req)?.id ?? null));
  });

  /** Düzenleme: sevk edilmiş satır silinemez ve sevk edilenden aza indirilemez */
  app.put('/api/orders/:id', async (req) => {
    const id = idParam(req.params);
    const b = orderSchema.omit({ customerId: true }).extend({ lines: z.array(lineSchema.extend({ id: z.number().int().positive().optional() })).min(1).max(500) }).parse(req.body);
    return db.tx(async (q) => {
      const [o] = await q.query<{ customer_id: number; cancelled: boolean }>('SELECT customer_id, cancelled FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!o) throw fail(404, 'Sipariş bulunamadı');
      const existing = await q.query<{ id: number; shipped: number; qty: number }>(`SELECT ol.id, ol.qty, ${SHIPPED('ol')} shipped FROM order_lines ol WHERE ol.order_id = $1`, [id]);
      const priced = await priceLines(q, o.customer_id, b.lines);
      const keep = new Set<number>();
      for (const [i, l] of b.lines.entries()) {
        const cur = l.id ? existing.find((e) => e.id === l.id) : undefined;
        if (l.id && !cur) throw fail(400, 'Bilinmeyen sipariş satırı');
        if (cur) {
          if (l.qty < cur.shipped) throw fail(400, `Bir satır sevk edilen miktardan (${cur.shipped}) aza indirilemez`);
          keep.add(cur.id);
          await q.query('UPDATE order_lines SET product_id=$1, qty=$2, unit_price=$3, sort=$4 WHERE id=$5', [l.productId, l.qty, priced[i].unitPrice, i, cur.id]);
        } else {
          await q.query('INSERT INTO order_lines(order_id, product_id, qty, unit_price, sort) VALUES ($1,$2,$3,$4,$5)', [id, l.productId, l.qty, priced[i].unitPrice, i]);
        }
      }
      for (const e of existing) {
        if (keep.has(e.id)) continue;
        if (e.shipped > 0) throw fail(400, 'Sevk edilmiş satır silinemez');
        await q.query('DELETE FROM order_lines WHERE id = $1', [e.id]);
      }
      await q.query('UPDATE orders SET date=$1, channel=$2, requested_date=$3, customer_ref=$4, note=$5 WHERE id=$6', [
        b.date,
        b.channel,
        b.requestedDate ?? null,
        b.customerRef,
        b.note,
        id,
      ]);
      return { id };
    });
  });

  /** Kapat: sevk edilmeyen kısım iptal (sevk edilenler kalır). Yeniden aç ile geri alınır. */
  app.post('/api/orders/:id/close', async (req) => {
    const b = z.object({ cancelled: z.boolean().default(true) }).parse(req.body ?? {});
    const r = await db.query('UPDATE orders SET cancelled = $1 WHERE id = $2 RETURNING id', [b.cancelled, idParam(req.params)]);
    if (!r.length) throw fail(404, 'Sipariş bulunamadı');
    return { ok: true };
  });
  app.delete('/api/orders/:id', async (req) => {
    const id = idParam(req.params);
    if ((await db.query('SELECT 1 FROM dispatches WHERE order_id = $1', [id])).length) throw fail(409, 'Sevk edilmiş sipariş silinemez; kapatın');
    await db.query('DELETE FROM orders WHERE id = $1', [id]);
    return { ok: true };
  });

  // ---- Excel ----
  const fileSchema = z.object({
    data: z.string().min(10).max(15_000_000),
    chainId: z.number().int().positive().nullish(),
    customerId: z.number().int().positive().nullish(),
  });
  app.post('/api/orders/import/preview', async (req) => {
    const b = fileSchema.parse(req.body);
    return parseOrderFile(db, Buffer.from(b.data, 'base64'), b);
  });
  app.post('/api/orders/import', async (req) => {
    const b = fileSchema.extend({ date: daySchema.optional(), requestedDate: daySchema.nullish(), note: optText(500) }).parse(req.body);
    const preview = await parseOrderFile(db, Buffer.from(b.data, 'base64'), b);
    if (preview.errors.length) throw fail(400, `Dosyada ${preview.errors.length} sorun var; önizlemede düzeltin`);
    if (!preview.orders.length) throw fail(400, 'Dosyada sipariş satırı yok');
    const batch = crypto.randomBytes(6).toString('hex');
    const date = b.date ?? todayTr(now());
    return db.tx(async (q) => {
      const created = [];
      for (const o of preview.orders) {
        created.push(
          await createOrder(
            q,
            {
              customerId: o.customerId,
              date,
              channel: 'excel',
              requestedDate: b.requestedDate ?? null,
              customerRef: null,
              note: b.note,
              lines: o.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })),
            },
            currentUser(req)?.id ?? null,
            batch,
          ),
        );
      }
      return { batch, orders: created };
    });
  });
  app.get('/api/orders/template', async (req, reply) => {
    const q = z.object({ chainId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const buf = await orderTemplate(db, q.chainId ?? null);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="siparis-sablonu.xlsx"`);
    return reply.send(buf);
  });
}
