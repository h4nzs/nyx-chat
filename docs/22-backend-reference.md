# 22 — Backend Reference (Express API)

A complete inventory of `server/src`. Feature-level behavior is in `14`–`20`; the endpoint catalog is `12-api-reference.md`; this is the "what lives where" map.

## 22.1 Boot & config

| File | Role |
|---|---|
| `src/index.ts` | Redis connect (awaited) → dynamic-import `app.ts`, `redisBridge`, sweepers → listen(4000) |
| `src/config.ts` | `env` object (port, cors, secrets, R2, VAPID, CF TURN…); CSRF_SECRET trim; prod JWT guard |
| `src/app.ts` | Express app: CORS, helmet/CSP, compression, CSRF (`csrf-csrf` keyed per `x-nyx-installation-id`), rate limiters, `/api/csrf-token`, `/health`, error handler |

## 22.2 Route modules (`routes/`, 23)

| Module | Mount | Notable endpoints |
|---|---|---|
| `auth.ts` | `/api/auth` | `transport-ticket`, `register`, `login`, `burner`, `refresh`, `recover`(+challenge), `logout`/`logout-all`, `pow/challenge`+`verify`, `webauthn/register/*`, `webauthn/login/*` |
| `users.ts` | `/api/users` | `me`, `me/devices`, `me/blocked`, `:id/block`, `me/keys`, `me/complete-onboarding`, `me` (DELETE account), `search`, `:id` |
| `conversations.ts` | `/api/conversations` | `sync`, create, `:id`, `:id/details`, `:id/participants`, `:id/leave`, `:id/group` (DELETE — admin purge), `:id` (DELETE), `:id/pin`, `:id/key-rotation` |
| `messages.ts` | `/api/messages` | `:conversationId` (pending fetch), `POST /` (blind send), `:id` (DELETE blind) |
| `keys.ts` | `/api/keys` | `prekey-bundle`, `upload-otpk`, `count-otpk`, `otpk` (DELETE), `prekey-bundle/:userId`, `public-keys`, `prekey-bundles`, `initial-session/...`, `turn` |
| `sessionKeys.ts` | `/api/session-keys` | `:conversationId/devices/:deviceId`, `:conversationId/ratchet` |
| `sessions.ts` | `/api/sessions` | list, `:jti` (DELETE revoke) |
| `stories.ts` | `/api/stories` | create, `user/:userId`, `:id`, `:id` (DELETE) |
| `uploads.ts` | `/api/uploads` | `presigned`, `burner-presigned`, `groups/:id/avatar` |
| `previews.ts` | `/api/previews` | `POST /` (link preview), `GET /image` (proxy) |
| `subscriptions.ts` | `/api/subscriptions` | `create-crypto-transaction`, `nowpayments-webhook` (crypto-only) |
| `engine.ts` | `/api/engine` | `rooms` (B2B) |
| `admin.ts` | `/api/admin` | `system-status`, `banned-users`, `ban`/`unban`, `tenants` CRUD + toggle |
| `reports.ts` | `/api/reports` | `user`, `POST /` (bug) |
| `system.ts` | `/api/system` | `status` |
| `wellKnown.ts` | `/.well-known` | `api-catalog`, `openid-configuration`, `oauth-*`, `mcp/server-card.json`, `agent-skills/index.json` |
| `groups.ts` | `/api/groups` | `POST /sync` (token di body, tanpa cookie/JWT — satu-satunya jalur tulis yang boleh lewat OHTTP), mailbox/epoch, `tokens` |
| `callTokens.ts` | `/api/call-tokens` | `POST /` issue, `POST /resolve` (token acak → sesi, userId tidak pernah di envelope) |
| `ktQuery.ts` | `/api/keys/kt` | proxy bukti KT (protobuf base64url, tanpa parsing di Node) |
| `backup.ts` | `/api/backup` | arsip terenkripsi klien (header + chunk), R2 |
| `ohttp.ts` | `/api/ohttp` | `GET /config` (`application/ohttp-keys`), `POST /relay` (404 bila `OHTTP_RELAY_EXTERNAL=1`), `POST /gateway` — docs/10 §10.18 |
| `pir.ts` | `/api/pir` | `GET /params`, `POST /query` — proxy byte opaque ke sidecar ChalametPIR; tidak dipasang tanpa `PIR_ENABLED=1` (docs/10 §10.19) |

