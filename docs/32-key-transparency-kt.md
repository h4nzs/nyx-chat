# 32 — Key Transparency (KT): penulis log NYX

> **Status: sisi tulis + sisi baca landed (2026-10-13); integrasi klien belum.**
> Sisi **penulis** (server → log) berjalan dan terverifikasi terhadap binary Go
> `key-transparency-server` yang sesungguhnya
> (`server/tests/keyTransparency.test.ts`). Sisi **baca** ada di
> `server/kt-query` (§32.8) — pemilik tunggal basis data, penyaji bukti untuk
> search/monitor/distinguished — dan **proxy-nya** di `/api/keys/kt/*`. Sisi
> **verifier klien** ada di `packages/keytrans-wasm` + `web/src/lib/keyTransparency.ts`
> dan sudah memverifikasi bukti dari jalur produksi ini (`docs/34`). Yang
> **belum**: pemanggilan verifier di jalur bundle, loop monitor otomatis, dan
> auditor/`SetAuditorHead` (`docs/34` §34.6). Selama itu berjalan, log menyediakan
> **bukti inklusi + jejak audit**, bukan jaminan anti-rollback/anti-MITM penuh.

Pin referensi (§30.2): `key-transparency-server` commit `30b7a2a40604`,
`libsignal/rust/keytrans` `e8cc2dddd578`.

## 32.1 Yang TIDAK diubah

Logika KT dipakai **apa adanya**: tidak ada perubahan protokol, tidak ada fork.
Yang NYX tambahkan hanya cara mengisi log, nilai yang ditulis, dan (**§32.8**)
cara membaca bukti.

> **Amandemen 2026-10-13 — siapa yang menjalankan basis data.** Kalimat asli
> bagian ini berbunyi "server KT dipakai apa adanya; yang dijalankan adalah
> binary `kt-server` upstream". Itu tidak bisa dipertahankan: query service
> upstream menolak nilai log NYX (§32.8 temuan 1), dan LevelDB tidak bisa dibagi
> dua proses (§32.8 temuan 2). Sejak sekarang **proses pemilik basis data KT
> adalah `nyx-kt-query`** (`server/kt-query`, Go) — binary upstream tidak lagi
> dijalankan. Kode pohon, VRF, commitment, dan penyimpanan **tetap** dari paket
> upstream yang di-pin; yang jadi milik NYX hanyalah dua pembungkus tipis
> (penulis log di TS, penyaji bukti di Go). Protokol tulis **tidak berubah**:
> `KT_SERVER_URL` penulis tetap menunjuk `KeyTransparencyTestService.Update`.

Fakta yang diverifikasi langsung di kode server (bukan asumsi):

| Fakta | Lokasi |
|---|---|
| Tipe search key `UsernameHashPrefix = 'u'` (0x75) sudah ada | `cmd/shared/constants.go`, dipakai di `cmd/kt-server/util.go:205` |
| Panjang search key tidak dibatasi; validasi hanya byte pertama | `cmd/kt-server/util.go:195` |
| `Update` adalah **test service** (bukan query service) | `cmd/kt-server/pb/key_transparency_test.proto`, didaftarkan di `main.go:281` |
| Update duplikat → server mengembalikan `(nil, nil)` (sukses senyap) | `cmd/kt-server/kt_update_handler.go` (`ErrDuplicateUpdate`) |
| `consistency` **wajib hadir** (boleh kosong) | error live: `invalid argument for field consistency: consistency cannot be nil` |
| Backend default: LevelDB lokal | `db/leveldb.go` |

Konsekuensi: search key NYX = `0x75 || usernameHash(32 byte)`, dan karena
`usernameHash` adalah keluaran Argon2id 64 MB (bukan nomor telepon), log **tidak
menjadi kamus baru**.

## 32.2 Nilai log (format NYX v1, FROZEN)

```
offset  size   field
0       1      version            = 0x01
1       1      keyVersion         1 = pendaftaran, 2 = pemulihan akun
2       32     identityKey        X25519 (base64url 32 byte)
34      1216   pqIdentityKey      ML-KEM-768
1250    32     signingKey         Ed25519
1282    4      updatedAtDay       uint32 big-endian, hari sejak epoch
------------------------------------------------------------
total   1286 byte
```

Tidak ada userId, IP, nama, atau metadata perangkat. Nilai ditulis kanonik
(urutan field tetap) supaya dua penulisan bermakna sama menghasilkan byte sama —
itu yang membuat dedupe & audit mungkin.

