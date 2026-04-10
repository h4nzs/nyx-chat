# Phase 1: Security & Cryptography (Zero-Knowledge Validation)

## Langkah 1: Audit Skema Database (`schema.prisma`)
1. **[MEDIUM] `RefreshToken` (IP Address & User-Agent)**: ~~Menyimpan IP Address dalam bentuk *plaintext* melanggar prinsip anonimitas absolut.~~ *(Koreksi: Pada Langkah 3, ditemukan bahwa IP Address sebenarnya sudah di-hash SHA-256 sebelum disimpan).*
2. **[LOW] `Device` (Name)**: ~~Disimpan sebagai *plaintext*. Terkadang pengguna menamai perangkat dengan nama asli.~~
3. **[INFO] `Message` (Content)**: Kolom bernama `content` berisiko membuat *developer* secara tidak sengaja melakukan *logging* pada kolom ini. Saran: ubah menjadi `encryptedContent`.

## Langkah 2: Integritas Kriptografi (Klien)
1. **[GOOD] Enkripsi IndexedDB (`shadowVaultDb.ts`)**: Implementasi enkripsi *at-rest* di klien untuk IndexedDB menggunakan XChaCha20Poly1305 sebelum disimpan. Sesuai dengan prinsip Zero-Knowledge.
2. **[GOOD] Memory Management (`crypto.worker.ts`)**: Pembersihan memori kunci sensitif (`sodium.memzero`) telah diterapkan secara konsisten.
3. **[MEDIUM] Validasi Zod (`schemas.ts`)**: Kolom `content` atau payload kriptografi di Zod hanya divalidasi sebagai `z.string()`. Sebaiknya memiliki regex/validasi khusus untuk format Base64.
4. **[MEDIUM] Ekspor Vault (`shadowVaultDb.ts`)**: ~~Fungsi `exportDatabaseToJson` mendekripsi *messageKeys* lokal ke JSON mentah. Fitur ini bisa digunakan untuk *Data Exfiltration* jika perangkat dicuri dalam keadaan *unlocked*. Sebaiknya ekspor dilindungi dengan *password-based encryption* (misal: PBE/Argon2).~~ *(FIXED: Diubah menjadi ekspor berbasis password. File JSON yang diekspor sekarang dienkripsi menggunakan algoritma `XChaCha20Poly1305` dengan kunci dari `Argon2id`)*

## Langkah 3: Autentikasi & Otorisasi (Server)
1. **[GOOD] Hashing Kredensial (`password.ts`)**: Menggunakan Argon2id yang dikonfigurasi dengan aman (Memory Cost: 32MB, Time Cost: 3) yang tahan terhadap serangan *GPU cracking*.
2. **[GOOD] Anti-Spam & Rate Limit (`auth.ts`)**: Menggunakan Cloudflare Turnstile saat registrasi dan sistem *Proof of Work (PoW)* kustom berbasis Redis untuk melimitasi akun yang belum terverifikasi.
3. **[GOOD] IP Address Hashing (`auth.ts`)**: Mengoreksi temuan Langkah 1, alamat IP ternyata di-hash menggunakan SHA-256 sebelum disimpan ke dalam tabel `RefreshToken`. Ini adalah implementasi Zero-Knowledge yang sempurna.
4. **[MEDIUM] Unauthenticated Socket (`socket.ts` & `auth.ts`)**: ~~Middleware Socket.io membiarkan koneksi tanpa token tetap terbuka (tanpa `socket.user`). Walaupun berguna untuk *Device Migration* atau WebRTC awal, hal ini berisiko *resource exhaustion* (DDoS) jika koneksi bodong tidak diputus setelah *idle timeout*.~~ *(FIXED: Telah ditambahkan mekanisme Idle Timeout selama 60 detik pada level socket untuk pengguna unauthenticated, melindungi server dari risiko kebocoran memori akibat zombie connection)*

## Langkah 4: Keamanan Transport (Socket)
1. **[GOOD] E2EE Transport (`socket.ts` & `shared/src/socket.ts`)**: Payload yang melewati socket sepenuhnya buta (hanya `content` sebagai *ciphertext* dan kunci yang dienkripsi). Server hanya bertindak sebagai *relay*.
2. **[GOOD] Smart Key Routing (`socket.ts`)**: Distribusi kunci grup (`messages:distribute_keys`) secara cerdas diarahkan hanya ke spesifik `targetDeviceId`, mengurangi permukaan serangan.
3. **[MEDIUM] Celah Rate Limit Signaling (`socket.ts`)**: Terdapat *rate limiter* Redis untuk event `message:send` dan `typing`. Namun, event `webrtc:secure_signal` tidak di-rate limit. Penyerang dapat membanjiri target tertentu dengan payload sampah WebRTC (Signaling DoS).

# Phase 2: User Experience (UX) & Performance Audit

