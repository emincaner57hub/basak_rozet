import { useEffect, useState } from 'react';
import { api, type Customer, type PortalUser, type Settings, type User } from '../api';
import { getUser } from '../App';
import { Badge, Confirm, ErrorLine, Field, Modal, Page, SearchSelect, useLoad, useToast } from '../ui';

export function SettingsPage() {
  const me = getUser();
  return (
    <Page title="Ayarlar">
      <div className="grid gap-4 lg:grid-cols-2">
        <CompanyCard />
        <div className="space-y-4">
          {me?.role === 'admin' && <UsersCard />}
          <PasswordCard />
        </div>
      </div>
      {me?.role === 'admin' && (
        <div className="mt-4">
          <PortalUsersCard />
        </div>
      )}
    </Page>
  );
}

const FIELDS: [keyof Settings, string, boolean?][] = [
  ['companyName', 'Firma adı (kısa)'],
  ['companyLegalName', 'Tam firma ünvanı'],
  ['companyTaxOffice', 'Vergi dairesi'],
  ['companyTaxId', 'Vergi no / TCKN'],
  ['companyAddress', 'Adres', true],
  ['companyPhone', 'Telefon'],
  ['companyEmail', 'E-posta'],
  ['companyIban', 'IBAN (faturada basılır)', true],
  ['invoiceNote', 'Fatura alt notu', true],
];

