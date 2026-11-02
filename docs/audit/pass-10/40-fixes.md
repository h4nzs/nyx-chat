# Pass 10 — Perbaikan

Lima temuan `20-findings.md`. Tidak ada temuan pass 1–9 yang dibuka ulang, kecuali
regresi yang memang diperkenalkan pass 9 (N10-01, N10-04).

## N10-01 — monitor KT melempar sebelum tahu ada pekerjaan: **TERTUTUP**

**Akar masalah.** N9-02 membuat `resolveConfig` fail-closed untuk pin
`unknown-account`/`unreadable`. `monitorKeyTransparency` meresolusi config
**sebelum** memeriksa daftar state, jadi tick 6 jam saat akun belum terhidrasi
(boot, sesudah logout) selalu melempar dan jalur cepat `{checked:0}` tidak pernah
tercapai — tes `ktMonitoring` yang sudah ada merah.

**Perbaikan.** `web/src/lib/ktBundleProof.ts` merencanakan lebih dulu
(`planKtMonitor(states)`); bila tidak ada state siap, ia mengembalikan
`{checked:0, changed:[]}` tanpa membaca config sama sekali. State dibaca sekali
dan diteruskan ke `runKtMonitorOnce` (tidak dimuat dua kali). Fail-closed tetap
utuh pada jalur yang benar-benar memverifikasi: config tetap diresolusi (dan
melempar untuk pin tak terbaca) sebelum satu byte pun dikirim.

**Tes.** `ktMonitoring.test.ts` sekarang juga mengunci `fetchConfig` **tidak**
dipanggil untuk kasus `states: []` — asersi lama hanya memeriksa `fetchMonitor`,
sehingga urutan yang salah bisa lolos kalau config kebetulan terbaca.

## N10-02 — dua limiter OHTTP lain masih satu bucket global: **TERTUTUP**

**Akar masalah.** `ohttpLimiter` gateway (`routes/ohttp.ts`) dan limiter relay
(`ohttp/relayApp.ts`) tidak punya `keyGenerator`, jadi memakai `req.ip`: gateway
dipanggil relay lewat loopback dan relay dipanggil nginx tanpa XFF — satu counter
120/menit untuk semua klien. Probe pass 10: 429 pertama di request #121 meski 140
klien berbeda.

**Perbaikan.**

- Gateway: `keyGenerator: (req) => clientRateLimitTag(req)` — urutan tag relay →
  subjek token OHTTP → IP, sama dengan limiter API (`middleware/rateLimiter.ts`).
- Relay: `keyGenerator` = `HMAC(OHTTP_INTERNAL_TOKEN, alamat klien)` bila token
  ada (key di memori relay pun bukan alamat mentah), selain itu alamat klien.
  Alamat diambil dari `ohttpClientAddress` (lihat N10-03).

