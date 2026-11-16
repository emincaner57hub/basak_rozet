import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

/**
 * Veritabanı katmanı.
 * - Üretim (Render): DATABASE_URL ile gerçek PostgreSQL (`pg`).
 * - Yerel geliştirme ve testler: DATABASE_URL yoksa PGlite — WASM içinde çalışan gerçek
 *   PostgreSQL. Bilgisayara Postgres kurmak gerekmez; aynı SQL her iki ortamda da çalışır.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

// bigint (COUNT/SUM), numeric → number; date → 'YYYY-MM-DD' metni
const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const toNum = (v: string) => (v === null ? null : Number(v));

/**
 * Veritabanını açar ve migration'ları çalıştırır.
 * schema: PostgreSQL'de bu bağlantının çalışacağı şema (işletme başına ayrı şema).
 * migrations: verilmezse işletme şeması; kontrol veritabanı kendi listesini verir.
 */
export async function openDb(opts: { url?: string; dataDir?: string; schema?: string; migrations?: string[] } = {}): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url, opts.schema) : await openPglite(opts.dataDir);
  try {
    await migrate(db, opts.migrations ?? MIGRATIONS);
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}

async function openPostgres(url: string, schema?: string): Promise<Db> {
  pg.types.setTypeParser(INT8, toNum);
  pg.types.setTypeParser(NUMERIC, toNum);
  pg.types.setTypeParser(DATE, (v: string) => v);
  // Render dış bağlantı adresi SSL ister; iç adres (aynı bölge) istemez.
  const needsSsl = /render\.com|sslmode=require/.test(url) || process.env.PGSSL === '1';
  const ssl = needsSsl ? { rejectUnauthorized: false } : undefined;
  if (schema && schema !== 'public') {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Geçersiz şema adı');
    const c = new pg.Client({ connectionString: url, ssl });
    await c.connect();
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    } finally {
      await c.end();
    }
  }
  // Her bağlantı yalnız kendi şemasını görür (işletmeler birbirinin tablosuna erişemez)
  const pool = new pg.Pool({
    connectionString: url,
    ssl,
    max: schema && schema !== 'public' ? 4 : 10,
    options: schema && schema !== 'public' ? `-c search_path=${schema}` : undefined,
  });
  return {
    kind: 'postgres',
    async query(sql, params) {
      return (await pool.query(sql, params as unknown[])).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (s, p) => (await client.query(s, p as unknown[])).rows });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const lite = new PGlite({ dataDir, parsers: { [INT8]: toNum, [NUMERIC]: toNum, [DATE]: (v: string) => v } });
  await lite.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) {
      return (await lite.query(sql, params as unknown[])).rows as never[];
    },
    tx(fn) {
      return lite.transaction((t) => fn({ query: async (s, p) => (await t.query(s, p as unknown[])).rows as never[] }));
    },
    close: () => lite.close(),
  };
}

