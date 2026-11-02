# NYX self-host (mesin ini)

Deployment ini memakai **systemd user units**. PM2 tidak dipakai.

- Kode + konfigurasi: repo `nyx-chat` (folder ini).
- State runtime: `~/nyx-selfhost` (KT v2, Grafana, Prometheus, env, sertifikat).
- Rahasia dan data **tidak** masuk git.

## Prasyarat

- Arch Linux, user dengan linger aktif.
- Paket sistem: `postgresql`, `valkey`, `cloudflared`, `nginx`, `nodejs`, `pnpm`, `rust`, `go`, `age`, `rclone`.
- `age` dan `rclone` boleh dipasang user-local di `~/.local/bin` bila tidak mau sudo.

## Instal / update

```bash
git clone git@github.com:h4nzs/nyx-chat.git ~/nyx-chat
cd ~/nyx-chat
bash deploy/selfhost/scripts/install-user.sh
bash deploy/selfhost/scripts/verify-boot.sh
```

`install-user.sh` memanggil `scripts/sync-selfhost.sh --apply` lebih dulu, lalu memasang
14 unit + `nyx.target` + timer backup. Unit di `~/nyx-selfhost` adalah hasil render;
jangan edit di sana.

Update kode:

```bash
cd ~/nyx-chat && git pull
bash scripts/sync-selfhost.sh --check   # lihat drift dulu
bash scripts/sync-selfhost.sh --apply
bash deploy/selfhost/scripts/rebuild.sh --restart
```

## OHTTP relay dan `OHTTP_TRUSTED_PROXIES`

Selfhost **tidak** memakai Docker: nginx (`nyx-nginx`) dan relay
(`nyx-ohttp-relay`) berjalan di host yang sama, dan nginx menyambung ke relay
di `127.0.0.1:4100` (hasil render `sync-selfhost.sh`). Karena itu alamat hop
langsung relay **selalu loopback**, dan nilai yang benar untuk
`OHTTP_TRUSTED_PROXIES` di `~/nyx-selfhost/ohttp/relay.env` (dan `server/.env`)
adalah **kosong** — default-nya hanya memercayai `127.0.0.1`/`::1`.

| Profil | `OHTTP_TRUSTED_PROXIES` | Alasan |
|---|---|---|
| `selfhost` (mesin ini) | *(kosong)* | nginx → relay lewat loopback |
| `docker` (`SELFHOST_PROFILE=docker`) | `172.16.0.0/12` (atau IP nginx) | nginx container → relay lewat jaringan container |

Jangan menyalin nilai profil Docker ke sini: relay lalu memakai alamat nginx
container untuk semua klien, dan `OHTTP_TRUSTED_PROXIES` yang salah lebih buruk
daripada kosong — tag per klien hilang tanpa error.

Yang harus ada di sisi nginx (sudah dibawa `ops/nginx/nyx.conf`, jangan diedit di
`~/nyx-selfhost`):

- `set_real_ip_from 127.0.0.1; set_real_ip_from ::1;` — cloudflared menyambung
dari loopback (nginx listen `127.0.0.1:3000`), jadi tanpa ini `$remote_addr`
tetap `127.0.0.1` untuk semua pengunjung;
- `proxy_set_header CF-Connecting-IP $remote_addr;` di blok relay dan `/api`
 (audit N10-03) — nilai yang diteruskan adalah hasil restorasi `real_ip`, bukan
 header kiriman klien.

Cek setelah instal/update — `verify-boot.sh` bagian 9 menguji keduanya:

```bash
bash deploy/selfhost/scripts/verify-boot.sh
# manual:
grep -E '^OHTTP_TRUSTED_PROXIES=' ~/nyx-selfhost/ohttp/relay.env   # harus kosong
grep -c 'CF-Connecting-IP \$remote_addr' ~/nyx-selfhost/nginx/nyx.conf  # ≥ 4
journalctl --user -u nyx-ohttp-relay -n 5 --no-pager              # tidak ada peringatan trust proxy
```

Gejala bila salah: semua pengguna OHTTP berbagi satu bucket rate-limit (429
massal saat beberapa klien memverifikasi kontak) dan
`nyx_ohttp_client_tag_total{status="tagged"}` hampir tidak naik padahal trafik
relay jalan.

## Backup

RPO 24 jam, RTO 4 jam (lihat `docs/39-disaster-recovery-runbook.md`).

Sekali saja:

```bash
mkdir -p ~/.local/bin ~/.config/nyx-backup
sudo pacman -S --needed age rclone
age-keygen -o ~/.config/nyx-backup/age-identity
age-keygen -y ~/.config/nyx-backup/age-identity > ~/.config/nyx-backup/age.pub
```

Simpan `age-identity` **di luar mesin ini** (password manager + media offline). Tanpa itu
bundle tidak bisa dibuka. Public key boleh ada di mesin.

Jalankan:

```bash
bash deploy/selfhost/scripts/backup.sh
systemctl --user enable --now nyx-backup.timer   # harian 03:30
```

Isi bundle: `pg_dump -Fc`, KT v2 (`db`, `snapshots`, `auditor-state.json`, config,
`auditor.key`), env server/web/OHTTP/PIR/Grafana/ntfy/exporter, sertifikat sidecar,
roots attestation, unit terpasang, meta commit/versi, manifes R2.

Unggahan memakai kredensial `R2_*` dari `server/.env` ke bucket `R2_BUCKET_NAME`
prefix `nyx-backups/`. Override bucket dengan `NYX_BACKUP_R2_BUCKET`.

Konfigurasi opsional:

| Variabel | Default |
|---|---|
| `NYX_BACKUP_DIR` | `~/nyx-backups` |
| `NYX_BACKUP_RECIPIENT_FILE` | `~/.config/nyx-backup/age.pub` |
| `NYX_BACKUP_RETENTION_DAYS` | `14` |
| `NYX_BACKUP_UPLOAD` | `1` |

## Restore

```bash
bash deploy/selfhost/scripts/restore.sh \
  --bundle ~/nyx-backups/nyx-backup-YYYYMMDDTHHMMSSZ.tar.gz.age
# dry-run; tambahkan --apply untuk menulis
```

Restore berhenti di `nyx.target`, memulihkan Postgres, env, sertifikat, KT v2, lalu
memasang ulang unit dan menjalankan `verify-boot.sh`. Tambahkan `--db-push` bila kode
yang dipulihkan lebih baru dari dump.

## Rahasia yang tidak boleh hilang

`NYX_AT_REST_PEPPER`, kunci log KT v2 (`config.yaml`, `auditor.key`), `NYX_OPRF_SEED`,
`PIR_MASTER_SECRET`, `BACKUP_KEY_SECRET`, kunci OHTTP, `JWT_SECRET`, `CHAT_SECRET`,
`CSRF_SECRET`. Detail ada di `SECRETS.md`.

## Catatan

- `deploy.yml` sekarang `workflow_dispatch`; push ke `main` tidak lagi auto-deploy ke VPS lama.
- WebTransport publik tetap mati (cloudflared tidak membawa QUIC/UDP); client fallback WSS.
- Auditor KT v2 satu host dengan API (bukan independensi organisasi).
