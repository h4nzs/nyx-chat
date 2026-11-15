# 01 — Baseline Otomatis

Dijalankan pada 2026-10-31, Node v26.8.2, pnpm 11.4.0, commit `b320c957`.
Tidak ada kegagalan yang saya perbaiki (fase read-only) — hanya dicatat.

## 1.1 Install & build

| Langkah | Perintah | Exit | Catatan |
|---|---|---|---|
| Prisma client | `cd server && npx prisma generate` | 0 | Client sebelumnya **belum ada**; tanpa langkah ini `tsc` server gagal (`PrismaClient` tidak diekspor). Dokumentasi AGENTS sudah menyebut ini — terkonfirmasi. |
| `@nyx/shared` | `pnpm --filter @nyx/shared run build` | 0 | Wajib sebelum typecheck konsumen (dikonfirmasi). |
| Build semua | `pnpm -r run build` | **0** | marketing ✓ (32 halaman), server `tsc` ✓, web `tsc -b && vite build` ✓ (1399 modul), postbuild ✓ (IndexNow dilewati tanpa key). |

Catatan build web: peringatan `Module "crypto"/"node:fs" has been externalized for browser compatibility` dari `@hpke/common`, `@cloudflare/blindrsa-ts`, dan `libsodium` — **warning, bukan error**. Tidak saya nilai sebagai bug (build lolos), tetapi menandakan jalur Node di dependensi ikut ter-bundle; layak dicek bila ada perilaku aneh saat runtime (bukan temuan).

## 1.2 Lint (oxlint, satu-satunya linter)

`pnpm run lint` → **exit 0**. Web: **190 warning, 0 error**. Server: **45 warning, 0 error**.

Semua warning adalah `no-unused-vars`. CI memblokir pada `error`, jadi baseline hijau. Yang relevan untuk audit (bukan gaya): variabel mati di jalur kripto (`web/src/lib/messagePipeline.ts:350,713,715,818`) — dicatat sebagai F-12.

`--report-unused-disable-directives`: tidak ada direktif mati yang dilaporkan pada dua paket yang saya jalankan.

## 1.3 Tes unit

| Suite | Hasil |
|---|---|
| Server (`node:test` via `tsx`, 92 berkas terdaftar eksplisit) | **711 tes, 709 lulus, 2 skip, 0 gagal**, 118.9 s |
| Web (`vitest`) | **134 berkas / 1108 tes, semua lulus, exit 0**, 531.3 s |

Catatan metrik: run pertama terpotong oleh timeout alat (600 s) dan **bukan** kegagalan tes — log tanpa `FAIL`, hanya `[ELIFECYCLE]` akibat proses dihentikan. Run penuh yang dijalankan ulang menyelesaikan **134/134 berkas, 1108/1108 tes**. Durasi 531 s patut diperhatikan untuk CI (lihat `06-tests-docs.md`).

2 tes server yang di-skip tidak saya identifikasi satu per satu.

## 1.4 Tes yang tidak dijalankan

| Suite | Alasan |
|---|---|
| Playwright E2E (`--project=chromium`) | Butuh Postgres + Redis + `nyx-server dev` + `nyx-web dev`; tidak tersedia di sesi ini. `call.spec` juga butuh coturn. |
| `--project=chrome` (WebTransport) | Butuh sidecar Rust + Chrome full build + pinning cert hash. |
| `cargo test` / `cargo clippy` / `cargo audit` | Toolchain ada (`cargo 1.95.0`) tetapi suite tidak dijalankan dalam audit ini. |
| `server/kt-query/build.sh test` (58 tes Go) | `go1.27.1` ada; tidak dijalankan. |
| `scripts/drill-alerts.sh`, `scripts/load/run-relay-load.sh`, `scripts/client-restore-drill.sh`, `scripts/kt-v2-restore-drill.sh` | Butuh Prometheus/pg/k6/waktu; tidak dijalankan. |
| `tools/dr-oracle -check` | Tidak dijalankan. |
| Fuzz parser (`fuzz:parsers`, sidecar fuzz) | Tidak dijalankan. |

## 1.5 Dependency audit

`pnpm audit --prod` → **exit 1**, 3 advisory:

| Paket | Severity | Rentan | Patched | Jalur |
|---|---|---|---|---|
| `qs` | **moderate** | ≥6.7.0 ≤6.16.0 | ≥6.16.1 | `server>express`, `server>express-rate-limit>express`, `server>rate-limit-redis>…>express` |
| `i18next-http-backend` | low | <4.0.4 | ≥4.0.4 | `web`, `marketing` |
| `i18next-http-backend` | low | <4.0.3 | ≥4.0.3 | `web`, `marketing` |

CI menjalankan `pnpm audit --prod`; baseline ini berarti job tersebut **merah** saat ini kecuali ada mekanisme allowlist (tidak saya temukan di `.github/workflows/ci.yml` — tidak saya baca penuh).

## 1.6 Pemindaian rahasia / debug

- **`console.log/warn/error`:** banyak dan disengaja (server ops). Yang saya periksa tidak mencetak kunci/plaintext: log memakai `sanitizeForLog()` untuk id, dan `morgan` hanya aktif non-produksi (alasan: query sensitif). Tidak ditemukan `console.log` yang mencetak token/password/private key di jalur yang saya baca.
- **Rahasia hard-coded:** tidak ditemukan di `server/src` / `web/src` (grep pola key/token tidak menghasilkan nilai literal; `JWT_SECRET`/`CSRF_SECRET`/`NYX_AT_REST_PEPPER` dibaca dari env, dan `getAtRestPepper()` **melempar** di production bila pepper kosong).
- **`TODO/FIXME/HACK`:** tidak saya hitung/klasifikasi menyeluruh — keterbatasan cakupan.
- **`.env`:** tidak dibaca (dan tidak bisa — file env dikecualikan dari pembacaan/searce). `.env.example` ada sebagai template.

## 1.7 Ringkas baseline

Build & lint **hijau**; server test (711) dan web test (1108) **hijau**; `pnpm audit` **merah** karena 3 advisory; E2E/Rust/Go **tidak dijalankan**. Semua ini tercermin di bagian "Scope & limitations" laporan akhir.
