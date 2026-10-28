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

### `POST /api/pir/query → 403 Invalid CSRF token` (lewat OHTTP)
Amplop OHTTP **tidak membawa cookie**: relay membuang header klien, dan identitasnya token ber-scope di dalam amplop. Lapisan CSRF global (`server/src/app.ts`) melewati `/api/pir/query` hanya bila request tidak punya cookie sesi (`at`/`rt`/`embed_at`). Kalau 403 ini muncul, berarti ada cookie sesi yang ikut terkirim di dalam amplop (klien menambahkan `cookie` manual) atau pengecualian di `app.ts` hilang. Jangan melebarkan pengecualiannya ke path lain.

### `/api/pir/*` → 404 atau `503 PIR_UNAVAILABLE`
- 404 = `PIR_ENABLED` kosong; router memang tidak dipasang (bukan 403).
- 503 = `PIR_SERVICE_URL` salah atau sidecar mati: `curl -fsS http://127.0.0.1:9470/health`, `systemctl --user status nyx-pir-sidecar`.
- Sidecar hidup tetapi params menolak: snapshot kosong/tidak ada. `pnpm --filter nyx-server run pir:snapshot` **menolak 0 user ber-oprfIndex** — pastikan `PIR_OPRF_ENABLED=1` sejak akun didaftarkan, lalu jalankan ulang dan `systemctl --user restart nyx-pir-sidecar`.

### Pencarian user yang baru mendaftar tidak menemukan apa pun (PIR aktif)
Index PIR dibangun dari snapshot, bukan dibaca live dari DB. Akun baru/profil yang berubah menandai `pir:snapshot:gen` dan job interval (`*/3 * * * *`) membangun ulang, jadi normalnya terlihat ≤ 3 menit. Kalau lebih lama:

- cek `redis-cli get pir:snapshot:gen` vs `redis-cli get pir:snapshot:built` — sama berarti tick sudah jalan (atau penanda tak pernah naik karena Redis mati saat registrasi);
- cek log `[PIR] snapshot diperbarui (perubahan baru)`; `[PIR] status penanda tidak terbaca` berarti Redis tidak terhubung dan tick sengaja dilewati (cron 04:15 tetap jadi jaring);
- rebuild manual: `pnpm --filter nyx-server run pir:snapshot && systemctl --user restart nyx-pir-sidecar` (lalu samakan `pir:snapshot:built` bila perlu).

Klien sengaja **tidak** punya fallback diam-diam ke `/api/users/search` (`web/src/lib/userSearch.ts`).

### `/api/users/search/oprf → 503 PIR_OPRF_DISABLED`
`PIR_OPRF_ENABLED` kosong. Nyalakan di server **dan** `VITE_PIR_OPRF_ENABLED=1` di klien (bangun ulang web), lalu restart API. Seed OPRF default = `HMAC(NYX_AT_REST_PEPPER, "NYX_OPRF_SEED_V1")` — mengganti pepper/`NYX_OPRF_SEED` setelah ada akun membuat `oprfIndex` lama tidak cocok lagi.

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
The refresh route rotates the `rt` cookie on every refresh, so a duplicate presentation used to look like theft and revoked the whole family. Fixes (2026-10-18):
- **Server** (`utils/refreshReplay.ts` + `auth.ts`): replay is *classified*. A token whose family has **no live token left** (logout/revocation already happened) is answered with a plain 401 — no `session_hijacked` alarm and no broadcast. A token that is the **direct predecessor** of the live tip and was rotated within `REFRESH_REPLAY_GRACE_MS` (default 120 s) is treated as a benign retry (lost/slow response, frozen tab) and the chain continues. Anything else is a genuine replay → family revoked.
- **Server**: `force_logout` (reuse detection and `DELETE /api/sessions/:jti`) is **device-scoped** — payload carries `deviceId` and the event targets only that device.
- **Client** (`store/auth.ts` + `lib/refreshLock.ts`): `silentRefresh` is single-flight per tab and serialized across tabs (Web Locks API + localStorage fallback), retries up to 3×, and now reports whether the failure was **auth** (401/403) or **transient** (network/timeout/5xx).
- **Client** (`lib/api.ts` + `store/auth.ts`): only an *authoritative* refresh failure triggers the logout handler (which POSTs `/api/auth/logout` and therefore revokes the family). A transient failure keeps the session alive, and `bootstrap()` no longer wipes the local session when the failure looks transient.
- **Cleanup**: revoked `RefreshToken` rows are kept 7 days (`REVOKED_REFRESH_TOKEN_RETENTION_MS`) so the `replacedById` chain still exists for the classification above.
If you still see reuse logs on prod, the deploy is stale — confirm the latest `auth.ts` shipped.

### `⚠️ CSRF_SECRET not set` even though it's in `.env`
`config.ts` reads `CSRF_SECRET` and warns only when it's empty/whitespace **and** `NODE_ENV=production`. The prod env is copied from `/root/nyx-app/.env` over `server/.env` on deploy — set a non-empty `CSRF_SECRET` there (not just in `server/.env`). The config now trims the value, so `CSRF_SECRET=` (empty) is treated as unset.

### App logs out intermittently on open / refresh
- A transient refresh failure no longer triggers logout/revocation (see above): the session only ends on 401/403 from `/api/auth/refresh`.
- `bootstrap` still falls back to a direct `GET /api/users/me`, but keeps the local session when the failure is transient (offline/timeout/5xx) instead of clearing `user` + `localStorage`.
- Known limitation: if the app is opened while the network is down, `bootstrap` has no server-validated user yet and the route guard still shows `/login` until connectivity returns (local session is preserved, so no data is lost).
- If `/login?reason=revoked` still appears with no reuse log, check that the client build is current — an old bundle ignores the `deviceId` scope and logs out on any device's revocation.

### Biometric login then password login says "incorrect password"
Biometric unlock used to regenerate the key bundle with a random session key and overwrite the password-encrypted bundle in IndexedDB, breaking password login. Fixed: biometric unlock now loads keys **in memory only** and never touches `nyx_encrypted_keys`. Users whose bundle was already overwritten by the old bug need one recovery pass.

### "New Device Detected" flashes during biometric login
The biometric flow now sets `isUnlocking` during key restore, same as the password flow, so the recovery modal does not appear until keys settle.

### User's profile change doesn't propagate to other users' chatlist/header
`PUT /api/users/me` now broadcasts `user:updated` to every peer sharing a conversation (`UserHiddenConversation`), not just to the user themselves. Previously peers only saw the new profile after a fresh message arrived.

Client side, three things had to line up or the event was invisible in the chat list and story tray (bubble + user-info modal come from a different path):

- `updateParticipantDetails` matched participants by `p.id === user.id` only, so group-v2 pseudonyms were skipped, and it never persisted the result — the stale snapshot came back from ShadowVault on reload.
- `profileStore.getCacheOnly` fell back to the plain-id alias. Once a participant carried a new `encryptedProfile`, the alias (decrypted from the **old** blob) was returned as a "quick cache" and the new blob was never decrypted.
- Nothing refreshed the participant snapshot when the event was missed; `loadConversations` now takes `encryptedProfile` from the sender of the last message (the same source that keeps bubbles fresh), and incoming 1:1 messages refresh their sender's participant entry.

If a peer still shows an old avatar in a client after this release, hard-reload that client first — a cached PWA bundle runs the old code.

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
