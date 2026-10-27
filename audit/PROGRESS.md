# PROGRESS — audit NYX (HEAD `25b1699`, 2026-10-25)

Berkas ini adalah titik masuk setelah konteks di-reset. Baca ini dulu.

## Status domain (§4 audit.md)

| Domain | Status | Catatan |
|---|---|---|
| Fase 0 orientasi + klaim C1–C15 | selesai | `00-ringkasan.md` §Klaim |
| Fase 1 peta perubahan | selesai | `01-change-map.md` |
| A. Kriptografi & protokol | selesai (baca kode + gate) | `notes/A-crypto.md` |
| B. Key Transparency | selesai (permukaan) | `notes/B-kt.md` |
| C. Privasi metadata / privacy closure | selesai | `notes/C-privacy.md` |
| D. OPRF + PIR | selesai (permukaan) | `notes/D-search-pir.md` |
| E. Auth, sesi, perangkat | selesai | `notes/E-auth.md` |
| F. Transport & relay | selesai | `notes/F-transport.md` |
| G. Server umum | selesai (permukaan) | `notes/G-server.md` |
| H. Frontend | sebagian (Dexie/CSP/i18n; XSS & SW hanya statis) | `notes/H-frontend.md` |
| I. Infra / supply chain / ops | selesai | `notes/I-infra.md` |
| J. Kualitas test & CI | selesai | `notes/J-tests-ci.md` |
| Fase 3 domino + drift | selesai | `03-domino-matrix.md`, `04-docs-drift.md` |
| Fase 4 rencana perbaikan | selesai | `07-fix-plan.md` |

## Temuan paling penting (jangan hilang)

1. `server/src/utils/privacyPass.ts:190-198` — `redis.set(..., 'EX', ttl, 'NX')` diabaikan
   node-redis 6 → **tidak ada anti-replay & tidak ada TTL**. Dibuktikan dengan Redis lokal.
2. `NODE_ENV` tidak pernah `production` di VPS → cookie sesi tanpa `Secure`, morgan
   `dev` mencatat URL+query, CSP/HSTS dev. `deploy.yml:260-263`.
3. `pnpm audit --prod` merah (3 high: zod, body-parser, undici) → job CI `audit` merah.
4. `node scripts/check-pq-only.mjs` merah (RSABSSA baru di `privacyPass.ts` server+web).
5. `prisma db push || true` + kolom wajib baru (`UserHiddenConversation.tokenHash`)
   → deploy tetap sukses walau migrasi gagal.
6. `OHTTP_TOKEN_MODE=off` memakai `internalToken` acak **per proses**, sedangkan pm2
   `-i max` → relay→gateway 403 acak.

## Yang belum diperiksa (lihat `06-tidak-diperiksa.md`)

E2E Playwright tidak dijalankan; `pnpm audit` butuh jaringan (dijalankan, hasil nyata);
`prisma db push` tidak dijalankan ke DB mana pun; review kripto baris-per-baris pada
`crypto.worker.ts` tidak lengkap (hanya jalur handshake & cutover).

## Verifikasi ulang (2026-10-26, HEAD tetap `25b1699`)

Semua klaim utama diperiksa lagi dari kode/perintah, bukan dari catatan:

| Klaim | Hasil |
|---|---|
| F-01 Privacy Pass `NX`/`EX` | **Terkonfirmasi** — `privacyPass.ts:197` argumen posisional; `redis` terpasang **6.2.1** |
| F-02 `NODE_ENV` produksi | **Terkonfirmasi** — `deploy.yml` tidak menyetelnya; pm2 `start` tanpa env |
| F-03 `pnpm audit --prod` | **Terkonfirmasi** — 10 kerentanan (3 high), exit 1 |
| F-04 `db push \|\| true` | **Terkonfirmasi** — `deploy.yml:238` |
| F-05 guard PQ-only | **Terkonfirmasi** — exit 1, RSABSSA 0→4 (server) & 0→3 (web) |
| F-06 token OHTTP off | **Terkonfirmasi** — `internalToken = randomBytes(32)` per proses, relay via loopback |
| F-07 singleton + metrik | **Terkonfirmasi** — `pm2 -i max`; job dimulai tanpa kunci |
| F-08 `resolutions` inert | **Terkonfirmasi** — 31 entri di `package.json`, lock hanya 2 override |
| Test server | **Diulang**: 659 tes, 657 pass, 2 skip, exit 0 |
| Test web | 125 berkas, 1007 pass (log, tidak diulang) |
| Catatan per-domain | `notes/B-…`–`notes/J-…` ditulis lengkap |

