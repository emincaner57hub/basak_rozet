import { arr, at, esc, parseXml, tag, text, type XNode } from './xml.js';

/**
 * UBL-TR 1.2 (UBL 2.1) fatura XML'i. Eleman sırası UBL şemasındaki sıradır; değiştirmeyin.
 * Tutarlar kuruş (tamsayı) olarak gelir, XML'e iki ondalıkla yazılır.
 */

export interface UblParty {
  taxId: string; // 10 hane VKN ya da 11 hane TCKN
  name: string; // ünvan
  taxOffice?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface UblLine {
  code?: string | null;
  name: string;
  qty: number;
  unit?: string | null;
  unitPrice: number;
  vatRate: number;
  net: number;
  vat: number;
}

export interface UblInvoice {
  profile: 'TEMELFATURA' | 'TICARIFATURA' | 'EARSIVFATURA';
  id?: string | null; // boşsa numarayı EDM verir
  uuid: string;
  issueDate: string;
  issueTime: string;
  dueDate?: string | null;
  notes: string[];
  supplier: UblParty;
  customer: UblParty;
  lines: UblLine[];
  despatches: { no: string; date: string }[];
  iban?: string | null;
}

const amt = (kurus: number) => (kurus / 100).toFixed(2);
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));
const TRY = ' currencyID="TRY"';

const UNIT: Record<string, string> = { adet: 'C62', ad: 'C62', kg: 'KGM', gr: 'GRM', g: 'GRM', paket: 'PA', pk: 'PA', kutu: 'BX', koli: 'CT', set: 'SET', düzine: 'DZN', metre: 'MTR', m: 'MTR', litre: 'LTR' };
export const unitCode = (u?: string | null) => UNIT[(u ?? 'adet').trim().toLocaleLowerCase('tr')] ?? 'C62';

const isTckn = (id: string) => /^\d{11}$/.test(id);

function party(p: UblParty) {
  const scheme = isTckn(p.taxId) ? 'TCKN' : 'VKN';
  const words = p.name.trim().split(/\s+/);
  const person =
    scheme === 'TCKN'
      ? `<cac:Person>${tag('cbc:FirstName', words.length > 1 ? words.slice(0, -1).join(' ') : p.name)}${tag('cbc:FamilyName', words.length > 1 ? words.at(-1) : p.name)}</cac:Person>`
      : '';
  return (
    '<cac:Party>' +
    `<cac:PartyIdentification><cbc:ID schemeID="${scheme}">${esc(p.taxId)}</cbc:ID></cac:PartyIdentification>` +
    (scheme === 'VKN' ? `<cac:PartyName>${tag('cbc:Name', p.name)}</cac:PartyName>` : '') +
    '<cac:PostalAddress>' +
    tag('cbc:StreetName', p.address) +
    `<cbc:CitySubdivisionName>${esc(p.district || p.city || '-')}</cbc:CitySubdivisionName>` +
    `<cbc:CityName>${esc(p.city || p.district || '-')}</cbc:CityName>` +
    '<cac:Country><cbc:IdentificationCode>TR</cbc:IdentificationCode><cbc:Name>Türkiye</cbc:Name></cac:Country>' +
    '</cac:PostalAddress>' +
    (p.taxOffice ? `<cac:PartyTaxScheme><cac:TaxScheme>${tag('cbc:Name', p.taxOffice)}</cac:TaxScheme></cac:PartyTaxScheme>` : '') +
    (p.phone || p.email ? `<cac:Contact>${tag('cbc:Telephone', p.phone)}${tag('cbc:ElectronicMail', p.email)}</cac:Contact>` : '') +
    person +
    '</cac:Party>'
  );
}

const taxSubtotal = (taxable: number, tax: number, rate: number) =>
  '<cac:TaxSubtotal>' +
  `<cbc:TaxableAmount${TRY}>${amt(taxable)}</cbc:TaxableAmount>` +
  `<cbc:TaxAmount${TRY}>${amt(tax)}</cbc:TaxAmount>` +
  `<cbc:Percent>${num(rate)}</cbc:Percent>` +
  '<cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>' +
  '</cac:TaxSubtotal>';

