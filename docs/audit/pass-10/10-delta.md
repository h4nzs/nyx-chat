# Pass 10 — Laporan delta

Basis: `bfca57c7`. Pass 1: `AUDIT_REPORT.md`. Pass 2–9: `pass-2/`…`pass-9/`.
Temuan baru: `20-findings.md`. Verifikasi fix: `30-verify-fixes.md`.

## Ringkasan satu paragraf

Ketiga fix pass 9 benar di intinya, tetapi **dua di antaranya tidak mencapai
tujuan yang ditulis di commit message**, dan pass ini membuktikannya dengan
menjalankan kode, bukan membaca komentar. N9-01 memberi API tag per klien —
probe menunjukkan gateway meneruskan 120 tag berbeda — tetapi **dua limiter
120/menit lain di jalur yang sama masih satu bucket global**: `ohttpLimiter` di
gateway (`req.ip` = loopback) dan limiter relay (`req.ip` = nginx). Probe: 140
request dengan dua tag sah tetap kena 429 di #121; 140 `cf-connecting-ip`
berbeda di relay juga kena 429 di #121. Jadi kegagalan yang membuat verifikasi
KT `unavailable` untuk semua orang **masih ada**, malah dengan batas 120/menit
yang lebih ketat daripada bucket 240/menit yang digantikannya. N9-03 hanya
mendaur state yang **byte-identik**; sesi X3DH baru menghasilkan state awal yang
berbeda (118 B, terbukti), sehingga dua era tanpa pesan tetap memakan dua slot
arsip. N9-02 bekerja (unknown-account/unreadable fail-closed) tetapi urutannya
di `monitorKeyTransparency` membuat jalur "belum ada yang dimonitor" melempar
lebih dulu — tes `ktMonitoring` yang sudah ada jadi merah. Ditambah satu tes
server yang masih menegaskan nama fungsi lama (`ipKey.test.ts`), HEAD saat ini
**tidak hijau**: 1 tes server + 1 tes web gagal.

## A. Diperbaiki / diverifikasi

| ID | Bukti | Verdict |
|---|---|---|
| N9-01 (mekanisme tag) | Relay menghitung `HMAC(secret, alamat)`, gateway membuang klaim header dari amplop dan memasang nilai relay, API memakai `clientRateLimitTag`; probe menunjukkan 120 tag berbeda sampai ke gateway | **Tertutup sebagian** → N10-02/N10-03 |
| N9-02 (fail-closed pin) | `resolveKtConfigPin` membedakan `pin`/`empty`/`unknown-account`/`unreadable`; `resolveConfig` melempar untuk dua yang terakhir (`ktBundleProof.ts:539-544`); `ktConfigPinScope.test.ts` 5/5 | **Tertutup** → regresi urutan N10-01 |
| N9-03 (churn arsip) | `sameState()` + guard `unchanged` (`spqrState.ts:330-348`); tes baru lulus | **Sebagian** → N10-04: hanya state identik |
| N8-01…N8-04, N7-01, N5-01 | Tidak berubah sejak pass 9; tes terkait tetap lulus pada pass ini | Tetap tertutup |
| Sidecar Rust | `cargo test --offline`: 19 tes protokol + 6 tes sertifikat lulus | **Terverifikasi eksekusi** (pertama kali) |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N10-01 | **Baru (Medium)** | `monitorKeyTransparency` memanggil `resolveConfig` sebelum cek state; akun belum terhidrasi → throw, tes merah |
| N10-02 | **Baru (Medium)** | Gateway + relay masih satu bucket 120/menit global → N9-01 belum tertutup di produksi |
| N10-03 | **Baru (Low)** | Relay memercayai `cf-connecting-ip` yang diteruskan nginx tanpa dinormalisasi |
| N10-04 | **Baru (Low)** | N9-03 hanya mendaur state identik; era baru tanpa pesan tetap menggeser arsip |
| N10-05 | **Baru (Low)** | `ipKey.test.ts` menegaskan `clientIpTag`, kode memakai `clientRateLimitTag` → suite server merah |
| F-13 | Tidak diverifikasi | `pnpm audit --prod` butuh jaringan |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip |
| Cakupan | Terbuka | E2E, fuzz, Go KT, drill, DR oracle, suite web penuh, `cargo test` spqr-wasm |

