# Pass 8 — Cakupan, metode, batasan

Tanggal: 2026-11-02. Basis: `dd1426be` **plus perubahan working tree yang belum
di-commit** (fix untuk N7-01…N7-04 dari pass 7). Laporan pass 1–7 dibaca lebih
dulu (`AUDIT_REPORT.md`, `pass-2/`…`pass-7/`).

Pass 8 memprioritaskan:

1. **verifikasi fix pass 7 di working tree** — bukan hanya membaca diff, tetapi
   menjalankan panggilan API pihak ketiga yang dipakai fix tersebut;
2. **cek yang tujuh pass belum pernah dijalankan**: `cargo test` sidecar dan
   `pnpm audit --prod` (F-13);
3. **fokus khusus: state klien** — apa yang benar-benar tersimpan, apa yang
   benar-benar dipanggil, dan apakah fix pass 7 bekerja saat runtime.

## Metode

- `git diff` dibaca lebih dulu; setiap fix dipetakan ke jalurnya
  (`defaultFetchProof` → rute → gateway → limiter; `saveKtState` →
  `ktSearchKeyRowId` → libsodium; logout → `clearKtStates`/`clearKtConfigPin`).
- Untuk panggilan library, **bukan pembacaan tipe**: `crypto_kdf_derive_from_key`
  dieksekusi dengan paket dan versi yang sama (`libsodium-wrappers@^0.8.4`,
  `web/package.json:52`) — di situlah N8-01 muncul.
- Klaim "sudah diuji" ditantang dengan membaca mock tesnya
  (`ktMonitoring.test.ts:55` mem-mock `deriveKtSearchIndexKey`), bukan hanya
  melihat hasil hijau.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint server/src web/src` | **0 error**, 230 warning |
| `pnpm --filter @nyx/shared run build` | **exit 0** |
| `pnpm --filter nyx-server run test` | **786 tes, 784 lulus, 0 gagal, 2 skip** |
| `npx tsx --test tests/ohttp.test.ts` | **18/18 lulus** |
| `vitest run` 6 berkas KT | **61/61 lulus** |
| `vitest run` ktMonitoring + ktBundleProofV2 + dexieMigration | **35/35 lulus** |
| `cargo test` sidecar | **6/6 lulus** |
| `pnpm audit --prod` | **No known vulnerabilities found** (F-13 tertutup) |
| Probe libsodium `crypto_kdf_derive_from_key` | **THREW** `TypeError: subkey_len must be an unsigned integer` |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, fuzz, 58 tes Go KT, drill DR/restore, DR oracle,
  `cargo test` untuk `packages/spqr-wasm` (hanya sidecar).
- Seluruh suite vitest web tidak dijalankan; hanya 9 berkas yang menyentuh KT
  dan migrasi Dexie.
- Dampak N8-02 diukur dari kode (loopback dispatcher + `clientIpTag`), bukan
  dari uji beban nyata dengan OHTTP aktif.
- Perilaku OHTTP end-to-end tidak dijalankan di browser; yang diuji adalah
  unit/integration test server dan pembacaan jalur klien.
