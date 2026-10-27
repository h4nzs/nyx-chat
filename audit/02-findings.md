# 02 — Temuan

Format per `audit.md` §7. Urutan: Tinggi → Sedang → Rendah → pengamatan.
Tidak ada temuan **Kritis** yang bisa saya buktikan (kebocoran isi/kunci,
pengambilalihan akun, bypass auth) — yang ada di bawah ini adalah kegagalan
pertahanan berlapis, ketersediaan, dan drift yang membuat kontrol tampak ada.

---

## F-01 — Redemption Privacy Pass tidak pernah `NX`/`EX`: token bisa dipakai ulang tanpa batas & key Redis tumbuh selamanya

**Severity: Tinggi — Keyakinan: Terbukti (direproduksi dengan Redis lokal)**

- **Lokasi:** `server/src/utils/privacyPass.ts:190-198` (dipakai
  `server/src/routes/groups.ts` `/pp/redeem` dan `/sync` lewat
  `utils/syncProofs.ts`).
- **Masalah:** `redis.set(spentKey, '1', 'EX', ttl, 'NX')` memakai bentuk
  variadik yang **diabaikan node-redis v6** — perintah yang benar-benar dikirim
  adalah `SET key value` polos, tanpa expiry dan tanpa `NX`.
- **Skenario:** (a) Anggota grup meminta 10 token, lalu memakai **satu** token
  berulang kali untuk sync tanpa batas → anti-abuse `PP_SYNC_REQUIRED=1` tidak
  menahan apa pun; setiap redemption juga menulis satu key `pp:spent:<sha256>`
  yang **tidak pernah kedaluwarsa** → Redis tumbuh monoton (memori VPS 8 GB
  dibagi Postgres/Redis/4 worker), dan `/pp/redeem` adalah endpoint tanpa sesi,
  jadi penyerang yang memegang token sah bisa membanjiri Redis.
  (b) Token yang dicuri dari storage ter-seal tetap sah 24 jam walau sudah
  di-redemption.
- **Bukti:** pada klien yang dipakai server (`redis@6.2.1`) di Redis lokal:

  ```
  set('k','1','EX',5,'NX')  → OK   (pertama)
  set('k','1','EX',5,'NX')  → OK   (kedua — seharusnya null karena NX)
  ttl('k')                  → -1   (tanpa expiry)

  set('k','1',{EX:5,NX:true}) → OK
  set('k','1',{EX:5,NX:true}) → null   ← bentuk yang benar
  ttl('k')                    → 5
  ```

  Tipe parameter di `ppRedeemToken` ditulis tangan
  (`{ set(key,value,mode:'EX',ttl:number,nx:'NX') }`) sehingga TypeScript tidak
  menangkap mismatch ini; call site di `groups.ts` juga memakai
  `as unknown as Parameters<…>`.
- **Perbaikan minimal:** ganti ke `redis.set(spentKey, '1', { EX: PP_TOKEN_TTL_SEC, NX: true })`
  dan ketik parameter sebagai `Pick<RedisClientType, 'set'>`. Tanpa perubahan format wire.
- **Test yang harus ada:** `server/tests/privacyPass.test.ts` — fake Redis yang
  **hanya** menghormati opsi `{EX,NX}`: (1) redemption kedua = `spent`,
  (2) key punya TTL > 0, (3) token grup lain = `invalid` (binding conversationId).
- **Radius domino:** `/api/groups/sync` (gate bukti), `/api/groups/pp/redeem`,
  `utils/syncProofs.ts`, alert/ops `PP_SYNC_REQUIRED`.

---

## F-02 — Produksi berjalan dalam mode development: cookie sesi tanpa `Secure`, log HTTP memuat identifier & token di query

**Severity: Tinggi — Keyakinan: Terbukti (kode + workflow), dampak sebagian perlu dicek di VPS**

- **Lokasi:** `.github/workflows/deploy.yml:260-263` (pm2 tanpa `NODE_ENV`),
  `server/src/utils/sessionUtils.ts:19-24`, `server/src/app.ts:83,109,161,229,248`,
  `server/src/utils/allowedOrigin.ts:48-63`, `server/src/realtime/gateway.ts:189`.
- **Masalah:** `NODE_ENV` tidak pernah diset untuk `nyx-api`, jadi
  `env.nodeEnv !== 'production'` pada **semua** cabang `isProd`.
- **Skenario:**
  1. `authCookieOptions()` memberi `secure: false`, `sameSite: 'lax'` untuk
     cookie `at`/`rt`/`nyx_install`. Cookie sesi karenanya ikut terkirim pada
     permintaan `http://…` (satu salah-ketik skema / MitM aktif = pencurian
     sesi), dan tidak ada `upgrade-insecure-requests`/HSTS dari helmet.
  2. `app.use(logger("dev"))` aktif → morgan menulis **URL penuh termasuk query**
     ke `pm2 logs`: `/api/users/search?q=<hash identifier>` (blind index,
     identifier stabil yang menghubungkan pencarian), `/embed/:id?token=…`
     (token akses halaman embed), `/api/keys/prekey-bundle/<userId>` (graf).
     Ini bertentangan langsung dengan klaim "log server tidak memuat identifier"
     (`docs/28`) dan dengan komentar di `app.ts:245-247` yang menyatakan morgan
     hanya untuk dev.
  3. `allowedOrigin` menerima `http://app.nyx-app.my.id`, `http://api.…`, dst.
     (`DEV_ORIGINS`) sebagai origin CORS sah.
