# Changelog

All notable changes to this project will be documented in this file.

## 📊 Arsip riwayat link: metrik, alarm, cache partisipan grup, dan angka terukur (2026-10-30)

Operasi arsip riwayat sekarang terukur: `nyx_link_history_ops_total{op,result}`
(`presign|ready|abort|download|consume` × `ok|denied|missing|error`, tanpa label
identitas). `denied` = penolakan kebijakan 4xx, `missing` = TTL habis / sudah
dikonsumsi, `error` = kegagalan infrastruktur. Alarm
`NyxLinkHistoryConsumeFailing` menyala bila `consume` gagal (arsip sudah diimpor
tetapi objeknya tertinggal di R2 — klien hanya mencetak `console.warn`), lengkap
dengan kasus drill menyala **dan** tidak menyala.

Arsip juga membawa `groupCachedParticipants` (id anggota grup, bukan rahasia):
tanpa itu grup hasil impor tampil tanpa daftar anggota sampai server mengirim
ulang cache-nya.

Benchmark 10k pesan (fixture identik dengan `backupBench`, harness
`linkHistoryBench`): arsip **3,46 MB / 17 frame**, ekspor 932 ms, impor 240 ms,
puncak heap 106 MB. Penyegelan ulang + tulis IndexedDB tidak termasuk (penulis
di-inject), jadi angka itu batas bawah.

Paginasi `seq` setelah impor dikunci `olderPageCursor` + test yang memaginasi
arsip nyata: halaman berikutnya menyambung tanpa duplikat dan tanpa lompatan.

Suite E2E kini **memaksa** `VITE_API_URL=/api`: bila `web/.env` berisi URL API
absolut (mis. produksi), seluruh suite sebelumnya menulis ke sana — registrasi
akun uji dan pesan sungguhan — sementara spec mengira sedang menguji stack lokal.

## 🔗 Arsip riwayat untuk perangkat hasil link — kontak, percakapan, dan pesan (2026-10-29)

Link perangkat (`/link`) membuat **identitas baru**, jadi menyalin baris Dexie
apa adanya menghasilkan riwayat kosong: `content`, `senderName`, `fileMeta`
disegel kunci vault = turunan identity private key yang **lama**. Sekarang
perangkat lama mengekspor riwayat sebagai **objek domain terdekripsi**, menyegel
kunci arsip acak 32 byte ke X-Wing public key perangkat baru (`pq_box_seal_v2`,
envelope `NYS2`), lalu mengunggahnya ke R2; server hanya menyimpan pointer
(`size`, `digest`, `sealedKey`) dan tidak pernah melihat isi maupun kuncinya.

Kontainer tetap `NYXB` v1 (tanpa perubahan format/versi/AAD), tetapi setiap
chunk membawa penanda `k:"history"` **di dalam plaintext AEAD** — jadi arsip ini
ditolak oleh "Restore from .nyxbak" dan sebaliknya. Kunci objek
`link-history/<HMAC(deviceId)>.nyxhist`; state di Redis (`link_history:<deviceId>`)
ber-TTL 30 menit dan dihapus setelah impor (`consume`), dengan lifecycle rule
sebagai jaring.

Ekspor memakai pembaca yang sudah ada (`getAllContacts`,
`shadowVault.getAllConversations`, dan `decodeMessageRecord` yang diekstrak dari
`parseRecordsToMessages`); impor memakai penulis yang sudah ada
(`saveContactRecord`, `saveConversation`, `upsertMessages` dalam batch 250)
sehingga data disegel ulang dengan identitas baru. Yang tidak ikut (sengaja):
pesan kedaluwarsa, view-once, `waiting_for_key`, centang baca, dan seluruh state
kripto (ratchet/sender-key/prekey) yang terikat identitas lama. `seq`
dipertahankan supaya "muat pesan lama" di perangkat baru tetap punya kursor.

Melengkapi temuan §40.2: setelah impor, `pushContactBundle()` menulis blob kontak
identitas baru ke server dan `loadConversations()` me-merge percakapan hasil
impor ke sidebar. `consume` yang gagal (putus jaringan tepat setelah impor)
tidak menggagalkan impor — objek yatim dihapus TTL/lifecycle.

Sebelum mengunggah, perangkat lama membaca kuota efektifnya dari
`GET /link/history/limits` (angka yang sama dengan penegakan presign; 25 MB
untuk akun belum terverifikasi) dan membatalkan ekspor bila arsip melebihi
kuota — dengan kedua angka di pesan, bukan 400 dari presign setelah puluhan MB
terkirim. `abort` tetap dipanggil supaya perangkat baru tidak menunggu 60 detik.

Impor yang gagal (jaringan, tab ditutup, kuota browser) tidak membuang arsip:
penanda boolean `nyx_link_history_pending` di `kvStore` (tanpa timestamp: waktu
presisi per kejadian adalah metadata aktivitas) membuat app start berikutnya
mencoba **sekali** lagi (`autoRetryLinkedHistory`, hanya setelah vault terbuka dan
dijaga single-flight agar file 10 MB tidak diunduh dua kali), dan Settings →
Active Sessions menampilkan tombol "Ambil riwayat dari perangkat sebelumnya"
selama arsipnya masih ada. Penanda dibersihkan pada sukses maupun saat server
menjawab `{state:'none'}` (TTL habis) — tidak menggantung selamanya.

Tes: `web/src/lib/__tests__/linkHistoryMessages.test.ts` (proyeksi pesan) +
kasus batch/progres di `linkHistory.test.ts`, 13 kasus server di
`server/tests/linkHistory.test.ts`, dan `web/e2e/deviceLinking.spec.ts` yang
menyemai tiga pesan di perangkat lama lalu membacanya kembali dengan kunci vault
identitas baru setelah link (dijalankan nyata, lulus). Desain lengkap:
`docs/40`.

## 🔗 Blob kontak server ditulis ulang setelah link — perangkat baru tidak lagi gagal memulihkan kontak (2026-10-29)

`users.encryptedContactBundle` disegel kunci vault = BLAKE2b-256(identity
private key) (`shadowVaultDb.getVaultKey`), bukan `masterSeed`. Link perangkat
membuat **identitas baru**, jadi blob yang diunggah identitas lama tidak bisa
dibuka lagi oleh perangkat hasil link: setiap `loadConversations` mencetak
"Bundle korup/tak dikenal", restore kontak berhenti sebagai kegagalan senyap,
dan ciphertext mati itu tetap tersimpan di server selamanya.

Perbaikan dua bagian. **(1)** `pushContactBundle({ force })` boleh menulis
daftar kontak **kosong** — perangkat hasil link memang belum punya kontak, dan
daftar kosong itulah isi yang benar untuk identitas baru; push rutin tetap
melewati daftar kosong supaya seeding tidak mem-PUT blob kosong berulang.
`replaceContactBundleWithLocal()` (nama yang menyatakan sebabnya) dipanggil
`LinkDevicePage.finishLink` setelah `login()` dan **sebelum** navigasi ke
`/chat`, jadi `loadConversations` di halaman berikutnya sudah membaca blob yang
bisa dibuka. **(2)** `restoreContactsFromBundle` sengaja **tidak** menimpa blob
saat dekripsi gagal: `decryptVaultText` mengembalikan `null` baik untuk "kunci
identitas lain" maupun "vault terkunci / worker gagal", dan menulis daftar
lokal yang belum terbaca bisa menghapus salinan server yang masih baik. Ia
hanya memperingatkan dengan sebab yang benar; penggantinya tetap deterministik
(link atau upsert kontak berikutnya).

Yang belum kembali adalah **isi** kontak lama — itu tugas arsip riwayat
(`docs/40`), yang mendarat di entri di atas.

Tes: 4 kasus baru di `web/src/lib/__tests__/contactStore.test.ts` (push kosong
tanpa `force` tidak mengirim; `replace` menulis bundle kosong yang valid;
`replace` batal bila vault tidak bisa menyegel; blob identitas lain → restore
gagal-open tanpa PUT) dan `web/e2e/deviceLinking.spec.ts` menyemai blob
identitas lama sebelum link lalu memastikan `version` berubah (123 → hash
klien) dan byte lama hilang — dijalankan nyata, lulus.

## 🔗 Transfer vault via QR dihapus — link device jadi satu-satunya jalur perangkat baru (2026-10-29)

Dua fitur di Settings terlihat setara padahal berbeda: **Transfer to New Device
(QR)** memindahkan seluruh vault (20 tabel) ke perangkat baru, sedangkan **Link a
Device** hanya membuat identitas perangkat baru tanpa riwayat. Transfer dihapus
karena tiga hal yang tidak bisa dibela: (1) `MigrationReceivePage` mewajibkan
perangkat baru **sudah login** — jadi ia bukan jalur untuk perangkat yang belum
bisa masuk; (2) nol e2e/unit test untuk alurnya, dan setelah impor halaman itu
menghapus `deviceId` tanpa pernah membuat ulang Device row, sehingga L1 relay
menolak perangkat tersebut; (3) `migration:prepare` menyalakan `is_migrating`
ber-TTL 15 menit yang mematikan cek satu-device untuk seluruh akun — jendela dua
device yang mahal bila app pengirim crash sebelum `migration:cancel`.

Yang dihapus: `MigrationSendPage`/`MigrationReceivePage`, rute
`/settings/migrate-send` + `/migrate-receive`, tombol Settings, handler
`migration:prepare|cancel|join|start|chunk|ack` beserta allowlist gateway WSS,
kind room `migration`, dan gate `is_migrating` di `issueTokens` +
`isActiveDeviceAllowed`/L1. Sisa Redis lama (`migration:room:*`,
`is_migrating:*`, `migration_owner:*`) kedaluwarsa sendiri; tidak ada migrasi
data.

Pengganti: **(a)** modal recovery di `/login` kini menawarkan **Link a Device**
(`/link`), dan halaman itu menerima tempelan URL/token saat tidak dipindai dari
QR — sebelumnya entri ini hanya bisa dicapai dengan memindai; **(b)** riwayat
tetap pindah lewat `.nyxbak` (berkas atau salinan R2) dengan recovery phrase,
yang sudah mencakup 20/20 tabel. Tes server yang mengunci perilaku `migration:*`
disesuaikan (`redisIdentity`, `roomMembership`, `gatewayParity`); suite web tidak
pernah punya tes untuk alur ini.

## 📱 `/bench/pq` juga mengukur jalur nyata: pipeline worker + IndexedDB (2026-10-29)

Harness perangkat hanya mengukur primitif ML-DSA-65/X-Wing di thread utama, jadi
angka p95-nya tidak menjawab pertanyaan yang sebenarnya saat dipakai di HP:
berapa biaya satu pesan dan satu tulis IndexedDB. Halaman `/bench/pq` sekarang
juga menjalankan `web/src/lib/devicePipelineBench.ts`: seal/open
XChaCha20-Poly1305 lewat crypto worker yang sama dengan aplikasi (4 permintaan
in-flight; payload 256 B dan 8152 B = plaintext setelah padding traffic-cover
8 KB), lalu put/get/delete `messageKeys` dan update state ratchet 2 KB di
database terpisah `nyx-device-bench` yang dihapus setelah pengukuran (`deleted`
dilaporkan jujur, `null` bila browser tidak punya `indexedDB.databases()`).
Tidak ada data akun yang dibaca; modul diimpor dinamis supaya build yang
nonaktif tidak membuat crypto worker. Yang tetap TIDAK diukur ditulis di
halaman: langkah ratchet/`kdfChain`, serialisasi header, dan RTT jaringan.

## 🔐 Export/import brankas JSON (`.nyxvault`) dihapus (2026-10-29)

Settings punya dua jalur cadangan yang terlihat setara: "Ekspor/Impor Brankas"
(JSON `.nyxvault`) dan "Backup Terenkripsi (.nyxbak)". Yang pertama ternyata
berbahaya: `exportDatabaseToJson` menulis **JSON terbaca** berisi seluruh key
store, termasuk `sessionKeys.key` dan `groupKeys.key` yang disimpan mentah tanpa
envelope `ENC1:` — mengklik tombol itu sama dengan memindahkan kunci sesi ke
disk. Envelope `{encrypted, salt, data}` yang dibaca `importDatabaseFromJson`
tidak pernah dibuat kode mana pun (grep `encrypted: true` = 0 hasil), jadi
prompt password saat impor hanya berlaku untuk berkas lama. Jalur itu juga lebih
sempit (16 tabel, tanpa `conversations`/`contacts`/`profileCache`/
`groupCachedParticipants`), kehilangan `Date` menjadi string, tidak menjalankan
`normalizeOrderIndex()` (pesan bisa tersimpan tapi tak pernah tampil), dan
menghapus `identityKeys` — bukan hanya `deviceId`.

Karena itu export **dan** import `.nyxvault` dihapus: dua fungsi di
`web/src/lib/keychainDb.ts`, tombol di Settings, opsi "Import Vault File" di
modal pemulihan `/login`, teks bantuan `ChatInfoModal`, serta salinan bantuan
di situs marketing (4 bahasa). Penggantinya sudah ada dan mencakup 20/20 tabel:
`.nyxbak` (kunci dari recovery phrase) — dan modal pemulihan di `/login` sekarang
membuka jalur restore `.nyxbak` itu, sehingga perangkat baru tanpa perangkat lama
tetap punya pintu masuk berkas. Konsekuensi yang diterima: berkas `.nyxvault`
yang beredar tidak bisa dipulihkan lagi; formatnya tidak pernah menjadi cadangan
yang aman.

## 🧯 Drill pemulihan log KT v2 menggantikan drill v1 (2026-10-29)

Sejak drill v1 dihapus (2026-10-28), tidak ada satu pun uji otomatis yang
membuktikan arsip snapshot KT bisa **dipulihkan** — snapshot yang terverifikasi
saat dibuat hanya membuktikan masa lalu, bukan pemulihan. Sekarang
`scripts/kt-v2-restore-drill.sh` menjalankan 11 langkah dengan kode produksi
sungguhan: menulis lewat `publishKeyTransparencyEntry`, menunggu snapshot
terverifikasi, menghapus DB, memulihkan **hanya** dari arsip, memverifikasi bukti
lewat `transparency.VerifySearch` (fungsi yang sama dengan `verify_search` di
WASM klien, dengan anchor klien yang disimpan di berkas), lalu membuktikan log
tumbuh tanpa memutus anchor pra-bencana. Empat kontrol negatif (root palsu, nilai
palsu, kunci log salah, arsip dirusak satu byte) menjaga agar "lulus" berarti
sesuatu; skrip yang sengaja dirusak terbukti merah. Berjalan di CI (job
`kt-recovery-v2`) tanpa layanan eksternal, dan mode `--bundle <file.tar.gz.age>`
disediakan untuk operator (belum pernah dijalankan).

Alat baru: `server/kt-query/cmd/nyx-kt-v2-check` (pengganti `nyx-kt-check` v1:
`config`/`head`/`verify-search`/`tree-size`/`audit`) dan
`server/scripts/kt-v2-drill-entries.ts`. Drill menemukan dua hal yang tidak
terlihat dari kode: arsip yang dibuat sebelum auditor menandatangani head **tidak
memuat** auditor head (pemulihan wajib menjalankan auditor sebelum bukti bisa
diverifikasi), dan `-check` exit 0 bukan bukti integritas karena LevelDB bisa
memulihkan diri dari salinan sebagian. Detail + opsi kebijakan rollback:
`docs/39` §39.5d.

## 🔔 Tulisan KT yang dilewati akhirnya terlihat (2026-10-29)

`nyx_kt_writes_total{result="invalid"}` sudah ada sejak pensiunnya log v1, tetapi
tidak punya alert maupun panel: perangkat tanpa `signingKeyV2` kehilangan entri
log tanpa satu pun tanda di dashboard. Dua aturan baru memisahkan dua hal yang
berbeda — aliran persisten (≥3 kejadian/6 jam dan >5% dari seluruh tulisan) =
utang migrasi, versus burst ≥5 dalam 15 menit = bug klien/input cacat — sehingga
satu login dari perangkat lama tidak membangunkan siapa pun. Ditambah panel
pangsa `invalid` di dashboard `nyx-overview`, dan `scripts/kt-invalid-report.sh`
yang memecah sebabnya hanya dari agregat (Prometheus + hitungan perangkat di
Postgres `READ ONLY` + `<reason>` dari journal, tanpa identifier). Baseline dan
opsi keputusan: `docs/10` §10.23.

## 🗑️ KT v1 dipensiunkan total: penulis, binary, dan drill v1 dihapus (2026-10-28)

Klien sudah lama hanya menerima ABI 2, tetapi server **masih punya jalur tulis v1**
(`KT_SERVER_URL`, pohon classical) dan masih membangun tiga binary Go v1. Efek
deployment-nya selama transisi hanya dicapai dengan mengosongkan env — jalur yang
masih ada berarti suatu hari menyala lagi tanpa alarm yang tepat.

Sekarang `server/src/utils/keyTransparency.ts` hanya punya satu penulis: log
ML-DSA-65 v2 (`KT_V2_SERVER_URL`). `KT_SERVER_URL` yang masih ada di `.env` tidak
ditafsirkan — ia memicu satu peringatan boot supaya tidak jadi konfigurasi zombie.
Metrik tidak diberi sufiks baru: `nyx_kt_writes_total` +
`nyx_kt_last_success_timestamp_seconds` kini milik log v2 dan `nyx_kt_v2_*`
dihapus, jadi alert, dashboard Grafana, dan kasus `promtool test rules` memakai
nama lama tanpa jendela buta dan tanpa `sum()` ganda.

Dihapus bersama jalurnya: `server/kt-query/{main,query,write,audit,snapshot,store,
metrics,config}.go` + tesnya, `cmd/nyx-kt-auditor`, `cmd/nyx-kt-check`,
`cmd/nyx-kt-query` (v1), unit `ops/systemd/nyx-kt-query.service` /
`nyx-kt-auditor.service`, `scripts/kt-restore-drill.sh`, `server/scripts/kt-{drill-
entries,fixtures,query-fixtures}.ts`, job CI `kt-recovery`, serta verifier klien v1
(`web/src/lib/keyTransparency.ts` + `packages/keytrans-wasm`, kini hanya
`keytrans-wasm-v2`) dan fixture protobuf v1 di `web/src/lib/__tests__/fixtures/kt/`.

Yang **hilang dan belum diganti** (dicatat, bukan disembunyikan): drill pemulihan
otomatis KT. Skrip lamanya bergantung pada penulis v1 dan `nyx-kt-check`; langkah
pemulihan kini manual dan didokumentasikan di docs/10 §10.13. `deploy.yml`
mematikan + menghapus unit v1 yang masih `enabled` di VPS, tetapi menghapus
`/var/lib/nyx/kt` dan kunci v1 adalah tindakan operator (tidak bisa dibatalkan).

## 🧾 Error 4xx tidak lagi tampil sebagai kode mesin (2026-10-28)

Server menjawab 4xx dengan **kode mesin** (`RATE_LIMITED`, `TOKEN_STALE`,
`ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token`, `SANDBOX_LIMIT_REACHED`,
`MEMBERS_REMAIN: …`). `handleApiError` mengembalikan `e.message` apa adanya dan
belasan komponen memakai `error.message` langsung, jadi toast pengguna bisa berisi
kode itu — atau teks Inggris hardcoded yang tidak bisa diterjemahkan — tanpa
petunjuk apa yang harus dilakukan.

Sekarang semua jalur lewat `web/src/lib/apiErrorText.ts`: kode dikenal → kalimat
yang bisa ditindaklanjuti (kunci `api_*` di keempat bahasa), kalimat manusia dari
server dipakai bila ada, sisanya fallback per status (401/403/404/409/413/429),
dan kode mentah tidak pernah dirender. Pemanggil yang punya kalimat konteks
(`formatApiErrorOr`) mempertahankannya saat server tidak memberi detail, sedangkan
error perangkat (crypto/rotasi/penyimpanan) tetap apa adanya agar bisa didiagnosis.

Batas akun belum terverifikasi (`SANDBOX_LIMIT*`) bukan kegagalan sekilas:
`sandboxLimitNotice.ts` menampilkannya sebagai `SystemBanner` dengan aksi ke
halaman verifikasi (bertahan melewati poll `systemStore`), dan
`startConversation` tidak lagi membungkus ulang `ApiError` menjadi `Error` biasa
sehingga `status`/`details` sampai ke pemanggil.

## 🚨 Realtime mati setelah login: cookie sesi host-only + `NODE_ENV` VPS (2026-10-25)

Setelah registrasi, dasbor `/chat` tertahan di banner `ESTABLISHING_UPLINK`.
Dari log jaringan pengguna: `WebTransport connection rejected` 2× → fallback
`wss://api.nyx-app.my.id/socket.io` dijawab **101**, lalu tidak ada apa pun lagi
(tidak ada `users/me/devices`, tidak ada `conversations`). Terverifikasi dengan
probe socket.io-client: gateway menolak dengan `connect_error: unauthorized` dan
**tidak** melakukan `reconnect_attempt` — kegagalan middleware memang tidak
di-retry, jadi gejalanya menggantung alih-alih gagal-ulang.

Sebabnya dua:

- `at`/`rt` diterbitkan `app.nyx-app.my.id` (REST relatif `/api`) **tanpa**
  `Domain`, jadi browser tidak mengirimnya ke `api.nyx-app.my.id` — host yang
  dipakai `resolveApiOrigin()`. Cookie CSRF punya `domain`, cookie sesi tidak.
- `deploy.yml` menjalankan `pm2 start …` tanpa `NODE_ENV`, sehingga
  `env.nodeEnv = 'development'` di VPS: cookie kehilangan `Secure`/`SameSite=None`
  dan cabang `domain: isProd ? …` tidak pernah aktif (terbukti dari `Set-Cookie`
  CSRF produksi tanpa `Domain`).

Perbaikan: env baru **`COOKIE_DOMAIN`** dipakai satu sumber oleh set **dan** clear
cookie sesi (`authCookieOptions()`), plus cookie CSRF; jalur WSS kini mengirim
`handshake.auth.token` sehingga tidak lagi bergantung pada cookie lintas-subdomain;
`connect_error` socket.io dicatat dan status koneksi dibuat jujur; klien melewati
percobaan WebTransport bila tidak ada URL absolut (fallback hardcoded
`api…/transport` selalu ditolak). Langkah operator + peringatan `NODE_ENV`:
`docs/10` §10.20.

## 🔎 Pencarian privat dinyalakan: OHTTP + PIR + OPRF (selfhost, 2026-10-25)

Di selfhost `~/nyx-selfhost` ketiga gerbang sekarang **aktif** (default repo tetap
mati): gateway OHTTP dengan keypair P-256 baru, relay OHTTP sebagai proses
terpisah (`:4100`), sidecar ChalametPIR (`:9470`), dan `PIR_OPRF_ENABLED=1`
sehingga register/login mengisi `User.oprfIndex`. Klien dibangun ulang dengan
`VITE_OHTTP_ENABLED=1`, `VITE_PIR_ENABLED=1`, `VITE_PIR_OPRF_ENABLED=1`.

**Perbaikan wiring yang ditemukan saat menyalakan:** `POST /api/pir/query` lewat
OHTTP selalu `403 Invalid CSRF token` karena amplop tidak membawa cookie. Lapisan
CSRF global kini melewati path itu **hanya bila request tidak membawa cookie sesi
sama sekali** — request berbasis cookie tetap wajib CSRF (token di dalam amplop
sudah ber-scope dan `requireAuth` menolaknya di luar allowlist OHTTP).

**Perubahan lain:** `web/.env` memakai `VITE_API_URL=` (relatif) — nilai absolut
`http://localhost:4000` diblokir CSP `connect-src 'self'` nginx dan memecah cookie
antara `127.0.0.1` dan `localhost`; `vite.config.ts` mem-proxy
`/api/ohttp/relay` → `:4100/relay` (dev + preview) di atas `/api`; unit baru
`ops/systemd/user/nyx-pir-sidecar.service`; docs/10 §10.19, docs/12 (endpoint
`/api/ohttp/*`, `/api/pir/*`, `/api/auth/ohttp-token`, `/api/users/search/oprf`),
docs/13 (gejala CSRF/404/503/snapshot basi), docs/37 (port PIR 9470). Diverifikasi
end-to-end: login → OPRF → token OHTTP → amplop → relay → gateway → search, dan
params → query WASM → OHTTP → record PIR (bukan hanya unit test).

## 🛰️ Relay OHTTP proses terpisah + angka PIR diperbarui (2026-10-25)

**Relay OHTTP tidak lagi harus satu proses dengan API.** `server/src/ohttp/relay.ts`
(+ `relayApp.ts`) menjalankan `POST /relay` tanpa DB/Redis/Prisma: ia hanya
meneruskan byte amplop ke gateway loopback dan **membuang seluruh header klien**
(cookie, authorization, x-forwarded-for, user-agent). Boot menolak gateway
non-loopback (kecuali host disebut eksplisit di `OHTTP_GATEWAY_TRUSTED_HOSTS`,
untuk Docker), menolak `OHTTP_TOKEN_MODE=off` (relay tanpa sesi), dan menolak
bind non-loopback tanpa `OHTTP_RELAY_ALLOW_PUBLIC_BIND=1`. `OHTTP_RELAY_EXTERNAL=1`
membuat API berhenti memasang `/relay`; nginx meneruskan `location =
/api/ohttp/relay` ke `ohttp-relay:4100`. Unit: `ops/systemd/nyx-ohttp-relay.service`,
compose service `ohttp-relay`. Tes `tests/ohttpRelay.test.ts` (7) + proses relay
dijalankan nyata (healthz, 502 upstream mati, 400 body kosong). Batas jujur: masih
satu host pada default — yang hilang adalah korelasi di log/state aplikasi.

Angka PIR diukur ulang di mesin ini: N=1000 (query 138 ms/5,5 KB, startup 20,6 s)
dan N=10.000 (startup **886 s**, query 1,92 s/50 KB, RSS 128 MB) — konsisten
dengan catatan 2026-10-24, dan menegaskan startup superlinear sebagai alasan PIR
butuh sharding sebelum dipakai luas. Bukan angka produksi, belum diaudit.

## ⏱️ Jitter rilis grup + ops nginx/unit masuk repo (2026-10-25)

**Waktu terima pesan grup tidak lagi sama dengan waktu kirim.** Dengan
`GROUP_RELEASE_JITTER_MS` (default mati, clip 2000 ms), relay pesan grup ditunda
acak 0..N ms **setelah ACK** — pengirim tidak menunggu, isi/padding 8 KB tidak
berubah, dan 1:1 tidak tersentuh. Delay yang benar-benar dipakai dicatat di
histogram `nyx_group_release_delay_ms` (tanpa label), jadi fitur yang hidup
terlihat di scrape dan fitur mati tidak menghasilkan deret palsu. Berlaku di
kedua jalur kirim (WT + REST). Ini **bukan batching**: volume tetap terlihat.

Config nginx dan unit systemd sekarang bersumber dari repo: `ops/nginx/nyx.conf`
(+ `README.md`, termasuk `location = /api/ohttp/relay`; master `nginx.conf` tetap
lokal), `ops/systemd/*`, `ops/systemd/user/*`, dan `scripts/sync-selfhost.sh`
(profil `selfhost`/`docker`, dry-run default, `--apply`, `--check` exit 1 saat
beda). `deploy.yml` memasang unit relay bila sudah `enabled` dan mencatat drift
selfhost sebagai peringatan tanpa menggagalkan deploy.

## 🔑 At-rest `ENC2` + key ring seal + job re-seal (2026-10-25)

**Kunci at-rest sekarang bisa dirotasi tanpa downtime, dan formatnya ber-versi.**
Nilai ter-seal ditulis sebagai `ENC2:<keyId>:<b64url(nonce||ct)>` dengan kunci
dari key ring (`NYX_AT_REST_KEYRING` atau file custody `NYX_AT_REST_KEYRING_FILE`);
format lama (tanpa prefiks) tetap terbaca sebagai kunci id `0` turunan
`NYX_AT_REST_PEPPER`, jadi deploy build ini sendirian tidak mengubah satu byte
pun. Tanpa key ring, semua tulisan tetap legacy. Key id yang
tidak ada di ring menghasilkan `null` (gagal baca terlihat), bukan plaintext;
key ring yang rusak melempar, tidak diam-diam jatuh ke legacy.

Karena satu plaintext menghasilkan ciphertext berbeda per kunci, semua lookup
kesetaraan pindah ke `sealedLookupCandidates` (kunci aktif + legacy): routing
keanggotaan, `Story.authorTag`, pasangan `BlockedUser`, dan
`PushSubscription.endpointSealed` (subscribe kini cek-lalu-update, bukan upsert
yang akan menduplikasi baris lama). `scripts/reseal-at-rest.ts` memindahkan
baris lama ke kunci aktif secara batch dan idempoten (dry-run default, `--apply`,
exit 2 bila ada nilai tak terbaca); runbook di `docs/10` §10.17. Custody provider
`env`/`file` + status tanpa rahasia ada di `/api/admin/system-status` (`atRest`).
Blind index HMAC **tidak** ikut dirotasi — HMAC satu arah, plaintext tidak
disimpan server (dicatat di `docs/28` §R4). Verifikasi: 21 tes at-rest/custody
baru, 638 tes server hijau.

## 🔬 Spike BRaccoon ditutup tanpa implementasi (2026-10-25)

**Credential PQ tidak dihidupkan, dan alasannya sekarang terukur.** Spike
BRaccoon (ePrint 2026/1084) selesai dengan satu keputusan: signature Raccoon
level 1 berukuran 11,5 KB, sementara `CREDENTIAL_MAX_BYTES` 8 KiB — sebelum
satu byte proof pun masuk. Total komunikasi issuance diestimasi penulis ≈862 KB
(butuh ≥14 body OHTTP 64 KB), dan belum ada implementasi publik, test vector,
atau audit. Verifier tetap fail-closed dengan allowlist suite kosong; wire
format credential tidak berubah, jadi suite PQ kelak bisa masuk tanpa migrasi
bila signature-nya muat. Gate untuk membuka kembali (implementasi referensi,
≤8 KiB, ≤64 KB, proving WASM p95 ≤2 s, audit, dual-verify + kill switch) ada di
`docs/37` §37.9.5.

## 🔄 Rotasi era grup terjadwal (PCS kasar) + rotasi manual yang menaikkan epoch (2026-10-24)

**Rotasi era tidak lagi hanya manual dan tidak lagi hanya mengganti rantai sender
key.** `maybeRotateGroupEpoch` (`web/src/lib/groupEpochRotation.ts`, loop 15 menit
di `App.tsx`) membaca `GET /api/groups/:id/epoch` (admin capability), memutuskan
lewat kebijakan murni `groupEpochPolicy.ts` — **24 jam** sejak rotasi terakhir
atau **500 pesan** sejak baseline lokal — lalu `POST /api/groups/:id/epoch`
(epoch += 1, token grup baru) dan menulis ulang metadata v3 dengan token itu
(`rotateGroupKey(..., 'periodic_rotation', true, token)`), sehingga era kunci
baru terdistribusi lewat mailbox. Token baru disimpan sebagai `pendingToken`
**sebelum** metadata ditulis: kalau PUT metadata gagal, percobaan ulang memakai
token yang sama alih-alih merotasi dua kali dan meninggalkan anggota dengan
token basi.

Tombol **Rotate keys** di Group Info kini memakai jalur yang sama, jadi rotasi
manual juga menaikkan epoch dan mematikan token grup lama (sebelumnya hanya
rantai sender key yang berganti). Header `GET /:id/epoch` mengembalikan
`{epoch, rotatedAt, createdAt, messageSeq}`; `GroupTokenConversationRow`
diperluas untuk kolom itu. Verifikasi: 15 tes baru (`groupEpochPolicy` 8,
`groupEpochRotation` 7 — termasuk skenario kegagalan PUT + pemulihan token) dan
server 628 tes tetap hijau.

## 📬 Mailbox grup + Privacy Pass klien + OHTTP POST untuk sync anonim (2026-10-24)

**Distribusi kunci grup tidak lagi membentuk graf.** Envelope sender-key sekarang
ditulis ke mailbox percakapan (`web/src/lib/groupMailbox.ts`) dengan tag alamat
`HMAC(memberTokenPenerima, "nyx-mailbox-v1")` — server hanya melihat "grup G
menerima item", bukan tepi requester→fulfiller. Envelope diproses lewat jalur
dekripsi yang sudah ada (`storeReceivedSessionKey`), dengan hint perangkat agar
satu user ber-multi-device tidak mencoba membuka amplop device lain. Poll loop
(10 detik, satu tick pada satu waktu) hidup selama sesi di `App.tsx`. Jalur lama
`group:fulfilled_key` hanya dipakai bila metadata/token grup belum tersedia
(mis. distribusi pertama saat createGroup) supaya kunci tidak hilang.

**Privacy Pass sisi klien** (`web/src/lib/privacyPass.ts`): issuance Blind RSA
(RFC 9474) memakai `@cloudflare/blindrsa-ts` yang sama dengan server, token
diverifikasi ulang secara lokal sebelum disimpan (token tak terverifikasi =
tidak disimpan), tersimpan ter-seal di `kvStore` dengan TTL 24 jam, dan
dihabiskan tepat satu per sync. Issuance saat stok kosong berjalan di latar —
sync tidak menunggu blind RSA.

**Sync anonim lewat OHTTP POST** (`web/src/lib/groupSync.ts`): allowlist gateway
bertambah `POST /api/groups/sync` (body ≤ 64 KB ditolak 413 di dalam amplop) dan
token OHTTP mengikuti pasangan method+path, bukan hanya GET. Klien memakai
amplop bila `VITE_OHTTP_ENABLED=1`, lalu jatuh ke jalur langsung bila gagal.

Server: `POST /api/groups/sync` menerima `proofs` (satu token = satu sync,
terikat `conversationId`); `PP_SYNC_REQUIRED=1` membuat sync tanpa bukti sah
dijawab `403 PP_PROOF_REQUIRED` (default: bukti dihabiskan bila dikirim, tidak
wajib). `PP_ISSUER_PRIVATE_JWK` didokumentasikan di `.env.example` bersama flag
itu. Verifikasi: server **628 tes / 0 fail** (+5 `syncProofs`), web **965 tes /
0 fail** di `lib`/`store`/`utils` (mailbox 15, Privacy Pass 8 dengan RSA asli,
group sync 4), plus smoke live `post→pull→403→400` terhadap API selfhost.

## 🧪 E2E residual Fase 8: recovery, device-linking, credential grup, OHTTP + fix blind RSA (2026-10-23)

> **Koreksi (2026-10-23):** cutover PQ-only menghapus seluruh fitur credential
> (`groupCredential.spec.ts`, `/api/credentials/*`, suite RSA, client
> `groupCredentials`). Spec credential dan hasil “3 passed” di bawah adalah
> historis sebelum penghapusan; E2E yang tersisa: recovery, deviceLinking,
> OHTTP. Jangan menganggap credential grup tersedia di build ini.

Empat alur browser yang sebelumnya hanya dijaga unit test kini punya spec
Playwright: pemulihan akun (`recovery.spec.ts`) mengambil frasa dari vault,
memulihkan lewat `/restore`, dan mewajibkan request `POST /api/auth/recover`
membawa `signatureV2`/`signingKeyV2` (ML-DSA-65) yang diterima server 200;
tautan perangkat (`deviceLinking.spec.ts`) menjalankan QR perangkat lama →
claim → approve → login perangkat baru di dua konteks; credential grup
(`groupCredential.spec.ts`) membuktikan issuance nyata, persist `ENC1:` di
IndexedDB, dan presentasi `X-Group-Credentials` saat sync setelah reload;
OHTTP (`ohttp.spec.ts`) membuktikan pencarian keluar lewat
`POST /api/ohttp/relay` berisi amplop `message/ohttp-req`, key gateway dipin,
dan **tidak ada** `GET /api/users/search` langsung dari halaman.

OHTTP tidak bisa memakai dev server biasa (gateway hanya dipasang saat
`OHTTP_ENABLED=1`), jadi `playwright.ohttp.config.ts` menyalakan stack sendiri
di API 4100 + Vite 5273 dengan kunci P-256 yang dibuat saat config dimuat (tidak
ada kunci privat yang di-commit) dan `NYX_E2E_API_PROXY_TARGET` untuk proxy.
Jalankan `pnpm --filter nyx-web run test:e2e:ohttp`; di suite utama spec itu
skip dengan alasan tertulis karena default produksi memang mematikan OHTTP.

Untuk gerbang denylist legacy, `server/scripts/audit-v1-residuals.ts`
(`pnpm --filter nyx-server run audit:v1`) menghitung agregat artefak v1 yang
bisa diamati server — Device tanpa `signingKeyV2`, PreKeyBundle tanpa
`signatureV2`, OneTimePreKey klasik, GroupCredential bersuite NULL, dan amplop
pesan X3DH/grup v1 — sehingga "menunggu v1 habis" bisa diukur. Skrip read-only,
`--json` untuk mesin, `--check` exit 1 selama masih ada sisa.

Untuk pengukuran di HP sungguhan ada harness `/bench/pq`
(`web/src/pages/PqDeviceBenchPage.tsx`, build `build:pq-bench`): menjalankan
`runPqBenchmark`, menampilkan p95 vs budget, ukuran output, dan konteks baterai
(level/charging; proxy kasar, bukan mWh). Halaman nonaktif pada build default.
Keempat spec E2E di atas dijalankan di selfhost 2026-10-23: recovery +
deviceLinking + groupCredential **3 passed (6,7 m)**, OHTTP **1 passed (2,7 m)**.

Benchmark perangkat rendah kini punya proxy yang bisa diulang:
`bench:pq:throttle` menjalankan ML-DSA-65 + X-Wing di Chromium dengan CPU
throttling CDP 1x/4x/6x. Pada 6x (p95): keygen 79,1 ms, sign 186,5 ms, verify
71,3 ms; X-Wing keypair/encaps/decaps 10,8/8,1/10,3 ms — budget desktop tetap
terpenuhi, jadi keputusan tetap di noble (liboqs tidak dipicu). Ini bukan
pengukuran baterai/perangkat fisik.

Jalur v1 yang tidak meninggalkan jejak di DB (recovery Ed25519 saja, pre-key
bundle v1, tautan perangkat tanpa kunci ML-DSA) sekarang dihitung lewat counter
event-only `nyx_legacy_v1_usage_total{path=…}`; labelnya enum pendek dan nilai
berbentuk identitas ditolak seperti metrik lain.

Paket review kriptografi eksternal disusun di `docs/36` (ruang lingkup Tier A +
KT v2, klaim, bukti, residual, pertanyaan reviewer). Status review tetap
**belum dilakukan**.

Spec credential langsung menemukan regresi nyata dari bump dependensi:
`@cloudflare/blindrsa-ts` 0.4.6 mengekspor kunci ke JWK di dalam
`blind()`/`blindSign()`, sehingga kunci yang di-import non-extractable membuat
issuance gagal dengan `key is not extractable`. Klien (`credential_blind`,
`credential_finalize`) dan server (kunci privat issuer) sekarang meng-import
dengan `extractable: true`; tanpa fix ini credential grup tidak bisa diterbitkan
sama sekali.

## 🔏 Fase 7 landed: log Key Transparency v2 (ML-DSA) + dual-write, cutover baca belum (2026-10-21)

Log KT v2 berjalan berdampingan dengan v1: crate fork lokal
(`packages/keytrans-v2`) memakai ML-DSA-65 dan indeks SHA--256 alih-alih
Ed25519/EC-VRF, dengan WASM verifier terpisah (`keytrans-v2.wasm`, ABI 2) yang
diverifikasi lintas bahasa lewat fixture Go → Rust → vitest. Service, auditor,
LevelDB, port, metrics, dan snapshot v2 terpisah; `deploy.yml` mem-bootstrap
config + kunci di VPS lewat `nyx-kt-v2-init` lalu meng-enable unit v2.

Server menulis entri identik ke v1 dan v2 bila `KT_V2_SERVER_URL` diisi
(`nyx_kt_v2_writes_total`, dedupe per log), dan klien memilih ABI dari
`/config` lalu mem-pin ABI 2 hanya setelah bukti terverifikasi. **Pembacaan
tetap v1**: search key KT diturunkan dari Argon2id mentah yang tidak disimpan
server, jadi akun lama tidak bisa di-backfill ke log v2. Cutover `KT_QUERY_URL`
dan v1 read-only masih manual setelah populasi cukup.

## 🧭 Sisa Fase 4: limiter pencarian per akun, padded query, OTPK tidak lagi terbakar saat preview (2026-10-21)

Pencarian user kini punya dua limiter berlapis: **30/menit per akun** dan
**90/menit per IP**. Limiter umum sebelumnya hanya menghitung per IP, sehingga
satu akun di balik NAT bisa memborong jatah bersama sementara banyak akun dari
satu kantor/VPN saling memblokir. Kunci limiter memakai `identityTag`/
`clientIpTag` (HMAC), jadi snapshot Redis tidak memuat userId atau alamat mentah.

Query pencarian diberi padding: `q` bisa 43 karakter (hash klien) atau 64 hex
(hash-ID lama), dan perbedaan panjang itu sebelumnya terbaca dari URL. Sekarang
sisa slot diisi `&pad=` acak sampai 64 karakter sehingga panjang path seragam.
Server hanya membaca `q`.

Pembacaan bundle pre-key dipisah dari konsumsi OTPK. Sebelumnya **setiap** GET
`/api/keys/prekey-bundle/:userId` menghapus satu OTPK peer — artinya preview
profil, percobaan gagal, atau retry jaringan ikut menguras pre-key korban.
Sekarang `?otpk=read` mengembalikan identitas + signed pre-key tanpa menyentuh
kolam dan tanpa `oneTimePreKey` (OTPK yang dikirim tanpa dihapus bisa dipakai
dua inisiator sekaligus). Default tetap `consume` agar klien X3DH yang ada tidak
berubah.

PIR masih riset: butuh keputusan library/service (§35.11 #3), benchmark, dan
audit sebelum boleh masuk default.

## 🔒 R5 ditutup: pencarian user hanya menerima hash, bukan nilai mentah (2026-10-21)

`identifierLookupCandidates()` dulu mengembalikan `[HMAC_pepper(q), q]`. Kandidat
kedua membuat server mau mencari **nilai kiriman apa adanya** ke kolom
`usernameHash` — artinya pemegang dump DB bisa mengirim tebakan username/email
ke API hidup dan server yang menghitungkan hash-nya, menjadikan endpoint
pencarian sebagai oracle keanggotaan. Sekarang fungsi itu hanya mengembalikan
bentuk hash: 43-char (Argon2id klien) → satu kandidat ter-pepper; 64-hex (blind
index yang di-echo server untuk link berbagi) → dipakai apa adanya.

`GET /api/users/search` menolak nilai non-hash dengan 400
`INVALID_IDENTIFIER_HASH` sebelum menyentuh DB, untuk semua akun. Gerbang
sandbox lama (`SANDBOX_SEARCH_RESTRICTION`) menjadi tidak relevan dan digantikan
validasi yang lebih ketat. Tool WebMCP `search_users` kini meng-hash input bebas
di klien, dan store percakapan meneruskan 64-hex apa adanya sehingga link profil
lama tetap menemukan user (jalur migrasi, bukan kompatibilitas nilai mentah).

## 🕶️ Fase 3 selesai di kode: OHTTP dipakai jalur pencarian, cover adaptif, jitter, chaff visibility-aware (2026-10-21)

docs/35 Fase 3 sebelumnya baru "scaffold": relay/gateway ada tetapi tidak
mungkin dipakai karena cookie sesi `HttpOnly` tidak bisa masuk amplop OHTTP.
Sekarang ada **carriage token**: `POST /api/auth/ohttp-token` (cookie + CSRF)
menerbitkan JWT 120 detik ber-scope `ohttp` yang diletakkan di dalam amplop
sebagai `authorization: Bearer …`. `requireAuth` menolak token itu di luar
allowlist OHTTP dan hanya untuk GET, jadi token yang bocor tidak sama dengan
sesi penuh. `GET /api/users/search` sekarang lewat relay → gateway lewat
`web/src/lib/userSearch.ts` (satu pintu untuk hook pencarian, daftar chat, dan
store percakapan) tanpa fallback diam-diam ke HTTP biasa.

Rotasi kunci dua slot: `/api/ohttp/config` mempublikasikan key id 1 dan 2,
gateway memilih slot dari byte pertama amplop, dan pin klien disimpan **per key
id** — kunci yang sudah dipin tidak boleh berubah (fail-closed), kunci baru baru
diadopsi setelah kunci lama pensiun. Metrik `nyx_ohttp_ops_total{route,result}`
membedakan `unknown_key` dari amplop rusak.

Cover traffic menjadi adaptif: λ mengikuti laju kirim nyata per percakapan
(0.2–2.0/menit) dengan plafon 25 MB/percakapan/hari yang direset per hari UTC,
sehingga "Maximum" tidak lagi bisa menjadi penguras kuota tanpa terlihat. Mode
Maximum menambah jitter/batching 200–800 ms untuk pesan user (urutan tetap,
silent/receipt dilewati). Chaff transport berhenti saat tab background dan
profilnya dapat diubah runtime.

Gerbang: server tetap default mati (`OHTTP_ENABLED` kosong → router 404) dan
klien `VITE_OHTTP_ENABLED=1`. Jalur relay→gateway→dispatch diuji lewat HTTP
nyata (14 test), dan uji itu menemukan bug nyata: sanitasi header identitas
sebelumnya hanya ada di dispatcher default, bukan di gateway — kini gateway yang
membersihkan, jadi dispatcher apa pun aman.

## 🕶️ OHTTP punya relay, gateway, dan worker klien — default mati, belum dipakai alur aplikasi (2026-10-20)

docs/35 Fase 3 meminta "OHTTP client worker + relay/gateway untuk REST".
Katalog layanan tidak menyediakan OHTTP relay, jadi relay-nya **self-hosted**:
`POST /api/ohttp/relay` hanya meneruskan byte opaque ke gateway yang URL-nya
berasal dari env (bukan input klien, sehingga bukan open proxy), dan
`POST /api/ohttp/gateway` membuka HPKE, menegakkan allowlist, lalu melakukan
dispatch ke API lewat loopback dengan header jaringan dibuang. Wire mengikuti
RFC 9458 §4.1–4.4: DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM
(semuanya WebCrypto native), isi Binary HTTP RFC 9292 known-length. Tidak ada
primitif buatan sendiri; tambahan dependency hanya `@hpke/core` di
`packages/shared`.

Sisi klien: `web/src/workers/ohttp.worker.ts` (HPKE + Binary HTTP di worker,
bukan main thread) dan `web/src/lib/ohttpClient.ts` yang mengambil
`application/ohttp-keys`, mem-pin SHA-256-nya secara TOFU, lalu mengirim lewat
relay. Allowlist dibatasi ke `GET /api/users/search` dan
`GET /api/keys/prekey-bundle/<id>`; body 128 KiB; relay/gateway 120 req/menit.

Batas yang ditulis jujur: relay dan gateway ada di VPS yang sama, jadi yang
terlindung adalah path/header/konten dari edge Cloudflare dan access log nginx,
**bukan** dari operator VPS. Dan OHTTP **belum dipakai alur aplikasi**: cookie
sesi `HttpOnly` tidak bisa dibaca JS, sehingga belum ada kredensial yang bisa
dimasukkan ke amplop. Gateway sudah meneruskan `authorization` bila ada, jadi
langkah berikutnya adalah keputusan carriage token, bukan perubahan transport.

Dikunci test: `server/tests/ohttp.test.ts` (10 test — round-trip HPKE
request/response, framing Binary HTTP, key config collection, allowlist
termasuk query string, sanitasi header, gate config default-mati/gagal-keras,
403 terenkripsi tanpa dispatch, dan amplop yang diubah ditolak). Verifikasi:
`tsc` web + server bersih, `vite build` web sukses, `oxlint` 0 error.

## 🕵️ Cover traffic akhirnya bisa dipakai di chat 1:1 — tanpa memulai percakapan baru (2026-10-20)

Cover traffic (T4) selama ini hanya hidup di grup Maximum dan burner, dan itu
bukan karena scheduler-nya menolak: `sendCoverTraffic` sendiri yang kembali lebih
awal untuk percakapan non-grup (`if (!conv?.isGroup) return`). Akibatnya privacy
level "Maximum" praktis tidak tersedia untuk chat personal — padahal justru DM
yang paling sering dipakai.

Sekarang DM yang sudah punya riwayat bisa di-opt-in dari panel info kontak
(`DirectCoverTrafficCard`): state tetap client-local (server tidak pernah tahu
chat mana yang mengirim umpan), estimasi ~MB/hari tetap ditampilkan sebelum
menyalakan, dan toggle-nya tunduk pada master kill-switch global. Yang sengaja
**tidak** dilonggarkan: cover tidak boleh menjadi pemicu sesi.
`coverTargetAllowed()` menolak DM yang `lastMessage`-nya masih kosong, karena
handshake untuk pesan umpan justru membuat percakapan/handshake baru di server —
metadata baru, bukan yang ingin disembunyikan. Grup dan burner berperilaku sama
seperti sebelumnya.

Dikunci test: `web/src/lib/__tests__/coverTraffic.test.ts` (24 test; dua di
antaranya baru — scheduler meng-arm DM yang di-opt-in, dan matriks
`coverTargetAllowed` untuk grup/burner/DM tanpa riwayat). Verifikasi: `tsc -b
--noEmit` web bersih, `oxlint` 0 error, dan key i18n baru tersedia di keempat
locale (en/es/id/pt-BR).

## 🛡️ Migrasi post-quantum Fase 1 landed — ML-DSA, X3DH v2, grup v4 — di balik gerbang yang masih mati (2026-10-20)

Seluruh langkah Fase 1 `docs/35` sekarang ada di kode, dan **tidak satu pun
menyala secara default**. Semua jalur baru berada di balik gerbang
`VITE_PQ_V2=1` (`resolvePqV2Enabled()`): tanpa gerbang itu klien tetap
mengirim/mengiklankan v1, tetap **membaca** v2, dan tidak ada format v1 yang
berubah. Capability dan format baru hanya aktif setelah keputusan deploy, bukan
karena kebetulan build.

**Fondasi.** `@noble/post-quantum@0.7.1` dipin exact di web, server, dan shared.
`packages/shared/src/cryptoSuite.ts` mendefinisikan `PQ_V2_SUITE`, ukuran
ML-DSA-65/X-Wing, dan `PQ_V2_DOMAINS` (bundle, handshake, seal, group, KT,
credential, recovery, link). Capability `pq-v2` masuk `SERVER_CAPABILITIES`
(sidecar Rust) dan `CLIENT_CAPABILITIES.PQ_V2`, dan klien hanya mengiklankannya
lewat `advertisedPqCapabilities()` saat gerbang hidup. `scripts/check-pq-only.mjs`
bersama `scripts/pq-only-baseline.json` menjadi ratchet: 12 pola classical-only
(`crypto_scalarmult`, `crypto_box_seal`, Ed25519 sign/verify, RSABSSA, ECVRF) di
`web/src`, `server/src`, dan `packages/shared/src` dibandingkan ke baseline, dan
call baru menggagalkan CI (step `PQ-only guard` di job `lint`).

**Tanda tangan ML-DSA-65.** `packages/shared/src/mlDsa.ts` membungkus noble
dengan `context` = domain, sehingga domain separation tidak bisa lupa dipasang.
Worker mendapat op `ml_dsa_*`; server mendapat `verifyMlDsaSignature` yang
fail-closed (panjang salah atau exception → `false`). Device key v2 diturunkan
deterministik dari `masterSeed` (label `signing-v2`) sehingga user lama dapat
kunci v2 saat unlock tanpa reset password. Bundle v2 ditandatangani atas pesan
kanonik ber-prefix panjang `u32` BE (identity X25519, pqIdentity, signedPreKey,
pqSignedPreKey, signingKeyV2) dengan context `NYX-PQ-BUNDLE-V2`, dan server
memverifikasinya **sebelum menyentuh DB** di `POST /api/keys/prekey-bundle`:
bundle yang hanya membawa sebagian field v2 ditolak `400`, bukan disimpan
tanggung.

**1:1 X3DH v2 tanpa DH klasik.** `packages/shared/src/pqHandshake.ts`
mendefinisikan wire `[magic 'N'][0x02][flags][pad][ctId][ctSpk][ctOtpk?][signature]`
(5553 B tanpa OTPK, 6673 B dengan OTPK) dan transkrip ber-prefix panjang yang
mengikat `signingKeyV2` inisiator + identity X25519 penerima + semua ciphertext.
Session key = `BLAKE2b-256(ss_id ‖ ss_spk [‖ ss_otpk])` — murni hasil encapsulation
X-Wing, tanpa `crypto_scalarmult` dan tanpa konversi Ed25519→X25519. Karena KEM
saja tidak membuktikan siapa pengirim, inisiator menandatangani transkrip dengan
ML-DSA; kunci verifikasinya **tidak** ada di wire, melainkan di payload ter-seal
(`handshakeVersion: 2`, `initiatorSigningKeyV2`) dan diwajibkan sama dengan
`signingKeyV2` bundle peer — dicek di dua jalur: `messagePipeline` untuk pesan
masuk dan `storeReceivedSessionKey` untuk offline sync `session:new_key`.

**Grup v4.** Pesan dan metadata grup memakai `sigV: 2` (ML-DSA-65 atas
`u32(N) BE ‖ nonce(24) ‖ ciphertext`), dengan `senderKeyId` 8 byte =
`BLAKE2b-256("NYX-PQ-GROUP-V4" ‖ signingKeyV2)[:8]` yang dicocokkan constant-time
secara fail-closed. Envelope distribusi sender key naik v2 (77 B) → v3 (85 B,
+senderKeyId) → **v4 (2037 B, +signingKeyV2)**: kunci verifikasi pengirim ikut di
dalam envelope yang sudah diseal per-device, sehingga penerima tidak perlu lookup
bundle — bug nyata yang membuat semua metadata/pesan `sigV: 2` gagal saat
pseudonym pengirim belum bisa di-resolve. `packGroupEnvelope` menolak v4 yang
`senderKeyId`-nya tidak cocok dengan `signingKeyV2`, dan v2/v3 tetap dibaca.

**Burner, recovery, device linking, migration, push.** Burner mendapat init
PQ-only (`pqOnly`): tanpa keypair X25519, root key dari shared secret X-Wing,
`guestClassicalPk: ''` dan `KEMr: null`; link memakai bagian ke-6 opsional
(`…:<HostClassicalPublicKey>:2`) dan link 5-bagian lama tetap valid. Recovery
mengirim `signatureV2` (ML-DSA atas string yang identik dengan v1) dan server
memverifikasinya terhadap `Device.signingKeyV2` **atau** jalur Ed25519 lama.
Device linking memvalidasi panjang `signingKeyV2`, menyimpannya ter-seal di
pending, menulis `cryptoVersion: 2` saat approve, dan menerbitkan entri KT v2.
Migrasi vault membawa `pqPubKey` di QR dan memakai `sealForDevice` /
`openSealedForDevice`; push payload memakai jalur yang sama bila kunci PQ device
tersedia. Semua ini memakai choke point yang sama, jadi fallback perangkat lama
tetap `crypto_box_seal` v1.

**Sealed box v2.** `packages/shared/src/pqSeal.ts` membungkus
`[magic "NYS2"][X-Wing ct 1120][nonce 24][ct]` dengan key `BLAKE2b-256(ss)`;
magic 4 byte dipakai karena v1 dibungkus `[ephemeral X25519 32][ct][nonce][ct]`
sehingga tidak ada byte versi. Pembaca mendeteksi versi dari magic (peluang
salah deteksi 2^-32) lalu memverifikasi panjang minimum.

**Key Transparency Scope A.** Nilai log v2 = 3238 B (v1 1286 B + `signingKeyV2`
1952 B), dipilih otomatis saat `signingKeyV2` tersedia; nilai v1 tetap dibaca.
Verifikasi bundle kini membandingkan **tiga** kunci ke log (X25519 identity,
X-Wing pqIdentity, ML-DSA signingKeyV2) dan mismatch mana pun menghasilkan
verdict `mismatch`. Konfigurasi KT dipin TOFU di tabel Dexie `ktConfig` (v14)
lewat `ktConfigPin.ts`: `signatureKey`/`vrfKey`/`auditorKeys` pertama disimpan
ter-seal `ENC1:` dan perubahan ditolak sebagai `unverifiable`.

**Audit yang menemukan akar bug, bukan gejalanya.** Lapisan persistensi Dexie
(`keychainDb.ts`) menulis state dengan whitelist field eksplisit dan tidak
memuat `signingKeyV2`/`senderKeyId`, sehingga kunci yang sudah terikat saat
distribusi hilang setiap kali state dibaca ulang — inilah akar
"Missing sender signing key v2" (relay dan envelope sudah benar). Field itu
sekarang ikut di `save/getGroupReceiverState`, `archiveGroupReceiverState`,
`listGroupReceiverStates`, dan `save/getGroupSenderState`; relay
`group:fulfilled_key` diuji membawa field v1/v2 di jalur live **dan** content
SYSTEM. Dua temuan audit yang sama ikut ditutup: metadata grup sekarang
didekripsi dengan kandidat era (verifikasi signature per kandidat, fail-closed)
sehingga era lama tetap terbaca setelah state aktif pindah, dan envelope
distribusi membawa `targetDeviceKey` yang disertakan server ke payload SYSTEM
sebagai `targetIdentityKey` (`SYSTEM_DEVICE_FIELDS`) sehingga device yang
di-reset tetap bisa catch-up offline.

**Yang belum.** Belum di-deploy, belum ada build produksi dengan gerbang hidup,
KAT resmi FIPS 204/X-Wing belum dijalankan, scoping versi log di
`ktMonitoring`/`ktGossip` sengaja ditunda sampai Scope B, dan Fase 3–8 (OHTTP,
discovery, credential PQ, anonymous issuance, KT Scope B) belum disentuh.
`.env.example` memuat `VITE_PQ_V2=1` dengan sengaja: dengan gerbang menyala,
alur perpesanan 1:1 dan grup diverifikasi manual berjalan normal. Build dev/E2E
yang menyalin template karena itu mengiklankan v2; produksi tetap harus memilih
nilainya eksplisit, dan belum ada build produksi dengan gerbang hidup.

Dikunci test: `web/src/lib/__tests__/mlDsa.test.ts`,
`server/tests/mlDsa.test.ts`, `server/tests/pqBundle.test.ts`,
`pqHandshake.test.ts`, `pqSeal.test.ts`, `pqCapability.test.ts`,
`x3dhOracleVectors.test.ts` (15 vektor vs oracle Go), `x3dhOracleInterop.test.ts`,
`groupEnvelopeV3.test.ts` (v2/v3/v4), `groupV4Signature.test.ts`,
`keychainDbPersistence.test.ts`, `ktBundleProof.test.ts`, `ktConfigPin.test.ts`,
`recoveryV2Signature.test.ts`, `burnerV2RootKey.test.ts`, dan
`web/e2e/pqV2.spec.ts` (X3DH v2, grup `sigV: 2`, burner PQ-only; skip dengan
alasan tertulis bila gerbang mati). Verifikasi yang menyertai commit: `tsc` web
dan server bersih, `oxlint` 0 error, `go run . -check` untuk vektor oracle, dan
`node scripts/check-pq-only.mjs` lulus tanpa mengubah baseline.

## 🔗 QR device-linking akhirnya bisa dipakai, dan redirect `/login` menjelaskan alasannya (2026-10-18)

`auth:request_linking_qr` sudah lama membuat token 5 menit di Redis lalu
meng-emit `auth:linking_qr_ready`, tetapi tidak ada endpoint redeem, tidak ada
persetujuan perangkat lama, tidak ada listener, dan tidak ada halaman — QR-nya
hanya dekorasi. Sekarang alurnya utuh: perangkat lama menampilkan QR di
**Settings → Active Connections → Link a device**, perangkat baru membuka
`/link?t=<token>`, memasukkan password akun, dan kunci device **baru** dibuat di
perangkat itu (dienkripsi password, server hanya menyimpan bundel terenkripsi).
Perangkat lama menerima `auth:linking_request` dan menyetujui lewat REST
(`/api/auth/link/approve|deny`); setelah disetujui, perangkat baru memanggil
`/link/complete` → `{deviceId, usernameHash}` lalu menyelesaikan sesi lewat jalur
`login()` yang sudah ada. State machine-nya (`utils/deviceLinking.ts`) menyimpan
semua nilai ter-seal di Redis: token sekali pakai, pending 5 menit, dan approve
kedua tidak bisa membuat device kedua. `complete` sengaja **tidak** menerbitkan
token supaya tidak ada jalur sesi kedua untuk diaudit.

Kebijakan “satu akun satu device aktif” tetap berlaku: begitu perangkat baru
masuk, sesi perangkat lama dicabut oleh `issueTokens` (sama seperti login biasa)
— UI menyebutkannya sebelum QR dipindai, bukan setelah pengguna kehilangan sesi.
Transfer riwayat/kunci massal tetap memakai alur migrasi yang sudah ada.

Dua sisa audit ikut ditutup: halaman login kini membaca `reason=revoked|kicked|
banned` (+ `msg`) dan menampilkan alasannya, sehingga perangkat yang dicabut atau
diblokir tidak lagi mendarat di form kosong; dan `NewMessageToast.tsx` (komponen
yang tidak diimpor di mana pun, dengan handler klik yang hanya menutup toast)
dihapus.

Dikunci test: `server/tests/deviceLinking.test.ts` (token sekali pakai, nilai
ter-seal, approve lintas-user ditolak, complete sebelum approve mustahil),
`web/src/lib/__tests__/deviceLinking.test.ts` (bentuk URL/`t` hasil scan),
`web/src/lib/__tests__/loginNotice.test.ts` (tiga alasan redirect).

## 🔌 Audit paritas WebTransport ↔ WebSocket: empat lubang ditutup (2026-10-18)

Fallback WSS ada supaya klien di jaringan yang memblokir QUIC mendapat perilaku
server yang sama. Audit kedua jalur (peta opcode ↔ event, handler, listener, dan
test paritas yang ada) menemukan empat celah nyata — semuanya karena satu jalur
memasang sesuatu yang jalur lain tidak:

**1. Rate limit hanya hidup di gateway WSS.** `chat_message` (120/menit),
`message_ack_delivered` (240/menit), dan `presence_update` (30/menit) dipasang di
`realtime/gateway.ts` saja, sedangkan jalur WebTransport — transport UTAMA — tidak
punya limiter apa pun (sidecar Rust tidak punya, dan `handleUpstreamMessage`
hanya memeriksa active-device). Dampaknya bukan teoretis: satu klien cacat bisa
membanjiri insert DB + fan-out `sendJsonToUser` lewat jalur cepat. Ketiganya kini
hidup di handler (`CHAT_RATE_LIMIT`/`ACK_RATE_LIMIT`/`PRESENCE_RATE_LIMIT`) supaya
KEDUA relay memakai satu penghitung per `(user, bucket)` — dipasang di dua tempat
justru akan menghitung ganda dan membuat limit efektif separuh. Angka untuk WSS
tidak berubah, dan subscription presence tetap punya bucket sendiri (60/menit)
sehingga tidak ikut terkena limit presence umum.

**2. Sinyal panggilan mati total di mode WebSocket.** `WEBRTC_SIGNAL`/`WEBRTC_ICE`
ditandai `noop` di `OUTGOING_OPCODE_MAP` (sinyal keluar hilang diam-diam) dan
gateway tidak mendaftarkan event masuknya — jadi di jaringan yang memblokir QUIC
panggilan tidak pernah bisa tersambung. Arah sebaliknya lebih buruk lagi: envelope
relay `{from,type,payload}` tidak punya field `event`, sehingga cabang default
gateway meng-emit-nya sebagai `message:new` dan klien mencoba mem-parse sinyal
panggilan sebagai pesan chat. Logika relay kini satu tempat
(`handleWebRtcRelay` di `realtimeHandlers.ts`, dipakai WT lewat `redisBridge` dan
WSS lewat gateway), event masuk/keluar memakai nama yang sudah ada di kontrak
shared (`webrtc:secure_signal`), dan klien memetakannya ke `webrtc:signal` yang
sama seperti jalur WT.

**3. `KICK` tidak pernah sampai sebagai event di jalur WebTransport.** Sidecar
hanya menutup koneksi ("Kicked by server") tanpa meneruskan payload-nya, padahal
klien bereaksi pada `force_logout` (`deviceId`/`reason`) — sehingga revoke sesi,
kick device, dan hardware mismatch me-logout instan di WSS tetapi tidak di WT
(hanya putus–reconnect sampai REST 401 muncul). Sidecar sekarang mengirim frame
KICK lebih dulu (stream diselesaikan sebelum close) dan klien memetakan payload
ke alur yang sama dengan gateway: ada `deviceId` → `force_logout` device-scoped;
hanya ada `reason` (akun dihapus/ban) → `auth:banned` seperti sebelumnya.

**4. Event yang di-emit server tapi tidak punya listener di klien.**
`message:deleted_remotely` (unsend peer), `message:deleted_batch` (sweeper
auto-delete), `message:viewed` (view-once dibuka peer), dan `subscription_updated`
(webhook pembayaran) kini ditangani — sebelumnya efeknya baru terlihat setelah
reload/refetch. Alur permintaan kunci sesi 1:1 juga diperbaiki: klien dulu
mendengarkan `session:fulfill_request`, nama yang TIDAK pernah di-emit siapa pun
(server memakai `session:request_key`), dan `FileAttachment` mengirim permintaan
tanpa `targetId` sehingga server selalu menjawab `session:request_key_failed`
("Opaque Mailbox requires targetId"). Deklarasi mati di `packages/shared/src/socket.ts`
(`messages:expired`, `reaction:new/deleted`, `presence:sync`, `typing:update`,
`user:identity_changed`, `conversation:participants_added`, `session:key_requested`,
`session:fulfill_request`, `session:request_key_fulfillment`) dan case handler
`session:request_missing` dihapus supaya tipe tidak menjanjikan yang tidak ada;
`auth:request_linking_qr` dan `messages:distribute_keys` sengaja DIPERTAHANKAN
dengan catatan eksplisit (guard migrasi / kontrak tanpa pemanggil klien).

Sapuan residual berikutnya menemukan sisa kelas yang sama: `message:updated`,
`conversation:participant_updated`, `presence:init`, `presence:user_joined`,
`presence:user_left`, dan `conversation:join` diklaim di kontrak tetapi tidak
punya emitter di server maupun pemanggil di klien — semuanya dihapus (beserta
listener `message:updated` / `conversation:participant_updated` di
`socketListeners.ts`), sehingga `ServerToClientEvents`/`ClientToServerEvents`
kembali hanya memuat nama yang benar-benar dipakai.

Semua lubang itu kini dikunci test: paritas source di `tests/gatewayParity.test.ts`
(bucket rate limit tidak boleh kembali ke gateway; kedua opcode sinyal harus punya
rute keluar; KICK tetap dipetakan ke `force_logout`), perilaku bucket per-jalur di
`tests/realtimeHandlers.test.ts`, peta opcode di `web/src/lib/__tests__/transportMode.test.ts`,
dan listener baru di `web/src/lib/__tests__/socketListeners.test.ts`.

## ⏱️ Timer auto-delete muncul di SEMUA pesan dan ikut hilang setelah reload (2026-10-18)

Setiap pesan 1:1 menampilkan hitung-mundur merah di bubble-nya walaupun pengirim
tidak pernah memilih timer, dan pada pesan yang timer-nya benar-benar dipilih
indikatornya hilang begitu berpindah percakapan. Dua sebab, satu akar:
`expiresAt` dipakai sebagai penanda auto-delete padahal ia **selalu** terisi di
jalur 1:1 (TTL store-and-forward server 14 hari, lalu disingkat jadi 24 jam
begitu pesan di-READ) — dan penanda pilihan pengirim itu sendiri tidak pernah
ada.

Sekarang pengirim menandai pilihannya di dalam ciphertext (`autoDelete: true`,
server tidak melihatnya) pada jalur kirim yang sama dengan `sentAt` presisi,
termasuk bubble optimistik sehingga timernya langsung benar tanpa menunggu echo
server. Penerima mengambil penanda itu saat dekripsi (`captureAutoDelete()`,
sepasang dengan `captureSentAt()` — field asing yang tersisa akan merusak
collapse payload teks dan menampilkan JSON mentah), lalu mempersist-nya di
ShadowVault sebagai flag ter-seal. Aturannya sama seperti reaksi: kiriman yang
tidak membawa penanda (salinan server, tombstone parsial) mempertahankan nilai
lama, jadi timer tidak bisa muncul/hilang sendiri karena pesan ditulis ulang.
`MessageBubble` hanya menjalankan hitung-mundur bila `autoDelete` benar-benar ada.

## ✅ Centang biru muncul prematur & status baca hilang setelah reload (2026-10-18)

Dua keluhan yang tampak terpisah tetapi punya jalur yang sama. Pertama, bubble
pengirim berubah jadi “dibaca” padahal penerima belum membuka percakapannya:
baik `doAddIncomingMessage` (pesan tiba live) maupun
`loadMessagesForConversation` (sync semua percakapan saat connect)
me-receipt `READ`. Padahal “baru tiba” bukan “dibaca” — dan pada 1:1 receipt READ
juga mempersempit TTL ciphertext server jadi 24 jam. Kedua, centang abu/biru di
bubble pengirim hilang setelah berpindah percakapan dan setelah reload, karena
`Message.statuses` tidak pernah ikut disimpan (persis bug reaksi: kolom tidak ada
di daftar tulis `upsertMessages`), jadi peta receipt hanya hidup di memori.

Receipt pesan-tiba sekarang dikirim lewat satu helper (`sendDeliveryReceipts`)
yang mengemas `messages:mark_delivered` dengan `targets` messageId → pengirim
asli hasil dekripsi (wire 1:1 sealed-sender menyimpan `NULL`, jadi peta itu
wajib) dan dipotong per `RECEIPT_CHUNK_SIZE` (= batas batch server). READ kini
hanya datang dari `ChatWindow`/`MessageItem` saat bubble benar-benar terlihat.
`statuses` dipersist sebagai kolom struktur ter-seal dengan aturan sama seperti
reaksi: kiriman tanpa field itu mempertahankan nilai lama, `[]` eksplisit berarti
“tidak ada receipt”, dan entri rusak hanya di-drop tanpa menggagalkan pembacaan
baris.

## 🔐 Riwayat grup jadi `waiting_for_key` setelah kick + re-add (2026-10-18)

Gejala: anggota dikeluarkan dari grup (atau keluar) lalu di-add kembali, sebagian
pesan lama sebelum dia keluar berubah menjadi `waiting_for_key` — padahal pesan
itu dulu bisa dibaca.

**Penyebab: kick menghapus kunci lokal.** `DELETE /:id/participants/:userId`
mengirim `conversation:deleted` ke anggota yang dikeluarkan. Klien memperlakukan
semua event itu sama: `removeConversation` → `shadowVault.deleteConversation()`
+ `deleteConversationKeychain()`, yang menghapus pesan vault **dan seluruh group
receiver state beserta arsip era + skipped keys**. Saat anggota di-add kembali,
riwayat di-fetch ulang dari server tetapi tidak ada kunci era lagi untuk
didekripsi; hanya pesan yang message-key-nya sudah ter-cache yang tetap terbaca
(itulah kenapa hanya *sebagian* yang rusak). Server hanya mengirim event ini ke
socket yang online, jadi gejalanya juga “kadang” muncul.

**Perbaikan.** Askah kick kini membawa `reason: 'removed'` (hapus lokal membawa
`'hidden'`; klien lama mengabaikan field ini). Klien menyembunyikan percakapan
tetapi mempertahankan pesan ShadowVault dan kunci grup per era, sehingga seluruh
riwayat sampai pesan terakhir sebelum keluar tetap terbaca setelah anggota
di-add kembali. Hapus lokal/burner tetap membersihkan riwayat + kunci seperti
sebelumnya. State yang dipertahankan hanya membuka era saat anggota masih
menjadi anggota — era pasca-kick tidak pernah didistribusikan kepadanya, jadi
tidak ada eskalasi akses.

## 👤 Avatar/nama di daftar chat & story tray tidak ikut berubah (2026-10-18)

Satu keluhan dengan dua akar yang saling menutupi: ketika peer mengganti avatar
atau nama, bubble pesan dan modal info user langsung terlihat baru, tetapi baris
daftar chat dan story tray tetap memakai profil lama.

**Cache profil menyematkan versi lama.** Participant 1:1 hanya hidup di klien
(Opaque Mailbox: server tidak mengirim roster), jadi ep (`encryptedProfile`) yang
baru datang lewat event `user:updated` membentuk key komposit baru. Di titik itu
`getCacheOnly` masih punya fallback ke alias plain-id — alias itu berisi hasil
dekripsi ep **lama**, dikembalikan sebagai "cache cepat", lalu `useUserProfile`
berhenti tanpa pernah mendekripsi ep baru. Sekarang alias hanya dipakai pemanggil
yang memang tidak punya ep (`hydrateProfileForPlainId`, participant tanpa profil);
ep baru selalu memaksa dekripsi.

**Snapshot participant tidak pernah di-refresh/dipersist.** Penulisan
`user:updated` hanya cocok untuk `p.id === user.id` (participant pseudonym grup v2
dilewati, padahal deteksinya sudah pseudonym-aware), hasilnya tidak ditulis ke
ShadowVault sehingga hilang lagi setelah reload, dan contact store tidak ikut
disegarkan. Sekarang pembaruan memakai pencocokan kanonik (pseudonym dipertahankan,
bukan ditimpa userId asli), dipersist ke vault, langsung mendekripsi profil, dan
meng-upsert kontak. Dua jalur tambahan menutup kasus event terlewat: saat
`loadConversations` profil peer diambil dari pengirim pesan terakhir (pesan server
membawa ep terbaru — sumber yang sama yang membuat bubble selalu segar), dan tiap
pesan 1:1 masuk menyegarkan participant pengirimnya.

## 🔥 Burner Chat: guest tidak bisa kirim pesan & destroy host tidak sampai (2026-10-18)

Dua keluhan, satu tema: kegagalan burner berhenti di `console.error` dan tidak
punya jalur pulih.

**Guest tidak bisa mengirim (Enter/klik kirim = diam).** `sendMessage`
mengembalikan `void`, jadi semua kegagalan tidak terlihat: transport mati hanya
menumpuk payload di antrean offline, ack tidak pernah datang, dan setelah timeout
15 detik pun tidak ada apa pun di UI — sementara teks input sudah dikosongkan.
Pemicu paling sering: sesi guest **tidak punya refresh token** (server sengaja
tidak mempersist-nya) sedangkan access token hanya 15 menit, sehingga guest yang
sesi-nya lebih lama terus menyambung dengan token mati; jalur lama hanya meminta
token baru ketika `user` kosong. Sekarang `ensureBurnerTransport()` memastikan
transport hidup (token lama → gagal → terbitkan identitas guest baru), `sendMessage`
mengembalikan `{ok, error}` dan **tidak** mengenkripsi pesan saat transport tidak
bisa disambungkan (ratchet tidak terbakar oleh pesan yang tidak pernah keluar),
serta UI menampilkan toast alasan gagal tanpa menghapus teks yang diketik.

**Destroy host tidak sampai ke guest (+ room masih terbuka setelah refresh).**
Destroy hanya disiarkan sebagai event realtime ke anggota room, dan `destroy`
sendiri dikirim lalu langsung redirect — navigasi bisa memutus transport sebelum
payload terkirim. Selain itu membership hilang setiap kali transport putus
(`handleDisconnect` menyapu semua `burner:room:*`), sehingga destroy berikutnya
tidak menemukan guest. Perbaikan berlapis: host **menunggu ACK** destroy sebelum
pindah halaman; server **meng-ACK** `burner:send/reply/destroy` (room terminated
menjawab `ROOM_TERMINATED`, bukan hening), `burner:join` mengembalikan status room,
dan pengirim di-`sAdd` ulang ke room (self-heal). Gerbang utamanya tetap: endpoint
baru `GET /api/burner/:roomId/status` diperiksa saat `/drop` dibuka, ditambah
penanda lokal `burned_<roomId>` — jadi guest yang me-refresh halaman (atau sedang
offline saat destroy) tidak lagi masuk ke room yang sudah mati.

## 💬 Preview daftar chat salah / berubah jadi "belum ada pesan" (2026-10-18)

Dua keluhan yang akarnya sama: preview baris terakhir di daftar percakapan.

**"Belum ada pesan" padahal riwayatnya ada.** Banyak pesan internal memang tidak
punya representasi visual: `CALL_INIT`, `GHOST_SYNC`, `PROFILE_SYNC`, `COVER`,
`GROUP_KEY`, `UNSEND`, `reaction_remove`, `SYSTEM_KEY_REQUEST`, `STORY_KEY`.
`withPreview` hanya mengenali empat tipe; sisanya jatuh ke cabang "teks biasa",
sehingga payload JSON **mentah** dipakai sebagai preview (termasuk
`{"type":"PROFILE_SYNC","profileKey":…}`). Tipe yang dikenali pun menghasilkan
`preview: ''`, dan pesan-pesan itu tetap disimpan serta tetap dipakai sebagai
`lastMessage` — jadi daftar chat menampilkan "No messages yet" untuk percakapan
yang jelas berisi. Sekarang ada satu aturan di `utils/messagePreview.ts`: hanya
pesan yang benar-benar terlihat (teks terbaca, lampiran, atau view-once) yang
boleh menjadi preview; pesan kontrol tidak pernah menggantikannya dan tidak
menaikkan unread.

**Preview flaky.** Tiga jalur menimpanya secara bergiliran:
`loadConversations` hanya mengambil **satu** baris terbaru dari vault (kalau baris
itu kontrol, preview runtuh); hasil sync menimpa seluruh daftar sehingga pesan
live yang tiba di tengah `await` hilang lagi; dan handle pesan yang tiba
sebelum `conversation:new` dibuang diam-diam (`if (!conversation) return state`).
Kini sync memindai jendela baris terbaru lalu memilih yang terlihat
(`pickPreviewLastMessage`), penggabungan dengan state live menolak menurunkan
preview yang lebih baru (unread yang bertambah ikut dipertahankan), dan preview
untuk percakapan yang belum ada disimpan sementara lalu dipasang saat
percakapannya muncul.

Ikut diperbaiki karena satu akar: menghapus/unsend atau membuka pesan view-once
**yang sedang menjadi preview** dulu menuliskan nisan ke `lastMessage` (preview
jadi kosong) atau meninggalkan teks pesan yang sudah dihapus (preview basi).
Sekarang preview dihitung ulang ke pesan terlihat berikutnya lewat aksi baru
`forceConversationLastMessage`, dan `null` hanya dipakai bila riwayatnya memang
habis.

## 🧷 "Internal server error" saat verify biometric + backup awan ditolak (2026-10-18)

Dua keluhan yang ternyata satu rantai. Menekan verifikasi perangkat berakhir dengan
toast "internal server error", dan membuat `.nyxbak` dengan centang awan berakhir
dengan toast gagal unggah walau berkas lokalnya sudah tersimpan.

**Penyebab pertama** ada di `GET /api/auth/webauthn/register/options`:
`excludeCredentials[].id` dikirim sebagai `Buffer` (hasil decode base64url).
`@simplewebauthn/server` v13 memvalidasi setiap id dengan `isBase64URL()` →
`trimPadding()` → `input.replace(...)`, dan `Buffer` tidak punya `.replace`, jadi
setiap akun yang **sudah punya authenticator** — yaitu justru akun yang mencoba
memverifikasi diri — mendapat `TypeError: input.replace is not a function` dan 500.
Log produksi 2026-10-18 03:42 mencatat persis error itu. Sekarang id dinormalkan ke
`Base64URLString` (`utils/webauthnCredentials.ts`): base64url dipakai apa adanya,
base64 standar dikonversi, baris tak terpakai dibuang tanpa menjatuhkan sisa daftar.

**Penyebab kedua** adalah akibat dari yang pertama ditambah dua klaim palsu di UI.
`isVerified` hanya naik lewat `/webauthn/register/verify` (kredensial baru) atau
Proof of Trust, tetapi jalur "pakai credential yang sudah ada" di Settings tidak
menyentuh server sama sekali — sementara toastnya berbunyi "biometrik aktif".
Pengguna pun melihat biometrik "berhasil" sambil unggahan awan terus ditolak 403
(`SANDBOX_UPLOAD_RESTRICTION`), dan modal backup menyebutnya "gagal unggah" seolah
gangguan jaringan. Sekarang: toast mengikuti `user.isVerified` (bukan asumsi), dan
kegagalan unggah 403 dipetakan ke alasan yang bisa ditindaklanjuti — plus alasannya
menetap di panel hasil, tidak hanya lewat toast yang hilang. Pesan error verifikasi
di Settings juga menampilkan penyebab server, bukan lagi "Unknown error".

Verifikasi: `server/tests/webauthnCredentials.test.ts` memanggil
`generateRegistrationOptions` yang sebenarnya (bentuk Buffer wajib melempar, bentuk
baru wajib lolos dengan id utuh), `server/scripts/webauthn-exclude-check.ts`
mengulang hal yang sama pada credential NYATA di DB, dan probe ber-JWT ke instance
yang berjalan mengembalikan 200 dengan `excludeCredentials` berisi id yang sama
(sebelumnya 500).

## 👍 Reaksi di bubble pesan tidak bertahan (2026-10-18)

Mengirim reaksi tampak berhasil, lalu gelembung kecilnya hilang begitu berpindah
percakapan — dan tidak pernah kembali setelah reload. Penyebabnya sederhana dan
menyeluruh: **reaksi tidak pernah ikut disimpan**. `upsertMessages` menulis daftar
kolom yang eksplisit dan `reactions` tidak ada di daftar itu (juga tidak ada di
`DecryptedMessageRecord`), jadi reaksi hanya hidup di store:

- `loadMessagesForConversation` langkah 1 (baca vault → replace store) menghapusnya
  setiap kali percakapan dibuka kembali, begitu juga `loadMessageContext`;
- reload hanya bisa memulihkannya bila pesan sinyal `{"type":"reaction"}` kebetulan
  ikut ter-fetch ulang dan masih bisa didekripsi (tidak ada jaminan itu);
- jalur kirim reaksi (`addLocalReaction`, `replaceOptimisticReaction`,
  `removeLocalReaction`) memang hanya memutasi store, dan sinyal hapus reaksi pun
  tidak pernah menulis apa pun.

Sekarang `reactions` ikut dipersist sebagai kolom struktur ter-seal (`ENC1:`) —
pola yang sama dengan `senderId`/`repliedToId` (emoji + userId = metadata
perilaku, jadi tidak boleh plaintext). Dua aturan yang penting: kiriman tanpa
field `reactions` (salinan server, tombstone parsial) **mempertahankan** reaksi
yang sudah tersimpan, sedangkan `[]` eksplisit berarti “dibersihkan” (unsend).
Ketiga mutator reaksi lokal kini menulis keadaan terbaru ke vault sendiri,
sehingga reaksi sendiri tetap bertahan walau echo socket tidak datang atau
kiriman sedang offline. Merge pesan pada sync juga membawa `reactions` dari
salinan mana pun yang memilikinya — menangnya salinan server (yang tidak pernah
memuat reaksi) tidak lagi menghapusnya dari UI.

## 🔐 Logout sendiri saat idle + `/login?reason=revoked` di perangkat yang sama (2026-10-18)

Gejalanya flaky: aplikasi dibiarkan idle, tab kehilangan fokus, lalu tiba-tiba
sesi berakhir dan URL berisi `reason=revoked` — padahal perangkat & browser-nya
sama. Log produksi menunjukkan penyebabnya: `[Security] Refresh token reuse
detected!`, satu per insiden, masing-masing dengan `familyId` baru (artinya user
sudah login ulang). Tiga kejadian klien yang normal ditafsirkan sebagai
pencurian token:

1. **Respons rotasi hilang / lambat.** Klien mem-POST `rt` = R1; server merotasi
   ke R2 lalu respons hilang (tab di-freeze, jaringan pindah, timeout request
   30 s). Klien mengulang dengan R1 — tetapi toleransinya hanya
   `now - R2.createdAt < 5 s`, sementara timeout + retry wajar sudah melewati
   jendela itu → seluruh family di-revoke.
2. **Family sudah mati.** Satu tab logout (atau sesinya dicabut) → family
   di-revoke; tab lain yang tertinggal mem-POST token lama. Dulu ini tetap
   dianggap serangan dan mem-broadcast `force_logout` — padahal tidak ada sesi
   hidup yang perlu dilindungi.
3. **Device lain ikut ter-logout.** Event `force_logout` dikirim tanpa `deviceId`
   ke **semua** socket milik user, jadi mencabut satu sesi me-logout seluruh
   perangkat.

Keputusan replay sekarang lewat helper murni `server/src/utils/refreshReplay.ts`:
family tanpa token hidup → 401 biasa (tanpa alarm, tanpa broadcast); token yang
merupakan **pendahulu langsung** dari tip hidup dan berumur ≤
`REFRESH_REPLAY_GRACE_MS` (default 2 menit, clamp 24 jam) → dianggap retry benign
dan rantai dilanjutkan; selebihnya baru replay asli → family di-revoke +
`force_logout` dengan **scope `deviceId`** (payload & target). Cleanup tidak lagi
menghapus baris revoked setiap hari — retensi 7 hari supaya rantai
`replacedById` tetap ada untuk klasifikasi ini.

Di sisi klien, `authFetch` tidak lagi memanggil handler logout untuk kegagalan
refresh yang **transien**: `refreshRetry` menandai `auth` (401/403) vs
`transient` (offline/timeout/5xx), dan hanya yang pertama boleh logout — karena
logout mem-POST `/api/auth/logout` yang me-revoke seluruh family. Satu gangguan
jaringan singkat saat tab resume tidak lagi mematikan sesi di semua tab, dan
`bootstrap()` mempertahankan sesi lokal kalau kegagalannya transien.

## 👤 Anggota baru bisa menerima tapi tidak bisa mengirim pesan grup (2026-10-18)

Gejalanya asimetris dan itu yang membuatnya lama dicari: anggota yang baru
ditambahkan **menerima** semua pesan, tetapi setiap kiriman darinya gagal.
Penyebabnya satu baris metadata. `rotateGroupKey` menyusun metadata rotasi
dengan `...existingMeta`, sehingga `pseudonymMap` era lama ikut terkirim;
`encryptGroupMetadata` hanya meregenerasi peta bila `pseudonymMap` **tidak ada**.
Peta lama itu tidak memuat anggota baru, jadi `getMyPseudonym()` → `undefined`,
`ensureMyPseudonym()` juga tidak menemukannya, dan jalur kirim berhenti di
`requireGroupSenderIdentity()` — sebelum `message:send`. Dekripsi pesan masuk
tidak butuh pseudonym milik penerima, makanya hanya arah kirim yang rusak.

Penyusunan metadata rotasi dipindah ke helper murni
`web/src/lib/groupMetadataRotation.ts`: peta lama dibuang (penulis metadata
meregenerasi untuk roster saat ini), role anggota lama dipertahankan, anggota
baru diberi `joinedAtGeneration`, dan `generation` sengaja **belum** dinaikkan
supaya `encryptGroupMetadata` menaikkannya tepat sekali (bukan +2). Helper yang
sama menggabungkan `deliveryTokenMap` hasil invite — sebelumnya token itu hanya
dikirim ke server sementara peta lokal tetap stale.

Dua penyebab pendukung ikut ditutup. `addParticipants` tidak lagi memanggil
`forceRotateGroupSenderKey` (pemanggil admin sudah memanggil `rotateGroupKey`
eksplisit; dua jalur bersamaan = dua era dalam hitungan detik), dan setelah
`storeReceivedSessionKey` sukses, pipeline mencoba ulang dekripsi metadata yang
tiba sebelum kunci era-nya — dulu grup bisa tertahan “Unknown Group” sampai
reload. Rotasi periodik PCS kini hanya dijalankan admin (PUT `/:id/details`
memang admin-only; non-admin dulu tetap meng-update blob lokal setelah 403) dan
mengemit `metadata:updated` seperti `rotateGroupKey`.

## 🧾 Attestation pendaftaran akhirnya bisa dipantau & bundle root bisa disegarkan (2026-10-17)

Tiga hal yang sebelumnya hanya bisa diketahui dengan mengingat atau menebak:
penolakan attestation, isi bundle root, dan tanggal kedaluwarsa daftar root.
Semuanya gagal **tanpa error** — `403 ATTESTATION_REJECTED` satu baris per
percobaan, atau berkas yang diam sampai perangkat baru tidak bisa mendaftar.

**Metrik hasil gerbang.** `nyx_attestation_registration_total{result,reason}`
menghitung setiap keputusan `/register`: `accepted`, `rejected`, `missing`,
`challenge_invalid`, `malformed`. Label `reason` memakai kode pendek dari
`attestationReasonCode()` (`root_not_trusted`, `certificate_expired`,
`synced_authenticator`, …; kode baru yang belum dipetakan masuk `unmapped`,
bukan hilang). Pemetaan itu perlu karena `metrics.ts` menolak nilai label >24
karakter atau berbentuk base64url/UUID — kode asli seperti
`SYNCED_AUTHENTICATOR_NOT_ALLOWED` akan ditolak dan penolakan yang ingin dilihat
operator justru lenyap.

**Empat alert baru** (`ops/prometheus/alerts.yml`, grup `nyx-app`):
`NyxAttestationRootNotTrusted` (`for: 0m` — setiap penolakan jenis ini adalah
orang nyata yang tidak bisa mendaftar), `NyxAttestationRejectionRateHigh` (rasio
>50% terhadap accepted+rejected dengan minimal 3 penolakan/jam, bukan jumlah
mentah), `NyxAttestationRootExpired`, dan `NyxAttestationRootBundleStale`
(`nextUpdate` MDS lewat). Penyebut rasio dijaga `or vector(0)` + `clamp_min`
supaya jendela tanpa sampel tidak menghasilkan NaN yang membuat aturan diam.

**Skrip refresh dengan verifikasi, bukan sekadar unduh.**
`scripts/attestation-roots.mjs refresh` mengambil FIDO MDS (JWS RS256/ES256
diverifikasi dengan kunci leaf `x5c`, seluruh tautan rantai + masa berlaku +
identitas `CN=mds.fidoalliance.org`, fingerprint rantai dipin TOFU di metadata,
`--mds-root` untuk anchor GlobalSign eksplisit), Android, dan Apple; lalu
membuang non-CA, kedaluwarsa, duplikat, dan seluruh root dari entri MDS berstatus
kompromi/revoked. `check` memberi peringatan (nextUpdate, root kedaluwarsa, sha256
metadata) dan `--strict` menjadikannya exit 2 untuk cron; opsi tak dikenal ditolak
(`check --file` salah ketik = exit 1, bukan diam-diam memeriksa bundle default).
Unduhan mengulang sendiri untuk 429/5xx (menghormati `Retry-After`, tiga
percobaan) karena MDS membalas 429 bila dipanggil berdekatan — terbukti saat
menyegarkan bundle selfhost: percobaan ulang berjalan sesuai jadwal dan
kegagalan tetap berakhir exit 1 tanpa menulis berkas setengah jadi.
Uji nyata dengan blob
MDS seri 291 (520 entri): 1094 kandidat → 208 root, +2 Android +1 Apple = 209
root; 27 kedaluwarsa, 78 non-CA, 1 entri kompromi dibuang. Bundle yang sama
menghasilkan sha stabil pada refresh kedua, dan JWT yang diubah satu byte
ditolak sebelum satu pun root ditulis.

**Peringatan boot + gauge.** `utils/attestationRootsHealth.ts` membaca bundle +
`<bundle>.meta.json` tiap start dan memperingatkan metadata hilang, `nextUpdate`
lewat/≤30 hari, root kedaluwarsa/≤30 hari, dan sha256 yang tidak cocok (berkas
diganti manual). Gauge `nyx_attestation_roots_expired_certs` +
`nyx_attestation_roots_next_update_timestamp_seconds` mengisi dua alert terakhir;
tanpa `ABUSE_ATTESTATION_ROOTS_FILE` keduanya tidak di-set, jadi aturan diam
(panel/alert tidak menyala palsu untuk deployment tanpa attestation).

**Verifikasi.** 10 kasus `node:test` baru (`server/tests/attestationRootsHealth.test.ts`),
`scripts/drill-alerts.sh` lulus: 39 aturan kompilasi, semua kasus
menyala/tidak-menyala, dan 30 metrik yang dirujuk aturan sudah dideklarasikan.
Bundle produksi saat ini (222 root) **tidak** otomatis diganti: `check`
melaporkan 13 root kedaluwarsa dan metadata belum ada, jadi boot berikutnya akan
memperingatkan sampai operator menjalankan `refresh` (langkahnya di
`ops/attestation/README.md` dan docs/10 §10.16).

## ⏱️ Latensi jalur WebTransport vs WSS terukur — penurunan jalur cepat terlihat sebelum sidecar mati (2026-10-17)

Sisa WS-G yang sebelumnya hanya bisa dijawab dengan "sidecar hidup": jalur cepat
yang **MELAMBAT** tidak menghasilkan satu pun error. Klien tidak tahu ia sedang
memakai jalur yang seharusnya lebih cepat, sidecar tetap `up`, dan alert
`NyxTransportSidecarDown` diam — sampai handshake-nya gagal dan semua klien mundur
ke WSS. Dua histogram baru menutup jendela itu.

**Dua titik ukur, dua proses.** `nyx_transport_ingress_seconds` (sidecar Rust,
`:9465`) mengukur hop yang benar-benar dimiliki sidecar: dari frame klien utuh
diterima sampai Redis menerimanya di `nyx:upstream:<opcode>` — diukur di ketiga
jalur masuk (bidi, uni, datagram), hanya saat publish berhasil, dan timer-nya
dimulai setelah pembacaan selesai (waktu tunggu klien bukan bagian dari latensi
server). `nyx_wss_ingress_seconds` (nyx-api, `:9464`) mengukur padanannya di jalur
cadangan: dari event socket.io diterima sampai handler selesai, termasuk validasi,
rate limit, pemeriksaan perangkat, dan publish ke `nyx:downstream`.

Cakupan keduanya **tidak identik dan itu disengaja**: pekerjaan yang di jalur WSS
masuk span-nya justru terjadi di proses Node SETELAH hop yang diukur sidecar. Jadi
span WSS memuat lebih banyak pekerjaan, dan aturan pembandingnya hanya menyala
ketika jalur cepat benar-benar sudah kehilangan keunggulannya.

**Tanpa dependency baru di kedua sisi.** Sisi Rust mendapat dukungan histogram
minimal di `metrics.rs` (bucket kumulatif + `_sum`/`_count`, jumlah disimpan
sebagai mikrodetik `u64` supaya penjumlahannya tanpa kunci dan tanpa galat
pembulatan; nilai NaN/negatif DIBUANG, bukan dijepit — satu `NaN` yang lolos akan
meracuni p95 selamanya). Sisi TS memakai `defineHistogram` yang sudah ada, dengan
pembungkus `server/src/utils/transportLatency.ts` yang dipisah dari `gateway.ts`
supaya bagian yang bisa salah bisa diuji tanpa soket.

**Bucket wajib sama, dan itu diuji.** `INGRESS_BUCKETS` (metrics.rs) ↔
`WSS_INGRESS_SECONDS` (metrics.ts) memakai batas yang identik: p95 dari dua
histogram dengan pembagian bucket berbeda tidak sebanding, dan itu tidak
memunculkan error apa pun — hanya perbandingan yang bohong. Keduanya juga
dirender bernilai 0 sejak proses hidup (tanpa observasi), jadi panel laju
menampilkan **0**, bukan "No data", dan penjaga `rate(..._count[15m]) > 0` bekerja
seperti yang dimaksud.

**Tiga aturan baru (32 → 35), semuanya `warning`:**

- `NyxTransportIngressSlow` — p95 hop sidecar > 250 ms (normalnya sub-milidetik)
  selama 15 menit. Jaring terakhir tanpa pembanding: berarti event loop kelaparan,
  Redis lambat, atau chaff membanjiri jalur baca.
- `NyxTransportSlowerThanWss` — p95 jalur cepat > p95 jalur cadangan selama 30
  menit, dengan trafik di KEDUA jalur. Inilah "penurunan jalur cepat" dalam bentuk
  paling faktual, dan sengaja dipakai alih-alih ambang milidetik karena tidak
  bergantung pada kecepatan CPU host.
- `NyxTransportUnused` — sesi WT pernah ada lalu habis sementara WSS terus
  melayani, dan prosesnya masih `up`: jalur cepatnya **tidak melambat dan tidak
  mati, hanya berhenti dipakai**. Keempat aturan transport lain diam semua di
  keadaan ini (handshake bisa saja sukses, frame sah, auth bersih), jadi tanpa
  aturan ini penurunannya hanya terlihat oleh orang yang kebetulan membuka
  dashboard. Penjaga `max_over_time(nyx_transport_active_sessions[1h]) > 0`
  membuat instalasi yang memang belum pernah memakai jalur cepat — termasuk
  mesin ini, selama WT belum terjangkau dari publik — tetap diam, karena
  "selalu nol sejak awal" bukan penurunan.

**Verifikasi.** `cargo test` 18 lulus (termasuk dua uji histogram: deret nol tanpa
observasi, dan semantik bucket kumulatif + `_sum` dalam detik), suite server
**455 test (453 lulus, 2 skip opt-in)**, `tsc --noEmit` bersih, `promtool test
rules` lulus dengan **10 kasus baru** — termasuk dua yang khusus menjaga alarm
palsu di keadaan nyata mesin ini: histogram kosong (nol observasi, kuantil = NaN)
dan tanpa trafik WebTransport sama sekali. Enam kasus baru itu memakai nilai p95
yang dihitung tangan dari distribusi bucket-nya (mis. semua observasi di `le="1"`
→ p95 = 0,9625 s), bukan ambang yang digeser agar lulus.

**Dashboard: satu baris + empat panel baru** — "Latensi jalur: WebTransport vs WSS"
(p95 per jalur dengan garis ambang 250 ms, laju ingress per jalur untuk melihat
jalur mana yang benar-benar dipakai klien, rasio WT÷WSS, dan p50/p95/p99 jalur
cepat). Dokumen: `docs/10` §10.12, `docs/23` §23.2, `docs/25`, `AGENTS.md`.

**Batas yang jujur.** Tanpa telemetry klien, yang bisa diukur adalah **hop sisi
server**, bukan latensi yang dirasakan klien (RTT jaringan tidak masuk ke angka
mana pun — itu batas yang sudah berlaku untuk seluruh sistem ini). Dan di mesin
ini kedua histogram masih tanpa sampel karena belum ada klien yang terhubung: panel
p95 akan menampilkan "No data" (NaN, bukan 0) sampai ada trafik nyata — itulah
sebabnya aturan latensi dijaga penjaga laju, dan sebabnya kasus drill "histogram
kosong" ada.

## 📊 Dua proses senyap akhirnya bisa dilihat: exporter `nyx-sidecar` + `nyx-kt-query`, dan notifikasi Alertmanager → ntfy (2026-10-17)

Tiga residual WS-G yang selama ini tercatat di `~/nyx-selfhost/README.md` §6c
ditutup sekaligus. Ketiganya punya akar yang sama: **kegagalan yang tidak
menghasilkan error di mana pun**.

**1. `nyx-sidecar` (Rust) tidak punya `/metrics`.** Klien yang gagal handshake
WebTransport tidak error — ia turun ke WSS secara senyap
(`web/src/lib/transportMode.ts`), jadi sidecar boleh mati berhari-hari dan yang
hilang hanya latensi. `server/transport-sidecar/src/metrics.rs` (baru) menambah
10 keluarga `nyx_transport_*` (koneksi/handshake, auth per metode + alasan gagal,
kick perangkat, frame yang dibuang, relay terkirim per jalur, downstream, byte
per arah, sesi aktif, umur proses) dan eksposisi teks Prometheus 0.0.4 **tanpa
dependency baru**. Nilai label semuanya enum bertipe, jadi tidak ada string bebas
yang bisa menyelundupkan identitas — dan karena renderer menuliskan **seluruh**
nilai enum (bernilai 0 sejak scrape pertama), `increase()` tetap bermakna lintas
restart. Listener wajib loopback: alamat non-loopback ditolak saat start.

**2. `nyx-kt-query` (Go) tidak punya `/metrics`.** Proses ini **fail-open**: kalau
ia mati, registrasi dan rotasi kunci tetap sukses, hanya tanpa jejak audit —
tidak ada satu pun error di aplikasi yang menunjuk ke sana.
`server/kt-query/metrics.go` (baru) menambah 8 keluarga `nyx_kt_query_*` (tulisan
per hasil, baca per operasi, percobaan snapshot, ukuran pohon, umur proses, dua
gauge kunci, penjaga privasi) di `NYX_KT_METRICS_ADDR` (default
`127.0.0.1:9467`).

**3. Tidak ada yang memberi tahu operator.** `prometheus.yml` sekarang punya blok
`alerting:` → Alertmanager `127.0.0.1:9093`; Alertmanager (0.34.1) **tidak punya
receiver ntfy**, jadi `ops/alertmanager/` berisi config **tanpa rahasia**
(receiver = relay loopback) + `ntfy-relay.mjs` (payload JSON v4 → pesan ntfy,
prioritas dari `severity`, `--self-test`). Topik + token hidup di EnvironmentFile
0600 di VPS, tidak di repo. Port relay 9095 (bukan 9094: itu listener gossip
Alertmanager sendiri — memakainya membuat proses gagal start).

**Aturan alert: 23 → 32** dalam 5 grup (`nyx-app`, `nyx-transport`,
`nyx-kt-query`, `nyx-kt-auditor`, `nyx-host`). Sembilan aturan baru memisahkan
kelas kegagalan yang tindakannya berbeda: `…Down` (proses/exporter hilang),
`…Restarting` untuk kedua proses baru (`changes(up[1h]) > 2` **atau**
`resets(uptime[1h]) > 1`, karena restart lebih cepat dari satu irama scrape tidak
pernah terlihat `up == 0`), lonjakan auth/frame di sidecar (dengan
`reason="chaff"` sengaja **dikecualikan** — itu traffic-cover normal), tulisan log
KT yang error, snapshot lokal yang berhenti dibuat, dan anchor `distinguished`
yang berhenti berputar.

**Cacat yang ditemukan saat menulis aturan itu.** Gauge
`nyx_kt_query_distinguished_timestamp_seconds` awalnya hanya di-set **sekali saat
start**: alert "anchor basi" (ambang 30 menit) karena itu akan menyala **palsu di
setiap restart** sekaligus tetap buta terhadap loop yang benar-benar berhenti —
persis kelas kesalahan yang sudah pernah terjadi di sisi TS (alarm palsu snapshot
2026-10-16). `updateDistinguished` sekarang mempublikasikan nilai yang
**benar-benar ditulis** pada setiap putaran yang berhasil, dan ada kasus drill
khusus untuk regresi ini.

**Verifikasi (dijalankan, bukan diasumsikan).** `go vet` + `go test ./...`
bersih (termasuk `metrics_test.go` baru); `cargo` + unit test exporter sidecar;
`promtool check config`/`check rules` → 32 aturan; `promtool test rules` → semua
kasus menyala **dan** tidak-menyala lulus (20 kasus baru, termasuk regresi label
child pra-0 dan restart cepat); `scripts/drill-alerts.sh` sekarang membaca
**empat** sumber deklarasi metrik (`metrics.ts`, dua `metrics.go`, `metrics.rs`)
dan menolak aturan yang merujuk metrik tak terdeklarasi. Di mesin ini: keempat job
`up` (`9464`/`9465`/`9466`/`9467`), Alertmanager aktif di Prometheus, dan
notifikasi ujung-ke-ujung terbukti (alert uji masuk, berikut `resolved`-nya).

**Dokumentasi.** `docs/10` §10.12 (tabel metrik dua exporter baru + seluruh
sub-bagian notifikasi), `docs/23` §23.2 (metrics sidecar), `server/kt-query/README.md`
(env + metrik), `ops/systemd/README.md` (verifikasi + gejala), `docs/25`, `AGENTS.md`,
`~/nyx-selfhost/README.md` §6c.

**Sisa yang jujur.** `nyx_kt_snapshot_remote_latest_timestamp_seconds` masih
kosong di mesin ini (belum ada satu pun arsip di R2 — jalur unggahnya sudah
dikonfigurasi, cron 03:30 belum berjalan sejak itu), jadi
`NyxKtSnapshotNotUploaded` menyala dan itu **benar**; ia hilang setelah satu
putaran unggah sukses.

## 🔁 Rotasi kunci identitas kini tertulis di log KT — celah "log memuat kunci lama" ditutup (2026-10-17)

Sisa WS-A sebelumnya: tiga jalur menimpa `Device.publicKey` **tanpa** entri log
(`POST /keys/prekey-bundle`, `PUT /users/me/keys`, re-sync kunci
`POST /auth/login`). Akibatnya, setelah rotasi yang sah, log masih memuat kunci
LAMA: peer memverifikasi bundle → verdict `mismatch` (kunci tersaji ≠ kunci log)
→ `peerIdentityTrust` menyimpannya sebagai `ktMismatch` + `pendingKey` → gate
kirim menutup sampai user menerima "perubahan kunci" yang sebenarnya rotasi biasa.

**Kenapa tidak bisa diperbaiki sepihak di server.** Search key log =
`0x75 || Argon2id(raw)`, sedangkan yang tersimpan di DB adalah identifier
ter-pepper (`pepperedIdentifier`) yang tidak bisa dibalik tanpa pepper. Jadi
server **tidak bisa** menurunkan search key sendiri — nilai mentahnya harus
datang dari klien, dan justru itu yang membuat verifikasi kepemilikan wajib.

**Server — `server/src/utils/ktIdentityLog.ts` (baru).** `publishIdentityKeyChange`
menulis entri rotasi dengan aturan yang eksplisit:

- **Kepemilikan diverifikasi:** `identifierLookupCandidates(kiriman)` harus memuat
  `User.usernameHash` pemanggil. Tanpa ini, siapa pun yang sudah login bisa
  menulis entri ke search key **akun lain** (log = ruang publik, vektor
  poisoning). Ditolak → `nyx_kt_writes_total{result="identifier_mismatch"}`.
- **Penyaring rotasi:** `identityKeysChanged` membandingkan material sebelum vs
  sesudah — upload ulang bundle yang sama (auto-heal, login biasa) tidak menulis
  entri. Dedupe lama saja tidak cukup (umurnya 10 menit).
- **Fail-visible, tidak pernah menahan respons:** fire-and-forget (`void`) di
  ketiga jalur, dan alasan kegagalan bisa dibedakan — `no_identifier` (klien lama
  tidak melampirkan identifier), `invalid` (kunci wajib tidak lengkap),
  `identifier_mismatch`, `ok`.
- **Label alur, bukan angka sihir:** `KT_KEY_VERSION_REGISTRATION` /
  `_RECOVERY` / `_ROTATION` menggantikan literal `keyVersion: 1`/`2` di
  `routes/auth.ts`. Format nilai log tetap beku (`docs/32`); yang berubah hanya
  konstanta penamaannya.
- Jalur yang **sengaja** tidak menulis log: device dummy iframe B2B
  (`routes/engine.ts`) — akun tenant, kunci dummy, tanpa identifier Argon2id.

**Klien — identifier ter-seal, scoped per user.** `keyStorage` menyimpan
identifier mentah sebagai envelope `ENC1:` (masterSeed) dengan slot per user
(`nyx_kt_identifier:<userId>`), diisi saat login & register, dibuang saat logout,
**tidak** dibuang saat `lockApp` (vault terkunci hanya membuat pembacaan gagal).
`setupAndUploadPreKeyBundle` melampirkan `usernameHash` pada body bundle hanya
bila nilainya ada — klien lama/terkunci tetap jalan, servernya mencatat
`no_identifier`.

**Verifikasi.** `server/tests/ktIdentityLog.test.ts` (baru, 8 test): kepemilikan
identifier (tolak + metrik), nilai yang benar-benar ditulis (keyVersion rotasi,
kunci cocok, hanya material publik), `no_identifier`, kunci tidak lengkap,
no-op tanpa `KT_SERVER_URL`, penyaring `identityKeysChanged`, dan guard sumber
ketiga jalur. Guard lama diperbarui ke konstanta label. Web:
`src/lib/__tests__/ktIdentifierStorage.test.ts` (7 test) — penyimpanan ter-seal
(bukan plaintext), scoping antar-akun, clear hanya slot sendiri, dan wiring store
(`login`/`register` menyimpan, `logout` membersihkan, body bundle melampirkan).
Suite: **server 445 test (444 lulus, 1 live opt-in skip)**, **web 684 test lulus**,
`tsc --noEmit` bersih di kedua paket.

**Insiden kecil yang tercatat jujur — dan penyebab + penutupnya.** Test live
pertama untuk jalur rotasi memakai gate `skip: !process.env.KT_SERVER_URL`. Gate
itu tampak benar tapi salah di repo ini: `server/.env` **selalu** mengisi
`KT_SERVER_URL`, dan `src/config.ts` (`import 'dotenv/config'`) memuatnya begitu
sebuah modul menarik `atRestSecrets` — sehingga saat suite penuh dijalankan,
test "live" itu benar-benar jalan dan **menulis dua entri uji ke log self-host**
(`127.0.0.1:8081`, `nyx-kt-query`). Log KT append-only, jadi entri itu tidak bisa
dihapus. Dampaknya: dua entri *orphan* di pohon (search key acak 32 byte, kunci
dummy 0x77/0x22/0x33, `keyVersion` rotasi, bucket hari ini) — tidak menunjuk akun
mana pun, jadi tidak mengubah verdict verifikasi siapa pun; yang bertambah hanya
ukuran pohon (+2) dan kehadirannya di snapshot/auditor. Perbaikannya: gate
menjadi **opt-in eksplisit** (`NYX_KT_LIVE_WRITE=1` + `KT_SERVER_URL`) untuk
kedua test live, ditambah guard `guard: penulisan live hanya dengan opt-in
eksplisit` yang menggagalkan suite bila ada yang mengembalikannya ke gate lama.
Verifikasi ulang: suite penuh men-*skip* keduanya (445 lulus, 2 skip, 0 gagal) dan
jalur live-nya lulus saat diminta eksplisit ke instance terisolasi
(`127.0.0.1:18081`).

**Sisa yang tidak ikut ditutup:** pembanding rotasi adalah baris `Device`, bukan
entri log. Rotasi yang terjadi sebelum perubahan ini (log memuat kunci lama,
`Device` memuat kunci baru) tidak tersinkron oleh upload berikutnya yang mengirim
kunci sama; log baru ikut benar saat kunci berubah lagi atau lewat pemulihan.
Memperbaikinya = membaca entri log di sisi server sebelum menulis (keputusan
terpisah, dicatat `docs/32` §32.7 poin 2).

**Diperbarui:** `docs/30` (§30.5 poin 2 + blok status + baris WS-A), `docs/32`
(§32.7 poin 2 + tabel metrik), `docs/34` residual poin 3, `docs/11` (§11.1 gate
live + §11.4), `docs/12` (field `usernameHash?` di dua endpoint).

## 🔐 Verifikasi WS-A: penulis log KT terbukti menulis — dan sisa "keyVersion konstanta" ternyata dua kali lebih besar (2026-10-17)

Baris WS-A `docs/30` mencatat sisa tunggal: *`keyVersion` masih konstanta alur*.
Dua hal diperiksa: (1) apakah penulis benar-benar terpasang & bekerja, dan
(2) apa arti sisa itu bagi deteksi. Hasilnya: penulis **terbukti** bekerja, dan
sisanya **dua sisi** — yang kedua lebih berdampak daripada yang tertulis.

**Bukti bahwa penulis jalan (bukan klaim dokumen).** `keyTransparency.test.ts`
11 test lulus (10 jalan + 1 live opt-in), termasuk **satu penulisan nyata** ke
binary Go `key-transparency-server` yang dijalankan terisolasi
(`127.0.0.1:18081`, LevelDB sendiri di `/tmp` — log self-host tidak disentuh):
ukuran pohon bertambah setelah `Update`. Temuan lama yang masih berlaku: server
menolak `consistency = nil`, jadi field itu selalu dikirim (boleh kosong).

**Guard baru 1 — wiring dua situs.** Tidak ada test yang menjaga *bentuk*
pemanggilan di `routes/auth.ts`. Sekarang dikunci: tepat **dua** situs penulisan
(registrasi `keyVersion: 1`, pemulihan `keyVersion: 2`), keduanya fire-and-forget
(`void`, bukan `await`), keduanya berada **setelah** tulisan DB terdekat (nested
create di registrasi, `prisma.$transaction` di pemulihan) dan **sebelum** respons,
dan presisi waktunya bucket harian (`Math.floor(dayBucket()/86_400_000)`) — bukan
detik/milidetik yang akan membocorkan jam pendaftaran ke log publik.

**Guard baru 2 — invariant daftar jalur penulis kunci.** Scan seluruh
`server/src` menemukan **lima** tempat dengan pola tulis `publicKey: Buffer.from(…)`:
`routes/auth.ts` (2 situs tertulis di atas), **`routes/keys.ts`
(`POST /keys/prekey-bundle`)**, **`routes/users.ts` (`PUT /users/me/keys`)**, dan
**`routes/engine.ts`** (device dummy iframe B2B) — ketiganya **tidak menulis log**;
sisanya `network/realtimeHandlers.ts` (pencarian `where: { publicKey: … }`, bukan
penulisan). Test mengunci daftar itu, jadi jalur penulis baru atau jalur yang
mulai menulis log akan menggagalkan test dan memaksa dokumen diperbarui.

**Kenapa sisi kedua itu penting.** Setelah rotasi kunci lewat salah satu dari tiga
jalur tadi, log masih memuat kunci LAMA: peer yang memverifikasi bundle
mendapat verdict `mismatch` (kunci tersaji ≠ kunci log), `peerIdentityTrust`
menyimpannya sebagai `ktMismatch` + `pendingKey`, dan gate kirim menutup sampai
user menerimanya — padahal yang terjadi adalah rotasi yang sah. Server tidak bisa
memperbaikinya sendiri: yang tersimpan di DB adalah identifier ter-pepper,
sedangkan search key log butuh Argon2id mentah 32 byte, jadi klien harus
mengirimkannya bersama upload bundle.

**Yang justru TIDAK terpengaruh: deteksi perubahan kunci.** `ktMonitoring`
memakai `MonitoringData.greatest_version()`, yaitu `PrefixProof.counter` pohon
prefix KT (naik pada **setiap** penulisan, apa pun isi byte `keyVersion` NYX) —
diverifikasi di kode vendored: `vendor/signal/libsignal-keytrans/src/lib.rs:385`,
`verify.rs:982`, dan proto `transparency.PrefixProof.counter`. Jadi residual ini
bukan lubang deteksi, melainkan lubang *kelengkapan penulis*.

**Diperbarui:** `docs/30` (§30.5 poin 2 + baris WS-A), `docs/32` §32.7 poin 2,
`docs/34` residual poin 3, `docs/11` §11.4. **Tidak diubah:** `server/src` —
verifikasi ini tidak menyentuh jalur kripto/penulisan.

## 🧬 Verifikasi WS-D: tiga "Sisa" prasyarat SPQR sudah tertutup — dan kini ada penjaganya (2026-10-17)

Baris M8 `docs/30` masih mencatat empat "Sisa" untuk WS-D (*versi wire baru di
header DR + ack + pemanggilan modul negosiasi/state dari jalur pesan + verifikasi
E2E*). `docs/33` §33.7/§33.10 mencatat ketiganya landed 2026-10-14. Yang benar:
ketiganya **memang sudah dipanggil jalur pesan** — dan satu-satunya bukti yang
ada selama ini adalah E2E `web/e2e/spqr.spec.ts`, yang **tidak bisa dijalankan**
di mesin ini.

**Temuan 1 — E2E tidak bisa dijalankan di mesin ini, dan itu bukan soal
layanan.** Postgres menerima koneksi dan Redis menjawab `PONG`, tetapi
`web/e2e/global.setup.ts` → `server/scripts/reset-test-env.ts` berhenti sendiri
dengan `DANGER: Attempted to wipe database in non-local/production environment!`
(exit 1) karena `server/.env` di mesin ini `NODE_ENV=production`. Guardrail itu
**benar** (tidak boleh dilewati dengan mengubah `.env`), jadi seluruh suite
Playwright — termasuk dua spec SPQR — mustahil berjalan di sini. Akibatnya klaim
"integrasi jalur pesan" hanya bersandar pada hasil E2E 2026-10-14.

**Temuan 2 — tidak ada penjaga yang bisa dijalankan untuk tiga hal itu.** Wire v2,
`ackV`, dan pemanggilan op worker hanya diuji lewat unit test modul tunggal
(`spqrWire`/`spqrNegotiation`/`spqrState`/`spqrSession`) — tak satu pun menyentuh
komposisinya, dan tak ada yang menjaga **urutan** panggilan di `utils/crypto.ts`
(header v2 harus diparse sebelum state machine v1; tanpa itu sebuah pesan v2 bisa
dibaca sebagai v1).

**Perbaikan (tanpa menyentuh jalur kripto beku).** Test baru
`web/src/lib/__tests__/spqrMessagePath.test.ts` — **8 test**, modul nyata + WASM
nyata + libsodium nyata:

1. **Perilaku:** v1 dulu (peer belum menyatakan; wire benar-benar v1) → peer
   menulis `ackV: 2` di payload ter-seal → pengiriman berikutnya v2
   (`{v:2,b:[…]}`, tanpa `kemPk`/`n`/`pn`) → peer **membuka plaintext itu**
   (braid + XChaCha20 sungguhan) → berlaku dua arah. Rollback: keputusan kembali
   v1 dengan `preservedVersion: 'v2'`, state braid dipertahankan, dan pesan v2
   dari peer tetap terbaca. Keputusan v2 tanpa akar braid → wire tetap v1
   (fallback), percobaan v2 diulang pada pesan berikutnya.
2. **Guard sumber:** mengunci impor modul negosiasi/wire/state di `utils/crypto.ts`,
   urutan `parseSpqrHeader` **sebelum** `worker_dr_ratchet_decrypt` dan sebelum
   pemeriksaan skipped-key, dua tempat `extractVersionDeclaration` →
   `peerAckRatchetVersion`, `saveSpqrState` di kirim & terima, `deleteSpqrState`
   pada sesi baru, `flushSpqrState`, guard fail-closed "sesi tanpa state braid",
   ketiga op worker (`spqr_ratchet_init/encrypt/decrypt`) + proxy-nya, dan paritas
   padding/AEAD v2 dengan v1 (8 KB + nonce 24 B + XChaCha20-Poly1305).

**Koreksi dokumen (drift yang ditemukan saat membandingkan klaim dengan kode):**
`spqrNegotiation.test.ts` bukan 9 test (`docs/33` §33.9) atau 18 (§33.10),
melainkan **21** (4 `advertisedCapabilities`, 5 `resolveRatchetVersion`, 2
`planRatchetRollback`, 7 `resolveOutboundRatchetVersion`, 3 kill switch runtime);
§33.9 masih menulis `SPQR_INTEGRATION_ENABLED = false` padahal nilainya `true`;
dan baris M8 `docs/30` masih mencantumkan "Sisa" yang sudah selesai.

Verifikasi yang dijalankan: `bash scripts/check-wasm-artifacts.sh` exit 0
(`spqr.wasm` 518.522 B + `keytrans.wasm` 299.670 B, hash cocok manifest);
suite SPQR + kapabilitas + `drProtocol` **98/98 lulus di 7 berkas**;
`spqrMessagePath.test.ts` **8/8**; web `npx tsc --noEmit` **0**.

**Batas jujur:** E2E `spqr.spec.ts` (termasuk rollback dua klien nyata) **tidak
dijalankan** dalam verifikasi ini — blocked oleh guardrail `NODE_ENV` di atas.
Test baru ini menjaga rantai panggilan yang E2E buktikan, bukan menggantikannya.

## 🔗 Verifikasi WS-I: tautan `/u/<hashId>` tak punya produsen & tak bisa dipindai (2026-10-16)

Gate `docs/30` §30.13 terdengar sudah selesai (route `/u/:hashId` ada, validasi
bentuk sama dengan server), tetapi diperiksa dari sisi **pengguna** fiturnya tidak
bisa dipakai sama sekali:

**Temuan 1 — tidak ada yang menghasilkan tautannya.** `ShareProfileModal` masih
membangun `/connect?u=<hashId>&i=<userId>&p=<profil terenkripsi>`: userId mentah
ikut beredar di dalam QR/tautan, dan karena tidak ada kode lain yang menulis
`/u/`, halaman WS-I hanya bisa dibuka oleh orang yang mengetik hashId-nya sendiri.

**Temuan 2 — pemindai QR menolaknya.** `ScanQRModal` hanya menerima tautan
berbentuk `/connect?u=…`, jadi QR berisi `/u/<hashId>` (bentuk yang justru
dituju WS-I) diabaikan tanpa pesan.

**Perbaikan.** `ShareProfileModal` memakai `buildUsernameLink` dari
`utils/usernameLink.ts`: QR dan tombol salin kini menunjuk URL yang **sama**
(`/u/<hashId>`), hanya memuat hashId; hashId tak berbentuk sah membuat modal tidak
render (sebelumnya `buildUsernameLink` bisa melempar saat render). Sisi konsumen:
`parseProfileShareLink()` baru menjadi **satu** parser untuk dua bentuk —
`/u/<hashId>` divalidasi dengan aturan yang sama seperti server, dan
`/connect?u=…&i=…&p=…` diteruskan **apa adanya** supaya QR yang sudah beredar
tidak mati. `ScanQRModal` memakai parser itu, jadi perilaku pemindaian lama tidak
berubah (host sengaja tidak dipatok: deployment self-host memakai domain sendiri,
dan yang diteruskan hanya hashId).

Tidak ada perubahan pada kontrak server: `/api/users/search` tetap pencocokan
**persis** (`identifierLookupCandidates`, tanpa prefix), di bawah `generalLimiter`
dan wajib terautentikasi — jadi klaim "tanpa enumerasi" tetap seperti semula.

Verifikasi: web `npx tsc --noEmit` 0, `pnpm --filter nyx-web run build` exit 0,
`vitest` **669/669 (78 file)**; test baru: `usernameLink.test.ts` (+8, termasuk
roundtrip `buildUsernameLink` → `parseProfileShareLink`),
`shareProfileModal.test.tsx` (3: QR hanya hashId, tombol salin = QR, hash tak sah
= tanpa QR) dan `scanQrModal.test.tsx` (4: link pendek diterima + kamera berhenti,
64 hex diterima, QR lama utuh, non-NYX/segmen rusak diabaikan). **Sisa jujur:**
tidak ada E2E kamera/`/connect` nyata — suite Playwright butuh Postgres + Redis
lokal yang belum tersedia di mesin ini.

## 🕵️ Verifikasi WS-H: alamat klien masih tersimpan di key Redis (2026-10-16)

Gate `docs/30` §30.12 menuntut dua hal yang mudah diklaim tanpa diuji: akun ke-100
dari satu ASN dalam satu jam ditahan, dan audit "tidak ada IP di DB/Redis".
Bagian pertama memang sudah benar (guard burst + attestation, diuji sebagai
perilaku). Bagian kedua **gagal**: dua tempat menyimpan wakil klien di Redis.

**Temuan 1 — key rate-limit memuat alamat mentah.** Ketiga limiter API memakai
`ipKeyGenerator(cfAwareClientIp(req))` sebagai key, dan `RedisStore` menulis
`rl:general:<ip>` / `rl:auth:<ip>` / `rl:upload:<ip>` dengan TTL 15 menit–1 jam.
Artinya snapshot Redis (atau `MONITOR`/AOF) berisi daftar alamat klien beserta
riwayatnya — persis yang dilarang kriteria audit dan bertolak belakang dengan
cara repo ini sudah menangani userId di key (`identityTag`).

**Temuan 2 — counter PoW memakai hash tanpa kunci.** `/pow/challenge` membentuk
key dari `blake2b(primaryId)` **tanpa kunci**, dipotong 16 hex
(`pow:user|inst|fp|ip`). Untuk identitas berentropi rendah itu bukan
perlindungan: ruang IPv4 hanya 2^32, jadi pemegang snapshot bisa mengenumerasi
seluruh ruang dan mencocokkan hash-nya. Alasan yang sama sudah tertulis di
`utils/atRestSecrets.ts` ("hash TANPA kunci = bisa dienumerasi") — aturan itu
kini dipakai konsisten di key Redis.

**Perbaikan.** `clientIpTag()` (`utils/clientIp.ts`) = HMAC pepper atas alamat
yang **sudah** dinormalkan `ipKeyGenerator` (normalisasi IPv6 bawaan tetap
terpakai), dipasang di ketiga limiter + limiter non-API; `powRateKey()`
(`utils/powIdentity.ts`) = HMAC pepper domain-separated, dipakai
`/pow/challenge`. Semantik pembatasan tidak berubah (klien sama → tag sama →
counter sama); operator tetap bisa menghitung tag dari pepper kalau perlu
menelusuri satu alamat. Konsekuensi yang disengaja: bentuk key berubah → counter
lama berhenti dipakai (TTL-nya pendek, jadi wajar).

**Koreksi rujukan ops.** Alert `NyxAbuseGuardDisabled` menyuruh operator membaca
"checklist lengkap di docs/10 §10.13" — §10.13 adalah pembersihan & snapshot KT.
Checklist WS-H kini ada di **§10.16** (menyalakan bertahap: `shadow` untuk
mengukur → isi `ASN_DB_FILE` → `on`; rollback; daftar key yang tidak boleh
kembali ke IP mentah), dan rujukan alert + peringatan boot diarahkan ke sana.

**Dua kegagalan suite server yang lama juga ditutup — keduanya kelas "test
bergantung `.env` mesin", bukan perilaku produk:** `atRestSecrets` meng-assert
cabang dev-fallback padahal `.env` di mesin ini `NODE_ENV=production` (kini
mode-aware: production wajib fail-closed), dan `ktSnapshot` mengharap
`KT_SNAPSHOT_DIR` kosong padahal `.env` self-host mengisinya (kini env dibersihkan
selama test). Mesin dengan `.env` produksi terisi sebelumnya **tidak bisa**
memperoleh suite server hijau.

Verifikasi: server `tsc --noEmit` 0, `pnpm --filter nyx-server run test`
**434/435 lulus (1 skip = live KT opt-in), exit 0** (+5 test: `ipKey` 3,
`powIdentity` 2).

## 🧪 Verifikasi gate WS-F: dua kolom waktu presisi masih bocor di IndexedDB (2026-10-16)

Verifikasi ulang `docs/30` §30.10 menemukan bahwa klaim "sisa plaintext hanya
primary key dan bucket indeks" belum lengkap — dan gate-nya sendiri
("inspeksi IndexedDB tidak memperlihatkan pola aktivitas: jumlah pesan per hari,
**jam**, grup/1:1") belum punya bukti otomatis sama sekali, hanya pemeriksaan
per-kolom di test.

**Temuan.** `Message.sentAt` (ms presisi per pesan, ditulis `upsertMessages` dan
dibaca `parseRecordsToMessages`) dan `pqDrSessionsV2.lastActivity` (ms per sesi
PQ-DR) masih plaintext. Keduanya terbaca di baris mentah, jadi "jam" per pesan —
persis yang diminta gate untuk hilang — masih bisa dipulihkan dari profil browser
yang dicuri, walau `createdAt` sudah dipindah ke lapis ter-seal. Waktu presisi itu
tidak perlu ada di disk: ia hanya dipakai di memori untuk tampilan dan tie-break
urutan.

**Perbaikan** mengikuti pola `seq`/`expiresAt` yang sudah ada (seal di tempat,
tanpa mengubah format wire): writer menyegel (`upsertMessages`, `savePqDrSession`),
migrasi unlock menutup baris lama (`sealLegacyStructFields` + loop baru di
`migrateAtRestSealing`), pembaca membuka (`openLocalNumber`) — termasuk
`getPqDrSession`, yang kini memilih sesi terbaru lewat nilai yang **dibuka**,
bukan pengurangan string. Baris lama berbentuk angka plaintext tetap terbaca, jadi
perangkat user yang sudah ada tidak perlu di-reset.

**Bukti (bukan asumsi).** Pemindai baris mentah baru di
`web/src/lib/__tests__/dexieMigration.test.ts` (`findActivityLeaks`) menyapu
**semua tabel Dexie** di atas **IndexedDB nyata + Dexie nyata** dan menolak:
ISO non-bucket, epoch-ms non-bucket, boolean `isGroup`/`isDeletedLocal`/`isViewOnce`,
serta kolom yang seharusnya `ENC1:` tapi masih plaintext. Ada **kontrol negatif**
(baris bocor buatan → ≥5 temuan) supaya "bersih" tidak bisa berarti "pemindai
buta", dan dump ter-redaksi dicetak sebagai bahan inspeksi manual. Gate lain juga
diukur: urutan pesan identik setelah **reload** dan setelah **wipe + restore
arsip mentah** (baris pra-v9, lalu `normalizeOrderIndex`), pencarian **10k pesan = 3,98–4,03 ms/query**
(hangat), 3,4–4,3 ms (dingin) — gate < 100 ms.

**Batas jujur.** Yang tetap terbaca adalah granularitas **bucket 15 menit** dan
jumlah baris per bucket/percakapan (inheren pada penyimpanan pesan, dan sudah
terpublikasi di server `docs/28` B3/B4), plus `offlineQueue.timestamp` yang
merupakan kolom indeks `orderBy('timestamp')` pada antrean kirim sementara. Gate
yang benar adalah "tidak ada presisi di bawah bucket", bukan "nol pola aktivitas".

Verifikasi: web `tsc` 0, `vitest` **654/654 (76 file)** — 17 di antaranya
`dexieMigration` (11 lama + 6 baru), build web exit 0.

## 🔐 Jalur backup `.nyxbak` akhirnya tersambung dari UI (2026-10-16)

WS-C sudah ditandai selesai sampai fase 5, tetapi verifikasi end-to-end menemukan
tiga sambungan yang belum ada pemanggilnya. Ketiganya ditutup di sini.

**1. Tidak ada cara membuat berkas `.nyxbak`.** `startBackupFileDownload` punya
nol pemanggil: arsip hanya lahir dari alur QR (`MigrationSendPage`, kunci acak
yang di-seal ke penerima), sehingga `BackupRestoreModal` — yang membuka arsip
dengan kunci turunan recovery phrase — tidak pernah punya sumber berkas. Modul
transport fase 3 lengkap tetapi tidak terjangkau. Kini ada
`BackupExportModal` (tombol “Encrypted Backup (.nyxbak)”) yang mengambil recovery
phrase (auto-unlock key atau prompt password), membuat salt acak 16 byte,
menurunkan kunci dengan `deriveBackupKey`, membangun arsip dengan salt yang sama
(sehingga tersimpan di header), lalu mengunduh byte-nya. Normalisasi phrase
(`normalizeBackupPhrase`) dipakai jalur export dan restore sekaligus, jadi tidak
ada dua aturan yang bisa menyimpang.

**2. Jalur awan R2 tidak pernah dipanggil.** `uploadBackupToCloud`,
`downloadCloudBackup`, dan `deleteCloudBackup` semuanya nol pemanggil: tidak ada
cara mengunggah, tidak ada cara mengambil kembali, dan — yang paling penting —
`executeLocalWipe` tidak pernah menghapus objek backup, sehingga objek opaque di
R2 **selamat** dari wipe walau cookie HttpOnly sudah dimatikan. Sekarang unggah
opt-in dari modal export, tombol “Ambil dari awan” di modal restore
(`download-url` + 404 sebagai sinyal “tidak ada backup”), dan hapus objek di
`executeLocalWipe` **sebelum** `/api/auth/logout-all` — endpoint DELETE butuh
sesi hidup, jadi urutannya diuji sebagai kontrak, bukan diserahkan ke kebetulan.
Lubang yang sama ditutup di server: `DELETE /api/users/me` sekarang ikut
menghapus objek backup. Kuncinya sengaja tidak memuat userId, jadi filter
lampiran berbasis prefix `${userId}-` tidak pernah bisa menyapunya — tanpa
langkah eksplisit itu, salinan terenkripsi tetap tinggal di R2 setelah akun
dihapus.

**3. Kontrak tipe bersama menyesatkan.** `packages/shared/src/socket.ts` masih
mengetikkan `migration:chunk` sebagai `chunk: ArrayBuffer` di kedua arah,
sementara klien mengirim/membaca base64url (transport men-serialize payload
dengan JSON, jadi `ArrayBuffer` mentah menjadi `{}`). Klien memakai map event
sendiri sehingga compiler tidak pernah menangkap perbedaan itu — tipe mati yang
menyesatkan kini diselaraskan. Entri lama `migration:chunk/start/ack` di
`KNOWN_WT_ONLY` (`gatewayParity.test.ts`) ikut dihapus karena gateway WSS sudah
meneruskannya; daftar itu hanya berguna kalau isinya benar-benar belum punya rute.

Verifikasi: web `tsc` 0, server `tsc` 0, `vitest` **647/647** (76 file, termasuk
4 test modal export + 2 test urutan wipe), `gatewayParity` 10/10 dan shared
rebuild bersih. Dua kegagalan di suite server (`atRestSecrets`, `ktSnapshot`) ada
sebelum perubahan ini dan hanya butuh env (`NYX_AT_REST_PEPPER` / `KT_SNAPSHOT_DIR`).

## 🔀 Ratchet v2 akhirnya terpakai di jalur WSS juga (2026-10-16)

Jalur ratchet v2 (braid SPQR) sudah lama landed, tetapi punya satu syarat yang
membuatnya praktis tidak pernah menyala: relay harus mengiklankan kapabilitas
`spqr-ratchet`. Kapabilitas itu **hanya** datang dari sidecar WebTransport (HELLO
bidi) — sementara klien di jaringan yang memblokir QUIC memakai **WSS**, dan di
sana negosiasi tidak ada sama sekali. Akibatnya `negotiatedCapabilities` selalu
kosong di jalur WSS dan `resolveOutboundRatchetVersion` tidak pernah memilih v2,
walau **kedua peer sudah saling menyatakan mampu in-band** (`ackV` di payload
ter-seal, otentikasi AEAD). Fitur yang sudah selesai jadi tidak terpakai oleh
justru mayoritas pengguna.

**Perbaikannya bukan menambah fitur, melainkan menutup jalur kedua.** Gateway WSS
kini menegosiasikan kapabilitas dengan aturan yang identik dengan HELLO sidecar:
klien mengiklankan daftarnya di `handshake.auth.capabilities`, gateway membalas
event `capabilities` berisi irisan dengan `SERVER_CAPABILITIES`, dan batas
parse-nya satu implementasi bersama di `packages/shared`
(`sanitizeCapabilityList`, dipakai **juga** oleh parser HELLO — dua batas yang
disalin ulang cepat atau lambat menyimpang). Klien menutup kedua jalur lewat satu
fungsi (`finishCapabilityNegotiation`) supaya tidak ada dua logika "kapan
negosiasi selesai".

Yang **tidak** berubah, dan sengaja: klien lama yang tidak mengirim apa pun tetap
legacy (daftar kosong, koneksi tidak pernah gagal karena field cacat); balasan
hanya dikirim ke klien yang mengiklankan (klien lama tidak mengenal event baru
ini); irisan tetap dihitung di kedua sisi; dan bukti kemampuan peer tetap in-band
— relay tidak pernah diberi wewenang menentukan versi.

Rollout-nya kini terukur: `nyx_wss_capability_total{capability}` (`none` = klien
mengiklankan sesuatu yang tak dikenal gateway), sehingga "berapa klien yang bisa
v2" tidak lagi ditebak dari selera. Verifikasi: 5 test server baru (bentuk input
jaringan, irisan, jejak metrik), test wiring klien yang dikunci ke jalur baru ini,
dan spec E2E `web/e2e/spqr.spec.ts` yang sekarang **berjalan tanpa WebTransport**
(project `chromium` biasa) — amplop v2 di server dibuktikan di jalur WSS, sementara
project `chrome` tetap membuktikannya di jalur WT.

## 📈 Auditor KT: dari kotak hitam menjadi terukur — exporter, 8 aturan, dashboard (2026-10-16)

Auditor pihak ketiga (`server/kt-query/cmd/nyx-kt-auditor`, port dari auditor
referensi Signal) sudah menandatangani tree head — log berjalan **mode 3** —
tetapi sampai hari ini satu-satunya jejaknya ada di journal. Kegagalannya karena
itu **tidak terlihat sampai terlambat**: tanpa tanda tangan baru, log tetap
melayani bukti (aplikasi sehat, tidak ada error di klien), dan yang barulah gagal
adalah verifikasi klien setelah auditor head melewati batas 7 hari upstream.

**Exporter loopback auditor (`cmd/nyx-kt-auditor/metrics.go`, `127.0.0.1:9466`).**
Sepuluh metrik tanpa dependency baru, dengan aturan privasi yang sama seperti
sisi server (`metrics.ts`): deklarasi wajib lebih dulu, label hanya enum, nilai
label berbentuk UUID/hex-panjang/base64url/IP/email **ditolak** dan hitungannya
expose di `nyx_kt_auditor_metrics_rejected_total`. Yang membuat pemeriksaan luar
mungkin: `head_sends_total{result}` (kiriman ditolak vs diterima),
`rounds_total{result}` (`inconsistent` = peristiwa keamanan),
`tree_size` vs `head_tree_size` (pekerjaan yang belum ditandatangani), dan
`uptime_seconds`.

**8 aturan alert** (`ops/prometheus/alerts.yml`, grup `nyx-kt-auditor`) yang
memisahkan kelas kegagalan menurut tindakannya. Drill menemukan dua cacat nyata
yang keduanya membuat aturan mati secara praktis:

1. `…HeadStale` memakai `absent(last_head)` tanpa penjaga umur proses — head
   pertama memang menunggu irama tanda tangan (≤1 jam), jadi aturan itu **menyala
   30 menit setelah setiap restart**. Ditutup dengan `nyx_kt_auditor_uptime_seconds`
   (metrik ke-10, yang juga mencegah "proses baru" dianggap "tak pernah
   menandatangani").
2. Celah pasangan kelas-pertama: proses yang start ulang terus selalu berumur
   muda, jadi penjaga umur di atas justru membutakannya. Aturan `…Restarting`
   menutupnya dengan dua sinyal — `changes(up[1h]) > 2` (restart yang terlihat
   mati di scrape) **atau** `resets(nyx_kt_auditor_uptime_seconds[1h]) > 1`
   (restart lebih cepat dari satu irama scrape) — dan ambangnya sengaja tidak
   menyala pada satu restart per jam (deploy), supaya alarm tidak diabaikan.

**Dashboard.** Baris baru di `ops/grafana/dashboards/nyx-overview.json`: auditor
hidup, umur tree head **dan** umur proses, penjaga label identitas auditor,
posisi pohon (diverifikasi vs head diterima), tulis/baca log KT, putaran audit +
head per hasil, snapshot, dan umur tulis KT sukses terakhir. Ambang di panel
sengaja identik dengan ambang alert.

**Drill.** `promtool test rules` kini punya kasus **tidak-menyala** untuk
kedua cacat di atas (proses muda tanpa head; satu restart per jam), dan lapis
kontrak metrik `scripts/drill-alerts.sh` membaca deklarasi dari `metrics.ts`
**dan** `metrics.go` auditor. Total 23 aturan, semuanya punya kasus drill.

**Harness (self-host tanpa root).** Pemakaian tanpa root diuji penuh: Prometheus
3.15 di `~/nyx-selfhost/prometheus` (`conf/` = salinan `ops/prometheus`, unit
`systemd --user`), Grafana 13.2 di `~/nyx-selfhost/grafana` (`conf/custom.ini`
loopback **:3001** karena :3000 dipakai nginx, datasource uid `prometheus` +
dashboard NYX **diprovisikan dari berkas**, jadi tidak ada impor manual). Verifikasi
bukan "proses hidup": scrape `up{job="nyx-kt-auditor"} == 1`, sampel
`nyx_kt_auditor_*` nyata, 23 aturan termuat tanpa error, dan Grafana menjawab
`Successfully queried the Prometheus API`. Batasnya dicatat: exporter
`node`/`postgres`/`redis` belum dipasang di mesin dev (tiga job `up == 0`), dan
tanpa Alertmanager aturan yang menyala hanya terlihat di UI Prometheus.

## 🔒 3.0.0 — Review menyeluruh: provenance artefak, kegagalan yang tadinya senyap, endpoint destruktif (2026-10-15)

Rilis ini menutup temuan review eksternal + review internal atas seluruh rentang
sejak `2.7.0`. Perubahan yang **breaking** (legacy purge, kolom DB baru, artefak
WASM dibangun ulang) sudah masuk sejak rangkaian sebelumnya; entri ini menutup
celah yang membuatnya sulit dipercaya dan sulit dioperasikan.

### Artefak WASM: dari "ada dan cukup besar" menjadi terbukti berasal dari sumber (R1)

Sebelumnya guard hanya memeriksa `.wasm` **ada, ≥100 KB, dan ter-track**; tidak
ada satu pun pemeriksaan yang mengaitkan biner itu dengan `vendor/signal/*`.
Dua percobaan menentukan perbaikannya, dan keduanya dicatat karena mudah dilupakan:

1. build apa adanya → hash **berbeda antar direktori** (rustc menyematkan path absolut);
2. setelah semua path di-remap ke prefix tetap → **masih berbeda** (51fa0767… vs
   c1f2c58f…). Perbandingan per-seksi menunjukkan `type/table/memory/data` identik
   tetapi `func/code/elem/name` berbeda: cargo menurunkan *unit hash* dari
   **package id**, dan package id path-dependency memuat path absolutnya →
   disambiguator simbol Rust berubah → urutan link berubah.

Karena itu: `scripts/wasm-repro-build.sh` (build di **root kanonik**, `--update`
menulis `packages/wasm-artifacts.json`, `--verify` membandingkan hash),
`rust-toolchain.toml` dipin ke 1.95.0 di kedua paket, remap path di `build.sh`,
`check-wasm-artifacts.sh` kini memverifikasi **hash** (bukan hanya ukuran), dan
**job CI `wasm` membangun ulang dari `vendor/` lalu membandingkan hash**.
Dibuktikan: build dari checkout `/home/ken/nyx-chat` dan dari checkout lain
(`/tmp/other-checkout`) menghasilkan hash yang sama dengan manifest.
Alasan lama "CI tak bisa membangun ulang" dicabut dari `NOTICE`, `CONTRIBUTING`,
dan pesan script.

### Drop yang tadinya senyap kini terlihat (R2)

Envelope distribusi sender-key v0/v1 diabaikan hanya dengan `console.warn` —
pengguna kehilangan pesan grup tanpa gejala yang bisa ditindaklanjuti. Sekarang
kegagalan itu muncul sebagai **pesan sistem di percakapan + toast + dynamic
island** (sekali per percakapan per sesi, i18n di 4 bahasa).

Dua jalur lain menutup sisanya, karena "terlihat di UI" saja tidak menolong
klien yang bundelnya sudah usang:

1. **Service worker memaksa satu muat ulang per tab per sesi** saat SW baru
   mengambil alih. `skipWaiting()` + `clientsClaim()` sudah membuat SW baru aktif
   segera, tetapi halaman tetap menjalankan bundel LAMA sampai dimuat ulang —
   itulah yang membuat klien pra-3.0.0 bisa bertahan berhari-hari. Penanda
   `sessionStorage` (bukan variabel modul) mencegah reload berantai.
2. **Gerbang versi klien di server** (`utils/clientVersion.ts` +
   `middleware/clientVersion.ts`): klien mengirim `x-nyx-client-version` di
   setiap request REST (termasuk upload), dan bila `MIN_CLIENT_VERSION` diset,
   klien yang lebih tua ditolak **`426 CLIENT_TOO_OLD`** dengan pesan yang bisa
   ditindaklanjuti (toast menetap, i18n 4 bahasa) + metrik
   `nyx_client_version_rejected_total{result="too-old"}`. Gerbangnya **mati bila
   env kosong**, dan request **tanpa** header versi selalu lolos — semua klien
   yang dirilis sebelum 3.0.0 tidak mengirim header itu, jadi menolaknya berarti
   mematikan basis pengguna yang ada. Urutan menaikkannya ada di `docs/10` §10.14.

### Pemulihan akun kini benar-benar menghasilkan entri log KT (temuan internal baru)

Pemulihan menukar kunci identitas — peristiwa yang justru harus terlihat di log —
tetapi search key log adalah `0x75 || Argon2id(username)` sementara halaman
pemulihan mengirim **hash ID ter-pepper (64 hex)**; server tak punya cara
menurunkannya, jadi entri **dilewati**. Halaman pemulihan sekarang menormalkan
masukan (`resolveRecoveryIdentifierInput`): hash ID dikirim apa adanya, username
di-hash Argon2id lebih dulu — sehingga lookup tetap benar **dan** entri KT bisa
ditulis. Penolakan bentuk ter-pepper kini dihitung terpisah sebagai
`nyx_kt_writes_total{result="unsupported_identifier"}` supaya kejadiannya
terlihat di dashboard, dan label/placeholder diperjelas di 4 bahasa.

### `/api/admin/cleanup` tidak lagi dijaga satu rahasia umum (R6)

Sejak endpoint itu benar-benar menghapus baris (termasuk akun dorman),
kebijakannya dipindah ke fungsi murni ber-test (`utils/adminCleanupAuth.ts`) dan
dikeraskan: `ADMIN_CLEANUP_SECRET` (fallback `CHAT_SECRET`), allow-list IP
opsional, rate limit 5/jam per IP, plus metrik `nyx_admin_cleanup_total{result}`
(`ok`/`partial`/`error`/`forbidden`/`rate_limited`) — pemanggilan yang **ditolak**
pun terlihat, bukan senyap. Kedua env baru itu didokumentasikan di template
(`.env.example` + `server/.env.example`, dengan uji yang menahannya) supaya
operator tidak diam-diam jatuh ke `CHAT_SECRET`.

### `seq` pesan SYSTEM selalu dalam satu transaksi (R7)

`reserveMessageSeq(...).catch(() => 0)` bisa menulis `seq: 0` (sentinel "baris
legacy") sehingga pesan SYSTEM melompat ke awal riwayat, dan kegagalan setelah
reservasi meninggalkan lubang `seq`. GROUP_KEY & METADATA_UPDATED kini
reserve+create dalam satu transaksi — tidak pernah menulis urutan bohong.

### Guard anti-abuse yang OFF kini berbunyi (R11)

Gauge `nyx_abuse_guard_enabled{guard}` diset saat boot, aturan alert
`NyxAbuseGuardDisabled` ditambahkan **beserta kasus drill-nya**, dan peringatan
boot menyebut guard/rahasia yang belum diset (`utils/startupSignals.ts`, murni &
teruji). `docs/10` diperbarui: checklist post-deploy + tabel env + pengamanan
endpoint cleanup.

### ESLint dihapus tuntas — oxlint satu-satunya linter (2026-10-15)

ESLint tidak pernah bisa dijalankan di repo ini (`typescript-eslint` menolak
TypeScript 7), jadi selama ini ada **dua sumber kebenaran**: aturan yang ditulis
di `eslint.config.js` yang tidak pernah dieksekusi, dan `oxlint` yang benar-benar
menahan regresi. Sekarang yang kedua menjadi satu-satunya:

- ketiga `eslint.config.js` (`web`, `server`, `marketing`) dihapus;
- **20 devDependency** eslint/* dicabut (`eslint`, `@eslint/js`,
  `typescript-eslint`, `@typescript-eslint/*`, plugin react/astro/import/n/promise,
  `astro-eslint-parser`, `globals`) → `pnpm-lock.yaml` −1365 baris, 124 paket
  hilang dari `node_modules`, `pnpm install --frozen-lockfile` tetap bersih;
- direktif `eslint-disable` lama diganti: yang masih menahan sesuatu dipindahkan
  ke sintaks `// oxlint-disable-next-line <rule>` **tepat di atas baris kodenya**,
yang mati dihapus dan diganti komentar biasa.

Temuan yang membuat pembersihan ini bukan kosmetik: di
`server/src/utils/logger.ts` ada DUA direktif bertumpuk (`oxlint-` di atas
komentar, `eslint-` di atas kode). Yang menahan `no-control-regex` sebenarnya
hanya yang kedua — sementara direktif pertama dicatat oxlint sebagai *unused*,
sehingga menghapus "yang sudah tidak perlu" tanpa memeriksa justru akan
menyalakan error. Kini tinggal satu direktif, di posisi yang benar, dengan
komentar yang menjelaskan jebakan itu. Sisa direktif mati diperiksa dengan
`npx oxlint src --report-unused-disable-directives` (kini 0 di semua paket).

Hasilnya diverifikasi: `pnpm run lint` tetap **0 error** dengan jumlah temuan
identik sebelum/sesudah (2/3/49/194 warning per paket) — jadi tidak ada aturan
yang ikut hilang bersama ESLint.

### Dokumen yang menyimpang dari kode

`README` (lint: oxlint **blocking**, bukan ESLint non-blocking), `CONTRIBUTING`
(ESLint v10 → oxlint; "build-time path dependency"/"CI tidak bisa rebuild" →
ter-vendor + hash diverifikasi), `docs/02` §2.5 ("lint non-blocking, jangan
perbaiki error lint" → oxlint blocking), `docs/10` §10.2 (job `lint` di tabel CI),
`docs/29` §7.4 + roadmap (lint dinyatakan selesai), `docs/README`,
`docs/25`, `GEMINI.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
`docs/04` §4.6 ("v1/v0 tetap terbaca" → memang ditolak), nuansa "header beku vs
payload aditif" (`ackV`/`ktG`/`ackKem`), `docs/30` §30.19 (rujukan dokumen yang
tidak pernah ada), header `spqrNegotiation.ts` (keputusan per pengiriman, bukan
hanya saat sesi didirikan), dan `/**` ganda. Versi dinaikkan ke **3.0.0**
(breaking: legacy purge + kolom baru).

### Yang SENGAJA belum ditutup (dipertahankan apa adanya, dicatat di `docs/28` §28.11)

`R4` (envelope seal tanpa byte versi → belum ada jalur rotasi pepper) dan `R5`
(kandidat lookup "nilai apa adanya" dipakai tautan berbagi/pemulihan). Keduanya
butuh perubahan skema **dan** klien; mengerjakannya setengah jalan lebih berbahaya
daripada mencatatnya dengan rencana urutan yang jelas. `R8` (memecah
`utils/crypto.ts`) juga tidak dikerjakan: aturan maintainer melarang memecah file
kripto, dan file utilitas ini terikat pada jalur yang sedang diverifikasi.

### Langkah operator (breaking)

1. Ekspor kunci issuer lama **sebelum** `prisma db push` (bila belum).
2. `prisma db push`; set `NYX_AT_REST_PEPPER` + `GROUP_ISSUER_KEY_PKCS8` di
   `/root/nyx-app/.env` (fallback dev tidak berlaku di production).
3. Set `ADMIN_CLEANUP_SECRET` + `ADMIN_CLEANUP_IP_ALLOWLIST` (opsional tapi
   disarankan); aktifkan `ABUSE_REGISTRATION_GUARD=on` setelah `shadow` bila
   belum — alert `NyxAbuseGuardDisabled` akan mengingatkan.
4. Pastikan bundle klien diperbarui (hard reload) — klien pra-v2 tidak bisa lagi
   mengikuti era kunci grup baru, dan sekarang itu terlihat di UI.

## 📞 WS-E gate (1): panggilan benar-benar merelay lewat coturn — 2026-10-15

Gate `docs/30` §30.9 menerima “E2E call 1:1 di CI chrome dengan coturn”. Gate itu
sebelumnya hanya bisa diklaim sebagai rencana: tidak ada spec panggilan, dan
`transport.spec` (yang jadi satu-satunya spec E2E berjalan di jalur nyata) belum
pernah dieksekusi karena headless Chromium di mesin dev tidak punya WebTransport.

**`web/e2e/call.spec.ts` (baru)** membuktikan tiga hal berurutan lewat jalur
produksi, bukan lewat mock: (a) `/api/keys/turn` (klien `web/src/lib/api.ts`)
mengembalikan kredensial **coturn** — username `<unixExpiry>:<identityTag>`, tag
identitas bukan userId — dan entri Cloudflare **disaring keluar** supaya bukti
relay tidak bisa lolos lewat pihak ketiga; (b) dua `RTCPeerConnection` di browser
nyata dengan `iceTransportPolicy: 'relay'` benar-benar terhubung; (c) pasangan
kandidat terpilih `relay`↔`relay` dari coturn. Run nyata:
`kandidat terpilih: {localType:relay, remoteType:relay, localAddress:127.0.0.1}`.
Tanpa coturn, spec **skip dengan alasan tertulis** — bukan lulus lewat STUN publik.

Dua bug di sisi **uji** ditemukan saat spec itu pertama dijalankan, keduanya kelas
“alat ukurnya yang salah, bukan produknya”:

1. SDP diserahkan **sebelum** ICE gathering selesai (spec tanpa trickle ICE tidak
   punya jalur sinyal untuk kandidat susulan). SDP tanpa kandidat membuat ICE
   mandek di `new` dan `getStats` melaporkan nol pasangan — persis seperti coturn
   tidak bekerja. Kini `iceGatheringState === 'complete'` ditunggu sebelum
   `setRemoteDescription`. Diverifikasi terpisah dengan harness Chrome standalone:
   setelah perbaikan itu, pasangan `relay↔relay` **nominated & succeeded**.
2. `connectionState` dibaca **setelah** `close()`, jadi setiap kegagalan dilaporkan
   sebagai `caller=closed callee=closed` tanpa informasi apa pun. Status kini
   diambil sebelum menutup.

**CI `e2e-chrome` menjalankan coturn sendiri** (`apt-get install coturn` + conf
loopback + `ss -lun | grep :3478` sebelum suite, `TURN_URLS` /
`TURN_STATIC_AUTH_SECRET` di env job). `allow-loopback-peers` dipakai **hanya di
runner** karena kedua peer ada di loopback yang sama — produksi memakai IP publik
(catatan itu ada di komentar CI dan di spec, supaya tidak ada yang menyalinnya ke
VPS).

**`transport.spec` akhirnya benar-benar dijalankan** (`--project=chrome` + sidecar
nyata) dan membayar utangnya: assertion tombstone-nya mencari “message deleted”
sedangkan tombstone asli “This message was deleted” (selalu gagal begitu spec
dijalankan), dan `getByText` juga mencocokkan **preview di sidebar** sehingga aksi
berikutnya bertemu dua elemen dan menggantung. Locator chat sekarang di-scope ke
`main` dan tiap aksi punya timeout eksplisit.

**Gate latency-nya sendiri salah ukur (temuan).** `expect(endToEndMs).toBeLessThan(8000)`
membandingkan seluruh jalur dari klik kirim sampai bubble peer terbaca. Di mesin
ini angka itu didominasi **kripto lokal pengirim** (Argon2 + penyiapan sesi DR di
worker: terukur 1,8–4,5 detik) dan oleh klik baris sidebar di klien peer — kode
yang sama dilaporkan 10,5–17,2 detik hanya karena mesin sibuk. Run pertama yang
benar-benar hijau sekaligus membuktikan pemisahannya: **total 7.406 ms = optimistic
3.531 ms + relay/dekripsi 3.875 ms**. Karena itu yang diasersikan sekarang adalah
**kaki relay** (bubble optimistis muncul → bubble peer terbaca) dengan anggaran 8
detik yang tetap ketat, dan totalnya hanya dicatat di log. Menurunkan anggaran
(tanpa memisahkan) akan membuat gate itu **flaky dan tetap buta** terhadap regresi
transport — dua hal yang sama-sama menghilangkan nilainya.

**`regression.spec` (burner destroy) flaky karena barrier-nya di lapis yang salah.**
`deleteConversation` menghapus baris dari state UI **sinkron**, lalu menunggu hapus
di IndexedDB, dan handler klik `ChatWindow` tidak menunggu rantai itu — jadi
baris UI yang sudah hilang bukan bukti penghapusan sudah tertulis. Spec menunggu
di UI, lalu reload membatalkan hapusnya, dan baris burner muncul kembali
(snapshot kegagalan memperlihatkan baris `Unknown / No messages yet`). Sekarang
spec menunggu di **lapis persistensi** (baris `conversations` + pesan benar-benar
hilang dari Dexie) sebelum reload — kalau penghapusan memang tidak pernah tertulis,
barrier itu sendiri yang gagal. Bukti: lulus 2/2 dijalankan terpisah setelah
perbaikan (sebelumnya lulus 2 dari 4 run suite penuh).

**`settings.spec` juga tidak pernah benar-benar menguji apa pun:** anggarannya
60 detik, sedangkan rantai registrasi saja 40–70 detik → spec selalu mati di tengah
(`Target page, context or browser has been closed`) dan kegagalannya terbaca seperti
bug eject. Dengan anggaran yang realistis (180 detik, sama dengan spec lain) plus
`expect.poll` untuk redirect pasca-reload, eject sekarang **lulus** (1,2 menit).

**`chat.spec` gagal ~1 dari 5 run karena anggaran PoW-nya pas di batas.** Setelah
empat spec lain hijau, sisa kegagalan tunggalnya adalah loket terakhir di alur
verifikasi: snapshot kegagalan memperlihatkan modal masih “Mining hash collision…
CPU at 100%” saat `toBeVisible({ timeout: 60000 })` habis, artinya yang kehabisan
waktu adalah **kripto, bukan locator atau produk**. Biayanya memang besar:
`minePoW` adalah **Argon2id 16 MB per percobaan** (`crypto.worker.ts`) mengejar
prefiks heksa `floor(difficulty/2)` nol, dan alur ini mencapai difficulty 6
(registrasi sudah memakai satu challenge, upgrade memakai challenge kedua →
`min(4 + count, 8)`), jadi ~16³ ≈ 4096 evaluasi Argon2id — puluhan detik dengan
ekor geometris yang gampang melewati 60 detik. Anggarannya sekarang disamakan
dengan **timeout PoW milik klien sendiri** (300 detik, `crypto-worker-proxy.minePoW`)
dan timeout global spec dinaikkan **di atas** anggaran itu (480 detik), supaya
kalau mining memang tidak pernah selesai yang menangkap adalah assertion badge —
bukan timeout global yang pesan kegagalannya tidak lagi menunjuk penyebab. Test
tetap gagal bila badge tidak muncul; yang berubah hanya anggarannya.

Setelah empat perbaikan itu, **seluruh suite Chrome hijau pada run penuh yang
sama: 12 passed, 2 skipped** (dua skip itu `spqr.spec` yang memang env-gated,
bukan lulus palsu). Sebelumnya run penuh terakhir berakhir `1 failed, 11 passed`.

Dokumentasi residual diperbarui agar tidak lagi menyebut “belum dijalankan”:
`docs/30` §30.9 (status keempat gate WS-E) + §30.20 (bagian M6 baru), `docs/29`,
`docs/10` §10.2, `docs/11` §11.2–§11.4, `AGENTS.md`. Sisa WS-E tinggal operasi:
coturn systemd di VPS.

## 🎯 WS-G tuntas: alert di-drill, load test terukur, oracle lintas-implementasi — 2026-10-14

Tiga item WS-G (`docs/30`) ditutup dengan bukti, bukan dengan catatan status:

- **WS-G(2) alert di-drill.** `ops/prometheus/tests.yml` + `scripts/drill-alerts.sh`
  (4 lapis) membuktikan tiap aturan **bisa menyala**, bukan cuma bisa
  dikompilasi. Lapis ketiga menolak aturan yang merujuk nama metrik yang tidak
  dideklarasikan (`metrics.ts`) — kesalahan itu sebelumnya menghasilkan aturan
  yang **diam selamanya tanpa error apa pun**; lapis keempat menolak aturan baru
  yang belum punya kasus drill. Saat pertama di-drill, tiga aturan mengeluarkan
  label yang tidak sesuai dugaan (`NyxMetricsExporterDown` menambah `job`,
  `NyxSweeperStale`/`NyxKtSnapshotNotUploaded` menandai sampel terakhir yang
  `result="ok"`) — kelas kesalahan yang hanya terlihat dengan menjalankan
  ekspresi terhadap seri waktu. Jobs CI baru: `alerts` (+ lapis scrape-nyata di
  `e2e`).
- **WS-G(3) load test dijalankan.** `scripts/load/run-relay-load.sh` + `server/scripts/load-test-user.ts`
  menyiapkan akun/device/percakapan uji secara idempoten, menjalankan **SMOKE 5 VU**
  lebih dulu, lalu beban penuh. Terukur 500 VU: send p95 **74,4 ms**, fetch p95
  **68,8 ms** (gate < 200 ms), `http_req_failed` **0%**, `nyx_relay_errors` **0%**.
  Tanpa langkah SMOKE, kegagalan autentikasi/CSRF tampak seperti beban ringan
  (dijawab cepat tanpa menyentuh DB).
- **WS-G(6) vektor lintas-implementasi.** `tools/dr-oracle/` — oracle Go yang
  **tidak memakai libsodium sama sekali** (X25519 `x/crypto`, konversi
  Ed25519→X25519 ditulis sendiri, X-Wing `cloudflare/circl`, BLAKE2b keyed,
  XChaCha20-Poly1305) menutup lubang "implementasi NYX menyetujui kesalahan
  implementasi NYX". Dua arah: vektor ter-commit diverifikasi oleh test web
  lewat **worker asli** (`x3dhOracleVectors.test.ts`), dan hasil NYX diserahkan
  kembali ke oracle (`x3dhOracleInterop.test.ts`, termasuk kontrol negatif).
  Gate drift `go run . -check` menjaga vektor tidak menyimpang diam-diam; job CI
  `dr-oracle`. **Batas jujur:** sender-key chain/skipped key/`SessionRecord`
  libsignal tidak dibandingkan ke oracle (tetap internal), jadi ini ditulis
  sebagai parsial di `docs/29`/`docs/30`, bukan "vektor DR penuh".

Bukti: `scripts/drill-alerts.sh` exit 0 (14 aturan, 14 kasus drill, 7 metrik
terdeklarasi, exporter hidup 13 keluarga metrik), interop 4/4, `-check` identik.

## 📦 Sumber Signal masuk repo: `vendor/` penuh — 2026-10-14

Sebelumnya kode Signal yang dipakai NYX hanya hidup sebagai **checkout lokal di
luar repo**: `packages/*/build.sh` menunjuk `~/signal/...`, `server/kt-query`
memakai `replace` ke path itu, dan CI bergantung pada artefak WASM yang sudah
di-commit. Akibatnya clone bersih tidak bisa membangun apa pun yang menyentuh
Signal, dan tidak ada cara memeriksa "kode apa yang sebenarnya dipakai" dari
dalam repo. Sekarang sumbernya **di-vendor utuh** (±25 MB) sehingga satu clone
cukup:

- **Rust:** `vendor/signal/spqr` (crate `spqr` v1.6.0, pin `06959b4708f9`,
disalin apa adanya termasuk `benches`/`proofs`) dan
`vendor/signal/libsignal-keytrans` (pin `e8cc2dddd578`), dengan manifest
libsignal **dimaterialisasi** — setiap `workspace = true` ditulis ulang jadi versi
eksplisit karena crate itu kini berdiri sendiri. Tidak ada patch pada kode
upstream; perubahan perilaku hanya boleh datang dari naiknya pin.
- **Go:** `server/kt-query/vendor/github.com/signalapp/keytransparency` (pin
`30b7a2a40604`), dihasilkan `go mod vendor`. `go.mod` **tidak lagi memuat
`replace`** ke checkout lokal, jadi `go build/test` jalan offline dengan
`-mod=vendor`.
- **Pembungkus ikut berubah:** `packages/spqr-wasm/build.sh` dan
`packages/keytrans-wasm/build.sh` sekarang default ke sumber ter-vendor
(`SPQR_CRATE_PATH` / `KEYTRANS_PATH`, alias lama `LIBSIGNAL_PATH` masih
didukung) untuk mode "kejar pin"; `server/kt-query/build.sh` menolak build tanpa
`vendor/` dan hanya memakai `NYX_KT_UPSTREAM` bila diminta eksplisit.
- **`NOTICE` dan dokumen diperbaiki:** klaim "tidak di-vendor" diganti dengan
fakta vendoring (sumber upstream kini ikut didistribusikan → wajib berada di
repo bersama `LICENSE`), termasuk `README.md`, `AGENTS.md`, `docs/11` §11.3,
`docs/25` §25.3, `docs/30` §30.1/§30.15/§30.16b/§30.17, `docs/33` §33.2/§33.6,
dan komentar `.gitignore`.
- **Guard & CI:** `scripts/vendor-signal.sh` (re-vendor dari checkout pada pin,
menolak commit yang tidak cocok), `scripts/check-vendor.sh` (manifest ada &
ter-materialisasi, pin di `vendor/README.md` cocok dengan `NOTICE`, `go.mod`
tanpa `replace`, tiap paket di `modules.txt` ada di disk, semuanya ter-track),
dan langkah CI baru yang menjalankan guard itu plus `go build/vet/test`
`server/kt-query` dari vendor (dengan `setup-go` dari `go-version-file`).
- **Bukti:** `cargo +nightly test --release --lib` di crate ter-vendor →
**57 passed, 0 failed** (sama dengan checkout pin); `go vet` + `go test`
`server/kt-query` → lulus, termasuk build dengan `GOPROXY=off` +
`GOMODCACHE` kosong (bukti tidak menyentuh jaringan); 28 test web
(`spqrRatchet` 10 + `keyTransparency` 18) lulus terhadap kedua WASM yang
**dibangun ulang dari sumber ter-vendor**. sha256 artefak WASM bergeser
(46168c12…→62a72c14… spqr; 8f29334e…→3c35c0df… keytrans) karena rustc menyematkan
metadata path sumber — perilakunya diverifikasi lewat test di atas, bukan lewat
hash.

## 🔐 SPQR tuntas: ratchet jalur v2 hidup berdampingan dengan jalur beku — 2026-10-14

WS-D berhenti di batas "pembungkus + test" karena mengganti langkah `KEMs/KEMr`
mengubah **protokol beku** (`docs/04`). Sekarang versi jalur barunya ada,
dipilih lewat bukti peer, dan dibuktikan E2E di Chrome — bukan tambalan pada
format lama.

- **Wire v2 (versi baru):** header `{v: 2, b: [frame…]}` (frame braid ~37 B)
  menggantikan `kemPk`+`ct` 1120 B di jalur v1; sisa jalur **identik** (pad 8 KB,
  nonce 24 B, XChaCha20-Poly1305) sehingga ciphertext di wire tetap satu bentuk
  dan MK cache untuk pesan duplikat tetap berlaku.
- **Bukti dari peer sebelum kirim:** `ackV: 2` di payload ter-seal = "versi ratchet yang
  bisa saya buka". Pengirim hanya memakai v2 setelah melihat deklarasi itu dari
  peer — klien lama **tidak pernah** menerima header yang tak bisa dibacanya.
  Sesi yang sudah v2 sticky (reconnect/WSS tidak menurunkannya), rollback
  mengembalikan `preservedVersion: 'v2'` sehingga state braid tidak dihapus.
- **State berdampingan:** state DR v1 tidak pernah ditimpa; state braid per sesi
  di baris `nyx_spqr_state_v1:*` (ter-seal `ENC1:`, tulis di-koalesensi 250 ms,
  dibaca dari antrean pending, di-flush saat tab disembunyikan, dibuang saat
  wipe). Akar braid (`spqrAuthKey`/`spqrDirection`) menumpang di baris state DR
  supaya modul WASM 506 KiB tetap dimuat malas.
- **Gate deployment di relay:** sidecar mengiklankan `spqr-ratchet`
  (`SERVER_CAPABILITIES`) — saklar tingkat deployment; kill switch klien:
  `VITE_SPQR_FORCE_V1=1` (build-time) dan kill switch **runtime**
  `localStorage['nyx_spqr_force_v1']` (hanya build DEV, dibaca per pengiriman).
  **Saklar hanya menghentikan kirim + iklan, bukan jalur baca:** menolak membaca
  v2 yang sudah terkirim akan mengubah tindakan operator menjadi kehilangan
  pesan, padahal state braid justru sengaja dipertahankan.
- **Bukti:** 13 test `spqrSession` (modul WASM sungguhan + ratchet palsu untuk
  loop tanpa key), 8 test `spqrWire`, 18 test negosiasi, `cargo test` sidecar,
  dan E2E Chrome `web/e2e/spqr.spec.ts` yang memeriksa amplop **di server**
  (`dr.v === 2`, ada `b`, tanpa `kemPk`) sambil memastikan peer membaca plaintext.
- **Gate §30.8 poin 1 sekarang tertutup:** test internal crate `spqr` pada
  checkout pin (`06959b4708f9` = v1.6.0) dijalankan — `cargo +nightly test
  --release --lib` → **57 passed, 0 failed**, exit 0 (stable gagal `E0658`,
  `std::assert_matches`). Karena satu langkah `send` crate = satu chunk di wire,
  test chunked itu (`v1::test::chaos` 10.000 tick / `onlineoffline_healing_unidir`
  100.000 tick) juga memberi bukti **loss per chunk** untuk gate poin 2.
- **Rollback kini diuji dua klien nyata** (sebelumnya hanya resolver + ratchet
  palsu): test kedua `web/e2e/spqr.spec.ts` memaksa satu klien kembali ke v1 di
  tengah sesi v2 lewat kill switch runtime DEV. Dari amplop di server: klien yang
  di-rollback **mengirim v1 lagi**, peer (sesi v2) tetap membacanya, pesan v2 dari
  peer **tetap terbaca** di klien yang di-rollback, dan baris state braid-nya
  masih ada (`loadSpqrState` → `v2`).
- **Modul WASM masuk precache service worker:** `**/*.wasm` ditambahkan ke
  `injectManifest.globPatterns` (`web/vite.config.ts`) sehingga `spqr-*.wasm` dan
  `keytrans-*.wasm` tersedia offline sejak install (terverifikasi di `dist/sw.js`);
  biaya install PWA bertambah **±0,8 MB** tak terkompresi.

## 🔐 KT masuk jalur bundle + loop monitor berjalan; SPQR siap-sambung — 2026-10-14

Tiga hal yang selama ini "ada tapi tidak dipanggil" sekarang dipanggil, ditambah
prasyarat integrasi SPQR. Semua bertambah **tanpa** mengubah format beku.

### Verifikasi log Key Transparency di jalur prekey bundle

Sampai hari ini klien hanya **menulis** log KT; bundle kunci palsu dari server
masih diterima karena pin TOFU percaya apa pun pada kontak pertama.

- `web/src/lib/ktBundleProof.ts` — ambil bukti `/api/keys/kt/*`, verifikasi WASM,
  bandingkan kunci di log dengan kunci bundle → verdict (tidak melempar):
  `confirmed` / `mismatch` / `unverifiable` / `unavailable` / `unknown-subject`.
- `web/src/lib/ktSubject.ts` — **username peer** diturunkan dari profil E2EE
  (cache RAM → participant → dekripsi `encryptedProfile` percakapan → kontak).
  Tanpa ini search key `0x75‖Argon2id(username)` tidak bisa dibentuk, jadi dulu
  verifikasi mustahil dipanggil dari jalur bundle.
- `web/src/lib/peerIdentityTrust.ts` — verdict masuk **sebelum** kunci dipin:
  `mismatch` pada kontak **pertama** kini memblokir kirim + memunculkan banner
  (dulu tidak terdeteksi siapa pun), `confirmed` mencatat `ktVerifiedAt` (TTL 24
  jam agar tidak memanggil log berulang), verdict lain tetap TOFU tetapi tercatat
  (`ktLastVerdict`) — KT yang mati tidak boleh membuat NYX tidak bisa dipakai.
- UI: banner identitas membedakan `source: 'kt'` ("kunci bertentangan dengan log
  publik") dari rotasi biasa, 2 kunci i18n ×4 bahasa.

### Loop monitor dijalankan penjadwal

`runKtMonitorOnce` sudah ada sejak kemarin tetapi tidak pernah dipanggil — jadi
klien tidak pernah punya bukti konsistensi (`docs/34` §34.5: tanpa itu perubahan
kunci tidak terdeteksi).

- `monitorKeyTransparency()` (jembatan verifier + config ke
  `POST /api/keys/kt/monitor`), `startKtMonitorLoop()` (jeda awal 30 s lalu tiap
  6 jam, satu langkah pada satu waktu, gagal ≠ berhenti), dan wiring `App.tsx`
  dengan impor dinamis (WASM 295 KiB tidak masuk bundel awal) + toast saat
  `keyVersion` di log naik.

### Prasyarat integrasi SPQR (jalur pesan v2 belum dinyalakan)

- `web/src/lib/spqrNegotiation.ts` — keputusan versi ratchet: kapabilitas hanya
  dibaca saat sesi **didirikan** (tidak ada perubahan versi di tengah sesi),
  anti-downgrade (v2 hanya bila kedua sisi mampu), saklar tunggal
  `SPQR_INTEGRATION_ENABLED=false`, dan rollback eksplisit yang **mempertahankan**
  state v2 agar pesan lama tetap terbaca.
- `web/src/lib/spqrState.ts` — state braid per sesi: ter-seal `ENC1:`, tulis
  di-koalesensi 250 ms (benchmark: state 3,8 KiB/langkah), batas 64 KiB
  diperiksa sebelum masuk antre, dan fail-closed saat dibaca. Sisa langkah =
  versi wire baru di header DR + ack + memanggil modul ini (`docs/33` §33.7).

Verifikasi: web `tsc` 0, `vitest` **551/551** (67 file), server `tsc` 0, server
`node:test` 351 pass/1 skip, dan E2E chromium di lingkungan lokal (Postgres +
Redis lokal siap; catatan lama "E2E tidak bisa dijalankan" sudah tidak berlaku —
`docs/30` M4): `auth.spec` **3/3**, `chat.spec` (kirim pesan antar dua klien) +
`profile.spec` **2/2**.

## 🐛 Burner guest: sesi ephemeral tidak lagi dibunuh bootstrap `/drop` — 2026-10-14

Regresi E2E burner (host kirim lampiran → guest tak pernah menerima) berakar pada
**dua hal**, keduanya di jalur guest:

- **Bootstrap aplikasi balapan dengan `POST /api/auth/burner`.** Halaman `/drop`
  menjalankan `bootstrap()` seperti halaman lain. Guest bukan akun server, jadi
  refresh-nya gagal dan fallback `GET /api/users/me` menjawab 401 — lalu jalur
  `catch` bootstrap **menghapus cookie `at` + `user`** yang baru diterbitkan untuk
  guest. Uplink burner turun, BurnerChat menerbitkan **identitas guest baru**,
  dan balasan host hilang (relay `burner:reply` ditujukan ke id lama).
  `App.tsx` sekarang melewati bootstrap store di route `/drop`.
- **`burner:join` tidak pernah diulang setelah reconnect.** Keanggotaan
  `burner:room:<roomId>` mengikat identitas socket saat join, sedangkan guest
  ephemeral bisa berganti identitas dan WebTransport bisa reconnect. `BurnerChat`
  kini join ulang setiap event `connect` transport.
- Verifikasi: `pnpm exec playwright test --project=chrome --grep burner` →
  **2 passed** (host→guest lampiran tampil sebagai preview; room yang di-destroy
  tidak kembali setelah reload). Spec ikut diperbaiki: pembukaan burner host
  dilakukan in-app (reload menghapus DR host yang RAM-only), Quick Tour ditutup
  setelah tiap navigasi penuh, dan Destroy ditunggu selesai sebelum reload —
  rinciannya di `docs/11-testing.md`.

## 🔁 KT: penyimpanan state monitoring + satu langkah loop — 2026-10-13

`docs/34` §34.5 menyimpulkan bahwa **loop monitor bukan opsional**: tanpa anchor
tree head yang tersimpan, perubahan `search`/tree head tidak terdeteksi. Sampai
sekarang tak ada tempat menyimpannya. Sekarang ada:

- Tabel Dexie **`ktMonitoring`** (`web/src/lib/db.ts` versi 11, murni aditif) —
  satu baris per `0x75||usernameHash(32)`, dengan `treeHead`,
  `monitoringData`, `distinguishedTreeHead`, dan `keyVersion` **ter-seal
  `ENC1:`** (masterSeed). Search key sendiri sudah hash 32 byte → boleh jadi PK
  plaintext; nilai bukti tidak.
- `web/src/lib/ktMonitoring.ts`: `saveKtState`/`loadKtStates` (update parsial
  mempertahankan nilai lama), `planKtMonitor` (pilih baris siap + anchor),
  `runKtMonitorOnce` (rakit permintaan via op 6 → `POST /monitor` →
  `verifyMonitor` → simpan), `clearKtStates`.
- **Fail-closed**: state hanya ditulis setelah verifikasi berhasil — bukti palsu
  atau jaringan gagal tidak mengubah apa pun. Diuji eksplisit.
- `KtMonitorOutcome.changed` melaporkan `keyVersion` yang naik (kandidat
  notifikasi ke user); modul tetap bebas UI/toast.
- Verifikasi: `web/src/lib/__tests__/ktMonitoring.test.ts` — **7 test** (round-trip
  ter-seal, update parsial, `planKtMonitor`, fail-closed dengan bukti tidak sah
  dari fixture jalur produksi). Suite web: 507 → **514**.

Sisa: penjadwalan timer + notifikasi UI, dan loop ini baru punya data setelah
verifier dipanggil di jalur bundle (§34.6 poin 1).

## 🐛 Registrasi tidak lagi terblokir prompt kunci saat onboarding — 2026-10-13

Suite E2E tidak pernah bisa hijau: setelah `POST /api/auth/register` berhasil
(201), muncul overlay **"ACCESS CONTROL PAD"** (`PasswordPromptModal`) dan alur
onboarding berhenti — modal `TRUST LEVEL VERIFICATION` (tombol *Skip for now*)
tak pernah tampil. Akar masalahnya bukan di jalur registrasi, melainkan di helper
at-rest: `keychainDb.getMasterSeedOrUndefined()` memanggil
`useAuthStore.getState().getMasterSeed()`, yang **memunculkan prompt**. Helper itu
dipanggil fire-and-forget oleh `migrateKeychainAtRestEncryption()` dari
`saveDeviceAutoUnlockKey()`, yaitu saat vault belum ter-unlock dan identitas user
belum ter-scope — jadi prompt itu tak pernah bisa dijawab.

- `useAuthStore.getMasterSeedIfUnlocked()` baru: cache → auto-unlock senyap →
  `undefined` bila terkunci; **tidak** menyentuh `keysRetrievalPromise` bersama
  (agar tidak mencuri hasil pemanggil yang memang boleh memunculkan prompt).
- `keychainDb.getMasterSeedOrUndefined()` memakainya — sesuai namanya, tidak
  pernah memblokir.
- Helper E2E `dismissModalCloseButton` (di `web/e2e/helpers/registration.ts`)
  menggantikan `locator(...).first().click()` yang rapuh pada tombol `×`: elemen
  sering "not stable"/detached saat modal lama masih ber-animasi keluar; kini
  lokator di-resolve ulang tiap percobaan + `force`. `auth.spec.ts` dimigrasikan
  ke helper bersama itu (sebelumnya menyalin rantai onboarding).
- `settings.spec.ts`: klik konfirmasi scoped ke dialog + `force`.

Hasil E2E chromium (mesin ini, sidecar berjalan): `auth.spec` 3/3, `profile`,
`security`, `settings` lulus; 2 test burner (`regression.spec`) masih gagal di
`ESTABLISHING_UPLINK` (perlu ditelusuri terpisah).

## 🔧 KT: op `monitor_build` — permintaan monitor dirakit di WASM — 2026-10-13

Langkah berikutnya yang `docs/34` §34.6 poin 2 catat ("ABI WASM belum punya op
untuk membangun permintaan monitor") sudah ditutup. `packages/keytrans-wasm`
sekarang mengekspor op **6 `monitor_build`**: dari `StoredMonitoringData` dan
tree head (`StoredTreeHead`) yang sudah dimiliki klien, ia merakit
`transparency.MonitorRequest` (protobuf) siap dikirim ke `/api/keys/kt/monitor`.

- Encoding protobuf dilakukan **di Rust** (bukan JS) — konsisten dengan aturan
  "tidak ada parser protobuf di klien"; `commitment_index` diambil dari keluaran
  VRF bukti search terakhir, `entry_position` dari posisi log terakhir.
- Pembungkus TS: `verifier.buildMonitorRequest({ monitoringData, distinguishedTreeHead, lastTreeHead })`.
- `lastTreeHead` opsional: bila dikirim, `consistency.last` ikut terisi (bukti
  konsistensi menyala); bila tidak, hanya `consistency.distinguished` (anchor).
- Bukti: `web/src/lib/__tests__/keyTransparency.test.ts` naik dari 16 → **18 test**
  (`buildMonitorRequest` dari monitoring data nyata + penolakan daftar kosong);
  artefak WASM dibangun ulang (`dist/keytrans.wasm`, 299.846 B).

Sisa yang jujur (tetap seperti `docs/34` §34.6): penyimpanan monitoring data/tree
head per kontak di keychain (`ENC1:`) dan penjadwalan loop belum ada; loop itu
juga baru punya data setelah verifier dipanggil di jalur bundle (poin 1).

## 🔍 Sisi baca Key Transparency milik NYX sendiri (`nyx-kt-query`) — 2026-10-13

Sampai sekarang NYX hanya **menulis** log KT: tidak ada cara meminta bukti, jadi
verifier klien (`docs/34`) tak punya sumber. Menyediakan sisi baca ternyata tidak
bisa memakai query service upstream, dan tidak bisa dijalankan sebagai proses
kedua. Keduanya dibuktikan dengan menjalankan binary Go yang sesungguhnya, bukan
dengan membaca dokumen (`docs/32` §32.8):

```
== A) SEARCH tanpa entri ACI di log (kondisi log NYX) ==   search permission denied
== B) SEARCH dengan nilai format Signal 0x00||aci16 ==     ACI + username hash: OK
== C) tulis nilai format NYX (1286 B) ke search key itu ==  entry ditulis (tree 4)
== D) SEARCH setelah nilai format NYX ==                    rpc error: Unavailable: unexpected error
```

`aciSearch()` wajib, dan `usernameHashSearch()` bukan hanya menolak nilai yang
bukan `0x00||aci16` — ia menggagalkan seluruh `SearchV2`. Temuan kedua:
`storage.newFileLock(readOnly=true)` mengambil `LOCK_SH` di level OS sedangkan
penulis memegang `LOCK_EX`, sehingga membuka LevelDB yang sama secara read-only
pun gagal (`resource temporarily unavailable`); goleveldb hanya melepas kunci
*in-process*-nya, bukan flock-nya.

Karena itu satu proses memiliki basis data — dan proses itu milik NYX:
**`server/kt-query`** (Go, paket `tree/transparency` + `db` upstream yang di-pin,
tanpa fork) menyajikan tiga peran: baca bukti NYX (`GET /search`,
`/distinguished`, `POST /monitor`, `/config`), tulis lewat gRPC
`KeyTransparencyTestService.Update` (**protokol penulis lama tidak berubah** —
`KT_SERVER_URL` tetap), dan kunci `distinguished`. Server NYX meneruskannya lewat
`/api/keys/kt/*` (byte protobuf base64url apa adanya; parser dan verifikasi tetap
di WASM) dengan metrik `nyx_kt_queries_total{result}` dan degradasi terlihat:
tanpa `KT_QUERY_URL`, endpoint menjawab 503 `KT_QUERY_DISABLED` dan bukan TOFU
senyap.

Verifikasi: 18 test Go (termasuk `VerifySearch` **dan** `VerifyMonitor` upstream
menelan bukti untuk nilai NYX 1286 byte), 13 test proxy server (`ktQuery.test.ts`),
dan jalur hidup penuh — penulis TS → adapter → HTTP → fixture → **verifier
libsignal di WASM** (16 test, termasuk rotasi kunci terhadap anchor bukti
sebelumnya). Temuan saat menjalankan jalur itu: tanpa klien mengirim `last`, server
tidak menyalakan bukti konsistensi dan verifikasi dengan anchor gagal sebagai
`Malformed proof` — perilaku yang sekarang dikunci test.

Sisa yang jujur: loop monitor klien butuh op WASM baru (`monitor_build`),
pemanggilan verifier di jalur bundle (`processPreKeyBundle`), dan
auditor/`SetAuditorHead` belum dikerjakan — `docs/34` §34.6.

## 🔐 Verifier Key Transparency (nyata, bukan mock) + ratchet SPQR PQ (2026-10-13)

Dua workstream `docs/30` yang selama ini hanya punya "toolchain terbukti":
**WS-A** (verifier KT di klien) dan **WS-D** (SPQR), plus penutupan gate
observability/anti-abuse dari milestone sebelumnya.

**WS-A — verifier KT di klien (`docs/34`).** Crate `libsignal-keytrans`
berhasil dikompilasi ke `wasm32-unknown-unknown` (`packages/keytrans-wasm/`,
295 KB, **nol import**, tanpa `wasm-bindgen`) dengan ABI scratch-buffer:
`verify_search`, `verify_monitor`, `verify_distinguished`, `monitor_next`, dan
`condense_update`. Klien `web/src/lib/keyTransparency.ts` + **12 test**
(`web/src/lib/__tests__/keyTransparency.test.ts`) yang memverifikasi **bukti
nyata dari binary Go `key-transparency-server`** — fixture dibuat oleh
`server/scripts/kt-fixtures.ts` (`pnpm --filter nyx-server run kt:fixtures`),
menulis dua entri NYX lewat penulis log dengan `return_update_response=true`
(tree 63→64, `vrf_proof` 80 B). Test mengunci: nilai terverifikasi,
rotasi kunci, **MITM (nilai palsu) ditolak**, `vrf_proof`/`opening` diubah
ditolak, dengan anchor `search`/`tree head` palsu ditolak, kunci VRF/search key
salah ditolak, dan fuzz 200 input tanpa trap.

Temuan yang dicatat jujur (`docs/34` §34.5): pada pencarian **pertama** (belum
ada anchor) perubahan di `search`/`tree head` belum terdeteksi — keamanan KT
bergantung pada loop monitor yang menyimpan tree head. Karena itu integrasi ke
jalur bundle produksi dan loop monitor otomatis **belum** dikerjakan (§34.6),
bersama auditor/`SetAuditorHead`.

**WS-D — pembungkus + test + benchmark SPQR (`docs/33`).** Crate `spqr`
v1.6.0 dikompilasi ke WASM sebagai raw module tanpa import, dengan entropi
disuntik host (`getrandom_backend="custom"`) sehingga RNG-nya bisa diaudit dari
klien. `web/src/lib/spqrRatchet.ts` + **10 test** memakai modul hasil build
sungguhan: kesepakatan message key, entropi host deterministik, entropi kurang →
`SpqrError(4)`, fuzz, **kehilangan 1..N−1 pesan**, **pengiriman keluar urutan**,
dan kehilangan dua arah — semuanya sembuh. Benchmark terukur
(`pnpm --filter nyx-web run bench:spqr`): pesan mapan 37 B, **state 3,8 KiB per
langkah**, `send` p50 0,26 ms / `recv` p50 0,12 ms (mesin dev). Bug nyata yang
ditemukan & diperbaiki di jalan: `memory.buffer` dibaca sebelum getter pointer
Rust → alokasi malas + `memory.grow` melepas ArrayBuffer ("detached") pada
instance kedua dan seterusnya.

Gate yang **belum** tertutup dan dicatat sebagai residual: test internal crate
`spqr` (butuh nightly, kompilasi >10 menit) belum dijalankan; erasure coding
**per chunk** ada di modul `pub(crate)` crate sehingga hanya bisa diuji di
bentuk yang teramati dari ABI publik (pesan hilang/keluar urutan).

**Verifikasi:** web `tsc` 0, server `tsc` 0, `pnpm --filter nyx-web run build`
exit 0, vitest **501/501** (62 file), server `node:test` **336/336** (1 skip:
test live KT yang butuh binary).

## 🛡️ WS-G(4)/(5) + penutup WS-F: otorisasi grup teruji, fuzz parser, kolom waktu kontak (2026-10-12)

Audit residual `docs/30` (non-E2E). Tiga hal yang ditutup:

**WS-G(4) — jalur grup kini punya test perilaku.** Keputusan otorisasi yang
dulu tersebar inline di `routes/conversations.ts` dipindah ke
`server/src/utils/groupAccess.ts` (add/kick anggota, leave, details, rotasi
kunci, purge) dan diuji sebagai **perilaku** dengan klien Prisma palsu
(`tests/groupAccess.test.ts`, 17 test) — bukan regex atas source. Yang dikunci:
kode status + pesan kontrak, **urutan** gate (token → capability admin →
hitungan anggota), 409 `MEMBERS_REMAIN` sebelum apa pun dihapus, fail-closed
saat `adminSecretHash` NULL, dan bahwa pencarian baris keanggotaan memakai nilai
routing ter-seal (userId mentah tidak pernah jadi nilai query). Catatan kontrak
lama yang sengaja dipertahankan: `PUT /:id/details` menjawab 403 (bukan 404)
untuk conversation yang tidak ada.

**WS-G(5) — fuzz parser input tak terpercaya (deterministik).** Web:
`web/src/lib/fuzzParsers.ts` + runner vitest untuk `parseTransportHello`,
`readBackupHeader`, `unpadBackupPayload`, `parseBackupArchive`,
`readBackupChunk` (5 × 100k input ≈ 50 s, 0 temuan) dengan invariant bentuk
hasil, bukan sekadar "tidak crash", plus **self-test** yang membuktikan harness
benar-benar melaporkan temuan. Sidecar: keputusan framing `[opcode][len][payload]`
yang dulu ditulis empat kali inline dipindah ke crate lib (`src/protocol.rs`,
`src/fuzz.rs`, runner `src/bin/fuzz-framing.rs`) dan di-fuzz 160,9 juta iterasi
per 300 s (536k/detik → gate 1 jam ≈ 1,9 miliar input, 0 temuan), termasuk
differential test melawan implementasi referensi kedua. `cargo test` masuk CI
(job `e2e-chrome`).

**WS-F — kolom waktu terakhir yang masih plaintext.** `ContactRow.updatedAt`
dan `ProfileCacheRecord.updatedAt` (pola aktivitas di IndexedDB) kini di-seal
(`ENC1:`) di titik tulis dan di rel migrasi unlock yang sudah ada
(`migrateAtRestSealing`, idempoten; vault terkunci tidak pernah menghapus
plaintext). Pembaca kontak memakai `openLocalNumber`, jadi baris lama tetap
terbaca.

Plus artefak observability yang dijanjikan `docs/30` §30.11(1) tetapi belum ada:
`ops/grafana/dashboards/nyx-overview.json` (18 panel; query = metrik yang sudah
dideklarasikan `metrics.ts`, ambang disamakan dengan `ops/prometheus/alerts.yml`).

Sisa yang **tidak** dikerjakan di audit ini (dicatat eksplisit di `docs/30`
§30.20): WS-E(2) signaling call berbasis token (hanya bisa diverifikasi lewat
E2E call chrome), WS-G(6) vektor DR/sender-key vs oracle libsignal (butuh build
libsignal + menyentuh jalur kripto beku), WS-H per-hash-ASN (butuh data ASN),
WS-A/WS-D (proyek tersendiri).

## 🔐 WS-F langkah 1–3: skema + wiring urutan terenkripsi & seal kolom struktur (2026-10-12)

`web/src/lib/localOrderKey.ts` (+ modul daun `localOrderBucket.ts`; 19 test) — kolom pengurutan vault lokal
(`createdAt`) tidak bisa langsung di-seal: ciphertext tidak punya urutan
leksikal, jadi range-scan indeks + `.limit()` sebelum dekripsi hilang dan
paginasi `fetch-older` rusak. Skema dua lapis:

- `orderBucketMs` — waktu di-floor ke bucket 15 menit (`LOCAL_TIME_BUCKET_MS`,
  konstanta yang sama dengan bucket `createdAt`/`lastMessageAt` server) → tetap
  bisa diindeks, dan granularitasnya **sudah** dipublikasikan server, jadi tidak
  menambah kebocoran.
- `createdAtSealed` — presisi sebagai envelope `ENC1:` (helper sama dengan
  `seq`); urutan presisi dipulihkan setelah kandidat diambil, bukan sebelum.

Opsi "nilai urut ter-HMAC" di `docs/30` §30.20 ditolak saat implementasi (HMAC
adalah fungsi acak → indeks tidak bisa di-range-scan). Aturan yang diuji:
kursor `beforeDate` tetap **inklusif** dan keluaran tetap lama→baru seperti
`.reverse().limit().reverse()` lama, baris tanpa waktu dibuang, dan pembaca
harus mengambil bucket batas **utuh** (`equals([conv, bucket])`) — kalau
berhenti di `limit` baris pertama, baris lebih tua di bucket batas terlewat
permanen (indeks mengurutkan kunci yang sama berdasarkan primary key).

**Wiring (langkah 2).** `db.ts`: Dexie **v9** mengganti indeks pesan ke
`[conversationId+orderBucketMs]` dan mengisi bucket baris lama saat upgrade
(murni aritmetika waktu — `masterSeed` belum tentu tersedia saat DB dibuka).
`shadowVaultDb.ts`: writer menyegel `createdAt` lewat `ensureOrderFields`
(plaintext baru dilepas **setelah** envelope berhasil dibuat), pembaca
berpaginasi per bucket utuh dengan jendela maksimum 32 bucket (~8 jam) dan
**memulai halaman pertama dari bucket terbaru yang ada** — bukan dari `now`,
karena percakapan yang sepi berhari-hari akan tampak kosong kalau begitu.
`messageSearch` mengurut lewat lapis presisi (bukan `sortBy('createdAt')` yang
kini berisi ciphertext). Baris yang masuk melewati writer — restore `.nyxbak`
(`liveBackupStore`) dan impor JSON — dinormalkan lewat
`shadowVault.normalizeOrderIndex()` (idempoten), karena tanpa kolom bucket
pesannya tersimpan tapi tidak pernah muncul di query.

Test baru: `localOrderKey.test.ts` (19) dan `shadowVaultOrderIndex.test.ts`
(10, tabel palsu yang meniru indeks bucket), plus `vaultSeqPersistence.test.ts`
yang fake-nya diperbaiki agar benar-benar menyaring per kunci (sebelumnya
mengembalikan seluruh tabel) dan menguji jalur perbaikan baris lama.
Verifikasi: `tsc` 0, `vitest` **414/414** (52 file), build web exit 0.

**Langkah 3 — kolom struktur di-seal di tempat.** `senderId`, `repliedToId`,
`isViewOnce`, `isDeletedLocal`, `expiresAt` (ms) dan `Conversation.isGroup` kini
disimpan sebagai envelope `ENC1:` **di kolom yang sama** (pola `seq`), lewat
`sealLocalText`/`sealLocalFlag` + pembacanya (`openLocalText`/`openLocalFlag`,
toleran baris plaintext lama). Dexie **v10** melepas indeks yang jadi tak
berguna: `messages.senderId`, `messages.isDeletedLocal`, `conversations.isGroup`
(tidak ada satu pun klausa query yang memakainya).

Dua jebakan yang ikut ditutup dan dikunci test:
- Nilai ter-seal **selalu truthy**, jadi pembaca yang dulu menulis
  `if (row.isViewOnce || row.isDeletedLocal)` (mis. `messageSearch`) harus
  membukanya dulu — kalau tidak, seluruh hasil pencarian akan ter-skip.
- `expiresAt` yang sudah berupa envelope **tidak boleh** diurai `Date.parse`:
  jalur tulis ulang sekarang mempertahankan baris lama apa adanya
  (`readExpiresAt` untuk membaca; tanpa itu expiry pesan hilang saat tombol
  status/unsend menyentuh baris itu).

`status` sengaja tidak ikut: tidak ada jalur tulis yang menyimpannya, jadi
menyegelnya tidak menambah privasi apa pun.

Verifikasi: `tsc` 0, `vitest` **427/427** (53 file), build web exit 0;
`shadowVaultOrderIndex.test.ts` bertambah jadi 14 test (round-trip kolom
ter-seal, kompatibilitas baris lama, expiry, `isGroup`).

**Semantik Dexie kini benar-benar diuji, bukan diasumsikan.**
`dexieMigration.test.ts` (9 test, devDependency baru `fake-indexeddb`) membangun
dulu DB versi-1 berisi baris lama (indeks `[conversationId+createdAt]`, kolom
plaintext), lalu membukanya dengan skema aplikasi: upgrade v1→v9 mengisi
`orderBucketMs` untuk semua baris, indeks `[conversationId+orderBucketMs]`
terisi dan bisa di-range-scan (`.equals([conv, bucket])` dan
`.between(min,max).reverse().limit(1)`), v10 benar-benar menghapus indeks
`senderId`/`isDeletedLocal`/`conversations.isGroup`, dan pembaca/writer vault
berjalan di atas IndexedDB nyata (termasuk round-trip konten + kolom ter-seal
serta `normalizeOrderIndex` untuk baris hasil restore).

**Belum diverifikasi:** E2E browser (UI chat scroll-back, upgrade pada profil
pengguna nyata). Catatan test: stub `crypto-worker-proxy` tidak aman untuk
dekripsi **konkuren** di lingkungan test, jadi asersi yang butuh dekripsi
dijalankan berurutan (kode produksi tetap `Promise.all`).

## 🧹 WS-G(7) dedup helper E2E (2026-10-12)

`web/e2e/helpers/registration.ts` jadi satu-satunya sumber helper onboarding.
Sebelumnya `registerUser` disalin di **6 spec** dan salinannya sudah menyimpang:
`settings.spec` butuh langkah skip biometric lebih dulu, varian itu kini
eksplisit sebagai `registerUserViaBiometric`. Ikut dipindah: probe WebTransport
(dulu `supportsWebTransport` di `regression.spec` **dan** `webTransportSupported`
di `transport.spec`, plus satu evaluasi inline di `chat.spec`), lalu blok
"cari peer → buka chat → kirim → peer menerima" yang disalin di `chat.spec` dan
`transport.spec` (×2) menjadi `openDirectChatWith` / `sendChatMessage` /
`expectPeerReceivesMessage`.

Semantik tiap spec dipertahankan secara sengaja: `supportsWebTransport` default
mengevaluasi tanpa navigasi (perilaku lama `chat`/`transport`), `regression.spec`
memakai `{ navigateToAppOrigin: true }` (cek harus setelah mendarat di origin app
karena di about:blank `isSecureContext` bisa `false`); asersi kemunculan bubble
dan pengukuran latency tetap di spec agar toleransi timeout tidak bergeser.

Verifikasi: web `tsc` 0, `vitest` **385/385** (50 file), `playwright test --list`
22 test / 7 file. **Tidak dijalankan:** suite E2E-nya sendiri — Postgres lokal di
mesin ini tidak punya role `nyx_user`/db `nyx_app` sehingga `e2e/global.setup.ts`
gagal di langkah reset sebelum spec berjalan (kondisi lingkungan, bukan
perubahan ini); Redis dev sudah dihidupkan untuk percobaan tersebut.

## 🛡️ WS-E(1) coturn + WS-I username links + WS-H guard registrasi (2026-10-12)

Tindak lanjut audit kode terhadap `docs/30` (item yang belum).

**WS-E(1) — coturn self-host jadi primer.** `GET /api/keys/turn` sekarang
menerbitkan kredensial TURN **time-limited** (HMAC-SHA1, konvensi coturn
`use-auth-secret`) dari `TURN_URLS` + `TURN_STATIC_AUTH_SECRET` (TTL default
600 s). Username memakai `identityTag(userId)` — **bukan** userId — sehingga log
coturn tidak memetakan sesi call ke akun (`docs/28`). Cloudflare TURN turun jadi
cadangan; STUN pihak ketiga tetap tidak dipakai. Logika murni di
`server/src/utils/turnCredentials.ts` + `tests/turnCredentials.test.ts` (7 test,
klok disuntik).

**WS-I — link pendek `/u/<hashId>`.** Route baru (di dalam `ProtectedRoute`)
`/u/:hashId` meneruskan hashId ke alur `/connect` yang sudah ada (pencocokan
persis via `/api/users/search`, tanpa enumerasi). Validasi bentuk sama dengan
server (`43` base64url | `64` hex) di `web/src/utils/usernameLink.ts` +
`usernameLink.test.ts` (5 test).

**WS-H — guard burst registrasi tanpa PII (sebagian).**
`server/src/utils/registrationGuard.ts`: kuota per **sumber** (IP di-HMAC dengan
pepper — IP mentah tidak pernah disimpan) dan per **instalasi**
(`deviceInstallationTag`), counter Redis `INCR`+`EXPIRE` atomik, fail-open saat
Redis error. Wiring di `auth.ts` register lewat env
`ABUSE_REGISTRATION_GUARD=on` (default off = no-op, rollback tanpa deploy
logika). 5 test (`registrationGuard.test.ts`). **Belum:** kuota per-hash-ASN
(repo tidak punya sumber data ASN), WebAuthn attestation akun baru, drill
false-positive NAT.

**WS-G(4) sebagian — test perilaku endpoint.** Dua jalur dipindah ke util yang
diuji dengan klien Prisma palsu:
- `server/src/utils/sessionRevocation.ts` (+ `sessionRevocation.test.ts`, 3 test):
  `DELETE /api/sessions/:jti` — jti milik user lain → 404 tanpa mutasi, revokasi
  seluruh family, blacklist hanya JTI belum kedaluwarsa.
- `server/src/utils/keyBundle.ts` (+ `keyBundle.test.ts`, 5 test): pemetaan
  perangkat → bundle yang dulu **disalin 3×** di `keys.ts` (Buffer/Uint8Array/
  string → base64url, `null` tetap `null`, bundle publik tanpa signed pre-key).

Verifikasi: server `tsc` 0 & `npm test` **283/283** (+20); web `tsc` 0 &
`vitest` **385/385** (50 file); `pnpm -r run build` selesai. **Belum dijalankan:**
E2E call chrome dengan coturn, dan drill produksi.

**Ditahan (butuh keputusan):** WS-F (seal kolom sorting lokal — `docs/30` §30.20
menyatakan ini bukan tambalan; menyegel kolom jalur-panas tanpa mengubah semua
pembaca akan merusak sorting/paginasi). WS-G(7) (dedup helper E2E) yang tadinya
ikut ditahan sudah dikerjakan di entri di atas.

## 📥 UI restore berkas `.nyxbak` manual (2026-10-12)

Menutup batasan fase 4: jalur berkas manual kini punya UI, tidak hanya
`migration:*` (`docs/31` §31.6c).

- `web/src/components/BackupRestoreModal.tsx` — pemilih berkas `.nyxbak` +
  prompt recovery phrase, dibuka dari tombol "Restore from .nyxbak File" di
  modul Data pada `SettingsPage`.
- Urutan defensif: `readBackupFile` memvalidasi header **sebelum** phrase
  disentuh (berkas asing/terpotong tidak memicu KDF 128 MB) →
  `openFramedBackupWithPhrase` (progres per frame) → hapus `deviceId` + bersihkan
  `identityKeys` (bootstrap identitas baru, konsisten dengan "Import Vault") →
  reload. Tombol non-aktif sampai berkas **dan** phrase terisi; phrase dinormalkan
  (`trim` + `lowercase`).
- i18n: `modals:backup_restore.*` (14 key) + `settings:data.restore_backup` di
  keempat bahasa (en/id/es/pt-BR).
- Test baru `src/components/__tests__/backupRestoreModal.test.tsx` (4 test):
  berkas asing ditolak tanpa memanggil restore, tombol non-aktif sampai lengkap,
  byte arsip & phrase dinormalkan diteruskan, phrase salah → error tanpa klaim
  sukses.

Verifikasi: web `tsc --noEmit` 0 & `vitest` **380 test** (49 file);
`pnpm --filter nyx-web run build` exit 0; `oxlint` file baru 0 error/0 warning.

## 📊 WS-C fase 5 — Benchmark backup 10k pesan (2026-10-12)

Klaim "format ber-frame muat untuk 10k pesan" sekarang menjadi **angka terukur**,
bukan asumsi (`docs/31` §31.6d, gate `docs/30` §30.7):

- `web/src/lib/backupBench.ts` — harness: fixture deterministik (LCG, tanpa
  `Math.random`) berisi 10 000 pesan + kunci pesan, `runBackupBenchmark` mengukur
  waktu + puncak heap/RSS export/import (sampling `process.memoryUsage()` tiap
  10 ms), verifikasi integritas per tabel (`countsEqual`, tidak peduli urutan
  frame karena `scramble` default), dan `formatBackupBenchmark` untuk laporan.
- Script `pnpm --filter nyx-web run bench:backup` menjalankan benchmark penuh;
  suite normal hanya menjalankan bench 200 pesan (cepat, tetap menguji
  integritas). Ambang gate longgar ada di `BACKUP_BENCH_BUDGET`.
- **Hasil (dev, Linux, Node 26, satu proses, `chunkBytes` 64 KB; rentang dua
  eksekusi, variasi ≈ ±10 %):** 10 000 pesan → **20 272 catatan**, arsip
  **4.62 MB / 79 frame**; **export 1.34–1.51 s** (puncak heap ~147 MB, RSS
  ~296 MB), **restore 0.62–0.77 s** (puncak heap ~147 MB, RSS ~312 MB);
  integritas `OK`.
- Batasan yang dicatat eksplisit: **I/O IndexedDB tidak diukur** (store in-memory
  → angka adalah batas bawah kripto + serialisasi); puncak memori hanya sampel
  10 ms; `restoreFramedBackup` masih menahan seluruh catatan di memori sebelum
  satu transaksi tulis.

Verifikasi: web `tsc --noEmit` 0 & `vitest` **376 test** (3 baru di
`backupBench.test.ts`); benchmark 10k lulus gate di mesin ini.

## 🔐 WS-C fase 4 — Restore `.nyxbak` di perangkat pengganti (2026-10-12)

Migrasi perangkat (`migration:*`) sekarang memindahkan **arsip backup ber-frame**
(`docs/31` §31.6c), bukan lagi JSON vault tunggal + AES-GCM:

- `web/src/lib/backupRestore.ts` — lem antara `backupFormat`/`backupPayload` dan
  Dexie: `createFramedBackup`, `restoreFramedBackup` (progres **per frame**),
  `openFramedBackupWithPhrase` (jalur berkas manual lewat recovery phrase),
  adapter `readTablesFromDexie`/`writeTablesToDexie` (satu transaksi `rw`,
  `clear()` → `bulkPut()`), `liveBackupStore()` (impor `./db` dinamis sehingga
  modul aman diuji tanpa IndexedDB), dan `formatBackupSize`.
- `backupPayload.ts`: `readBackupChunk(frame, codec)` diekstrak dari
  `readBackupChunks` (satu implementasi validasi) agar restore bisa melaporkan
  progres per frame tanpa menduplikasi parser.
- `MigrationSendPage` membangun arsip pada tahap prefetch (kunci acak 32 byte
  diseal ke kunci publik penerima via QR); `MigrationReceivePage` merakit ulang
  chunk, membuka seal, dan memulihkan per frame dengan progres 0–100 %.
- **Perbaikan nyata:** chunk migrasi kini dikirim sebagai **base64**, bukan
  `ArrayBuffer`. Transport men-serialize payload dengan `JSON.stringify`, jadi
  `ArrayBuffer` yang dikirim apa adanya menjadi `{}` dan chunk penerima (yang
  mengharapkan base64) tidak akan pernah cocok.

Verifikasi: web `tsc --noEmit` 0 & `vitest` **373/373** (10 test baru
`backupRestore.test.ts`, kripto sungguhan + Dexie palsu); `pnpm -r run build`
selesai (shared/server/web/marketing + postbuild). **Belum dijalankan di sini:**
E2E WebTransport (butuh Postgres + Redis + sidecar + Chrome full build).

## 🧹 Purge Legacy (data lama v1 + toleransi at-rest) (2026-10-10)

DB sudah direset (2026-09) dan tidak ada klien/data v1 tersisa, jadi seluruh
jalur kompatibilitas-pra-perubahan dihapus — bukan sekadar dibiarkan.

**Server — toleransi at-rest dihapus.** `credentialTokenMatches` hanya menerima
nilai tersimpan ber-hash (cabang plaintext dibuang); `sealedLookupCandidates`
(tenant API key) & `routingCandidates`/`resolveRoutingUser` (routing identity,
Story/Block tag) mengembalikan/menerima bentuk ter-seal saja; `resolveRepliedToId`
tidak lagi meloloskan plaintext; admin capability `adminSecretHash` NULL = **fail
closed** (bukan bypass grup pra-26.9); kursor pesan `parseMessageCursor` menolak
ISO date (hanya `seq`); mapper tak lagi memetakan `seq 0` sebagai legacy. Schema
`Story.authorTag` + `BlockedUser.blockerTag/blockedTag` jadi **NOT NULL**.

**Satu pembalikan yang disengaja:** `identifierLookupCandidates` tetap
`[ter-pepper, nilai kiriman]` karena kandidat kedua bukan toleransi baris lama —
ia melayani **echo klien** (server mengembalikan `usernameHash` ter-pepper, link
berbagi profil `connect?u=` mengirimnya balik ke pencarian). Meniadakannya
mematikan pencarian hash-ID → dikembalikan + diuji.

**Web — grup v1 (protokol) dihapus.** `encryptGroupMetadata` tidak lagi menulis
metadata v1 (rantai) dan `decryptGroupMetadata` tidak lagi membacanya; envelope
distribusi sender key hanya v2 (pack v1 36-byte & v0 32-byte ditolak); wrapper
pesan memakai `chainId` eksplisit (fallback prefix CK dihapus) dan SELALU
pseudonym (fallback `?? userId` dihapus); `groupEra`/`keychainDb` hanya merutekan
via `chainId` (alias keyId dihapus); `amIGroupAdmin` fail-closed tanpa roster v3;
auto-heal grup tidak lagi jatuh ke userId pengirim.

Verifikasi: server `tsc --noEmit` 0 & `npm test` **215/215**; web `tsc -b` 0 &
`vitest` **289/289**. **Belum dijalankan di sini:** E2E WebTransport/kripto
(butuh Postgres + Redis + sidecar).

## 🔒 Tier 4 — Identitas Pengirim & Field At-Rest (2026-10-09)

Tindak lanjut audit dump: **semua kebocoran identitas yang tersisa ditutup**,
termasuk fallback pseudonym dan field yang tersimpan di dalam blob metadata.

**1. `Message.senderId` tidak lagi bisa memuat userId asli.** Fallback
`senderPseudonym ?? userId` dihapus; kini pseudonym klien dipakai apa adanya dan
selain itu userId disimpan **TER-SEAL** (AEAD deterministik, `utils/senderIdentity.ts`).
Enam jalur baca (otorisasi unsend, view-once, receipt tunggal & batch,
`message:deleted`, mapper) membuka nilai itu sebelum membandingkan/mengirim — jadi
perilaku klien tidak berubah, tetapi dump tidak lagi menampilkan pengirim.
Nilai kiriman klien berbentuk UUID (klien lama) ditolak dan diganti identitas
pengirim yang terautentikasi.

**2. Wrapper metadata v2 tidak lagi membawa `senderId`.** Reader v2 merutekan
lewat `chainId` + `senderDeviceKey` dan memverifikasi tanda tangan hanya atas
byte `ct`, jadi field itu murni kebocoran. Klien berhenti menulisnya dan server
menyaringnya (`utils/groupMetadataBlob.ts`) di `POST /api/conversations`,
`PUT /:id/details`, dan `metadata:updated` — blob v1 legacy dibiarkan utuh.

**3. Device id di pesan SYSTEM disegel.** 19 baris `GROUP_KEY` menyimpan
`targetDeviceKey` = `Device.id` apa adanya (temuan analis eksternal); kini
disegel at-rest dan dibuka saat relay/catch-up. `senderDeviceKey`/`senderSigningKey`
tetap plaintext karena keduanya kunci publik yang memang dibagikan ke anggota grup.

**4. `Message.sessionId` disegel**, dan **`Conversation.createdAt` dipotong 15 menit**
(paritas B3) di kedua jalur pembuatan (REST + engine).

**5. Redis bersih dari userId.** Lima keluarga key yang masih menyematkan
identitas asli (`rl:story-view`, `rl:contact-bundle`, `rl:powverify`, `otpkq`,
`sandbox:newchat`) kini memakai `identityTag()` (HMAC pepper, deterministik →
counter tetap idempoten).

**6. Klien selalu mengirim pseudonym.** `ensureMyPseudonym()` menghidrasi peta
pseudonym dari metadata v2/v3 saat store belum memilikinya (penyebab utama
fallback userId sebelumnya) dan `resolveSenderIdentityForGroup()` memastikan grup
v2/v3 tidak pernah jatuh ke userId.

Verifikasi: server `tsc` 0 & `npm test` **215/215** (+20 `senderIdentity`), web
`tsc -b` 0, `vitest` **291/291** (+5), `vite build` 0, dan **live check di DB
nyata**: baris ditulis lewat helper produksi → `pg_dump --data-only` → 7/7
pemeriksaan pada byte tersimpan LULUS (termasuk positif-kontrol) → baris temp
dihapus (DB kembali 39 pesan/3 percakapan/3 device).

## 🔍 Audit DB & Dump Nyata (2026-10-09)

Audit relasi/graph + kondisi zero-knowledge pada DB pengembangan nyata (`psql`)
dan pada `pg_dump` yang di-restore ke schema scratch.

**Bug guardrail dump simulator (diperbaiki).** `parseCopySections` memakai pola
terminator `\n\.`, sehingga untuk tabel KOSONG (dump `FROM stdin;` langsung diikuti
`\.`) body-nya menelan blok tabel berikutnya: di dump nyata **seluruh tabel
`Message` (39 baris) tidak pernah diaudit** dan laporan tetap hijau. Selain itu
target reply-edge memakai nama field Prisma (`repliedToId`) alih-alih nama kolom DB
(`replied_to_id`), jadi pemeriksaannya vakum. Ketiga hal diperbaiki: terminator
di-anchor ke awal baris, target memakai nama kolom DB, dan ditambah guard
anti-vakum (`hasColumn` → kolom tidak ada = GAGAL, bukan lulus). Dengan rahasia
nyata, audit dump kini GAGAL (exit 1) dan menunjuk tepat `Message.senderId`
(6 identitas bocor); `Message.deleteSecret` ikut teraudit (0 → 18 nilai).
Test `dumpAudit` 9 → 12 (3 regresi baru: tabel kosong, kebocoran setelah tabel
kosong, dan kolom hilang).

**Temuan yang belum diperbaiki (dicatat di docs/28):** `Message.senderId` memuat
userId asli pada 6/30 pesan grup (jalur fallback `senderPseudonym ?? userId`),
dan `Conversation.encryptedMetadata` memuat `senderId` = userId asli pembuat grup.
Empat keluarga key Redis juga masih menyematkan userId asli (rate-limit story view,
contact bundle, powverify, kuota OTPK, sandbox newchat).

Verifikasi: server `tsc --noEmit` 0, server `npm test` **195/195**.

## 🐞 Perbaikan Bug Runtime dari E2E Manual (2026-10-09)

Audit log E2E manual (perpesanan 1:1 & grup berhasil didekripsi di kedua sisi)
menemukan empat bug nyata; semuanya diperbaiki di akar masalahnya, bukan
gejalanya.

**1. Sertifikat sidecar lokal tidak pernah dirotasi → WebTransport selalu gagal.**
Sidecar memakai ulang `transport_cert.der` yang tersimpan tanpa memeriksa masa
berlaku, padahal WebTransport mensyaratkan sertifikat masih valid (dan rentangnya
≤ 14 hari). Setelah 10 hari, SETIAP koneksi ditolak Chrome
(`QUIC_TLS_CERTIFICATE_UNKNOWN` / `Code::crypto`) dan klien diam-diam jatuh ke
fallback WebSocket. Kini `main.rs` mem-parse DER (`x509-parser`) dan merotasi bila
sudah kedaluwarsa, belum berlaku, rentangnya > 14 hari, atau sisa masa berlaku
< 1 hari — lalu mencetak hash baru beserta reminder `web/.env`. Ditambah 6 unit
test (`cargo test`) untuk tiap cabang rotasi. `web/.env`
(`VITE_TRANSPORT_CERT_HASH`) diperbarui ke hash sertifikat baru, dan fallback WT→WSS
di DEV kini memberi petunjuk penyebabnya.

**2. `UserHiddenConversation` kehilangan baris keanggotaan (P2003).** Relasi FK
`UserHiddenConversation.user` tertinggal padahal kolomnya sudah menyimpan nilai
**ter-seal** (docs/28 D2) → setiap `create` keanggotaan gagal
`ForeignKeyConstraintViolation` dan hanya muncul sebagai `console.warn`. Relasi FK
dihapus dari `schema.prisma`; pembersihan saat akun dihapus / dead man's switch
pindah ke `purgeSealedUserRows` (kini juga menghapus baris keanggotaan). Guard baru:
`schemaPrivacy` (D2) melarang FK pada kolom ter-seal, `routingIdentity` menguji
purge. **Perlu `prisma db push` sekali** di DB yang masih memakai schema lama.

**3. Cache pre-key tidak pernah di-invalidate.** Di `routes/keys.ts` variabel
`identityKey` hasil destructuring `req.body` **menutupi** helper `identityKey()`
dari `utils/redisIdentity` → `identityKey('cache:keys:…', userId)` melempar
`TypeError` yang tertangkap `try/catch`, sehingga peer bisa menerima bundle
pre-key basi sampai TTL 1 jam (risiko handshake E2EE gagal). Variabel di-alias
`identityKeyB64`; guard di `redisIdentity.test.ts` mencegah terulang.

**4. Kontak baru tidak muncul sampai reload.** Contact store hanya di-seed di
`loadConversations`, jadi peer yang mengirim pesan pertama (percakapan baru ala
Opaque Mailbox, `participants` kosong) tidak masuk store — picker create grup /
story tampak kosong sampai aplikasi di-reload. Kini pipeline pesan memanggil
`noteDirectMessageContact` untuk setiap pesan 1:1 yang berhasil didekripsi, dan
`conversation:new` juga men-seed kontak dari roster bila ada.

Verifikasi: server `tsc` 0, `npm test` **192/192**; web `tsc -b` 0, `vitest`
**286/286**; `cargo test` sidecar **6/6**; probe Chrome ke sidecar membuktikan
handshake gagal saat pin basi/kedaluwarsa dan berhasil setelah rotasi. **Belum
dijalankan:** E2E Playwright otomatis (`transport.spec.ts`/`chat.spec.ts`) dan
`prisma db push` pada DB pengembang.

## 🔒 Penutupan Residual DB-Dump (Tier 1.5 + D14 + 3.2) (2026-10-08)

Menutup sisa item traceability audit `docs/28-db-dump-threat-model.md`: residual
Tier 1.5 (identitas yang masih plaintext), temuan **D14** (Redis + presence), dan
**Tier 3.2** (dump simulator sebagai pembuktian).

**Presence lazy/opt-in + Redis tanpa userId asli (D14, Tier 0.7/1.5).** Redis
persisten kini tidak lagi memuat userId asli: `utils/redisIdentity.ts` menyediakan
`identityTag` (HMAC → keanggotaan SET `online_users` & sufiks key `active_device:*`,
`is_migrating:*`, `cache:keys:*`, `rate_limit:*`) dan `sealIdentity` (seal
deterministik → member SET routing `burner:room:*`, `migration:room:*`,
`migration_owner:*`, nilai `linking_token:*`), dengan toleransi baris legacy
`[ter-seal, apa adanya]`. Di sisi produk, presence berhenti membroadcast roster
global: klien meminta `presence:subscribe` hanya untuk kontak yang sedang
ditampilkan, server memvalidasi lewat daftar peer yang **diturunkan sendiri** dari
`UserHiddenConversation` (`collectPresencePeers`), dan join/leave hanya dikirim ke
klien yang berlangganan (`utils/presenceSubscriptions.ts`, registry in-memory).
Event klien baru: `presence:subscribe` / `presence:sync`.

**Residual Tier 1.5 ter-seal.** `User.externalId` → `externalIdSealed`
(uniqueness tetap `[tenantId, externalIdSealed]`), `Device.name` → `nameSealed`,
`Device.installationId` → `installationTag` (HMAC), `PushSubscription.endpoint` →
`endpointSealed` (dibuka hanya saat mengirim push), dan `Conversation.metadata`
**dihapus** (write-only; dump tak bisa lagi memuat plaintext titipan tenant).
Semua baca/tulis lewat helper `atRestSecrets`/`sealAtRest`/`openAtRest`.

**Tier 3.2 — dump simulator.** `utils/dumpAudit.ts` (logika murni, tanpa DB)
mem-parsing section `COPY` dari `pg_dump` plain dan memeriksa 11 kolom identitas +
2 rahasia otoritas + artefak Redis. Pembungkus: `scripts/privacy-dump-audit.ts`
(mode live seed→`pg_dump`→audit→cleanup, dan mode offline `--dump <file>`).
`npm run privacy:dump-audit` menjalankan jalur live.

**`seq` dipersist ke ShadowVault.** `DecryptedMessageRecord.seq` ditulis & dibaca
kembali, sehingga kursor paginasi server (`oldestMessage.seq`) tetap presisi
setelah reload — tidak lagi jatuh ke jalur ISO-date legacy yang bisa mengulang
sebagian halaman.

**Guard test baru/diperbarui:** `schemaPrivacy.test.ts` (7 — termasuk D4/D9/D10 &
D11 residual), `redisIdentity.test.ts` (7), `presencePeers.test.ts` (6, wiring
presence lazy), `dumpAudit.test.ts` (9 — kontrol negatif: dump bocor GAGAL),
`vaultSeqPersistence.test.ts` (4). Referensi desain (Signal) didokumentasikan di
docs/28 §28.10.

Verifikasi: server `tsc` 0, `npm test` **191/191**; web `tsc -b` 0, `vitest`
**282/282**, `pnpm build` 0. **Belum dijalankan:** E2E Playwright & jalur live
dump simulator (butuh Postgres ter-seed + `prisma db push`, yang tidak dijalankan
atas permintaan maintainer).

## ⏱️ Urutan & Metadata Temporal — Tier 2 B1–B5 (2026-10-08)

**B1 — urutan pesan berbasis sequence.** Urutan pesan (dan kursor keyset
pagination) tidak lagi bergantung pada jam dinding `Message.createdAt`.
`Conversation.messageSeq` di-increment atomik (Prisma `increment` dalam satu
transaksi; util `utils/messageSequence.ts`) dan `Message.seq` menyimpan hasilnya.
Dipakai di 4 titik create (REST, WT `chat_message`, SYSTEM fulfilled_key &
metadata_updated). Paginasi menerima kursor `seq` **atau** ISO date legacy
(`parseMessageCursor`), urutan utama `seq` dengan `createdAt` sebagai tie-break
baris lama, dan mapper mengirim `seq` hanya bila >0. Klien ikut mengurutkan via
`seq` (fallback `createdAt`). Efeknya: `Message.createdAt` boleh dikasar (B3)
tanpa merusak urutan. Test `tests/messageSequence.test.ts`.

**B4 — bucket metadata aktivitas.** `User.lastActiveAt` → `lastActiveDay`
(bucket **hari**, UTC); ditulis saat user dibuat dan di `issueTokens` (updateMany
no-op bila hari sama) — sekaligus memperbaiki bug dead man's switch yang dulu
memakai nilai basi sejak registrasi. `Device.lastActiveAt` di-bucket **15 menit**
(`deviceActivityBucket`) di semua jalur write, dengan tie-break deterministik
`[{lastActiveAt desc},{createdAt desc}]` di semua pembaca. Util baru:
`utils/temporalBucket.ts`. Test `tests/temporalBucket.test.ts`.

**B2 — waktu presisi pindah ke ciphertext.** Klien menyuntik `sentAt`
(`Date.now()`) ke objek JSON yang dienkripsi; saat dekripsi `captureSentAt()`
menyalin ke `Message.sentAt` lalu **menghapus field** (wajib, karena logika
"collapse" memakai `Object.keys(parsed).length === 1`). Tampilan (bubble,
jendela edit 5 menit, daftar chat, pencarian) memakai `sentAt` dengan fallback
`createdAt`; `sentAt` dipersist lokal (shadowVault). Server tak pernah melihat
waktu presisi.

**B3 — createdAt & metadata receipt kasar.** `Message.createdAt` dipotong ke 15
menit di semua jalur create, `expiresAt` diturunkan dari waktu kasar yang sama
(kalau tidak, `expiresAt − TTL` membocorkan createdAt), dan
`Conversation.lastMessageAt` ikut waktu kasar yang sama. `MessageStatus.updatedAt`
juga dikasar: `@updatedAt` dihapus (Prisma akan menimpanya) dan nilainya ditulis
eksplisit di kedua jalur receipt. Vault lokal memakai `sentAt` presisi sebagai
indeks.

**B5 — id non-time-ordered (tuntas).** Semua model ber-default PK kini
`@default(uuid())` (User, Conversation, Device, Tenant, MessageStatus, SessionKey,
RefreshToken, PushSubscription, OneTimePreKey, UserHiddenConversation,
BlockedUser) — tak ada `cuid()` time-ordered tersisa; id lama tetap valid (opaque
bagi klien). Id SYSTEM metadata tak lagi memakai `Date.now()`; validator
`keys.ts` (dulu `.cuid()`) menerima id lama maupun baru.

**Tier 2 residual (2.2/2.3/2.4).** `Message.repliedToId` kini **ter-seal**
(`sealAtRest`) — dump DB tak memuat edge balasan; server membukanya saat read
(`resolveRepliedToId`) dan mapper sengaja mengosongkan kolomnya agar nilai
ter-seal tak bocor ke klien. `OneTimePreKey.createdAt` **dihapus** (baris OTPK
sudah dihapus atomik saat dipakai; urutan pakai `keyId`). `Authenticator.counter`
**sengaja dipertahankan** — dibutuhkan deteksi kloning WebAuthn (keputusan sadar).

Verifikasi: server `tsc` 0, `npm test` **173/173**; web `tsc -b` 0, `vitest`
**278/278**, `pnpm build` 0. **Backfill `seq`** untuk baris lama (SQL di docs/28
§28.9) dan `prisma db push` belum dijalankan — B2/B3 **butuh verifikasi E2E** di
lingkungan nyata (jalur dekripsi & tampilan).

**Tinjauan efek domino (lanjutan).** Menutup tiga regresi yang muncul dari
B1–B3 di klien:
- **Pesan pending (optimistik/antrean offline) tanpa `seq`** dulu ikut `seq = 0`
  sehingga setiap sort ulang (pesan masuk/sync) melempar bubble "SENDING" ke
  ATAS riwayat — kini pending selalu dianggap **paling baru**
  (`utils/messageOrder.ts`, dipakai 3 jalur sort; test `messageOrder.test.ts`).
- **Waktu kirim pesan sendiri** jatuh ke `createdAt` server yang kasar (tampil
  membulat 15 menit) karena balikan server tak memuat `sentAt` — bubble
  optimistik kini menyimpan `sentAt`, nilai itu dipakai untuk plaintext
  ciphertext, dan dipertahankan saat ACK (2 jalur) mengganti bubble.
- **Urutan daftar chat** berpotensi flip saat `lastMessageAt` seri dalam satu
  bucket — server kini `orderBy [{lastMessageAt desc},{id desc}]`, klien
  mengurutkan dengan `sentAt` presisi + tie-break id.

Sisa yang **belum** ditutup (dicatat, bukan bug baru): `seq` tidak ikut
dipersist ke ShadowVault lokal, jadi setelah reload kursor paginasi jatuh ke
jalur ISO-date legacy (bisa memberi duplikat yang di-dedupe klien) — **ditutup
menyusul** di entri *Penutupan Residual DB-Dump (Tier 1.5 + D14 + 3.2)* di atas;
`expiresAt`/sweeper toleran ≤1 bucket (15 menit).

## 🖼️ Story & Block Ter-seal — Tier 1.3/1.4 / D8+D9 (2026-10-08)

**D8:** `Story.senderId` dulu FK asli → dump DB memberi "siapa membuat story
kapan" tanpa perlu membukanya. Kini penulis disimpan sebagai `authorTag`
(seal deterministik, kunci dari `NYX_AT_REST_PEPPER`); kolom & relasi `sender`
dihapus. Create/list lookup by tag, `GET /:id` membuka tag untuk cek blocklist,
delete memverifikasi kepemilikan lewat tag (baris legacy tetap bisa dihapus).

**D9:** `BlockedUser(blockerId, blockedId)` dulu graph permusuhan eksplisit →
kini `blockerTag`/`blockedTag` ter-seal dengan unique pair (idempoten) + index
per sisi; block/unblock, gating story, dan `GET /me/blocked` memakai pasangan
tag.

Kontrak klien **tidak berubah** (nol perubahan web): respons story dikirim lewat
mapper whitelist `toClientStory` yang menyertakan `senderId` asli hasil resolve
server, dan `/me/blocked` tetap mengembalikan `{id, ...}[]`. Penting: `authorTag`
**tidak pernah** dikirim ke klien — nilai ter-seal yang sama dipakai kolom lain
(UHC routing, block), jadi bocornya ke klien akan memungkinkan penyerang
dengan dump memetakan tag → user.

Karena FK cascade hilang, penghapusan akun (`users.ts`) dan dead man's switch
(`systemSweeper`) membersihkan Story & BlockedUser eksplisit lewat
`purgeSealedUserRows`. Kolom tag sengaja nullable supaya `prisma db push` tetap
jalan di tabel berisi (catatan + SQL pembersihan baris legacy ada di docs/28
§28.8). Test baru `tests/storyBlockPrivacy.test.ts` (9 test). Server 152/152.

## 🧪 Guardrail Privasi At-Rest — Tier 3.1 (2026-10-08)

`server/tests/schemaPrivacy.test.ts`: satu suite yang mengunci janji privasi
docs/28 di level schema + format penyimpanan + dokumentasi env, supaya
perbaikan Tier 0/1.x tidak bisa regresi diam-diam. Yang dijaga: kunci privat
issuer tidak kembali ke DB (D1), identitas asli tidak dipersist di
MessageStatus/UserHiddenConversation (D2), secret otoritas jadi hash/sealed
(D3/D4), tidak ada ipAddress/userAgent per sesi (D5), identifier ber-entropi
rendah ter-pepper (D6/D7), presence peer-scoped (D14).

Diverifikasi dengan **negative control**: menambahkan kolom `ipAddress` kembali
ke `RefreshToken` membuat suite ini GAGAL (exit 1); setelah dikembalikan, LULUS
(exit 0). Server 144/144.

## 🗂️ Routing Identity Ter-seal — Tier 1.2 / D2 (2026-10-08)

`UserHiddenConversation.userId` dulu menyimpan **userId asli** tiap anggota
(routing-only, tapi di dalam dump ia = daftar keanggotaan: siapa di grup mana).
Sekarang nilainya di-**seal** (AEAD deterministik, kunci dari
`NYX_AT_REST_PEPPER`): server tetap bisa membukanya untuk push/sweeper/broadcast
profil/presence, tapi dump DB saja tidak lagi membaca keanggotaan.

- util baru `utils/routingIdentity.ts`: `routingIdentity`, `routingCandidates`
  `[sealed, apa adanya]`, `resolveRoutingUser` (sealed & legacy), dan helper
  `upsertMembership` / `findMembership` / `deleteMembership`.
- keempat jalur penulisan keanggotaan kini lewat `upsertMembership` (sealing +
  single source of truth); revocation memakai `deleteMany` + kandidat supaya
  baris legacy ikut terhapus tanpa duplikat (`deliveryToken` unik).
- pembaca disesuaikan: `messageSweeper` (buka routing identity sebelum notifikasi),
  broadcast profil `users.ts`, `presencePeers`, kick/leave `conversations.ts`.
- baris lama (plaintext) tetap berfungsi lewat kandidat lookup dan ter-upgrade
  saat ditulis ulang. Test baru `tests/routingIdentity.test.ts` (7 test, termasuk
  fake in-memory untuk alur upsert/delete) + 2 kontrak lama diperbarui.

Server 139/139, tsc 0.

## 🎭 Blind Receipt 1:1 — Tier 1.1 / D2 (2026-10-08)

**Edge 1:1 di dump DB ditutup.** Sebelumnya, meski `Message.senderId` sudah
NULL (sealed sender), `MessageStatus.userId` tetap menyimpan **userId asli**
di jalur 1:1 & grup v1 — jadi dump DB masih merekonstruksi pasangan "A↔B"
plus siapa membaca apa, kapan. Sekarang kolom itu diisi **tag opaque turunan
server**: `HMAC(NYX_AT_REST_PEPPER, "receipt:<conversationId>:<userId>")`.

- deterministik per (percakapan, user) → `upsert` + guard "sudah pernah READ"
  tetap idempoten; berbeda antar percakapan → pembaca tidak bisa dikorelasikan
  lintas chat; tak bisa dibalik tanpa pepper (dump saja tidak bisa menyebut siapa).
- jalur grup v2 tidak berubah (tetap pseudonym klien — sudah bagian protokol),
  dan nilai pseudonym dari klien **tidak dipakai** di jalur 1:1 supaya klien
  tidak bisa memalsukan receipt atas nama user lain.
- "skip pesan sendiri" kini membandingkan identitas PENGIRIM (userId/pseudonym),
  bukan tag pembaca.
- klien: di 1:1 status tidak lagi bisa dicocokkan ke identitas (server tidak
  menyimpannya) → tick `MessageItem`, guard receipt, dan `unreadVisible`
  `ChatWindow` memperlakukan status di 1:1 sebagai milik satu-satunya peer;
  logika pseudonym grup tidak berubah.

Dua kontrak test lama yang mengunci perilaku "1:1 menyimpan userId" diperbarui
(perilaku memang berubah sesuai docs/28 D2) + guard regresi baru. Server
131/131, web 267/267, tsc keduanya 0.

## 👥 Presence Per-Kontak — Tier 0.7 (2026-10-08)

**D14: roster online global dihapus.** Dulu setiap klien yang connect menerima
`{ type: 'bulk', userIds }` berisi SELURUH `online_users`, dan join/leave
di-broadcast ke seluruh roster — artinya setiap pengguna NYX bisa memanen graph
presensi platform tanpa perlu dump. Sekarang:

- snapshot & broadcast hanya memuat **peer** (user yang berbagi conversation),
  diturunkan server dari `UserHiddenConversation` — TIDAK dari deklarasi klien,
  supaya tidak menukar satu kebocoran dengan kebocoran lain (daftar kontak).
- helper baru `utils/presencePeers.ts` (murni, teruji) + dipakai di
  `handlePresence` (active/away) dan `handleDisconnect`; disconnect dibungkus
  `try/catch` agar kegagalan DB tidak menggagalkan pembersihan koneksi.
- klien: setelah membuat grup, store conversation meminta refresh presence
  (`user:active`) supaya badge anggota baru langsung terisi. Batasan yang
  disadari: perubahan keanggotaan dari jalur lain baru terlihat pada refresh
  presence/connect berikutnya (bukan push real-time per anggota).

## 🧩 Privasi At-Rest — Tier 0.2 Blind Index Username (2026-10-08)

**D6: `User.usernameHash` kini ter-pepper.** Sebelumnya nilai Argon2id klien
disimpan apa adanya; salt-nya statis (`NYX_BLIND_IDX_V1`) dan parameternya ada
di bundel klien (publik) → dump DB + kamus username = deanonymisasi, dan satu
rainbow table berlaku global. Sekarang yang disimpan adalah
`HMAC(NYX_AT_REST_PEPPER, argonKlien)`: deterministik untuk lookup, tapi tidak
bisa dibalik dari dump tanpa pepper.

Tanpa perubahan protokol klien: register menyimpan nilai ter-index;
login / recovery-verify / cek-duplikat register / pencarian user memakai
kandidat `[ter-pepper, apa adanya]` sehingga baris legacy dan nilai yang
di-echo klien tetap bekerja. Nonce recovery di-key oleh index ter-pepper
(Redis ikut bersih) dengan fallback kandidat. `isExactHash` di pencarian user
kini menerima 43-char base64url maupun 64-hex, jadi link undangan yang memuat
nilai ter-index tetap bisa menemukan kontak. User B2B (`engine.ts`) ikut
ter-pepper. Test baru: `tests/usernameBlindIndex.test.ts` (properti privasi +
lokasi wiring).

## 🔐 Privasi At-Rest — Tier 0 "Rahasia & Identifier" (2026-10-08)

Lanjutan audit docs/28 (dump DB). Keputusan maintainer: Tier 0 penuh +
Tier 1.1/1.2, presence jadi per-kontak. Batch ini menutup temuan KRITIS D1 dan
semua TINGGI yang bisa dikerjakan **tanpa perubahan protokol klien**:

- **D1 KRITIS — private key issuer grup keluar dari DB.** Kolom
  `CredentialIssuerKey.privateKeyPkcs8` dihapus dari schema; key dibaca dari env
  `GROUP_ISSUER_KEY_PKCS8` (dev: file `server/.nyx-issuer-key` 0600, dibuat
otomatis & gitignored). DB hanya menyimpan `publicKeyJwk` + `keyVersion`;
mismatch env↔DB = fail fast, production tanpa env = fail-closed. Script baru
`issuer-key:generate` (buat key) & `issuer-key:export` (ekspor kolom legacy
SEBELUM db push — raw SQL). Sebelumnya: dump DB = bisa menandatangani credential
untuk grup mana pun.
- **D5 — IP & userAgent dihapus** dari `RefreshToken` (hash tanpa kunci atas
  IPv4 = enumerable dalam 2^32; UA = sidik jari perangkat). `GET /api/sessions`
  memakai `Device.name` + flag `isCurrent`; UI manajer sesi ikut disesuaikan
  (dedupe per `deviceId`, label dari nama perangkat, bukan parse UA).
- **D7 — `Device.fingerprint` ter-index** (`HMAC(pepper, fingerprint)`) di
  register/login/recovery, `PUT /api/users/keys`, dan hardware-binding
  `redisBridge` (nilai tetap deterministik untuk membandingkan, tapi dump DB
  tidak memuat sidik jari mentah).
- **D4 — `Tenant.apiKey` disimpan sealed** (AEAD deterministik, nonce turunan
  plaintext) → lookup tetap; admin tetap bisa menampilkan/menyalin key (key asli
dikembalikan sekali saat create). Dump DB tidak lagi memberi akses API B2B.
- **D3 — `authSecret` grup & `deleteSecret` pesan di-hash** (SHA-256 hex, pola
  `adminSecretHash`) dengan perbandingan dual-mode, jadi dump DB tidak bisa
  dipakai untuk ikut bicara di grup atau unsend pesan orang lain; baris legacy
  plaintext tetap berfungsi.
- **Baru:** `server/src/utils/atRestSecrets.ts` (pepper env `NYX_AT_REST_PEPPER`,
  `pepperedIdentifier`, `hashCredentialToken`, `credentialTokenMatches`,
  `sealAtRest`/`openAtRest`) + `tests/atRestSecrets.test.ts` (9 test).
  `.env.example` root & server diperbarui.
- Sisa rencana ada di docs/28 §28.8: 0.2 (pepper blind index username — menyentuh
  kontrak identitas), 0.7 (presence per-kontak), 1.1 (blind receipt 1:1),
  1.2 (`UserHiddenConversation.userId` → routing ter-seal).

## 🔍 Audit: DB-Dump Threat Model (2026-10-08)

Dokumen baru `docs/28-db-dump-threat-model.md`: pemetaan 17 tabel + graph
relasi, lalu analisis "apa bahaya terburuk bila DB di-dump" per tabel
(temuan D1–D14 ber-severity, dengan bukti file:line). Temuan utama:
(1) **D1 KRITIS** — kunci privat `CredentialIssuerKey.privateKeyPkcs8`
disimpan plaintext di DB = akar kepercayaan keanggotaan grup ikut ter-dump;
(2) **D2 KRITIS** — penonimaan `Message.senderId` belum menghapus edge 1:1,
karena `MessageStatus.userId` dan `UserHiddenConversation.userId` masih diisi
userId asli; (3) **D3/D4** — `Conversation.authSecret`, `Message.deleteSecret`,
dan `Tenant.apiKey` plaintext (padahal `adminSecretHash` sudah pola benar);
(4) **D5/D6/D7 TINGGI** — hash **tanpa kunci** atas input rendah-entropi (IP
8-byte, `Device.fingerprint`), dan `usernameHash` Argon2id dengan salt statis
+ parameter publik (Signal menyimpan 32-byte hash + ZK proof, dicek di
`~/signal`); (5) **D14** — Redis `online_users` di-broadcast utuh ke setiap
klien (roster presensi global). Rencana bertingkat: Tier 0 (rahasia & operasi,
tanpa perubahan protokol klien), Tier 1 (linkability struktural), Tier 2
(metadata temporal), Tier 3 (guardrail test + dump simulator).
**Belum ada kode yang diubah** — menunggu keputusan maintainer di §28.6.

## 🛡️ Robustness Hardening — Server Realtime (2026-10-06)

**Guard handler socket WSS (anti crash proses):** semua handler async
gateway socket.io (`message:send`, ACK, presence, 27 event KEY_SYNC) kini
di-bungkus `guardedOn` — rejection yang lepas dari handler (error Redis/DB
di checkRateLimit / isActiveDeviceAllowed / handle*) dulu menjadi
unhandledRejection → node ≥15 membunuh PROSES untuk satu klien yang
mem-trigger error infra. Kini: error di-log, callback (bila ada) menerima
INTERNAL_ERROR, koneksi bermasalah diputus — proses & user lain tetap hidup.
Jalur WT sudah ter-cover try/catch pSubscribe sejak awal; test parity
kini juga mem-assert guard (regresi guard = crash proses).

**checkRateLimit fail-open + Lua terpusat:** pola Lua atomic INCR+EXPIRE
pindah ke `utils/redisResilience.ts` (satu sumber kebenaran); saat Redis
down, rate limit socket kini FAIL-OPEN (trafik realtime jalan tanpa limit
socket; limit HTTP di app.ts berdiri sendiri) — dulu eval melempar →
rejection lepas → skenario crash di atas, plus seluruh realtime mati.
Balasan NaN/negatif dianggap tak terukur (fail-open juga).

**Invalidasi cache active-device lintas-proses:** cache lokal 60s di
`isActiveDeviceAllowed` tidak tahu kalau `active_device:<userId>` baru saja
di-overwrite login di perangkat lain → device BARU yang sah diblokir ≤60s.
Login (issueTokens + refresh) kini mengirim sinyal invalidasi via channel
pub/sub khusus `nyx:device-cache-invalidate` (publish best-effort dari
`redisResilience.ts`) saat deviceId BERUBAH; logout/logout-all juga.
Subscriber di `initializeRedisBridge` menghapus cache lokal di SEMUA
instance — tanpa efek samping presence (sengaja bukan opcode 99, yang akan
memicu broadcast `leave` palsu ke kontak).

## 🛡️ Robustness Hardening — Web Layer (2026-10-06)

**API timeout:** semua request REST via `api()` kini punya timeout default
30s (AbortController manual — kompatibel semua browser; `timeoutMs` bisa
di-override per-call, `0` menonaktifkan) dan mencakup fetch + pembacaan body.
Timeout melempar `ApiError(0, "Request timeout…")` agar konsisten dengan jalur
error jaringan; abort dari pemanggil diteruskan apa adanya. Upload
(`apiUpload`) dapat `xhr.timeout` 120s, fetch CSRF 10s. Sebelumnya request
yang menggantung (server tak merespons / jaringan setengah mati) menunggu
selamanya — UI nyangkut tanpa pesan error.

**Guard re-entrancy `processOfflineQueue`:** dua pemanggil yang overlap
(reconnect cepat, caller baru) sebelumnya bisa memproses item queue yang SAMA
→ pesan terkirim dobel. Kini hanya satu loop drain pada satu waktu; pemanggil
kedua menandai rerun, dan item yang masuk selama drain diproses segera
setelah loop selesai.

**silentRefresh probe-first + mutex lintas-tab 3 tier:** `silentRefresh()`
kini SELALU probe `GET /api/users/me` dulu (dulu hanya di cabang Web Locks),
dan doRefresh RE-PROBE sekali lagi DI DALAM lock tepat sebelum POST —
menunggu mutex bisa makan waktu; tab lain mungkin sudah menyelesaikan refresh
selama kita antre. `runExclusive` kini punya tiga tier: **(1) Web Locks API**
(exclusion sejati), **(2) mutex via Service Worker** — registry tunggal
per-origin di `sw.ts` (`swMutexCore.ts` logika murni sync + heartbeat 1s +
sweep stale 4s → tab crash otomatis kehilangan lock; klien
`swMutexClient.ts` pakai MessageChannel dengan request-id anti-clobber),
dipakai bila SW mengendalikan halaman tapi `navigator.locks` tidak ada
(browser lawas 2021–2022); **(3) localStorage mutex** — best-effort (tanpa
test-and-set atomik), hanya dijalankan bila dua tier di atas tak tersedia.
Grace 5s server (`FRESH_ROTATION_GRACE_MS`) tetap menutup kasus
near-simultaneous yang tersisa.

**Socket cleanup:** poll chain offline sync dari koneksi lama dimatikan saat
disconnect (generation guard `syncPollGeneration` — dulu bisa bertabrakan
dengan chain koneksi baru); loop failure-retry 5s kini berbatas 3× per siklus
koneksi (`MAX_SYNC_FAILURE_RETRIES`, dulu TANPA batas saat server unreachable
dengan conversations termuat — spam request + console selamanya, berlawanan
dengan komentarnya sendiri). `burner:receive` tanpa roomId hanya fallback ke
sesi pertama bila tepat satu sesi aktif — bila 0 atau >1, routing ambigu
(pesan bisa masuk ke room yang salah) → di-drop dengan warning.
`setCookie` non-secure dihapus dari `tokenStorage` (dead code; kontrak
HttpOnly yang dihapus server-side didokumentasikan).

## 👥 Contact Store + Story Hardening (2026-10-05)

**Fix — daftar kontak modal create grup basi sampai reload:** daftar hanya
di-load sekali saat mount komponen (modal lazy render-on-demand → mount =
open pertama), sementara seeding/restore contact store jalan fire-and-forget
di `loadConversations` — burst yang selesai SETELAH mount tak pernah masuk
daftar. Sekarang contact store punya `subscribeToContacts()` (notifikasi
debounced per-burst 50ms dari upsert/delete/wipe/restore) dan modal create
grup berlangganan + reload — daftar terisi live tanpa reload aplikasi.

**Fitur — distributed profile key di roster metadata v3 (anggota pasif
terlihat):** kunci profil anggota sebelumnya hanya terdistribusi lewat payload
PESAN dari anggota itu sendiri → anggota pasif (belum pernah kirim pesan) tak
pernah menyebarkan kuncinya dan tetap "Anonymous" bagi anggota lain. Dua kanal
baru (server tetap opaque — metadata terenkripsi+ditandatangani, silent message
biasa; tidak ada perubahan server):
1. **Kanal utama (roster):** `GroupMemberEntry.profileKey?` — penulis metadata
   (creator/admin, pola Signal sender-keys) menyuntikkan kunci MILIKNYA ke
   entri roster-nya di `encryptGroupMetadata`; pembaca menyimpan kunci peer
   (first-wins, kunci yang sudah dikenal tidak ditimpa) via
   `applyGroupProfileKeys` di semua jalur masuk metadata. `parseGroupMembers`
   mem-whitelist field baru (field asing tetap dibuang).
2. **Fallback (silent PROFILE_SYNC):** anggota yang entri roster-nya belum
   membawa kunci (kunci lahir setelah metadata, atau client lawas) mengirim
   SATU silent `PROFILE_SYNC` (tanpa bubble/push, pola GHOST_SYNC) sekali per
   (device, conversation) — dipicu saat metadata terdekripsi tanpa kunci
   sendiri, dan saat GroupInfoPanel dibuka. Penerima menyimpan kunci keyed
   userId kanonik (bukan pseudonym wire).

**Fix — UI grup semua "Anonymous" (senyap, tanpa error console):** dua
patahan sekaligus di rantai profil.
1. **Mismatch cache key:** `decryptAndCache`/`getCacheOnly` menulis/membaca
   key komposit `${id}_${ep.slice(0,32)}` saja, sedangkan `useUserProfile`
   (participant panel grup tanpa `encryptedProfile`) dan `ContactRow`
   (kontak tanpa ep) membaca key polos `${id}` → profil yang sukses
   didekripsi TETAP tak terlihat oleh UI. Sekarang store **dual-write**
   komposit + alias plain-id (dan fallback baca alias), plus
   `hydrateProfileForPlainId()` (RAM → profileCache IDB → dekripsi) untuk
   UI tanpa ep. Fallback nama palsu tidak pernah masuk alias.
2. **Prefetch panel grup buntu:** efek prefetch `ParticipantList` hanya
   menjalankan `getCacheOnly` (tanpa ep → selalu null) lalu fetch remote dan
   mendekripsi — hasilnya tidak pernah sampai ke UI keyed polos, dan fetch
   diulang tiap mount. Rantai baru: RAM/IDB polos → dekripsi ep lokal →
   remote → dekripsi ep remote → tandai gagal sekali per sesi (tidak boros
   GET /api/users/:id).

**Fix — version bundle 31-bit (PUT /contact-bundle 400):** `computeBundleVersion`
sebelumnya memakai mask 63-bit (`0x7fffffffffffffff`) sehingga `version` bisa
melewati `Number.MAX_SAFE_INTEGER` — Zod 4 di server menolak PUT dengan
`"Too big: expected int to be <=9007199254740991"`. Sekarang version = hash
**31-bit** (jalur sodium maupun fallback FNV-1a dipotong identik) yang aman
untuk Zod safe-int DAN kolom Postgres `Int` (2^31-1); guard belt-&-suspenders
menormalkan nilai liar via hashFallback sebelum kirim, dan schema Zod server
cap eksplisit `max(0x7fffffff)` agar klien lama ditolak bersih (400), bukan
meledak sebagai error Prisma (500).

Sebelumnya "user yang pernah bertukar pesan" adalah derivasi runtime dari
`conversations.participants` (Opaque Mailbox) — hilang saat reinstall/device
baru/pesan TTL habis, dengan tiga rumusan derive Participant berbeda di UI.

**P1 — Contact store persisten + backup opaque:**
- `ContactRecord` + `getParticipantUserId` + `ContactBundle` v1 di `@nyx/shared`
  (serializer deterministik, parser fail-open).
- Tabel Dexie `contacts` (NyxUnifiedDB v8) — per-peer terenkripsi at-rest via
  `encryptVaultText` (kunci deterministik dari identity key → restoreable).
- `web/src/lib/contactStore.ts`: CRUD merge non-destruktif, seed dari
  conversations, heal participants kosong (device baru tidak menunggu pesan
  pertama lagi), push debounced 10s + version-hash guard, pull kondisional.
- Server: `User.encryptedContactBundle` (+version) — SATU blob opaque per
  user; `GET/PUT/DELETE /api/users/me/contact-bundle` (rate limit Lua 30/jam,
  cap 512KB). Server TIDAK bisa membaca isi. Schema push di-deploy otomatis
  (deploy.yml db push).

**P2 — Normalisasi identitas:** semua derive participant (story store,
CreateStoryModal, StoryTray) kini via `getParticipantUserId` (semantik `||`
legacy: userId kosong-string jatuh ke kandidat berikutnya).

**P3 — Story reliability & privacy:**
- Fan-out story MENGHORMATI BLOCKLIST (dulu user diblokir masih menerima
  STORY_KEY di mode ALL) + retry 1x per-target + toast jumlah kegagalan.
- Picker story membaca contact store + filter blocklist; StoryTray tidak lagi
  fetch story peer yang diblokir.
- Server `GET /stories/user/:userId` & `GET /stories/:id`: cek blocklist
  pengirim (403 STORY_BLOCKED) + rate limit per (requester,target) 120/jam
  (Lua atomik; redis down = fail-open).
- Sweeper harian menghapus story expired dari DB (dulu menumpuk selamanya).
- i18n key baru `story_keys_partial_fail` (en/id/es/pt-BR).

Verifikasi: tsc web+server exit 0; vitest web **215/215** (30 file, +20 test
contact store); node:test server 102/102. Primitives/protokol kripto tidak
berubah.

**P4 — Picker grup dari contact store + trust level (2026-10-05):**
- `web/src/lib/contactTrust.ts` (pure): `ContactTrustLevel` = verified
  (safety-number 1:1 cocok via verification store) > known (tercatat di
  contact store) > stranger; `computeContactTrust` (blocked selalu stranger,
  defensif) + `compareByTrustDescThenRecency` (trust desc → rekansi → id).
- `CreateGroupChat`: bagian "Kontak" dari contact store di atas search —
  sorted verified dulu, profil didekripsi via profileStore per baris (pola
  ContactItem), badge trust, collapsible, blocked disembunyikan. Search
  blind-index tetap untuk menemukan stranger.
- i18n: `contact_picker_title` / `contact_picker_all_selected` /
  `contact_trust_*` (en/id/es/pt-BR).
- +7 unit test pure (hierarki, blocked-defensif, determinisme komparator).
  Verifikasi: vitest web **222/222** (31 file); tsc web exit 0.

**P2 lanjutan — pembersihan total poke identitas lama (2026-10-05):** semua
pemakaian menyimpang `p.userId||p.id` / lookup `p.id` buta dinormalisasi via
`getParticipantUserId` di jalur KRITIKAL: relay targetRecipients & receipt
(message.ts), roster/pseudonym-map & fulfillKeyRequest & inisiasi DR 1:1
(crypto.ts), mesh call (webrtc.ts), user:updated propagation (kini resolve
pseudonym map — update profil kembali sampai di grup v2), typing indicator,
chat list header, peer page, verification set, StoryTray/StoryViewer (plus
fallback profile dari contact store), story fan-out. Yang sengaja dipertahankan:
jalur 1:1 (bentuk selalu id), groupPseudonyms legacy, fallback UI. Verifikasi:
vitest web 222/222; tsc web exit 0.

**Audit UI nama/avatar utk bentuk pseudonym (2026-10-05):** AKAR — di grup v2
`senderId` payload terenkripsi = pseudonym, dulu dipakai langsung untuk
`saveProfileKey(pseudonym)` + `decryptAndCache(pseudonym)` padahal profileKey
& profileCache keyed by REAL userId → nama/avatar pengirim grup v2 selalu
"Encrypted User"/Anonymous. Fix di `messagePipeline.ts`: helper
`resolveCanonicalProfileIdentity` (resolvePseudonymToUserId) — `sender.id` +
penyimpanan kunci profil + dekripsi profil kini pakai userId kanonik;
`senderId` WIRE tetap pseudonym (receipt server keyed pseudonym). Enrich
`enrichMessagesWithSenderProfile` kini set `sender.id = resolvedUserId`
(kanonik). Konsumen downstream (MessageItem/MessageBubble/DynamicIsland via
`useUserProfile(message.sender)`) otomatis membaik tanpa perubahan.
ChatWindow/ChatList peer lookup dinormalisasi (1:1). ParticipantList aman
(participants metadata = real userId). Verifikasi: vitest web 222/222; tsc
web exit 0.

## 🕵️ 2.7.0 - Group Privacy Blueprint (docs 26, tiers T1–T4)
## 🕵️ 2.7.0 - Group Privacy Blueprint (docs 26, tiers T1–T4)

Implements the full group-privacy blueprint: per-group sender pseudonyms,
pseudonym-scoped receipts, blinded membership via delivery tokens, sender-key
distribution over pairwise sessions, and opt-in application-level cover
traffic. With the prod DB reset (2026-09-27), legacy interop paths are GONE:
key distribution is pairwise-only, and membership/discovery is token-first
(`UserHiddenConversation.userId` nullable, token required — **requires a
schema push**, `prisma db push`, at deploy time).

### 🎭 T1 — Sender Pseudonyms (doc 26.2)
* **Unlinkable Group Senders:** Group messages in metadata-v2 groups store a
  random per-group pseudonym (22-char base64url) in `Message.senderId`
  instead of the authenticated userId; the `pseudonym → userId` map lives
  ONLY inside encrypted metadata (v2) with a generation counter that bumps on
  every key/membership rotation — pre/post-rotation messages cannot be
  stitched by the server. 1:1 conversations stay sealed-sender; legacy v1
  groups keep the old path.
* **Metadata v2:** `GroupMetadataV2` (`v, generation, pseudonymMap`) is the
  single choke point for pseudonym regeneration (`encryptGroupMetadata`):
  calls without an explicit map auto-regenerate at generation+1; key rotation
  and membership changes re-encrypt metadata with a fresh map (PCS rotation
  path is fire-and-forget to keep the hot path fast).
* **Server stores verbatim:** `handleChatMessage`, `messages:distribute_keys`,
  and `group:fulfilled_key` relay/store the client-supplied pseudonym.
  Group unsend is deleteSecret-only (a pseudonym never matches userId auth).
* **UI resolution:** message enrichment resolves pseudonyms to accounts via
  the local map; receipts, unread checks, and sender profiles work unchanged.

### 🎭 26.8.1 — ZKGroup-Style Anonymous Credentials (blind RSA, doc 26.8.1)
* **Blind RSA Credentials (RFC 9474):** the upgrade path reserved by the T3
  token slot is now executed — RSABSSA-SHA384-PSS-Randomized via
  `@cloudflare/blindrsa-ts` (WebCrypto in the client crypto worker,
  node:crypto/WebCrypto on the server). Members hold a blind-signed random
  message per group; the issuer never sees the unblinded form, and
  presentations are unlinkable to the issuance session.
* **Issuance & Presentation:** `POST /conversations/credential-issuance`
  signs blinded messages (quota per user/conversation/day);
  `credential-commit` registers the serial (SHA-384 of the prepared message —
  no identity link) for verification and revocation; sync accepts
  `X-Group-Credentials` presentations verified kryptografis against the
  stored issuer key. Issuer keys are versioned in DB for rotation; rotation
  invalidates credentials signed under old versions.
* **Revocation:** `POST /:id/credential-revoke` (X-Group-Token authed)
  deletes serials — credentials die without the server learning who held
  them. Residual (documented): issuance-time linkage (user requested a
  credential for a conversation) is accepted; presentations afterward are
  unlinkable. Delivery tokens remain the routing slot; credentials own
  verification.

### 🧾 T3a — Pseudonym-Scoped Receipts (doc 26.4)
* **Blind Read Receipts:** Group `MessageStatus.userId` now stores the
  reader's pseudonym (from `readerPseudonym` on `message:mark_read`,
  `message:mark_as_read`, `message:ack_delivered`, and the batch variants)
  instead of the raw account id; `message:status_updated` broadcasts carry
  the pseudonym. 1:1 receipts and the 1:1 TTL-grace path are untouched, and
  client-supplied pseudonyms are ignored outside groups.
* **Client-side own-read resolution:** all receipt senders attach
  `getMyPseudonym()`; is-mine and already-read checks resolve pseudonyms via
  the metadata map (own messages carry a pseudonym `senderId` in v2 groups).

### 🎟️ T3b — Delivery Tokens (doc 26.2 membership)
* **Token-First Membership (2026-09-27):** `UserHiddenConversation` is now
  keyed by a **required** unique `deliveryToken` (16-byte creator-issued); the
  `userId` column is nullable and **routing-only** (push, sweeper, profile
  broadcast) — never a discovery key. **Sync is token-possession only**:
  `GET /conversations/sync` matches the `X-Delivery-Tokens` header (cap 500)
  with NO userId join — closing 26.8.1 trigger condition #1 (token-only
  endpoints). The token map still lives in encrypted metadata v2
  (`deliveryTokenMap`), and every group message piggybacks
  `targetDeliveryTokens` so the server can register token-keyed rows for
  offline recipients (skip without a token).
* **Token-Keyed Rows at Every Invite Surface:** conversation creation,
  participant add, and both chat-relay paths (WebTransport + REST) register
  `(conversationId, token)` rows — only when the sender piggybacked a token.
  **Revocation:** kick/leave deletes the row — the token dies with membership.
* **Client:** `generateDeliveryToken(Map)`, `getMyDeliveryToken`,
  `collectMyDeliveryTokens`; sync sends owned tokens; token maps are
  inherited (never rotated) across pseudonym rotations.

### 🔀 T2 — Pairwise Key Delivery (doc 26.2)
* **Key Graph Removed:** Sender-key envelopes now travel inside the existing
  pairwise Double Ratchet session (`gspqr_<peer>`) as a silent `GROUP_KEY`
  control message — the server sees ordinary DR-encrypted messages, so the
  sender→target key-delivery graph is gone and stored envelopes gain
  transport FS (no more re-open with later-compromised static keys).
* **Inner Seal Preserved:** the per-device `pq_box_seal` envelope is kept
  inside (defense in depth: FS + PQ in transit).
* **Fallback removed (2026-09-27):** with the prod DB reset (no legacy clients
  to interop with), the deferred removal of `messages:distribute_keys` is
  executed — one key-delivery route remains. Server handler ACKs an
  explicit error; the parity test asserts the rejection.
* **CORRECTION (2026-09-27, E2E finding):** the pairwise SPQR transport was
  never complete — the server rejected the virtual `<group>:pw:<peer>` control
  conversation and the client had no receiver hook, so group keys silently
  NEVER arrived (recipients stuck in `waiting_for_key`). Key delivery now runs
  through the fully-wired `group:fulfilled_key` → `session:new_key` →
  `storeReceivedSessionKey` path (same inner `pq_box_seal` per-device envelope,
  request/fulfill auto-heal as safety net); dormant SPQR helpers deleted.
  Trade-off: the server still observes the key-delivery graph (routes by real
  userId) — graph-hiding transport moves to the 26.8 backlog with PQ-MLS.
  Related schema fixes found by the same E2E pass: `MessageStatus.userId` and
  `Message.senderId` are no longer FKs to `User` (T3a/T1 persist pseudonyms
  there), and `deliveryTokens`/`targetDeliveryTokens` zod schemas validate
  keys as userIds (Zod 4: first `z.record` arg = key schema) — group creation
  and relay 400'd before the fix. Client token maps standardized to
  `{userId → token}` (server contract orientation).
* **Signing key bound to receiver state (2026-09-28, libsignal pattern):**
  group message signature verification no longer re-resolves the sender via
  pseudonymMap → userId → prekey-bundle API. The sender's public signing key
  now travels with the key distribution (`group:fulfilled_key` payload +
  offline SYSTEM GROUP_KEY persistence) and is stored on the group receiver
  state (`GroupReceiverState.signingKey`, plaintext — public material).
  Verification reads `receiverState.signingKey` first (libsignal
  `SenderKeyState.sender_signing_key` pattern); bundle lookups remain as
  fallbacks for pre-existing states. Also fixed in the same pass: creator's
  cached `decryptedMetadata` now mirrors the full v2 object (v, generation,
  `pseudonymMap`, `deliveryTokenMap`) — previously only title/avatar/authSecret,
  so the creator  could never resolve incoming pseudonyms (its own cache guard
  prevented re-decryption, permanently hiding the map).
* **First key distribution no longer leaks userId (2026-09-28, DB
  audit):** during `createGroup`, the creator's GROUP_KEY envelope routed
  with the real userId — the pseudonym map existed only in memory while
  `ensureGroupSession` (invoked inside `encryptGroupMetadata`) reads the
  not-yet-populated conversation store. The creator's pseudonym is now
  injected explicitly through the call chain (`opts.pseudonym`); store
  lookup remains the fallback for later distributions.
* **Active rotation on membership changes (2026-09-28):** admin kick/add
  now runs full active rotation — metadata re-encrypted with a fresh
  pseudonym map (kicked member absent, generation+1) and the new sender
  key distributed immediately instead of lazily (the kicked member can no
  longer decrypt new-era messages at all, not just until their next
  send). Fixes included: the membership-change re-encrypt branch was
  never invoked (only periodic rotation was), key distribution ran under
  the old map identity before the new map was generated, and
  `group:participants_changed` had no client listener so non-admin
  members never learned of roster changes until reload (they now refresh
  metadata and mark rotation needed). Manual "Force rotate keys" in
  Group Info uses the same active-rotation path.

### 🔐 Sender-Key v2 — libsignal-model rewrite + stabilization (2026-10-05)

After 30+ incremental fixes on the group layer, the sender-key pipeline was
rewritten in place to follow libsignal `sender_keys.rs` exactly, then audited
gainst `sender_keys.rs` / `group_cipher.rs` and stabilized with a 3-browser
manual test (web vitest 176 / server node:test 102 green throughout).

* **Era identity & header v2:** every era mints a RANDOM 64-bit `chainId` (not
  derived from the chain key) plus a dedicated 256-bit `metadataKey`. Message
  wrappers are versioned `{v:2, chainId, header.n}` — the legacy `keyId =
  CK[0:8]` is gone from v2 wrappers; v1/v0 readers kept for prod data.
* **Metadata out of the chain:** metadata v2 =
  `{v:2, kind:'group_metadata', chainId, ct (XChaCha), signature, senderId,
  senderDeviceKey}` — encrypted with the era `metadataKey` carried inside the
  distribution envelope `[0x02][chainId(8)][u32 iter][CK(32)][metadataKey(32)]`
  (77 bytes, `pq_box_seal` per device). The position-twinning / sender-state
  restore hacks are impossible by construction.
* **One distribution path:** create/rotate/redistribute/fulfill/request-reply
  all funnel through `sendGroupSenderKeyDistribution` → `group:fulfilled_key`
  → `session:new_key` → `storeReceivedSessionKey`; duplicated seal loops
  deleted.
* **Receiver states ala `SenderKeyRecord`:** one per
  `(conversation, senderDeviceKey)` (device-keyed — stable across pseudonym
  rotations), states carry `chainId`/`eraCK`/`metadataKey`/`signingKey`,
  skipped message keys live inside the record, old eras are archived (max 5,
  `MAX_SENDER_KEY_STATES`); routing goes through the pure `pickChainState`
  helper — no cross-era guessing. Replay of a same-era distribution is a
  no-op (`isSameEraDistribution`); key request routing resolves the fulfiller
  by `targetDeviceKey` server-side so members without metadata can reach
  every sender.
* **Audit fixes (2026-10-05):** `listGroupReceiverStates` now returns
  `metadataKey` (metadata v2 failed with the state present — critical);
  skip-own GROUP_KEY compares the device identity key (cross-device group
  sync fixed); offline GROUP_KEY paths forward `senderSigningKey`;
  `PROTOCOL_RESET` no longer queries a nonexistent Dexie compound index; PCS
  metadata re-encryption supports roster v3 without downgrading it.
* **Distribution stability:** the signing-key fallback in group decryption
  fetched prekey bundles **per incoming message**, burning the OTPK fetch
  quota (30/pair/day, fail-closed 429) — one tripped pair disabled ALL bulk
  bundle fetches for that account, so key distributions came out empty and
  recipients sat in `waiting_for_key`. The fetch is now guarded by
  `!keyToUse` (zero API calls on the hot path).
* **Era hygiene on rotation:** `rotateGroupKey` replaces only the local
  sender state (receiver states, era archives and skipped keys survive —
  old-era messages stay readable); the self-receiver state carries
  `signingKey` (a writer can re-read its own metadata blob); rotation emits
  `metadata:updated` so members receive the new blob + roster in real time;
  roster changes no longer force-rotate the sender key (era churn).
* **Forward secrecy of pre-join eras (by design):** messages from eras a
  member never possessed stay undecryptable; the unknown-era key request runs
  once per chainId instead of looping request→timeout on every re-decrypt
  sweep. Stale persisted `METADATA_UPDATED` replays can no longer regress a
  newer, already-decrypted metadata blob in the store.

### 🔁 1:1 DR protocol — self-heal handshake + header slimming (2026-10-05)

Follow-up to the 1:1 audit against libsignal: two structural gaps closed,
decisions signed off by the maintainer (breaking changes allowed — all clients
must be ≥ 2.7.0).

* **x3dh-until-confirmed:** the initiator re-attaches the X3DH handshake to
  every outgoing message until the first incoming reply decrypts under the
  current session (`peerSessionConfirmed` client-side flag on the DR state).
  A lost/expired first message — the only carrier of the handshake — no longer
  wedges the conversation in permanent `waiting_for_ratchet_state`: the peer
  derives from any later message. Re-derivation is deterministic, so it
  re-syncs to the same chain safely. Salinan handshake disimpan di state
  (`pendingHandshake`) dan ditempel ulang tiap persist
  (`attachClientProtocolFields` — serializeState worker me-strip field luar).
* **Ratchet ack + omit-ct:** the sealed payload now carries `ackKem` (the
  sender's current `KEMr`), authenticated by the AEAD. Once the peer's ack
  matches the current chain, the sender **omits the 1120-byte KEM `ct`** from
  the DR header (~1.5 KB saved per message on the wire). Receivers that have
  not stepped still receive `ct`. A new chain whose header lacks `ct` is
  rejected **before any state mutation** (`Missing ratchet key material`) and
  enters the archived-session fallback — the previous partial-step path (which
  corrupted `KEMr`/`Nr` without new chain material) is gone.
* **DR session archive: 1 slot → 3-slot FIFO** (`#archived_0..2`, legacy
  `#archived` auto-migrated) — messages arriving 2+ DH-steps late survive even
  when the skipped-key LRU (200/conv) has evicted them; the decrypt fallback
  tries every archived slot in order.
* **Pure helpers + tests:** protocol decisions extracted to
  `web/src/lib/drProtocol.ts` (handshake inclusion, omit-ct rule, ack
  extraction, client-field re-attachment) with 14 vitest cases — total web
  suite 190. `dr_init_bob` now serializes an explicit empty `skippedKeys` map
  (shape symmetry with `dr_init_alice`).
* **Own-echo self-decrypt fixed (2026-10-05):** every outgoing 1:1 message
  logged `Self-decrypt failed with stored key` and fell through to the DR
  path (own-chain mismatch → `[Decrypt] Failed`; UI survived only via the
  Shield local copy). Root cause: DR/group ciphertexts carry **padded**
  plaintext (8KB + `0x80` marker + zero-fill) and the raw
  `secretbox_open_easy` call sites (messagePipeline self-decrypt + the
  MK-cache/skipped-key paths in `crypto.ts`) decoded the buffer directly —
  `sodium.to_string`'s fatal TextDecoder throws on the `0x80` byte. New pure
  helper `trimPaddedPlaintext` (mirror of the worker's `unpadBuffer`, 5 unit
  tests) trims the padding before decode; passthrough for non-padded legacy
  payloads.
* **Omit-ct scope (measured, 2026-10-05):** in a strictly alternating
  conversation the ack always references the peer's **previous** chain (every
  incoming message carries a fresh `kemPk`, forcing a ratchet step), so `ct`
  is omitted only on **burst sends** (2+ messages in one chain before the
  peer's next message). Verified in the 3-browser log: all alternating
  messages correctly carried `ct`; the mechanism stays for bursts and its
  guard fixed the latent partial-step corruption path.
* **Deliberately unchanged:** used skipped keys are never deleted (MK-persist,
  reload/kick+re-add decryptability) and `MAX_SKIP` stays 1000 (libsignal's
  25 000 considered too loose for NYX's threat model).

### 🌫️ T4 — Cover Traffic (doc 26.10)
* **Application-Level Filler:** Opt-in per group. Cover messages traverse the
  FULL pipeline (sendMessage → sidecar → redisBridge → Postgres → recipient
  decrypt) with bit-for-bit identical metadata (tempId, deleteSecret,
  identical TTL distribution, 8KB padding, pseudonyms) and differ only in the
  encrypted payload (`{ type: 'COVER', ts }`); receivers drop them after
  decryption (mirroring GHOST_SYNC: no bubble, no vault, no preview, no push).
  Complements the existing wire-level chaff (opcode 0x00).
* **Poisson Scheduling:** Independent per-conversation process
  (Δ = -ln(U)/λ clamped [10s, 15min], λ = 0.5/min default), memoryless
  resampling, no inter-member coordination — real sends hide by superposition.
  Skipped ticks (hidden tab / disconnected) are not queued.
* **Cover Yields to Real (26.10.4):** real sends are tracked in a rolling
  60s window; cover backs off as the shared `chat_message` bucket fills
  (soft cap 118/min after the 27.2.4 recalibration) — real traffic is never
  throttled by cover.
* **Honest UX (26.10.5):** per-group toggle in Group Info showing the ~5.6
  MB/day estimate before enabling; global master kill-switch in Settings
  (Privacy Shield module, with live "N group(s) armed" status); i18n in all
  four locales. Cover advancing the sender-key chain means chain index N no
  longer maps to real message counts (by design).
* **Burners Default Maximum (26.10.5 Q5):** burner conversations (1:1,
  `burner_<hex>`) emit cover traffic from day one without opt-in — the
  scheduler treats every `burner_*` id as opted-in (master kill-switch still
  wins), the conversation store subscription arms new/recovered burners live,
  and the burner DR receive path drops `COVER` payloads after decryption
  (`isCoverPayload`; the burner path bypasses `parseSilent`). Maximum status
  is derivative of the id prefix: never persisted, never sent to the server.
  Burner sends also stay out of the cover backoff accounting (no shared
  `chat_message` bucket).
* **Maximum Bundle Completed (26.10.5):** the per-group Maximum switch now
  bundles **ephemeral receipts** alongside cover traffic — receipts in
  opted-in groups (and all burners, 26.10.7) are released with a random
  0–45s jitter (`scheduleEphemeralReceipt`), decorrelating read-time from
  open-time; the toggle, burners included, is client-local. Batched/jittered
  release for message payloads remains a future bundle addition.

### 🧪 Tests (this tier set)
* Server: 90 total — T1 pseudonym storage/relay/unsend, T3a receipt
  persistence & broadcast (incl. 1:1 isolation and self-read skip), T3b
  token-first schema/sync/revocation contract, T2 pairwise-only rejection,
  T2 OFFLINE-KEY (fulfilled_key persisted as SYSTEM GROUP_KEY for offline
  catch-up), 26.8.1 blind RSA credentials (roundtrip, serial parity, issuance
  quota, sync presentation, verify rejections).
* Web: 143 total — pseudonym map helpers, pairwise key delivery wire
  contract, cover-traffic Poisson sampling/scheduler/backoff (incl. burner
  default-Maximum arming, master-switch precedence, `isCoverPayload`,
  `collectCoverArmedIds`), ephemeral-receipt gating and jitter scheduling,
  GROUP_KEY and COVER silent-payload guards.

## 🔒 [Unreleased] - 2026-09-25

Reliability, privacy, and multi-account hardening pass: eliminates silent
message loss on flaky networks, closes two identity-mixing bugs (biometric
vault and auto-unlock key scoping), removes the last third-party telemetry
surfaces, and locks previously-untested server contracts behind regression
tests. No schema migration and no new required environment variables.

### Fixed
* **Unread Badge Re-appearing (#98):** One message could raise the unread
  badge more than once — live `message:new` events were processed by two
  call sites, and re-delivered/edited old messages re-incremented the
  counter. A per-session per-message watermark now guarantees each message
  increments the badge at most once (covered by unit tests).

### 🚀 Reliability & Realtime
* **Idempotent Message Send:** Retries after a lost ACK (5s offline-queue / 15s
  emit timeout) no longer create duplicates. The server reserves a Redis slot
  (`SET NX`, 24h TTL) keyed by `deviceId + tempId`; duplicate sends receive an
  ACK replaying the original message instead of inserting again. Fail-open if
  Redis is unavailable.
* **Cursor Pagination for Offline Catch-Up:** `GET /api/messages/:conversationId`
  supports `?before=` keyset pagination (clamped to the 14-day retention window)
  and returns `hasMore`/`nextCursor`. Clients backfill up to 4×250 messages per
  reconnect and fall back to server pages on scroll — a user offline for days
  in an active group no longer silently misses everything past the first 250.
* **Offline Message Loss (Receipts):** Read receipts no longer delete ciphertext
  immediately; a 24-hour one-shot grace window keeps messages retrievable by
  devices that were offline when they were read elsewhere.
* **Batched Read Receipts:** Plural `messages:mark_as_read` now processes up to
  100 receipts with 4 queries total instead of 2-3 per message — kills the N+1
  spike when opening a busy group on the 1-core VPS. The client now actually
  sends the plural event (chunks of 100) on both transports, and the socket.io
  fallback registers all `messages:mark_*` events (previously WT-only).
  Opaque Mailbox preserved via a per-message `targets` map so 1:1
  sealed-sender notifications still reach the sender.
* **WSS Gateway Parity:** The socket.io fallback now registers all 24 KEY_SYNC
  events through a single exported `WSS_KEYS_SYNC_EVENTS` list and forwards
  `msgId` for ACK correlation, matching the WebTransport path. A new parity
  test cross-checks the gateway against `handleKeySync`'s switch cases and
  forces future divergences to be reviewed or explicitly documented.
* **Collision-Resistant tempId:** Multi-tab message composition could mint
  identical tempIds; with server dedupe that silently swallowed one message.
  New scheme packs 53 JS-safe bits (`epoch-seconds | per-tab counter |
  boot-random`) — duplicate-free up to 4096 msg/s/tab, valid until ~2106.
  Retry-with-same-tempId contract unchanged.

### 🔒 Privacy & Security
* **Third-Party Telemetry & AI Removal:** Removed end-to-end: the AI Smart Reply
  proxy (decrypted plaintext never leaves the device anymore, even opt-in),
  Sentry crash reporting (errors stay in local pm2 logs), the Gemini
  dependency, and all dead config (`SENTRY_*`, `GEMINI_API_KEY`,
  `VITE_SENTRY_DSN`, `VITE_WS_URL`, `VITE_CHAT_SECRET`, legacy S3/Supabase).
* **Biometric Vault per-Credential:** The biometric vault moved from a single
  per-origin entry (`nyx_bio_vault`) to a map keyed by WebAuthn credential ID
  (`nyx_bio_vault_v2`). Two accounts enrolling biometrics on the same browser no
  longer overwrite each other; corrupt credentials are removed selectively.
* **Biometric Unlock Is RAM-Only:** Biometric unlock regenerates keys into
  memory via the recovery phrase without touching the password-encrypted
  bundle in IndexedDB — fixing the regression where biometric login made the
  next password login fail with "incorrect password".
* **Per-User Auto-Unlock Key:** The sessionStorage auto-unlock key is scoped
  `nyx_device_auto_unlock_key:<userId>` instead of a single global slot, so
  alternating accounts in one tab can neither clobber nor decrypt with each
  other's keys. Legacy global keys are still read for migration. Also fixes a
  latent storage bug where short obfuscated keys were returned raw by the old
  legacy-value heuristic.
* **Server-Side Encrypted-Keys Sync:** The device's `encryptedPrivateKey` copy
  was only written on register/login/recover — key rotation left a stale
  identity bundle that broke blind logins on new devices. `POST
  /api/keys/prekey-bundle` now accepts `encryptedPrivateKeys` (optional,
  backward compatible) and updates the device row in the same transaction;
  the client sends the latest copy on every bundle upload.
* **Crypto-Only Payments:** Removed the fiat rail entirely (Tripay checkout
  `POST /create`, its `POST /webhook` callback, and the Midtrans-branded UI
  strings). Even with an anonymous alias, fiat rails create a financial paper
  trail that contradicts the zero-knowledge promise. NOWPayments (crypto) is
  now the only payment method; `TRIPAY_*` env vars are no longer read.

### 🧹 Cleanup
* **Dead Locale Namespaces:** Removed `privacy`, `help`, and `landing` JSON
  (4 languages) from the web app — unreferenced by `i18n.ts` and stale copies
  of the marketing site's (more current) locale files; they only bloated the
  service-worker precache. Dead orphan component `EncryptionStatusNotification`
  (localStorage-era contract) removed with its i18n keys.
* **Docs Sync:** Purged all stale AI smart-reply / Sentry references from the
  docs tree; CHANGELOG's Smart Reply entry annotated as removed rather than
  deleted. Prekey-bundle docs updated for the new sync field.

### 🧪 Tests
* Server: +11 tests (send dedupe, batch receipts, encrypted-keys sync, WSS
  parity) — 64 total, all without Postgres/Redis.
* Web: +12 tests (bio vault v2, biometric RAM-unlock contract, auto-unlock
  scoping, tempId collision) — 101 total. Test mocks for `keyStorage` hardened
  against missing-export crashes; one-shot identity state now reset per test.

## 🔒 [2.6.5] - 2026-06-13

This update introduces the cutting-edge Binary WebTransport Handshake (NYX-BWH-V1), significantly optimizing Post-Quantum Cryptography performance. We have also hardened our security model by strictly enforcing Single-Active-Device policies and introducing Biometric Vault unlocks for seamless session recovery.

### 🚀 Protocol & Cryptography (NYX-BWH-V1)
* **Binary WebTransport Handshake:** Transitioned the PQX3DH handshake from JSON/Base64 to a packed raw binary format (`Uint8Array`). This reduces payload overhead by ~40% and drastically improves Time To First Chat (TTFC).
* **Zero-Copy Memory Transfers:** Web Workers (`crypto.worker` and `transport.worker`) now communicate using Transferable Objects (`ArrayBuffer`), allowing heavy X-Wing decapsulation to run without blocking the main UI thread.
* **Bi-directional Stream Pipeline:** The Rust Sidecar now handles dedicated, continuous bidirectional streams specifically for binary handshakes (OpCode `0x0A`), featuring immediate ACK frames to handle aggressive UDP backpressure.

### 🔒 Security & Identity Hardening
* **Single-Active-Device Enforcement:** To eliminate cryptographic "Split-Brain" scenarios, accounts are now strictly limited to one active device per account. Logging into a new device automatically revokes all previous refresh tokens and sessions.
* **Better biometric Vault Unlock:** Integrated WebAuthn PRF. Users can now securely unlock their local vault and decrypt session keys using device biometrics (FaceID/TouchID) instead of manually typing their password.
* **Sandbox Search Bypass:** Unverified accounts in Sandbox Mode can now bypass search restrictions by providing the exact 43-character Base64URL Hash ID of a contact.
* **Out-of-Band (OOB) Profile Exchange:** Profile sharing URLs now bundle the `id` and `encryptedProfile` payload (`?u=...&i=...&p=...`), allowing immediate peer connection without requiring an initial round-trip to the server.

### 📁 Media & UI/UX Improvements
* **Optimistic Local Previews:** Media rendering components (`LazyImage`, `FileAttachment`, `VoiceMessagePlayer`) now intelligently bypass the decryption pipeline for local, unencrypted blob URLs, instantly rendering sent attachments.
* **Image Editor Refinements:** Rewrote the canvas composition engine. SVG strokes are now accurately drawn onto a high-res background bitmap before exporting, preserving original image dimensions and aspect ratios.
* **Interface Cleanup:** Added iOS safe-area utilities (`pt-safe`, `pb-safe`) for edge-to-edge screens. Wrapped `ImageEditorModal` and `AttachmentCropperModal` in React `<Portal>` to fix stacking context issues. Removed legacy multi-device UI components.
* **Post-Quantum Badges:** Replaced manual Paranoid Mode toggles with automated "X-Wing Post-Quantum" status badges in the User Info panel.

### 🐛 Bug Fixes & Stability
* **Redis PubSub Self-Relay:** Fixed an issue where the sender's own active sessions weren't receiving chat message broadcasts over the Redis bridge (push notifications are still correctly suppressed for self).
* **Cloud Storage Cleanup:** Fixed an R2 bucket cleanup bug that caused user avatar and media artifacts to be orphaned upon account deletion.
* **Database Migration:** Upgraded the local `NyxDatabase` (IndexedDB) to version 4, gracefully migrating legacy `pqDrSessions` into `pqDrSessionsV2` using robust composite keys.
* **Group Ratchet State:** Added the `requiresImmediateRotation` flag to `GroupSenderState` and improved fallback logic for fetching older skipped message keys missing the `senderDeviceKey`.
* **Memory Leak Prevention:** Improved `MessageInput`'s file preview manager to strictly track and execute `URL.revokeObjectURL()` on deleted or modified attachments, preventing RAM bloat.

## 🔒 [2.6.4] - 2026-06-06

This major update introduces a high-performance networking architecture using WebTransport (HTTP/3), a secure hybrid storage system for attachments, and significant hardening of the anonymous Burner Chat experience.

### 🚀 Core Architecture
* **WebTransport & Rust Sidecar:** Migrated the real-time communication pipeline to WebTransport (HTTP/3 QUIC) powered by a dedicated Rust sidecar server. This provides lower latency, improved reliability in unstable networks, and better CPU efficiency.
* **Hybrid OPFS Storage:** Implemented a new secure storage system using the Origin Private File System (OPFS). Encrypted ciphertext blobs are now cached locally, drastically reducing bandwidth consumption and improving media load times while maintaining a Zero Trace model.

### 🔥 Burner Chat (Guest Mode) Enhancements
* **Anonymous Authentication:** Introduced a new anonymous guest authentication flow specifically for Burner Chat, providing temporary JWTs and seamless WebTransport token integration.
* **Encryption State Sync:** Resolved "Split-Brain" scenarios in guest sessions, ensuring both sides maintain consistent cryptographic states even after browser reloads.
* **Session Hardening:** Fixed several critical bugs in the burner flow, including socket crashes, Redis adapter leaks, and incorrect device fetching logic for ephemeral users.

### 🐛 Bug Fixes & Stability
* **E2EE Key Management:** Optimized key transaction queues and fixed multi-device key request loops. Corrected target device selection for system key requests and restored missing socket events.
* **UI Clean-up:** Fixed a regression where system control messages (like `GROUP_KEY`) were leaking into the chat UI.
* **API Optimization:** Prevented API call spamming on the frontend and fixed unsafe type assertions in the core message processor.
* **Message Logic:** Improved message deletion consistency and sender key distribution reliability for offline participants.

### 🎨 UI/UX Improvements
* **Media Interaction:** Added discreet download buttons to image bubbles, file attachments, and the voice message player. Redesigned the Lightbox with integrated download actions.
* **System Health:** Introduced a new System Status UI with a modern banner look and full internationalization (i18n) support.
* **Responsiveness:** Fixed layout overflow issues in the Voice Message Player and improved image rendering consistency.

### 🛠️ Infrastructure & CI
* **VPS Migration:** Successfully migrated production services to a new VPS infrastructure.
* **Deployment Pipeline:** Prepared new CI/CD workflows and enforced stricter git commit rules for codebase integrity.
* **Cleanup:** Standardized `.gitignore` rules and removed legacy untracked artifacts.

## 🔒 [2.6.3] - 2026-05-26

This release introduces new monetization features, seamless integrations, and addresses critical E2EE and infrastructure stability issues.

### ✨ New Features
* **Subscriptions & Pro Tier:** Integrated a comprehensive subscription feature with the first implementation of the Pro tier. Added new crypto payment methods and corresponding localization updates.
* **Integrations:** Introduced a new iframe integration and SDK initialization for embedded chat experiences.

### 🐛 Bug Fixes & Stability
* **E2EE & Offline Sync:** Enforced a fresh public key fetch for system key requests and improved offline key catch-up robustness for the sender key protocol.
* **Security & Type Safety:** Addressed essential bug and vulnerability findings, fixed CSRF vulnerabilities for Snap, tightened Auth SafeUser validation, and resolved leftover unsafe (`any`) types from previous implementations (e.g., Midtrans integration).
* **General Fixes:** Fixed message ordering logic on the web, corrected link preview typos on the server, and applied minor stability improvements to the iframe and SDK.
* **Infrastructure:** Wrapped the socket connect listener in a try-catch with silent token refresh on 401 Unauthorized errors, and added `.mjs` MIME type mapping to Nginx.

### 🛠️ Maintenance & Testing
* **Documentation & Policies:** Updated the refund policy and marketing page documentation.
* **Dependencies & Tooling:** Updated minor version dependencies across the web, marketing, and server workspaces. Migrated marketing pages to PostCSS and implemented a new development runner (`tsx` watch).

## 🔒 [2.6.2] - 2026-05-01

This update marks the completion of our transition to a fully Post-Quantum Hardened architecture. We have finalized the migration to `libsodium-wrappers` as our primary cryptographic provider and implemented rigorous security patches across the entire application layer.

### 🛡️ Security & Cryptography
* **Full Libsodium Migration:** Completed the migration of all cryptographic operations to `libsodium-wrappers`. Eliminated all remnants of the WebCrypto API (`crypto.randomUUID`, `crypto.subtle`) for core security functions to ensure a single, audited source of truth.
* **Post-Quantum Hardening:** Enforced ML-KEM-768 (X-Wing) hybrid key exchange across all messaging protocols.
* **Dynamic Sender Key Rotation:** Implemented a new smart rotation system for Sender Keys to maintain Post-Compromise Security (PCS), specifically hardening the unified Fan-Out architecture used for both 1-on-1 and group chats.
* **Cryptographic App Lock:** Strengthened the "App Lock" by moving auto-unlock keys to `sessionStorage` (ephemeral) and implementing a memory-level wipe that clears private keys from RAM when the app loses focus.
* **XSS & DOM Hardening:** Implemented specialized SVG sanitization for decrypted attachments and hardened the Markdown parser to block `javascript:` protocol execution in links.
* **Paranoid Mode (PQ-DR):** Introduced "Paranoid Mode" (Post-Quantum Double Ratchet) for 1-on-1 messaging, providing a higher tier of security against future quantum threats.

### ✨ New Features
* **Stable Burner Chat:** Released the first stable version of Burner Chat sessions, providing a highly ephemeral and anonymous communication channel via secure link-based handshakes.
* **Protocol Signaling:** Added dynamic protocol switch messaging to support seamless upgrades to PQC-hardened sessions.

### 🐛 Bug Fixes & Stability
* **Crypto Engine Reliability:** Fixed critical bugs in the PQC chain derivation and resolved race conditions in the key rotation sender state.
* **Optimistic UI Timeout:** Added a 15-second timeout to all message-sending socket events, ensuring the UI correctly transitions to a "FAILED" state during network interruptions.
* **Data Leakage Prevention:** Implemented `sanitizeErrorLog` to ensure that private keys, plaintext, or sensitive JSON metadata never leak into the browser console or UI toast notifications.
* **Force Device Revocation:** Fixed a loophole where revoked devices could remain connected via Socket.IO; the server now enforces immediate disconnection upon device removal.

### 🛠️ Maintenance & Testing
* **Deep Security Audit:** Completed a comprehensive E2E security audit covering the UI, Zustand stores, and the Web Worker-based crypto engine.
* **PQC Testing:** Integrated new cryptographic tests specifically for ML-KEM-768 and X-Wing constructs to ensure long-term stability and backward compatibility of keys.

## 🔒 [2.6.1] - 2026-04-24

This maintenance release focuses on absolute Zero-Knowledge integrity and Post-Quantum hardening. We have completely removed the server's role in cryptographic key generation, ensuring the backend remains a blind relay that never touches plaintext keys.

### 🛡️ Security & Cryptography
* **Pure Blind Relay Architecture:** Stripped all key generation (`sodium.crypto_secretbox_keygen`) and encryption (`crypto_box_seal`) from the server. The backend now only routes and stores opaque, client-encrypted blobs.
* **Client-Authoritative Key Distribution:** Key rotation is now managed exclusively by the client. The initiator client generates the `sessionKey` locally and distributes it to all group members via hybrid **ML-KEM-768 (Post-Quantum)** + X25519 (X-Wing construct).
* **Privacy Hardening:** Patched potential leaks of IP addresses and device names.
* **Network Security:** Implemented strict rate-limiting for WebRTC signaling and fixed zombie socket connection cleanup.
* **Database Integrity:** Migrated all key storage types in Prisma to `Bytes` (Buffer) for consistent binary handling.

### 🐛 Bug Fixes & Stability
* **Fatal Crash Prevention:** Replaced dangerous non-null assertions and unsafe `parseInt` logic in the local vault hex-parsing utility to prevent "White Screen" crashes during Argon2id verification.
* **UI Logic:** Fixed bugs in the UI reply bubble logic to ensure consistent rendering of message threads.
* **Socket Reliability:** Resolved race conditions in push notifications for multi-device environments.
* **Crypto Validation:** Hardened Zod schemas for cryptographic payloads to prevent malformed packet injection.

### 🛠️ Maintenance & Testing
* **E2EE Testing Framework:** Fully integrated **Playwright** for comprehensive end-to-end (E2E) cryptographic testing.
* **Localization:** Conducted a major update to the localization library, stores, and hooks to support expanded multi-language features.
* **Clean Up:** Removed obsolete unit tests that relied on legacy, non-PQC architectures.
* **Dependencies:** Bumped `axios` and various frontend/backend packages to resolve vulnerabilities and improve performance.

## 🚀 [v2.6.0] - 2026-04-11

This release brings one of the most significant architectural updates to Nyx Chat. We have completely rewritten the core cryptographic engine to support multiple simultaneous devices, ensuring you stay connected everywhere without compromising End-to-End Encryption (E2EE) privacy.

### ✨ New Features
* **Linked Devices (Multi-Device Support):** Your account can now be linked to multiple devices simultaneously. Each device maintains its own secure cryptographic identity, powered by our new *Fan-Out Sender Key* architecture.
* **History Sync & Vault Management:** Seamlessly synchronize your chat history across linked devices via E2EE, complete with a revamped export/import system for the Local Vault.

### 🐛 Bug Fixes
* **Cryptography & Synchronization:** Fixed decryption failures on group metadata and perfected Message Key distribution across multi-device environments.
* **Database / IndexedDB:** Resolved an issue where exporting/importing the vault and reloading messages resulted in empty chat bubbles.
* **WebRTC & Calls:** Fixed bugs during call initialization and ensured the wakelock feature (preventing the screen from sleeping) works correctly during active audio/video calls.
* **Notifications:** Push notifications are now strictly managed per-device to prevent conflicts or missing alerts across different active sessions.
* **Marketing Site:** Fixed multi-language routing (`lang` page) on the Astro marketing site.

### 🛡️ Security & Under the Hood
* **Security Patches:** Resolved severity findings from static analysis (CodeQL), including preventing multiple log injection vulnerabilities.
* **Type Safety:** Conducted a massive cleanup and refinement of TypeScript definitions to make the codebase more resilient against runtime errors.
* **Dependency Updates:** Addressed Dependabot security alerts by bumping Vite to a secure branch, along with ESLint and various other core backend and frontend dependencies.
* **Internal:** Cleaned up dozens of internal multi-device testing commits to keep the git history clean.

## [2.5.5] - 2026-04-04

### 🚀 Key Features & Architectural Changes
- **Pure Store-and-Forward E2EE Architecture:** Completely eliminated long-term message storage on the server. Messages are now strictly ephemeral on the backend, existing only to be routed, and are instantly destroyed once the recipient acknowledges delivery.
- **Unified Local Database (Dexie):** Refactored all raw IndexedDB usage to use `dexie`, vastly improving local query performance, code readability, and data integrity for the Shadow Vault.
- **Zero-Knowledge Default Avatars:** Removed the third-party dependency on `dicebear.com` for generating default avatars. Avatars are now generated locally on the client using initials and deterministic colors, preventing metadata leaks and improving UI load times.
- **Marketing Site Overhaul (Pure Astro):** Completely rebuilt the marketing pages (`/marketing`) using pure Astro. This drastically improves SEO, load speeds, and multi-language (i18n) handling.
- **TypeScript 6.x Upgrade & Strict Mode:** Upgraded the entire monorepo to TypeScript 6.x. Eliminated the usage of `any` across the stack, introducing a Single Source of Truth (SSOT) for shared DTOs, Socket payloads, and database mappers.

### 🛡️ Security & Privacy
- **DOM-Based XSS Prevention:** Patched a critical vulnerability in the Markdown parser. Raw HTML inputs (e.g., `<h1>`) are now safely converted to literal text rather than being stripped out or executed.
- **IDOR Prevention on View-Once Messages:** The server now strictly validates user participation before allowing `view_once_opened` socket events.
- **Strict WebRTC Payload Validation:** Added rigid runtime type checking for all WebRTC signaling payloads (`offer`, `answer`, `candidate`) to prevent UI crashes from malformed packets.
- **Legal & Compliance:** Removed inaccurate "HIPAA-ready" marketing claims to avoid compliance and legal risks, replacing them with accurate technical descriptors (e.g., *zero-knowledge, enterprise-grade security*).
- **Hall of Fame:** Added `faiqalfaruq` to `SECURITY.md` for responsibly disclosing the DOM-based XSS vulnerability.
- Updated multiple vulnerable dependencies including `serialize-javascript`, `lodash-es`, and `zod`.

### 🐛 Bug Fixes
- **E2EE Race Conditions:** Fixed a critical race condition where messages could be deleted from the server before being safely saved to the local IndexedDB.
- **Unsend Paradox:** Fixed an issue where the "Unsend" socket event failed to broadcast because it attempted to query a message that had already been deleted by the Store-and-Forward mechanism.
- **Story Viewer Timers:** Fixed bugs in the Story Viewer where the progress bar would run before the media was fully downloaded/decrypted. Video stories now correctly adapt their progress bar duration to the actual length of the video.
- **Edit Message Button:** Fixed a bug in Optimistic UI where the "Edit" button would disappear immediately after sending a message due to a mismatch in the `type` state.
- **Double Bubble & Desync:** Resolved various issues related to optimistic UI rendering, message bubble duplication, and read receipt (blue tick) synchronization between clients.
- **Tailwind Scanner in Astro:** Fixed an issue where Tailwind CSS v4 failed to scan utility classes within the new Astro marketing pages.
- **File Attachment Logic:** Improved file attachment handling for strict browsers (Firefox and Safari).

### ⚡ Performance & Optimizations
- **App Optimization Passes 1-6:** Conducted massive sweeps across the client application to reduce re-renders, optimize media loading, and improve React component lifecycles.
- **Offline Queue Reliability:** Enhanced the robustness of the offline message queue, ensuring precise retries and preventing duplicates upon reconnection.
- **Dependency Bumps:** Updated `pnpm/action-setup` to v5 and bumped various frontend and backend dependencies to their latest stable versions for better security and performance.


## [2.5.4] - 2026-03-24

This massive update brings a complete rewrite of our public-facing infrastructure, major architectural security enhancements ("The Grand Unification"), native WebRTC calls, the new Stories feature, and full internationalization. 

### 🚀 New Features
- **Next-Gen Marketing Pages (Astro):** Completely rewrote the landing, privacy, and help pages using pure Astro for zero-JS footprint, blazing-fast performance, and superior SEO/GEO.
- **Global Internationalization (i18n):** Added native multi-language support across the app and landing pages. Officially supporting Indonesian (`id`), Spanish (`es`), and Portuguese (Brazil) (`pt-BR`), complete with a dynamic Language Switcher.
- **Stories & Canvas Editor:** Introduced end-to-end encrypted Stories with complete privacy controls. Includes a native canvas image editor, dynamic crop modes, and attachment cropper.
- **WebRTC & TURN Server:** Implemented a dedicated TURN server and a new WebRTC P2P mesh topology for highly reliable, encrypted audio/video calls.
- **QR Connect:** New QR-based quick connect and peer discovery feature.
- **Manual State Sync:** Added a new "Desync" button for users to manually forcefully reconcile local and server message states.

### 🛡️ Architecture & Security ("The Grand Unification")
- **Full Strict Mode:** Enforced TypeScript `strict: true` across the entire frontend and backend monorepo.
- **Zod & Opaque Types:** Replaced loose types with Zod runtime shields and cryptographic opaque types to strictly validate all incoming/outgoing payloads.
- **Shared Package:** Extracted core types and validations into a new unified `@nyx/shared` package for flawless backend-frontend contract matching.
- **CodeQL Refactor:** Refactored GitHub CodeQL workflows for deeper security analysis.
- **Vulnerability Patches:** Resolved multiple critical/high severity findings, updated vulnerable dependencies via `pnpm` overrides (e.g., `flatted`, `undici`), and hardened socket payload shields.
- **Cryptography Enhancements:** Hardened X3DH protocol initiators and optimized cryptographic operations ordering via Proxy Web Workers.

### 💅 Polish & Improvements
- **SEO & IndexNow:** Implemented advanced SEO tags, GEO-hooks, and automated `IndexNow` pinging for faster search engine indexing.
- **Media Optimization:** Enhanced image loading logic (lazy loading, responsive sizing) and UI icon refinements.
- **Error Handling UI:** Redesigned error boundaries and fallback UIs for a smoother user experience during network failures.
- **Settings Expansion:** Added new dedicated UI toggles for Push Notifications within the Settings page.

### 🐛 Bug Fixes
- **Message State & Sync:** Fixed recurring issues with message desync, offline queue logic, and atomic increment errors between local IndexedDB and server state.
- **File Uploads:** Rewrote file upload sequence logic to prevent freezing and ensure proper metadata attachment.
- **Dynamic Island:** Fixed null message rendering bugs that caused the Dynamic Island navigation to crash.
- **Routing & Previews:** Fixed missing URL previews on reply messages and corrected React Router navigation edge cases in the Register flow.
- **Legal & Branding:** Corrected typos and formatting in the Privacy Policy, Licensing (AGPL/Commercial), and Trademark attributions.

## [2.3.0] - 2026-03-07

This release introduces the **"Tactical UX & Advanced Operations"** upgrade. It significantly elevates the user experience, media handling, and functional messaging capabilities while maintaining strict adherence to Zero-Knowledge and E2EE protocols.

### Advanced Messaging & E2EE Capabilities

* **E2EE Message Editing:** Users can now edit sent messages. Edits are transmitted securely as specialized encrypted JSON payloads (`{"type":"edit"}`) that retroactively overwrite the local IndexedDB state and append an `(edited)` label. The server remains completely blind to the edits.
* **Silent Drop (Ghost Messaging):** Long-pressing the send button reveals a "Send without sound" option. This feature uses a masked payload (`{"type":"silent"}`) to instruct the recipient's application to suppress ringtones and push notifications, allowing for discreet message delivery.
* **Expanded Tactical Reactions:** Upgraded the static reaction menu. Clicking the new "More" (`+`) button reveals a full Emoji Picker. This utilizes an isolated global event hijacking technique to map the dynamic emoji back to the specific E2EE message safely.
* **Tombstone Protocol (Ghost Placeholder Fix):** Fixed a critical E2EE synchronization bug where locally deleted messages would reappear as "Decryption failed" upon reload. Implemented a soft-delete tombstone pattern (`isDeletedLocal: true`) in the local vault to safely ignore server re-fetches.
* **Crypto Mutex Serialization:** Resolved a Double Ratchet race condition when bulk-sending files. Implemented a Promise-based Mutex queue (`acquireSendLock`) to strictly serialize concurrent E2EE operations, preventing Ratchet Counter (N) collisions.

### Media Handling & Staging

* **Media Staging Carousel:** Completely overhauled the file attachment flow. Selected files are now intercepted and held in a staging area (a horizontal carousel) above the text input. Users can review, cancel individual files, and add text before executing the final upload.
* **Dynamic HD Image Upload:** Added an "HD" toggle for media. Standard images undergo aggressive client-side compression (1MB/1080p limit), but enabling HD dynamically bypasses this constraint to allow high-fidelity image uploads (up to 10MB/4K).
* **Native Voice Note Compression:** Optimized the client-side `MediaRecorder`. Voice notes are now forced into the `audio/webm;codecs=opus` codec with a strictly throttled 16kbps bitrate, cutting audio file sizes by up to 80% with zero external dependencies.
* **SVG Structure Preserver:** Fixed a rendering bug where E2EE decrypted SVG blobs would collapse to zero dimensions in the Chat UI by enforcing structural aspect ratios and container constraints.

### Privacy & Security UX

* **Voice Anonymizer (Real-Time Distortion):** Introduced an "ANON" mode for Voice Notes. When toggled, it intercepts the microphone stream via the native Web Audio API, applying a real-time Ring Modulator (40Hz) and Lowpass Filter (800Hz) to deeply scramble and disguise the user's voice *before* encryption.
* **Privacy Cloak:** Added a tactical sensor toggle (Eye icon) in the main header. Activating it instantly applies a CSS blur and opacity filter over all chat list contents and message bubbles, physically protecting the screen from shoulder-surfers.
* **Biometric Identity Normalization:** Fixed WebAuthn initialization where authenticator prompts displayed random hex arrays. Normalized the User ID buffer for a cleaner OS-level biometric prompt and improved fallback routing when PRF keys desynchronize.

### Functional UX

* **Tactical Sweep (Bulk Delete):** Introduced a bulk selection mode. Users can enter "Select" mode via the context menu, tap checkboxes next to multiple messages, and execute a mass-deletion from their local IndexedDB via a dedicated tactical header.
* **Smart Message Truncation:** Extremely long text messages are now elegantly truncated to a maximum height. Instead of raw string slicing (which breaks Markdown), it utilizes CSS `mask-image` fade-out gradients and a "Read More / Show Less" toggle.

## [2.2.0] - 2026-02-26

This release introduces the "Pure Anonymity" architecture, completely decoupling the application from email and phone numbers. It establishes NYX as a Trust-Tier system with Zero-Knowledge principles at its core.

### The Great Decoupling (Pure Anonymity)
- **Email Removal:** Completely removed all email-related logic, columns, and dependencies from the database and backend. Registration and Login now use a **Blind Indexing** mechanism.
- **Blind Indexing:** Usernames are hashed client-side using Argon2id with a static salt before being sent to the server. The server stores only `usernameHash` and has no knowledge of the original username.
- **No PII Storage:** The server database no longer contains any Personally Identifiable Information (PII). `name`, `avatarUrl`, and `description` are encrypted client-side.

### Trust-Tier System (The Sandbox)
- **Sandbox Mode:** New accounts start in "Sandbox Mode" (Unverified) by default to prevent spam.
- **Gatekeeper:** Implemented strict server-side rate limiting for unverified users:
  - Max 5 messages/minute.
  - No group creation allowed.
  - Max 3 new private conversations per day.
  - Search results limited to 3 items.
- **VIP Upgrade:** Users can upgrade to "Verified" status (VIP) via:
  - **Biometric Verification:** Instant upgrade using WebAuthn (Fingerprint/FaceID).
  - **Proof of Work (PoW):** A privacy-friendly alternative where users solve a cryptographic puzzle (SHA-256 mining) in the browser to prove they are human.

### Security & Cryptography
- **Profile Encryption:** User profiles (Name, Bio, Avatar) are now encrypted client-side using a symmetric `ProfileKey`. This key is securely exchanged via the Double Ratchet header in the first message to a new contact. The server only stores `encryptedProfile`.
- **WebAuthn PRF (Biometric Vault):** Implemented the WebAuthn Pseudo-Random Function (PRF) extension. This allows users to decrypt their local key vault (containing the Recovery Phrase) using only their biometric authentication, enabling a true passwordless login experience.
- **Zero-Knowledge Recovery:** Account recovery now uses a cryptographic signature derived from the 24-word phrase to authorize password resets, without ever revealing the phrase to the server.
- **Device Migration Tunnel:** Added a secure, direct WebSocket tunnel for transferring account data from an old device to a new one via QR code, bypassing the need for cloud backups.

### Infrastructure
- **Cloudflare R2 Hardening:** Fixed critical CORS issues with AWS SDK v3 by disabling checksum calculation and enforcing path-style URLs for compatibility with Cloudflare R2.
- **Redis Integration:** Expanded Redis usage for PoW challenges, Sandbox rate limiting, and ephemeral state management.

### UI/UX
- **Settings Overhaul:** Redesigned the Settings page to display Trust Tier status (Verified/Sandboxed) and manage the new security features (Vault Export/Import, Biometric Setup).
- **Registration Flow:** Updated the registration process to offer immediate Biometric Verification for VIP status.
- **Visual Feedback:** Added visual indicators for Verified users in chat lists and profiles.

## [2.1.1] - 2026-02-22

### Privacy & Security
- **Reactions as Messages:** Replaced the legacy `MessageReaction` table with E2E encrypted messages. Reactions are now transmitted as secure messages and processed client-side, eliminating metadata leakage about user interactions.
- **Blind Attachments:** Implemented blind attachment protocol. File metadata (name, type, size, key) is now encrypted within the message payload. The server no longer stores `fileUrl` or file metadata in plaintext columns.
- **Backend Cleanup:** Removed `imageUrl`, `fileUrl`, `fileName`, `fileType`, `fileSize`, `duration`, and `fileKey` columns from the `Message` model in `schema.prisma`. Removed `MessageReaction` model.
- **Endpoint Hardening:** Removed legacy upload endpoints that saved file metadata. Updated `POST /api/messages` to reject file fields, accepting only encrypted content.

### Fixes
- **Reaction Deletion:** Fixed 404 errors when deleting reactions by ensuring the correct server-side Message ID is used instead of the local optimistic ID.
- **Decryption Reliability:** Fixed race conditions where messages appeared as "Legacy Message Unreadable" or "Waiting for key" by implementing robust re-decryption logic with a slight delay to allow key storage.
- **Chat List Preview:** Fixed issue where reactions appeared as raw JSON in the chat list preview. Now displays "Reacted [Emoji]" or the last actual message.
- **Frontend Refactor:** Unified upload logic in `messageInput.ts` to support blind attachments for both file uploads and voice notes.

### Infrastructure
- **Database:** Schema simplified by removing file-related columns and the reaction table. (Requires migration: `npx prisma migrate dev`).

## [2.1.0] - 2026-02-21

This release establishes NYX as a "Paranoia-Level" secure messaging platform. It introduces a Hardened Encryption protocol (XChaCha20), eliminates all forms of user tracking, and secures the application infrastructure against advanced attacks.

### Security Hardening (Paranoia Level)

-   **XChaCha20-Poly1305 Migration:**
    -   **Hard Migration:** Replaced the legacy XSalsa20-Poly1305 cipher with the modern, high-performance **XChaCha20-Poly1305** stream cipher for all new message encryption.
    -   **Mobile Optimization:** Leverages XChaCha20's superior performance on ARM-based mobile devices.
    -   **Clean Break:** Old messages encrypted with XSalsa20 are intentionally rendered unreadable to ensure a clean cryptographic state moving forward.
-   **Privacy-First Architecture:**
    -   **Zero Analytics:** Removed all tracking scripts (`Google Analytics`, `Vercel Analytics`, `Hotjar`) and dependencies.
    -   **Metadata Protection:** Disabled Service Worker API caching to prevent metadata leakage in browser storage.
    -   **IP Anonymization:** Server now **hashes IP addresses** (SHA-256) before storing them in the refresh token table, preventing long-term tracking of user locations.
-   **Frontend Defense:**
    -   **XSS Proofing:** Replaced the custom markdown parser with `react-markdown` and `rehype-sanitize`, strictly sanitizing all HTML output to prevent Cross-Site Scripting (XSS).
    -   **Strict CSP:** Implemented a rigorous Content Security Policy (CSP) that blocks all unauthorized scripts, analytics, and unsafe evaluations (except necessary WASM).
-   **Backend Defense:**
    -   **DoS Protection:** Implemented a **Split Body Parser** strategy. General API endpoints are now strictly limited to `100kb` payloads, while file uploads are isolated with a `15mb` limit.
    -   **Rate Limiting:** Added Redis-backed rate limiting to critical WebSocket events (`join`, `message`, `typing`) to prevent socket flooding.
    -   **Input Validation:** Enforced strict `Zod` schema validation on all critical message and reaction endpoints.

### Changed

-   **Nginx Configuration:**
    -   Updated `nginx.conf` for VPS deployment (Port 3000, Proxy to Localhost).
    -   Hardened security headers: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.
    -   Disabled Gzip compression for `application/json` to mitigate BREACH attacks on encrypted API responses.
-   **Supply Chain:**
    -   Audited and fixed all critical NPM vulnerabilities via `pnpm.overrides`.
    -   Removed unused and bloated dependencies: `multer`, `crypto-js`, `@types/helmet`, `bcrypt`.

## [2.0.0] - 2026-02-10

This landmark release transforms NYX into a "Fortress of Privacy" with a completely re-architected security model, introduces AI-powered features, and achieves full compliance transparency. It represents the biggest leap in security and capability since the project's inception.

### Security Architecture Overhaul (The "Cloud Vault" Upgrade)

-   **IndexedDB Key Storage:** Migrated all cryptographic key storage from vulnerable `localStorage` to an isolated **IndexedDB** instance (`keychain-db-${userId}`). This mitigates XSS risks and allows for secure multi-user login on the same device.
-   **Encrypted Key Sync (Cloud Vault):** Implemented a "Zero-Knowledge" synchronization system. Encrypted private keys are now securely backed up to the server during registration and automatically restored upon login. This allows users to access their encrypted chats on new devices simply by logging in with their password, eliminating the need for manual manual restores while maintaining full E2EE.
-   **Argon2 Hashing:** Upgraded the backend password hashing algorithm from `bcrypt` to **Argon2id** for superior resistance against GPU-based brute-force attacks. Includes a seamless "lazy migration" system for existing users.
-   **Memory Wiping:** Implemented rigorous memory hygiene in the `crypto.worker.ts`. Sensitive variables (seeds, private keys) are now explicitly wiped using `sodium.memzero()` immediately after use to protect against RAM scraping attacks.
-   **Secure Logout:** The logout process now aggressively sanitizes the browser environment, wiping all local cryptographic material (Master Keys) while preserving the encrypted session database for future access.

### Added (New Features)

-   **AI Smart Reply (REMOVED in later releases):**
    -   A Gemini-powered smart reply suggestion feature existed in this version.
    -   It has since been fully removed in the name of maximum anonymity — no third-party AI service ever sees message content.
-   **Legal & Privacy Center:**
    -   Added a comprehensive `/privacy` page detailing the Data Policy, Terms of Service, and Security Architecture.
    -   Accessible from the Login/Register footer and the Settings menu.
-   **System Notifications:** Implemented persistent in-chat system banners to warn users about optimal security practices (e.g., ensuring both parties are online for the initial handshake).

### Changed

-   **Mobile Viewport Optimization:** Replaced `100vh` with `100dvh` (Dynamic Viewport Height) across the application (`App.tsx`, `index.css`). This finally resolves the notorious "floating address bar" issue on mobile browsers, ensuring the chat input is always visible.
-   **Profile Experience:**
    -   The Profile Page and User Info Modal now display **real-time** data, including the user's actual Public Identity Key (fingerprint) and online status.
    -   Email addresses are now visible on profiles if the user has opted to share them.

### Fixed

-   **CRITICAL: Key Rotation Signature Failure:** Fixed a major bug where rotating keys would break future conversations. The server now correctly updates the user's public `signingKey` during rotation, ensuring valid signature verification for new sessions.
-   **CRITICAL: Registration Race Condition:** Resolved a race condition where the application would attempt to bootstrap a session before the registration process completed, causing the newly generated keys to be wiped. Added safeguards to the `bootstrap` and `verifyEmail` flows.
-   **CRITICAL: Crypto Worker Type Errors:** Fixed deserialization issues in `crypto.worker.ts` that caused "unsupported input type" errors for `x3dh_initiator`, `crypto_box_seal_open`, and file encryption operations.
-   **Session Key Persistence:** Fixed a regression where logging out would delete session keys, making old chats unreadable upon re-login. The system now correctly preserves encrypted session keys locally.
-   **Verification UI:** Added a prominent notice to the Email Verification modal advising users to check their Spam/Junk folders.

## [1.9.0] - 2026-02-02

This major release focuses on "Performance & Polish". It introduces a complete visual overhaul to "Industrial Neumorphism", implements a rigorous "Crypto Quarantine" for faster initial load times, and resolves critical bugs in voice messaging and security.

### Added

-   **Performance: Crypto Quarantine (Lazy Loading):**
    -   Refactored the application architecture to **lazy load** the massive cryptographic libraries (`libsodium`, `crypto-worker`). The ~750KB crypto bundle is now only downloaded when a user logs in or performs an encrypted action, significantly improving the "Time to Interactive" on the Landing Page.
    -   Added visual loading states (`isInitializingCrypto`) to provide feedback while the security module initializes.
-   **Performance: Virtualized Lists:** Implemented `react-virtuoso` virtualization with optimized memoization for both the Chat List and Message Window. This resolves severe scrolling lag on mobile devices by only rendering items currently in view.
-   **SEO & GEO Optimization:**
    -   Added `robots.txt` and `sitemap.xml` to properly index the application.
    -   Injected rich JSON-LD schema (`SoftwareApplication`, `Organization`, `FAQPage`) into `index.html` to optimize for AI citation (GEO) and Google Rich Results.
-   **Security: Cloudflare Turnstile:** Integrated Cloudflare Turnstile on the Registration page to prevent bot abuse, complete with proper Content-Security-Policy (CSP) configuration.

### Changed

-   **UI Overhaul: Industrial Neumorphism:**
    -   **Design System:** Fully implemented a new "Industrial Neumorphism" design language featuring custom `neu-*` shadows, "Seam" separators, and "Trench" inputs for a tactile, physical feel.
    -   **Profile Page:** Redesigned into a "Personnel File" dashboard layout.
    -   **Modals:** Refactored `UserInfoModal` into a "Digital Identity Card" design.
    -   **Dynamic Island:** Updated with "Heavy Levitation" physics.
-   **Asset Diet:** Removed over **4MB** of unused background assets and moved documentation screenshots out of the production build, further reducing the initial download size.

### Fixed

-   **Voice Message Decryption:** Fixed a critical bug where voice messages failed to play with the error "Data provided to an operation does not meet requirements". The player now correctly decrypts the *file key* using the session key before attempting to decrypt the audio file.
-   **Voice Uploads:** Fixed `OpaqueResponseBlocking` errors by ensuring encrypted voice files are uploaded with the `application/octet-stream` MIME type to Cloudflare R2.
-   **Lightbox Z-Index:** Fixed an issue where the image lightbox was clipped by sidebars or modals. It now uses a React Portal to render at the top level of the DOM.
-   **Content-Security-Policy (CSP):**
    -   Hardened CSP to allow Web Workers (`blob:`) and Cloudflare Turnstile (`challenges.cloudflare.com`) while blocking unauthorized scripts.
    -   Aligned the backend `helmet` CSP configuration with the frontend meta tags.
-   **Bio/Profile Caching:** Fixed a bug where profile bio updates were not visible immediately due to aggressive API caching. Added `Cache-Control: no-store` headers to API responses.

## [1.8.0] - 2026-01-19

This is a major stability and architectural release focused on delivering a fully functional, robust, and user-friendly "Link Device" feature. It resolves a series of deep, interconnected bugs in the authentication, cryptography, and real-time state management layers.

### Added

-   **Fully Functional "Link Device" Feature:** Users can now seamlessly and reliably link a new device by scanning a QR code. The new device is set up automatically without requiring password entry, providing a modern and convenient onboarding experience.

### Fixed

-   **CRITICAL: Complete Overhaul of Device Linking Flow:** Diagnosed and fixed a cascade of critical bugs that previously made the feature unusable.
    -   **UI Stability:** Resolved a persistent crash on the QR scanner page (`DeviceScannerPage`) by correctly managing the camera lifecycle within React.
    -   **Race Condition Elimination:** Fixed a critical race condition where global application logic (`App.tsx`) would prematurely terminate the guest WebSocket connection or trigger unauthorized API calls during the linking process.
    -   **Cryptographic Integrity:**
        *   Resolved a fundamental data format mismatch between the client and the crypto worker, fixing an `incomplete input` error.
        *   Fixed a subtle key derivation mismatch, where the encryption key did not match the decryption key, resolving the `wrong secret key for the given ciphertext` error.
        *   Corrected the encrypted payload structure to match the exact format expected by the decryption function in the crypto worker.
-   **Authentication Flow Robustness:**
    -   **Registration:** Fixed a bug that caused the initial secure key upload (`setupAndUploadPreKeyBundle`) to fail after a user registered a new account.
    -   **Login:** Improved the login flow to immediately decrypt and cache local keys using the login password, removing a redundant password prompt.
-   **Build Stability:** Resolved multiple TypeScript syntax and type errors that were preventing successful production builds.

### Changed

- **Improved Help & FAQ:** The content of the Help page (`HelpPage.tsx`) and the security info modal (`ChatInfoModal.tsx`) has been completely rewritten to be more accurate, comprehensive, and to correctly explain the new "Link Device" feature as the primary method for adding devices.

## [1.7.1] - 2025-12-29

This is a massive stability, security, and architectural hardening release that resolves numerous critical bugs, race conditions, and security vulnerabilities, particularly within the End-to-End Encryption (E2EE) and real-time state synchronization systems.

### Changed

-   **Major E2EE Decryption Refactor:** Rearchitected the entire message decryption flow to eliminate critical race conditions. All decryption logic is now centralized in a single function (`decryptMessageObject`) which acts as the "single source of truth". It now robustly determines the message context (1-on-1 vs. Group) based on the message's `sessionId` rather than relying on potentially stale component state.
-   **Robust Key Rotation & Request Handling:**
    -   The key rotation process for groups is no longer "fire-and-forget". It now features an automatic retry mechanism with exponential backoff.
    -   Key requests for missing group keys now have a timeout and retry limit. If all retries fail (e.g., no other users are online), messages will now display a final "Key request timed out" error instead of being stuck in a "waiting" state indefinitely.

### Fixed

-   **CRITICAL SECURITY: Invalid Key Distribution Vulnerability:** Patched a critical vulnerability where any authenticated user could distribute encryption keys to any conversation, even those they were not a part of. The server now strictly validates that the key distributor is a member of the target conversation.
-   **CRITICAL SECURITY: Reply Chain DoS Vulnerability:**
    -   Hardened the client-side decryption logic to prevent infinite recursion or stack overflow crashes when processing messages with circular or excessively deep reply chains.
    -   Added server-side validation to reject new messages that would create a reply chain deeper than a set limit.
-   **CRITICAL SECURITY: History Leak on Re-join:** Fixed a major privacy leak where a user who was kicked from and then re-added to a group could see the message history from their original membership period after a page reload. The server now correctly resets the user's "joined at" timestamp upon re-joining.
-   **CRITICAL SECURITY: Key Material Leaked in Logs:** Removed multiple `console.log` statements that were insecurely printing sensitive cryptographic key material in the browser console.
-   **Real-time & State Synchronization Bugs:**
    -   Fixed a bug where the group member list in the UI would not update in real-time when a user was added or removed.
    -   Fixed an issue where a user kicked from a group would still receive notifications for new messages in that group. The client now correctly ignores events for conversations it has left.
    -   Fixed a bug where an Admin's special controls (e.g., "add member") would disappear after reloading the page. The server now consistently provides the user's role data.
-   **General Stability:**
    -   Fixed multiple `ReferenceError` crashes caused by missing imports or undeclared variables in the crypto and state management modules.
    -   Fixed a bug where the "retry send" feature would not work correctly for messages that were replies.

## [1.7.0] - 2025-12-27

This is a major architectural and stability release that introduces significant performance improvements for end-to-end encryption (E2EE) and fixes critical bugs in the group chat implementation.

### Added

- **Cryptography Offloading to Web Workers:** All heavy cryptographic operations (key generation, encryption, decryption) have been moved off the main UI thread and into a dedicated Web Worker. This prevents the UI from freezing during intensive crypto calculations, resulting in a significantly smoother and more responsive user experience, especially on lower-end devices.
- **Functional Group Chat E2EE:** Implemented the foundational layer for secure group conversations. This version uses a **shared group key** model where a single, securely distributed key is used by all members to encrypt and decrypt messages. This provides a robust and efficient E2EE baseline for group chats.

### Fixed

- **Critical Group Chat E2EE Bug:** Diagnosed and fixed a series of complex, interconnected bugs that prevented group chats from functioning correctly.
  - **Key Distribution Failure:** Fixed a critical flaw where group encryption keys were generated by the sender but never successfully distributed to other participants. This was traced to both a missing server-side socket listener and client-side logic that failed to trigger distribution at the correct time. The system now reliably distributes keys to all members before a message is sent.
  - **Missing Public Key Data:** Fixed a bug where the server would not send participants' public keys when fetching conversation data. This was the final root cause of the "Participant has no public key" error.
  - **Incorrect Encryption Path:** Fixed the underlying issue that caused the application to mistakenly use 1-on-1 encryption logic for group messages, which led to the "No session key available" error. The correct group encryption path is now always used.

## [1.6.0] - 2025-12-02

This is a massive stability and security release that resolves numerous critical bugs throughout the application, with a major focus on making the end-to-end encryption (E2EE) system and real-time features robust, secure, and reliable.

### Fixed

- **Critical End-to-End Encryption Overhaul:**
  - Resolved a persistent and complex bug that caused initial E2EE sessions to fail. The fix involved correcting the client-side key derivation logic, ensuring the server correctly stores all required cryptographic keys, and fixing database relationships (`PrismaClientValidationError`).
  - The client now correctly handles session keys generated by both client-side handshakes and server-side ratchets, fixing an architectural mismatch that led to `404` errors.
  - Corrected the client-side key generation and storage process to ensure all necessary private keys (`identity`, `signing`, `signedPreKey`) are deterministically created and stored, enabling the recipient-side key derivation to succeed.

- **Security & Data Integrity:**
  - Removed a silent fallback to non-encrypted conversations, which was a critical security risk. The application will now explicitly fail if a secure session cannot be established.
  - Fixed an authorization vulnerability where any user could react to messages in conversations they were not a part of.
  - Fixed another authorization vulnerability where users could fetch messages from conversations they were not a part of.
  - Ensured conversation and session key creation is now an atomic database transaction to prevent orphaned or inconsistent data.
  - Fixed a data integrity issue where a user's primary identity key (`User.publicKey`) was not being updated correctly in all scenarios.

- **Real-time & UI Functionality:**
  - **Read Receipts:** Fixed a bug preventing read receipts from working. The status of messages now updates in real-time when a recipient views them.
  - **Profile Updates:** Fixed a bug where user profile updates were not reflected in real-time for other users.
  - **Notifications:** Fixed both the "Dynamic Island" and Notification Bell features, which were not showing notifications for new messages in inactive chats.
  - **Message Bubble Deletion:** Fixed a UI rendering bug where deleting a message would cause its bubble to incorrectly display the content of the message below it.
  - **State Management on Logout:** Fixed a critical bug where logging out and logging back in without a page refresh would cause application errors. The logout process now fully and correctly resets all application state.
  - **Message Retry Logic:** Fixed a bug that would cause a message to become permanently unreadable if the "retry send" action was used.

## [1.5.0] - 2025-11-10

This is a quality-of-life and robustness release focused on polishing the user interface of newly implemented features and hardening the application against potential data inconsistencies.

### Changed
- **Polished Voice Message Player:** The UI for the voice message player has been significantly improved:
  - The play button now uses the main theme background color for better contrast against the message bubble.
  - A "thumb" indicator has been added to the progress bar, providing clearer visual feedback of the current playback position.
  - The overall layout and styling have been tweaked for a more refined and professional appearance.
- **Improved Error Handling for Missing Files:** All media components (`VoiceMessagePlayer`, `FileAttachment`, `LazyImage`, `Lightbox`) now provide a clear, user-friendly error message ("File not found on server.") when they fail to load a file due to a 404 error. This improves the user experience if files are cleaned up from the server.
- **Consistent Modal Language:** All text within the "Security Info" modal (`ChatInfoModal`) has been standardized to English to ensure consistency.

### Fixed
- **Incomplete Chat History:** Fixed a critical bug where opening a conversation would sometimes only show the most recent messages instead of the full history. The message loading logic now correctly fetches the complete history the first time a chat is opened.
- **Voice Message Bubble Width:** Fixed a UI bug where voice message bubbles would shrink, by enforcing a fixed, proportional width for all voice messages.
- **Voice Message Duration Bug:** Fixed a critical bug where the duration of all voice messages was incorrectly recorded as `0`. This was traced to a stale state issue within an event handler, which has been resolved by using a `useRef` hook to guarantee the correct duration is captured. This fix also corrected the progress bar indicator, which was stuck at the start.
- **File Deletion on Server:** Fixed a critical bug where deleting a message with a file attached would delete the database record but leave the physical file on the server. The backend logic now correctly reconstructs the file path and deletes the file from storage.
- **Lightbox Image Overflow:** Fixed a bug where very tall or wide images would overflow the screen in the lightbox view. The component now correctly constrains the image to the viewport while maintaining its aspect ratio and ensuring a consistent margin.
- **Reply Preview:** Fixed a bug where the reply preview UI would show incorrect information or raw encrypted text. The preview now correctly shows the sender's name and a proper summary for all message types (text, file, voice).
- **Build Failure:** Fixed a build failure caused by a dangling import to a deleted file (`sanitize.ts`) in `ChatList.tsx`.

### Reverted
- **Typing Indicator:** Reverted a change that attempted to fix the typing indicator. The implementation caused a regression in the user presence (online/offline) status and has been rolled back to restore the correct presence behavior. The typing indicator remains non-functional and is a known issue.

## [1.4.0] - 2025-11-10

This is a major security and feature release that implements a complete, end-to-end encrypted (E2EE) file sharing system, building upon the robust patterns established in previous versions. All user-uploaded content, including voice messages, images, and documents, is now fully encrypted.

### Added
- **E2EE for All File Uploads:** Extended the end-to-end encryption protocol to cover all file types. The application now follows a consistent and secure pattern for all uploads:
  1.  A one-time symmetric key is generated for the file on the client.
  2.  The file is encrypted with this key.
  3.  The file key is then encrypted with the conversation's session key.
  4.  The encrypted file is uploaded, and the encrypted file key is sent as part of the message payload.
- **E2EE Voice Messages:** Implemented a full-featured voice messaging system with E2EE.
- **Smart Media Components:** Refactored all components that handle file-based media (`VoiceMessagePlayer`, `FileAttachment`, `LazyImage`, `Lightbox`) to be "smart". They now accept the full message object, handle their own decryption logic, and manage loading/error states internally.

### Fixed
- **Critical E2EE Data Corruption Bug:** Diagnosed and fixed a persistent and elusive bug where encrypted keys were being corrupted before reaching the receiver. The root cause was traced to the database schema, where the `content` field had a default length limit that was silently truncating the long encrypted keys.
  - **Solution:** The `content` field's data type was changed to `Text` in the Prisma schema to remove the length limit. As a more robust, long-term solution, a dedicated `fileKey` field was added to the `Message` model to completely isolate file keys from the text `content` field, preventing any future conflicts.
- **UI Race Condition in Voice Recording:** Fixed a bug where the voice message duration was always recorded as `0` seconds. This was caused by a race condition where the recording timer was reset before the `onstop` event could capture its value.
- **E2EE Key Decryption Failures:**
  - Fixed a bug where the sender of a voice message or file would see a decryption error on their own optimistic message. This was resolved by making the media components "optimistic-aware" and preventing them from attempting to decrypt a raw, unencrypted key.
  - Fixed multiple instances where components would attempt to decrypt the wrong message field (e.g., `content` instead of `fileKey`).
- **Broken Lightbox:** Fixed a bug where the image lightbox failed to display images after the initial E2EE implementation. The `Lightbox` component was refactored to be "smart" and handle its own decryption.
- **UI Glitches:**
  - Fixed a bug where the raw file key (a random string) would briefly appear in the message bubble for voice messages.
  - Corrected placeholder text in reply previews for voice messages.

## [1.3.0] - 2025-11-10

This release introduces a comprehensive, professional landing page to serve as the application's public-facing "front door". It also includes numerous UI/UX enhancements and critical routing fixes.

### Added
- **New Landing Page:** Created a full-featured, animated landing page at the root (`/`) of the application, including:
  - A hero section with a call-to-action.
  - An interactive theme comparison slider to showcase light and dark modes.
  - A "Features" section with animated cards.
  - A "How It Works" section visually explaining the security flow.
  - A "Works Everywhere" section displaying the app on multiple devices.
  - A "Testimonials" section for social proof.
- **Scroll Animations:** Implemented "fade-in" and "slide-up" animations on all sections of the landing page, triggered as the user scrolls.
- **Hover Animations:** Added a more dynamic, spring-based "expand and lift" effect to the feature cards on hover.

### Changed
- **Root Routing:** The application's root route (`/`) now serves the public landing page. The main chat interface is now exclusively accessible via the `/chat` route.

### Fixed
- **Post-Login Redirect:** Fixed a critical bug where users were redirected to the landing page after logging in, registering, or restoring an account. All authentication flows now correctly redirect to `/chat`.
- **In-App Back Buttons:** Corrected multiple "back" buttons (e.g., from Settings) to navigate to `/chat` instead of the root landing page.
- **Landing Page Scrolling:** Fixed a bug where a global `overflow: hidden` style prevented the new landing page from being scrollable.
- **Component Rendering:** Fixed several React/JSX errors in the landing page that caused build failures or prevented components (like the theme slider and testimonials) from rendering correctly.

## [1.2.0] - 2025-11-08


This is a major architectural release focused on improving the long-term maintainability, stability, and performance of the application by refactoring core components and fixing critical real-time functionality bugs.

### Changed

- **Theming:**
  - Overhauled the color palettes for both light and dark modes to create a more authentic and cohesive Neumorphic aesthetic.
  - Dark mode now uses a neutral dark gray theme, removing all blue tints for a "true black" feel.
  - Light mode now uses a softer, off-gray background for both the main view and component surfaces, creating a more subtle "soft UI" effect.
  - Adjusted all shadow and border colors to complement the new palettes and enhance the 3D effect.

- **Major State Management Refactor:** The monolithic `useMessageStore` has been broken down into smaller, more focused stores (`useMessageStore`, `useMessageInputStore`, `useMessageSearchStore`) to improve separation of concerns and simplify state management.
- **Component Logic Extraction:** Refactored the `ChatList` component into a purely presentational component. All of its business logic, state selection, and side effects have been extracted into a new, dedicated `useChatList` custom hook.
- **Conversation Creation Flow:** Moved 1-on-1 conversation creation logic from a WebSocket event (`message:send`) to the `POST /api/conversations` REST endpoint, making the creation process more explicit and robust.
- **Centralized File Uploads:** Consolidated file upload logic into a new `apiUpload` helper function, removing direct `axios` usage from the stores and ensuring consistent authentication handling.

### Fixed

- **Real-time Connection for New Chats:**
  - Fixed a critical bug where the creator of a new group or 1-on-1 chat would not receive real-time messages until refreshing. The client now immediately joins the new conversation's socket room.
  - Fixed an issue where users added to a new conversation would not receive real-time updates. The client now correctly handles the `conversation:new` socket event and joins the room.
- **Server Race Condition:** Fixed a `P2003 Foreign key constraint violated` error on the server that occurred when marking a message as read too quickly. Message creation is now wrapped in a database transaction to ensure atomicity.
- **UI & Data Sync:**
  - Fixed a bug where deleting a group or conversation would not be reflected in the UI until a page refresh.
  - Fixed the user search functionality within the "Create Group" modal, which was failing due to an authentication issue.
  - Fixed a UI bug where the sender's name in group chats was invisible in dark mode by applying a theme-aware CSS filter.
- **General Stability:**
  - Fixed a bug where the initial page load would get stuck in a loading state indefinitely.
  - Resolved a Vite configuration error (`fs.allow`) that prevented `react-pdf` styles from loading.
  - Corrected multiple JavaScript `ReferenceError` and syntax errors (`Unexpected ")"`, misplaced `import`) that were introduced during the extensive refactoring process.

## [1.1.2] - 2025-11-08

This release addresses critical backend architecture and frontend user experience issues, improving application stability and robustness.

### Fixed

- **Online Status Race Condition:** Migrated the online presence tracking system from a local in-memory `Set` to a centralized Redis set. This resolves a potential race condition and ensures that the presence status and the E2EE key recovery mechanism work reliably across multiple server instances.
- **Conversation Load Error Handling:** Improved the user experience for data loading errors. The conversation list now displays a descriptive error message and a "Retry" button if conversations fail to load, allowing users to recover from network failures without a full page refresh.

## [1.1.1] - 2025-11-08

This release focuses on enhancing user experience with smoother UI transitions and a critical improvement to end-to-end encryption key recovery for offline messages.

### Added

- **Real-time E2EE Key Recovery:** Implemented a robust client-to-client key recovery mechanism via WebSocket. When a user comes online and encounters messages encrypted with a session key they don't possess (e.g., sent while offline), the client now securely requests the missing key from another online participant in the conversation.
  - Server-side Socket.IO now orchestrates key requests and fulfillment between clients.
  - Client-side Socket.IO handles emitting key requests and fulfilling requests from other clients.
  - Client-side cryptographic logic (`crypto.ts`) now non-blockingly requests keys and re-encrypts keys for other clients.
  - Client-side message store (`message.ts`) now re-decrypts messages after a missing key is successfully received.

### Changed

- **Animated Tab Indicators:** Refactored tab components (`GroupInfoPanel`, `UserInfoPanel`) to use a new `AnimatedTabs` component. The active tab indicator now slides smoothly between tabs using `framer-motion`'s `tween` transition, providing a more dynamic and responsive UI.
- **Backdrop Contrast Improvement:** Adjusted the styling of `backdrop-blur` elements to ensure better color contrast in both light and and dark themes, making blurred backgrounds darker in light mode and lighter in dark mode.

## [1.1.0] - 2025-11-08

This release introduces a complete and robust account restore flow, ensuring users can access their full, decrypted message history on a new device. It also fixes critical bugs related to the restore process.

### Added

- **Full History Sync on Restore:** When restoring an account with a recovery phrase, the application now automatically fetches, decrypts, and stores the entire history of message encryption keys. This allows users to seamlessly view their old, encrypted messages on a new device.
- **Backend Sync Endpoint:** Created a new, secure API endpoint (`/api/session-keys/sync`) to facilitate the secure transfer of historical keys to a newly restored device.

### Fixed

- **Failed Decryption on New Device:** Fixed the critical bug where messages in existing conversations would fail to decrypt after restoring an account.
- **Stuck "Syncing" Notification:** Resolved an issue where the "Syncing message keys..." notification would get stuck in a loading state. This was traced to a race condition in React's Strict Mode and has been fixed by preventing concurrent synchronization processes.

### Changed

- **Code Cleanup:** Removed an obsolete and unused encryption utility file (`web/src/utils/e2ee.ts`) to reduce technical debt and improve clarity.

## [1.0.9] - 2025-11-06

This release focuses on improving UI clarity and accessibility.

### Changed

- **Message Bubble Styling:** Adjusted the styling of self-sent messages. The chosen accent color is now applied to the message bubble's background instead of the text, improving visual distinction.

### Fixed

- **Accessibility:** 
  - Added descriptive `aria-label` attributes to all icon-only buttons across the application to improve screen reader compatibility.
  - Fixed color contrast issues in the light theme for the blue and purple accent colors to ensure text remains readable.
- **Performance:** Resolved a critical performance issue that caused high CPU usage when the onboarding modal was displayed by fixing a re-render loop.

## [1.0.8] - 2025-11-06

This release introduces a crucial onboarding experience for new users to familiarize them with the app's key security concepts.

### Added

- **New User Onboarding Tour:** Implemented a multi-step guided tour for first-time users that explains core security features like the Recovery Phrase and Safety Numbers.
- **Backend Support for Onboarding:** Added a `hasCompletedOnboarding` flag to the user model in the database and created a new API endpoint to track the tour's completion status.

### Fixed

- **Onboarding API Call:** Fixed a `TypeError` that occurred when finishing the tour by correcting the API call syntax.
- **Server-Side Rendering Issues:** Resolved an issue where a server restart was required for new backend changes to take effect.
- **Database Schema Validation:** Corrected multiple validation errors in the Prisma schema that were preventing database migrations.
- **Broken Registration Route:** Restored critical logic in the `/register` API endpoint that was accidentally deleted in a previous modification.

## [1.0.7] - 2025-11-06

This release introduces theme customization, allowing users to personalize the application by choosing their preferred accent color. It also includes several critical bug fixes for recently added features.

### Added

- **Accent Color Customization:** Users can now select their preferred accent color from a palette in the Settings page under the 'Appearance' section. The chosen color is applied across the entire application and is saved for future sessions.

### Fixed

- **Infinite Loop in Components:** Resolved a critical `Maximum update depth exceeded` error by wrapping function declarations in `useCallback` within `App.tsx` and `ChatList.tsx`, preventing infinite re-render loops.
- **Missing React Import:** Fixed a `ReferenceError` by adding a missing `useCallback` import in `App.tsx`.
- **Theme Picker UI:** Corrected a UI bug in the Settings page where color swatches were not displaying correctly. The implementation was changed to use inline styles for better reliability.

## [1.0.6] - 2025-11-06

This release upgrades the `Ctrl+K` shortcut into a full-featured Command Palette, allowing for quick execution of commands from anywhere in the application.

### Added

- **Command Palette:** Implemented a Command Palette (`Ctrl+K` or `Cmd+K`) for quick access to actions.
  - Includes initial commands: 'Settings', 'Logout', and 'New Group' (contextual).
  - Features include real-time filtering, keyboard navigation (Arrow keys & Enter), and a scalable command registration system.

### Fixed

- **Build Errors:** Resolved multiple build errors related to duplicate declarations and incorrect import paths that arose during the command palette implementation.

## [1.0.5] - 2025-11-06

This release introduces significant enhancements to file sharing, including a media gallery to browse all shared files in a conversation and rich previews for PDFs, videos, and audio files.

### Added

- **Media Gallery:** Added a 'Media' tab to the Group Info and User Info panels, allowing users to easily view all images, videos, and documents shared in a conversation.
- **Rich File Previews:** File attachments in chats now show rich previews:
  - **PDFs:** Display a preview of the first page directly in the chat.
  - **Video & Audio:** Embed a playable media player for video and audio files.

### Fixed

- **Backend API:** Fixed a 500 Internal Server Error on the new `/media` API endpoint by correcting the database query to use the proper schema fields (`fileType`, `fileUrl`, `imageUrl`).
- **PDF Preview Rendering:** Resolved a build error and a runtime warning related to the `react-pdf` library in Vite by correcting CSS import paths and self-hosting the required PDF worker script.

## [1.0.4] - 2025-11-06

This release introduces major keyboard navigation enhancements for a faster, more accessible user experience, and fixes bugs related to their implementation.

### Added

- **Keyboard Navigation:** Implemented comprehensive keyboard navigation features:
  - **Chat List Navigation:** Users can now navigate the conversation list using the `Arrow Up` and `Arrow Down` keys and open a chat by pressing `Enter`.
  - **Global Escape:** Pressing the `Escape` key now closes any open modal or side panel, providing a consistent way to exit views.
  - **Quick Search Shortcut:** Added a global `Ctrl+K` (or `Cmd+K` on Mac) shortcut to immediately focus the main search bar from anywhere in the app.

### Fixed

- **Keyboard Navigation Bugs:** Resolved several reference and syntax errors in the `ChatList` component that occurred during the implementation of keyboard navigation, ensuring the feature is stable.

## [1.0.3] - 2025-11-06

This release addresses a critical message loading bug and includes several UI refinements and fixes based on user feedback after the Neumorphic redesign.

### Changed (Improvements & Refactors)

- **Button Theme:** Reverted primary action buttons from a gradient to a solid accent color (`bg-accent`). This resolves a visual bug where the button and its text were not visible in light mode and improves consistency with the Neumorphic design.

### Fixed

- **Message Loading:** Fixed a bug where older messages would not load when opening a conversation for the first time. The app now automatically fetches additional message pages to ensure the chat history is scrollable.
- **Toggle Switch UI:** Corrected a visual glitch in the Neumorphic `ToggleSwitch` where the handle was not vertically centered within its track.

## [1.0.2] - 2025-11-06

This release completes the transition to a full Neumorphic design system, ensuring a consistent and tactile UI across the entire application. It also includes several configuration and bug fixes.

### Changed (Improvements & Refactors)

- **Neumorphic Design System:** Completed the full implementation of the Neumorphic design system, replacing all remaining standard UI elements.
- **Component Styling:** Refactored all major components to use `convex` (protruding) and `concave` (recessed) neumorphic styles, including: Modals, Panels, Cards, List Items, Message Bubbles, Buttons, and Input Fields.
- **Toggle Switch Redesign:** Rebuilt all Toggle Switches to be fully neumorphic, with a concave track and a convex handle for a more tactile feel.
- **Dark Mode Tuning:** Fine-tuned dark mode neumorphic shadows to be more subtle and visually pleasing based on user feedback.

### Fixed

- **Build Failure:** Fixed a build error caused by a missing `colors` definition in the Tailwind CSS configuration.
- **JSX Syntax Errors:** Corrected JSX parsing errors in `Register.tsx` and `Login.tsx` that prevented the application from loading.
- **Corrupted Component:** Repaired the `MessageBubble.tsx` component file which contained duplicate, conflicting code.

## [1.0.1] - 2025-11-06

This release focuses on a significant UI/UX overhaul, introducing a unique visual identity and advanced responsive layouts.

### Added (New Features)

- **"Aurora" Gradient Theme:** Implemented a distinctive Teal-to-Indigo gradient as the application's new accent color, applied to primary buttons and key UI elements.
- **"Command Center" Layout:** Introduced an adaptive three-column layout for ultrawide monitors, displaying ChatList, ChatWindow, and a contextual info panel (GroupInfoPanel or UserInfoPanel) simultaneously.
- **Hybrid Tablet Experience:** Implemented dynamic layout switching for tablets based on orientation (mobile-like in portrait, desktop-like in landscape).
- **`useOrientation` Hook:** Created a custom React hook to detect and respond to screen orientation changes.
- **`UserInfoPanel` Component:** Developed a dedicated panel to display user information in the three-column layout.
- **New `2xl` Breakpoint:** Added a `2xl` breakpoint (1920px) to Tailwind CSS for ultrawide screen optimization.

### Changed (Improvements & Refactors)

- **"Floating Glass" Sidebar:** Transformed the desktop ChatList sidebar into a semi-transparent, blurred panel (`backdrop-blur-sm`) that floats over the main content, creating a modern depth effect.
- **Dynamic Background Pattern:** Added a subtle SVG pattern to the ChatWindow background, visible through the transparent sidebar, enhancing the visual depth.
- **Unified Button Styling:** Standardized all primary buttons across the application (including Auth pages, Message Input, Create Group, Settings, and Modals) to consistently use the new "Aurora" gradient.
- **Improved Color Contrast:** Further refined color contrast ratios for secondary text in both light and dark themes to enhance accessibility.

### Fixed

- **Layout Overlap:** Resolved the issue where the floating sidebar obscured the ChatWindow content by adding responsive left padding to the main content area.
- **Solid Sidebar Background:** Fixed the bug where the ChatList sidebar appeared solid by removing an erroneous `bg-surface` class from individual chat items.
- **JSX Parsing Errors:** Corrected multiple JSX closing tag errors in `Settings.tsx`.
- **Gradient Application:** Fixed issues where the new "Aurora" gradient was not correctly applied to primary buttons on Auth pages and various in-app components.

## [1.0.0] - 2025-11-05

This is a massive overhaul release, focusing on security, new features, and a complete UI/UX redesign.

### Added (New Features)

- **Secure Device Linking:** Implemented a new, secure flow to link a new device using a QR code, eliminating the need to re-enter the recovery phrase.
- **Biometric Login:** Added support for logging in using platform authenticators (e.g., fingerprint, face ID).
- **Account Restore:** Created a new flow for restoring an account from the 24-word recovery phrase.
- **Session Management:** Added a new page where users can view and manage all their active sessions.
- **Group Chat:** Implemented full support for creating and managing group conversations.
- **E2EE & Security:**
  - Implemented the Double Ratchet algorithm for robust, self-healing E2EE session management.
  - Added Safety Number verification to allow users to confirm the identity of their contacts.
  - Strengthened the master key generation and storage process.
- **In-App Notifications:** Built a notification center and popup system for real-time, in-app alerts.
- **User Profiles:** Added user profiles with display names and descriptions.
- **Message Features:**
  - Implemented link previews for URLs shared in messages.
  - Added message search functionality.
  - Implemented read receipts and unread message counts.
  - Added an emoji picker to the message input.
  - Implemented message replies.

### Changed (Improvements & Refactors)

- **Major UI/UX Overhaul:**
  - Defined and implemented a new professional, HSL-based color palette with full light/dark mode support.
  - Redesigned all key components (`ChatList`, `MessageBubble`, `ChatWindow`, Modals) for a modern and consistent look.
  - Standardized all forms, inputs, and buttons across the application with clear `hover`, `focus`, and `disabled` states.
  - Added smooth CSS transitions and `framer-motion` animations for a more dynamic and responsive user experience (e.g., sidebar slide-in, message fade-in, list re-ordering).
  - Improved color contrast ratios for better accessibility.
- **Architecture & Performance:**
  - Migrated device linking state from server memory to **Redis** for improved scalability and reliability.
  - Refactored socket logic for more efficient real-time communication, including implicit 1-on-1 chat creation.
  - Replaced CSS-based animations with `framer-motion` for smoother, physics-based transitions.
  - Implemented `react-virtuoso` for efficient rendering of long message and conversation lists.

### Fixed

- **Server Stability:** Fixed a critical server crash that occurred during `typing` events by adding defensive checks for the user object.
- **Client-Side Errors:**
  - Resolved a `ReferenceError` in the `ChatList` component that occurred after a refactor.
  - Fixed a bug that prevented messages from being decrypted correctly on the client.
- **UI/UX Bugs:**
  - Fixed an issue where modals and dropdowns had a transparent background, adding a `backdrop-blur` effect for a modern look.
  - Corrected numerous visual and contrast issues across the app after the new theme was implemented.
- **Authentication:** Patched a token unauthorization bug.
- **General Stability:** Numerous miscellaneous bug fixes and stability improvements (as noted by commits like `stable`, `stable3`, `stable4`, `stable5`, etc.).
