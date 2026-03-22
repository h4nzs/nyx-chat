# Laporan Kondisi Codebase NYX (Zero-Knowledge Messenger)

Berikut adalah Laporan Kondisi Codebase NYX (Zero-Knowledge Messenger) berdasarkan analisis menyeluruh terhadap struktur proyek:

## 1. Arsitektur & Struktur (Architecture)

Proyek ini adalah Monorepo modern yang dikelola dengan pnpm workspaces, memisahkan concerns dengan sangat jelas:

- **Backend (server/):**
  - Dibangun dengan Node.js + Express 5.
  - Menggunakan Prisma ORM v7 untuk interaksi database (PostgreSQL).
  - Pola desain: Route/Middleware/Service pattern (standar industri).
  - Real-time: Menggunakan Socket.IO dengan Redis Adapter untuk skalabilitas (clustering).

- **Frontend (web/):**
  - Dibangun dengan React 19 + Vite 8 (Sangat modern/up-to-date).
  - State Management: Menggunakan Zustand (pilihan tepat untuk state kompleks seperti kunci enkripsi).
  - Struktur komponen modular dan terorganisir dengan baik.

- **Database:** Skema Prisma (`schema.prisma`) dirancang khusus untuk mendukung E2EE (menyimpan PreKeys, SessionKeys, dan BlindIndex untuk username).

## 2. Kualitas Kode (Code Quality)

- **TypeScript:** Penggunaan TypeScript yang ekstensif dan ketat di seluruh stack, menjamin type safety.
- **Modern Stack:** Penggunaan versi terbaru (React 19, Express 5, Prisma 7) menunjukkan codebase ini sangat future-proof.
- **Linting & Formatting:** Konfigurasi ESLint dan Prettier tampaknya sudah diterapkan untuk menjaga konsistensi gaya kode.

## 3. Keamanan (Security) - Kekuatan Utama

Mengingat ini adalah aplikasi privasi, postur keamanannya sangat kuat:

- **E2EE (End-to-End Encryption):** Implementasi protokol Signal (Double Ratchet, X3DH) menggunakan `libsodium-wrappers`.
- **Proteksi Standar:**
  - CSRF: Menggunakan double-csrf protection.
  - Headers: Helmet untuk Content Security Policy (CSP).
  - Rate Limiting: Diimplementasikan di level middleware dengan backing Redis.
- **Autentikasi:** Terdapat dukungan untuk WebAuthn (keamanan tingkat tinggi tanpa password).
- **Zero-Knowledge:** Server tidak menyimpan pesan plaintext; hanya blob terenkripsi.

## 4. Status Pengujian (Testing State)

- **Backend:** Menggunakan Jest dan Supertest (`tests/api.test.ts`) untuk pengujian API endpoint.
- **Frontend:** Menggunakan Vitest dengan environment jsdom untuk unit testing komponen React.
- **Catatan:** Keberadaan file tes terkonfirmasi, namun cakupan (coverage) mendalam untuk skenario edge cases kriptografi perlu diverifikasi lebih lanjut manual.

## 5. Technical Debt & Area Perbaikan (Isu yang Ditemukan)

Meskipun codebase ini sangat solid, ada beberapa area yang bisa ditingkatkan:

1. **Duplikasi Tipe (Type Duplication):**
   - **Temuan:** Terdapat definisi tipe (terutama untuk payload E2EE dan model User) yang diduplikasi antara `server/src/types` dan `web/src/types`.
   - **Resiko:** Jika satu sisi diupdate dan sisi lain lupa, akan terjadi bug runtime yang sulit dilacak.
   - **Rekomendasi:** Buat workspace baru `packages/shared` atau `packages/types` untuk menyimpan tipe, konstanta, dan utilitas validasi (Zod schemas) yang dipakai bersama.

2. **Kompleksitas Distribusi Kunci (Key Distribution):**
   - **Temuan:** Logika pertukaran kunci E2EE sangat bergantung pada event Socket.IO (`session:request_key`, dll).
   - **Resiko:** Jika koneksi socket tidak stabil, state kunci bisa tidak sinkron (race conditions).
   - **Rekomendasi:** Pastikan ada mekanisme retry yang kuat atau fallback ke REST API untuk pertukaran kunci kritis guna menjamin transaksionalitas.

## Kesimpulan

Secara keseluruhan, Codebase NYX berada dalam kondisi **SANGAT BAIK (Health: A-)**.

Arsitekturnya matang, menggunakan teknologi terkini, dan memiliki fokus keamanan yang jelas. Satu-satunya kelemahan minor adalah duplikasi kode tipe antar frontend dan backend yang umum terjadi pada tahap awal monorepo.

> Apakah Anda ingin saya mulai dengan membuat paket shared untuk mengatasi duplikasi tipe tersebut, atau ada area spesifik lain yang ingin Anda fokuskan?

---

# End-to-End Codebase Review

Berikut adalah End-to-End Codebase Review untuk proyek NYX (Zero-Knowledge Messenger).

## 📊 Executive Summary

**Kondisi Codebase: Excellent (A-)**

Proyek ini adalah implementasi privacy-first yang matang dan modern. Arsitekturnya konsisten dengan prinsip "Trust No One" (TNO), di mana server hanya bertindak sebagai relay buta (blind relay) dan penyimpan data terenkripsi. Stack teknologi yang digunakan (React 19, Express 5, Prisma 7) sangat up-to-date.

---

## 1. Arsitektur & Teknologi

- **Monorepo:** Menggunakan pnpm workspaces dengan struktur yang bersih:
  - `server/`: Backend API & Socket (Express + Socket.IO).
  - `web/`: Frontend PWA (React + Vite).
