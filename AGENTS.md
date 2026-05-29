# NYX Chat — Agent Guide

## Monorepo Layout (pnpm workspace)
```
nyx-chat/
├── web/              # PWA client (React 19 + Vite 8 + Tailwind v4)
├── server/           # Express + Socket.IO + Prisma + Redis
├── packages/shared/  # @nyx/shared — Zod schemas, socket types, constants
├── packages/nyx-sdk/ # @nyx-engine/sdk — embeddable SDK (separate consumer)
└── marketing/        # Landing page
```

## Prerequisites & Setup
- **Runtime:** Node.js 22+, pnpm, PostgreSQL, Redis
- **Environment:** Copy `.env.example` → `server/.env` + `web/.env`
- **Required env vars for server:** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGIN`
- **Required env vars for web:** `VITE_APP_SECRET` (for key encryption), `VITE_API_URL`
- **First-time setup order:** `pnpm install` → build `packages/shared` first → `cd server && npx prisma db push` → then you can run dev

## Build & Dev Commands
- `pnpm install` — installs everything (workspace-wide)
- Build order: `packages/shared` must be built **before** `web` or `server`
- `pnpm -r build` — builds all packages in dependency order
- **Server dev:** `cd server && pnpm dev` (tsx watch src/index.ts)
- **Web dev:** `cd web && pnpm dev` (Vite on :5173, proxies /api, /uploads, /socket.io to :4000)
- **Web preview:** `cd web && pnpm preview` (port 4173, same proxy config)
- **Server start:** `cd server && pnpm start` (node dist/index.js with 768MB heap limit)

## Testing
- **Web unit:** `cd web && npx vitest` (jsdom env, setup in `/web/src/SetupTests.ts`)
- **Web e2e:** `cd web && pnpm test:e2e` (Playwright)
- **Server tests:** `cd server && npx jest` (supertest available)
- No vitest config file — config is inside `vite.config.ts` under `test` key

## Lint & Typecheck
- **Lint:** `pnpm -r run lint` (ESLint v10 flat config per package)
- **Web lint:** `cd web && pnpm lint` (ESLint with typescript-eslint + react plugin)
- **Server lint:** `cd server && pnpm lint` (ESLint with typescript-eslint)
- **Lint rules:** `no-unused-vars` = warn (args prefixed `_` ignored), `no-explicit-any` = warn
- **Typecheck:** each package `tsc` with `--noEmit` as needed
- **Pre-commit:** `pnpm run build` must pass with zero warnings (except unused-var)

## Architecture Essentials

### Server (Express + Socket.IO)
- **Entry:** `server/src/index.ts` — async bootstrap: connect Redis first, then lazy-import app + socket + jobs
- **Port:** 4000
- **REST API:** Express routes under `/api/*` with per-prefix routers
- **Socket.IO:** Custom auth middleware (JWT from cookie `at` or `auth.token`), Redis adapter for clustering
- **Rate limiting (REST):** `server/src/middleware/rateLimiter.ts` — 4 Redis-backed limiters: general (300/15min), auth (20/hr), upload (20/hr), OTP (5/15min)
- **Rate limiting (Socket):** `server/src/socket.ts` function `checkRateLimit(userId, eventKey, limit, windowSec)` — Redis INCR+EXPIRE per event
- **Prisma:** PostgreSQL via `@prisma/adapter-pg` v7. Schema at `server/prisma/schema.prisma`. Run `npx prisma db push` to sync (not migrate in dev)
- **Redis:** Required at startup (server won't fully boot without it). Used for rate limiting, online presence, socket adapter, OTPK atomic fetch (SELECT FOR UPDATE SKIP LOCKED)

### Web Client (React 19 PWA)
- **Entry:** `web/src/main.tsx` — sets up Buffer polyfill, i18n, service worker, HelmetProvider
- **Routing:** React Router v7 in `web/src/App.tsx` with lazy-loaded pages
- **State:** Zustand v5 stores in `web/src/store/` — auth, conversation, message, keychain, connection, etc.
- **Path aliases (tsconfig + Vite):** `@/` → `src/`, `@components/`, `@store/`, `@utils/`, `@lib/`, `@pages/`, `@hooks/`
- **Crypto:** All heavy crypto runs in a Web Worker (`web/src/workers/crypto.worker.ts`). Main thread communicates via `web/src/lib/crypto-worker-proxy.ts`. Uses libsodium-wrappers + hash-wasm
- **IndexedDB:** Dexie.js for local message storage ("Shadow Vault")
- **Socket client:** `web/src/lib/socket.ts` — singleton with message batching (100ms buffer window), echo cancellation, SYSTEM message prioritization
- **PWA:** Custom service worker (`web/src/sw.ts`), injected via vite-plugin-pwa

### Packages
- **@nyx/shared:** Source of truth for Zod schemas, branded types (UserId, ConversationId), socket event interfaces, and constants. Must be built before web/server
- **@nyx-engine/sdk:** Embeddable SDK for external consumers. Separate build, deps: libsodium, socket.io-client, hash-wasm, idb, eventemitter3

### Crypto Architecture (E2EE)
- Mandatory post-quantum mode — no classical-only downgrade allowed
- **Key exchange:** PQX3DH (X25519 + ML-KEM-768 via X-Wing)
- **Message encryption:** XChaCha20-Poly1305 with sender key protocol (client-side fan-out)
- **Group keys:** Distributed via `messages:distribute_keys` socket event, persisted as SYSTEM messages with 7-day TTL
- **Identity:** Ed25519 signing keys. WebAuthn PRF + Argon2id for local vault binding
- **Proof-of-Humanity:** Sandbox mode (5 msgs/min unverified), VIP via WebAuthn or BLAKE2b PoW

### Key Server Routes (REST)
| Route | File | Notes |
|---|---|---|
| `/api/auth/*` | `routes/auth.ts` | register/logout/refresh/WebAuthn/PoW, uses `authLimiter` |
| `/api/keys/*` | `routes/keys.ts` | prekey bundles, OTPK (atomic DELETE RETURNING), bulk fetch, TURN creds |
| `/api/session-keys/*` | `routes/sessionKeys.ts` | get/ratchet session keys per-device |
| `/api/conversations/*` | `routes/conversations.ts` | CRUD + participant mgmt |
| `/api/messages/*` | `routes/messages.ts` | message retrieval |
| `/api/uploads/*` | `routes/uploads.ts` | multipart body parser (1mb limit) |
| `/api/engine/*` | `routes/engine.ts` | public engine routes (no CSRF) |

### CSRF & Security
- CSRF via `csrf-csrf` double-cookie pattern on all POST/PUT/DELETE except webhooks and `/api/engine/*`
- Webhook paths `/api/subscriptions/webhook`, `/api/subscriptions/nowpayments-webhook` also bypass CSRF
- Helmet CSP configured for Cloudflare Turnstile, R2, fonts, WASM
- Request timeout: 30s
- Body size limit: 1mb (except uploads which share same 1mb)

### Socket Events (Key)
Client→Server events with rate limits (in `server/src/socket.ts`):
| Event | Rate Limit |
|---|---|
| `conversation:join` | 10/60s |
| `typing:start` | 20/10s |
| `messages:distribute_keys` | 50/60s |
| `message:send` | 5/60s (sandbox, unverified) or 15/60s (FREE) or 50/60s (SUBSCRIBER) |
| `session:request_key` | 10/60s |
| `group:request_key` | 10/60s |
| `session:fulfill_response` | 30/60s |
| `group:fulfilled_key` | 30/60s |
| `session:request_missing` | 10/60s |
| `webrtc:secure_signal` | 20/60s |
| `migration:start` | 10/60s |
| `burner:send` | 10/60s (per socket.id) |

### Known Quirks
- **DO NOT** bump `libsodium-wrappers` unless adding new PQC primitives — backward compatibility is critical
- Server uses ESM (`"type": "module"`) with explicit `.js` extensions in all imports (TypeScript outputs `.js` paths)
- Socket.IO auth reads JWT from cookie `at` first, then `handshake.auth.token`
- `auth:request_linking_qr` and `migration:*` events are accessible WITHOUT auth (used by device linking flow)
- `burner:*` events are accessible to both authenticated and unauthenticated users
- Rate limit Redis keys format: `rate_limit:socket:{event}:{userId}` (socket) / `rl:{prefix}:{ipHash}` (REST)
- PoW challenge difficulty scales with request count (`difficulty = min(4 + count/2, 6)`)
- Online presence tracked via Redis SET `online_users` + per-user SET `user:{id}:sockets`
- Message batching on client: 100ms debounce window, SYSTEM messages processed before USER, 20ms yield every 5 messages

### Docker
- `docker-compose.yml` at root: postgres:18-alpine, redis:alpine, server (port 4000), web (port 3000)
- Server connects to `redis://redis:6379` inside Docker network
