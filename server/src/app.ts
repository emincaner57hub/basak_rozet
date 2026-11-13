import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { registerAuth } from './auth.js';
import { registerCustomers } from './customers.js';
import { registerProducts } from './products.js';
import { registerLots } from './lots.js';
import { registerOrders } from './orders.js';
import { registerDispatches } from './dispatches.js';
import { registerInvoices } from './invoices.js';
import { registerReports } from './reports.js';
import { registerSettings } from './settings.js';
import { registerEdm } from './edm.js';
import { registerEdmOnboarding } from './edm-onboarding.js';
import type { FetchFn } from './edm/soap.js';

export const VERSION = (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || 'yerel';

export interface AppOptions {
  db: Db;
  now?: () => Date;
  webDist?: string;
  sessionSecret: string;
  secureCookies?: boolean;
  /** EDM web servisine istek (testlerde sahte sunucu) */
  edmFetch?: FetchFn;
}

export function buildApp({ db, now = () => new Date(), webDist, sessionSecret, secureCookies = false, edmFetch }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' ? { level: 'warn' } : false, bodyLimit: 20 * 1024 * 1024 });
  app.register(cookie);

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: first?.message ?? 'Geçersiz veri', issues: err.issues });
    }
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    return reply.status(code).send({ error: code >= 500 && code !== 502 ? 'Sunucu hatası' : err.message });
  });

  app.after(() => {
    const { currentUser } = registerAuth(app, { db, secret: sessionSecret, now, secureCookies });
    app.get('/api/health', async () => {
      await db.query('SELECT 1');
      return { ok: true, db: db.kind, version: VERSION };
    });
    registerCustomers(app, { db });
    registerProducts(app, { db });
    registerLots(app, { db });
    registerOrders(app, { db, currentUser, now });
    registerDispatches(app, { db });
    registerInvoices(app, { db, now });
    registerReports(app, { db, now });
    registerSettings(app, { db });
    registerEdm(app, { db, now, currentUser, fetchFn: edmFetch });
    registerEdmOnboarding(app, { db, now, fetchFn: edmFetch });
  });

  // Web arayüzü (derlenmiş). index.html önbelleğe alınmaz: yeni sürüm hemen gelsin.
  if (webDist && fs.existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, index: false, wildcard: false });
    const indexHtml = () => fs.readFileSync(`${webDist}/index.html`, 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Bulunamadı' });
      const file = req.url.split('?')[0];
      if (file !== '/' && fs.existsSync(`${webDist}${file}`) && fs.statSync(`${webDist}${file}`).isFile()) return reply.sendFile(file.slice(1));
      reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml());
    });
  }
  return app;
}
