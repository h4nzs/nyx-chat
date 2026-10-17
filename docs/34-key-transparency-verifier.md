# 34 — Verifier Key Transparency di klien

> **Status: verified-search landed + teruji terhadap bukti nyata, termasuk dari
> jalur baca produksi (2026-10-13); integrasi jalur bundle + loop monitor +
> auditor + gossip landed (2026-10-14).** Modul WASM
> (`packages/keytrans-wasm`, kompilasi `libsignal-keytrans`), pembungkus klien
> (`web/src/lib/keyTransparency.ts`), pemakai produksinya
> (`web/src/lib/ktBundleProof.ts`, `web/src/lib/ktSubject.ts`,
> `web/src/lib/ktMonitoring.ts`, `web/src/lib/ktGossip.ts`), dan **60 test**
> verifier di lima berkas — `keyTransparency.test.ts` 12 (bukti nyata dari penulis
> Go + `server/kt-query`, termasuk rotasi kunci terhadap anchor bukti sebelumnya),
> `ktGossip.test.ts` 17, `peerIdentityTrust.test.ts` 14, `ktMonitoring.test.ts` 9,
> `ktSubject.test.ts` 8. Bundle peer kini **diverifikasi terhadap log sebelum
> dipin** (§34.6a), loop monitor dijalankan penjadwal (§34.6b), auditor pihak
> ketiga dilayani `server/kt-query` (`audit.go`), dan tree head di-gossip antar
> klien (§34.6c). Yang **belum**: auditor
> + gossip (mode 3) — §34.6 poin 3.

Rencana & gate: `docs/30` §30.5. Sisi penulis log: `docs/32`.

## 34.1 Apa yang ditutup

Sebelum ini NYX hanya **menulis** log KT. Tanpa verifier, server masih bisa
menyajikan prekey bundle palsu yang konsisten dengan dirinya sendiri (TOFU).
Sekarang klien bisa:

| Kemampuan | Artinya |
|---|---|
| `verify_search` | nilai log (identity key, PQ key, signing key, keyVersion) dibuktikan terhadap pohon + VRF + commitment |
| `verify_distinguished` | tree head baru konsisten dengan tree head distinguished yang sudah dipercaya |
| `verify_monitor` | membuktikan log tetap dibangun benar untuk kunci yang dimonitor (deteksi split-view/rewrite) |
| `monitor_next` | parameter monitor berikutnya (`next_monitor`, entries, versi terbesar) dari monitoring data |
| `condense_update` | `UpdateResponse` (balasan penulis log NYX) → bukti yang bisa diverifikasi klien |

Semua berjalan **di klien**: server hanya menyampaikan byte.

## 34.2 Artefak

| Berkas | Isi |
|---|---|
| `packages/keytrans-wasm/src/lib.rs` | ABI verifier + framing + re-tag protobuf `UpdateResponse` |
| `packages/keytrans-wasm/build.sh` | build ke `wasm32-unknown-unknown` (tanpa `wasm-pack`) |
| `packages/keytrans-wasm/dist/keytrans.wasm` | artefak ter-commit (295 KiB, **nol import**) |
| `web/src/lib/keyTransparency.ts` | pembungkus TS: frame, konfigurasi, state update, error |
| `web/src/lib/__tests__/keyTransparency.test.ts` | 18 test (bukti nyata, MITM, tamper, fuzz, `monitor_build`) |
| `server/scripts/kt-fixtures.ts` | generator fixture dari kt-server hidup (`pnpm --filter nyx-server run kt:fixtures`) |
| `web/src/lib/__tests__/fixtures/kt/*` | `config.json`, `search-v1.pb`, `search-v2.pb` (bukti nyata, keyVersion 1 & rotasi) |

## 34.3 Interop nyata (bukan mock)

Fixture dibuat dengan menjalankan binary Go yang sesungguhnya:

1. `kt-server` dengan `test_config.yaml` (kunci tetap di config) → test-update
   service di `127.0.0.1:8081`.
2. Dua entri NYX ditulis lewat penulis log NYX (`buildKtLogEntry` +
   `return_update_response = true`) → server mengembalikan `UpdateResponse`
   berisi `FullTreeHead` + `vrf_proof` (80 B) + `search` + `opening`.
3. `UpdateResponse` disimpan **apa adanya** sebagai fixture (53–62 KB; ukuran
   proof tumbuh seiring pohon).

