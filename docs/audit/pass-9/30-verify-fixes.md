# Pass 9 — Verifikasi fix pass 8 (commit `0a8a2e2b` dan `09bc7d04`)

## N8-01 — KDF KT melempar: **TERTUTUP (dijalankan)**

Kode akhir memakai bentuk JS yang benar
(`web/src/lib/keychainDb.ts:49-53`):

```ts
const subkey = sodium.crypto_kdf_derive_from_key(32, 1, 'nyx-kt01', masterSeed);
```

Probe dengan `libsodium-wrappers@^0.8.4` (paket yang dipakai app):

```
fixed call -> len 32 nonzero true
deterministic true
differs per seed true
64-byte seed -> THREW: invalid key length
16-byte seed -> THREW: invalid key length
31-byte seed -> THREW: invalid key length
```

Jadi jalur nyata bekerja, dan `masterSeed` yang bukan 32 byte gagal **terlihat**
(bukan menulis indeks nol). `masterSeed` dibuat `randombytes_buf(32)`
(`web/src/workers/crypto.worker.ts:690`), jadi ukuran itu memang kontraknya.
`ktSearchIndexKey.test.ts` (5 tes) memakai sodium asli, bukan mock — regresi
yang sama tidak bisa lolos lagi.

## N8-02 — bucket limiter bersama: **TERTUTUP untuk trafik bertoken, TERBUKA untuk jalur anonim**

`clientRateLimitTag` (`server/src/utils/clientIp.ts:63-76`) memberi satu bucket
per subjek token OHTTP; `rateLimitIdentity.test.ts` membuktikannya (dua token
berbeda dari IP loopback yang sama → bucket berbeda). Namun route bukti KT kini
anonim dan klien mengirim `withToken: false`
(`web/src/lib/ktBundleProof.ts:396`), sehingga jalur itu tetap jatuh ke tag
`127.0.0.1`. Itu **bukan** regresi mekanisme N8-02, melainkan celah yang
dibukanya: dicatat sebagai **N9-01**.

## N8-03 — pin TOFU dihapus saat logout: **TERTUTUP**

Pin ber-PK per akun (`web/src/lib/ktConfigPin.ts:129-131`), logout tidak
menghapusnya (`web/src/store/auth.ts:873-877` hanya berkomentar, tanpa
`clearKtConfigPin`), dan `clearKtConfigPin` menghapus semua baris hanya untuk
rotasi/wipe. `ktConfigPinScope.test.ts` (5 tes) mengunci: pin bertahan setelah
logout, akun B tidak membaca pin A, tanpa id akun tidak ada baca/tulis.
Efek samping baru yang tersisa: N9-02 (akun tidak diketahui diperlakukan
sebagai "belum di-pin").

## N8-04 — fallback OHTTP menelan 4xx: **TERTUTUP**

4xx kini fail-closed + log terstruktur; fallback hanya untuk transport/5xx
(`web/src/lib/ktBundleProof.ts:400-427`). Konsekuensi yang diperiksa: `404
KT_NOT_FOUND` tidak lagi mengirim ulang hash ke server, dan verdict tetap
`unavailable` (bukan `mismatch`), jadi tidak memblokir kirim. Degradasi masih
**log-only** (`console.warn`), belum metrik — dicatat sebagai batas, bukan
temuan.

## N5-01 — pesan v2 lintas-era: **TERTUTUP (dibuktikan dengan WASM sungguhan)**

`rotateSpqrStateForNewSession` mem-flush debounce, menggeser FIFO tiga slot,
lalu menghapus baris aktif (`web/src/lib/spqrState.ts:304-330`);
`decryptSpqrMessage` mencoba era aktif lalu setiap arsip dan **tidak** menyimpan
state era arsip ke baris aktif (`web/src/utils/crypto.ts:527-575`).

Saya menguji hipotesis bahwa arsip read-only akan gagal membuka pesan **kedua**
dari era yang sama (karena state normalnya dimajukan tiap pesan). Probe dengan
`spqr.wasm` asli:

```
n=2  ok,ok
n=3  ok,ok,ok
n=5  ok,ok,ok,ok,ok
n=10 ok×10
n=20 ok×20
n=40 ok×40
reverse n=6 ok×6
```

Semua message key cocok, termasuk **urutan terbalik**. Artinya braid membuat
setiap pesan dapat dibuka dari state era yang sama tanpa dimajukan lebih dulu —
hipotesis saya salah, dan arsip read-only memang cukup untuk pesan tertunda
banyak sekaligus. Sisa risiko yang nyata hanyalah churn rotasi (**N9-03**).

## N7-01 — server tahu akun→hash: **TERTUTUP**

`POST /api/keys/kt/search` anonim (`server/src/routes/ktQuery.ts:120`, tanpa
`requireAuth`), klien mengirim tanpa cookie
(`web/src/lib/ktBundleProof.ts:363-371`, `credentials: 'omit'`) dan tanpa token
di amplop. Gateway tidak mewajibkan token (`server/src/ohttp/gateway.ts` —
`injectedAuthorization` opsional), allowlist memuat `POST /api/keys/kt/search`
dengan batas body 4 KB (`packages/shared/src/ohttp.ts:398`, `:409-410`), dan GET
`/search` tetap terautentikasi (`server/src/routes/ktQuery.ts:129`).

Oracle enumerasi tidak bertambah: registrasi sudah menjawab `409 Username
already taken` (`server/src/routes/auth.ts:354`), dan bukti log KT memang data
publik. Yang tersisa: IP peminta terlihat tanpa OHTTP (didokumentasikan), dan
N9-01 untuk jalur OHTTP.

## Lima klaim "Verified-OK" yang ditantang ulang

1. **Token OHTTP hanya untuk allowlist** — bertahan. `isOhttpScopeRequestAllowed`
   memakai pasangan method+path; 18 tes `ohttp.test.ts` lulus.
2. **State KT fail-closed** — bertahan, dan kini **benar-benar menulis**: 39/39
   tes (termasuk KDF asli) dan 100/100 tes KT/Dexie lulus.
3. **Isolasi pin per akun** — bertahan (5 tes + kode).
4. **Arsip era tidak pernah dipromosikan** — bertahan; probe 40 pesan
   menunjukkan baris aktif tidak berubah dan arsip tidak perlu dimajukan.
5. **Pengecualian CSRF hanya tanpa cookie sesi** — tidak diubah commit ini;
   `hasSessionCookie` tetap mencakup `at`/`rt`/`embed_at` (`server/src/app.ts`).

## Catatan working tree

Satu perubahan belum di-commit: `web/src/lib/__tests__/ktMonitoring.test.ts`
menaikkan batas waktu tes "tanpa state siap" ke 20 dtk (import dinamis graf KT
memakan 4,5–5 dtk). Tidak ada asersi yang dilonggarkan; tes yang sama lulus
(9,6 dtk) pada pass ini.