- **Database:** PostgreSQL dengan skema yang dioptimalkan untuk E2EE (menyimpan public keys, pre-keys, dan encrypted blobs).
- **Infrastruktur:** Docker-ready, mendukung clustering dengan Redis Adapter untuk Socket.IO.

---

## 2. Analisis Alur Kritis (End-to-End Flows)

### A. Autentikasi & Sesi (Security-First)

Alur ini dirancang untuk melindungi identitas pengguna bahkan dari administrator server.

1. **Input & Validasi:**
   - Frontend menggunakan Zod untuk validasi form sebelum dikirim.
   - Username di-hash di sisi klien (Blind Indexing) sebelum dikirim ke server. Server hanya menyimpan `usernameHash`, bukan plaintext username.

2. **Pemrosesan Server:**
   - Password di-hash menggunakan Argon2id (param: 32MB RAM, 3 iterations). Ini konfigurasi yang solid untuk menyeimbangkan keamanan dan performa VPS.

3. **Manajemen Sesi:**
   - Menggunakan JWT (Access & Refresh Tokens).
   - Token disimpan di HttpOnly, Secure, SameSite Cookies (mitigasi XSS).
   - Refresh token disimpan di DB dengan tracking IP & User-Agent untuk mendeteksi pencurian sesi.

4. **Fitur Lanjutan:**
   - Dukungan WebAuthn (Biometric/FIDO2) sudah terintegrasi di skema database.

### B. Pesan Aman (Signal Protocol Implementation)

Alur pesan mengikuti standar E2EE modern (mirip Signal/WhatsApp).

1. **Inisiasi (Key Exchange):**
   - Saat user mendaftar, klien membuat Identity Key, Signed Pre-Key, dan sekumpulan One-Time Pre-Keys.
   - Semua public key diunggah ke server; private key disimpan aman di IndexedDB browser (dienkripsi dengan password user).

2. **Pengiriman Pesan:**
   - Pengirim mengambil Pre-Key Bundle penerima dari server.
   - Sesi enkripsi (X3DH) dibuat secara lokal.
   - Pesan dienkripsi (AES-256-GCM / libsodium) sebelum menyentuh jaringan.

3. **Transmisi & Penyimpanan:**
   - Payload terenkripsi dikirim via Socket.IO (`message:send`).
   - Server menyimpan payload ke tabel `Message`. Kolom `content` berisi ciphertext. Server tidak bisa membaca pesan ini.

4. **Penerimaan:**
   - Penerima mendekripsi pesan menggunakan private key lokal mereka.

---

## 3. Temuan Kualitas Kode & Resiko

### ✅ Kekuatan (Pros)

- **Modern Stack:** React 19 dan Express 5 menjamin longevity proyek.
- **Skema Database:** Relasi `User -> PreKeyBundle -> SessionKey` didefinisikan dengan sangat baik dan menggunakan Cascade delete untuk kebersihan data.
- **Security Defaults:** Rate limiting (Redis), CSRF protection, dan Helmet (CSP) sudah aktif secara default.
- **Privacy Features:** Fitur "Panic Password" dan "Auto-Destruct" (terlihat di skema DB) menunjukkan fokus privasi yang mendalam.

### ⚠️ Kelemahan & Area Perbaikan (Cons)

1. **Duplikasi Kode (DRY Violation):**
   - Definisi tipe TypeScript (misalnya interface User, payload Socket) diduplikasi di folder server dan web. Ini berisiko ketidakkonsistenan tipe saat refactoring.

2. **Ketergantungan Socket.IO:**
   - Pertukaran kunci (Key Exchange) sangat bergantung pada event Socket.IO. Jika koneksi tidak stabil saat pertukaran kunci awal, user mungkin gagal mendekripsi pesan pertama.
   - **Saran:** Pertimbangkan endpoint REST HTTP sebagai fallback atau jalur utama untuk fetching Pre-Keys guna reliabilitas lebih tinggi.

3. **Kompleksitas Client-Side:**
   - Logika kriptografi yang berat di sisi klien (browser) berpotensi memblokir UI thread jika tidak sepenuhnya dipindahkan ke Web Workers.

## 4. Rekomendasi Langkah Selanjutnya

1. **Refactor:** Buat workspace `packages/shared` untuk menampung Tipe TypeScript dan Zod Schema yang dipakai bersama oleh Server dan Web.
2. **Testing:** Tambahkan End-to-End (E2E) Test khusus untuk skenario enkripsi (misal: User A kirim pesan -> User B terima & dekripsi sukses) menggunakan Playwright/Puppeteer untuk memvalidasi implementasi kriptografi secara otomatis.
3. **Performance:** Pastikan semua operasi libsodium yang berat berjalan di dalam Web Worker (`web/src/workers/`).

> Codebase ini siap untuk pengembangan fitur lebih lanjut dengan fondasi keamanan yang sangat kokoh.

---

# Security Audit Report

Berikut adalah hasil Audit Keamanan (Security Audit) pada codebase NYX, berfokus pada potensi celah dan kelemahan yang ditemukan:

## 🛡️ Ringkasan Audit

Secara umum, NYX memiliki postur keamanan yang sangat kuat. Prinsip Defense in Depth diterapkan dengan baik, mulai dari validasi input (Zod), keamanan sesi (HttpOnly Cookies), hingga enkripsi data (E2EE/Argon2).

Namun, ditemukan satu potensi isu privasi yang signifikan terkait fitur AI.

## 🔍 Temuan Audit (Detailed Findings)

### 1. Potensi Kebocoran Privasi: Fitur "Smart Reply" (AI)

