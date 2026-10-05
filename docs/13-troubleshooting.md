# 13 — Troubleshooting

Known errors, their root causes, and fixes. Each entry was encountered in production or E2E at least once.

## Server

### `DriverAdapterError: DatabaseNotReachable`
The API cannot reach PostgreSQL (or the hostname doesn't resolve).
- Check `DATABASE_URL`/`DIRECT_URL` in `/root/nyx-app/server/.env` (prod) — remember deploys overwrite it from `/root/nyx-app/.env`.
- `pg_isready` on the VPS; DNS: `getent hosts <dbhost>`.
- After a DB outage, `pm2 restart nyx-api` re-establishes the pool.

### `TlsConnectionError: self-signed certificate`
The client is forcing TLS against local Postgres. `server/src/lib/prisma.ts` appends `sslmode=require` **only for non-local hosts** — if you see this against `127.0.0.1`, that guard regressed. Never add `sslmode=require` for localhost.

### `POST /api/auth/register → 500` (P2003 `RefreshToken_deviceId_fkey`)
Login/register attempted to create a refresh token with an empty/nonexistent `deviceId`. In `auth.ts:issueTokens`, refresh persistence is skipped when `!deviceId` (recovery flow). If this re-appears, check the device find/create logic in the login/recover routes.

### `POST /api/auth/login → 403 Invalid CSRF token`
CSRF state is keyed **per client** via the `x-nyx-installation-id` header. The client must send the exact same value on `/api/csrf-token` and every mutation. Mismatch sources: multiple tabs/browsers before the per-client keying fix, or a stale cached page. Hard reload usually clears it.

### Sweeper errors every minute (`messageSweeper`)
Usually a DB connectivity symptom (see above). If it's a query error, check `Message.expiresAt` index exists (`prisma db push` after schema changes).

## Frontend

### Lazy-loaded feature "blinks" (full-screen Suspense) on first use
Global modals (ContextMenu, CommandPalette, CallOverlay, UserInfoModal, …) and pages are `React.lazy` under a single `<Suspense fallback={<LoadingScreen/>}>`. Opening one before its chunk is fetched flashes the whole app. Mitigation: `lib/prefetch.ts` (`prefetchAppChunks`) preloads these chunks in the background after login/registration/bootstrap.

### Group shows "Unknown" / group messages disappear
Group metadata is encrypted at sender-key N=0; re-decrypting it after the ratchet advanced fails. Fix: the decrypted metadata is now persisted to the Shadow Vault on first success, so reloads reuse the cache instead of re-decrypting. If it still shows "Unknown", trigger `repairSecureSession` / a ghost sync to re-fetch the group key.

### Deleted conversation (burner / soft-delete) reappears after reload
`removeConversation`/`deleteConversation` used to clear only in-memory state or just messages — the `conversations` row stayed in IndexedDB. Both now also delete the conversation record from the Shadow Vault.

### CSP violation: "Missing 'unsafe-eval'" in `schemas-*.js`
Zod 4 JIT (`Function()`) executed — the jitless flag wasn't set before schemas were created. The flag is a **direct mutation** of `globalThis.__zod_globalConfig.jitless` in `packages/shared/src/schemas.ts` and `web/src/zodSetup.ts`. Do not switch to `zod.config()` (tree-shaken in prod — zod has `sideEffects: false`). Never re-add `'unsafe-eval'` to the nginx CSP.

### `i18next::translator: missingKey <lang> <ns> <key>`
A translation key exists in fewer than all four locales (`en/es/id/pt-BR`). Add it to all four files. `load: 'languageOnly'` means en-US resolves to `en` — if you see `failed parsing /locales/en-US/*.json`, the languageOnly option was removed.

### "New Device Detected" modal flashes briefly on the same device
During login, `hasRestoredKeys` is `false` (baseline) until key decryption finishes (~2–4s, Argon2). The `isUnlocking` flag in `store/auth.ts` suppresses the modal during that window, and `Login.tsx` auto-closes it when `hasRestoredKeys` becomes true. If it flashes again, check both guards are intact.

### Login loops back to `/login` or recovery modal re-appears
- `hasRestoredKeys` gates routing (ProtectedRoute). Don't add unconditional `navigate("/chat")` after login.
- The recovery modal re-opens unless dismissed per user (`dismissedRecoveryForUserId` in `Login.tsx`).

### `401 transport-ticket` spam after logout
The reconnect timer must skip when there's no access token (`connection.ts:scheduleReconnect`). If it returns, that guard regressed.

### `🔒 Pesan gagal didekripsi (Kunci kedaluwarsa)` on own messages
Own-message decrypt failures are converted to `waiting_for_key` (retryable) in `messagePipeline.ts` — never rendered as an error bubble. If an *incoming* message from others fails, it's a genuine session desync: check the session-key relay and `session:request_key` repair flow.

### `TextDecoder.decode: Decoding failed` during self-decrypt
The stored message key (`mk`) or the envelope does not match the ciphertext — typically a temp-id → server-id key migration issue after ack, or an old cached bundle. The DR fallback then runs; if it also fails, the message lands in `waiting_for_key`.

### Group: new member sees `waiting_for_key` → `[Key request timed out]` on old messages
Messages from eras **before the member joined** are permanently undecryptable —
that is forward secrecy working as designed (the member never possessed those
era keys; libsignal behaves the same). Since 2026-10-05 the unknown-era key
request runs once per chainId (`unknownEraKeyRequested` in
`web/src/utils/crypto.ts`), so the bubble rests after a single request cycle
instead of looping. If a message from the **current** era also fails, check
whether the era distribution actually reached the device (`GROUP_KEY` SYSTEM
rows in the message list / `storeReceivedSessionKey` logs) and whether the
prekey-bundle fetch quota (30/pair/day, fail-closed 429) was burned.

### Group metadata fails with `metadataKey era belum tersedia`
The metadata blob's `chainId` matched no receiver state (live or archived).
Usual causes: the era distribution never reached the device (see above), or a
stale persisted `METADATA_UPDATED` row regressed the store blob (fixed
2026-10-05 — stale blobs that fail to decrypt can no longer overwrite a
decrypted newer blob).

### Blank screen / "nf" when serving `dist/` locally
The SPA needs a fallback to `index.html` for unknown routes (nginx `try_files` in prod; a plain static server locally).

## WebTransport / sidecar

### "Opening handshake failed" in the browser
- Sidecar not running (check pm2 `nyx-sidecar` and UDP `:33333`).
- Dev: `VITE_TRANSPORT_CERT_HASH` in `web/.env` doesn't match the sidecar banner hash (the sidecar regenerates its cert periodically).
- Headless Chromium may lack WebTransport entirely — use full Chrome (`--project=chrome`) or a desktop browser.

### No realtime delivery, but REST works
- Sidecar lost its Redis subscription (`Successfully subscribed to nyx:downstream` in its log).
- Node↔sidecar channel names drift: `nyx:upstream:<op>` / `nyx:downstream`.
- The single-active-device check (redisBridge) blocking a second device by design.

## Auth / session (recent fixes)

### "Refresh token reuse detected" logs + random 401s on uploads/presigned
The refresh route rotates the `rt` cookie on every refresh. Two concurrent refreshes (multi-tab, or the burner `/drop` page alongside the main app) used to look like theft, revoking the whole family. Fixes:
- **Server** (`auth.ts`): a 5 s grace window treats a same-device, recently-rotated duplicate as a benign concurrent refresh and continues the chain instead of revoking.
- **Client** (`store/auth.ts` + `lib/refreshLock.ts`): `silentRefresh` is single-flight per tab and serialized across tabs (Web Locks API + localStorage fallback), and retries up to 3×.
- `bootstrap()` falls back to a direct `GET /api/users/me` before logging out when refresh fails transiently.
If you still see reuse logs on prod, the deploy is stale — confirm the latest `auth.ts` shipped.

### `⚠️ CSRF_SECRET not set` even though it's in `.env`
`config.ts` reads `CSRF_SECRET` and warns only when it's empty/whitespace **and** `NODE_ENV=production`. The prod env is copied from `/root/nyx-app/.env` over `server/.env` on deploy — set a non-empty `CSRF_SECRET` there (not just in `server/.env`). The config now trims the value, so `CSRF_SECRET=` (empty) is treated as unset.

### App logs out intermittently on open / refresh
- The `rt` cookie (30 d) may have been revoked earlier by a reuse false-positive (see above).
- `bootstrap` now retries `silentRefresh` and falls back to validating the still-valid `at` cookie before logging out.

### Biometric login then password login says "incorrect password"
Biometric unlock used to regenerate the key bundle with a random session key and overwrite the password-encrypted bundle in IndexedDB, breaking password login. Fixed: biometric unlock now loads keys **in memory only** and never touches `nyx_encrypted_keys`. Users whose bundle was already overwritten by the old bug need one recovery pass.

### "New Device Detected" flashes during biometric login
The biometric flow now sets `isUnlocking` during key restore, same as the password flow, so the recovery modal does not appear until keys settle.

### User's profile change doesn't propagate to other users' chatlist/header
`PUT /api/users/me` now broadcasts `user:updated` to every peer sharing a conversation (`UserHiddenConversation`), not just to the user themselves. Previously peers only saw the new profile after a fresh message arrived.

## Database / deploy

### Deploy succeeded but new behavior doesn't show
The PWA service worker caches bundles — do a hard reload (twice) or DevTools → Application → Service Workers → Update.

### `prisma db push` refuses to run
Prisma 7's AI guard requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` in the environment (or an interactive confirmation). CI and the VPS deploy script set it explicitly for their ephemeral/prod DBs.

### Backup restore
```bash
PASS=$(cat /root/.nyx_db_pass)
pg_restore -h 127.0.0.1 -U nyx -d nyx_app --clean --if-exists /root/backups/nyx_<date>.dump
```
Stop `nyx-api` during restore to avoid writes.
