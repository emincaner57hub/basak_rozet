import { parseUbl } from '../src/edm/ubl.js';
import { parseXml, find, text } from '../src/edm/xml.js';
import type { FetchFn } from '../src/edm/soap.js';

/** Sahte EDM web servisi: gelen SOAP isteğini okuyup kayıtlı faturalarla yanıt verir */
export function fakeEdm() {
  const calls: { op: string; action: string; body: string }[] = [];
  const store = new Map<string, { id: string; uuid: string; xml: string; receiver: string; status: string; date: string; total: string; earchive: boolean }>();
  let seq = 0;
  const registered = new Set(['1234567890', '1112223334']); // e-Fatura mükellefleri
  const ok = (op: string, inner: string) => ({
    ok: true,
    status: 200,
    text: async () => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/">${inner}</${op}Response></s:Body></s:Envelope>`,
  });
  const faultRes = (msg: string) => ({
    ok: false,
    status: 500,
    text: async () =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>err</faultstring><detail><REQUEST_ERRORType xmlns="http://tempuri.org/"><ERROR_CODE>10</ERROR_CODE><ERROR_SHORT_DES>${msg}</ERROR_SHORT_DES></REQUEST_ERRORType></detail></s:Fault></s:Body></s:Envelope>`,
  });
  const add = (xml: string, receiver: string, earchive: boolean) => {
    const p = parseUbl(xml);
    const id = p.id || `BSK2026${String(++seq).padStart(9, '0')}`;
    store.set(p.uuid, { id, uuid: p.uuid, xml: xml.replace('<cbc:ID/>', `<cbc:ID>${id}</cbc:ID>`), receiver, status: 'SEND - SUCCEED', date: p.issueDate, total: (p.total / 100).toFixed(2), earchive });
    return store.get(p.uuid)!;
  };
  const fetchFn: FetchFn = async (url, init) => {
    if (init?.method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          ['Login', 'Logout', 'CheckUser', 'SendInvoice', 'GetInvoiceStatus', 'GetInvoice']
            .map((op) => `<wsdl:operation name="${op}"><soap:operation soapAction="http://tempuri.org/EFaturaEDMPort/${op}" style="document"/></wsdl:operation>`)
            .join(''),
      };
    }
    const body = init!.body!;
    const op = /<(\w+)Request xmlns="http:\/\/tempuri.org\/">/.exec(body)![1];
    calls.push({ op, action: init!.headers!.soapaction, body });
    const doc = parseXml(body);
    if (op === 'Login') return text(find(doc, 'PASSWORD')) === 'gizli' ? ok(op, '<SESSION_ID xmlns="">S-1</SESSION_ID>') : faultRes('Kullanıcı adı veya şifre hatalı');
    if (text(find(doc, 'SESSION_ID')) !== 'S-1') return faultRes('Oturum geçersiz');
    if (op === 'Logout') return ok(op, '<REQUEST_RETURN xmlns=""><RETURN_CODE>0</RETURN_CODE></REQUEST_RETURN>');
    if (op === 'CheckUser') {
      const vkn = text(find(doc, 'IDENTIFIER'));
      return ok(
        op,
        registered.has(vkn)
          ? `<USER xmlns=""><IDENTIFIER>${vkn}</IDENTIFIER><ALIAS>urn:mail:defaultgb@${vkn}.com</ALIAS><UNIT>GB</UNIT></USER><USER xmlns=""><IDENTIFIER>${vkn}</IDENTIFIER><ALIAS>urn:mail:defaultpk@${vkn}.com</ALIAS><TITLE>FIRMA</TITLE><UNIT>PK</UNIT></USER>`
          : '',
      );
    }
    if (op === 'SendInvoice') {
      const inv = find(doc, 'INVOICE') as Record<string, unknown>;
      const xml = Buffer.from(text((Array.isArray(inv) ? inv[0] : inv).CONTENT), 'base64').toString('utf8');
      const receiver = (find(doc, 'RECEIVER') as Record<string, string>)['@vkn'];
      const e = add(xml, receiver, text(find(doc, 'EARCHIVE')) === 'true');
      return ok(op, `<REQUEST_RETURN xmlns=""><RETURN_CODE>0</RETURN_CODE></REQUEST_RETURN><INVOICE xmlns="" TRXID="1" UUID="${e.uuid}" ID="${e.id}"><HEADER><STATUS>PACKAGE - PROCESSING</STATUS><STATUS_DESCRIPTION>Paketleniyor</STATUS_DESCRIPTION></HEADER></INVOICE>`);
    }
    if (op === 'GetInvoiceStatus') {
      const uuid = (find(doc, 'INVOICE') as Record<string, string>[])[0]['@UUID'];
      const e = store.get(uuid);
      if (!e) return faultRes('Fatura bulunamadı');
      return ok(op, `<INVOICE_STATUS xmlns="" UUID="${e.uuid}" ID="${e.id}"><STATUS>${e.status}</STATUS><STATUS_DESCRIPTION>Başarılı</STATUS_DESCRIPTION></INVOICE_STATUS>`);
    }
    if (op === 'GetInvoice') {
      const id = text(find(doc, 'ID'));
      const headerOnly = text(find(doc, 'HEADER_ONLY')) === 'Y';
      const list = [...store.values()].filter((e) => !id || e.id === id);
      return ok(
        op,
        list
          .map(
            (e) =>
              `<INVOICE xmlns="" TRXID="1" UUID="${e.uuid}" ID="${e.id}"><HEADER><SENDER>5556667778</SENDER><RECEIVER>${e.receiver}</RECEIVER><CUSTOMER>MÜŞTERİ</CUSTOMER><ISSUE_DATE>${e.date}T00:00:00</ISSUE_DATE><PAYABLE_AMOUNT currencyID="TRY">${e.total}</PAYABLE_AMOUNT><PROFILEID>TEMELFATURA</PROFILEID><STATUS>${e.status}</STATUS><EARCHIVE>${e.earchive}</EARCHIVE></HEADER>` +
              (headerOnly ? '' : `<CONTENT>${Buffer.from(e.xml).toString('base64')}</CONTENT>`) +
              '</INVOICE>',
          )
          .join(''),
      );
    }
    return faultRes(`Bilinmeyen işlem ${op}`);
  };
  return { fetchFn, calls, store, add };
}
