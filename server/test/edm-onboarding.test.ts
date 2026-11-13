import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { openDb, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { buildUbl } from '../src/edm/ubl.js';
import { fakeEdm } from './fake-edm.js';

describe('EDM ilk kurulum: geçmiş faturalardan müşteri listesi (Excel)', () => {
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
    await req('PUT', '/api/settings', { companyLegalName: 'Başak Rozet Ltd.', companyTaxId: '5556667778', companyTaxOffice: 'Kadıköy', companyCity: 'İstanbul' });
    await req('PUT', '/api/edm/settings', { enabled: true, env: 'test', username: 'basak', password: 'gizli', senderAlias: 'urn:mail:defaultgb@basak.com', profile: 'TEMELFATURA', allowEarchive: true });
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });
  const req = async <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object): Promise<T> => {
    const r = await app.inject({ method, url, payload, headers: { cookie } });
    if (r.statusCode >= 400) throw Object.assign(new Error(r.body), { status: r.statusCode });
    return r.json() as T;
  };
  let n = 0;
  const past = (taxId: string, name: string, date: string, qty: number, extra: Partial<{ taxOffice: string; city: string; address: string }> = {}) =>
    edm.add(
      buildUbl({
        profile: 'TEMELFATURA',
        uuid: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
        issueDate: date,
        issueTime: '10:00:00',
        notes: [],
        supplier: { taxId: '5556667778', name: 'Başak', city: 'İstanbul' },
        customer: { taxId, name, city: extra.city ?? 'İstanbul', taxOffice: extra.taxOffice, address: extra.address },
        lines: [{ code: 'R-1', name: 'Kedi', qty, unitPrice: 5000, vatRate: 20, net: qty * 5000, vat: qty * 1000 }],
        despatches: [],
      }),
      taxId,
      false,
    );

  async function exportBook() {
    const r = await app.inject({ method: 'GET', url: '/api/edm/onboarding/export?from=2026-01-01&to=2026-11-10', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    return wb;
  }
  const upload = async (wb: ExcelJS.Workbook, step: 'preview' | 'import') =>
    app.inject({ method: 'POST', url: `/api/edm/onboarding/${step}`, headers: { cookie }, payload: { data: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') } });
  const rowOf = (ws: ExcelJS.Worksheet, taxId: string) => {
    let found: ExcelJS.Row | undefined;
    ws.eachRow((r) => {
      if (String(r.getCell(1).value) === taxId) found = r;
    });
    return found!;
  };

  it('dışa aktar → tür işaretle → önizle → içe al: zincir, franchise, tek kafe; açılış bakiyesi; seçili faturalar', async () => {
    past('1234567890', 'Kahve Durağı Gıda A.Ş.', '2026-03-05', 10, { taxOffice: 'Beşiktaş', address: 'Barbaros Blv. 1' });
    past('1234567890', 'Kahve Durağı Gıda A.Ş.', '2026-06-05', 20, { taxOffice: 'Beşiktaş', address: 'Barbaros Blv. 1' });
    past('2223334445', 'KD İzmir Franchise Ltd.', '2026-07-01', 5, { city: 'İzmir' });
    past('11111111111', 'Ayşe Yılmaz', '2026-08-01', 4);
    past('11111111111', 'Ayşe Yılmaz', '2026-10-20', 6);
    past('9998887776', 'Tek Seferlik Ltd.', '2026-09-01', 1);
    const existing = await req('POST', '/api/customers', { name: 'Eski Kafe', kind: 'single', taxId: '7778889990' });
    past('7778889990', 'Eski Kafe Ltd.', '2026-09-15', 2);

    const wb = await exportBook();
    const ws = wb.getWorksheet('Müşteriler')!;
    const fs = wb.getWorksheet('Faturalar')!;
    expect(ws.rowCount).toBe(6); // başlık + 5 firma
    expect(fs.rowCount).toBe(8);
    // Ciroya göre sıralı, ayrıntılar UBL'den
    const kd = rowOf(ws, '1234567890');
    expect(kd.number).toBe(2);
    expect(kd.getCell(2).value).toBe('Kahve Durağı Gıda A.Ş.');
    expect(kd.getCell(4).value).toBe('Tek kafe');
    expect(kd.getCell(7).value).toBe('Beşiktaş');
    expect(kd.getCell(15).value).toBe(2);
    expect(kd.getCell(16).value).toBe(1800);
    expect(rowOf(ws, '7778889990').getCell(19).value).toBe('Var: Eski Kafe');

    // Kullanıcının işaretlemesi
    kd.getCell(3).value = 'Kahve Durağı';
    kd.getCell(4).value = 'Zincir';
    kd.getCell(6).value = 'KD';
    const fr = rowOf(ws, '2223334445');
    fr.getCell(4).value = 'Franchise şube';
    fr.getCell(5).value = 'Kahve Durağı';
    fr.getCell(12).value = 10;
    const ay = rowOf(ws, '11111111111');
    ay.getCell(3).value = 'Limon Kafe';
    ay.getCell(13).value = 1500.5;
    ay.getCell(14).value = '01.10.2026';
    rowOf(ws, '9998887776').getCell(4).value = 'Atla';
    // Mart faturası alınmasın
    fs.eachRow((r, i) => {
      if (i > 1 && r.getCell(3).value === '2026-03-05') r.getCell(8).value = 'Hayır';
    });

    const pv = (await upload(wb, 'preview')).json();
    expect(pv.errors).toEqual([]);
    expect(pv.summary).toMatchObject({ create: 3, existing: 1, skip: 1, chains: 1, singles: 1, branches: 1, invoicesToImport: 5, withOpening: 1 });

    const r = await upload(wb, 'import');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ customersCreated: 3, invoicesImported: 5, invoicesFailed: [] });

    const all = await req<any[]>('GET', '/api/customers?all=1');
    const chain = all.find((c) => c.taxId === '1234567890');
    expect(chain).toMatchObject({ name: 'Kahve Durağı', kind: 'chain', code: 'KD', legalName: 'Kahve Durağı Gıda A.Ş.', taxOffice: 'Beşiktaş' });
    expect(all.find((c) => c.taxId === '2223334445')).toMatchObject({ kind: 'branch', parentId: chain.id, billTo: 'self', paymentDays: 10, city: 'İzmir' });
    const limon = all.find((c) => c.taxId === '11111111111');
    expect(limon).toMatchObject({ name: 'Limon Kafe', kind: 'single', openingBalance: 150050, openingDate: '2026-10-01' });
    expect(all.find((c) => c.taxId === '9998887776')).toBeUndefined();
    expect(all.filter((c) => c.taxId === '7778889990')).toHaveLength(1);
    // Açılış tarihinden önceki fatura bakiyeye girmez: 1500,50 + Ekim faturası 360
    expect((await req('GET', `/api/customers/${limon.id}`)).balance).toBe(150050 + 36000);
    const invs = await req<any[]>('GET', '/api/invoices');
    expect(invs).toHaveLength(5);
    expect(invs.every((i) => i.eSource === 'edm' && i.eUuid)).toBe(true);
    expect(invs.find((i) => i.customerId === existing.id)).toBeTruthy();

    // Aynı dosya ikinci kez: yeni müşteri ve fatura açılmaz
    const again = await upload(wb, 'import');
    expect(again.json()).toMatchObject({ customersCreated: 0, invoicesImported: 0 });
    // Yeni dışa aktarımda içe alınmışlar "Rozet'te" dolu ve Hayır gelir
    const rows: { take: unknown; rozet: unknown }[] = [];
    (await exportBook()).getWorksheet('Faturalar')!.eachRow((r, i) => i > 1 && rows.push({ take: r.getCell(8).value, rozet: r.getCell(9).value }));
    expect(rows.filter((x) => x.rozet)).toHaveLength(5);
    expect(rows.filter((x) => x.rozet).every((x) => x.take === 'Hayır')).toBe(true);
  });

  it('hatalı işaretleme önizlemede gösterilir, içe alma yapılmaz', async () => {
    past('1234567890', 'Kahve Durağı', '2026-05-01', 1);
    past('2223334445', 'KD Franchise', '2026-05-02', 1);
    const wb = await exportBook();
    const ws = wb.getWorksheet('Müşteriler')!;
    rowOf(ws, '2223334445').getCell(4).value = 'Franchise şube'; // zincir yazılmadı
    rowOf(ws, '1234567890').getCell(4).value = 'bilmem';
    const pv = (await upload(wb, 'preview')).json();
    expect(pv.errors.map((e: any) => e.message).join(' | ')).toMatch(/Tür seçilmemiş.*\|.*Bağlı zincir/);
    expect((await upload(wb, 'import')).statusCode).toBe(400);
    expect(await req<any[]>('GET', '/api/customers?all=1')).toHaveLength(0);
  });
});
