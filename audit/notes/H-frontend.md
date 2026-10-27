# H — Frontend

Diperiksa (statis): `web/src/lib/{db,messagePipeline,peerIdentityTrust,
ktGossip,transportClient,api}.ts`, `web/src/workers/{crypto,transport}.worker.ts`
(permukaan), `web/src/App.tsx`, `web/src/lib/__tests__/*`,
`web/public/locales/*`, `web/nginx.conf` + `ops/nginx/nyx.conf` (CSP).

## Yang terbukti benar

- **Dexie aditif.** `web/src/lib/db.ts:415-448` menaikkan versi 12→16; setiap
  versi baru hanya menambah tabel/index, tidak menghapus — jalur upgrade dari
  v12 aman secara skema. Data KT (`ktMonitoring`, `ktGossip`) disegel `ENC1:`
  sebelum ditulis (verifikasi: `ktGossip.ts` menyimpan baris ter-seal).
- **CSP produksi tanpa `unsafe-eval`** (`$app_csp` di `ops/nginx/nyx.conf:273`);
  Zod dipaksa jitless karena itu.
- **i18n lengkap:** 7 namespace × 4 bahasa, **0 kunci hilang / 0 yatim**
  (skrip pembanding flatten dijalankan saat audit).
- **Routing mengikuti `hasRestoredKeys`**, modal global `React.lazy`, dan
  `Virtuoso itemContent` membaca pesan lewat ref (tidak ada `messages` di deps).
- **Pesan milik sendiri yang gagal didekripsi** menjadi `waiting_for_key`,
  bukan gelembung error (`messagePipeline.ts`).

## Temuan terkait

- **F-09** — status KT "tidak tersedia" tidak punya permukaan UI; pengguna tidak
  bisa membedakan "terverifikasi log" dari "pemeriksaan tidak berjalan".
- **F-14** — drif dokumen: `AGENTS.md` menyebut NyxUnifiedDB **v13**, kode sudah
  **v16** (terverifikasi: `this.version(16)` di `db.ts:442`).

## Batas

- **XSS dinilai statis saja** (markdown/link preview/embed/nama profil) — tidak
  ada uji runtime per-komponen, tidak ada payload berbahaya yang dijalankan.
- Service worker (precache, `NavigationRoute`, denylist) dibaca, tidak diuji
  runtime; tidak ada Lighthouse/a11y otomatis.
- E2E Playwright tidak dijalankan (butuh Postgres/Redis/server dev).
