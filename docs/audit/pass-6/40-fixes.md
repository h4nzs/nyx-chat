# Pass 6 — Perbaikan

Basis: `537c432b` + working tree. Temuan: `20-findings.md`. Delta: `10-delta.md`.

Pass ini hanya menemukan dua cacat Low (`N6-01`, `N6-02`) dan satu Info
(`N6-03`). Tidak ada temuan Critical/High, jadi ruang lingkup perbaikan kecil
dan semuanya sudah diimplementasi + diuji di tree ini.

## N6-01 (Low) — `/logout` mencabut token tanpa memutus socket

**Perbaikan.** `POST /api/auth/logout` kini mengirim `force_logout` + `KICK`
seperti `DELETE /api/sessions/:jti`, tetapi **device-scoped**:

- `server/src/utils/logoutKick.ts` (baru) — `planDeviceLogoutKick()` murni.
  Mengembalikan `null` bila `userId`/`deviceId` tidak diketahui. Ini disengaja:
  `force_logout`/`KICK` tanpa `deviceId` berarti "logout semua perangkat",
  padahal `/logout` hanya untuk satu sesi. Tanpa planner, `deviceId` yang
  `undefined` akan berubah diam-diam menjadi logout global.
- `server/src/routes/auth.ts` — `deviceId` diambil dari baris refresh token
  yang diverifikasi (`stored.deviceId`), lalu dipakai sebagai argumen device ke
  `emitEventToUser` **dan** `sendJsonToUser(..., KICK, ..., false, deviceId)`.
  Bila token tidak ada di DB (fallback revoke single JTI), `deviceId` tetap
  `null` → tidak ada kick sama sekali, bukan kick global.
- `server/tests/logoutKick.test.ts` (baru, 4 tes) — perilaku planner
  (`deviceId` kosong/`null`/spasi → `null`) **dan** pemasangan di handler
  (regex atas blok `POST /logout`: kedua emitter menerima `kick.deviceId`).
  Lapis kedua penting karena planner benar yang tidak dipakai tidak menutup
  apa pun.

Sisa perbedaan yang diterima: `/logout` tidak mem-blacklist seluruh JTI family
di Redis (hanya `revokeFamily` yang menandai DB), berbeda dari `logout-all`.
Itu bukan bagian temuan ini dan tidak diubah — refresh token yang dicabut di DB
sudah ditolak saat rotasi.

## N6-02 (Low) — id guest Burner 32 bit

**Perbaikan.** `guestId` dan `guestDeviceId` memakai `crypto.randomUUID()`
penuh (sebelumnya `substring(0, 8)`): `server/src/routes/auth.ts` di titik
pembuatan guest. Prefix `guest_`/`burner_` tetap, jadi semua pengecekan
`isEphemeralGuestSubject` dan pemakaian `sub`/`device_id` tidak berubah.
`burnerLimiter` tetap membatasi pembuatan per IP, jadi tidak ada biaya tambahan.

**Penjaga regresi.** `server/tests/guestIdEntropy.test.ts` (baru, 2 tes):
menolak pola `randomUUID().substring(0, 8)` di `routes/auth.ts` dan mewajibkan
bentuk UUID penuh untuk kedua id.

**Yang tidak diklaim.** Dampak routing relay (`sub` guest sebagai kanal) hanya
dibuktikan dari kode, tidak lewat E2E; yang ditutup di sini adalah sumbernya
(entropi id), yang tetap benar apa pun jalur routing-nya.

## N6-03 (Info) — `isVerified` bukan bukti perangkat

Tidak ada perubahan perilaku (itu desain tier kepercayaan). Ditambahkan komentar
di `POST /api/pow/verify` (`routes/auth.ts`) yang menyatakan `isVerified` hanya
tier PoW dan tidak boleh dibaca sebagai "perangkat terverifikasi"; bila perlu
dibedakan, tambah kolom terpisah.

## Yang tetap terbuka setelah pass ini

| Item | Status |
|---|---|
| `N5-01` (pesan v2 lintas-era tanpa arsip braid) | **Terbuka** — keputusan protokol, lihat `docs/33` §33.8 dan `pass-5/40-fixes.md`. |
| `F-13` (`pnpm audit --prod`) | Belum dijalankan (butuh jaringan). |
| Race single-active-device di sidecar | Diwarisi pass 4, belum diverifikasi. |
| Cakupan | WASM KT, `metrics.rs` rinci, E2E/Rust/fuzz/drill tidak dijalankan pass ini. |

## Checks

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx oxlint` 4 berkas tersentuh | **0 error**, 2 warning lama (`no-unused-vars` di `auth.ts`) |
| `tsx --test tests/logoutKick.test.ts tests/guestIdEntropy.test.ts` | **6 tes, 6 lulus** |
| Full `pnpm --filter nyx-server run test` | **785 tes, 783 lulus, 0 gagal, 2 skip** |
| `cargo test` (sidecar) | tidak diulang — pass ini tidak menyentuh Rust; pass 5 sudah 0 gagal setelah `main.rs` dikoreksi |

Tidak dijalankan: E2E, `pnpm audit --prod`, tes Go KT, fuzz, drill, DR oracle.