## 22.3 Middleware (`middleware/`, 3)

| File | Middleware |
|---|---|
| `auth.ts` | `requireAuth` (cookie `at`, fallback `embed_at` for embed pages, / Bearer; JTI blacklist; ban cache; sets `req.user`/`req.deviceId`). Token ber-`scope=ohttp` (120 dtk) hanya diterima untuk target allowlist OHTTP (`utils/ohttpToken.ts`), jadi token dari amplop tidak bisa dipakai memutasi/mengirim apa pun. `requireAdmin`, `verifyAuth` |
| `rateLimiter.ts` | `generalLimiter` (300/15m), `authLimiter` (20/h), `uploadLimiter` (20/h) — RedisStore, key = `clientIpTag(req)` (HMAC pepper atas alamat klien, **bukan** IP mentah — `docs/30` §30.12 WS-H) |
| `tenantAuth.ts` | `requireTenantAuth` (validates `x-nyx-engine-key`) |

## 22.4 Network bridge (`network/redisBridge.ts`, 803 L)

- Subscribes `nyx:upstream:*`, publishes `nyx:downstream`.
- Senders: `sendToUser`, `sendJsonToUser`, `emitEventToUser` (wraps named events as `KEY_SYNC {event,data}`), `emitEventToUsers`, `broadcastToUsers`.
- Opcode handlers: `CHAT_MESSAGE` (`handleChatMessage`), `KEY_SYNC` (`handleKeySync` — big event switch), `WEBRTC_SIGNAL`/`WEBRTC_ICE` (`handleWebRtcRelay`), `PRESENCE`, `AUTH` (single-device + hardware binding), `99` disconnect.
- `handleKeySync` events: `session:request_key`, `session:fulfill_response`, `messages:distribute_keys` (explicit ACK error — legacy path removed), `group:request_key`, `group:fulfilled_key`, `metadata:updated`, `auth:request_linking_qr` (dipakai `LinkDeviceModal` → `auth:linking_qr_ready`; persetujuan lewat REST `/api/auth/link/*`, lihat docs/14 §14.10), `message:unsend`, `message:view_once_opened`, `push:subscribe`/`unsubscribe`, `burner:*`, `migration:*`, `message:*` status events. (`session:request_missing` was removed: no sender, no listener.)
- `checkRateLimit` (atomic Lua), `isActiveDeviceAllowed` (60 s cache), `sendAck`. Data buckets live in the handlers (`CHAT_RATE_LIMIT`/`ACK_RATE_LIMIT`/`PRESENCE_RATE_LIMIT`), so the WSS gateway and the WT path share one counter each — see `realtime/gateway.ts` (no local buckets) and `tests/gatewayParity.test.ts`.

## 22.5 Utilities (`utils/`, 72) & lib (`lib/`, 3)

Tabel di bawah menyorot helper yang mengatur batas keamanan; `ls server/src/utils` adalah daftar lengkap (72 berkas, termasuk `privacyPass`, `groupMailbox`/`groupSync`/`groupTokens`, `keyCustody`, `atRestSecrets`, `syncProofs`, `searchOprf`, `ohttpToken`, `allowedOrigin`, `uploadLimits`, `releaseJitter`, `transportCapability`).