- **Bukti:** grep `NODE_ENV` di `.github/workflows/` hanya menemukan
  `ops/systemd/*ohttp-relay*`; blok `pm2 start` tidak menyetelnya. `isProd`
  dipakai di 7 tempat dan semuanya jatuh ke cabang dev. `docs/10` §10.20 sudah
  mencatat insiden cookie; belum ada perbaikan `NODE_ENV`.
- **Perbaikan minimal:** set `NODE_ENV=production` pada `pm2 start` (atau
  `env:` di `ecosystem`), **setelah** memverifikasi `JWT_SECRET`/`CSRF_SECRET`
  bukan default (guard `config.ts` akan menolak boot), lalu
  `COOKIE_DOMAIN=.nyx-app.my.id`. Tambahan murah: pindahkan morgan ke
  `logger('tiny')` + `skip: (req) => req.path.startsWith('/api/health')` atau
  hilangkan query (`req.baseUrl + req.path`).
- **Test yang harus ada:** `server/tests/sessionUtils.test.ts` sudah mengunci
  `secure/sameSite/domain`; tambahkan kasus "NODE_ENV tidak diset →
  `startupSignals` memperingatkan" dan satu test sumber bahwa `deploy.yml`
  menyertakan `NODE_ENV=production` (pola `lintGate.test.ts` yang membaca berkas repo).
- **Radius domino:** cookie CSRF (`app.ts:367-378`), logout-all, embed page,
  CORS socket.io, CSP `upgrade-insecure-requests`, job `audit`/`lint` tidak terkait.

---

## F-03 — 10 kerentanan dependensi produksi (3 high); job CI `audit` merah di HEAD

**Severity: Tinggi — Keyakinan: Terbukti (`pnpm audit --prod` dijalankan)**

- **Lokasi:** `pnpm-lock.yaml` (zod <4.6.6 di `server`, `@nyx/shared`, `marketing`;
  `body-parser` <2.4.0 via `express@5`; `undici` <8.12.2 via `link-preview-js`).
- **Masalah:** tiga kerentanan high yang bisa dipicu lewat HTTP, dan gate CI
  `audit` (`.github/workflows/ci.yml:248-263`) gagal tanpa `continue-on-error`.
- **Skenario:**
  - `zod` GHSA-mrhx-c7xc-m3w5 (memory exhaustion pada koleksi ber-`max()`):
    `POST /api/groups/sync` (`tokens` max 500), `POST /messages` dsb. Body 1 MB
    cukup untuk memaksa alokasi besar berulang; endpoint sync **tanpa sesi**.
  - `body-parser` GHSA-27r3-jxmh-p828 (trailing bytes setelah body terkompresi):
    setiap POST `/api/*` dengan `Content-Encoding` → worker cluster 1 GB heap
    (`--max-old-space-size=1024`) bisa dimatikan satu per satu.
  - `undici` GHSA-xjj6-f33q-929c (unhandled error pada banyak
    `content-encoding`): jalur `link-preview-js` mengunduh URL yang dikirim
    pengguna → satu URL jahat bisa memicu unhandled rejection di proses API.
- **Bukti:** keluaran `pnpm audit --prod` (10 kerentanan: 3 high, 5 moderate,
  2 low) ada di `05-baseline.md`. `express@5` mengunci `body-parser@^2.0.x`;
  perbaikan butuh bump eksplisit (express yang menambal atau override).
- **Perbaikan minimal:** bump `zod` ke `>=4.6.6` (cek jitless tetap),
  `body-parser`/`express` ke versi berpatched, dan `undici` via override —
  **lewat `pnpm.overrides`/`pnpm-workspace.yaml`**, bukan `resolutions`
  (lihat F-08). Jalankan `pnpm install` lalu `pnpm audit --prod` sampai bersih.
- **Test yang harus ada:** tidak perlu test unit; gate = job `audit` itu sendiri
  (sudah ada). Tambahkan `deny`-list versi di CI bila ingin lebih tegas.
- **Radius domino:** `@nyx/shared` zod dipakai web+server (jitless), lockfile
  harus di-commit ulang; `marketing` (astro) juga menarik zod/undici.

---

## F-04 — `prisma db push || true` + kolom wajib baru: deploy hijau dengan skema lama

**Severity: Tinggi — Keyakinan: Kuat (mekanisme pasti, eksekusi ke DB prod tidak dijalankan)**

- **Lokasi:** `.github/workflows/deploy.yml:237-238`; `server/prisma/schema.prisma:355-380`
  (`UserHiddenConversation.tokenHash String @unique`, tanpa default),
  `:391-404` (`GroupMailboxItem` baru), `:239-249` (`groupEpoch`, `adminSecretHash`).
- **Masalah:** `prisma db push` yang gagal ditelan `|| true`, lalu pm2 tetap
  di-restart. Rilis ini menambah kolom **NOT NULL + UNIQUE tanpa default** ke
  tabel yang pasti berisi baris di produksi (setiap anggota grup punya baris),
  dan menghapus `deliveryToken` (hard cut tanpa backfill).
- **Skenario:** deploy sukses (hijau), `prisma db push` gagal karena
  `ALTER TABLE … ADD COLUMN "tokenHash" TEXT NOT NULL` pada tabel berisi baris
  → API baru berjalan dengan skema lama → `POST /api/groups/sync`,
  `userHiddenConversation.findMany` dan semua routing grup melempar
  `PrismaClientKnownRequestError` (kolom tidak ada) → discovery grup mati total;
  `messageSweeper`/push juga gagal. Rollback tidak otomatis karena zip lama
  sudah menimpa `server/src`/`dist`.
