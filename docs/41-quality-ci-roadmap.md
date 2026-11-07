# 41 — Roadmap kesehatan development, audit, tes, E2E, coverage, dan CI

**Status:** hidup — diperbarui 5 November 2026.
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
| Phase 0 — hijaukan E2E | ✅ selesai di kode; hijau belum dibuktikan run CI (commit lokal belum di-push) | `web/e2e/settings.spec.ts` (page baru pasca-eject), `web/e2e/auth.spec.ts` (bukti logout + pembersihan state), `1fb27815` (prefix `/api/ohttp` di stack uji) |
| §6.1 coverage web | ✅ selesai | `web/vite.config.ts` (`test.coverage`), `pnpm --filter nyx-web run test:coverage` |
| §6.2 coverage server | ✅ selesai | `server/scripts/test-coverage.mjs` |
| §6.3 changed-lines | ✅ selesai (web; non-blocking) | `scripts/check-changed-lines.mjs`, step di job `unit` |
| §6.4 `groupLifecycle.spec.ts` | ✅ (kontrak HTTP) | `web/e2e/groupLifecycle.spec.ts`: 3 konteks browser, buat grup, tambah anggota, gate token, rotasi admin, kick merotasi era token, purge 409/204; **lulus 4,1 menit**. Menemukan bug: DELETE tanpa body → `req.body` undefined → kick sah 500 (diperbaiki di `routes/conversations.ts`). Pesan terenkripsi/era kripto belum dikirim (batas jujur di kepala spec) |
| §6.5 required-tests gate | ✅ selesai | `web/e2e/required-tests.json`, `web/e2e/verify-required-tests.mjs`, 2 step di `ci.yml` |
| §6.6 MinIO jalur sukses R2 | ✅ dijalankan lokal + CI | `R2_ENDPOINT` di `server/src/config.ts` + `resolveR2Endpoint` (`utils/r2.ts`); 4 tes kontrak + 1 tes opt-in `NYX_R2_SMOKE=1`; presign→PUT→HEAD→GET→DELETE nyata lulus terhadap `rclone serve s3` (SigV4 penuh, 5/5). Job `unit` menjalankan `rclone serve s3` v1.75.2 (`NYX_R2_SMOKE_CREATE_BUCKET=1`) tanpa menambah required check |
| §6.7 PIR live E2E | ⬜ belum | butuh sidecar PIR + gateway OHTTP hidup |
| §6.8 KT live E2E | ⬜ belum | butuh layanan KT v2 (`nyx-kt-query-v2`) + snapshot; keputusan di §41.5 |
| §7.1 WebKit/Firefox smoke | 🟡 project + nightly | `firefox`/`webkit` di `playwright.config.ts`, job `browsers` di `nightly.yml`; belum ada run hijau (butuh runner ber-browser) |
| §7.2 contract test HTTP | ✅ opt-in | `server/tests/httpContract.test.ts` (7 tes: helmet, JSON 400, CSRF 403, body 413, csrf-token, CORS) + job `http-contract`; memakai `fetch` + `app.listen(0)`, bukan supertest, dan tidak jalan di suite unit karena butuh Redis/Postgres |
| §7.3 nightly fuzz/k6 | ✅ workflow | `.github/workflows/nightly.yml`: fuzz web 1 jam, fuzz sidecar 1 jam, k6 100 VU ephemeral, smoke Firefox/WebKit, a11y, contract HTTP; belum ada run hijau di Actions |
| §7.4 flake gate + karantina | ✅ gate | `web/e2e/quarantine.json` + `evaluateQuarantine` di `verify-required-tests.mjs` (owner/reason/expires wajib; kedaluwarsa/masih-jalan tes hilang = gagal); self-test 12/12 |
| §7.5 backup/restore E2E | 🟡 terjadwal | `drills.yml` job `client-restore` menjalankan drill mingguan; belum per-PR |
| §8 a11y (sisanya belum) | 🟡 a11y | `web/e2e/a11y.spec.ts` + `@axe-core/playwright` + `playwright.a11y.config.ts` (tanpa reset DB); kontras Login/Register diperbaiki; halaman ber-sesi, PWA/offline, visual, perf, mutation belum |
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
| Spec E2E | 16 | `ls web/e2e/*.spec.ts | wc -l` |
| Berkas tes web | 137 | `find web/src -name '*.test.ts*' | wc -l` |
| Berkas tes server | 101 | daftar eksplisit `server/package.json` |
| Tes Go KT | 58 | `cd server/kt-query && ./build.sh test` |
| Aturan alert | 44 | `grep -c '^\s*- alert:' ops/prometheus/alerts.yml` |
| Required contexts `main` | 14 | `gh api repos/h4nzs/nyx-chat/branches/main/protection` |
| Manifest E2E | chromium 9 / chrome 12 `mustPass`, `minTotal` 22 | `web/e2e/required-tests.json` |
| Durasi job E2E | ≈20–22 menit | halaman run Actions |
| Alert Dependabot terbuka | 11 (2 high / 5 medium / 4 low) — per cek terakhir | `gh api .../dependabot/alerts?state=open` |

