# 10 — Deployment & Operations

## 10.1 Topology (prod)

| Component | Where | Notes |
|---|---|---|
| Web app | `https://app.nyx-app.my.id` | Static build in `/var/www/nyx-web` (nginx) |
| API | `https://api.nyx-app.my.id` → `localhost:4000` | pm2 `nyx-api` (cluster) |
| WebTransport | `https://rt.nyx-app.my.id:33333` | pm2 `nyx-sidecar` (Rust) |
| Marketing | `https://nyx-app.my.id` | `/var/www/nyx-marketing` |
| DB | `127.0.0.1:5432/nyx_app` (user `nyx`) | Local PostgreSQL 17 on the VPS |
| Redis | `127.0.0.1:6379` | pub/sub bridge + caches |
| Storage | Cloudflare R2 | Encrypted blobs |

VPS: Debian 13, **1 core / 1GB RAM / 2GB swap**, `vm.swappiness=10`, PostgreSQL tuned for low memory. Keep this in mind before adding workers/queues.

## 10.2 CI (`.github/workflows/ci.yml`)

On PR and push to `main`:

| Job | Content |
|---|---|
| `build` | frozen-lockfile install → prisma generate → `pnpm run build` |
| `unit` | `pnpm run test` (33 server + 29 web tests) |
| `lint` | non-blocking (`continue-on-error`) — typescript-eslint ≠ TS 7 |
| `audit` | `pnpm audit --prod` |
| `e2e` | Postgres+Redis services, `prisma db push` (consent env), Playwright chromium — transport specs auto-skip |
| `e2e-chrome` | Full Chrome via apt + Rust sidecar built & started; cert hash parsed into `VITE_TRANSPORT_CERT_HASH`; runs `--project=chrome` (WebTransport active) |

## 10.3 Deploy pipeline (`deploy.yml`)

Push to `main` triggers:

1. Install (frozen lockfile) → assert secrets → build shared → web → marketing → server (incl. `prisma generate`) → Rust sidecar (`cargo build --release`).
2. Package: workspace files + builds + sidecar binary → `nyx-deploy.zip`.
3. SCP to VPS (`root@…`) → unzip to `/root/nyx-app` (overwrite).
4. On VPS: `pnpm install --frozen-lockfile` → **copy `/root/nyx-app/.env` → `server/.env`** (prod secrets live only on the VPS) → `prisma generate` → `prisma db push` (consent env, `|| true`) → deploy web/marketing to `/var/www/…` → reload nginx → pm2 restart `nyx-api` + `nyx-sidecar` → `pm2 save`.

> ⚠ Any change to `.env` on the VPS will be **overwritten from `/root/nyx-app/.env`** on the next deploy. Edit the root file, not `server/.env`.

## 10.4 VPS runbook (SSH)

```bash
ssh -i <key> root@<VPS>

pm2 list                                # nyx-api (cluster), nyx-sidecar (fork)
pm2 logs nyx-api --lines 100 --nostream # API logs
pm2 restart nyx-api                     # restart after .env change
systemctl status postgresql redis-server
pg_isready && redis-cli ping
free -m                                 # RAM pressure watch
ls /root/backups/                       # nightly pg_dumps
```

## 10.5 Post-deploy checklist

1. `curl https://api.nyx-app.my.id/health` → `{"status":"ok bang"}`.
2. `pm2 logs nyx-api` — no `DatabaseNotReachable` / `TlsConnectionError`; sweeper started.
3. Open the app with a **hard reload** (service worker update) — check console for `missingKey` or CSP violations.
4. Register + send a message between two accounts.
5. Confirm no `unsafe-eval` CSP errors (Zod jitless must be intact).

## 10.6 Environment variables (full table)

### Server (`/root/nyx-app/.env`)

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | `postgres://nyx:<pw>@127.0.0.1:5432/nyx_app` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `JWT_SECRET` | Token signing (≥32 chars) |
| `CSRF_SECRET` | CSRF state secret (falls back to JWT_SECRET) |
| `CHAT_SECRET` | Admin cleanup key |
| `APP_URL` / `CORS_ORIGIN` | Public API origin / allowed origins |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile verify |
| `VAPID_SUBJECT/PUBLIC_KEY/PRIVATE_KEY` | Web Push |
| `R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET_NAME/PUBLIC_DOMAIN` | Cloudflare R2 |
| `CF_ACCOUNT_ID/CF_TURN_KEY_ID/CF_TURN_API_TOKEN` | Cloudflare TURN (WebRTC) |
| `SUPABASE_URL/SUPABASE_SERVICE_KEY` | (legacy, optional) |
| `NOWPAYMENTS_API_KEY/IPN_SECRET` | Payments (crypto-only) |
| `DISCORD_REPORT_WEBHOOK_URL` | Abuse reports |
| `RESEND_API_KEY` | Email (optional) |
| `TRANSPORT_PORT` | Sidecar port (33333) |
| `NODE_ENV` | production |

### Web (`web/.env` → build-time `VITE_*`)

`VITE_API_URL`, `VITE_TRANSPORT_URL`, `VITE_TRANSPORT_CERT_HASH` (dev pinning), `VITE_TURNSTILE_SITE_KEY`, `VITE_VAPID_PUBLIC_KEY`, `INDEXNOW_API_KEY`.

## 10.7 Secrets policy

- `.env` files are gitignored; `.env.example` (root) and `server/.env.example` are the templates.
- GitHub Actions secrets: `VPS_HOST/PORT/USER/PASSWORD`, `VITE_*`, `INDEXNOW_API_KEY`, `CI_DATABASE_URL` (optional).
- Do not commit: DB passwords (VPS: `/root/.nyx_db_pass`), VAPID private keys, R2 secret keys, sidecar private keys (`*.der`).

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
   - Result: the ONLY public socket left is the QUIC sidecar on `:33333`, which is
     designed for direct P2P (JWT auth + client-side cert-hash pinning).
2. **Firewall default-deny inbound** (owner ops on the VPS):
   ```bash
   ufw default deny incoming
   ufw allow 22/tcp          # or restrict to your admin IP(s)
   ufw allow 33333/udp       # WebTransport sidecar (QUIC)
   ufw enable && ufw status verbose
   ```
   cloudflared egress (:7844 outbound) is unaffected.
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
   `nyx-api`. On the 1 GB + 1 GB swap VPS this caps practical replicas at ~2–3;
   beyond that, move to a bigger box first.
5. The Rust WebTransport sidecar keeps its own session map per replica — if you ever
   run multiple sidecars, device targeting already tolerates unknown device IDs
   (continue-on-nonmatch), but presence fan-out assumes one sidecar; treat multi-sidecar
   as unsupported until it needs to exist.



