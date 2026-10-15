# `nyx-kt-query` — layanan Key Transparency NYX (baca + tulis)

> Status: **landed & teruji** (2026-10-13; auditor + gossip + snapshot 2026-10-14).
> **31 test Go**, semuanya hijau; bukti yang disajikannya diverifikasi verifier
> libsignal yang sebenarnya lewat modul WASM
> (`web/src/lib/__tests__/keyTransparency.test.ts`). Lihat `docs/32` §32.8,
> `docs/34` §34.6c, dan `docs/10` §10.15 (deploy/ops service ini).

## Kenapa ada

Dua temuan dari pengujian — bukan dugaan — menentukan bentuk layanan ini.

1. **Query service upstream tidak bisa melayani nilai log NYX.**
   `aciSearch()` wajib punya entri `'a'||aci`, dan `usernameHashSearch()` menolak
   nilai apa pun yang bukan `0x00||aci16` (bahkan menggagalkan seluruh
   `SearchV2` dengan error internal). Log NYX hanya berisi `'u'||hash` dengan
   nilai 1286 byte format NYX v1:

   ```
   == A) SEARCH tanpa entri ACI di log (kondisi log NYX) ==
   search permission denied
   == B) SEARCH dengan nilai format Signal 0x00||aci16 ==
   ACI search response:            Value: 1111…(identity key)
   Username hash search response:  Value: 1111…(aci16)
   == C) tulis nilai format NYX (1286 B) ke search key yang sama ==
   NYX entry written: {"treeSize":"4","vrfProofLength":80,"hasUpdateProof":true}
   == D) SEARCH setelah nilai format NYX ==
   search request: rpc error: code = Unavailable desc = unexpected error
   ```

2. **LevelDB tidak bisa dibagi dua proses.** Rencana awal — membuka basis data
   yang sama secara read-only di samping `kt-server` — gagal:
   `storage.newFileLock(readOnly=true)` mengambil `LOCK_SH` di level OS sedangkan
   penulis memegang `LOCK_EX`. goleveldb hanya melepas kunci *in-process*-nya saat
   read-only, bukan flock-nya:

   ```
   buka read-only di samping penulis: resource temporarily unavailable
   ```

Karena itu **satu proses memiliki basis data**, dan proses itu adalah layanan
ini. Ia menyajikan tiga hal sekaligus:

| Peran | Detail |
|---|---|
| Sisi baca NYX | `GET /search`, `GET /distinguished`, `POST /monitor`, `GET /config` — search key `0x75||usernameHash(32)`, nilai NYX v1 apa adanya |
| Sisi tulis | `KeyTransparencyTestService.Update` (gRPC) — **protokol yang sama** dengan yang sudah dipakai `server/src/utils/keyTransparency.ts`, jadi `KT_SERVER_URL` penulis tidak berubah |
| Kunci `distinguished` | timestamp Unix, diperbarui tiap `api.distinguished` (anchor klien sebelum mengenal kontak) |
| Layanan auditor (mode 3) | gRPC `KeyTransparencyAuditorService` di listener terpisah (`-auditor-addr`, default `127.0.0.1:8082`): `TreeSize`, `Audit`, `SetAuditorHead` — verifikasi tanda tangan memakai kode upstream |
| Snapshot harian | arsip `tar.gz` **terverifikasi** dari basis data (`-snapshot-dir`): penulisan dijeda, salinan dibuka ulang, tree head + root-nya dibandingkan dengan pohon hidup sebelum diarsipkan |

Yang **tidak** diubah: nilai log (`docs/32` §32.2, frozen), bentuk bukti
(protobuf upstream), dan primitif kripto. Pohon, VRF, commitment, dan
penyimpanan semuanya dari paket upstream (`tree/transparency`, `db`) yang di-pin.

## Bangun

Modul ini bergantung pada paket dari repo upstream yang **privat**, jadi paket
itu **ter-vendor penuh** di `vendor/github.com/signalapp/keytransparency`
(dihasilkan `go mod vendor` dari checkout upstream pada pin `docs/32` §32.1:
commit `30b7a2a40604`). `go.mod` tidak memuat directive `replace`, jadi build
tidak menyentuh jaringan maupun checkout di luar repo:

```bash
# build (default: -mod=vendor)
server/kt-query/build.sh

# jalankan vet + test
server/kt-query/build.sh test

# mode "kejar pin" — pakai checkout lokal dulu, sebelum re-vendor
NYX_KT_UPSTREAM=/path/ke/key-transparency-server server/kt-query/build.sh
```

