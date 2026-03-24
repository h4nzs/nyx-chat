# Laporan Audit SEO & Analisa Codebase (Marketing Refactor)

Analisa ini dilakukan pada direktori `marketing/` (Astro) dan interaksinya dengan `web/` (React SPA). Fokus utama adalah pada implementasi SEO, performa rendering, dan struktur arsitektur.

## 🚨 Temuan Kritis (Critical Issues)

### 1. Masalah Rendering Metadata (React Helmet di Astro)
**Status:** 🔴 **Critical**
- **Masalah:** Anda menggunakan `react-helmet-async` di dalam komponen React (`SEO.tsx`) yang di-hydrate dengan `client:load` di dalam Astro.
- **Dampak:** Meta tags (Title, Description, OG Image, Twitter Card) **tidak akan muncul** pada source code HTML statis saat build (`npm run build`). Crawler (Googlebot, Bing) dan Link Preview (WhatsApp, Twitter, Discord) akan melihat halaman tanpa metadata karena mereka membaca HTML statis awal, bukan hasil render JavaScript klien.
- **Solusi:** Pindahkan logika SEO sepenuhnya ke komponen native Astro (`.astro`). Jangan gunakan `react-helmet` di dalam Astro kecuali untuk kasus SSR dynamic yang sangat spesifik.

### 2. "SPA di dalam Astro" (Client-Side Rendering Berlebih)
**Status:** 🟠 **Major**
- **Masalah:** Halaman utama (`index.astro`) hanya memanggil satu komponen besar `<LandingEntry client:load />`.
- **Dampak:** Ini membatalkan keuntungan utama Astro (Zero JS by default & HTML Statis cepat). Browser harus mendownload bundle React + Framer Motion + i18n sebelum konten ("LCP") bisa tampil. Skor Core Web Vitals (terutama LCP dan INP) akan lebih rendah dibanding implementasi Astro murni.
- **Solusi:** Pecah `LandingPage.tsx` menjadi komponen-komponen kecil Astro (`.astro`). Gunakan React hanya untuk bagian interaktif (seperti dropdown FAQ atau toggle theme). Teks statis harus dirender di server (HTML).

