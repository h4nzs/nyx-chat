# `server/kt-query` — layanan log Key Transparency NYX (v2 / ML-DSA-65)

> Status (2026-10-28): **hanya v2**. Layanan v1 (`nyx-kt-query`), auditor v1
> (`nyx-kt-auditor`), dan pemeriksa `nyx-kt-check` dihapus bersama pensiunnya
> jalur KT v1 (`docs/38`). Yang masih dibangun di sini: `nyx-kt-query-v2`
> (log), `nyx-kt-auditor-v2` (auditor pihak ketiga), `nyx-kt-v2-init`
> (bootstrap sekali pakai), dan `kt-v2-fixtures` (generator fixture tes).

## Kenapa satu proses memiliki basis data

LevelDB tidak bisa dibagi dua proses: `storage.newFileLock(readOnly=true)`
mengambil `LOCK_SH` di level OS sedangkan penulis memegang `LOCK_EX`, jadi
membuka basis data yang sama secara read-only di samping penulis gagal dengan
`resource temporarily unavailable` (`store_test.go` menjaga sifat ini). Karena
itu **satu proses** memiliki log, dan proses itu menyajikan baca, tulis, kunci
`distinguished`, layanan auditor, dan snapshot sekaligus.

Layanan upstream `kt-server` karena itu tidak dijalankan; NYX menautkan paket
pustaka upstream (`tree/transparency` versi v2, `db`, `cmd/kt-server/pb`) ke
binari sendiri. Semua sumber ada di `vendor/` — build offline, tanpa checkout
di luar repo.

## Bangun

```bash
server/kt-query/build.sh          # build vendored (-mod=vendor)
server/kt-query/build.sh test     # go vet + go test
```

Modul yang di-vendor: `github.com/signalapp/keytransparency` pada pin
`docs/32` §32.1 (`30b7a2a40604`). `go.mod` tidak memuat `replace`; mode kejar
pin (`NYX_KT_UPSTREAM=<checkout>`) hanya untuk mencoba pin baru **sebelum**
`go mod vendor` + commit.

## Jalankan (`nyx-kt-query-v2`)

```bash
nyx-kt-query-v2 -config /etc/nyx/kt-v2/config.yaml
```

| Flag | Env | Default | Arti |
|---|---|---|---|
| `-config` | `KT_V2_CONFIG_FILE` | `kt-v2-config.yaml` | config YAML log (kunci ML-DSA + `db.file`) |
| `-read-addr` | `NYX_KT_V2_QUERY_ADDR` | `127.0.0.1:8089` | HTTP baca — **loopback**; proxy-nya `/api/keys/kt/*` di server NYX |
| `-write-addr` | `NYX_KT_V2_WRITE_ADDR` | `127.0.0.1:8088` | gRPC test-update; samakan dengan `KT_V2_SERVER_URL` penulis |
| `-auditor-addr` | `NYX_KT_V2_AUDITOR_ADDR` | `127.0.0.1:8087` | gRPC auditor pihak ketiga; kosong = nonaktif |
| `-db` | — | dari config | override `db.file` |
| `-distinguished` | — | `api.distinguished` | interval kunci anchor; `0` = nonaktif |
| `-snapshot-dir` | `NYX_KT_V2_SNAPSHOT_DIR` | — | direktori arsip snapshot; kosong = nonaktif |
| `-snapshot-interval` | `NYX_KT_V2_SNAPSHOT_INTERVAL` | `24h` | jeda antar snapshot |
| `-snapshot-keep` | `NYX_KT_V2_SNAPSHOT_KEEP` | `7` | jumlah arsip lokal terakhir |
| `-metrics-addr` | `NYX_KT_V2_METRICS_ADDR` | `127.0.0.1:9468` | exporter `/metrics` — **wajib loopback**; `0` = mati |
| `-check` | — | — | buka basis data + bangun pohon, lalu keluar (health check deploy) |

Sisi server NYX membaca lewat `KT_QUERY_URL` (mis. `http://127.0.0.1:8089`);
tanpa itu `/api/keys/kt/*` menjawab 503 `KT_QUERY_DISABLED` — degradasi yang
terlihat, bukan TOFU senyap.

## API baca

Jawaban sukses berisi protobuf mentah (parser-nya di WASM klien):

| Endpoint | Permintaan | Jawaban |
|---|---|---|
| `GET /search` | `hash=<b64url 32B>` **atau** `key=<b64url>`, `last=<n>`, `distinguished=<n>` | `u32 len ‖ FullTreeHead ‖ u32 len ‖ CondensedTreeSearchResponse` |
| `GET /distinguished` | `last`, `distinguished` | seperti `/search` (search key `distinguished`) |
| `POST /monitor` | body = `transparency.MonitorRequest` | `transparency.MonitorResponse` |
| `GET /config` | — | `abiVersion: 2`, `valueFormat: nyx-kt-value-v2`, kunci ML-DSA log (+ `auditorKeys`) |
| `GET /head` | — | `{treeSize, timestamp, root}` — jangkar gossip antar-klien |
| `GET /healthz` | — | `{treeSize, timestamp}` |

Kode error: `NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE`, `INTERNAL`,
`METHOD_NOT_ALLOWED`. Search key dibatasi ke `0x75||hash(32)` atau
`distinguished`; monitor dibatasi 64 kunci per permintaan.

