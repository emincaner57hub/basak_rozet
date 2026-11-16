import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './auth.js';
import { catalogFor } from './customers.js';
import type { Db, Queryable } from './db.js';
import { todayTr } from './db.js';
import { fail, idParam, optText, type Row } from './lib.js';
import { createOrder, orderSchema, statusOf } from './orders.js';

/**
 * Müşteri portalı (cepte, uygulama değil): satın almacı kendi kodu ve şifresiyle girer, atandığı şubelere
 * sipariş verir, siparişlerinin durumunu görür. Zincire atanan satın almacı zincirin tüm şubelerine sipariş verebilir.
 * Oturum ayrı çerezde ("p<id>.<bitiş>.<imza>"); ekip oturumundan bağımsız.
 */
export const PORTAL_COOKIE = 'rozet_portal';
const TTL = 30 * 24 * 3600_000; // 30 gün: cepte her seferinde giriş istemesin

/** Satır başına sevk edilen (sipariş miktarını aşmadan) toplamı */
const SHIPPED_SUM = `(SELECT COALESCE(SUM(LEAST(ol.qty, COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
                                                             WHERE dl.order_line_id = ol.id AND NOT d.cancelled), 0))), 0)
                      FROM order_lines ol WHERE ol.order_id = o.id)`;

interface PortalUser {
  id: number;
  code: string;
  name: string;
  seePrices: boolean;
}

/** Satın almacının sipariş verebileceği müşteriler: atanan şube / tek kafe + atanan zincirlerin aktif şubeleri */
async function allowedCustomers(q: Queryable, userId: number) {
  return q.query<{ id: number; name: string; chainName: string | null; city: string | null; address: string | null }>(
    `SELECT DISTINCT c.id, c.name, ch.name "chainName", c.city, c.address
     FROM portal_user_customers pc
     JOIN customers x ON x.id = pc.customer_id
     JOIN customers c ON (c.id = x.id AND x.kind <> 'chain') OR (x.kind = 'chain' AND c.parent_id = x.id)
     LEFT JOIN customers ch ON ch.id = c.parent_id
     WHERE pc.user_id = $1 AND c.active
     ORDER BY ch.name NULLS FIRST, c.name`,
    [userId],
  );
}

