# Pass 10 — Temuan baru

Temuan pass 1–9 tidak diulang; lihat `10-delta.md`. Semua bukti di bawah berasal
dari kode yang dibaca **dan** dijalankan pada pass ini.

---

## N10-01 (Medium, keyakinan tinggi) — monitor KT melempar sebelum tahu ada state yang perlu dimonitor

**Ringkas.** Fix N9-02 membuat `resolveConfig` fail-closed untuk pin yang tidak
bisa dibaca:

```ts
// web/src/lib/ktBundleProof.ts:539-544
const pinState = await resolveKtConfigPin();
if (pinState.status !== 'pin' && pinState.status !== 'empty') {
  throw new Error(`kt: pin konfigurasi tidak bisa dibaca (${pinState.status}) — verifikasi ditunda`);
}
```

Tetapi `monitorKeyTransparency` meresolusi config **lebih dulu**, sebelum
`runKtMonitorOnce` sempat memeriksa apakah ada state yang perlu dimonitor:

```ts
// web/src/lib/ktBundleProof.ts:855
const resolved = await resolveConfig(deps.fetchConfig ?? defaultFetchConfig);
const verifier = deps.verifier ?? (await loadKtVerifier());
const outcome = await runKtMonitorOnce({ ... states: deps.states ... });
```

`resolveKtConfigPin` mengembalikan `unknown-account` bila
`useAuthStore.getState().user?.id` kosong (`ktConfigPin.ts:151-153`) — yaitu
tepat pada boot sebelum hidrasi, sesudah logout, atau saat verifikasi berjalan
di jendela logout. Di kondisi itu monitor sekarang **melempar**, padahal
tidak ada satu pun baris `ktMonitoring` yang perlu diperiksa.

**Bukti eksekusi.** Tes yang sudah ada gagal di HEAD:

```
FAIL src/lib/__tests__/ktMonitoring.test.ts > monitorKeyTransparency
     > tanpa state siap → tidak memanggil jaringan
Error: kt: pin konfigurasi tidak bisa dibaca (unknown-account) — verifikasi ditunda
 ❯ resolveConfig src/lib/ktBundleProof.ts:542:11
 ❯ monitorKeyTransparency src/lib/ktBundleProof.ts:854:20
 ❯ src/lib/__tests__/ktMonitoring.test.ts:408:21
```

**Dampak.** `startKtMonitorLoop` menangkap error per langkah dan tidak berhenti,
jadi bukan crash. Yang hilang adalah jalur cepat `{checked:0, changed:[]}`:
setiap tick 6 jam saat akun belum terhidrasi melakukan kerja config + melempar,
dan tes penjaga perilaku itu merah. Ini juga menandakan urutan yang rapuh:
fail-closed seharusnya berlaku saat **memverifikasi**, bukan saat memutuskan
apakah ada pekerjaan.

**Perbaikan.** Pindahkan `resolveConfig` setelah pemeriksaan state kosong, atau
kembalikan `{checked:0, changed:[]}` lebih awal bila `loadKtStates()` kosong.
Jangan melemahkan fail-closed di jalur yang benar-benar memverifikasi.

**Test yang menangkapnya.** Tes `ktMonitoring` yang sudah ada (gagal sekarang);
tambahkan satu kasus `states: []` + `user` kosong yang mengharapkan
`{checked:0}` tanpa memanggil `fetchConfig`.

---

## N10-02 (Medium, keyakinan tinggi) — dua limiter OHTTP lain masih satu bucket 120/menit global

**Ringkas.** N9-01 memperbaiki `ktProofLimiter` (240/menit, per tag relay).
Tetapi jalur OHTTP yang sama memiliki **dua** limiter yang tidak memakai tag:

```ts
// server/src/routes/ohttp.ts:62-66
const ohttpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
```

Tidak ada `keyGenerator`, jadi `express-rate-limit` memakai `req.ip`. Gateway
dipanggil relay lewat loopback (`createLoopbackDispatcher('http://127.0.0.1:PORT')`),
jadi `req.ip` = `127.0.0.1` untuk semua pengguna. Hal yang sama berlaku pada
relay proses terpisah:

```ts
// server/src/ohttp/relayApp.ts:105-108
const limiter = rateLimit({ windowMs: 60_000, limit: options.rateLimitPerMinute ?? 120, ... });
```

`relayApp` tidak menyetel `app.set('trust proxy', ...)`, dan nginx **tidak**
mengirim `X-Forwarded-For`/`X-Real-IP` ke relay (`ops/nginx/nyx.conf:179-186`,
`:335-342`) — hanya `Host`. Akibatnya `req.ip` relay juga alamat nginx
(`127.0.0.1`), satu bucket untuk semua klien.

**Bukti eksekusi (probe dengan router asli).**

```
GATEWAY two distinct trusted tags -> first 429 at request #121 (140 sent)
RELAY 140 distinct cf-connecting-ip -> first 429 at request #121
RELAY gateway saw 120 distinct client tags
```

Kalau bucket mengikuti tag, 140 request dengan dua tag (atau 140 IP) tidak
mungkin kena 429. Angka 121 membuktikan satu counter bersama.

**Dampak.** Skenario yang ditutup N9-01 — dua klien wajar menghabiskan jatah,
lalu semua verifikasi KT jadi `unavailable` + backoff — **masih terjadi**, dan
sekarang batas efektifnya 120/menit, lebih ketat daripada bucket 240/menit yang
dulu ada di `ktProofLimiter`. Penyerang tanpa akun tetap bisa memicunya; route
bukti KT anonim. `docs/34` §34.7 menyatakan masalah ini "ditutup", jadi
dokumentasinya kini lebih optimistis daripada kenyataan.

**Perbaikan.** (a) `ohttpLimiter` memakai `keyGenerator: (req) =>
clientRateLimitTag(req)` — tag sudah tersedia di header sebelum body dibaca;
(b) relay diberi `trust proxy` yang eksak untuk nginx loopback **dan** nginx
mengirim `CF-Connecting-IP $remote_addr` (bukan meneruskan header klien) di
kedua blok relay; atau (c) batas relay dinaikkan/dihapus dan penegakan
diserahkan ke API yang sudah per-tag, dengan metrik/alert 429.

**Test yang menangkapnya.** Tes integrasi: 140 request dari loopback dengan dua
tag relay sah harus **tidak** menghasilkan 429 sebelum bucket per-tag habis.
Tes seperti ini bisa memakai router asli tanpa OHTTP envelope (limiter berjalan
sebelum body).

---

## N10-03 (Low, keyakinan sedang-tinggi) — relay memercayai `cf-connecting-ip` yang diteruskan nginx

**Ringkas.** `ohttpClientAddress` memilih header lebih dulu:

```ts
// server/src/ohttp/clientTag.ts:71-75
const cfIp = req.headers['cf-connecting-ip'];
if (typeof cfIp === 'string' && cfIp.trim() !== '') return cfIp.trim();
if (typeof req.ip === 'string' && req.ip !== '') return req.ip;
```

Komentarnya benar untuk trafik **melalui Cloudflare**: edge menimpa header itu.
Tetapi blok nginx untuk relay hanya menyetel `Host`
(`ops/nginx/nyx.conf:179-186`); header klien lain diteruskan apa adanya. Bila
origin bisa dijangkau langsung (firewall VPS adalah satu-satunya kontrol, tidak
ada di repo), klien dapat memilih `CF-Connecting-IP` sendiri, sehingga tag
yang "ditandatangani relay" sebenarnya berasal dari input penyerang.

**Bukti eksekusi.** Probe mengirim 140 nilai `cf-connecting-ip` berbeda ke
relay; gateway menerima **120 tag berbeda** — relay meneruskan header itu
sebagai identitas, bukan `req.socket.remoteAddress`.

**Dampak.** Dengan N10-02 apa adanya, dampaknya tertahan limiter relay global
(120/menit). Setelah N10-02 diperbaiki (relay per-klien), celah ini menjadi
jalur untuk mendapat bucket API tanpa batas per request, karena tag dapat
dikarang. Ini juga bertentangan dengan komentar nginx/README bahwa relay
"sengaja tidak menerima identitas yang sudah ditegakkan edge".

