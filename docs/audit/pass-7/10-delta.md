# Pass 7 — Laporan delta

Basis: `dd1426be`. Pass 1: `AUDIT_REPORT.md`. Pass 2–6: `pass-2/`…`pass-6/`.
Temuan baru: `20-findings.md`. Verifikasi fokus KT: `30-kt.md`.

## Ringkasan satu paragraf

Fix pass 6 **terverifikasi**: `/logout` kini mengirim `force_logout` + `KICK`
device-scoped lewat planner murni (dan `null` bila `deviceId` tidak diketahui —
tidak berubah menjadi logout global), id guest Burner memakai UUID penuh, dan
komentar `isVerified` dikoreksi. Fix pass 5 (`b774116c`) juga terverifikasi.
Fokus baru — state KT di klien — **fail-closed-nya benar** (state hanya ditulis
setelah verifikasi; pin konfigurasi menolak kunci pengganti; gossip tidak
menambah data ke server), tetapi dua kebocoran metadata muncul dari sana:
kueri KT mengirim `usernameHash` kontak ke server NYX di URL GET (N7-01, Medium),
dan PK `ktMonitoring` menyimpan search key kontak plaintext sehingga sealing
nilai tidak melindungi kontak yang dimonitor dari dump IndexedDB (N7-02, Medium).
Tidak ada temuan Critical/High.

## A. Diperbaiki dan terverifikasi

| ID | Klaim perbaikan | Bukti | Verdict |
|---|---|---|---|
| N6-01 | `/logout` mengirim kick device-scoped, `null` bila `deviceId` tidak ada | `utils/logoutKick.ts` (planner murni), `auth.ts:1461-1505` (`loggedOutDeviceId = stored.deviceId`, kedua emitter menerima `kick.deviceId`), `tests/logoutKick.test.ts` (4 tes: planner + pemasangan) | **Tertutup.** Tidak ada jalur yang mengubah `deviceId` hilang menjadi kick global. |
| N6-02 | Id guest Burner = UUID penuh | `auth.ts:791-798` (`guest_${crypto.randomUUID()}`, `burner_${crypto.randomUUID()}`), `tests/guestIdEntropy.test.ts` menolak pola lama | **Tertutup.** Prefix tetap → `isEphemeralGuestSubject`/limiter tidak berubah. |
| N6-03 | `isVerified` bukan bukti perangkat | komentar di `/pow/verify` (`auth.ts:1617-1622`) | **Tertutup sebagai dokumentasi.** |
| N5-02 | Dokumen `spqrRatchet` menyatakan modul dipakai produksi | commit `b774116c` + diff terverifikasi sebelumnya | **Tertutup.** |
| N5-03 | Suite SPQR gagal bila WASM hilang | commit `b774116c`, tes baru `HAS_WASM` | **Tertutup.** |
| N5-04 | Komentar batas uni dikoreksi | commit `b774116c` (`main.rs:803-812`) | **Tertutup sebagai dokumentasi.** |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N5-01 | **Terbuka** | Pesan v2 lintas-era tanpa arsip braid — keputusan protokol. |
| N7-04 | **UNVERIFIED** | State KT tidak ter-scope akun; `clearKtStates`/`clearKtConfigPin` tanpa pemanggil. Perlu uji logout→login akun lain. |
| F-13 | **Tidak diverifikasi** sejak pass 1 | `pnpm audit --prod` butuh jaringan. |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip. |
| Race single-active-device sidecar | **Tidak diverifikasi** | Diwarisi pass 4. |
| Cakupan | Terbuka | WASM KT internal, `metrics.rs` rinci, eksekusi Rust/fuzz/E2E. |

## C. Regresi baru

Tidak ada. Perubahan `dd1426be` hanya menambah kick pada `/logout` (dengan
planner yang menolak `deviceId` kosong) dan memperpanjang id guest; tidak ada
jalur lain yang tersentuh.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N7-01 | **Medium** (High confidence) | `defaultFetchProof` mengirim `hash = Argon2id(username)` kontak sebagai query GET ke `/api/keys/kt/search` lewat `api()` ber-cookie (bukan OHTTP/PIR). Server/log/proxy dapat merekonstruksi social graph dari rangkaian verifikasi. |
| N7-02 | **Medium** (High confidence) | PK `ktMonitoring.searchKeyHex` plaintext berisi `0x75||Argon2id(username)`; parameter Argon2id publik + salt statis, jadi dump IndexedDB tanpa masterSeed bisa dicocokkan dengan kandidat username → himpunan kontak yang dimonitor bocor, membatalkan alasan sealing nilai. |
| N7-03 | Low | Dokumen `ktMonitoring` menyatakan modul belum dipanggil produksi, padahal `App.tsx` menjalankan loop monitor. |
| N7-04 | UNVERIFIED | `clearKtStates`/`clearKtConfigPin` tidak punya pemanggil; apakah logout biasa menghapus `NyxUnifiedDB` belum dibuktikan. |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **exit 0**; web **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning.
- `pnpm --filter nyx-server run test`: **785 tes, 783 lulus, 0 gagal, 2 skip**
  (naik 6 dari pass 6 — `logoutKick` + `guestIdEntropy`).
- `vitest run` 6 berkas KT (`ktMonitoring`, `ktGossip`, `keyTransparencyV2`,
  `ktBundleProofV2`, `ktConfigPin`, `privacyStatus`): **60 tes, 60 lulus**.
- Tidak dijalankan: `cargo test`, E2E, `pnpm audit --prod`, tes Go KT, drill, fuzz.

## F. Rekomendasi urutan tindak lanjut

1. **N7-01** — bungkus kueri KT dengan OHTTP + token scoped (pola
   `POST /api/pir/query`), atau minimal pindahkan hash ke body POST agar tidak
   masuk log URL. Ini menyentuh rute, bukan format wire E2EE.
2. **N7-02** — ganti PK `searchKeyHex` menjadi HMAC ber-masterSeed; simpan search
   key hanya di nilai ter-seal. Perlu migrasi Dexie (versi baru), bukan
   perubahan format kripto.
3. **N7-04** — jalankan uji logout→login akun lain; bila baris bertahan, panggil
   `clearKtStates` + `clearKtConfigPin` di jalur logout.
4. **N7-03** — koreksi dokumen; lalu F-13 dan N5-01 sebelum rilis.
