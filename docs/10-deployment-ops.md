# 10 — Deployment & Operations

## 10.1 Topology (prod)

| Component | Where | Notes |
|---|---|---|
| Web app | `https://app.nyx-app.my.id` | Static build in `/var/www/nyx-web` (nginx) |
| API | `https://api.nyx-app.my.id` → `localhost:4000` | pm2 `nyx-api` (cluster) |
| WebTransport | `https://rt.nyx-app.my.id:33333` | pm2 `nyx-sidecar` (Rust, satu fork) |
| Marketing | `https://nyx-app.my.id` | `/var/www/nyx-marketing` |
| Key Transparency | `127.0.0.1:8085` (HTTP baca), `127.0.0.1:8081` (gRPC tulis), `127.0.0.1:8082` (gRPC auditor) | binary Go `nyx-kt-query` + LevelDB miliknya — **satu-satunya** pemilik log KT; binary + unit systemd dikirim `deploy.yml` (config + kunci log tetap owner ops, §10.15) |
| DB | `127.0.0.1:5432/nyx_app` (user `nyx`) | Local PostgreSQL 18 on the VPS (versi prod terkonfirmasi dari dump — `docs/28` §28.7) |
| Redis | `127.0.0.1:6379` | pub/sub bridge + caches |
| Storage | Cloudflare R2 | Encrypted blobs + arsip snapshot KT (`kt-snapshots/`) |
| TURN (WebRTC) | coturn `:3478/udp+tcp`, `:5349/tls` + rentang relay | **primer** untuk kredensial `/api/keys/turn`; Cloudflare TURN hanya cadangan; prosesnya systemd = owner ops (§10.9) |
| Observability | NYX `127.0.0.1:9464`; Prometheus (default `:9090`); exporter node `:9100`, postgres `:9187`, redis `:9121`; Grafana | konfigurasinya di-commit di `ops/`; pemasangan manual (§10.12) |

