# 10 — Deployment & Operations

## 10.1 Topology (prod)

| Component | Where | Notes |
|---|---|---|
| Web app | `https://app.nyx-app.my.id` | Static build in `/var/www/nyx-web` (nginx) |
| API | `https://api.nyx-app.my.id` → `localhost:4000` | pm2 `nyx-api` (cluster) |
| WebTransport | `https://rt.nyx-app.my.id:33333` | pm2 `nyx-sidecar` (Rust, satu fork) |
| Marketing | `https://nyx-app.my.id` | `/var/www/nyx-marketing` |
| Key Transparency | `127.0.0.1:8085` (HTTP baca), `127.0.0.1:8081` (gRPC tulis), `127.0.0.1:8082` (gRPC auditor) | binary Go `nyx-kt-query` + LevelDB miliknya — **satu-satunya** pemilik log KT; binary + unit systemd dikirim `deploy.yml` (config + kunci log tetap owner ops, §10.15) |
| Relay OHTTP | `127.0.0.1:4100` (proses terpisah) | unit `nyx-ohttp-relay` dikirim `deploy.yml` dan di-restart hanya bila `enabled`; klien memakai `/api/ohttp/relay` di origin API → nginx (§10.18) |
| Sidecar PIR | `127.0.0.1:9470` (loopback) | binary `server/pir-sidecar`; **tidak** ikut `deploy.yml` (belum ada unit produksi) — jalankan manual bila `PIR_ENABLED=1` (§10.19) |
| DB | `127.0.0.1:5432/nyx_app` (user `nyx`) | Local PostgreSQL 18 on the VPS (versi prod terkonfirmasi dari dump — `docs/28` §28.7) |
| Redis | `127.0.0.1:6379` | pub/sub bridge + caches |
| Storage | Cloudflare R2 | Encrypted blobs + arsip snapshot KT (`kt-snapshots/`) |
| TURN (WebRTC) | coturn `:3478/udp+tcp`, `:5349/tls` + rentang relay | **primer** untuk kredensial `/api/keys/turn`; Cloudflare TURN hanya cadangan; prosesnya systemd = owner ops (§10.9) |
| Observability | NYX `127.0.0.1:9464`, sidecar `:9465`, auditor KT `:9466`, log KT `:9467`, log KT v2 `:9468`, auditor KT v2 `:9469`; Prometheus (default `:9090`); Alertmanager `:9093` + relay ntfy `:9095`; exporter node `:9100`, postgres `:9187`, redis `:9121`; Grafana | semuanya loopback; konfigurasinya di-commit di `ops/`; pemasangan manual (§10.12) |

`deploy.yml` mengurus **web, marketing, `nyx-api`, `nyx-sidecar`, binary + unit systemd `nyx-kt-query`/v2, dan unit `nyx-ohttp-relay`** (relay di-restart hanya bila unitnya `enabled`). Yang **tidak pernah** dikirim otomatis (owner ops, sinkron manual): `ops/nginx/nyx.conf` (§10.9), config + kunci log KT (§10.15), coturn, `ops/prometheus` + `ops/grafana` (§10.12), sysctl/PostgreSQL/Redis (§10.11), dan `.env` (hanya disalin lokal di VPS).

VPS: Debian 13, **4 core / 8GB RAM / 4GB swap** (upgraded 2026-10 from 1 core / 1GB RAM), `vm.swappiness=10`, PostgreSQL re-tuned for the larger box (see §10.11). The principle from docs/26 §26.9 still applies: the upgrade buys margin for privacy features, not bloat.

> ℹ️ The pre-upgrade sizing notes ("low-memory Postgres", replica caps, `password.ts` Argon2 "sweet spot") were written for the 1 GB box — treat them as historical context, not current constraints.

## 10.2 CI (`.github/workflows/ci.yml`)

On PR and push to `main`:

| Job | Content |
|---|---|
| `build` | gate cepat `scripts/check-wasm-artifacts.sh` + `scripts/check-vendor.sh` → Go build/vet/test `server/kt-query` **dari vendor** → frozen-lockfile install → prisma generate → `pnpm run build` |
| `wasm` | [R1] bangun ULANG `packages/spqr-wasm` + `packages/keytrans-wasm` dari `vendor/signal/*` lalu bandingkan hash dengan `packages/wasm-artifacts.json` (`scripts/wasm-repro-build.sh --verify`) — biner yang dikirim ke browser harus bisa dibuktikan asalnya |
| `unit` | `pnpm run test` — seluruh test server (`node:test` + `tsx`) dan web (vitest). Sengaja tanpa angka di dokumen ini: hitungannya berubah tiap penambahan test, dan angka basi di sini pernah menyesatkan |
| `lint` | **BLOCKING** — `pnpm run lint` = `oxlint src` per paket (ESLint dihapus 2026-10-15). Nol temuan untuk rule level `error` + kategori `correctness`; `no-unused-vars` sengaja `warn` |
| `alerts` | `SKIP_LIVE=1 scripts/drill-alerts.sh` — drill aturan Prometheus 4 lapis (§10.12); aturan yang merujuk metrik tak terdeklarasi ditolak di sini |
| `dr-oracle` | [WS-G(6)] `tools/dr-oracle` (Go, implementasi kedua tanpa libsodium): vet/test + gate drift vektor ter-commit + test NYX↔oracle & interop dua arah |
| `kt-recovery` | [§10.13] drill pemulihan log KT end-to-end (`scripts/kt-restore-drill.sh`) + `go vet`/`go test` `kt-query` |
| `audit` | `pnpm audit --prod` |
| `e2e` | Postgres+Redis services, `prisma db push` (consent env), Playwright chromium — transport specs auto-skip; setelah suite, `nyx-api` dinyalakan dan drill alert dijalankan terhadap exporter nyata (`METRICS_URL`) |
| `e2e-chrome` | Full Chrome via apt + Rust sidecar built & started; cert hash parsed into `VITE_TRANSPORT_CERT_HASH`; **coturn installed & started** (loopback relay, `allow-loopback-peers` only in CI) with `TURN_URLS`/`TURN_STATIC_AUTH_SECRET` in the job env; runs `--project=chrome` (WebTransport + real TURN relay active) |

## 10.3 Deploy pipeline (`deploy.yml`)

Push to `main` triggers:

- **Guards (gagal cepat, sebelum install):** `scripts/check-wasm-artifacts.sh` (artefak WASM ter-commit + cocok hash manifest `packages/wasm-artifacts.json`) dan `scripts/check-vendor.sh` (sumber Signal ter-vendor cocok pin `NOTICE`) — tanpa keduanya, clone bersih tidak bisa dibangun ulang.
1. Install (frozen lockfile) → assert secrets (`VITE_TURNSTILE_SITE_KEY` — satu-satunya yang di-assert hari ini) → build shared → web → marketing → server (incl. `prisma generate`) → Rust sidecar (`cargo build --release`) → binary layanan log KT (`bash server/kt-query/build.sh`, dari vendor; §10.15).
2. Package ke `nyx-deploy.zip`: manifest root + `packages/shared` (+ `dist`) + `web/dist` + `marketing/dist` + `server/{src,dist,package.json,tsconfig.json,prisma}` + binary sidecar + `server/kt-query/{nyx-kt-query,nyx-kt-check}` + `ops/systemd/`. **Tidak** ikut: `ops/nginx/nyx.conf`, `ops/{prometheus,grafana}`, `scripts/`, `docker-compose.yml`.
3. SCP to VPS (`root@…`) → `pm2 stop nyx-api nyx-sidecar` → binary KT lama disimpan sebagai `nyx-kt-query.prev` (rollback cepat) → unzip ke `/root/nyx-app` (menimpa; `server/{src,dist}`, `web/`, `marketing/` dihapus lebih dulu).
4. On VPS: `pnpm install --frozen-lockfile` → **copy `/root/nyx-app/.env` → `server/.env`** (prod secrets live only on the VPS) → `prisma generate` → `prisma db push` (consent env, `|| true`) → deploy web/marketing to `/var/www/…` → reload nginx → `pm2 delete` + `pm2 start` `nyx-api` (`-i max`, `--max-old-space-size=1024`) dan `nyx-sidecar` → `pm2 save --force`.
5. Layanan log KT (§10.15): binary di-`chmod +x`, unit `/etc/systemd/system/nyx-kt-query.service` disegarkan dari `ops/systemd/` + `systemctl daemon-reload`. Kalau unit **`enabled`**: `systemctl restart nyx-kt-query` → tunggu 2 s → `is-active` + `curl 127.0.0.1:8085/healthz`; gagal ⇒ deploy berhenti **merah** (log KT mati = kunci identitas baru tidak ter-audit). Kalau belum `enabled`: hanya pesan informatif — pemasangan pertama ada di `ops/systemd/README.md`.
6. Relay OHTTP (§10.18): unit `/etc/systemd/system/nyx-ohttp-relay.service` disegarkan dari `ops/systemd/`. Kalau unit **`enabled`**: pastikan `server/dist/ohttp/relay.js` ada, `systemctl restart nyx-ohttp-relay`, lalu `is-active` + `curl 127.0.0.1:4100/healthz`; gagal ⇒ deploy merah. Kalau belum `enabled`: pesan informatif (relay masih dilayani API bila `OHTTP_RELAY_EXTERNAL` tidak diset). Sidecar PIR **tidak** ikut deploy (belum ada unit sistem/pm2).

> ⚠ Any change to `.env` on the VPS will be **overwritten from `/root/nyx-app/.env`** on the next deploy. Edit the root file, not `server/.env`.

## 10.4 VPS runbook (SSH)

```bash
ssh -i <key> root@<VPS>

pm2 list                                # nyx-api (cluster), nyx-sidecar (fork)
pm2 logs nyx-api --lines 100 --nostream # API logs
pm2 restart nyx-api                     # restart after .env change
systemctl status postgresql redis-server
systemctl status nginx coturn            # reverse proxy + TURN primer (bila sudah dipasang)
pg_isready && redis-cli ping
free -m                                 # RAM pressure watch
ls /root/backups/                       # nightly pg_dumps
curl -s 127.0.0.1:9464/metrics | head    # exporter metrik NYX (loopback, §10.12)
curl -s 127.0.0.1:8085/healthz           # layanan KT: {treeSize,timestamp} (§10.15)
ls /var/lib/nyx/kt-snapshots/            # arsip snapshot KT terverifikasi (§10.13)
```

## 10.5 Post-deploy checklist

1. `curl https://api.nyx-app.my.id/health` → `{"status":"ok bang"}`.
2. `pm2 logs nyx-api` — no `DatabaseNotReachable` / `TlsConnectionError`; sweeper started.
3. Open the app with a **hard reload** (service worker update) — check console for `missingKey` or CSP violations.
4. Register + send a message between two accounts.
5. Confirm no `unsafe-eval` CSP errors (Zod jitless must be intact).
6. [R11] Baca peringatan boot `⚠️  [startup]` di `pm2 logs nyx-api`: guard
   anti-abuse dan rahasia admin cleanup yang belum diset dilaporkan di sana, dan
   gauge `nyx_abuse_guard_enabled` harus membuat alert `NyxAbuseGuardDisabled`
   menyala bila guard memang sengaja dimatikan. Jangan biarkan alert itu menyala
   tanpa keputusan eksplisit.
7. [R1] Pastikan job CI `wasm` hijau: biner WASM yang di-deploy terbukti berasal
   dari `vendor/signal/*` (`scripts/wasm-repro-build.sh --verify`).
8. [§10.15] Layanan KT hidup: `systemctl is-active nyx-kt-query` → `active`, lalu
   `curl -s http://127.0.0.1:8085/healthz` → `{treeSize,timestamp}`, dan
   `/api/keys/kt/*` menjawab bukti (bukan 503 `KT_QUERY_DISABLED`). Health check
   penuh `nyx-kt-query -check` membuka LevelDB, jadi **hentikan service dulu**
   (`systemctl stop`, lalu `start`) — beda tree head dengan `latest.json` terakhir
   berarti basis data dan arsip tidak sinkron.
9. [§10.12] `curl -s http://127.0.0.1:9464/metrics` hidup, dan
   `nyx_metrics_rejected_total` tetap **0**.

## 10.6 Environment variables (full table)

### Server (`/root/nyx-app/.env`)

**Wajib di production.** `config.ts` memperingatkan var wajib yang kosong (`PORT`, `CORS_ORIGIN`, `JWT_SECRET`) dan **menolak boot** bila `JWT_SECRET` kosong / bernilai `dev-secret`; `NYX_AT_REST_PEPPER` melempar error begitu dipakai tanpa nilai di produksi, dan issuer key gagal-tertutup saat kredensial grup diminta:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://nyx:<pw>@127.0.0.1:5432/nyx_app` (PostgreSQL lokal, plaintext — `server/src/lib/prisma.ts` menambahkan `sslmode=require` **hanya** untuk host non-lokal) |
| `DIRECT_URL` | (opsional) URL untuk `prisma db push`; `prisma.config.ts` memakai `DIRECT_URL \|\| DATABASE_URL` |
| `PORT` | Port Express (default `4000`) — ikut daftar env wajib `config.ts` |
| `CORS_ORIGIN` | Origin yang diizinkan, dipisah koma (default produksi `https://app.nyx-app.my.id`) |
| `JWT_SECRET` | Token signing (≥32 chars). Produksi menolak boot bila kosong / bernilai `dev-secret` |
| `CSRF_SECRET` | CSRF state secret. Kosong di produksi → jatuh ke `JWT_SECRET` + peringatan boot (isolasi lebih lemah) |
| `NYX_AT_REST_PEPPER` | [docs/28 Tier 0] Pepper hash identifier at-rest + kunci seal legacy (id `0`). **Wajib**: `utils/atRestSecrets.ts` melempar error di produksi tanpa ini; bocor = dump DB bisa dibalik |
| `NYX_AT_REST_KEYRING` / `NYX_AT_REST_KEYRING_FILE` | [docs/37 P6, docs/10 §10.17] Key ring seal ber-versi (`ENC2:<keyId>:…`). Kosong = kunci legacy saja. Isi JSON `{active,keys}` atau path file 0400. Rotasi + re-seal lewat `scripts/reseal-at-rest.ts` |
| `NODE_ENV` | `production` |

**Perilaku & fitur** (kosong = fitur mati / degradasi yang terlihat):

