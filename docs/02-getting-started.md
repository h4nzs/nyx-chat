# 02 — Getting Started (Development)

## 2.1 Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 | `engines` implied by CI/Docker |
| pnpm | 11.4.0 | Pinned via `packageManager` in root `package.json` |
| PostgreSQL | 16+ (17 used in prod) | Local dev: plaintext, no SSL (`sslmode` must NOT be forced — see below) |
| Redis | 6+ | Required even for tests that touch rate limiting |
| Rust / Cargo | stable | Only if you need the WebTransport sidecar |
| Playwright Chromium | — | `pnpm --filter nyx-web exec playwright install chromium` |

## 2.2 Initial setup

```bash
git clone https://github.com/h4nzs/nyx-chat.git
cd nyx-chat
pnpm install --frozen-lockfile

# 1. Build the shared package FIRST (web/server consume @nyx/shared from dist/)
pnpm --filter @nyx/shared run build

# 2. Generate the Prisma client (required before server typecheck/build)
cd server
npx prisma generate
# Create the schema (local dev DB). Prisma 7 refuses without explicit consent env:
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma db push

# 3. Environment files — copy the templates and fill values
#    Root .env.example contains BOTH server vars (top) and VITE_* web vars (bottom).
cp .env.example server/.env        # server keys: DATABASE_URL, REDIS_URL, JWT_SECRET, …
cp .env.example web/.env           # web keys: VITE_API_URL, VITE_TRANSPORT_*, …
```

## 2.3 Run the stack (three terminals)

```bash
# Terminal 1 — API
pnpm --filter nyx-server dev        # http://localhost:4000

# Terminal 2 — Web app
pnpm --filter nyx-web dev           # http://localhost:5173

# Terminal 3 — WebTransport sidecar (optional, required for realtime)
cd server/transport-sidecar && cargo build --release
JWT_SECRET=<same as server> REDIS_URL=redis://127.0.0.1:6379 TRANSPORT_PORT=33333 \
  ./target/release/transport-sidecar
# ⚠ The sidecar prints a cert hash at startup — copy it into web/.env:
#   VITE_TRANSPORT_CERT_HASH=<sha256 hex from the banner>
#   VITE_TRANSPORT_URL=http://localhost:33333
```

## 2.4 Daily commands

```bash
pnpm -r run build                      # build everything (shared → web → server → marketing)
pnpm -r --if-present run test          # unit tests (server: node:test via tsx; web: vitest)
npx tsc --noEmit                       # typecheck (run per package)
pnpm --filter nyx-web exec playwright test --project=chromium   # E2E (needs stack running)
```

### Command order that matters

1. **Edit `packages/shared/src/*` → rebuild shared → then typecheck/build web or server.** Changes are invisible otherwise.
2. **After `pnpm install` or dependency updates → `npx prisma generate` in `server/`** or server tsc fails with a missing `PrismaClient` export.
3. E2E global setup wipes your **local dev database and Redis** (`server/scripts/reset-test-env.ts`) — don't point dev at anything valuable.

## 2.5 Toolchain quirks

- **Lint = oxlint** (Rust; tidak terikat versi TypeScript), satu-satunya linter di repo. ESLint dihapus sepenuhnya 2026-10-15 (config + devDependency + direktif) karena `typescript-eslint` menolak TS 7.0 — jangan dihidupkan kembali. Jalankan `pnpm run lint`; rule level `error` dan kategori `correctness` **blocking** (harus 0 temuan), sisa `no-unused-vars` sengaja `warn`. Direktif penekan: `// oxlint-disable-next-line <rule>` tepat di atas baris kode yang disasar.
- **TypeScript is strict** in every package, including `noUncheckedIndexedAccess` (web, server, shared) — array/record indexing yields `T | undefined`.
- **Jest is dead** — server tests use `node:test` via `tsx` (files are listed explicitly in `server/package.json` `test` script).
- **Zod 4 must run jitless** (no `eval`) because prod CSP has no `unsafe-eval`. The flag is set by direct mutation of `globalThis.__zod_globalConfig.jitless` in `packages/shared/src/schemas.ts` and `web/src/zodSetup.ts` — never via `zod.config()` (it gets tree-shaken in production builds).
- Server code is ESM with **`.js` import specifiers** (e.g. `import x from './config.js'`) and runs through `tsx` — keep that convention.

## 2.6 Environment variables

See [10-deployment-ops.md](10-deployment-ops.md) for the full table. The minimum for local dev:

```env
# server/.env
DATABASE_URL=postgresql://user:pass@localhost:5432/nyx_app
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=<random ≥32 chars>
CSRF_SECRET=<random>
NODE_ENV=development

# web/.env
# Relatif (kosong) = origin sendiri lewat proxy Vite/nginx. Absolut hanya untuk
# dev yang menembak API langsung; bila aplikasi disajikan nginx, CSP
# `connect-src 'self'` memblokir localhost:4000 dan cookie terpecah antar-host.
VITE_API_URL=http://localhost:4000
VITE_TRANSPORT_URL=http://localhost:33333
VITE_TRANSPORT_CERT_HASH=<from sidecar banner>
```

## 2.7 First-run smoke test

1. Register two users (in two browser profiles) and exchange a message — confirms crypto + DB + transport.
2. If realtime receive fails: check the sidecar log is subscribed to `nyx:downstream`, the cert hash in `web/.env` matches the banner, and Redis is reachable from both processes.
3. Watch the browser console: `missingKey` spam means a translation key was added to one locale but not all four (`en/es/id/pt-BR`).
