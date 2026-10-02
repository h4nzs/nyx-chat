# AGENTS.md

NYX: zero-knowledge post-quantum messenger. pnpm monorepo: `web` (React 19 + Vite 8), `server` (Express 5 + Prisma 7 + Redis bridge), `marketing` (Astro), `packages/shared` (`@nyx/shared`), `server/transport-sidecar` (Rust WebTransport).

## Commands that matter

- **`@nyx/shared` is consumed from `dist/`** — after editing `packages/shared/src`, run `pnpm --filter @nyx/shared run build` BEFORE typechecking web/server or the changes are invisible.
- Build: `pnpm -r run build` (root) — runs web `tsc -b && vite build`, server `tsc`, marketing `astro build`.
- Unit tests: `pnpm -r --if-present run test`. Server = `node:test` via `tsx` (files listed explicitly in server `package.json`; jest config is dead, do not use). Web = vitest.
- Typecheck: `npx tsc --noEmit` per package. After `pnpm install` or dep updates, run `npx prisma generate` in `server/` first or server tsc fails with missing `PrismaClient` export.
- **ESLint is broken repo-wide** (typescript-eslint rejects TS 7.0). CI lint job is `continue-on-error` on purpose. Verify with `tsc --noEmit` + build instead; don't try to fix lint errors.
- E2E: `pnpm exec playwright test --project=chromium` in `web/`. Prereqs: Postgres + Redis running, server dev (`pnpm --filter nyx-server dev`), vite dev (`pnpm --filter nyx-web dev`). `workers: 1` (serial — suite is flaky in parallel). `e2e/global.setup.ts` wipes the local DB via `server/scripts/reset-test-env.ts`.
- Playwright config webServer uses pnpm filter names `nyx-server` / `nyx-web` (NOT `server`/`web`).

## WebTransport / transport.spec

- Rust sidecar: `cargo build --release` in `server/transport-sidecar`, run with `JWT_SECRET`, `REDIS_URL`, `TRANSPORT_PORT=33333`. It prints a cert hash at startup → paste into `web/.env` as `VITE_TRANSPORT_CERT_HASH` (dev pinning).
- `transport.spec.ts` / `chat.spec.ts` auto-skip when `WebTransport` is undefined (headless Chromium on this machine lacks it). Use Chrome full build (`--project=chrome`) in CI (`e2e-chrome` job builds + runs the sidecar and parses the cert hash).
- Sidecar ignores opcode `0x00` on uni-streams/datagrams (CHAFF); auth also uses `0x00` but over the bidi control stream. Rust hardcodes opcode numbers — sync with `packages/shared/src/transport.ts`.

## E2EE / crypto constraints (do not break)

- **Do not split** `web/src/workers/crypto.worker.ts`, `crypto-worker-proxy.ts`, or other crypto files (explicit maintainer rule); fix them in place only.
- Frozen formats: at-rest prefix `ENC1:` (keychainDb), XChaCha envelope `base64url(nonce(24)||ct)` (canonical worker ops `xchacha_seal`/`xchacha_open`), `ENCRYPT_DATA` JSON must keep `Array.from(...)` number arrays (JSON.stringify of Uint8Array silently breaks stored bundles), 8KB traffic-cover padding. Never change primitives/padding/protocol.
- Group chain keys / skipped keys / story keys are encrypted at-rest with masterSeed; migration runs on unlock via `saveDeviceAutoUnlockKey`.
- **Zod 4 must run jitless** (prod CSP has no `unsafe-eval`). Set it ONLY via direct mutation `globalThis.__zod_globalConfig.jitless = true` — using `zod.config()` gets tree-shaken in prod builds because zod declares `sideEffects: false`. Done in `packages/shared/src/schemas.ts` and `web/src/zodSetup.ts` (first import in main.tsx). Don't remove, and don't add `unsafe-eval` back to nginx CSP.
- Message pipeline lives in `web/src/lib/messagePipeline.ts` (extracted from the store). Own-message decrypt failures return `waiting_for_key`, never error bubbles.

## Server gotchas