- **Bukti:** perintah deploy tidak memeriksa exit code. Prisma mendokumentasikan
  bahwa kolom wajib tanpa default tidak bisa ditambahkan ke tabel berisi data;
  Postgres menolak `ADD COLUMN … NOT NULL` pada tabel berisi baris. Saya tidak
  dapat menguji ke DB proyek (tanpa kredensial; `audit.md` melarang
  `db push`) — lihat `06-tidak-diperiksa.md`.
- **Perbaikan minimal:** hapus `|| true` (biarkan deploy merah), dan beri jalur
  migrasi nyata sebelum rollout: kolom nullable + backfill + `@@unique` terpisah,
  atau reset yang disengaja dengan backup. Minimal: cek `prisma db push` lalu
  `prisma db execute` verifikasi kolom (`SELECT column_name …`) sebelum restart.
- **Test yang harus ada:** `server/tests/deploySchema.test.ts` — baca
  `deploy.yml` dan gagalkan bila `db push` diikuti `|| true`; plus test sumber
  bahwa setiap kolom baru non-null di `schema.prisma` punya default/backfill note.
- **Radius domino:** seluruh jalur grup/token/mailbox, KT snapshot (membaca DB),
  backup harian, `scripts/reset-test-env.ts` (dev).

---

## F-05 — Guard PQ-only merah di HEAD; pengecualian baru tidak tercatat

**Severity: Sedang — Keyakinan: Terbukti**

- **Lokasi:** `scripts/check-pq-only.mjs`, `scripts/pq-only-exceptions.json`,
  `server/src/utils/privacyPass.ts`, `web/src/lib/privacyPass.ts`;
  job CI `.github/workflows/ci.yml:155`.
- **Masalah:** dua berkas baru memakai `RSABSSA` (RSA klasik) tanpa entri
  exception, jadi guard gagal. Pemakaiannya sendiri **disengaja** dan
  didokumentasikan (`docs/37` §37.9.4: token Privacy Pass bukan unforgeability
  pasca-kuantum), tetapi manifest pengecualian adalah satu-satunya tempat
  "kenapa primitif klasik ini ada" dicatat — dan ia tidak diperbarui.
- **Skenario:** CI `lint` merah → seluruh PR diblokir; atau, lebih buruk, orang
  menambahkan baseline (`--write`) tanpa alasan sehingga guard berhenti
  membedakan "klasik yang dibutuhkan format v2" dari "jalur v1 baru".
- **Bukti:** keluaran guard persis:
  `server/src/utils/privacyPass.ts: RSABSSA 0 -> 4 (klasik-only baru)` dan
  `web/src/lib/privacyPass.ts: RSABSSA 0 -> 3`.
- **Perbaikan minimal:** tambahkan dua entri `privacyPass.ts` ke
  `pq-only-exceptions.json` dengan `tier: "tier-b"`/`hybrid-v2-identity`
  (pilih yang jujur: ini **bukan** v1 fallback, ini anti-abuse) + `rationale`
  dan `removalGate` yang menyebut gate BRaccoon (`docs/37` §37.9.5). Jangan
  mengubah baseline.
- **Test yang harus ada:** guard sudah menjadi test; tambahkan assertion bahwa
  `PP_SUITE` tidak dipakai untuk apa pun selain anti-abuse (grep sumber).
- **Radius domino:** `docs/35` §35.11 (status PQ), `docs/36` (paket review),
  `AGENTS.md` (klaim "PQ-only").

---

## F-06 — `OHTTP_TOKEN_MODE=off` memakai rahasia acak **per proses**; di pm2 cluster relay→gateway gagal 403

**Severity: Sedang — Keyakinan: Kuat (kode pasti; topologi dari `deploy.yml`)**

- **Lokasi:** `server/src/ohttp/config.ts:139-146` (`internalToken: randomBytes(32)`),
  `server/src/routes/ohttp.ts:69-78` dan `:117-133`, `app.ts:384-402`,
  `.github/workflows/deploy.yml:260-263` (`-i max`).
- **Masalah:** pada mode `off`, `/relay` menandatangani token lalu memanggil
  `config.relayTarget` (default `http://127.0.0.1:$PORT/api/ohttp/gateway`)
  dengan header `x-nyx-ohttp-internal` berisi token acak yang dibuat saat modul
  dimuat. Tiap worker cluster punya token berbeda, dan request ke `127.0.0.1:$PORT`
  didistribusikan ke worker mana pun.
- **Skenario:** operator menyalakan `OHTTP_ENABLED=1 OHTTP_TOKEN_MODE=off` untuk
  self-host loopback (alasan mode ini ada: relay tanpa sesi). Di produksi
  `pm2 -i max` (4 worker), ~3/4 request `/api/ohttp/relay` dijawab
  `403 OHTTP_GATEWAY_FORBIDDEN` → pencarian/prekey lewat OHTTP gagal acak,
  sementara test lokal (satu proses) hijau.
- **Bukti:** kode di atas; `docs/37` §37.4 P7 hanya menyatakan token-off
  "ditolak di proses relay terpisah", tidak menyebut klaster API.
