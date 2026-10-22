import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { addDays, todayTr } from './db.js';

/**
 * Örnek veri (yalnız boş veritabanında): bir zincir (2 merkeze bağlı şube + 1 franchise), tek kafeler,
 * rozet tasarımları, stand ve etiket, Çin ithalatı ve Temu partisi, birkaç sipariş, irsaliye ve fatura.
 */
export async function seedDemo(db: Db, app: FastifyInstance, email: string, password: string) {
  const [{ n }] = await db.query<{ n: number }>('SELECT COUNT(*) n FROM customers');
  if (n > 0) return;
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const api = async <T = { id: number }>(method: 'POST' | 'PUT', url: string, payload: object): Promise<T> => {
    const r = await app.inject({ method, url, payload, headers: { cookie } });
    if (r.statusCode >= 400) throw new Error(`${url}: ${r.body}`);
    return r.json() as T;
  };
  const today = todayTr();
  const d = (n: number) => addDays(today, n);

  const chain = await api('POST', '/api/customers', {
    code: 'KD', name: 'Kahve Durağı', kind: 'chain', legalName: 'Kahve Durağı Gıda A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy',
    address: 'Bağdat Cad. No:10 Kadıköy', city: 'İstanbul', contactName: 'Elif Demir', phone: '0216 555 10 10', email: 'satinalma@kahveduragi.example', paymentDays: 30,
  });
  const b1 = await api('POST', '/api/customers', { code: 'KD-MDA', name: 'Moda', kind: 'branch', parentId: chain.id, billTo: 'parent', address: 'Moda Cad. 5', city: 'İstanbul' });
  const b2 = await api('POST', '/api/customers', { code: 'KD-BST', name: 'Beşiktaş', kind: 'branch', parentId: chain.id, billTo: 'parent', address: 'Barbaros Blv. 20', city: 'İstanbul' });
  const b3 = await api('POST', '/api/customers', {
    code: 'KD-IZM', name: 'İzmir Alsancak', kind: 'branch', parentId: chain.id, billTo: 'self', legalName: 'Ege Kahve Ltd. Şti.', taxId: '9876543210', taxOffice: 'Konak',
    address: 'Kıbrıs Şehitleri Cad. 40', city: 'İzmir', contactName: 'Mert Yıldız', paymentDays: 15,
  });
  const single = await api('POST', '/api/customers', {
    code: 'LIM', name: 'Limon Kafe', kind: 'single', legalName: 'Ayşe Kaya', taxId: '12345678901', taxOffice: 'Çankaya', address: 'Tunalı Hilmi 33', city: 'Ankara', paymentDays: 7,
  });
  await api('POST', '/api/customers', { code: 'MAV', name: 'Mavi Fincan', kind: 'single', taxId: '5555555555', taxOffice: 'Bornova', city: 'İzmir' });

  const prods: Record<string, number> = {};
  for (const [code, name, cat, price] of [
    ['R-001', 'Kedi ve fincan', 'Hayvanlar', 6500],
    ['R-002', 'Latte art kalp', 'Kahve', 6000],
    ['R-003', 'Kruvasan', 'Yiyecek', 6000],
    ['R-004', 'Uykucu ayı', 'Hayvanlar', 6500],
    ['R-005', 'Çiçekli fincan', 'Kahve', 5500],
    ['R-006', 'Gökkuşağı', 'Klasik', 5000],
  ] as const) {
    prods[code] = (await api('POST', '/api/products', { code, name, category: cat, listPrice: price, minQty: 100 })).id;
  }
  prods['KD-LOGO'] = (await api('POST', '/api/products', { code: 'KD-LOGO', name: 'Kahve Durağı logolu rozet', category: 'Özel', listPrice: 7000, chainId: chain.id })).id;
  prods['STAND'] = (await api('POST', '/api/products', { code: 'STAND', name: 'Tezgâh standı', kind: 'promo', category: 'Promosyon', vatRate: 20 })).id;
  prods['ETIKET'] = (await api('POST', '/api/products', { code: 'ETIKET', name: 'Fiyat etiketi', kind: 'promo', category: 'Promosyon' })).id;
  await api('PUT', `/api/customers/${chain.id}/prices/${prods['R-001']}`, { price: 5800 });
  await api('PUT', `/api/customers/${chain.id}/prices/${prods['R-002']}`, { price: 5400 });

  const china = await api('POST', '/api/suppliers', { name: 'Yiwu Badge Co.', kind: 'china', contact: 'WeChat: yiwubadge' });
  const temu = await api('POST', '/api/suppliers', { name: 'Temu', kind: 'temu' });
  const broker = await api('POST', '/api/suppliers', { name: 'Ekol Gümrük Müşavirliği', kind: 'broker' });
  const lot1 = await api('POST', '/api/lots', {
    date: d(-40), supplierId: china.id, kind: 'import', currency: 'USD', fxRate: 34.2, allocation: 'value',
    lines: [
      { productId: prods['R-001'], qty: 1000, unitPriceFx: 0.32 },
      { productId: prods['R-002'], qty: 1000, unitPriceFx: 0.3 },
      { productId: prods['R-003'], qty: 600, unitPriceFx: 0.3 },
      { productId: prods['R-004'], qty: 600, unitPriceFx: 0.35 },
      { productId: prods['KD-LOGO'], qty: 500, unitPriceFx: 0.4 },
      { productId: prods['STAND'], qty: 30, unitPriceFx: 2.5 },
    ],
    costs: [
      { type: 'freight', description: 'Hava kargo', amount: 850000 },
      { type: 'customs_duty', description: 'Gümrük vergisi', amount: 620000 },
      { type: 'import_vat', description: 'İthalat KDV (indirilecek)', amount: 410000 },
      { type: 'broker', description: 'Müşavirlik ücreti', amount: 350000, supplierId: broker.id },
    ],
  });
  await api('POST', `/api/lots/${lot1.id}/receive`, { date: d(-30) });
  const lot2 = await api('POST', '/api/lots', {
    date: d(-12), supplierId: temu.id, kind: 'temu', currency: 'TRY', fxRate: 1, allocation: 'qty',
    lines: [
      { productId: prods['R-005'], qty: 300, unitPriceFx: 18 },
      { productId: prods['R-006'], qty: 300, unitPriceFx: 15 },
      { productId: prods['ETIKET'], qty: 500, unitPriceFx: 2 },
    ],
    costs: [{ type: 'cargo', description: 'Kargo', amount: 45000 }],
  });
  await api('POST', `/api/lots/${lot2.id}/receive`, { date: d(-8) });
  await api('POST', '/api/lots', {
    date: d(-3), supplierId: china.id, kind: 'import', currency: 'USD', fxRate: 34.6, expectedDate: d(20),
    lines: [{ productId: prods['R-006'], qty: 1500, unitPriceFx: 0.25 }],
  });

  // Siparişler, sevk, fatura, tahsilat
  const o1 = await api<{ id: number }>('POST', '/api/orders', {
    customerId: b1.id, date: d(-25), channel: 'whatsapp',
    lines: [{ productId: prods['R-001'], qty: 120 }, { productId: prods['R-002'], qty: 100 }, { productId: prods['KD-LOGO'], qty: 80 }],
  });
  const o1d = await (await app.inject({ method: 'GET', url: `/api/orders/${o1.id}`, headers: { cookie } })).json();
  const ds1 = await api('POST', '/api/dispatches', {
    date: d(-23), customerId: b1.id, orderId: o1.id, carrier: 'Yurtiçi Kargo',
    lines: [...o1d.lines.map((l: { id: number; productId: number; qty: number }) => ({ productId: l.productId, qty: l.qty, orderLineId: l.id })), { productId: prods['STAND'], qty: 1 }, { productId: prods['ETIKET'], qty: 50 }],
  });
  const o2 = await api('POST', '/api/orders', { customerId: b2.id, date: d(-20), channel: 'phone', lines: [{ productId: prods['R-003'], qty: 60 }, { productId: prods['R-004'], qty: 60 }] });
  const o2d = await (await app.inject({ method: 'GET', url: `/api/orders/${o2.id}`, headers: { cookie } })).json();
  const ds2 = await api('POST', '/api/dispatches', {
    date: d(-18), customerId: b2.id, orderId: o2.id,
    lines: [{ productId: o2d.lines[0].productId, qty: 60, orderLineId: o2d.lines[0].id }, { productId: o2d.lines[1].productId, qty: 30, orderLineId: o2d.lines[1].id }, { productId: prods['STAND'], qty: 1 }],
  });
  await api('POST', '/api/invoices', { customerId: chain.id, date: d(-17), dispatchIds: [ds1.id, ds2.id] });
  await api('POST', '/api/payments', { customerId: chain.id, date: d(-5), amount: 1000000, method: 'havale', reference: 'Garanti EFT' });

  const o3 = await api('POST', '/api/orders', { customerId: b3.id, date: d(-10), channel: 'email', lines: [{ productId: prods['R-002'], qty: 50 }, { productId: prods['R-005'], qty: 40 }] });
  const o3d = await (await app.inject({ method: 'GET', url: `/api/orders/${o3.id}`, headers: { cookie } })).json();
  const ds3 = await api('POST', '/api/dispatches', {
    date: d(-9), customerId: b3.id, orderId: o3.id,
    lines: [...o3d.lines.map((l: { id: number; productId: number; qty: number }) => ({ productId: l.productId, qty: l.qty, orderLineId: l.id })), { productId: prods['STAND'], qty: 1 }],
  });
  await api('POST', '/api/invoices', { customerId: b3.id, date: d(-9), dispatchIds: [ds3.id] });
  await api('POST', '/api/promo-expenses', { customerId: b3.id, date: d(-9), description: 'Özel baskı menü etiketi', amount: 75000 });

  const o4 = await api('POST', '/api/orders', { customerId: single.id, date: d(-4), channel: 'phone', lines: [{ productId: prods['R-006'], qty: 40 }, { productId: prods['R-001'], qty: 30 }] });
  const o4d = await (await app.inject({ method: 'GET', url: `/api/orders/${o4.id}`, headers: { cookie } })).json();
  await api('POST', '/api/dispatches', {
    date: d(-3), customerId: single.id, orderId: o4.id,
    lines: o4d.lines.map((l: { id: number; productId: number; qty: number }) => ({ productId: l.productId, qty: l.qty, orderLineId: l.id })),
  });
  await api('POST', '/api/orders', { customerId: b2.id, date: d(-1), channel: 'panel', lines: [{ productId: prods['R-006'], qty: 80 }, { productId: prods['KD-LOGO'], qty: 50 }] });
  console.log('Örnek veri yüklendi.');
}
