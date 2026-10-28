# 07 — Rencana perbaikan (batch seukuran PR)

Urut prioritas + dependensi. Aturan Ponytail dipakai **hanya** di sini: perbaikan
minimal, hapus > tambah. Tidak ada usulan yang melanggar format beku
(`ENC1:`/`ENC2:`, envelope XChaCha, padding 8 KB, `Array.from`, pemecahan
`crypto.worker.ts`).

## Batch 1 — Buka gate CI (blocking, tanpa perubahan runtime)

> **Selesai 2026-10-26 (working tree, belum commit).** Semua gate hijau: `pnpm
audit --prod` 0 vuln, `node scripts/check-pq-only.mjs` lulus (Tier B: 2 untuk
> Privacy Pass), `cargo clippy --all-targets -- -D warnings` bersih + job CI
> `sidecar` baru. Bukti lengkap: `PROGRESS.md` §Perbaikan Batch 1. Catatan:
> clippy `-D warnings` juga menuntut 3 lint tambahan di `main.rs`
> (`while_let_loop`, `let_underscore_future`, `items_after_test_module`) yang
> ikut diperbaiki; `cargo fmt --check` masih merah dan sengaja belum di-CI-kan.

**Tujuan:** HEAD bisa dinilai hijau lagi supaya perbaikan berikutnya punya sinyal.

- **F-03** bump `zod >=4.6.6`, `body-parser/express` berpatched, `undici >=8.12.2`
  lewat `overrides:` di `pnpm-workspace.yaml` (lihat Batch 5 untuk mekanismenya).
  Verifikasi: `pnpm install && pnpm audit --prod` → 0 high.
- **F-05** tambahkan entri `privacyPass.ts` (server+web) ke
  `scripts/pq-only-exceptions.json` dengan `rationale` + `removalGate` yang
  merujuk gate BRaccoon. Jangan `--write` baseline.
- **F-12** perbaiki 3 lint clippy + tambahkan langkah clippy ke job sidecar.
- Berkas: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `scripts/pq-only-exceptions.json`,
  `server/transport-sidecar/src/{fuzz,protocol}.rs`, `.github/workflows/ci.yml`.
- Risiko: bump `zod` menyentuh semua skema — jalankan suite penuh + cek jitless
  (`packages/shared/src/schemas.ts`).
- Verifikasi: `pnpm -r run test`, `node scripts/check-pq-only.mjs`,
  `pnpm audit --prod`, `cargo clippy` dua crate.

## Batch 2 — Anti-abuse Privacy Pass benar-benar stateful

> **Selesai 2026-10-26.** `SET { EX, NX: true }`, parameter `PpRedeemRedis`,
> cast di `routes/groups.ts` hilang, fake Redis di test menolak bentuk posisional.

**Tergantung Batch 1** (lockfile).

- **F-01** `privacyPass.ppRedeemToken` → `{ EX, NX }`; ketik parameter
  `Pick<RedisClientType,'set'>`; hapus cast `as unknown as …` di `routes/groups.ts`.
- Test: `server/tests/privacyPass.test.ts` (fake Redis yang **hanya** mengenal
  `{EX,NX}`): redemption kedua `spent`, TTL > 0, binding grup salah `invalid`.
- Berkas: `server/src/utils/privacyPass.ts`, `server/src/routes/groups.ts`, test.
- Verifikasi manual: `redis-cli TTL pp:spent:*` setelah redemption nyata.

## Batch 3 — Migrasi DB eksplisit & deploy fail-closed

> **Selesai 2026-10-26.** `|| true` dihapus, verifikasi `information_schema`
> setelah push, deploy berhenti sebelum `pm2` restart. Jalur data dipilih:
> **tidak ada reset otomatis** (operator + backup terverifikasi); keputusan
> maintainer #1 (2026-10-27) menetapkan skema produksi sudah memuat kolomnya,
> jadi tidak ada backfill/reset tambahan.

**Tidak tergantung Batch 1/2.** Ini yang mencegah rilis merusak produksi.

- **F-04** hapus `|| true`; tambahkan langkah verifikasi kolom setelah push
  (`prisma db execute` → `SELECT column_name FROM information_schema.columns …`),
  dan jalur aman untuk kolom wajib baru: `tokenHash` nullable → backfill dari
  token yang masih dipegang klien (tidak mungkin) **atau** reset yang disengaja
  dengan backup terverifikasi. **Keputusan maintainer**: apakah produksi sudah
  punya `tokenHash` (artinya rilis sebelumnya sukses) atau belum.
- Berkas: `.github/workflows/deploy.yml`, `docs/10`, `docs/37` §37.4.
- Risiko: deploy bisa merah pada rilis pertama setelah perubahan — itu tujuannya.

## Batch 4 — NODE_ENV produksi + log tanpa identifier

