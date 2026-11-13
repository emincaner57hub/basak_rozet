import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { addDays, todayTr } from './db.js';
import { daySchema, fail } from './lib.js';
import { asEdmError, company, edmClient, importParsedInvoice } from './edm.js';
import { statusTone, type EdmClient, type EdmInvoiceHeader, type FetchFn } from './edm/soap.js';
import { parseUbl, type UblParty } from './edm/ubl.js';

/**
 * İlk kurulum: EDM'deki geçmiş giden faturalardan müşteri listesi çıkarılır ve Excel'e verilir.
 * Kullanıcı her firmanın türünü (zincir / tek kafe / franchise şube / atla) işaretler; dosya geri
 * yüklenince müşteriler açılır, istenirse geçmiş faturalar da irsaliyesiz fatura olarak içe alınır.
 */

const KIND_LABEL = { single: 'Tek kafe', chain: 'Zincir', branch: 'Franchise şube', skip: 'Atla' } as const;
type Kind = keyof typeof KIND_LABEL;

const C = {
  taxId: 'VKN / TCKN',
  legal: 'Ünvan (EDM)',
  name: 'Kısa ad',
  kind: 'Tür',
  parent: 'Bağlı zincir',
  code: 'Müşteri kodu',
  taxOffice: 'Vergi dairesi',
  address: 'Adres',
  city: 'İl',
  email: 'E-posta',
  phone: 'Telefon',
  days: 'Vade (gün)',
  opening: 'Açılış bakiyesi (TL)',
  openingDate: 'Açılış tarihi',
  count: 'Fatura sayısı',
  total: 'Toplam (TL, KDV dahil)',
  first: 'İlk fatura',
  last: 'Son fatura',
  rozet: "Rozet'te",
} as const;
const F = { no: 'EDM no', uuid: 'ETTN', date: 'Tarih', taxId: 'VKN / TCKN', name: 'Ünvan', total: 'Toplam (TL)', status: 'EDM durumu', take: "Rozet'e al", rozet: "Rozet'te" } as const;

const norm = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/\s+/g, ' ');
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

function kindOf(v: unknown): Kind | null {
  const s = norm(v);
  if (!s) return null;
  if (/atla|geç|skip|hayır/.test(s)) return 'skip';
  if (/franchise|şube|sube|branch/.test(s)) return 'branch';
  if (/zincir|chain|merkez/.test(s)) return 'chain';
  if (/tek|kafe|cafe|single|bağımsız/.test(s)) return 'single';
  return null;
}

/** Ay ay tarih aralıkları (EDM sorgusu büyük aralıkta yavaş) */
function months(from: string, to: string) {
  const out: { from: string; to: string }[] = [];
  let cur = from;
  while (cur <= to) {
    const d = new Date(cur + 'T00:00:00Z');
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push({ from: cur, to: end < to ? end : to });
    cur = addDays(end, 1);
  }
  return out;
}

async function listOut(cl: EdmClient, from: string, to: string) {
  const seen = new Map<string, EdmInvoiceHeader>();
  for (const m of months(from, to)) for (const h of await cl.getInvoices({ direction: 'OUT', from: m.from, to: m.to })) if (h.uuid) seen.set(h.uuid.toUpperCase(), h);
  return [...seen.values()];
}

const kurus = (v?: string) => Math.round(Number(v || 0) * 100);
const tl = (k: number) => Math.round(k) / 100;

// ---------------- Excel oluşturma ----------------