- **Lokasi:** `server/src/routes/ai.ts` dan `web/src/components/SmartReply.tsx`.
- **Isu:** Fitur Smart Reply mengharuskan klien mengirim konten pesan terakhir dalam bentuk plaintext ke server (dan kemudian ke penyedia AI seperti Google Gemini/OpenAI) untuk menghasilkan saran balasan.
- **Dampak:** Ini secara teknis mematahkan janji "Zero-Knowledge" untuk pesan tersebut. Meskipun E2EE melindungi pesan dari eavesdropping jaringan, fitur ini secara sukarela membuka pesan tersebut kepada pihak ketiga (AI Provider).
- **Rekomendasi:**
  1. Pastikan fitur ini **OPT-IN** (mati secara default).
  2. Tampilkan peringatan jelas (disclaimer) kepada pengguna bahwa mengaktifkan Smart Reply akan mengirim data pesan ke penyedia AI.
  3. Pertimbangkan penggunaan Local LLM (jika memungkinkan di masa depan) untuk menjaga privasi tetap di perangkat.

### 2. Autentikasi & Sesi (Authentication)

- **Status:** ✅ Aman.
- **Analisis:**
  - Token akses (JWT) berumur pendek (15 menit).
  - Refresh token disimpan di database dengan hashing (Argon2), sehingga jika database bocor, token tidak bisa langsung dipakai.
  - Cookie diset dengan atribut HttpOnly, Secure (di production), dan SameSite=Strict.

### 3. Kontrol Akses (IDOR)

- **Status:** ✅ Aman.
- **Analisis:**
  - Endpoint kritis seperti `GET /messages/:conversationId` di `server/src/routes/messages.ts` memverifikasi apakah `req.user.id` adalah partisipan sah dalam percakapan tersebut sebelum mengembalikan data.
  - Tidak ditemukan celah Insecure Direct Object Reference (IDOR) yang jelas.

### 4. Keamanan Real-time (Socket.IO)

- **Status:** ✅ Aman.
- **Analisis:**
  - Koneksi socket diautentikasi menggunakan middleware JWT yang sama dengan REST API.
  - User hanya bisa join ke room percakapan (`conversation:join`) jika mereka terdaftar sebagai partisipan di database. Ini mencegah penyusup "mendengarkan" percakapan orang lain.

### 5. Penyimpanan Kunci (Key Storage & XSS)

- **Status:** ✅ Aman.
- **Analisis:**
  - Private Key pengguna disimpan di IndexedDB (`idb-keyval`), bukan LocalStorage. Ini jauh lebih aman dari serangan XSS sederhana karena IndexedDB tidak bisa diakses semudah LocalStorage.
  - Rendering pesan menggunakan `react-markdown` yang disanitasi dengan `rehype-sanitize`. Tidak ditemukan penggunaan `dangerouslySetInnerHTML` yang berbahaya.

### 6. Upload File

- **Status:** ✅ Aman.
- **Analisis:**
  - Server hanya menerima tipe MIME `application/octet-stream` untuk file terenkripsi, memaksa klien mengenkripsi file sebelum upload.
  - Ukuran file dibatasi (validasi size).

## 📋 Rekomendasi Perbaikan Prioritas

1. **AI Privacy Warning:** Tambahkan UI/UX warning yang sangat jelas saat user mengaktifkan Smart Reply.
2. **Socket.IO Fallback:** Pertimbangkan mekanisme fallback ke HTTP polling atau REST untuk pertukaran kunci (Key Exchange) jika koneksi WebSocket tidak stabil, untuk mencegah denial of service (DoS) yang tidak disengaja pada fitur E2EE.

> Apakah Anda ingin saya membantu mengimplementasikan warning untuk fitur Smart Reply atau ada bagian lain yang ingin diperiksa lebih dalam?

---

# Laporan Audit Keamanan & Analisis Ancaman

**Target:** NYX Chat (Zero-Knowledge Messenger)  
**Mode:** Red Team / Adversary Simulation  
**Tanggal:** 21 Maret 2026

Sebagai penyerang ("hacker"), saya telah membedah kode sumber NYX untuk mencari celah masuk. Berikut adalah analisis mendalam mengenai vektor serangan yang mungkin digunakan dan status pertahanan aplikasi saat ini.

---

## 1. 🛡️ Ringkasan Eksekutif (Verdict)

Secara umum, NYX memiliki postur keamanan yang **SANGAT KUAT** untuk ukuran aplikasi chat modern. Arsitektur Zero-Knowledge diterapkan dengan disiplin tinggi.

- **Frontend:** Terlindungi dengan baik dari XSS (penggunaan `rehype-sanitize`).
- **Backend:** Rate limiting granular dan validasi input yang ketat.
- **Storage:** Server buta terhadap konten file (hanya menerima blob terenkripsi).

Namun, ditemukan satu celah logika (Logic Flaw) pada level Socket.IO yang memungkinkan serangan Harassment/DoS ringan.

---

## 2. 🕵️‍♂️ Vektor Serangan & Temuan

### A. Cross-Site Scripting (XSS) - The Kingslayer

Bagi aplikasi E2EE (End-to-End Encryption), XSS adalah "game over" karena penyerang bisa mencuri Private Key dari IndexedDB.

- **Metode Serangan:** Mencoba menyusupkan payload Javascript `<script>alert(1)</script>` melalui pesan Markdown atau nama file attachment.
- **Analisis Kode (MarkdownMessage.tsx):**

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSanitize]} // <--- PERTAHANAN UTAMA
>
  {content}
