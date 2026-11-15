import { useEffect, useMemo, useState } from 'react';
import { api, COST_LABEL, LOT_KIND, SUPPLIER_KIND, COST_TYPE_LABEL, type CostType, type LotDetail, type LotInput, type Supplier } from '../api';
import { Link, useNav } from '../router';
import { Badge, Confirm, Empty, ErrorLine, Field, IntInput, Modal, MoneyInput, Page, SearchSelect, Stat, useLoad, useToast } from '../ui';
import { decText, fmtNum, formatTL, formatUnit, parseDec, today, trDate } from '../money';

export function LotsPage() {
  const { data, error } = useLoad(() => api.lots(), []);
  const [suppliers, setSuppliers] = useState(false);
  const { go } = useNav();
  const transit = (data ?? []).filter((l) => l.status === 'ordered');
  return (
    <Page
      title="Alımlar"
      subtitle="Çin ithalatı, Temu / bavul ve yerel alım partileri; gümrük, broker ve kargo masrafları ürün maliyetine dağıtılır"
      actions={
        <>
          <button className="btn" onClick={() => setSuppliers(true)}>
            Tedarikçiler
          </button>
          <button className="btn btn-primary" onClick={() => go('/alimlar/yeni')}>
            + Yeni parti
          </button>
        </>
      }
    >
      <ErrorLine error={error} />
      {transit.length > 0 && (
        <p className="mb-3 text-sm text-muted">
          <b className="text-ink">{transit.length}</b> parti yolda · {fmtNum(transit.reduce((s, l) => s + l.qty, 0))} adet
        </p>
      )}
      <div className="card overflow-hidden">
        <table className="tbl">
          <thead>
            <tr>
              <th>Parti</th>
              <th>Tarih</th>
              <th>Tedarikçi</th>
              <th>Tür</th>
              <th className="text-right">Adet</th>
              <th className="text-right">Mal bedeli</th>
              <th className="text-right">Masraflar</th>
              <th className="text-right">Toplam maliyet</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => go(`/alimlar/${l.id}`)}>
                <td className="whitespace-nowrap font-medium">{l.no}</td>
                <td>{trDate(l.date)}</td>
                <td>{l.supplierName ?? '—'}</td>
                <td className="text-xs">
                  {LOT_KIND[l.kind]}
                  {l.currency !== 'TRY' && (
                    <div className="text-muted">
                      {l.currency} · kur {decText(l.fxRate)}
                    </div>
                  )}
                </td>
                <td className="tabular text-right">{fmtNum(l.qty)}</td>
                <td className="tabular text-right">{formatTL(l.goods)}</td>
                <td className="tabular text-right">{formatTL(l.extra)}</td>
                <td className="tabular text-right font-medium">
                  {formatTL(l.landed)}
                  {l.qty > 0 && <div className="text-[11px] font-normal text-muted">ort. {formatUnit(l.landed / l.qty)} / adet</div>}
                </td>
                <td>{l.status === 'received' ? <Badge tone="ok">Teslim {trDate(l.receivedDate)}</Badge> : <Badge tone="warn">Yolda{l.expectedDate ? ` · ${trDate(l.expectedDate)}` : ''}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Alım partisi yok.</Empty>}
      </div>
      {suppliers && <SuppliersDialog onClose={() => setSuppliers(false)} />}
    </Page>
  );
}

function SuppliersDialog({ onClose }: { onClose: () => void }) {
  const { data, reload } = useLoad(() => api.suppliers(), []);
  const [edit, setEdit] = useState<Partial<Supplier> | null>(null);
  return (
    <Modal title="Tedarikçiler" onClose={onClose} width={640}>
      <table className="tbl mb-3">
        <tbody>
          {data?.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => setEdit(s)}>
              <td className="font-medium">{s.name}</td>
              <td className="text-xs text-muted">
                {SUPPLIER_KIND[s.kind]} · {COST_TYPE_LABEL[s.costType]}
              </td>
              <td className="text-xs text-muted">{[s.contactName, s.phone, s.contact].filter(Boolean).join(' · ')}</td>
              <td className="text-right text-xs">{s.lotCount} parti</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit ? (
        <SupplierForm
          initial={edit}
          onDone={() => {
            setEdit(null);
            reload();
          }}
        />
      ) : (
        <button className="btn" onClick={() => setEdit({ kind: 'china' })}>
          + Tedarikçi
        </button>
      )}
    </Modal>
  );
}

