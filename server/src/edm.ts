import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from './db.js';

/**
 * EDM Bilişim e-Fatura web servisi (SOAP, i2i şeması) — gelen ve giden faturaları okur, cariye yazar.
 *
 * Ayarlar (Render → Environment): EDM_USER, EDM_PASSWORD, isteğe bağlı EDM_URL
 * (varsayılan https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc).
 * Şifre koda ya da veritabanına yazılmaz.
 *
 * Akış: Login → GetInvoice (DIRECTION IN / OUT, tarih aralığı, UBL içerik) → Logout.
 * Her fatura UBL'inden: ETTN, no, tarih, tür (SATIS / IADE…), karşı taraf VKN/TCKN ve unvanı, matrah, KDV, toplam.
 * Karşı taraf vergi numarasıyla bulunur; yoksa açılır (giden → müşteri, gelen → tedarikçi).
 * Giden fatura uygulamada kesilmiş faturayla eşleşirse (e-Fatura no ya da müşteri + tarih + tutar) cariye bir kez yazılır.
 */

export const EDM_DEFAULT_URL = 'https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc';
const NS = 'http://schemas.i2i.com/ei/wsdl';

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface EdmConfig {
  url: string;
  user: string;
  password: string;
}

export const edmConfig = (): EdmConfig | null =>
  process.env.EDM_USER && process.env.EDM_PASSWORD ? { url: process.env.EDM_URL || EDM_DEFAULT_URL, user: process.env.EDM_USER.trim(), password: process.env.EDM_PASSWORD } : null;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v)).trim();

export class EdmError extends Error {}

/** XML öğe: { ad: değer } sırası korunur; değer nesne ise iç içe */
type Node = [string, string | Node[]];
const render = (nodes: Node[]): string => nodes.map(([k, v]) => `<${k}>${typeof v === 'string' ? esc(v) : render(v)}</${k}>`).join('');

export class EdmClient {
  private session: string | null = null;
  private wsdl: { actions: Map<string, string>; orders: string[][] } | null = null;

  constructor(
    private cfg: EdmConfig,
    private fetcher: Fetcher = fetch as unknown as Fetcher,
  ) {}

  /** WSDL'den SOAPAction'lar ve öğe sıraları (sıra önemli: sunucu sırasız öğeleri yok sayabilir) */
  private async loadWsdl() {
    if (this.wsdl) return this.wsdl;
    const actions = new Map<string, string>();
    const orders: string[][] = [];
    try {
      const r = await this.fetcher(`${this.cfg.url}?singleWsdl`);
      const t = await r.text();
      for (const m of t.matchAll(/<wsdl:operation name="(\w+)">\s*<soap:operation soapAction="([^"]*)"/g)) actions.set(m[1], m[2]);
      for (const m of t.matchAll(/<xs:sequence>([\s\S]*?)<\/xs:sequence>/g)) {
        const names = [...m[1].matchAll(/<xs:element[^>]*\bname="(\w+)"/g)].map((x) => x[1]);
        if (names.length) orders.push(names);
      }
    } catch {
      /* WSDL alınamazsa varsayılanlar */
    }
    this.wsdl = { actions, orders };
    return this.wsdl;
  }

  /** Verilen alanları WSDL'deki sıraya dizer (bu alanların hepsini içeren ilk dizi) */
  private ordered(nodes: Node[]): Node[] {
    const names = nodes.map((n) => n[0]);
    const seq = this.wsdl?.orders.find((o) => names.every((n) => o.includes(n)));
    return seq ? [...nodes].sort((a, b) => seq.indexOf(a[0]) - seq.indexOf(b[0])) : nodes;
  }

  private header(): Node {
    return [
      'REQUEST_HEADER',
      this.ordered([
        ['SESSION_ID', this.session ?? '-1'],
        ['CLIENT_TXN_ID', randomUUID()],
        ['ACTION_DATE', new Date().toISOString().slice(0, 19)],
        ['REASON', 'Cari takip'],
        ['APPLICATION_NAME', 'BasakRozet'],
        ['HOSTNAME', 'basak-rozet'],
        ['CHANNEL_NAME', 'HTTP'],
        ['COMPRESSED', 'N'],
      ]),
    ];
  }