### 3. Implementasi i18n Tidak SEO-Friendly
**Status:** 🟠 **Major**
- **Masalah:** Internationalization (i18n) ditangani oleh `react-i18next` secara client-side tanpa perubahan URL (State-based).
- **Dampak:** Google hanya akan mengindeks satu bahasa (default). Halaman versi bahasa lain (ID, ES, PT) tidak memiliki URL unik (seperti `/id`, `/es`) sehingga tidak akan pernah diranking oleh mesin pencari lokal.
- **Solusi:** Gunakan [Astro i18n Routing](https://docs.astro.build/en/guides/internationalization/). Struktur file harusnya `src/pages/[lang]/index.astro`.

### 4. Manajemen Aset Statis Manual
**Status:** 🟡 **Moderate**
- **Masalah:** `sitemap.xml` dan `robots.txt` berada di folder `public/` dan sepertinya ditulis manual (hardcoded).
- **Dampak:** Jika Anda menambah halaman baru (misal `/blog` atau `/features`), sitemap tidak akan update otomatis. Risiko link mati atau halaman yatim (orphan pages).
- **Solusi:** Gunakan integrasi `@astrojs/sitemap`.

---

## 🛠️ Rincian Audit Teknis

### A. Metadata & Social Graph
| Komponen | Status | Temuan |
| :--- | :--- | :--- |
| **Title Tag** | ⚠️ | Ada di `MainLayout` tapi tidak dinamis (hanya menerima prop title dasar), logika `SEO.tsx` tidak terekspos ke HTML statis. |
| **Meta Desc** | ❌ | Tidak ada di HTML statis (hanya di JS client). |
| **Canonical** | ❌ | Tidak ada di HTML statis. |
| **Open Graph** | ❌ | Tidak ada di HTML statis (Link preview di WA/Twitter akan rusak/kosong). |
| **JSON-LD** | ⚠️ | Schema markup ada di `SEO.tsx`, tapi tidak ter-render di HTML awal. |

### B. Performa & Core Web Vitals
| Metrik | Analisa Kode | Potensi Masalah |
| :--- | :--- | :--- |
| **LCP (Loading)** | Render bergantung pada `client:load` React. | Browser menunggu JS execute baru menampilkan teks Hero. |
| **CLS (Shift)** | Image menggunakan tag `<img>` standar tanpa `width`/`height` eksplisit. | Potensi layout shift saat gambar dimuat. Harusnya pakai `<Image />` Astro. |
| **Bundle Size** | Memuat seluruh `framer-motion` dan `react-icons` di main thread. | Ukuran JS awal besar untuk sekadar landing page statis. |

### C. Struktur Kode (Astro vs React)
Saat ini struktur folder `marketing/` adalah:
```text
marketing/src/
├── pages/index.astro   -> Wrapper tipis
├── entries/            -> React Provider Wrapper
└── react-pages/        -> Seluruh konten halaman (Monolithic)
```
Ini adalah pola "Astro sebagai Build Tool saja", bukan "Astro sebagai Framework".

---

## ✅ Rekomendasi Perbaikan (Action Plan)

### Tahap 1: Perbaikan Fundamental SEO (Prioritas Tertinggi)
1.  **Buat Komponen `SEO.astro`:**
    Pindahkan semua logika dari `SEO.tsx` ke `marketing/src/components/SEO.astro`. Terima props via `Astro.props`.
2.  **Update `MainLayout.astro`:**
    Masukkan komponen `SEO.astro` ke dalam `<head>` di layout ini.
    ```astro
    <head>
      <SEO title={title} description={description} ... />
    </head>
    ```
3.  **Hapus `Helmet`:** Lepaskan ketergantungan `react-helmet-async` dari marketing site.

### Tahap 2: Migrasi ke "Island Architecture"
1.  **Migrasi Konten Statis:**
    Pindahkan Hero Section, Features, dan Footer dari React (`LandingPage.tsx`) langsung ke `index.astro` (HTML/Tailwind biasa). Ini akan mengurangi JS bundle secara drastis.
2.  **Isolasi Interaktivitas:**
    Hanya gunakan React (`client:visible` atau `client:load`) untuk komponen yang benar-benar butuh state:
    - `FAQSection` (Accordions)
    - `LanguageSwitcher`
    - `ThemeToggle`

### Tahap 3: Teknis Lanjutan
1.  **Install `@astrojs/sitemap`:** Agar sitemap generate otomatis saat build.
2.  **Gunakan Astro Image:** Ganti tag `<img>` dengan `<Image />` dari `astro:assets` untuk optimasi format (WebP) dan ukuran otomatis.
3.  **Setup i18n Routing:** Struktur ulang `src/pages` menjadi `src/pages/[lang]/index.astro` untuk mendukung multi-bahasa yang terindeks Google.

---

**Kesimpulan:**
Refactor ke Astro adalah langkah tepat untuk performa, namun implementasi saat ini masih membawa beban "SPA" dari `web/`. Untuk mencapai skor SEO 100 dan performa maksimal, Anda perlu memindahkan rendering konten dari React (Client) ke Astro (Build-time/Server).

<br/>

# Laporan Audit GEO (Generative Engine Optimization)

Audit ini mengevaluasi seberapa mudah konten situs dipahami, dikutip, dan direkomendasikan oleh mesin pencari berbasis AI (ChatGPT, Perplexity, Claude, Gemini).

## 📊 Skor GEO: Rendah (Perlu Optimasi Struktur)

Meskipun konten Anda berkualitas tinggi (Zero Knowledge, Signal Protocol), cara penyampaiannya ("Invisible Content") membuat AI sulit mengutipnya.

### 1. Masalah "Invisible Content" (Fatal untuk GEO)
**Status:** 🔴 **Critical**
- **Temuan:** Sama seperti SEO, konten teks dirender oleh React Client-Side. Crawler AI (seperti `GPTBot` atau `ClaudeBot`) yang melakukan *scraping* cepat seringkali hanya mengambil HTML awal.
- **Dampak:** AI melihat halaman kosong. Saat user bertanya *"Apa bedanya NYX dengan WhatsApp?"* ke ChatGPT, ChatGPT tidak bisa menjawab karena tidak bisa membaca tabel perbandingan yang ada di dalam JS.
- **Rekomendasi:** Pindahkan tabel perbandingan dan fitur utama ke HTML statis (`.astro`).

### 2. Struktur Data & Entitas
**Status:** 🟡 **Moderate**
- **Temuan:** Tabel perbandingan di Landing Page sangat bagus untuk manusia, tapi untuk AI, strukturnya agak kompleks (divs + icons).
- **Rekomendasi:** Gunakan elemen `<table>` semantik standar HTML untuk data perbandingan. Tambahkan atribut `summary` atau caption yang menjelaskan: *"Table comparing NYX Privacy Features vs WhatsApp and Telegram"*. Ini memudahkan AI mengekstrak fakta "NYX tidak butuh nomor HP".

### 3. Robots.txt & Akses Crawler
**Status:** 🟢 **Excellent**
- **Temuan:** Anda secara eksplisit mengizinkan `GPTBot`, `CCBot`, dan `Google-Extended`.
- **Dampak:** Ini langkah strategis yang sangat baik. Anda mengundang AI untuk mempelajari protokol keamanan Anda, meningkatkan peluang dikutip sebagai "contoh aplikasi chat aman".

### 4. Kualitas Konten & Sitasi (Authoritativeness)
**Status:** 🟢 **Good**
- **Temuan:** Halaman Privacy (`PrivacyPage.tsx`) mengandung istilah teknis yang spesifik: "Argon2id hashing", "Double Ratchet algorithm", "Zero Telemetry".
- **Peluang:** AI sangat suka data spesifik.
- **Rekomendasi:**
    - Tambahkan link eksternal ke Whitepaper Signal Protocol atau dokumentasi Argon2 untuk memvalidasi klaim ("Citation Loops").
    - Buat bagian "Technical Specs" yang terpisah dan padat data di halaman Help atau About agar mudah diparsing.

### 5. FAQ Schema
**Status:** ⚠️ **Warning**
- **Temuan:** Ada JSON-LD FAQ di `LandingPage.tsx`, tapi karena dirender JS, mungkin terlewat.
- **Rekomendasi:** Pastikan JSON-LD ini ada di HTML statis via komponen Astro. FAQ adalah sumber utama "Featured Snippets" di Google dan jawaban langsung di Perplexity.

---

## 🚀 Strategi GEO "Quick Wins"

1.  **Definisi Entitas yang Jelas (Di HTML Statis):**
    Pastikan ada paragraf yang secara eksplisit mendefinisikan apa itu NYX dengan format [Subjek] adalah [Predikat].
    > *"NYX is a zero-knowledge messaging application that uses the Signal Protocol for end-to-end encryption without requiring a phone number."*
    (Letakkan ini di `<p>` pertama di halaman Home/About).

2.  **Perbandingan Langsung (Direct Comparison):**
    AI sering ditanya "Alternatif WhatsApp yang aman". Pastikan teks di tabel perbandingan Anda mudah dibaca mesin:
    - *Bad:* (Icon Check)
    - *Good:* "Yes, Supported" (Text hidden visible to screen readers/bots if using icons).

3.  **Author Authority:**
    Di `FIXES.md` sebelumnya, schema menyebutkan "Author: Han". Pertimbangkan membuat halaman "About" atau "Security Architecture" yang menjelaskan siapa pengembangnya atau audit keamanan yang telah dilakukan. Kepercayaan (Trust) adalah faktor E-E-A-T yang vital.

4.  **Halaman "Help" sebagai Knowledge Base:**
    Halaman `HelpPage.tsx` saat ini agak tipis. Ubah menjadi "Knowledge Base" dengan struktur hierarki yang jelas. AI sangat suka mengutip dokumentasi teknis yang terstruktur rapi.

---

**Kesimpulan GEO:**
Anda memiliki fondasi konten yang "emas" untuk AI (Topik: Privasi, Keamanan, Kripto), namun "emas" tersebut terkubur dalam peti JavaScript yang terkunci. Buka kuncinya dengan Server-Side Rendering (Astro native) agar AI bisa melihat dan mempromosikan aplikasi Anda.
