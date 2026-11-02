# Pass 11 — Verifikasi fix pass 10 (commit `0c337be9`)

## N10-01 — monitor KT melempar sebelum tahu ada pekerjaan: **TERTUTUP**

Kode sekarang merencanakan lebih dulu:

```ts
// web/src/lib/ktBundleProof.ts:863-866
const states = deps.states ?? (await loadKtStates());
if (planKtMonitor(states) === null) return { checked: 0, changed: [] };

const resolved = await resolveConfig(deps.fetchConfig ?? defaultFetchConfig);
```

`planKtMonitor` mengembalikan `null` bila tidak ada baris dengan
`monitoringData` + `distinguishedTreeHead` (`ktMonitoring.ts:248-256`), jadi
tick tanpa pekerjaan tidak lagi membaca config — fail-closed N9-02 tetap utuh
untuk jalur yang benar-benar memverifikasi (config diresolusi **sebelum**
`runKtMonitorOnce`).

Dua hal yang saya periksa sebagai calon regresi:

1. **Jangkar gossip ikut terlewat.** `refreshKtAnchor` ada di akhir fungsi
   (`:883`), jadi early return melewatinya. Ini **bukan** kehilangan: jalur
   verifikasi kontak sudah menyegarkan jangkar bila belum ada
   (`ktBundleProof.ts:733`, `if (!getLocalAnchor()) await refreshKtAnchor(...)`)
   dan loop monitor di App hanya berjalan setelah 30 dtk. Tidak ada temuan.
2. **Tes penjaganya.** `ktMonitoring.test.ts` lulus pada pass ini (bagian dari
   40/42), termasuk asersi baru `fetchConfig` tidak dipanggil.

## N10-02 — dua limiter OHTTP lain: **TERTUTUP**

- Gateway: `keyGenerator: (req) => clientRateLimitTag(req)`
  (`server/src/routes/ohttp.ts:71-77`).
- Relay: `keyGenerator` = `relayClientTag(internalToken, clientAddress(req))`,
  atau `addr:<alamat>` tanpa token (`server/src/ohttp/relayApp.ts:113-130`);
  alamat mentah tidak masuk store.
- **Gap yang paling mungkin membuat fix ini hanya lulus di tes**: tag hanya
  dipercaya bila proses API memegang token internal. `app.ts:413` memanggil
  `setOhttpInternalToken(ohttpConfig?.internalToken)` dan
  `config.ts:112-126` menurunkan token dari `OHTTP_INTERNAL_TOKEN` atau HMAC
  `JWT_SECRET`, jadi di produksi tag benar-benar dipercaya (mode `on`).
- Bukti eksekusi (tes baru, router asli + `express-rate-limit` nyata, lulus
  pada suite server pass ini):
  - gateway, 140 request bergantian dua tag sah → **0** respons 429;
  - gateway, satu tag 121 request → tepat **1** 429, di indeks 120;
  - relay, 140 alamat klien berbeda dari loopback → **0** 429;
  - relay, satu alamat 121 request → **1** 429 di indeks 120.

Konsekuensi yang tetap berlaku (bukan temuan baru): bila
`OHTTP_INTERNAL_TOKEN` tidak disetel di salah satu proses, tag menjadi
`no-token`/`untrusted` dan bucket kembali per alamat loopback. Itu terlihat di
metrik `nyx_ohttp_client_tag_total` + alert/dashboard yang ditambahkan commit
ini; perilakunya didokumentasikan, bukan diam-diam.

## N10-03 — `CF-Connecting-IP` dipercaya tanpa syarat: **TERTUTUP**

- `ohttpClientAddress` memakai `req.socket.remoteAddress` lebih dulu, dan
  header hanya dipakai bila hop langsung cocok dengan `OHTTP_TRUSTED_PROXIES`
  (default `127.0.0.1`/`::1`) — `clientTag.ts:127-152`. `X-Forwarded-For` tetap
  tidak dipakai.
- nginx menimpa header di **enam** blok (`ops/nginx/nyx.conf:196,214,228,364,
  382,396`) dengan `$remote_addr` hasil `real_ip`, dan `real_ip` sekarang juga
  memercayai cloudflared loopback (`set_real_ip_from 127.0.0.1; ::1;` di konteks
  `http`, `:70-75`).
- **Premis pass 10 melemah**: kedua `server` hanya `listen 127.0.0.1:3000`
  (`:79`, `:244`), jadi "origin terjangkau langsung" berarti proses lokal di
  host itu sendiri — sudah di dalam batas kepercayaan (komentar config
  menyebutnya). Nilai temuan tetap: tanpa penimpaan, header kiriman klien
  diteruskan apa adanya lewat cloudflared.
- Tes baru `ohttpClientAddress` (peer non-proxy, loopback, CIDR container)
  lulus. Celah yang tes itu tidak cakup: **CIDR IPv6** — lihat N11-05.

