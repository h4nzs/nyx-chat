# `ops/systemd/` — proses prod yang tidak dikelola `deploy.yml`

Service yang **tidak** boleh hidup di dalam cluster `nyx-api` dipasang sebagai unit
systemd. Repo ini mengirim unit-nya, jadi pembaruan binary tidak lagi manual.

| Berkas | Tujuan |
|---|---|
| `nyx-kt-query.service` | Unit systemd untuk layanan log Key Transparency (`server/kt-query`, Go) |
| `nyx-kt-query.env.example` | Template `EnvironmentFile` (alamat loopback + setelan snapshot) |
| `nyx-kt-auditor.service` | Unit systemd untuk **auditor pihak ketiga** (mode 3, `server/kt-query/cmd/nyx-kt-auditor`, Go) |
| `nyx-kt-auditor.env.example` | Template `EnvironmentFile` auditor (nama, kunci, state, irama tanda tangan) |
| `nyx-kt-query-v2.service` | Unit systemd untuk **log KT v2** (ML-DSA, LevelDB terpisah) |
| `nyx-kt-query-v2.env.example` | Template `EnvironmentFile` v2 (port 8089/8088/8087, snapshot v2) |
| `nyx-kt-auditor-v2.service` | Unit systemd untuk **auditor v2** (ML-DSA, mode 3) |
| `nyx-kt-auditor-v2.env.example` | Template `EnvironmentFile` auditor v2 |
| `nyx-kt-query` / `nyx-kt-auditor` (binary) | Dibangun CI dari `server/kt-query` (vendor) dan ditaruh `deploy.yml` di `/root/nyx-app/server/kt-query/` |
| `nyx-kt-query-v2` / `nyx-kt-auditor-v2` / `nyx-kt-v2-init` (binary) | Binary v2 + alat bootstrap; dibangun CI dan dikirim `deploy.yml` |

Yang **otomatis** sejak unit ini ada di repo (`.github/workflows/deploy.yml`, docs/10 §10.3):
build binary dari vendor → masuk `nyx-deploy.zip` → disalin ke
`/root/nyx-app/server/kt-query/` (+ unit disegarkan ke `/etc/systemd/system/`) →
`systemctl restart nyx-kt-query` **bila unit sudah `enabled`**, lalu
`systemctl restart nyx-kt-auditor` **bila unit auditor sudah `enabled`** (urutan itu
penting: auditor memanggil `TreeSize`/`Audit`/`SetAuditorHead` ke layanan log).
Sebelum restart, binary lama disimpan sebagai `nyx-kt-query.prev` untuk rollback cepat.

Yang **tetap sekali saja / manual** (di bawah): direktori, kunci log + config YAML,
`EnvironmentFile`, `systemctl enable`, dan pengisian `KT_*` di `/root/nyx-app/.env`.
Tanpa langkah itu, deploy hanya mencetak `ℹ️ nyx-kt-query belum di-enable` dan tidak
menyentuh apa pun.

Kenapa systemd dan bukan pm2: service ini memegang **flock LevelDB** — harus satu
proses. Dua proses sekaligus (mis. satu di pm2 + satu di systemd) mati dengan
`resource temporarily unavailable`. Ia juga punya lifecycle sendiri: `pm2 restart
nyx-api` tidak boleh memutus layanan baca KT.

## Pemasangan pertama (di VPS, sebagai root)

Prasyarat: `deploy.yml` sudah pernah jalan minimal sekali, atau Anda membangun
binary sendiri dengan `server/kt-query/build.sh` (butuh Go + `server/kt-query/vendor/`).

