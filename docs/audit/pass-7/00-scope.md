# Pass 7 — Cakupan, metode, batasan

Tanggal: 2026-11-01. Basis: `dd1426be` ("fix(audit): putus socket pada logout
perangkat dan lebarkan id guest Burner") di `main`, working tree bersih.

Laporan sebelumnya dibaca lebih dulu (`AUDIT_REPORT.md`, `pass-2`…`pass-6`).
Pass 7 memprioritaskan:

1. verifikasi fix pass 6 (`dd1426be`) dan fix pass 5 (`b774116c`) dengan membaca
   kode yang berubah;
2. area yang enam pass sebelumnya nyatakan **belum dibaca**: verifikasi Key
   Transparency **di klien** (`ktMonitoring`, `ktGossip`, `ktConfigPin`,
   `ktSubject`, `ktBundleProof`, `keyTransparencyV2`) — modul yang menentukan
   apakah log KT benar-benar diverifikasi atau hanya dipercaya;
3. fokus khusus pass ini: **state KT & anonimitas kueri** (apa yang disimpan
   klien, apa yang dikirim ke layanan KT, dan apakah kegagalan verifikasi bisa
   menulis state).

## Metode

- Berkas KT dibaca dari luar ke dalam: penyimpanan (`db.ts` → `ktMonitoring`,
  `ktGossip`, `ktConfigPin`) → jalur verifikasi (`checkBundleAgainstKeyTransparency`)
  → penjadwal (`startKtMonitorLoop` di `App.tsx`) → jalur pesan
  (`extractTreeHeadField`/`recordPeerTreeHead`).
- Setiap klaim "ter-seal" dicocokkan dengan **apa yang benar-benar ada di
  IndexedDB**: nilai vs kunci indeks. Ini yang menemukan N7-01.
- Setiap klaim "fail-closed" dicari tesnya (`ktMonitoring.test.ts` memastikan
  baris tidak berubah saat verifikasi ditolak) dan dipastikan pemanggilnya
  (`App.tsx` benar-benar menjalankan loop — N7-02).

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint server/src web/src` | **0 error**, 230 warning |
| `pnpm --filter nyx-server run test` | **785 tes, 783 lulus, 0 gagal, 2 skip** |
| `vitest run` 6 berkas KT | **60 tes, 60 lulus** (6/6 berkas) |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, `cargo test` (spqr-wasm & sidecar), `pnpm audit
  --prod` (F-13), tes Go KT (58), drill, fuzz, DR oracle.
- `packages/keytrans-wasm-v2` (implementasi verifier di Rust) tidak dibaca;
  laporan ini memeriksa **pemakaian** verifier dari TypeScript, bukan kebenaran
  internal WASM.
- Anonimitas kueri KT hanya dinilai dari kode klien (apakah lewat OHTTP/PIR);
  perilaku jaringan nyata tidak diuji.