Perbarui sink saat pin naik: jalankan `scripts/vendor-signal.sh` (mengecek
commit pin), lalu dari direktori ini
`NYX_KT_UPSTREAM=~/signal/key-transparency-server go mod vendor` untuk pin baru —
selama `replace` tidak ada di `go.mod`, perintah itu perlu `go mod edit -replace`
sementara; `build.sh` dengan `NYX_KT_UPSTREAM` melakukan hal yang sama untuk
sekadar membangun. Setelah `vendor/` tergenerasi ulang, commit `go.mod`,
`go.sum`, dan `vendor/` bersama-sama.

## Jalankan

```bash
nyx-kt-query \
  -config /etc/nyx/kt/test_config.yaml \
  -read-addr 127.0.0.1:8085 \
  -write-addr 127.0.0.1:8081 \
  -distinguished 1m
```

| Flag | Env | Default | Arti |
|---|---|---|---|
| `-config` | `KT_CONFIG_FILE` | `test_config.yaml` | config YAML yang sama dengan penulis (kunci log + `db.file`) |
| `-read-addr` | `NYX_KT_QUERY_ADDR` | `127.0.0.1:8085` | HTTP baca — **loopback**, proxy ada di server NYX |
| `-write-addr` | `NYX_KT_WRITE_ADDR` | `127.0.0.1:8081` | gRPC test-update (samakan dengan `KT_SERVER_URL` penulis) |
| `-auditor-addr` | `NYX_KT_AUDITOR_ADDR` | `127.0.0.1:8082` | gRPC layanan auditor pihak ketiga; kosong = nonaktif |
| `-db` | — | dari config | override `db.file` |
| `-distinguished` | — | `api.distinguished` | interval kunci distinguished; `0` = nonaktif |
| `-snapshot-dir` | `NYX_KT_SNAPSHOT_DIR` | — | direktori arsip snapshot; kosong = snapshot nonaktif |
| `-snapshot-interval` | `NYX_KT_SNAPSHOT_INTERVAL` | `24h` | jeda antar snapshot |
| `-snapshot-keep` | `NYX_KT_SNAPSHOT_KEEP` | `7` | jumlah arsip terakhir yang disimpan lokal |
| `-check` | — | — | buka basis data, bangun pohon, lalu keluar (health check deploy) |

Sisi server NYX diarahkan lewat `KT_QUERY_URL` (mis.
`http://127.0.0.1:8085`); tanpa itu endpoint `/api/keys/kt/*` menjawab 503
`KT_QUERY_DISABLED` — degradasi yang terlihat, bukan TOFU senyap.

## API baca

Semua jawaban sukses berisi protobuf mentah (klien tidak memakai JSON untuk
bukti; parser-nya ada di WASM):

| Endpoint | Permintaan | Jawaban |
|---|---|---|
| `GET /search` | `hash=<b64url 32B>` **atau** `key=<b64url>`, `last=<n>`, `distinguished=<n>` | `u32 len ‖ FullTreeHead ‖ u32 len ‖ CondensedTreeSearchResponse` |
| `GET /distinguished` | `last`, `distinguished` | seperti `/search` (search key `distinguished`) |
| `POST /monitor` | body = `transparency.MonitorRequest` | `transparency.MonitorResponse` |
| `GET /config` | — | kunci publik log (mode, `signatureKey`, `vrfKey`, `auditorKeys`) |
| `GET /head` | — | `{treeSize, timestamp, root}` — jangkar **gossip** antar-klien (bukan bukti; root tidak bisa dibaca dari `FullTreeHead` tanpa parser protobuf, dan parser itu hanya hidup di WASM) |
| `GET /healthz` | — | `{treeSize, timestamp}` |

Kode error: `NOT_FOUND` (search key tidak ada di log — dibedakan dari layanan
mati), `INVALID_ARGUMENT`, `UNAVAILABLE`, `INTERNAL`, `METHOD_NOT_ALLOWED`.

Pembatasan yang disengaja: search key **hanya** `0x75||hash(32)` atau
`distinguished` — layanan ini bukan oracle pencarian bebas untuk namespace
Signal lain. Monitor dibatasi 64 kunci per permintaan.

## Verifikasi

```bash
# test unit + integrasi (dari vendor/ — tidak butuh checkout upstream)
server/kt-query/build.sh test
```

Langkah jalur hidup yang dipakai saat landed (dan bisa diulang):

