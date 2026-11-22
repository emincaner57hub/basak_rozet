import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { openDb, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';

describe('Başak Rozet akışı', () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let cookie = '';
  let clock = new Date('2026-10-22T09:00:00Z');
  beforeEach(async () => {
    db = await openDb();
    clock = new Date('2026-10-22T09:00:00Z');
    await ensureAdmin(db, 'a@b.c', 'sifre1234');
    app = buildApp({ db, sessionSecret: 'test', now: () => clock });
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
    const chain = await req('POST', '/api/customers', { code: 'KD', name: 'Kahve Durağı', kind: 'chain', taxId: '1234567890', paymentDays: 30 });
    const moda = await req('POST', '/api/customers', { code: 'KD-1', name: 'Moda', kind: 'branch', parentId: chain.id, billTo: 'parent' });
    const izmir = await req('POST', '/api/customers', { code: 'KD-2', name: 'İzmir', kind: 'branch', parentId: chain.id, billTo: 'self', taxId: '9876543210', paymentDays: 10 });
    const solo = await req('POST', '/api/customers', { code: 'LIM', name: 'Limon Kafe', kind: 'single', taxId: '11111111111', paymentDays: 7 });
    const a = await req('POST', '/api/products', { code: 'R-1', name: 'Kedi', listPrice: 6000 });
    const b = await req('POST', '/api/products', { code: 'R-2', name: 'Kalp', listPrice: 5000 });
    const logo = await req('POST', '/api/products', { code: 'KD-L', name: 'Logolu', listPrice: 7000, chainId: chain.id });
    const stand = await req('POST', '/api/products', { code: 'STAND', name: 'Stand', kind: 'promo' });
    return { chain, moda, izmir, solo, a, b, logo, stand };
  }

  it('müşteri portalı: satın almacı kodu, atanan şubeler, sipariş ve gelen siparişler', async () => {
    const s = await setup();
    await req('PUT', `/api/customers/${s.chain.id}/prices/${s.a.id}`, { price: 5500 });
    // zincire atanan satın almacı → tüm şubeleri; tek kafe ayrıca
    const pu = await req('POST', '/api/portal-users', { code: 'Ayse.KD', name: 'Ayşe', password: 'portal123', customerIds: [s.chain.id] });
    await expect(req('POST', '/api/portal-users', { code: 'ayse.kd', name: 'X', password: 'portal123' })).rejects.toMatchObject({ status: 409 });
    const anon = await app.inject({ method: 'GET', url: '/api/portal/orders' });
    expect(anon.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/portal/login', payload: { code: 'ayse.kd', password: 'yanlis' } })).statusCode).toBe(401);
    const lr = await app.inject({ method: 'POST', url: '/api/portal/login', payload: { code: 'AYSE.KD', password: 'portal123' } });
    expect(lr.statusCode).toBe(200);
    const pc = lr.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const preq = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const r = await app.inject({ method, url, payload, headers: { cookie: pc } });
      return { status: r.statusCode, body: r.json() as any };
    };
    // portal çerezi ekip API'sini açmaz
    expect((await app.inject({ method: 'GET', url: '/api/customers', headers: { cookie: pc } })).statusCode).toBe(401);
    const ses = (await preq('GET', '/api/portal/session')).body;
    expect(ses.user.name).toBe('Ayşe');
    expect(ses.customers.map((c: any) => c.name).sort()).toEqual(['Moda', 'İzmir'].sort());
    const cat = (await preq('GET', `/api/portal/catalog?customerId=${s.moda.id}`)).body;
    expect(cat.find((p: any) => p.code === 'R-1').price).toBe(5500);
    expect(cat.find((p: any) => p.code === 'STAND')).toBeUndefined(); // promosyon portalda yok
    expect(cat[0].onHand).toBeUndefined(); // stok gösterilmez
    expect((await preq('GET', `/api/portal/catalog?customerId=${s.solo.id}`)).status).toBe(403);
    const o = await preq('POST', '/api/portal/orders', { customerId: s.moda.id, requestedDate: '2026-10-25', note: 'acil', lines: [{ productId: s.a.id, qty: 10 }, { productId: s.logo.id, qty: 2 }] });
    expect(o.status).toBe(200);
    expect((await preq('POST', '/api/portal/orders', { customerId: s.solo.id, lines: [{ productId: s.a.id, qty: 1 }] })).status).toBe(403);
    const mine = (await preq('GET', '/api/portal/orders')).body;
    expect(mine[0]).toMatchObject({ no: o.body.no, customerName: 'Moda', status: 'open', total: 10 * 5500 + 2 * 7000, byName: 'Ayşe' });
    // Ekip: gelen siparişler
    expect((await req('GET', '/api/orders/incoming')).count).toBe(1);
    const inc = await req('GET', '/api/orders?status=all&portal=1');
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ channel: 'portal', portalUser: 'Ayşe', isNew: true });
    const d = await req('GET', `/api/orders/${o.body.id}`);
    expect(d.portalUser).toBe('Ayşe');
    expect((await req('GET', '/api/orders/incoming')).count).toBe(0); // açıldı → görüldü
    // Satılabilir işareti kalkan ürün portalda yok, sipariş verilemez; fiyatı olmayan görünür ama sipariş verilemez
    await req('POST', `/api/products/${s.b.id}/sellable`, { sellable: false });
    const cat2 = (await preq('GET', `/api/portal/catalog?customerId=${s.moda.id}`)).body;
    expect(cat2.find((p: any) => p.code === 'R-2')).toBeUndefined();
    expect((await preq('POST', '/api/portal/orders', { customerId: s.moda.id, lines: [{ productId: s.b.id, qty: 1 }] })).status).toBe(400);
    const np = await req('POST', '/api/products', { code: 'R-9', name: 'Fiyatsız' });
    expect((await preq('GET', `/api/portal/catalog?customerId=${s.moda.id}`)).body.find((p: any) => p.code === 'R-9')).toMatchObject({ price: null });
    expect((await preq('POST', '/api/portal/orders', { customerId: s.moda.id, lines: [{ productId: np.id, qty: 1 }] })).status).toBe(400);
    expect((await req<any[]>('GET', '/api/products')).find((p) => p.id === s.b.id).sellable).toBe(false);
    // Fiyat görebilir kapalı: katalogda ve siparişlerde fiyat yok, sipariş yine verilebilir
    await req('PUT', `/api/portal-users/${pu.id}`, { code: 'ayse.kd', name: 'Ayşe', seePrices: false, customerIds: [s.chain.id] });
    const cat3 = (await preq('GET', `/api/portal/catalog?customerId=${s.moda.id}`)).body;
    expect(cat3.find((p: any) => p.code === 'R-1')).toMatchObject({ price: null, orderable: true, special: false });
    expect((await preq('GET', '/api/portal/session')).body.user.seePrices).toBe(false);
    expect((await preq('GET', '/api/portal/orders')).body[0].total).toBeNull();
    expect((await preq('GET', `/api/portal/orders/${o.body.id}`)).body.lines[0].unitPrice).toBeNull();
    expect((await preq('POST', '/api/portal/orders', { customerId: s.moda.id, lines: [{ productId: s.a.id, qty: 3 }] })).status).toBe(200);
    expect((await req<any[]>('GET', '/api/portal-users')).find((x) => x.id === pu.id).seePrices).toBe(false);
    // kullanıcı pasif → giriş yok
    await req('PUT', `/api/portal-users/${pu.id}`, { code: 'ayse.kd', name: 'Ayşe', active: false, customerIds: [s.chain.id] });
    expect((await preq('GET', '/api/portal/orders')).status).toBe(401);
    // siparişi olan kullanıcı silinmez, pasifleşir
    expect((await req('DELETE', `/api/portal-users/${pu.id}`)).deactivated).toBe(true);
  });

  it('giriş olmadan API kapalı', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/customers' });
    expect(r.statusCode).toBe(401);
  });

  it('müşteri indirimi: siparişte fiyata uygulanır; 0 ise yok; şube zincirin indirimini alır', async () => {
    const s = await setup();
    // 0 → indirim yok
    let o = await req('POST', '/api/orders', { customerId: s.solo.id, date: '2026-10-22', lines: [{ productId: s.a.id, qty: 2 }] });
    expect((await req('GET', `/api/orders/${o.id}`)).lines[0].unitPrice).toBe(6000);
    // tek kafeye %10
    const solo = await req('GET', `/api/customers/${s.solo.id}`);
    await req('PUT', `/api/customers/${s.solo.id}`, { ...solo, discount: 10 });
    expect((await req('GET', `/api/customers/${s.solo.id}`)).discount).toBe(10);
    o = await req('POST', '/api/orders', { customerId: s.solo.id, date: '2026-10-22', lines: [{ productId: s.a.id, qty: 2 }, { productId: s.stand.id, qty: 1 }] });
    const d = await req('GET', `/api/orders/${o.id}`);
    expect(d.lines.map((l: any) => l.unitPrice)).toEqual([5400, 0]); // promosyon 0 kalır
    expect(d.total).toBe(10800);
    // zincire %12,5 ve özel fiyat → şube (kendi indirimi 0) zincirinkini alır, özel fiyatın üstüne
    const chain = await req('GET', `/api/customers/${s.chain.id}`);
    await req('PUT', `/api/customers/${s.chain.id}`, { ...chain, discount: 12.5 });
    await req('PUT', `/api/customers/${s.chain.id}/prices/${s.b.id}`, { price: 4000 });
    const cat = await req('GET', `/api/customers/${s.moda.id}/catalog`);
    expect(cat.find((p: any) => p.code === 'R-2')).toMatchObject({ basePrice: 4000, price: 3500, discount: 12.5 });
    // şubenin kendi indirimi zincirinkini ezer
    const izmir = await req('GET', `/api/customers/${s.izmir.id}`);
    await req('PUT', `/api/customers/${s.izmir.id}`, { ...izmir, discount: 5 });
    expect((await req('GET', `/api/customers/${s.izmir.id}`)).parentDiscount).toBe(12.5);
    expect((await req('GET', `/api/customers/${s.izmir.id}/catalog`)).find((p: any) => p.code === 'R-1').price).toBe(5700);
    // elle girilen fiyat olduğu gibi kalır; irsaliye → fatura indirimli fiyatla
    o = await req('POST', '/api/orders', { customerId: s.moda.id, date: '2026-10-22', lines: [{ productId: s.a.id, qty: 1 }, { productId: s.b.id, qty: 1, unitPrice: 4100 }] });
    expect((await req('GET', `/api/orders/${o.id}`)).lines.map((l: any) => l.unitPrice)).toEqual([5250, 4100]);
    await expect(req('PUT', `/api/customers/${s.solo.id}`, { ...solo, discount: 100 })).rejects.toMatchObject({ status: 400 });
  });

  it('sipariş listesi: tarih aralığı, durum süzgeci, toplamlar ve toplu teslim', async () => {
    const s = await setup();
    await req('POST', `/api/products/${s.a.id}/adjust`, { date: '2026-09-01', qty: 500, unitCost: 2000 });
    const mk = (date: string, qty: number, customerId = s.solo.id) => req('POST', '/api/orders', { customerId, date, lines: [{ productId: s.a.id, qty }] });
    const o1 = await mk('2026-09-10', 10); // sevk → teslim
    const o2 = await mk('2026-10-05', 20); // sevk
    const o3 = await mk('2026-10-06', 30); // açık
    const o4 = await mk('2026-10-07', 40); // iptal
    const o5 = await mk('2026-10-08', 50); // 20 sevk, kalanı kapatıldı
    const ship = async (o: { id: number }, qty: number) => {
      const d = await req('GET', `/api/orders/${o.id}`);
      await req('POST', '/api/dispatches', { date: '2026-10-09', customerId: s.solo.id, orderId: o.id, lines: [{ productId: s.a.id, qty, orderLineId: d.lines[0].id }] });
    };
    await ship(o1, 10);
    await ship(o2, 20);
    await ship(o5, 20);
    await req('POST', `/api/orders/${o4.id}/close`, {});
    await req('POST', `/api/orders/${o5.id}/close`, {});

    // açık sipariş teslim edilemez; hiçbir şey değişmez
    await expect(req('POST', '/api/orders/deliver', { ids: [o1.id, o3.id] })).rejects.toMatchObject({ status: 400 });
    expect((await req('GET', `/api/orders/${o1.id}`)).status).toBe('shipped');
    expect((await req('POST', '/api/orders/deliver', { ids: [o1.id, o5.id] })).count).toBe(2);
    expect(await req('GET', `/api/orders/${o1.id}`)).toMatchObject({ status: 'delivered', deliveredAt: '2026-10-22' });

    const st = async (qs: string) => (await req('GET', `/api/orders?${qs}`)).map((o: any) => o.no);
    expect(await st('status=delivered')).toHaveLength(2);
    expect(await st('status=shipped')).toEqual([o2.no]);
    expect(await st('status=pending')).toEqual([o3.no]);
    expect(await st('status=all&from=2026-10-01&to=2026-10-06')).toEqual([o3.no, o2.no]);
    expect((await req('GET', '/api/orders?status=all')).find((o: any) => o.id === o2.id)).toMatchObject({ deliverable: true });

    // toplam: iptal 0, kalanı kapatılan yalnız sevk edilen kısım
    expect(await req('GET', '/api/orders/summary?status=all&from=2026-10-01&to=2026-10-31')).toEqual({ count: 4, qty: 20 + 30 + 0 + 20, total: 70 * 6000 });
    expect(await req('GET', '/api/orders/summary?status=delivered')).toEqual({ count: 2, qty: 30, total: 30 * 6000 });

    await req('POST', `/api/orders/${o1.id}/undeliver`, {});
    expect((await req('GET', `/api/orders/${o1.id}`)).status).toBe('shipped');
  });

  it('müşteri ağacı, özel fiyat ve zincire özel ürün', async () => {
    const s = await setup();
    await expect(req('POST', '/api/customers', { name: 'Yetim şube', kind: 'branch' })).rejects.toMatchObject({ status: 400 });
    await expect(req('POST', '/api/customers', { name: 'X', kind: 'branch', parentId: s.solo.id })).rejects.toMatchObject({ status: 400 });
    await req('PUT', `/api/customers/${s.chain.id}/prices/${s.a.id}`, { price: 5500 });
    const cat = await req('GET', `/api/customers/${s.moda.id}/catalog`);
    expect(cat.find((p: any) => p.code === 'R-1')).toMatchObject({ price: 5500, special: true });
    expect(cat.find((p: any) => p.code === 'KD-L')).toBeTruthy();
    // Şubeye özel fiyat zincirinkinden önce gelir
    await req('PUT', `/api/customers/${s.moda.id}/prices/${s.a.id}`, { price: 5200 });
    expect((await req('GET', `/api/customers/${s.moda.id}/catalog`)).find((p: any) => p.code === 'R-1').price).toBe(5200);
    expect((await req('GET', `/api/customers/${s.izmir.id}/catalog`)).find((p: any) => p.code === 'R-1').price).toBe(5500);
    // Başka müşteri zincire özel ürünü görmez
    expect((await req('GET', `/api/customers/${s.solo.id}/catalog`)).find((p: any) => p.code === 'KD-L')).toBeUndefined();
    await expect(req('POST', '/api/orders', { customerId: s.solo.id, date: '2026-10-22', lines: [{ productId: s.logo.id, qty: 5 }] })).rejects.toMatchObject({ status: 400 });
    // Siparişi zincirin kendisine girmek yasak (sevk adresi şubedir)
    await expect(req('POST', '/api/orders', { customerId: s.chain.id, date: '2026-10-22', lines: [{ productId: s.a.id, qty: 5 }] })).rejects.toMatchObject({ status: 400 });
  });

  it('parti maliyeti: kur, masraf dağıtımı, ithalat KDV hariç; sonradan gelen masraf satılanın maliyetini de günceller', async () => {
    const s = await setup();
    const lot = await req('POST', '/api/lots', {
      date: '2026-09-01', currency: 'USD', fxRate: 30, allocation: 'value',
      lines: [
        { productId: s.a.id, qty: 100, unitPriceFx: 1 }, // 3.000 ₺
        { productId: s.b.id, qty: 100, unitPriceFx: 0.5 }, // 1.500 ₺
      ],
      costs: [
        { type: 'customs_duty', amount: 90000 }, // 900 ₺
        { type: 'import_vat', amount: 50000 }, // maliyete girmez
      ],
    });
    let d = await req('GET', `/api/lots/${lot.id}`);
    expect(d.totals).toMatchObject({ goods: 450000, extra: 90000, importVat: 50000, landed: 540000, qty: 200 });
    expect(d.lines[0].unitCost).toBeCloseTo(3600); // (3000 + 600) / 100 ₺ → kuruş
    expect(d.lines[1].unitCost).toBeCloseTo(1800);
    let prods = await req('GET', '/api/products');
    expect(prods.find((p: any) => p.code === 'R-1')).toMatchObject({ onHand: 0, onOrder: 100 });

    await req('POST', `/api/lots/${lot.id}/receive`, { date: '2026-09-10' });
    prods = await req('GET', '/api/products');
    expect(prods.find((p: any) => p.code === 'R-1')).toMatchObject({ onHand: 100, onOrder: 0, avgCost: 3600 });

    const ds = await req('POST', '/api/dispatches', { date: '2026-09-15', customerId: s.solo.id, lines: [{ productId: s.a.id, qty: 10 }] });
    let det = await req('GET', `/api/dispatches/${ds.id}`);
    expect(det.lines[0]).toMatchObject({ unitPrice: 6000, unitCost: 3600 });

    // Broker faturası sonradan: 600 ₺ daha → R-1 birim maliyeti 3.600 + 400 = 4.000
    await req('PUT', `/api/lots/${lot.id}`, {
      date: '2026-09-01', currency: 'USD', fxRate: 30, allocation: 'value',
      lines: [
        { productId: s.a.id, qty: 100, unitPriceFx: 1 },
        { productId: s.b.id, qty: 100, unitPriceFx: 0.5 },
      ],
      costs: [{ type: 'customs_duty', amount: 90000 }, { type: 'broker', amount: 60000 }],
    });
    det = await req('GET', `/api/dispatches/${ds.id}`);
    expect(det.lines[0].unitCost).toBeCloseTo(4000);
    prods = await req('GET', '/api/products');
    expect(prods.find((p: any) => p.code === 'R-1')).toMatchObject({ onHand: 90 });
    expect(prods.find((p: any) => p.code === 'R-1').avgCost).toBeCloseTo(4000);

    // Teslim alınmış parti silinemez; sayım farkı
    await expect(req('DELETE', `/api/lots/${lot.id}`)).rejects.toMatchObject({ status: 400 });
    expect((await req('POST', `/api/products/${s.a.id}/adjust`, { date: '2026-09-20', counted: 88 })).delta).toBe(-2);
    expect((await req('GET', `/api/products/${s.a.id}/moves`))[0]).toMatchObject({ kind: 'adjust', qty: -2, balance: 88 });
  });

  it('sipariş → kısmi sevk + promosyon → fatura merkeze; franchise kendi faturası; tahsilat FIFO ve vade', async () => {
    const s = await setup();
    await req('POST', `/api/products/${s.a.id}/adjust`, { date: '2026-10-01', qty: 500, unitCost: 2000 });
    await req('POST', `/api/products/${s.b.id}/adjust`, { date: '2026-10-01', qty: 500, unitCost: 1500 });
    await req('POST', `/api/products/${s.stand.id}/adjust`, { date: '2026-10-01', qty: 10, unitCost: 15000 });

    const o = await req('POST', '/api/orders', { customerId: s.moda.id, date: '2026-10-02', channel: 'whatsapp', lines: [{ productId: s.a.id, qty: 100 }, { productId: s.b.id, qty: 50 }] });
    let od = await req('GET', `/api/orders/${o.id}`);
    expect(od).toMatchObject({ status: 'open', total: 100 * 6000 + 50 * 5000 });
    const [la, lb] = od.lines;
    await expect(
      req('POST', '/api/dispatches', { date: '2026-10-03', customerId: s.moda.id, orderId: o.id, lines: [{ productId: s.a.id, qty: 101, orderLineId: la.id }] }),
    ).rejects.toMatchObject({ status: 400 });
    const d1 = await req('POST', '/api/dispatches', {
      date: '2026-10-03', customerId: s.moda.id, orderId: o.id,
      lines: [{ productId: s.a.id, qty: 100, orderLineId: la.id }, { productId: s.b.id, qty: 20, orderLineId: lb.id }, { productId: s.stand.id, qty: 1 }],
    });
    od = await req('GET', `/api/orders/${o.id}`);
    expect(od.status).toBe('partial');
    expect(od.lines[1]).toMatchObject({ shipped: 20, remaining: 30 });
    const dd = await req('GET', `/api/dispatches/${d1.id}`);
    expect(dd).toMatchObject({ billToId: s.chain.id, total: 100 * 6000 + 20 * 5000 });
    expect(dd.lines.find((l: any) => l.isPromo)).toMatchObject({ unitPrice: 0, unitCost: 15000 });

    // Faturayı şubeye kesmek yasak; zincire kesilir, promosyon faturaya girmez
    await expect(req('POST', '/api/invoices', { customerId: s.moda.id, date: '2026-10-05', dispatchIds: [d1.id] })).rejects.toMatchObject({ status: 400 });
    expect((await req('GET', '/api/invoices/pending'))[0]).toMatchObject({ customerId: s.chain.id, dispatchCount: 1 });
    const inv = await req('POST', '/api/invoices', { customerId: s.chain.id, date: '2026-10-05', dispatchIds: [d1.id] });
    const id = await req('GET', `/api/invoices/${inv.id}`);
    expect(id).toMatchObject({ subtotal: 700000, vatTotal: 140000, total: 840000, dueDate: '2026-11-04', status: 'open' });
    expect(id.lines).toHaveLength(2);
    await expect(req('POST', `/api/dispatches/${d1.id}/cancel`)).rejects.toMatchObject({ status: 400 });

    // Kalan sevk → sipariş tamamlanır
    await req('POST', '/api/dispatches', { date: '2026-10-06', customerId: s.moda.id, orderId: o.id, lines: [{ productId: s.b.id, qty: 30, orderLineId: lb.id }] });
    expect((await req('GET', `/api/orders/${o.id}`)).status).toBe('shipped');

    // Franchise kendi carisi
    const d3 = await req('POST', '/api/dispatches', { date: '2026-10-06', customerId: s.izmir.id, lines: [{ productId: s.a.id, qty: 10 }] });
    expect((await req('GET', `/api/dispatches/${d3.id}`)).billToId).toBe(s.izmir.id);
    const inv2 = await req('POST', '/api/invoices', { customerId: s.izmir.id, date: '2026-10-06', dispatchIds: [d3.id] });
    expect(inv2.total).toBe(72000);
    await expect(req('POST', '/api/payments', { customerId: s.moda.id, date: '2026-10-10', amount: 1000 })).rejects.toMatchObject({ status: 400 });

    // Tahsilat: 500.000 → fatura kısmi; vade geçince gecikmiş
    await req('POST', '/api/payments', { customerId: s.chain.id, date: '2026-10-10', amount: 500000, reference: 'EFT' });
    let list = await req('GET', `/api/invoices?customerId=${s.chain.id}`);
    expect(list[0]).toMatchObject({ paid: 500000, remaining: 340000, status: 'partial', daysOverdue: 0 });
    clock = new Date('2026-11-20T09:00:00Z');
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@b.c', password: 'sifre1234' } });
    cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    list = await req('GET', '/api/invoices?status=overdue');
    expect(list).toHaveLength(2);
    expect(list.find((x: any) => x.id === inv.id).daysOverdue).toBe(16);
    const rec = await req('GET', '/api/reports/receivables');
    expect(rec.find((r: any) => r.id === s.chain.id)).toMatchObject({ balance: 340000, d30: 340000, overdue: 340000 });
    const st = await req('GET', `/api/customers/${s.chain.id}/statement`);
    expect(st.rows.map((r: any) => r.balance)).toEqual([840000, 340000]);

    // Kârlılık: zincir = Moda; promosyon maliyeti düşülür
    const pr = await req('GET', '/api/reports/profitability?from=2026-10-01&to=2026-10-31');
    const kd = pr.rows.find((r: any) => r.id === s.chain.id);
    expect(kd.branches.find((b: any) => b.id === s.moda.id)).toMatchObject({ revenue: 850000, cogs: 100 * 2000 + 50 * 1500, promo: 15000 });
    expect(kd.revenue).toBe(850000 + 60000);

    // Fatura iptali irsaliyeleri serbest bırakır
    await req('POST', `/api/invoices/${inv.id}/cancel`);
    expect((await req('GET', `/api/dispatches/${d1.id}`)).invoiceId).toBeNull();
  });

  it('Excel: geniş tablo (şube × ürün) ve uzun liste; şablon geri okunur', async () => {
    const s = await setup();
    const tpl = await app.inject({ method: 'GET', url: `/api/orders/template?chainId=${s.chain.id}`, headers: { cookie } });
    expect(tpl.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Sipariş')!;

    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(['Şube kodu', 'Şube', 'KD-L', 'R-1', 'R-2']);
    // Doldur: Moda 10 × R-1, İzmir 5 × KD-L + 3 × R-2
    const rowOf = (code: string) => [2, 3].find((r) => ws.getRow(r).getCell(1).value === code)!;
    ws.getRow(rowOf('KD-1')).getCell(4).value = 10;
    ws.getRow(rowOf('KD-2')).getCell(3).value = 5;
    ws.getRow(rowOf('KD-2')).getCell(5).value = 3;
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const prev = await req('POST', '/api/orders/import/preview', { data, chainId: s.chain.id });
    expect(prev.format).toBe('wide');
    expect(prev.errors).toEqual([]);
    expect(prev.orders.map((o: any) => [o.customerName, o.lines.map((l: any) => `${l.code}:${l.qty}`).join(',')])).toEqual([
      ['Kahve Durağı · İzmir', 'KD-L:5,R-2:3'],
      ['Kahve Durağı · Moda', 'R-1:10'],
    ]);
    const done = await req('POST', '/api/orders/import', { data, chainId: s.chain.id, date: '2026-10-22' });
    expect(done.orders).toHaveLength(2);
    const orders = await req('GET', '/api/orders');
    expect(orders.filter((o: any) => o.channel === 'excel')).toHaveLength(2);

    // Uzun liste: müşteri adı + ürün + adet; bilinmeyenler hata olarak listelenir
    const wb2 = new ExcelJS.Workbook();
    const w2 = wb2.addWorksheet('a');
    w2.addRow(['Şube', 'Ürün kodu', 'Adet']);
    w2.addRow(['Moda', 'R-2', 7]);
    w2.addRow(['Limon Kafe', 'R-1', 4]);
    w2.addRow(['Yok Kafe', 'R-1', 1]);
    w2.addRow(['Moda', 'X-99', 2]);
    const d2 = Buffer.from(await wb2.xlsx.writeBuffer()).toString('base64');
    const p2 = await req('POST', '/api/orders/import/preview', { data: d2 });
    expect(p2.format).toBe('long');
    expect(p2.orders).toHaveLength(2);
    expect(p2.errors.map((e: any) => e.row)).toEqual([4, 5]);
    await expect(req('POST', '/api/orders/import', { data: d2 })).rejects.toMatchObject({ status: 400 });
  });
});