| Var | Purpose |
|---|---|
| `HOST` | Interface bind, default `127.0.0.1` (`server/src/index.ts`) — cloudflared satu host; jangan buka tanpa alasan |
| `APP_URL` | Origin publik API (dipakai pada tautan/redirect) |
| `REDIS_URL` | `redis://127.0.0.1:6379` — bridge pub/sub, rate limit, presence |
| `CHAT_SECRET` | Rahasia umum (masih dipakai beberapa fitur) — **fallback** kunci `/api/admin/cleanup` |
| `ADMIN_CLEANUP_SECRET` | [R6] Rahasia KHUSUS `/api/admin/cleanup` (endpoint destruktif). Sangat disarankan terpisah dari `CHAT_SECRET`; kosong → `CHAT_SECRET` + peringatan boot |
| `ADMIN_CLEANUP_IP_ALLOWLIST` | [R6] CSV IP yang boleh memicu `/api/admin/cleanup`. Kosong = tanpa batasan IP. Diperiksa **sebelum** kunci |
| `BACKUP_KEY_SECRET` | HMAC kunci objek backup R2 (fallback `JWT_SECRET` + peringatan; harus **STABIL** — rotasi JWT_SECRET akan membuat backup awan lama tak ditemukan, `docs/31` §31.6b) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_DOMAIN` | Cloudflare R2: blob terenkripsi + arsip snapshot KT |
| `UPLOAD_DIR` | Direktori fallback upload lokal bila tidak memakai bucket R2 (default `uploads`) |
| `GROUP_RELEASE_JITTER_MS` | [docs/37 P8] Jitter rilis pesan grup (ms, default kosong = mati, clip 2000). Menambah latensi ACK? Tidak — ACK dikirim dulu; hanya relay yang ditunda. Metrik `nyx_group_release_delay_ms` |
| `OHTTP_RELAY_EXTERNAL` | [docs/37 P7] `1` = relay OHTTP dijalankan proses terpisah; API tidak memasang `/api/ohttp/relay`. Butuh `nyx-ohttp-relay`; klien memakai default same-origin `/api/ohttp/relay` (nginx → `:4100`), `VITE_OHTTP_RELAY_URL` hanya bila relay berada di origin lain (§10.18) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile verify (register/PoW) |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push |
| `TURN_URLS` / `TURN_STATIC_AUTH_SECRET` / `TURN_TTL` | coturn self-host **primer** (WebRTC): kredensial HMAC time-limited, username memakai `identityTag` (bukan userId). Kosong → jatuh ke Cloudflare. `docs/30` §30.9 |
| `ICE_STUN_URLS` | STUN milik operator (opsional, dipisah koma). Kosong = **tidak ada** STUN pihak ketiga; kegagalan TURN jadi 503/502 yang terlihat (`docs/29` §5.7) |
| `CF_ACCOUNT_ID` / `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | Cloudflare TURN (WebRTC) — **cadangan** sejak WS-E(1) |
| `KT_SERVER_URL` / `KT_TIMEOUT_MS` | gRPC test-update log KT; samakan dengan `-write-addr` `nyx-kt-query` (`http://127.0.0.1:8081`). Kosong = penulisan log nonaktif (`docs/32` §32.8) |
| `KT_QUERY_URL` / `KT_QUERY_TIMEOUT_MS` | Layanan baca KT (`http://127.0.0.1:8085`). Kosong = `/api/keys/kt/*` menjawab 503 `KT_QUERY_DISABLED` dan klien jatuh ke TOFU (metrik `result="disabled"`) |
| `KT_SNAPSHOT_DIR` | Direktori arsip milik `nyx-kt-query`; diisi = unggahan harian 03:30 ke R2 + retensi 30 hari (§10.13) |
| `MIN_CLIENT_VERSION` | [R2] Versi klien minimum (mis. `3.0.0`). Klien dengan versi lebih kecil ditolak `426 CLIENT_TOO_OLD` + pesan "perbarui aplikasi" — bukan kehilangan kunci grup secara senyap. Kosong = gerbang mati; klien **tanpa** header versi selalu lolos (§10.14) |
| `METRICS_HOST` / `METRICS_PORT` | Exporter metrik loopback (default `127.0.0.1:9464`; `0` = mati) — §10.12 |
| `ABUSE_REGISTRATION_GUARD` | `on` \| `shadow` \| `off`. `on` = guard burst registrasi (per IP ter-HMAC, per instalasi, per ASN) **menahan**; `shadow` = evaluasi penuh tapi tidak menahan siapa pun (mengukur false-positive NAT lewat `nyx_registration_guard_observed_total`); default `off` (no-op). `docs/30` §30.12 |
| `ABUSE_REQUIRE_ATTESTATION` | `on` = SEMUA akun baru wajib attestation perangkat keras. Heuristik burst sybil per-ASN tetap meminta attestation walau ini `off` |
| `ABUSE_ATTESTATION_FORMATS` / `ABUSE_ATTESTATION_BLOCKED_AAGUIDS` / `ABUSE_ATTESTATION_ROOTS` | Kebijakan attestation: format yang diterima, AAGUID yang diblokir, fingerprint root yang dipercaya |
| `ABUSE_ATTESTATION_ALLOW_SELF` / `ABUSE_ATTESTATION_ALLOW_NONE` / `ABUSE_ATTESTATION_ALLOW_SYNCED` / `ABUSE_ATTESTATION_ALLOW_UNATTESTED` / `ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN` / `ABUSE_ATTESTATION_ALLOW_NO_AIK_EKU` | Pelonggaran verifikasi. `ALLOW_NONE=on` + `ALLOW_SYNCED=on` + `none` di `ABUSE_ATTESTATION_FORMATS` = **mode passkey**: menerima passkey tersinkron Google/Apple (`fmt: none`, `multiDevice`) yang dipakai default di Android/iOS; gate hanya membuktikan authenticator ber-UV. `ALLOW_UNATTESTED=on` = perangkat tanpa authenticator sama sekali boleh mendaftar tanpa bukti (hanya bila permintaan datang dari kebijakan global, bukan dari burst per-ASN). Kedua jalur membuat akun `isVerified=false` (sandbox: upload & pencarian luas tertutup) dan memunculkan peringatan boot. `ALLOW_SELF`/`ALLOW_UNVERIFIED_CHAIN` tetap **hanya untuk test** — keduanya membuat tier "hardware" bisa dipalsukan |
| `ASN_DB_FILE` | Tabel `prefix,asn` LOKAL (ekspor GeoLite2-ASN). Kosong = lapisan ASN nonaktif; IP mentah tidak pernah disimpan, yang masuk Redis hanya nilai ter-pepper |
| `NOWPAYMENTS_API_KEY` / `NOWPAYMENTS_IPN_SECRET` | Payments (crypto-only) |
| `DISCORD_REPORT_WEBHOOK_URL` | Abuse reports |

> Catatan: `RESEND_API_KEY` dan `SUPABASE_URL/SUPABASE_SERVICE_KEY` yang dulu ada di tabel ini **sudah tidak ada di kode** (tidak ada pemakaian `process.env.*`-nya maupun di `.env.example`) — jangan diset lagi.

### `nyx-sidecar` (env proses Rust, `docs/08` §8.2)

`JWT_SECRET` (harus sama dengan API — token AUTH diverifikasi di sidecar), `REDIS_URL`, `TRANSPORT_PORT` (default `33333`, **UDP**), opsional `PROD_CERT_PATH` / `PROD_KEY_PATH` (sertifikat CA di produksi; tanpa keduanya sidecar membuat self-signed dan mencetak hash-nya), `TRANSPORT_METRICS_ADDR` (default `127.0.0.1:9465`; **wajib loopback** — alamat non-loopback ditolak saat start; `0` = exporter mati).

### `nyx-kt-query` (env proses log KT, §10.15)

`KT_CONFIG_FILE` (config YAML berisi kunci log + `db.file`), `NYX_KT_QUERY_ADDR` (default `127.0.0.1:8085`), `NYX_KT_WRITE_ADDR` (`127.0.0.1:8081`), `NYX_KT_AUDITOR_ADDR` (`127.0.0.1:8082`), `NYX_KT_SNAPSHOT_DIR`, `NYX_KT_SNAPSHOT_INTERVAL` (`24h`), `NYX_KT_SNAPSHOT_KEEP` (`7`), `NYX_KT_METRICS_ADDR` (default `127.0.0.1:9467`; wajib loopback, `0` = mati). Semua alamat = loopback; tidak ada port KT yang boleh publik.

### `nyx-kt-query-v2` (env proses log KT v2, transisi docs/35 §35.7)

Paralel dan **terpisah** dari v1: database, config, snapshot, dan port sendiri
(`NYX_KT_V2_QUERY_ADDR` default `127.0.0.1:8089`, `NYX_KT_V2_WRITE_ADDR`
`:8088`, `NYX_KT_V2_AUDITOR_ADDR` `:8087`, `NYX_KT_V2_SNAPSHOT_DIR`,
`NYX_KT_V2_METRICS_ADDR` default `127.0.0.1:9468`). Unit + contoh env:
`ops/systemd/nyx-kt-query-v2.*`; auditor ML-DSA: `nyx-kt-auditor-v2.*`
(`NYX_KT_V2_AUDITOR_*`, metrics `:9469`). Server menulis ke keduanya bila
`KT_V2_SERVER_URL` diisi; pembacaan pindah dengan mengarahkan `KT_QUERY_URL` ke
`:8089`. Saat `/etc/nyx/kt-v2/config.yaml` belum ada, `deploy.yml` menjalankan
`nyx-kt-v2-init` lalu meng-`enable` kedua unit (bootstrap otomatis); setelah
`enabled`, setiap deploy me-restart + health-check. Cutover baca dan backfill
tetap manual — lihat §10.15.

### Web (`web/.env` → build-time `VITE_*`, disuntik `deploy.yml` dari secrets)

| Var | Purpose |
|---|---|
| `VITE_API_URL` | Origin REST API |
| `VITE_TRANSPORT_URL` | Origin WebTransport (mis. `https://rt.nyx-app.my.id:33333`); kosong = diturunkan dari `VITE_API_URL` **hanya bila absolut**. Dengan `VITE_API_URL` relatif, WebTransport dilewati dan klien langsung memakai WSS (§10.20) |
| `VITE_TRANSPORT_CERT_HASH` | Pin sertifikat sidecar untuk **dev/localhost** (produksi memakai trust CA `rt.nyx-app.my.id`) |
| `VITE_TURNSTILE_SITE_KEY` | Situs Turnstile — satu-satunya secret yang di-assert `deploy.yml` |
| `VITE_VAPID_PUBLIC_KEY` | Kunci publik Web Push |
| `VITE_APP_SECRET` | Secret aplikasi klien (diambil dari secrets CI saat build) |
| `VITE_WSS_TRANSPORTS` | Transports socket.io untuk fallback WSS (mis. `websocket` di belakang LB tanpa sticky) — §10.10 |
| `VITE_SPQR_FORCE_V1` / `VITE_SPQR_FORCE_V2` | Kill switch operator jalur ratchet v2 / override uji-E2E (`docs/33` §33.10) |
| `INDEXNOW_API_KEY` | Ping IndexNow setelah build |

## 10.7 Secrets policy

- `.env` files are gitignored; `.env.example` (root) and `server/.env.example` are the templates — setiap var di §10.6 punya komentarnya di sana.
- GitHub Actions secrets: `VPS_HOST/PORT/USER/PASSWORD`, `VITE_API_URL`, `VITE_TRANSPORT_URL`, `VITE_TURNSTILE_SITE_KEY` (di-assert saat deploy), `VITE_APP_SECRET`, `VITE_VAPID_PUBLIC_KEY`, `INDEXNOW_API_KEY`, `CI_DATABASE_URL` (optional). `VITE_TRANSPORT_CERT_HASH` **bukan** secret deploy — ia di-parse dari banner sidecar hanya di job `e2e-chrome` dan untuk dev lokal.
- Do not commit: DB passwords (VPS: `/root/.nyx_db_pass`), VAPID private keys, R2 secret keys, sidecar private keys (`*.der`).
- Kunci yang **wajib** ada hanya di `.env` produksi (bukan di DB, bukan di backup): `NYX_AT_REST_PEPPER` dan config YAML `nyx-kt-query` (kunci `signing-key`/`vrf-key`/`prefix-key`/`opening-key` log KT). Bocornya pepper = identifier at-rest bisa dibalik; bocornya kunci log KT = log bisa ditulis oleh pihak lain.

## 10.8 Rollback

1. `git revert <bad commit>` → push → deploy reruns.
2. DB has no automatic migration rollback — restore the latest nightly dump if a destructive `db push` shipped (downtime + `pg_restore`).

## 10.9 Security hardening sync (2026-08-23)

Remediation of `SECURITY-ASSESSMENT-2026-08-23.md` (plan: `.omo/plans/security-remediation.md`) landed in commits `d0ba35b0` (H1/H2/M1/M3), `9d520856` (M2 OTPK quota), `32814663` (L2 CSP), `9a6584d5` (nginx real_ip/XFF), `dd00d425` (I1 metadata). Everything below is **manual ops** — `deploy.yml` does **not** ship `ops/nginx/nyx.conf`, so the VPS nginx config must be synced by hand, and it must be re-synced every time that file changes in the repo.

> ⚠ **Ordering matters:** commit `d0ba35b0` sets Express `trust proxy = 2`. On the *current* (pre-sync) prod chain, `req.ip` resolves to the leftmost, attacker-forgeable XFF entry — the H1 rate-limit bypass is only fully closed **after** this nginx sync. Do the sync promptly; verify with the curls in step 4.

### Step 1 — Refresh Cloudflare IP ranges

The `set_real_ip_from` block in `ops/nginx/nyx.conf` was fetched from <https://www.cloudflare.com/ips/> on 2026-08-23 and is marked VERIFY-AT-SYNC-TIME. Re-fetch and update any changed ranges before syncing:

```bash
curl -s https://www.cloudflare.com/ips-v4; echo ---; curl -s https://www.cloudflare.com/ips-v6
```

### Step 2 — Syntax check locally

`ops/nginx/nyx.conf` is an http-context **snippet** (starts with `include mime.types`), not a full main config — mounting it directly as `/etc/nginx/nginx.conf` fails with `"types" directive is not allowed here`. Wrap it:

```bash
cat > /tmp/opencode/nginx-wrap.conf <<'EOF'
events { worker_connections 16; }
http { include /check/nginx.conf; }
EOF
docker run --rm --add-host=server:127.0.0.1 \
  -v "$PWD/ops/nginx/nyx.conf":/check/nginx.conf:ro \
  -v /tmp/opencode/nginx-wrap.conf:/etc/nginx/nginx.conf:ro \
  nginx:alpine nginx -t
# expect: syntax is ok / test is successful
```

(`--add-host=server:127.0.0.1` is needed because `proxy_pass http://server:4000` resolves the upstream hostname at parse time.)

### Step 3 — Sync to VPS

