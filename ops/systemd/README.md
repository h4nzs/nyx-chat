# `ops/systemd/` — proses prod yang tidak dikelola `deploy.yml`

Service yang **tidak** boleh hidup di dalam cluster `nyx-api` dipasang sebagai unit
systemd. Repo ini mengirim unit-nya, jadi pembaruan binary tidak lagi manual.

| Berkas | Tujuan |
|---|---|
| `nyx-kt-query-v2.service` | Unit systemd untuk **log KT v2** (ML-DSA, pemilik LevelDB) |
| `nyx-kt-query-v2.env.example` | Template `EnvironmentFile` log v2 (port 8089/8088/8087, snapshot v2) |
| `nyx-kt-auditor-v2.service` | Unit systemd untuk **auditor v2** (ML-DSA, mode 3) |
| `nyx-kt-auditor-v2.env.example` | Template `EnvironmentFile` auditor v2 |
| `nyx-kt-query-v2` / `nyx-kt-auditor-v2` / `nyx-kt-v2-init` (binary) | Binary v2 + alat bootstrap; dibangun CI dan dikirim `deploy.yml` |
| `user/nyx-ohttp-relay.service` | Unit **user** (`systemctl --user`) untuk selfhost `~/nyx-selfhost`: relay OHTTP proses terpisah (docs/10 §10.18) |
| `user/nyx-pir-sidecar.service` | Unit **user** untuk selfhost: sidecar PIR ChalametPIR :9470 (docs/10 §10.19) |

> **Log KT v1 sudah pensiun (2026-10-28).** Unit `nyx-kt-query.service` dan
> `nyx-kt-auditor.service` dihapus dari repo bersama penulis v1 (`docs/38`).
> `deploy.yml` mematikan + menghapus unit v1 yang masih `enabled` di VPS;
> LevelDB v1 dibiarkan di disk (arsip/rollback operator, docs/39).

Yang **otomatis** sejak unit ini ada di repo (`.github/workflows/deploy.yml`, docs/10 §10.3):
build binary dari vendor → masuk `nyx-deploy.zip` → disalin ke
`/root/nyx-app/server/kt-query/` (+ unit disegarkan ke `/etc/systemd/system/`) →
`systemctl restart nyx-kt-query-v2` lalu `nyx-kt-auditor-v2` **bila unit sudah
`enabled`** (urutan itu penting: auditor memanggil `TreeSize`/`Audit`/`SetAuditorHead`
ke layanan log). Sebelum restart, binary lama disimpan sebagai
`nyx-kt-query-v2.prev` untuk rollback cepat.

Pemasangan pertama v2 juga otomatis bila `/etc/nyx/kt-v2/config.yaml` belum ada:
`nyx-kt-v2-init` membuat config + kunci ML-DSA **di VPS** (tidak pernah melewati CI),
lalu kedua unit di-`enable` dan `KT_V2_SERVER_URL=http://127.0.0.1:8088` ditambahkan
ke `/root/nyx-app/.env` bila belum ada. `KT_QUERY_URL` **tidak** diubah deploy.

Kenapa systemd dan bukan pm2: service ini memegang **flock LevelDB** — harus satu
proses. Dua proses sekaligus (mis. satu di pm2 + satu di systemd) mati dengan
`resource temporarily unavailable`. Ia juga punya lifecycle sendiri: `pm2 restart
nyx-api` tidak boleh memutus layanan baca KT.

## Bootstrap v2 (yang dibuat `nyx-kt-v2-init`)

- `config.yaml` (seed signing ML-DSA 32 byte, prefix/opening 32 byte, entri
  `api.auditors` berisi kunci publik ML-DSA-65 auditor, `distinguished: 1m`,
  `db.file=/var/lib/nyx/kt-v2/tree.db`);
- berkas seed auditor di path `NYX_KT_V2_AUDITOR_KEY_FILE`;
- direktori `0700` untuk config, DB, snapshot, dan state auditor.

```bash
# Status setelah deploy (semua loopback):
curl -s 127.0.0.1:8089/healthz
systemctl status nyx-kt-query-v2 nyx-kt-auditor-v2 --no-pager
journalctl -u nyx-kt-query-v2 -n 30 --no-pager
curl -s 127.0.0.1:9468/metrics | grep -E '^nyx_kt_query_(tree_size|writes)'
curl -s 127.0.0.1:9469/metrics | grep -E '^nyx_kt_auditor_'
```