export function buildUbl(inv: UblInvoice): string {
  if (!inv.lines.length) throw new Error('Faturada satır yok');
  for (const l of inv.lines) if (!(l.vatRate > 0)) throw new Error(`${l.name}: KDV %0 satırlar için istisna kodu gerekir; EDM portalından kesin`);
  const net = inv.lines.reduce((s, l) => s + l.net, 0);
  const vat = inv.lines.reduce((s, l) => s + l.vat, 0);
  const byRate = new Map<number, { net: number; vat: number }>();
  for (const l of inv.lines) {
    const g = byRate.get(l.vatRate) ?? { net: 0, vat: 0 };
    g.net += l.net;
    g.vat += l.vat;
    byRate.set(l.vatRate, g);
  }
  const notes = inv.profile === 'EARSIVFATURA' ? [...inv.notes, 'Gönderim Şekli: ELEKTRONIK'] : inv.notes;
  const supplierScheme = isTckn(inv.supplier.taxId) ? 'TCKN' : 'VKN';
  const iban = inv.iban?.replace(/\s/g, '');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
    ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>' +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>TR1.2</cbc:CustomizationID>' +
    `<cbc:ProfileID>${inv.profile}</cbc:ProfileID>` +
    (inv.id ? tag('cbc:ID', inv.id) : '<cbc:ID/>') +
    '<cbc:CopyIndicator>false</cbc:CopyIndicator>' +
    tag('cbc:UUID', inv.uuid) +
    tag('cbc:IssueDate', inv.issueDate) +
    tag('cbc:IssueTime', inv.issueTime) +
    '<cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>' +
    notes.map((n) => tag('cbc:Note', n)).join('') +
    '<cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>' +
    `<cbc:LineCountNumeric>${inv.lines.length}</cbc:LineCountNumeric>` +
    inv.despatches.map((d) => `<cac:DespatchDocumentReference>${tag('cbc:ID', d.no)}${tag('cbc:IssueDate', d.date)}</cac:DespatchDocumentReference>`).join('') +
    '<cac:Signature>' +
    `<cbc:ID schemeID="VKN_TCKN">${esc(inv.supplier.taxId)}</cbc:ID>` +
    `<cac:SignatoryParty><cac:PartyIdentification><cbc:ID schemeID="${supplierScheme}">${esc(inv.supplier.taxId)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PostalAddress><cbc:CitySubdivisionName>${esc(inv.supplier.district || inv.supplier.city || '-')}</cbc:CitySubdivisionName><cbc:CityName>${esc(inv.supplier.city || '-')}</cbc:CityName><cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress></cac:SignatoryParty>` +
    '<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#Signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>' +
    '</cac:Signature>' +
    `<cac:AccountingSupplierParty>${party(inv.supplier)}</cac:AccountingSupplierParty>` +
    `<cac:AccountingCustomerParty>${party(inv.customer)}</cac:AccountingCustomerParty>` +
    (inv.dueDate || iban
      ? `<cac:PaymentMeans><cbc:PaymentMeansCode>${iban ? '42' : '1'}</cbc:PaymentMeansCode>${tag('cbc:PaymentDueDate', inv.dueDate)}${iban ? `<cac:PayeeFinancialAccount>${tag('cbc:ID', iban)}</cac:PayeeFinancialAccount>` : ''}</cac:PaymentMeans>`
      : '') +
    `<cac:TaxTotal><cbc:TaxAmount${TRY}>${amt(vat)}</cbc:TaxAmount>` +
    [...byRate.entries()].map(([rate, g]) => taxSubtotal(g.net, g.vat, rate)).join('') +
    '</cac:TaxTotal>' +
    '<cac:LegalMonetaryTotal>' +
    `<cbc:LineExtensionAmount${TRY}>${amt(net)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxExclusiveAmount${TRY}>${amt(net)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount${TRY}>${amt(net + vat)}</cbc:TaxInclusiveAmount>` +
    `<cbc:AllowanceTotalAmount${TRY}>0.00</cbc:AllowanceTotalAmount>` +
    `<cbc:PayableAmount${TRY}>${amt(net + vat)}</cbc:PayableAmount>` +
    '</cac:LegalMonetaryTotal>' +
    inv.lines
      .map(
        (l, i) =>
          '<cac:InvoiceLine>' +
          `<cbc:ID>${i + 1}</cbc:ID>` +
          `<cbc:InvoicedQuantity unitCode="${unitCode(l.unit)}">${num(l.qty)}</cbc:InvoicedQuantity>` +
          `<cbc:LineExtensionAmount${TRY}>${amt(l.net)}</cbc:LineExtensionAmount>` +
          `<cac:TaxTotal><cbc:TaxAmount${TRY}>${amt(l.vat)}</cbc:TaxAmount>${taxSubtotal(l.net, l.vat, l.vatRate)}</cac:TaxTotal>` +
          `<cac:Item>${tag('cbc:Name', l.name)}${l.code ? `<cac:SellersItemIdentification>${tag('cbc:ID', l.code)}</cac:SellersItemIdentification>` : ''}</cac:Item>` +
          `<cac:Price><cbc:PriceAmount${TRY}>${amt(l.unitPrice)}</cbc:PriceAmount></cac:Price>` +
          '</cac:InvoiceLine>',
      )
      .join('') +
    '</Invoice>'
  );
}