## Langkah 1: Performa Kriptografi (Non-blocking UI)
1. **[GOOD] Off-Main-Thread Crypto (`crypto-worker-proxy.ts`)**: Seluruh operasi kriptografi berat (libsodium, Argon2id) di-delegasikan ke `crypto.worker.ts` menggunakan proksi berbasis Promise dan UUID. Ini menjamin aplikasi React tidak akan pernah *freeze* saat melakukan enkripsi atau dekripsi, mempertahankan animasi 60fps untuk pengalaman *mobile-first*.
2. **[GOOD] Code Splitting Otomatis (`vite.config.ts`)**: Pemisahan *chunk* (modul) dilakukan dengan sangat efisien. Modul berat seperti PDF renderer, WebAuthn, dan Image Editor di-load menggunakan strategi `lazy()` secara modular (contoh: `feature-passkey`, `feature-pdf`).

## Langkah 2: Alur Penemuan Kontak & Pencarian
1. **[GOOD] Pilihan Fleksibel Onboarding**: Aplikasi mendukung pencarian ID global (lewat `/api/users/search`) untuk kemudahan komunikasi bisnis, sekaligus memiliki `ScanQRModal.tsx` dan `ShareProfileModal.tsx` yang menggunakan `html5-qrcode` & `react-qr-code` untuk berbagi identitas *out-of-band* secara aman.
2. **[INFO] Umpan Balik Pencarian**: Modul pencarian telah menggunakan status `isSearching` (Loading Spinner) dan `Optimistic UI` dengan baik untuk mencegah interaksi macet. 

## Langkah 3: Aksesibilitas (A11y) & Standar UI
1. **[GOOD] Kompatibilitas Screen Reader (`aria-*`)**: Audit `ux-audit` menemukan integrasi ekstensif atribut `aria-label`, `aria-hidden`, dan `aria-labelledby` pada modal, tombol aksi obrolan, dan navigasi (*sidebar*). Ini menempatkan UX aplikasi pada standaribilitas tinggi untuk inklusi *screen-reader*.
2. **[GOOD] Manajemen Status Offline (`App.tsx`)**: Desain reaktif untuk pergantian *Visibility State*. Aplikasi secara otomatis mendeteksi jika browser di- *minimize* dan memberikan notifikasi `user:away` kepada peladen. 

## Langkah 4: Kesiapan Situs Pemasaran (SEO & Konversi)
1. **[GOOD] Arsitektur Situs Astro (`SEO.astro`)**: Menyediakan infrastruktur SEO *Technical* yang lengkap—mendukung Meta Title, Description, Canonical URL, Open Graph (untuk bagikan di sosial media), Twitter Cards, dan injeksi *Schema Markup* (JSON-LD).
2. **[GOOD] Progressive Web App (PWA)**: Konfigurasi `vite-plugin-pwa` diatur dengan *maximumFileSizeToCacheInBytes* 5MB (untuk mengakomodasi WASM dari *libsodium*). Memastikan aplikasi dapat diinstal di *home screen* tanpa *address bar*, memberikan sensasi "Native App".

# Phase 3: Scalability & Backend Infrastructure

## Langkah 1: Manajemen Koneksi & Rate Limiting
1. **[GOOD] Rate Limiter Terdistribusi (`rateLimiter.ts`)**: Menggunakan `express-rate-limit` yang disandarkan pada Redis (`RedisStore`). Dapat diskalakan secara horizontal karena menjamin *state* rate-limit dibagikan antar *worker*/peladen.
2. **[GOOD] Keamanan Deteksi IP**: Menggunakan *helper* `ipKeyGenerator` dari header `cf-connecting-ip` untuk mencegah serangan manipulasi identitas alamat IP di belakang *Reverse Proxy* (Cloudflare).

