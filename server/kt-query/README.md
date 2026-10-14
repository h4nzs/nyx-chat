# `nyx-kt-query` — layanan Key Transparency NYX (baca + tulis)

> Status: **landed & teruji** (2026-10-13). 18 test Go, semuanya hijau; bukti yang
> disajikannya diverifikasi verifier libsignal yang sebenarnya lewat modul WASM
> (`web/src/lib/__tests__/keyTransparency.test.ts`). Lihat `docs/32` §32.8 dan
> `docs/34`.

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

Yang **tidak** diubah: nilai log (`docs/32` §32.2, frozen), bentuk bukti
(protobuf upstream), dan primitif kripto. Pohon, VRF, commitment, dan
penyimpanan semuanya dari paket upstream (`tree/transparency`, `db`) yang di-pin.

## Bangun

Modul ini bergantung pada paket dari repo upstream yang **privat**, jadi
dibangun terhadap checkout lokal yang di-pin (`docs/32` §32.1: commit
`30b7a2a40604`):

```bash
# checkout upstream di tempat default (~/signal/key-transparency-server)
server/kt-query/build.sh

# atau arahkan ke lokasi lain
NYX_KT_UPSTREAM=/path/ke/key-transparency-server server/kt-query/build.sh

# jalankan test
server/kt-query/build.sh test
```

`build.sh` menyetel directive `replace` di `go.mod` sementara, lalu
mengembalikannya. Tanpa skrip itu, `go build` tetap bekerja selama checkout ada
di tempat default.

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
| `-db` | — | dari config | override `db.file` |
| `-distinguished` | — | `api.distinguished` | interval kunci distinguished; `0` = nonaktif |
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
| `GET /healthz` | — | `{treeSize, timestamp}` |

Kode error: `NOT_FOUND` (search key tidak ada di log — dibedakan dari layanan
mati), `INVALID_ARGUMENT`, `UNAVAILABLE`, `INTERNAL`, `METHOD_NOT_ALLOWED`.

Pembatasan yang disengaja: search key **hanya** `0x75||hash(32)` atau
`distinguished` — layanan ini bukan oracle pencarian bebas untuk namespace
Signal lain. Monitor dibatasi 64 kunci per permintaan.

## Verifikasi

```bash
# test unit + integrasi (butuh checkout upstream)
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

## Sisa yang jujur

- **Loop monitor klien belum jalan.** Endpoint `POST /monitor` benar dan teruji
  (Go) termasuk verifikasi `VerifyMonitor` upstream, tetapi permintaannya harus
  dibangun dari monitoring data tersimpan — dan ABI WASM saat ini belum punya op
  untuk itu (`docs/34` §34.6 poin 2). Selama itu, deteksi rollback/rotasi
  bergantung pada klien membandingkan `keyVersion` dari bukti yang diterimanya.
- **Auditor pihak ketiga belum aktif.** `SetAuditorHead` + mode 3 belum
  dijalankan; tanpa auditor, operator masih bisa menulis ulang log.
- **Klaim `docs/32` §32.1 berubah**: upstream `kt-server` tidak lagi dijalankan
  sebagai penulis — layanan ini yang memilikinya (alasan di atas).
