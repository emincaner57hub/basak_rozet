import crypto from 'node:crypto';
import { arr, at, esc, find, parseXml, tag, text, type XNode } from './xml.js';

/**
 * EDM Bilişim e-Fatura / e-Arşiv web servisi (WCF, SOAP 1.1) istemcisi.
 * Gövde elemanı http://tempuri.org/ ad alanında, alt elemanlar ad alanısız (xmlns="").
 * Akış: Login → SESSION_ID → işlemler (REQUEST_HEADER içinde SESSION_ID) → Logout.
 */

export const EDM_URLS = {
  test: 'https://test.edmbilisim.com.tr/EFaturaEDM21ea/EFaturaEDM.svc',
  prod: 'https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc',
} as const;

export interface EdmConfig {
  url: string;
  username: string;
  password: string;
  /** İstek başlığında giden uygulama bilgileri (EDM loglarında görünür) */
  applicationName?: string;
  hostname?: string;
  channelName?: string;
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class EdmError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Gönderilen faturanın EDM'deki başlık bilgisi */
export interface EdmInvoiceHeader {
  id: string; // fatura no (ör. ABC2026000000012)
  uuid: string; // ETTN
  status: string;
  statusDescription: string;
  gibStatusCode?: string;
  gibStatusDescription?: string;
  responseCode?: string;
  responseDescription?: string;
  issueDate?: string;
  profileId?: string;
  sender?: string;
  receiver?: string;
  customer?: string;
  payable?: string;
  currency?: string;
  earchive?: boolean;
  content?: string; // UBL XML (çözülmüş)
}

const nowTr = () => {
  // EDM yerel saat bekler: Europe/Istanbul, ISO biçimi saniyeli
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
};

/** WSDL'den işlem → SOAPAction eşlemesi (adres başına bir kez okunur) */
const actionCache = new Map<string, Map<string, string>>();
export function parseSoapActions(wsdl: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<(?:\w+:)?operation\s+name="(\w+)"[^>]*>\s*<(?:\w+:)?operation\s+soapAction="([^"]*)"/g;
  for (let m; (m = re.exec(wsdl)); ) out.set(m[1], m[2]);
  return out;
}

export class EdmClient {
  private session: string | null = null;
  constructor(
    private cfg: EdmConfig,
    private fetchFn: FetchFn = fetch as unknown as FetchFn,
    private timeoutMs = 60_000,
  ) {}

