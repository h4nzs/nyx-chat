# 41 — Roadmap kesehatan development, audit, tes, E2E, coverage, dan CI

**Status:** hidup — diperbarui 12 November 2026.
**Menggantikan:** `~/.opencode/plan/nyx-quality-ci-roadmap.md` (plan eksternal, revisi 2).
Dokumen ini ada **di dalam repo** supaya komentar `[docs/41 §6.1]` di kode bisa
diresolusi tanpa akses ke direktori pribadi siapa pun. Nomor bagian sengaja
dipertahankan sama dengan plan lama.

Prinsip yang tidak berubah:

1. Tes yang skip bukan bukti lulus — gate harus bisa **gagal**.
2. Coverage adalah alat diagnosis, bukan target; modul kritis dikunci per-glob.
3. Tes kritis harus deterministik — perbaiki race, jangan menaikkan `retries`.
4. Jangan membangun gate di atas baseline merah.
5. Jangan mengklaim "teruji" tanpa bukti yang bisa dibaca ulang dari log/spec.
6. Perubahan kecil, terukur, bisa di-rollback.

## 41.1 Status ringkas

| Area | Status | Artefak |
|---|---|---|
| Phase 0 — hijaukan E2E | ✅ selesai **dan terbukti di CI** — run [42351711379](https://github.com/h4nzs/nyx-chat/actions/runs/42351711379), 12/12 job hijau termasuk kedua job E2E | `web/e2e/settings.spec.ts` (page baru pasca-eject), `web/e2e/auth.spec.ts` (bukti logout + pembersihan state), `1fb27815` (prefix `/api/ohttp` di stack uji) |
| §6.1 coverage web | ✅ selesai | `web/vite.config.ts` (`test.coverage`), `pnpm --filter nyx-web run test:coverage` |
| §6.2 coverage server | ✅ selesai | `server/scripts/test-coverage.mjs` |
| §6.3 changed-lines | ✅ selesai (web; non-blocking) | `scripts/check-changed-lines.mjs`, step di job `unit` |
| §6.4 `groupLifecycle.spec.ts` + `groupEra.spec.ts` | ✅ (kontrak HTTP + era kripto) | `web/e2e/groupLifecycle.spec.ts`: 3 konteks browser, buat grup, tambah anggota, gate token, rotasi admin, kick merotasi era token, purge 409/204; **lulus 4,1 menit**. Menemukan bug: DELETE tanpa body → `req.body` undefined → kick sah 500 (diperbaiki di `routes/conversations.ts`). `web/e2e/groupEra.spec.ts` menutup batas itu: dua akun sungguhan, grup dibuat lewat modal UI, pesan era awal, rotasi epoch dari panel info (`POST /:id/epoch` → `rotateGroupKey` → mailbox), lalu era lama **dan** era baru tetap terbaca setelah reload; **lulus 4,6 menit**. Belum: keempat skenario fault injection |
| §6.5 required-tests gate | ✅ selesai | `web/e2e/required-tests.json`, `web/e2e/verify-required-tests.mjs`, 2 step di `ci.yml` |
| §6.6 MinIO jalur sukses R2 | ✅ dijalankan lokal + CI | `R2_ENDPOINT` di `server/src/config.ts` + `resolveR2Endpoint` (`utils/r2.ts`); 4 tes kontrak + 1 tes opt-in `NYX_R2_SMOKE=1`; presign→PUT→HEAD→GET→DELETE nyata lulus terhadap `rclone serve s3` (SigV4 penuh, 5/5). Job `unit` menjalankan `rclone serve s3` v1.75.2 (`NYX_R2_SMOKE_CREATE_BUCKET=1`) tanpa menambah required check |
| §6.7 PIR dua server | ✅ WP1–WP9 | keputusan 2026-11-09: ChalametPIR (tanpa proof) diganti **XOR-PIR dua server + sharding** — deteksi dusta dari satu server jujur, tanpa proof dan tanpa hint. Kontrak, builder shard, sidecar A/B, proxy dua-server (`PIR_SERVERS`), dan klien XOR (dua relay OHTTP + verifikasi manifest) sudah ada; jalur lama sudah dihapus. Unit template + metrik/alert ops juga sudah (WP7). E2E dua server + vektor lintas-impl sudah (WP8, drill CI `pir-e2e`); WP9 = pembersihan sisa jalur lama + `STATUS.md` (selesai). Performa diukur manual via `scripts/bench/pir-query.mjs` (2026-11-11: p95 3,8 ms; 2.560 B/query; RSS 1,61× pada shard 8 MiB, 1,16× pada 32 MiB — target gate di `docs/42`). |
| §6.8 KT live E2E | ✅ ABI 2 | `web/e2e/ktLive.spec.ts`: config `abiVersion: 2` + kunci ML-DSA-65, `/head`, anchor `distinguished`, bukti publik `POST /search`; **lulus 1,4 menit** terhadap KT v2 lokal. Interop `cmd/kt-client` tetap item lanjutan. |
| §7.1 WebKit/Firefox smoke | ✅ hijau di nightly (belum PR gating) | `firefox`/`webkit` di `playwright.config.ts`, job `browsers` di `nightly.yml`. **Run hijau pertama 13 November 2026** (`43433660755`, head `ee2c0f2f`, job 12,6 menit): Firefox **4/4 (4,7 m)** dan WebKit **4/4 (4,8 m)** untuk `auth.spec` + `settings.spec`, lalu a11y **3/3 (1,4 m)** di job yang sama. Naik ke PR setelah 7 hari hijau (paling cepat 20 November 2026). `transport`/`chat` tetap di `e2e-chrome`: WebTransport tidak ada di Firefox/WebKit headless |
| §7.2 contract test HTTP | ✅ opt-in | `server/tests/httpContract.test.ts` (**7 sub-tes**: helmet, JSON 400, CSRF 403, body 413, csrf-token, CORS, **429**) + job `http-contract`; memakai `fetch` + `app.listen(0)`, bukan supertest, dan tidak jalan di suite unit karena butuh Redis/Postgres |
| §7.3 nightly fuzz/k6 | ✅ hijau penuh | `.github/workflows/nightly.yml`: fuzz web 1 jam (60,5 m), fuzz sidecar 1 jam (61,1 m), k6 100 VU ephemeral (5,8 m), contract HTTP (55 dtk), smoke Firefox/WebKit + a11y (12,6 m). **5/5 job hijau** di run `43433660755` (13 November 2026, head `ee2c0f2f`) |
| §7.4 flake gate + karantina | ✅ gate | `web/e2e/quarantine.json` + `evaluateQuarantine` di `verify-required-tests.mjs` (owner/reason/expires wajib; kedaluwarsa/masih-jalan tes hilang = gagal); self-test 12/12 |
| §7.5 backup/restore E2E | ✅ Playwright | `web/e2e/backupRestore.spec.ts`: ekspor `.nyxbak` (**magic `NYXB`**, unduhan nyata) lalu restore dengan recovery phrase yang dibaca dari onboarding; **lulus 2,1 menit**. Drill mingguan tetap ada. |
| §8 a11y (sisanya belum) | 🟡 a11y (3 halaman) | `web/e2e/a11y.spec.ts`: login, register/landing, dan **Settings ber-sesi**; pelanggaran yang ditemukan diperbaiki di UI (label select/input, nama tombol swatch, kontras tombol Register, kontras `DefaultAvatar`). PWA/offline, visual, perf, mutation belum |
| §9.1 branch protection | ✅ aktif | 14 required contexts (12 job `ci.yml` + 2 CodeQL) |
| §9.2 Dependabot lockfile | ✅ selesai | `.github/workflows/dependabot-lockfile.yml` |
| §9.4 CI hygiene | ✅ selesai | `concurrency` + `timeout-minutes` 12 job + artifact saat gagal |

## 41.2 Baseline terukur (5 November 2026)

Angka di bawah diambil dari repo, bukan dari ingatan. Kolom terakhir adalah cara
mengukurnya kembali.

| Item | Nilai | Cara ukur |
|---|---|---|
| Job `ci.yml` | 12 | `python3 -c "import yaml;print(len(yaml.safe_load(open('.github/workflows/ci.yml'))['jobs']))"` |
| Workflow total | 12 | `ls .github/workflows/` |
| Spec E2E | 19 | `ls web/e2e/*.spec.ts | wc -l` |
| Berkas tes web | 137 | `find web/src -name '*.test.ts*' | wc -l` |
| Berkas tes server | 102 (13 Nov 2026) | daftar eksplisit `server/package.json` |
| Tes Go KT | 58 | `cd server/kt-query && ./build.sh test` |
| Aturan alert | 44 | `grep -c '^\s*- alert:' ops/prometheus/alerts.yml` |
| Required contexts `main` | 14 | `gh api repos/h4nzs/nyx-chat/branches/main/protection` |
| Manifest E2E | chromium 10 / chrome 13 `mustPass`, `minTotal` 24 | `web/e2e/required-tests.json` |
| Durasi job E2E | ≈20–22 menit | halaman run Actions |
| Alert Dependabot terbuka | 11 (2 high / 5 medium / 4 low) — per cek terakhir | `gh api .../dependabot/alerts?state=open` |

## 41.3 Phase 0 — hijaukan main (terbukti hijau di CI)

> Perbaikan E2E (`82b94359`, `04fd58af`) sudah di-push dan run CI
> [42351711379](https://github.com/h4nzs/nyx-chat/actions/runs/42351711379)
> (commit `dabeb44c`) menutup phase ini: **12/12 job hijau**, termasuk
> `E2E (Playwright, Chromium)` dan `E2E (Chrome penuh — WebTransport/QUIC
> aktif)`. Perbaikan lanjutan yang ikut terbukti di run itu: kutip tunggal pada
> ekspresi `concurrency` (`e7953b80`), S3 smoke memakai `rclone serve s3`
> menggantikan image MinIO yang tidak lagi terdistribusi (`805c06fe`), dan nama
> env `NYX_RCLONE_VERSION` agar tidak dibaca rclone sebagai flag `--version`
> (`dabeb44c`).

- `settings.spec.ts` memeriksa route terproteksi lewat **page baru di context yang
  sama**, bukan `goto()` di page yang sedang menjalankan `window.location.replace('/')`
  (itu yang dulu menghasilkan `net::ERR_ABORTED`), dan tanpa `catch(() => {})` yang
  membuat asersi vakum.
- `auth.spec.ts` membuktikan logout benar-benar mencabut sesi sebelum login ulang,
  dan membersihkan state lokal dari halaman yang stabil (race "Execution context
  was destroyed").
- OHTTP: akar masalah bukan token/trust-proxy melainkan **prefix `/api/ohttp`
  yang hilang di stack uji** (`1fb27815`); spec kini membaca status relay, bukan
  hanya menunggu teks hasil.

## 41.4 P0 — fondasi sinyal

### 6.1 Coverage web — selesai

`web/vite.config.ts` → `test.coverage`: provider v8, reporter `text`,
`json-summary`, `html`, `lcov`, `reportOnFailure: true`. Lantai berlaku **per
berkas** (perilaku glob Vitest) untuk `spqr*`, `kt*`, `group*`, `privacy*`,
`keychainDb`, dan `messagePipeline`.

**Angka per glob — nilai terukur, lantai, dan alasan tiap pengecualian — ada di
`docs/11` §11.1d, satu-satunya sumber.** Jangan menyalin tabelnya ke sini supaya
tidak ada dua daftar yang bisa menyimpang. Prinsipnya tetap: global
(lines/functions/branches/statements) sengaja **0** karena angka global bisa
naik-turun karena berkas yang sudah teruji dan justru menutupi modul kritis, dan
`src/utils/crypto.ts` **tidak** diberi lantai karena permukaannya berjalan di
crypto worker dan diuji lewat E2E.

### 6.2 Coverage server — selesai

`server/scripts/test-coverage.mjs` membaca script `test` dari `package.json`
(satu-satunya daftar berkas tes) lalu menjalankannya dengan
`--experimental-test-coverage`; tidak ada daftar kedua yang bisa menyimpang.
Gagal karena `NODE_OPTIONS` menolak flag itu, jadi runner memanggil
`process.execPath` langsung dengan `--import tsx` dan `--enable-source-maps`.
Baseline 3 Nov 2026: lines 77,3% · branches 84,7% · functions 79,4% → gate
**72/78/74**.

### 6.3 Changed-lines — selesai untuk web, non-blocking

`scripts/check-changed-lines.mjs` membandingkan baris yang diubah dengan
`web/coverage/lcov.info`; `--diff-file <patch>` memungkinkan pengujian tanpa
mengubah repo. Di CI jalan di job `unit` pada PR dengan `continue-on-error`
sampai angka global stabil 10 run. Server belum mungkin: reporter native Node
tidak mengeluarkan lcov.

### 6.4 `groupLifecycle.spec.ts` — kontrak HTTP + era kripto selesai; fault injection belum

Tiga context browser, memakai endpoint yang sudah ada (`POST /api/conversations`,
`/participants`, `/leave`, `/group`, `/key-rotation`, `POST /api/groups/:id/epoch`,
mailbox, sync). Skenario: buat + kirim, tambah anggota sebelum pesan pertama,
keluarkan anggota (pull era baru harus gagal), tambah kembali, rotasi epoch
dipaksa dengan `X-Admin-Token`, pesan era lama tetap terbaca dari arsip. Plus
fault injection: tunda `metadata:updated`, kirim `group:fulfilled_key` sebelum
metadata, putuskan socket saat rotasi, reload saat rotasi.

**Status 7 November 2026:** yang berjalan baru **kontrak HTTP** (3 context
nyata: buat grup, token gate `403 BLIND_AUTH_REQUIRED`, rotasi admin, kick
merotasi era token, purge `409 MEMBERS_REMAIN` → 204) dan itu sudah masuk
`mustPass`.

**Status 14 November 2026 — era kripto selesai:** `web/e2e/groupEra.spec.ts`
(2 konteks, **lulus 4,6 menit** di chromium) membuat grup lewat modal UI yang
sama dengan pengguna, mengirim pesan era awal dan memastikan anggota
membacanya, memutar epoch dari panel info grup (`GroupInfoPanel` →
`rotateGroupEpochNow`) bukan lewat request, lalu membuktikan pesan era baru
terbaca anggota dan **pesan era lama tetap terbaca setelah halaman di-reload**
di kedua sisi — itu bukti kunci era lama tersimpan, bukan hanya di memori. Spec
ini masuk `mustPass` untuk `chromium` dan `chrome` (`minTotal` 24 → 25).

Dua hal yang ditemukan saat menulisnya, keduanya dicatat di kepala spec:
`playwright.config.ts` tidak menetapkan `actionTimeout`, jadi aksi lokator yang
tidak pernah resolve menggantung sampai anggaran tes habis (spec memakai
`setDefaultTimeout(60_000)` per halaman); dan grup harus dibuat **sebelum**
navigasi percakapan apa pun, karena klik `New Group` saat navigasi masih
berjalan membuat modal ter-unmount 200 ms kemudian.

**Belum**: keempat skenario fault injection di atas (tunda `metadata:updated`,
`group:fulfilled_key` sebelum metadata, socket putus saat rotasi, reload saat
rotasi).

### 6.5 Required-tests gate — selesai

`web/e2e/required-tests.json` (`minTotal`, `mustPass`, `allowedSkipReasons`) +
`web/e2e/verify-required-tests.mjs` membaca report JSON Playwright. Gagal bila:
entri cocok dengan 0 tes, tes `mustPass` di-skip, atau skip tanpa alasan yang
terdaftar. `--self-test` menjalankan 12 skenario sintetis (8 gate: lulus, skip
beralasan, tes wajib di-skip, skip tanpa alasan, alasan tak diizinkan, tes
hilang, jumlah menyusut; 4 karantina: sah, kedaluwarsa, tes hilang, masih
berjalan) dan ikut jalan di CI.

Cakupan `mustPass`: auth (register/login/wrong password), profile, security,
settings, recovery, deviceLinking, group lifecycle, backup/restore — **10 tes di
chromium** — plus transport (2), chat, profile, security, settings, recovery,
deviceLinking, group lifecycle, dan backup/restore di chrome (**13 tes**). Skip
hanya sah bila labelnya cocok dengan `allowedSkipReasons`; alasan baru berarti PR
yang mengubah manifest. (`call.spec.ts` sengaja **tidak** ada di `mustPass`:
butuh coturn, dan di luar job `e2e-chrome` ia skip dengan alasan tertulis.)

### 6.6 MinIO / jalur sukses R2 — jalur nyata sudah dijalankan

Seam `r2Endpoint` ada di `server/src/config.ts` + `server/src/utils/r2.ts`
(klien S3 dibuat saat modul dimuat, jadi env harus ada sebelum boot).
`server/tests/r2Endpoint.test.ts` berisi 4 tes kontrak endpoint **dan** satu tes
opt-in (`NYX_R2_SMOKE=1`) yang menjalankan put objek (jalur server) → HEAD →
presign GET → presign PUT dari klien → HEAD lagi → GET isi objek → DELETE
terhadap endpoint S3-compatible nyata. Dijalankan 5 November 2026 di
mesin selfhost dengan `rclone serve s3` (`:9000`, SigV4 divalidasi): **5/5 lulus**.
Dua koreksi yang ditemukan jalur ini: SigV4 `region: 'auto'` ditolak endpoint
non-R2 (kini `us-east-1` bila `R2_ENDPOINT` diset) dan `r2Configured()` dulu
mewajibkan `R2_ACCOUNT_ID` sehingga MinIO selalu 503. Sejak 7 November 2026 job
`unit` di `ci.yml` menjalankan `rclone serve s3` (versi dipin `v1.75.2`) — MinIO
tidak lagi mendistribusikan image/binary gratis (`docker minio/minio` ditolak,
`dl.min.io` 410), sementara rclone tetap memvalidasi SigV4 penuh — lalu
menjalankan tes yang sama dengan
`NYX_R2_SMOKE=1 NYX_R2_SMOKE_CREATE_BUCKET=1`; sengaja di job yang sudah ada
supaya daftar 12 required check tidak berubah. **Belum**: skenario E2E
`available: true` → arsip terunggah → perangkat baru mengunduh; jalur negatif
503 sudah ada dan harus tetap lulus.

### 6.7 PIR dua server — selesai WP1–WP9 (fitur tetap default mati)

**Keputusan 2026-11-09** mengubah arah: ChalametPIR (tanpa proof, hint ±11 MB,
rebuild global tiap epoch) diganti **XOR-PIR dua server + sharding**. Alasan,
kontrak wire, gate, dan paket kerja ada di `docs/42-pir-two-server-sharded.md`;
bagian ini hanya mencatat status.

- WP1 ✅ kontrak `xor-pir-v1` + record v2 + manifest (`packages/shared/src/pir.ts`).
- WP2 ✅ builder per shard (cuckoo 3-kandidat, `dbRoot`, manifest ML-DSA-65) di
  `server/src/pir/{shards,manifest}.ts`.
- WP3 ✅ core XOR-PIR di `server/pir-sidecar/src/{pir,shard}.rs`: share bit
  LSB-first, `answer(share)`, validasi `dbRoot` terhadap isi slot, hot-swap
  per shard dengan epoch monoton.
- WP4 ✅ sidecar role A/B: `/health`, `/manifest?shard=N`, `/query?shard=N`,
  `/admin/rebuild` per shard; ChalametPIR (`/params`, snapshot lama, `bench:pir`)
  dihapus dari binary.
- WP5 ✅ proxy `/api/pir/:server/{manifest,query}?shard=N`: konfigurasi
  `PIR_SERVERS` (≥2, gagal boot bila kurang), kunci manifest ter-pin, dan
  verifikasi tanda tangan sebelum diteruskan; job rebuild menandatangani per
  server, memastikan `dbRoot` identik, lalu hot-swap kedua sidecar.
- WP6 ✅ jalur klien baru: `web/src/lib/pirManifest.ts` (pin + verifikasi
  manifest ML-DSA-65), `pirClient.ts` (XOR dua jawaban per shard),
  `ohttpClient.ts` (relayUrl per request). Jalur lama dihapus — `packages/pir-wasm`,
  entri `wasm-artifacts.json`, `pir.worker.ts`, `pirParams.ts`, dan kode galat
  `PIR_PARAMS_INVALID` sudah tidak ada.
- WP7 ✅ operasional: 8 metrik PIR (`server/src/utils/metrics.ts`), 4 alert +
  kasus firing/non-firing di drill (`NyxPirTampered`, `NyxPirDesync`,
  `NyxPirSidecarDown`, `NyxPirRebuildStale`), templat systemd
  `nyx-pir@.service` (`%i` = a/b → :9470/:9471), dan docs/10 §10.19 ditulis
  ulang untuk dua server.
- WP8 ✅ pengujian: vektor lintas-implementasi di
  `server/tests/fixtures/pirVectors.json` dipakai bersama oleh
  `server/tests/pirVectors.test.ts` (Node) dan tes Rust
  `cross_impl_vectors_match_fixture`; E2E dua server nyata di
  `web/e2e/pir.spec.ts` + `web/playwright.pir.config.ts`
  (`pnpm --filter nyx-web run test:e2e:pir`, job `pir-e2e` di `drills.yml`)
  membuktikan hit lewat XOR dua server + OHTTP, miss, dan nol permintaan ke
  `/api/users/search`.
- Performa (2026-11-11, `node scripts/bench/pir-query.mjs`): `S=4096/R=2048`
  p50 2,5 ms / p95 3,8 ms / p99 5,1 ms, 2.560 B per query sidecar (15.360 B per
  pencarian penuh), RSS 1,61× pada shard 8 MiB dan 1,16× pada 32 MiB. Angka
  target vs terukur dipisah di `docs/42`.
- WP9 ✅ pembersihan: `STATUS.md` mencatat suite `xor-pir-v1` dan rute
  `/api/pir/:server/{manifest,query}` (diperiksa `scripts/check-status.mjs`),
  dan dokumen yang masih menggambarkan PIR satu-server sudah ditandai
  superseded. Fitur tetap **default mati**, jadi tidak ada perubahan perilaku
  pengguna sampai `PIR_ENABLED` dinyalakan.
- `PIR_TAMPERED`/`PIR_DESYNC` dibuktikan di `web/src/lib/__tests__/pirClient.test.ts`
  (mock dua server), bukan dengan sidecar live yang sengaja dirusak: sidecar
  menolak shard yang `dbRoot`-nya tidak cocok, jadi jalur rebuild tidak bisa
  dipakai menyuntikkan record rusak. Jangan menulis asersi "proof salah
  ditolak" — `xor-pir-v1` tidak memakai proof; jaminannya dua server dengan
  satu yang jujur.

### 6.8 KT live E2E — ABI 2 terbukti; interop `cmd/kt-client` menyusul

Baca KT di klien kini **ABI 2** (config tanpa `abiVersion: 2` → `unavailable`,
tidak ada fallback senyap ke verifier v1); tulis lewat `KT_V2_SERVER_URL`, baca
lewat `KT_QUERY_URL`, rollback kini butuh redeploy bukan env flip. E2E browser
sebaiknya menguji jalur yang benar-benar dipakai: `/api/keys/kt/*` → layanan KT →
verifier WASM, termasuk monitor fail-closed (`verifyMonitor` sukses sebelum state
ditulis) dan proof dirusak → UI tidak menampilkan "terverifikasi".

**Status 8 November 2026:** jalur transport ABI 2 sudah diuji nyata —
`ktLive.spec.ts` mendaftar akun, lalu memeriksa `config` (abiVersion 2 + kunci
ML-DSA-65 3904 hex), `/head`, anchor `distinguished`, dan bukti publik
`POST /search`; **lulus 1,4 menit** terhadap `nyx-kt-query-v2` lokal. Verifikasi
proof di WASM dan monitor fail-closed sudah dikunci unit test
(`keyTransparency.test.ts`, `ktMonitoring.test.ts`), bukan diduplikasi di E2E.
Interop `cmd/kt-client` tetap menjadi item terpisah sesuai keputusan §41.7(a).

## 41.5 P1/P2 — status per 5 November 2026

- **§7.1** WebKit/Firefox smoke — **hijau di nightly 13 November 2026**:
  `firefox` dan `webkit` di `web/playwright.config.ts`, job `browsers` di
  `nightly.yml` (auth + settings + a11y dalam satu job). Run `43433660755`
  (head `ee2c0f2f`) selesai 5/5 job hijau: Firefox 4/4 (4,7 m), WebKit 4/4
  (4,8 m), a11y 3/3 (1,4 m). Yang membuat WebKit menggantung bukan tesnya:
  build dev tidak punya `sw.js`, dan menyentuh `navigator.serviceWorker` di
  WebKit membekukan main thread — karena itu semua jalur push/SW sekarang
  lewat `isPushSupported()` (`web/src/lib/pushSupport.ts`) yang mensyaratkan
  build produksi sebelum menyentuh `navigator`. Anggaran langkah trust adalah
  `TRUST_STEP_TIMEOUT_MS` = 180 dtk dengan angka terukur (Firefox CI 1,3 m,
  WebKit lokal 45–60 dtk), bukan 90 dtk yang memotong pekerjaan sah.
  **Naik ke PR setelah 7 hari hijau** (paling cepat 20 November 2026).
- **§7.2** Contract test HTTP — **selesai sebagai tes opt-in**:
  `server/tests/httpContract.test.ts` (7 tes) dijalankan job `http-contract`
  nightly. Env diset sebelum `import app`; Redis disambungkan **sebelum** import
  karena store limiter dibuat saat modul dimuat (kalau dibalik, semua request
  500 `ClientClosedError` — itu yang pertama ditemukan tes ini). Memakai
  `fetch` + `app.listen(0)`, bukan `supertest` (tidak perlu dependensi baru).
  **Sudah ditambah 8 November 2026**: rate-limit 429 (bucket unik lewat
  `CF-Connecting-IP` agar tidak memakan limiter 127.0.0.1 milik E2E) — suite
  **lulus** (`node:test` melaporkan 8 tes: 7 sub-tes di atas + pembungkusnya).
  **Ditambahkan 12 November 2026**: `COOKIE_DOMAIN` (atribut `Domain` pada cookie
  CSRF) dan token bearer OHTTP yang ditolak `403 OHTTP_SCOPE_DENIED` di luar
  allowlist — keduanya lulus dalam suite kontrak (9/9). Urutan gate
  `token → admin → member count` juga diuji lewat request HTTP nyata di
  `groupLifecycle.spec.ts`: tanpa token → 403 `BLIND_AUTH_REQUIRED`, token saja
  → 403 `ADMIN_AUTH_REQUIRED`, keduanya dengan anggota tersisa → 409
  `MEMBERS_REMAIN`.
- **§7.3** Nightly — **hijau penuh 13 November 2026**:
  `.github/workflows/nightly.yml` (02:00 UTC) berisi fuzz web 1 jam, fuzz
  sidecar 1 jam, k6 100 VU di stack ephemeral, smoke Firefox/WebKit, a11y,
  contract HTTP. Run `43433660755` (head `ee2c0f2f`) menyelesaikan **5/5 job
  hijau**: fuzz web 60,5 m, fuzz sidecar 61,1 m, k6 5,8 m, contract HTTP 55 dtk,
  browsers 12,6 m. Drill tetap di `drills.yml`; k6 hanya boleh ke stack
  ephemeral.
- **§7.4** Karantina flake — **selesai**: `web/e2e/quarantine.json` +
  `evaluateQuarantine` di `verify-required-tests.mjs`. Entri wajib
  `owner`/`reason`/`expires`; kedaluwarsa, tes hilang, atau tes yang masih
  dijalankan menggagalkan gate. Self-test 12/12 (8 gate + 4 karantina).
  **Belum**: metrik flake dari report dan `retries: 0` (butuh 10 run hijau dulu).
- **§7.5** Backup/restore E2E — **terjadwal, bukan per-PR**: job
  `client-restore` di `drills.yml` menjalankan `scripts/client-restore-drill.sh`
  mingguan di atas dump Postgres nyata. **Jalur Playwright ditambahkan 8 November
  2026**: `web/e2e/backupRestore.spec.ts` membuat `.nyxbak` lewat Settings
  (magic `NYXB`, unduhan nyata), lalu merestore berkas yang sama dengan recovery
  phrase yang dibaca dari modal onboarding — **lulus 2,1 menit**, masuk
  `mustPass`.
- **§8** a11y — **halaman tanpa sesi selesai**: `web/e2e/a11y.spec.ts` +
  `@axe-core/playwright` + `playwright.a11y.config.ts` (tanpa global reset DB,
  supaya bisa jalan di mesin ber-`server/.env` produksi). Pemindaian pertama
  menemukan `color-contrast` serious di Login (3 node) dan Register (2 node);
  **UI-nya diperbaiki**, bukan aturannya dimatikan. Sejak 8 November 2026 spec
  juga memindai **Settings ber-sesi** dan menemukan `select-name`, `label`,
  `button-name`, serta kontras `DefaultAvatar`; semuanya diperbaiki di UI
  (aria-label select/input, nama tombol swatch, kontras tombol Register dan
  avatar). **13 November 2026**: job `browsers` menemukan satu lagi
  `color-contrast` serious — badge "SANDBOXED" di Settings
  (`text-yellow-500` di atas tint `bg-yellow-500/10` ≈ 1,4:1) — diperbaiki di
  UI menjadi `text-yellow-800 dark:text-yellow-300`; fase a11y lalu hijau
  **3/3 (1,4 m)** di run `43433660755`. PWA/offline, visual regression, perf
  budget, chaos/race, kebocoran lintas akun, dan mutation testing belum.

## 41.6 Engineering health

### 9.1 Branch protection — aktif

14 required contexts = 12 job `ci.yml` + `Analyze (actions)` +
`Analyze (javascript-typescript)`. `strict: false`, `enforce_admins: false`
(bypass admin untuk darurat, alasannya dicatat), tanpa wajib PR/review,
force-push dan penghapusan branch diblokir. Gate isi (manifest, coverage) hidup
di dalam job — required check hanya sekuat job yang menjalankannya.

### 9.2 Dependabot — selesai

Dependabot per-`directory` hanya mengubah `<workspace>/package.json`, bukan
`pnpm-lock.yaml` root, sehingga setiap PR mati di `ERR_PNPM_OUTDATED_LOCKFILE`.
`dependabot-lockfile.yml` meregenerasi lockfile (`--lockfile-only`) dan
mendorongnya ke branch PR lewat GitHub App (`vars.APP_ID` +
`secrets.APP_PRIVATE_KEY`), karena push `GITHUB_TOKEN` tidak memicu CI ulang.
`ci.yml` tetap `--frozen-lockfile`. Tanpa App, job sengaja tidak jalan dan PR
tetap merah dengan pesan yang jujur. Detail: `docs/25` §25.5.

### 9.4 CI hygiene — selesai

- `concurrency` per ref; `cancel-in-progress` hanya untuk PR, push ke `main`
  tidak pernah dibatalkan.
- `timeout-minutes`: build 15, wasm 20, unit 20, pir-sidecar 20, sidecar 20,
  lint 5, alerts 5, dr-oracle 15, kt-recovery-v2 20, audit 5, e2e 40,
  e2e-chrome 45.
- Artifact `web/test-results/` + `web/playwright-report/` di-upload saat gagal.

### 9.3/9.5 Audit + definition of done

Audit pass 12 menutup N12-01/N12-02 dan memverifikasi F-13
(`docs/audit/pass-12/10-delta.md`). Definition of done yang belum tercapai:
`main` hijau 10 run berturut-turut, flake < 2%, coverage modul kritis ≥ 80/70,
nightly hijau 7 hari, tidak ada high terbuka > 7 hari.

## 41.7 Keputusan

**Sudah terjawab oleh praktik:** target coverage (lantai terukur, bukan 80%
global — §6.1/§6.2); siapa boleh bypass branch protection (admin, dengan
`enforce_admins: false` dan catatan alasan); cara memperbaiki PR Dependabot
(opsi ketiga: GitHub App, bukan `--no-frozen-lockfile`).

**Terjawab 8 November 2026:** (a) KT — **ABI 2 sekarang**, interop
`cmd/kt-client` menjadi item lanjutan; (b) PIR — **verifikasi proof di klien
dulu**, dan karena ChalametPIR tidak menghasilkan proof, mekanismenya masih
terbuka (Merkle inclusion + root bertanda tangan vs skema PIR terverifikasi).
**Diputuskan 12 November 2026:** (c) WebKit/Firefox tetap **nightly-only**;
belum dipindah ke PR sampai ada 7 hari hijau. (d) Changed-lines server **tidak
dikejar**: `node --test-reporter=lcov` di Node 26 hanya menghasilkan `TN:` dan
exit 1 pada percobaan nyata, jadi butuh toolchain lcov baru yang tidak sepadan
untuk gate non-blocking. Changed-lines web tetap dilaporkan dan belum memblokir
sampai 10 run stabil.

## 41.8 Cara verifikasi

```bash
# web
cd web && npx tsc --noEmit && npx oxlint src e2e && npx vitest run --coverage
npx playwright test --project=chromium          # per spek saat iterasi:
npx playwright test e2e/auth.spec.ts --project=chromium
node e2e/verify-required-tests.mjs --self-test        # 12 skenario (gate + karantina)
npx playwright test e2e/a11y.spec.ts --config=playwright.a11y.config.ts --project=chrome
npx playwright test e2e/ktLive.spec.ts --project=chrome      # butuh KT v2 hidup
npx playwright test e2e/backupRestore.spec.ts --project=chrome

# server
cd server && npx tsc --noEmit && pnpm test && pnpm test:coverage

# repo / CI
node scripts/check-changed-lines.mjs --self-test
bash scripts/drill-alerts.sh                    # SKIP_LIVE=1 di CI
gh api repos/h4nzs/nyx-chat/branches/main/protection
gh workflow run drills.yml                      # atau tunggu Senin 04:00 UTC
```