```bash
ssh -i <key> root@<VPS> 'nginx -T 2>/dev/null | grep -m1 "configuration file"'   # locate active conf path
ssh -i <key> root@<VPS> 'cp <conf-path> <conf-path>.bak.$(date +%F)'
scp -i <key> ops/nginx/nyx.conf root@<VPS>:<conf-path>
ssh -i <key> root@<VPS> 'nginx -t && systemctl reload nginx'
```

If the VPS splits server blocks into `sites-*` includes instead of consuming this file whole, merge per-block and keep the top-of-http real_ip block in the main conf.

### Step 4 — Post-sync verification

```bash
# a) Forged XFF must no longer split rate-limit buckets:
#    both requests must report IDENTICAL RateLimit-* reset/remaining values.
curl -sS -D - -o /dev/null -H 'X-Forwarded-For: 1.2.3.4'       https://api.nyx-app.my.id/api/csrf-token | grep -i ratelimit
curl -sS -D - -o /dev/null -H 'X-Forwarded-For: 5.6.7.8'       https://api.nyx-app.my.id/api/csrf-token | grep -i ratelimit

# b) Disallowed origin: HTTP 200, NO access-control-allow-origin header, NOT 500.
curl -sS -D - -o /dev/null -H 'Origin: https://evil.example'   https://api.nyx-app.my.id/health

# c) /api/keys mutations are CSRF-protected now: expect 403 EBADCSRFTOKEN.
curl -sS -D - -o /dev/null -X POST https://api.nyx-app.my.id/api/keys/prekey-bundle \
  -H 'Content-Type: application/json' -d '{"userIds":["x"]}'
```

Also re-check §10.5 items 3–5 (console free of CSP violations after hard reload).

### Step 5 — L1 hardening (updated 2026-08-24, "Option A" decision)

`rt.nyx-app.my.id` must stay **direct-to-origin**: Cloudflare does not proxy
WebTransport sessions (edge terminates HTTP/3; tunnel is HTTP(S) off-ramp only),
and Spectrum is out of budget. So `dig rt.nyx-app.my.id` keeps revealing the VPS
IP (`103.169.207.156`). The mitigation is to make that knowledge worthless:

1. **Loopback-bind every TCP listener** so nothing answers on the public IP:
   - Express: default `HOST=127.0.0.1` since commit `b36541ac` (verify:
     `ss -tlnp | grep 4000` → `127.0.0.1:4000`).
   - nginx: both server blocks now `listen 127.0.0.1:3000;` (cloudflared connects
     over loopback, unaffected). Verify after sync: `ss -tlnp | grep 3000`.
   - Result: satu-satunya soket publik yang tersisa adalah QUIC sidecar di
     `:33333` — dirancang untuk P2P langsung (auth JWT + pinning cert-hash di klien)
     — plus listener coturn begitu TURN primer dipasang, yang memang **harus**
     dapat dijangkau publik supaya panggilan bisa direlay.
2. **Firewall default-deny inbound** (owner ops on the VPS):
   ```bash
   ufw default deny incoming
   ufw allow 22/tcp          # or restrict to your admin IP(s)
   ufw allow 33333/udp       # WebTransport sidecar (QUIC)
   # Bila coturn berjalan (TURN primer, §10.6 / docs/30 §30.9): TURN memang harus
   # bisa dijangkau dari internet — samakan rentang relay dengan min-port/max-port
   # di turnserver.conf (CI memakai 49160-49200; instalasi umum 49152-65535).
   ufw allow 3478/udp
   ufw allow 3478/tcp
   ufw allow 5349/tcp
   ufw allow 49152:65535/udp
   ufw enable && ufw status verbose
   ```
   cloudflared egress (:7844 outbound) is unaffected. Port Prometheus/exporter dan
   `nyx-kt-query` **tidak** pernah dibuka: semuanya loopback (§10.12, §10.15).
3. ~~Front `rt.` with Tunnel/Spectrum~~ — not feasible today (no CF WebTransport
   proxying); revisit if Cloudflare ships it or budget allows Spectrum.

Residual risk (accepted, documented honestly):

- **Direct-to-origin DDoS on :33333** bypasses Cloudflare absorption while `rt`
  is direct. Impact is limited to realtime transport; REST API traffic rides the
  tunnel and stays up.
- If this IP ever appeared in historical DNS records (SecurityTrails etc.), removing
  the A-record would not un-leak it — which is exactly why steps 1–2 (shrinking the
  attack surface behind the IP) matter more than hiding the record itself.

### Step 6 — Tunnel topology & origin binding (added 2026-08-23)

Actual prod topology (confirmed with owner): **all** web/API traffic rides a Cloudflare
Tunnel (`cloudflared` makes outbound-only connections; nothing listens on :80/:443 by design):

```
CF edge ──tunnel──► nginx :3000      (app.nyx-app.my.id static, nyx-app.my.id marketing)
CF edge ──tunnel──► Express :4000    (api.nyx-app.my.id — DIRECT, bypasses nginx)
P2P QUIC ─────────► sidecar :33333   (rt.nyx-app.my.id WebTransport)
```

Implications:

1. **nginx XFF normalization (Steps 1–3) only protects hosts that traverse nginx.**
   `api.*` reaches Express directly, so `req.ip` there can still resolve to a forged
   XFF entry regardless of nginx config. The authoritative control for the API path is
   now **code-side**: `cfAwareClientIp()` (`server/src/utils/clientIp.ts`, commit
   `fc90a530`) keys rate limits, PoW and CSRF on `CF-Connecting-IP`, which the CF edge
   always overwrites with the real client IP on both proxy and tunnel paths.
2. After deploying `fc90a530`, re-run the Step 4a curls: forged `X-Forwarded-For`
   must **no longer open fresh buckets** — identical `RateLimit-*` values expected
   for any forged header value.
3. Recommended hardening inside this topology (owner ops):
   - Express now binds to loopback **by default in code** (`server/src/index.ts`:
     `HOST` env override, default `127.0.0.1`) so the PM2 socket is not reachable
     even if the VPS firewall slips — cloudflared connects over loopback and keeps
     working unchanged. After deploy, verify with `ss -tlnp | grep 4000`: it must
     show `127.0.0.1:4000`, not `0.0.0.0:4000` / `*:4000`.
   - Keep the VPS firewall deny-all inbound except SSH and the `rt.` QUIC port.
   - Optional: route `api.*` through nginx too (tunnel → nginx :3001 → Express) for
     uniform logging/limits; not required for security once (1) is deployed.

## 10.10 Realtime horizontal scaling (added 2026-08-24)

The WSS fallback gateway (`server/src/realtime/gateway.ts`) was designed so a single
Node process today can become N replicas later without protocol changes:

**Why the design is already replica-safe**

| Concern | Mechanism | Multi-instance status |
|---|---|---|
| Inbound events | Delegated to `realtimeHandlers.ts` which publishes via the shared Redis relay (`nyx:upstream`/`nyx:downstream`) | ✅ any replica can process any socket's traffic |
| Rate limits | Redis Lua (`checkRateLimit`), shared counters | ✅ cluster-wide by construction |
| Single-active-device check | Redis-backed with 60s local cache | ✅ safe across replicas |
| Outbound delivery | Broadcast-and-filter: every replica subscribes `nyx:downstream`, delivers only to sockets it holds locally | ✅ no `@socket.io/redis-adapter` needed **as long as delivery keeps flowing through this subscriber — never introduce `io.to(room).emit` without adding the adapter** |
| Rolling deploys | `closeWssGateway()` drains all sockets on SIGTERM/SIGINT before `httpServer.close()` (5s hard-exit fallback) | ✅ clients reconnect to another replica instead of timing out |

**Checklist when scaling past one replica**

1. **Sticky sessions OR websocket-only transports.** The polling transport
   long-polls and must land on the same replica during handshake/upgrade. Either:
   - put a sticky LB in front of the Express replicas (nginx `ip_hash`/cookie, HAProxy),
     or
   - build the web bundle with `VITE_WSS_TRANSPORTS=websocket` — a pure WebSocket
     connection is one upgraded TCP stream that any stateless LB can route freely.
2. **Run N × `pm2 scale nyx-api <N>`** behind that LB (each binds its own port via
   `PORT`; keep `HOST=127.0.0.1`). Point cloudflared ingress at the LB instead of a
   single :4000.
3. **Redis & Postgres stay shared singletons** — they are already the coordination
   layer; nothing else to change.
4. **Memory budget**: each extra Node replica adds roughly the current RSS of
   `nyx-api`. On the upgraded 4 core / 8 GB RAM / 4 GB swap VPS, ~4–6 replicas fit
   comfortably; beyond that, vertical scaling is still the cheapest first step.
5. The Rust WebTransport sidecar keeps its own session map per replica — if you ever
   run multiple sidecars, device targeting already tolerates unknown device IDs
   (continue-on-nonmatch), but presence fan-out assumes one sidecar; treat multi-sidecar
   as unsupported until it needs to exist.

## 10.11 Post-upgrade tuning (4 core / 8 GB RAM / 4 GB swap)

Recommended settings for the new box (owner ops on the VPS; `deploy.yml` does not manage sysctl/Postgres/Redis config):

**Sysctl / kernel**

- Keep `vm.swappiness=10` (RAM is plentiful now, swap stays an emergency buffer).
- Optional: `vm.vfs_cache_pressure=50` — retains more inode/dentry cache now that RAM is not scarce.

**PostgreSQL (replaces the old low-memory tuning)**

```ini
shared_buffers = 2GB            # 25% of RAM
effective_cache_size = 6GB      # OS cache estimate (75%)
work_mem = 16MB                 # per sort/hash node — 16MB is plenty at this scale
maintenance_work_mem = 512MB    # autovacuum / index builds
max_connections = 100
max_wal_size = 2GB
checkpoint_completion_target = 0.9
random_page_cost = 1.1          # SSD-backed volume
```

Restart Postgres after the change and confirm with `SHOW shared_buffers;`.

**Redis**

- `maxmemory 768mb` + `maxmemory-policy allkeys-lru` for the cache keyspace; rate-limit keys rely on `noeviction` semantics — keep them in a separate logical DB or ensure the LRU pool never contains them (docs/27 §27.1).
- Enable AOF persistence (`appendonly yes`, `appendfsync everysec`) — the bridge state is rebuildable but restarts are faster and pub/sub counter state survives.

**PM2 / Node**

- `deploy.yml` starts `nyx-api` with `-i max` (cluster = 1 worker per core) and `--max-old-space-size=1024`. On 4 cores that is a ~4 GB worst case — still fine under 8 GB alongside Postgres (2 GB) + Redis (< 1 GB). Raise `--max-old-space-size` to `1536` only if RSS actually climbs; don't preemptively.
- The Rust sidecar's tokio runtime now gets real parallelism — leave `nyx-sidecar` as a single fork instance; it no longer competes with the API cluster for the one core.



## 10.12 Observability tanpa telemetry (added 2026-10-11, docs/30 WS-G)

Prinsipnya dari `docs/27` §27.7 dan `docs/30` §30.1: **hitung event, jangan
pernah identitas.** Yang menegakkan itu bukan disiplin penulis kode, melainkan
`server/src/utils/metrics.ts`:

1. Metrik wajib dideklarasikan lebih dulu (`defineCounter/Gauge/Histogram`) →
   tidak ada deret waktu yang lahir dari nilai runtime (kardinalitas tak
   terbatas adalah jalur exfil paling mudah).
2. Label wajib ada di deklarasi; nilai label wajib pendek (≤24 char) dan bukan
   bentuk UUID / heksadesimal ≥32 / base64url ≥22 / IPv4 / IPv6 / email.
3. Pelanggaran **ditolak lalu dihitung** di `nyx_metrics_rejected_total` →
   percobaan menaruh identitas ke metrik justru memicu alert
   (`NyxMetricsIdentityLeakAttempt`), bukan hilang diam-diam.

**Endpoint.** `GET /metrics` dilayani oleh HTTP listener terpisah yang hanya
bind loopback (`METRICS_HOST=127.0.0.1`, `METRICS_PORT=9464`; `0` = mati) —
**bukan** route Express: jalur publik ke Express (`/api`, `/uploads`,
`/.well-known` lewat nginx, dan `api.*` yang bahkan melewati nginx) sengaja tidak
pernah membawa endpoint metrik. Lihat juga temuan `ops/prometheus/` (job scrape
`nyx-api` → `127.0.0.1:9464`). Jangan membuka port ini ke internet, dan jangan
menambah relabel Prometheus yang menyuntikkan header/query ke label.

**Metrik yang tersedia hari ini** (daftar ini harus sama dengan
`server/src/utils/metrics.ts` — aturan alert yang merujuk metrik tak terdeklarasi
akan ditolak lapis kontrak metrik di `scripts/drill-alerts.sh`):

| Metrik | Arti |
|---|---|
| `nyx_relay_ops_total{op,result}` | Operasi relay upstream (`accepted`/`blocked`/`unhandled`/`error`) per opcode |
| `nyx_security_blocks_total{op,reason}` | Blokir keamanan sesi/perangkat (`device_inactive`, `session_revoked`, `identity_missing`, `hardware_mismatch`) |
| `nyx_sweeper_duration_seconds{result}` | Durasi putaran sweeper |
| `nyx_sweeper_last_run_timestamp_seconds{result}` | Kapan sweeper terakhir selesai (termasuk yang gagal) |
| `nyx_sweeper_deleted_rows_total{kind}` | Baris dibersihkan (`refresh_token`, `session_key`, `account`, `subscription`, `story`) |
| `nyx_backup_ops_total{op,result}` | Operasi endpoint backup R2 (presign/unduh/hapus) per hasil — `docs/31` |
| `nyx_kt_writes_total{result}` | Penulisan entri log KT, per hasil |
| `nyx_kt_last_success_timestamp_seconds` | Unix timestamp penulisan log KT terakhir yang **berhasil** (lag = selisihnya) |
| `nyx_kt_queries_total{result}` | Permintaan bukti lewat `/api/keys/kt/*`; `result="disabled"` = `KT_QUERY_URL` kosong (klien jatuh ke TOFU) |
| `nyx_kt_snapshot_upload_total{result}` | Unggahan arsip snapshot KT ke R2 (§10.13) |
| `nyx_kt_snapshot_deleted_total{result}` | Arsip snapshot KT yang dihapus karena retensi |
| `nyx_registration_guard_observed_total{action,reason}` | Hasil evaluasi guard registrasi (mode `shadow` = keputusan hipotetis) |
| `nyx_attestation_registration_total{result,reason}` | Hasil gerbang attestation saat pendaftaran (`accepted`/`rejected`/`missing`/`challenge_invalid`/`malformed`; `reason` = kode enum pendek, `unmapped` = kode baru yang belum dipetakan) |
| `nyx_attestation_roots_expired_certs` | Jumlah sertifikat di bundle root attestation yang sudah lewat `validTo` (alert `NyxAttestationRootExpired`) |
| `nyx_attestation_roots_next_update_timestamp_seconds` | `nextUpdate` FIDO MDS dari metadata bundle root (alert `NyxAttestationRootBundleStale`); seri tidak ada bila metadata tidak ada |
| `nyx_admin_cleanup_total{result}` | Pemanggilan `/api/admin/cleanup` — termasuk yang DITOLAK (`forbidden`, `rate_limited`) |
| `nyx_abuse_guard_enabled{guard}` | 1 = guard menyala saat boot, 0 = off (alert `NyxAbuseGuardDisabled`) |
| `nyx_client_version_rejected_total{result}` | Request ditolak karena versi klien < `MIN_CLIENT_VERSION` (§10.14) |
| `nyx_metrics_rejected_total{reason}` | Harus **selalu 0** di produksi; >0 = ada kode yang mencoba mengirim identitas ke metrik |
| `nyx_wss_capability_total{capability}` | Kapabilitas hasil negosiasi jalur WSS (socket.io), per kapabilitas — `none` = klien mengiklankan sesuatu yang tak dikenal gateway (`docs/29` §5.6). Seri datar = tidak ada klien yang mengiklankan apa pun, bukan "semua sudah v2" |
| `nyx_wss_ingress_seconds` (histogram) | Latensi ingress jalur **WSS**: dari event socket.io diterima sampai handler selesai (validasi + rate limit + perangkat + publish). Pembanding `nyx_transport_ingress_seconds` — lihat "Latensi jalur" di bawah. Rendah tanpa label → tetap dirender (bernilai 0) sejak boot, jadi `rate(..._count[15m])` = **0**, bukan "No data" |

