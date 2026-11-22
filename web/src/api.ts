/** Sunucu API'si: tipler ve çağrılar. Tutarlar kuruş. */

export type CustomerKind = 'chain' | 'branch' | 'single';
export interface Customer {
  id: number;
  code: string | null;
  name: string;
  kind: CustomerKind;
  parentId: number | null;
  parentName: string | null;
  billTo: 'self' | 'parent';
  legalName: string | null;
  taxId: string | null;
  taxOffice: string | null;
  address: string | null;
  city: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  paymentDays: number;
  openingBalance: number;
  openingDate: string | null;
  note: string | null;
  active: boolean;
  branchCount: number;
  balance: number | null;
  billable: boolean;
}
export type CustomerInput = Omit<Customer, 'id' | 'parentName' | 'branchCount' | 'balance' | 'billable'>;

export interface Product {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'promo';
  category: string | null;
  description: string | null;
  unit: string;
  vatRate: number;
  listPrice: number | null;
  chainId: number | null;
  chainName: string | null;
  minQty: number | null;
  image: string | null;
  active: boolean;
  /** Müşteri portalında (cepten) sipariş verilebilir */
  sellable: boolean;
  avgCost: number | null;
  onHand: number;
  onOrder: number;
  committed: number;
}
export type ProductInput = Omit<Product, 'id' | 'chainName' | 'avgCost' | 'onHand' | 'onOrder' | 'committed'>;

export interface CatalogItem {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'promo';
  category: string | null;
  unit: string;
  vatRate: number;
  listPrice: number | null;
  price: number | null;
  special: boolean;
  onHand: number;
  chainId: number | null;
  image: string | null;
}

export interface Supplier {
  id: number;
  name: string;
  kind: 'china' | 'temu' | 'broker' | 'local' | 'other';
  contact: string | null;
  costType: 'direct' | 'invoice';
  phone: string | null;
  contactName: string | null;
  note: string | null;
  active: boolean;
  lotCount: number;
}

export type CostType = 'freight' | 'customs_duty' | 'import_vat' | 'broker' | 'cargo' | 'other';
export interface LotSummary {
  id: number;
  no: string;
  date: string;
  kind: 'import' | 'temu' | 'local';
  currency: string;
  fxRate: number;
  status: 'ordered' | 'received';
  expectedDate: string | null;
  receivedDate: string | null;
  supplierName: string | null;
  qty: number;
  lineCount: number;
  goods: number;
  extra: number;
  landed: number;
  importVat: number;
}
export interface LotDetail {
  id: number;
  no: string;
  date: string;
  supplierId: number | null;
  supplierName: string | null;
  kind: 'import' | 'temu' | 'local';
  currency: 'USD' | 'CNY' | 'EUR' | 'TRY';
  fxRate: number;
  allocation: 'value' | 'qty';
  status: 'ordered' | 'received';
  expectedDate: string | null;
  receivedDate: string | null;
  note: string | null;
  lines: { id: number; productId: number; code: string; name: string; qty: number; unitPriceFx: number; goods: number; extra: number; unitCost: number }[];
  costs: { id: number; type: CostType; description: string | null; amount: number; supplierId: number | null; supplierName: string | null; date: string | null }[];
  totals: { goods: number; extra: number; importVat: number; landed: number; qty: number };
}
export interface LotInput {
  date: string;
  supplierId: number | null;
  kind: LotDetail['kind'];
  currency: LotDetail['currency'];
  fxRate: number;
  allocation: LotDetail['allocation'];
  expectedDate: string | null;
  note: string | null;
  lines: { productId: number; qty: number; unitPriceFx: number }[];
  costs: { type: CostType; description: string | null; amount: number; supplierId: number | null; date: string | null }[];
}