- ESM TS with `.js` import specifiers (run with `tsx`). `utils/` holds shared helpers (`sessionUtils.ts`, `validate.ts` incl. `safeEqualStrings`).
- Prisma 7: `prisma db push` (no migrate flow) reads `DIRECT_URL || DATABASE_URL` via `prisma.config.ts`; pass `--url` explicitly if env isn't loaded. Prisma 7 refuses db push without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` env (AI guard) — set it in scripts/CI, ask a human first.
- `server/src/lib/prisma.ts` appends `sslmode=require` ONLY for non-local hosts — local Postgres must stay plaintext (self-signed snakeoil cert otherwise kills every query with `TlsConnectionError`). Do not regress this.
- Rate limiting uses atomic Lua INCR+EXPIRE (`redisBridge.ts` RATE_LIMIT_LUA, auth pow, sandbox newchat) — do not reintroduce incr-then-expire races.
- Single-active-device check runs per-opcode in `redisBridge.ts` (`isActiveDeviceAllowed`, 60s cache). CSRF server state is keyed per client via `x-nyx-installation-id` header (app.ts) — client `web/src/lib/api.ts` must send that header consistently (same value as `getPersistentInstallationId()`), or login/register break with 403.
- Redis pub/sub: `nyx:upstream:<opCode>` / `nyx:downstream`. Relay payloads must NOT duplicate `content` into a `ciphertext` field (`mappers.ts`).
- Group admin capability (RBAC): the server stores only `Conversation.adminSecretHash` (SHA-256 of the 256-bit `X-Admin-Token` header); guard = `requireAdminCapability` (`server/src/utils/adminCapability.ts`) on `PUT /:id/details`, `POST /:id/key-rotation`, `DELETE /:id/group`. **NULL hash = legacy bypass** (pre-RBAC groups keep working). `DELETE /:id/group` purges the group and answers 409 `MEMBERS_REMAIN` while delivery tokens still exist. New columns REQUIRE the `prisma db push` on the VPS to have run before new clients are rolled out.

## Frontend gotchas

- Single REST client: `web/src/lib/api.ts` (`api`, `authFetch`, `apiUpload`). `api-client.ts` was deleted — don't recreate.
- i18n: locales in `web/public/locales/{en,es,id,pt-BR}` (7 namespaces, `load: 'languageOnly'`). Every key must exist in ALL 4 languages or console spam shows `missingKey`; add new keys to all four.
- App.tsx: global modals are `React.lazy` + render-on-demand; Virtuoso `itemContent` reads messages via a ref (keep `messages` out of its deps — that caused mass re-renders).
- Login/new-device flow: `hasRestoredKeys` gates routing (ProtectedRoute). Never add unconditional `navigate("/chat")` after login — routing must follow `hasRestoredKeys` so the recovery modal isn't bypassed.
- `nukeProtocol.executeLocalWipe` must call `/api/auth/logout-all` first (HttpOnly cookies can't be cleared client-side).

## Deploy / ops

- Push to `main` triggers `deploy.yml`: CI builds everything + Rust sidecar, zips, SCP to VPS, on-VPS `pnpm install` + `prisma db push` (consent env, `|| true` — schema changes ship with every deploy, still verify the push didn't fail), pm2 restarts `nyx-api` / `nyx-sidecar`, and **overwrites `/root/nyx-app/server/.env` with `/root/nyx-app/.env`** — prod secrets live only on the VPS (`.env` files are gitignored; `.env.example` at root and `server/` are the templates).
- Prod DB is LOCAL Postgres on the VPS (`postgres://nyx:…@127.0.0.1:5432/nyx_app`); old Aiven host is dead. DB password is in `/root/.nyx_db_pass` (0600); daily backup cron dumps to `/root/backups/`.
- CI: `ci.yml` (build, unit, lint-nonblocking, `pnpm audit --prod`, e2e with Postgres/Redis services, `e2e-chrome` for WebTransport specs). Install always uses `--frozen-lockfile`; pnpm pinned via `packageManager: pnpm@11.4.0`.
- VPS (upgraded 2026-10): **4 core / 8GB RAM / 4GB swap**, `vm.swappiness=10`, Postgres re-tuned for the larger box (`shared_buffers=2GB`, `effective_cache_size=6GB`). Keep memory usage in mind when changing workers/queues — the upgrade buys margin for privacy features, not bloat (docs/26 §26.9).

## Testing notes

- E2E registration walks a fixed modal chain (Proof of Trust → Recovery → Secure Phrase → Verify Sequence ×2 close → System Init). Helpers are duplicated per spec file — that's the repo convention; keep them in sync.
- Registration/avatar assertions can be slow — use `expect.poll` / generous timeouts, not shorter ones.
- Unit tests must not require Postgres/Redis (server tests use fakes for Prisma clients).
