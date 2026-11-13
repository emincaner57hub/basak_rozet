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
  vade müşteri vadesinden. Yazdırılabilir.
- **EDM e-Fatura:** fatura tek tuşla EDM'ye gönderilir — alıcı e-Fatura mükellefiyse e-Fatura (temel/ticari),
  değilse e-Arşiv; EDM'nin verdiği fatura no, ETTN ve durum geri yazılır. **Faturalar → EDM'den al**:
  EDM portalında kesilmiş giden faturalar listelenir; Rozet'te karşılığı olan eşleştirilir, olmayan
  irsaliyesiz fatura olarak cariye işlenir (müşteri vergi no ile bulunur, yoksa açılır; stok değişmez).
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

## EDM bağlantısı

1. EDM'den **web servis kullanıcısı** isteyin (portal şifresinden ayrı olabilir).
2. Ayarlar → Firma bilgileri: ünvan, vergi dairesi, vergi no, **ilçe ve il** dolu olmalı.
3. Ayarlar → EDM e-Fatura: önce **Test** ortamı, kullanıcı adı / şifre → *Bağlantıyı test et*.
   Listelenen **GB** etiketini "Kullan" ile gönderici etiketi yapın, kaydedin.
4. Test ortamında birkaç fatura gönderip EDM test portalında kontrol edin; sonra ortamı **Canlı** yapın.

Şifre ayarlarda saklanır (geri gösterilmez). İsterseniz Render'da `EDM_USERNAME`, `EDM_PASSWORD`
(ve gerekirse `EDM_URL`) ortam değişkenleri ayarların önüne geçer.

## Sonraki adımlar

- e-İrsaliye; gelen (alış) e-Faturaları EDM'den çekme
- Müşteri portalı: kafelerin kendi sipariş vermesi, geçmiş, borç
