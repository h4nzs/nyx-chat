# Pass 2 — Cakupan, metode, batasan

Tanggal: 2026-10-31. Basis: `73a5d656` ("fix(audit): tutup temuan otorisasi realtime,
fail-closed perangkat, dan batas input") di atas `main`.

Laporan pass 1 (`docs/audit/AUDIT_REPORT.md`) dibaca lebih dulu; pass 2 **tidak**
mengulang temuan yang sudah ada kecuali masih terbuka, dan memprioritaskan:

1. verifikasi tiap klaim perbaikan dengan membaca kode yang berubah;
2. mencari bug baru yang **diperkenalkan** oleh perbaikan itu;
3. area yang di pass 1 tidak dibaca (`routes/users.ts` penuh, `routes/stories.ts`,
   `routes/sessions.ts`, `routes/backup.ts`, `routes/previews.ts`, `routes/callTokens.ts`);
4. fokus khusus pass ini: **otorisasi di setiap endpoint** (dipilih karena slot
   fokus di prompt re-run kosong).

## Metode

- Diff commit perbaikan dibaca per berkas, lalu **setiap gate** dicocokkan dengan
  **payload yang benar-benar dikirim klien** (bukan dengan komentar/tests).
  Ini yang menemukan dua regresi: gate server benar, kontrak klien tidak.
- Setiap temuan diberi tingkat keyakinan dan bukti `berkas:baris`.
- Klaim "Verified-OK" pass 1 diperiksa ulang minimal lima yang paling berisiko:
  otorisasi view-once, gate grup realtime, single-active-device, blind delete,
  dan derivasi peer.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | exit 0 |
| `npx oxlint server/src web/src` | 0 error, 236 warning (`no-unused-vars`) |
| `pnpm --filter nyx-server run test` | **739 tes, 737 lulus, 0 gagal, 2 skip** (97 s) |

## Yang TIDAK dijalankan (batasan yang sama dengan pass 1, ditambah)

- Web vitest (tidak ada berkas `web/src` yang berubah sejak pass 1 yang lulus
  134/134 berkas), E2E Playwright, WebTransport E2E.
- `cargo test/clippy/audit`, 58 tes Go KT, drill backup/alert/load, fuzz parser,
  DR oracle — butuh Postgres/Redis/sidecar/coturn/toolchain.
- `pnpm audit --prod`: butuh jaringan. `pnpm-lock.yaml` berubah di commit
  perbaikan, jadi status 3 advisory pass 1 **belum diverifikasi ulang**.
- `routes/auth.ts` (1875 baris) tetap hanya di-grep untuk pola token; alur
  register/login/recovery/PoW tidak dibaca penuh.
- WASM verifier KT, crate SPQR, dan sidecar Rust tidak diaudit.