// ---------------- Okuma (EDM'den içe aktarma) ----------------

export interface ParsedInvoice {
  id: string;
  uuid: string;
  profile: string;
  type: string;
  issueDate: string;
  currency: string;
  notes: string[];
  supplierTaxId: string;
  customer: UblParty;
  lines: UblLine[];
  subtotal: number;
  vatTotal: number;
  total: number;
  despatches: string[];
}

/** "1234.56" → 123456 kuruş */
const kurus = (v: unknown) => Math.round(Number(text(v) || 0) * 100);

function partyOf(p: unknown): UblParty {
  const ids = arr<XNode>(at(p, 'PartyIdentification'));
  const idNode = ids.map((x) => x.ID as XNode).find((x) => ['VKN', 'TCKN'].includes(text(x?.['@schemeID']))) ?? ids[0]?.ID;
  const personName = [text(at(p, 'Person.FirstName')), text(at(p, 'Person.FamilyName'))].filter(Boolean).join(' ');
  const addr = at(p, 'PostalAddress');
  return {
    taxId: text(idNode),
    name: text(at(p, 'PartyName.Name')) || personName,
    taxOffice: text(at(p, 'PartyTaxScheme.TaxScheme.Name')) || null,
    address: [text(at(addr, 'StreetName')), text(at(addr, 'BuildingName')), text(at(addr, 'BuildingNumber'))].filter(Boolean).join(' ') || null,
    district: text(at(addr, 'CitySubdivisionName')) || null,
    city: text(at(addr, 'CityName')) || null,
    phone: text(at(p, 'Contact.Telephone')) || null,
    email: text(at(p, 'Contact.ElectronicMail')) || null,
  };
}

export function parseUbl(xml: string): ParsedInvoice {
  const doc = parseXml(xml);
  const inv = doc.Invoice as XNode | undefined;
  if (!inv) throw new Error('UBL fatura değil');
  const lines: UblLine[] = arr<XNode>(inv.InvoiceLine).map((l) => {
    const sub = arr<XNode>(at(l, 'TaxTotal.TaxSubtotal')).find((s) => ['0015', ''].includes(text(at(s, 'TaxCategory.TaxScheme.TaxTypeCode'))));
    const net = kurus(l.LineExtensionAmount);
    return {
      code: text(at(l, 'Item.SellersItemIdentification.ID')) || null,
      name: text(at(l, 'Item.Name')) || text(at(l, 'Item.Description')) || 'Kalem',
      qty: Number(text(l.InvoicedQuantity) || 0),
      unit: text((l.InvoicedQuantity as XNode | undefined)?.['@unitCode']) || null,
      unitPrice: kurus(at(l, 'Price.PriceAmount')),
      vatRate: Number(text(sub?.Percent) || 0),
      net,
      vat: kurus(sub?.TaxAmount ?? at(l, 'TaxTotal.TaxAmount')),
    };
  });
  const mt = inv.LegalMonetaryTotal as XNode | undefined;
  const subtotal = kurus(mt?.TaxExclusiveAmount ?? mt?.LineExtensionAmount);
  const total = kurus(mt?.PayableAmount ?? mt?.TaxInclusiveAmount);
  return {
    id: text(inv.ID),
    uuid: text(inv.UUID),
    profile: text(inv.ProfileID),
    type: text(inv.InvoiceTypeCode),
    issueDate: text(inv.IssueDate).slice(0, 10),
    currency: text(inv.DocumentCurrencyCode) || 'TRY',
    notes: arr(inv.Note).map(text).filter(Boolean),
    supplierTaxId: partyOf(at(inv, 'AccountingSupplierParty.Party')).taxId,
    customer: partyOf(at(inv, 'AccountingCustomerParty.Party')),
    lines,
    subtotal,
    vatTotal: kurus(at(inv, 'TaxTotal.TaxAmount')) || total - subtotal,
    total,
    despatches: arr<XNode>(inv.DespatchDocumentReference).map((d) => text(d.ID)).filter(Boolean),
  };
}