Test kemudian: `condenseUpdate` (re-tag protobuf di Rust) → `verify_search`
dengan kunci publik log yang diturunkan dari seed config kt-server → nilai
kembali harus sama dengan nilai yang ditulis. Terukur saat pembuatan fixture:
`tree = 63 → 64`, `vrf_proof = 80 B`.

Dua jebakan saat **meregenerasi** fixture (ditemukan 2026-10-17, saat
memverifikasi ulang interop terhadap binary pin `30b7a2a40604` yang dibangun
lokal):

1. `VERIFY_NOW` di `keyTransparency.test.ts` dipatok ke waktu fixture lama.
   Tree head baru berumur “sekarang”, jadi verifikasi menolaknya bila `now` uji
   tertinggal lebih dari 24 jam (batas verifier upstream) — gejalanya muncul
   sebagai error proof, bukan pesan “waktu”. Regenerasi fixture **wajib**
   memperbarui konstanta itu.
2. `kt-fixtures.ts` menulis `mode: 1` (ContactMonitoring) apa adanya. Jalankan
   `kt-server` **tanpa** blok `api.auditors` — peta kosong (`auditors: {}`) pun
   membuat `TreeConfig()` memilih ThirdPartyAuditing (`auditorConfigs != nil`),
   sehingga fixture-nya tidak cocok dengan `mode` yang ditulis.

## 34.4 Yang diuji (12 test dasar + 6 dari jalur baca NYX)

| Properti | Hasil |
|---|---|
| Modul nol import + ABI diekspor | ✅ |
| Bukti keyVersion 1 diterima; nilai = `version|keyVersion|identityKey|…` | ✅ |
| Bukti rotasi kunci (keyVersion 2) diterima dengan identity key baru | ✅ |
| State update bisa dipakai ulang (monitoring data → `monitorStep`) | ✅ |
| **MITM**: nilai diganti (identity key palsu) → ditolak | ✅ |
| `vrf_proof`/`opening` diubah → ditolak (bahkan tanpa anchor) | ✅ |
| Dengan anchor: `search`/`tree head` diubah → ditolak (split-view) | ✅ |
| Kunci VRF salah (operator lain) → ditolak | ✅ |
| Search key tidak cocok → ditolak | ✅ |
| Mode deployment tak dikenal / kunci panjang salah → error, bukan trap | ✅ |
| Fuzz 200 input acak → semuanya `KtVerificationError`, instance tetap sehat | ✅ |
| Tree head sampah → ditolak sebelum nilai dipakai | ✅ |

## 34.5 Temuan penting: **anchor itu wajib**

Saat menguji perubahan byte, ada perbedaan yang harus dicatat apa adanya:

- **Tanpa anchor** (pencarian pertama, belum ada tree head yang dipercaya):
  perubahan di `vrf_proof` dan `opening` **ditolak** (nilai terikat ke proof),
  tetapi perubahan di dalam `search` dan `tree head` **tidak** terdeteksi —
  karena tanpa akar pembanding tidak ada yang bisa dibandingkan.
- **Dengan anchor** (`lastTreeHead` + monitoring data dari verifikasi
  sebelumnya): perubahan di `search`/`tree head` **ditolak**
  (`root is different but tree size is the same`).

Konsekuensi desain (bukan bug, tapi konsekuensi protokol): **keamanan KT
bergantung pada loop monitor**. Klien harus (a) memverifikasi *distinguished*
tree head sekali, (b) menyimpannya, dan (c) memverifikasi monitor secara berkala.
Tanpa itu, KT hanya mempersempit (bukan menutup) kemampuan server menyajikan
nilai palsu. Karena itu §34.6 menempatkan monitor sebagai langkah berikutnya yang
wajib sebelum gate kirim diaktifkan.

Residual lain yang tercatat jujur:

1. **Mode `ContactMonitoring` (mode 1) tidak memverifikasi tanda tangan auditor.**
   Byte di dalam slot tanda tangan auditor yang tidak dipakai mode ini tidak
   diperiksa; untuk menjadikannya bermakna, deployment harus memakai mode 3
   (third-party auditing) + `SetAuditorHead`. **Ditutup 2026-10-16:** log NYX (self-host)
   berjalan mode 3 dengan auditor nyata (`cmd/nyx-kt-auditor`, §34.6c), jadi auditor
   head benar-benar ada dan diperiksa verifier.
