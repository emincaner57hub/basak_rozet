import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { addDays, getSetting, setSetting, todayTr } from './db.js';
import { daySchema, fail, idParam, nextNo, type Row } from './lib.js';
import { EDM_URLS, EdmClient, EdmError, statusTone, type EdmInvoiceHeader, type FetchFn } from './edm/soap.js';
import { buildUbl, parseUbl, type UblInvoice } from './edm/ubl.js';

/**
 * EDM e-Fatura entegrasyonu:
 *  - Rozet → EDM: kesilen faturayı UBL-TR olarak gönderir (alıcı e-Fatura kayıtlıysa e-Fatura, değilse e-Arşiv),
 *    EDM'nin verdiği fatura no + ETTN + durum geri yazılır.
 *  - EDM → Rozet: EDM'de oluşturulmuş giden faturaları listeler; Rozet'teki faturayla eşleştirir ya da
 *    irsaliyesiz fatura olarak içe alır (cariye işler, stoğa dokunmaz).
 * Bağlantı bilgileri Ayarlar'dan (yalnız yönetici) ya da EDM_USERNAME / EDM_PASSWORD / EDM_URL ortam değişkenlerinden.
 */

type User = { id: number; role: 'admin' | 'staff' } | null;

interface EdmSettings {
  enabled: boolean;
  env: 'test' | 'prod';
  url: string;
  username: string;
  password: string;
  senderAlias: string;
  profile: 'TEMELFATURA' | 'TICARIFATURA';
  allowEarchive: boolean;
}

async function loadSettings(q: Queryable): Promise<EdmSettings> {
  const g = (k: string, d = '') => getSetting(q, `edm_${k}`, d);
  const env = (await g('env', 'test')) === 'prod' ? 'prod' : 'test';
  return {
    enabled: (await g('enabled', '0')) === '1',
    env,
    url: process.env.EDM_URL || (await g('url')) || EDM_URLS[env],
    username: process.env.EDM_USERNAME || (await g('username')),
    password: process.env.EDM_PASSWORD || (await g('password')),
    senderAlias: await g('sender_alias'),
    profile: (await g('profile', 'TEMELFATURA')) === 'TICARIFATURA' ? 'TICARIFATURA' : 'TEMELFATURA',
    allowEarchive: (await g('earchive', '1')) === '1',
  };
}

const company = async (q: Queryable) => {
  const s = (k: string) => getSetting(q, `s_${k}`, '');
  return {
    name: (await s('companyLegalName')) || (await s('companyName')),
    taxId: (await s('companyTaxId')).replace(/\s/g, ''),
    taxOffice: await s('companyTaxOffice'),
    address: await s('companyAddress'),
    district: await s('companyDistrict'),
    city: await s('companyCity'),
    phone: await s('companyPhone'),
    email: await s('companyEmail'),
    iban: await s('companyIban'),
    note: await s('invoiceNote'),
  };
};

/** İstanbul saatiyle SS:DD:ss */
const timeTr = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(/^24/, '00');

const asBad = (e: unknown) => (e instanceof EdmError ? fail(502, e.message) : e);