  private async http(url: string, init: Parameters<FetchFn>[1]) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: ctl.signal });
    } catch (e) {
      throw new EdmError(`EDM'ye bağlanılamadı: ${(e as Error).name === 'AbortError' ? 'zaman aşımı' : (e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
  }

  private async soapAction(op: string): Promise<string> {
    let map = actionCache.get(this.cfg.url);
    if (!map) {
      try {
        const r = await this.http(`${this.cfg.url}?singleWsdl`, { method: 'GET' });
        map = r.ok ? parseSoapActions(await r.text()) : new Map();
      } catch {
        map = new Map();
      }
      if (map.size) actionCache.set(this.cfg.url, map);
    }
    return map.get(op) ?? op;
  }

  private header() {
    return (
      '<REQUEST_HEADER xmlns="">' +
      tag('SESSION_ID', this.session ?? '0') +
      tag('CLIENT_TXN_ID', crypto.randomUUID()) +
      tag('ACTION_DATE', nowTr()) +
      tag('REASON', 'Başak Rozet fatura entegrasyonu') +
      tag('APPLICATION_NAME', this.cfg.applicationName ?? 'Basak Rozet') +
      tag('HOSTNAME', this.cfg.hostname ?? 'basak-rozet') +
      tag('CHANNEL_NAME', this.cfg.channelName ?? 'ERP') +
      tag('COMPRESSED', 'N') +
      '</REQUEST_HEADER>'
    );
  }

  /** Tek SOAP çağrısı; gövde içeriği REQUEST_HEADER'dan sonra gelir */
  async call(op: string, inner: string): Promise<XNode> {
    const envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      `<${op}Request xmlns="http://tempuri.org/">${this.header()}${inner}</${op}Request>` +
      '</s:Body></s:Envelope>';
    const r = await this.http(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${await this.soapAction(op)}"` },
      body: envelope,
    });
    const body = await r.text();
    let doc: XNode;
    try {
      doc = parseXml(body);
    } catch {
      throw new EdmError(`EDM yanıtı okunamadı (HTTP ${r.status})`);
    }
    const fault = find(doc, 'Fault');
    if (fault || !r.ok) {
      const short = text(find(fault, 'ERROR_SHORT_DES'));
      const long = text(find(fault, 'ERROR_LONG_DES'));
      const code = text(find(fault, 'ERROR_CODE'));
      const msg = [short, long].filter((x, i, a) => x && a.indexOf(x) === i).join(' — ') || text(find(fault, 'faultstring')) || `HTTP ${r.status}`;
      throw new EdmError(`EDM: ${msg}`, code || undefined);
    }
    const res = find(doc, `${op}Response`);
    if (res === undefined) throw new EdmError(`EDM yanıtında ${op}Response yok`);
    return (res ?? {}) as XNode;
  }

  async login() {
    const res = await this.call('Login', tag('USER_NAME', this.cfg.username, ' xmlns=""') + tag('PASSWORD', this.cfg.password, ' xmlns=""'));
    const sid = text(find(res, 'SESSION_ID'));
    if (!sid) throw new EdmError('EDM girişi başarısız: oturum alınamadı');
    this.session = sid;
  }

  async logout() {
    if (!this.session) return;
    try {
      await this.call('Logout', '');
    } catch {
      /* oturum zaten düşmüş olabilir */
    }
    this.session = null;
  }

  /** Giriş yapıp işi çalıştırır, sonunda çıkış yapar */
  async withSession<T>(fn: (c: EdmClient) => Promise<T>): Promise<T> {
    await this.login();
    try {
      return await fn(this);
    } finally {
      await this.logout();
    }
  }

  /** VKN/TCKN e-Fatura kayıtlı mı; kayıtlıysa etiketleri (PK: posta kutusu/alıcı, GB: gönderici birim) */
  async checkUser(identifier: string): Promise<{ alias: string; title: string; unit: string }[]> {
    const res = await this.call('CheckUser', `<USER xmlns="">${tag('IDENTIFIER', identifier)}</USER>`);
    return arr<XNode>(res.USER)
      .map((u) => ({ alias: text(u.ALIAS), title: text(u.TITLE), unit: text(u.UNIT) }))
      .filter((u) => u.alias);
  }

  /** Faturayı gönderir. content: UBL-TR XML. e-Arşiv için earchive=true ve receiverAlias boş. */
  async sendInvoice(o: { senderVkn: string; senderAlias: string; receiverVkn: string; receiverAlias: string | null; content: string; earchive: boolean; receiverEmail?: string | null }) {
    const b64 = Buffer.from(o.content, 'utf8').toString('base64');
    const inner =
      `<SENDER xmlns="" vkn="${esc(o.senderVkn)}" alias="${esc(o.senderAlias)}"/>` +
      `<RECEIVER xmlns="" vkn="${esc(o.receiverVkn)}" alias="${esc(o.receiverAlias ?? '')}"/>` +
      '<INVOICE xmlns="" TRXID="0"><HEADER>' +
      tag('SENDER', o.senderVkn) +
      tag('RECEIVER', o.receiverVkn) +
      tag('FROM', o.senderAlias) +
      tag('TO', o.earchive ? (o.receiverEmail ?? '') : (o.receiverAlias ?? '')) +
      tag('INTERNETSALES', 'false') +
      tag('EARCHIVE', o.earchive ? 'true' : 'false') +
      tag('EARCHIVE_REPORT_SENDDATE', '0001-01-01') +
      tag('CANCEL_EARCHIVE_REPORT_SENDDATE', '0001-01-01') +
      `</HEADER><CONTENT>${b64}</CONTENT></INVOICE>`;
    const res = await this.call('SendInvoice', inner);
    const code = text(at(res, 'REQUEST_RETURN.RETURN_CODE'));
    if (code && code !== '0') throw new EdmError(`EDM gönderimi reddetti (kod ${code})`, code);
    const inv = arr<XNode>(res.INVOICE)[0] ?? {};
    return { id: text(inv['@ID']), uuid: text(inv['@UUID']), status: text(at(inv, 'HEADER.STATUS')), statusDescription: text(at(inv, 'HEADER.STATUS_DESCRIPTION')) };
  }

  async getInvoiceStatus(uuid: string): Promise<EdmInvoiceHeader> {
    const res = await this.call('GetInvoiceStatus', `<INVOICE xmlns="" TRXID="0" UUID="${esc(uuid)}"/>`);
    const s = arr<XNode>(res.INVOICE_STATUS)[0];
    if (!s) throw new EdmError('EDM faturayı bulamadı');
    return {
      id: text(s['@ID']),
      uuid: text(s['@UUID']) || uuid,
      status: text(s.STATUS),
      statusDescription: text(s.STATUS_DESCRIPTION),
      responseCode: text(s.RESPONSE_CODE) || undefined,
      responseDescription: text(s.RESPONSE_DESCRIPTION) || undefined,
      earchive: text(at(s, 'HEADER.EARCHIVE')) === 'true',
    };
  }

  /**
   * Giden (OUT) ya da gelen (IN) faturalar. Tarih: EDM'de oluşturulma tarihi aralığı.
   * withContent: UBL içeriği de gelsin (içe aktarma için).
   */
  async getInvoices(o: { direction: 'OUT' | 'IN'; from?: string; to?: string; id?: string; withContent?: boolean }): Promise<EdmInvoiceHeader[]> {
    const key =
      '<INVOICE_SEARCH_KEY xmlns="">' +
      tag('ID', o.id) +
      tag('READ_INCLUDED', 'true') +
      tag('DIRECTION', o.direction) +
      tag('CR_START_DATE', o.from ? `${o.from}T00:00:00` : undefined) +
      tag('CR_END_DATE', o.to ? `${o.to}T23:59:59` : undefined) +
      tag('ISARCHIVED', 'false') +
      '</INVOICE_SEARCH_KEY>' +
      tag('HEADER_ONLY', o.withContent ? 'N' : 'Y', ' xmlns=""') +
      tag('INVOICE_CONTENT_TYPE', 'XML', ' xmlns=""');
    const res = await this.call('GetInvoice', key);
    return arr<XNode>(res.INVOICE).map((inv) => {
      const h = (inv.HEADER ?? {}) as XNode;
      const raw = text(inv.CONTENT);
      return {
        id: text(inv['@ID']),
        uuid: text(inv['@UUID']),
        status: text(h.STATUS),
        statusDescription: text(h.STATUS_DESCRIPTION),
        gibStatusCode: text(h.GIB_STATUS_CODE) || undefined,
        gibStatusDescription: text(h.GIB_STATUS_DESCRIPTION) || undefined,
        responseCode: text(h.RESPONSE_CODE) || undefined,
        responseDescription: text(h.RESPONSE_DESCRIPTION) || undefined,
        issueDate: text(h.ISSUE_DATE).slice(0, 10) || undefined,
        profileId: text(h.PROFILEID) || undefined,
        sender: text(h.SENDER) || undefined,
        receiver: text(h.RECEIVER) || undefined,
        customer: text(h.CUSTOMER) || undefined,
        payable: text(h.PAYABLE_AMOUNT) || undefined,
        currency: text((h.PAYABLE_AMOUNT as XNode | undefined)?.['@currencyID']) || undefined,
        earchive: text(h.EARCHIVE) === 'true',
        content: raw ? decodeContent(raw) : undefined,
      };
    });
  }
}

/** CONTENT base64; bazen düz XML gelir */
export function decodeContent(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('<')) return s;
  const buf = Buffer.from(s, 'base64');
  if (buf[0] === 0x50 && buf[1] === 0x4b) throw new EdmError('EDM fatura içeriğini sıkıştırılmış (zip) gönderdi; desteklenmiyor');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/** EDM durum metnini sadeleştirir: ok / wait / bad */
export function statusTone(status: string | null | undefined): 'ok' | 'wait' | 'bad' | 'none' {
  if (!status) return 'none';
  const s = status.replace(/\s/g, '').toUpperCase();
  if (/FAIL|ERROR|REJECTED|REJECT-SUCCEED|CANCEL/.test(s)) return 'bad';
  if (/SUCCEED/.test(s)) return 'ok';
  return 'wait';
}
