import '@fastify/cookie';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { fail, idParam } from './lib.js';

/** Kullanıcılar: e-posta + şifre. Oturum imzalı çerezde ("u<id>.<bitiş>.<imza>"). */

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString('base64')}$${(await scrypt(pw, salt, 32)).toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [v, s, k] = stored.split('$');
  if (v !== 's1' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 32);
  const want = Buffer.from(k, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

export const SESSION_COOKIE = 'rozet_session';
const TTL = 12 * 3600_000;

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'staff';
}

export function registerAuth(app: FastifyInstance, o: { db: Db; secret: string; now: () => Date; secureCookies: boolean }) {
  const { db } = o;
  const sign = (payload: string) => crypto.createHmac('sha256', o.secret).update(payload).digest('base64url');
  const users = new WeakMap<object, User>();
  const attempts = new Map<string, { count: number; until: number }>();

  async function userOf(cookie?: string): Promise<User | null> {
    if (!cookie) return null;
    const [who, exp, sig] = cookie.split('.');
    if (!who || !exp || !sig || !who.startsWith('u')) return null;
    const want = sign(`${who}.${exp}`);
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    if (Number(exp) < o.now().getTime()) return null;
    const [u] = await db.query<User & { active: boolean }>('SELECT id, name, email, role, active FROM users WHERE id = $1', [Number(who.slice(1))]);
    return u && u.active ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
  }

  const OPEN = new Set(['/api/login', '/api/logout', '/api/session', '/api/health']);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const path = req.url.split('?')[0];
    if (OPEN.has(path) || path.startsWith('/api/portal/')) return; // portal kendi oturumuyla (portal.ts)
    const u = await userOf(req.cookies[SESSION_COOKIE]);
    if (!u) return reply.status(401).send({ error: 'Giriş gerekli' });
    if ((path.startsWith('/api/users') || path.startsWith('/api/portal-users')) && u.role !== 'admin') return reply.status(403).send({ error: 'Bu işlem için yönetici olmalısınız' });
    users.set(req, u);
  });

  app.get('/api/session', async (req) => ({ user: await userOf(req.cookies[SESSION_COOKIE]) }));

  app.post('/api/login', async (req, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase().max(120), password: z.string().max(200) }).parse(req.body);
    const key = `${req.ip}|${b.email}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw fail(429, 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
    const [u] = await db.query<{ id: number; password_hash: string; active: boolean }>('SELECT id, password_hash, active FROM users WHERE email = $1', [b.email]);
    if (!u || !u.active || !(await verifyPassword(b.password, u.password_hash))) {
      const count = (a?.count ?? 0) + 1;
      attempts.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw fail(401, 'E-posta ya da şifre hatalı');
    }
    attempts.delete(key);
    const exp = String(o.now().getTime() + TTL);
    const payload = `u${u.id}.${exp}`;
    reply.setCookie(SESSION_COOKIE, `${payload}.${sign(payload)}`, { path: '/', httpOnly: true, sameSite: 'lax', secure: o.secureCookies, maxAge: TTL / 1000 });
    return { user: await userOf(`${payload}.${sign(payload)}`) };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- Kullanıcı yönetimi (yönetici) ----
  const userSchema = z.object({
    name: z.string().trim().min(1, 'Ad girin').max(80),
    email: z.string().trim().toLowerCase().email('E-posta geçersiz').max(120),
    role: z.enum(['admin', 'staff']).default('staff'),
    active: z.boolean().default(true),
    password: z.string().min(8, 'Şifre en az 8 karakter olmalı').max(200).optional(),
  });
  app.get('/api/users', async () => db.query('SELECT id, name, email, role, active, created_at "createdAt" FROM users ORDER BY id'));
  app.post('/api/users', async (req) => {
    const b = userSchema.parse(req.body);
    if (!b.password) throw fail(400, 'Şifre girin');
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [b.email])).length) throw fail(409, 'Bu e-posta zaten kayıtlı');
    const [r] = await db.query<{ id: number }>('INSERT INTO users(name, email, role, active, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
      b.name,
      b.email,
      b.role,
      b.active,
      await hashPassword(b.password),
    ]);
    return r;
  });
  app.put('/api/users/:id', async (req) => {
    const id = idParam(req.params);
    const b = userSchema.parse(req.body);
    const me = users.get(req)!;
    if (id === me.id && (!b.active || b.role !== 'admin')) throw fail(400, 'Kendi yöneticiliğinizi kapatamazsınız');
    const dup = await db.query<{ id: number }>('SELECT id FROM users WHERE email = $1', [b.email]);
    if (dup.length && dup[0].id !== id) throw fail(409, 'Bu e-posta zaten kayıtlı');
    await db.query('UPDATE users SET name=$1, email=$2, role=$3, active=$4 WHERE id=$5', [b.name, b.email, b.role, b.active, id]);
    if (b.password) await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(b.password), id]);
    return { ok: true };
  });
  // Herkes kendi şifresini değiştirebilir
  app.post('/api/me/password', async (req) => {
    const b = z.object({ current: z.string(), next: z.string().min(8, 'Yeni şifre en az 8 karakter olmalı').max(200) }).parse(req.body);
    const me = users.get(req)!;
    const [u] = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [me.id]);
    if (!(await verifyPassword(b.current, u.password_hash))) throw fail(400, 'Mevcut şifre hatalı');
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(b.next), me.id]);
    return { ok: true };
  });

  return { currentUser: (req: object) => users.get(req) ?? null };
}

/** İlk kurulum: hiç kullanıcı yoksa verilen bilgilerle yönetici oluşturur */
export async function ensureAdmin(db: Db, email?: string, password?: string, name = 'Yönetici') {
  const [{ n }] = await db.query<{ n: number }>('SELECT COUNT(*) n FROM users');
  if (n > 0 || !email || !password) return false;
  await db.query("INSERT INTO users(name, email, role, password_hash) VALUES ($1, $2, 'admin', $3)", [name, email.trim().toLowerCase(), await hashPassword(password)]);
  return true;
}
