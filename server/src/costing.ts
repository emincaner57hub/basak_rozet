import type { Queryable } from './db.js';

/**
 * Maliyet: hareketli ağırlıklı ortalama.
 * - Girişler (parti, elle giriş) kendi birim maliyetiyle gelir.
 * - Çıkışlar (irsaliye, sayım eksiği) o anki ortalamadan çıkar.
 * Sonradan gelen bir masraf (ör. broker faturası) partiyi değiştirirse ürünün tüm hareketleri
 * baştan hesaplanır; satılan malın maliyeti ve kârlılık raporları da güncellenir.
 */

export interface LotCostLine {
  lineId: number;
  productId: number;
  qty: number;
  /** Malın TL değeri (kuruş) */
  goods: number;
  /** Dağıtılan masraf (kuruş) */
  extra: number;
  /** Birim gerçek maliyet (kuruş) */
  unitCost: number;
}

/** Partinin satırlarına masrafları dağıtır (KDV hariç; ithalat KDV'si maliyete girmez) */
export async function lotCosts(q: Queryable, lotId: number): Promise<{ lines: LotCostLine[]; goods: number; extra: number; vat: number }> {
  const [lot] = await q.query<{ fx_rate: number; allocation: 'value' | 'qty' }>('SELECT fx_rate, allocation FROM lots WHERE id = $1', [lotId]);
  if (!lot) return { lines: [], goods: 0, extra: 0, vat: 0 };
  const rows = await q.query<{ id: number; product_id: number; qty: number; unit_price_fx: number }>(
    'SELECT id, product_id, qty, unit_price_fx FROM lot_lines WHERE lot_id = $1 ORDER BY id',
    [lotId],
  );
  const [c] = await q.query<{ extra: number; vat: number }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type <> 'import_vat'), 0) extra, COALESCE(SUM(amount) FILTER (WHERE type = 'import_vat'), 0) vat
     FROM lot_costs WHERE lot_id = $1`,
    [lotId],
  );
  const goodsOf = (r: (typeof rows)[number]) => r.qty * r.unit_price_fx * lot.fx_rate * 100;
  const totalGoods = rows.reduce((s, r) => s + goodsOf(r), 0);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const byValue = lot.allocation === 'value' && totalGoods > 0;
  const lines = rows.map((r) => {
    const goods = goodsOf(r);
    const share = byValue ? goods / totalGoods : totalQty ? r.qty / totalQty : 0;
    const extra = c.extra * share;
    return { lineId: r.id, productId: r.product_id, qty: r.qty, goods: Math.round(goods), extra: Math.round(extra), unitCost: (goods + extra) / r.qty };
  });
  return { lines, goods: Math.round(totalGoods), extra: c.extra, vat: c.vat };
}

/** Teslim alınmış partinin stok girişlerini satırlarıyla eşitler ve maliyetleri yeniden hesaplar */
export async function syncLot(q: Queryable, lotId: number) {
  const [lot] = await q.query<{ status: string; received_date: string | null }>('SELECT status, received_date FROM lots WHERE id = $1', [lotId]);
  const before = await q.query<{ product_id: number }>(
    `SELECT DISTINCT m.product_id FROM stock_moves m JOIN lot_lines l ON l.id = m.lot_line_id WHERE l.lot_id = $1`,
    [lotId],
  );
  // Silinen satırların hareketleri ON DELETE CASCADE ile gider; kalanlar yeniden yazılır
  await q.query('DELETE FROM stock_moves WHERE lot_line_id IN (SELECT id FROM lot_lines WHERE lot_id = $1)', [lotId]);
  const affected = new Set(before.map((r) => r.product_id));
  if (lot?.status === 'received') {
    const { lines } = await lotCosts(q, lotId);
    for (const l of lines) {
      await q.query(
        `INSERT INTO stock_moves(product_id, date, qty, kind, lot_line_id, unit_cost, fixed_cost) VALUES ($1, $2, $3, 'lot', $4, $5, TRUE)`,
        [l.productId, lot.received_date, l.qty, l.lineId, l.unitCost],
      );
      affected.add(l.productId);
    }
  }
  await recalc(q, [...affected]);
}

/** Ürünlerin tüm hareketlerini tarih sırasıyla yeniden fiyatlar; ürünün ortalama maliyetini yazar */
export async function recalc(q: Queryable, productIds: number[]) {
  for (const pid of [...new Set(productIds)]) {
    const moves = await q.query<{ id: number; qty: number; unit_cost: number | null; fixed_cost: boolean }>(
      'SELECT id, qty, unit_cost, fixed_cost FROM stock_moves WHERE product_id = $1 ORDER BY date, id',
      [pid],
    );
    let qty = 0;
    let value = 0;
    let avg: number | null = null;
    for (const m of moves) {
      let cost: number;
      if (m.qty > 0 && m.fixed_cost && m.unit_cost != null) cost = m.unit_cost;
      else cost = avg ?? (m.qty > 0 && m.unit_cost != null ? m.unit_cost : 0);
      if (m.unit_cost == null || Math.abs(m.unit_cost - cost) > 0.00005) {
        await q.query('UPDATE stock_moves SET unit_cost = $1 WHERE id = $2', [cost, m.id]);
      }
      if (m.qty > 0) {
        value += m.qty * cost;
        qty += m.qty;
        if (qty > 0) avg = value / qty;
      } else {
        qty += m.qty;
        value = qty * (avg ?? cost);
      }
    }
    await q.query('UPDATE products SET avg_cost = $1 WHERE id = $2', [avg, pid]);
  }
}