- **Perbaikan minimal:** turunkan `internalToken` dari env
  (`OHTTP_INTERNAL_TOKEN`, wajib sama di semua worker) atau dari
  `HMAC(JWT_SECRET, 'ohttp-internal')` sehingga deterministik per deployment;
  tolak boot bila `OHTTP_TOKEN_MODE=off` dan variabel tidak ada.
- **Test yang harus ada:** `server/tests/ohttpRelay.test.ts` — dua instance
  config dengan env sama harus menghasilkan token yang sama; mode `off` tanpa
  env = throw.
- **Radius domino:** `ops/systemd/nyx-ohttp-relay*` (mode `on` tidak terpengaruh),
  `docs/35` §35.7 Fase 3, klien `ohttpClient`.

---

## F-07 — Job singleton berjalan di **setiap** worker cluster; exporter metrik hanya hidup di satu worker

**Severity: Sedang — Keyakinan: Terbukti (kode + `deploy.yml`)**

- **Lokasi:** `server/src/index.ts:70-77` (`startMessageSweeper`,
  `startSystemSweeper`, `startKtSnapshotUploader`, `startPirSnapshotRefresher`,
  `startMetricsServer`), `server/src/utils/metricsEndpoint.ts:58-65`
  (`on('error')` hanya log).
- **Masalah:** tidak ada leader election/lock; `pm2 -i max` menjalankan keempat
  job di semua worker. Exporter `:9464` hanya bisa di-bind satu proses; tiga
  lainnya mencatat error lalu lanjut.
- **Skenario:**
  - `04:15` → 4× `refreshPirSnapshot` serentak: masing-masing membaca **seluruh**
    user ber-`oprfIndex`, membangun snapshot, menulis file yang sama
    (`<path>.<pid>.<ts>.tmp` lalu `rename` — aman secara atomik tetapi saling
    menimpa), dan memanggil `/admin/rebuild` 4× di sidecar. Puncak memori 4× +
    rebuild 4× dengan timeout 1 jam.
  - `startKtSnapshotUploader` → 4 upload arsip yang sama ke R2 (biaya + race).
  - `messageSweeper`/`cleanup` → 4× query hapus bersamaan (deadlock/seq-scan
    contention di Postgres 2 GB `shared_buffers`).
  - Metrik `nyx_*` (permintaan, rate-limit, KT, OHTTP) hanya mencerminkan
    ~1/4 trafik → alert `Nyx*` memakai angka yang salah, bukan sekadar kasar.
- **Bukti:** `-i max` di `deploy.yml:260-263`; `index.ts` memanggil job tanpa
  guard; `metricsEndpoint` menelan `EADDRINUSE`.
- **Perbaikan minimal:** satu lock Redis per job (`SET job:<name> <instance> NX EX <ttl>`,
  pola Lua yang sudah ada di `redisBridge.ts`) dan `METRICS_PORT` per worker
  (atau exporter di proses terpisah / `pm2 -i 1` untuk proses metrik). Untuk
  metrik, paling murah: dokumentasikan bahwa exporter harus jalan di proses
  tunggal dan set `METRICS_PORT=0` di worker lain lewat `NODE_APP_INSTANCE`
  (pm2 menyediakannya).
- **Test yang harus ada:** `server/tests/jobLock.test.ts` — fake Redis: lock
  dipegang instance A → instance B melewati putaran; lock kedaluwarsa → jalan.
- **Radius domino:** `ops/prometheus` (alert yang memakai metrik itu),
  `docs/10` §10.12 (klaim enam exporter), biaya R2/PIR.

---

## F-08 — `resolutions` di root `package.json` diabaikan pnpm; 28 pin keamanan tidak berlaku

**Severity: Sedang — Keyakinan: Terbukti**

- **Lokasi:** `package.json:18-47` (`"resolutions"`), `pnpm-workspace.yaml`
  (`overrides:` hanya `mysql2`, `deepmerge-ts`), `pnpm-lock.yaml:7-9`.
- **Masalah:** `resolutions` adalah field Yarn. pnpm hanya membaca
  `pnpm.overrides` / `overrides` di `pnpm-workspace.yaml`. Lockfile membuktikan
  hanya dua override yang diterapkan.
- **Skenario:** pin `tar`, `ws`, `undici`, `axios`, `path-to-regexp`,
  `brace-expansion`, dst. memberi rasa aman yang salah. Saat advisory baru
  muncul, kontributor "menambal" dengan menambah baris di `resolutions` — tidak
  ada efeknya, dan F-03 terus terjadi.
- **Bukti:** `overrides:` di lock hanya dua entri; `minimatch@5.1.9` masih ada
  padahal pin menyebut `>=10.2.3` (pin tidak diterapkan). `pnpm install`
  **tidak** memberi peringatan. Bonus: `pnpm-workspace.yaml`
  `allowBuilds: puppeteer: "set this to true or false"` — nilai placeholder
  yang bukan boolean.
- **Perbaikan minimal:** pindahkan entri yang masih relevan ke `overrides:` di
  `pnpm-workspace.yaml`, hapus `resolutions` dari `package.json`, perbaiki nilai
  `puppeteer`, lalu regenerasi lockfile. Jangan menyalin semua 28 baris tanpa
  memeriksa apakah versinya masih masuk akal.
- **Test yang harus ada:** `scripts/check-overrides.mjs` di job `audit`:
  gagalkan bila `package.json` punya `resolutions`, atau bila pin di
  `pnpm-workspace.yaml` tidak muncul di blok `overrides:` lockfile.
- **Radius domino:** seluruh rantai dependensi; `docs/10` §10.10 (prosedur patch).