**Jangan** menjalankan `nyx-kt-v2-init -force` pada log yang sudah berisi bukti:
itu mengganti identitas log dan semua bukti lama menjadi tidak terverifikasi.
Deploy berikutnya tidak pernah menimpa config/kunci yang ada.

## Sisi server NYX (`/root/nyx-app/.env`, docs/10 §10.6)

```bash
KT_V2_SERVER_URL=http://127.0.0.1:8088   # = NYX_KT_V2_WRITE_ADDR (tulis)
KT_QUERY_URL=http://127.0.0.1:8089       # = NYX_KT_V2_QUERY_ADDR (baca)
KT_SNAPSHOT_DIR=/var/lib/nyx/kt-v2-snapshots  # = NYX_KT_V2_SNAPSHOT_DIR
pm2 restart nyx-api
```

`KT_SERVER_URL` tidak lagi dibaca: bila masih ada di `.env`, boot menuliskan satu
peringatan dan mengabaikannya. Klien hanya menerima config `abiVersion: 2`, jadi
`KT_QUERY_URL` yang masih menunjuk layanan v1 akan membuat semua verdict KT
`unavailable` (terlihat), bukan terverifikasi diam-diam.

```bash
# Bukti sisi server sudah memakai KT (bukan jatuh ke TOFU):
curl -s 127.0.0.1:9464/metrics | grep '^nyx_kt_queries_total'
curl -s https://api.nyx-app.my.id/health   # probe liveness tetap hijau

# Bukti proses log KT sendiri mengekspos metrik (job scrape `nyx-kt-query-v2`):
curl -s 127.0.0.1:9468/metrics | grep -E '^nyx_kt_query_(tree_size|distinguished_timestamp)'
```

Tidak ada port yang perlu dibuka di firewall: semua listener loopback (docs/10 §10.9).

## Auditor pihak ketiga (mode 3)

Log berjalan **mode 1** (`ContactMonitoring`) selama `api.auditors` kosong: bukti
memuat byte tanda tangan auditor, tetapi nol auditor head berarti tidak ada yang
memeriksanya (`docs/34` §34.5). Menambah entri `api.auditors` menyalakan mode 3 —
dan sejak itu klien **mewajibkan** auditor head: sampai auditor pertama mengirim
`SetAuditorHead`, verifikasi klien gagal dengan `auditor tree head not provided
even though auditing is required`. Karena itu urutannya: siapkan auditor dulu,
baru aktifkan mode 3.

`nyx-kt-v2-init` sudah membuat seed auditor + entri `api.auditors` untuk satu nama
(default dari `-auditor-name`). Verifikasi:

```bash
systemctl status nyx-kt-auditor-v2 --no-pager
journalctl -u nyx-kt-auditor-v2 -n 50 --no-pager   # cari "tree head DIKIRIM treeSize=..."
/root/nyx-app/server/kt-query/nyx-kt-auditor-v2 \
  -name <nama> -key-file /etc/nyx/kt-v2/auditor.key -check
```

Catatan operasional:

- Auditor boleh mati tanpa mematikan log: bukti lama tetap dilayani, hanya tanda
  tangan baru yang berhenti. Klien menolak auditor head yang lebih tua dari **7
  hari** (`timeAuditorMaxBehind` upstream), jadi jangan pasang irama tanda tangan
  lebih panjang dari 24 jam (`NYX_KT_V2_AUDITOR_SIGNATURE_INTERVAL`).
- Bila auditor menemukan inkonsistensi, ia berhenti menandatangani (log
  `TIDAK KONSISTEN — tree head tidak dikirim`) dan **tidak** menyimpan state;
  restart tidak membuatnya melompat melewati update yang gagal.
- State auditor ada di `NYX_KT_V2_AUDITOR_STATE_FILE` (default
  `/var/lib/nyx/kt-auditor-v2/state.json`, mode 0600, bertanda tangan). Menghapusnya
  = auditor mengaudit ulang dari posisi 0, bukan bencana, tetapi ia kehilangan
  posisi terakhir yang sudah ia tandatangani.
- Auditor di host yang sama membuktikan **konsistensi riwayat**, bukan independensi
  organisasi (`docs/38` §38.3).