export async function buildOnboardingWorkbook(db: Queryable, cl: EdmClient, from: string, to: string): Promise<{ buf: Buffer; customers: number; invoices: number }> {
  const list = (await listOut(cl, from, to)).sort((a, b) => (a.issueDate ?? '').localeCompare(b.issueDate ?? ''));
  const existing = await db.query<{ id: number; name: string; legal_name: string | null; kind: string; tax_id: string }>(
    "SELECT id, name, legal_name, kind, regexp_replace(tax_id, '\\s', '', 'g') tax_id FROM customers WHERE tax_id IS NOT NULL ORDER BY active DESC, id",
  );
  const byTax = new Map<string, { name: string; legal_name: string | null; kind: string }>();
  for (const e of existing) if (!byTax.has(e.tax_id)) byTax.set(e.tax_id, e);
  const ours = await db.query<{ no: string; e_uuid: string | null; e_invoice_no: string | null }>('SELECT no, e_uuid, e_invoice_no FROM invoices WHERE e_uuid IS NOT NULL OR e_invoice_no IS NOT NULL');
  const ourUuid = new Map(ours.filter((o) => o.e_uuid).map((o) => [o.e_uuid!.toUpperCase(), o.no]));
  const ourNo = new Map(ours.filter((o) => o.e_invoice_no).map((o) => [o.e_invoice_no!, o.no]));

  // Firma başına özet; ayrıntı (adres, vergi dairesi) son faturanın UBL'inden
  const groups = new Map<string, { list: EdmInvoiceHeader[]; total: number }>();
  for (const h of list) {
    if (statusTone(h.status) === 'bad') continue;
    const t = digits(h.receiver);
    if (!t) continue;
    const g = groups.get(t) ?? { list: [], total: 0 };
    g.list.push(h);
    g.total += kurus(h.payable);
    groups.set(t, g);
  }
  const details = new Map<string, UblParty>();
  for (const [taxId, g] of groups) {
    if (byTax.has(taxId)) continue;
    const last = g.list.at(-1)!;
    try {
      const [full] = last.id ? await cl.getInvoices({ direction: 'OUT', id: last.id, withContent: true }) : [];
      if (full?.content) details.set(taxId, parseUbl(full.content).customer);
    } catch {
      /* ayrıntı alınamazsa başlıktaki ad yeter */
    }
  }

  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet('Nasıl doldurulur');
  const ws = wb.addWorksheet('Müşteriler');
  const fs = wb.addWorksheet('Faturalar');
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];

  for (const line of [
    'Başak Rozet — EDM\'den ilk kurulum',
    '',
    `EDM'de ${from} – ${to} arasında oluşturulmuş giden faturalar ve bu faturalardaki firmalar listelendi.`,
    '',
    '1) "Müşteriler" sayfasında her firmanın "Tür" sütununu seçin:',
    '     Tek kafe — zincire bağlı olmayan kafe (önceden "Tek kafe" yazılı geldi)',
    '     Zincir — merkez; şubeleri sonra Rozet\'te bu zincirin altına eklersiniz',
    '     Franchise şube — kendi adına fatura alan şube; "Bağlı zincir" sütununa zincirin VKN\'sini ya da kısa adını yazın',
    '     Atla — Rozet\'e alınmasın (bu firmanın faturaları da alınmaz)',
    '2) İsterseniz "Kısa ad" (Rozet\'te görünen ad), "Müşteri kodu" ve "Vade (gün)" sütunlarını düzeltin.',
    '3) Cari: Rozet\'e bugünkü bakiyeyle başlamak için "Açılış bakiyesi" ve "Açılış tarihi" girin.',
    '     Açılış tarihinden önceki faturalar bakiyeye eklenmez; yalnız geçmiş olarak görünür.',
    '     Açılış girmezseniz içe alınan bütün faturalar ödenmemiş sayılır (tahsilatları ayrıca girmeniz gerekir).',
    '4) "Faturalar" sayfasında "Rozet\'e al" sütunu Evet olanlar irsaliyesiz fatura olarak alınır (stok değişmez).',
    '     Yalnız müşterileri almak istiyorsanız hepsini Hayır yapın.',
    '5) Dosyayı kaydedip Rozet\'te Faturalar → EDM\'den al → İlk kurulum ekranından yükleyin. Önce önizleme gösterilir.',
    '',
    '"Rozet\'te" sütunu dolu olan firmalar zaten kayıtlı; onlar değiştirilmez.',
  ])
    help.addRow([line]);
  help.getRow(1).font = { bold: true, size: 14 };
  help.getColumn(1).width = 120;

  const cols = Object.values(C);
  ws.addRow(cols);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  const rows = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [taxId, g] of rows) {
    const ex = byTax.get(taxId);
    const d = details.get(taxId);
    const legal = d?.name || ex?.legal_name || ex?.name || g.list.at(-1)!.customer || '';
    ws.addRow([
      taxId,
      legal,
      ex?.name ?? legal,
      ex ? KIND_LABEL[(ex.kind === 'branch' ? 'branch' : ex.kind) as Kind] : KIND_LABEL.single,
      '',
      '',
      d?.taxOffice ?? '',
      d?.address ?? '',
      d?.city ?? '',
      d?.email ?? '',
      d?.phone ?? '',
      30,
      null,
      null,
      g.list.length,
      tl(g.total),
      g.list[0].issueDate ?? '',
      g.list.at(-1)!.issueDate ?? '',
      ex ? `Var: ${ex.name}` : '',
    ]);
  }
  const widths = [14, 36, 24, 16, 20, 12, 16, 36, 12, 24, 14, 10, 16, 14, 12, 16, 12, 12, 24];
  ws.columns.forEach((c, i) => (c.width = widths[i] ?? 14));
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(13).numFmt = '#,##0.00';
  ws.getColumn(16).numFmt = '#,##0.00';
  const kindCol = 4;
  for (let r = 2; r <= rows.length + 1; r++) {
    ws.getCell(r, kindCol).dataValidation = { type: 'list', allowBlank: false, formulae: [`"${Object.values(KIND_LABEL).join(',')}"`] };
    ws.getCell(r, kindCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  fs.addRow(Object.values(F));
  fs.getRow(1).font = { bold: true };
  fs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  let n = 0;
  for (const h of list) {
    const bad = statusTone(h.status) === 'bad';
    const inRozet = ourUuid.get(h.uuid.toUpperCase()) ?? (h.id ? ourNo.get(h.id) : undefined);
    fs.addRow([h.id, h.uuid, h.issueDate ?? '', digits(h.receiver), h.customer ?? details.get(digits(h.receiver))?.name ?? '', tl(kurus(h.payable)), h.status, bad || inRozet ? 'Hayır' : 'Evet', inRozet ?? '']);
    n++;
    fs.getCell(n + 1, 8).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Evet,Hayır"'] };
  }
  fs.columns = [{ width: 18 }, { width: 38 }, { width: 12 }, { width: 14 }, { width: 36 }, { width: 14 }, { width: 24 }, { width: 11 }, { width: 16 }];
  fs.getColumn(6).numFmt = '#,##0.00';
  fs.views = [{ state: 'frozen', ySplit: 1 }];
  fs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };
  return { buf: Buffer.from(await wb.xlsx.writeBuffer()), customers: rows.length, invoices: n };
}