</ReactMarkdown>
```

- **Status:** ✅ AMAN. Penggunaan `rehype-sanitize` secara default membuang tag berbahaya. `FileAttachment.tsx` juga menggunakan whitelist tipe file (Image, Video, PDF) sebelum me-render, sehingga file HTML berbahaya akan jatuh ke mode "Download" dan tidak dieksekusi di browser.

### B. Broken Access Control (IDOR) - The Noise Attack

Saya mencari endpoint di mana saya bisa memanipulasi ID (misal: `conversationId`) untuk berinteraksi dengan data orang lain.

- **Metode Serangan:** Mengirim event socket ke room di mana saya bukan anggota.
- **Temuan (CRITICAL LOGIC FLAW):**

Pada file `server/src/socket.ts`, event `session:request_missing` tidak memvalidasi keanggotaan pengirim di database. Komentar kode bahkan mengakui hal ini:

```typescript
socket.on("session:request_missing", async ({ conversationId, sessionId }) => {
    // Cek apakah user member grup
    // (Opsional: Query DB untuk validasi) <--- INI CELAHNYA!

    socket.to(conversationId).emit("session:key_requested", ...);
});
```

- **Skenario Eksploitasi:**
  1. Penyerang menebak atau mengetahui `conversationId` target.
  2. Penyerang mengirim ribuan event `session:request_missing` ke ID tersebut.
  3. Server me-relay request ini ke SEMUA anggota grup tersebut.
  4. Klien korban akan terbebani memproses request kunci palsu ini (CPU Spike / Baterai terkuras).

- **Status:** ⚠️ RENTAN (Low-Medium Severity). Tidak membocorkan data (karena balasan kunci dienkripsi ke pengirim), tapi bisa digunakan untuk mengganggu kenyamanan (spam/DoS).

### C. Socket & API Rate Limiting - The Flood

Apakah saya bisa mematikan server dengan mengirim jutaan request?

- **Analisis Kode:**
  - API Upload (`uploads.ts`) menggunakan `uploadLimiter`.
  - Socket (`socket.ts`) memiliki limiter manual berbasis Redis yang sangat granular:
    - `join`: 10/menit
    - `typing`: 20/10detik
    - `message`: 15/menit (User biasa) / 5/menit (User baru/Sandbox).

- **Status:** ✅ AMAN. Implementasi "Sandbox Mode" untuk user yang belum terverifikasi adalah langkah cerdas untuk mencegah akun bot baru melakukan spamming massal.

### D. Manipulasi File Upload

Bisakah saya mengupload file berbahaya (PHP shell, Malware) dan membuatnya dieksekusi server?

- **Analisis Kode (uploads.ts):**
  - Server memaksa ekstensi file hanya `application/octet-stream`.
  - File disimpan di R2 (Object Storage), bukan di file system server lokal (mencegah eksekusi shell).
  - Nama file di-random menggunakan `nanoid` (mencegah path traversal).

- **Status:** ✅ AMAN. Karena server tidak pernah mencoba membaca isi file (hanya memindahkan blob terenkripsi), server kebal terhadap serangan konten file.

---

## 3. 📝 Rekomendasi Perbaikan

Untuk menutup celah yang ditemukan, segera terapkan patch berikut:

### Perbaiki Logika `session:request_missing` di `server/src/socket.ts`:

Jangan biarkan socket me-relay request tanpa validasi DB.

```typescript
// SEBELUM:
// (Opsional: Query DB untuk validasi)

// SESUDAH (Rekomendasi):
const isParticipant = await prisma.participant.findFirst({
  where: { conversationId, userId: socket.user!.id }
});