Klien hanya menerima config ber-`abiVersion: 2` — layanan ini satu-satunya yang
melayani `/api/keys/kt/*` (`docs/34`, `docs/38`).

## Auditor pihak ketiga (`nyx-kt-auditor-v2`)

Proses terpisah, tidak menyentuh LevelDB. Ia membaca `/config`, memverifikasi
aliran update lewat gRPC auditor (`TreeSize`/`Audit`), lalu mengirim
`SetAuditorHead` dengan kunci ML-DSA-nya sendiri. Kunci publik auditor
didaftarkan di `api.auditors` config log; nama dikirim lewat metadata
`x-nyx-auditor-name`.

```bash
nyx-kt-auditor-v2 -name <nama> -key-file /etc/nyx/kt-v2/auditor.key -print-public-key
nyx-kt-auditor-v2 -name <nama> -key-file /etc/nyx/kt-v2/auditor.key -check
nyx-kt-auditor-v2 -name <nama> -key-file /etc/nyx/kt-v2/auditor.key -once
```

Flag/env: `-name` (`NYX_KT_V2_AUDITOR_NAME`), `-key-file`
(`NYX_KT_V2_AUDITOR_KEY_FILE`), `-state-file`
(`NYX_KT_V2_AUDITOR_STATE_FILE`), `-read-url` (`NYX_KT_V2_QUERY_URL`),
`-auditor-addr` (`NYX_KT_V2_AUDITOR_ADDR`), `-metrics-addr`
(`NYX_KT_V2_AUDITOR_METRICS_ADDR`, default `127.0.0.1:9469`), `-batch-size`,
`-interval`, `-signature-interval`, `-signature-page-size`, `-once`, `-check`,
`-print-public-key`.

Logika verifikasi adalah port baris-per-baris dari auditor referensi Signal
(Java, AGPL-3.0): `CondensedPrefixTree` dan `CondensedLogTree`, diuji terhadap
vektor resmi `testdata/katie_test_vectors.pb` (10 `should_succeed`, 5
`should_fail`, tanda tangan tree head byte-per-byte).

**Sisa yang jujur:** auditor berjalan di host yang sama dengan log, jadi ia
membuktikan konsistensi riwayat, bukan independensi organisasi; interop
`cmd/kt-client` upstream dan auditor kedua di mesin lain belum dijalankan
(`docs/34` §34.6).

## Snapshot harian → R2

`-snapshot-dir` menyalakan arsip harian **terverifikasi**: penulisan dijeda,
direktori LevelDB disalin, salinan dibuka ulang, lalu tree head **dan root**
dibandingkan dengan pohon hidup. Beda → arsip dibuang dan putaran dilaporkan
gagal; arsip yang belum terverifikasi tidak pernah masuk `latest.json`. Arsip
dipangkas ke `-snapshot-keep` terbaru.

Unggahan ke R2 dilakukan proses lain, `server/src/jobs/ktSnapshot.ts`
(`KT_SNAPSHOT_DIR` di server NYX, cron 03:30, retensi 30 hari, metrik
`nyx_kt_snapshot_upload_total`/`nyx_kt_snapshot_deleted_total`): kredensial
objek tidak dipasang di proses log.

## Metrik (`metrics.go`, job scrape `nyx-kt-query-v2`)

Proses ini **fail-open**: bila ia mati, registrasi dan rotasi kunci tetap sukses
— hanya tanpa jejak audit. Karena itu `metrics.go` ada: tulisan per hasil
(`ok`/`duplicate`/`invalid`/`error`), baca per operasi, percobaan snapshot lokal,
ukuran pohon, umur proses, plus dua gauge kunci:

- `nyx_kt_query_snapshot_last_timestamp_seconds` — snapshot lokal terakhir yang
  tersimpan **dan terverifikasi** (aturan memakai `absent_over_time`, bukan
  `== 0`).
- `nyx_kt_query_distinguished_timestamp_seconds` — anchor yang benar-benar
  ditulis, bukan pembacaan saat start (menghindari alarm palsu setelah restart).

Nilai label hanya dari enum; nilai berbentuk identitas ditolak dan dihitung di
`nyx_kt_query_metrics_rejected_total` (harus selalu 0).

## Bootstrap (`nyx-kt-v2-init`)

Alat satu kali: membuat config YAML, kunci ML-DSA log, dan seed auditor di
`-config-dir` (default `/etc/nyx/kt-v2`). `deploy.yml` memanggilnya hanya bila
`config.yaml` belum ada; kunci lahir di VPS dan tidak pernah melewati CI.
`-force` menulis ulang (dan **menghapus** identitas log lama) — jangan dipakai
tanpa sengaja.

## Fixture

`cmd/kt-v2-fixtures` menghasilkan fixture deterministik untuk verifier Rust
(`packages/keytrans-v2`) dan WASM (`packages/keytrans-wasm-v2`):

```bash
cd server/kt-query
go run ./cmd/kt-v2-fixtures -out ../../packages/keytrans-wasm-v2/testdata
```

Timestamp tree head dipatok supaya fixture tidak kedaluwarsa. Fixture ikut
di-commit; `-check` di `tools/dr-oracle` tidak menyentuhnya.