## 41.3 Phase 0 — hijaukan main (kode selesai, verifikasi CI tertunda)

> Commit perbaikan E2E (`82b94359`, `04fd58af`) ada di lokal dan **belum
di-push**, jadi belum ada run CI yang membuktikan kedua job E2E hijau. Jangan
menulis "main hijau" sebelum run itu ada.

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
(satu-satunya daftar 99 berkas) lalu menjalankannya dengan
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

### 6.4 `groupLifecycle.spec.ts` — belum

Tiga context browser, memakai endpoint yang sudah ada (`POST /api/conversations`,
`/participants`, `/leave`, `/group`, `/key-rotation`, `POST /api/groups/:id/epoch`,
mailbox, sync). Skenario: buat + kirim, tambah anggota sebelum pesan pertama,
keluarkan anggota (pull era baru harus gagal), tambah kembali, rotasi epoch
dipaksa dengan `X-Admin-Token`, pesan era lama tetap terbaca dari arsip. Plus
fault injection: tunda `metadata:updated`, kirim `group:fulfilled_key` sebelum
metadata, putuskan socket saat rotasi, reload saat rotasi.

### 6.5 Required-tests gate — selesai

`web/e2e/required-tests.json` (`minTotal`, `mustPass`, `allowedSkipReasons`) +
`web/e2e/verify-required-tests.mjs` membaca report JSON Playwright. Gagal bila:
entri cocok dengan 0 tes, tes `mustPass` di-skip, atau skip tanpa alasan yang
terdaftar. `--self-test` menjalankan 12 skenario sintetis (8 gate: lulus, skip
beralasan, tes wajib di-skip, skip tanpa alasan, alasan tak diizinkan, tes
hilang, jumlah menyusut; 4 karantina: sah, kedaluwarsa, tes hilang, masih
berjalan) dan ikut jalan di CI.

Cakupan `mustPass`: auth (register/login/wrong password), profile, security,
settings, recovery, deviceLinking, group lifecycle — 9 tes di chromium — plus
transport, chat, dan call di chrome (12 tes). Skip hanya sah bila labelnya cocok dengan
`allowedSkipReasons`; alasan baru berarti PR yang mengubah manifest.

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

### 6.7 PIR live E2E — belum

Klien menolak jalan tanpa OHTTP (`PIR_REQUIRES_OHTTP`), jadi stack PIR harus
menyalakan gateway OHTTP. Skenario: params, query hit, `PIR_RECORD_MISS`, `409
PIR_EPOCH_STALE`, tidak ada username polos di body. **Catatan desain:** klien
belum memverifikasi proof secara kriptografis — jangan menulis asersi "proof
salah ditolak" sebelum mekanismenya ada.

### 6.8 KT live E2E — belum, butuh keputusan

Baca KT di klien kini **ABI 2** (config tanpa `abiVersion: 2` → `unavailable`,
tidak ada fallback senyap ke verifier v1); tulis lewat `KT_V2_SERVER_URL`, baca
lewat `KT_QUERY_URL`, rollback kini butuh redeploy bukan env flip. E2E browser
sebaiknya menguji jalur yang benar-benar dipakai: `/api/keys/kt/*` → layanan KT →
verifier WASM, termasuk monitor fail-closed (`verifyMonitor` sukses sebelum state
ditulis) dan proof dirusak → UI tidak menampilkan "terverifikasi".

