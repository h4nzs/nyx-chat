# 22 — Backend Reference (Express API)

A complete inventory of `server/src`. Feature-level behavior is in `14`–`20`; the endpoint catalog is `12-api-reference.md`; this is the "what lives where" map.

## 22.1 Boot & config

| File | Role |
|---|---|
| `src/index.ts` | Redis connect (awaited) → dynamic-import `app.ts`, `redisBridge`, sweepers → listen(4000) |
| `src/config.ts` | `env` object (port, cors, secrets, R2, VAPID, CF TURN…); CSRF_SECRET trim; prod JWT guard |
| `src/app.ts` | Express app: CORS, helmet/CSP, compression, CSRF (`csrf-csrf` keyed per `x-nyx-installation-id`), rate limiters, `/api/csrf-token`, `/health`, error handler |

## 22.2 Route modules (`routes/`, 17)

| Module | Mount | Notable endpoints |
|---|---|---|
| `auth.ts` | `/api/auth` | `transport-ticket`, `register`, `login`, `burner`, `refresh`, `recover`(+challenge), `logout`/`logout-all`, `pow/challenge`+`verify`, `webauthn/register/*`, `webauthn/login/*` |
| `users.ts` | `/api/users` | `me`, `me/devices`, `me/blocked`, `:id/block`, `me/keys`, `me/complete-onboarding`, `me` (DELETE account), `search`, `:id` |
| `conversations.ts` | `/api/conversations` | `sync`, create, `:id`, `:id/details`, `:id/participants`, `:id/leave`, `:id` (DELETE), `:id/pin`, `:id/key-rotation` |
| `messages.ts` | `/api/messages` | `:conversationId` (pending fetch), `POST /` (blind send), `:id` (DELETE blind) |
| `keys.ts` | `/api/keys` | `prekey-bundle`, `upload-otpk`, `count-otpk`, `otpk` (DELETE), `prekey-bundle/:userId`, `public-keys`, `prekey-bundles`, `initial-session/...`, `turn` |
| `sessionKeys.ts` | `/api/session-keys` | `:conversationId/devices/:deviceId`, `:conversationId/ratchet` |
| `sessions.ts` | `/api/sessions` | list, `:jti` (DELETE revoke) |
| `stories.ts` | `/api/stories` | create, `user/:userId`, `:id`, `:id` (DELETE) |
| `uploads.ts` | `/api/uploads` | `presigned`, `burner-presigned`, `groups/:id/avatar` |
| `previews.ts` | `/api/previews` | `POST /` (link preview), `GET /image` (proxy) |
| `subscriptions.ts` | `/api/subscriptions` | `create` (Tripay), `webhook`, `create-crypto-transaction`, `nowpayments-webhook` |
| `engine.ts` | `/api/engine` | `rooms` (B2B) |
| `admin.ts` | `/api/admin` | `system-status`, `banned-users`, `ban`/`unban`, `tenants` CRUD + toggle |
| `reports.ts` | `/api/reports` | `user`, `POST /` (bug) |
| `system.ts` | `/api/system` | `status` |
| `wellKnown.ts` | `/.well-known` | `api-catalog`, `openid-configuration`, `oauth-*`, `mcp/server-card.json`, `agent-skills/index.json` |

## 22.3 Middleware (`middleware/`, 3)

| File | Middleware |
|---|---|
| `auth.ts` | `requireAuth` (cookie `at` / Bearer; JTI blacklist; ban cache; sets `req.user`/`req.deviceId`), `requireAdmin`, `verifyAuth` |
| `rateLimiter.ts` | `generalLimiter` (300/15m), `authLimiter` (20/h), `uploadLimiter` (20/h) — RedisStore, key from `req.ip` |
| `tenantAuth.ts` | `requireTenantAuth` (validates `x-nyx-engine-key`) |

## 22.4 Network bridge (`network/redisBridge.ts`, 803 L)

- Subscribes `nyx:upstream:*`, publishes `nyx:downstream`.
- Senders: `sendToUser`, `sendJsonToUser`, `emitEventToUser` (wraps named events as `KEY_SYNC {event,data}`), `emitEventToUsers`, `broadcastToUsers`.
- Opcode handlers: `CHAT_MESSAGE` (`handleChatMessage`), `KEY_SYNC` (`handleKeySync` — big event switch), `WEBRTC_SIGNAL`/`WEBRTC_ICE`, `PRESENCE`, `AUTH` (single-device + hardware binding), `99` disconnect.
- `handleKeySync` events: `session:request_key`, `session:fulfill_response`, `session:request_missing`, `messages:distribute_keys`, `group:request_key`, `group:fulfilled_key`, `metadata:updated`, `auth:request_linking_qr`, `message:unsend`, `message:view_once_opened`, `push:subscribe`/`unsubscribe`, `burner:*`, `migration:*`, `message:*` status events.
- `checkRateLimit` (atomic Lua), `isActiveDeviceAllowed` (60 s cache), `sendAck`.