**Tes.** `ohttp.test.ts` menjalankan router **asli** dengan
`express-rate-limit` sungguhan: 140 request bergantian antara dua tag sah → nol
429 (dulu 429 di #121), sementara satu tag tetap kena 429 tepat di request
ke-121; hal yang sama untuk relay dengan 140 alamat klien berbeda dan satu klien
yang mengirim 121 request.

**Batas.** Angka 120/menit tidak diubah. Tag tetap identitas **per alamat**, bukan
per akun; beberapa akun di satu IP berbagi bucket.

## N10-03 — relay memercayai `CF-Connecting-IP` dari header: **TERTUTUP**

**Akar masalah.** `ohttpClientAddress` membaca `cf-connecting-ip` tanpa syarat.
nginx hanya menyetel `Host` untuk blok relay, jadi header klien lain diteruskan
apa adanya; klien yang menjangkau origin langsung (bypass Cloudflare) bisa
memilih tag — yaitu bucket API tanpa batas setelah N10-02.

**Perbaikan.** `ohttpClientAddress(req, { trustedProxies })` sekarang:

1. mengambil alamat **soket** lebih dulu (bukan `req.ip` yang sudah dipengaruhi
   trust-proxy/XFF);
2. memakai `CF-Connecting-IP` hanya bila hop langsung ada di
   `OHTTP_TRUSTED_PROXIES` (CSV alamat atau CIDR IPv4; default loopback);
3. selain itu memakai alamat soket, dan `X-Forwarded-For` tetap tidak dipakai.

`OHTTP_TRUSTED_PROXIES` diresolusi di proses relay (`relay.ts`, dengan catatan
saat start bila kosong) dan di proses API. `ops/nginx/nyx.conf` menimpa
`CF-Connecting-IP $remote_addr` (hasil restorasi `real_ip`) di **kedua** blok
relay dan **kedua** blok `/api`, sehingga nilai yang diteruskan bukan header
kiriman klien.

**Tes.** Kasus unit: peer non-proxy yang mengirim header → alamat soket yang
dipakai; peer `::ffff:127.0.0.1` → header dipakai; `172.18.0.5` hanya dipercaya
bila `172.16.0.0/12` dicantumkan. Tes relay 140 alamat berbeda bergantung pada
aturan ini (tanpa trust, semuanya jatuh ke alamat nginx).

**Batas.** Daftar proxy adalah konfigurasi operator: deployment nginx-di-container
**wajib** mengisi `OHTTP_TRUSTED_PROXIES` (mis. `172.16.0.0/12`), kalau tidak
semua klien kembali berbagi satu bucket. Itu dinyatakan lewat peringatan start
dan `.env.example`, bukan ditebak diam-diam.

## N10-04 — daur arsip hanya mengenali state byte-identik: **TERTUTUP**

**Akar masalah.** N9-03 membandingkan state aktif dengan slot arsip 0. State awal
sesi X3DH baru selalu berbeda (`authKey` berbeda), jadi dua era tanpa pesan tetap
memakan dua slot — churn yang N9-03 ingin hentikan masih terjadi (probe: 118 B
berbeda, 2 slot).

**Perbaikan.** Baris state menyimpan penanda `advanced` (field `a` di JSON
ter-seal). `saveSpqrState({ advanced: true })` hanya dipakai langkah ratchet
nyata di `web/src/utils/crypto.ts` (encrypt dan decrypt); state awal era tidak
menyetelnya (default `false`) dan penandanya menempel dalam satu era.
`rotateSpqrStateForNewSession` mengarsipkan **hanya** era `advanced`; era tanpa
lalu lintas v2 dihapus tanpa menggeser FIFO, dan penanda ikut terbawa saat slot
digeser. Baris lama tanpa field `a` dianggap pernah maju (konservatif: lebih baik
menyimpan era yang mungkin berisi lalu lintas).

**Tes.** `spqrState.test.ts`: dua era dengan state awal **berbeda** dan tanpa
pesan → arsip tetap satu slot; era yang maju tetap menggeser ke `[baru, lama]`
dan `advanced` ikut tersimpan/terbaca.

**Batas.** Penanda adalah sinyal dari pemanggil, bukan bukti kriptografis: jalur
baru yang menulis state tanpa `advanced: true` akan kehilangan kesempatan
diarsipkan. Karena hanya dua pemanggil (keduanya langkah ratchet) dan keduanya
dikunci tes ini, risikonya sempit — tetapi harus diingat saat menambah jalur
tulis state baru.

## N10-05 — suite server merah: tes wiring menegaskan nama lama: **TERTUTUP**

**Perbaikan.** `server/tests/ipKey.test.ts` menegaskan
`secureKeyGenerator = (req: Request): string => clientRateLimitTag(req)`.
Asersinya **diperkuat**, bukan dilonggarkan: tes yang sama tetap memastikan
`ipKeyGenerator(cfAwareClientIp(...))` tidak dipakai di luar `clientIpTag`, dan
limiter `/api` di `app.ts` tetap memakai tag HMAC (`clientIpTag`) — limiter itu
hanya berlaku untuk path non-`/api`, jadi tag relay tidak relevan di sana.

**Tes.** `npx tsx --test tests/ipKey.test.ts` hijau; suite server kembali 0 gagal
untuk berkas yang dijalankan pass ini.

## Cek yang dijalankan

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint` berkas yang diubah | **0 error** |
| `tsx --test` ipKey + ohttp + rateLimitIdentity + envExample | **41/41 lulus** |
| `vitest run` spqrState + ktMonitoring | **29/29 lulus** |

Tidak dijalankan: E2E Playwright/WebTransport, fuzz framing, 58 tes Go KT, drill
DR/restore KT, DR oracle, suite vitest web penuh, probe beban nyata melewati
nginx/Cloudflare, serta `cargo test` (tidak ada perubahan Rust pada pass ini).
Perubahan `ops/nginx/nyx.conf` juga belum diuji dengan `nginx -t` — berkas itu
tidak dipakai proses lokal.