## 41.5 P1/P2 — status per 5 November 2026

- **§7.1** WebKit/Firefox smoke — **project + job nightly siap**: `firefox` dan
  `webkit` di `web/playwright.config.ts`, job `browsers` di `nightly.yml`
  (auth + settings). Naik ke PR setelah 7 hari hijau. **Belum ada run hijau**:
  job-nya belum pernah dieksekusi di Actions.
- **§7.2** Contract test HTTP — **selesai sebagai tes opt-in**:
  `server/tests/httpContract.test.ts` (7 tes) dijalankan job `http-contract`
  nightly. Env diset sebelum `import app`; Redis disambungkan **sebelum** import
  karena store limiter dibuat saat modul dimuat (kalau dibalik, semua request
  500 `ClientClosedError` — itu yang pertama ditemukan tes ini). Memakai
  `fetch` + `app.listen(0)`, bukan `supertest` (tidak perlu dependensi baru).
  **Belum dicakup**: `COOKIE_DOMAIN`, rate-limit 429, OHTTP bearer scope, urutan
  gate `token → admin → member count` (butuh akun + DB nyata, kandidat lanjutan).
- **§7.3** Nightly — **workflow dibuat**: `.github/workflows/nightly.yml`
  (02:00 UTC) berisi fuzz web 1 jam, fuzz sidecar 1 jam, k6 100 VU di stack
  ephemeral, smoke Firefox/WebKit, a11y, contract HTTP. Drill tetap di
  `drills.yml`. **Belum ada run hijau**; k6 hanya boleh ke stack ephemeral.
- **§7.4** Karantina flake — **selesai**: `web/e2e/quarantine.json` +
  `evaluateQuarantine` di `verify-required-tests.mjs`. Entri wajib
  `owner`/`reason`/`expires`; kedaluwarsa, tes hilang, atau tes yang masih
  dijalankan menggagalkan gate. Self-test 12/12 (8 gate + 4 karantina).
  **Belum**: metrik flake dari report dan `retries: 0` (butuh 10 run hijau dulu).
- **§7.5** Backup/restore E2E — **terjadwal, bukan per-PR**: job
  `client-restore` di `drills.yml` menjalankan `scripts/client-restore-drill.sh`
  mingguan di atas dump Postgres nyata. Jalur spec Playwright yang memakai
  `backupFormat.ts`/`backupRestore.ts` belum ada.
- **§8** a11y — **halaman tanpa sesi selesai**: `web/e2e/a11y.spec.ts` +
  `@axe-core/playwright` + `playwright.a11y.config.ts` (tanpa global reset DB,
  supaya bisa jalan di mesin ber-`server/.env` produksi). Pemindaian pertama
  menemukan `color-contrast` serious di Login (3 node) dan Register (2 node);
  **UI-nya diperbaiki**, bukan aturannya dimatikan — tes hijau 2/2. Halaman
  ber-sesi, PWA/offline, visual regression, perf budget, chaos/race, kebocoran
  lintas akun, dan mutation testing belum.

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

**Masih terbuka:** (a) KT E2E — cukup jalur ABI 2 yang sekarang, atau tunggu
interop `cmd/kt-client`; (b) PIR — apakah verifikasi proof di klien ditambahkan;
(c) WebKit/Firefox — nightly saja atau langsung PR; (d) apakah changed-lines
server layak dikejar (butuh lcov dari toolchain lain).

## 41.8 Cara verifikasi

```bash
# web
cd web && npx tsc --noEmit && npx oxlint src e2e && npx vitest run --coverage
npx playwright test --project=chromium          # per spek saat iterasi:
npx playwright test e2e/auth.spec.ts --project=chromium
node e2e/verify-required-tests.mjs --self-test        # 12 skenario (gate + karantina)
npx playwright test e2e/a11y.spec.ts --config=playwright.a11y.config.ts --project=chrome

# server
cd server && npx tsc --noEmit && pnpm test && pnpm test:coverage

# repo / CI
node scripts/check-changed-lines.mjs --self-test
bash scripts/drill-alerts.sh                    # SKIP_LIVE=1 di CI
gh api repos/h4nzs/nyx-chat/branches/main/protection
gh workflow run drills.yml                      # atau tunggu Senin 04:00 UTC
```
