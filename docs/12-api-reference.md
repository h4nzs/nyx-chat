# 12 — API Reference (complete catalog)

Base URL: `https://api.nyx-app.my.id/api`. All request bodies are JSON (limit 1MB; uploads 1MB). Cookies: `at` (access, 15m) and `rt` (refresh, 30d), HttpOnly. CSRF: header `CSRF-Token` for non-GET when cookies are used. Most routes require `requireAuth` (cookie or `Authorization: Bearer`).

Conventions: `:id` = CUID, keys are base64url, ciphertexts are opaque strings. Responses are JSON; errors use `{ "error": "..." }`.

---

## auth — `/api/auth`

| Method | Path | Auth | Body / Notes |
|---|---|---|---|
| POST | `/register` | public (authLimiter + Turnstile) | `{usernameHash, password, encryptedProfile, publicKey, pqPublicKey, signingKey, encryptedPrivateKeys, deviceName, turnstileToken}` + headers `X-Nyx-Fingerprint`, `X-Nyx-Installation-Id` → `{user, accessToken, deviceId}` |
| POST | `/login` | public (authLimiter) | `{usernameHash, password, publicKey?, pqPublicKey?, signingKey?, encryptedPrivateKey?, deviceName?, deviceId?}` + fingerprint/installation headers → `{user, accessToken, deviceId, encryptedPrivateKey?}` |
| POST | `/refresh` | cookie `rt` | Rotates tokens; reuse detection revokes the whole family → `{accessToken}` |
| POST | `/logout` | cookie | Revokes the refresh family, clears cookies |
| POST | `/logout-all` | requireAuth | Revokes all sessions of the user + Redis `active_device` |
| GET | `/recover/challenge` | public | Recovery challenge for an identifier |
| POST | `/recover` | public | Recovery with signature + new password |
| GET | `/webauthn/register/options` / POST `/webauthn/register/verify` | requireAuth | Passkey registration |
| GET | `/webauthn/login/options` / POST `/webauthn/login/verify` | public | Passkey login (returns `encryptedPrivateKey` when the device is recognized) |
| GET | `/pow/challenge` | requireAuth | PoW challenge for trust verification |
| POST | `/pow/verify` | requireAuth | Submit PoW solution → verified tier |
| GET | `/transport-ticket` | requireAuth | Short-lived ticket for WebTransport connect |
| POST | `/burner` | public | Create a burner guest session |

## users — `/api/users`

| Method | Path | Notes |
|---|---|---|
| GET | `/me` | Own profile (opaque encryptedProfile) |
| PUT | `/me` | Update `{encryptedProfile?, autoDestructDays?}` → returns updated user + emits `user:updated` |
| PUT | `/me/keys` | Update device public keys (invalidates key caches) |
| POST | `/me/complete-onboarding` | Set `hasCompletedOnboarding` |
| POST | `/me/logout` | Revoke own refresh token, clear cookies |
| DELETE | `/me` | Delete account (+ R2 files `{fileKeys}`) → KICK |
| GET | `/me/devices` | List own devices |
| DELETE | `/me/devices/:deviceId` | Remove a device |
| GET | `/me/blocked` | List blocked users |
| GET | `/search?q=<hash>` | Search by usernameHash (blind index) |
| GET | `/:id` | Public profile + latest device public keys (for safety numbers) |
| POST | `/:id/block` / DELETE `/:id/block` | Block / unblock |

## conversations — `/api/conversations`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create (1:1 or group). Sandbox: 3/day for unverified → `SANDBOX_LIMIT` |
| GET | `/sync?ids=…` | Fetch conversations (Opaque Mailbox) |
| GET | `/:id` | Single conversation |
| PUT | `/:id/details` | Update `{encryptedMetadata}` — requires `X-Group-Token` (blind auth) |
| POST | `/:id/participants` | Broadcast participant add intent (blind) |
| DELETE | `/:id/participants/:userId` | Broadcast participant remove intent |
| DELETE | `/:id/leave` | Leave group (blind token) |
| POST | `/:id/pin` | Pin/unpin conversation |
| POST | `/:id/key-rotation` | Request sender-key rotation |
| DELETE | `/:id` | Delete/hide conversation |

## messages — `/api/messages`