Dua kegagalan di log lama `/tmp/server-tests4.log` (`gatewayParity`,
`redisIdentity`) **tidak reproduce** di HEAD; keduanya lulus saat dijalankan
ulang. Tambahan pengamatan **D6** (test paritas memakai regex teks sumber)
masuk ke `02-findings.md`.

### Audit `docs/01` & `docs/04` (2026-10-26)

Kedua dokumen dicocokkan baris-per-baris ke kode; hasil = klaim **C19–C35** di
`00-ringkasan.md`, bukti di `notes/K-docs-claims.md`, dan drift **#19–#26** di
`04-docs-drift.md`. Temuan paling material: **C22** — `docs/04` §4.4 menyatakan
initiator memverifikasi tanda tangan signed-pre-key, padahal jalur v2
`pqSignature` "sengaja tidak dibaca" (`crypto.ts:3133-3136`); autentikasi ada di
tanda tangan transkrip handshake yang diverifikasi penerima. Drift lain: katalog
op 48→50 dengan nama usang, envelope grup v3 85 B / v4 2037 B, ML-DSA-65 tidak tercantum,
angka layout `docs/01` (21 router/77 komponen/5 job). Pengamatan baru **D7**:
`encryptValueAtRest` menulis plaintext bila sealing gagal.

**Tindak lanjut:** `docs/04-crypto-protocol.md` diperbarui (2026-10-26, working
tree) untuk #19–#24 & #26: pengecualian main-thread crypto, ML-DSA-65 di §4.1 &
§4.3, koreksi §4.4 (`pqSignature` tidak diverifikasi; autentikasi = tanda tangan
transkrip), envelope grup v3 85 B / v4 2037 B + `sigV`/`senderKeyId`/`signingKeyV2`, fail-open `ENC1:` di
§4.8, dan katalog **50 op** yang akurat. `docs/01` (#25) menyusul di batch kerapian (lihat §Perbaikan Batch 9).

**Bersih-bersih referensi op (2026-10-26):** `docs/16`, `docs/21`, `docs/26`,
`docs/29` tidak lagi menyebut `pq_box_seal`/`crypto_box_seal` yang sudah dihapus;
sekarang memakai `pq_box_seal_v2` (X-Wing, parameter kunci klasik diabaikan) dan
menyebut envelope grup v4 2037 B di tempat yang relevan (`notes` drift #27).
Sisa referensi historis di `docs/03`, `docs/05`, `docs/31`, `docs/35` **ditutup
2026-10-27** (lihat §Sisa implementasi di bawah).

## Perbaikan Batch 1 — gate CI dibuka (2026-10-26)

Dikerjakan di working tree, **belum commit**. Semua klaim di bawah dari output
perintah, bukan dari ingatan.

| Temuan | Tindakan | Bukti |
|---|---|---|
| **F-03** `pnpm audit --prod` merah (3 high) | `overrides:` di `pnpm-workspace.yaml` untuk `zod >=4.6.6`, `body-parser >=2.4.0`, `undici >=8.12.2`, `fast-uri >=3.1.9`, `ip-address >=10.7.4`; deklarasi `zod` di server/shared/web naik ke `^4.6.6` | `pnpm audit --prod` → `No known vulnerabilities found`, exit 0 (termasuk 5 moderate + 2 low yang sebelumnya ikut memerahkan job `audit`) |
| **F-05** guard PQ-only merah (RSABSSA baru) | `scripts/pq-only-baseline.json` mencatat **eksplisit** `RSABSSA: 4` (server) / `3` (web) — bukan `--write` global; `pq-only-exceptions.json` memberi dua entri `tier-b` + rationale + removalGate ke `docs/37` §37.9.5 | `node scripts/check-pq-only.mjs` → lulus, `Tier A baru: 0; Tier B: 2; legacy v1: 0; hybrid v2 identity: 2` |
| **F-12** clippy merah, tak ada job CI | 3 lint asli (`manual_checked_ops`, `manual_is_multiple_of`, `question_mark`) + 3 yang baru terlihat setelah itu (`while_let_loop` ×3, `let_underscore_future` ×2, `items_after_test_module`); job `sidecar` baru di `ci.yml` menjalankan `cargo clippy --all-targets -- -D warnings` + `cargo test` | `cargo clippy --all-targets -- -D warnings` bersih; `cargo test` 18 + 6 lulus |

Regresi yang dijalankan setelah perubahan dependensi: `pnpm --filter @nyx/shared
run build` + `pnpm -r run build` (web/server/marketing) exit 0; test server **659
tes, 657 pass, 0 fail, 2 skip**, exit 0; test web **125 berkas lulus**, exit 0;
`pnpm install --frozen-lockfile` → `Already up to date` (lockfile konsisten
dengan override baru).

Catatan: `cargo fmt --check` di `server/transport-sidecar` **masih** gagal
(impor di `src/fuzz.rs` dan `src/bin/fuzz-framing.rs` belum di-rustfmt). Itu
tidak dimasukkan ke CI pada batch ini supaya job baru tidak merah sejak awal;
menjalankan `rustfmt` menyeluruh akan mencampur diff format besar dengan
perbaikan audit. **Ditutup 2026-10-27** — lihat §Sisa implementasi.

## Perbaikan Batch 2–9 (2026-10-26, working tree, belum commit)

### Batch 2 — F-01 Privacy Pass benar-benar stateful

`ppRedeemToken` kini memakai `SET` berbentuk **objek** `{ EX, NX: true }`
(bentuk posisional `'EX', ttl, 'NX'` diabaikan node-redis 6 → token bisa
di-replay selamanya dan key `pp:spent:*` tumbuh tanpa TTL). Parameter Redis
diketik sempit (`PpRedeemRedis`, bukan `Pick<RedisClientType,'set'>`) sehingga
dua cast `as unknown as …` di `routes/groups.ts` hilang. Test memakai fake Redis
yang **hanya** menerima objek opsi: double-spend → `spent`, TTL 24 jam tercatat,
binding grup salah → `invalid` tanpa menyentuh Redis.

### Batch 3 — F-04 migrasi DB eksplisit

`deploy.yml` tidak lagi memakai `prisma db push || true`. Push yang gagal
menghentikan deploy **sebelum** `pm2` restart (proses lama tetap melayani),
lalu `nyx-verify-schema.mjs` (ditulis di `server/` agar ESM `pg`/`dotenv`
meresolusi `node_modules`) memeriksa `information_schema` untuk
`UserHiddenConversation.tokenHash`/`tokenEpoch`, `Conversation.adminSecretHash`,
dan `GroupMailboxItem`. Reset DB tidak dilakukan otomatis — itu keputusan
operator dengan backup terverifikasi (`docs/37` §37.4 P0 diperbarui).

### Batch 4 — F-02 NODE_ENV + F-13 env

`pm2 start` sekarang `NODE_ENV=production pm2 start …`. Karena guard
`config.ts` bisa menolak boot, deploy memverifikasi `JWT_SECRET` (≥32 karakter,
bukan `dev-secret`) **sebelum** `pm2 delete`; `CSRF_SECRET` dan `COOKIE_DOMAIN`
diperingatkan (tidak fail-closed, sesuai perilaku kode). Access log morgan memang
sudah hanya di non-prod, jadi aktifnya NODE_ENV produksi sekaligus menutup
kebocoran URL+query (F-02/C18). `.env.example` + tabel env `docs/10` melengkapi
`OHTTP_INTERNAL_TOKEN`, `OHTTP_GATEWAY_TARGET/TRUSTED_HOSTS`,
`CREDENTIAL_SUITE_ALLOWLIST`, dan status `NODE_ENV`. Test baru:
`deployWorkflow.test.ts` (NODE_ENV, guard sebelum delete, `|| true` hilang,
verifikasi kolom, pin action, permission) dan `envExample.test.ts` (env wajib
dokumentasi + tidak ada rahasia asli).

### Batch 5 — F-08 override pnpm berlaku

`resolutions` (31 entri, diabaikan pnpm 11) dihapus; pin yang paketnya masih ada
di pohon dipindah ke `overrides:` (`minimatch`, `picomatch`, `brace-expansion`,
`ws`, `qs`, `esbuild`, `lodash`, `bn.js`, `defu`, `effect`, `path-to-regexp`,
`socket.io-parser`, `serialize-javascript`, `@types/react*`, `mysql2`,
`deepmerge-ts`). Pin untuk paket yang **tidak ada** di pohon (basic-ftp,
fast-xml-parser, tar, hono, @hono/node-server, @opentelemetry/core, flatted,
lodash-es, axios, follow-redirects, dua entri rollup@2/4) sengaja tidak
dipindahkan dan dicatat di komentar — mempertahankannya hanya klaim kosong.
`allowBuilds.puppeteer` placeholder → `false`. Gate baru
`scripts/check-overrides.mjs` (CI job `audit`) menolak `resolutions`, override
yang tidak muncul di lockfile, dan `allowBuilds` non-boolean.

### Batch 6 — F-07 job singleton + metrik

`utils/jobLock.ts` baru: `SET job:<name> <token> NX EX <ttl>` + pelepasan
compare-and-delete (Lua), TTL selalu ada, dan **fail-closed** bila Redis tidak
bisa dihubungi (job dilewati, bukan dijalankan semua worker). Dipakai
`message-sweeper` (120 dtk), `system-sweeper` (1 jam), `kt-snapshot` (1 jam),
`pir-snapshot` (2 jam > timeout rebuild 60 menit). `startMetricsServer` hanya
membuka exporter di `NODE_APP_INSTANCE=0`; worker lain mencatat satu baris dan
diam (dulu semua mencoba bind `:9464` → hanya satu berhasil). Test
`jobLock.test.ts` (5 kasus, fake Redis hanya menerima `{NX,EX}` + `EVAL`).

### Batch 7 — F-06 token OHTTP deterministik

`internalToken` tidak lagi `randomBytes(32)` per proses. Urutan:
`OHTTP_INTERNAL_TOKEN` (≥32 karakter) → HMAC-SHA256(`JWT_SECRET`, label tetap) →
**boot gagal**. Test baru di `ohttp.test.ts`: dua config dengan env sama → token
sama, env eksplisit menang, tanpa rahasia → throw, token pendek → throw, mode
`on` → undefined. `docs/10` §10.18 menjelaskan konsekuensinya.

### Batch 8 — F-10 batas respons sync

`MAX_SYNC_TOKENS` 500 → **200** (sesuai `docs/37` §37.3.3) dan pemotongan
dilaporkan sebagai `truncated: true` di respons (bukan disembunyikan). Klien
`groupSync` menambahkan field itu dan mencatat peringatan jujur (tidak ada
paginasi). Test `groupSync.test.ts` mengunci angka 200 + flag tersebut.

### Batch 9 — kerapian

- **F-11** token QR device-linking dibaca-lalu-dibakar dengan **`GETDEL`**
  (atomik). `LinkingStore.getDel` ditambahkan; test baru: dua claim berbarengan
  → tepat satu menerima token.
- **F-09** kegagalan pemeriksaan log KT kini verdict `unavailable` (bukan
  `null`), disimpan per peer (`ktLastVerdict`, juga untuk peer baru), diekspos
  lewat `listKtUnavailablePeers`, dan ditampilkan `ChatWindow` sebagai banner
  informasi kuning — **bukan** gate kirim. Key i18n `banners.kt_unavailable*`
  ada di keempat bahasa.
- **D5** frame KICK pindah ke `protocol::kick_frame` (+ `KICK_OPCODE`) dengan
  test bentuk wire; dua salinan inline di `main.rs` dihapus.
- **F-14/04** drift: `CONTRIBUTING.md` (tidak ada `pnpm dev`; perintah build/
test/lint yang benar), `docs/18` TURN (coturn → Cloudflare → `ICE_STUN_URLS` →
503/502, tanpa Google STUN), `docs/29` quick-win #3 ditandai landed, `AGENTS.md`
Dexie **v16** + banner KT tersedia, angka warning CI 193, `x-delivery-tokens`
dihapus dari CORS, komentar "index-only changes" hilang bersama penulisan ulang
push, `docs/01` 21 router / 77 komponen / 5 job.
- **F-15** `dtolnay/rust-toolchain`, `appleboy/ssh-action`, `appleboy/scp-action`
di-pin ke SHA (komentar tag di sampingnya), `permissions: contents: read` di
`ci.yml` dan `deploy.yml`, dan gate `scripts/check-actions-pins.mjs` menolak
`@master`/`@main`/`@latest`.


## Sisa implementasi (2026-10-27, working tree)

Dua hal yang masih tercatat "belum" di batch 1–9 dikerjakan, ditambah sinkronisasi
angka dokumen yang ikut terlihat saat mengerjakannya. Batas sesi ini: **tidak**
menyentuh keputusan maintainer (lihat daftar di akhir).

### 1. `cargo fmt --check` hijau + jadi gate CI

`server/transport-sidecar` di-rustfmt-kan sekali (4 berkas, +296/−99; 57 hunk — impor
`fuzz.rs`/`bin/fuzz-framing.rs`, pembungkusan argumen `main.rs`/`protocol.rs`). Job CI
`sidecar` kini menjalankan `cargo fmt --all -- --check` **sebelum** clippy, persis seperti
job `pir-sidecar` (`toolchain.components: rustfmt, clippy`); tanpa gate itu satu-satunya
crate Rust tanpa fmt otomatis akan kembali kacau. Gate baru dicatat di `docs/11` §11.1
dan `docs/25` (daftar job `ci.yml`).

Verifikasi: `cargo fmt --all -- --check` bersih, `cargo clippy --all-targets -- -D warnings`
bersih, `cargo test` → lib **19** + `cert_tests` **6** lulus (0 gagal).

### 2. Referensi op sealing usang di dokumen sisa (drift #28–#31)

- `docs/03` §3.2: baris "Message vault" (memakai `ENC1:` masterSeed, bukan envelope
  ber-kunci identitas — sama kelasnya dengan drift #20) dan baris "Push payloads"
  (`crypto_box_seal` → `pq_box_seal_v2`/`sealForDevice`, perangkat tanpa kunci PQ tidak
  dapat payload).
- `docs/05` diagram alur: label `crypto_box_seal(pushPayload, devicePk)` → `sealForDevice`
  → `pq_box_seal_v2`.
- `docs/31` §tabel jalur kunci: kunci `migration:*` diseal `pq_box_seal_v2` (X-Wing),
  QR v1 tanpa `pqPubKey` ditolak.
- `docs/35` §35.2.2 (tiga baris inventaris) + §35.6 (dua bullet "Langkah 5/9") yang masih
  menjanjikan fallback `crypto_box_seal` untuk QR/perangkat lama diberi anotasi
  **dihapus di cutover PQ-only 2026-10-23** dengan lokasi kode yang menegakkannya.
  §35.2 tetap dibiarkan sebagai baseline historis (memang dinyatakan begitu).

Tidak diubah (diperiksa, bukan drift): `marketing/src/locales/*/api-docs.json` memakai
nama fungsi **libsodium** `crypto_box_seal_open` pada troubleshooting integrator Engine,
dan entri lama di `CHANGELOG.md`.

### 3. Angka test `docs/11` §11.1 disinkronkan (drift #31)

Diukur di mesin ini, bukan dari ingatan:

| Runner | Angka nyata 2026-10-27 | Tertulis sebelumnya |
|---|---|---|
| server (`node:test` via `tsx`) | **86 berkas / 677 tes — 675 pass, 0 fail, 2 skip**, exit 0 | 48 berkas / 380 tes |
| web (vitest) | **125 berkas / 1018 tes** | 72 berkas / 615 tes |
| sidecar `cargo test` | **2 target / 25 tes** (19 lib + 6 sertifikat) | 18 tes |
| total | **211 berkas** (86 + 125) | 120 berkas |

Semua **86** berkas `server/tests/*.test.ts` terdaftar di skrip `test`
`server/package.json` (0 yatim, dicek dengan membandingkan `readdirSync` ke isi skrip).

### Catatan verifikasi (jujur)

- `pnpm --filter nyx-web run test` penuh menghasilkan **1 gagal / 1017 lulus** dari 1018:
  `src/lib/__tests__/pqBench.test.ts` → `expected 108.376 to be less than 100`
  (`PQ_BENCH_BUDGET.mlDsaSignP95Ms`). Ini **benchmark wall-clock** di dalam suite unit,
  jadi sensitif beban mesin — dijalankan ulang sendirian berkas itu **lulus** (sign
  p95 40,19 ms; keempat ukuran output ML-DSA-65/X-Wing juga persis). Tidak ada berkas web
  yang disentuh di sesi ini, jadi ini flake beban, bukan regresi; ambang `PQ_BENCH_BUDGET`
  **tidak** diubah (itu akan melemahkan assertion).
- Perubahan sesi ini hanya menyentuh dokumen, `.github/workflows/ci.yml`, dan format Rust —
  tidak ada kode runtime yang berubah, sehingga gate perilaku (drill alert, PQ-only,
  overrides, actions-pins, e2e) tidak terpengaruh; yang relevan dan dijalankan ulang:
  `cargo fmt/clippy/test`.

### Masih menunggu keputusan maintainer (tidak diputuskan di sini)

1. **F-04 hard cut token grup** — produksi di-reset (kehilangan riwayat) atau backfill?
   Menentukan apakah `docs/37` §37.4 P0 perlu langkah reset eksplisit.
2. **Privacy Pass** — perbaiki dan hidupkan (`PP_SYNC_REQUIRED=1`) atau matikan dan hapus
   kode + exception PQ-nya?
3. **Metrik klaster** — eksporter terpisah/agregasi, atau cukup satu worker + `NODE_APP_INSTANCE`?
4. **D1/D7** — `MIN_CLIENT_VERSION` dijadikan fail-closed untuk mutasi? Seal at-rest
   tetap fail-open ke plaintext (didokumentasikan di `docs/04` §4.8) atau berubah jadi
   melempar/melewati penulisan?

## Keputusan maintainer + implementasinya (2026-10-27, working tree)

Tiga jawaban maintainer atas §"Yang butuh keputusan maintainer" dikerjakan.
Jawaban mentah: (1) skema produksi **sudah** memuat kolom barunya; (2) Privacy
Pass **dipertahankan dan dinyalakan**; (3) paket hardening yang dipilih **D7**.

### 1. F-04 — tidak ada migrasi/reset tambahan

Produksi sudah ter-deploy dengan kolom baru, jadi tidak ada backfill atau reset
yang perlu ditulis. Yang tetap berlaku: Batch 3 (push gagal = deploy merah,
verifikasi `information_schema`, proses lama tetap hidup). Dicatat di
`07-fix-plan.md`; tidak ada perubahan kode.

### 2. Privacy Pass — dipertahankan, disiapkan untuk `PP_SYNC_REQUIRED=1`

F-01 (anti-replay `SET {EX,NX}`) sudah benar; yang kurang adalah jalur **hidup**:

- **Cold start klien** (`web/src/lib/privacyPass.ts`, `groupSync.ts`):
  `ensurePrivacyPassProof()` menerbitkan bukti **sinkron**, dan `syncBatch`
  mengulang **sekali** saat server menjawab `403 PP_PROOF_REQUIRED`
  (sebelumnya gate itu mematikan discovery untuk perangkat baru / stok kosong
  sampai issuance latar kebetulan selesai). Retry kedua tetap dilempar —
  tidak ada loop.
- **Rotasi kunci issuer**: `PP_ISSUER_KEY_CHANGED` membuang cache dan mencoba
  sekali lagi; sebelumnya klien gagal permanen sampai reload halaman.
- **Observability**: alert `NyxPrivacyPassDenied` (rasio `denied` > 20% selama
  15 menit, `clamp_min` untuk pembagian nol) + 2 kasus drill (menyala/tidak).
  Drill: 40 aturan, semua punya kasus, kontrak metrik tetap 31 metrik.
- **Runbook** `docs/10` §10.22 (prasyarat, generate `pp-key:generate --write`,
  verifikasi metrik, rotasi, rollback, batas jujur) + baris env
  `PP_ISSUER_PRIVATE_JWK`/`PP_SYNC_REQUIRED` di tabel §10.6 + `docs/37`
  §37.3.3/§37.9.4 menyatakan gate dipertahankan.
- Test: `privacyPass.test.ts` (issuance sinkron + rotasi issuer),
  `groupSync.test.ts` (retry 403 + tidak ada loop).

### 3. D7 — seal at-rest fail-closed (bukan lagi fail-open ke plaintext)

`web/src/lib/keychainDb.ts`: `encryptValueAtRest` **melempar**
`AtRestSealUnavailableError` bila `masterSeed` belum tersedia dan membiarkan
error worker naik — tidak pernah mengembalikan plaintext (dulu `return value`
+ `console.warn`). Konsekuensi yang disengaja: penulisan yang tidak bisa
disegel **dilewati** (baris pesan/kontak dilewati, bukan diturunkan
jaminannya), sedangkan **pembacaan** baris lama plaintext tetap jalan
(`decryptValueAtRest` tidak berubah) dan migrasi saat unlock men-seal ulang.

- `localAtRest.ts` mewarisi sifat itu (dokumentasi helper diperbarui).
- `saveKtIdentifier` (identifier akun) dan `upsertContact` menangkap error itu
  dan **melewati penulisan** dengan satu peringatan — dua jalur yang dulu
  menulis plaintext di localStorage/IndexedDB tanpa try/catch.
- Test baru `web/src/lib/__tests__/atRestFailClosed.test.ts` (7 kasus): vault
  terkunci → melempar; worker gagal → error naik; sukses → envelope `ENC1:`
  yang bisa dibuka; baris lama tetap terbaca; helper `sealLocal*` mewarisi;
  nilai kosong tetap `null`.
- `docs/04` §4.8 diperbarui: "fail-open (known limitation)" → **fail-closed**.

### Verifikasi sesi ini

- `npx tsc -b --noEmit` (web) bersih.
- `privacyPass.test.ts` 10 lulus; `groupSync.test.ts` 9 lulus;
  `atRestFailClosed.test.ts` 7 lulus.
- 118 tes vault/at-rest/kontak/profil (`localAtRest`, `localOrderKey`,
  `contactStore`, `profileStore`, `dexieMigration`, `shadowVaultOrderIndex`,
  `vaultSeq/Reactions/Statuses`, `autoDeletePersistence`) lulus.
- `drill-alerts.sh` (SKIP_LIVE): 40 aturan valid, semua punya kasus drill.
- Catatan flake (bukan regresi): `ktMonitoring.test.ts` > "tanpa state siap"
  timeout 5 detik saat 7 berkas dijalankan paralel (1891 ms sendirian,
  lulus dengan `--no-file-parallelism`); `pqBench.test.ts` sudah tercatat
  sebelumnya (benchmark wall-clock — 106,64 ms vs ambang 100 ms saat suite
  penuh, 40,19 ms sendirian).
- Suite web penuh setelah perubahan: **126 berkas / 1030 tes, 1029 lulus, 1 gagal
  (= pqBench flake di atas)**, 482 dtk. `keychainDbPersistence.test.ts` yang
  semula mengandalkan fallback plaintext (mock "masterSeed terkunci") kini
  menyediakan seed + stub crypto dan menambah kasus "nilai tersimpan benar-benar
  ter-seal".
- Angka `docs/11` §11.1 diperbarui lagi ke 126 berkas / 1030 tes (total 212).
