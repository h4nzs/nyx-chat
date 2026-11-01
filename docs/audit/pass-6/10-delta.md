# Pass 6 — Laporan delta

Basis: `537c432b` + **working tree** (fix pass 5 belum di-commit).
Pass 1: `AUDIT_REPORT.md`. Pass 2–5: `pass-2/`…`pass-5/`.
Temuan baru: `20-findings.md`. Verifikasi fokus auth: `30-auth.md`.

## Ringkasan satu paragraf

Tiga temuan pass 5 diperbaiki di working tree dan saya verifikasi di kode:
paragraf usang di `spqrRatchet.ts` diganti status sebenarnya, suite SPQR kini
**gagal** (bukan skip senyap) bila `dist/spqr.wasm` tidak ada, dan komentar
batas uni sidecar dikoreksi menjadi perilaku yang benar. N5-01 (pesan v2
lintas-era tanpa arsip) tetap **terbuka** — itu keputusan protokol, bukan patch.
Fokus baru — `routes/auth.ts` yang enam pass hanya di-grep — **tidak menemukan
celah Critical/High**: rotasi refresh, recovery ML-DSA dengan nonce sekali pakai,
linking QR, WebAuthn UV-wajib, dan PoW semuanya ter-gate benar. Yang ditemukan
dua cacat Low: `/logout` mencabut token tetapi **tidak** memutus socket
(berbeda dari `/logout-all` dan `DELETE /sessions/:jti` yang sudah mengirim
`KICK`), dan id guest Burner hanya **32 bit** sehingga dua guest dapat berbagi
kanal relay pada skala puluhan ribu sesi.

## A. Diperbaiki dan terverifikasi (working tree, belum di-commit)

| ID | Klaim perbaikan | Bukti | Verdict |
|---|---|---|---|
| N5-02 | Dokumen `spqrRatchet.ts` menyatakan modul dipakai produksi + gerbang tiga lapis | `git diff web/src/lib/spqrRatchet.ts` (paragraf diganti, merujuk `docs/33` §33.10 dan `spqrNegotiation`) | **Tertutup.** Tidak ada lagi klaim "belum dipakai". |
| N5-03 | Artefak WASM hilang → tes gagal, bukan skip senyap | diff `spqrSession.test.ts`, `spqrRatchet.test.ts`, `spqrMessagePath.test.ts`: `if (!HAS_WASM) { describe(... expect(HAS_WASM).toBe(true)) }` | **Tertutup.** Pada mesin ini `HAS_WASM` true sehingga suite tetap 69/69; bila artefak hilang, satu tes baru gagal keras. |
| N5-04 | Komentar batas uni dikoreksi: parser hanya membaca frame pertama, byte sisa diabaikan | `git diff server/transport-sidecar/src/main.rs:803-812` | **Tertutup sebagai dokumentasi.** Komentar tidak lagi menjanjikan penolakan yang tidak ada. |
| N5-01 | Pesan v2 lintas-era | tidak ada perubahan | **Masih terbuka** (Low) — lihat §B. |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N5-01 | **Terbuka** | Braid state tetap satu baris per percakapan dan dihapus pada sesi baru; jalur v2 tidak memakai arsip era seperti v1. Butuh keputusan protokol (state per `sessionId` vs dokumentasi bahwa rotasi memutus pesan v2 tertunda). |
| F-13 | **Tidak diverifikasi** sejak pass 1 | `pnpm audit --prod` butuh jaringan. |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip. |
| Race single-active-device sidecar | **Tidak diverifikasi** | Diwarisi dari pass 4. |
| Cakupan | Terbuka | WASM KT, `metrics.rs` rinci, eksekusi Rust/fuzz/E2E. |

## C. Regresi baru

Tidak ada. Perubahan working tree hanya dokumen + tes + komentar; tidak
menyentuh logika runtime. `tsc` server/web, oxlint, dan kedua suite lulus.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N6-01 | Low (High confidence) | `POST /api/auth/logout` mencabut refresh family tetapi tidak mengirim `force_logout`/`KICK`, tidak seperti `/logout-all` (`auth.ts:1406-1408`) dan `DELETE /sessions/:jti` (`sessions.ts:104-108`). Relay tidak memeriksa blacklist per frame, jadi socket yang sudah terbuka tetap menerima pesan setelah logout. |
| N6-02 | Low (High confidence pada mekanisme) | Id guest Burner = `randomUUID().substring(0, 8)` → **32 bit**, tanpa uniqueness check (guest tidak dipersist). Dua guest berbagi kanal relay pada skala puluhan ribu sesi; isi tetap E2EE, metadata tidak. |
| N6-03 | Info | `isVerified` dinaikkan oleh PoW tanpa memandang tier attestation, padahal jalur register/WebAuthn memakai kolom yang sama untuk arti "bukti perangkat". Jangan dipakai sebagai bukti perangkat. |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server: **exit 0**.
- `npx tsc --noEmit` web (termasuk working-tree SPQR): **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning (`no-unused-vars`).
- `pnpm --filter nyx-server run test`: **779 tes, 777 lulus, 0 gagal, 2 skip**.
- `vitest run` 6 berkas SPQR: **69 tes, 69 lulus** (6/6 berkas).
- Tidak dijalankan: `cargo test` (spqr-wasm/sidecar — penting karena working
  tree mengubah `main.rs`), E2E, `pnpm audit --prod`, tes Go KT, drill, fuzz.

## F. Rekomendasi urutan tindak lanjut

1. **N6-01** — tiga baris di `/logout`: kirim `force_logout` + `KICK` dengan
   `deviceId` dari token refresh, sama seperti `DELETE /sessions/:jti`.
2. **N6-02** — pakai id guest penuh (UUID 36 char atau 16 byte base64url);
   tidak ada biaya tambahan, dan `burnerLimiter` tetap membatasi pembuatan.
3. **N5-01** — putuskan arsip braid per `sessionId` atau dokumentasikan bahwa
   rotasi sesi memutus pesan v2 yang belum terkirim.
4. Jalankan `cargo test` untuk sidecar setelah perubahan `main.rs`, lalu F-13
   (`pnpm audit --prod`) sebelum rilis.