## N10-04 — arsip braid hanya mengenali state byte-identik: **SESUAI DESAIN, INERSIA DI PRODUKSI**

Mekanisme terpasang benar:

- baris ter-seal menyimpan `a` (`spqrState.ts:104-125`), pembaca lama tanpa
  penanda dianggap `advanced: true` (`:137-152`);
- `saveSpqrState` menyimpan penanda dan tidak bisa "dibatalkan" tulis
  berikutnya di era yang sama (`:167-200`);
- `rotateSpqrStateForNewSession` hanya menggeser FIFO bila `current.advanced`
  (`:331-360`);
- kedua penulis nyata menandai `true` (`utils/crypto.ts:470`, `:574`).

Tetapi dua temuan mengubah nilai klaimnya:

1. **Kondisinya tidak bisa dicapai lewat produksi.** `grep -rn "saveSpqrState("
   web/src` → hanya dua pemanggil, keduanya `advanced: true`. Tidak ada jalur
   yang menyimpan "state awal era" tanpa langkah ratchet: state v2 baru ada
   setelah `encrypt`/`decrypt` berhasil. Artinya di produksi setiap baris yang
   ada sudah `advanced`, sehingga rotasi **selalu** mengarsipkan seperti
   sebelum N9-03 — churn yang diukur pass 10 berasal dari probe/tes yang menulis
   state awal secara langsung, bukan dari `utils/crypto.ts`. (N11-02)
2. **Dua tes arsip era sekarang merah** karena fixture-nya menulis state era
   tanpa penanda: `spqrEraArchive.test.ts:138` → `expected [] to have a length
   of 1`; `:187` → `expected [] to have a length of 3`. Suite web merah → CI
   unit merah. (N11-01)

## N10-05 — suite server merah: **TERTUTUP**

`server/tests/ipKey.test.ts:77-79` menegaskan
`const secureKeyGenerator = (req: Request): string => clientRateLimitTag(req)`,
dan tidak melonggarkan asersi lain (`doesNotMatch(/ipKeyGenerator\(cfAwareClientIp/)`
tetap ada). `pnpm --filter nyx-server run test` **exit 0** pada pass ini.

## Lima klaim "Verified-OK" yang ditantang ulang

1. **Pengecualian CSRF hanya tanpa cookie sesi** — bertahan.
   `hasSessionCookie` mencakup `at`/`rt`/`embed_at` dan pengecualian hanya untuk
   `/api/pir/query` + `/api/keys/kt/search` (`server/src/app.ts:430-452`).
2. **State KT hanya ditulis setelah verifikasi** — bertahan. `runKtMonitorOnce`
   memanggil `saveState` setelah `verifyMonitor` (`ktBundleProof.ts:711-724`);
   pembungkus monitor hanya menambah early return sebelum config, tidak ada
   penulisan state di sana (`:863-885`).
3. **Allowlist OHTTP tetap sempit** — bertahan. Seluruh `ohttp.test.ts` (20+ tes,
   termasuk tes limiter baru) lulus pada suite server pass ini.
4. **Tag relay tidak bisa dikarang tanpa token internal** —
   `trustedRelayClientTag` memverifikasi token dengan `timingSafeEqual` dan
   bentuk tag sebelum dipakai (`clientTag.ts:63-72,176-190`); gateway juga
   membuang klaim header dari dalam amplop (tes lulus). Bertahan.
5. **Batas kepercayaan nginx/`real_ip`** — bertahan dengan catatan: memercayai
   loopback berarti proses lokal dapat mengarang `CF-Connecting-IP`, tetapi
   proses lokal sudah bisa memanggil `127.0.0.1:4000` langsung; kedua `server`
   hanya listen loopback. Bukan perluasan permukaan yang nyata.

## Catatan eksekusi suite web penuh (pertama kali dalam rangkaian audit)

```
Test Files  3 failed | 106 passed (109)
     Tests  4 failed | 943 passed (947)
```

Keempat kegagalan:

| Tes | Sebab | Status |
|---|---|---|
| `spqrEraArchive` "frame era lama … terbuka dari arsip era" | fixture tanpa `advanced` → arsip kosong | **regresi commit ini** (N11-01) |
| `spqrEraArchive` "arsip dibatasi FIFO…" | idem | **regresi commit ini** (N11-01) |
| `clientVersion` "CLIENT_VERSION_REQUIRED dibedakan dari too-old" | `CSRF_UNAVAILABLE`, `status: 0` | **pre-existing** — gagal juga di `bfca57c7` (worktree bisect) |
| `x3dhOracleInterop` "ratchet + AEAD dua arah" | timeout 60 dtk (build Go dingin) | lingkungan — lulus sendiri dalam **11 dtk** setelah cache hangat (N11-06) |