  async call(op: string, body: Node[]): Promise<Record<string, unknown>> {
    const w = await this.loadWsdl();
    const envelope =
      `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<ns:${op}Request xmlns:ns="${NS}">${render(this.ordered([this.header(), ...body]))}</ns:${op}Request></s:Body></s:Envelope>`;
    const action = w.actions.get(op) ?? w.actions.get(`${op}Request`) ?? op;
    let r;
    try {
      r = await this.fetcher(this.cfg.url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` }, body: envelope });
    } catch (e) {
      throw new EdmError(`EDM'ye bağlanılamadı: ${(e as Error).message}`);
    }
    const text = await r.text();
    const doc = xml.parse(text) as Record<string, unknown>;
    const bodyEl = ((doc.Envelope as Record<string, unknown>)?.Body ?? {}) as Record<string, unknown>;
    const fault = bodyEl.Fault as Record<string, unknown> | undefined;
    if (fault || r.status >= 400) {
      const detail = fault ? JSON.stringify(fault.detail ?? '').match(/"(?:ERROR_SHORT_DES|ERROR_LONG_DES|ERROR_SHORT_DESC|faultstring)":"([^"]+)"/)?.[1] : null;
      const msg = detail || txt(fault?.faultstring) || `HTTP ${r.status}`;
      throw new EdmError(`EDM ${op}: ${msg}`);
    }
    const res = Object.values(bodyEl)[0] as Record<string, unknown>;
    return res ?? {};
  }

  async login() {
    const r = await this.call('Login', [
      ['USER_NAME', this.cfg.user],
      ['PASSWORD', this.cfg.password],
    ]);
    const sid = txt(r.SESSION_ID);
    if (!sid) throw new EdmError('EDM girişi başarısız (oturum numarası dönmedi)');
    this.session = sid;
  }

  async logout() {
    if (!this.session) return;
    try {
      await this.call('Logout', []);
    } catch {
      /* önemsiz */
    }
    this.session = null;
  }

  /** Tarih aralığındaki faturalar (UBL içeriğiyle) */
  async invoices(direction: 'IN' | 'OUT', from: string, to: string, limit = 1000): Promise<EdmInvoice[]> {
    const key: Node[] = this.ordered([
      ['LIMIT', String(limit)],
      ['START_DATE', `${from}T00:00:00`],
      ['END_DATE', `${to}T23:59:59`],
      ['READ_INCLUDED', 'true'],
      ['DIRECTION', direction],
    ]);
    const r = await this.call('GetInvoice', [
      ['INVOICE_SEARCH_KEY', key],
      ['HEADER_ONLY', 'N'],
      ['INVOICE_CONTENT_TYPE', 'XML'],
    ]);
    return arr(r.INVOICE as Record<string, unknown>[]).map((i) => parseInvoiceEl(i, direction));
  }
}

export interface EdmInvoice {
  uuid: string;
  no: string;
  direction: 'in' | 'out';
  status: string;
  ubl: string | null;
  header: Record<string, string>;
}

function parseInvoiceEl(i: Record<string, unknown>, direction: 'IN' | 'OUT'): EdmInvoice {
  const h = (i.HEADER ?? {}) as Record<string, unknown>;
  const header: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) header[k] = txt(v);
  const pa = h.PAYABLE_AMOUNT as Record<string, unknown> | undefined;
  if (pa && typeof pa === 'object') header.CURRENCY = txt(pa['@currencyID']);
  const content = txt(i.CONTENT);
  let ubl: string | null = null;
  if (content) {
    ubl = content.trimStart().startsWith('<') ? content : Buffer.from(content, 'base64').toString('utf8');
  }
  return {
    uuid: txt(i['@UUID'] ?? i.UUID),
    no: txt(i['@ID'] ?? i.ID),
    direction: direction === 'IN' ? 'in' : 'out',
    status: [header.STATUS, header.STATUS_DESCRIPTION, header.GIB_STATUS_DESCRIPTION].filter(Boolean).join(' · '),
    ubl,
    header,
  };
}

const kurus = (v: unknown) => Math.round(Number(txt(v).replace(',', '.') || 0) * 100);

export interface ParsedInvoice {
  uuid: string;
  no: string;
  date: string;
  type: string;
  profile: string;
  currency: string;
  fxRate: number | null;
  subtotal: number;
  vat: number;
  total: number;
  supplier: { taxId: string; name: string; taxOffice: string };
  customer: { taxId: string; name: string; taxOffice: string };
}

function party(p: unknown): { taxId: string; name: string; taxOffice: string } {
  const P = ((p as Record<string, unknown>)?.Party ?? {}) as Record<string, unknown>;
  const ids = arr(P.PartyIdentification as Record<string, unknown>[]).map((x) => x.ID as Record<string, unknown>);
  const id = ids.find((x) => /^(VKN|TCKN)$/i.test(txt(x?.['@schemeID']))) ?? ids[0];
  const person = P.Person as Record<string, unknown> | undefined;
  const name = txt((P.PartyName as Record<string, unknown>)?.Name) || [txt(person?.FirstName), txt(person?.FamilyName)].filter(Boolean).join(' ');
  const taxOffice = txt(((P.PartyTaxScheme as Record<string, unknown>)?.TaxScheme as Record<string, unknown>)?.Name);
  return { taxId: txt(id), name, taxOffice };
}