function CompanyCard() {
  const { data, error } = useLoad(() => api.settings(), []);
  const [f, setF] = useState<Settings | null>(null);
  const toast = useToast();
  useEffect(() => setF(data), [data]);
  if (!f) return <ErrorLine error={error} />;
  return (
    <div className="card p-5">
      <h2 className="mb-1 font-semibold">Firma bilgileri</h2>
      <p className="mb-4 text-xs text-muted">İrsaliye ve fatura çıktılarının başında ve “Teslim eden” bölümünde basılır. Bilmediğiniz alanı boş bırakın, sonra doldurursunuz.</p>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(([k, l, wide]) => (
          <Field key={k} label={l} className={wide ? 'col-span-2' : ''}>
            <input className="input" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <button
        className="btn btn-primary mt-4"
        onClick={async () => {
          try {
            await api.saveSettings(f);
            toast('Kaydedildi');
          } catch (e) {
            toast((e as Error).message, 'bad');
          }
        }}
      >
        Kaydet
      </button>
    </div>
  );
}

function UsersCard() {
  const { data, reload } = useLoad(() => api.users(), []);
  const [edit, setEdit] = useState<Partial<User> | null>(null);
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center">
        <h2 className="flex-1 font-semibold">Kullanıcılar</h2>
        <button className="btn btn-sm" onClick={() => setEdit({ role: 'staff', active: true })}>
          + Kullanıcı
        </button>
      </div>
      <table className="tbl">
        <tbody>
          {data?.map((u) => (
            <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
              <td className="font-medium">{u.name}</td>
              <td className="text-muted">{u.email}</td>
              <td>
                {u.role === 'admin' ? <Badge tone="brand">Yönetici</Badge> : <Badge>Kullanıcı</Badge>} {!u.active && <Badge tone="bad">Pasif</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <UserDialog
          u={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({ u, onClose, onSaved }: { u: Partial<User>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(u.name ?? '');
  const [email, setEmail] = useState(u.email ?? '');
  const [role, setRole] = useState<User['role']>(u.role ?? 'staff');
  const [active, setActive] = useState(u.active ?? true);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title={u.id ? 'Kullanıcıyı düzenle' : 'Yeni kullanıcı'}
      onClose={onClose}
      width={440}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await api.saveUser(u.id ?? null, { name, email, role, active, password: password || undefined });
                onSaved();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Kaydet
          </button>
        </>
      }
    >
      <Field label="Ad" className="mb-2">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="E-posta" className="mb-2">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label={u.id ? 'Yeni şifre (değiştirmek için)' : 'Şifre (en az 8 karakter)'} className="mb-2">
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="flex items-center gap-4 text-sm">
        <select className="input w-40" value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
          <option value="staff">Kullanıcı</option>
          <option value="admin">Yönetici</option>
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktif
        </label>
      </div>
    </Modal>
  );
}

function PasswordCard() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const toast = useToast();
  return (
    <div className="card p-5">
      <h2 className="mb-3 font-semibold">Şifremi değiştir</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mevcut şifre">
          <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="Yeni şifre">
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
      <button
        className="btn mt-3"
        disabled={!cur || next.length < 8}
        onClick={async () => {
          try {
            await api.changePassword(cur, next);
            setCur('');
            setNext('');
            toast('Şifre değişti');
          } catch (e) {
            toast((e as Error).message, 'bad');
          }
        }}
      >
        Değiştir
      </button>
    </div>
  );
}

// ---------- Müşteri satın almacıları (portal) ----------
function PortalUsersCard() {
  const { data, reload } = useLoad(() => api.portalUsers(), []);
  const [edit, setEdit] = useState<PortalUser | 'new' | null>(null);
  const link = `${location.origin}/portal`;
  const toast = useToast();
  return (
    <div className="card p-5">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 font-semibold">Müşteri satın almacıları (cepten sipariş)</h2>
        <button className="btn btn-sm" onClick={() => setEdit('new')}>
          + Satın almacı
        </button>
      </div>
      <p className="mb-3 text-sm text-muted">
        Müşterinin satın almacısı kendi kodu ve şifresiyle{' '}
        <button
          className="font-medium text-brand underline"
          onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Bağlantı kopyalandı'), () => {})}
          title="Kopyala"
        >
          {link}
        </button>{' '}
        adresinden girer, atandığı şubelere sipariş verir ve siparişlerinin durumunu görür. Zincire atanan satın almacı zincirin tüm şubelerine sipariş
        verebilir. Gelen siparişler Siparişler → "Gelen (müşteriden)" altında, menüde sayıyla görünür.
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Ad</th>
            <th>Kod</th>
            <th>Atandığı müşteriler</th>
            <th>Son giriş</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
              <td className="font-medium">
                {u.name} {!u.active && <Badge tone="bad">Pasif</Badge>} {!u.seePrices && <Badge>fiyat gizli</Badge>}
                {u.phone && <div className="text-xs font-normal text-muted">{u.phone}</div>}
              </td>
              <td className="font-mono text-sm">{u.code}</td>
              <td className="text-sm">
                {u.customers.length
                  ? u.customers.map((c) => (
                      <span key={c.id} className="mr-1 inline-block">
                        <Badge tone={c.kind === 'chain' ? 'brand' : 'muted'}>
                          {c.name}
                          {c.kind === 'chain' ? ' (tüm şubeler)' : ''}
                        </Badge>
                      </span>
                    ))
                  : <span className="text-bad">atanmamış</span>}
              </td>
              <td className="text-xs text-muted">{u.lastLogin ? new Date(u.lastLogin).toLocaleString('tr-TR') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <p className="py-3 text-sm text-muted">Henüz satın almacı yok.</p>}
      {edit && (
        <PortalUserDialog
          u={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function PortalUserDialog({ u, onClose, onSaved }: { u: PortalUser | null; onClose: () => void; onSaved: () => void }) {
  const customers = useLoad(() => api.customers(), []);
  const [name, setName] = useState(u?.name ?? '');
  const [code, setCode] = useState(u?.code ?? '');
  const [phone, setPhone] = useState(u?.phone ?? '');
  const [email, setEmail] = useState(u?.email ?? '');
  const [active, setActive] = useState(u?.active ?? true);
  const [seePrices, setSeePrices] = useState(u?.seePrices ?? true);
  const [password, setPassword] = useState('');
  const [ids, setIds] = useState<number[]>(u?.customers.map((c) => c.id) ?? []);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const toast = useToast();
  const all = (customers.data ?? []).filter((c) => c.active || ids.includes(c.id));
  const byId = new Map(all.map((c) => [c.id, c]));
  const label = (c: Customer) => (c.kind === 'chain' ? `${c.name} — zincir (tüm şubeler)` : c.parentName ? `${c.parentName} · ${c.name}` : c.name);
  const suggest = () => {
    const first = byId.get(ids[0]);
    const base = (first?.code || first?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nm = name.trim().split(/\s+/)[0]?.toLowerCase().replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u').replace(/[^a-z0-9]/g, '');
    return [nm, base].filter(Boolean).join('.');
  };
  return (
    <Modal
      title={u ? 'Satın almacıyı düzenle' : 'Yeni satın almacı'}
      onClose={onClose}
      width={560}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          {u && (
            <button className="btn mr-auto" onClick={() => setDel(true)}>
              Sil
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await api.savePortalUser(u?.id ?? null, { name, code, phone: phone || null, email: email || null, active, seePrices, password: password || null, customerIds: ids });
                toast(password ? `Kaydedildi · kod: ${code.toLowerCase()} — şifreyi satın almacıya iletin` : 'Kaydedildi');
                onSaved();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Kaydet
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ad soyad">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Telefon">
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Kullanıcı kodu (girişte)">
          <div className="flex gap-1">
            <input className="input font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ör. ayse.kahveduragi" autoCapitalize="none" />
            {!u && (
              <button className="btn btn-sm" type="button" onClick={() => setCode(suggest())} title="Ad ve müşteriden öner">
                Öner
              </button>
            )}
          </div>
        </Field>
        <Field label={u ? 'Yeni şifre (değiştirmek için)' : 'Şifre (en az 6)'}>
          <input className="input" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="E-posta (isteğe bağlı)">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="mt-5 space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktif (girebilir)
          </label>
          <label className="flex items-center gap-2" title="Kapalıysa siparişte ve geçmiş siparişlerde fiyat / tutar görünmez">
            <input type="checkbox" checked={seePrices} onChange={(e) => setSeePrices(e.target.checked)} /> Fiyat görebilir
          </label>
        </div>
      </div>
      <div className="mt-4">
        <div className="label">Sipariş verebileceği müşteriler</div>
        <div className="mb-2 flex flex-wrap gap-1">
          {ids.map((id) => {
            const c = byId.get(id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-sm">
                {c ? label(c) : `#${id}`}
                <button className="text-muted hover:text-bad" onClick={() => setIds(ids.filter((x) => x !== id))} aria-label="Çıkar">
                  ×
                </button>
              </span>
            );
          })}
          {!ids.length && <span className="text-sm text-muted">Henüz atanmadı: zincir, şube ya da tek kafe ekleyin.</span>}
        </div>
        <SearchSelect
          items={all.filter((c) => !ids.includes(c.id))}
          value={null}
          onChange={(id) => id && setIds([...ids, id])}
          label={label}
          placeholder="Zincir, şube ya da kafe ekle…"
        />
      </div>
      {del && u && (
        <Confirm
          title="Satın almacı silinsin mi?"
          text="Siparişi olan satın almacı silinmez, pasif yapılır (giremez)."
          yes="Sil"
          danger
          onClose={() => setDel(false)}
          onYes={async () => {
            const r = await api.deletePortalUser(u.id);
            toast(r.deactivated ? 'Siparişi olduğu için pasif yapıldı' : 'Silindi');
            onSaved();
          }}
        />
      )}
    </Modal>
  );
}
