# Pass 12 — Cakupan, metode, batasan

Tanggal: 2026-11-03. Basis: `666f37c5` ("fix(audit): tutup temuan pass 11 —
arsip braid aman-default, CIDR IPv6, pesan relay") **plus dua berkas working
tree yang belum di-commit** (`web/src/lib/api.ts`,
`web/src/lib/__tests__/clientVersion.test.ts` — perbaikan jalur 426 pada
`GET /api/csrf-token`). Laporan pass 1–11 dibaca lebih dulu.

Pass 12 memprioritaskan:

1. **verifikasi enam fix pass 11** — N11-01/02 (default `advanced`), N11-03
   (docs/33), N11-04 (pesan relay), N11-05 (CIDR IPv6 + validator), N11-06
   (timeout oracle);
2. **mencari bug baru yang diperkenalkan fix itu**, khususnya pada validator
   `OHTTP_TRUSTED_PROXIES` yang baru — jalur yang tidak dijalankan pass 11
   (probe-nya memakai fungsi lama, bukan yang baru);
3. **area yang pass 1–11 nyatakan belum dieksekusi**, kali ini benar-benar
   dijalankan: seluruh suite web (bukan hanya `src/lib`), `cargo test` sidecar,
   suite Go KT (58 tes), DR oracle `-check`, dan fuzz parser deterministik;
4. menantang ulang lima klaim "Verified-OK" berisiko tertinggi (CSRF tanpa
   cookie, urutan monitor KT, allowlist OHTTP, guard capability admin,
   sumber tunggal cookie sesi).

## Metode

- `git show 666f37c5` dibaca per berkas, lalu kode akhirnya; setiap klaim fix
  dicocokkan dengan **pemanggil produksi**, bukan hanya tes yang ditambahkan
  (mis. `saveSpqrState` → `rotateSpqrStateForNewSession` → arsip;
  `OHTTP_TRUSTED_PROXIES` → `relay.ts` → `relayApp` → `ohttpClientAddress`).
- Validator baru diuji dengan **fungsi aslinya** (`tsx` mengimpor
  `server/src/ohttp/clientTag.ts`), termasuk bentuk yang tes barunya tidak
  cakup: CIDR tanpa prefix (`10.0.0.0/`, `fd00::/`), prefix ganda, dan CIDR
  IPv4-mapped.
- Perbaikan `clientVersion` diuji dengan suite penuh (bukan satu berkas), karena
  cache token CSRF hidup di scope modul dan urutan tes menentukan jalur yang
  dilewati.
- Klaim "Verified-OK" diperiksa di kode akhir, bukan di komentar commit.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint` pada 4 berkas yang berubah | **0 error**, 0 warning |
| `npx tsx --test tests/ohttp.test.ts` | **24/24 lulus** |
| `vitest run` 4 berkas (spqrEraArchive, spqrState, clientVersion, ktMonitoring) | **49/49 lulus** |
| `vitest run` **seluruh suite web** (137 berkas) | **1136/1136 lulus**, exit 0 |
| `cargo test` (`server/transport-sidecar`) | **lulus**, 0 gagal |
| `server/kt-query/build.sh test` (`go vet` + `go test ./...`) | **exit 0**, 4 paket `ok`, 0 `FAIL` |
| `go run . -check` (`tools/dr-oracle`) | **identik dengan regenerasi**, exit 0 |
| `fuzz:parsers` (50 000 iterasi) | **0 temuan**, deterministik |
| Probe `invalidTrustedProxyReason` / `ohttpClientAddress` | `10.0.0.0/` dan `fd00::/` **diterima sebagai /0** → N12-01 |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport (`web/e2e`) — butuh Postgres, Redis, server dev,
  Vite dev, dan sidecar; tidak dijalankan pada pass ini.
- Drill DR Klien (`scripts/client-restore-drill.sh`), drill KT v2
  (`scripts/kt-v2-restore-drill.sh`), drill alert (`scripts/drill-alerts.sh`),
  dan uji beban relay — tidak dijalankan.
- `pnpm audit --prod` (butuh jaringan), `cargo clippy`/`cargo audit`.
- Perubahan nginx dan `deploy/selfhost` dibaca; tidak di-`nginx -t` dan tidak
  diuji lewat trafik nyata.
- `pnpm --filter nyx-web run build` (bundle produksi) tidak dijalankan; yang
  diperiksa adalah `tsc --noEmit` dan vitest.
- Jumlah tes Go dihitung dari paket yang lulus (`go test` tanpa `-v` tidak
  mencetak per-tes); klaim "58 tes" milik `AGENTS.md` tidak diverifikasi
  ulang angkanya, hanya status lulus/gagal.
