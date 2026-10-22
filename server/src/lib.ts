import { z } from 'zod';
import type { Queryable } from './db.js';

export const fail = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code });
export const idParam = (p: unknown, key = 'id') => z.coerce.number().int().positive().parse((p as Record<string, string>)[key]);
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG olmalı');

/** Boş metni null yapar */
export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export type Row = Record<string, unknown>;

/**
 * Belge numarası: ÖNEK-YIL-SIRA (ör. SIP-2026-00012). Aynı anda iki numara çakışmasın diye
 * işlem içinde kilitlenir.
 */
export async function nextNo(q: Queryable, table: 'orders' | 'dispatches' | 'invoices' | 'lots', prefix: string, date: string) {
  const year = date.slice(0, 4);
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`no:${table}:${year}`]);
  const [r] = await q.query<{ n: number | null }>(
    `SELECT MAX(CAST(split_part(no, '-', 3) AS INTEGER)) n FROM ${table} WHERE no LIKE $1`,
    [`${prefix}-${year}-%`],
  );
  return `${prefix}-${year}-${String((r?.n ?? 0) + 1).padStart(5, '0')}`;
}

/** Kuruş tutarında KDV: satır bazında yuvarlanır */
export const vatOf = (net: number, rate: number) => Math.round((net * rate) / 100);
