# Monitoring

Aplikasi Monitoring menyediakan login dan pilihan menu monitoring ping dan PRTG. Akun aplikasi disimpan di satu database MySQL; kata sandi disimpan sebagai hash bcrypt, bukan teks biasa.

## Halaman aplikasi

- `index.html` — halaman login.
- `dashboard.html` — menu pilihan Ping Monitoring atau PRTG Monitoring setelah login.
- `ping-monitoring.html` — halaman Ping Monitoring.
- `prtg-monitoring.html` — halaman PRTG Monitoring.
- `public/app.css` dan `public/app.js` — aset tampilan dan interaksi bersama.

Halaman setelah login hanya disajikan melalui rute backend yang memeriksa sesi. `/menu`, `/ping-monitoring`, dan `/prtg-monitoring` menggunakan database `nadi_monitoring` yang sama untuk autentikasi. Fitur pengambilan data host ping dan server PRTG belum dikonfigurasi.

## Menjalankan

1. Pastikan MySQL aktif dan user MySQL memiliki izin membuat database dan tabel.
2. Salin `.env.example` menjadi `.env`, lalu isi password user MySQL. Buat secret sesi acak menggunakan PowerShell:

   ```powershell
   Copy-Item .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Salin hasil perintah tersebut ke `SESSION_SECRET` di `.env`.
3. Instal dependensi:

   ```powershell
   npm.cmd install
   ```

4. Siapkan database dan tabel:

   ```powershell
   npm.cmd run db:init
   ```

5. Buat user awal `NOC`. Masukkan password awal melalui environment agar tidak tersimpan di source code:

   ```powershell
   $env:NOC_PASSWORD = "12345678"
   npm.cmd run db:seed
   Remove-Item Env:NOC_PASSWORD
   ```

   Seeder hanya membuat user jika username belum ada. Jalankan hanya sekali. Jika gagal karena `Access denied`, berikan user MySQL izin yang diperlukan atau sesuaikan kredensial di `.env`.

6. Jalankan aplikasi:

   ```powershell
   npm.cmd start
   ```

Buka `http://localhost:3000`. Login akan membuka menu pilihan. Endpoint `/api/me` memeriksa sesi login yang ditandatangani server. Sesi tersimpan di cookie `HttpOnly` dan berlaku selama 8 jam.

## Modul Ping dan PRTG

Setiap modul punya sub-menu **TAMPILKAN**, **TAMBAH**, dan **ATUR POSISI** (maksimal 16 slot per slide, tampil hingga 4 kolom × 4 baris dalam satu layar tanpa scroll; tekan `Esc` untuk keluar). Kartu pada **ATUR POSISI** punya tombol **Edit** yang membuka ulang form TAMBAH terisi data lama. Di modul Ping, password SSH boleh dikosongkan saat edit untuk tetap memakai password lama, dan daftar tujuan dikirim ulang penuh (menggantikan seluruh tujuan lama). Di modul PRTG, passhash juga boleh dikosongkan saat edit untuk tetap memakai yang lama.

- **Ping** — worker SSH (`workers/pingWorker.js`, library `ssh2`) membuka satu koneksi per perangkat aktif dan menjalankan `ping_command` dengan interval siklus satu detik untuk tiap tujuan. Hasil diparse (`lib/parsers.js`) lalu disimpan ke `ping_logs` dan disiarkan lewat WebSocket `/ws/ping`. Satu perangkat boleh punya hingga 6 tujuan (tabel `ping_targets`); placeholder `<IP>` pada command diganti tiap tujuan secara bergantian (satu koneksi SSH dipakai berurutan untuk semua tujuan). Tanpa tujuan terdaftar, command dijalankan apa adanya ke host perangkat. Di layar **TAMPILKAN**, tiap tujuan tampil sebagai kolom terpisah; kapasitas per slide dapat diatur hingga 16 kolom.
- **PRTG** — backend mengambil grafik dari `http://<prtg_ip>/chart.png` dan mengalirkannya ke browser (`/api/prtg/chart/:id`), serta traffic In/Out Mbps (`/api/prtg/traffic/:id`). Passhash tidak pernah dikirim ke browser. `:id` adalah id baris di tabel `prtg_sensors`, bukan ID sensor PRTG. Saat menambah sensor baru, field IP/host, Username, dan Passhash boleh dikosongkan — jika server PRTG sama dengan sensor yang sudah terdaftar, nilainya otomatis disalin dari sensor pertama di database, jadi cukup isi Label dan ID sensor.

Tabel dibuat oleh `npm.cmd run db:init` dari `db/002_modules.sql`: `ping_devices`, `prtg_sensors`, `ping_targets` (tujuan per perangkat, maks 6), `ping_logs` (FK ke `ping_devices`, hapus perangkat ikut menghapus log dan tujuannya). Password SSH dan passhash PRTG disimpan **terenkripsi AES-256-GCM**; kuncinya `DATA_ENCRYPTION_KEY` (64 karakter hex) di `.env`. Jangan kehilangan kunci ini, data terenkripsi tidak bisa dibuka tanpanya. Buat dengan:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ping_logs` dibersihkan otomatis setiap jam; atur retensi lewat `PING_LOG_RETENTION_DAYS` (default 7 hari).

| Endpoint | Fungsi |
|---|---|
| `GET/POST /api/ping/devices`, `PUT /api/ping/devices/:id`, `DELETE /api/ping/devices/:id` | CRUD perangkat ping |
| `GET /api/ping/recent?limit=` | riwayat terbaru per perangkat |
| `GET/POST /api/prtg/sensors`, `PUT /api/prtg/sensors/:id`, `DELETE /api/prtg/sensors/:id` | CRUD sensor PRTG |
| `POST /api/reorder/:module` (`ping` atau `prtg`) | body `[{ "id": 1, "slot_order": 1 }, ...]`, harus mencakup semua baris |

Semua endpoint butuh sesi login.


Jangan membuka `index.html` langsung (`file:///`) atau melalui server statis seperti Live Server. Login memerlukan backend Express agar `/api/login` dapat memverifikasi akun melalui MySQL. Server tetap dapat menampilkan halaman login saat MySQL belum tersedia, tetapi login hanya berhasil setelah MySQL berjalan, tabel siap, dan pengaturan `.env` benar. Jika server belum berjalan, jalankan `npm.cmd start`, kemudian buka `http://localhost:3000`.