if (!isParticipant) {
  // Silent drop atau emit error ke penyerang
  return;
}
```

## Kesimpulan

NYX dibangun dengan mindset keamanan yang benar ("Trust No One"). Celah yang ada bersifat minor dan logikal, bukan fundamental kriptografi. Kode aplikasi ini sangat siap menghadapi serangan umum, namun perlu sedikit pengetatan pada logika bisnis di layer Socket.IO.

---

# Laporan Audit Performa (NYX Chat)

**Platform:** Web (Desktop & Mobile PWA)  
**Framework:** React 19 + Vite + Tailwind CSS v4  
**Fokus:** Core Web Vitals (LCP, FCP, CLS, INP)

---

## 1. 📊 Ringkasan Eksekutif

NYX Chat memiliki fondasi performa yang **SANGAT BAIK (Above Average)** untuk kategori aplikasi yang berat di kriptografi client-side.

Pengembang telah menerapkan pola arsitektur high-performance yang jarang ditemukan di aplikasi React standar, seperti:

1. **Off-Main-Thread Architecture:** Operasi berat (enkripsi/dekripsi) dilempar ke Web Worker (`crypto.worker.ts`).
2. **List Virtualization:** Menggunakan `react-virtuoso` untuk merender ribuan pesan tanpa lag.
3. **Code Splitting:** Semua rute di-lazy load secara agresif.

Namun, beban payload awal (libsodium) dan strategi loading gambar masih bisa dioptimalkan untuk mengejar skor "100" di Lighthouse.

---

## 2. 🚦 Analisa Core Web Vitals

### A. First Contentful Paint (FCP) - Excellent

- **Strategi Saat Ini:** Menggunakan "Inline Critical CSS Loader" di `index.html`.

```html
<div id="initial-loader">...</div>
```

- **Dampak:** User melihat indikator loading instan (0-100ms) sebelum bundle JS yang besar selesai di-download. Ini sangat baik untuk UX Mobile di jaringan lambat.

### B. Largest Contentful Paint (LCP) - Good to Moderate

- **Elemen LCP:** Kemungkinan besar adalah Chat Bubble pertama atau Hero Image di Landing Page.
- **Isu:**
  1. **Lazy Decryption:** Gambar di chat (`LazyImage.tsx`) baru didekripsi setelah komponen di-mount (`useEffect`). Ini menambah delay render sekitar 100-300ms.
  2. **Font Loading:** Font Nunito di-load dari Google Fonts tanpa strategi preconnect yang agresif untuk file font spesifik (hanya domain).

### C. Cumulative Layout Shift (CLS) - Moderate Risk

- **Pertahanan:** Menggunakan `react-virtuoso` mencegah pergeseran layout masif saat scroll.
- **Celah:** Pada `LazyImage.tsx`:

```tsx
// Class min-h-[150px] hanya estimasi kasar
<div className={`... min-w-[200px] min-h-[150px]`}>
```

Jika gambar asli memiliki rasio aspek berbeda (misal: portrait tinggi), kontainer akan "melompat" ukurannya setelah gambar selesai didekripsi dan dirender.

### D. Interaction to Next Paint (INP) - Good

- **Kemenangan Besar:** Penggunaan `crypto-worker-proxy` di `web/src/utils/crypto.ts` adalah penyelamat performa.

```typescript
const { worker_file_decrypt } = await getWorkerProxy();
```

Tanpa ini, mendekripsi file 5MB akan membekukan UI selama 1-2 detik (membuat INP hancur). Dengan Worker, UI tetap responsif (60fps) saat proses berjalan di background.

---

## 3. 📦 Bundle & Network Analysis

1. **Libsodium Overhead:**
   - `libsodium-wrappers` adalah library yang sangat besar (bisa mencapai ~500KB+ WASM). Meskipun sudah dipisah ke chunk `crypto-vendor` di `vite.config.ts`, ini tetap payload besar yang harus di-download saat startup.

2. **Manual Chunks Strategy:**
   - Konfigurasi di `vite.config.ts` sudah baik:

```javascript
manualChunks(id) {
    if (id.includes('react')) return 'react-vendor';
    if (id.includes('libsodium')) return 'crypto-vendor'; // Smart split
}
```

Ini memastikan update kode aplikasi tidak memaksa user mendownload ulang library crypto yang jarang berubah.

---

## 4. 💡 Rekomendasi Optimasi (Actionable Insights)

### Prioritas 1: CLS (Layout Shift pada Gambar)

Simpan metadata `width` dan `height` gambar asli di database/pesan saat upload, lalu terapkan `aspect-ratio` pada container `LazyImage` sebelum gambar di-load.

**Solusi:**

```css
/* Gunakan CSS aspect-ratio */
.img-container {
  aspect-ratio: var(--width) / var(--height);
}
```

### Prioritas 2: Resource Hints (LCP)

Tambahkan `rel="preload"` untuk font utama di `index.html` agar browser tidak menunggu CSS parsing selesai.

```html
<!-- Tambahkan ini di head -->
<link rel="preload" href="/fonts/nunito-v20-latin-regular.woff2" as="font" type="font/woff2" crossorigin>
```

### Prioritas 3: Warm-up Crypto Worker

Inisialisasi Web Worker sesegera mungkin (bahkan sebelum React mount) agar saat user membuka chat, worker sudah "ready" dan tidak perlu waktu boot-up dingin.

## Kesimpulan

Secara teknis, NYX Chat sudah siap untuk produksi dari sisi performa. Aplikasi ini jauh lebih teroptimasi dibandingkan rata-rata aplikasi React karena penggunaan Worker dan Virtualization yang disiplin. Isu yang tersisa bersifat minor (polishing).

---

# Laporan Audit SEO (Search Engine Optimization)

**Target:** NYX Chat (Web Application)  
**Fokus:** Visibilitas Global & Kemudahan Penemuan

---

## 1. 📊 Ringkasan Eksekutif

Aplikasi ini memiliki pondasi Technical SEO yang solid, namun masih memiliki kelemahan besar dalam jangkauan global (Internationalization).

Meskipun infrastruktur meta tags dan robots.txt sudah sangat baik ("AI-Ready"), aplikasi ini saat ini hanya akan ditemukan oleh pengguna berbahasa Inggris. Untuk memenuhi target "mudah ditemui dimanapun lokasi mereka berada", strategi multi-bahasa (i18n) adalah prioritas utama yang hilang.

---

## 2. ✅ Kekuatan (Sudah Optimal)

### A. Infrastruktur Meta Tags (SEO.tsx)

Anda telah membangun komponen SEO yang reusable dan kuat menggunakan `react-helmet-async`.

- **Social Cards Ready:** Open Graph (Facebook/LinkedIn) dan Twitter Cards sudah terkonfigurasi otomatis dengan gambar default (`normal-desktop-dark.png`).
- **Canonical URLs:** Mencegah masalah konten duplikat.
- **Robots Control:** Konfigurasi `max-image-preview:large` sangat bagus untuk Google Discover.

### B. Generative Engine Optimization (GEO)

File `robots.txt` Anda sangat progresif karena secara eksplisit mengizinkan AI Crawlers (GPTBot, CCBot, Google-Extended).

- **Dampak:** Ini memastikan NYX akan muncul dalam jawaban ChatGPT, Gemini, atau Perplexity ketika orang bertanya tentang "secure messaging app".
- **Security:** Anda dengan tepat memblokir `/chat` dan `/api` agar data privat tidak terindeks.

### C. Sitemap & Struktur Link

- `sitemap.xml` sudah bersih dan hanya memuat halaman publik penting.
- Landing page menggunakan semantic HTML (`<header>`, `<main>`, `<section>`, `<h1>`-`<h3>`) yang memudahkan Google memahami hierarki konten.

---

## 3. ⚠️ Area Perbaikan (Gap Analisis)

### A. Masalah Utama: "Invisible" untuk Non-English User (Global Reach)

Anda ingin aplikasi ini ditemukan "dimanapun lokasi mereka berada", tetapi saat ini konten hanya tersedia dalam Bahasa Inggris.

- **Masalah:** Orang di Indonesia mencari "aplikasi chat aman", orang di Brazil mencari "aplicativo de mensagem seguro". NYX tidak akan muncul untuk kata kunci ini.
- **Solusi:** Implementasikan i18n (Internationalization).
  1. Terjemahkan Landing Page ke bahasa strategis (Indonesia, Spanyol, Portugis, Mandarin, Hindi).
  2. Tambahkan tag `hreflang` di `SEO.tsx` agar Google menyajikan versi bahasa yang tepat sesuai lokasi user.

### B. JSON-LD Schema (Low Hanging Fruit)

Di `LandingPage.tsx`, properti `schemaMarkup` belum digunakan pada komponen `<SEO />`.

- **Masalah:** Google harus "menebak" bahwa ini adalah aplikasi software.
- **Solusi:** Suntikkan schema `SoftwareApplication` agar muncul Rich Snippet (Rating bintang, Harga "Free", OS Support) di hasil pencarian.

### C. Client-Side Rendering (SPA Risk)

NYX adalah Single Page Application (Vite).

- **Masalah:** Saat crawler (terutama selain Google, seperti Bing atau Yandex) mengunjungi website, mereka melihat file `index.html` yang hampir kosong sebelum JavaScript berjalan.
- **Solusi:** Pertimbangkan Pre-rendering (SSG) hanya untuk halaman publik (`/`, `/help`, `/privacy`) menggunakan plugin seperti `vite-plugin-ssr` atau migrasi halaman marketing ke Next.js/Astro.

---

## 4. 🚀 Rekomendasi Aksi (Action Plan)

### 1. Tambahkan Schema Markup (Prioritas Cepat)

Update `LandingPage.tsx` untuk menyertakan data terstruktur:

```tsx
const softwareSchema = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "NYX",
  "applicationCategory": "CommunicationApplication",
  "operatingSystem": "Web, Android, iOS",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "featureList": "End-to-End Encryption, Zero Knowledge, No Phone Number Required"
});

