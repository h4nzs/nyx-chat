# Analisis Mendalam Aplikasi Chat Lite

## Ringkasan Proyek

Chat Lite adalah aplikasi perpesanan real-time yang aman dan modern dengan fokus pada pengalaman pengguna dan enkripsi end-to-end. Ini adalah aplikasi full-stack yang dirancang untuk pengguna yang mengutamakan privasi dan antarmuka pengguna yang bersih dan modern.

## Arsitektur dan Teknologi

### Stack Teknologi
- **Frontend**: React, Vite, TypeScript, Zustand, Tailwind CSS, Framer Motion
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO
- **Enkripsi**: `libsodium-wrappers`
- **Tambahan**: Redis untuk caching, JWT untuk otentikasi

### Struktur Monorepo
- Direktori `server/` untuk backend
- Direktori `web/` untuk frontend
- Docker dan Docker Compose untuk containerisasi

## Fitur Utama

### 1. Keamanan dan Privasi
- **End-to-End Encryption**: Semua pesan dan file dienkripsi menggunakan pustaka `libsodium` yang diaudit
- **Pemulihan Akun**: Melalui frasa 24 kata yang dihasilkan dari kunci master unik pengguna
- **Tautan Perangkat**: Menghubungkan perangkat baru secara aman menggunakan kode QR
- **Manajemen Sesi**: Melihat dan mengelola semua sesi aktif dari halaman pengaturan

### 2. Pengalaman Pengguna Modern
- **Antarmuka Neumorphic**: UI taktil dengan tampilan cembung/konkaf yang indah dan fungsional
- **Tema Gelap/Terang**: Dukungan untuk mode gelap dan terang
- **Personalisasi Tema**: Pilihan warna aksen dari palet yang telah ditentukan
- **Command Palette**: Fitur `Ctrl+K` untuk navigasi cepat dan eksekusi perintah
- **Navigasi Keyboard Lanjutan**: Navigasi dengan tombol panah, buka obrolan dengan Enter, tutup modal dengan Escape

### 3. Fitur Perpesanan Kaya
- **Komunikasi Real-Time**: Perpesanan instan, indikator mengetik, status baca, dan status kehadiran online melalui WebSockets
- **Grup Chat**: Mudah membuat dan mengelola percakapan grup
- **Berbagi Media dan File**: Kirim gambar, video, audio, dan dokumen secara aman, semua dienkripsi end-to-end
- **Pratinjau dalam Obrolan**: Dapatkan pratinjau tautan kaya dan pratinjau dalam aplikasi untuk PDF, video, dan audio
- **Dan Lainnya**: Balas pesan, reaksi emoji, dan galeri untuk melihat semua media yang dibagikan dalam percakapan

## Implementasi Keamanan

### 1. Enkripsi End-to-End
- Menggunakan pustaka `libsodium` untuk enkripsi
- Protokol X3DH (mirip Signal Protocol) untuk pertukaran kunci awal
- Kunci disimpan secara lokal di perangkat pengguna dan tidak pernah meninggalkan perangkat dalam bentuk tidak terenkripsi
- Web Workers digunakan untuk operasi kriptografi intensif untuk menghindari pemblokiran UI

### 2. Otentikasi dan Otorisasi
- JWT untuk otentikasi dengan refresh token
- Cookie dengan pengaturan keamanan (HttpOnly, Secure, SameSite)
- WebAuthn untuk otentikasi biometrik/fido2
- Rate limiting untuk mencegah abuse

### 3. Manajemen Kunci
- Kunci identitas, kunci penandatanganan, dan signed pre-key dihasilkan secara lokal
- Pre-key bundle diunggah ke server untuk inisialisasi percakapan
- Session keys untuk percakapan 1-1 dan group keys untuk grup
- Penyimpanan kunci lokal menggunakan IndexedDB

## Alur Bisnis Utama

### 1. Registrasi Akun
- Pembuatan kunci kriptografi lokal di Web Worker
- Validasi input dan Captcha (Cloudflare Turnstile)
- Pengiriman data ke server dengan kunci publik
- Verifikasi email dengan OTP
- Tampilan frasa pemulihan 24 kata

