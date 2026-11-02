# Pass 8 — Laporan delta

Basis: `dd1426be` + **fix pass 7 yang belum di-commit** di working tree.
Pass 1: `AUDIT_REPORT.md`. Pass 2–7: `pass-2/`…`pass-7/`.
Temuan baru: `20-findings.md`. Verifikasi fix: `30-verify-fixes.md`.

## Ringkasan satu paragraf

Fix pass 7 **tidak semuanya bekerja**. Arah desainnya benar — hash kontak
pindah ke body POST + allowlist OHTTP, PK `ktMonitoring` menjadi HMAC
ber-masterSeed, logout membersihkan state KT — tetapi implementasi KDF-nya
memanggil libsodium dengan tanda tangan API C, sehingga **selalu melempar
`TypeError`** dan state KT tidak pernah tersimpan (N8-01, High: kontrol
anti-equivocation mati; verifikasi kontak selalu `unavailable`). Tes hijau
karena fungsi yang rusak di-mock. Dua temuan lain lahir dari jalur yang
tersentuh: semua trafik OHTTP berbagi satu bucket rate-limit loopback
(N8-02), dan logout kini menghapus pin TOFU KT sehingga pin hanya berlaku
satu sesi (N8-03). N7-01 hanya **partial**: server tetap tahu akun → hash.
F-13 akhirnya tertutup (`pnpm audit --prod` bersih).

## A. Diperbaiki / diverifikasi

| ID | Klaim | Bukti | Verdict |
|---|---|---|---|
| N7-03 | Dokumen KT menyatakan modul belum dipakai | `ktMonitoring.ts:26-32`, `docs/34` §34.6 | **Tertutup** |
| N7-04 | State KT + pin dibersihkan saat logout | `store/auth.ts:873-878`; `clearKtConfigPin` menelan error (`ktConfigPin.ts:139-148`) | **Tertutup**, dengan efek samping N8-03 |
| N7-01 | Hash kontak tidak lagi di URL | `ktQuery.ts:110-117`, `ohttp.ts:396-398`, CSRF-exempt hanya tanpa cookie (`app.ts:427-444`), `ohttp.test.ts` 18/18 | **PARTIAL** — log/URL bersih, server tetap melihat akun→hash; OHTTP default mati |
| F-13 | Audit dependensi | `pnpm audit --prod` → *No known vulnerabilities found* | **Tertutup** |
| N6-01/N6-02 | Perbaikan pass 6 | Tidak berubah di working tree; tidak diubah pass ini | Tetap tertutup (tidak diverifikasi ulang) |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N7-02 | **REGRESI → N8-01** | Desain HMAC benar, tetapi KDF melempar; tidak ada baris KT yang bisa ditulis |
| N7-01 | **Terbuka (Medium)** | Server tetap menerima `userId` + hash di body; OHTTP hanya menyembunyikan IP |
| N5-01 | Terbuka | Pesan SPQR v2 lintas-era tanpa arsip braid — keputusan protokol |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip |
| Race single-active-device sidecar | Tidak diverifikasi | Warisan pass 4 |
| Cakupan | Terbuka | WASM KT internal, `metrics.rs` rinci, E2E, fuzz, tes Go KT, drill |

## C. Regresi baru

| ID | Dari fix | Dampak |
|---|---|---|
| N8-01 | N7-02 | `deriveKtSearchIndexKey` selalu `TypeError` → `saveKtState` reject → verifikasi kontak `unavailable`, monitor tidak pernah menyimpan anchor/rotasi |
| N8-03 | N7-04 | Pin TOFU KT dihapus saat logout → login berikutnya re-pin buta; swap kunci antar-sesi tidak terdeteksi |

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N8-01 | **High** (High) | `crypto_kdf_derive_from_key(subkey, …)` salah API → `TypeError`; seluruh penulisan state KT gagal; tes menutupinya dengan mock |
| N8-02 | **Medium** (High mekanisme) | Gateway dispatch lewat loopback dan membuang `cf-connecting-ip`, jadi `generalLimiter` (300/15 mnt) berbagi satu bucket untuk semua pengguna OHTTP; relay 120/mnt per klien mempercepat habisnya |
| N8-03 | Low (High) | Logout menghapus pin TOFU KT; perlindungan turun jadi per-sesi |
| N8-04 | Low (Medium) | Fallback OHTTP memicu request cookie kedua pada 4xx sah (mis. 404 KT_NOT_FOUND) dan saat OHTTP salah konfigurasi, tanpa metrik/banner |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **exit 0**; web **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning.
- `pnpm --filter @nyx/shared run build`: **exit 0**.
- `pnpm --filter nyx-server run test`: **786 tes, 784 lulus, 0 gagal, 2 skip**.
- `npx tsx --test tests/ohttp.test.ts`: **18/18 lulus**.
- `vitest run` 6 berkas KT: **61/61 lulus**; ktMonitoring+ktBundleProofV2+dexieMigration: **35/35 lulus**.
- `cargo test` sidecar: **6/6 lulus**.
- `pnpm audit --prod`: **bersih**.
- Probe libsodium: **THREW** `TypeError: subkey_len must be an unsigned integer`.
- Tidak dijalankan: E2E, fuzz, tes Go KT, drill, DR oracle, `cargo test` spqr-wasm, seluruh suite vitest web.

## F. Rekomendasi urutan tindak lanjut

1. **N8-01** — perbaiki panggilan KDF menjadi bentuk JS (`crypto_kdf_derive_from_key(32, 1, 'nyx-kt01', masterSeed)`), lalu tambahkan tes tanpa mock. Tanpa ini, semua pekerjaan KT lain tidak berarti.
2. **N8-02** — jangan pakai `generalLimiter` berbasis IP untuk jalur OHTTP; key dari identitas token atau header internal bertanda tangan.
3. **N8-03** — scope pin KT per akun, bukan hapus saat logout.
4. **N8-04** — fallback hanya untuk kegagalan transport/5xx + metrik degradasi.
5. **N7-01** — bila tujuan privasi adalah server tidak tahu akun→hash, KT search perlu jalur anonim (OHTTP + token tak terikat akun, atau PIR), bukan hanya POST.
