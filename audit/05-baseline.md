# 05 — Baseline (HEAD `25b1699`, dijalankan 2026-10-25 di mesin audit)

Lingkungan: Node 26.8.2, pnpm 11.4.0, Rust 1.95.0, Go 1.27.1, Redis lokal hidup
(`PONG`), Postgres lokal menerima koneksi (tapi **tidak ada kredensial peran** untuk
audit — lihat `06-tidak-diperiksa.md`), Chromium headless tanpa WebTransport.

> Working tree tidak bersih: `docs/10-deployment-ops.md` (+63) dan
> `ops/cloudflare/worker/server-down-worker.js` (+11/−4) modif, plus berkas
> `ops/cloudflare/worker/{build.mjs,server-down-worker.test.mjs,src/}` yang belum
> di-track. Audit ini menilai **HEAD**; perubahan kerja itu dicatat sebagai konteks,
> bukan sebagai bagian dari kode yang diaudit.

## Hasil perintah (persis seperti `AGENTS.md`)

| # | Perintah | Exit | Hasil |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | 12 s |
| 2 | `pnpm --filter @nyx/shared run build` | 0 | 9 s |
| 3 | `cd server && npx prisma generate` | 0 | 12 s |
| 4 | `pnpm run build` | 0 | 141 s (shared+server+web+marketing) |
| 5 | `pnpm -r --if-present run test` | 0 | 536 s |
| 6 | `pnpm run lint` (oxlint) | 0 | 0 error, **193 warning** (`no-unused-vars`) |
| 7 | `node scripts/check-pq-only.mjs` | **1** | **GAGAL** — lihat di bawah |
| 8 | `bash scripts/check-vendor.sh` | 0 | lulus |
| 9 | `bash scripts/check-wasm-artifacts.sh` | 0 | lulus |
| 10 | `pnpm audit --prod` | **1** | **10 kerentanan (3 high, 5 moderate, 2 low)** |
| 11 | `cd server/transport-sidecar && cargo test --locked` | 0 | lulus |
| 12 | `… && cargo clippy --all-targets -- -D warnings` | **101** | **3 error** (`manual_checked_ops`, `manual_is_multiple_of`, `question_mark`) |
| 13 | `cd server/pir-sidecar && cargo test --locked` | 0 | lulus |
| 14 | `cd server/pir-sidecar && cargo clippy --all-targets -- -D warnings` | 0 | lulus |
| 15 | `cd server/kt-query && ./build.sh test` | 0 | lulus (offline, `-mod=vendor`) |
| 16 | `cd tools/dr-oracle && go build/vet/test ./... && go run . -check` | 0 | "vektor oracle identik dengan hasil regenerasi" |
| 17 | `scripts/drill-alerts.sh` | — | **tidak dijalankan** (mengunduh promtool; lihat `06`) |
| 18 | `pnpm exec playwright test --project=chromium` | — | **tidak dijalankan**; Prisma reset tidak boleh dijalankan dan Chromium mesin ini tanpa WebTransport |

### Detail angka test

- Server (`node:test` via `tsx`): **659 tes, 657 pass, 0 fail, 2 skip**.
  - Skip: `live: penulisan nyata ke binary KT (opt-in NYX_KT_LIVE_WRITE=1)` dan
    `live: entri rotasi masuk ke binary KT (opt-in NYX_KT_LIVE_WRITE=1)` — opt-in
    yang wajar, bukan penyembunyian kegagalan (jalur KT tetap diuji lewat fake).
- Web (vitest): **125 berkas, 1007 tes, semuanya pass**.
- Seluruh **83** berkas `server/tests/*.test.ts` terdaftar di skrip `test`
  `server/package.json` (0 yatim) — dicek dengan membandingkan `readdirSync('tests')`
  terhadap isi skrip.

### Semua kondisi skip yang ditemukan