2. **`condense_update` mengandalkan kompatibilitas wire** antara server
   `transparency.proto` dan `signal.keytrans` (field 1–4 sama). Itu diuji lewat
   fixture nyata, tetapi kalau server mengubah tata letak field, test ini yang
   akan menangkapnya.
3. **`keyVersion` masih label alur** (registrasi / pemulihan / rotasi, lihat
   `docs/32` §32.7) — cukup untuk dedupe & mendeteksi perubahan, belum cukup
   untuk menyimpulkan urutan versi dari log saja. Sisi penulisnya **sudah
   lengkap** sejak 2026-10-17: tiga jalur rotasi (`POST /keys/prekey-bundle`,
   `PUT /users/me/keys`, re-sync kunci `POST /auth/login`) menulis entri via
   `utils/ktIdentityLog.ts`, sehingga verifier tidak lagi melihat `mismatch`
   untuk rotasi yang sah pada perangkat yang sudah mengirim identifier mentah
   (klien lama tetap dilewati → `no_identifier`). Deteksi perubahan kunci
   **tidak** bergantung pada byte `keyVersion` itu: `ktMonitoring` memakai
   `greatest_version()` = `PrefixProof.counter` pohon prefix KT (siapa pun yang
   menulis, counter naik) — `vendor/signal/libsignal-keytrans/src/lib.rs:385` +
   `verify.rs:982`.
4. **Ukuran proof tumbuh dengan pohon** (fixture sudah 53–62 KB untuk pohon 64
   entri). Ini biaya bandwidth nyata: verifikasi harus memakai *condensed*
   response (dua pembacaan: 3 condensed + 1 tree head dalam protokol Signal)
   dan tidak boleh dijalankan pada setiap pesan.

## 34.5a Sumber bukti: `nyx-kt-query` + proxy `/api/keys/kt/*` (2026-10-13)

Verifier di atas butuh bukti. Sumbernya **bukan** query service upstream —
layanan itu menolak nilai log NYX (bukti empiris lengkap di `docs/32` §32.8).
Yang menyajikan adalah `server/kt-query`, dan server NYX meneruskannya lewat
`/api/keys/kt/{search,distinguished,monitor,config}` (byte protobuf base64url
apa adanya; parser-nya ada di WASM, bukan di JS).

Fixture `web/src/lib/__tests__/fixtures/kt/query-*.pb` dihasilkan
`server/scripts/kt-query-fixtures.ts` melalui jalur itu, dan test ke-13–18
memverifikasinya dengan WASM sungguhan:

| Properti | Hasil |
|---|---|
| `GET /search` untuk nilai NYX v1 (1286 byte) | ✅ nilai kembali persis |
| Rotasi kunci **dengan anchor** dari bukti sebelumnya | ✅ `consistency` diverifikasi |
| `GET /distinguished` sebagai anchor pertama | ✅ berisi Unix detik |
| Nilai diubah di jalur produksi | ✅ ditolak (`KtVerificationError`) |

Satu perilaku yang **wajib** diingat pemanggil: klien harus mengirim ukuran
pohon yang sudah dipercayainya (`last`). Tanpa itu server tidak menyalakan bukti
konsistensi, dan verifikasi dengan anchor gagal sebagai `Malformed proof`
(temuan saat pertama kali menjalankan jalur hidup).

## 34.6a Integrasi jalur bundle (landed 2026-10-14)

Rencana awal di dokumen ini adalah op worker baru (`kt_verify_search`) yang
dipanggil dari `processPreKeyBundle`. Yang benar-benar dikerjakan **menyimpang
dari rencana itu**, dan alasannya teknis:

- verifikasi KT butuh **jaringan** (`/api/keys/kt/*`) dan **state tersimpan**
  (tree head, monitoring data, anchor distinguished) — dua hal yang tidak dimiliki
  worker crypto; memindahkannya ke worker berarti worker menyimpan state + memanggil
  `fetch`, padahal `docs/04` melarang memecah/menambah tanggung jawab jalur itu;
- jalur worker hanya punya `identityKey` bundle, tanpa username peer;
- verifikasi berjalan **sekali per peer** (di-cache), bukan per pesan, jadi biaya
  pindah thread tidak relevan.

Karena itu verifikasi hidup di thread utama, dan yang berubah di jalur bundle
hanyalah **titik keputusan pin**:

| Berkas | Peran |
|---|---|
| `web/src/lib/ktBundleProof.ts` | ambil bukti → verifikasi WASM → bandingkan kunci log dengan kunci bundle → **verdict** (`confirmed`/`mismatch`/`unverifiable`/`unavailable`/`unknown-subject`) |
| `web/src/lib/ktSubject.ts` | menurunkan username peer (search key `0x75‖Argon2id(username)`) dari profil E2EE: cache RAM → participant → dekripsi `encryptedProfile` percakapan → kontak |
| `web/src/lib/peerIdentityTrust.ts` | memanggil verifikasi **sebelum** memin kunci, mencatat `ktVerifiedAt`/`ktKeyVersion`/`ktMismatch` |
| `web/src/store/verification.ts` + `web/src/components/ChatWindow.tsx` | alert membawa `source: 'kt'` dan menampilkan copy khusus ("kunci bertentangan dengan log publik") |

Perilaku yang berubah (dan patut diingat):

1. **Kontak pertama pun bisa diblokir.** Dulu pin pertama selalu dipercaya (TOFU);
   sekarang bila bukti log sah tetapi berisi kunci LAIN, `trustedKey` tidak
   diperlakukan sebagai terverifikasi: gate kirim (`hasPendingPeerIdentityChange`)
   dan banner menyala sampai user memverifikasi safety number lewat jalur lain.
   **Inilah** kasus MITM terarah yang sebelumnya tak terdeteksi siapa pun.
2. **Verifikasi bukan prasyarat mutlak (fail-open yang terlihat).**
   `unavailable` (KT mati/jaringan), `unverifiable` (anchor basi/bukti ditolak),
   dan `unknown-subject` (username peer belum diketahui) **tidak** memblokir —
   masing-masing tercatat di baris pin (`ktLastVerdict`, `ktCheckedAt`) dan di log,
   karena memblokir pengiriman karena layanan mati akan membuat NYX tidak bisa
   dipakai. Hanya `mismatch` yang memblokir, dan itu hanya bisa dinyatakan oleh
   **bukti yang terverifikasi**.
3. **Batasan yang jujur:** username peer datang dari profil E2EE yang dibagikan
   peer, jadi peer yang belum pernah membagikan profil (tanpa kontak/percakapan)
   tetap `unknown-subject` → TOFU. Server tidak pernah menyediakan username
   plaintext (`docs/14`), dan itu memang disengaja.
4. **Biaya:** satu verifikasi = Argon2id (memory-hard) + 1–2 permintaan bukti
   (bisa puluhan KB) + WASM 295 KiB (dimuat sekali, impor dinamis). Hasil
   `confirmed` disimpan dengan TTL 24 jam (`KT_CONFIRMATION_TTL_MS`) sehingga
   pengamatan berulang tidak memanggil log lagi. Penurunan username yang **gagal**
   ditahan `KT_SUBJECT_MISS_RETRY_MS` (60 detik) supaya jalur pemrosesan pesan
   tidak mencoba dekripsi profil pada setiap pesan dari peer yang profilnya belum
   kita miliki; kegagalan layanan KT sendiri sudah punya backoff 5 menit di
   `ktBundleProof`.

Verifikasi: `peerIdentityTrust.test.ts` (+5 test: mismatch kontak pertama,
penerimaan user, TTL konfirmasi, sumber `kt` di daftar pending, unknown-subject),
`ktSubject.test.ts` (8 test: prioritas sumber + fail-open), dan — ditambahkan
2026-10-17 — `ktBundleProof.test.ts` (5 test integrasi yang memanggil
`checkBundleAgainstKeyTransparency` dengan bukti `search-v1.pb` dari kt-server
sungguhan + verifier WASM; yang dipalsukan hanya batas jaringan). Test terakhir
mengunci hal yang sebelumnya hanya diuji lewat primitif: `confirmed` + state
tersimpan, `mismatch` untuk bundle MITM, `unverifiable` saat `vrf_proof` diubah,
`unavailable` + backoff, dan `unknown-subject` tanpa panggilan jaringan.

## 34.6b Loop monitor (landed 2026-10-14)

Endpoint `/api/keys/kt/monitor`, op WASM `monitor_build`, dan penyimpanan state
tersimpan (`ktMonitoring`) sudah ada sejak 2026-10-13; yang ditambahkan sekarang
adalah **pemanggilnya**:

- `monitorKeyTransparency()` (`ktBundleProof.ts`) — jembatan ke jaringan: verifier
  + config + `POST /api/keys/kt/monitor` → `runKtMonitorOnce` (fail-closed).