/** UBL-TR faturadan cari için gereken alanlar (tutarlar TL kuruş) */
export function parseUbl(ublXml: string): ParsedInvoice {
  const d = xml.parse(ublXml) as Record<string, unknown>;
  const inv = (d.Invoice ?? Object.values(d).find((v) => typeof v === 'object')) as Record<string, unknown>;
  const cur = txt(inv.DocumentCurrencyCode) || 'TRY';
  const rate = cur === 'TRY' ? null : Number(txt((inv.PricingExchangeRate as Record<string, unknown>)?.CalculationRate)) || null;
  const lmt = (inv.LegalMonetaryTotal ?? {}) as Record<string, unknown>;
  const toTl = (k: number) => (rate ? Math.round(k * rate) : k);
  const vat = arr(inv.TaxTotal as Record<string, unknown>[]).reduce((s, t) => s + kurus(t.TaxAmount), 0);
  const payable = kurus(lmt.PayableAmount);
  const taxExcl = kurus(lmt.TaxExclusiveAmount);
  return {
    uuid: txt(inv.UUID),
    no: txt(inv.ID),
    date: txt(inv.IssueDate).slice(0, 10),
    type: txt(inv.InvoiceTypeCode).toUpperCase(),
    profile: txt(inv.ProfileID).toUpperCase(),
    currency: cur,
    fxRate: rate,
    subtotal: toTl(taxExcl),
    vat: toTl(vat),
    total: toTl(payable || taxExcl + vat),
    supplier: party(inv.AccountingSupplierParty),
    customer: party(inv.AccountingCustomerParty),
  };
}

/** Reddedilen / iptal edilen fatura cariye yazılmaz */
export const isCancelled = (status: string) => /\b(RED|REJECT|IPTAL|İPTAL|CANCEL)/i.test(status);

/** Karşı tarafı vergi numarasıyla bul; yoksa aç */
async function ensureParty(q: Queryable, dir: 'in' | 'out', p: { taxId: string; name: string; taxOffice: string }): Promise<number> {
  const name = (p.name || p.taxId || 'Bilinmeyen').slice(0, 200);
  if (dir === 'out') {
    if (p.taxId) {
      const [c] = await q.query<{ id: number }>(
        `SELECT id FROM customers WHERE tax_id = $1 AND (kind <> 'branch' OR bill_to = 'self') ORDER BY (kind = 'chain') DESC, active DESC, id LIMIT 1`,
        [p.taxId],
      );
      if (c) return c.id;
    }
    const [r] = await q.query<{ id: number }>(
      `INSERT INTO customers(name, kind, legal_name, tax_id, tax_office, note) VALUES ($1, 'single', $1, $2, $3, 'e-Faturadan açıldı') RETURNING id`,
      [name, p.taxId || null, p.taxOffice || null],
    );
    return r.id;
  }
  if (p.taxId) {
    const [s] = await q.query<{ id: number }>('SELECT id FROM suppliers WHERE tax_id = $1 ORDER BY active DESC, id LIMIT 1', [p.taxId]);
    if (s) return s.id;
  }
  const [r] = await q.query<{ id: number }>(`INSERT INTO suppliers(name, kind, tax_id, tax_office, note) VALUES ($1, 'local', $2, $3, 'e-Faturadan açıldı') RETURNING id`, [
    name,
    p.taxId || null,
    p.taxOffice || null,
  ]);
  return r.id;
}

/** Giden e-faturayı uygulamada kesilmiş faturayla eşleştir (cariye iki kez yazılmasın) */
async function matchLocal(q: Queryable, p: ParsedInvoice, customerId: number): Promise<{ invoiceId: number; customerId: number } | null> {
  const [byNo] = await q.query<{ id: number; customer_id: number }>('SELECT id, customer_id FROM invoices WHERE NOT cancelled AND e_invoice_no = $1 LIMIT 1', [p.no]);
  if (byNo) return { invoiceId: byNo.id, customerId: byNo.customer_id };
  const [byAmt] = await q.query<{ id: number; customer_id: number }>(
    `SELECT i.id, i.customer_id FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE NOT i.cancelled AND i.e_invoice_no IS NULL AND i.date = $1 AND abs(i.total - $2) <= 100
       AND (i.customer_id = $3 OR ($4::text <> '' AND c.tax_id = $4))
       AND NOT EXISTS (SELECT 1 FROM e_invoices e WHERE e.invoice_id = i.id)
     ORDER BY abs(i.total - $2), i.id LIMIT 1`,
    [p.date, p.total, customerId, p.customer.taxId],
  );
  if (!byAmt) return null;
  await q.query('UPDATE invoices SET e_invoice_no = $1 WHERE id = $2 AND e_invoice_no IS NULL', [p.no, byAmt.id]);
  return { invoiceId: byAmt.id, customerId: byAmt.customer_id };
}

