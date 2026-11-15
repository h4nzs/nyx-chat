# Pass 4 — Cakupan, metode, batasan

Tanggal: 2026-11-01. Basis: `7395c91e` ("fix(audit): tutup temuan pass-3 dan
hidupkan ratchet dengan bukti peserta") di `main`.

Laporan sebelumnya dibaca lebih dulu (`AUDIT_REPORT.md`, `pass-2/*`, `pass-3/*`).
Pass 4 **tidak** mengulang temuan yang sudah tertutup, dan memprioritaskan:

1. verifikasi tiap klaim perbaikan pass 3 dengan membaca kode yang berubah;
2. mencari bug baru yang diperkenalkan perbaikan itu — khususnya pada **trust
   anchor baru** (`SessionKey.issuedByServer`) dan jalur yang menulisnya;
3. area yang pass 1–3 nyatakan **belum dibaca**: sidecar Rust
   (`server/transport-sidecar`), `packages/spqr-wasm`, WASM KT, dan
   `routes/auth.ts` penuh;
4. fokus khusus pass ini: **transport & sidecar Rust** (satu-satunya lapisan
   yang tiga pass sebelumnya tidak pernah dibaca, dan satu-satunya proses NYX
   yang menerima koneksi langsung dari internet tanpa Express di depannya).

## Metode

- Diff `7395c91e` dibaca per berkas. Setiap perbaikan dicocokkan dengan **data
  yang benar-benar ditulis klien** dan dengan **jalur lain yang menulis tabel
  yang sama** — bukan dengan komentar atau tes. Ini yang menemukan N4-01: endpoint
  yang dijaga (ratchet) kini ketat, tetapi endpoint yang menulis anchor yang
  sama (pembuatan percakapan) tidak divalidasi sama sekali.
- Untuk sidecar: `protocol.rs` dibaca penuh (502 baris, termasuk seluruh tes),
  lalu `main.rs` pada jalur auth (tiket + BWH), bidi, uni, datagram, dan
  konfigurasi QUIC. Keputusan framing dicocokkan dengan klien
  (`web/src/workers/transport.worker.ts`).
- Lima klaim "Verified-OK" paling berisiko diperiksa ulang secara independen:
  (a) JWT sidecar (algoritma, `exp`, tanpa secret cadangan), (b) batas 32 KB
  sebelum alokasi, (c) urutan gate guard ratchet, (d) penghitungan view-once
  "semua sudah membuka", (e) konsumsi OTPK di kedua jalur.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx oxlint server/src web/src` | **0 error**, 230 warning (`no-unused-vars`) |
| `pnpm --filter nyx-server run test` | **775 tes, 773 lulus, 0 gagal, 2 skip** (70,7 s) |
| `vitest run` (pqHandshake, x3dhOracleVectors, x3dhOracleInterop) | **3 berkas, 17 tes, 17 lulus** (10,4 s) |

## Yang TIDAK dijalankan (batasan)

- **`cargo test` / `cargo clippy` / `cargo audit`**: tidak dijalankan. Seluruh
  temuan sidecar di `30-sidecar.md` berasal dari **membaca kode**, bukan dari
  eksekusi atau reproduksi.
- E2E Playwright dan WebTransport E2E (butuh Postgres/Redis/sidecar/coturn),
  58 tes Go KT, drill backup/alert/load/fuzz, DR oracle.
- `pnpm audit --prod`: butuh jaringan. Status F-13 tetap **tidak diverifikasi**
  sejak pass 1.
- `routes/auth.ts` (1875 baris): register/login/recovery/PoW tetap tidak dibaca
  penuh; hanya jalur token yang di-grep.
- `packages/spqr-wasm` (Rust), `spqrRatchet.ts`, dan WASM KT
  (`packages/keytrans-wasm-v2`) tidak dibaca — tetap menjadi utang cakupan.
- Primitif ML-DSA / X-Wing di `packages/shared` dipakai sebagai primitif, tidak
  diaudit ulang.