// Pass ke komponen SEO
<SEO ... schemaMarkup={softwareSchema} />
```

### 2. Mulai Strategi Lokalisasi (Jangka Panjang)

- Gunakan library `react-i18next`.
- Buat file JSON bahasa (`en.json`, `id.json`, `es.json`).
- Deteksi browser language user dan redirect otomatis.

### 3. Optimalkan Keyword Lokal

Jangan hanya "Secure Messaging". Targetkan long-tail keywords spesifik:

- "Anonymous chat without phone number"
- "Private wa alternative"
- "Aplikasi chat rahasia anti sadap" (untuk target Indonesia)

---

# Laporan Audit GEO (Generative Engine Optimization)

**Target:** NYX Chat  
**Tujuan:** Memastikan aplikasi direkomendasikan oleh AI (ChatGPT, Gemini, Perplexity) saat user mencari "aplikasi chat private tanpa nomor HP".

---

## 1. 🤖 Status Visibilitas di Mata AI

Saat ini, NYX memiliki skor **GEO B- (Menengah)**.

Meskipun `robots.txt` sudah mengizinkan AI crawler, struktur data (Schema) yang menjadi "bahasa ibu" mesin AI belum diimplementasikan. Tanpa ini, AI harus "menebak" konteks konten Anda, yang seringkali menyebabkan halusinasi atau pengabaian.

| Elemen GEO      | Status       | Analisa                                                                                             |
|-----------------|--------------|-----------------------------------------------------------------------------------------------------|
| Akses Crawler   | ✅ Excellent | GPTBot, CCBot, Google-Extended diizinkan di `robots.txt`.                                             |
| Struktur Konten | ⚠️ Cukup     | Landing page menggunakan semantic HTML, tapi tabel perbandingan agak berat di styling CSS.          |
| Kutipan Data    | ❌ Kurang    | Tidak ada Schema Markup (JSON-LD) untuk mendefinisikan Software, FAQ, atau Author.                  |
| Konteks Entitas | ✅ Bagus     | PrivacyPage sangat detail menjelaskan teknis (Argon2, Signal Protocol), ini "makanan enak" buat AI. |

---

## 2. 🛠️ Rekomendasi Teknis (High Impact)

AI sangat menyukai data yang terstruktur. Berikut adalah kode spesifik untuk membuat NYX "dimengerti" oleh mesin.

### A. Implementasi SoftwareApplication + FAQPage Schema

Di file `web/src/pages/LandingPage.tsx`, kita harus menyuntikkan metadata ini ke komponen `<SEO />`.

**Langkah Implementasi:**

1. Buka `web/src/pages/LandingPage.tsx`.
2. Tambahkan definisi schema berikut sebelum return statement:

```tsx
const landingSchema = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "name": "NYX Chat",
      "applicationCategory": "CommunicationApplication",
      "operatingSystem": "Web, Android, iOS, Windows, macOS, Linux",
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "USD"
      },
      "description": "Zero-knowledge, end-to-end encrypted messaging app that requires no phone number. Built on the Signal Protocol.",
      "featureList": [
        "No Phone Number Required",
        "End-to-End Encryption (Signal Protocol)",
        "Self-Destructing Messages",
        "Local-First Architecture",
        "PWA (Progressive Web App)"
      ],
      "softwareHelp": "https://nyx-app.my.id/help",
      "author": {
        "@type": "Person",
        "name": "Han",
        "url": "https://github.com/h4nzs"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is NYX end-to-end encrypted?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. NYX uses the Signal Protocol (X3DH + Double Ratchet) ensuring only you and the recipient can read messages."
          }
        },
        {
          "@type": "Question",
          "name": "Do I need a phone number?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. You sign up with a username and password only. Your identity is protected by Argon2 hashing."
          }
        },
        {
          "@type": "Question",
          "name": "Is it free?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, NYX is open-source (AGPL-3.0) and completely free to use without ads or tracking."
          }
        }
      ]
    }
  ]
});