> **Selesai 2026-10-26.** `NODE_ENV=production pm2 start`, guard `JWT_SECRET`
> sebelum `pm2 delete` (CSRF/COOKIE_DOMAIN diperingatkan), `.env.example` +
> `docs/10` dilengkapi, test `deployWorkflow`/`envExample` ditambahkan. Morgan
> sudah hanya aktif di non-prod, jadi C18 tertutup oleh NODE_ENV itu sendiri.

**Tergantung Batch 3** (supaya deploy merah terlihat saat guard `config.ts` menolak boot).

- **F-02** set `NODE_ENV=production` di `pm2 start`; verifikasi `JWT_SECRET`,
  `CSRF_SECRET`, `COOKIE_DOMAIN` sebelum menyalakan (guard akan crash-loop).
  Ganti morgan ke `tiny`/tanpa query di produksi (atau matikan).
- **F-13** lengkapi `.env.example` + `docs/10` (`PP_ISSUER_PRIVATE_JWK`,
  `CREDENTIAL_SUITE_ALLOWLIST`, `OHTTP_RELAY_*`, `OHTTP_GATEWAY_*`).
- Test: `server/tests/sessionUtils.test.ts` (sudah ada) + test sumber
  `deploy.yml` memuat `NODE_ENV=production`; `envExample.test.ts` untuk drift env.
- Berkas: `.github/workflows/deploy.yml`, `server/src/app.ts`,
  `.env.example`, `docs/10`, test.

## Batch 5 — Overrides pnpm yang benar-benar berlaku

> **Selesai 2026-10-26.** `resolutions` dihapus; pin yang paketnya masih ada di
> pohon pindah ke `overrides:` (22 entri), sisanya sengaja dibuang dan dicatat
> di komentar. Gate `scripts/check-overrides.mjs` di job `audit`.

- **F-08** pindahkan pin relevan dari `resolutions` → `overrides:` di
  `pnpm-workspace.yaml`; hapus `resolutions`; perbaiki `allowBuilds.puppeteer`.
- Test: `scripts/check-overrides.mjs` di job `audit` (gagal bila `resolutions`
  ada atau pin tidak muncul di lock).