- `startKtMonitorLoop()` (`ktMonitoring.ts`) — penjadwal: langkah pertama setelah
  jeda 30 detik, lalu setiap 6 jam; satu langkah pada satu waktu (timer berikutnya
  baru dipasang setelah langkah sebelumnya selesai), kegagalan tidak menghentikan
  loop, `stop()` aman dipanggil ganda.
- Wiring `web/src/App.tsx` (efek terpisah, aktif hanya bila `user && hasRestoredKeys`,
  impor dinamis sehingga WASM tidak masuk bundel awal); `keyVersion` yang naik
  memunculkan toast `chat:banners.kt_key_rotation` (4 bahasa).

9 test di `ktMonitoring.test.ts` (urutan penjadwalan, tidak menumpuk, tidak
berhenti saat gagal, pelaporan `changed`, dan tanpa state → tidak memanggil
jaringan). Loop ini tidak mengubah kunci yang dipercaya: hasilnya state baru +
notifikasi; keputusan blokir tetap di jalur pin (§34.6a). Setiap langkah juga
menyegarkan jangkar gossip lewat `GET /api/keys/kt/head` (§34.6c).

## 34.6 Sisa pekerjaan

1. ~~Integrasi ke jalur bundle~~ — **landed**, lihat §34.6a.
2. ~~Loop monitor + penjadwalan + notifikasi~~ — **landed**, lihat §34.6b.
   Catatan: loop baru punya data setelah verifikasi search pertama berhasil, dan
   verifikasi itu butuh username peer (§34.6a poin 3), jadi profil peer harus
   pernah terdekripsi.
3. ~~**Auditor + gossip**~~ — **landed 2026-10-14**, dan auditor **dioperasikan
   2026-10-16**: auditor pihak ketiga dilayani `server/kt-query/audit.go` (mode 3,
   `TreeSize`/`Audit`/`SetAuditorHead` lewat verifikasi upstream), proses auditornya
   adalah `server/kt-query/cmd/nyx-kt-auditor` (port Go dari auditor referensi
   Signal, unit `ops/systemd/nyx-kt-auditor.service`), dan gossip tree head hidup di
   `ktGossip.ts` (§34.6c). Sisa yang jujur: interop `cmd/kt-client` upstream tetap
   tidak dijalankan (`package main`, tidak di-vendor) — perannya diambil
   `nyx-kt-check`; pelaksanaan dua auditor (Java referensi vs port ini) berdampingan
   juga belum; dan auditor berjalan di host yang sama dengan log.
4. **Degradasi terlihat** — bila KT mati: klien jalan dengan TOFU; verdict-nya
   tersimpan di baris pin (`ktLastVerdict`) dan setiap permintaan bukti dihitung
   di `nyx_kt_queries_total{result="disabled"|"error"}`. **Tidak ada banner**
   "verifikasi kunci tidak tersedia" — yang tampil ke user hanya toast rotasi
   kunci; banner diagnostik adalah pekerjaan UI, bukan perilaku yang sudah ada.
5. **Rollback** — jalur nyatanya adalah **mengosongkan `KT_QUERY_URL`**: endpoint
   `/api/keys/kt/*` menjawab 503 dan setiap verdict menjadi `unavailable` (TOFU),
   tanpa perubahan kode klien. Kapabilitas `KT_LITE` di
   `packages/shared/src/transport.ts` **dideklarasikan tetapi tidak pernah
   diiklankan/dibaca** — dulu disebut gerbang rollback di sini, nyatanya bukan.
6. **Verifikasi E2E jalur KT** — tidak bisa dijalankan di suite E2E NYX (butuh
   layanan `nyx-kt-query` + penulis log hidup; dengan `KT_QUERY_URL` kosong,
   setiap verdict `unavailable` dan pin tetap TOFU). Yang bisa diverifikasi
   sekarang: unit/properti (**60 test**: `keyTransparency.test.ts` 12,
   `ktGossip.test.ts` 17, `peerIdentityTrust.test.ts` 14, `ktMonitoring.test.ts` 9,
   `ktSubject.test.ts` 8) + jalur hidup manual (`docs/32` §32.8).

## 34.6c Auditor + gossip (landed 2026-10-14)