## 22.5 Utilities (`utils/`, 12) & lib (`lib/`, 3)

| File | Purpose |
|---|---|
| `errors.ts` | `ApiError` |
| `jwt.ts` | `signAccessToken` (15m), `signTransportTicket` (15s), `verifyJwt`, `newJti`, `refreshExpiryDate` (30d) |
| `logger.ts` | `sanitizeForLog` (log-injection scrub) |
| `password.ts` | argon2id `hashPassword`/`verifyPassword` (32 MB / 3 iter) |
| `validate.ts` | `safeEqualStrings` (constant-time), `zodValidate` |
| `mappers.ts` | `toRawServerMessage`, `toConversation`, `toParticipant`, `hoistKeys`, `hoistConvoKeys` — relay payloads must NOT duplicate `content` into `ciphertext` |
| `r2.ts` | `s3Client`, `getPresignedUploadUrl`, `deleteR2File(s)` |
| `secureLinkPreview.ts` | SSRF-safe link preview |
| `sendPushNotification.ts` | VAPID per-device encrypted push |
| `sessionKeys.ts` | `relaySessionKeys` (blind relay) |
| `sessionUtils.ts` | `clearAuthCookies`, `revokeFamily` |
| `lib/prisma.ts` | PrismaClient + `@prisma/adapter-pg`; sslmode only for non-local hosts |
| `lib/redis.ts` | `redisClient`, `connectRedis` |
| `lib/sodium.ts` | `getSodium` singleton |

## 22.6 Jobs (`jobs/`, 2)

| Job | Schedule | Behavior |
|---|---|---|
| `messageSweeper.ts` | every minute | delete expired (>expiresAt or >14d) messages; notify via `message:deleted_batch`; single query for affected conversations |
| `systemSweeper.ts` | daily 00:00 | purge expired refresh tokens + session keys, Dead-Man's-Switch account deletion, subscriber downgrade |

## 22.7 Redis keys

| Key | Purpose | TTL |
|---|---|---|
| `nyx:upstream:<op>` / `nyx:downstream` | sidecar↔Node bridge | — |
| `active_device:<userId>` | single-active-device | 30d |
| `is_migrating:<userId>` | migration mode | transient |
| `revoked_jti:<jti>` | refresh blacklist | token expiry |
| `ban_status:<userId>` | ban cache | 15m |
| `cache:keys:bundle:<userId>` / `cache:keys:public:<userId>` | prekey cache | 1h |
| `rate_limit:socket:<event>:<userId>` | socket event limits | per event |
| `sandbox:newchat:<userId>:<date>` | sandbox chat limit | 1d |
| `linking_token:<token>` | QR linking | 5m |
| `burner:room:<roomId>` / `burner:terminated:<roomId>` | burner rooms | — |
| `online_users` | presence | refreshed |
| `rl:<limiter>:` | express-rate-limit | per limiter |

## 22.8 Security invariants

- Constant-time compares for `deleteSecret`, `authSecret`, webhook HMACs.
- `message:unsend` requires sender ownership or valid `deleteSecret`.
- 500-recipient cap on broadcast paths; parallelized `Promise.all`.
- Refresh reuse → full family revocation + `force_logout` (with 5 s benign-concurrency grace).

## 22.9 Tests & scripts

- `tests/` (node:test, no Postgres/Redis): `password`, `validate`, `jwt`, `mappers` (TD-13 regression), `sessionKeys`.
- `scripts/reset-test-env.ts`: wipes DB + Redis for E2E; refuses in production.

## 22.10 Type declarations (`types/`, 3)

Ambient declarations (no runtime code):

| File | Purpose |
|---|---|
| `types/auth.d.ts` | `AuthPayload` (id, role, deviceId, jti) + `AuthJwtPayload` |
| `types/express.d.ts` | augments Express `Request` with `user`, `deviceId`, `jwtPayload`, `file` |
| `types/socket.io.d.ts` | legacy Socket.IO `Socket.user` augmentation |

> `prisma/seed.ts` is a **stale legacy stub** (references removed columns) — do not use it; `prisma db push` is the schema source of truth (see `09-database.md`).