```bash
# 1. Direktori (basis data LevelDB, arsip snapshot, config + kunci log)
install -d -m 700 /etc/nyx/kt /var/lib/nyx/kt /var/lib/nyx/kt-snapshots

# 2. Kunci log + config YAML — HANYA SEKALI. Kunci ini adalah identitas log:
#    menggantinya berarti semua bukti lama tak bisa diverifikasi klien (dan
#    anchor/gossip klien menjadi tak berguna). Simpan bersama `NYX_AT_REST_PEPPER`.
umask 077
cat > /etc/nyx/kt/test_config.yaml <<EOF
api:
  signing-key: $(openssl rand -hex 32)
  vrf-key: $(openssl rand -hex 32)
  prefix-key: $(openssl rand -hex 32)
  opening-key: $(openssl rand -hex 32)
  # Irama rotasi kunci distinguished (anchor klien sebelum mengenal kontak).
  # Inilah satu-satunya tempatnya — unit systemd sengaja tidak mengoper
  # -distinguished (docs/32 §32.8). Tanpa backtick di dalam blok ini:
  # heredoc tak dikutip, jadi backtick akan dieksekusi sebagai perintah.
  distinguished: 1m
db:
  file: /var/lib/nyx/kt
EOF

# 3. EnvironmentFile (default sudah cocok dengan topologi docs/10 §10.1;
#    db.file/snapshot dir WAJIB ada di ReadWritePaths unit)
install -m 600 /root/nyx-app/ops/systemd/nyx-kt-query.env.example /etc/nyx/kt/nyx-kt-query.env

# 4. Unit + jalankan
install -m 644 /root/nyx-app/ops/systemd/nyx-kt-query.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nyx-kt-query
```

## Auditor pihak ketiga (mode 3)

Log berjalan **mode 1** (`ContactMonitoring`) selama `api.auditors` kosong: bukti
memuat byte tanda tangan auditor, tetapi nol auditor head berarti tidak ada yang
memeriksanya (`docs/34` §34.5). Menambah entri `api.auditors` menyalakan mode 3 —
dan sejak itu klien **mewajibkan** auditor head: sampai auditor pertama mengirim
`SetAuditorHead`, verifikasi klien gagal dengan `auditor tree head not provided
even though auditing is required`. Karena itu urutannya: siapkan auditor dulu,
baru aktifkan mode 3.

Pemasangan pertama (di VPS, sebagai root):

```bash
# 1. Direktori state auditor (ReadWritePaths unit) + direktori kunci
install -d -m 700 /etc/nyx/kt /var/lib/nyx/kt-auditor

# 2. Kunci auditor — HANYA SEKALI. Kunci ini yang menandatangani tree head;
#    menggantinya berarti entri `api.auditors` harus diperbarui dan state lama
#    (bertanda tangan kunci lama) ditolak saat dimuat.
umask 077
openssl rand -hex 32 > /etc/nyx/kt/auditor.key
chmod 600 /etc/nyx/kt/auditor.key

# 3. Baris `api.auditors` yang harus masuk config log — dicetak alat itu sendiri
#    supaya kunci publik tidak pernah disalin dengan tangan.
/root/nyx-app/server/kt-query/nyx-kt-auditor \
  -name nyx-primary-auditor -key-file /etc/nyx/kt/auditor.key -print-public-key

# 4. Tambahkan ke /etc/nyx/kt/test_config.yaml (dan simpan bersama kunci log):
#      api:
#        auditors:
#          nyx-primary-auditor: <hex dari langkah 3>
#    lalu restart layanan log → mode 3.
systemctl restart nyx-kt-query

# 5. EnvironmentFile + unit auditor
install -m 600 /root/nyx-app/ops/systemd/nyx-kt-auditor.env.example /etc/nyx/kt/nyx-kt-auditor.env
#    isi NYX_KT_AUDITOR_NAME (harus sama dengan langkah 4) bila berbeda dari contoh
install -m 644 /root/nyx-app/ops/systemd/nyx-kt-auditor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nyx-kt-auditor
```

Verifikasi auditor:

```bash
systemctl status nyx-kt-auditor --no-pager
journalctl -u nyx-kt-auditor -n 50 --no-pager     # cari "tree head DIKIRIM treeSize=..."

# Mode 3 terlihat dari layanan baca (tanpa menyentuh basis data):
/root/nyx-app/server/kt-query/nyx-kt-check config -url http://127.0.0.1:8085
#   mode=3 … auditorKeys=1

# Bukti mode 3 yang diverifikasi **verifier upstream** (kode yang sama dengan WASM
# klien): butuh satu usernameHash yang benar-benar terdaftar di log.
/root/nyx-app/server/kt-query/nyx-kt-check verify-search \
  -url http://127.0.0.1:8085 -hash <base64url 32 byte usernameHash>
```

Catatan operasional:

- Auditor boleh mati tanpa mematikan log: bukti lama tetap dilayani, hanya tanda
  tangan baru yang berhenti. Klien menolak auditor head yang lebih tua dari **7
  hari** (`timeAuditorMaxBehind` upstream), jadi jangan pasang irama tanda tangan
  lebih panjang dari 24 jam.