---

## F-09 — Verifikasi KT gagal-terbuka saat error tak terduga: pesan tetap terkirim tanpa peringatan apa pun

**Severity: Sedang — Keyakinan: Terbukti (kode) / keputusan sadar sebagian**

- **Lokasi:** `web/src/lib/peerIdentityTrust.ts:331-341` (`catch` → `verdict: null`),
  `:311` (`unknown-subject` tidak dicatat), `:206-208`.
- **Masalah:** kegagalan apa pun di jalur KT (WASM, jaringan, bug parsing,
  subject tak bisa diturunkan) diperlakukan sebagai "tidak ada pemeriksaan".
  Tidak ada indikator UI bahwa kontak itu **belum** diverifikasi log.
- **Skenario:** server/log KT dikompromikan atau diblokir (mis. `KT_QUERY_URL`
  mati), penyerang menyajikan prekey bundle baru untuk kontak yang sudah
  dipin. `observePeerIdentityKey` mengembalikan `{status:'new'}` untuk kontak
  yang belum punya pin, atau `changed` bila pin ada — tetapi untuk kontak yang
  **sudah** dipin dan kunci **sama**, verdict `null` tidak pernah
  memperingatkan bahwa pemeriksaan log tidak berjalan. Pengguna melihat
  percakapan normal, sementara jaminan "kunci terverifikasi log" tidak berlaku
  dan tidak ada yang memberi tahu.