export type OrderStatus = 'open' | 'partial' | 'shipped' | 'closed' | 'cancelled';
export type Channel = 'panel' | 'phone' | 'whatsapp' | 'email' | 'excel' | 'portal';
export interface OrderSummary {
  id: number;
  no: string;
  date: string;
  channel: Channel;
  cancelled: boolean;
  requestedDate: string | null;
  customerRef: string | null;
  batch: string | null;
  customerId: number;
  customerName: string;
  chainName: string | null;
  qty: number;
  shipped: number;
  total: number;
  status: OrderStatus;
  portalUser: string | null;
  isNew: boolean;
}
export interface PortalUser {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  seePrices: boolean;
  lastLogin: string | null;
  customers: { id: number; name: string; kind: CustomerKind }[];
}
export interface PortalUserInput {
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  seePrices: boolean;
  password?: string | null;
  customerIds: number[];
}
export interface OrderDetail {
  id: number;
  no: string;
  date: string;
  customerId: number;
  customerName: string;
  customerKind: CustomerKind;
  chainName: string | null;
  channel: Channel;
  cancelled: boolean;
  requestedDate: string | null;
  customerRef: string | null;
  note: string | null;
  status: OrderStatus;
  total: number;
  portalUser: string | null;
  portalPhone: string | null;
  lines: { id: number; productId: number; code: string; name: string; kind: 'sale' | 'promo'; vatRate: number; qty: number; unitPrice: number; shipped: number; remaining: number; onHand: number }[];
  dispatches: { id: number; no: string; date: string; cancelled: boolean; invoiceId: number | null; invoiceNo: string | null; qty: number }[];
}
export interface OrderInput {
  customerId: number;
  date: string;
  channel: Channel;
  requestedDate: string | null;
  customerRef: string | null;
  note: string | null;
  lines: { id?: number; productId: number; qty: number; unitPrice?: number | null }[];
}
export interface ImportPreview {
  format: 'long' | 'wide';
  orders: { customerId: number; customerName: string; lines: { productId: number; code: string; name: string; qty: number; unitPrice: number | null }[]; total: number }[];
  errors: { row: number | null; message: string }[];
  rows: number;
}

export interface DispatchSummary {
  id: number;
  no: string;
  date: string;
  cancelled: boolean;
  orderId: number | null;
  orderNo: string | null;
  invoiceId: number | null;
  invoiceNo: string | null;
  customerName: string;
  chainName: string | null;
  billToId: number;
  billToName: string;
  carrier: string | null;
  trackingNo: string | null;
  qty: number;
  promoQty: number;
  total: number;
}
export interface DispatchDetail {
  id: number;
  no: string;
  date: string;
  cancelled: boolean;
  carrier: string | null;
  trackingNo: string | null;
  note: string | null;
  orderId: number | null;
  orderNo: string | null;
  customerRef: string | null;
  invoiceId: number | null;
  invoiceNo: string | null;
  customerId: number;
  customerName: string;
  customerLegalName: string | null;
  customerAddress: string | null;
  customerCity: string | null;
  customerPhone: string | null;
  customerContact: string | null;
  chainName: string | null;
  billToId: number;
  billToName: string;
  billToLegalName: string | null;
  billToTaxId: string | null;
  billToTaxOffice: string | null;
  billToAddress: string | null;
  billToCity: string | null;
  total: number;
  lines: { id: number; productId: number; code: string; name: string; unit: string; vatRate: number; qty: number; unitPrice: number; isPromo: boolean; orderLineId: number | null; unitCost: number | null }[];
}
export interface DispatchInput {
  date: string;
  customerId: number;
  orderId: number | null;
  carrier: string | null;
  trackingNo: string | null;
  note: string | null;
  lines: { productId: number; qty: number; orderLineId?: number | null; unitPrice?: number | null }[];
}

export type InvoiceStatus = 'open' | 'partial' | 'paid' | 'cancelled';
export interface InvoiceSummary {
  id: number;
  no: string;
  date: string;
  dueDate: string;
  subtotal: number;
  vatTotal: number;
  total: number;
  cancelled: boolean;
  eInvoiceNo: string | null;
  customerId: number;
  customerName: string;
  customerKind: CustomerKind;
  dispatchCount: number;
  paid: number;
  remaining: number;
  status: InvoiceStatus;
  daysOverdue: number;
}
export interface InvoiceDetail extends Omit<InvoiceSummary, 'customerKind' | 'dispatchCount'> {
  legalName: string | null;
  taxId: string | null;
  taxOffice: string | null;
  address: string | null;
  city: string | null;
  note: string | null;
  lines: { id: number; productId: number | null; description: string; qty: number; unitPrice: number; vatRate: number; net: number; vat: number; total: number }[];
  dispatches: { id: number; no: string; date: string; customerName: string }[];
}
export interface PendingInvoice {
  customerId: number;
  name: string;
  kind: CustomerKind;
  dispatchCount: number;
  oldest: string;
  net: number;
}