- Berkas: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`.

## Batch 6 — Satu worker untuk job singleton + metrik

> **Selesai 2026-10-26.** Kunci `job:<name>` (`SET NX EX` + Lua
> compare-and-delete, fail-closed) untuk keempat job. Metrik per-worker
> (`METRICS_PORT + NODE_APP_INSTANCE * 10` + `file_sd` dari
> `scripts/metrics-targets.mjs`) menyusul di commit `13e602d5` — lihat poin #3
> di bawah.

- **F-07** lock Redis per job (`SET job:<name> <id> NX EX <ttl>`, pola Lua yang
  sudah ada) untuk `messageSweeper`, `systemSweeper`, `ktSnapshot`,
  `pirSnapshot`; `METRICS_PORT=0` untuk worker non-0 (`NODE_APP_INSTANCE`).
- Test: `server/tests/jobLock.test.ts` (fake Redis).
- Berkas: `server/src/index.ts`, `server/src/jobs/*.ts`, `server/src/utils/metricsEndpoint.ts`.

## Batch 7 — OHTTP token-off deterministik

> **Selesai 2026-10-26.** `OHTTP_INTERNAL_TOKEN` → HMAC(`JWT_SECRET`) → boot
> gagal; test di `ohttp.test.ts`; didokumentasikan di `docs/10` §10.18.

- **F-06** `internalToken` dari env/HMAC `JWT_SECRET`; tolak boot bila mode
  `off` dan tidak tersedia; dokumentasikan konsekuensi klaster.
- Test: `server/tests/ohttpRelay.test.ts` (dua config, env sama → token sama).
- Berkas: `server/src/ohttp/config.ts`, `server/src/routes/ohttp.ts`, `docs/10` §10.18.

## Batch 8 — Batas respons sync + dokumen

> **Selesai 2026-10-26.** Dipilih opsi pertama: `MAX_SYNC_TOKENS = 200` +
> `truncated: true` (tanpa paginasi; klien memperingatkan). `docs/37` §37.3.3
> tidak lagi menjanjikan batas byte 256 KB yang tidak ditegakkan.

- **F-10** `MAX_SYNC_TOKENS=200` **atau** pemotongan berdasarkan byte +
  `truncated` (pilih satu; yang pertama lebih murah dan sesuai dokumen).
  Klien `groupSync` sudah mem-parse `truncated`? (cek — bila belum, tambahkan
  halaman berikutnya atau abaikan dengan jujur).
- Test: `server/tests/groupSync.test.ts`.
- Berkas: `server/src/utils/groupSync.ts`, `web/src/lib/groupSync.ts`, `docs/37`, `docs/12`.

## Batch 9 — Kerapian kecil (boleh digabung)

> **Selesai 2026-10-26.** F-11 `GETDEL`, F-09 verdict `unavailable` + banner
> peringatan (bukan gate), D5 `protocol::kick_frame`, drift F-14/04 (CONTRIBUTING,
> docs/18, docs/29, AGENTS v16, docs/01, CORS, warning count), dan F-15 pin SHA +
> `permissions: contents: read` + gate `scripts/check-actions-pins.mjs`.

- **F-11** `GETDEL` untuk token QR device-linking + test.
- **F-09** verdict `unavailable` (bukan `null`) saat KT error + indikator UI.
- **D5** pindahkan konstruksi frame KICK ke `protocol.rs` (satu fungsi, dua call site).
- **F-14/04** perbaiki drift: `CONTRIBUTING.md` perintah dev, `docs/18` TURN,
  `docs/29` residual #3, `AGENTS.md` v13→v16 & angka warning, komentar
  "index-only changes" di `deploy.yml`, hapus `x-delivery-tokens` dari CORS.
- **F-15** pin `uses:` ke SHA (khususnya `dtolnay/rust-toolchain@master`) dan
  deklarasikan `permissions:` minimum di `ci.yml`/`deploy.yml`; gate opsional
  `scripts/check-actions-pins.mjs`.
- **Klaim `docs/01`/`docs/04` (C19–C35, drift #19–#26)**: perbarui §4.1
  (ML-DSA-65), §4.4 (verifikasi SPK v2), §4.6 (v3 85 B / v4 2037 B, `sigV`/`senderKeyId`/`signingKeyV2`),
  §4.11 (50 op + nama `*_v2`/`ml_dsa_*`), intro "semua kripto di worker", dan
  angka `docs/01` (21 router, 77 komponen, 5 job). Sekalian tulis D7
  (fail-open plaintext) di §4.8 — atau ubah perilakunya, keputusan maintainer.

## Yang butuh keputusan maintainer (jangan diputuskan sendiri)

1. **Hard cut token grup** — **diputuskan 2026-10-27:** skema produksi sudah
   memuat kolom barunya (deploy sebelumnya sukses), jadi tidak ada reset/backfill
   tambahan. Yang berlaku tetap jalur fail-closed Batch 3 (push gagal =
   deploy merah + verifikasi `information_schema`).
2. **Privacy Pass** — **diputuskan 2026-10-27: dipertahankan dan disiapkan untuk
   dinyalakan.** Anti-replay F-01 sudah benar; yang ditambahkan: cold-start klien
   (`ensurePrivacyPassProof` + retry sekali pada 403 `PP_PROOF_REQUIRED`), muat
   ulang issuer saat rotasi kunci, alert `NyxPrivacyPassDenied`, dan runbook
   `docs/10` §10.22 (generate kunci, verifikasi metrik, rotasi, rollback).
3. **Metrik klaster** — **ditutup 2026-10-27 oleh commit `13e602d5`:** tiap worker
   membuka `METRICS_PORT + NODE_APP_INSTANCE * 10`, deploy menulis `file_sd`
   lewat `scripts/metrics-targets.mjs`, Prometheus men-scrape semua target
   (`docs/10` §10.12), dan alert mengagregasi sehingga angka trafik tidak lagi
   mewakili 1/N proses.
4. **`NODE_ENV=production`** — **diputuskan 2026-10-27 (sudah diimplementasikan di
   Batch 4 dengan guard pra-restart):** deploy memverifikasi `JWT_SECRET` sebelum
   `pm2 delete`, jadi crash-loop terjadi sebelum proses lama dimatikan.
5. **D7 (seal at-rest gagal-terbuka)** — **diputuskan 2026-10-27: fail-closed.**
   `encryptValueAtRest` melempar `AtRestSealUnavailableError` (tidak pernah
   mengembalikan plaintext); penulisan dilewati, baris lama tetap terbaca.
   Test: `web/src/lib/__tests__/atRestFailClosed.test.ts`.
6. **D1 (`MIN_CLIENT_VERSION` fail-open), D6 (test paritas berbasis teks
   sumber)** — **dikerjakan 2026-10-27.** D1: mode ketat opt-in
   (`CLIENT_VERSION_REQUIRE_MUTATIONS=1`) menolak mutasi tanpa header versi
   (`426 CLIENT_VERSION_REQUIRED`, metrik `strict-no-header`), baca tetap
   fail-open; default tidak berubah. D6: registrasi/routing gateway menjadi
   `wssInboundTable()` + `wssDownstreamRoute()` (diuji perilaku), guard handler
   diekstrak (`makeGuardedOn`/`createHandlerFailureReporter`), dan wiring
   identitas Redis diuji dengan Redis pencatat + `openIdentity`. Detail +
   verifikasi: `PROGRESS.md` §D1 + D6.