## C. Regresi baru

1. **KT monitor**: N9-02 membuat `resolveConfig` melempar untuk
   `unknown-account`. Karena `monitorKeyTransparency` meresolusi config
   **sebelum** `runKtMonitorOnce` memeriksa daftar state, jalur "tidak ada yang
   dimonitor" tidak lagi mengembalikan `{checked:0}` — ia melempar. Dampak
   produksi: tick monitor 6 jam saat store belum terhidrasi / sesudah logout
   selalu error (ditangkap loop, tetapi tidak pernah mencapai jalur cepat).
   Bukti: `ktMonitoring.test.ts:408` gagal.
2. **Suite server merah**: `server/tests/ipKey.test.ts:77-79` masih mencari
   `secureKeyGenerator = (req) => clientIpTag(req)`; `rateLimiter.ts:24` kini
   memakai `clientRateLimitTag(req)`. Tes ini adalah penjaga "tidak ada IP
   mentah di key limiter", jadi kegagalannya bukan sekadar kosmetik — ia harus
   diperbarui, bukan dihapus.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N10-01 | **Medium** (High) | `monitorKeyTransparency` meresolusi config sebelum cek state → `unknown-account` melempar; tes merah |
| N10-02 | **Medium** (High) | `ohttpLimiter` gateway dan limiter relay sama-sama global 120/menit (loopback); probe 429 di #121 |
| N10-03 | Low (Medium) | Relay membaca `cf-connecting-ip` dari header yang diteruskan nginx; bisa dikarang bila origin terjangkau langsung |
| N10-04 | Low (High) | Daur arsip N9-03 hanya untuk state byte-identik; state awal era baru selalu berbeda |
| N10-05 | Low (High) | Tes `ipKey` menegaskan nama fungsi lama; suite server gagal 1 tes |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **0**, web **0**.
- `pnpm --filter nyx-server run test`: **1 gagal** dari ±940 tes
  (`wiring limiter: keyGenerator memakai clientIpTag, bukan IP mentah`).
- `vitest run` 5 berkas: **45/46**; satu gagal
  (`monitorKeyTransparency > tanpa state siap`).
- `cargo test --offline` sidecar: **25/25**.
- Probe limiter: gateway 429 di #121 untuk dua tag sah; relay 429 di #121 untuk
  140 IP berbeda.
- Probe arsip: dua era tanpa pesan → **2 slot** terpakai; state awal berbeda.
- Tidak dijalankan: E2E, fuzz, Go KT, drill, DR oracle, suite web penuh,
  `cargo test` spqr-wasm (masih kompilasi).

## F. Rekomendasi urutan tindak lanjut

1. **N10-02** — samakan identitas di ketiga lapisan: gateway memakai
   `clientRateLimitTag(req)` (tag sudah tersedia sebelum body dibaca), relay
   memakai `trust proxy` untuk nginx loopback + `proxy_set_header
   CF-Connecting-IP $remote_addr` di kedua blok nginx. Tanpa ini perbaikan
   N9-01 tidak terasa di produksi dan bucket-nya lebih ketat dari sebelumnya.
2. **N10-01** — pindahkan `resolveConfig` **setelah** pemeriksaan "tidak ada
   state" (atau buat `monitorKeyTransparency` mengembalikan `{checked:0}` saat
   `states` kosong), lalu pertahankan fail-closed untuk verifikasi nyata.
3. **N10-05** — perbarui asersi tes ke `clientRateLimitTag`; jangan longgarkan.
4. **N10-04** — putuskan: simpan penanda "era ini pernah maju" (generation)
   alih-alih membandingkan byte, atau rotasi hanya saat state aktif berbeda
   dari yang terakhir ditulis.
5. **N10-03** — relay mengambil alamat dari `req.socket.remoteAddress` dan hanya
   memakai XFF dari proxy tepercaya; nginx menimpa header CF secara eksplisit.
