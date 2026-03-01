# WhatsApp Auto Forward Bot

Bot untuk memforward notifikasi pesan WhatsApp yang belum dibaca setelah waktu tertentu.

## Cara Kerja

1. Bot terkoneksi ke WhatsApp Anda via QR code (seperti WhatsApp Web)
2. Setiap pesan masuk akan ditampung dengan timer sesuai konfigurasi (default 5 menit)
3. Jika pesan **dibaca** sebelum timeout → forward dibatalkan
4. Jika pesan **belum dibaca** sampai timeout → notifikasi dikirim ke nomor tujuan dengan format:
   ```
   Ada pesan baru dari Nama Pengirim (628xxx) sejak 5 menit yang lalu.
   ```
   Jika nama tidak tersedia, hanya nomor yang ditampilkan.
5. Hanya 1 pesan per nomor pengirim yang ditampung. Pesan berikutnya dari pengirim yang sama diabaikan selama masih ada yang pending

## Instalasi

```bash
npm install
```

## Konfigurasi

Edit file `.env`:

```env
FORWARD_TO_NUMBER=628123456789
TIMEOUT_MINUTES=5
```

- `FORWARD_TO_NUMBER`: Nomor tujuan notifikasi (format internasional tanpa `+`)
- `TIMEOUT_MINUTES`: Waktu tunggu sebelum forward (default: 5 menit)

## Menjalankan Bot

```bash
npm run dev
```

Atau build manual:

```bash
npm run build
npm start
```

Scan QR code yang muncul di terminal menggunakan WhatsApp → **Linked Devices** → **Link a Device**.

## Catatan

- Session tersimpan di folder `auth_info` — jangan dihapus agar tidak perlu scan QR lagi
- Jika perlu login ulang, hapus folder `auth_info` lalu jalankan ulang bot
- Bot akan otomatis reconnect jika koneksi terputus