// ---------------- Excel okuma ----------------

export interface OnboardingCustomer {
  row: number;
  taxId: string;
  legalName: string;
  name: string;
  kind: Kind;
  parentRef: string | null;
  code: string | null;
  taxOffice: string | null;
  address: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  paymentDays: number;
  openingBalance: number;
  openingDate: string | null;
  existingId: number | null;
  existingName: string | null;
  parentName: string | null;
}
export interface OnboardingPreview {
  customers: OnboardingCustomer[];
  invoices: { row: number; id: string; uuid: string; date: string; taxId: string; name: string; total: number; take: boolean; already: string | null }[];
  summary: { create: number; existing: number; skip: number; chains: number; singles: number; branches: number; invoicesToImport: number; invoicesTotal: number; withOpening: number };
  errors: { sheet: string; row: number | null; message: string }[];
}

const cellVal = (v: ExcelJS.CellValue): unknown => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return (v as { result: unknown }).result;
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: string }).text;
  }
  return v;
};

function sheetRows(ws: ExcelJS.Worksheet | undefined, want: Record<string, string>) {
  if (!ws) return { rows: [] as { row: number; get: (k: string) => unknown }[], missing: Object.values(want) };
  const head = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => norm(cellVal(v)));
  const idx: Record<string, number> = {};
  const missing: string[] = [];
  for (const [k, label] of Object.entries(want)) {
    const i = head.findIndex((h) => h === norm(label));
    if (i < 0) missing.push(label);
    else idx[k] = i;
  }
  const rows: { row: number; get: (k: string) => unknown }[] = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const vals = (r.values as ExcelJS.CellValue[]).map(cellVal);
    if (!vals.some((v) => String(v ?? '').trim())) return;
    rows.push({ row: n, get: (k) => (idx[k] == null ? undefined : vals[idx[k]]) });
  });
  return { rows, missing };
}

const str = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();
  return s || null;
};
function money(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v).trim().replace(/\s|₺|TL/gi, '');
  if (!s) return null;
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
function day(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'invalid';
}

