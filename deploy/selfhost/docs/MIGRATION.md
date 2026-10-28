# Migrasi ke server baru

RPO 24 jam / RTO 4 jam. Jangan mulai tanpa bundle backup yang bisa didekripsi.

## 1. Sebelum meninggalkan host lama

```bash
cd ~/nyx-chat
git status                      # harus bersih
git rev-parse HEAD              # catat SHA
bash deploy/selfhost/scripts/backup.sh
sha256sum ~/nyx-backups/*.age
```

Salin `*.age` + private key age ke host baru lewat kanal aman. Jangan lewat repo.

## 2. Host baru

Pasang Arch, `postgresql`, `valkey`, `cloudflared`, `nginx`, `nodejs`, `pnpm`, `rust`,
`go`, `age`, `rclone`; buat user, aktifkan linger; siapkan `/etc/cloudflared`
(token tunnel dari dashboard Cloudflare — tidak ada di bundle).

```bash
git clone git@github.com:h4nzs/nyx-chat.git ~/nyx-chat
cd ~/nyx-chat && git checkout <SHA>
pnpm install --frozen-lockfile
pnpm --filter @nyx/shared build
pnpm --filter nyx-server build
pnpm --filter nyx-web build
pnpm --filter marketing build
```

## 3. Restore

```bash
bash deploy/selfhost/scripts/restore.sh --bundle /path/bundle.tar.gz.age
bash deploy/selfhost/scripts/restore.sh --bundle /path/bundle.tar.gz.age --apply
bash deploy/selfhost/scripts/verify-boot.sh
```

Urutan yang dilakukan restore: stop `nyx.target` → Postgres → env/sertifikat → KT v2
→ unit → verifikasi. KT v2 start query dulu, auditor menyusul.

## 4. Cutover

1. Pastikan `verify-boot.sh` lulus dan KT v2 mode 3 mengembalikan head.
2. Arahkan tunnel/DNS ke host baru (tunnel token sama atau buat baru).
3. Cek `https://api.nyx-app.my.id/health`, app, marketing, upload, login.
4. Rotasi kredensial jangka pendek (Grafana, ntfy, exporter).
5. Simpan host lama 7 hari untuk rollback; jangan hapus data sebelum itu.

## 5. Rollback

Arahkan tunnel/DNS kembali ke host lama. Host lama tidak diubah selama migrasi.

## 6. Yang tidak ada di bundle

- Token tunnel Cloudflare (`/etc/cloudflared`).
- Objek R2 (hanya manifes; bucket tetap di Cloudflare).
- Binary Prometheus/Grafana/Alertmanager/exporter (unduh ulang; config ada).
- Database role/password bila berbeda dari dump.