| File | Purpose |
|---|---|
| `errors.ts` | `ApiError` |
| `atRestSecrets.ts` | `sealAtRest`/`openAtRest`/`credentialTokenMatches`/`hashCredentialToken` — sealing deterministik dari `NYX_AT_REST_PEPPER` (docs/28 Tier 0) |
| `routingIdentity.ts` | `routingIdentity`/`routingCandidates`/`upsertMembership`/`findMembership`/`deleteMembership`/`purgeSealedUserRows` — kolom routing & keanggotaan ter-seal |
| `senderIdentity.ts` | identitas pengirim at-rest (docs/28 Tier 4) |
| `temporalBucket.ts` | `messageTimeBucket` (15 menit) untuk `createdAt`/`expiresAt`/`lastMessageAt`/`MessageStatus.updatedAt` |
| `messageSequence.ts` | `seq` per-conversation (urutan & kursor paginasi) |
| `authGate.ts` | Satu aturan blacklist JTI + ban (dipakai REST `requireAuth` **dan** realtime gateway) |
| `ohttpToken.ts` | Token carriage OHTTP (scope/aud `ohttp`, 120 dtk) + `isOhttpScopeRequestAllowed` (allowlist yang sama dengan gateway) |
| `searchOprf.ts` | Kunci OPRF server dari at-rest pepper + `searchOprfIndexForIdentifier` (isi `User.oprfIndex` saat register/login) |
| `credentialPresentation.ts` | Verifikasi presentasi token grup (menggantikan credential blind RSA yang dihapus 2026-10-23) |
| `groupAccess.ts` | Otorisasi jalur grup: add/kick anggota, leave, details, rotasi kunci, purge (`BLIND_AUTH_REQUIRED` / `ADMIN_AUTH_REQUIRED` / `MEMBERS_REMAIN`) |
| `adminCapability.ts` | `hashAdminToken`/`isAdminTokenValid` (SHA-256, constant-time, NULL hash = fail-closed) |
| `keyBundle.ts` | Pemetaan device Prisma → `IDeviceTemplate`/bundle publik |
| `sessionKeys.ts` / `sessionRevocation.ts` | Blind relay session key; revokasi sesi (ownership 404, family, blacklist TTL) |
| `encryptedKeysSync.ts` | Salinan `encryptedPrivateKey` terbaru saat bundle di-upload |
| `otpkQuota.ts` | Kuota harian OTPK per pasangan (Lua INCR+EXPIRE, fail-closed) |
| `registrationGuard.ts` | Anti-abuse registrasi bertingkat tanpa PII (IP ter-HMAC + per instalasi) |
| `clientIp.ts` | IP klien tahan pemalsuan (Cloudflare proxy/tunnel) |
| `powIdentity.ts` | Rate-state PoW (VIP gate) |
| `redisIdentity.ts` | `identityKey`/`identityTag` — key Redis ber-tag, tanpa userId mentah |
| `redisResilience.ts` | `checkRateLimit` di atas client Redis yang diberikan |
| `presencePeers.ts` / `presenceSubscriptions.ts` | Presence per-kontak (peer-scoped, lazy/opt-in) |
| `metrics.ts` / `metricsEndpoint.ts` | Deklarasi metrik event-only + exporter `/metrics` loopback |
| `dumpAudit.ts` | Analisis dump DB (murni, tanpa DB) dipakai `scripts/privacy-dump-audit.ts` |
| `groupMetadataBlob.ts` | Sanitasi blob metadata grup tanpa identitas penulis |
| `backupObject.ts` | Kunci objek R2 backup akun (HMAC, tanpa userId) |
| `turnCredentials.ts` | Kredensial TURN time-limited (coturn `static-auth-secret`) |
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

## 22.6 Jobs (`jobs/`, 5)

| Job | Schedule | Behavior |
|---|---|---|
| `messageSweeper.ts` | every minute | delete expired (>expiresAt or >14d) messages ordered by `expiresAt` asc (nulls first), 500/page, ≤20 pages per run; notify via `message:deleted_batch`; single query for affected conversations |
| `systemSweeper.ts` | daily 00:00 | purge expired refresh tokens + session keys, Dead-Man's-Switch account deletion, subscriber downgrade |
| `cleanup.ts` | daily 00:00 | pembersihan retensi (berkas yatim/R2, baris kedaluwarsa) dengan guard `ADMIN_CLEANUP_*` |
| `ktSnapshot.ts` | daily 03:30 | unggah snapshot KT terverifikasi terbaru ke R2 (retensi 30 hari, hanya bila `KT_SNAPSHOT_DIR` ada) |
| `pirSnapshot.ts` | daily 04:15 + every 3 minutes | bangun snapshot `User.oprfIndex`, tulis atomik ke `PIR_SNAPSHOT_PATH`, hot-swap sidecar lewat `/admin/rebuild` (butuh `PIR_ENABLED` + `PIR_ADMIN_TOKEN`); tick 3 menit memakai `refreshPirSnapshotIfDirty` sehingga hanya rebuild bila `pir:snapshot:gen` > `pir:snapshot:built` |

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
- Refresh replay classification (`utils/refreshReplay.ts`): dead family → 401 without alarm; direct-successor retry inside `REFRESH_REPLAY_GRACE_MS` (default 2 min) → benign continuation; genuine replay → family revocation + **device-scoped** `force_logout`.
- `RefreshToken` revoked rows are retained `REVOKED_REFRESH_TOKEN_RETENTION_MS` (7 d) so the `replacedById` chain survives for replay classification.

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
