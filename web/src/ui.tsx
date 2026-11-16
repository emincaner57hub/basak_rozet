import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Tone } from './api';
import { moneyText, parseMoney } from './money';

// ---------- Bildirim ----------
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'bad') => void>(() => {});
export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ text: string; tone: 'ok' | 'bad'; key: number } | null>(null);
  const show = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => setT({ text, tone, key: Date.now() }), []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), t.tone === 'bad' ? 6000 : 3000);
    return () => clearTimeout(h);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div key={t.key} className={`no-print fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${t.tone === 'ok' ? 'bg-ink' : 'bg-bad'}`}>
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Veri yükleme ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn().then(
      (d) => {
        if (n !== seq.current) return;
        setData(d);
        setError('');
        setLoading(false);
      },
      (e) => {
        if (n !== seq.current) return;
        setError((e as Error).message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- Düzen ----------
export function Page({ title, subtitle, actions, children, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; back?: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-4 md:px-6 md:py-5">
      {back && <div className="no-print mb-1 text-sm">{back}</div>}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  const cls = {
    brand: 'bg-brand-soft text-brand',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    muted: 'bg-paper text-muted border border-line',
  }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

export function Stat({ label, value, sub, tone, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'ok' | 'warn'; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`card px-4 py-3 ${onClick ? 'cursor-pointer hover:border-brand/40' : ''}`}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`tabular mt-0.5 text-xl font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}
export function ErrorLine({ error }: { error: string }) {
  return error ? <div className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div> : null;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {items.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${value === k ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------- Pencere ----------
export function Modal({ title, onClose, children, width = 560, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-[6vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full rounded-2xl bg-card shadow-xl" style={{ maxWidth: width }}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="flex-1 text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Kapat" className="rounded-md px-2 text-xl leading-none text-muted hover:bg-paper">
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Form ----------
export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Para girişi: metin olarak tutulur, kaydederken kuruşa çevrilir */
export function MoneyInput({ value, onChange, placeholder, className, ariaLabel }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; className?: string; ariaLabel?: string }) {
  const [text, setText] = useState(moneyText(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(moneyText(value));
      last.current = value;
    }
  }, [value]);
  const bad = text.trim() !== '' && parseMoney(text) == null;
  return (
    <input
      value={text}
      inputMode="decimal"
      placeholder={placeholder ?? '0,00'}
      aria-label={ariaLabel}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        last.current = v;
        onChange(e.target.value.trim() === '' ? null : v);
      }}
      className={`input tabular text-right ${bad ? 'border-bad' : ''} ${className ?? ''}`}
    />
  );
}

export function IntInput({ value, onChange, className, ariaLabel, min = 0 }: { value: number | null; onChange: (v: number | null) => void; className?: string; ariaLabel?: string; min?: number }) {
  return (
    <input
      value={value ?? ''}
      inputMode="numeric"
      aria-label={ariaLabel}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d-]/g, '');
        onChange(t === '' || t === '-' ? null : Math.max(min, Number(t)));
      }}
      className={`input tabular text-right ${className ?? ''}`}
    />
  );
}

/** Aranabilir seçim kutusu */
export function SearchSelect<T extends { id: number }>({
  items,
  value,
  onChange,
  label,
  sub,
  placeholder = 'Ara…',
  disabled,
  ariaLabel,
  filter,
}: {
  items: T[];
  value: number | null;
  onChange: (id: number | null, item: T | null) => void;
  label: (t: T) => string;
  sub?: (t: T) => ReactNode;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  filter?: (t: T, q: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const cur = items.find((i) => i.id === value) ?? null;
  const list = useMemo(() => {
    const s = q.trim().toLocaleLowerCase('tr');
    return (s ? items.filter((i) => (filter ? filter(i, s) : label(i).toLocaleLowerCase('tr').includes(s))) : items).slice(0, 80);
  }, [items, q, label, filter]);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  const pick = (t: T | null) => {
    onChange(t?.id ?? null, t);
    setOpen(false);
    setQ('');
  };
  return (
    <div ref={box} className="relative">
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        value={open ? q : cur ? label(cur) : ''}
        placeholder={cur ? label(cur) : placeholder}
        onFocus={() => {
          setOpen(true);
          setHi(0);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
          else if (e.key === 'Enter' && open && list[hi]) {
            e.preventDefault();
            pick(list[hi]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
        className="input"
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-72 w-full min-w-[260px] overflow-y-auto rounded-lg border border-line bg-card py-1 shadow-lg scroll-thin">
          {list.length === 0 && <div className="px-3 py-2 text-sm text-muted">Sonuç yok</div>}
          {list.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(t)}
              onMouseEnter={() => setHi(i)}
              className={`block w-full px-3 py-1.5 text-left text-sm ${i === hi ? 'bg-brand-soft' : ''} ${t.id === value ? 'font-semibold' : ''}`}
            >
              {label(t)}
              {sub && <div className="text-xs text-muted">{sub(t)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Confirm({ title, text, onYes, onClose, yes = 'Evet', danger }: { title: string; text: ReactNode; onYes: () => Promise<void> | void; onClose: () => void; yes?: string; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onYes();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {yes}
          </button>
        </>
      }
    >
      <div className="text-sm">{text}</div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
    </Modal>
  );
}

export const fileToBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
