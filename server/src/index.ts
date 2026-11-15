import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getSetting, openDb, setSetting } from './db.js';
import { buildApp } from './app.js';
import { startEdmSchedule } from './cari.js';
import { ensureAdmin, hashPassword } from './auth.js';
import { seedDemo } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === 'production';

async function connect() {
  for (let i = 1; ; i++) {
    try {
      return await openDb({ url: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR ?? path.resolve(here, '../data/pglite') });
    } catch (e) {
      if (i >= 20) throw e;
      console.warn(`Veritabanına bağlanılamadı (${(e as Error).message}); ${i}/20, 3 sn sonra tekrar…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
const db = await connect();

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = await getSetting(db, 'session_secret', '');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await setSetting(db, 'session_secret', secret);
  }
}

// İlk yönetici: üretimde ADMIN_EMAIL + ADMIN_PASSWORD ile; yerelde admin@local / admin1234
const adminEmail = process.env.ADMIN_EMAIL ?? (production ? undefined : 'admin@local');
const adminPassword = process.env.ADMIN_PASSWORD ?? (production ? undefined : 'admin1234');
if (await ensureAdmin(db, adminEmail, adminPassword)) console.log(`İlk yönetici oluşturuldu: ${adminEmail}`);
// Şifre unutulursa: Render'da ADMIN_RESET=1 → ADMIN_EMAIL kullanıcısının şifresi ADMIN_PASSWORD olur (sonra ADMIN_RESET silinmeli)
if (production && process.env.ADMIN_RESET === '1' && adminEmail && adminPassword) {
  const r = await db.query<{ id: number }>("UPDATE users SET password_hash = $1, active = true WHERE email = $2 RETURNING id", [await hashPassword(adminPassword), adminEmail.trim().toLowerCase()]);
  console.log(r.length ? `Yönetici şifresi ADMIN_PASSWORD ile sıfırlandı: ${adminEmail}` : `ADMIN_RESET: ${adminEmail} kullanıcısı bulunamadı`);
}
else if (production && !(await db.query('SELECT 1 FROM users LIMIT 1')).length) console.warn('UYARI: Kullanıcı yok. ADMIN_EMAIL ve ADMIN_PASSWORD ortam değişkenlerini girin.');

const app = buildApp({ db, sessionSecret: secret, webDist: path.resolve(here, '../../web/dist'), secureCookies: production });
await app.ready();
// Örnek veri: yerelde boş veritabanında, üretimde yalnız SEED=1 ile
if (process.env.SEED === '1' || (!production && process.env.SEED !== '0')) await seedDemo(db, app, adminEmail!, adminPassword!);

await app.listen({ port, host: '0.0.0.0' });
if (production) startEdmSchedule(db); // EDM tanımlıysa saatlik e-fatura eşitleme
console.log(`Başak Rozet: http://localhost:${port}  (veritabanı: ${db.kind})`);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
