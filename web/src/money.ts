/** Tutarlar kuruş (tam sayı) olarak tutulur */
const tl = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatTL = (kurus: number | null | undefined) => (kurus == null ? '—' : tl.format(Math.round(kurus) / 100));
/** Birim maliyet gibi küsuratlı kuruşlar: 4 haneye kadar */
export const formatUnit = (kurus: number | null | undefined) =>
  kurus == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(kurus / 100);
export const fmtNum = (n: number | null | undefined, digits = 0) => (n == null ? '—' : n.toLocaleString('tr-TR', { maximumFractionDigits: digits }));
export const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `%${(n * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`);

/** "1.234,56" ya da "1234.56" → kuruş; geçersizse null */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/\s|₺/g, '');
  if (!t) return null;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^-?\d+(\.\d{0,2})?$/.test(norm)) return null;
  return Math.round(Number(norm) * 100);
}
export const moneyText = (k: number | null | undefined) => (k == null ? '' : (k / 100).toFixed(2).replace('.', ','));
/** Ondalık sayı ("0,35") */
export function parseDec(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}
export const decText = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

export const trDate = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('.') : '—');
export function today(offset = 0) {
  const d = new Date(Date.now() + offset * 86_400_000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
export const monthStart = () => `${today().slice(0, 7)}-01`;
