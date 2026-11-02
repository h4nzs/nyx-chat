# Pass 8 — Perbaikan

Tanggal: 2026-11-02. Basis: `dd1426be` + fix pass 7 di working tree (belum
di-commit saat audit). Temuan: `20-findings.md`; verifikasi fix pass 7:
`30-verify-fixes.md`.

Keempat temuan pass 8 ditutup. N7-01 tetap **PARTIAL** (butuh jalur anonim,
bukan patch), N5-01 tetap terbuka (keputusan protokol).

## N8-01 (High) — KDF libsodium salah API; state KT tidak pernah tersimpan

**Perbaikan.** `web/src/lib/keychainDb.ts` — `deriveKtSearchIndexKey` memakai
bentuk JS yang benar:

```ts
const subkey = sodium.crypto_kdf_derive_from_key(32, 1, 'nyx-kt01', masterSeed);
```

Sebelumnya argumen disusun seperti API C (`(subkey, 1, ctx, key)`), sehingga
binding melempar `TypeError: subkey_len must be an unsigned integer`. `ctx`
tetap 8 karakter dan `masterSeed` 32 byte (`randombytes_buf(32)` di
`crypto.worker.ts`). Panjang hasil diperiksa (32 byte) dan kegagalan tetap
`AtRestSealUnavailableError` sehingga jalur tulis KT tetap fail-closed.

Efek berantai yang pulih: `ktSearchKeyRowId` → `saveKtState` bisa menulis,
`checkBundleAgainstKeyTransparency` tidak lagi memetakan `TypeError` menjadi
`unavailable`, dan `runKtMonitorOnce` kembali menyimpan anchor/`keyVersion`
(rotasi & split-view bisa terdeteksi).

**Penjaga.** `web/src/lib/__tests__/ktSearchIndexKey.test.ts` (5 tes) memakai
libsodium **asli** (tanpa mock `deriveKtSearchIndexKey`):
deterministik, 32 byte, berbeda untuk seed berbeda, melempar saat vault
terkunci, dan PK baris KT 64 hex yang bukan search key mentah. Tes lama tetap
hijau karena ia mem-mock fungsi ini — itulah sebabnya regresi ini lolos.

## N8-02 (Medium) — semua trafik OHTTP berbagi satu bucket rate-limit

**Perbaikan.** `server/src/utils/clientIp.ts` menambah `ohttpTokenSubjectTag` +
`clientRateLimitTag`; `server/src/middleware/rateLimiter.ts` memakai
`clientRateLimitTag` sebagai `keyGenerator` limiter umum.

- Request yang membawa token OHTTP sah (`scope: 'ohttp'`, tanda tangan
  diverifikasi) diberi bucket `pepperedIdentifier('ohttp-sub:<id>')` → **satu
  akun satu bucket**, walaupun semuanya tiba dari `127.0.0.1`.
- Tanpa token OHTTP (sesi cookie, token rusak/kedaluwarsa, jalur non-OHTTP)
  perilakunya **tidak berubah**: tag IP ber-pepper seperti sebelumnya.
- Tag tetap HMAC pepper, bukan userId mentah, jadi snapshot Redis tidak memuat
  daftar akun (kriteria WS-H tetap).

Batas yang dipertahankan: penyerang tidak bisa memilih bucket akun lain tanpa
tanda tangan sah, dan token yang tidak sah tetap ditolak `requireAuth` setelah
limiter. Relay terpisah tetap punya limiter per-IP klien sendiri
(`relayApp.ts`, default 120/menit).

**Penjaga.** `server/tests/rateLimitIdentity.test.ts` (4 tes): dua token →
bucket beda; token sama dari IP berbeda → bucket sama; token sesi/rusak →
kembali ke tag IP; trafik non-OHTTP tetap per IP. Didaftarkan di
`server/package.json`.

## N8-03 (Low) — logout menghapus pin TOFU KT

**Perbaikan.** Pin kini **ber-PK per akun** (`ktConfigPinRowId(userId)` =
`kt-config:<userId>`) dan **tidak dihapus saat logout**
(`web/src/store/auth.ts` hanya membersihkan state monitoring).

- `loadKtConfigPin` / `saveKtConfigPin` mengambil id akun dari auth store; tanpa
  id akun keduanya tidak membaca/menulis apa pun (tidak ada pin lintas-akun).
- `clearKtConfigPin` tetap ada untuk rotasi kunci yang disengaja / wipe, dan
  menghapus **semua** baris pin (satu akun tidak bisa "mereset" pin akun lain
  lewat jalur ini).
- Konsekuensi: akun yang sama mempertahankan kontinuitas TOFU lintas
  logout→login, sementara akun B di perangkat yang sama tidak pernah mewarisi
  pin A. Baris legacy `kt-config` (satu baris global) sengaja tidak dibaca: ia
  tidak bisa dibuktikan milik akun mana pun, jadi pengguna lama melakukan TOFU
  ulang **sekali**.

**Penjaga.** `web/src/lib/__tests__/ktConfigPinScope.test.ts` (5 tes): pin
bertahan setelah logout, akun lain tidak membacanya, tanpa id akun tidak ada
baca/tulis, dan `clearKtConfigPin` menghapus semua baris.

## N8-04 (Low) — fallback OHTTP menelan 4xx sah dan membocorkan hash

**Perbaikan.** `web/src/lib/ktBundleProof.ts` — `defaultFetchProof` membedakan
tiga kelas hasil amplop:

| Hasil OHTTP | Tindakan |
|---|---|
| 2xx | dipakai |
| 5xx | fallback ke jalur langsung + log `kt.ohttp-degraded` |
| gangguan transport | fallback ke jalur langsung + log `kt.ohttp-degraded` |
| 4xx (mis. `404 KT_NOT_FOUND`) | **tanpa fallback**, log `kt.ohttp-degraded`, lempar → verdict `unavailable` |

Dulu semua non-2xx dikirim ulang lewat cookie, sehingga hash kontak yang **belum
terdaftar** tetap sampai ke server pada setiap percobaan — persis yang ingin
dicegah OHTTP — dan request berlipat. Log terstruktur (bukan `console.warn`
lepas) membuat degradasi privasi terlihat oleh operator.

## Checks yang dijalankan

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx oxlint src/utils/clientIp.ts src/middleware/rateLimiter.ts` | **0 error**, 0 warning |
| `tsx --test tests/rateLimitIdentity.test.ts tests/ohttp.test.ts` | **22 tes, 22 lulus** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `vitest run` ktSearchIndexKey + ktConfigPinScope + ktBundleProofV2 | **16 tes, 16 lulus** |

Tidak dijalankan: E2E, fuzz, `cargo test`, tes Go KT, drill, DR oracle, seluruh
suite vitest web (hanya berkas yang tersentuh).

## Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N7-01 | **PARTIAL** | Hash keluar dari URL/log, tetapi server tetap tahu akun→hash; anonimitas penuh butuh OHTTP+PIR/token tak terikat akun, dan `VITE_OHTTP_ENABLED` masih default mati. |
| N5-01 | Terbuka | Pesan SPQR v2 lintas-era tanpa arsip braid (keputusan protokol, `docs/33` §33.8). |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip. |
| Race single-active-device sidecar | Tidak diverifikasi | Warisan pass 4. |