export type PayMethod = 'havale' | 'nakit' | 'kart' | 'cek' | 'diger';
export const PAY_METHOD: Record<PayMethod, string> = { havale: 'Havale / EFT', nakit: 'Nakit', kart: 'Kredi kartı', cek: 'Çek', diger: 'Diğer' };
export interface Payment {
  id: number;
  date: string;
  amount: number;
  method: PayMethod;
  reference: string | null;
  note: string | null;
  customerId: number;
  customerName: string;
}
export interface Statement {
  customer: { id: number; name: string; balance: number };
  opening: number;
  rows: StatementRow[];
}
export interface StatementRow {
  date: string;
  kind: 'opening' | 'invoice' | 'payment' | 'einvoice' | 'adjust';
  ref: string;
  description: string | null;
  debit: number;
  credit: number;
  refId: number | null;
  balance: number;
}
export interface SupplierStatement {
  supplier: { id: number; name: string; taxId: string | null; balance: number };
  opening: number;
  rows: StatementRow[];
}
export interface SupplierBalance {
  id: number;
  name: string;
  kind: Supplier['kind'];
  costType: Supplier['costType'];
  taxId: string | null;
  balance: number;
  invoiceCount: number;
}
export interface EInvoice {
  id: number;
  uuid: string;
  direction: 'in' | 'out';
  no: string;
  date: string;
  type: string | null;
  profile: string | null;
  partyTaxId: string | null;
  partyName: string | null;
  currency: string;
  subtotal: number;
  vatTotal: number;
  total: number;
  status: string | null;
  cancelled: boolean;
  customerId: number | null;
  supplierId: number | null;
  invoiceId: number | null;
  invoiceNo: string | null;
  accountName: string | null;
  source: 'edm' | 'manual';
  saleKind: 'kdvli' | 'faturali' | null;
  note: string | null;
  costType: Supplier['costType'] | null;
}
export interface ManualEntryInput {
  direction: 'in' | 'out';
  date: string;
  no?: string | null;
  customerId?: number | null;
  supplierId?: number | null;
  type: 'SATIS' | 'IADE';
  saleKind?: 'kdvli' | 'faturali' | null;
  subtotal: number;
  vatTotal: number;
  note?: string | null;
}
export interface EdmSyncResult {
  in: number;
  out: number;
  new: number;
  updated: number;
  newCustomers: number;
  newSuppliers: number;
  matched: number;
  errors: string[];
}
export interface EdmStatus {
  configured: boolean;
  user: boolean;
  password: boolean;
  last: (EdmSyncResult & { at: string; from: string; to: string }) | null;
}
export interface PromoExpense {
  id: number;
  date: string;
  description: string;
  amount: number;
  customerId: number;
  customerName: string;
}

export interface Dashboard {
  today: string;
  openOrders: { count: number; units: number };
  pendingInvoice: { customers: number; dispatches: number; net: number };
  month: { revenue: number; cogs: number; promo: number; gross: number };
  stock: { value: number; low: number };
  lotsInTransit: number;
  receivables: { total: number; overdue: number; top: Receivable[] };
  recentOrders: { id: number; no: string; date: string; channel: Channel; customerName: string; chainName: string | null; total: number }[];
}
export interface Receivable {
  id: number;
  name: string;
  kind: CustomerKind;
  balance: number;
  current: number;
  d30: number;
  d60: number;
  d90: number;
  older: number;
  other: number;
  overdue: number;
}
export interface SalesReport {
  from: string;
  to: string;
  group: 'customer' | 'chain' | 'product' | 'month';
  rows: { id: number; label: string; qty: number; revenue: number; cogs: number; gross: number; dispatches: number }[];
}
export interface ProfitRow {
  id: number;
  name: string;
  revenue: number;
  cogs: number;
  promo: number;
  qty: number;
  gross: number;
  net: number;
  margin: number | null;
}
export interface ProfitReport {
  from: string;
  to: string;
  rows: (ProfitRow & { kind: CustomerKind; branches: ProfitRow[] })[];
}
export interface StockRow {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'promo';
  category: string | null;
  minQty: number | null;
  avgCost: number | null;
  onHand: number;
  onOrder: number;
  sold90: number;
}
export interface StockMove {
  id: number;
  date: string;
  qty: number;
  kind: 'lot' | 'dispatch' | 'adjust';
  unitCost: number | null;
  note: string | null;
  lotNo: string | null;
  lotId: number | null;
  supplierName: string | null;
  dispatchNo: string | null;
  dispatchId: number | null;
  customerName: string | null;
  isPromo: boolean | null;
  balance: number;
}
export interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'staff';
  active?: boolean;
}
export type Settings = Record<
  'companyName' | 'companyLegalName' | 'companyTaxId' | 'companyTaxOffice' | 'companyAddress' | 'companyPhone' | 'companyEmail' | 'companyIban' | 'invoiceNote',
  string