export interface SyncResult {
  in: number;
  out: number;
  new: number;
  updated: number;
  newCustomers: number;
  newSuppliers: number;
  matched: number;
  errors: string[];
}

/** Faturaları kaydeder; aynı ETTN yeniden gelirse durum / tutar güncellenir, cari bağlantısı korunur */
export async function saveInvoices(db: Db, list: EdmInvoice[]): Promise<SyncResult> {
  const res: SyncResult = { in: 0, out: 0, new: 0, updated: 0, newCustomers: 0, newSuppliers: 0, matched: 0, errors: [] };
  for (const e of list) {
    if (!e.ubl) {
      res.errors.push(`${e.no || e.uuid}: içerik gelmedi`);
      continue;
    }
    let p: ParsedInvoice;
    try {
      p = parseUbl(e.ubl);
    } catch (err) {
      res.errors.push(`${e.no || e.uuid}: okunamadı (${(err as Error).message})`);
      continue;
    }
    const uuid = (p.uuid || e.uuid).toUpperCase();
    const no = p.no || e.no;
    if (!uuid || !no || !p.date) {
      res.errors.push(`${no || uuid}: ETTN / no / tarih eksik`);
      continue;
    }
    res[e.direction]++;
    const other = e.direction === 'in' ? p.supplier : p.customer;
    await db.tx(async (q) => {
      const [old] = await q.query<{ id: number; customer_id: number | null; supplier_id: number | null; invoice_id: number | null }>(
        'SELECT id, customer_id, supplier_id, invoice_id FROM e_invoices WHERE uuid = $1',
        [uuid],
      );
      const cancelled = isCancelled(e.status);
      if (old) {
        await q.query('UPDATE e_invoices SET status=$1, cancelled=$2, subtotal=$3, vat_total=$4, total=$5, fetched_at=now() WHERE id=$6', [
          e.status,
          cancelled,
          p.subtotal,
          p.vat,
          p.total,
          old.id,
        ]);
        res.updated++;
        return;
      }
      const before = await q.query<{ c: number; s: number }>('SELECT (SELECT COUNT(*) FROM customers) c, (SELECT COUNT(*) FROM suppliers) s');
      const partyId = await ensureParty(q, e.direction, other);
      let customerId: number | null = e.direction === 'out' ? partyId : null;
      let invoiceId: number | null = null;
      if (e.direction === 'out') {
        const m = await matchLocal(q, p, partyId);
        if (m) {
          invoiceId = m.invoiceId;
          customerId = m.customerId;
          res.matched++;
        }
      }
      await q.query(
        `INSERT INTO e_invoices(uuid, direction, no, date, type, profile, party_tax_id, party_name, currency, fx_rate, subtotal, vat_total, total, status,
                                customer_id, supplier_id, invoice_id, cancelled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [uuid, e.direction, no, p.date, p.type || null, p.profile || null, other.taxId || null, other.name || null, p.currency, p.fxRate, p.subtotal, p.vat, p.total, e.status || null,
          customerId, e.direction === 'in' ? partyId : null, invoiceId, cancelled],
      );
      const after = await q.query<{ c: number; s: number }>('SELECT (SELECT COUNT(*) FROM customers) c, (SELECT COUNT(*) FROM suppliers) s');
      res.newCustomers += after[0].c - before[0].c;
      res.newSuppliers += after[0].s - before[0].s;
      res.new++;
    });
  }
  return res;
}

/** EDM'den tarih aralığını çek ve kaydet (7 günlük parçalarla) */
export async function syncEdm(db: Db, cfg: EdmConfig, from: string, to: string, fetcher?: Fetcher): Promise<SyncResult> {
  const client = new EdmClient(cfg, fetcher);
  await client.login();
  const all: EdmInvoice[] = [];
  try {
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 7 * 864e5)) {
      const a = d.toISOString().slice(0, 10);
      const e = new Date(Math.min(d.getTime() + 6 * 864e5, Date.parse(`${to}T00:00:00Z`))).toISOString().slice(0, 10);
      for (const dir of ['IN', 'OUT'] as const) all.push(...(await client.invoices(dir, a, e)));
    }
  } finally {
    await client.logout();
  }
  const r = await saveInvoices(db, all);
  await db.query(
    `INSERT INTO settings(key, value) VALUES ('edm_last_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ at: new Date().toISOString(), from, to, ...r, errors: r.errors.slice(0, 20) })],
  );
  return r;
}