| Lokasi | Kondisi | Menyembunyikan kegagalan? |
|---|---|---|
| `server/tests/ktQuery.test.ts` (2) | `NYX_KT_LIVE_WRITE=1` tidak diset | Tidak — jalur KT diuji lewat fake; ini uji tulis ke binary nyata |
| `web/src/lib/__tests__/{spqr*,keyTransparency*,ktBundleProof*}` | `HAS_WASM` / `HAS_FIXTURES` / `HAS_QUERY_FIXTURES` / Go tidak ada | Tidak — pada run ini semua prasyarat terpenuhi (1007 pass, 0 skip); bila WASM hilang, suite KT/SPQR hilang seluruhnya, jadi CI harus tetap memastikan WASM ada (`check-wasm-artifacts`) |
| `web/e2e/{transport,chat,spqr,call}.spec.ts` | `WebTransport` tidak ada / coturn tidak jalan / sidecar tidak aktif | Tidak — skip menulis alasan; tetapi artinya jalur WT **tidak** teruji di mesin ini |
| `web/e2e/regression.spec.ts:149` | `VITE_FORCE_WSS=1` atau uplink WT tidak tersedia | Tidak — burner memang butuh WT; skip beralasan |
| `web/e2e/regression.spec.ts` (storage) | Kredensial R2 tidak ada | Tidak — upload burner tidak bisa diuji tanpa storage |

### `check-pq-only.mjs` (GAGAL)

```
Guard PQ-only gagal:
  - server/src/utils/privacyPass.ts: RSABSSA 0 -> 4 (klasik-only baru)
  - web/src/lib/privacyPass.ts: RSABSSA 0 -> 3 (klasik-only baru)
```

Berkas ini baru (commit `ab7ef8e3`, 2026-10-25) dan memakai blind RSA klasik
(RFC 9474) untuk anti-abuse sync anonim — keputusan yang **didokumentasikan**
(`docs/37` §37.9.4 menyatakan token Privacy Pass bukan unforgeability pasca-kuantum).
Masalahnya bukan pemakaian itu, melainkan: baseline/exception tidak diperbarui,
sehingga **job CI `lint` (yang menjalankan guard ini, `.github/workflows/ci.yml:155`)
merah di HEAD**. Pengecualian juga tidak bertambah — jadi manifest tidak bisa dipakai
untuk menjawab "kenapa primitif klasik ini ada".

### `pnpm audit --prod` (GAGAL)

| Severity | Paket | Versi rentan | Jalur produksi |
|---|---|---|---|
| high | `zod` | `<4.6.6` | `server`, `@nyx/shared`, `marketing>astro` |
| high | `body-parser` | `>=2.0.0 <2.4.0` | `server>express`, `express-rate-limit`, `rate-limit-redis` |
| high | `undici` | `>=8.0.0 <8.12.2` | `server>link-preview-js>undici`, `marketing>astro>unifont` |
| moderate | `undici` (2×: unbounded DoS, SRI bypass) | idem | idem |
| moderate | `ip-address` | (Address6 kuadratik) | rantai `astro`/dev-ish |
| moderate/low | `fast-uri` (4×) | `<3.1.9` | `server>@prisma/client>prisma>@prisma/dev>…` |

Job CI `audit` (`.github/workflows/ci.yml:248-263`) menjalankan perintah ini tanpa
`continue-on-error` → **merah**. Catatan penting: `pnpm audit` butuh registri;
hasil di atas berasal dari registri pada 2026-10-25, jadi CI akan melihat hal yang sama.

### `cargo clippy` transport-sidecar (GAGAL, tidak memblokir CI)

```
error[manual_checked_ops]: src/fuzz.rs:217
error[manual_is_multiple_of]: src/fuzz.rs:248
error[question_mark]: src/protocol.rs:201
```

`ci.yml` hanya menjalankan `cargo test` + `cargo build --release` untuk sidecar
(job `e2e-chrome`), jadi ini tidak membuat CI merah — tetapi `AGENTS.md` menyebut
clippy sebagai bagian toolchain Rust dan `audit.md` memintanya. Tiga temuan itu
murni kebersihan lint, bukan bug.

### Yang TIDAK bisa dijalankan (dan alasannya)

- **E2E Playwright**: `e2e/global.setup.ts` menjalankan `server/scripts/reset-test-env.ts`
  yang **menghapus DB lokal** — audit bersifat read-only dan skrip itu destruktif
  terhadap data pengguna mesin ini. Selain itu Chromium headless di sini tidak punya
  `WebTransport`, jadi `transport.spec`/`chat.spec`/`spqr.spec` akan auto-skip dan
  hasilnya tidak bermakna.
- **`prisma db push`**: dilarang oleh `audit.md` §0 dan butuh consent env.
- **`scripts/drill-alerts.sh`**: mengunduh `promtool` 3.15.0 ke `.cache/`; tidak
  dijalankan agar tidak menambah artefak jaringan tak terduga. (Lapis kontrak metrik
  diperiksa manual, lihat `notes/I-infra.md`.)
- **`pnpm audit` offline**: tidak relevan — perintahnya berhasil dan hasilnya nyata.