>;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !url.startsWith('/api/login')) window.dispatchEvent(new Event('rozet:unauthorized'));
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(data?.error ?? `Hata (${r.status})`, r.status);
  return data as T;
}
const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v != null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};

export const api = {
  session: () => req<{ user: User | null }>('GET', '/api/session'),
  login: (email: string, password: string) => req<{ user: User }>('POST', '/api/login', { email, password }),
  logout: () => req('POST', '/api/logout'),
  changePassword: (current: string, next: string) => req('POST', '/api/me/password', { current, next }),
  users: () => req<User[]>('GET', '/api/users'),
  saveUser: (id: number | null, b: { name: string; email: string; role: User['role']; active: boolean; password?: string }) =>
    req(id ? 'PUT' : 'POST', id ? `/api/users/${id}` : '/api/users', b),
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (b: Partial<Settings>) => req('PUT', '/api/settings', b),
  dashboard: () => req<Dashboard>('GET', '/api/dashboard'),

  customers: (o: { q?: string; all?: boolean } = {}) => req<Customer[]>('GET', `/api/customers${qs({ q: o.q, all: o.all ? '1' : null })}`),
  customer: (id: number) => req<Customer & { branches: Customer[] }>('GET', `/api/customers/${id}`),
  saveCustomer: (id: number | null, b: CustomerInput) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/customers/${id}` : '/api/customers', b),
  deleteCustomer: (id: number) => req('DELETE', `/api/customers/${id}`),
  catalog: (customerId: number) => req<CatalogItem[]>('GET', `/api/customers/${customerId}/catalog`),
  prices: (customerId: number) => req<{ productId: number; code: string; name: string; listPrice: number | null; price: number }[]>('GET', `/api/customers/${customerId}/prices`),
  setPrice: (customerId: number, productId: number, price: number | null) => req('PUT', `/api/customers/${customerId}/prices/${productId}`, { price }),
  statement: (customerId: number, o: { from?: string; to?: string } = {}) => req<Statement>('GET', `/api/customers/${customerId}/statement${qs(o)}`),

  products: (o: { q?: string; all?: boolean; kind?: 'sale' | 'promo' } = {}) => req<Product[]>('GET', `/api/products${qs({ q: o.q, all: o.all ? '1' : null, kind: o.kind })}`),
  setSellable: (id: number, sellable: boolean) => req<{ ok: boolean }>('POST', `/api/products/${id}/sellable`, { sellable }),
  saveProduct: (id: number | null, b: ProductInput) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/products/${id}` : '/api/products', b),
  deleteProduct: (id: number) => req('DELETE', `/api/products/${id}`),
  productMoves: (id: number) => req<StockMove[]>('GET', `/api/products/${id}/moves`),
  adjustStock: (id: number, b: { date: string; counted?: number; qty?: number; unitCost?: number | null; note?: string | null }) =>
    req<{ delta: number }>('POST', `/api/products/${id}/adjust`, b),
  deleteMove: (id: number) => req('DELETE', `/api/stock-moves/${id}`),

  suppliers: () => req<Supplier[]>('GET', '/api/suppliers'),
  supplierBalances: () => req<SupplierBalance[]>('GET', '/api/suppliers/balances'),
  supplierStatement: (id: number, o: { from?: string; to?: string } = {}) => req<SupplierStatement>('GET', `/api/suppliers/${id}/statement${qs(o)}`),
  addSupplierPayment: (b: { supplierId: number; date: string; amount: number; method: PayMethod; reference?: string | null; note?: string | null }) => req<{ id: number }>('POST', '/api/supplier-payments', b),
  deleteSupplierPayment: (id: number) => req('DELETE', `/api/supplier-payments/${id}`),
  paySuppliersBulk: (b: { supplierIds: number[]; method: 'havale' | 'kart'; date: string; note?: string | null }) =>
    req<{ paid: { supplierId: number; name: string; amount: number; paymentId: number }[]; skipped: { supplierId: number; name: string; balance: number }[]; total: number }>(
      'POST', '/api/supplier-payments/bulk', b),
  addAdjustment: (b: { customerId?: number; supplierId?: number; date: string; targetBalance?: number; amount?: number; note?: string | null }) =>
    req<{ id?: number; amount: number }>('POST', '/api/adjustments', b),
  deleteAdjustment: (id: number) => req('DELETE', `/api/adjustments/${id}`),
  eInvoices: (o: { direction?: 'in' | 'out'; from?: string; to?: string; q?: string } = {}) => req<EInvoice[]>('GET', `/api/e-invoices${qs(o)}`),
  edmStatus: () => req<EdmStatus>('GET', '/api/edm/status'),
  saveManualEntry: (id: number | null, b: ManualEntryInput) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/e-invoices/${id}` : '/api/e-invoices', b),
  deleteManualEntry: (id: number) => req('DELETE', `/api/e-invoices/${id}`),
  edmDiag: () => req<Record<string, unknown>>('GET', '/api/edm/diag'),
  edmSync: (from: string, to: string) => req<EdmSyncResult>('POST', '/api/edm/sync', { from, to }),
  saveSupplier: (id: number | null, b: Omit<Supplier, 'id' | 'lotCount'>) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/suppliers/${id}` : '/api/suppliers', b),
  lots: () => req<LotSummary[]>('GET', '/api/lots'),
  lot: (id: number) => req<LotDetail>('GET', `/api/lots/${id}`),
  saveLot: (id: number | null, b: LotInput) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/lots/${id}` : '/api/lots', b),
  receiveLot: (id: number, date: string) => req('POST', `/api/lots/${id}/receive`, { date }),
  unreceiveLot: (id: number) => req('POST', `/api/lots/${id}/unreceive`, {}),
  deleteLot: (id: number) => req('DELETE', `/api/lots/${id}`),

  orders: (o: { status?: 'open' | 'all' | 'portal'; customerId?: number; q?: string } = {}) => req<OrderSummary[]>('GET', `/api/orders${qs(o)}`),
  incomingOrders: () => req<{ count: number }>('GET', '/api/orders/incoming'),
  portalUsers: () => req<PortalUser[]>('GET', '/api/portal-users'),
  savePortalUser: (id: number | null, b: PortalUserInput) => req<{ id: number }>(id ? 'PUT' : 'POST', id ? `/api/portal-users/${id}` : '/api/portal-users', b),
  deletePortalUser: (id: number) => req<{ ok: boolean; deactivated?: boolean }>('DELETE', `/api/portal-users/${id}`),
  order: (id: number) => req<OrderDetail>('GET', `/api/orders/${id}`),
  createOrder: (b: OrderInput) => req<{ id: number; no: string }>('POST', '/api/orders', b),
  updateOrder: (id: number, b: Omit<OrderInput, 'customerId'>) => req('PUT', `/api/orders/${id}`, b),
  closeOrder: (id: number, cancelled: boolean) => req('POST', `/api/orders/${id}/close`, { cancelled }),
  deleteOrder: (id: number) => req('DELETE', `/api/orders/${id}`),
  importPreview: (b: { data: string; chainId?: number | null; customerId?: number | null }) => req<ImportPreview>('POST', '/api/orders/import/preview', b),
  importOrders: (b: { data: string; chainId?: number | null; customerId?: number | null; date: string; requestedDate?: string | null; note?: string | null }) =>
    req<{ batch: string; orders: { id: number; no: string }[] }>('POST', '/api/orders/import', b),
  templateUrl: (chainId?: number | null) => `/api/orders/template${qs({ chainId })}`,

  dispatches: (o: { invoiced?: '0' | '1'; billToId?: number; from?: string; to?: string; q?: string } = {}) => req<DispatchSummary[]>('GET', `/api/dispatches${qs(o)}`),
  dispatch: (id: number) => req<DispatchDetail>('GET', `/api/dispatches/${id}`),
  createDispatch: (b: DispatchInput) => req<{ id: number; no: string }>('POST', '/api/dispatches', b),
  cancelDispatch: (id: number) => req('POST', `/api/dispatches/${id}/cancel`, {}),
  updateShipping: (id: number, b: { carrier: string | null; trackingNo: string | null; note: string | null }) => req('PUT', `/api/dispatches/${id}/shipping`, b),

  pendingInvoices: () => req<PendingInvoice[]>('GET', '/api/invoices/pending'),
  invoices: (o: { customerId?: number; status?: 'open' | 'overdue' | 'all'; from?: string; to?: string } = {}) => req<InvoiceSummary[]>('GET', `/api/invoices${qs(o)}`),
  invoice: (id: number) => req<InvoiceDetail>('GET', `/api/invoices/${id}`),
  createInvoice: (b: { customerId: number; date: string; dispatchIds: number[]; note?: string | null }) => req<{ id: number; no: string; total: number }>('POST', '/api/invoices', b),
  cancelInvoice: (id: number) => req('POST', `/api/invoices/${id}/cancel`, {}),
  updateInvoice: (id: number, b: { eInvoiceNo: string | null; note: string | null; dueDate?: string }) => req('PUT', `/api/invoices/${id}`, b),

  payments: (o: { customerId?: number; from?: string; to?: string } = {}) => req<Payment[]>('GET', `/api/payments${qs(o)}`),
  createPayment: (b: { customerId: number; date: string; amount: number; method: PayMethod; reference: string | null; note: string | null }) => req('POST', '/api/payments', b),
  deletePayment: (id: number) => req('DELETE', `/api/payments/${id}`),
  promoExpenses: (customerId?: number) => req<PromoExpense[]>('GET', `/api/promo-expenses${qs({ customerId })}`),
  createPromoExpense: (b: { customerId: number; date: string; description: string; amount: number }) => req('POST', '/api/promo-expenses', b),
  deletePromoExpense: (id: number) => req('DELETE', `/api/promo-expenses/${id}`),

  salesReport: (o: { from: string; to: string; group: SalesReport['group'] }) => req<SalesReport>('GET', `/api/reports/sales${qs(o)}`),
  profitReport: (o: { from: string; to: string }) => req<ProfitReport>('GET', `/api/reports/profitability${qs(o)}`),
  stockReport: () => req<StockRow[]>('GET', '/api/reports/stock'),
  receivables: () => req<Receivable[]>('GET', '/api/reports/receivables'),
};

export const KIND_LABEL: Record<CustomerKind, string> = { chain: 'Zincir', branch: 'Şube', single: 'Tek kafe' };
export const CHANNEL_LABEL: Record<Channel, string> = { panel: 'Panel', phone: 'Telefon', whatsapp: 'WhatsApp', email: 'E-posta', excel: 'Excel', portal: 'Portal' };
export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  open: { label: 'Açık', tone: 'brand' },
  partial: { label: 'Kısmi sevk', tone: 'warn' },
  shipped: { label: 'Sevk edildi', tone: 'ok' },
  closed: { label: 'Kapandı', tone: 'muted' },
  cancelled: { label: 'İptal', tone: 'muted' },
};
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  open: { label: 'Ödenmedi', tone: 'warn' },
  partial: { label: 'Kısmi ödendi', tone: 'warn' },
  paid: { label: 'Ödendi', tone: 'ok' },
  cancelled: { label: 'İptal', tone: 'muted' },
};
export const COST_LABEL: Record<CostType, string> = {
  freight: 'Navlun',
  customs_duty: 'Gümrük vergisi',
  import_vat: 'İthalat KDV (maliyete girmez)',
  broker: 'Gümrük müşaviri / broker',
  cargo: 'Kargo',
  other: 'Diğer',
};
export const SUPPLIER_KIND: Record<Supplier['kind'], string> = { china: 'Çin tedarikçi', temu: 'Temu / online', broker: 'Gümrük müşaviri', local: 'Yerel', other: 'Diğer' };
export const COST_TYPE_LABEL: Record<Supplier['costType'], string> = { direct: 'Direkt maliyet', invoice: 'Fatura amaçlı' };
export const SALE_KIND_LABEL: Record<'kdvli' | 'faturali', string> = { kdvli: "KDV'li", faturali: 'Faturalı' };
export const LOT_KIND: Record<LotDetail['kind'], string> = { import: 'Çin ithalatı', temu: 'Temu / bavul', local: 'Yerel alım' };
export type Tone = 'brand' | 'ok' | 'warn' | 'bad' | 'muted';
