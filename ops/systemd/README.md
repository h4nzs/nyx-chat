# `ops/systemd/` — proses prod yang tidak dikelola `deploy.yml`

Service yang **tidak** boleh hidup di dalam cluster `nyx-api` dipasang sebagai unit
systemd. Repo ini mengirim unit-nya, jadi pembaruan binary tidak lagi manual.

| Berkas | Tujuan |
|---|---|
| `nyx-kt-query.service` | Unit systemd untuk layanan log Key Transparency (`server/kt-query`, Go) |
| `nyx-kt-query.env.example` | Template `EnvironmentFile` (alamat loopback + setelan snapshot) |
| `nyx-kt-query` (binary) | Dibangun CI dari `server/kt-query` (vendor) dan ditaruh `deploy.yml` di `/root/nyx-app/server/kt-query/` |

Yang **otomatis** sejak unit ini ada di repo (`.github/workflows/deploy.yml`, docs/10 §10.3):
build binary dari vendor → masuk `nyx-deploy.zip` → disalin ke
`/root/nyx-app/server/kt-query/` (+ unit disegarkan ke `/etc/systemd/system/`) →
`systemctl restart nyx-kt-query` **bila unit sudah `enabled`**. Sebelum restart,
binary lama disimpan sebagai `nyx-kt-query.prev` untuk rollback cepat.

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

## Yang masih belum otomatis (jujur)

- Pemasangan pertama di atas (kunci + config + `enable`) — sengaja manual: kunci log
  tidak boleh lahir dari CI.
- Auditor pihak ketiga nyata belum dioperasikan (`NYX_KT_AUDITOR_ADDR` menganggur
  sampai ada proses yang memanggil `SetAuditorHead`; `docs/34` §34.5).
- Latihan pemulihan arsip **dari R2** masih langkah manual (§10.13); versi otomatisnya
  (dari arsip lokal) sudah jalan di CI sebagai job `kt-recovery`.
- coturn dan tumpukan observability (`ops/prometheus`, `ops/grafana`) tetap owner ops
  (§10.12); keduanya belum punya unit di direktori ini.
