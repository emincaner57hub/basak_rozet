import { useMemo, useState } from 'react';
import { api, type Product, type ProductInput } from '../api';
import { Link, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, IntInput, Modal, MoneyInput, Page, SearchSelect, Stat, Tabs, useLoad, useToast } from '../ui';
import { fmtNum, fmtPct, formatTL, formatUnit, today, trDate } from '../money';

export function ProductsPage() {
  const [tab, setTab] = useState<'sale' | 'promo'>('sale');
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const { data, error, reload } = useLoad(() => api.products({ all }), [all]);
  const { go } = useNav();
  const rows = useMemo(() => {
    const s = q.trim().toLocaleLowerCase('tr');
    return (data ?? []).filter((p) => p.kind === tab && (!s || `${p.code} ${p.name} ${p.category ?? ''} ${p.chainName ?? ''}`.toLocaleLowerCase('tr').includes(s)));
  }, [data, q, tab]);
  const value = rows.reduce((s, p) => s + Math.max(p.onHand, 0) * (p.avgCost ?? 0), 0);
  const low = rows.filter((p) => p.minQty != null && p.onHand <= p.minQty).length;
  return (
    <Page
      title="Ürünler ve stok"
      subtitle="Rozet tasarımları ve müşteriye verilen promosyon malzemeleri (stand, etiket)"
      actions={
        <button className="btn btn-primary" onClick={() => setEditing({ kind: tab })}>
          + {tab === 'sale' ? 'Rozet' : 'Promosyon malzemesi'}
        </button>
      }
    >
      <ErrorLine error={error} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['sale', `Rozetler (${(data ?? []).filter((p) => p.kind === 'sale').length})`],
          ['promo', `Stand, etiket… (${(data ?? []).filter((p) => p.kind === 'promo').length})`],
        ]}
      />
      <div className="mb-3 flex items-center gap-3">
        <input className="input max-w-xs" placeholder="Kod, ad, kategori…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Pasifler
        </label>
        <span className="ml-auto text-sm text-muted">
          Stok değeri <b className="text-ink">{formatTL(value)}</b>
          {low > 0 && <span className="ml-3 font-semibold text-warn">{low} üründe stok kritik</span>}
        </span>
      </div>
      {tab === 'sale' && (
        <p className="mb-2 text-sm text-muted">
          <b>Satılabilir</b> işaretli rozetler müşterinin satın almacısına cepte (portal) görünür. Fiyat: müşteriye özel fiyat (şube → zincir), yoksa liste
          fiyatı; ikisi de yoksa ürün görünür ama sipariş verilemez.
        </p>
      )}
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-12" />
              <th>Ürün</th>
              {tab === 'sale' && <th title="Müşteri cepten sipariş verebilir">Satılabilir</th>}
              {tab === 'sale' && <th className="text-right">Liste fiyatı</th>}
              <th className="text-right">Ort. maliyet</th>
              {tab === 'sale' && <th className="text-right">Marj</th>}
              <th className="text-right">Stok</th>
              <th className="text-right">Yolda</th>
              <th className="text-right">Bekleyen sipariş</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const lowStock = p.minQty != null && p.onHand <= p.minQty;
              return (
                <tr key={p.id} className={`clickable ${p.active ? '' : 'opacity-50'}`} onClick={() => go(`/urunler/${p.id}`)}>
                  <td>{p.image ? <img src={p.image} alt="" className="h-9 w-9 rounded-md object-cover" /> : <div className="h-9 w-9 rounded-md bg-paper" />}</td>
                  <td>
                    <div className="font-medium">
                      {p.code} <span className="font-normal">{p.name}</span>
                    </div>
                    <div className="flex gap-1.5 text-xs text-muted">
                      {p.category}
                      {p.chainName && <Badge tone="brand">Özel: {p.chainName}</Badge>}
                    </div>
                  </td>
                  {tab === 'sale' && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={p.sellable}
                          onChange={async (e) => {
                            await api.setSellable(p.id, e.target.checked);
                            reload();
                          }}
                        />
                        {p.sellable ? <span className="text-ok">cepte açık</span> : <span className="text-muted">kapalı</span>}
                        {p.sellable && p.listPrice == null && <span className="text-warn" title="Liste fiyatı yok: yalnız özel fiyatı olan müşteriler sipariş verebilir">· fiyat?</span>}
                      </label>
                    </td>
                  )}
                  {tab === 'sale' && <td className="tabular text-right">{formatTL(p.listPrice)}</td>}
                  <td className="tabular text-right text-muted">{formatUnit(p.avgCost)}</td>
                  {tab === 'sale' && <td className="tabular text-right">{p.listPrice && p.avgCost ? fmtPct(1 - p.avgCost / p.listPrice) : '—'}</td>}
                  <td className={`tabular text-right font-semibold ${p.onHand < 0 ? 'text-bad' : lowStock ? 'text-warn' : ''}`}>
                    {fmtNum(p.onHand)}
                    {p.minQty != null && <div className="text-[11px] font-normal text-muted">min {p.minQty}</div>}
                  </td>
                  <td className="tabular text-right text-muted">{p.onOrder ? fmtNum(p.onOrder) : '—'}</td>
                  <td className={`tabular text-right ${p.committed > p.onHand ? 'font-semibold text-warn' : 'text-muted'}`}>{p.committed ? fmtNum(p.committed) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !rows.length && <Empty>{tab === 'sale' ? 'Rozet yok. “+ Rozet” ile ekleyin.' : 'Stand, etiket gibi satılmayıp müşteriye verilen malzemeleri buraya ekleyin.'}</Empty>}
      </div>
      {editing && (
        <ProductEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            reload();
            go(`/urunler/${id}`);
          }}
        />
      )}
    </Page>
  );
}

