# Pass 10 — Cakupan, metode, batasan

Tanggal: 2026-11-02. Basis: `bfca57c7` ("fix(audit): tutup temuan pass 9 — tag
klien relay OHTTP, pin KT fail-closed, arsip braid") + working tree yang tidak
terkait (`docs/10-deployment-ops.md`, `ops/grafana/.../nyx-overview.json`).
Laporan pass 1–9 dibaca lebih dulu.

Pass 10 memprioritaskan:

1. **verifikasi tiga fix pass 9** — N9-01 (tag klien relay), N9-02 (pin KT
   fail-closed), N9-03 (churn arsip braid);
2. **mencari regresi yang diperkenalkan fix itu**, terutama di jalur yang tidak
   dijalankan saat fix dibuat;
3. **area yang pass 1–9 nyatakan belum pernah dieksekusi**: sidecar Rust
   (`cargo test` tidak pernah jalan di seluruh rangkaian audit ini) dan
   **topologi edge OHTTP** (nginx → relay → gateway → API) yang justru
   menentukan apakah tag limiter bekerja di produksi;
4. fokus khusus pass ini: **transport & edge** — WSS gateway (`realtime/gateway`)
   dibaca penuh, dan dua bucket 120/menit di jalur OHTTP diukur dengan
   `express-rate-limit` sungguhan.

## Metode

- `git show bfca57c7` dibaca per berkas; setiap perbaikan dicocokkan dengan
  **pemanggilnya** dan dengan **konfigurasi deploy** (`ops/nginx`, `relay.ts`,
  `scripts/sync-selfhost.sh`), bukan hanya dengan tes yang ditambahkan.
- Klaim limiter diuji dengan **probe yang menjalankan router asli**:
  `createOhttpRouter` dan `createOhttpRelayApp` dengan `express-rate-limit`
  nyata, 140 request, dua tag tepercaya berbeda / 140 `cf-connecting-ip`
  berbeda. Hasil dicetak, bukan disimpulkan dari komentar.
- Klaim arsip braid diuji dengan **`spqr.wasm` hasil build** dan modul
  `spqrState` asli (mock hanya IndexedDB/enkripsi at-rest), untuk dua era tanpa
  pesan dengan `authKey` berbeda.
- `cargo test --offline` dijalankan untuk sidecar (25 tes: 19 protokol + 6
  sertifikat) — eksekusi Rust pertama dalam audit ini.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `pnpm --filter nyx-server run test` | **1 gagal**: `ipKey.test.ts` "wiring limiter" |
| `vitest run` 5 berkas KT/SPQR | **45/46 lulus**; `ktMonitoring.test.ts` gagal (`unknown-account`) |
| `cargo test --offline` sidecar | **25/25 lulus** (19 `protocol.rs` + 6 `main.rs`) |
| Probe limiter gateway (2 tag sah, 140 req) | **429 pertama di #121** |
| Probe limiter relay (140 IP berbeda) | **429 pertama di #121**; gateway melihat 120 tag |
| Probe era braid (2 era tanpa pesan) | state awal **berbeda** (118 B); arsip terisi **2 slot** |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, fuzz framing, 58 tes Go KT, drill DR/restore KT,
  DR oracle, seluruh suite vitest web, `pnpm audit --prod`.
- `cargo test` untuk `packages/spqr-wasm` selesai dengan **0 tes** (target
  kosong); tidak ada unit test Rust untuk wrapper WASM di crate itu.
- Probe limiter memakai Express langsung di loopback; ia membuktikan **perilaku
  keyGenerator**, bukan beban produksi nyata melewati nginx/Cloudflare.
- `cf-connecting-ip` yang dipalsukan diuji sebagai header ke relay; apakah origin
  bisa dijangkau langsung (bypass Cloudflare) bergantung pada firewall VPS yang
  tidak ada di repo.
