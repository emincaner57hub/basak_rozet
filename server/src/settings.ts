import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { getSetting, setSetting } from './db.js';
import { optText } from './lib.js';

/** Firma bilgileri: irsaliye ve faturada basılır */
const KEYS = ['companyName', 'companyLegalName', 'companyTaxId', 'companyTaxOffice', 'companyAddress', 'companyPhone', 'companyEmail', 'companyIban', 'invoiceNote'] as const;

export function registerSettings(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/settings', async () => {
    const out: Record<string, string> = {};
    for (const k of KEYS) out[k] = await getSetting(db, `s_${k}`, k === 'companyName' ? 'Başak Rozet' : '');
    return out;
  });
  app.put('/api/settings', async (req) => {
    const b = z.object(Object.fromEntries(KEYS.map((k) => [k, optText(k === 'invoiceNote' || k === 'companyAddress' ? 600 : 160)]))).parse(req.body);
    for (const k of KEYS) if (k in (req.body as object)) await setSetting(db, `s_${k}`, (b as Record<string, string | null>)[k] ?? '');
    return { ok: true };
  });
}