## Pembaruan & rollback

- **Binary:** otomatis tiap push ke `main` (§10.3). Jika unit sudah `enabled`,
  deploy merestart dan memverifikasi `systemctl is-active`; kalau gagal, deploy
  berhenti dengan status merah (log KT mati = kunci identitas baru tidak ter-audit).
- **Unit:** ikut disalin ulang dari repo saat deploy. Perubahan unit di repo karena
  itu berlaku pada deploy berikutnya — jangan mengeditnya hanya di VPS.
- **Rollback cepat:** `/root/nyx-app/server/kt-query/nyx-kt-query-v2.prev` adalah
  binary dari deploy sebelumnya; `install -m 755 nyx-kt-query-v2.prev nyx-kt-query-v2
  && systemctl restart nyx-kt-query-v2`. Rollback ke **log v1** bukan lagi pilihan
  env: klien menolak ABI 1 dan penulis v1 sudah dihapus — itu butuh redeploy commit
  sebelumnya (`docs/38` §38.2).
- **Config/kunci tidak pernah disentuh deploy** — itu satu-satunya bagian yang tidak
  bisa dipulihkan otomatis.

## Kalau bermasalah

| Gejala | Penyebab tersering |
|---|---|
| `resource temporarily unavailable` di journal | Ada proses lain memegang LevelDB — cek `pgrep -af nyx-kt-query` dan `ss -tlnp \| grep 8089`; unit v1 yang masih hidup harus dimatikan |
| Service gagal dengan `baca config /etc/nyx/kt-v2/config.yaml` | Bootstrap belum jalan, atau izin/file salah (`ls -l /etc/nyx/kt-v2`) |
| `read-only file system` | `db.file`/`-snapshot-dir` di luar `ReadWritePaths` unit (`ProtectSystem=strict`) |
| Klien jatuh ke TOFU | `KT_QUERY_URL` kosong/ masih menunjuk v1, atau service mati — cek `nyx_kt_queries_total{result="disabled"}` |
| Alert snapshot menyala | `KT_SNAPSHOT_DIR` (server) ≠ `NYX_KT_V2_SNAPSHOT_DIR` (unit), arsip belum pernah dibuat, atau kredensial R2 |
| `distinguished` tidak maju | `api.distinguished` kosong di config YAML (unit tidak mengoper `-distinguished`); cek log `[kt-query-v2]` saat start |
| Alert `NyxKtQueryDown` menyala | Proses log mati/terputus. Registrasi **tetap** jalan (fail-open), jadi tidak ada error di aplikasi — cek `systemctl status nyx-kt-query-v2`, `NYX_KT_V2_METRICS_ADDR`, dan `curl -s 127.0.0.1:9468/metrics` |
| Alert `NyxKtQuerySnapshotStalled` menyala | Snapshot lokal tidak dibuat >48 jam padahal `NYX_KT_V2_SNAPSHOT_DIR` diisi — cek ruang disk + log `snapshot` di journal (arsip dibuat proses yang sama, jadi restart yang terlalu sering juga menutup jalannya) |

## `nyx-ohttp-relay` (relay OHTTP proses terpisah)

Bukan layanan KT, tetapi dipasang dengan pola yang sama dan butuh
`OHTTP_GATEWAY_TARGET` (loopback). Lihat `nyx-ohttp-relay.env.example` dan
`docs/10` §10.18. Proses ini tidak memegang DB/Redis/kunci apa pun; kalau
EnvironmentFile-nya mulai berisi `DATABASE_URL`/`JWT_SECRET`, ada tanggung jawab
yang salah tempat. Status: `curl -fsS http://127.0.0.1:4100/healthz`.

## Yang masih belum otomatis (jujur)

- Latihan pemulihan arsip KT **dari R2** masih langkah manual (§10.13). Drill
  otomatis yang dulu ada (job CI `kt-recovery`, `scripts/kt-restore-drill.sh`)
  dihapus bersama log v1; drill setara untuk v2 **belum ada** (`docs/38` §38.3).
- Auditor di mesin/operator lain: protokolnya sama, tetapi pemasangan kedua belum
  dijalankan (`docs/34` §34.6).
- coturn dan tumpukan observability (`ops/prometheus`, `ops/grafana`) tetap owner ops
  (§10.12); keduanya belum punya unit di direktori ini.