### 2. Login
- Login dengan email/username dan password
- Atau login dengan WebAuthn (biometrik/passkey)
- Dekripsi kunci lokal menggunakan password atau kunci auto-unlock
- Koneksi socket.io untuk komunikasi real-time

### 3. Pemulihan Akun
- Masukkan frasa pemulihan 24 kata
- Regenerasi kunci dari frasa menggunakan algoritme BIP39
- Enkripsi ulang kunci dengan password baru
- Sinkronisasi kunci ke server

### 4. Tautan Perangkat
- Perangkat baru menampilkan QR code dengan token dan kunci publik sementara
- Perangkat lama memindai QR code dan mengenkripsi master seed
- Transfer aman master seed ke perangkat baru
- Pembuatan ulang kunci dan pengaturan auto-unlock

### 5. Pembuatan Percakapan
- Untuk percakapan 1-1: Proses X3DH untuk inisialisasi sesi aman
- Untuk grup: Pembuatan kunci grup dan distribusi ke semua anggota
- Enkripsi pesan menggunakan kunci sesi/grup

### 6. Perpesanan Grup
- Kunci grup untuk enkripsi pesan
- Distribusi kunci grup ke anggota baru
- Rotasi kunci saat anggota bergabung/keluar
- Mekanisme pemulihan kunci untuk anggota yang kehilangan kunci

## UI/UX dan Responsivitas

### 1. Desain Antarmuka
- Gaya Neumorphic dengan efek cembung/konkaf
- Dukungan tema gelap/terang
- Warna aksen yang dapat disesuaikan
- Animasi dan transisi halus menggunakan Framer Motion

### 2. Responsivitas
- Tampilan tiga kolom untuk layar lebar (Command Center)
- Tampilan hybrid untuk tablet
- Tampilan satu kolom untuk mobile
- Responsif terhadap perubahan orientasi

### 3. Pengalaman Pengguna
- Navigasi keyboard dan shortcut
- Command palette untuk akses cepat
- Feedback visual dan animasi
- Loading states dan skeleton screens

## Deployment dan Infrastruktur

### 1. Deployment Hybrid
- Backend di Koyeb (vast-aigneis-h4nzs-9319f44e.koyeb.app)
- Frontend di Vercel (melalui vercel.json rewrites)
- Proxy API dari Vercel ke Koyeb untuk mengatasi masalah CORS dan cookie lintas situs

### 2. Docker dan Containerisasi
- Dockerfiles untuk containerisasi backend dan frontend
- Docker Compose untuk orkestrasi layanan (PostgreSQL, Redis, backend, frontend)
- Multi-stage builds untuk efisiensi

### 3. Konfigurasi Lingkungan
- File .env untuk konfigurasi lingkungan
- Validasi variabel lingkungan penting
- Konfigurasi untuk development dan production

## Konvensi dan Praktik Pengembangan

### 1. Konvensi Kode
- TypeScript digunakan di seluruh proyek untuk keamanan tipe
- ESLint dan Prettier untuk format dan linting kode
- Organisasi komponen berdasarkan fitur
- Manajemen state terpusat dengan Zustand stores

### 2. Praktik Keamanan
- Validasi input di sisi klien dan server
- Sanitasi dan pembersihan data
- Penggunaan header keamanan HTTP (Helmet)
- CSRF protection
- Rate limiting

### 3. Testing
- Frontend: vitest dengan lingkungan jsdom
- Backend: supertest untuk pengujian API
- Framework pengujian mirip Jest
- Dukungan untuk pengujian unit dan integrasi

## Kesimpulan

Chat Lite adalah contoh aplikasi perpesanan modern yang menggabungkan keamanan tingkat tinggi dengan pengalaman pengguna yang luar biasa. Arsitektur monorepo dengan teknologi canggih seperti WebAuthn, enkripsi end-to-end berbasis Signal Protocol, dan desain UI Neumorphic menciptakan solusi komunikasi yang aman, fungsional, dan estetis menarik. Proyek ini menunjukkan implementasi praktis dari prinsip-prinsip keamanan dan desain UI/UX terbaru dalam aplikasi perpesanan.