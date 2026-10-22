import { useMemo, useState } from 'react';
import { api, KIND_LABEL, type Customer, type CustomerInput } from '../api';
import { Link, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, IntInput, Modal, MoneyInput, Page, SearchSelect, Stat, Tabs, useLoad, useToast } from '../ui';
import { formatTL, today, trDate } from '../money';
import { StatementView } from './Payments';
import { OrdersTable } from './Orders';

/** Müşteri listesi: zincirler şubeleriyle birlikte, tek kafeler ayrı */
export function CustomersPage() {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<Partial<Customer> | null>(null);
  const { data, error, reload } = useLoad(() => api.customers({ all }), [all]);
  const { go } = useNav();

  const rows = useMemo(() => {
    const list = data ?? [];
    const s = q.trim().toLocaleLowerCase('tr');
    const hit = (c: Customer) => !s || [c.name, c.code, c.taxId, c.city, c.parentName].some((x) => x?.toLocaleLowerCase('tr').includes(s));
    const top = list.filter((c) => c.kind !== 'branch');
    const out: { c: Customer; depth: number }[] = [];
    for (const t of top) {
      const kids = list.filter((b) => b.parentId === t.id);
      const anyKid = kids.some(hit);
      if (!hit(t) && !anyKid) continue;
      out.push({ c: t, depth: 0 });
      for (const k of kids) if (hit(k) || hit(t)) out.push({ c: k, depth: 1 });
    }
    return out;
  }, [data, q]);
  const stats = useMemo(() => {
    const l = data ?? [];
    return { chains: l.filter((c) => c.kind === 'chain').length, branches: l.filter((c) => c.kind === 'branch').length, singles: l.filter((c) => c.kind === 'single').length };
  }, [data]);

  return (
    <Page
      title="Müşteriler"
      subtitle={`${stats.chains} zincir · ${stats.branches} şube · ${stats.singles} tek kafe`}
      actions={
        <>
          <button className="btn" onClick={() => setEditing({ kind: 'chain' })}>
            + Zincir
          </button>
          <button className="btn" onClick={() => setEditing({ kind: 'single' })}>
            + Tek kafe
          </button>
          <button className="btn btn-primary" onClick={() => setEditing({ kind: 'branch' })}>
            + Şube
          </button>
        </>
      }
    >
      <ErrorLine error={error} />
      <div className="mb-3 flex items-center gap-3">
        <input className="input max-w-xs" placeholder="Ad, kod, vergi no, şehir…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Pasifleri göster
        </label>
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Müşteri</th>
              <th>Tür</th>
              <th>Fatura</th>
              <th>Şehir</th>
              <th>İletişim</th>
              <th className="text-right">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ c, depth }) => (
              <tr key={c.id} className={`clickable ${c.active ? '' : 'opacity-50'}`} onClick={() => go(`/musteriler/${c.id}`)}>
                <td className={depth ? 'pl-9' : ''}>
                  <div className={depth ? '' : 'font-semibold'}>
                    {depth ? '└ ' : ''}
                    {c.name}
                  </div>
                  {c.code && <div className="text-xs text-muted">{c.code}</div>}
                </td>
                <td>
                  <Badge tone={c.kind === 'chain' ? 'brand' : 'muted'}>{c.kind === 'branch' && c.billTo === 'self' ? 'Franchise' : KIND_LABEL[c.kind]}</Badge>
                  {c.kind === 'chain' && <span className="ml-1.5 text-xs text-muted">{c.branchCount} şube</span>}
                </td>
                <td className="text-xs text-muted">{c.billable ? (c.taxId ? `VKN ${c.taxId}` : <span className="text-warn">Vergi no eksik</span>) : 'Merkeze'}</td>
                <td className="text-sm">{c.city ?? '—'}</td>
                <td className="text-xs text-muted">{[c.contactName, c.phone].filter(Boolean).join(' · ') || '—'}</td>
                <td className={`tabular text-right ${c.balance && c.balance > 0 ? 'font-semibold' : 'text-muted'}`}>{c.billable ? formatTL(c.balance) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length && <Empty>Müşteri yok. Önce zinciri, sonra şubelerini ekleyin; zincirsiz kafeler için “+ Tek kafe”.</Empty>}
      </div>
      {editing && (
        <CustomerEditor
          initial={editing}
          chains={(data ?? []).filter((c) => c.kind === 'chain')}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            reload();
            go(`/musteriler/${id}`);
          }}
        />
      )}
    </Page>
  );
}

