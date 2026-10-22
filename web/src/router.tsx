import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** Küçük yönlendirici: adres çubuğuyla eşleşir, geri/ileri çalışır */
const Ctx = createContext<{ path: string; go: (to: string) => void }>({ path: '/', go: () => {} });

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = (to: string) => {
    if (to === location.pathname + location.search) return;
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  return <Ctx.Provider value={{ path, go }}>{children}</Ctx.Provider>;
}
export const useNav = () => useContext(Ctx);

/** "/siparisler/12" kalıbı "/siparisler/:id" ile eşleşirse parametreleri döner */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = path.split('?')[0].split('/').filter(Boolean);
  const k = pattern.split('/').filter(Boolean);
  if (p.length !== k.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < k.length; i++) {
    if (k[i].startsWith(':')) out[k[i].slice(1)] = decodeURIComponent(p[i]);
    else if (k[i] !== p[i]) return null;
  }
  return out;
}
export const queryParam = (path: string, key: string) => new URLSearchParams(path.split('?')[1] ?? '').get(key);

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { go } = useNav();
  return (
    <a
      href={to}
      className={className ?? 'text-brand hover:underline'}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        go(to);
      }}
    >
      {children}
    </a>
  );
}