`deploy.yml` mengurus **web, marketing, `nyx-api`, `nyx-sidecar`, dan binary + unit systemd `nyx-kt-query`**. Yang **tidak pernah** dikirim otomatis (owner ops, sinkron manual): `web/nginx.conf` (§10.9), config + kunci log KT (§10.15), coturn, `ops/prometheus` + `ops/grafana` (§10.12), sysctl/PostgreSQL/Redis (§10.11), dan `.env` (hanya disalin lokal di VPS).

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
2. Package ke `nyx-deploy.zip`: manifest root + `packages/shared` (+ `dist`) + `web/dist` + `marketing/dist` + `server/{src,dist,package.json,tsconfig.json,prisma}` + binary sidecar + `server/kt-query/{nyx-kt-query,nyx-kt-check}` + `ops/systemd/`. **Tidak** ikut: `web/nginx.conf`, `ops/{prometheus,grafana}`, `scripts/`, `docker-compose.yml`.
3. SCP to VPS (`root@…`) → `pm2 stop nyx-api nyx-sidecar` → binary KT lama disimpan sebagai `nyx-kt-query.prev` (rollback cepat) → unzip ke `/root/nyx-app` (menimpa; `server/{src,dist}`, `web/`, `marketing/` dihapus lebih dulu).
4. On VPS: `pnpm install --frozen-lockfile` → **copy `/root/nyx-app/.env` → `server/.env`** (prod secrets live only on the VPS) → `prisma generate` → `prisma db push` (consent env, `|| true`) → deploy web/marketing to `/var/www/…` → reload nginx → `pm2 delete` + `pm2 start` `nyx-api` (`-i max`, `--max-old-space-size=1024`) dan `nyx-sidecar` → `pm2 save --force`.
5. Layanan log KT (§10.15): binary di-`chmod +x`, unit `/etc/systemd/system/nyx-kt-query.service` disegarkan dari `ops/systemd/` + `systemctl daemon-reload`. Kalau unit **`enabled`**: `systemctl restart nyx-kt-query` → tunggu 2 s → `is-active` + `curl 127.0.0.1:8085/healthz`; gagal ⇒ deploy berhenti **merah** (log KT mati = kunci identitas baru tidak ter-audit). Kalau belum `enabled`: hanya pesan informatif — pemasangan pertama ada di `ops/systemd/README.md`.

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
| `NYX_AT_REST_PEPPER` | [docs/28 Tier 0] Pepper hash identifier at-rest + kunci seal deterministik. **Wajib**: `utils/atRestSecrets.ts` melempar error di produksi tanpa ini; bocor = dump DB bisa dibalik |
| `GROUP_ISSUER_KEY_PKCS8` | [docs/28 Tier 0.1] Private key issuer blind RSA grup (base64 PKCS#8). Wajib di produksi (fail-closed) karena kunci keanggotaan grup **tidak** disimpan di DB. Buat: `pnpm --filter nyx-server run issuer-key:generate` |
| `GROUP_ISSUER_KEY_VERSION` | Versi kunci issuer (default `1`); naikkan untuk rotasi — row publik dibuat otomatis |
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
| `ABUSE_ATTESTATION_ALLOW_SELF` / `ABUSE_ATTESTATION_ALLOW_NONE` / `ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN` / `ABUSE_ATTESTATION_ALLOW_NO_AIK_EKU` | Pelonggaran verifikasi (self/none = bukan bukti perangkat; rantai x5c tak diverifikasi; EKU AIK TPM tidak diwajibkan). Semuanya **hanya untuk test** |
| `ASN_DB_FILE` | Tabel `prefix,asn` LOKAL (ekspor GeoLite2-ASN). Kosong = lapisan ASN nonaktif; IP mentah tidak pernah disimpan, yang masuk Redis hanya nilai ter-pepper |
| `NOWPAYMENTS_API_KEY` / `NOWPAYMENTS_IPN_SECRET` | Payments (crypto-only) |
| `DISCORD_REPORT_WEBHOOK_URL` | Abuse reports |

> Catatan: `RESEND_API_KEY` dan `SUPABASE_URL/SUPABASE_SERVICE_KEY` yang dulu ada di tabel ini **sudah tidak ada di kode** (tidak ada pemakaian `process.env.*`-nya maupun di `.env.example`) — jangan diset lagi.

### `nyx-sidecar` (env proses Rust, `docs/08` §8.2)

`JWT_SECRET` (harus sama dengan API — token AUTH diverifikasi di sidecar), `REDIS_URL`, `TRANSPORT_PORT` (default `33333`, **UDP**), opsional `PROD_CERT_PATH` / `PROD_KEY_PATH` (sertifikat CA di produksi; tanpa keduanya sidecar membuat self-signed dan mencetak hash-nya).

### `nyx-kt-query` (env proses log KT, §10.15)

`KT_CONFIG_FILE` (config YAML berisi kunci log + `db.file`), `NYX_KT_QUERY_ADDR` (default `127.0.0.1:8085`), `NYX_KT_WRITE_ADDR` (`127.0.0.1:8081`), `NYX_KT_AUDITOR_ADDR` (`127.0.0.1:8082`), `NYX_KT_SNAPSHOT_DIR`, `NYX_KT_SNAPSHOT_INTERVAL` (`24h`), `NYX_KT_SNAPSHOT_KEEP` (`7`). Semua alamat = loopback; tidak ada port KT yang boleh publik.

### Web (`web/.env` → build-time `VITE_*`, disuntik `deploy.yml` dari secrets)

| Var | Purpose |
|---|---|
| `VITE_API_URL` | Origin REST API |
| `VITE_TRANSPORT_URL` | Origin WebTransport; kosong = diturunkan dari `VITE_API_URL` (http→https) |
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
- Kunci yang **wajib** ada hanya di `.env` produksi (bukan di DB, bukan di backup): `NYX_AT_REST_PEPPER`, `GROUP_ISSUER_KEY_PKCS8`, dan config YAML `nyx-kt-query` (kunci `signing-key`/`vrf-key`/`prefix-key`/`opening-key` log KT). Bocornya pepper = identifier at-rest bisa dibalik; bocornya issuer key = keanggotaan grup bisa dipalsukan; bocornya kunci log KT = log bisa ditulis oleh pihak lain.

## 10.8 Rollback

1. `git revert <bad commit>` → push → deploy reruns.
2. DB has no automatic migration rollback — restore the latest nightly dump if a destructive `db push` shipped (downtime + `pg_restore`).

## 10.9 Security hardening sync (2026-08-23)

Remediation of `SECURITY-ASSESSMENT-2026-08-23.md` (plan: `.omo/plans/security-remediation.md`) landed in commits `d0ba35b0` (H1/H2/M1/M3), `9d520856` (M2 OTPK quota), `32814663` (L2 CSP), `9a6584d5` (nginx real_ip/XFF), `dd00d425` (I1 metadata). Everything below is **manual ops** — `deploy.yml` does **not** ship `web/nginx.conf`, so the VPS nginx config must be synced by hand, and it must be re-synced every time that file changes in the repo.

> ⚠ **Ordering matters:** commit `d0ba35b0` sets Express `trust proxy = 2`. On the *current* (pre-sync) prod chain, `req.ip` resolves to the leftmost, attacker-forgeable XFF entry — the H1 rate-limit bypass is only fully closed **after** this nginx sync. Do the sync promptly; verify with the curls in step 4.

### Step 1 — Refresh Cloudflare IP ranges

The `set_real_ip_from` block in `web/nginx.conf` was fetched from <https://www.cloudflare.com/ips/> on 2026-08-23 and is marked VERIFY-AT-SYNC-TIME. Re-fetch and update any changed ranges before syncing:

```bash
curl -s https://www.cloudflare.com/ips-v4; echo ---; curl -s https://www.cloudflare.com/ips-v6
```

### Step 2 — Syntax check locally

`web/nginx.conf` is an http-context **snippet** (starts with `include mime.types`), not a full main config — mounting it directly as `/etc/nginx/nginx.conf` fails with `"types" directive is not allowed here`. Wrap it:

```bash
cat > /tmp/opencode/nginx-wrap.conf <<'EOF'
events { worker_connections 16; }
http { include /check/nginx.conf; }
EOF
docker run --rm --add-host=server:127.0.0.1 \
  -v "$PWD/web/nginx.conf":/check/nginx.conf:ro \
  -v /tmp/opencode/nginx-wrap.conf:/etc/nginx/nginx.conf:ro \
  nginx:alpine nginx -t
# expect: syntax is ok / test is successful
```

(`--add-host=server:127.0.0.1` is needed because `proxy_pass http://server:4000` resolves the upstream hostname at parse time.)

### Step 3 — Sync to VPS

```bash
ssh -i <key> root@<VPS> 'nginx -T 2>/dev/null | grep -m1 "configuration file"'   # locate active conf path
ssh -i <key> root@<VPS> 'cp <conf-path> <conf-path>.bak.$(date +%F)'
scp -i <key> web/nginx.conf root@<VPS>:<conf-path>
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
| `nyx_admin_cleanup_total{result}` | Pemanggilan `/api/admin/cleanup` — termasuk yang DITOLAK (`forbidden`, `rate_limited`) |
| `nyx_abuse_guard_enabled{guard}` | 1 = guard menyala saat boot, 0 = off (alert `NyxAbuseGuardDisabled`) |
| `nyx_client_version_rejected_total{result}` | Request ditolak karena versi klien < `MIN_CLIENT_VERSION` (§10.14) |
| `nyx_metrics_rejected_total{reason}` | Harus **selalu 0** di produksi; >0 = ada kode yang mencoba mengirim identitas ke metrik |

**Pemasangan (ops di VPS):** Prometheus + Grafana + exporter
node/postgres/redis di host yang sama; scrape config &
alert: `ops/prometheus/prometheus.yml`, `ops/prometheus/alerts.yml`; dashboard
Grafana: `ops/grafana/dashboards/nyx-overview.json` (impor manual: Grafana →
Dashboards → Import, pilih datasource Prometheus). Alertmanager tidak
di-commit (berisi token notifikasi).

**Dashboard yang di-commit** memakai metrik yang sama dengan alert — ambang di
panel dijaga identik dengan `alerts.yml` supaya tidak ada dua kebenaran. Panel
`nyx_metrics_rejected_total` (harus 0) dan `Redis key ter-evict` sengaja diberi
warna merah pada nilai > 0: keduanya berarti jaminan privasi/rate-limit sudah
bocor, bukan sekadar performa.

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
dirujuk aturan harus ada di `metrics.ts`) → cakupan drill (aturan baru wajib punya
kasus). Lapis terakhir opsional men-scrape `/metrics` nyata. **Sebuah aturan yang
merujuk metrik yang salah tulis tidak akan pernah menyala dan tidak menghasilkan
error apa pun** — itu yang dicegah lapis ketiga. Ini juga jalan per-PR (job CI
`alerts`, dan versi scrape-nyata di job `e2e`).

Kalau ingin mereproduksi gejalanya dengan tangan: matikan exporter →
`NyxMetricsExporterDown`; isi disk sampai <12% → `NyxHostDiskLow`; hentikan
sweeper → `NyxSweeperStale`.

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
gejala adalah tabel `Message` yang tumbuh.

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
- **Layanan auditor pihak ketiga** di listener terpisah (`:8082`) — kodenya siap,
  tetapi **belum ada auditor nyata yang beroperasi** (`server/kt-query/README.md`
  "Sisa yang jujur").

**Deploy: otomatis, dengan satu langkah sekali-saja.** Unit-nya ada di repo
(`ops/systemd/nyx-kt-query.service` + template `nyx-kt-query.env.example` +
`ops/systemd/README.md`), jadi sejak 2026-10-15:

| Bagian | Siapa yang mengerjakan |
|---|---|
| Build binary dari vendor (`nyx-kt-query` + `nyx-kt-check`) | `deploy.yml` (CI) |
| Salin binary + `ops/systemd/` ke VPS, segarkan unit, `daemon-reload` | `deploy.yml` |
| Restart + verifikasi (`is-active`, `/healthz`) bila unit `enabled`; gagal ⇒ deploy merah | `deploy.yml` |
| Simpan binary sebelumnya sebagai `nyx-kt-query.prev` | `deploy.yml` |
| Pemasangan pertama: direktori, kunci log + config YAML, `EnvironmentFile`, `systemctl enable --now` | **owner ops, sekali** — `ops/systemd/README.md` |
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
6. Service ini belum mengekspos `/metrics`; `ops/prometheus/prometheus.yml`
   menyiapkan tempatnya (dikomentari) supaya tidak memicu `up == 0` palsu —
   jangan menyalakannya sebelum exporter-nya ada.
7. Pin upstream naik = `scripts/vendor-signal.sh` + `go mod vendor`
   (`server/kt-query/README.md`); vendor-nya ikut di-commit dan dibuktikan bisa
   dibangun oleh job CI `build` serta dipakai ulang oleh job `kt-recovery`.