<SEO
  title="NYX"
  description="..."
  canonicalUrl="/"
  schemaMarkup={landingSchema} // <--- Tambahkan ini
/>
```

### B. Optimasi "Citable Facts" (Fakta yang Bisa Dikutip)

AI sering mencari tabel perbandingan untuk menjawab pertanyaan "Apa bedanya NYX dengan WhatsApp?".

Tabel di `LandingPage.tsx` saat ini penuh dengan ikon (`<FiCheck />`). AI vision mungkin bisa membacanya, tapi AI teks (LLM) lebih suka teks eksplisit.

**Saran:** Tambahkan atribut `aria-label` atau teks tersembunyi yang deskriptif pada sel tabel.

```tsx
// SEBELUM:
<td className="..."> <FiCheck /> </td>

// SESUDAH (AI-Friendly):
<td className="...">
  <span className="sr-only">Yes, Supported</span> {/* Teks ini dibaca AI & Screen Reader */}
  <div aria-hidden="true"><FiCheck /></div>
</td>
```

### C. Tech Article Schema untuk Halaman Privasi

Halaman `PrivacyPage.tsx` sangat teknis. Beritahu AI bahwa ini adalah sumber otoritatif untuk arsitektur keamanan.

Tambahkan schema `TechArticle` di `PrivacyPage.tsx`:

```tsx
const techArticleSchema = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "NYX Security Architecture & Zero-Knowledge Protocol",
  "alternativeHeadline": "How NYX protects metadata without storing user identities",
  "author": {
      "@type": "Organization",
      "name": "NYX Project"
  },
  "keywords": "Signal Protocol, Argon2, Zero-Knowledge, End-to-End Encryption, Privacy",
  "articleBody": "NYX uses a Double Ratchet algorithm...",
  "datePublished": "2026-03-01"
});
```

---

## 3. 🎯 Prediksi Hasil

Jika rekomendasi di atas diterapkan:

1. **Perplexity/Bing Chat:** Akan menampilkan Rich Card dengan rating, harga (Free), dan fitur kunci langsung di hasil pencarian.
2. **ChatGPT/Gemini:** Saat ditanya "Best anonymous chat app 2026", kemungkinan besar akan mengutip NYX karena memiliki data terstruktur yang memvalidasi klaim "No Phone Number" dan "Signal Protocol".
3. **Autoritas:** Google akan menganggap situs ini sebagai entitas "Software" yang sah, bukan sekadar blog atau situs scam.

> Apakah Anda ingin saya menerapkan Schema Markup ini sekarang ke `LandingPage.tsx`?

terdapat beberapa bug saat saya mencoba ui dalam bahasa indonesia, analisa semua temuan saya ini tentang teks yang hanya mendisplay nama kata   
   kunci json nya dan bukan teksnya, juga ada yang tidak berubah ke bahasa indonesia:                                                              
                                                                                                                                                   
   Return                                                                                                                                          
   keys_page.title                                                                                                                                 
                                                                                                                                                   
   keys_page.subtitle                                                                                                                              
                                                                                                                                                   
   Your private keys are the only way to decrypt your messages. They are stored locally on this device. Losing these keys means losing your        
   message history forever.                                                                                                                        
   keys_page.recovery_title                                                                                                                        
                                                                                                                                                   
   keys_page.recovery_desc                                                                                                                         
   keys_page.rotation_title                                                                                                                        
                                                                                                                                                   
   keys_page.rotation_desc                                                                                                                         
                                                                                                                                                   
   password_prompt.title                                                                                                                           
                                                                                                                                                   
   password_prompt.desc                                                                                                                            
   password_prompt.vault_idpassword_prompt.status_locked                                                                                           
   action.abort                                                                                                                                    
   action.unlock                                                                                                                                   
   KEYS_PAGE.REVEAL_BTN                                                                                                                            
   KEYS_PAGE.ROTATE_BTN                                                                                                                            
   sessions_page.title                                                                                                                             
                                                                                                                                                   
   sessions_page.subtitle                                                                                                                          
   Desktop / Firefox                                                                                                                               
   sessions_page.current                                                                                                                           
                                                                                                                                                   
   sessions_page.ip 114.10.149.42                                                                                                                  
                                                                                                                                                   
   sessions_page.last_ping 3/22/2026, 10:59:44 PM                                                                                                  
   smart.ai_reply                                                                                                                                  
                                                                                                                                                   
   Auto-generate response suggestions.                                                                                                             
   SUPPORT.PUSH_NOTIF                                                                                                                              
   support.help_center                                                                                                                             
   support.legal                                                                                                                                   
   support.report_bug                                                                                                                              
   report.title_bug                                                                                                                                
                                                                                                                                                   
   report.desc_bug                                                                                                                                 
   report.summary_label                                                                                                                            
   report.details_label                                                                                                                            
                                                                                                                                                   
   report.summary_placeholder                                                                                                                      
   report.details_placeholder                                                                                                                      
   report.submit                                                                                                                                   
   NYX disediakan "SEBAGAIMANA ADANYA", tanpa jaminan apa pun. Pengelola tidak bertanggung jawab atas kehilangan data, kunci yang dikompromikan,   
   atau gangguan layanan. Anda bertanggung jawab penuh untuk mengelola Frasa Pemulihan kriptografi Anda. NYX is provided "AS IS", without warranty 
   of any kind. The maintainers shall not be held liable for any data loss, compromised keys, or service interruptions. You are solely responsible 
   for managing your cryptographic Recovery Phrase.                                                                                                
   Kode sumber NYX bangga menjadi open-source dan dilindungi dengan ketat di bawah The NYX source code is proudly open-source and fiercely         
   protected under the .Jika Anda memodifikasi basis kode NYX dan mengizinkan pengguna berinteraksi dengannya melalui jaringan (misalnya,          
   menghostingnya sebagai SaaS), Anda secara hukum diwajibkan untuk merilis kode sumber yang dimodifikasi kepada publik. If you modify the NYX     
   codebase and allow users to interact with it over a network (e.g., hosting it as a SaaS), you are legally obligated to release your modified    
   source code to the public.                                                                                                                      
   Kami menyediakan fitur eksperimental "Balasan Cerdas" menggunakan API Google Gemini. Fitur ini We provide an experimental "Smart Reply" feature 
   utilizing the Google Gemini API. This feature is .                                                                                              
   actioin.view_profile                                                                                                                            
   action.pin_chat                                                                                                                                 
   action.block_user                                                                                                                               
   action.delete_chat                                                                                                                              
   action.delete_group                                                                                                                             
   input.placeholder_default                                                                                                                       
   input.placeholder_offline                                                                                                                       
   chat_info.title                                                                                                                                 
   chat_info.e2ee.title                                                                                                                            
                                                                                                                                                   
   All your conversations are protected by strong End-to-End Encryption, inspired by the Signal Protocol. Think of it as a private digital vault.  
                                                                                                                                                   
   chat_info.e2ee.content_2                                                                                                                        
   chat_info.keys.title                                                                                                                            
                                                                                                                                                   
   Your entire account is secured by a single "Master Key". This key is generated from your unique 24-word Recovery Phrase that you received       
   during registration.                                                                                                                            
                                                                                                                                                   
   The most important concept: Your Recovery Phrase is the only way to access your account if you forget your password or switch devices without   
   access to an old one. We do not store it and cannot recover it for you.                                                                         
   chat_info.storage.title                                                                                                                         
                                                                                                                                                   
   For your convenience, your Master Key is stored on this device in a highly secure, encrypted bundle. This bundle is "locked" using your         
   password.                                                                                                                                       
                                                                                                                                                   
       chat_info.storage.list_1                                                                                                                    
       chat_info.storage.list_2                                                                                                                    
                                                                                                                                                   
   chat_info.access.title                                                                                                                          
                                                                                                                                                   
   chat_info.access.content_1                                                                                                                      
                                                                                                                                                   
       chat_info.access.list_1_label chat_info.access.list_1_text                                                                                  
       chat_info.access.list_2_label chat_info.access.list_2_text                                                                                  
       chat_info.access.list_3_label If you lost your device and backups, use the "Restore" feature with your 24-word Recovery Phrase. This will   
   reset your password and restore your Identity Keys, but chat history will be lost without a Vault backup.                                       
                                                                                                                                                   
   chat_info.best_practices.title                                                                                                                  
                                                                                                                                                   
       DO store your Recovery Phrase in a very safe, offline location (e.g., a safe, physical note, or an encrypted password manager).             
       DO verify your contacts' identities using the available security features before sharing sensitive information.                             
       DO NOT share your password or Recovery Phrase with anyone. Ever.                                                                            
       DO NOT stay logged in on public or shared computers. Use the "Active Sessions" feature in Settings to log out remotely if needed.           
   search.placeholder                                                                                                                              
   group_info.create_title                                                                                                                         
   action.create_group                                                                                                                             
   scan.title                                                                                                                                      
                                                                                                                                                   
   scan.desc                                                                                                                                       
                                                                                                                                                   
   scan.awaiting                                                                                                                                   
   notifications.title                                                                                                                             
                                                                                                                                                   
   notifications.empty                                                                                                                             
   About Media                                                                                                                                     
   VIEW PERSONNEL FILE                                                                                                                             
   VERIFY ENCRYPTION HANDSHAKE                                                                                                                     
   BLOCK SIGNAL                                                                                                                                    
   REPORT SIGNAL                                                                                                                                   
   media.no_media                                                                                                                                  
   profile.encrypted                                                                                                                               
   profile.bio_data                                                                                                                                
    profile.system_telemetry                                                                                                                       
   profile.verified_operator                                                                                                                       
   profile.home_server                                                                                                                             
   profile.session_status                                                                                                                          
   action.confirm                                                                                                                                  
   restore.title                                                                                                                                   
                                                                                                                                                   
   restore.subtitle                                                                                                                                
   restore.labels.identifier                                                                                                                       
   restore.labels.phrase                                                                                                                           
   restore.labels.new_password                                                                                                                     
   restore.buttons.abort                                                                                                                           
   RESTORE.BUTTONS.RECOVER                                                                                                                         
   ---                                                                                                                                             
   ini semua adalah teks yang muncul di ui secara mentah saat saya menggunakan bahasa indonesia dan beberapa ada yang duplikat id+en seperti pada  
   privacypage.