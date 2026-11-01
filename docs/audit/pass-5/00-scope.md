# Pass 5 — Cakupan, metode, batasan

Tanggal: 2026-11-01. Basis: `537c432b` ("fix(audit): validasi anchor bukti peserta
dan batasi baca stream sidecar") di `main`.

Laporan sebelumnya dibaca lebih dulu (`AUDIT_REPORT.md`, `pass-2/*`, `pass-3/*`,
`pass-4/*`). Pass 5 **tidak** mengulang temuan yang sudah tertutup, dan
memprioritaskan:

1. verifikasi perbaikan pass 4 (N4-01, N4-02, N4-03) dengan membaca kode yang
   berubah, lalu mencari bug baru yang diperkenalkan;
2. area yang pass 1–4 nyatakan **belum dibaca**: jalur braid SPQR di klien
   (`spqrWire.ts`, `spqrNegotiation.ts`, `spqrSession.ts`, `spqrRatchet.ts`,
   `spqrState.ts`, integrasi `crypto.ts` + `crypto.worker.ts`), `packages/spqr-wasm`,
   dan `routes/auth.ts`;
3. fokus khusus pass ini: **ratchet v2 (braid SPQR)** — satu-satunya jalur kripto
   produksi yang belum pernah dibaca, dan satu-satunya tempat di mana format wire
   baru hidup berdampingan dengan format beku v1.

## Metode

- Diff `537c432b` dibaca per berkas; setiap perbaikan dicocokkan dengan **data
  yang dikirim klien** (encoding base64 standar vs base64url, `includeSelf`) dan
  dengan **jalur lain yang menulis tabel/berkas yang sama**.
- Untuk SPQR: jalur dibaca dari wire ke bawah — `spqrWire` (parser header) →
  `spqrNegotiation` (keputusan versi) → `spqrSession` (langkah braid) →
  `spqrRatchet` (ABI WASM) → `crypto.worker` (op) → `crypto.ts` (kirim/terima) →
  `messagePipeline` (inisialisasi sesi). Setiap klaim "fail-closed" dicari
  pemanggilnya, bukan hanya komentarnya.
- Integrasi produksi diperiksa dengan grep pemakaian (`spqrSendStep`,
  `parseSpqrHeader`, `ackV`, `deleteSpqrState`, `peerAckRatchetVersion`), lalu
  badan fungsinya dibaca.
- Lima klaim "Verified-OK" paling berisiko diperiksa ulang secara independen:
  (a) deklarasi versi hanya dari payload ter-seal; (b) header v2 tidak pernah
  dibaca sebagai v1; (c) kill switch menghentikan kirim/iklan tetapi tidak baca;
  (d) transaksionalitas state braid; (e) batas wire frame braid.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint server/src web/src` | **0 error**, 230 warning (`no-unused-vars`) |
| `pnpm --filter nyx-server run test` | **779 tes, 777 lulus, 0 gagal, 2 skip** |
| `vitest run` 6 berkas SPQR (wire, session, ratchet, state, negotiation, messagePath) | **69 tes, 69 lulus** (15,8 s) |

## Yang TIDAK dijalankan (batasan)

- `cargo test` pada `packages/spqr-wasm` dan sidecar; seluruh pernyataan Rust di
  laporan ini dari membaca kode, bukan eksekusi.
- E2E `spqr.spec.ts` (termasuk rollback dua klien nyata) — butuh sidecar +
  Chrome full build.
- `pnpm audit --prod` (F-13, butuh jaringan), tes Go KT, drill, DR oracle, fuzz.
- `routes/auth.ts` penuh, `packages/keytrans-wasm-v2`, `metrics.rs` terperinci.
- Kampanye fuzz framing transport tidak dijalankan ulang.
