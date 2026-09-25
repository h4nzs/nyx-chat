# NYX Security Assessment Report

| | |
|---|---|
| **Target** | `https://nyx-app.my.id` + subdomains (`api.` · `app.` · `storage.` · `rt.` · `mail.`) |
| **Date** | 2026-08-23 |
| **Mode** | Authorized bug-bounty assessment — scope-strict, no-DoS (all live probes rate-capped, single-threaded, `sleep`-spaced) |
| **Method** | Hybrid white-box (public source `h4nzs/nyx-chat`) + low-rate black-box verification through the Cloudflare edge |
| **Evidence archive** | `/tmp/opencode/recon/` (raw transcripts, headers, scan output) |
| **Working notes** | `/tmp/opencode/fullscan-nyx.md` |

---

## Remediation Status (updated 2026-08-23)

In-repo remediation executed per `.omo/plans/security-remediation.md`. Findings below are resolved in source; **L1 and the nginx sync remain open ops actions** (runbook: `docs/10-deployment-ops.md` §10.9).

| Finding | Status | Commit |
|---|---|---|
| H2 — CSRF-reachable `/api/keys` | Fixed: router mounted below `doubleCsrfProtection` | `d0ba35b0` |
| H1 — forged XFF / trust proxy (code half) | Fixed in two layers: `trust proxy = 2` (`d0ba35b0`) + all limiter/PoW/CSRF keying moved to un-forgeable `CF-Connecting-IP` after live testing proved the tunnel path bypasses nginx | `d0ba35b0`, `fc90a530` |
| H1/L1 — nginx real_ip + XFF overwrite + un-shadow `/api-docs` | Committed and synced to VPS; benefits app/marketing hosts. Live Burp probe showed `api.*` reaches Express **directly via CF Tunnel** (no nginx hop), so the API-side closure comes from the code fix above, not nginx | `9a6584d5`, `fc90a530` |
| M1 — CORS deny → 500/Sentry flood | Fixed: deny without throwing (`callback(null, false)`; missed in `d0ba35b0`, caught by final verification wave) | `ba024dc2` |
| M2 — OTPK depletion DoS | Fixed: per-(requester,target) daily quota (30/24h), fail-closed 429 on both consuming endpoints | `9d520856` |
| M3 — PoW identity pinned by client header + dead otpLimiter | Fixed: userId-first identity, per-user verify throttle, dead limiter removed | `d0ba35b0` |
| L2 — app-host CSP | Fixed: jsdelivr + `'unsafe-inline'` out of script-src; inline font-loader handler removed; marketing host intentionally unchanged (Turnstile) | `32814663` |
| I1 — agent-discovery metadata drift | Fixed: stale `/api/ai/mcp` transport removed, `/health` claims absolutized, all advertised URLs verified resolvable | `dd00d425` |
| L1 — origin infrastructure disclosure | **Mitigated & verified live (2026-08-24)** — CF cannot proxy WebTransport so `rt.` stays direct; instead every TCP listener is loopback-bound (Express `b36541ac`, nginx `listen 127.0.0.1:3000`) + ufw default-deny. External probe: direct-to-IP :80/:3000/:4000 all TIMEOUT while tunnel paths return 200. Residual: direct DDoS on :33333 | — |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Infrastructure Map](#2-infrastructure-map)
3. [Methodology](#3-methodology)
4. [Findings](#4-findings)
   - [H1 — Rate-Limit Bypass via Forged X-Forwarded-For](#h1--high--rate-limit-bypass-via-forged-x-forwarded-for)
   - [H2 — CSRF-Reachable E2EE Pre-Key Overwrite](#h2--high--csrf-reachable-e2ee-pre-key-overwrite-on-apıkeys)
   - [M1 — Disallowed Origin → HTTP 500 + Sentry Flood](#m1--medium--disallowed-origin--http-500--sentry-captureexception-flood)
   - [M2 — One-Time PreKey Depletion DoS](#m2--medium--one-time-prekey-depletion-dos-against-arbitrary-users)
   - [M3 — PoW Difficulty Pinned via Client Header + Dead OTP Limiter](#m3--medium--pow-difficulty-pinned-at-minimum-via-client-controlled-identifier)
   - [L1 — Origin Infrastructure Disclosure](#l1--low--origin-infrastructure-disclosure-via-rtnyx-appmyid)
   - [L2 — Weakened Content-Security-Policy](#l2--low--weakened-content-security-policy-both-hosts)
   - [I1 — Agent-Discovery Metadata Drift](#i1--info--agent-discovery-metadata-drift)
5. [Negative Findings (Checked, Clean)](#5-negative-findings-checked-clean)
6. [Limitations — Not Tested](#6-limitations--not-tested)
7. [Attack Surface Inventory](#7-attack-surface-inventory)
8. [Remediation Priority Matrix](#8-remediation-priority-matrix)
9. [Appendix A — Raw Evidence Index](#appendix-a--raw-evidence-index)

---

## 1. Executive Summary

NYX presents a hardened external posture: Cloudflare-fronted hosts, strict TLS, locked-down origin TCP surface, modern JWT refresh rotation with family reuse detection, single-use recovery nonces, timing-safe admin comparisons, and disciplined upload presigning. Several design decisions are genuinely strong (documented in §5).

However, the assessment identified **2 High, 3 Medium, 2 Low, 1 Info** findings. The most significant cluster is a **chain**: client-controllable `X-Forwarded-For` propagates through Cloudflare → nginx → Express `trust proxy = true`, making every IP-keyed defense (auth brute-force limiter, upload limiter, PoW IP fallback, Sentry-noise ceiling) **keyable on an attacker-chosen value**. Combined with a mount-order defect that leaves `/api/keys/*` mutations outside CSRF protection while session cookies are issued `SameSite=None`, this creates a realistic path to **silent E2EE key-material replacement** for logged-in victims, plus cheap resource-amplification vectors against a 1-core production VPS.

All High/Medium findings include source references (`file:line`) and, where safely possible, live reproduction transcripts against production. Findings that are code-proven but not end-to-end exploited live are explicitly labeled, with the blocking constraint named (Turnstile-gated registration, root-only UDP tooling).

---

## 2. Infrastructure Map

### 2.1 Hosts

| Host | Resolves to | Role | Fronting |
|------|-------------|------|----------|
| `nyx-app.my.id` | 104.21.17.222, 172.67.178.156 | Marketing site (nginx static, Astro build) + reverse proxy `/api`, `/uploads`, `/.well-known` | Cloudflare |
| `app.nyx-app.my.id` | 104.21.17.222, 172.67.178.156 | React SPA (PWA) | Cloudflare |
| `api.nyx-app.my.id` | 104.21.17.222, 172.67.178.156 | Express 5 REST API (port 4000 behind nginx) | Cloudflare |
| `storage.nyx-app.my.id` | CF edge (2606:4700:… seen) | Encrypted blob delivery (R2 custom domain) | Cloudflare |
| `rt.nyx-app.my.id` | **103.169.207.156** (`nevacloud.net`) | WebTransport/QUIC sidecar (connect-src reveals port 33333) | **NONE — direct origin A record** ⚠️ |
| `mail.nyx-app.my.id` | `links1.resend-dns.com` → CloudFront | Resend e-mail infra (out of scope) | third-party |

### 2.2 DNS / TLS

- NS: `norah.ns.cloudflare.com`, `javier.ns.cloudflare.com`; MX: `route{1,2,3}.mx.cloudflare.net`; SPF `include:_spf.mx.cloudflare.net ~all`
- Edge cert: `CN=nyx-app.my.id`, issuer Google Trust Services **WE1**, validity 2026-08-05 → 2026-11-03, SANs `nyx-app.my.id`, `*.nyx-app.my.id`

### 2.3 Origin VPS (via `rt.` disclosure)

```
$ nmap -Pn -T3 --top-ports 400 -sV --version-light 103.169.207.156
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 10.0p2 Debian 7+deb13u4 (protocol 2.0)
Not shown: 399 filtered tcp ports
```
Explicit re-check of 80/443/3000/33333/5432/6379: **all filtered**. QUIC/UDP untestable without root privileges. This positive hardening coexists with the negative of publishing the origin IP at all (Finding L1).

---

## 3. Methodology

1. **Passive recon** — DNS, CT logs, subfinder, robots/sitemap/well-known mining (the `Link:` response header on the marketing root disclosed the entire agent-facing catalog).
2. **Low-rate active fingerprinting** — single-threaded `curl` header/body captures per host, TLS inspection, method probes; nuclei template pass capped at `-rl 8 -c 2` (misconfig/exposure tags only; produced zero hits before termination).
3. **White-box review** — direct read of `server/src/app.ts`, `middleware/{auth,rateLimiter,tenantAuth}.ts`, `routes/{auth,keys,uploads}.ts`, `utils/jwt.ts`, `config.ts`, `web/nginx.conf`.
4. **Safe live verification** — each candidate finding was either reproduced against production with minimal requests (transcripts archived) or labeled *code-proof* with the exact reason a live chain was not executed.
5. **Cleanup** — all scanning processes terminated and verified (`pgrep` receipt); artifacts retained as evidence.

Rate-safety notes: the production VPS is 1 core/~1 GB RAM; every probe sequence was ≤ a handful of requests with ≥1 s spacing. No fuzzing wordlists were fired at the origin; no DoS-pattern traffic was generated.

Two delegated exploration sub-agents timed out after 30 minutes with zero output; their scopes were absorbed into the direct manual review above (noted for process transparency).

---

## 4. Findings

Severity follows HackerOne convention. "Verified live" = reproduced against production during this assessment.

---

### H1 · HIGH · Rate-Limit Bypass via Forged `X-Forwarded-For`

**Verified live: ✅**

#### Description

Three configuration choices compose into a full bypass of every IP-keyed control:

1. Express trusts the entire proxy chain — [`server/src/app.ts:54`](server/src/app.ts):
   ```ts
   // Trust Proxy: Wajib true karena di belakang Cloudflare & Nginx
   app.set('trust proxy', true);
   ```
2. nginx **appends** to the client-supplied header — [`web/nginx.conf:105`](web/nginx.conf):
   ```nginx
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   ```
   `$proxy_add_x_forwarded_for` = incoming XFF + `, remote_addr`. Cloudflare behaves identically upstream. Final chain seen by Express: `<client-supplied>, <real>, <cf-edge>`.
3. Under `trust proxy = true`, `req.ip` resolves to the **leftmost** entry — fully attacker-controlled.

Every limiter keys on exactly that value ([`server/src/middleware/rateLimiter.ts:11-18`](server/src/middleware/rateLimiter.ts)):
```ts
const secureKeyGenerator = (req: Request): string => {
  const socketIp = req.ip && req.ip !== 'unknown' ? req.ip : undefined;
  ...
  return ipKeyGenerator(clientIp);
};
```
Affected controls:

| Control | Limit | Location |
|---|---|---|
| `generalLimiter` (/api/*) | 300 / 15 min / key | [rateLimiter.ts:27](server/src/middleware/rateLimiter.ts) |
| `authLimiter` (login/register/recover) | **20 / h / key** | [rateLimiter.ts:46](server/src/middleware/rateLimiter.ts) |
| `uploadLimiter` | 20 / h | [rateLimiter.ts:65](server/src/middleware/rateLimiter.ts) |
| Prod non-API cap ("CF Tunnel bypass" comment) | 1000 / 15 min | [app.ts:224-235](server/src/app.ts) |
| PoW challenge IP fallback | difficulty scaling | [routes/auth.ts:691-707](server/src/routes/auth.ts) |

#### Proof (executed against production)

```
$ curl -sS -D - -o /dev/null -H 'X-Forwarded-For: 8.8.8.8' \
    https://api.nyx-app.my.id/api/csrf-token | grep -i ratelimit
ratelimit-limit: 300
ratelimit-remaining: 299

$ curl -sS -D - -o /dev/null -H 'X-Forwarded-For: 9.9.9.9' \
    https://api.nyx-app.my.id/api/csrf-token | grep -i ratelimit
ratelimit-limit: 300
ratelimit-remaining: 299      ← fresh bucket: forged IP = new identity
```
Two requests, two distinct buckets, straight through Cloudflare + nginx. Corroborating run against the non-API limiter (`GET /health`, max 1000): `ratelimit-remaining: 999` for both forged addresses.

#### Impact

- Brute-force protection for `/api/auth/login`, `/register`, `/recover/challenge`, `/recover` is void — attacker rotates XFF per attempt and never touches the 20/hour ceiling.
- Upload and general caps become per-forged-IP, enabling resource amplification against a 1-core box.
- Amplifies M1 (unbounded "IPs" feeding Sentry exceptions).
- Spoofs the `ip:` fallback identifiers in PoW rate-state and CSRF session binding.

#### Remediation

- Set `app.set('trust proxy', N)` with the **exact hop count** (Cloudflare→nginx = fixed number) or explicit trusted IPs; never `true`.
- At nginx, **overwrite** rather than append: `proxy_set_header X-Forwarded-For $remote_addr;` (CF already normalized the client IP), or use `real_ip` module with `CF-Connecting-IP` at a single trusted boundary.
- Defense-in-depth: key sensitive limiters on authenticated user ID where available instead of IP alone.

---

### H2 · HIGH · CSRF-Reachable E2EE Pre-Key Overwrite on `/api/keys`

**Verified: structurally (mount order + live cookie flags). End-to-end browser chain not executed — registration is Turnstile-gated (see §6).**

#### Description

The double-CSRF protection is applied globally **after** some routers are already mounted ([`server/src/app.ts`](server/src/app.ts)):

```ts
app.use("/api", generalLimiter);          // line 253
...
app.use("/api/keys", keysRouter);         // line 263  ← BEFORE the CSRF layer
...
const { doubleCsrfProtection, ... } = doubleCsrf({ ... });   // line 284
app.use((req, res, next) => { ... doubleCsrfProtection(req, res, next); }); // lines 307-312
```

Everything mounted after line 307 is protected — confirmed live: an unprotected POST to `/api/auth/burner` returns `{"error":"Invalid CSRF token"}`. But every route under `/api/keys` predates the guard and accepts state-changing calls **without any CSRF token**:

| Route | Effect | Location |
|---|---|---|
| `POST /api/keys/prekey-bundle` | Overwrites device identity key, PQ identity key, signing key, signed pre-key bundle (upsert + `device.update`) | [routes/keys.ts:21-100](server/src/routes/keys.ts) |
| `POST /api/keys/upload-otpk` | Injects up to 100 one-time pre-keys | [routes/keys.ts:103-139](server/src/routes/keys.ts) |
| `DELETE /api/keys/otpk` | Deletes all victim OTPKs | [routes/keys.ts:154-163](server/src/routes/keys.ts) |

Meanwhile session cookies are issued cross-site-sendable in production ([`server/src/routes/auth.ts:64-69`](server/src/routes/auth.ts); live capture below):

```ts
const cookieOptions: CookieOptions = {
  httpOnly: true, secure: isProd,
  sameSite: isProd ? 'none' : 'lax', path: '/' }
// at: 15 min, rt: 30 days
```
```
set-cookie: x-csrf-token=<…>; Domain=.nyx-app.my.id; Path=/; HttpOnly; Secure; SameSite=None
```

Finally, `express.urlencoded({ extended: true })` is enabled globally ([app.ts:250](server/src/app.ts)), so an HTML form auto-submitting `application/x-www-form-urlencoded` — a CORS-*simple* request type that triggers **no preflight**, hence no CORS rejection — populates `req.body` including nested objects via bracket notation (`signedPreKey[key]=…&signedPreKey[pqKey]=…`), satisfying the Zod schema of `prekey-bundle`.

#### Attack chain (code-proven, not executed live)

1. Victim logs into NYX (`at` cookie, 15 min TTL, `SameSite=None`).
2. Victim visits any page containing attacker's auto-submitting form targeting `https://api.nyx-app.my.id/api/keys/prekey-bundle` with attacker-generated base64url key material in urlencoded fields.
3. Browser sends POST **with** victim cookies (no preflight, no CSRF token required on this router).
4. Server replaces the victim's active-device public identity/signing/pre-key material and poisons Redis caches `cache:keys:bundle:*` / `cache:keys:public:*` for 1 h.

#### Impact

Silent substitution of a device's E2EE public key set. Subsequent PQX3DH session establishment by contacts negotiating with that device would derive shared secrets against **attacker-chosen** keys — i.e., impersonation/MITM capability over newly established sessions, in a messenger whose entire value proposition is zero-knowledge E2EE. Also enables OTPK poisoning/deletion combos with M2.

#### Remediation

- Move `app.use("/api/keys", keysRouter)` below the CSRF middleware block (one-line fix), or apply `doubleCsrfProtection` explicitly inside the router.
- Consider `SameSite=Lax` for `at` (short-lived anyway) even if `rt` must stay `None`.
- Reject non-JSON content types on key-mutating routes (defense-in-depth vs. simple-request CSRF).

---

### M1 · MEDIUM · Disallowed Origin → HTTP 500 + Sentry `captureException` Flood

**Verified live: ✅**

#### Description

The custom CORS allowlist rejects unknown origins by **throwing** ([`server/src/app.ts:197-206`](server/src/app.ts)):

```ts
origin: (originHeader, callback) => {
  const origin = originHeader || '';
  if (isAllowedOrigin(origin)) { callback(null, true); }
  else {
    console.warn(`Blocked by CORS: ${origin}`);
    callback(new Error('Not allowed by CORS'));   // ← becomes a 500
  }
},
```

The error falls through to the generic handler ([app.ts:387-406](server/src/app.ts)) which calls `Sentry.captureException(err)` and returns `res.status(500).json({ error: "Internal server error" })`.

#### Proof (executed)

```
$ curl -sS -D - -o /dev/null -m 15 -H 'Origin: https://evil.example' \
    https://api.nyx-app.my.id/health
HTTP/2 500

$ curl … -H 'Origin: null'            → HTTP/2 500
$ curl … -H 'Origin: https://evilyx-app.my.id' → HTTP/2 500

$ curl … -H 'Origin: https://nyx-app.my.id'    → HTTP/2 200
  access-control-allow-origin: https://nyx-app.my.id     ← legit origins fine
```
Body on 500: `{"error":"Internal server error"}`.

Browser-side enforcement itself is intact (no ACAO header on denied responses, so reads stay blocked). The defects are: wrong status semantics (server fault for a client-side policy deny) and, critically, an **unauthenticated, unbounded Sentry exception feed** — combined with H1's forged-IP rotation, an attacker can saturate the Sentry quota / error log from unlimited identities, blinding real-error observability.

#### Remediation

`callback(null, false)` (omit CORS headers, respond normally) or return 403 without constructing an Error; add Sentry sampling/dedupe for the CORS tag regardless.

---

### M2 · MEDIUM · One-Time PreKey Depletion DoS Against Arbitrary Users

**Verified: code-proof + live reachability of prerequisites (csrf-token issuance and burner minting are unauthenticated; CSRF layer demonstrably active but trivially satisfied outside a browser).**

#### Description

`GET /api/keys/prekey-bundle/:userId` serves any authenticated caller any user's bundle **and atomically consumes** one OTPK per call ([`server/src/routes/keys.ts:226-239`](server/src/routes/keys.ts)):

```ts
otpk = await prisma.$queryRaw`
  DELETE FROM "OneTimePreKey"
  WHERE id = (
    SELECT id FROM "OneTimePreKey"
    WHERE "deviceId" = ${deviceTemplate.id}
    ORDER BY "createdAt" ASC
    FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING id, "keyId", "publicKey", "pqPublicKey"`
```
Bulk variant `POST /api/keys/prekey-bundles` does the same across up to 50 users ([keys.ts:429-468](server/src/routes/keys.ts)). There is **no per-(requester,target) quota** — only the rotatable general limiter (see H1). Burner identities (`POST /api/auth/burner`) require no account; a server-side script obtains a CSRF pair first (`GET /api/csrf-token` issues token+cookie to anyone — verified live) and then mints tokens at will. The browser-CSRF barrier proven live (`{"error":"Invalid CSRF token"}`) simply doesn't constrain scripted clients.

#### Impact

An attacker loops bundle fetches against a target user ID until OTPK stock is exhausted; new-session handshakes degrade/fail for that user until the client replenishes keys. On a messenger, that is targeted disruption of message reception for new conversations — cheap, deniable, hard to attribute (rotating requester identities per H1).

#### Remediation

- Quota per `(requesterId, targetId)` independent of IP; alert on depletion velocity.
- Require an existing conversation/invite relationship before serving consumable bundles, or serve non-consuming bundles to strangers and consume only for established contacts.

---

### M3 · MEDIUM · PoW Difficulty Pinned at Minimum via Client-Controlled Identifier (+ Dead OTP Limiter)

**Verified: code-proof; identifier precedence read directly from source.**

#### Description

The VIP-gate Proof-of-Work scales its difficulty by how many challenges a "client identity" has requested — but the identity priority is `instId || fingerprint || ip || userId` where `x-nyx-installation-id` is an **attacker-supplied header** ([`server/src/routes/auth.ts:700-707`](server/src/routes/auth.ts)):

```ts
// MULTI-LAYER IDENTIFICATION:
// We prioritize Installation ID (IDB), then Fingerprint, then IP
const primaryId = instId || fingerprint || ip || userId;
...
const difficulty = Math.min(4 + Math.floor(count / 1), 8);
```
Rotating the header per request keeps `count == 1` forever → difficulty pinned at **4**. Verification halves it ([auth.ts:753](server/src/routes/auth.ts)):

```ts
const targetPrefix = '0'.repeat(Math.max(1, Math.floor(difficulty / 2)));
```
→ 2 hex zeros ≈ 1/256 Argon2id passes (16 MB, 1 iteration — [auth.ts:764-772](server/src/routes/auth.ts)). With H1, the `ip` fallback is equally meaningless.

Impact paths: (a) the anti-spam VIP gate is trivially cheap to satisfy for any scripted principal; (b) each `/pow/verify` attempt burns a 16 MB Argon2id computation server-side on a 1-core VPS — an authenticated (burner-tier) resource-amplification loop.

Additionally, [`otpLimiter`](server/src/middleware/rateLimiter.ts) (5/15 min) is defined but referenced **nowhere** (repo-wide grep: zero call sites) — whatever it was meant to protect is currently unprotected, and its presence suggests coverage that does not exist.

#### Remediation

Key PoW rate state strictly on `req.user.id` (it is a `requireAuth` route — the userId is always available and was even fetched last in the priority chain); add per-user verify throttling; wire or delete `otpLimiter`.

---

### L1 · LOW · Origin Infrastructure Disclosure via `rt.nyx-app.my.id`

**Verified live: ✅ (DNS + nmap)**

`subfinder` surfaced `rt.nyx-app.my.id` → **A 103.169.207.156** (`103-169-207-156.nevacloud.net`) — the production VPS sits **outside** Cloudflare, defeating the WAF/anti-DDoS fronting used for every other host: an attacker who discovers any service later bound publicly can target the origin directly, bypassing CF rules entirely. The app CSP additionally publishes the sidecar port (`connect-src … https://rt.nyx-app.my.id:33333`, [web/nginx.conf:149](web/nginx.conf)).

Mitigating context: current TCP posture is strong (only SSH open; everything else filtered — see §2.3), so present-day impact is informational-plus. Rated Low as defense-in-depth erosion.

**Remediation.** Serve the sidecar through a Cloudflare-tunneled hostname or Spectrum; avoid origin-resolving A records on public subdomains.

---

### L2 · LOW · Weakened Content-Security-Policy Both Hosts

**Verified live: ✅ (response headers)**

- Marketing host: `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com` ([web/nginx.conf:38](web/nginx.conf))
- App host: adds `'wasm-unsafe-eval'` and **`https://cdn.jsdelivr.net`** inside `script-src` ([web/nginx.conf:149](web/nginx.conf))

`'unsafe-inline'` nullifies script-source restrictions against injected inline handlers/scripts; jsdelivr is a public CDN hosting user-publishable npm/GitHub content — effectively an attacker-hostable script gadget origin permanently on the allowlist. Any single XSS sink anywhere in the SPA becomes fully weaponizable, which is especially painful for an app whose threat model includes keystroke/plaintext theft via DOM compromise. (`img-src`/`media-src` also allow broad blob/data — lower risk.)

**Remediation.** Nonce- or hash-based script policy (Vite can emit hashes for the bootstrap snippet); remove `'unsafe-inline'`; drop jsdelivr or pin exact paths + SRI.

---

### I1 · INFO · Agent-Discovery Metadata Drift

**Verified live: ✅**

Machine-readable agent docs advertise endpoints that do not exist:

| Advertised in | Endpoint | Live status |
|---|---|---|
| [/auth.md](https://nyx-app.my.id/auth.md) | `GET /health` on marketing host | 404 (nginx) — health lives on `api.` host |
| `/auth.md` + api-catalog | `https://nyx-app.my.id/api-docs` | 404 (`Cannot GET /api-docs`) |
| MCP server-card | `https://api.nyx-app.my.id/api/ai/mcp` | 404 on GET |

For a platform actively courting agentic integration (Link headers, auth.md, skills index), stale discovery metadata misdirects integrators and erodes trust in the machine-readable surface.

**Remediation.** Either ship the advertised docs/MCP endpoint or remove them from the catalogs.

---

## 5. Negative Findings (Checked, Clean)

Things probed that held up — worth recording so future assessors don't re-burn time:

- **No webpack/Vite source maps** exposed: `.js.map` for 6 representative chunks (incl. `engine-crypto`, `crypto-worker-proxy`, `db`, `keychainDb`, `api`, `index`) → all 404.
- **`storage.nyx-app.my.id`**: random object paths → uniform clean 404s; no bucket listing behavior observed.
- **Refresh-token rotation** ([routes/auth.ts:442-476](server/src/routes/auth.ts)): family-chain reuse detection with revocation of the whole family, Redis JTI blacklist, and a documented benign-concurrent-refresh grace window (5 s, same device) — sound design.
- **Account recovery** ([routes/auth.ts:539-619](server/src/routes/auth.ts)): challenge nonce single-use (deleted on read), Ed25519 signature binds the full credential-change payload, timestamp window ±5 min, `authLimiter` applied.
- **Admin cleanup endpoint** ([app.ts:265-281](server/src/app.ts)): length-checked `crypto.timingSafeEqual` against `CHAT_SECRET`.
- **Presigned uploads** ([routes/uploads.ts:13-95](server/src/routes/uploads.ts)): folder allowlist w/ safe fallback, strict `application/octet-stream` enforcement, tier-aware size ceilings, unauthenticated burner variant still limiter-bound and 50 MB-capped.
- **Turnstile** enforced server-side on `/register` in production ([routes/auth.ts:119-150](server/src/routes/auth.ts)).
- **Login responses**: uniform `Invalid credentials` for unknown-user and bad-password (registration collision messages aside, blind-index hashing makes mass enumeration impractical by design).
- **Security response headers** broadly present: HSTS (+includeSubDomains), `X-Content-Type-Options`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy on all three first-party hosts.

## 6. Limitations — Not Tested

Stated plainly so the report isn't over-read:

1. **WebTransport/QUIC sidecar** (`rt.nyx-app.my.id:33333`, UDP) — requires root QUIC tooling not available in this environment; protocol-level testing of the Rust sidecar and `redisBridge` opcode relay was not performed.
2. **Full browser-level CSRF chain for H2** — registration is gated by a production Turnstile widget; solving it programmatically was out of scope/no-DoS discipline. The chain is proven structurally (mount order + cookie flags live + urlencoded parser config) but the final click-through was not executed.
3. **R2 presigned abuse chains** (e.g., retention manipulation, key squatting) — require a registered, verified account.
4. **Subscription webhook signature validation** (`/api/subscriptions/webhook`, `/nowpayments-webhook`) — CSRF-exempt by design ([app.ts:308](server/src/app.ts)); signature handling not audited in this pass.
5. nuclei template pass ran limited scope (misconfig/exposure) and was terminated early with zero hits — absence of template hits is weak signal, not assurance.

## 7. Attack Surface Inventory

Source-derived route table (Express routers; auth column = middleware observed):

| Router | Routes (method path) | Auth |
|---|---|---|
| auth | GET transport-ticket; POST register/login/burner/refresh/logout/logout-all/recover/pow-verify/webauthn-*-verify; GET recover-challenge/pow-challenge/webauthn-*-options | mixed (requireAuth on ticket/pow/webauthn-register; public: register/login/burner/refresh/recover/webauthn-login) |
| users | GET me, me/devices, me/blocked, search, :id; PUT me, me/keys; POST :id/block, me/complete-onboarding, me/logout; DELETE :id/block, me/devices/:deviceId, me | requireAuth |
| conversations | GET sync,:id; POST /,:id/participants,:id/pin,:id/key-rotation; PUT :id/details; DELETE :id/participants/:userId, :id/leave, :id | requireAuth |
| messages | GET :conversationId; POST /; DELETE :id | requireAuth |
| keys | POST prekey-bundle, upload-otpk, public-keys, prekey-bundles; GET count-otpk, prekey-bundle/:userId, initial-session/:c/:s, turn; DELETE otpk | requireAuth (**pre-CSRF** — see H2) |
| uploads | POST presigned, burner-presigned (unauth) | mixed + uploadLimiter |
| previews | POST /; GET image | mixed |
| sessionKeys | GET :conversationId/devices/:deviceId; POST :conversationId/ratchet | requireAuth |
| sessions | GET /; DELETE :jti | requireAuth |
| stories | POST /; GET user/:userId, :id; DELETE :id | requireAuth |
| reports | POST user, / | public |
| subscriptions | POST create, webhook, create-crypto-transaction, nowpayments-webhook | mixed (webhooks CSRF-exempt) |
| engine | POST rooms | CSRF-exempt by design |
| admin | GET system-status, banned-users, tenants; POST ban, unban, tenants; PATCH tenants/:id/toggle | requireAdmin |
| system / wellKnown | GET status; /.well-known/* handlers | public |
| static | /uploads (disk serve, CORP cross-origin) | public |

## 8. Remediation Priority Matrix

| Order | Finding | Fix effort | Risk reduced |
|---|---|---|---|
| 1 | H2 mount order | **One line** — move `/api/keys` mount after CSRF middleware | Silent E2EE key overwrite (highest product-risk) |
| 2 | H1 trust proxy | Small config change (`trust proxy` count + nginx overwrite) | Brute-force/resource-abuse class |
| 3 | M1 CORS error path | Two-line change (`callback(null,false)`) + Sentry dedupe | Observability blindness |
| 4 | M2 OTPK quotas | Moderate (new quota table/logic) | Targeted reception DoS |
| 5 | M3 PoW identity + dead limiter | Trivial (reorder priority; wire/delete otpLimiter) | VIP gate integrity, CPU burn |
| 6 | L1 origin exposure | Infra change (tunnel/Spectrum) | Future origin-direct attacks |
| 7 | L2 CSP | Frontend build work (nonces/hashes) | XSS blast radius |
| 8 | I1 docs drift | Content fix | Integrator trust |

## Appendix A — Raw Evidence Index

All files under `/tmp/opencode/recon/`:

| File | Contents |
|---|---|
| `subdomains.txt` | subfinder output (rt/storage/mail) |
| `root-headers.txt`, `root-body.html` | marketing host full headers + 74 KB body |
| `app-root.html` | app host SPA shell + chunk manifest |
| `api_health.out`, `api_.out`, `api___well-known_*.out`, `api__api_auth_login.out` | API host fingerprints, OAuth/MCP discovery JSON, route 404s |
| `wk_auth_md.out`, `wk__well-known_api-catalog.out`, `wk__well-known_openid-configuration.out`, `wk__well-known_oauth-protected-resource.out`, `wk__well-known_mcp_server-card_json.out`, `wk__well-known_agent-skills_index.json.out`, `wk_robots_txt.out` | agent-discovery corpus |
| `cors-legit.out` | allowlisted-origin ACAO echo proof |
| `mcp.out`, `api-docs.out`, `wk_health.out`, `wk_security_txt.out` | missing-endpoint receipts (I1) |
| `nmap-origin.txt` | origin TCP posture (22/tcp only) |
| `fullscan-nyx.md` (parent dir) | chronological engagement notepad incl. XFF bypass transcripts, burner CSRF 403, csrf-cookie flags |

---

*End of report. Generated 2026-08-23 during authorized assessment; no destructive actions performed; all live probing rate-capped per no-DoS constraint.*