- **Bukti:** komentar kode menyebut ini disengaja ("tidak boleh memblokir
  pengiriman karena bug lokal"), dan `docs/34` mendaftarkan residual; yang
  **tidak** ada adalah permukaan UI/status yang membuatnya terlihat, padahal
  `ktAvailability` sudah ada untuk banner. Jadi ini bukan bug alur, tapi klaim
  yang lebih luas daripada kenyataan.
- **Perbaikan minimal:** tulis `ktLastVerdict: 'unavailable'` pada error
  (bukan `null`) dan tampilkan indikator kecil di header chat + status di
  `SessionManagerPage`/banner KT yang sudah direncanakan. Jangan memblokir kirim.
- **Test yang harus ada:** `web/src/lib/__tests__/peerIdentityTrust.test.ts` —
  `checkKeyTransparency` melempar → record memuat `unavailable`, `status` tetap
  `new`/`unchanged`, dan tidak ada pin yang ditimpa.
- **Radius domino:** `docs/34` §residual, banner `ktAvailability`, UI trust.

---

## F-10 — `/api/groups/sync` tanpa batas ukuran respons (dokumen mengklaim ≤256 KB / ≤200 item)

**Severity: Sedang — Keyakinan: Terbukti**

- **Lokasi:** `server/src/utils/groupSync.ts:39` (`MAX_SYNC_TOKENS = 500`),
  `server/src/routes/groups.ts:120-190` (respons `conversations` penuh),
  `docs/37` §37.3.3 ("batas ukuran respons (≤ 256 KB, ≤ 200 item)").
- **Masalah:** tidak ada pemotongan byte maupun jumlah item pada respons sync;
  `encryptedMetadata` tiap grup dikirim utuh untuk setiap token yang sah.
- **Skenario:** anggota dengan 500 keanggotaan (atau beberapa token yang
  disiapkan) meminta satu sync; respons bisa mencapai beberapa MB. Endpoint ini
  **tanpa sesi**, jadi biaya parsing JSON + memori ada di server, dan klien
  jahat bisa mengulang 120×/menit per token (batas bucket) → amplifikasi
  request ~22 KB → respons besar berulang.
- **Bukti:** 500 token × metadata; `res.json` tanpa `nextCursor`/`truncated`.
  Dokumen menyebut angka yang tidak ada di kode.
- **Perbaikan minimal:** batasi `MAX_SYNC_TOKENS` ke 200 (sesuai dokumen) **atau**
  potong respons berdasarkan byte (mis. 256 KB) dan kembalikan `truncated: true`;
  klien melanjutkan dengan halaman berikutnya. Perbarui dokumen agar sama.
- **Test yang harus ada:** `server/tests/groupSync.test.ts` — 500 token → hasil
  ≤ batas, `truncated` benar, dan urutan index tetap menunjuk token asli.
- **Radius domino:** `web/src/lib/groupSync.ts` (`parseSyncBody`), metrik
  `nyx_group_sync_total`, docs/12.

---

## F-11 — `consumeLinkToken` bukan operasi atomik (komentar menyatakan sebaliknya)

**Severity: Rendah — Keyakinan: Terbukti**

- **Lokasi:** `server/src/utils/deviceLinking.ts:158-170`.
- **Masalah:** `readLinkToken` (GET) lalu `del` — dua klaim bersamaan dengan
  token yang sama sama-sama lolos sebelum `del`, menghasilkan dua `link_pending`.
  Komentar menyebut "race: GET lalu DEL" seolah itu yang mencegah.
- **Skenario:** penyerang yang pernah melihat QR (screenshot) dan pemilik sah
  memindai hampir bersamaan → dua permintaan tautan muncul di perangkat lama;
  yang pertama disetujui menang, tetapi UI bisa menampilkan dua permintaan dan
  Device row kedua sempat dibuat (lalu dihapus oleh jalur race di `/approve`).
  Dampak terbatas: tetap butuh persetujuan perangkat lama + password akun.
- **Bukti:** kode; token 256-bit sehingga tidak bisa ditebak.
- **Perbaikan minimal:** `GETDEL` (`redisClient.getDel`) atau Lua
  `if redis.call('GET',k) then redis.call('DEL',k) return v end` lalu buka seal.
- **Test yang harus ada:** `server/tests/deviceLinking.test.ts` — store yang
  mensimulasikan `getDel`; dua `consume` berurutan → yang kedua `null`.
- **Radius domino:** `/link/claim`, UI `LinkDeviceModal`.

---

## F-12 — Clippy `transport-sidecar` merah (3 lint) dan tidak ada di CI

**Severity: Rendah — Keyakinan: Terbukti**

- **Lokasi:** `server/transport-sidecar/src/fuzz.rs:217`, `:248`,
  `src/protocol.rs:201`; `.github/workflows/ci.yml` job `e2e-chrome` hanya
  `cargo test` + `cargo build --release`.
- **Masalah:** `-D warnings` gagal; tidak ada job yang menjalankannya, sehingga
  `AGENTS.md` (yang menyebut clippy sebagai bagian toolchain) dan kenyataan
  berbeda.
- **Skenario:** kontributor menganggap sidecar "bersih" karena CI hijau;
  lint yang sama (mis. `question_mark` pada batas frame) terus menumpuk di
  berkas protokol yang justru paling sensitif.
- **Bukti:** keluaran clippy di `05-baseline.md`.
- **Perbaikan minimal:** perbaiki tiga lint (`checked_div`, `is_multiple_of`,
  `?`) dan tambahkan langkah clippy ke job sidecar (atau job `pir-sidecar`
  yang sudah ada).
- **Test yang harus ada:** tidak ada test baru; gate = CI.
- **Radius domino:** fuzz campaign (`src/fuzz.rs`), `docs/11` §11.1c.

---

## F-13 — Drift env: 8 variabel server tidak ada di `.env.example`, satu wajib di produksi

**Severity: Rendah — Keyakinan: Terbukti**

- **Lokasi:** `.env.example`; `server/src/utils/privacyPass.ts:126-133`
  (`PP_ISSUER_PRIVATE_JWK` **wajib** bila `NODE_ENV=production`),
  `server/src/ohttp/{config,relay}.ts` (`OHTTP_RELAY_*`, `OHTTP_GATEWAY_*`),
  `server/src/routes/groups.ts` (`CREDENTIAL_SUITE_ALLOWLIST`).
- **Masalah:** operator yang menyalakan `NODE_ENV=production` (F-02) dan
  `PP_SYNC_REQUIRED=1` akan mendapat 500 dari `/api/groups/pp/issuer` dan
  `/pp/issue` karena kunci issuer tidak terdokumentasi di template; sync grup
  lalu ditolak `PP_PROOF_REQUIRED` → discovery grup mati.
- **Skenario:** deploy mengikuti `.env.example` → fitur grup rusak tanpa pesan
  yang menunjuk env yang hilang.
- **Bukti:** skrip pembanding `process.env.*` vs `.env.example` (lihat
  `notes/I-infra.md`): 8 nama tidak ada di template, 4 tidak disebut di `docs/`.
- **Perbaikan minimal:** tambahkan ke `.env.example` (dengan komentar "wajib
  bila PP_SYNC_REQUIRED=1") dan ke `docs/10` tabel env; sebut `OHTTP_RELAY_*`
  di sana dengan tautan ke `ops/systemd/nyx-ohttp-relay.env.example`.
- **Test yang harus ada:** `server/tests/envExample.test.ts` — setiap
  `process.env.X` di `server/src` punya entri di `.env.example`.
- **Radius domino:** `docs/10`, `ops/systemd/*.env.example`, deploy.

---

## F-14 — Drift dokumentasi (ringkas; detail di `04-docs-drift.md`)

**Severity: Rendah — Keyakinan: Terbukti**

- **Lokasi/Isi:** `AGENTS.md` menyebut Dexie **v13** padahal `web/src/lib/db.ts:435`
  sudah v16; `AGENTS.md` menyebut 194 warning lint, nyatanya 193;
  `CONTRIBUTING.md:22` menyebut `pnpm dev` (tidak ada di root);
  `docs/37` §37.3.3 menyebut batas respons sync 200 item/256 KB (F-10);
  `docs/37` §37.4 P0 menyebut DB "di-reset" tetapi `deploy.yml` tidak punya
  langkah itu (F-04).
- **Perbaikan minimal:** satu commit dokumentasi; jangan mengubah kode hanya
  untuk menyesuaikan dokumen yang salah.

---

## F-15 — Actions tidak dipin ke SHA; `dtolnay/rust-toolchain@master` mengikuti branch bergerak

**Severity: Sedang — Keyakinan: Terbukti**

- **Lokasi:** `.github/workflows/ci.yml:73,117`, `.github/workflows/deploy.yml:40`
  (`dtolnay/rust-toolchain@master`); semua `uses:` lain memakai tag mayor
  (`actions/checkout@v4`/`@v7`, `pnpm/action-setup@v6`, `setup-go@v5`, dst).
  `permissions:` hanya ada di `codeql.yml:16`; `ci.yml` dan `deploy.yml` tidak
  mendeklarasikannya.
- **Masalah:** `@master` adalah branch yang bisa dipindahkan kapan saja, dan tag
  mayor juga bisa digeser. `deploy.yml` menjalankan langkah dengan akses
  `secrets` VPS — kompromi action berarti akses ke host produksi, bukan hanya
  ke runner.
- **Skenario:** pemilik repo action (atau akun yang diambil alih) menggeser
  `master` → job `e2e-chrome`/deploy menjalankan kode baru di runner yang punya
  `SSH_PRIVATE_KEY`/kredensial deploy → penyerang membaca secrets atau menulis
  ke VPS. Efek samping kedua: build tidak reprodusibel (versi toolchain berubah
  tanpa perubahan repo).
- **Bukti:** `grep -rn "uses:" .github/workflows` — tidak ada satu pun pin
  `@<40-hex>`; `dtolnay/rust-toolchain@master` muncul dua kali di CI dan sekali
  di deploy. `permissions:` absen di `ci.yml`/`deploy.yml`, sehingga token
  `GITHUB_TOKEN` memakai default repo (bisa `write` bila disetel begitu).
- **Perbaikan minimal:** ganti `@master`/tag dengan SHA 40-hex + komentar versi;
  tambahkan `permissions: contents: read` di `ci.yml` dan permission minimum
  yang benar-benar dipakai di `deploy.yml`. Tidak ada perubahan logika job.
- **Test yang harus ada:** gate ringan `scripts/check-actions-pins.mjs` di job
  `lint` (gagalkan `uses: …@v\d` atau `@master`) — atau serahkan ke Dependabot
  dengan `pin-digests`.
- **Radius domino:** seluruh workflow, `docs/25`; tidak menyentuh runtime.

---

## Pengamatan desain (bukan bug)

- **D1 — MIN_CLIENT_VERSION fail-open.** `utils/clientVersion.ts` meloloskan
  request tanpa header versi. Alasannya terdokumentasi (klien lama tidak boleh
  mati), tetapi artinya gate ini tidak bisa dipakai sebagai kontrol keamanan —
  hanya sebagai peringatan. Kalau nanti gate ini dijadikan syarat cutover,
  ia harus fail-closed untuk metode mutasi.
  **[DITUTUP 2026-10-27]** Mode ketat opt-in `CLIENT_VERSION_REQUIRE_MUTATIONS=1`:
  mutasi tanpa header versi → `426 CLIENT_VERSION_REQUIRED` (metrik
  `strict-no-header`), baca tetap fail-open, default tidak berubah
  (`docs/10` §10.14, `tests/clientVersion.test.ts`).
- **D2 — REST `GET /api/messages/:conversationId` tanpa cek keanggotaan**
  (trade-off `docs/03` §3.7, Opaque Mailbox) masih seperti yang didokumentasikan.
  Tidak saya laporkan sebagai bug; yang berubah: token grup sekarang tersimpan
  sebagai hash, sehingga dump DB tidak bisa dipakai membaca mailbox.
- **D3 — Tag mailbox `HMAC(memberToken)` terlihat server.** Server memegang
  hash token + tag; saat pull ia bisa menghitung tag untuk token yang
  dipresentasikan. Ini menghapus klaim "server tidak bisa mengaitkan item ke
  penerima" pada **satu** item yang sedang dipull, tetapi tidak membentuk graf
  requester→fulfiller. Dokumen `docs/37` §37.3.2 sudah menyatakan batas ini
  secara implisit; layak ditulis eksplisit.
- **D4 — `CREDENTIAL_SUITE_ALLOWLIST` kosong = fail-closed** dan tidak ada
  issuer di build ini. Positif (tidak ada klaim fitur hidup), tetapi berarti
  `POST /:id/credential/present` selalu 403 — pastikan tidak ada klien yang
  menganggapnya jalur hidup.
- **D5 — Duplikasi konstruksi frame KICK** di dua cabang `main.rs:385-405` dan
  `:446-466`, padahal `AGENTS.md` meminta logika framing di `protocol.rs`.
  Bukan bug, tetapi persis kelas duplikasi yang fuzz target dibuat untuk dicegah.
- **D6 — Dua test paritas menguji TEKS SUMBER, bukan perilaku.**
  `server/tests/gatewayParity.test.ts:243` mencocokkan regex
  `checkRateLimit\(userId, 'chat_message', …\)` dan
  `server/tests/redisIdentity.test.ts:158` mencocokkan literal
  literal ``sAdd(`burner:room:${roomId}`, await sealIdentity(userId))`` terhadap isi
  `realtimeHandlers.ts` yang dibaca sebagai string. Keduanya lulus di HEAD,
  tetapi refactor setara (mis. membungkus limit dalam helper) memerahkannya —
  dan sebaliknya, perubahan perilaku bisa lolos selama teks yang dicari masih
  ada. Bukan bug; jelaskan di komentar test atau ganti dengan uji perilaku
  (fake Redis yang menghitung INCR).
  **[DITUTUP 2026-10-27]** Registrasi gateway menjadi `wssInboundTable()` dan
  routing `nyx:downstream` menjadi `wssDownstreamRoute()` (keduanya dipakai
  runtime dan diuji sebagai perilaku); guard handler diekstrak
  (`makeGuardedOn`/`createHandlerFailureReporter`) sehingga bisa dijalankan
  tanpa socket; wiring identitas Redis diuji dengan Redis pencatat +
  `openIdentity`, bukan literal. Sisa pemindaian sumber diberi komentar alasan
  (inventaris `case` dan properti *absen*).
- **D7 — Seal at-rest gagal-terbuka ke plaintext.** `keychainDb.ts:33-47`
  (`encryptValueAtRest`) mengembalikan nilai **apa adanya** bila `masterSeed`
  tidak tersedia atau `encrypt_session_key` melempar — hanya `console.warn`.
  Konsekuensi: `Message.seq`, `senderId`, `repliedToId`, `expiresAt`,
  `Conversation.isGroup` (lihat `localAtRest.ts:29-38`) bisa tersimpan plaintext
  di IndexedDB pada kondisi itu, padahal `docs/04` §4.8 menyiratkan nilai baru
  selalu di-wrapped (hanya baris lama yang plaintext). Bukan kebocoran isi
  pesan, tetapi melemahkan klaim "struktur lokal ter-seal" pada model ancaman
  perangkat dicuri (`docs/28`). Bila disengaja (lebih baik plaintext daripada
  gagal menulis), dokumentasikan; bila tidak, lebih aman melempar/melewati
  penulisan daripada menurunkan jaminan diam-diam.
  **[DITUTUP 2026-10-27]** Fail-closed: `AtRestSealUnavailableError`, penulisan
  dilewati, baris lama tetap terbaca (`docs/04` §4.8,
  `web/src/lib/__tests__/atRestFailClosed.test.ts`).

---

## Konfirmasi positif (diperiksa dan benar)

- **PQ fail-closed di klien.** `web/src/utils/crypto.ts:3087-3105` menolak
  bundle tanpa `pqIdentityKey`/`pqKey`/`signingKeyV2` ("Post-Quantum Handshake
  Mandatory"), dan `deriveSessionKeyAsRecipient` menolak `handshakeVersion !== 2`
  (`:3180`). Tidak ada fallback DH X25519 diam-diam di jalur kirim/terima.
- **Server tetap menerima bundle klasik** tetapi menandainya
  `nyx_legacy_v1_usage_total{path="prekey-bundle"|"device-link"}` — residual
  yang terlihat, bukan diam.
- **CSRF per-instalasi** (`app.ts:355-382`) + `/api/groups` di-mount sebelum
  CSRF **karena** semua route-nya token-first tanpa cookie — konsisten dan
  dijelaskan; tidak ada route ber-cookie di prefix itu.
- **OHTTP allowlist sempit** (`packages/shared/src/ohttp.ts:381-388`), target
  relay/gateway dari konfigurasi (bukan input klien), header identitas dibuang
  (`sanitizeOhttpForwardHeaders`), body sync dibatasi 64 KB, dan token OHTTP
  ber-TTL 120 s **ditolak di luar allowlist** (`middleware/auth.ts:29-33`).
- **Token grup/member:** hanya SHA-256 yang persist (`tokenHash @unique`),
  perbandingan timing-safe (`credentialTokenMatches`), epoch + expiry ditegakkan
  di route **dan** di `groupAccess`, rotasi memindahkan semua baris anggota dalam
  satu transaksi.
- **KT mismatch tidak pernah menjadi pin** dan memicu peringatan
  `security_key_changed` (`peerIdentityTrust.ts:218-246`); monitor KT
  fail-closed (`runKtMonitorOnce` hanya menulis state setelah verifikasi).
- **Mailbox:** `kind` enum tertutup, payload ≤8 KB, ≤32 item/post, TTL 7 hari,
  cursor komposit, GC terhubung ke `jobs/cleanup.ts:227`.
- **i18n:** 7 namespace × 4 bahasa, **0 kunci hilang / 0 kunci yatim** (dicek
  dengan skrip pembanding flatten).
- **Pendaftaran test server:** 83/83 berkas `server/tests/*.test.ts` terdaftar
  di skrip `test` (tidak ada test yang tidak pernah jalan).
- **DR oracle:** `tools/dr-oracle` build+vet+test+`-check` lulus — vektor
  komit identik dengan regenerasi (X3DH v2/KEM/kdfChain/AEAD).
- **SSRF link preview tertutup, termasuk DNS rebinding.**
  `server/src/utils/secureLinkPreview.ts` hanya mengizinkan `http(s)`, memvalidasi
  setiap hop redirect (maks 5), dan `resolveDns` menolak `private`/`loopback`/
  `linkLocal`/`reserved`/`multicast`. Yang membuatnya bukan sekadar validasi:
  `link-preview-js` versi terpasang **mem-pin koneksi** ke alamat hasil resolusi
  (`prepareFetch` → dispatcher `connect.lookup` untuk HTTPS, hostname ditulis
  ulang untuk HTTP), jadi resolver yang berubah saat fetch tidak bisa
  mengarahkan request ke IP internal. Residual kecil: HEAD pada tahap validasi
  redirect memakai `fetch` biasa (resolusi kedua), tetapi hanya status/lokasi
  yang dibaca dan tidak pernah dikembalikan ke klien.
- **Tidak ada kredensial sesi yang ditulis JS.** `tokenStorage.ts` hanya menulis
  `embed_at` (nama terpisah dari cookie `at`), `Secure`, dan umurnya = `exp`
  token; komentar kontrak melarang menulis `at` dari JS.
- **Wipe lokal mendahulukan pencabutan sesi server.** `nukeProtocol.ts:40`
  memanggil `/api/auth/logout-all` sebelum menghapus state lokal, sesuai
  kontrak `AGENTS.md` (cookie HttpOnly tidak bisa dihapus klien).
- **Atestasi:** verifikasi rantai fail-closed; root kedaluwarsa/`nextUpdate`
  lewat hanya menghasilkan peringatan boot + gauge + alert, bukan boot gagal.