Kode: `server/src/utils/keyTransparency.ts` (`encodeKtValue`/`decodeKtValue`,
`KT_VALUE_V1_BYTES`), diuji round-trip + penolakan panjang salah.

## 32.3 Transport (tanpa dependensi baru)

`transparency.UpdateRequest` dikodekan **tangan** (protobuf minimal) dan dikirim
sebagai unary gRPC lewat `node:http2`:

- `:path = /kt_test.KeyTransparencyTestService/Update`
- `content-type: application/grpc+proto`, framing 5 byte (flag + panjang BE)
- status dibaca dari **header maupun trailer** (`grpc-status`, `grpc-message`
  di-`decodeURIComponent`)

Alasan tidak memakai `@grpc/grpc-js`: satu unary call dengan tiga field tidak
sebanding dengan menambah dependensi gRPC/protobuf di server yang harus tetap
kecil (kebiasaan dari era VPS 1 core/1 GB — spesifikasi sekarang di `docs/10`
§10.1).

`consistency` **selalu dikirim** (boleh kosong) karena server menolak `nil` —
temuan ini datang dari test live, bukan dari dokumen.

## 32.4 Titik tulis

| Alur | Kapan | keyVersion | Lokasi |
|---|---|---|---|
| Registrasi | setelah `prisma.user.create` sukses | 1 | `server/src/routes/auth.ts` (`publishKeyTransparencyEntry`) |
| Pemulihan akun | setelah transaksi device baru | 2 | `server/src/routes/auth.ts` (`/recover`) |

Sifat yang dijaga:

- **Idempoten** — dedupe in-memory (`searchKey, keyVersion, digest nilai`).
  Digest nilai ikut dihitung supaya **perubahan kunci tetap ditulis** walau
  versinya sama (dua pemulihan berturut-turut); ini diuji eksplisit.
- **Fail-visible, tidak memblokir** — kegagalan TIDAK menggagalkan registrasi
  (ketersediaan), tetapi dihitung di `nyx_kt_writes_total{result}` + di-log
  dengan search key ter-hash. Dashboard/alert menangkapnya (§32.6).
- **Nonaktif secara default** — tanpa `KT_SERVER_URL`, modul no-op.
- **Bentuk tidak sah dilewati** — mis. `usernameHash` bukan 32 byte
  (`updatedAtDay` memakai bucket harian `dayBucket()`, presisi detik tidak masuk).

### 32.4b Bentuk identifier yang WAJIB dikirim klien (2026-10-15)

Search key log adalah `0x75 || Argon2id(username)` (32 byte). Server **tidak bisa**
menurunkannya dari blind index ter-pepper (64 hex = `HMAC(pepper, …)`, satu arah),
jadi klien harus mengirim bentuk Argon2id-nya. Ini penting khusus di **pemulihan
akun**, karena pemulihan menukar kunci identitas — tepat peristiwa yang harus
terlihat di log:

| Yang dikirim klien | Hasil |
|---|---|
| Argon2id 32 byte base64url (`hashUsername(username)`) | entri ditulis (keyVersion 2) |
| Hash ID ter-pepper 64 hex (yang ditampilkan/dibagikan server) | **entri dilewati** — dihitung `nyx_kt_writes_total{result="unsupported_identifier"}` |
| Bentuk rusak lain (panjang/alfabet salah) | dilewati — `result="invalid"` |

Klien sudah menormalkan masukan halaman pemulihan
(`resolveRecoveryIdentifierInput`): hash ID dikirim apa adanya, sedangkan username
di-hash Argon2id lebih dulu. Dua hasil "dilewati" itu sengaja **dipisah** di
metrik supaya pemulihan yang kehilangan jejak log terlihat sebagai kejadian
sendiri, bukan tercampur dengan input cacat.

## 32.5 Env

| Var | Arti | Default |
|---|---|---|
| `KT_SERVER_URL` | endpoint gRPC test-update (mis. `http://127.0.0.1:8081`) | kosong = nonaktif |
| `KT_TIMEOUT_MS` | timeout unary call | `5000` |

Deployment (sejak 2026-10-13, lihat §32.8): **`nyx-kt-query`** dijalankan
berdampingan `nyx-api`; ia yang memegang LevelDB lokal dan menyajikan sisi tulis
gRPC **maupun** sisi baca HTTP — keduanya di loopback (`server/kt-query/README.md`
memuat flag/env lengkap). Server NYX diarahkan lewat `KT_QUERY_URL` untuk baca dan
`KT_SERVER_URL` untuk tulis. Snapshot LevelDB → R2 harian tetap **residual**:
kunci snapshot ada di box, sama seperti catatan `docs/30` §30.5.