**Metrik auditor log KT** (`server/kt-query/cmd/nyx-kt-auditor/metrics.go`, exporter
loopback terpisah di `NYX_KT_AUDITOR_METRICS_ADDR`, default `127.0.0.1:9466`) —
scrape config-nya job `nyx-kt-auditor`. Aturan privasinya sama (deklarasi dulu,
label enum, penolakan dihitung):

| Metrik | Arti |
|---|---|
| `nyx_kt_auditor_rounds_total{result}` | Putaran audit selesai: `ok` / `error` (layanan log tak menjawab) / `inconsistent` (**peristiwa keamanan**) |
| `nyx_kt_auditor_updates_verified_total` | Update log yang berhasil diverifikasi (detak log) |
| `nyx_kt_auditor_head_sends_total{result}` | Pengiriman tree head bertanda tangan, per hasil; `error` = `SetAuditorHead` ditolak/mati |
| `nyx_kt_auditor_tree_size` | Ukuran pohon menurut auditor (sudah diverifikasi) |
| `nyx_kt_auditor_head_tree_size` | Ukuran pohon pada tree head terakhir yang **DITERIMA** log (selisihnya = belum ditandatangani) |
| `nyx_kt_auditor_last_round_timestamp_seconds` | Putaran audit terakhir selesai (hasil apa pun) |
| `nyx_kt_auditor_last_consistent_timestamp_seconds` | Putaran terakhir yang seluruh buktinya konsisten |
| `nyx_kt_auditor_last_head_timestamp_seconds` | Tree head terakhir yang diterima log — **tidak ada** sebelum kiriman pertama berhasil |
| `nyx_kt_auditor_uptime_seconds` | Umur proses: pembeda "proses baru (head pertama masih menunggu irama)" dari "proses lama yang tak pernah menandatangani" |
| `nyx_kt_auditor_metrics_rejected_total{reason}` | Penjaga privasi sisi auditor; harus **selalu 0** |

**Metrik proses LOG KT** (`server/kt-query/metrics.go`, exporter loopback terpisah
di `NYX_KT_METRICS_ADDR`, default `127.0.0.1:9467`) — job `nyx-kt-query`. Ini
proses yang **menulis** riwayat, bukan yang mengauditnya: kegagalannya fail-open
(registrasi tetap sukses tanpa jejak audit), jadi tidak ada satu pun error di
aplikasi yang menunjuk kemari:

| Metrik | Arti |
|---|---|
| `nyx_kt_query_writes_total{result}` | Penulisan entri oleh proses log sendiri; `ok`, `duplicate` (idempoten, **bukan** kegagalan), `invalid` (permintaan klien salah), `error` (pohon/basis data gagal) |
| `nyx_kt_query_reads_total{op,result}` | Operasi baca (`search`, `distinguished`, `monitor`, `config`, `head`, `health`); `not_found` dipisah dari `invalid`/`error` karena "belum ada di log" adalah jawaban sah |
| `nyx_kt_query_snapshot_total{result}` | Percobaan snapshot lokal; `ok` = arsip tersimpan **dan** terverifikasi |
| `nyx_kt_query_snapshot_last_timestamp_seconds` | Arsip lokal terverifikasi terakhir — **tidak ada** sebelum snapshot pertama (karena itu aturannya memakai `absent_over_time`) |
| `nyx_kt_query_distinguished_timestamp_seconds` | Timestamp anchor `distinguished` yang tersimpan; ditulis ulang setiap putaran yang berhasil, jadi seri yang diam = loop berhenti (§10.15) |
| `nyx_kt_query_tree_size` | Ukuran pohon menurut proses log |
| `nyx_kt_query_uptime_seconds` | Umur proses (pembeda restart cepat) |
| `nyx_kt_query_metrics_rejected_total{reason}` | Penjaga privasi sisi log; harus **selalu 0** |

**Metrik proses LOG KT v2** mengekspor nama yang sama (`nyx_kt_query_*`) di
`NYX_KT_V2_METRICS_ADDR` (`127.0.0.1:9468`, job `nyx-kt-query-v2`); demikian
pula auditor v2 (`nyx_kt_auditor_*`, `127.0.0.1:9469`, job
`nyx-kt-auditor-v2`). Nama sengaja tidak diberi sufiks v2 supaya dashboard dan
aturan alarm yang ada berlaku untuk kedua log; `job` membedakannya. Jangan
menambahkan aturan `up == 0` sebelum unit v2 di-`enable` (akan menyala palsu).

**Metrik sidecar WebTransport** (`server/transport-sidecar/src/metrics.rs`,
`TRANSPORT_METRICS_ADDR`, default `127.0.0.1:9465`) — job `nyx-sidecar`. "Aplikasi
hidup" tidak berarti jalur ini hidup: klien yang gagal handshake **turun ke WSS
secara senyap** (`web/src/lib/transportMode.ts`), jadi tanpa metrik ini sidecar
boleh mati berhari-hari tanpa satu pun error di mana pun:

| Metrik | Arti |
|---|---|
| `nyx_transport_connections_total{result}` | Handshake masuk: `accepted` / `rejected` / `failed` |
| `nyx_transport_auth_total{method}` | Sesi terautentikasi (`ticket` / `bwh`) |
| `nyx_transport_auth_failures_total{reason}` | Gagal auth (`ticket_invalid`, `token_too_large`, `bwh_invalid`, `no_identifier`) |
| `nyx_transport_session_kicks_total` | Sesi lama diputus aturan satu-perangkat-aktif |
| `nyx_transport_rejected_frames_total{reason}` | Frame dibuang sebelum diteruskan (`chaff` = traffic-cover normal, bukan anomali) |
| `nyx_transport_relay_published_total{path}` | Frame yang **berhasil** diteruskan ke `nyx:upstream` (`bidi` / `uni` / `datagram`) |
| `nyx_transport_downstream_total{result}` | Pesan `nyx:downstream` (`delivered` / `no_session` / `dropped`) |
| `nyx_transport_bytes_total{direction}` | Byte payload per arah (`in` / `out`) |
| `nyx_transport_active_sessions` | Sesi WebTransport aktif saat scrape |
| `nyx_transport_uptime_seconds` | Umur proses (restart terlihat dari nilai yang turun) |
| `nyx_transport_ingress_seconds` (histogram) | Latensi ingress jalur **WebTransport**: dari frame klien utuh diterima sampai diteruskan ke Redis (`nyx:upstream`). Hop inilah satu-satunya bagian ingress yang dimiliki sidecar — lihat "Latensi jalur" di bawah |

Tidak ada `…metrics_rejected_total` di sisi sidecar: semua nilai label di sana
**bertipe enum** (bukan string bebas), jadi nilai berbentuk identitas tidak bisa
masuk by construction — berbeda dari dua exporter lain yang menerima string dari
pemanggil. Yang tetap berlaku sama: nama metrik wajib dideklarasikan lebih dulu,
sehingga salah tulis nama ketahuan dari lapis kontrak `scripts/drill-alerts.sh`.

**Catatan penting soal `increase()` dan restart** (akar satu alarm palsu nyata,
2026-10-16): `prom-client` (nyx-api) **baru membuat label child saat `.inc()`
pertama**, jadi setelah restart seri `{result="ok"}` bisa hilang dari eksposisi —
dan `increase()` atas seri yang tak ada = 0, sehingga pola
`increase(counter) == 0` menyala palsu. Kedua exporter Go/Rust di atas tidak
punya sifat itu: keduanya merender **seluruh** nilai enum bernilai 0 sejak awal
proses (`ALL` di `metrics.rs`, tabel nilai di `metrics.go`). Karena itu aturan
untuk keduanya boleh memakai `increase(...) > 0` ("ada kegagalan **baru**") tanpa
takut restart, dan justru itulah bentuk yang dipakai. Untuk metrik yang memang
hanya lahir dari peristiwa (nyx-api), polanya diganti **gauge yang diturunkan
dari kenyataan luar** (mis. daftar objek R2, `…_remote_latest_timestamp_seconds`)
— bukan counter, lihat §10.13.

**Pemasangan (ops di VPS).** Prometheus + Grafana + exporter node/postgres/redis
di host yang sama (`nyx-api` :9464, sidecar :9465, auditor KT :9466, log KT
:9467, log KT v2 :9468, auditor KT v2 :9469 — semuanya **loopback**). Alertmanager juga di-commit, tetapi **tanpa
rahasia**: `ops/alertmanager/alertmanager.yml` hanya menunjuk relay loopback,
dan topik ntfy hidup di EnvironmentFile 0600 di VPS (§10.12 sub-bagian
notifikasi).
Semua listener **loopback**: nginx tidak mem-proxy `/metrics`, `:9090`, maupun
`:3001` — jangan menambahkan route untuk itu.

```bash
# 1. Prometheus — config + aturan dari repo (bukan diedit di server)
install -d -m 755 /etc/prometheus /var/lib/prometheus
install -m 644 ops/prometheus/prometheus.yml /etc/prometheus/
install -m 644 ops/prometheus/alerts.yml    /etc/prometheus/
promtool check config /etc/prometheus/prometheus.yml   # WAJIB: menolak config/aturan rusak
promtool test rules ops/prometheus/tests.yml           # kasus menyala + tidak-menyala
prometheus --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus --web.listen-address=127.0.0.1:9090 \
  --storage.tsdb.retention.time=15d --storage.tsdb.retention.size=2GB

# 2. Grafana — port 3001, karena 127.0.0.1:3000 sudah dipakai nyx-nginx.
#    Datasource + dashboard DIPROVISIKAN dari berkas (tanpa impor manual):
#      conf/custom.ini                     → http_addr=127.0.0.1, http_port=3001, path
#      provisioning/datasources/prometheus.yml → uid `prometheus` (WAJIB sama dengan
#                                                datasource.uid di JSON dashboard)
#      provisioning/dashboards/nyx.yml     → provider folder NYX, muat ulang 60 s
#      dashboards/nyx-overview.json        → SALINAN ops/grafana/dashboards/
#    Password admin + secret key cookie lewat GF_SECURITY_ADMIN_PASSWORD /
#    GF_SECURITY_SECRET_KEY (EnvironmentFile 0600), bukan di berkas config.

# 3. Exporter host: node_exporter :9100, postgres_exporter :9187, redis_exporter :9121
#    (job `node`/`postgres`/`redis` sudah ada di prometheus.yml; tanpa exporter ini
#     target-nya `up == 0` dan alert host/Redis menyala tanpa sebab nyata)
```

Verifikasi pemasangan (yang dibuktikan di sini: scrape **nyata**, bukan sekadar
proses hidup):

```bash
curl -s 127.0.0.1:9090/-/ready                       # "Prometheus Server is Ready."
curl -s 127.0.0.1:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
curl -s 127.0.0.1:9090/api/v1/rules   | grep -o '"name":"nyx[^"]*"' | wc -l   # 39 aturan
curl -s 127.0.0.1:9090/api/v1/query --data-urlencode 'query=up{job="nyx-kt-auditor"}'
curl -s 127.0.0.1:9090/api/v1/query --data-urlencode 'query=up{job="nyx-kt-query"}'
curl -s 127.0.0.1:9090/api/v1/query --data-urlencode 'query=up{job="nyx-sidecar"}'
# Semua target harus `up` — target yang mati TIDAK menyalakan alarm lain (aturan
# yang bergantung padanya "diam" karena tidak ada data), jadi `up` diperiksa eksplisit.
curl -s 127.0.0.1:9090/api/v1/targets | python3 -c 'import json,sys; [print(t["labels"]["job"], t["health"]) for t in json.load(sys.stdin)["data"]["activeTargets"]]'
curl -s 127.0.0.1:9090/api/v1/alertmanagers   # activeAlertmanagers TIDAK boleh kosong
curl -s 127.0.0.1:9093/-/ready                # "Alertmanager is Ready."
# Grafana (basic auth: admin + GF_SECURITY_ADMIN_PASSWORD)
curl -s -u admin:"$GF_SECURITY_ADMIN_PASSWORD" 127.0.0.1:3001/api/health
curl -s -u admin:"$GF_SECURITY_ADMIN_PASSWORD" \
  127.0.0.1:3001/api/datasources/uid/prometheus/health    # "Successfully queried…"
curl -s -u admin:"$GF_SECURITY_ADMIN_PASSWORD" '127.0.0.1:3001/api/search?type=dash-db'
```

**Pemasangan tanpa root** (dev/self-host, diverifikasi 2026-10-16): berkas dan
aturan yang **sama**, hanya path-nya di bawah `$HOME` — biner di
`~/nyx-selfhost/{prometheus,grafana}/bin`, config di `…/prometheus/conf`, data di
`…/prometheus/data`, unit `systemd --user`. Langkah lengkap + catatan lingkupnya
ada di `~/nyx-selfhost/README.md`; intinya identik dengan blok di atas.