| Method | Path | Notes |
|---|---|---|
| GET | `/:conversationId?limit=250` | Pending store-and-forward messages (last 14 days) |
| POST | `/` | Send (blind relay): `{conversationId, content, sessionId?, tempId?, expiresIn?, isViewOnce?, targetRecipients? (≤500)}` |
| DELETE | `/:id` | Blind delete — header `X-Delete-Token` must match `deleteSecret` (constant-time); `?r2Key=` cleans the R2 blob |

## keys — `/api/keys`

| Method | Path | Notes |
|---|---|---|
| POST | `/prekey-bundle` | Upload own bundle (identity/pq/signing + signed prekeys + OTPK) — also carries `encryptedPrivateKeys?` to keep the server's device copy in sync ([temuan #2]) |
| GET | `/prekey-bundle/:userId` | Fetch a user's bundle (Redis-cached 1h) |
| POST | `/prekey-bundles` | Batch fetch (≤50 users) |
| POST | `/public-keys` | Batch public keys (≤50 users) |
| POST | `/upload-otpk` | Refill one-time prekeys |
| GET | `/count-otpk` | Remaining OTPK count |
| DELETE | `/otpk` | Reset OTPKs |
| GET | `/initial-session/:conversationId/:sessionId` | Initial session key for a conversation |
| GET | `/turn` | Cloudflare TURN credentials (WebRTC) |

## sessionKeys — `/api/session-keys`

| Method | Path | Notes |
|---|---|---|
| GET | `/:conversationId/devices/:deviceId` | Fetch relayed session keys |
| POST | `/:conversationId/ratchet` | Distribute ratchet key material (blind) |

## sessions — `/api/sessions`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List active sessions (UA-parsed) |
| DELETE | `/:jti` | Revoke a session — revokes the whole token family + Redis blacklist |

## stories — `/api/stories`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create story (encrypted payload, expiresAt) |
| GET | `/:id` | Fetch story |
| GET | `/user/:userId` | List a user's active stories |
| DELETE | `/:id` | Delete story |

## uploads — `/api/uploads`

| Method | Path | Notes |
|---|---|---|
| POST | `/presigned` | R2 presigned upload URL (uploadLimiter) |
| POST | `/burner-presigned` | Presigned upload for burner guests |
| POST | `/groups/:id/avatar` | Set group avatar URL |

## previews — `/api/previews`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Link preview metadata |
| GET | `/image` | Proxied image preview |

## subscriptions — `/api/subscriptions`

| Method | Path | Notes |
|---|---|---|
| POST | `/create-crypto-transaction` | NOWPayments transaction (requireAuth) |
| POST | `/nowpayments-webhook` | NOWPayments IPN (HMAC, constant-time) |

## engine — `/api/engine` (B2B, tenant auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/rooms` | Create an embeddable room (`requireTenantAuth`); returns room URL |

## admin — `/api/admin`

| Method | Path | Notes |
|---|---|---|
| GET | `/system-status` | VPS metrics (RAM/CPU/uptime) — `requireAuth` + `requireAdmin` |
| GET | `/banned-users` | List banned users |
| POST | `/ban` | Ban user (invalidates ban cache, KICKs) |
| POST | `/unban` | Unban (invalidates ban cache) |
| GET | `/tenants` | List tenants |
| POST | `/tenants` | Create tenant (apiKey) |
| PATCH | `/tenants/:id/toggle` | Toggle tenant active state |

## reports — `/api/reports`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Report a bug → Discord webhook |
| POST | `/user` | Report a user → Discord webhook |

## system — `/api/system`

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | System status + banner (public; reads Redis `nyx:system:status`) |

## wellKnown — `/.well-known`

| Method | Path | Notes |
|---|---|---|
| GET | `/api-catalog` | RFC 9727 linkset (API discovery) |
| GET | `/openid-configuration` | OIDC discovery doc |
| GET | `/oauth-authorization-server` | OAuth server metadata |
| GET | `/oauth-protected-resource` | Protected-resource metadata |
| GET | `/mcp/server-card.json` | MCP server card |
| GET | `/agent-skills/index.json` | AI-agent skill index |

## Misc

| Method | Path | Notes |
|---|---|---|
| GET | `/api/csrf-token` | Returns CSRF token (public) |
| GET | `/health` | `{"status":"ok bang"}` — no DB dependency |