```bash
# siapkan config dengan db.file menunjuk ke direktori kosong, lalu:
nyx-kt-query -config /tmp/nyx-kt-query/test_config.yaml &
cd server
KT_CONFIG_FILE=/tmp/nyx-kt-query/test_config.yaml \
KT_QUERY_URL=http://127.0.0.1:8085 \
KT_SERVER_URL=http://127.0.0.1:8081 \
  ./node_modules/.bin/tsx scripts/kt-query-fixtures.ts
cd ../web && npx vitest run src/lib/__tests__/keyTransparency.test.ts
```

Fixture yang dihasilkan (`query-v1.pb`, `query-v2.pb`,
`query-distinguished.pb`) diverifikasi modul WASM sungguhan — termasuk rotasi
kunci **terhadap anchor dari bukti sebelumnya**, yang gagal sampai permintaan
kedua ikut mengirim `last` (temuan saat pertama kali menjalankan jalur ini).

## Auditor pihak ketiga (mode 3)

Log berjalan `ContactMonitoring` selama belum ada auditor: bukti memuat byte tanda
tangan auditor, tetapi nol auditor head berarti tidak ada yang memeriksanya
(`docs/34` §34.5). Layanan auditor disajikan di listener terpisah dan memakai kode
upstream apa adanya:

- `TreeSize` — ukuran pohon untuk dipakai auditor memilih titik mulai `Audit`.
- `Audit` — batch update + proof (limit dibatasi `maxAuditLimit`, default 10.000).
- `SetAuditorHead` — tanda tangan auditor atas tree head. Nama auditor dibawa di
  metadata `x-nyx-auditor-name` (deployment loopback tanpa mTLS); kunci publiknya
  diambil dari `api.auditors` di config, jadi nama saja tidak berguna. Nama yang
  tidak terkonfigurasi ditolak `PermissionDenied`, tanda tangan yang tidak sah /
  kunci penyerang / mode bukan third-party ditolak `FailedPrecondition`.

`SetAuditorHead` menulis state pohon, jadi ia memakai mutex yang sama dengan
penulisan update biasa — tidak ada dua penulis state yang berjalan bersamaan.

**Sisa:** auditor nyata belum dioperasikan (belum ada proses yang mengirim tanda
tangan), dan gate CI vektor `cmd/generate-auditing-test-vectors` / interop
`cmd/kt-client` tidak dijalankan (keduanya `package main` di repo upstream, tidak
ter-vendor). Yang bisa dibuktikan sekarang ada di `audit_test.go`: verifier
upstream **menolak** bukti mode 3 tanpa auditor head, menerimanya setelah
`SetAuditorHead`, dan menolak tanda tangan yang diubah.

## Snapshot harian → R2

`-snapshot-dir` menyalakan arsip harian **terverifikasi**: penulisan dijeda
(mutex yang sama dengan penulis), direktori LevelDB disalin, salinan dibuka ulang
(`RecoverFile` bila perlu), lalu tree head **dan root** salinan dibandingkan dengan
pohon hidup. Beda → arsip dibuang dan langkah itu dilaporkan gagal; snapshot yang
belum terverifikasi tidak pernah masuk `latest.json`, jadi tidak ada arsip sampah
yang diunggah. Arsip disimpan sebagai `kt-snapshot-<waktu>Z.tar.gz` + `latest.json`,
dan dipangkas ke `-snapshot-keep` arsip terbaru.

Unggahan ke R2 dilakukan proses lain, `server/src/jobs/ktSnapshot.ts`
(`KT_SNAPSHOT_DIR` di server NYX, cron 03:30, retensi 30 hari, metrik
`nyx_kt_snapshot_upload_total`/`nyx_kt_snapshot_deleted_total`): kredensial objek
tidak dipasang di proses log.

**Sisa:** dijalankan di VPS (direktori + kredensial) dan membuktikan pemulihan
dari arsip ke basis data yang bisa melayani bukti.

## Sisa yang jujur

- **Loop monitor klien sudah jalan** (2026-10-14): ABI WASM punya
  `monitor_build`/`verify_monitor`, state ter-seal di `ktMonitoring`, penjadwal di
  app shell (`docs/34` §34.6b). Sisa di sisi ini: tidak ada.
- **Gossip tree head** memakai `GET /head` (`web/src/lib/ktGossip.ts`); dua klien
  yang melihat root berbeda untuk ukuran pohon yang sama melaporkan split-view.
  Verifikasi lintas-klien nyata (dua browser) belum dijalankan.
- **Auditor pihak ketiga belum dioperasikan** (kode siap, lihat di atas).
- **Klaim `docs/32` §32.1 berubah**: upstream `kt-server` tidak lagi dijalankan
  sebagai penulis — layanan ini yang memilikinya (alasan di atas).
