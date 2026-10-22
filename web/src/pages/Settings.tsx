import { useEffect, useState } from 'react';
import { api, type Settings, type User } from '../api';
import { getUser } from '../App';
import { Badge, ErrorLine, Field, Modal, Page, useLoad, useToast } from '../ui';

export function SettingsPage() {
  const me = getUser();
  return (
    <Page title="Ayarlar">
      <div className="grid grid-cols-2 gap-4">
        <CompanyCard />
        <div className="space-y-4">
          {me?.role === 'admin' && <UsersCard />}
          <PasswordCard />
        </div>
      </div>
    </Page>
  );
}

const FIELDS: [keyof Settings, string, boolean?][] = [
  ['companyName', 'Görünen ad'],
  ['companyLegalName', 'Ticari ünvan'],
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
      <p className="mb-4 text-xs text-muted">İrsaliye ve fatura çıktılarının başında basılır.</p>
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