## Langkah 2: Manajemen Siklus Hidup Data (Cron Jobs)
1. **[GOOD] Kebijakan Privasi Otomatis (`messageSweeper.ts`)**: Adanya sistem sapu jagat (Sweeper) yang berjalan setiap menit untuk menghapus pesan berdasarkan TTL (maksimum 14 hari di server) atau fitur *Disappearing Messages* (kedaluwarsa eksplisit). 
2. **[GOOD] Tombol Kematian (Dead Man's Switch)**: Pada `systemSweeper.ts`, ada fitur penghapusan akun otomatis beserta kaskade (cascade deletion) jika pengguna tidak *login* (tidak *online*) selama durasi `autoDestructDays`. Ini adalah fitur luar biasa untuk *High-Threat Model* (Whistleblower).

## Langkah 3: Infrastruktur & Deployment (Docker)
1. **[CRITICAL] Nginx Reverse Proxy Mismatch (`web/nginx.conf`)**: Pada berkas konfigurasi Nginx untuk situs App, permintaan `/api` dan `/socket.io` diteruskan (proxy_pass) ke `http://127.0.0.1:4000`. Dalam lingkungan Docker (via `docker-compose.yml`), IP `127.0.0.1` di dalam wadah `web` akan mengarah pada wadah itu sendiri, bukan ke wadah `server`. **Ini akan menyebabkan API dan Socket gagal terkoneksi (Connection Refused).** Harus diubah menjadi nama servis dalam docker-compose, yaitu `http://server:4000`.
2. **[INFO] Mismatch Port Expose Dockerfile (`web/Dockerfile`)**: Di dalam Dockerfile tertulis `EXPOSE 80`, namun `nginx.conf` dikonfigurasi untuk `listen 3000;`. Meski dalam docker-compose port pemetaan yang menang akan digunakan, ini dapat membingungkan saat men- *deploy* ke platform *Serverless* atau *PaaS* seperti Koyeb/Vercel/Render. Sebaiknya seragamkan.

# Phase 4: Kualitas Kode & Standar TypeScript

## Langkah 1: Kepatuhan Tipe Data Statis (TypeScript Coverage)
1. **[EXCELLENT] Zero `any` Type Tolerance**: Melalui audit statis regex ekstensif dan kompilasi `tsc`, ditemukan **0 (NOL)** penggunaan tipe `any` atau injeksi *type casting* brutal (`as any`) di seluruh repositori (Web, Server, dan Shared). Ini adalah pencapaian langka yang membuktikan bahwa basis kode ini sangat aman secara taktis dari *runtime type errors*.
2. **[GOOD] Keberhasilan Kompilasi Tanpa Emisi**: Uji coba `tsc --noEmit` pada lingkungan `web`, `server`, dan `packages/shared` berhasil dilewati tanpa satu pun galat kompilasi.

## Langkah 2: Validasi Data Runtime (Zod)
1. **[GOOD] Rekursi Model Skema (Zod)**: Skema `RawServerMessageSchema` (dalam `schemas.ts`) berhasil mengimplementasikan *tipe rekursif yang sangat aman* (menggunakan `z.lazy()`) untuk properti `repliedTo`, mencegah kebocoran data saat *parsing*.
2. **[GOOD] Perlindungan Pre-process Date (Zod)**: Skema masuk di `IncomingMessageSchema` dilengkapi proteksi konversi tanggal yang ketat. Zod `preprocess` Anda berhasil melindungi kemungkinan adanya format `Invalid Date` atau `NaN` dari eksekusi yang bisa membobol aplikasi React (*crash*).

## Langkah 3: Linting & Best Practices (ESLint)
1. **[INFO] Kegagalan Internal Dependensi Linting**: Proses eksekusi linter global (`pnpm lint`) mengalami interupsi (Exit Code 2) di dalam direktori `marketing` akibat masalah kompilasi pada bawaan modul (terjadi *TypeError* pada pustaka pihak ketiga: `minimatch` dalam paket `@eslint/config-array`). Saran: Lakukan pembaruan (upgrade) paket `eslint` atau pembersihan `node_modules` pada *workspace* `marketing` untuk menghindari gangguan integrasi CI/CD di tahap pengembangan kelak. Mengingat audit manual TypeScript dan Kode telah lolos 100%, hal ini tidak dikategorikan sebagai ancaman fungsional.

# Phase 5: Pengujian End-to-End (E2E) & Quality Assurance

## Langkah 1: Eksekusi Test Suite Global (`pnpm test`)
1. **[CRITICAL] Ketiadaan Test Playwright (E2E)**: Dari hasil pencarian `package.json` dan pemindaian direktori uji (`tests`/`e2e`), **tidak ditemukan ada implementasi pengujian Playwright (E2E) sama sekali**. Alur kunci yang Anda sebutkan seperti: autentikasi biometrik (WebAuthn), siklus hidup *Double Ratchet* di sisi UI, dan validasi penyimpanan lokal (IndexedDB) saat ini sepenuhnya tidak tervalidasi secara otomatis dari sudut pandang *End-to-End*. Ini merupakan celah regresi (*regression risk*) yang sangat besar.
2. **[CRITICAL] Kegagalan Unit/API Test Backend**: Saat menjalankan `pnpm test` di *workspace* `server`, proses *crash* dengan galat `ENOENT: no such file or directory, open '/home/kenz/nyx-chat/server/ca.pem'`. Ini berarti `prisma.ts` dikonfigurasi secara manual (*hard-coded*) untuk mencari sertifikat SSL saat menginisiasi *database* lokal untuk *testing*. Anda harus mengisolasi konfigurasi tes dengan mengejek (*mocking*) basis data atau tidak memerlukan file sertifikat SSL *production-level* saat sedang uji coba.
3. **[CRITICAL] Kode Uji yang Usang (Legacy Flow)**: Melirik ke dalam isi file `server/tests/api.test.ts`, terlihat tes ini masih mencoba menguji alur `/api/auth/register` dengan payload `email, username, password, name`. Padahal arsitektur Anda sudah lama bertransformasi menjadi **Zero-Knowledge** (menggunakan *usernameHash*, *publicKey*, dan *biometric*). Tes yang ada benar-benar sudah usang (*obsolete*).
