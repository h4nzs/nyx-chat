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