function SupplierForm({ initial, onDone }: { initial: Partial<Supplier>; onDone: () => void }) {
  const [name, setName] = useState(initial.name ?? '');
  const [kind, setKind] = useState<Supplier['kind']>(initial.kind ?? 'china');
  const [contact, setContact] = useState(initial.contact ?? '');
  const [costType, setCostType] = useState<Supplier['costType']>(initial.costType ?? 'direct');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [contactName, setContactName] = useState(initial.contactName ?? '');
  const [err, setErr] = useState('');
  return (
    <div className="rounded-xl bg-paper p-3">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Ad">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Tür">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Supplier['kind'])}>
            {(Object.keys(SUPPLIER_KIND) as Supplier['kind'][]).map((k) => (
              <option key={k} value={k}>
                {SUPPLIER_KIND[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Maliyet türü">
          <select className="input" value={costType} onChange={(e) => setCostType(e.target.value as Supplier['costType'])}>
            {(Object.keys(COST_TYPE_LABEL) as Supplier['costType'][]).map((k) => (
              <option key={k} value={k}>
                {COST_TYPE_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Yetkili kişi">
          <input className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Telefon">
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Diğer iletişim">
          <input className="input" value={contact} placeholder="e-posta, WeChat…" onChange={(e) => setContact(e.target.value)} />
        </Field>
      </div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn btn-sm" onClick={onDone}>
          Vazgeç
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={!name.trim()}
          onClick={async () => {
            try {
              await api.saveSupplier(initial.id ?? null, {
                name,
                kind,
                contact: contact || null,
                costType,
                phone: phone || null,
                contactName: contactName || null,
                note: initial.note ?? null,
                active: initial.active ?? true,
              });
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Kaydet
        </button>
      </div>
    </div>
  );
}

type L = { key: number; productId: number | null; qty: number | null; price: string };
type C = { key: number; type: CostType; description: string; amount: number | null; supplierId: number | null };
let n = 1;

/** Parti formu ve detayı: kalemler + masraflar + canlı maliyet dağıtımı */
export function LotPage({ id }: { id: number | null }) {
  const { go } = useNav();
  const toast = useToast();
  const products = useLoad(() => api.products(), []);
  const suppliers = useLoad(() => api.suppliers(), []);
  const [lot, setLot] = useState<LotDetail | null>(null);
  const [h, setH] = useState({ date: today(), supplierId: null as number | null, kind: 'import' as LotInput['kind'], currency: 'USD' as LotInput['currency'], fx: '', allocation: 'value' as LotInput['allocation'], expectedDate: '', note: '' });
  const [lines, setLines] = useState<L[]>([{ key: n++, productId: null, qty: null, price: '' }]);
  const [costs, setCosts] = useState<C[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [receive, setReceive] = useState(false);
  const [confirm, setConfirm] = useState<'unreceive' | 'delete' | null>(null);

  const load = (d: LotDetail) => {
    setLot(d);
    setH({ date: d.date, supplierId: d.supplierId, kind: d.kind, currency: d.currency, fx: decText(d.fxRate), allocation: d.allocation, expectedDate: d.expectedDate ?? '', note: d.note ?? '' });
    setLines(d.lines.map((l) => ({ key: n++, productId: l.productId, qty: l.qty, price: decText(l.unitPriceFx) })));
    setCosts(d.costs.map((c) => ({ key: n++, type: c.type, description: c.description ?? '', amount: c.amount, supplierId: c.supplierId })));
  };
  useEffect(() => {
    if (id) api.lot(id).then(load, (e) => setErr(e.message));
  }, [id]);

  const fx = h.currency === 'TRY' ? 1 : (parseDec(h.fx) ?? 0);
  const calc = useMemo(() => {
    const rows = lines.map((l) => ({ ...l, goods: (l.qty ?? 0) * (parseDec(l.price) ?? 0) * fx * 100 }));
    const goods = rows.reduce((s, r) => s + r.goods, 0);
    const qty = rows.reduce((s, r) => s + (r.qty ?? 0), 0);
    const extra = costs.filter((c) => c.type !== 'import_vat').reduce((s, c) => s + (c.amount ?? 0), 0);
    const vat = costs.filter((c) => c.type === 'import_vat').reduce((s, c) => s + (c.amount ?? 0), 0);
    const byValue = h.allocation === 'value' && goods > 0;
    const per = rows.map((r) => {
      const share = byValue ? r.goods / goods : qty ? (r.qty ?? 0) / qty : 0;
      const add = extra * share;
      return { key: r.key, goods: r.goods, extra: add, unit: r.qty ? (r.goods + add) / r.qty : null };
    });
    return { goods, extra, vat, qty, per: new Map(per.map((p) => [p.key, p])) };
  }, [lines, costs, fx, h.allocation]);

  const valid = lines.some((l) => l.productId && l.qty) && lines.every((l) => !l.productId || (l.qty && parseDec(l.price) != null)) && fx > 0;
  async function save() {
    setBusy(true);
    setErr('');
    try {
      const body: LotInput = {
        date: h.date,
        supplierId: h.supplierId,
        kind: h.kind,
        currency: h.currency,
        fxRate: fx,
        allocation: h.allocation,
        expectedDate: h.expectedDate || null,
        note: h.note || null,
        lines: lines.filter((l) => l.productId && l.qty).map((l) => ({ productId: l.productId!, qty: l.qty!, unitPriceFx: parseDec(l.price) ?? 0 })),
        costs: costs.filter((c) => c.amount).map((c) => ({ type: c.type, description: c.description || null, amount: c.amount!, supplierId: c.supplierId, date: null })),
      };
      const r = await api.saveLot(id, body);
      toast(lot?.status === 'received' ? 'Kaydedildi; stok maliyetleri yeniden hesaplandı' : 'Parti kaydedildi');
      if (!id) go(`/alimlar/${r.id}`);
      else load(await api.lot(id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const prodList = products.data ?? [];
  const cur = h.currency === 'TRY' ? '₺' : h.currency;
  return (
    <Page
      back={<Link to="/alimlar">‹ Alımlar</Link>}
      title={
        lot ? (
          <span className="flex items-center gap-2">
            {lot.no} {lot.status === 'received' ? <Badge tone="ok">Teslim alındı · {trDate(lot.receivedDate)}</Badge> : <Badge tone="warn">Yolda</Badge>}
          </span>
        ) : (
          'Yeni alım partisi'
        )
      }
      subtitle={lot?.status === 'received' ? 'Teslim alınmış partide yapılan değişiklik (ör. sonradan gelen broker faturası) stok ve satılan malın maliyetini günceller.' : undefined}
      actions={
        lot && (
          <>
            {lot.status === 'ordered' ? (
              <button className="btn btn-primary" onClick={() => setReceive(true)}>
                Teslim al (stoka gir)
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirm('unreceive')}>
                Teslimi geri al
              </button>
            )}
            {lot.status === 'ordered' && (
              <button className="btn btn-danger" onClick={() => setConfirm('delete')}>
                Sil
              </button>
            )}
          </>
        )
      }
    >
      <div className="card mb-4 grid grid-cols-6 gap-3 p-4">
        <Field label="Tarih">
          <input type="date" className="input" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} />
        </Field>
        <Field label="Tür">
          <select
            className="input"
            value={h.kind}
            onChange={(e) => {
              const kind = e.target.value as LotInput['kind'];
              setH({ ...h, kind, currency: kind === 'import' ? h.currency : 'TRY', allocation: kind === 'import' ? 'value' : h.allocation });
            }}
          >
            {(Object.keys(LOT_KIND) as LotInput['kind'][]).map((k) => (
              <option key={k} value={k}>
                {LOT_KIND[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tedarikçi" className="col-span-2">
          <SearchSelect items={suppliers.data ?? []} value={h.supplierId} onChange={(sid) => setH({ ...h, supplierId: sid })} label={(s) => s.name} sub={(s) => SUPPLIER_KIND[s.kind]} />
        </Field>
        <Field label="Para birimi">
          <select className="input" value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value as LotInput['currency'] })}>
            {['USD', 'CNY', 'EUR', 'TRY'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label={h.currency === 'TRY' ? 'Kur' : `Kur (1 ${h.currency} = ₺)`}>
          <input className="input tabular text-right" disabled={h.currency === 'TRY'} value={h.currency === 'TRY' ? '1' : h.fx} onChange={(e) => setH({ ...h, fx: e.target.value })} placeholder="34,25" />
        </Field>
        <Field label="Beklenen teslim">
          <input type="date" className="input" value={h.expectedDate} onChange={(e) => setH({ ...h, expectedDate: e.target.value })} />
        </Field>
        <Field label="Masraf dağıtımı" className="col-span-2">
          <select className="input" value={h.allocation} onChange={(e) => setH({ ...h, allocation: e.target.value as LotInput['allocation'] })}>
            <option value="value">Mal değerine göre (pahalı ürün daha çok masraf alır)</option>
            <option value="qty">Adede göre (her adet eşit)</option>
          </select>
        </Field>
        <Field label="Not" className="col-span-3">
          <input className="input" value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} placeholder="ör. sipariş no, AWB" />
        </Field>
      </div>

      <h3 className="mb-2 text-sm font-semibold">Ürünler</h3>
      <div className="card mb-4 overflow-visible">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '34%' }}>Ürün</th>
              <th className="w-28 text-right">Adet</th>
              <th className="w-32 text-right">Birim fiyat ({cur})</th>
              <th className="text-right">Mal bedeli (₺)</th>
              <th className="text-right">Dağıtılan masraf</th>
              <th className="text-right">Birim gerçek maliyet</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const c = calc.per.get(l.key);
              const used = new Set(lines.filter((x) => x.key !== l.key).map((x) => x.productId));
              return (
                <tr key={l.key}>
                  <td>
                    <SearchSelect
                      items={prodList.filter((p) => !used.has(p.id))}
                      value={l.productId}
                      onChange={(pid) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, productId: pid } : x)))}
                      label={(p) => `${p.code} · ${p.name}`}
                      sub={(p) => (p.kind === 'promo' ? 'Promosyon malzemesi' : `stok ${fmtNum(p.onHand)}`)}
                      filter={(p, s) => `${p.code} ${p.name}`.toLocaleLowerCase('tr').includes(s)}
                    />
                  </td>
                  <td>
                    <IntInput value={l.qty} onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: v } : x)))} ariaLabel="Adet" />
                  </td>
                  <td>
                    <input
                      className={`input tabular text-right ${l.price && parseDec(l.price) == null ? 'border-bad' : ''}`}
                      value={l.price}
                      inputMode="decimal"
                      aria-label="Birim fiyat"
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, price: e.target.value } : x)))}
                    />
                  </td>
                  <td className="tabular text-right">{formatTL(c?.goods)}</td>
                  <td className="tabular text-right text-muted">{formatTL(c?.extra)}</td>
                  <td className="tabular text-right font-semibold">{formatUnit(c?.unit)}</td>
                  <td className="w-10 text-right">
                    <button className="px-1 text-lg text-bad" aria-label="Satırı sil" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="p-3">
          <button className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { key: n++, productId: null, qty: null, price: '' }])}>
            + Ürün
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <h3 className="mb-2 text-sm font-semibold">Masraflar (₺, KDV hariç)</h3>
          <div className="card overflow-visible">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-56">Tür</th>
                  <th>Açıklama</th>
                  <th className="w-44">Kime ödendi</th>
                  <th className="w-36 text-right">Tutar</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.key} className={c.type === 'import_vat' ? 'bg-paper/60' : ''}>
                    <td>
                      <select className="input" value={c.type} onChange={(e) => setCosts((cs) => cs.map((x) => (x.key === c.key ? { ...x, type: e.target.value as CostType } : x)))}>
                        {(Object.keys(COST_LABEL) as CostType[]).map((t) => (
                          <option key={t} value={t}>
                            {COST_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="input" value={c.description} onChange={(e) => setCosts((cs) => cs.map((x) => (x.key === c.key ? { ...x, description: e.target.value } : x)))} />
                    </td>
                    <td>
                      <SearchSelect
                        items={suppliers.data ?? []}
                        value={c.supplierId}
                        onChange={(sid) => setCosts((cs) => cs.map((x) => (x.key === c.key ? { ...x, supplierId: sid } : x)))}
                        label={(s) => s.name}
                        placeholder="—"
                      />
                    </td>
                    <td>
                      <MoneyInput value={c.amount} onChange={(v) => setCosts((cs) => cs.map((x) => (x.key === c.key ? { ...x, amount: v } : x)))} />
                    </td>
                    <td className="w-10 text-right">
                      <button className="px-1 text-lg text-bad" aria-label="Masrafı sil" onClick={() => setCosts((cs) => cs.filter((x) => x.key !== c.key))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap gap-2 p-3">
              {(['freight', 'customs_duty', 'broker', 'cargo', 'import_vat', 'other'] as CostType[]).map((t) => (
                <button key={t} className="btn btn-sm" onClick={() => setCosts((cs) => [...cs, { key: n++, type: t, description: '', amount: null, supplierId: null }])}>
                  + {COST_LABEL[t].replace(' (maliyete girmez)', '')}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">İthalatta ödenen KDV indirilebildiği için maliyete eklenmez; kayıt için girilir. Gümrük vergisi, broker ve navlun maliyete dağıtılır.</p>
        </div>
        <div className="space-y-3">
          <Stat label="Mal bedeli" value={formatTL(calc.goods)} sub={h.currency !== 'TRY' && fx ? `${fmtNum(calc.goods / 100 / fx, 2)} ${h.currency} × ${decText(fx)}` : undefined} />
          <Stat label="Maliyete eklenen masraf" value={formatTL(calc.extra)} sub={calc.goods ? `mal bedelinin %${Math.round((calc.extra / calc.goods) * 100)}'i` : undefined} />
          <Stat label="Toplam maliyet" value={formatTL(calc.goods + calc.extra)} sub={calc.qty ? `${fmtNum(calc.qty)} adet · ort. ${formatUnit((calc.goods + calc.extra) / calc.qty)}` : undefined} />
          {calc.vat > 0 && <Stat label="İthalat KDV (indirilecek)" value={formatTL(calc.vat)} />}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <ErrorLine error={err} />
        <button className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          {id ? 'Değişiklikleri kaydet' : 'Partiyi kaydet'}
        </button>
      </div>
      {receive && lot && <ReceiveDialog lot={lot} onClose={() => setReceive(false)} onDone={async () => load(await api.lot(lot.id))} />}
      {confirm && lot && (
        <Confirm
          title={confirm === 'delete' ? 'Partiyi sil' : 'Teslimi geri al'}
          text={confirm === 'delete' ? 'Teslim alınmamış parti silinir.' : 'Bu partinin stok girişleri silinir; satılmışsa stok eksiye düşebilir.'}
          danger
          onClose={() => setConfirm(null)}
          onYes={async () => {
            if (confirm === 'delete') {
              await api.deleteLot(lot.id);
              go('/alimlar');
            } else {
              await api.unreceiveLot(lot.id);
              load(await api.lot(lot.id));
            }
          }}
        />
      )}
    </Page>
  );
}

function ReceiveDialog({ lot, onClose, onDone }: { lot: LotDetail; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(today());
  const [err, setErr] = useState('');
  return (
    <Modal
      title={`${lot.no} · teslim al`}
      onClose={onClose}
      width={420}
      footer={
        <>
          {err && <span className="mr-auto text-sm text-bad">{err}</span>}
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await api.receiveLot(lot.id, date);
                onDone();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Stoka gir
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        {fmtNum(lot.totals.qty)} adet, birim gerçek maliyetleriyle stoka girer. Masraflar sonradan değişirse partiyi düzenlemeniz yeterli.
      </p>
      <Field label="Teslim tarihi">
        <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