/** Görseli küçültüp data URL yapar (veritabanında saklanır) */
async function shrink(file: File, max = 320): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.85);
}

export function ProductEditor({ initial, onClose, onSaved }: { initial: Partial<Product>; onClose: () => void; onSaved: (id: number) => void }) {
  const customers = useLoad(() => api.customers(), []);
  const [f, setF] = useState<ProductInput>({
    code: initial.code ?? '',
    name: initial.name ?? '',
    kind: initial.kind ?? 'sale',
    category: initial.category ?? null,
    description: initial.description ?? null,
    unit: initial.unit ?? 'adet',
    vatRate: initial.vatRate ?? 20,
    listPrice: initial.listPrice ?? null,
    chainId: initial.chainId ?? null,
    minQty: initial.minQty ?? null,
    image: initial.image ?? null,
    active: initial.active ?? true,
    sellable: initial.sellable ?? true,
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const owners = (customers.data ?? []).filter((c) => c.kind !== 'branch');
  return (
    <Modal
      title={initial.id ? `${initial.code} · düzenle` : f.kind === 'sale' ? 'Yeni rozet' : 'Yeni promosyon malzemesi'}
      onClose={onClose}
      width={640}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn btn-primary"
            disabled={!f.code.trim() || !f.name.trim()}
            onClick={async () => {
              try {
                onSaved((await api.saveProduct(initial.id ?? null, f)).id);
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
      <div className="flex gap-4">
        <label className="flex h-32 w-32 shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-line bg-paper text-xs text-muted">
          {f.image ? <img src={f.image} alt="" className="h-full w-full object-cover" /> : 'Görsel ekle'}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) set('image', await shrink(file));
            }}
          />
        </label>
        <div className="grid flex-1 grid-cols-3 gap-3">
          <Field label="Kod *">
            <input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="R-001" />
          </Field>
          <Field label="Ad *" className="col-span-2">
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Kategori">
            <input className="input" value={f.category ?? ''} onChange={(e) => set('category', e.target.value || null)} />
          </Field>
          {f.kind === 'sale' && (
            <Field label="Liste fiyatı (KDV hariç)">
              <MoneyInput value={f.listPrice} onChange={(v) => set('listPrice', v)} />
            </Field>
          )}
          <Field label="KDV %">
            <IntInput value={f.vatRate} onChange={(v) => set('vatRate', v ?? 0)} />
          </Field>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {f.kind === 'sale' && (
          <Field label="Özel tasarım (yalnız bu müşteri görür)" className="col-span-2">
            <SearchSelect items={owners} value={f.chainId} onChange={(id) => set('chainId', id)} label={(c) => c.name} placeholder="Herkese açık" />
          </Field>
        )}
        <Field label="Kritik stok (min)">
          <IntInput value={f.minQty} onChange={(v) => set('minQty', v)} />
        </Field>
        <Field label="Açıklama" className="col-span-3">
          <textarea className="input" rows={2} value={f.description ?? ''} onChange={(e) => set('description', e.target.value || null)} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Aktif
        </label>
        {f.kind === 'sale' && (
          <label className="flex items-center gap-2" title="İşaretliyse müşterinin satın almacısı cepten bu ürüne sipariş verebilir">
            <input type="checkbox" checked={f.sellable} onChange={(e) => set('sellable', e.target.checked)} /> Satılabilir (müşteri cepten sipariş verebilir)
          </label>
        )}
        {f.chainId && <button className="text-brand" onClick={() => set('chainId', null)}>Özel tasarımı kaldır</button>}
        {f.image && (
          <button className="text-bad" onClick={() => set('image', null)}>
            Görseli kaldır
          </button>
        )}
      </div>
      {f.kind === 'promo' && <p className="mt-3 text-xs text-muted">Promosyon malzemesi satılmaz: irsaliyeye 0 ₺ ile eklenir, maliyeti o müşterinin promosyon giderine yazılır.</p>}
    </Modal>
  );
}

export function ProductPage({ id }: { id: number }) {
  const products = useLoad(() => api.products({ all: true }), []);
  const moves = useLoad(() => api.productMoves(id), [id]);
  const [editing, setEditing] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [del, setDel] = useState<'product' | number | null>(null);
  const { go } = useNav();
  const p = products.data?.find((x) => x.id === id);
  if (!p) return <Page title="…">{<ErrorLine error={products.error} />}</Page>;
  const reload = () => {
    products.reload();
    moves.reload();
  };
  return (
    <Page
      back={<Link to="/urunler">‹ Ürünler</Link>}
      title={
        <span className="flex items-center gap-3">
          {p.image && <img src={p.image} alt="" className="h-10 w-10 rounded-lg object-cover" />}
          {p.code} · {p.name}
          {p.kind === 'promo' && <Badge tone="brand">Promosyon</Badge>}
          {!p.active && <Badge>Pasif</Badge>}
        </span>
      }
      subtitle={[p.category, p.chainName && `Özel tasarım: ${p.chainName}`].filter(Boolean).join(' · ')}
      actions={
        <>
          <button className="btn" onClick={() => setAdjust(true)}>
            Sayım / düzeltme
          </button>
          <button className="btn" onClick={() => setEditing(true)}>
            Düzenle
          </button>
          <button className="btn btn-danger" onClick={() => setDel('product')}>
            Sil
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-5 gap-3">
        <Stat label="Stok" value={fmtNum(p.onHand)} tone={p.onHand < 0 ? 'bad' : p.minQty != null && p.onHand <= p.minQty ? 'warn' : undefined} sub={p.minQty != null ? `min ${p.minQty}` : undefined} />
        <Stat label="Ortalama maliyet" value={formatUnit(p.avgCost)} sub="gümrük ve masraflar dahil" />
        <Stat label="Stok değeri" value={formatTL(Math.max(p.onHand, 0) * (p.avgCost ?? 0))} />
        <Stat label="Yolda" value={fmtNum(p.onOrder)} sub="teslim alınmamış partiler" />
        {p.kind === 'sale' ? <Stat label="Liste fiyatı" value={formatTL(p.listPrice)} sub={p.listPrice && p.avgCost ? `marj ${fmtPct(1 - p.avgCost / p.listPrice)}` : undefined} /> : <Stat label="Bekleyen" value={fmtNum(p.committed)} />}
      </div>
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Hareket</th>
              <th>Belge</th>
              <th className="text-right">Miktar</th>
              <th className="text-right">Birim maliyet</th>
              <th className="text-right">Bakiye</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {moves.data?.map((m) => (
              <tr key={m.id}>
                <td>{trDate(m.date)}</td>
                <td>{m.kind === 'lot' ? 'Alım' : m.kind === 'dispatch' ? (m.isPromo ? 'Promosyon çıkışı' : 'Satış (irsaliye)') : 'Sayım / düzeltme'}</td>
                <td className="text-sm">
                  {m.lotId && <Link to={`/alimlar/${m.lotId}`}>{m.lotNo}</Link>}
                  {m.lotId && m.supplierName && <span className="text-muted"> · {m.supplierName}</span>}
                  {m.dispatchId && <Link to={`/sevkiyat/${m.dispatchId}`}>{m.dispatchNo}</Link>}
                  {m.dispatchId && <span className="text-muted"> · {m.customerName}</span>}
                  {m.note && <span className="text-muted">{m.note}</span>}
                </td>
                <td className={`tabular text-right font-medium ${m.qty < 0 ? 'text-bad' : 'text-ok'}`}>
                  {m.qty > 0 ? '+' : ''}
                  {fmtNum(m.qty)}
                </td>
                <td className="tabular text-right text-muted">{formatUnit(m.unitCost)}</td>
                <td className="tabular text-right">{fmtNum(m.balance)}</td>
                <td className="w-16 text-right">
                  {m.kind === 'adjust' && (
                    <button className="btn btn-sm btn-danger" onClick={() => setDel(m.id)}>
                      Sil
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {moves.data && !moves.data.length && <Empty>Hareket yok. Alımlar bölümünden parti girip teslim alınca stok oluşur; açılış stoğu için “Sayım / düzeltme”.</Empty>}
      </div>
      {editing && (
        <ProductEditor
          initial={p}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      {adjust && <AdjustDialog productId={p.id} onHand={p.onHand} avgCost={p.avgCost} onClose={() => setAdjust(false)} onSaved={reload} />}
      {del && (
        <Confirm
          title={del === 'product' ? 'Ürünü sil' : 'Hareketi sil'}
          text={del === 'product' ? 'Belgede kullanılmamış ürün silinir; kullanılmışsa pasif yapın.' : 'Elle girilen hareket silinir, maliyet yeniden hesaplanır.'}
          danger
          yes="Sil"
          onClose={() => setDel(null)}
          onYes={async () => {
            if (del === 'product') {
              await api.deleteProduct(p.id);
              go('/urunler');
            } else {
              await api.deleteMove(del);
              reload();
            }
          }}
        />
      )}
    </Page>
  );
}

function AdjustDialog({ productId, onHand, avgCost, onClose, onSaved }: { productId: number; onHand: number; avgCost: number | null; onClose: () => void; onSaved: () => void }) {
  const [counted, setCounted] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(avgCost != null ? Math.round(avgCost) : null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const delta = counted == null ? 0 : counted - onHand;
  return (
    <Modal
      title="Sayım / stok düzeltme"
      onClose={onClose}
      width={460}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button
            className="btn btn-primary"
            disabled={counted == null || !delta}
            onClick={async () => {
              try {
                await api.adjustStock(productId, { date, counted: counted!, unitCost: delta > 0 ? cost : null, note: note || null });
                toast(`Stok ${delta > 0 ? '+' : ''}${delta} düzeltildi`);
                onSaved();
                onClose();
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
      <p className="mb-3 text-sm text-muted">
        Sistemdeki stok: <b className="text-ink">{fmtNum(onHand)}</b>. Saydığınız miktarı girin; fark hareket olarak yazılır.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sayılan miktar">
          <IntInput value={counted} onChange={setCounted} />
        </Field>
        <Field label="Tarih">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {delta > 0 && (
          <Field label="Giriş birim maliyeti" className="col-span-2" hint="Açılış stoğunda bilinen alış maliyeti; boşsa ortalama maliyet">
            <MoneyInput value={cost} onChange={setCost} />
          </Field>
        )}
        <Field label="Not" className="col-span-2">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ör. açılış stoğu, fire" />
        </Field>
      </div>
      {counted != null && <p className={`mt-3 text-sm font-medium ${delta < 0 ? 'text-bad' : 'text-ok'}`}>Fark: {delta > 0 ? '+' : ''}{fmtNum(delta)}</p>}
    </Modal>
  );
}
