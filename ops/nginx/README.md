# `ops/nginx` — config nginx yang ikut repo

`nyx.conf` adalah **sumber kebenaran** untuk site config reverse proxy NYX. Di
mesin selfhost ia menjadi `~/nyx-selfhost/nginx/nyx.conf`; `nginx/nginx.conf`
(master: worker/pid/log path) tetap lokal karena path-nya host-specific dan
tidak pernah disalin. Jangan mengedit salinan di mesin — perubahan di sana
hilang pada sinkronisasi berikutnya dan tidak pernah terlihat di review.

## Apa yang ada di sini

| Bagian | Catatan |
|---|---|
| `set_real_ip_from` + `real_ip_header CF-Connecting-IP` | Semua trafik masuk lewat Cloudflare. Tanpa blok ini `$remote_addr` adalah IP edge CF dan `X-Forwarded-For` dibangun di atas input yang bisa dipalsukan. **Rentang CF berubah** — cek https://www.cloudflare.com/ips/ sebelum deploy. |
| CSP dua sisi | Marketing lebih longgar; aplikasi **tanpa** `unsafe-eval` (Zod jitless, WASM lewat `wasm-unsafe-eval`). Jangan tambahkan `unsafe-eval` kembali. |
| `location = /api/ohttp/relay` | [docs/37 §37.4 P7] Meneruskan ke relay OHTTP terpisah. Di repo tertulis `ohttp-relay:4100` (Docker); profil `selfhost` di skrip sync mengubahnya menjadi `127.0.0.1:4100`. **Exact match** supaya tidak tertelan prefix `/api`. Relay sengaja tidak menerima `X-Forwarded-For`/`X-Real-IP`. |
| `location /api` | Proxy ke API: `server:4000` di repo (Docker), `127.0.0.1:4000` setelah profil `selfhost` ditransformasi. |

Yang **tidak** boleh ditambahkan ke config ini: route metrics. Enam exporter
(`9464`–`9469`) hanya loopback dan tidak punya auth; mengeksposnya lewat nginx =
membocorkan topologi dan laju trafik (docs/10 §10.12).

## Sinkronisasi

```bash
# dry-run (tidak menulis apa pun)
SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh

# tulis salinan + petunjuk reload
SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh --apply

# verifikasi (exit 1 bila drift)
SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh --check
```

Dua profil:

- `selfhost` (default): mengubah `/var/www/nyx-*` → `/home/ken/nyx-chat/*/dist`,
  `server:4000`/`ohttp-relay:4100` → `127.0.0.1`, dan menyinkronkan
  `ops/systemd/user/*.service` → `{SELFHOST}/systemd/user/`.
- `docker`: menyalin apa adanya + `docker-compose.yml` + unit sistem.

Rahasia (`.env`, kunci KT, sertifikat) dan nginx master **tidak** disinkronkan.

## Setelah mengubah config

```bash
sudo cp /root/nyx-selfhost/nginx/nginx.conf /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl reload nginx
```

Bila perubahan menyentuh `/api/ohttp/relay`: pastikan service relay hidup
(`curl -fsS http://127.0.0.1:4100/healthz`) dan `OHTTP_RELAY_EXTERNAL=1` sudah
diset di environment API.