export async function parseOnboarding(db: Queryable, data: Buffer): Promise<OnboardingPreview> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw fail(400, 'Dosya okunamadı. Rozet\'in verdiği Excel (.xlsx) dosyasını yükleyin.');
  }
  const errors: OnboardingPreview['errors'] = [];
  const cs = sheetRows(wb.getWorksheet('Müşteriler'), { taxId: C.taxId, legal: C.legal, name: C.name, kind: C.kind, parent: C.parent, code: C.code, taxOffice: C.taxOffice, address: C.address, city: C.city, email: C.email, phone: C.phone, days: C.days, opening: C.opening, openingDate: C.openingDate });
  const required = [C.taxId, C.name, C.kind];
  if (!wb.getWorksheet('Müşteriler')) throw fail(400, '"Müşteriler" sayfası bulunamadı. Rozet\'ten indirdiğiniz dosyayı kullanın.');
  for (const m of cs.missing.filter((x) => (required as string[]).includes(x))) errors.push({ sheet: 'Müşteriler', row: null, message: `"${m}" sütunu yok` });

  const existing = await db.query<{ id: number; name: string; code: string | null; kind: string; bill_to: string; tax_id: string | null }>(
    "SELECT id, name, code, kind, bill_to, regexp_replace(tax_id, '\\s', '', 'g') tax_id FROM customers ORDER BY active DESC, id",
  );
  const exByTax = new Map<string, (typeof existing)[number]>();
  for (const e of existing) if (e.tax_id && !exByTax.has(e.tax_id) && (e.kind !== 'branch' || e.bill_to === 'self')) exByTax.set(e.tax_id, e);
  const codes = new Set(existing.filter((e) => e.code).map((e) => norm(e.code)));

  const customers: OnboardingCustomer[] = [];
  const seenTax = new Set<string>();
  for (const r of cs.rows) {
    const taxId = digits(r.get('taxId'));
    const err = (message: string) => errors.push({ sheet: 'Müşteriler', row: r.row, message });
    if (!/^\d{10,11}$/.test(taxId)) {
      err(`Vergi no 10 ya da 11 hane olmalı: "${str(r.get('taxId')) ?? ''}"`);
      continue;
    }
    if (seenTax.has(taxId)) {
      err(`${taxId} iki kez yazılmış`);
      continue;
    }
    seenTax.add(taxId);
    const kind = kindOf(r.get('kind'));
    if (!kind) {
      err(`Tür seçilmemiş ya da anlaşılmadı: "${str(r.get('kind')) ?? ''}" (Tek kafe / Zincir / Franchise şube / Atla)`);
      continue;
    }
    const legalName = str(r.get('legal')) ?? '';
    const name = (str(r.get('name')) ?? legalName).slice(0, 120);
    if (kind !== 'skip' && !name) err('Kısa ad boş');
    const code = str(r.get('code'));
    if (code && kind !== 'skip' && !exByTax.has(taxId)) {
      if (codes.has(norm(code))) err(`Müşteri kodu zaten kullanılıyor: ${code}`);
      codes.add(norm(code));
    }
    const daysRaw = r.get('days');
    const paymentDays = daysRaw == null || daysRaw === '' ? 30 : Number(daysRaw);
    if (!Number.isInteger(paymentDays) || paymentDays < 0 || paymentDays > 365) err('Vade 0–365 gün arası tam sayı olmalı');
    const opening = money(r.get('opening'));
    if (Number.isNaN(opening)) err('Açılış bakiyesi sayı olmalı');
    const openingDate = day(r.get('openingDate'));
    if (openingDate === 'invalid') err('Açılış tarihi GG.AA.YYYY olmalı');
    if (opening && !openingDate) err('Açılış bakiyesi için açılış tarihi de girin');
    const ex = exByTax.get(taxId);
    customers.push({
      row: r.row,
      taxId,
      legalName,
      name,
      kind,
      parentRef: str(r.get('parent')),
      code,
      taxOffice: str(r.get('taxOffice')),
      address: str(r.get('address')),
      city: str(r.get('city')),
      email: str(r.get('email')),
      phone: str(r.get('phone')),
      paymentDays: Number.isInteger(paymentDays) ? paymentDays : 30,
      openingBalance: opening && !Number.isNaN(opening) ? opening : 0,
      openingDate: openingDate === 'invalid' ? null : openingDate,
      existingId: ex?.id ?? null,
      existingName: ex?.name ?? null,
      parentName: null,
    });
  }
  // Franchise şubenin zinciri: dosyadaki zincir (VKN / kısa ad / kod) ya da Rozet'teki zincir
  const fileChains = customers.filter((c) => c.kind === 'chain');
  const dbChains = existing.filter((e) => e.kind === 'chain');
  for (const c of customers.filter((x) => x.kind === 'branch' && !x.existingId)) {
    const ref = c.parentRef ? norm(c.parentRef) : '';
    const refDigits = digits(c.parentRef);
    const f = ref && fileChains.find((x) => (refDigits && x.taxId === refDigits) || norm(x.name) === ref || (x.code && norm(x.code) === ref) || norm(x.legalName) === ref);
    const d = ref && dbChains.find((x) => (refDigits && x.tax_id === refDigits) || norm(x.name) === ref || (x.code && norm(x.code) === ref));
    if (!ref) errors.push({ sheet: 'Müşteriler', row: c.row, message: `${c.name}: franchise şube için "Bağlı zincir" yazın` });
    else if (!f && !d) errors.push({ sheet: 'Müşteriler', row: c.row, message: `${c.name}: "${c.parentRef}" zinciri bulunamadı (dosyada Tür=Zincir ya da Rozet'te kayıtlı zincir olmalı)` });
    else c.parentName = f ? f.name : (d as (typeof dbChains)[number]).name;
  }

  // Faturalar
  const fsr = sheetRows(wb.getWorksheet('Faturalar'), { no: F.no, uuid: F.uuid, date: F.date, taxId: F.taxId, name: F.name, total: F.total, take: F.take });
  if (wb.getWorksheet('Faturalar')) for (const m of fsr.missing.filter((x) => [F.uuid, F.take, F.taxId].includes(x as never))) errors.push({ sheet: 'Faturalar', row: null, message: `"${m}" sütunu yok` });
  const ours = await db.query<{ no: string; e_uuid: string | null; e_invoice_no: string | null }>('SELECT no, e_uuid, e_invoice_no FROM invoices WHERE e_uuid IS NOT NULL OR e_invoice_no IS NOT NULL');
  const ourUuid = new Map(ours.filter((o) => o.e_uuid).map((o) => [o.e_uuid!.toUpperCase(), o.no]));
  const ourNo = new Map(ours.filter((o) => o.e_invoice_no).map((o) => [o.e_invoice_no!, o.no]));
  const byTax = new Map(customers.map((c) => [c.taxId, c]));
  const invoices: OnboardingPreview['invoices'] = [];
  for (const r of fsr.rows) {
    const uuid = (str(r.get('uuid')) ?? '').toUpperCase();
    const take = /^(evet|e|yes|1|x|true)$/i.test(String(r.get('take') ?? '').trim());
    if (!uuid) continue;
    const taxId = digits(r.get('taxId'));
    const id = str(r.get('no')) ?? '';
    const already = ourUuid.get(uuid) ?? (id ? ourNo.get(id) : undefined) ?? null;
    const c = byTax.get(taxId);
    if (take && !already && (!c || c.kind === 'skip')) {
      if (!c && !exByTax.has(taxId)) errors.push({ sheet: 'Faturalar', row: r.row, message: `${id || uuid}: ${taxId} vergi nolu firma Müşteriler sayfasında yok` });
    }
    invoices.push({ row: r.row, id, uuid, date: day(r.get('date')) ?? '', taxId, name: str(r.get('name')) ?? '', total: money(r.get('total')) || 0, take: take && !already && !!(c ? c.kind !== 'skip' : exByTax.has(taxId)), already });
  }
  const active = customers.filter((c) => c.kind !== 'skip');
  const toImport = invoices.filter((i) => i.take);
  return {
    customers,
    invoices,
    summary: {
      create: active.filter((c) => !c.existingId).length,
      existing: active.filter((c) => c.existingId).length,
      skip: customers.length - active.length,
      chains: active.filter((c) => !c.existingId && c.kind === 'chain').length,
      singles: active.filter((c) => !c.existingId && c.kind === 'single').length,
      branches: active.filter((c) => !c.existingId && c.kind === 'branch').length,
      invoicesToImport: toImport.length,
      invoicesTotal: toImport.reduce((s, i) => s + i.total, 0),
      withOpening: active.filter((c) => !c.existingId && c.openingDate).length,
    },
    errors,
  };
}

