# Pass 9 — Laporan delta

Basis: `09bc7d04` + satu perubahan tes yang belum di-commit.
Pass 1: `AUDIT_REPORT.md`. Pass 2–8: `pass-2/`…`pass-8/`.
Temuan baru: `20-findings.md`. Verifikasi fix: `30-verify-fixes.md`.

## Ringkasan satu paragraf

Kedua commit fix bekerja. N8-01 **benar-benar hilang**: panggilan KDF sudah
berbentuk JS, dan probe dengan libsodium asli mengembalikan 32 byte
deterministik yang berbeda per seed — bukan lagi `TypeError`. Arsip era braid
v2 (N5-01) bahkan lebih kuat daripada dugaan saya: 40 pesan tertunda, termasuk
urutan terbalik, terbuka dari state arsip yang tidak dimajukan. Route KT anonim
(N7-01) menutup keterkaitan akun→hash tanpa menambah oracle enumerasi baru.
Dua hal tersisa: perbaikan N8-02 tidak menjangkau jalur yang justru paling
sering dipakai — bukti KT anonim lewat OHTTP tanpa token berbagi **satu** bucket
240/menit untuk semua pengguna (N9-01, Medium), dan pin per akun memperlakukan
"akun tidak diketahui" sama dengan "belum di-pin" (N9-02, Low). Churn rotasi
arsip (N9-03, Low) adalah sisa sempit dari N5-01.

## A. Diperbaiki / diverifikasi

| ID | Bukti | Verdict |
|---|---|---|
| N8-01 | Probe KDF: 32 byte, deterministik, beda per seed; `ktSearchIndexKey.test.ts` 5/5 | **Tertutup** |
| N8-02 | `clientRateLimitTag` + `rateLimitIdentity.test.ts` 36/36 untuk trafik bertoken | **Tertutup sebagian** → N9-01 |
| N8-03 | `ktConfigPinRowId`, logout tanpa hapus pin, `ktConfigPinScope.test.ts` 5/5 | **Tertutup** → N9-02 |
| N8-04 | 4xx fail-closed, fallback hanya transport/5xx (`ktBundleProof.ts:400-427`) | **Tertutup** |
| N5-01 | `spqrState.ts:304-330`; probe WASM 40 pesan + urutan terbalik | **Tertutup** → N9-03 |
| N7-01 | `ktQuery.ts:120` anonim; `credentials:'omit'`; `withToken:false`; allowlist 4 KB | **Tertutup** |
| N7-02 | Ditutup oleh N8-01 | **Tertutup** |
| F-13 | `pnpm audit --prod` bersih (pass 8, tidak berubah) | Tetap tertutup |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N9-01 | **Baru (Medium)** | Jalur KT anonim lewat OHTTP berbagi bucket 240/menit; dua klien cukup menghabiskannya |
| N9-02 | **Baru (Low)** | `user` kosong = "belum di-pin" → satu sesi verifikasi tanpa jangkar |
| N9-03 | **Baru (Low)** | Rotasi berulang menggeser arsip dan membuang era yang benar-benar lama |
| N8-02 sisa | Terbuka (terdokumentasi) | Hanya untuk trafik tanpa token; lihat N9-01 |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip |
| Race single-active-device sidecar | Tidak diverifikasi | Warisan pass 4 |
| Cakupan | Terbuka | E2E, fuzz, tes Go KT, drill, DR oracle, `cargo test` |

## C. Regresi baru

Tidak ada regresi fungsional pada jalur yang diuji. Dua efek samping desain
dicatat sebagai N9-01 dan N9-02; keduanya berasal dari fix, bukan dari kode lama.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N9-01 | **Medium** (High) | `POST /api/keys/kt/search` anonim + `withToken:false` → tag `127.0.0.1`; `ktProofLimiter` 240/menit dipakai bersama semua pengguna OHTTP; relay 120/menit per klien → dua klien menghabiskan bucket, KT `unavailable` untuk semua |
| N9-02 | Low (Medium) | `loadKtConfigPin` mengembalikan `undefined` saat `user` kosong, dan `saveKtConfigPin` no-op pada kondisi sama → `resolveConfig` menerima config sebagai TOFU; pin lama tidak tertimpa sehingga sesi berikutnya mendeteksi |
| N9-03 | Low (Medium) | `rotateSpqrStateForNewSession` menggeser FIFO setiap dipanggil, termasuk rotasi tanpa lalu lintas v2 → era lama nyata bisa terbuang sebelum tiga slot terpakai |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **exit 0**; web **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 229 warning.
- `tsx --test` ktQuery + ohttp + rateLimitIdentity: **36/36**.
- `vitest run` 5 berkas (ktSearchIndexKey, ktConfigPinScope, spqrEraArchive,
  spqrState, ktMonitoring): **39/39**.
- `vitest run` 10 berkas KT/Dexie/spqrMessagePath: **100/100**.
- Probe KDF: bentuk benar OK; seed 64/16/31 byte **THREW** `invalid key length`.
- Probe arsip era (WASM asli): 40 pesan + urutan terbalik **semua cocok**.
- Tidak dijalankan: E2E, fuzz, 58 tes Go KT, drill, DR oracle, `cargo test`,
  seluruh suite vitest web.

## F. Rekomendasi urutan tindak lanjut

1. **N9-01** — beri jalur KT anonim identitas per klien yang tidak bisa dipalsukan:
   relay menandatangani tag klien, atau bucket OHTTP agregat terpisah + alert.
   Tanpa ini, perbaikan anti-equivocation bisa dimatikan tanpa akun.
2. **N9-02** — bedakan `no-account` dari `no-pin`; saat akun tidak diketahui,
   kembalikan `unavailable` alih-alih TOFU.
3. **N9-03** — lewati rotasi bila state aktif belum maju; rotasi hanya di titik
   X3DH sukses.
4. Tambahkan metrik `kt_ohttp_degraded_total{reason}` agar degradasi privasi
   terlihat di dashboard, bukan hanya `console.warn`.