**Auditor pihak ketiga (mode 3).** Log NYX berjalan `ContactMonitoring` selama
belum ada auditor: bukti yang disajikan memuat byte tanda tangan auditor, tetapi
nol auditor head berarti tidak ada yang memeriksanya. Yang ditambahkan:
`server/kt-query` menyajikan layanan auditor upstream di listener terpisah
(`NYX_KT_AUDITOR_ADDR`, default `127.0.0.1:8082`) — `TreeSize`, `Audit`, dan
`SetAuditorHead`. Verifikasi tanda tangan **bukan** milik kami: `SetAuditorHead`
meneruskan ke `tree.SetAuditorHead` upstream, jadi aturan kriptonya identik dengan
Signal. Nama auditor dibawa di metadata `x-nyx-auditor-name` (deployment loopback
tanpa mTLS); kunci publiknya tetap dari `api.auditors` di config, dan nama tak
terkonfigurasi ditolak lebih awal (`PermissionDenied`). `audit_test.go`
menunjukkan inti mode 3: verifier upstream **menolak** bukti "auditor tree head not
provided" sebelum ada head, dan **menerima** sesudahnya; tanda tangan yang diubah,
kunci penyerang, dan mode bukan third-party semuanya ditolak.

**Auditor nyatanya (2026-10-16).** Proses yang mengirim `SetAuditorHead` ada di
repo ini, bukan di pihak ketiga: `server/kt-query/cmd/nyx-kt-auditor` (Go) — port
baris-per-baris `org.signal.keytransparency.audit.{Auditor,CondensedPrefixTree,
CondensedLogTree}` dari `signalapp/key-transparency-auditor` (AGPL-3.0, auditor
referensi Signal). Ia mengambil `/config` untuk kunci publik log, memverifikasi
aliran `Audit` (root prefix tree lama harus cocok sebelum update diterima, daun
pohon log ditambahkan, root dihitung ulang), menandatangani tree head dengan
`transparency.SignNewAuditorHead` upstream, lalu menyimpan state bertanda tangan
ed25519 — **hanya setelah** `SetAuditorHead` sukses, dan **berhenti menandatangani**
saat menemukan inkonsistensi. Yang membuktikannya: vektor resmi Signal
(`testdata/katie_test_vectors.pb`) — 10 update sukses (root hash pohon log cocok
tiap langkah), lima vektor gagal, tanda tangan byte-per-byte — plus test unit
pohon/state/runner, dan jalur hidup di self-host (mode 3: bukti ditolak sebelum
head auditor pertama, diterima sesudahnya). Detail: `server/kt-query/README.md`,
`docs/30` §30.5 tahap C.

**Gossip tree head.** Split-view (log menyajikan pohon berbeda ke klien berbeda)
tidak bisa dideteksi satu klien sendirian — masing-masing konsisten dengan
dirinya. `ktGossip.ts` menutupnya tanpa jalur data baru: jangkar `(treeSize,
root)` ikut di **payload ter-seal** (field `ktG`, sebagaimana `ackV`), dibaca dari
payload yang sudah lolos AEAD, lalu dibandingkan dengan jangkar lokal. Aturannya
satu fakta yang tidak butuh bukti tambahan: untuk satu `treeSize`, pohon hanya
punya satu root → ukuran sama + root beda = **split-view** (toast
`chat:banners.kt_split_view` di 4 bahasa); ukuran berbeda hanya dicatat
(`peer-ahead`/`peer-stale`) dan **tidak** dipakai menyimpulkan apa pun tanpa bukti
konsistensi. Root diambil dari `GET /api/keys/kt/head` (JSON kecil dari
`kt-query`): root tidak bisa dibaca dari byte `FullTreeHead` tanpa parser
protobuf, dan parser protobuf hanya boleh di WASM (`§34.2`). State (jangkar +
head peer per sesi) disimpan ter-seal `ENC1:` di Dexie **v13** (`ktGossip`, satu
baris), dimuat saat app siap, dan dibersihkan `executeLocalWipe`. 17 test
(`ktGossip.test.ts`) termasuk payload peer yang rusak, dedup tulis, batas 64 peer,
head peer yang lebih tua/lebih baru, dan fail-open saat tabel tidak ada.

## 34.7 Privasi

Verifier tidak menambah data yang dikirim ke server: ia hanya memverifikasi byte
yang sudah ada. Search key tetap `0x75 || usernameHash(32)` (memory-hard), tanpa
userId/IP di nilai log maupun di permintaan verifikasi (audit `privacy-dump-audit.ts`
tidak terpengaruh).
