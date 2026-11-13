import { XMLParser } from 'fast-xml-parser';

/** XML metin/öznitelik kaçışı */
export const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Boş değerde etiketi hiç yazmaz */
export const tag = (name: string, value: unknown, attrs = '') => (value == null || value === '' ? '' : `<${name}${attrs}>${esc(value)}</${name}>`);

// Birden çok gelebilen elemanlar her zaman dizi olsun
const ARRAYS = new Set(['INVOICE', 'USER', 'InvoiceLine', 'TaxSubtotal', 'TaxTotal', 'PartyIdentification', 'Note', 'DespatchDocumentReference', 'INVOICE_STATUS']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  textNodeName: '#text',
  isArray: (name) => ARRAYS.has(name),
});

export type XNode = Record<string, unknown>;
export const parseXml = (xml: string): XNode => parser.parse(xml) as XNode;

/** Düğümün metin değeri (öznitelikli düğümde #text) */
export function text(n: unknown): string {
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') return String(n);
  if (Array.isArray(n)) return text(n[0]);
  const t = (n as XNode)['#text'];
  return t == null ? '' : String(t);
}

/** Ağaçta adıyla ilk düğümü bulur (derinlik öncelikli) */
export function find(n: unknown, key: string): unknown {
  if (n == null || typeof n !== 'object') return undefined;
  if (Array.isArray(n)) {
    for (const x of n) {
      const r = find(x, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const o = n as XNode;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const r = find(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** a.b.c yolunu izler; diziyse ilk elemanı alır */
export function at(n: unknown, path: string): unknown {
  let cur: unknown = n;
  for (const k of path.split('.')) {
    if (Array.isArray(cur)) cur = cur[0];
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as XNode)[k];
  }
  return cur;
}

export const arr = <T = XNode>(v: unknown): T[] => (v == null ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);
