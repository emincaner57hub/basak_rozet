import { useEffect, useState } from 'react';
import { api, type EdmSettings, type Settings, type User } from '../api';
import { getUser } from '../App';
import { Badge, ErrorLine, Field, Modal, Page, useLoad, useToast } from '../ui';

export function SettingsPage() {
  const me = getUser();
  return (
    <Page title="Ayarlar">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-4">
          <CompanyCard />
          {me?.role === 'admin' && <EdmCard />}
        </div>
        <div className="space-y-4">
          {me?.role === 'admin' && <UsersCard />}
          <PasswordCard />
        </div>
      </div>
    </Page>
  );
}

const FIELDS: [keyof Settings, string, boolean?][] = [
  ['companyName', 'Firma adı (kısa)'],
  ['companyLegalName', 'Tam firma ünvanı'],
  ['companyTaxOffice', 'Vergi dairesi'],
  ['companyTaxId', 'Vergi no / TCKN'],
  ['companyAddress', 'Adres', true],
  ['companyDistrict', 'İlçe'],
  ['companyCity', 'İl'],
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

/** EDM Bilişim e-Fatura web servisi bağlantısı */
function EdmCard() {
  const { data, error, reload } = useLoad(() => api.edmSettings(), []);
  const [f, setF] = useState<EdmSettings | null>(null);
  const [password, setPassword] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string; aliases?: { alias: string; unit: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setF(data), [data]);
  if (!f) return <ErrorLine error={error} />;
  const set = <K extends keyof EdmSettings>(k: K, v: EdmSettings[K]) => setF({ ...f, [k]: v });
  const save = async () => {
    await api.saveEdmSettings({ enabled: f.enabled, env: f.env, url: f.url, username: f.username, senderAlias: f.senderAlias, profile: f.profile, allowEarchive: f.allowEarchive, password: password || undefined });
    setPassword('');
    reload();
  };
  return (
    <div className="card p-5">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 font-semibold">EDM e-Fatura</h2>
        {f.enabled ? <Badge tone={f.env === 'prod' ? 'ok' : 'warn'}>{f.env === 'prod' ? 'Canlı' : 'Test'}</Badge> : <Badge>Kapalı</Badge>}
      </div>
      <p className="mb-4 text-xs text-muted">
        Faturalar Rozet'ten EDM'ye gönderilir (alıcı e-Fatura mükellefiyse e-Fatura, değilse e-Arşiv); EDM'de kesilenler Faturalar → “EDM'den al” ile içe alınır. Web servis kullanıcısını EDM'den isteyin; portal şifresi ile aynı olmayabilir.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Entegrasyon açık
        </label>
        <Field label="Ortam">
          <select className="input" value={f.env} onChange={(e) => set('env', e.target.value as EdmSettings['env'])}>
            <option value="test">Test (test.edmbilisim.com.tr)</option>
            <option value="prod">Canlı (portal2.edmbilisim.com.tr)</option>
          </select>
        </Field>
        <Field label="Fatura senaryosu" hint="e-Fatura mükellefleri için">
          <select className="input" value={f.profile} onChange={(e) => set('profile', e.target.value as EdmSettings['profile'])}>
            <option value="TEMELFATURA">Temel fatura</option>
            <option value="TICARIFATURA">Ticari fatura (alıcı kabul/red eder)</option>
          </select>
        </Field>
        <Field label="Web servis kullanıcı adı" hint={f.fromEnv.username ? 'Ortam değişkeninden (EDM_USERNAME)' : undefined}>
          <input className="input" value={f.username} disabled={f.fromEnv.username} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field label="Şifre" hint={f.fromEnv.password ? 'Ortam değişkeninden (EDM_PASSWORD)' : f.hasPassword ? 'Kayıtlı · değiştirmek için yazın' : undefined}>
          <input className="input" type="password" autoComplete="new-password" disabled={f.fromEnv.password} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={f.hasPassword ? '••••••••' : ''} />
        </Field>
        <Field label="Gönderici etiketi (GB)" className="col-span-2" hint="ör. urn:mail:defaultgb@firmaniz.com — “Bağlantıyı test et” firmanın etiketlerini listeler">
          <input className="input" value={f.senderAlias} onChange={(e) => set('senderAlias', e.target.value)} />
        </Field>
        <Field label="Özel servis adresi (boş: ortama göre)" className="col-span-2" hint={`Kullanılan: ${f.effectiveUrl}`}>
          <input className="input" value={f.url} disabled={f.fromEnv.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…/EFaturaEDM.svc" />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.allowEarchive} onChange={(e) => set('allowEarchive', e.target.checked)} /> e-Fatura mükellefi olmayan alıcılara e-Arşiv kes
        </label>
      </div>
      {test && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${test.ok ? 'border-line' : 'border-bad text-bad'}`}>
          {test.text}
          {test.aliases?.map((a) => (
            <div key={a.alias} className="flex items-center gap-2 text-xs">
              <Badge tone={a.unit === 'GB' ? 'brand' : 'muted'}>{a.unit || '?'}</Badge>
              <span className="font-mono">{a.alias}</span>
              {a.unit === 'GB' && a.alias !== f.senderAlias && (
                <button className="btn btn-sm" onClick={() => set('senderAlias', a.alias)}>
                  Kullan
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button
          className="btn btn-primary"
          onClick={async () => {
            try {
              await save();
              toast('Kaydedildi');
            } catch (e) {
              toast((e as Error).message, 'bad');
            }
          }}
        >
          Kaydet
        </button>
        <button
          className="btn"
          disabled={busy || !f.enabled}
          onClick={async () => {
            setBusy(true);
            try {
              await save();
              const r = await api.edmTest();
              setTest({
                ok: true,
                text: r.company ? (r.aliases.length ? `Giriş başarılı. ${r.company} için EDM etiketleri:` : `Giriş başarılı, ancak ${r.company} e-Fatura kayıtlı görünmüyor.`) : 'Giriş başarılı. Firma vergi no girilmemiş.',
                aliases: r.aliases,
              });
            } catch (e) {
              setTest({ ok: false, text: (e as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Deneniyor…' : 'Bağlantıyı test et'}
        </button>
      </div>
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
