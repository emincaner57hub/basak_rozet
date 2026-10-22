# Başak Rozet

Çin'den ithal edilen (ya da Temu / bavul ticaretiyle alınan) rozetlerin kafelere toptan satışı için
sipariş, stok, irsaliye, fatura, tahsilat ve maliyet takibi.

## Neler var

- **Müşteri ağacı:** zincir (merkez) → şubeler; şube faturayı merkeze ya da kendisine (franchise) keser.
  Tek kafeler zincirsiz. Cari, faturanın kesildiği müşteride tutulur; açılış bakiyesi ve tarihi girilebilir.
- **Ürünler:** rozet tasarımları (görsel, kategori, liste fiyatı, kritik stok), zincire özel tasarımlar,
  stand / etiket gibi satılmayan **promosyon malzemeleri**. Zincire ya da kafeye özel fiyat.
- **Alım partileri:** USD/CNY/EUR/TL, kur; navlun, gümrük vergisi, broker, kargo masrafları ürünlere
  değere ya da adede göre dağıtılır (ithalat KDV'si maliyete girmez). Teslim alınca stoka girer.
  Masraf sonradan değişirse stok ve satılmış malın maliyeti yeniden hesaplanır (hareketli ortalama).
- **Siparişler:** panelden (telefon, WhatsApp, e-posta) ya da **Excel'den** — şube × ürün tablosu
  ya da "Şube · Ürün kodu · Adet" listesi; her şube için ayrı sipariş açılır. Zincire şablon indirilebilir.
- **İrsaliye:** siparişten kısmi ya da tam sevk, stoktan düşer; stand/etiket 0 ₺ ile eklenir ve
  müşterinin promosyon giderine yazılır. Yazdırılabilir A4 sevk irsaliyesi.
- **Fatura:** faturalanmamış irsaliyelerden, faturanın kesileceği müşteriye toplu; KDV satır bazında;
  vade müşteri vadesinden. e-Fatura numarası sonradan girilir. Yazdırılabilir.
- **Tahsilat:** havale vb.; faturaları eskiden yeniye kapatır, vadesi geçenler işaretlenir. Cari ekstre.
- **Raporlar:** satış (zincir / şube / ürün / ay), **müşteri kârlılığı** (ciro − maliyet − promosyon),
  stok değeri ve kaç gün yeteceği, alacak yaşlandırma. CSV indirme.

## Çalıştırma

```bash
npm run install:all
npm run dev:server   # http://localhost:3001 — veritabanı kurulumsuz (PGlite), örnek veriyle
npm run dev:web      # http://localhost:5173
```

Yerelde giriş: `admin@local` / `admin1234`. Örnek veri istemiyorsanız `SEED=0`.

Testler: `npm test`

## Yayına alma (Render)

`render.yaml` ile: New → Blueprint → depo. `ADMIN_EMAIL` ve `ADMIN_PASSWORD` girilir; ilk yönetici
bunlarla açılır. Veritabanı ayrı PostgreSQL; boş başlar (örnek veri için bir kez `SEED=1`).

## Sonraki adımlar

- e-Fatura / e-İrsaliye entegrasyonu (entegratör API'si)
- Müşteri portalı: kafelerin kendi sipariş vermesi, geçmiş, borç
