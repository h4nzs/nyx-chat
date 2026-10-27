# J — Kualitas test & CI

Diperiksa: `server/package.json` (`test` script), `ls server/tests/*.test.ts`
(83 berkas), `.github/workflows/ci.yml`, log eksekusi di `/tmp`
(`nyx-audit-server-final.log`, `nyx-web-vitest3.log`, `nyx-audit-js.log`).

## Hasil yang saya jalankan ulang (HEAD `25b1699`)

- **Server**: `pnpm --filter nyx-server run test` → **659 test, 657 pass,
  2 skip, 0 fail**, exit 0.
- **Web**: vitest → **125 berkas, 1007 test lulus**.
- **Registrasi test**: **83/83** berkas `server/tests/*.test.ts` ada di skrip
  `test` — tidak ada test yang tidak pernah jalan.
- **Go/Rust/oracle** (dari `05-baseline.md`): `kt-query build.sh test` lulus
  (31 test), `cargo test` sidecar & pir-sidecar lulus, DR oracle `-check`
  lulus; `cargo clippy` sidecar **merah** (F-12).
- Catatan reproduksibilitas: log lama `/tmp/server-tests4.log` (subset, sebelum
  HEAD) memuat 2 kegagalan (`gatewayParity`, `redisIdentity`); keduanya
  **lulus** saat dijalankan ulang pada HEAD — kegagalan itu bukan kondisi
  sekarang.

## Kualitas test

- Test yang baik: `groupAccess` mengunci status code + urutan gate;
  `schemaPrivacy`/`dumpAudit` mengunci kolom yang tidak boleh terang;
  `deviceLinking` menguji state machine; `ohttp` menguji allowlist + header.
- **Kelemahan**: `gatewayParity.test.ts` dan `redisIdentity.test.ts` memakai
  regex terhadap **teks sumber** (bukan perilaku). Refactor yang setara bisa
  memerahkan test; sebaliknya, perubahan perilaku kecil bisa lolos bila teks
  yang dicari masih ada. Ini brittleness, bukan bug.
- **Yang tidak tertangkap**: tidak ada test untuk token Privacy Pass yang
  di-redeem dua kali (F-01), tidak ada test `resolutions` vs lockfile (F-08),
  tidak ada test env-template (F-13).

## CI

Tiga job merah di HEAD: `audit` (F-03), `lint`/guard PQ (F-05 dijalankan di
`ci.yml`), dan clippy tidak ada di CI sama sekali (F-12). `e2e` hanya berjalan
bila service Postgres/Redis tersedia; spec transport auto-skip tanpa
WebTransport dan **tidak** menyembunyikan kegagalan (skip ditulis beralasan).

## Batas

E2E Playwright tidak dijalankan; fuzz 1 jam tidak dijalankan; `drill-alerts.sh`
tidak dijalankan.