// ---------- Şema (sıralı migration'lar; yalnız sona ekleme yapılır) ----------
const MIGRATIONS: string[] = [
  // 1 — Temel şema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','staff')),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Müşteriler: zincir (merkez) → şubeler; tek kafeler zincirsiz.
  -- Şube faturayı merkeze (bill_to = parent) ya da kendisine (franchise, bill_to = self) keser.
  CREATE TABLE customers (
    id              SERIAL PRIMARY KEY,
    code            TEXT UNIQUE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('chain','branch','single')),
    parent_id       INTEGER REFERENCES customers(id),
    bill_to         TEXT NOT NULL DEFAULT 'self' CHECK (bill_to IN ('self','parent')),
    legal_name      TEXT,
    tax_id          TEXT,
    tax_office      TEXT,
    address         TEXT,
    city            TEXT,
    contact_name    TEXT,
    phone           TEXT,
    email           TEXT,
    payment_days    INTEGER NOT NULL DEFAULT 30 CHECK (payment_days BETWEEN 0 AND 365),
    opening_balance INTEGER NOT NULL DEFAULT 0,          -- kuruş; + müşteri bize borçlu
    opening_date    DATE,
    note            TEXT,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'branch') = (parent_id IS NOT NULL)),
    CHECK (kind = 'branch' OR bill_to = 'self')
  );
  CREATE INDEX customers_parent ON customers(parent_id);

  CREATE TABLE suppliers (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'china' CHECK (kind IN ('china','temu','broker','local','other')),
    contact    TEXT,
    note       TEXT,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Ürünler: sale = satılan rozet; promo = stand, etiket gibi satılmayan, müşteriye verilen malzeme
  CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','promo')),
    category    TEXT,
    description TEXT,
    unit        TEXT NOT NULL DEFAULT 'adet',
    vat_rate    NUMERIC(5,2) NOT NULL DEFAULT 20,
    list_price  INTEGER CHECK (list_price IS NULL OR list_price >= 0),   -- kuruş, KDV hariç
    chain_id    INTEGER REFERENCES customers(id),                         -- zincire özel tasarım
    min_qty     INTEGER CHECK (min_qty IS NULL OR min_qty >= 0),
    image       TEXT,                                                     -- küçük görsel (data URL)
    avg_cost    NUMERIC(16,4),                                            -- hareketli ortalama maliyet (kuruş)
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Özel fiyat: zincire (tüm şubeleri) ya da tek kafeye
  CREATE TABLE prices (
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price       INTEGER NOT NULL CHECK (price >= 0),
    PRIMARY KEY (customer_id, product_id)
  );

  -- Alım partisi: Çin ithalatı, Temu / bavul, yerel alım
  CREATE TABLE lots (
    id            SERIAL PRIMARY KEY,
    no            TEXT NOT NULL UNIQUE,
    date          DATE NOT NULL,
    supplier_id   INTEGER REFERENCES suppliers(id),
    kind          TEXT NOT NULL DEFAULT 'import' CHECK (kind IN ('import','temu','local')),
    currency      TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','CNY','EUR','TRY')),
    fx_rate       NUMERIC(12,4) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    allocation    TEXT NOT NULL DEFAULT 'value' CHECK (allocation IN ('value','qty')),
    status        TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','received')),
    expected_date DATE,
    received_date DATE,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE lot_lines (
    id            SERIAL PRIMARY KEY,
    lot_id        INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products(id),
    qty           INTEGER NOT NULL CHECK (qty > 0),
    unit_price_fx NUMERIC(14,4) NOT NULL CHECK (unit_price_fx >= 0)
  );
  -- Partinin masrafları (TL): navlun, gümrük vergisi, broker, kargo… import_vat maliyete girmez (indirilir)
  CREATE TABLE lot_costs (
    id          SERIAL PRIMARY KEY,
    lot_id      INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('freight','customs_duty','import_vat','broker','cargo','other')),
    description TEXT,
    amount      INTEGER NOT NULL CHECK (amount >= 0),
    supplier_id INTEGER REFERENCES suppliers(id),
    date        DATE
  );

  -- Siparişler (sevk adresi = customer_id: şube ya da tek kafe)
  CREATE TABLE orders (
    id             SERIAL PRIMARY KEY,
    no             TEXT NOT NULL UNIQUE,
    date           DATE NOT NULL,
    customer_id    INTEGER NOT NULL REFERENCES customers(id),
    channel        TEXT NOT NULL DEFAULT 'panel' CHECK (channel IN ('panel','phone','whatsapp','email','excel','portal')),
    cancelled      BOOLEAN NOT NULL DEFAULT FALSE,
    requested_date DATE,
    customer_ref   TEXT,
    note           TEXT,
    batch          TEXT,                       -- aynı Excel'den gelen siparişler
    created_by     INTEGER REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX orders_customer ON orders(customer_id);
  CREATE TABLE order_lines (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty        INTEGER NOT NULL CHECK (qty > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),     -- kuruş, KDV hariç
    sort       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE invoices (
    id          SERIAL PRIMARY KEY,
    no          TEXT NOT NULL UNIQUE,
    date        DATE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),   -- fatura kesilen (ödeyen)
    due_date    DATE NOT NULL,
    subtotal    INTEGER NOT NULL,
    vat_total   INTEGER NOT NULL,
    total       INTEGER NOT NULL,
    cancelled   BOOLEAN NOT NULL DEFAULT FALSE,
    e_invoice_no TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX invoices_customer ON invoices(customer_id);
  CREATE TABLE invoice_lines (
    id          SERIAL PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id  INTEGER REFERENCES products(id),
    description TEXT NOT NULL,
    qty         INTEGER NOT NULL,
    unit_price  INTEGER NOT NULL,
    vat_rate    NUMERIC(5,2) NOT NULL,
    net         INTEGER NOT NULL,
    vat         INTEGER NOT NULL,
    total       INTEGER NOT NULL
  );

  -- İrsaliye (sevk): sevk edilen yer customer_id, faturanın kesileceği bill_to_id
  CREATE TABLE dispatches (
    id          SERIAL PRIMARY KEY,
    no          TEXT NOT NULL UNIQUE,
    date        DATE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    bill_to_id  INTEGER NOT NULL REFERENCES customers(id),
    order_id    INTEGER REFERENCES orders(id),
    cancelled   BOOLEAN NOT NULL DEFAULT FALSE,
    carrier     TEXT,
    tracking_no TEXT,
    note        TEXT,
    invoice_id  INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX dispatches_bill_to ON dispatches(bill_to_id);
  CREATE TABLE dispatch_lines (
    id            SERIAL PRIMARY KEY,
    dispatch_id   INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products(id),
    order_line_id INTEGER REFERENCES order_lines(id),
    qty           INTEGER NOT NULL CHECK (qty > 0),
    unit_price    INTEGER NOT NULL DEFAULT 0,          -- promo satırında 0
    is_promo      BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE INDEX dispatch_lines_order_line ON dispatch_lines(order_line_id);

  -- Stok hareketleri: + giriş (parti, sayım), − çıkış (irsaliye, sayım). unit_cost: ortalama maliyet (kuruş)
  CREATE TABLE stock_moves (
    id               SERIAL PRIMARY KEY,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    date             DATE NOT NULL,
    qty              INTEGER NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('lot','dispatch','adjust')),
    lot_line_id      INTEGER REFERENCES lot_lines(id) ON DELETE CASCADE,
    dispatch_line_id INTEGER REFERENCES dispatch_lines(id) ON DELETE CASCADE,
    unit_cost        NUMERIC(16,4),
    fixed_cost       BOOLEAN NOT NULL DEFAULT FALSE,     -- girişte maliyet elle/partiden verildi
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX stock_moves_product ON stock_moves(product_id, date, id);

  CREATE TABLE payments (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    date        DATE NOT NULL,
    amount      INTEGER NOT NULL CHECK (amount > 0),
    method      TEXT NOT NULL DEFAULT 'havale' CHECK (method IN ('havale','nakit','kart','cek','diger')),
    reference   TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX payments_customer ON payments(customer_id);

  -- Müşteriye yapılan pazarlama gideri (stoktan çıkmayan: özel etiket baskısı, stand üretimi…)
  CREATE TABLE promo_expenses (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    date        DATE NOT NULL,
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
  // 2 — e-Fatura (EDM) ve cari: tedarikçi carisi, tedarikçi ödemeleri, cari düzeltme kayıtları
  `
  ALTER TABLE suppliers ADD COLUMN tax_id TEXT;
  ALTER TABLE suppliers ADD COLUMN tax_office TEXT;
  ALTER TABLE suppliers ADD COLUMN opening_balance INTEGER NOT NULL DEFAULT 0;  -- kuruş; + biz tedarikçiye borçluyuz
  ALTER TABLE suppliers ADD COLUMN opening_date DATE;
  CREATE INDEX suppliers_tax_id ON suppliers(tax_id);
  CREATE INDEX customers_tax_id ON customers(tax_id);

  -- EDM'den gelen (in: alış, tedarikçi) ve giden (out: satış, müşteri) e-faturalar
  CREATE TABLE e_invoices (
    id           SERIAL PRIMARY KEY,
    uuid         TEXT NOT NULL UNIQUE,                    -- ETTN
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    no           TEXT NOT NULL,
    date         DATE NOT NULL,
    type         TEXT,                                    -- SATIS, IADE, TEVKIFAT…
    profile      TEXT,                                    -- TEMELFATURA, TICARIFATURA, EARSIVFATURA…
    party_tax_id TEXT,
    party_name   TEXT,
    currency     TEXT NOT NULL DEFAULT 'TRY',
    fx_rate      NUMERIC(14,6),
    subtotal     INTEGER NOT NULL DEFAULT 0,              -- kuruş, TL
    vat_total    INTEGER NOT NULL DEFAULT 0,
    total        INTEGER NOT NULL,                        -- ödenecek tutar, TL kuruş (iade: yine pozitif)
    status       TEXT,
    customer_id  INTEGER REFERENCES customers(id),
    supplier_id  INTEGER REFERENCES suppliers(id),
    invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,   -- uygulamada kesilmiş fatura ile eşleşti (cariye bir kez)
    cancelled    BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX e_invoices_customer ON e_invoices(customer_id);
  CREATE INDEX e_invoices_supplier ON e_invoices(supplier_id);
  CREATE INDEX e_invoices_date ON e_invoices(date);

  CREATE TABLE supplier_payments (
    id          SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    date        DATE NOT NULL,
    amount      INTEGER NOT NULL CHECK (amount > 0),
    method      TEXT NOT NULL DEFAULT 'havale' CHECK (method IN ('havale','nakit','kart','cek','diger')),
    reference   TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX supplier_payments_supplier ON supplier_payments(supplier_id);

  -- Cari düzeltme: kullanmaya başlarken o anki borç / alacağı oturtmak için (ya da sonradan düzeltme)
  -- amount: + müşteri için bize borcu artırır; tedarikçi için bizim borcumuzu artırır
  CREATE TABLE cari_adjustments (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    date        DATE NOT NULL,
    amount      INTEGER NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((customer_id IS NULL) <> (supplier_id IS NULL))
  );
  `,
  // 3 — Tedarikçi türü / telefon / yetkili; elle girilen alış-satış kayıtları ve satış türü
  `
  ALTER TABLE suppliers ADD COLUMN cost_type TEXT NOT NULL DEFAULT 'direct' CHECK (cost_type IN ('direct','invoice'));  -- direkt maliyet / fatura amaçlı
  ALTER TABLE suppliers ADD COLUMN phone TEXT;
  ALTER TABLE suppliers ADD COLUMN contact_name TEXT;
  ALTER TABLE e_invoices ADD COLUMN source TEXT NOT NULL DEFAULT 'edm' CHECK (source IN ('edm','manual'));
  ALTER TABLE e_invoices ADD COLUMN sale_kind TEXT CHECK (sale_kind IN ('kdvli','faturali'));          -- satış: KDV'li / faturalı
  ALTER TABLE e_invoices ADD COLUMN note TEXT;
  UPDATE e_invoices SET sale_kind = 'faturali' WHERE direction = 'out';
  `,
  // 4 — Müşteri portalı: satın almacı kullanıcıları (kod + şifre), atandıkları zincir / şube / tek kafe; portal siparişleri
  `
  CREATE TABLE portal_users (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,           -- giriş kodu (küçük harf)
    name          TEXT NOT NULL,
    phone         TEXT,
    email         TEXT,
    password_hash TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE portal_user_customers (
    user_id     INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, customer_id)
  );
  ALTER TABLE orders ADD COLUMN portal_user_id INTEGER REFERENCES portal_users(id);
  ALTER TABLE orders ADD COLUMN seen_at TIMESTAMPTZ;   -- portal siparişini ekipten biri açtı
  `,
  // 5 — Satılabilir: yalnız işaretli ürünler müşteri portalında sipariş verilebilir (mevcut satış ürünleri işaretli başlar)
  `
  ALTER TABLE products ADD COLUMN sellable BOOLEAN NOT NULL DEFAULT TRUE;
  UPDATE products SET sellable = FALSE WHERE kind = 'promo';
  `,
];

async function migrate(db: Db, MIGRATIONS: string[]) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (q) => {
      // Aynı anda iki sunucu açılırsa migration'ı yalnız biri çalıştırsın
      await q.query('SELECT pg_advisory_xact_lock(727001)');
      const again = await q.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (again.length) return;
      for (const stmt of splitSql(MIGRATIONS[i])) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    });
  }
}

function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Ayarlar ----------
export async function getSetting(q: Queryable, key: string, fallback: string): Promise<string> {
  const rows = await q.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(q: Queryable, key: string, value: string) {
  await q.query('INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
}

/** Bugünün tarihi (Europe/Istanbul), YYYY-MM-DD */
export function todayTr(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(iso: string, n: number): string {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
