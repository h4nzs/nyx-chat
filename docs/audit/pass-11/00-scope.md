# Pass 11 — Cakupan, metode, batasan

Tanggal: 2026-11-02. Basis: `0c337be9` ("fix(audit): tutup temuan pass 10 —
limiter OHTTP per klien, trust header relay, penanda era braid"). Working tree
bersih (`git status --porcelain` kosong). Laporan pass 1–10 dibaca lebih dulu.

Pass 11 memprioritaskan:

1. **verifikasi lima fix pass 10** — N10-01 (urutan monitor KT), N10-02 (dua
   limiter OHTTP), N10-03 (`CF-Connecting-IP` relay), N10-04 (penanda
   `advanced` arsip braid), N10-05 (tes wiring limiter);
2. **regresi yang diperkenalkan fix itu**, terutama di jalur yang tidak
   dijalankan saat fix dibuat — suite web penuh (selalu dinyatakan "tidak
   dijalankan" di pass 4–10) dijalankan pass ini, dan justru di situ regresinya
   muncul;
3. **area yang pass 1–10 nyatakan belum dieksekusi**: seluruh
   `web/src/lib/__tests__` (109 berkas, 947 tes) dan `deploy/selfhost`
   (README, `verify-boot.sh`, `install-user.sh`) yang ikut diubah commit ini;
4. fokus khusus: **kripto & state klien** (`spqrState` / jalur ratchet v2) dan
   **topologi edge OHTTP** (nginx `real_ip` → relay → gateway → API).

## Metode

- `git show 0c337be9` dibaca per berkas; setiap klaim dicocokkan dengan
  **pemanggil produksinya**, bukan hanya dengan tes yang ditambahkan. Untuk
  N10-04 itu berarti: `grep -rn "saveSpqrState(" web/src` → hanya **dua**
  pemanggil (`utils/crypto.ts:470`, `:574`), keduanya `advanced: true`.
- Regresi N10-01 dicari dengan membaca badan `monitorKeyTransparency` setelah
  early return (apakah `refreshKtAnchor` ikut hilang) dan mencari pemanggil
  `refreshKtAnchor` lainnya.
- N10-03 diuji dengan **fungsi asli** (`tsx` mengimpor
  `server/src/ohttp/clientTag.ts`), termasuk bentuk yang tidak dicakup tes baru
  (CIDR IPv6).
- Kegagalan `clientVersion.test.ts` **di-bisect** dengan `git worktree` pada
  `bfca57c7` (node_modules/dist di-symlink; worktree dihapus setelahnya) untuk
  membedakan regresi commit ini dari kegagalan yang sudah ada.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `pnpm --filter nyx-server run test` | **exit 0** (termasuk 20 tes `ohttp.test.ts` + 3 tes limiter baru) |
| `vitest run` 5 berkas KT/SPQR (seperti pass 10) | **40/42**; `spqrEraArchive.test.ts` **2 gagal** |
| `vitest run src/lib/__tests__` (109 berkas) | **943/947 lulus, 4 gagal** (2 arsip era, 1 `clientVersion` pre-existing, 1 interop oracle timeout) |
| `vitest run src/lib/__tests__/clientVersion.test.ts` di `bfca57c7` | **gagal juga** → pre-existing |
| `vitest run src/lib/__tests__/x3dhOracleInterop.test.ts` (cache Go hangat) | **lulus**, 11 detik |
| Probe `ohttpClientAddress` (fungsi asli) | IPv4 CIDR **cocok**; IPv6 CIDR `fe80::/10` **DIABAIKAN**; `::1` persis cocok; peer tak tepercaya → alamat soket |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, fuzz framing, 58 tes Go KT, drill DR/restore KT,
  DR oracle `-check`, `cargo test` (tidak ada perubahan Rust), `pnpm audit --prod`.
- `vitest run` penuh di luar `src/lib/__tests__` (komponen/store) tidak
  dijalankan; suite web penuh butuh waktu lebih lama daripada anggaran pass ini
  (109 berkas `src/lib` saja 530 detik).
- Perubahan `ops/nginx/nyx.conf` dibaca, tidak di-`nginx -t` dan tidak diuji
  lewat nginx sungguhan; klaim "header ditimpa" berasal dari direktif config,
  bukan dari trafik nyata.
- Apakah `OHTTP_INTERNAL_TOKEN` benar-benar sama antara proses API dan relay di
  VPS tidak bisa diperiksa dari repo (rahasia hanya ada di sana); yang
  diverifikasi adalah jalur kodenya (`app.ts:413`, `relay.ts:76`).
