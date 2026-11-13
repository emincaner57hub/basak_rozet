import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { buildUbl, parseUbl } from '../src/edm/ubl.js';
import { fakeEdm } from './fake-edm.js';

describe('EDM e-Fatura entegrasyonu', () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let cookie = '';
  let edm: ReturnType<typeof fakeEdm>;
  beforeEach(async () => {
    db = await openDb();
    edm = fakeEdm();
    await ensureAdmin(db, 'a@b.c', 'sifre1234');
    app = buildApp({ db, sessionSecret: 'test', now: () => new Date('2026-11-10T09:00:00Z'), edmFetch: edm.fetchFn });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.c', password: 'sifre1234' } });
    cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });
  const req = async <T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<T> => {
    const r = await app.inject({ method, url, payload, headers: { cookie } });
    if (r.statusCode >= 400) throw Object.assign(new Error(r.body), { status: r.statusCode });
    return r.json() as T;
  };

  async function setup() {
    await req('PUT', '/api/settings', { companyLegalName: 'Başak Rozet Ltd. Şti.', companyTaxId: '5556667778', companyTaxOffice: 'Kadıköy', companyAddress: 'Moda Cd. 1', companyDistrict: 'Kadıköy', companyCity: 'İstanbul', companyIban: 'TR12 0001 0000 0000 0000 0000 01' });
    await req('PUT', '/api/edm/settings', { enabled: true, env: 'test', username: 'basak', password: 'gizli', senderAlias: 'urn:mail:defaultgb@basak.com', profile: 'TEMELFATURA', allowEarchive: true });
    const chain = await req('POST', '/api/customers', { code: 'KD', name: 'Kahve Durağı', legalName: 'Kahve Durağı Gıda A.Ş.', kind: 'chain', taxId: '1234567890', taxOffice: 'Beşiktaş', city: 'İstanbul', paymentDays: 30 });
    const moda = await req('POST', '/api/customers', { code: 'KD-1', name: 'Moda', kind: 'branch', parentId: chain.id, billTo: 'parent' });
    const solo = await req('POST', '/api/customers', { code: 'LIM', name: 'Limon Kafe', legalName: 'Ayşe Nur Yılmaz', kind: 'single', taxId: '11111111111', city: 'İzmir', email: 'ayse@limon.com', paymentDays: 7 });
    const a = await req('POST', '/api/products', { code: 'R-1', name: 'Kedi rozet', listPrice: 6000 });
    await req('POST', `/api/products/${a.id}/adjust`, { date: '2026-11-01', qty: 500, unitCost: 2000 });
    const invoiceFor = async (customerId: number, qty: number) => {
      const shipTo = customerId === chain.id ? moda.id : customerId;
      const d = await req('POST', '/api/dispatches', { date: '2026-11-09', customerId: shipTo, lines: [{ productId: a.id, qty }] });
      return req('POST', '/api/invoices', { customerId, date: '2026-11-10', dispatchIds: [d.id] });
    };
    return { chain, solo, a, invoiceFor };
  }

  it('UBL-TR: tutarlar, KDV, TCKN alıcıda kişi adı; okunan XML aynı değerleri verir', () => {
    const xml = buildUbl({
      profile: 'TEMELFATURA',
      uuid: 'AAAA-1',
      issueDate: '2026-11-10',
      issueTime: '12:00:00',
      dueDate: '2026-12-10',
      notes: ['Not & <özel>'],
      supplier: { taxId: '5556667778', name: 'Başak', taxOffice: 'Kadıköy', city: 'İstanbul' },
      customer: { taxId: '11111111111', name: 'Ayşe Nur Yılmaz', city: 'İzmir' },
      lines: [
        { code: 'R-1', name: 'Kedi', qty: 10, unitPrice: 6000, vatRate: 20, net: 60000, vat: 12000 },
        { code: 'R-2', name: 'Kalp', qty: 3, unitPrice: 333, vatRate: 10, net: 999, vat: 100 },
      ],
      despatches: [{ no: 'IRS-2026-00001', date: '2026-11-09' }],
      iban: 'TR12 0001',
    });
    expect(xml).toContain('<cbc:FirstName>Ayşe Nur</cbc:FirstName><cbc:FamilyName>Yılmaz</cbc:FamilyName>');
    expect(xml).toContain('Not &amp; &lt;özel&gt;');
    expect(xml).toContain('<cbc:PayableAmount currencyID="TRY">730.99</cbc:PayableAmount>');
    const p = parseUbl(xml);
    expect(p).toMatchObject({ uuid: 'AAAA-1', subtotal: 60999, vatTotal: 12100, total: 73099, despatches: ['IRS-2026-00001'] });
    expect(p.customer).toMatchObject({ taxId: '11111111111', name: 'Ayşe Nur Yılmaz', city: 'İzmir' });
    expect(p.lines[1]).toMatchObject({ code: 'R-2', qty: 3, unitPrice: 333, vatRate: 10, net: 999, vat: 100, unit: 'C62' });
  });

  it('ayarlar: şifre geri dönmez, yalnız yönetici değiştirir; bağlantı testi etiketleri getirir', async () => {
    await setup();
    const s = await req('GET', '/api/edm/settings');
    expect(s).toMatchObject({ enabled: true, username: 'basak', hasPassword: true });
    expect(JSON.stringify(s)).not.toContain('gizli');
    // Şifre boş gönderilirse eskisi kalır
    await req('PUT', '/api/edm/settings', { enabled: true, env: 'test', username: 'basak', senderAlias: 'urn:mail:defaultgb@basak.com', profile: 'TEMELFATURA', allowEarchive: true });
    const t = await req('POST', '/api/edm/test');
    expect(t.ok).toBe(true);
    // SOAPAction WSDL'den okunur
    expect(edm.calls[0]).toMatchObject({ op: 'Login', action: '"http://tempuri.org/EFaturaEDMPort/Login"' });
    expect(edm.calls.at(-1)!.op).toBe('Logout');
    await req('PUT', '/api/edm/settings', { enabled: true, env: 'test', username: 'basak', password: 'yanlis', senderAlias: 'x', profile: 'TEMELFATURA', allowEarchive: true });
    await expect(req('POST', '/api/edm/test')).rejects.toMatchObject({ status: 502 });
  });

  it("Rozet → EDM: e-Fatura mükellefine e-Fatura, değilse e-Arşiv; no ve durum geri gelir, ikinci gönderim engellenir", async () => {
    const s = await setup();
    const inv1 = await s.invoiceFor(s.chain.id, 10);
    const r1 = await req('POST', `/api/invoices/${inv1.id}/edm/send`);
    expect(r1).toMatchObject({ ok: true, profile: 'TEMELFATURA', eInvoiceNo: 'BSK2026000000001' });
    const send = edm.calls.find((c) => c.op === 'SendInvoice')!;
    expect(send.body).toContain('alias="urn:mail:defaultpk@1234567890.com"');
    const sent = [...edm.store.values()][0];
    const p = parseUbl(sent.xml);
    expect(p).toMatchObject({ profile: 'TEMELFATURA', total: 72000, supplierTaxId: '5556667778' });
    expect(p.customer.name).toBe('Kahve Durağı Gıda A.Ş.');
    expect(p.lines[0]).toMatchObject({ code: 'R-1', name: 'Kedi rozet', qty: 10, unitPrice: 6000 });
    expect(p.despatches).toHaveLength(1);

    let d = await req('GET', `/api/invoices/${inv1.id}`);
    expect(d).toMatchObject({ eInvoiceNo: 'BSK2026000000001', eProfile: 'TEMELFATURA', eStatus: 'PACKAGE - PROCESSING', eError: null });
    expect(d.eUuid).toBe(p.uuid);
    await expect(req('POST', `/api/invoices/${inv1.id}/edm/send`)).rejects.toMatchObject({ status: 400 });
    await req('POST', `/api/invoices/${inv1.id}/edm/status`);
    d = await req('GET', `/api/invoices/${inv1.id}`);
    expect(d.eStatus).toBe('SEND - SUCCEED');

    // Kayıtsız alıcı (TCKN) → e-Arşiv
    const inv2 = await s.invoiceFor(s.solo.id, 2);
    expect(await req('POST', `/api/invoices/${inv2.id}/edm/send`)).toMatchObject({ profile: 'EARSIVFATURA' });
    const e2 = [...edm.store.values()][1];
    expect(e2.earchive).toBe(true);
    expect(e2.xml).toContain('Gönderim Şekli: ELEKTRONIK');
    expect(e2.xml).toContain('<cbc:ID schemeID="TCKN">11111111111</cbc:ID>');
    // e-Arşiv kapalıysa reddedilir, hata faturaya yazılır
    await req('PUT', '/api/edm/settings', { enabled: true, env: 'test', username: 'basak', senderAlias: 'urn:mail:defaultgb@basak.com', profile: 'TEMELFATURA', allowEarchive: false });
    const inv3 = await s.invoiceFor(s.solo.id, 1);
    await expect(req('POST', `/api/invoices/${inv3.id}/edm/send`)).rejects.toMatchObject({ status: 400 });
    expect((await req('GET', `/api/invoices/${inv3.id}`)).eError).toMatch(/e-Arşiv/);
  });

  it('firma bilgisi eksikse göndermez; entegrasyon kapalıysa uyarır', async () => {
    const s = await setup();
    const inv = await s.invoiceFor(s.chain.id, 1);
    await req('PUT', '/api/settings', { companyCity: '' });
    await expect(req('POST', `/api/invoices/${inv.id}/edm/send`)).rejects.toThrow(/il/);
    await req('PUT', '/api/edm/settings', { enabled: false, env: 'test', username: 'basak', senderAlias: 'x', profile: 'TEMELFATURA', allowEarchive: true });
    await expect(req('POST', `/api/invoices/${inv.id}/edm/send`)).rejects.toThrow(/kapalı/);
    expect(edm.calls.filter((c) => c.op === 'SendInvoice')).toHaveLength(0);
  });

  it("EDM → Rozet: listeler, Rozet faturasıyla eşleştirir, portalda kesileni içe alır (müşteri yoksa açar)", async () => {
    const s = await setup();
    const sent = await s.invoiceFor(s.chain.id, 4);
    await req('POST', `/api/invoices/${sent.id}/edm/send`);
    const manual = await s.invoiceFor(s.chain.id, 5); // EDM portalında elle kesilmiş, Rozet'te numarası yok
    const mk = (uuid: string, taxId: string, name: string, qty: number) =>
      buildUbl({
        profile: 'TEMELFATURA',
        id: null,
        uuid,
        issueDate: '2026-11-10',
        issueTime: '10:00:00',
        notes: [],
        supplier: { taxId: '5556667778', name: 'Başak', city: 'İstanbul' },
        customer: { taxId, name, taxOffice: 'Çankaya', city: 'Ankara', address: 'Atatürk Blv. 5' },
        lines: [{ code: 'R-1', name: 'Kedi rozet', qty, unitPrice: 6000, vatRate: 20, net: qty * 6000, vat: qty * 1200 }],
        despatches: [],
      });
    edm.add(mk('C0FFEE00-0000-0000-0000-000000000001', '1234567890', 'Kahve Durağı', 5), '1234567890', false);
    edm.add(mk('C0FFEE00-0000-0000-0000-000000000002', '1112223334', 'Yeni Kafe Ltd.', 3), '1112223334', false);

    const l = await req('GET', '/api/edm/invoices?from=2026-11-01&to=2026-11-10');
    const by = (u: string) => l.invoices.find((x: any) => x.uuid === u);
    const sentUuid = (await req('GET', `/api/invoices/${sent.id}`)).eUuid;
    expect(by(sentUuid)).toMatchObject({ state: 'linked', invoice: { id: sent.id } });
    expect(by('C0FFEE00-0000-0000-0000-000000000001')).toMatchObject({ state: 'candidate', invoice: { id: manual.id }, total: 36000 });
    expect(by('C0FFEE00-0000-0000-0000-000000000002')).toMatchObject({ state: 'new', customer: null, taxId: '1112223334' });
    const getInvoiceCall = edm.calls.find((c) => c.op === 'GetInvoice')!;
    expect(getInvoiceCall.body).toContain('<CR_START_DATE>2026-11-01T00:00:00</CR_START_DATE>');

    const n2 = by('C0FFEE00-0000-0000-0000-000000000002');
    const n1 = by('C0FFEE00-0000-0000-0000-000000000001');
    const r = await req('POST', '/api/edm/import', {
      items: [
        { uuid: n1.uuid, id: n1.id, action: 'link', invoiceId: manual.id },
        { uuid: n2.uuid, id: n2.id, action: 'create' },
      ],
    });
    expect(r.results.every((x: any) => x.ok)).toBe(true);
    expect((await req('GET', `/api/invoices/${manual.id}`)).eInvoiceNo).toBe(n1.id);
    const created = r.results[1];
    expect(created.customerCreated).toBe(true);
    const ci = await req('GET', `/api/invoices/${created.invoiceId}`);
    expect(ci).toMatchObject({ eSource: 'edm', eInvoiceNo: n2.id, total: 21600, subtotal: 18000, legalName: 'Yeni Kafe Ltd.', taxId: '1112223334', dispatches: [] });
    expect(ci.lines[0]).toMatchObject({ description: 'R-1 Kedi rozet', qty: 3, productId: s.a.id });
    // Cariye işlenir
    const cust = await req('GET', `/api/customers/${ci.customerId}`);
    expect(cust.balance).toBe(21600);
    // Tekrar içe alma çift kayıt açmaz
    const again = await req('POST', '/api/edm/import', { items: [{ uuid: n2.uuid, id: n2.id, action: 'create' }] });
    expect(again.results[0]).toMatchObject({ ok: true, message: 'Zaten bağlı', invoiceId: created.invoiceId });
    const l2 = await req('GET', '/api/edm/invoices?from=2026-11-01&to=2026-11-10');
    expect(l2.invoices.every((x: any) => x.state === 'linked')).toBe(true);
  });
});