export function registerEdm(app: FastifyInstance, { db, now, currentUser, fetchFn }: { db: Db; now: () => Date; currentUser: (req: object) => User; fetchFn?: FetchFn }) {
  const today = () => todayTr(now());

  async function client() {
    const s = await loadSettings(db);
    if (!s.enabled) throw fail(400, 'EDM entegrasyonu kapalı. Ayarlar → EDM e-Fatura bölümünden açın.');
    if (!s.username || !s.password) throw fail(400, 'EDM kullanıcı adı / şifresi girilmemiş (Ayarlar → EDM e-Fatura)');
    return { s, c: new EdmClient({ url: s.url, username: s.username, password: s.password }, fetchFn) };
  }

  const admin = (req: object) => {
    if (currentUser(req)?.role !== 'admin') throw fail(403, 'Bu işlem için yönetici olmalısınız');
  };

  // ---------- Ayarlar ----------
  app.get('/api/edm/settings', async () => {
    const s = await loadSettings(db);
    return {
      enabled: s.enabled,
      env: s.env,
      url: (await getSetting(db, 'edm_url', '')) || '',
      effectiveUrl: s.url,
      username: s.username,
      hasPassword: !!s.password,
      senderAlias: s.senderAlias,
      profile: s.profile,
      allowEarchive: s.allowEarchive,
      fromEnv: { username: !!process.env.EDM_USERNAME, password: !!process.env.EDM_PASSWORD, url: !!process.env.EDM_URL },
    };
  });

  app.put('/api/edm/settings', async (req) => {
    admin(req);
    const b = z
      .object({
        enabled: z.boolean(),
        env: z.enum(['test', 'prod']),
        url: z.string().trim().max(300).refine((v) => !v || /^https:\/\//.test(v), 'Adres https:// ile başlamalı').default(''),
        username: z.string().trim().max(120).default(''),
        password: z.string().max(200).optional(), // boş/undefined: değiştirme
        senderAlias: z.string().trim().max(200).default(''),
        profile: z.enum(['TEMELFATURA', 'TICARIFATURA']),
        allowEarchive: z.boolean(),
      })
      .parse(req.body);
    await setSetting(db, 'edm_enabled', b.enabled ? '1' : '0');
    await setSetting(db, 'edm_env', b.env);
    await setSetting(db, 'edm_url', b.url);
    await setSetting(db, 'edm_username', b.username);
    if (b.password) await setSetting(db, 'edm_password', b.password);
    await setSetting(db, 'edm_sender_alias', b.senderAlias);
    await setSetting(db, 'edm_profile', b.profile);
    await setSetting(db, 'edm_earchive', b.allowEarchive ? '1' : '0');
    return { ok: true };
  });

  /** Bağlantı testi: giriş + firmanın e-Fatura etiketleri */
  app.post('/api/edm/test', async (req) => {
    admin(req);
    const { c } = await client();
    const co = await company(db);
    try {
      return await c.withSession(async (cl) => {
        const users = co.taxId ? await cl.checkUser(co.taxId) : [];
        return { ok: true, company: co.taxId || null, aliases: users };
      });
    } catch (e) {
      throw asBad(e);
    }
  });

  // ---------- Rozet → EDM ----------
  async function saveStatus(q: Queryable, id: number, h: Partial<EdmInvoiceHeader>) {
    await q.query(
      `UPDATE invoices SET e_status = COALESCE(NULLIF($1,''), e_status), e_status_desc = COALESCE(NULLIF($2,''), e_status_desc),
         e_invoice_no = COALESCE(NULLIF($3,''), e_invoice_no), e_error = NULL WHERE id = $4`,
      [h.status ?? '', [h.statusDescription, h.responseDescription].filter(Boolean).join(' · '), h.id ?? '', id],
    );
  }

  app.post('/api/invoices/:id/edm/send', async (req) => {
    const id = idParam(req.params);
    const { s, c } = await client();
    const [inv] = await db.query<Row & { no: string; date: string; due_date: string; cancelled: boolean; note: string | null; e_uuid: string | null; e_status: string | null; customer_id: number }>(
      'SELECT id, no, date, due_date, cancelled, note, e_uuid, e_status, customer_id FROM invoices WHERE id = $1',
      [id],
    );
    if (!inv) throw fail(404, 'Fatura bulunamadı');
    if (inv.cancelled) throw fail(400, 'İptal edilmiş fatura gönderilemez');
    const tone = statusTone(inv.e_status);
    if (inv.e_uuid && (tone === 'ok' || tone === 'wait')) throw fail(400, "Bu fatura EDM'ye zaten gönderildi; durumunu yenileyin");

    const co = await company(db);
    const missing = [!co.taxId && 'vergi no', !co.name && 'ünvan', !co.taxOffice && 'vergi dairesi', !co.city && 'il'].filter(Boolean);
    if (missing.length) throw fail(400, `Ayarlar → Firma bilgilerinde eksik: ${missing.join(', ')}`);
    if (!s.senderAlias) throw fail(400, 'Gönderici etiketi (GB) girilmemiş: Ayarlar → EDM e-Fatura → "Bağlantıyı test et" ile bulabilirsiniz');

    const [cu] = await db.query<{ name: string; legal_name: string | null; tax_id: string | null; tax_office: string | null; address: string | null; city: string | null; phone: string | null; email: string | null }>(
      'SELECT name, legal_name, tax_id, tax_office, address, city, phone, email FROM customers WHERE id = $1',
      [inv.customer_id],
    );
    const taxId = (cu.tax_id ?? '').replace(/\s/g, '');
    if (!/^\d{10,11}$/.test(taxId)) throw fail(400, `${cu.name}: vergi no 10 (VKN) ya da 11 (TCKN) haneli olmalı`);
    const lines = await db.query<{ description: string; qty: number; unit_price: number; vat_rate: number; net: number; vat: number; code: string | null; unit: string | null }>(
      `SELECT l.description, l.qty, l.unit_price, l.vat_rate, l.net, l.vat, p.code, p.unit
       FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = $1 ORDER BY l.id`,
      [id],
    );
    const despatches = await db.query<{ no: string; date: string }>('SELECT no, date FROM dispatches WHERE invoice_id = $1 ORDER BY date, id', [id]);

    // Önceki deneme zaman aşımına uğradıysa aynı ETTN ile EDM'de var mı bakılır; hatalıysa yeni ETTN
    let uuid = inv.e_uuid && tone === 'none' ? inv.e_uuid : crypto.randomUUID().toUpperCase();
    try {
      return await c.withSession(async (cl) => {
        if (inv.e_uuid && tone === 'none') {
          const prev = await cl.getInvoiceStatus(inv.e_uuid).catch(() => null);
          if (prev && statusTone(prev.status) !== 'bad') {
            await saveStatus(db, id, prev);
            return { ok: true, already: true, eInvoiceNo: prev.id, status: prev.status };
          }
          if (prev) uuid = crypto.randomUUID().toUpperCase();
        }
        const pk = (await cl.checkUser(taxId)).filter((u) => !u.unit || u.unit === 'PK');
        const earchive = pk.length === 0;
        if (earchive && !s.allowEarchive) throw fail(400, `${cu.name} e-Fatura mükellefi değil; e-Arşiv gönderimi ayarlarda kapalı`);
        const profile: UblInvoice['profile'] = earchive ? 'EARSIVFATURA' : s.profile;
        let xml: string;
        try {
          xml = buildUbl({
            profile,
            uuid,
            issueDate: inv.date,
            issueTime: timeTr(now()),
            dueDate: inv.due_date,
            notes: [inv.note, `Rozet no: ${inv.no}`, co.note].filter((x): x is string => !!x),
            supplier: { taxId: co.taxId, name: co.name, taxOffice: co.taxOffice, address: co.address, district: co.district, city: co.city, phone: co.phone, email: co.email },
            customer: { taxId, name: cu.legal_name || cu.name, taxOffice: cu.tax_office, address: cu.address, city: cu.city, phone: cu.phone, email: cu.email },
            lines: lines.map((l) => ({ code: l.code, name: l.code && l.description.startsWith(`${l.code} `) ? l.description.slice(l.code.length + 1) : l.description, qty: l.qty, unit: l.unit, unitPrice: l.unit_price, vatRate: Number(l.vat_rate), net: l.net, vat: l.vat })),
            despatches,
            iban: co.iban,
          });
        } catch (e) {
          throw fail(400, (e as Error).message);
        }
        // Gönderimden önce ETTN kaydedilir: bağlantı koparsa tekrar gönderimde çift fatura oluşmaz
        await db.query('UPDATE invoices SET e_uuid = $1, e_profile = $2, e_status = NULL, e_status_desc = NULL, e_error = NULL, e_sent_at = now() WHERE id = $3', [uuid, profile, id]);
        const r = await cl.sendInvoice({ senderVkn: co.taxId, senderAlias: s.senderAlias, receiverVkn: taxId, receiverAlias: earchive ? null : pk[0].alias, content: xml, earchive, receiverEmail: cu.email });
        await saveStatus(db, id, { ...r, status: r.status || 'SEND - PROCESSING' });
        return { ok: true, eInvoiceNo: r.id || null, uuid: r.uuid || uuid, profile, status: r.status };
      });
    } catch (e) {
      await db.query('UPDATE invoices SET e_error = $1 WHERE id = $2', [(e as Error).message.slice(0, 500), id]);
      throw asBad(e);
    }
  });

  app.post('/api/invoices/:id/edm/status', async (req) => {
    const id = idParam(req.params);
    const [inv] = await db.query<{ e_uuid: string | null }>('SELECT e_uuid FROM invoices WHERE id = $1', [id]);
    if (!inv) throw fail(404, 'Fatura bulunamadı');
    if (!inv.e_uuid) throw fail(400, "Fatura EDM'ye gönderilmemiş");
    const { c } = await client();
    try {
      const h = await c.withSession((cl) => cl.getInvoiceStatus(inv.e_uuid!));
      await saveStatus(db, id, h);
      return { ok: true, status: h.status, eInvoiceNo: h.id || null };
    } catch (e) {
      throw asBad(e);
    }
  });

  /** Sonucu beklenen tüm faturaların durumunu yeniler */
  app.post('/api/edm/refresh', async () => {
    const rows = await db.query<{ id: number; e_uuid: string; e_status: string | null }>(
      `SELECT id, e_uuid, e_status FROM invoices WHERE e_uuid IS NOT NULL AND NOT cancelled AND e_sent_at > now() - interval '60 days' ORDER BY id DESC LIMIT 200`,
    );
    const todo = rows.filter((r) => ['wait', 'none'].includes(statusTone(r.e_status)));
    if (!todo.length) return { checked: 0, changed: 0 };
    const { c } = await client();
    let changed = 0;
    try {
      await c.withSession(async (cl) => {
        for (const r of todo) {
          const h = await cl.getInvoiceStatus(r.e_uuid).catch(() => null);
          if (!h) continue;
          if (h.status !== r.e_status) changed++;
          await saveStatus(db, r.id, h);
        }
      });
    } catch (e) {
      throw asBad(e);
    }
    return { checked: todo.length, changed };
  });

  // ---------- EDM → Rozet ----------
  const kurus = (v?: string) => Math.round(Number(v || 0) * 100);

  /** EDM'deki giden faturalar ve Rozet'teki karşılıkları */
  app.get('/api/edm/invoices', async (req) => {
    const q = z.object({ from: daySchema.optional(), to: daySchema.optional() }).parse(req.query);
    const to = q.to ?? today();
    const from = q.from ?? addDays(to, -30);
    if (Date.parse(to) - Date.parse(from) > 93 * 86_400_000) throw fail(400, 'En fazla 3 aylık aralık seçin');
    const { c } = await client();
    let list: EdmInvoiceHeader[];
    try {
      list = await c.withSession((cl) => cl.getInvoices({ direction: 'OUT', from, to }));
    } catch (e) {
      throw asBad(e);
    }
    const ours = await db.query<{ id: number; no: string; date: string; total: number; e_uuid: string | null; e_invoice_no: string | null; cancelled: boolean; tax_id: string | null; customer_name: string }>(
      `SELECT i.id, i.no, i.date, i.total, i.e_uuid, i.e_invoice_no, i.cancelled, c.tax_id, c.name customer_name
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.date BETWEEN $1::date - 31 AND $2::date + 31 OR i.e_uuid IS NOT NULL`,
      [from, to],
    );
    const customers = await db.query<{ id: number; name: string; tax_id: string }>(
      "SELECT id, name, regexp_replace(tax_id, '\\s', '', 'g') tax_id FROM customers WHERE tax_id IS NOT NULL AND (kind <> 'branch' OR bill_to = 'self') ORDER BY active DESC, id",
    );
    const custByTax = new Map<string, { id: number; name: string }>();
    for (const cu of customers) if (!custByTax.has(cu.tax_id)) custByTax.set(cu.tax_id, cu);
    const used = new Set<number>();
    const out = list.map((e) => {
      const total = kurus(e.payable);
      const tax = (e.receiver ?? '').replace(/\s/g, '');
      let match = ours.find((o) => o.e_uuid && e.uuid && o.e_uuid.toUpperCase() === e.uuid.toUpperCase()) ?? ours.find((o) => o.e_invoice_no && e.id && o.e_invoice_no === e.id);
      let state: 'linked' | 'candidate' | 'new' = match ? 'linked' : 'new';
      if (!match) {
        match = ours.find((o) => !o.cancelled && !o.e_uuid && !o.e_invoice_no && !used.has(o.id) && (o.tax_id ?? '').replace(/\s/g, '') === tax && o.total === total && o.date === e.issueDate);
        if (match) state = 'candidate';
      }
      if (match) used.add(match.id);
      const cust = custByTax.get(tax);
      return {
        id: e.id,
        uuid: e.uuid,
        issueDate: e.issueDate ?? null,
        customerName: e.customer ?? cust?.name ?? null,
        taxId: tax || null,
        total,
        currency: e.currency ?? 'TRY',
        profile: e.profileId ?? null,
        status: e.status,
        statusDescription: e.statusDescription,
        tone: statusTone(e.status),
        state,
        invoice: match ? { id: match.id, no: match.no, cancelled: match.cancelled } : null,
        customer: cust ?? null,
      };
    });
    return { from, to, invoices: out };
  });

  /**
   * İçe aktarma: link → mevcut Rozet faturasına EDM no + ETTN yazılır;
   * create → EDM'deki UBL okunur, müşteri (vergi no ile; yoksa açılır) ve irsaliyesiz fatura oluşturulur.
   */
  app.post('/api/edm/import', async (req) => {
    const b = z
      .object({
        items: z
          .array(z.object({ uuid: z.string().min(8).max(64), id: z.string().max(40), action: z.enum(['link', 'create']), invoiceId: z.number().int().positive().optional() }))
          .min(1, 'Fatura seçin')
          .max(100),
      })
      .parse(req.body);
    const { c } = await client();
    const results: { uuid: string; ok: boolean; invoiceId?: number; no?: string; message?: string; customerCreated?: boolean }[] = [];
    const co = await company(db);
    try {
      await c.withSession(async (cl) => {
        for (const it of b.items) {
          try {
            const [dup] = await db.query<{ id: number; no: string }>('SELECT id, no FROM invoices WHERE upper(e_uuid) = upper($1)', [it.uuid]);
            if (dup) {
              results.push({ uuid: it.uuid, ok: true, invoiceId: dup.id, no: dup.no, message: 'Zaten bağlı' });
              continue;
            }
            const st = await cl.getInvoiceStatus(it.uuid).catch(() => null);
            if (it.action === 'link') {
              if (!it.invoiceId) throw fail(400, 'Eşleşecek Rozet faturası seçilmedi');
              const r = await db.query<{ no: string }>(
                `UPDATE invoices SET e_uuid = $1, e_invoice_no = COALESCE(NULLIF($2,''), e_invoice_no), e_status = $3, e_status_desc = $4, e_sent_at = COALESCE(e_sent_at, now()), e_error = NULL
                 WHERE id = $5 AND e_uuid IS NULL RETURNING no`,
                [it.uuid.toUpperCase(), it.id, st?.status ?? null, st?.statusDescription ?? null, it.invoiceId],
              );
              if (!r.length) throw fail(400, 'Rozet faturası bulunamadı ya da başka bir e-Faturaya bağlı');
              results.push({ uuid: it.uuid, ok: true, invoiceId: it.invoiceId, no: r[0].no });
              continue;
            }
            const [full] = await cl.getInvoices({ direction: 'OUT', id: it.id || undefined, withContent: true });
            if (!full?.content) throw fail(502, "EDM fatura içeriğini vermedi");
            const p = parseUbl(full.content);
            if (p.uuid && p.uuid.toUpperCase() !== it.uuid.toUpperCase()) throw fail(502, "EDM'den gelen fatura ETTN'si uyuşmuyor");
            if (p.currency !== 'TRY') throw fail(400, `${p.currency} faturası içe alınamaz (yalnız TL)`);
            if (!['SATIS', 'TEVKIFAT', 'ISTISNA', 'IHRACKAYITLI', ''].includes(p.type)) throw fail(400, `${p.type} tipli fatura içe alınmaz (yalnız satış)`);
            if (co.taxId && p.supplierTaxId && p.supplierTaxId !== co.taxId) throw fail(400, 'Faturayı kesen firma Ayarlar’daki vergi no ile aynı değil');
            if (p.lines.some((l) => !Number.isInteger(l.qty))) throw fail(400, 'Küsuratlı miktarlı fatura içe alınamaz');
            const r = await db.tx(async (q) => {
              const taxId = p.customer.taxId.replace(/\s/g, '');
              let [cu] = await q.query<{ id: number; payment_days: number }>(
                "SELECT id, payment_days FROM customers WHERE regexp_replace(tax_id, '\\s', '', 'g') = $1 AND (kind <> 'branch' OR bill_to = 'self') ORDER BY active DESC, id LIMIT 1",
                [taxId],
              );
              let customerCreated = false;
              if (!cu) {
                [cu] = await q.query<{ id: number; payment_days: number }>(
                  `INSERT INTO customers(name, kind, legal_name, tax_id, tax_office, address, city, phone, email, note)
                   VALUES ($1,'single',$1,$2,$3,$4,$5,$6,$7,'EDM faturasından açıldı') RETURNING id, payment_days`,
                  [p.customer.name || taxId, taxId, p.customer.taxOffice, p.customer.address, p.customer.city, p.customer.phone, p.customer.email],
                );
                customerCreated = true;
              }
              const products = await q.query<{ id: number; code: string }>('SELECT id, code FROM products');
              const byCode = new Map(products.map((x) => [x.code.toLocaleUpperCase('tr'), x.id]));
              const date = p.issueDate || today();
              const no = await nextNo(q, 'invoices', 'FTR', date);
              const subtotal = p.lines.reduce((s, l) => s + l.net, 0);
              const vatTotal = p.lines.reduce((s, l) => s + l.vat, 0);
              const [{ id }] = await q.query<{ id: number }>(
                `INSERT INTO invoices(no, date, customer_id, due_date, subtotal, vat_total, total, note, e_invoice_no, e_uuid, e_profile, e_status, e_status_desc, e_source, e_sent_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'edm', now()) RETURNING id`,
                [
                  no,
                  date,
                  cu.id,
                  addDays(date, cu.payment_days),
                  subtotal,
                  vatTotal,
                  p.total || subtotal + vatTotal,
                  p.notes.filter((n) => !/^Rozet no:/.test(n)).join(' · ').slice(0, 1000) || null,
                  p.id || it.id || null,
                  it.uuid.toUpperCase(),
                  p.profile || null,
                  st?.status ?? full.status ?? null,
                  st?.statusDescription ?? full.statusDescription ?? null,
                ],
              );
              for (const l of p.lines) {
                const code = l.code ?? l.name.split(/\s+/)[0];
                const productId = byCode.get(code.toLocaleUpperCase('tr')) ?? null;
                await q.query(`INSERT INTO invoice_lines(invoice_id, product_id, description, qty, unit_price, vat_rate, net, vat, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
                  id,
                  productId,
                  l.code && !l.name.startsWith(l.code) ? `${l.code} ${l.name}` : l.name,
                  l.qty,
                  l.unitPrice,
                  l.vatRate,
                  l.net,
                  l.vat,
                  l.net + l.vat,
                ]);
              }
              return { id, no, customerCreated };
            });
            results.push({ uuid: it.uuid, ok: true, invoiceId: r.id, no: r.no, customerCreated: r.customerCreated });
          } catch (e) {
            if (e instanceof EdmError && /bağlanılamadı|oturum/i.test(e.message)) throw e;
            results.push({ uuid: it.uuid, ok: false, message: (e as Error).message });
          }
        }
      });
    } catch (e) {
      throw asBad(e);
    }
    return { results };
  });
}