// ---------------- İçe alma ----------------

export function registerEdmOnboarding(app: FastifyInstance, { db, now, fetchFn }: { db: Db; now: () => Date; fetchFn?: FetchFn }) {
  const today = () => todayTr(now());

  app.get('/api/edm/onboarding/export', async (req, reply) => {
    const q = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    const to = q.to ?? today();
    const from = q.from ?? addDays(to, -365);
    if (from > to) throw fail(400, 'Başlangıç bitişten sonra olamaz');
    if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) throw fail(400, 'En fazla 3 yıllık aralık seçin');
    const { c } = await edmClient(db, fetchFn);
    let r: Awaited<ReturnType<typeof buildOnboardingWorkbook>>;
    try {
      r = await c.withSession((cl) => buildOnboardingWorkbook(db, cl, from, to));
    } catch (e) {
      throw asEdmError(e);
    }
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="edm-ilk-kurulum-${from}-${to}.xlsx"`);
    reply.header('x-rozet-counts', `${r.customers};${r.invoices}`);
    return reply.send(r.buf);
  });

  const body = z.object({ data: z.string().min(10, 'Dosya seçin').max(30_000_000) });

  app.post('/api/edm/onboarding/preview', async (req) => parseOnboarding(db, Buffer.from(body.parse(req.body).data, 'base64')));

  app.post('/api/edm/onboarding/import', async (req) => {
    const p = await parseOnboarding(db, Buffer.from(body.parse(req.body).data, 'base64'));
    if (p.errors.length) throw fail(400, `Dosyada ${p.errors.length} sorun var; önizlemeye bakıp düzeltin`);
    // 1) Müşteriler: önce zincirler, sonra tek kafeler ve franchise şubeler (tek işlem)
    const created = await db.tx(async (q) => {
      const ids = new Map<string, number>(); // zincir adı → id (franchise eşlemesi için)
      for (const ch of (await q.query<{ id: number; name: string }>("SELECT id, name FROM customers WHERE kind = 'chain'"))) ids.set(norm(ch.name), ch.id);
      let n = 0;
      const order: Kind[] = ['chain', 'single', 'branch'];
      for (const k of order) {
        for (const c of p.customers.filter((x) => x.kind === k && !x.existingId)) {
          const parentId = k === 'branch' ? (ids.get(norm(c.parentName)) ?? null) : null;
          if (k === 'branch' && !parentId) throw fail(400, `${c.name}: zincir bulunamadı`);
          const [r] = await q.query<{ id: number }>(
            `INSERT INTO customers(code, name, kind, parent_id, bill_to, legal_name, tax_id, tax_office, address, city, phone, email, payment_days, opening_balance, opening_date, note)
             VALUES ($1,$2,$3,$4,'self',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'EDM ilk kurulumundan') RETURNING id`,
            [c.code, c.name, k, parentId, c.legalName || c.name, c.taxId, c.taxOffice, c.address, c.city, c.phone, c.email, c.paymentDays, c.openingBalance, c.openingDate],
          );
          if (k === 'chain') ids.set(norm(c.name), r.id);
          n++;
        }
      }
      return n;
    });

    // 2) Faturalar: EDM'den ay ay içerikle çekilir; bulunamayan tek tek istenir
    const want = p.invoices.filter((i) => i.take);
    const results = { imported: 0, failed: [] as { id: string; message: string }[] };
    if (want.length) {
      const { c } = await edmClient(db, fetchFn);
      const co = await company(db);
      try {
        await c.withSession(async (cl) => {
          const content = new Map<string, EdmInvoiceHeader>();
          const dates = want.map((w) => w.date).filter(Boolean).sort();
          if (dates.length) {
            for (const m of months(`${dates[0].slice(0, 7)}-01`, addDays(dates.at(-1)!, 7))) {
              for (const h of await cl.getInvoices({ direction: 'OUT', from: m.from, to: m.to, withContent: true })) if (h.uuid) content.set(h.uuid.toUpperCase(), h);
            }
          }
          for (const w of want) {
            try {
              let h = content.get(w.uuid);
              if (!h?.content && w.id) [h] = await cl.getInvoices({ direction: 'OUT', id: w.id, withContent: true });
              if (!h?.content) throw new Error("EDM fatura içeriğini vermedi");
              const parsed = parseUbl(h.content);
              await importParsedInvoice(db, parsed, { uuid: w.uuid, id: w.id, status: h.status, statusDescription: h.statusDescription, companyTaxId: co.taxId, today: today(), createCustomer: false });
              results.imported++;
            } catch (e) {
              results.failed.push({ id: w.id || w.uuid, message: (e as Error).message });
            }
          }
        });
      } catch (e) {
        throw asEdmError(e);
      }
    }
    return { customersCreated: created, invoicesImported: results.imported, invoicesFailed: results.failed };
  });
}