- Bila auditor menemukan inkonsistensi, ia berhenti menandatangani (log
  `TIDAK KONSISTEN — tree head tidak dikirim`) dan **tidak** menyimpan state;
  restart tidak membuatnya melompat melewati update yang gagal.
- State auditor ada di `NYX_KT_AUDITOR_STATE_FILE` (default
  `/var/lib/nyx/kt-auditor/state.json`, mode 0600, bertanda tangan). Menghapusnya
  = auditor mengaudit ulang dari posisi 0, bukan bencana, tetapi ia akan kehilangan
  posisi terakhir yang sudah ia tandatangani.

## Log KT v2 (ML-DSA) — bootstrap otomatis

Sejak Fase 7 (docs/35 §35.7) ada log **terpisah** dengan kunci ML-DSA-65, indeks
SHA-256, dan LevelDB sendiri. `deploy.yml` menjalankan `nyx-kt-v2-init` **hanya bila
`/etc/nyx/kt-v2/config.yaml` belum ada**; alat itu membuat:

- `config.yaml` (seed signing ML-DSA 32 byte, prefix/opening 32 byte, entri
  `api.auditors` berisi kunci publik ML-DSA-65 auditor, `distinguished: 1m`,
  `db.file=/var/lib/nyx/kt-v2/tree.db`);
- berkas seed auditor di path `NYX_KT_V2_AUDITOR_KEY_FILE`;
- direktori `0700` untuk config, DB, snapshot, dan state auditor.

Lalu deploy menyalin kedua EnvironmentFile (hanya jika belum ada),
`systemctl enable nyx-kt-query-v2 nyx-kt-auditor-v2`, dan menambahkan
`KT_V2_SERVER_URL=http://127.0.0.1:8088` ke `/root/nyx-app/.env` supaya penulis
yang sama melakukan **dual-write**. Deploy **tidak** memindahkan `KT_QUERY_URL`:
pembacaan tetap v1 sampai cutover disengaja.

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

### Kenapa cutover baca belum otomatis

`User.usernameHash` di Postgres adalah HMAC ter-pepper, sedangkan search key KT
diturunkan dari Argon2id mentah yang hanya dipegang klien. Karena itu log v2
**tidak dapat di-backfill dari database** dan akun lama belum punya entri v2.
Registrasi, pemulihan, dan rotasi kunci baru menulis ke kedua log (dual-write).
Pindahkan `KT_QUERY_URL` ke `http://127.0.0.1:8089` dan `KT_SNAPSHOT_DIR` ke
`/var/lib/nyx/kt-v2-snapshots` hanya setelah populasi yang dibutuhkan masuk;
setelah itu v1 **read-only** (jangan dimatikan) supaya klien lama masih bisa
memverifikasi.

Rollback: klien yang sudah mem-pin ABI 2 menolak turun ke ABI 1 (anti-downgrade).
Rollback yang aman = biarkan v2 hidup dan kembalikan `KT_QUERY_URL`, bukan
menghapus pin di klien. Pin hanya bisa di-reset lewat jalur pemulihan lokal.

## Verifikasi

```bash
systemctl status nyx-kt-query --no-pager
journalctl -u nyx-kt-query -n 50 --no-pager

# Bukti layanan hidup (tree head) — tidak membuka basis data, aman saat service jalan
curl -s 127.0.0.1:8085/healthz                     # {"treeSize":N,"timestamp":"..."}
/root/nyx-app/server/kt-query/nyx-kt-check head -url http://127.0.0.1:8085

# Health check penuh (membuka basis data) — HARUS service berhenti dulu, karena
# flock LevelDB hanya boleh dipegang satu proses.
systemctl stop nyx-kt-query
/root/nyx-app/server/kt-query/nyx-kt-query -check -config /etc/nyx/kt/test_config.yaml
systemctl start nyx-kt-query
```

Lalu sambungkan sisi server NYX (`/root/nyx-app/.env`, §10.6) dan restart API:

```bash
KT_SERVER_URL=http://127.0.0.1:8081     # = NYX_KT_WRITE_ADDR
KT_QUERY_URL=http://127.0.0.1:8085      # = NYX_KT_QUERY_ADDR
KT_SNAPSHOT_DIR=/var/lib/nyx/kt-snapshots  # = NYX_KT_SNAPSHOT_DIR
pm2 restart nyx-api

# Bukti sisi server sudah memakai KT (bukan jatuh ke TOFU):
curl -s 127.0.0.1:9464/metrics | grep '^nyx_kt_queries_total'
curl -s https://api.nyx-app.my.id/health   # probe liveness tetap hijau

# Bukti proses log KT sendiri mengekspos metrik (job scrape `nyx-kt-query`):
curl -s 127.0.0.1:9467/metrics | grep -E '^nyx_kt_query_(tree_size|distinguished_timestamp)'
# `NYX_KT_METRICS_ADDR` default 127.0.0.1:9467; `0` = exporter mati (dan alarm
# `NyxKtQueryDown` menyala — itu memang disengaja: proses tanpa metrik = proses
# yang kegagalannya tidak terlihat).
```

Tidak ada port yang perlu dibuka di firewall: ketiga listener loopback
(docs/10 §10.9).

## Pembaruan & rollback

- **Binary:** otomatis tiap push ke `main` (§10.3). Jika unit sudah `enabled`,
  deploy merestart dan memverifikasi `systemctl is-active`; kalau gagal, deploy
  berhenti dengan status merah (log KT mati = kunci identitas baru tidak ter-audit).
- **Unit:** ikut disalin ulang dari repo saat deploy. Perubahan unit di repo karena
  itu berlaku pada deploy berikutnya — jangan mengeditnya hanya di VPS.
- **Rollback cepat:** `/root/nyx-app/server/kt-query/nyx-kt-query.prev` adalah binary
  dari deploy sebelumnya; `install -m 755 nyx-kt-query.prev nyx-kt-query &&
  systemctl restart nyx-kt-query`. Rollback skema log (pin upstream) tetap lewat
  `git revert` + deploy, atau pemulihan arsip (§10.13).
- **Config/kunci tidak pernah disentuh deploy** — itu satu-satunya bagian yang tidak
  bisa dipulihkan otomatis.

## Kalau bermasalah

| Gejala | Penyebab tersering |
|---|---|
| `resource temporarily unavailable` di journal | Ada proses lain memegang LevelDB — cek `pgrep -af nyx-kt-query` dan `ss -tlnp \| grep 8085`; hapus entri pm2 lama `kt-` bila ada |
| Service gagal dengan `baca config /etc/nyx/kt/test_config.yaml` | Langkah 2 belum dijalankan, atau izin/file salah (`ls -l /etc/nyx/kt`) |
| `read-only file system` | `db.file`/`-snapshot-dir` di luar `ReadWritePaths` unit (`ProtectSystem=strict`) |
| Klien jatuh ke TOFU | `KT_QUERY_URL` kosong di `.env` server, atau service mati — cek `nyx_kt_queries_total{result="disabled"}` |
| Alert snapshot menyala | `KT_SNAPSHOT_DIR` (server) ≠ `NYX_KT_SNAPSHOT_DIR` (unit), arsip belum pernah dibuat, atau kredensial R2 |
| `distinguished` tidak maju | `api.distinguished` kosong di config YAML (unit tidak mengoper `-distinguished`); cek log `[kt-query]` saat start |
| Alert `NyxKtQueryDown` menyala | Proses log mati/terputus. Registrasi **tetap** jalan (fail-open), jadi tidak ada error di aplikasi — cek `systemctl status nyx-kt-query`, `NYX_KT_METRICS_ADDR`, dan `curl -s 127.0.0.1:9467/metrics` |
| Alert `NyxKtQuerySnapshotStalled` menyala | Snapshot lokal tidak dibuat >48 jam padahal `NYX_KT_SNAPSHOT_DIR` diisi — cek ruang disk + log `snapshot` di journal (arsip dibuat proses yang sama, jadi restart yang terlalu sering juga menutup jalannya) |

## Yang masih belum otomatis (jujur)

- Pemasangan pertama **v1** di atas (kunci + config + `enable`) — sengaja manual:
  kunci log v1 tidak boleh lahir dari CI. Log v2 memakai bootstrap otomatis
  (`nyx-kt-v2-init`) dengan kunci yang lahir di VPS.
- Cutover baca v2 dan pengisian akun lama: manual, karena search key tidak dapat
  diturunkan dari database (lihat bagian v2 di atas).
- Latihan pemulihan arsip **dari R2** masih langkah manual (§10.13); versi otomatisnya
  (dari arsip lokal) sudah jalan di CI sebagai job `kt-recovery`.
- coturn dan tumpukan observability (`ops/prometheus`, `ops/grafana`) tetap owner ops
  (§10.12); keduanya belum punya unit di direktori ini.