## 32.6 Observability

| Metrik | Arti |
|---|---|
| `nyx_kt_writes_total{result="ok"\|"error"\|"invalid"\|"unsupported_identifier"}` | penulisan log per hasil (`unsupported_identifier` = identifier bukan bentuk Argon2id 32 byte, mis. hash ID ter-pepper — §32.4b) |
| `nyx_kt_last_success_timestamp_seconds` | Unix timestamp penulisan sukses terakhir (lag) |

Alert (`ops/prometheus/alerts.yml`):
`NyxKeyTransparencyWriteFailing` (ada error dalam 15 menit) dan
`NyxKeyTransparencyStalled` (ada error dalam 1 jam **dan** tidak ada sukses
dalam 1 jam). Keduanya tidak menyala pada instance sepi.

## 32.7 Residual (jujur)

1. ~~**Verifier klien belum ada.**~~ **Sudah ada (2026-10-13)**: Spike-1 berhasil
   (`libsignal/rust/keytrans` → WASM, nol import) dan verifier klien + 12 test
   berbasis bukti nyata dari kt-server ada di `docs/34`. Yang **masih** tersisa
   dari poin ini: pemanggilan verifier di jalur bundle (`processPreKeyBundle`)
   dan **loop monitor** yang otomatis (`verify_monitor` + `monitorStep` + endpoint
   server), plus temuan penting di `docs/34` §34.5: tanpa anchor yang tersimpan,
   perubahan `search`/tree head tidak terdeteksi — jadi monitor bukan opsional.
2. **`keyVersion` masih konstanta alur** (1 registrasi, 2 pemulihan), bukan
   penghitung yang naik per rotasi kunci. Cukup untuk dedupe, belum cukup untuk
   menyimpulkan urutan versi dari log saja.
3. **Update service = test service.** Signal memakai alur provisioning sendiri
   untuk menulis log; NYX memakai endpoint test yang disediakan repo (dan
   melabelinya sebagai test di log server). Alternatif jangka panjang: penulis
   gRPC internal terpisah dengan otorisasi sendiri.
4. **Rantai audit/auditor belum dipasang.** `SetAuditorHead` + auditor pihak
   ketiga (atau auditor self-host terpisah) belum dijalankan; tanpa auditor,
   "log" masih bisa di-rewrite oleh operator.
5. **`/recover` dengan identifier ter-pepper** tidak bisa menurunkan search key
   (server tidak bisa membalik pepper) → entri dilewati dengan peringatan. Klien
   yang mengirim Argon2id mentah 32 byte aman.

## 32.8 Sisi baca: `nyx-kt-query` (2026-10-13)

Sebelum ini NYX **hanya menulis** log. Menyediakan sisi baca ternyata tidak bisa
memakai query service upstream, dan tidak bisa dijalankan sebagai proses kedua.
Dua temuan itu (keduanya dari pengujian, bukan pembacaan dokumen) menentukan
bentuk layanan baru `server/kt-query`.

### Temuan 1 — query service upstream tidak bisa melayani nilai log NYX

Dijalankan terhadap binary Go yang sesungguhnya (`kt-server`, config test),
dengan UUID/ACI dan usernameHash yang dikendalikan:

```
== A) SEARCH tanpa entri ACI di log (kondisi log NYX hari ini) ==
search permission denied
== B) SEARCH dengan nilai format Signal 0x00||aci16 ==
ACI search response:            Value: 1111…(identity key)
Username hash search response:  Value: 1111…(aci16)
== C) tulis nilai format NYX (1286 B) ke search key yang sama ==
NYX entry written: {"treeSize":"4","vrfProofLength":80,"hasUpdateProof":true}
== D) SEARCH setelah nilai format NYX ==
search request: rpc error: code = Unavailable desc = unexpected error
```

Sebabnya di `cmd/kt-server/kt_query_handler.go`: `aciSearch()` **wajib** dan
mengembalikan `PermissionDenied` bila entri `'a'||aci` tidak ada, lalu
`usernameHashSearch()` menolak nilai apa pun yang bukan `0x00||aci16` — dan
bukan sekadar tidak menjawab, tapi `errInternal` yang menggagalkan **seluruh**
`SearchV2` (langkah D). `MonitorV2` juga memakai `req.Aci` sebagai kunci pertama,
sedangkan NYX tidak punya ACIs.

### Temuan 2 — LevelDB tidak bisa dibagi dua proses

Rencana awal: buka basis data yang sama secara **read-only** di samping
`kt-server`. Gagal:

```
buka read-only di samping penulis: resource temporarily unavailable
```

`leveldb/storage.newFileLock(path, readOnly=true)` mengambil **`LOCK_SH`** di
level OS, sedangkan penulis memegang **`LOCK_EX`**. goleveldb memang melepas
kunci *in-process*-nya saat read-only (`fileStorage.Lock()` mengembalikan kunci
no-op) dan memutar ulang journal (`recoverJournalRO`) sehingga akan melihat
tulisan terbaru — tapi flock tidak dilepas, jadi dua handle tetap bentrok.
Regresi ini dijaga tes `TestLevelDBTidakBisaDibagiDuaProses`.

### Yang dibangun

`server/kt-query` — **satu proses yang memiliki basis data** dan menyajikan tiga
peran sekaligus (detail operasional: `server/kt-query/README.md`):

| Peran | Endpoint / protokol |
|---|---|
| Baca bukti (NYX) | `GET /search`, `GET /distinguished`, `POST /monitor`, `GET /config` — framing `u32 len ‖ FullTreeHead ‖ u32 len ‖ CondensedTreeSearchResponse` |
| Tulis (kompatibel penulis lama) | gRPC `KeyTransparencyTestService.Update` — `KT_SERVER_URL` penulis **tidak berubah** |
| Kunci `distinguished` | timestamp Unix, interval `api.distinguished` |

Keputusan desain yang penting untuk pembaca berikutnya:

- **Search key dibatasi** ke `0x75||hash(32)` dan `distinguished`. Layanan ini
  bukan oracle pencarian bebas untuk namespace Signal lain.
- **Tidak ada parsing protobuf di JS**: server NYX hanya meneruskan byte
  base64url; parser dan verifikasi ada di WASM `libsignal-keytrans`.
- **Pohon dibangun per permintaan** dari store yang sama (pola query handler
  upstream), sehingga head yang disajikan selalu yang terbaru — penting justru
  karena proses ini juga yang menulis.
- **Update diserialkan satu mutex**; update duplikat dijawab `(nil, nil)` seperti
  upstream supaya penulis yang mengulang entri (setelah restart) tetap idempoten.
- **Konsistensi hanya diminta bila klien mengirim `last`/`distinguished`.**
  Temuan saat menjalankan jalur hidup: tanpa itu, bukti rotasi kunci **tidak**
  bisa diverifikasi terhadap anchor sebelumnya (`Malformed proof`) — jadi klien
  wajib mengirim ukuran pohon yang sudah dipercayainya.

### Bukti (bukan klaim)

| Bukti | Cara |
|---|---|
| 18 test Go hijau (termasuk `VerifySearch`/`VerifyMonitor` upstream atas nilai NYX 1286 byte) | `server/kt-query/build.sh test` |
| Jalur hidup: penulis TS → adapter → HTTP → verifier libsignal | `server/scripts/kt-query-fixtures.ts` + `web/src/lib/__tests__/keyTransparency.test.ts` (**18 test**, termasuk rotasi kunci dengan anchor dan `monitor_build`) |
| Proxy server NYX + metrik + degradasi terlihat | `server/tests/ktQuery.test.ts` (13 test) |

### Sisa yang jujur

1. ~~**Loop monitor klien belum jalan.**~~ **Sudah jalan (2026-10-14)**: ABI WASM
   punya `monitor_build`/`verify_monitor`, state disimpan `ktMonitoring` (ter-seal),
   dan penjadwal `startKtMonitorLoop` berjalan di app shell — lihat `docs/34`
   §34.6b. Catatan: loop hanya punya data setelah verifikasi search pertama
   berhasil (butuh username peer).
2. **Auditor pihak ketiga belum dioperasikan** — kode sudah ada dan teruji
   (`server/kt-query/audit.go`, mode 3, `SetAuditorHead`), tetapi belum ada proses
   auditor yang mengirim tanda tangannya, jadi byte auditor di bukti masih tidak
   diperiksa di lapangan (`docs/34` §34.6 poin 3).
3. **`keyVersion` masih konstanta alur** (§32.7 poin 2).
4. ~~**Snapshot LevelDB → R2**~~ **Sudah ada (2026-10-14)**: `kt-query/snapshot.go`
   membuat arsip harian **terverifikasi** (tree head + root salinan dibandingkan
   dengan pohon hidup) dan `server/src/jobs/ktSnapshot.ts` mengunggahnya ke R2
   dengan retensi 30 hari. **Sisa:** menjalankan di VPS (direktori + kredensial)
   dan membuktikan pemulihan dari arsip.
