# 34 — Verifier Key Transparency di klien

> **Status: verified-search landed + teruji terhadap bukti nyata, termasuk dari
> jalur baca produksi (2026-10-13); integrasi jalur bundle + loop monitor
> landed (2026-10-14).** Modul WASM (`packages/keytrans-wasm`, kompilasi
> `libsignal-keytrans`), pembungkus klien (`web/src/lib/keyTransparency.ts`),
> pemakai produksinya (`web/src/lib/ktBundleProof.ts`,
> `web/src/lib/ktSubject.ts`, `web/src/lib/ktMonitoring.ts`), dan **18 test**
> verifier — 12 berbasis `UpdateResponse` binary Go, 4 berbasis bukti dari
> `server/kt-query` (`docs/32` §32.8), termasuk rotasi kunci terhadap anchor bukti
> sebelumnya. Bundle peer kini **diverifikasi terhadap log sebelum dipin**
> (§34.6a), dan loop monitor dijalankan penjadwal (§34.6b). Yang **belum**: auditor
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
   (third-party auditing) + `SetAuditorHead`.
2. **`condense_update` mengandalkan kompatibilitas wire** antara server
   `transparency.proto` dan `signal.keytrans` (field 1–4 sama). Itu diuji lewat
   fixture nyata, tetapi kalau server mengubah tata letak field, test ini yang
   akan menangkapnya.
3. **`keyVersion` masih konstanta alur** (1 registrasi, 2 pemulihan) seperti
   dicatat `docs/32` §32.7 — cukup untuk dedupe & mendeteksi perubahan, belum
   cukup untuk menyimpulkan urutan versi dari log saja.
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
penerimaan user, TTL konfirmasi, sumber `kt` di daftar pending, unknown-subject)
dan `ktSubject.test.ts` (7 test: prioritas sumber + fail-open).

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

7 test baru di `ktMonitoring.test.ts` (urutan penjadwalan, tidak menumpuk, tidak
berhenti saat gagal, pelaporan `changed`, dan tanpa state → tidak memanggil
jaringan). Loop ini tidak mengubah kunci yang dipercaya: hasilnya state baru +
notifikasi; keputusan blokir tetap di jalur pin (§34.6a).

## 34.6 Sisa pekerjaan

1. ~~Integrasi ke jalur bundle~~ — **landed**, lihat §34.6a.
2. ~~Loop monitor + penjadwalan + notifikasi~~ — **landed**, lihat §34.6b.
   Catatan: loop baru punya data setelah verifikasi search pertama berhasil, dan
   verifikasi itu butuh username peer (§34.6a poin 3), jadi profil peer harus
   pernah terdekripsi.
3. **Auditor + gossip** — mengaktifkan mode 3, `SetAuditorHead`, dan bertukar
   tree head lewat slot metadata pesan yang sudah ada, sesuai `docs/30` §30.5
   tahap C. Ini juga yang membuat byte tanda tangan auditor benar-benar diperiksa
   (§34.5 residual 1).
4. **Degradasi terlihat** — bila KT mati: klien jalan dengan TOFU + banner
   "verifikasi kunci tidak tersedia" (fail-visible, tercatat di metrik). Baris
   pin sudah menyimpan `ktLastVerdict`, sehingga UI diagnostik bisa dibuat dari
   data itu tanpa menyentuh jalur kripto.
5. **Rollback** — kapabilitas `KT_LITE` di `packages/shared/src/transport.ts`
   sudah jadi gerbang minimum; menghapus jalur KT tidak mengubah perilaku klien
   lama (semua pemanggil memperlakukan verdict non-`mismatch` sebagai TOFU).
6. **Verifikasi E2E jalur KT** — tidak bisa dijalankan di suite E2E NYX (butuh
   layanan `nyx-kt-query` + penulis log hidup; dengan `KT_QUERY_URL` kosong,
   setiap verdict `unavailable` dan pin tetap TOFU). Yang bisa diverifikasi
   sekarang: unit/properti (**50 test** di `keyTransparency.test.ts` 18,
   `ktMonitoring.test.ts` 11, `peerIdentityTrust.test.ts` 14, `ktSubject.test.ts` 7)
   + jalur hidup manual (`docs/32` §32.8).

## 34.7 Privasi

Verifier tidak menambah data yang dikirim ke server: ia hanya memverifikasi byte
yang sudah ada. Search key tetap `0x75 || usernameHash(32)` (memory-hard), tanpa
userId/IP di nilai log maupun di permintaan verifikasi (audit `privacy-dump-audit.ts`
tidak terpengaruh).
