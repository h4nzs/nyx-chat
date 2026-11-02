# Pass 10 — Verifikasi fix pass 9 (commit `bfca57c7`)

## N9-01 — tag klien relay untuk trafik OHTTP tanpa akun: **TERTUTUP SEBAGIAN**

Mekanismenya benar dan teruji:

- Relay menghitung `HMAC(secret, alamat)` dan mengirimnya bersama token internal
  (`server/src/ohttp/relayApp.ts:112-126`, `server/src/ohttp/clientTag.ts:79-83`);
  alamat mentah tidak keluar dari proses.
- Gateway membuang klaim `x-nyx-ohttp-internal` / `x-nyx-ohttp-client-tag` dari
  **dalam amplop**, lalu memasang nilai relay
  (`server/src/ohttp/gateway.ts:118-146`); tes `ohttp.test.ts` mengunci ini.
- API memakai tag itu lebih dulu: `clientRateLimitTag` =
  `ohttpRelayClientTag ?? ohttpTokenSubjectTag ?? clientIpTag`
  (`server/src/utils/clientIp.ts:96-98`).
- Tag tanpa token internal yang sah tidak dipercaya
  (`clientTag.ts:93-105`) — probe dengan tag palsu tidak menghasilkan bucket.

**Yang tidak tertutup:** dua limiter 120/menit lain di jalur yang sama masih
memakai `req.ip` loopback — `ohttpLimiter` gateway (`routes/ohttp.ts:62-66`) dan
limiter relay (`relayApp.ts:105-108`). Probe: 140 request dengan dua tag sah →
429 di #121; 140 `cf-connecting-ip` berbeda di relay → 429 di #121. Jadi
kegagalan ketersediaan yang menjadi inti N9-01 masih ada, dan batas efektifnya
(120/menit) lebih ketat daripada bucket 240/menit yang digantikan. Dicatat
sebagai **N10-02**; spoofing header CF sebagai **N10-03**.

## N9-02 — pin konfigurasi fail-closed: **TERTUTUP, dengan regresi urutan**

`resolveKtConfigPin` (`web/src/lib/ktConfigPin.ts:147-171`) membedakan empat
keadaan; `resolveConfig` melempar untuk `unknown-account` dan `unreadable`
(`ktBundleProof.ts:539-544`), dan hanya menerima config tanpa perbandingan pada
`empty`. Isolasi per akun tetap: PK `kt-config:<userId>`, logout tidak menghapus,
`clearKtConfigPin` hanya untuk rotasi/wipe; `ktConfigPinScope.test.ts` lulus
(termasuk kasus `unknown-account` dan baris rusak).

Regresi: `monitorKeyTransparency` memanggil `resolveConfig` **sebelum**
memeriksa daftar state (`ktBundleProof.ts:855`), sehingga jalur "belum ada yang
dimonitor" melempar ketika akun belum terhidrasi — tes `ktMonitoring` yang sudah
ada gagal (`N10-01`). Fail-closed pada jalur verifikasi itu sendiri tetap benar;
yang salah adalah urutannya.

## N9-03 — rotasi tanpa lalu lintas v2 tidak menggeser arsip: **SEBAGIAN**

`sameState` + guard `unchanged` (`web/src/lib/spqrState.ts:322-348`) mencegah
penulisan ulang bila state aktif **byte-identik** dengan slot 0. Dua tes baru
lulus untuk kasus itu.

Namun state awal sesi X3DH baru bergantung pada `authKey`, jadi selalu berbeda.
Probe dengan `spqr.wasm` asli: dua era tanpa pesan menghasilkan state awal
118 byte yang **tidak sama**, dan arsip berisi **2 slot** — churn yang
dijelaskan N9-03 tetap terjadi. Tes barunya memakai `stateBytes(1)` dua kali,
jadi ia menguji keadaan yang tidak dihasilkan alur nyata. Dicatat sebagai
**N10-04**.

## Lima klaim "Verified-OK" yang ditantang ulang

1. **Allowlist OHTTP hanya target sempit** — bertahan. Seluruh 20 tes
   `ohttp.test.ts` lulus pada suite server pass ini (satu-satunya kegagalan ada
   di `ipKey.test.ts`), termasuk pasangan method+path `POST /api/keys/kt/search`
   dan penolakan `GET`-nya.
2. **State KT tidak ditulis sebelum verifikasi** — bertahan di
   `runKtMonitorOnce` (state disimpan setelah `verifyMonitor`); yang rusak adalah
   pembungkusnya yang melempar sebelum sampai ke sana (N10-01), bukan urutan
   penulisan state.
3. **Pin tidak bocor antar akun** — bertahan. `ktConfigPinScope.test.ts` lulus
   5/5 pada pass ini (pin A tidak terbaca akun B, tanpa id akun tidak ada
   baca/tulis).
4. **Arsip era read-only cukup untuk banyak pesan** — bertahan. Tes
   `spqrState` lulus; probe pass 9 (40 pesan + urutan terbalik) tidak diulang
   karena tidak ada perubahan pada jalur baca, dan pass ini menambah bukti
   bahwa masalahnya hanya churn (N10-04).
5. **Pengecualian CSRF hanya tanpa cookie sesi** — bertahan.
   `hasSessionCookie` mencakup `at`/`rt`/`embed_at` (`server/src/app.ts:430-434`)
   dan pengecualian hanya untuk `/api/pir/query` + `/api/keys/kt/search`
   (`app.ts:445-452`); jalur ber-cookie tetap melewati `doubleCsrfProtection`.

## Catatan eksekusi Rust (pertama kali dalam rangkaian audit)

`cargo test --offline` di `server/transport-sidecar`:

```
19 passed (protocol.rs: framing/CHAFF/HELLO/limit)
 6 passed (main.rs: rotasi & validitas sertifikat lokal)
```

Ini menutup sebagian celah cakupan pass 4–9 yang selalu menyatakan "Rust tidak
dijalankan". `cargo test --offline` untuk `packages/spqr-wasm` juga selesai:
**0 tes** (satu target, `test result: ok. 0 passed`). Artinya perilaku wrapper
WASM tetap hanya diuji lewat harness TypeScript terhadap artefak build — bukan
oleh tes Rust di crate itu sendiri.
