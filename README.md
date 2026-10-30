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
REMINDER_NUMBERS=628123456789,628987654321
GEMINI_API_KEY=
```

- `FORWARD_TO_NUMBER`: Nomor tujuan notifikasi (format internasional tanpa `+`)
- `TIMEOUT_MINUTES`: Waktu tunggu sebelum forward (default: 5 menit)
- `BROADCAST_LIST`: Nama daftar siaran (broadcast list) WhatsApp Business untuk broadcast (default: `Subscribers`)

## Broadcast ke Daftar Siaran

Pengganti fitur broadcast WhatsApp Business yang berbayar: bot mengirim pesan satu per satu ke
semua penerima daftar siaran bernama `BROADCAST_LIST`, dengan jeda acak 10–30 detik antar pesan.
Daftar penerima dibaca ulang dari WhatsApp setiap kali `/bc` dipakai, jadi perubahan daftar di HP langsung ikut.

Dari HP, kirim pesan ke chat diri sendiri (**Message yourself**):

- `/bc` → menampilkan penerima daftar siaran tanpa mengirim apa pun
- `/bc isi pesan` → broadcast teks (link boleh; pratinjau link dari HP ikut dikirim jika ada)
- Gambar/video dengan caption `/bc isi caption` → broadcast media

Bot melaporkan mulai dan hasilnya (jumlah terkirim/gagal) ke chat diri sendiri. Hanya satu
broadcast yang bisa berjalan pada satu waktu.

## Pengingat Seragam SD

Setiap hari jam 05.00 WIB bot mengirim pengingat seragam ke nomor di `REMINDER_NUMBERS`
(dipisah koma; kosongkan untuk mematikan):

- Senin–Selasa: Merah Putih · Rabu–Kamis: Batik
- Jumat: ke-1 Olahraga, ke-2 & ke-3 HW, ke-4 Tapak Suci, ke-5 Olahraga
- Jadwal pelajaran hari itu untuk kelas 2B dan 4A (SD Muhammadiyah Pahandut T.A. 2026/2027,
  di `src/schedule.ts`), termasuk pengingat bawa baju olahraga saat ada PJOK dan jam pulang
- Libur nasional dari [api-harilibur.pages.dev](https://api-harilibur.pages.dev/) diberitahukan
  sehari sebelumnya (libur Senin diberitahukan hari Minggu). Libur di hari Sabtu/Minggu diabaikan.

Jika `GEMINI_API_KEY` diisi, pesan ditutup dengan kata penyemangat untuk orang tua. Seminggu sekali
(pada pengiriman pertama tiap minggu) Gemini mencari kondisi terkini di Indonesia lewat Google Search,
lalu menulis penyemangat untuk setiap hari di minggu itu sekaligus agar relevan dan tidak berulang.
Hasilnya disimpan di `encouragement.json`. Model diatur lewat `GEMINI_MODEL` (default
`gemini-flash-latest`). Jika Gemini gagal, pengingat tetap terkirim tanpa penyemangat.

Jika bot sedang terputus jam 05.00, pengiriman dicoba terus sampai jam 09.00. Status kirim harian
disimpan di `reminder-state.json` agar tidak terkirim dobel. Kirim `/seragam` (atau
`/seragam 2026-08-24`) ke chat diri sendiri untuk melihat pratinjau tanpa mengirim ke siapa pun.

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
