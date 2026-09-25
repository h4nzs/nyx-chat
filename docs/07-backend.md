# 07 — Backend (Express API)

## 7.1 Overview

- Express 5, ESM TypeScript with `.js` import specifiers, executed via `tsx` (dev) or compiled `dist/` (prod, `node --max-old-space-size=1024 dist/index.js`).
- Boot order (`src/index.ts`): **Redis connect (awaited, hard prerequisite)** → dynamic-import `app.ts`, `redisBridge`, sweepers → `listen(4000)`.
- DB access only through `src/lib/prisma.ts` (Prisma 7 + `@prisma/adapter-pg`). **Local DB hosts must not get `sslmode=require`** (self-signed snakeoil TLS would kill every query) — the code adds it only for non-local hosts.
- Rate limiting, CSRF, compression, helmet CSP, and CORS are configured in `app.ts`.

## 7.2 Middleware

| Middleware | File | Notes |
|---|---|---|
| `requireAuth` | `middleware/auth.ts` | Cookie/Bearer JWT, Redis JTI blacklist, ban check (Redis cache 15m, invalidated on ban/unban) |
| `requireAdmin` | `middleware/auth.ts` | Role gate |
| `generalLimiter`/`authLimiter`/`uploadLimiter` | `middleware/rateLimiter.ts` | RedisStore; key from `req.ip` (never trust `cf-connecting-ip` alone) |
| `tenantAuth` | `middleware/tenantAuth.ts` | B2B tenant API key gate (engine routes) |
| CSRF | `app.ts` | `csrf-csrf`, state keyed per `x-nyx-installation-id` |

## 7.3 Route modules

See [12-api-reference.md](12-api-reference.md) for the complete endpoint catalog. Summary of each module:

| Module | Purpose |
|---|---|
| `auth.ts` | Register, login, refresh (family reuse detection), logout/logout-all, recover (+challenge), WebAuthn register/login, transport-ticket, PoW challenge/verify, burner guest |
| `users.ts` | Profile (me), key upload, onboarding, devices, block, search (blind-index), account deletion — profile edits broadcast `user:updated` to conversation peers |
| `conversations.ts` | Create (sandbox limit), sync, details, participants (opaque broadcasts), pin, key-rotation, leave, delete || `messages.ts` | Store-and-forward send, pending fetch (14d window, 250 cap), blind delete (R2 file cleanup) |
| `keys.ts` | Prekey bundle upload/fetch (Redis-cached), OTPK lifecycle, initial session, TURN creds |
| `sessionKeys.ts` | Blind relay of session keys + ratchet distribution |
| `sessions.ts` | Session list + revoke by JTI (family revoke + Redis blacklist) |
| `stories.ts` | Encrypted story blob create/list/delete |
| `uploads.ts` | Presigned R2 uploads (standard + burner), group avatars |
| `previews.ts` | Link preview fetch / image proxy |
| `subscriptions.ts` | NOWPayments webhook (HMAC verified, constant-time) — crypto-only |
| `engine.ts` | B2B room factory (tenant) |
| `admin.ts` | Admin console: status, ban/unban, tenants |
| `reports.ts` | Report user/bug (Discord webhook) |
| `system.ts` | `/status` (VPS metrics) |
| `wellKnown.ts` | RFC 9727 API catalog + OAuth/OIDC/MCP discovery docs |

## 7.4 Jobs

| Job | Schedule | Behavior |
|---|---|---|
| `messageSweeper` | every minute (`noOverlap`) | Deletes expired (or >14d) messages, notifies recipients via `message:deleted_batch`; fetches affected `UserHiddenConversation` rows in ONE query |
| `systemSweeper` | daily 00:00 | Expired session keys, stale devices/OTPKs, Dead-Man's-Switch account deletion |

## 7.5 Redis inventory

| Key pattern | Purpose | TTL |
|---|---|---|
| `nyx:upstream:<op>` / `nyx:downstream` | pub/sub with the Rust sidecar | — |
| `active_device:<userId>` | Single-active-device enforcement | 30d |
| `is_migrating:<userId>` | Migration mode (allow 2 devices) | transient |
| `revoked_jti:<jti>` | Refresh-token blacklist | until token expiry |
| `ban_status:<userId>` | Ban cache (`BANNED`/`OK`) | 15m |
| `cache:keys:bundle:<userId>` / `cache:keys:public:<userId>` | Prekey cache | 1h (invalidated on key rotation) |
| `rate_limit:socket:<event>:<userId>` | Socket event limits | per event |
| `sandbox:newchat:<userId>:<date>` | Sandbox chat creation limit | 1d |
| `linking_token:<token>` | QR device-linking | 5m |
| `burner:room:<roomId>` / `burner:terminated:<roomId>` | Burner rooms | — |
| `online_users` | Presence set | refreshed on join |
| `rl:<limiter>:` | express-rate-limit counters | per limiter |

All increment-based limits use the atomic Lua pattern (`RATE_LIMIT_LUA`) — never INCR-then-EXPIRE.

## 7.6 Utilities

| File | Purpose |
|---|---|
| `utils/validate.ts` | `zodValidate` middleware wrapper + `safeEqualStrings` (constant-time compare — use for every secret/token) |
| `utils/sessionUtils.ts` | `clearAuthCookies` (options identical to `setAuthCookies`), `revokeFamily` (parallel Redis blacklist) |
| `utils/mappers.ts` | Prisma → wire shape (`toRawServerMessage`, `toConversation`, `hoistKeys`) — **relay payloads must NOT duplicate `content` into a `ciphertext` field** |
| `utils/jwt.ts` | Token sign/verify helpers |
| `utils/password.ts` | Argon2id hash/verify (32MB/3 iter) |
| `utils/sanitizeForLog` (`logger.ts`) | Log scrubbing |

## 7.7 Security invariants

- Timing-safe compares for: message `deleteSecret`, conversation `authSecret`, payment webhook HMACs.
- `message:unsend` requires sender ownership OR a valid `deleteSecret`.
- Broadcasts to recipients are parallelized (`Promise.all`), with a 500-recipient cap on both REST and socket paths.
- Refresh reuse = full family revocation (containment), with the victim notified via `force_logout` — with a 5 s grace window for benign concurrent (multi-tab) refreshes.
- `CSRF_SECRET` is trimmed before use; empty/whitespace falls back to `JWT_SECRET` with a warning pointing at the production `.env`.

> **Full module catalog:** see [22-backend-reference.md](22-backend-reference.md) for the complete inventory of routes, middleware, bridge, utils, jobs, and Redis keys.