export function registerPortal(app: FastifyInstance, o: { db: Db; secret: string; now: () => Date; secureCookies: boolean }) {
  const { db } = o;
  const sign = (p: string) => crypto.createHmac('sha256', `portal|${o.secret}`).update(p).digest('base64url');
  const attempts = new Map<string, { count: number; until: number }>();

  async function portalUser(req: FastifyRequest): Promise<PortalUser | null> {
    const c = req.cookies[PORTAL_COOKIE];
    if (!c) return null;
    const [who, exp, sig] = c.split('.');
    if (!who?.startsWith('p') || !exp || !sig) return null;
    const want = sign(`${who}.${exp}`);
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    if (Number(exp) < o.now().getTime()) return null;
    const [u] = await db.query<PortalUser & { active: boolean }>('SELECT id, code, name, active, see_prices "seePrices" FROM portal_users WHERE id = $1', [Number(who.slice(1))]);
    return u?.active ? { id: u.id, code: u.code, name: u.name, seePrices: u.seePrices } : null;
  }
  async function need(req: FastifyRequest) {
    const u = await portalUser(req);
    if (!u) throw fail(401, 'Giriş gerekli');
    return u;
  }

  // ---------------- Satın almacı (portal) ----------------
  app.get('/api/portal/session', async (req) => {
    const u = await portalUser(req);
    return { user: u, customers: u ? await allowedCustomers(db, u.id) : [] };
  });

  app.post('/api/portal/login', async (req, reply) => {
    const b = z.object({ code: z.string().trim().toLowerCase().min(1).max(40), password: z.string().max(200) }).parse(req.body);
    const key = `${req.ip}|${b.code}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw fail(429, 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
    const [u] = await db.query<{ id: number; password_hash: string; active: boolean }>('SELECT id, password_hash, active FROM portal_users WHERE code = $1', [b.code]);
    if (!u || !u.active || !(await verifyPassword(b.password, u.password_hash))) {
      const count = (a?.count ?? 0) + 1;
      attempts.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw fail(401, 'Kullanıcı kodu ya da şifre hatalı');
    }
    attempts.delete(key);
    await db.query('UPDATE portal_users SET last_login = now() WHERE id = $1', [u.id]);
    const payload = `p${u.id}.${o.now().getTime() + TTL}`;
    reply.setCookie(PORTAL_COOKIE, `${payload}.${sign(payload)}`, { path: '/', httpOnly: true, sameSite: 'lax', secure: o.secureCookies, maxAge: TTL / 1000 });
    return { ok: true };
  });

  app.post('/api/portal/logout', async (_req, reply) => {
    reply.clearCookie(PORTAL_COOKIE, { path: '/' });
    return { ok: true };
  });

  async function checkCustomer(userId: number, customerId: number) {
    if (!(await allowedCustomers(db, userId)).some((c) => c.id === customerId)) throw fail(403, 'Bu şubeye sipariş veremezsiniz');
  }

  app.get('/api/portal/catalog', async (req) => {
    const u = await need(req);
    const { customerId } = z.object({ customerId: z.coerce.number().int().positive() }).parse(req.query);
    await checkCustomer(u.id, customerId);
    // Yalnız "satılabilir" satış ürünleri; fiyat: müşteriye (şube → zincir) özel, yoksa liste fiyatı.
    // Fiyatı hiç olmayan ürün görünür ama sipariş verilemez. Stok ve maliyet müşteriye gösterilmez.
    return (await catalogFor(db, customerId))
      .filter((p) => p.kind === 'sale' && p.sellable)
      .map((p) => ({
        id: p.id, code: p.code, name: p.name, category: p.category, unit: p.unit, vatRate: Number(p.vatRate), image: p.image,
        orderable: p.price != null,
        // "Fiyat görebilir" kapalıysa fiyat hiç gönderilmez
        price: u.seePrices ? p.price : null,
        special: u.seePrices ? p.special : false,
      }));
  });

  app.post('/api/portal/orders', async (req) => {
    const u = await need(req);
    const b = z
      .object({
        customerId: z.number().int().positive(),
        requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        customerRef: optText(80),
        note: optText(1000),
        lines: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().int().positive().max(100_000) })).min(1, 'En az bir ürün seçin').max(200),
      })
      .parse(req.body);
    await checkCustomer(u.id, b.customerId);
    const cat = new Map((await catalogFor(db, b.customerId)).map((p) => [p.id, p]));
    for (const l of b.lines) {
      const p = cat.get(l.productId);
      if (!p || p.kind !== 'sale' || !p.sellable) throw fail(400, 'Ürün sipariş için açık değil');
      if (p.price == null) throw fail(400, `${p.name} için fiyat tanımlı değil; Başak Rozet'e sorun`);
    }
    const body = orderSchema.parse({ ...b, date: todayTr(o.now()), channel: 'portal', lines: b.lines.map((l) => ({ ...l, unitPrice: null })) });
    return db.tx(async (q) => {
      const r = await createOrder(q, body, null);
      await q.query('UPDATE orders SET portal_user_id = $1 WHERE id = $2', [u.id, r.id]);
      return r;
    });
  });

  app.get('/api/portal/orders', async (req) => {
    const u = await need(req);
    const ids = (await allowedCustomers(db, u.id)).map((c) => c.id);
    const rows = await db.query<Row & { cancelled: boolean; qty: number; shipped: number }>(
      `SELECT o.id, o.no, o.date, o.requested_date "requestedDate", o.customer_ref "customerRef", o.cancelled, c.name "customerName",
              pu.name "byName",
              (SELECT COALESCE(SUM(ol.qty),0) FROM order_lines ol WHERE ol.order_id = o.id) qty,
              ${SHIPPED_SUM} shipped,
              (SELECT COALESCE(SUM(ol.qty * ol.unit_price),0) FROM order_lines ol WHERE ol.order_id = o.id) total
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN portal_users pu ON pu.id = o.portal_user_id
       WHERE o.customer_id = ANY($1::int[]) ORDER BY o.date DESC, o.id DESC LIMIT 100`,
      [ids],
    );
    return rows.map((r) => ({ ...r, total: u.seePrices ? r.total : null, status: statusOf(r.cancelled, Number(r.qty), Number(r.shipped)) }));
  });

  app.get('/api/portal/orders/:id', async (req) => {
    const u = await need(req);
    const id = idParam(req.params);
    const [ord] = await db.query<Row & { customerId: number; cancelled: boolean }>(
      `SELECT o.id, o.no, o.date, o.requested_date "requestedDate", o.customer_ref "customerRef", o.note, o.cancelled, o.customer_id "customerId", c.name "customerName"
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
      [id],
    );
    if (!ord) throw fail(404, 'Sipariş bulunamadı');
    await checkCustomer(u.id, ord.customerId);
    const lines = await db.query<Row & { qty: number; shipped: number }>(
      `SELECT p.code, p.name, p.unit, ol.qty, ol.unit_price "unitPrice",
              COALESCE((SELECT SUM(dl.qty) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.order_line_id = ol.id AND NOT d.cancelled), 0) shipped
       FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = $1 ORDER BY ol.sort, ol.id`,
      [id],
    );
    const qty = lines.reduce((s, l) => s + Number(l.qty), 0);
    const shipped = lines.reduce((s, l) => s + Math.min(Number(l.shipped), Number(l.qty)), 0);
    return { ...ord, lines: u.seePrices ? lines : lines.map((l) => ({ ...l, unitPrice: null })), status: statusOf(ord.cancelled, qty, shipped) };
  });

  // ---------------- Ekip: satın almacı kullanıcıları (Ayarlar) ----------------
  const userSchema = z.object({
    code: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Kod 3–40 karakter: harf, rakam, nokta, tire'),
    name: z.string().trim().min(1, 'Ad girin').max(80),
    phone: optText(40),
    email: optText(120),
    active: z.boolean().default(true),
    seePrices: z.boolean().default(true),
    password: z.string().min(6, 'Şifre en az 6 karakter').max(200).nullish(),
    customerIds: z.array(z.number().int().positive()).max(500).default([]),
  });

  app.get('/api/portal-users', async () =>
    db.query(
      `SELECT u.id, u.code, u.name, u.phone, u.email, u.active, u.see_prices "seePrices", u.last_login "lastLogin",
              COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'kind', c.kind) ORDER BY c.name)
                        FROM portal_user_customers pc JOIN customers c ON c.id = pc.customer_id WHERE pc.user_id = u.id), '[]') customers
       FROM portal_users u ORDER BY u.active DESC, u.name`,
    ),
  );

  async function saveUser(id: number | null, body: unknown) {
    const b = userSchema.parse(body);
    if (!id && !b.password) throw fail(400, 'Şifre girin');
    return db.tx(async (q) => {
      const dup = await q.query<{ id: number }>('SELECT id FROM portal_users WHERE code = $1', [b.code]);
      if (dup.length && dup[0].id !== id) throw fail(409, 'Bu kullanıcı kodu kullanılıyor');
      let uid = id;
      if (id) {
        const r = await q.query('UPDATE portal_users SET code=$1, name=$2, phone=$3, email=$4, active=$5, see_prices=$6 WHERE id=$7 RETURNING id', [
          b.code, b.name, b.phone, b.email, b.active, b.seePrices, id,
        ]);
        if (!r.length) throw fail(404, 'Kullanıcı bulunamadı');
        if (b.password) await q.query('UPDATE portal_users SET password_hash=$1 WHERE id=$2', [await hashPassword(b.password), id]);
      } else {
        const [r] = await q.query<{ id: number }>(
          'INSERT INTO portal_users(code, name, phone, email, active, password_hash, see_prices) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [b.code, b.name, b.phone, b.email, b.active, await hashPassword(b.password!), b.seePrices],
        );
        uid = r.id;
      }
      await q.query('DELETE FROM portal_user_customers WHERE user_id = $1', [uid]);
      for (const c of new Set(b.customerIds)) await q.query('INSERT INTO portal_user_customers(user_id, customer_id) VALUES ($1,$2)', [uid, c]);
      return { id: uid };
    });
  }
  app.post('/api/portal-users', async (req) => saveUser(null, req.body));
  app.put('/api/portal-users/:id', async (req) => saveUser(idParam(req.params), req.body));
  app.delete('/api/portal-users/:id', async (req) => {
    const id = idParam(req.params);
    if ((await db.query('SELECT 1 FROM orders WHERE portal_user_id = $1 LIMIT 1', [id])).length) {
      await db.query('UPDATE portal_users SET active = FALSE WHERE id = $1', [id]);
      return { ok: true, deactivated: true };
    }
    await db.query('DELETE FROM portal_users WHERE id = $1', [id]);
    return { ok: true };
  });
}