export function CustomerEditor({ initial, chains, onClose, onSaved }: { initial: Partial<Customer>; chains: Customer[]; onClose: () => void; onSaved: (id: number) => void }) {
  const [f, setF] = useState<CustomerInput>({
    code: initial.code ?? null,
    name: initial.name ?? '',
    kind: initial.kind ?? 'single',
    parentId: initial.parentId ?? null,
    billTo: initial.billTo ?? 'parent',
    legalName: initial.legalName ?? null,
    taxId: initial.taxId ?? null,
    taxOffice: initial.taxOffice ?? null,
    address: initial.address ?? null,
    city: initial.city ?? null,
    contactName: initial.contactName ?? null,
    phone: initial.phone ?? null,
    email: initial.email ?? null,
    paymentDays: initial.paymentDays ?? 30,
    openingBalance: initial.openingBalance ?? 0,
    openingDate: initial.openingDate ?? null,
    note: initial.note ?? null,
    active: initial.active ?? true,
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CustomerInput>(k: K, v: CustomerInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const txt = (k: 'code' | 'name' | 'legalName' | 'taxId' | 'taxOffice' | 'address' | 'city' | 'contactName' | 'phone' | 'email' | 'note') => (
    <input className="input" value={f[k] ?? ''} onChange={(e) => set(k, e.target.value || (k === 'name' ? '' : null))} />
  );
  const billable = f.kind !== 'branch' || f.billTo === 'self';
  async function save() {
    setBusy(true);
    setErr('');
    try {
      const r = await api.saveCustomer(initial.id ?? null, { ...f, billTo: f.kind === 'branch' ? f.billTo : 'self', parentId: f.kind === 'branch' ? f.parentId : null });
      onSaved(r.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial.id ? `${initial.name} · düzenle` : 'Yeni müşteri'}
      onClose={onClose}
      width={720}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !f.name.trim()}>
            Kaydet
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-2">
        {(['chain', 'branch', 'single'] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={!!initial.id && initial.kind === 'chain' && (initial.branchCount ?? 0) > 0 && k !== 'chain'}
            onClick={() => set('kind', k)}
            className={`rounded-xl border px-3 py-2.5 text-left text-sm ${f.kind === k ? 'border-brand bg-brand-soft' : 'border-line hover:bg-paper'} disabled:opacity-40`}
          >
            <div className="font-semibold">{KIND_LABEL[k]}</div>
            <div className="text-xs text-muted">{k === 'chain' ? 'Merkez firma; şubeleri altında' : k === 'branch' ? 'Bir zincirin şubesi / franchise' : 'Zincirsiz bağımsız kafe'}</div>
          </button>
        ))}
      </div>
      {f.kind === 'branch' && (
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl bg-paper p-3">
          <Field label="Bağlı olduğu zincir">
            <SearchSelect items={chains} value={f.parentId} onChange={(id) => set('parentId', id)} label={(c) => c.name} placeholder="Zincir seçin" ariaLabel="Zincir" />
          </Field>
          <div>
            <span className="label">Faturayı kim öder?</span>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ['parent', 'Merkez', 'Fatura zincire kesilir'],
                  ['self', 'Franchise', 'Kendi vergi no ile'],
                ] as const
              ).map(([v, l, s]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set('billTo', v)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-sm ${f.billTo === v ? 'border-brand bg-card' : 'border-line bg-card/60'}`}
                >
                  <div className="font-semibold">{l}</div>
                  <div className="text-[11px] text-muted">{s}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label={f.kind === 'branch' ? 'Şube adı *' : 'Ad *'} className="col-span-2">
          {txt('name')}
        </Field>
        <Field label="Kod" hint="Excel eşleştirmesi için (ör. KD-MODA)">
          {txt('code')}
        </Field>
        {billable && (
          <>
            <Field label="Ticari ünvan (faturada)" className="col-span-3">
              {txt('legalName')}
            </Field>
            <Field label="Vergi no / TCKN">{txt('taxId')}</Field>
            <Field label="Vergi dairesi">{txt('taxOffice')}</Field>
            <Field label="Vade (gün)">
              <IntInput value={f.paymentDays} onChange={(v) => set('paymentDays', v ?? 0)} />
            </Field>
          </>
        )}
        <Field label={f.kind === 'branch' ? 'Sevk adresi' : 'Adres'} className="col-span-2">
          {txt('address')}
        </Field>
        <Field label="Şehir">{txt('city')}</Field>
        <Field label="Yetkili">{txt('contactName')}</Field>
        <Field label="Telefon">{txt('phone')}</Field>
        <Field label="E-posta">{txt('email')}</Field>
        {billable && (
          <>
            <Field label="Açılış bakiyesi (müşteri bize borçlu +)" hint="Sisteme geçmeden önceki borç">
              <MoneyInput value={f.openingBalance || null} onChange={(v) => set('openingBalance', v ?? 0)} />
            </Field>
            <Field label="Açılış tarihi">
              <input type="date" className="input" value={f.openingDate ?? ''} onChange={(e) => set('openingDate', e.target.value || null)} />
            </Field>
          </>
        )}
        <Field label="Not" className="col-span-3">
          <textarea className="input" rows={2} value={f.note ?? ''} onChange={(e) => set('note', e.target.value || null)} />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Aktif
      </label>
    </Modal>
  );
}

type Tab = 'info' | 'orders' | 'statement' | 'prices' | 'promo';

export function CustomerPage({ id }: { id: number }) {
  const { data: c, error, reload } = useLoad(() => api.customer(id), [id]);
  const chains = useLoad(() => api.customers({ all: true }), []);
  const [tab, setTab] = useState<Tab>('info');
  const [editing, setEditing] = useState(false);
  const [newBranch, setNewBranch] = useState(false);
  const [del, setDel] = useState(false);
  const { go } = useNav();
  const toast = useToast();
  if (!c) return <Page title="…">{<ErrorLine error={error} />}</Page>;
  const billable = c.billable;
  const tabs: [Tab, string][] = [
    ['info', c.kind === 'chain' ? `Bilgiler ve şubeler (${c.branches.length})` : 'Bilgiler'],
    ['orders', 'Siparişler'],
    ...(billable ? ([['statement', 'Cari ekstre']] as [Tab, string][]) : []),
    ...(c.kind !== 'branch' ? ([['prices', 'Özel fiyatlar']] as [Tab, string][]) : []),
    ['promo', 'Stand / etiket giderleri'],
  ];
  return (
    <Page
      back={<Link to="/musteriler">‹ Müşteriler</Link>}
      title={
        <span className="flex items-center gap-2">
          {c.name}
          <Badge tone="brand">{c.kind === 'branch' && c.billTo === 'self' ? 'Franchise' : KIND_LABEL[c.kind]}</Badge>
          {!c.active && <Badge>Pasif</Badge>}
        </span>
      }
      subtitle={
        c.parentId ? (
          <>
            <Link to={`/musteriler/${c.parentId}`}>{c.parentName}</Link> şubesi · {c.billTo === 'parent' ? 'fatura merkeze kesilir' : 'kendi faturası'}
          </>
        ) : (
          c.legalName
        )
      }
      actions={
        <>
          {c.kind !== 'chain' && (
            <button className="btn btn-primary" onClick={() => go(`/siparisler/yeni?musteri=${c.id}`)}>
              + Sipariş
            </button>
          )}
          {c.kind === 'chain' && (
            <button className="btn btn-primary" onClick={() => setNewBranch(true)}>
              + Şube ekle
            </button>
          )}
          <button className="btn" onClick={() => setEditing(true)}>
            Düzenle
          </button>
          <button className="btn btn-danger" onClick={() => setDel(true)}>
            Sil
          </button>
        </>
      }
    >
      {billable && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          <Stat label="Cari bakiye" value={formatTL(c.balance)} tone={c.balance && c.balance > 0 ? 'warn' : undefined} sub="+ müşteri borçlu" />
          <Stat label="Vade" value={`${c.paymentDays} gün`} />
          <Stat label="Vergi no" value={c.taxId ?? '—'} sub={c.taxOffice ?? (c.taxId ? '' : 'Fatura için gerekli')} tone={c.taxId ? undefined : 'bad'} />
          <Stat label="Açılış" value={formatTL(c.openingBalance)} sub={c.openingDate ? trDate(c.openingDate) : 'tarih yok'} />
        </div>
      )}
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === 'info' && (
        <div className="grid grid-cols-3 gap-4">
          <div className="card p-4 text-sm">
            <h3 className="mb-2 font-semibold">İletişim</h3>
            <Info k="Kod" v={c.code} />
            <Info k="Yetkili" v={c.contactName} />
            <Info k="Telefon" v={c.phone} />
            <Info k="E-posta" v={c.email} />
            <Info k="Adres" v={[c.address, c.city].filter(Boolean).join(', ')} />
            {c.note && <Info k="Not" v={c.note} />}
          </div>
          {c.kind === 'chain' && (
            <div className="card col-span-2 overflow-hidden">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Şube</th>
                    <th>Fatura</th>
                    <th>Şehir</th>
                    <th className="text-right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {c.branches.map((b) => (
                    <tr key={b.id} className={`clickable ${b.active ? '' : 'opacity-50'}`} onClick={() => go(`/musteriler/${b.id}`)}>
                      <td>
                        <div className="font-medium">{b.name}</div>
                        <div className="text-xs text-muted">{b.code}</div>
                      </td>
                      <td>{b.billTo === 'self' ? <Badge tone="warn">Franchise · kendi faturası</Badge> : <Badge>Merkeze</Badge>}</td>
                      <td>{b.city ?? '—'}</td>
                      <td className="tabular text-right">{b.billTo === 'self' ? formatTL(b.balance) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!c.branches.length && <Empty>Şube yok. “+ Şube ekle” ile ekleyin.</Empty>}
            </div>
          )}
        </div>
      )}
      {tab === 'orders' && <CustomerOrders customerId={c.id} />}
      {tab === 'statement' && <StatementView customerId={c.id} />}
      {tab === 'prices' && <PricesView customerId={c.id} chainId={c.kind === 'chain' ? c.id : null} />}
      {tab === 'promo' && <PromoView customerId={c.id} isChain={c.kind === 'chain'} />}
      {editing && (
        <CustomerEditor
          initial={c}
          chains={(chains.data ?? []).filter((x) => x.kind === 'chain')}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      {newBranch && (
        <CustomerEditor
          initial={{ kind: 'branch', parentId: c.id, billTo: 'parent', city: c.city }}
          chains={(chains.data ?? []).filter((x) => x.kind === 'chain')}
          onClose={() => setNewBranch(false)}
          onSaved={() => {
            setNewBranch(false);
            reload();
          }}
        />
      )}
      {del && (
        <Confirm
          title="Müşteriyi sil"
          text="Belgesi olmayan müşteri silinir. Belgesi varsa pasif yapın."
          danger
          yes="Sil"
          onClose={() => setDel(false)}
          onYes={async () => {
            await api.deleteCustomer(c.id);
            toast('Müşteri silindi');
            go('/musteriler');
          }}
        />
      )}
    </Page>
  );
}

function Info({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="flex gap-2 border-b border-line/60 py-1.5 last:border-0">
      <span className="w-20 shrink-0 text-muted">{k}</span>
      <span>{v || '—'}</span>
    </div>
  );
}

function CustomerOrders({ customerId }: { customerId: number }) {
  const { data } = useLoad(() => api.orders({ status: 'all', customerId }), [customerId]);
  return <div className="card overflow-hidden">{data && <OrdersTable rows={data} />}</div>;
}

function PricesView({ customerId, chainId }: { customerId: number; chainId: number | null }) {
  const prices = useLoad(() => api.prices(customerId), [customerId]);
  const products = useLoad(() => api.products({ kind: 'sale' }), []);
  const [pid, setPid] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const toast = useToast();
  const visible = (products.data ?? []).filter((p) => !p.chainId || p.chainId === chainId || p.chainId === customerId);
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="card col-span-2 overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Ürün</th>
              <th className="text-right">Liste fiyatı</th>
              <th className="text-right">Özel fiyat</th>
              <th className="text-right">Fark</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prices.data?.map((p) => (
              <tr key={p.productId}>
                <td>
                  <span className="font-medium">{p.code}</span> {p.name}
                </td>
                <td className="tabular text-right text-muted">{formatTL(p.listPrice)}</td>
                <td className="tabular text-right font-semibold">{formatTL(p.price)}</td>
                <td className="tabular text-right text-xs">{p.listPrice ? `%${Math.round((p.price / p.listPrice - 1) * 100)}` : ''}</td>
                <td className="text-right">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      await api.setPrice(customerId, p.productId, null);
                      prices.reload();
                    }}
                  >
                    Kaldır
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {prices.data && !prices.data.length && <Empty>Özel fiyat yok; liste fiyatı geçerli. {chainId ? 'Burada girilen fiyat tüm şubelere uygulanır.' : ''}</Empty>}
      </div>
      <div className="card p-4">
        <h3 className="mb-3 font-semibold">Özel fiyat ekle / değiştir</h3>
        <Field label="Ürün" className="mb-3">
          <SearchSelect
            items={visible}
            value={pid}
            onChange={(id, p) => {
              setPid(id);
              setPrice(prices.data?.find((x) => x.productId === id)?.price ?? p?.listPrice ?? null);
            }}
            label={(p) => `${p.code} · ${p.name}`}
            sub={(p) => `Liste: ${formatTL(p.listPrice)}`}
          />
        </Field>
        <Field label="Fiyat (KDV hariç)" className="mb-3">
          <MoneyInput value={price} onChange={setPrice} />
        </Field>
        <button
          className="btn btn-primary w-full"
          disabled={!pid || price == null}
          onClick={async () => {
            try {
              await api.setPrice(customerId, pid!, price);
              toast('Fiyat kaydedildi');
              setPid(null);
              setPrice(null);
              prices.reload();
            } catch (e) {
              toast((e as Error).message, 'bad');
            }
          }}
        >
          Kaydet
        </button>
        <p className="mt-3 text-xs text-muted">Şubeye özel fiyat şube sayfasından değil, zincirden verilir; zincirin fiyatı tüm şubelerinde geçerlidir.</p>
      </div>
    </div>
  );
}

function PromoView({ customerId, isChain }: { customerId: number; isChain: boolean }) {
  const { data, reload } = useLoad(() => api.promoExpenses(customerId), [customerId]);
  const [date, setDate] = useState(today());
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const toast = useToast();
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="card col-span-2 overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              {isChain && <th>Şube</th>}
              <th>Açıklama</th>
              <th className="text-right">Tutar</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id}>
                <td>{trDate(e.date)}</td>
                {isChain && <td>{e.customerName}</td>}
                <td>{e.description}</td>
                <td className="tabular text-right">{formatTL(e.amount)}</td>
                <td className="text-right">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      await api.deletePromoExpense(e.id);
                      reload();
                    }}
                  >
                    Sil
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Elle girilmiş gider yok. Stoktan verilen stand ve etiketler irsaliyeden otomatik gider yazılır.</Empty>}
      </div>
      <div className="card p-4">
        <h3 className="mb-1 font-semibold">Gider ekle</h3>
        <p className="mb-3 text-xs text-muted">Stoktan çıkmayan, bu müşteri için yapılan masraf: özel etiket baskısı, stand üretimi, montaj…</p>
        <Field label="Tarih" className="mb-2">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Açıklama" className="mb-2">
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label="Tutar (KDV hariç)" className="mb-3">
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <button
          className="btn btn-primary w-full"
          disabled={!desc.trim() || !amount}
          onClick={async () => {
            try {
              await api.createPromoExpense({ customerId, date, description: desc.trim(), amount: amount! });
              setDesc('');
              setAmount(null);
              reload();
              toast('Gider eklendi');
            } catch (e) {
              toast((e as Error).message, 'bad');
            }
          }}
        >
          Ekle
        </button>
      </div>
    </div>
  );
}
