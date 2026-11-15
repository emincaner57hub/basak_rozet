import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { parseUbl, type Fetcher } from '../src/edm.js';

/** UBL-TR örnek fatura */
const ubl = (o: { uuid: string; no: string; date: string; type?: string; sup: [string, string]; cus: [string, string]; net: number; vat: number; cur?: string; rate?: number }) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID><cbc:ID>${o.no}</cbc:ID><cbc:UUID>${o.uuid}</cbc:UUID><cbc:IssueDate>${o.date}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${o.type ?? 'SATIS'}</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>${o.cur ?? 'TRY'}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="VKN">${o.sup[0]}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${o.sup[1]}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>Kadıköy</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${o.cus[0].length === 11 ? 'TCKN' : 'VKN'}">${o.cus[0]}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${o.cus[1]}</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  ${o.rate ? `<cac:PricingExchangeRate><cbc:CalculationRate>${o.rate}</cbc:CalculationRate></cac:PricingExchangeRate>` : ''}
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${o.vat.toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="TRY">${o.net.toFixed(2)}</cbc:TaxExclusiveAmount><cbc:PayableAmount currencyID="TRY">${(o.net + o.vat).toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>`;

const OUR = '1291102914';
/** Sahte EDM SOAP sunucusu */
function fakeEdm(invoices: { dir: 'IN' | 'OUT'; ubl: string; uuid: string; no: string; status?: string }[], seen: string[] = []): Fetcher {
  return async (url, init) => {
    if (url.endsWith('?singleWsdl')) {
      return { status: 200, text: async () => `<wsdl:definitions><wsdl:operation name="Login"><soap:operation soapAction="Login" style="document"/></wsdl:operation></wsdl:definitions>` };
    }
    const body = init?.body ?? '';
    seen.push(body);
    const env = (inner: string) => ({ status: 200, text: async () => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>` });
    if (body.includes('LoginRequest')) {
      if (!body.includes('<PASSWORD>dogru</PASSWORD>'))
        return { status: 500, text: async () => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Kullanıcı adı veya şifre hatalı</faultstring></s:Fault></s:Body></s:Envelope>` };
      return env(`<LoginResponse xmlns="http://schemas.i2i.com/ei/wsdl"><SESSION_ID xmlns="">abc-123</SESSION_ID></LoginResponse>`);
    }
    if (body.includes('LogoutRequest')) return env(`<LogoutResponse xmlns="http://schemas.i2i.com/ei/wsdl"><REQUEST_RETURN xmlns=""><RETURN_CODE>0</RETURN_CODE></REQUEST_RETURN></LogoutResponse>`);
    if (body.includes('GetInvoiceRequest')) {
      expect(body).toContain('<SESSION_ID>abc-123</SESSION_ID>');
      const dir = body.includes('<DIRECTION>IN</DIRECTION>') ? 'IN' : 'OUT';
      const from = body.match(/<START_DATE>(\d{4}-\d{2}-\d{2})/)![1];
      const to = body.match(/<END_DATE>(\d{4}-\d{2}-\d{2})/)![1];
      const list = invoices.filter((i) => i.dir === dir && (() => { const d = parseUbl(i.ubl).date; return d >= from && d <= to; })());
      return env(
        `<GetInvoiceResponse xmlns="http://schemas.i2i.com/ei/wsdl">` +
          list
            .map((i) => `<INVOICE xmlns="" ID="${i.no}" UUID="${i.uuid}"><HEADER><STATUS>${i.status ?? 'SUCCEED'}</STATUS><PAYABLE_AMOUNT currencyID="TRY">1</PAYABLE_AMOUNT></HEADER><CONTENT>${Buffer.from(i.ubl).toString('base64')}</CONTENT></INVOICE>`)
            .join('') +
          `</GetInvoiceResponse>`,
      );
    }
    return { status: 500, text: async () => 'bilinmeyen' };
  };
}

describe('EDM e-fatura ve cari', () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let cookie = '';
  const seen: string[] = [];
  const invs = [
    // giden: uygulamada da kesilmiş (eşleşmeli), uygulamada olmayan yeni müşteri, iade
    { dir: 'OUT' as const, uuid: 'U-OUT-1', no: 'BRZ2026000000001', ubl: '' },
    { dir: 'OUT' as const, uuid: 'U-OUT-2', no: 'BRZ2026000000002', ubl: '' },
    { dir: 'OUT' as const, uuid: 'U-OUT-3', no: 'BRZ2026000000003', ubl: '' },
    // gelen: yeni tedarikçi, dövizli, reddedilmiş
    { dir: 'IN' as const, uuid: 'U-IN-1', no: 'ABC2026000000010', ubl: '' },
    { dir: 'IN' as const, uuid: 'U-IN-2', no: 'ABC2026000000011', ubl: '' },
    { dir: 'IN' as const, uuid: 'U-IN-3', no: 'XYZ2026000000001', ubl: '', status: 'REJECTED' },
  ];
  invs[0].ubl = ubl({ uuid: 'u-out-1', no: invs[0].no, date: '2026-11-02', sup: [OUR, 'Başak Rozet'], cus: ['11111111111', 'Limon Kafe'], net: 100, vat: 20 });
  invs[1].ubl = ubl({ uuid: 'u-out-2', no: invs[1].no, date: '2026-11-03', sup: [OUR, 'Başak Rozet'], cus: ['5555555555', 'Yeni Kafe Ltd'], net: 1000, vat: 200 });
  invs[2].ubl = ubl({ uuid: 'u-out-3', no: invs[2].no, date: '2026-11-04', type: 'IADE', sup: [OUR, 'Başak Rozet'], cus: ['5555555555', 'Yeni Kafe Ltd'], net: 100, vat: 20 });
  invs[3].ubl = ubl({ uuid: 'u-in-1', no: invs[3].no, date: '2026-11-02', sup: ['7777777777', 'Ambalaj AŞ'], cus: [OUR, 'Başak Rozet'], net: 500, vat: 100 });
  invs[4].ubl = ubl({ uuid: 'u-in-2', no: invs[4].no, date: '2026-11-05', sup: ['7777777777', 'Ambalaj AŞ'], cus: [OUR, 'Başak Rozet'], net: 10, vat: 2, cur: 'USD', rate: 34.5 });
  invs[5].ubl = ubl({ uuid: 'u-in-3', no: invs[5].no, date: '2026-11-06', sup: ['8888888888', 'Hatalı Firma'], cus: [OUR, 'Başak Rozet'], net: 50, vat: 10 });

  beforeEach(async () => {
    db = await openDb();
    await ensureAdmin(db, 'a@b.c', 'sifre1234');
    process.env.EDM_USER = OUR;
    process.env.EDM_PASSWORD = 'dogru';
    app = buildApp({ db, sessionSecret: 'test', now: () => new Date('2026-11-10T09:00:00Z'), edmFetcher: fakeEdm(invs, seen) });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.c', password: 'sifre1234' } });
    cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  });
  afterEach(async () => {
    delete process.env.EDM_USER;
    delete process.env.EDM_PASSWORD;
    await app.close();
    await db.close();
  });
  const req = async <T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<T> => {
    const r = await app.inject({ method, url, payload, headers: { cookie } });
    if (r.statusCode >= 400) throw Object.assign(new Error(r.body), { status: r.statusCode });
    return r.json() as T;
  };

  it('UBL okunur (döviz TL\'ye, iade türü)', () => {
    const p = parseUbl(invs[4].ubl);
    expect(p).toMatchObject({ no: 'ABC2026000000011', date: '2026-11-05', currency: 'USD', subtotal: 34500, vat: 6900, total: 41400 });
    expect(p.supplier).toMatchObject({ taxId: '7777777777', name: 'Ambalaj AŞ', taxOffice: 'Kadıköy' });
    expect(parseUbl(invs[2].ubl).type).toBe('IADE');
  });

  it('eşitleme: cariler açılır, faturalar cariye yazılır, uygulama faturasıyla eşleşir, düzeltme kaydı', async () => {
    // uygulamada Limon Kafe'ye kesilmiş 120 TL'lik fatura (e-Fatura no boş)
    const lim = await req('POST', '/api/customers', { code: 'LIM', name: 'Limon Kafe', kind: 'single', taxId: '11111111111', paymentDays: 7 });
    const p = await req('POST', '/api/products', { code: 'R-1', name: 'Kedi', listPrice: 10000 });
    await db.query(`INSERT INTO invoices(no, date, customer_id, due_date, subtotal, vat_total, total) VALUES ('FAT-2026-00001', '2026-11-02', $1, '2026-11-09', 10000, 2000, 12000)`, [lim.id]);
    void p;

    const st = await req('GET', '/api/edm/status');
    expect(st).toMatchObject({ configured: true, password: true });
    const r = await req('POST', '/api/edm/sync', { from: '2026-11-01', to: '2026-11-10' });
    expect(r).toMatchObject({ in: 3, out: 3, new: 6, matched: 1, newCustomers: 1, newSuppliers: 2 });
    expect(seen.some((b) => b.includes('<USER_NAME>1291102914</USER_NAME>'))).toBe(true);

    // eşleşen fatura: e-Fatura no yazıldı, cariye bir kez
    const [inv] = await db.query<{ e_invoice_no: string }>(`SELECT e_invoice_no FROM invoices WHERE no = 'FAT-2026-00001'`);
    expect(inv.e_invoice_no).toBe('BRZ2026000000001');
    const limSt = await req('GET', `/api/customers/${lim.id}/statement`);
    expect(limSt.customer.balance).toBe(12000);

    // e-faturadan açılan müşteri: 1200 − 120 iade = 1080 TL
    const [yeni] = await db.query<{ id: number; tax_id: string }>(`SELECT id, tax_id FROM customers WHERE name = 'Yeni Kafe Ltd'`);
    const ySt = await req('GET', `/api/customers/${yeni.id}/statement`);
    expect(ySt.customer.balance).toBe(108000);
    expect(ySt.rows.map((x: any) => x.kind)).toEqual(['einvoice', 'einvoice']);

    // tedarikçi: 600 TL + 414 TL (USD), reddedilen yazılmaz
    const sups = await req<any[]>('GET', '/api/suppliers/balances');
    const amb = sups.find((s) => s.name === 'Ambalaj AŞ');
    expect(amb.balance).toBe(60000 + 41400);
    expect(sups.find((s) => s.name === 'Hatalı Firma').balance).toBe(0);

    // aynı aralık yeniden: çift kayıt yok
    const r2 = await req('POST', '/api/edm/sync', { from: '2026-11-01', to: '2026-11-10' });
    expect(r2).toMatchObject({ new: 0, updated: 6 });
    expect((await req<any[]>('GET', '/api/e-invoices')).length).toBe(6);

    // başlangıç düzeltmesi: tedarikçiye gerçek borcumuz 5.000 TL, müşteri 0
    await req('POST', '/api/adjustments', { supplierId: amb.id, date: '2026-11-10', targetBalance: 500000, note: 'Açılış mutabakatı' });
    expect((await req<any[]>('GET', '/api/suppliers/balances')).find((s) => s.id === amb.id).balance).toBe(500000);
    await req('POST', '/api/adjustments', { customerId: yeni.id, date: '2026-11-10', targetBalance: 0 });
    expect((await req('GET', `/api/customers/${yeni.id}/statement`)).customer.balance).toBe(0);

    // tedarikçi ödemesi
    await req('POST', '/api/supplier-payments', { supplierId: amb.id, date: '2026-11-11', amount: 100000 });
    const sSt = await req('GET', `/api/suppliers/${amb.id}/statement`);
    expect(sSt.supplier.balance).toBe(400000);
    expect(sSt.rows.at(-1)).toMatchObject({ kind: 'payment', debit: 100000, balance: 400000 });
  });

  it('yanlış şifre anlaşılır hata verir', async () => {
    process.env.EDM_PASSWORD = 'yanlis';
    const r = await app.inject({ method: 'POST', url: '/api/edm/sync', payload: { from: '2026-11-01', to: '2026-11-02' }, headers: { cookie } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toContain('şifre hatalı');
  });
});
