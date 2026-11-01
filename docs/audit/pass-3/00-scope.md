# Pass 3 — Cakupan, metode, batasan

Tanggal: 2026-11-01. Basis: `3a658719` ("fix(audit): tutup residual pass 2 — bukti
peserta per percakapan, daftar penerima view-once, CSRF fail-closed") di `main`.

Laporan sebelumnya dibaca lebih dulu (`AUDIT_REPORT.md`, `pass-2/*`). Pass 3
**tidak** mengulang temuan yang sudah tertutup, dan memprioritaskan:

1. verifikasi tiap perbaikan pass 2 dengan membaca kode yang berubah, lalu
   mencocokkannya dengan **data yang benar-benar ditulis klien** (bukan komentar
   atau tes);
2. mencari bug baru yang diperkenalkan perbaikan itu;
3. area yang pass 1 dan 2 nyatakan **belum dibaca**;
4. fokus khusus pass ini: **crypto worker & handshake** (slot fokus di prompt
   re-run kosong; dipilih karena dua pass sebelumnya hanya menyentuh permukaan
   kripto lewat jalur server).

## Metode

- Diff `3a658719` dibaca per berkas, lalu setiap **trust anchor baru** ditelusuri
  sampai ke jalur yang menulisnya. Ini yang menemukan N3-01: gate pass 2 memakai
  `SessionKey` sebagai bukti keanggotaan, dan `SessionKey` dapat ditulis klien
  untuk `conversationId`/`deviceId` sembarang.
- Jalur kripto dibaca dari dalam ke luar: transkrip handshake → verifikasi tanda
  tangan → decapsulation → derivasi → penyimpanan state. Setiap primitif dicari
  situs pemanggilnya, bukan hanya definisinya.
- Lima klaim "Verified-OK" yang paling berisiko diperiksa ulang secara
  independen: (a) autentikasi transkrip handshake v2, (b) tidak ada fallback v1,
  (c) penanganan nonce, (d) zeroization material kunci, (e) pengikatan
  `signingKeyV2` payload ke bundle peer.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | exit 0 |
| `npx oxlint server/src web/src` | **0 error**, 230 warning (`no-unused-vars`) |
| `pnpm --filter nyx-server run test` | **764 tes, 762 lulus, 0 gagal, 2 skip** (79 s) |
| `vitest run` (pqHandshake, x3dhOracleVectors, x3dhOracleInterop) | lihat `10-delta.md` §E |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright dan WebTransport E2E (butuh Postgres/Redis/sidecar/coturn).
- `cargo test/clippy/audit`, 58 tes Go KT, drill backup/alert/load/fuzz, DR
  oracle (`go run . -check`) — butuh toolchain/jaringan.
- `pnpm audit --prod`: butuh jaringan. Pass 2 mencatat "No known vulnerabilities";
  status itu **belum** saya verifikasi ulang sendiri.
- `routes/auth.ts` (1875 baris): register/login/recovery/PoW tetap tidak dibaca
  penuh; hanya pola token yang di-grep.
- Kimia kripto yang tidak dibaca badan fungsinya: `packages/spqr-wasm` (Rust),
  verifikasi KT di WASM (`packages/keytrans-wasm-v2`), dan aritmetika ML-DSA /
  X-Wing di `packages/shared` (dipakai sebagai primitif, bukan diaudit ulang).
- `web/src/components/*` selain `Lightbox.tsx`: pass 1 sudah menyapu seluruh
  `web/src` untuk sink XSS; pass 3 tidak mengulang.