**Dashboard yang di-commit** memakai metrik yang sama dengan alert — ambang di
panel dijaga identik dengan `alerts.yml` supaya tidak ada dua kebenaran. Panel
`nyx_metrics_rejected_total` (harus 0) dan `Redis key ter-evict` sengaja diberi
warna merah pada nilai > 0: keduanya berarti jaminan privasi/rate-limit sudah
bocor, bukan sekadar performa. Sejak 2026-10-16 dashboard punya baris **Key
Transparency (auditor mode 3 + log nyx-kt-query)**: auditor hidup, umur tree head
terakhir **dan** umur proses (batang kedua — pembeda "proses baru" dari "tak
pernah menandatangani"), penjaga label identitas auditor, posisi pohon
(diverifikasi vs head yang diterima), tulis/baca log KT, putaran audit + head per
hasil, snapshot KT, dan umur tulis KT sukses terakhir. Sejak 2026-10-17 ada dua
baris lagi, sejajar dengan aturan alertnya: **Transport WebTransport
(`nyx-sidecar`)** — sidecar hidup, sesi aktif + handshake per hasil, auth gagal
per alasan, frame dibuang selain chaff — dan **Log KT: prosesnya sendiri
(`nyx-kt-query`)** — proses hidup, tulisan per hasil, baca per operasi, umur
snapshot lokal, umur anchor `distinguished`, plus panel **ukuran pohon: pandangan
log vs auditor** (selisih yang melebar = auditor tertinggal, padahal itu satu-
satunya hal yang membuat log KT punya jaminan auditas).

Dua panel lama diperbaiki judulnya karena menyesatkan: "Eksporter metrik hidup"
kini menampilkan `up{job=~"nyx-.*"}` (keempat proses, bukan hanya nyx-api), dan
panel "Tulis/baca log KT" yang memakai `nyx_kt_writes_total`/`nyx_kt_queries_total`
kini berjudul **"… dari sisi API (nyx-api)"** — metrik itu milik server, sedangkan
yang PROSES log tulis ada di baris barunya. Dua hal berbeda: satu mengukur apa yang
dikirim server, satu mengukur apa yang benar-benar diterima log.

**Fuzz parser (gate §30.11 butir 4) — bukan bagian deploy, jalankan nightly:**
`pnpm --filter nyx-web run fuzz:parsers:hour` dan
`cd server/transport-sidecar && NYX_FUZZ_SECONDS=3600 cargo run --release --bin fuzz-framing`
(lihat docs/11 §11.1c). Per-PR cukup `cargo test` + kampanye pendek vitest.

**Load test relay:** `scripts/load/relay.k6.js` (500 VU, ambang p95 < 200 ms,
error < 1%). Pakai pembungkusnya, `scripts/load/run-relay-load.sh`: ia memeriksa
API hidup, menyiapkan akun+device+percakapan uji (`server/scripts/load-test-user.ts`,
idempoten), menjalankan **SMOKE 5 VU lebih dulu** (tanpa langkah ini, kegagalan
autentikasi/CSRF tampak seperti beban ringan — ditolak cepat tanpa menyentuh DB),
baru beban penuh. Skrip ini **menulis** pesan — jalankan hanya ke server uji,
bukan produksi. Terukur 2026-10-14 (500 VU): send p95 74,4 ms, fetch p95 68,8 ms,
`http_req_failed` 0%. Jalur biner WebTransport/WSS diukur terpisah lewat harness
browser (`docs/11`), karena k6 tidak punya WebTransport.

**Drill alert (gate M1) — jalankan sebelum percaya pada aturan apa pun:**

```bash
scripts/drill-alerts.sh                              # 4 lapis, promtool di-cache
METRICS_URL=http://127.0.0.1:9464/metrics scripts/drill-alerts.sh
SKIP_LIVE=1 scripts/drill-alerts.sh                   # tanpa exporter hidup
```

Empat lapis: config + kompilasi aturan → **`promtool test rules`** (kasus
menyala **dan** tidak-menyala per aturan) → kontrak metrik (nama `nyx_*` yang
dirujuk aturan **atau panel dashboard** harus ada **di salah satu dari empat
sumber deklarasi**: `server/src/utils/metrics.ts`,
`server/kt-query/cmd/nyx-kt-auditor/metrics.go`, `server/kt-query/metrics.go`,
`server/transport-sidecar/src/metrics.rs`) → cakupan drill (aturan baru wajib
punya kasus). Lapis terakhir opsional men-scrape `/metrics` nyata dari keempat
exporter. Kontrak untuk dashboard ditambahkan bersama panel baris transport/log
(2026-10-17): panel dengan nama metrik salah tulis **tidak** menghasilkan error
apa pun, hanya "No data" — dan "No data" di produksi paling sering dibaca
sekadar sebagai "sedang sepi". **Sebuah aturan yang merujuk metrik yang
salah tulis tidak akan pernah menyala dan tidak menghasilkan error apa pun** —
itu yang dicegah lapis ketiga. Ini juga jalan per-PR (job CI `alerts`, dan versi
scrape-nyata di job `e2e`).

Kelompok `nyx-transport` (6 aturan) dan `nyx-kt-query` (5 aturan) ditambahkan
2026-10-17, saat kedua proses itu akhirnya punya exporter — justru keduanya
adalah kelas kegagalan **senyap**: sidecar yang mati hanya membuat klien turun ke
WSS, dan proses log yang mati hanya menghilangkan jejak audit (fail-open).
Keduanya berbagi dua aturan bentuk sama: `…Down` (proses/exporter hilang) dan
`…Restarting` (`changes(up[1h]) > 2` **atau** `resets(uptime[1h]) > 1`, karena
restart yang lebih cepat dari satu irama scrape tidak pernah terlihat sebagai
`up == 0`).

**Latensi jalur: WebTransport vs WSS (`…IngressSlow` + `…SlowerThanWss` + `…Unused`).**
Jalur cepat yang **melambat** tidak menghasilkan satu pun error: klien tidak tahu
ia sedang memakai jalur yang seharusnya lebih cepat, sidecar tetap `up`, dan
`…Down` diam — sampai handshake-nya gagal dan semua klien mundur ke WSS. Dua
aturan menutup jendela itu dengan dua histogram dari dua proses berbeda:

| Jalur | Metrik | Titik awal → titik akhir |
|---|---|---|
| WebTransport | `nyx_transport_ingress_seconds` (sidecar :9465) | frame klien utuh diterima → diteruskan ke Redis (`nyx:upstream`) |
| WSS | `nyx_wss_ingress_seconds` (nyx-api :9464) | event socket.io diterima → handler selesai (validasi + rate limit + perangkat + publish) |

Cakupan keduanya **tidak identik, dan itu disengaja**: pekerjaan yang di jalur WSS
ada di dalam span-nya (rate limit, pemeriksaan perangkat) justru terjadi di proses
Node SETELAH hop yang diukur di sidecar. Jadi span WSS memuat lebih banyak
pekerjaan, dan aturan pembandingnya (`NyxTransportSlowerThanWss`, p95 WT > p95 WSS
selama 30 menit) hanya menyala ketika jalur cepat benar-benar sudah kehilangan
keunggulannya — arah yang salah untuk alarm palsu. Aturan `NyxTransportIngressSlow`
(250 ms) adalah jaring terakhir yang tidak bergantung pembanding.

Yang membuat perbandingan ini sah: **bucket kedua histogram wajib sama**
(`INGRESS_BUCKETS` di `server/transport-sidecar/src/metrics.rs` ↔
`WSS_INGRESS_SECONDS` di `server/src/utils/metrics.ts`). p95 dari dua histogram
dengan pembagian bucket berbeda tidak sebanding, dan itu tidak memunculkan error
apa pun — hanya perbandingan yang bohong. Keduanya juga **dirender bernilai 0
sejak proses hidup** (nol observasi), jadi panel laju menampilkan 0 dan penjaga
`rate(..._count[15m]) > 0` bekerja seperti yang dimaksud; kuantilnya sendiri
bernilai NaN sampai ada sampel pertama (`histogram_quantile` atas histogram kosong
memang tidak punya jawaban) — dan `NaN > ambang` bernilai salah, jadi tidak ada
alarm dari data yang belum ada.

Bentuk penurunan **ketiga** ditangkap `NyxTransportUnused`: sesi WT **pernah ada
lalu habis** sementara WSS terus melayani dan prosesnya masih `up`. Di sini tidak
ada yang melambat dan tidak ada yang mati — yang hilang adalah pemakaiannya, dan
keempat aturan transport lain (handshake, auth, frame, latensi) tetap diam;
fallback memang dirancang berjalan senyap, jadi tidak ada satu pun keluhan yang
muncul sampai seseorang kebetulan membuka dashboard. Penjaganya
`max_over_time(nyx_transport_active_sessions[1h]) > 0`: instalasi yang memang belum
pernah memakai jalur cepat (host ini salah satunya selama WT belum terjangkau dari
publik) tidak ikut berteriak, karena "selalu nol sejak awal" bukan penurunan.

Kelompok `nyx-kt-auditor` (8 aturan) memisahkan kelas kegagalan yang tindakannya
berbeda: proses mati (`…Down`), hidup tapi tak maju (`…RoundStalled`), layanan log
tak terhubung (`…RoundFailing`), riwayat tidak konsisten (`…ProofInconsistent` —
insiden keamanan), head ditolak (`…HeadRejected`), dan dua pasangan yang saling
menutup: `…HeadStale` + `…Restarting`. Pasangan itu lahir dari drill 2026-10-16:
cabang "belum pernah ada tree head" pada `…HeadStale` **menyala 30 menit setelah
setiap restart** (head pertama memang menunggu irama tanda tangan), jadi
sekarang cabang itu dijaga `nyx_kt_auditor_uptime_seconds > 2 jam`; sementara
proses yang start ulang terus (umurnya selalu muda, jadi `…HeadStale` buta)
ditangkap `…Restarting` lewat `changes(up[1h])` **atau**
`resets(nyx_kt_auditor_uptime_seconds[1h])` — sinyal kedua untuk restart yang
lebih cepat dari satu irama scrape. Aturan yang menyala setiap deploy akan
berakhir diabaikan, dan itu sama saja dengan tidak ada aturan.

Kalau ingin mereproduksi gejalanya dengan tangan: matikan exporter →
`NyxMetricsExporterDown`; isi disk sampai <12% → `NyxHostDiskLow`; hentikan
sweeper → `NyxSweeperStale`.

**Notifikasi: Alertmanager → relay loopback → ntfy (ditambahkan 2026-10-17).**
Sampai blok `alerting:` ada di `prometheus.yml`, semua aturan di atas hanya
terlihat di UI `/alerts`: tidak ada yang diberi tahu, dan alarm yang tidak pernah
sampai sama saja dengan tidak ada. Blok itu menunjuk Alertmanager di loopback
(`127.0.0.1:9093`); dari sana notifikasi melewati `ops/alertmanager/ntfy-relay.mjs`
(127.0.0.1:9095) ke topik ntfy.

Kenapa relay, bukan receiver ntfy langsung: Alertmanager 0.34.1 tidak punya
receiver `ntfy` (`amtool check-config` → `field ntfy_configs not found`), dan
payload `webhook_configs` (JSON v4) bukan bentuk pesan yang terbaca di aplikasi
ntfy. Relay menerjemahkan payload itu → judul + pesan + prioritas (skala ntfy
1–5 dari label `severity`: `critical`→5, `high`→4, `warning`→3, `resolved`→2,
jadi kabar "sudah pulih" tetap terlihat tetapi tidak berkedip seperti alarm).
Yang **tidak** dikirim ke mana pun: topik dan token tidak pernah dicetak log
(`ntfy-relay.mjs` hanya mencatat panjang topik), dan isi alert hanya enum NYX
(job, severity, port, umur snapshot) — bukan identitas pengguna.

```bash
# 1. Biner + config (config TANPA rahasia — aman di-commit, disalin apa adanya)
install -m 644 ops/alertmanager/alertmanager.yml <conf-dir>/alertmanager.yml
amtool check-config <conf-dir>/alertmanager.yml          # WAJIB sebelum start

# 2. Topik ntfy di EnvironmentFile 0600 (BUKAN di config, jangan di repo)
install -m 600 ops/alertmanager/ntfy-relay.env.example \
                ~/nyx-selfhost/alertmanager/ntfy-relay.env   # lalu isi NTFY_TOPIC

# 3. Dua unit systemd: nyx-alertmanager (:9093) + nyx-ntfy-relay (:9095).
#    Port relay sengaja 9095, BUKAN 9094: 9094/tcp dipakai Alertmanager sebagai
#    listener gossip HA — memakai 9094 membuat prosesnya gagal start
#    (`listen tcp 0.0.0.0:9094: bind: address already in use`, terlihat 2026-10-17).
#    Cluster gossip juga dimatikan (`--cluster.listen-address=`) karena ini satu
#    instance tanpa HA — gossip hanya menambah port dan peringatan.

# 4. Verifikasi (bukan hanya "proses hidup")
node ops/alertmanager/ntfy-relay.mjs --self-test          # format pesan, tanpa jaringan
curl -s 127.0.0.1:9093/-/ready                            # "Alertmanager is Ready."
curl -s 127.0.0.1:9090/api/v1/alertmanagers               # activeAlertmanagers terisi
amtool alert add alertname=NyxChannelTest severity=critical \
  --alertmanager.url=http://127.0.0.1:9093                # uji ujung-ke-ujung
```

Langkah 4 terakhir adalah satu-satunya bukti yang benar: alert uji harus benar-
benar sampai ke perangkat. Jurnal relay mencatat `terkirim: "1 firing: …"`
untuk setiap kiriman yang diterima ntfy, jadi kegagalan jaringan tidak bisa
menyamar sebagai "sudah dikirim".

Aturan routing & peredaman yang dipakai (`ops/alertmanager/alertmanager.yml`):
`critical` dikirim seketika (`group_wait: 0s`, ulang tiap 1 jam), `high` setelah
1 menit (ulang tiap 2 jam), sisanya 30 detik (ulang tiap 4 jam) — `repeat_interval`
sengaja tidak lebih lama dari itu supaya alarm yang menyala berhari-hari (mis.
guard OFF) tidak terlupakan. Empat inhibit rule mencegah notifikasi turunan yang
menyesatkan: (a) proses/exporter yang mati (`NyxMetricsExporterDown`,
`NyxKtAuditorDown`, `NyxKtQueryDown`, `NyxTransportSidecarDown`) meredam semua
alarm `high`/`warning` berbasis metriknya — nilai yang "diam" tidak lagi berarti
"sehat"; (b) `…Restarting` meredam `…HeadStale` (auditor) dan lonjakan
auth/frame (sidecar), karena keduanya gejala dari satu sebab yang sama.

**Residual yang disadari:** topik ntfy default memakai server publik `ntfy.sh`,
jadi judul+ringkasan alert melewati pihak ketiga (tidak ada identitas pengguna di
dalamnya, dan topik bisa diset ke instance sendiri lewat `NTFY_URL`). Satu server
ntfy yang mati juga berarti notifikasi berhenti tanpa alarm — itu sebabnya
`up{job="prometheus"}` tidak dipakai sebagai alarm (Prometheus yang mati tidak
bisa mengalarmkan dirinya sendiri).

## 10.13 Operasional harian: pembersihan & snapshot log KT (added 2026-10-14)

Dua pekerjaan latar ini berjalan tanpa intervensi, tetapi **keduanya gagal secara
senyap kalau tidak dipantau** — karena itu metriknya wajib ada di dashboard.

**Pembersihan basis data.** Cron `jobs/systemSweeper.ts` (00:00) dan endpoint
manual `POST /api/admin/cleanup` (header `x-admin-key`) menjalankan **kode yang
sama** (`jobs/cleanup.ts`): refresh token kadaluarsa/revoked, session key
kadaluarsa/basi (> 30 hari), dead-man's switch (akun dorman + baris ter-sealnya),
langganan jatuh tempo → FREE, story kadaluarsa. Setiap langkah diisolasi: satu
tabel yang gagal tidak menahan langkah lain, dan kegagalannya dilaporkan per
langkah.

**Pembersihan pesan (tiap menit).** `jobs/messageSweeper.ts` berjalan
`* * * * *` dengan `noOverlap`: menghapus pesan yang sudah lewat `expiresAt`
**dan** semua pesan yang lebih tua dari **14 hari** (retensi tetap, bukan
pengaturan per-pesan), lalu memberi tahu klien lewat event
`message:deleted_batch` supaya barisnya hilang dari UI tanpa menunggu reload.
Job ini tidak muncul di metrik sweeper harian — kalau retensi macet, satu-satunya
gejala adalah tabel `Message` yang tumbuh. Urutannya `expiresAt` paling lama
dulu (NULL = baris >14 hari, didahulukan) dan satu run menguras sampai 20 halaman
× 500 baris (10.000 pesan/menit); kalau batas itu tercapai, log menulis
`Message Sweeper mencapai batas … halaman`. Backlog yang terus tersisa berarti
burst kedaluwarsa > 10k/menit — naikkan batas, jangan mengandalkan run berikutnya.

- Respons endpoint memuat hitungan per jenis + `errors`. **HTTP 500 bila ada
  langkah gagal** — jangan membaca 200 sebagai "semua bersih".
- Metrik: `nyx_sweeper_last_run_timestamp_seconds{result}` (alert
  `NyxSweeperStale`), `nyx_sweeper_deleted_rows_total{kind}`,
  `nyx_sweeper_duration_seconds`.
- **Endpoint ini destruktif** — sejak 2026-10-15 ia benar-benar menghapus baris
  (sebelumnya stub yang hanya menjawab "Cleanup triggered"). Pengamanannya:
  rahasia khusus `ADMIN_CLEANUP_SECRET` (fallback `CHAT_SECRET`), allow-list IP
  opsional `ADMIN_CLEANUP_IP_ALLOWLIST`, rate limit 5/jam per IP, dan metrik
  `nyx_admin_cleanup_total{result}` (`ok`/`partial`/`error`/`forbidden`/
  `rate_limited`) — jadi pemanggilan yang **ditolak** pun terlihat, bukan senyap.
- Jalur manual untuk operator (rahasia khusus dulu, fallback `CHAT_SECRET`):
  `curl -sS -X POST -H "x-admin-key: $ADMIN_CLEANUP_SECRET" https://api.nyx-app.my.id/api/admin/cleanup`

**Snapshot log Key Transparency.** Log KT hanya ada di LevelDB milik
`nyx-kt-query` (§10.15). Setel `NYX_KT_SNAPSHOT_DIR` di service itu (mis.
`/var/lib/nyx/kt-snapshots`) untuk menyalakan arsip harian:

1. Penulisan dijeda (mutex yang sama dengan penulis log), direktori LevelDB
   disalin, salinan **dibuka ulang** dan tree head + root-nya dibandingkan dengan
   pohon hidup. Beda → arsip dibuang, langkah dilaporkan gagal, `latest.json`
   tidak ditulis. Snapshot yang belum terverifikasi tidak pernah diunggah.
2. Arsip `kt-snapshot-<waktu>Z.tar.gz` + `latest.json`; arsip lokal dipangkas ke
   `NYX_KT_SNAPSHOT_KEEP` (default 7).
3. Proses server NYX (`KT_SNAPSHOT_DIR` di `.env`) mengunggah arsip terbaru ke R2
   tiap 03:30 (`kt-snapshots/<nama arsip>`, kredensial objek hanya di sana),
   idempoten, dan menghapus objek lebih tua dari **30 hari**.

- Metrik: `nyx_kt_snapshot_upload_total{result}` (alert bila `error` bertambah)
  dan `nyx_kt_snapshot_deleted_total`.
- Tanpa `KT_SNAPSHOT_DIR`, job log satu peringatan dan tidak mengunggah apa pun —
  ini kondisi yang harus terlihat, bukan dianggap normal.
- **Latihan pemulihan.** Sejak 2026-10-14 drill ini **otomatis di CI** (job
  `kt-recovery`, `scripts/kt-restore-drill.sh`): entri ditulis lewat penulis
  produksi → snapshot terverifikasi → **basis data hidup dihapus** → pulih hanya
  dari arsip → tree size **dan** root harus identik dengan pra-bencana, bukti lama
  tetap lolos verifier upstream (`nyx-kt-check`, memakai `transparency.VerifySearch`
  yang sama dengan WASM klien), log bisa tumbuh tanpa memutus anchor klien lama,
  dan kontrol negatif membuktikan pemeriksanya bisa gagal. Yang **tetap manual**
  (jalankan sebelum mengandalkan arsip R2): unduh arsip terbaru dari R2, ekstrak,
  arahkan `-db` ke direktori hasil ekstrak dan jalankan `nyx-kt-query -check`;
  `GET /healthz` harus melaporkan ukuran pohon yang sama dengan `latest.json`.

## 10.14 Versi klien minimum (`MIN_CLIENT_VERSION`) — added 2026-10-15, R2

Sejak 2026-10-10 envelope distribusi sender-key **v0/v1 tidak lagi dibaca** dan
metadata grup non-v2 menjadi `null`. Klien yang masih memegang bundel lama
(cache service worker/PWA) karena itu kehilangan pesan grup — sebelumnya **tanpa
gejala apa pun**. Dua sisi memperbaikinya:

- **Sisi klien:** drop itu sekarang terlihat (pesan sistem + toast, kunci i18n
  `common:security_legacy_group_key`) dan service worker baru **memaksa satu kali
  muat ulang** per tab per sesi, jadi bundel lama tidak bertahan diam-diam.
- **Sisi server:** gerbang versi klien. Klien mengirim
  `x-nyx-client-version: <versi build>` di setiap request REST; bila
  `MIN_CLIENT_VERSION` diset dan versi klien lebih kecil, request ditolak
  **`426 CLIENT_TOO_OLD`** dengan pesan "perbarui aplikasi" (metrik
  `nyx_client_version_rejected_total{result="too-old"}`).

Dua kelonggaran yang disengaja — jangan "perbaiki" tanpa alasan kuat:

1. **Kosong = gerbang mati.** Tanpa `MIN_CLIENT_VERSION`, tidak ada yang ditolak.
2. **Tanpa header versi = lolos (fail-open).** Semua klien yang dirilis sebelum
   3.0.0 tidak mengirim header ini; menolaknya berarti mematikan basis pengguna
   yang sudah ada. Konsekuensinya gerbang ini mengikat **mulai 3.0.0**, jadi ia
   bukan pengganti catatan migrasi/pemberitahuan rilis.

`/api/health` tidak pernah digerbang (probe liveness). Endpoint ops seperti
`/api/admin/cleanup` dipanggil `curl` tanpa header versi, jadi ia lolos lewat
jalur `no-header` dan operasi pemeliharaan tidak ikut terkunci.

**Urutan menaikkan angka ini saat rilis breaking berikutnya:** umumkan dulu →
beri jeda minimal satu siklus rilis (biar PWA pengguna memperbarui diri) → baru
naikkan `MIN_CLIENT_VERSION` ke versi rilis sebelumnya → pantau
`nyx_client_version_rejected_total` (lonjakan = masih ada klien lama); turunkan
kembali ke kosong bila lonjakannya besar dan pesan-pesannya belum sampai.

## 10.15 Layanan Key Transparency (`nyx-kt-query`) — added 2026-10-15

Log KT tidak ada di Postgres dan tidak di R2: ia hidup di LevelDB yang **dimiliki
satu proses** — `server/kt-query/` (Go), dijalankan sebagai `nyx-kt-query`. Dua
alasan bentuknya begitu (query service upstream tidak bisa melayani nilai log NYX;
LevelDB menolak dibuka dua proses) ada di `server/kt-query/README.md` — baca itu
sebelum menyentuh service ini.

**Transisi v2 (docs/35 §35.7).** Binary `nyx-kt-query-v2` dan
`nyx-kt-auditor-v2` memakai direktori data/konfigurasi sendiri
(`/var/lib/nyx/kt-v2`, `/var/lib/nyx/kt-v2-snapshots`,
`/var/lib/nyx/kt-auditor-v2`, config `/etc/nyx/kt-v2/`). `deploy.yml` memasang
unitnya, dan bila config belum ada ia menjalankan `nyx-kt-v2-init` (kunci lahir
di VPS), menyalin contoh `EnvironmentFile`, lalu `enable` kedua unit. Pemasangan
pertama **v1** tetap manual; cutover baca (`KT_QUERY_URL`) dan backfill akun lama
juga manual (search key tidak dapat diturunkan dari database). Jangan
menjalankan dua proses pada **satu** direktori LevelDB. Setelah cutover
(`KT_QUERY_URL` → `:8089`), v1 dipertahankan read-only sampai tidak ada klien
lama; rollback setelah klien mem-pin ABI 2 bersifat satu arah (anti-downgrade).

**Bangun** (dari vendor, tanpa jaringan dan tanpa checkout upstream; artefaknya
**tidak** ikut `deploy.yml`):

```bash
server/kt-query/build.sh          # → server/kt-query/nyx-kt-query + nyx-kt-check
server/kt-query/build.sh test     # go vet + go test
```

**Jalankan** (semua listener loopback; config YAML berisi kunci log + `db.file`):

```bash
nyx-kt-query \
  -config /etc/nyx/kt/test_config.yaml \
  -read-addr 127.0.0.1:8085 \
  -write-addr 127.0.0.1:8081 \
  -auditor-addr 127.0.0.1:8082 \
  -distinguished 1m \
  -snapshot-dir /var/lib/nyx/kt-snapshots
```

Flag/env lengkap (`-config`/`KT_CONFIG_FILE`, `-read-addr`/`NYX_KT_QUERY_ADDR`,
`-write-addr`/`NYX_KT_WRITE_ADDR`, `-auditor-addr`/`NYX_KT_AUDITOR_ADDR`,
`-snapshot-dir`/`NYX_KT_SNAPSHOT_DIR`, `NYX_KT_SNAPSHOT_INTERVAL`,
`NYX_KT_SNAPSHOT_KEEP`, `-check`) ada di `server/kt-query/README.md`; sisi server
NYX memakai `KT_SERVER_URL` (tulis, `:8081`) dan `KT_QUERY_URL` (baca, `:8085`).

Perannya hari ini:

- **Satu-satunya penulis log** — protokolnya tetap
  `KeyTransparencyTestService.Update`, jadi `server/src/utils/keyTransparency.ts`
  tidak berubah.
- **Penyaji bukti** untuk `/api/keys/kt/*` (proxy loopback dari Express) →
  verifikasi di klien WASM (`docs/34`).
- **Pembuat arsip snapshot terverifikasi** yang diunggah server NYX ke R2 (§10.13).
- **Layanan auditor pihak ketiga** di listener terpisah (`:8082`), dan auditor
  nyatanya `nyx-kt-auditor` (`server/kt-query/cmd/nyx-kt-auditor`, unit
  `ops/systemd/nyx-kt-auditor.service`). Log berjalan **mode 3** begitu
  `api.auditors` diisi: klien mewajibkan auditor head yang segar, dan auditor yang
  berhenti > 7 hari membuat klien menolak head (jadi prosesnya bagian dari
  ketersediaan verifikasi kunci, bukan hiasan). Pemasangan ada di
  `ops/systemd/README.md`.

**Deploy: otomatis, dengan satu langkah sekali-saja.** Unit-nya ada di repo
(`ops/systemd/nyx-kt-query.service` + template `nyx-kt-query.env.example` +
`ops/systemd/README.md`), jadi sejak 2026-10-15:

| Bagian | Siapa yang mengerjakan |
|---|---|
| Build binary dari vendor (`nyx-kt-query` + `nyx-kt-check` + `nyx-kt-auditor`) | `deploy.yml` (CI) |
| Salin binary + `ops/systemd/` ke VPS, segarkan unit, `daemon-reload` | `deploy.yml` |
| Restart + verifikasi (`is-active`, `/healthz`) bila unit `enabled`; gagal ⇒ deploy merah | `deploy.yml` |
| Restart `nyx-kt-auditor` setelah `nyx-kt-query` hidup (bila unit auditor `enabled`) | `deploy.yml` |
| Simpan binary sebelumnya sebagai `nyx-kt-query.prev` | `deploy.yml` |
| Pemasangan pertama: direktori, kunci log + config YAML, `EnvironmentFile`, `systemctl enable --now` | **owner ops, sekali** — `ops/systemd/README.md` |
| Pemasangan pertama auditor (mode 3): kunci auditor, entri `api.auditors`, `EnvironmentFile`, `systemctl enable --now` | **owner ops, sekali** — `ops/systemd/README.md` |
| Bootstrap v2: `nyx-kt-v2-init` (config + kunci ML-DSA di VPS), salin env contoh, `enable` kedua unit, isi `KT_V2_SERVER_URL`, `pm2 restart --update-env` | `deploy.yml` (bila `/etc/nyx/kt-v2/config.yaml` belum ada) |
| Cutover baca v2 (`KT_QUERY_URL` → `:8089`, `KT_SNAPSHOT_DIR` → `kt-v2-snapshots`), lalu v1 read-only | **owner ops, manual** — akun lama belum punya entri v2 |
| Isi `KT_SERVER_URL` / `KT_QUERY_URL` / `KT_SNAPSHOT_DIR` di `/root/nyx-app/.env`, lalu `pm2 restart nyx-api` | **owner ops, sekali** |

Aturan yang tidak boleh dilanggar:

1. **systemd, bukan pm2, dan hanya satu proses.** Service ini memegang flock
   LevelDB; dua proses (mis. satu di pm2 + satu di systemd) mati dengan
   `resource temporarily unavailable`.
2. Jangan pernah membuka `:8081`/`:8085`/`:8082` ke publik: hanya `nyx-api`
   lewat loopback yang boleh menulis/membaca (§10.9 step 2).
3. Config YAML + kunci log hidup di `/etc/nyx/kt/` (mode `0600`, §10.7) —
   **tidak** di repo dan **tidak** di DB. Jangan regenerate setelah produksi:
   kunci itu identitas log, dan menggantinya membuat semua bukti lama tak bisa
   diverifikasi klien.
4. `-check` membuka basis data ⇒ hentikan service dulu (§10.5 butir 8).
5. Kalau `db.file`/`-snapshot-dir` tidak di dalam `ReadWritePaths` unit
   (`/var/lib/nyx/kt`, `/var/lib/nyx/kt-snapshots`), service mati dengan
   "read-only file system" — tambahkan path-nya di unit, jangan melepas
   hardening-nya.
6. Sejak 2026-10-17 service ini mengekspos `/metrics` di loopback
   (`NYX_KT_METRICS_ADDR`, default `127.0.0.1:9467`, job scrape `nyx-kt-query`).
   Alamat non-loopback ditolak saat start. Sebelum itu, entry di
   `prometheus.yml` sengaja dikomentari supaya tidak memicu `up == 0` palsu —
   pola yang sama berlaku untuk exporter baru apa pun: tambahkan job scrape
   **bersamaan** dengan exporter-nya hidup.
7. Pin upstream naik = `scripts/vendor-signal.sh` + `go mod vendor`
   (`server/kt-query/README.md`); vendor-nya ikut di-commit dan dibuktikan bisa
   dibangun oleh job CI `build` serta dipakai ulang oleh job `kt-recovery`.

## 10.16 Guard anti-abuse registrasi (WS-H) — menyalakan & memantau (added 2026-10-16)

Pendaftaran massal (sybil) ditahan berlapis **tanpa PII**: tidak ada IP mentah
yang disimpan, tidak ada CAPTCHA baru, tidak ada ML atas data pribadi. Semua
lapisan default **mati**, jadi deployment produksi yang lupa menyalakannya
tampak sehat — karena itu §10.16 ini ada, dan kenapa boot-nya berisik.

**Menyalakan (urutan yang disarankan).**

1. **Ukur dulu, jangan blokir:** `ABUSE_REGISTRATION_GUARD=shadow`. Guard
   menghitung **semua** lapisan persis seperti mode `on`, tetapi tidak menahan
   siapa pun; keputusan hipotetisnya terlihat di
   `nyx_registration_guard_observed_total{action="would_block"|"would_attest"|"allowed"}`
   + log `[RegistrationGuard][shadow]` (hanya angka counter, tanpa identitas).
   Yang diukur: berapa pengguna **sah** yang akan tertahan (mis. kantor ber-NAT
   besar yang ramai dalam 10 menit).
2. **Isi tabel ASN:** `ASN_DB_FILE=/etc/nyx/asn-blocks.csv` (ekspor
   `GeoLite2-ASN-Blocks-IPv4/6.csv`, dua kolom pertama `network,asn_number`).
   Tanpa berkas ini lapisan per-ASN dilewati (fail-open) dan `would_attest`
   tidak pernah bisa menyala — jadi mode shadow tanpa ASN bukan pengukuran penuh.
3. **Nyalakan:** `ABUSE_REGISTRATION_GUARD=on`. Batas: sumber (IP ter-HMAC)
   20/jam, instalasi 10/jam, ASN **100/jam** (akun ke-100 ditahan) → `429
   REGISTRATION_BURST_LIMIT`; burst ASN ≥25/10 menit → **wajib attestation
   perangkat** (`428 ATTESTATION_REQUIRED`), bukan blokir.
4. **Attestation (opsional, paling keras):** `ABUSE_REQUIRE_ATTESTATION=on`
   mewajibkan attestation perangkat untuk **semua** akun baru. Kebijakan
   format/root/AAGUID lewat `ABUSE_ATTESTATION_*` (§10.6).

   Perlu diketahui sebelum menyalakannya: passkey default di Android/iOS adalah
   **kredensial tersinkron** (`fmt: none`, `multiDevice`) — Chrome/Safari sengaja
   tidak melampirkan attestation perangkat, dan desktop Linux tidak punya
   platform authenticator sama sekali. Kebijakan ketat karena itu hanya bisa
   dipenuhi security key FIDO2 atau perangkat berbiometrik yang membuat
   kredensial device-bound. Bila mayoritas pengguna memakai passkey, pilih
   **mode passkey** secara sadar: `ABUSE_ATTESTATION_ALLOW_NONE=on`,
   `ABUSE_ATTESTATION_ALLOW_SYNCED=on`, dan `none` ditambahkan ke
   `ABUSE_ATTESTATION_FORMATS`. Gate lalu = "punya authenticator WebAuthn ber-UV"
   (bukan bukti silikon), sybil resistance bertumpu pada Turnstile +
   `ABUSE_REGISTRATION_GUARD`, dan akun lewat jalur itu dibuat
   `isVerified=false` sehingga fitur ber-verifikasi tetap tertutup. `ALLOW_SELF`
   dan `ALLOW_UNVERIFIED_CHAIN` tetap hanya untuk test.
5. **Root perangkat nyata (wajib untuk `packed`/`tpm`/`android-key`/`apple`):**
   `x5c` dari TPM/Windows Hello, Android Key Attestation, YubiKey, dan Apple
   biasanya berhenti di **intermediate** — root-nya tidak ikut. Dengan
   `ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=off` (default), rantai seperti itu
   ditolak kecuali root-nya dipin:

   ```bash
   # unduh + VERIFIKASI JWS FIDO MDS, lalu ambil root Android & Apple;
   # filter: hanya CA, hanya yang masih berlaku, entri MDS kompromi dibuang.
   # Metadata nextUpdate ikut ditulis ke <bundle>.meta.json (dipakai peringatan
   # boot + alert). Tanpa restart: bundle dibaca ulang berdasarkan mtime.
   node scripts/attestation-roots.mjs refresh --out /etc/nyx/attestation-roots.pem
   node scripts/attestation-roots.mjs check --bundle /etc/nyx/attestation-roots.pem
   # lalu set ABUSE_ATTESTATION_ROOTS_FILE=/etc/nyx/attestation-roots.pem
   # (fingerprint ABUSE_ATTESTATION_ROOTS hanya cukup untuk root yang ikut di x5c)
   ```

   Rantai JWS MDS diverifikasi terhadap kunci leaf `x5c` (RS256/ES256), dan
   fingerprint rantainya dipin di metadata (TOFU) — perubahan rantai adalah
   error kecuali `--accept-new-mds-chain`; `--mds-root <pem>` menutup celah itu
   dengan anchor GlobalSign yang dipin operator. Sertifikat yang bukan CA dan
   yang kedaluwarsa **dibuang** (tidak bisa memverifikasi tanda tangan baru),
   dan seluruh root milik entri MDS berstatus `REVOKED`/
   `ATTESTATION_KEY_COMPROMISE`/`USER_KEY_*`/`USER_VERIFICATION_BYPASS`
   dibuang. Detail alur, sumber sertifikat, dan rotasinya:
   `ops/attestation/README.md`.

   Jalankan `check` (atau `refresh`) berkala — mis. cron mingguan — karena
   MDS memberi `nextUpdate` yang harus disegarkan sebelum tanggal itu. Boot akan
   memperingatkan bila attestation ketat menyala tanpa root dipin, bila
   `ALLOW_UNVERIFIED_CHAIN=on` (menerima self-signed buatan siapa pun sebagai
   "hardware"), bila metadata bundle tidak ada, bila `nextUpdate` MDS sudah/
   hampir lewat (≤30 hari), bila bundle memuat root kedaluwarsa, atau bila
   sha256 bundle berbeda dari yang dicatat metadata (diganti manual).
6. `TURNSTILE_SECRET_KEY` tetap wajib (pendaftaran menolak tanpa token sah).

**Memantau.** Gauge `nyx_abuse_guard_enabled{guard="registration"|"attestation"}`
(1 = menahan; mode `shadow` dihitung **0** karena ia tidak menahan) + alert
`NyxAbuseGuardDisabled`. Peringatan boot (`utils/startupSignals.ts`) menyebut
lingkungan produksi tanpa guard/attestation. Riwayat keputusan guard:
`nyx_registration_guard_observed_total`; blokirnya: `nyx_security_blocks_total`
+ `nyx_relay_errors_total{result}`.

**Gerbang attestation sendiri** punya empat alert, karena kegagalannya tidak
pernah terlihat sebagai error server — hanya `403 ATTESTATION_REJECTED: <KODE>`
per percobaan, atau bundle root yang diam-diam basi:

| Alert | Menyala saat | Tindakan |
|---|---|---|
| `NyxAttestationRootNotTrusted` | ada penolakan `reason="root_not_trusted"` (1 jam) | segarkan bundle (`refresh`) atau pin fingerprint vendor; jangan longgarkan `ALLOW_UNVERIFIED_CHAIN` |
| `NyxAttestationRejectionRateHigh` | >50% dari (accepted+rejected) ditolak selama 30 menit **dan** ≥3 penolakan/jam | kode alasan di body 403: `format_not_allowed`/`synced_authenticator`/`user_verification` = kebijakan vs perangkat; `root_not_trusted`/`certificate_expired` = bundle |
| `NyxAttestationRootExpired` | `nyx_attestation_roots_expired_certs > 0` selama 1 jam | `refresh` lalu restart `nyx-api` (gauge diisi saat boot) |
| `NyxAttestationRootBundleStale` | `nextUpdate` MDS di metadata sudah lewat | `refresh` sebelum perangkat baru mulai ditolak `root_not_trusted` |

`nyx_attestation_registration_total{result,reason}` adalah sumber utama untuk
diagnosis: `reason` hanya kode enum pendek (`root_not_trusted`,
`certificate_expired`, `synced_authenticator`, …), jadi angka ini aman dipantau
tanpa memuat identitas siapa pun. Alasan yang belum dipetakan masuk `unmapped`.

**Menjaga bucket tetap segar.** `refresh` menulis metadata berisi `nextUpdate`
MDS; `check` memperingatkan bila tanggal itu lewat atau bundle memuat root
kedaluwarsa. Jadwalkan mingguan (contoh):

```bash
0 4 * * 1 cd /opt/nyx && node scripts/attestation-roots.mjs refresh \
  --out /etc/nyx/attestation-roots.pem >> /var/log/nyx-roots-refresh.log 2>&1
```

Bundle dipakai tanpa restart (cache `path + mtime`), tetapi **gauge** dan
peringatan boot hanya diperbarui saat proses start — restart `nyx-api` setelah
refresh bila ingin alert ikut segar.

**Rollback.** Kembalikan env ke `off` lalu restart `nyx-api` — tidak ada state
yang perlu dibersihkan. Counter guard ber-TTL (1 jam / 10 menit) dan key-nya
adalah **HMAC pepper** dari IP/ASN/instalasi, bukan nilai mentah.

**Yang tidak boleh diregresikan.** Semua key Redis yang menyebut klien harus
tetap ter-pepper: `regburst:src|inst|asn|asnfast`, `pow:user|inst|fp|ip`
(`powRateKey`), dan key limiter `express-rate-limit` (`clientIpTag`). Snapshot
Redis karena itu tidak bisa dipakai untuk mengenumerasi alamat pengguna —
mengganti salah satunya kembali ke IP mentah = membatalkan kriteria audit WS-H
(`docs/30` §30.12).

**Sisa yang disadari:** pengukuran false-positive lapangan (langkah 1) butuh
trafik produksi nyata. Attestation browser sudah diuji E2E (2026-10-17) dengan
authenticator platform virtual Chromium pada kebijakan ketat + sertifikat uji
dipin: `428` → upacara WebAuthn → `201` dengan `isVerified` + baris
`Authenticator`. Yang **belum** dibuktikan: kunci privat di dalam silikon
sungguhan (TPM/SE/Titan) dan rantai vendor nyata — keduanya butuh perangkat fisik
+ bundle root dari `ops/attestation/README.md`, bukan kode baru.

## 10.17 Rotasi kunci at-rest (`ENC2` + key ring) — added 2026-10-25, docs/37 P6

Kolom ter-seal (`UserHiddenConversation.userId`, `Story.authorTag`,
`BlockedUser.*Tag`, `Message.senderId|sessionId|repliedToId`, `Device.nameSealed`,
`Tenant.apiKey`, `PushSubscription.endpointSealed`, device id di `content` SYSTEM)
dulu memakai satu kunci turunan `NYX_AT_REST_PEPPER` dan envelope tanpa versi.
Sekarang envelope ber-versi dan kuncinya bisa dirotasi **tanpa downtime**.

**Format.** Legacy (tanpa prefiks) = kunci id `0` (turunan pepper) dan selalu
tetap terbaca. Baru: `ENC2:<keyId>:<base64url(nonce‖ct)>`. Key id yang tidak ada
di ring → `openAtRest` mengembalikan `null` (gagal baca terlihat), bukan
plaintext/tebakan.

**Konfigurasi.**

```bash
# /root/nyx-app/.env (jangan commit; JANGAN disimpan di DB)
NYX_AT_REST_KEYRING='{"active":"k2026-11","keys":{"k2026-11":"<32+ char>","k2026-10":"<lama>"}}'
# atau custody file (systemd-creds, izin 0400/0600):
# NYX_AT_REST_KEYRING_FILE=/run/credentials/nyx-api.service/at-rest-keyring.json
```

Id `0` dicadangkan. Key ring yang **ada tetapi tidak valid** (JSON rusak, id
aktif tidak ada, materi <16 char) membuat request gagal — bukan diam-diam
kembali ke legacy. Status aman dilihat di `GET /api/admin/system-status` →
`atRest: { ok, activeKeyId, keyCount, envelope, custody, legacyReadable }`.

**Prosedur rotasi (urut, jangan dibalik).**

1. Backup DB **dan** key ring lama (dua tempat terpisah).
2. Tambah slot baru di key ring, `active` = slot baru, restart `nyx-api`.
   Tulisan baru langsung `ENC2`, baris lama tetap terbaca (lookup ganda).
3. Dry-run re-seal dari `server/`:
   `pnpm exec tsx scripts/reseal-at-rest.ts` → catat `legacy` dan `unreadable`.
   `unreadable > 0` = berhenti; ada nilai yang tak bisa dibuka (kunci hilang),
   jangan hapus apa pun.
4. Terapkan: `pnpm exec tsx scripts/reseal-at-rest.ts --apply`
   (batch 500 baris, idempoten, boleh dihentikan dan diulang).
5. Verifikasi: jalankan dry-run lagi → `0 legacy`, `0 ditulis`. Baru setelah itu
   slot lama boleh dihapus dari key ring.
6. Cek fungsional: kirim pesan 1:1 & grup, buka daftar perangkat, blokir/unblock,
   story, logout (hapus push), admin tenants.

**Rollback.** Kembalikan `active` ke slot lama — **jangan** mengosongkan key
ring setelah ada baris `ENC2`: nilai yang ditulis dengan slot baru hanya bisa
dibuka bila slot itu masih ada di `keys`, dan tanpa key ring `openAtRest`
mengembalikan `null` (gagal baca, tercatat sebagai peringatan `kunci … tidak ada
di key ring`). Mengosongkan ring hanya aman **sebelum** langkah 4 dijalankan.
Karena itu jangan menghapus slot mana pun sebelum langkah 5 hijau.

**Yang tidak ikut berubah.** Blind index (`HMAC(pepper, nilai)`), tag instalasi,
tag receipt, dan seed OPRF tetap memakai pepper: HMAC satu arah + plaintext tidak
disimpan server, jadi tidak bisa di-reindex dari sisi server (docs/28 §R4).
Menjadwalkan "rotasi pepper" dengan harapan kolom itu berganti adalah kesalahan.

**Batas jujur.** Ini bukan KMS/HSM: kunci ada di memori `nyx-api` dan root host
bisa membacanya. Custody `file` hanya memindahkan materi dari environment ke file
terbatas izin (`utils/keyCustody.ts`); belum ada Vault/TPM di mesin ini.

## 10.18 Relay OHTTP proses terpisah (`nyx-ohttp-relay`) — added 2026-10-25, docs/37 P7

Sebelumnya `/api/ohttp/relay` dan `/api/ohttp/gateway` berada di proses `nyx-api`
yang sama. Itu membuat klaim "relay melihat IP, gateway melihat isi" hanya
arsitektur di atas kertas: satu proses (dan satu log) bisa mengorelasikan
keduanya. Sekarang relay bisa dijalankan sebagai proses sendiri.

**Komponen.**

| Bagian | Berkas | Catatan |
|---|---|---|
| App relay | `server/src/ohttp/relayApp.ts` | `POST /relay` + `GET /healthz`; meneruskan **byte** amplop, membuang seluruh header klien |
| Unit user (selfhost) | `ops/systemd/user/nyx-ohttp-relay.service` | `systemctl --user`, tanpa root |
| Entrypoint | `server/src/ohttp/relay.ts` | baca env, validasi loopback, listen; tanpa DB/Redis/JWT |
| Script | `pnpm --filter nyx-server run relay` | dev lokal |
| Unit | `ops/systemd/nyx-ohttp-relay.service` + `.env.example` | VPS/pm2 (`/etc/systemd/system`) |

**Menyalakan.**

```bash
# 1. relay (loopback). Hanya host loopback yang diterima untuk gateway target.
install -d -m 0750 /etc/nyx/ohttp
install -m 0600 ops/systemd/nyx-ohttp-relay.env.example /etc/nyx/ohttp/nyx-ohttp-relay.env
#    isi OHTTP_GATEWAY_TARGET=http://127.0.0.1:4000/api/ohttp/gateway
install -m 0644 ops/systemd/nyx-ohttp-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nyx-ohttp-relay
curl -fsS http://127.0.0.1:4100/healthz

# 2. API berhenti memasang /relay sendiri
#    /root/nyx-app/.env: OHTTP_RELAY_EXTERNAL=1  → restart nyx-api

# 3. nginx meneruskan jalur publik ke relay (bukan ke API)
#    location = /api/ohttp/relay { proxy_pass http://127.0.0.1:4100/relay; … }

# 4. klien: default memakai `/api/ohttp/relay` di origin sendiri (nginx → :4100),
#    jadi tidak perlu env apa pun. Set VITE_OHTTP_RELAY_URL hanya bila relay
#    berada di origin/host lain.
```

**Batasan yang ditegakkan saat boot.** Target gateway non-loopback ditolak
(relay akan menjadi open proxy) kecuali host itu disebut eksplisit di
`OHTTP_GATEWAY_TRUSTED_HOSTS` (Docker: `server`); `OHTTP_TOKEN_MODE=off` ditolak
(relay tidak punya sesi/DB untuk mencetak token); bind non-loopback ditolak
kecuali `OHTTP_RELAY_ALLOW_PUBLIC_BIND=1` (dipakai compose — bind lebar di
jaringan container, nginx yang mengekspos). Body kosong = 400; upstream
mati/timeout = 502 tanpa detail internal.

**Selfhost (`~/nyx-selfhost`, systemd user).** `scripts/sync-selfhost.sh`
memasang `ops/nginx/nyx.conf` (setelah transformasi path) dan
`ops/systemd/user/nyx-ohttp-relay.service`; symlink unit ke
`~/.config/systemd/user/`, `systemctl --user daemon-reload`, lalu
`systemctl --user enable --now nyx-ohttp-relay`. Env terpisah:
`~/nyx-selfhost/ohttp/relay.env` (jangan mewarisi `server/.env`). Reload nginx:
`systemctl --user reload nyx-nginx`. Jangan enable selama `OHTTP_ENABLED` belum
diset.

**Docker (`docker-compose.yml`).** Service `ohttp-relay` sudah ada: build dari
`./server`, `command: pnpm run relay`, `OHTTP_GATEWAY_TARGET=http://server:4000/api/ohttp/gateway`,
`OHTTP_GATEWAY_TRUSTED_HOSTS=server`, `OHTTP_RELAY_HOST=0.0.0.0` +
`OHTTP_RELAY_ALLOW_PUBLIC_BIND=1`. nginx meneruskan `location = /api/ohttp/relay`
ke `http://ohttp-relay:4100/relay`. Jangan lupa `OHTTP_RELAY_EXTERNAL=1` pada
service `server`.

**Rollback.** Hapus `OHTTP_RELAY_EXTERNAL` (API memasang `/relay` lagi), hentikan
unit, kembalikan `VITE_OHTTP_RELAY_URL`. Tidak ada state.

**Batas jujur.** Kedua proses tetap di host yang sama bila dijalankan begitu;
operator host masih bisa mengorelasikan lewat jaringan/waktu. Yang hilang adalah
korelasi di log/state aplikasi. Pemisahan fisik = jalankan relay di host lain
dan ubah `OHTTP_GATEWAY_TARGET` (butuh perubahan kode karena validasi loopback
saat ini sengaja ketat).

## 10.19 PIR sidecar lokal (`nyx-pir-sidecar`) — added 2026-10-25, docs/35 Fase 4b

Pencarian PIR (ChalametPIR) membutuhkan **index** yang dibangun dari `User.oprfIndex`
dan sebuah proses yang menjawab `/params` (hint/filter/seed) serta `/query` biner.
Node tidak memegang kripto PIR: `server/src/routes/pir.ts` hanya mem-proxy byte ke
loopback, dan router `/api/pir` **tidak dipasang** tanpa `PIR_ENABLED=1` (404).

**Komponen.**

| Bagian | Berkas | Catatan |
|---|---|---|
| Sidecar | `server/pir-sidecar` (`pir-service`) | Rust; index in-memory, snapshot JSON |
| Unit user (selfhost) | `ops/systemd/user/nyx-pir-sidecar.service` | `systemctl --user`, env terpisah |
| Proxy API | `server/src/routes/pir.ts` | auth + rate limit pencarian, byte opaque |
| Snapshot | `pnpm --filter nyx-server run pir:snapshot` | tulis atomik dari `User.oprfIndex` |
| Refresh harian | `server/src/jobs/pirSnapshot.ts` | cron `15 4 * * *`, hot-swap `/admin/rebuild` |
| Klien | `web/src/lib/pirClient.ts` + worker WASM | wajib `VITE_OHTTP_ENABLED=1` |

**Env yang harus cocok (tiga tempat).**

- `server/.env`: `PIR_ENABLED=1`, `PIR_SERVICE_URL=http://127.0.0.1:9470`,
  `PIR_ADMIN_TOKEN`, `PIR_SNAPSHOT_PATH`, `PIR_OPRF_ENABLED=1` (gate OPRF; tanpa ini
  register/login tidak mengisi `oprfIndex` dan snapshot akan kosong).
- Env sidecar: `PIR_BIND` (loopback), `PIR_MASTER_SECRET`, `PIR_ADMIN_TOKEN` (**sama**
  dengan server), `PIR_SNAPSHOT_PATH` (**sama**), `PIR_ARITY`, `PIR_MAX_ENTRIES`,
  `PIR_RECORD_BYTES`.
- `web/.env`: `VITE_PIR_ENABLED=1`, `VITE_PIR_OPRF_ENABLED=1`, `VITE_OHTTP_ENABLED=1`.

**Menyalakan (selfhost).**

```bash
cd server/pir-sidecar && cargo build --release --locked
pnpm --filter nyx-server run pir:snapshot          # butuh >=1 user ber-oprfIndex
install -d -m 0750 ~/nyx-selfhost/pir
install -m 0600 <env> ~/nyx-selfhost/pir/pir.env
systemctl --user daemon-reload
systemctl --user enable --now nyx-pir-sidecar
curl -fsS http://127.0.0.1:9470/health
```

Snapshot hanya dimuat **saat boot**. Setelah user baru mendaftar, index tidak
berubah sampai cron `04:15` (hot-swap) atau operator menjalankan `pir:snapshot`
lalu `systemctl --user restart nyx-pir-sidecar`. Tanpa salah satu itu, pencarian
PIR untuk akun baru mengembalikan "tidak ditemukan"; klien sengaja **tidak**
punya fallback diam-diam ke `/api/users/search` (lihat `web/src/lib/userSearch.ts`).

**CSRF pada query PIR.** `POST /api/pir/query` lewat OHTTP tidak membawa cookie
(relay membuang header klien); identitasnya token OHTTP ber-scope di dalam amplop.
Karena itu lapisan CSRF global melewati jalur ini **hanya** bila request tidak
membawa cookie sesi sama sekali (`app.ts`); request berbasis cookie tetap wajib
CSRF. Jangan melonggarkan aturan itu ke path lain tanpa alasan yang sama.

**Rollback.** Hapus `PIR_ENABLED` (router hilang, 404) dan `PIR_OPRF_ENABLED`
(search kembali ke `usernameHash` legacy), lalu restart API. Sidecar boleh
dibiarkan mati.

## 10.20 Cookie sesi lintas subdomain — insiden realtime 2026-10-25

**Gejala.** Setelah login, dasbor `/chat` menampilkan banner kuning
`ESTABLISHING_UPLINK` terus-menerus; konsol mencatat `WebTransport connection
rejected` dua kali, lalu `wss://api.nyx-app.my.id/socket.io` **101 Switching
Protocols** tanpa satu pun error lanjutan. Tidak ada `GET /api/users/me/devices`
maupun `GET /api/conversations` sesudahnya — realtime memang tidak pernah naik.

**Sebab (dua lapis).**

1. **Cookie sesi host-only.** `web/src/lib/api.ts` memakai basis relatif (`/api`),
   jadi `at`/`rt` diterbitkan oleh `app.nyx-app.my.id`. `setAuthCookies` tidak
   pernah menyetel `Domain`, sehingga browser **tidak** mengirimkannya ke
   `api.nyx-app.my.id` — host yang dipakai socket.io (`resolveApiOrigin()`).
   Gateway lalu menjawab `44{"message":"unauthorized"}` dan menutup transport.
   socket.io **tidak** mencoba ulang untuk error middleware, jadi gejalanya
   diam-diam menggantung, bukan gagal-ulang (terverifikasi: `connect_error`
   `unauthorized` tanpa satu pun `reconnect_attempt`).
2. **`NODE_ENV` tidak pernah `production` di VPS.** `deploy.yml` menjalankan
   `pm2 start server/dist/index.js --name nyx-api -i max` **tanpa** NODE_ENV,
   sedangkan `pm2` tidak menebaknya. Akibatnya `env.nodeEnv = 'development'`:
   cookie `at` kehilangan `Secure`/`SameSite=None`, dan `cookieOptions.domain`
   (dulu `isProd ? '.nyx-app.my.id' : undefined`) tidak pernah aktif — terbukti
   dari `Set-Cookie` CSRF produksi yang tidak membawa `Domain`.

**Perbaikan yang sudah masuk repo.**

- `COOKIE_DOMAIN` (`server/src/config.ts`) — satu nilai untuk cookie sesi
  (`authCookieOptions()` di `utils/sessionUtils.ts`, dipakai set **dan** clear)
  dan cookie CSRF. Isi `.nyx-app.my.id` pada deployment yang memisah REST dan
  realtime; kosongkan pada self-host satu domain.
- Jalur WSS kini juga mengirim `handshake.auth.token` (access token di memori),
  jadi handshake tidak lagi bergantung pada cookie lintas-subdomain. Gateway
  sudah menerimanya sebagai cadangan.
- `connect_error` socket.io sekarang dicatat + status koneksi dibuat jujur
  (dulu sunyi total, klien tertinggal di `connecting`).

**Langkah operator (sekali).**

```bash
# 1. /root/nyx-app/.env  (di-overwrite deploy dari sini, jadi aman)
#    COOKIE_DOMAIN=.nyx-app.my.id
#    NODE_ENV=production            # lihat peringatan di bawah
# 2. deploy ulang, lalu verifikasi dari browser:
#    - Set-Cookie `at` membawa Domain=.nyx-app.my.id; Secure
#    - wss://api.nyx-app.my.id/socket.io menerima CONNECT (tidak ada 44 unauthorized)
#    - banner hilang setelah <=2 dtk dan `GET /api/users/me/devices` muncul
```

> ⚠ **Menyalakan `NODE_ENV=production` mengaktifkan guard `config.ts`**: API
> **menolak boot** bila `JWT_SECRET` kosong/`dev-secret`, dan `CSRF_SECRET`
> menjadi wajib. Periksa dulu `JWT_SECRET` + `CSRF_SECRET` di `.env` VPS sebelum
> menyalakannya, karena kegagalan di sini = crash-loop `nyx-api`.

> Catatan WebTransport: dengan `VITE_API_URL` relatif, `VITE_TRANSPORT_URL`
> **harus** absolut (`https://rt.nyx-app.my.id:33333`). Klien sekarang melewati
> percobaan WT bila tidak ada URL absolut (dulu mencoba
> `https://api.nyx-app.my.id/transport` yang tidak menyajikan sidecar, sehingga
> setiap sesi ditolak) dan langsung memakai WSS.