**Perbaikan.** Ambil alamat dari `req.socket.remoteAddress`; hanya pakai
`X-Forwarded-For`/`CF-Connecting-IP` bila hop langsung adalah proxy tepercaya
(loopback nginx). Di nginx, timpa header secara eksplisit:
`proxy_set_header CF-Connecting-IP $remote_addr;` untuk kedua blok relay —
`$remote_addr` sudah dipulihkan `real_ip` dari rentang CF.

**Test.** Kirim `cf-connecting-ip: 203.0.113.9` dari soket non-proxy dan
pastikan tag yang diteruskan **tidak** sama dengan tag untuk header itu.

---

## N10-04 (Low, keyakinan tinggi pada mekanisme) — daur arsip N9-03 hanya mengenali state byte-identik

**Ringkas.** Guard baru membandingkan state aktif dengan slot arsip terbaru:

```ts
// web/src/lib/spqrState.ts:330-334
const newest = await loadEraState(sessionId, 0);
const unchanged = newest !== undefined && sameState(newest, current);
```

`sameState` membandingkan `version` dan seluruh byte. Sesi X3DH baru selalu
menghasilkan state awal yang **berbeda** karena `authKey`-nya berbeda. Jadi
rotasi demi rotasi tanpa satu pun pesan v2 tetap menulis state awal era baru ke
slot 0 dan menggeser era lama — persis churn yang N9-03 ingin hentikan.

**Bukti eksekusi (WASM asli, dua era tanpa pesan).**

```
initial state lengths 118 118 identical? false
archive slots after two no-traffic eras: 2
```

**Dampak.** "Tiga era terakhir" masih bisa menyusut jauh lebih cepat pada peer
yang sering re-handshake, sehingga pesan v2 tertunda dari era yang sebenarnya
masih relevan bisa kehilangan arsipnya — sisa N5-01 yang sempit, bukan
kehilangan keamanan. Tes baru hanya menguji dua kali `stateBytes(1)` (state
identik), sehingga ia lulus tanpa membuktikan skenario yang ditulis komentarnya.

**Perbaikan.** Simpan penanda kemajuan per era (mis. generation/`updatedAt`
yang dinaikkan hanya saat `send`/`recv` benar-benar memajukan state), lalu
rotasi hanya bila era berjalan pernah maju. Alternatif: arsipkan hanya saat
state aktif berbeda dari state yang terakhir **ditulis untuk era itu** (bukan
dari slot 0).

**Test.** Dua era dengan `authKey` berbeda dan `states: []` masing-masing harus
menyisakan **satu** slot arsip (era yang benar-benar punya lalu lintas).

---

## N10-05 (Low, keyakinan tinggi) — suite server merah: tes wiring masih menegaskan `clientIpTag`

**Ringkas.** `server/src/middleware/rateLimiter.ts:24` sekarang:

```ts
const secureKeyGenerator = (req: Request): string => clientRateLimitTag(req);
```

Tetapi `server/tests/ipKey.test.ts:77-79` masih menegaskan bentuk lama:

```ts
assert.match(limiter, /const secureKeyGenerator = \(req: Request\): string => clientIpTag\(req\)/);
```

**Bukti eksekusi.** `pnpm --filter nyx-server run test` →

```
✖ wiring limiter: keyGenerator memakai clientIpTag, bukan IP mentah
```

satu-satunya kegagalan dari seluruh suite server.

**Dampak.** CI job unit merah pada HEAD. Tes ini penting (ia menjaga agar tidak
ada IP mentah yang menjadi key limiter), jadi perbaikannya adalah **memperbarui
asersi** ke `clientRateLimitTag(req)` — bukan menghapus atau melonggarkannya.

**Perbaikan.** Ubah regex ke `clientRateLimitTag\(req\)`, dan tambahkan asersi
bahwa `clientRateLimitTag` memprioritaskan tag relay (sudah dicakup
`rateLimitIdentity.test.ts`).

**Test.** Tes itu sendiri; jalankan suite server setelah perubahan.
