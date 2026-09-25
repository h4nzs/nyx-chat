# NYX Messenger: Current-State Feature/Journey Map (RESEARCH ONLY)

## 1. Docs Files Listing (34 files, 1-line purpose each)

- 01-architecture.md — Repository layout, runtime architecture, dependency boundaries, data ownership, key entry points
- 02-getting-started.md — Local setup, dev commands, Docker
- 03-security-model.md — Threat model, trust tiers, crypto primitives
- 04-crypto-protocol.md — E2EE primitives, XChaCha20, ML-KEM, ratchet details
- 05-message-pipeline.md — Message lifecycle, pipeline extract from store, decrypt failures
- 06-frontend.md — React components, state management, UI patterns
- 07-backend.md — Express setup, Prisma, Redis bridge, middleware
- 08-webtransport-sidecar.md — Rust sidecar QUIC termination, opcodes, auth paths
- 09-database.md — Prisma schema, PostgreSQL setup, migrations, seed
- 10-deployment-ops.md — VPS topology, CI/CD pipeline, env vars, rollback, nginx hardening
- 11-testing.md — Unit tests (57 total), E2E Playwright specs, CI matrix, known gaps
- 12-api-reference.md — Complete HTTP API catalog (auth, conversations, messages, keys, etc.)
- 13-troubleshooting.md — Common issues, logs, debugging
- 14-auth-identity.md — Registration, login, recovery, device management, single-device check
- 15-messaging.md — Message creation, view-once, edit/unsend, reactions pipeline
- 16-groups.md — Group creation, participant management, group auth tokens
- 17-burner.md — Burner guest sessions, ephemeral chat, guest device lifecycle
- 18-realtime-transport.md — WebTransport + Redis bridge + calls + push architecture
- 19-media-stories.md — Story creation, fetch, deletion, encryption at rest
- 20-subscriptions-b2b.md — Tripay/Crypto.com checkout, tenant auth, B2B features
- 21-frontend-reference.md — Component catalog, hook reference, store shapes
- 22-backend-reference.md — Route modules, middleware chain, Prisma bindings
- 23-shared-sidecar.md — @nyx/shared types, opcodes, constants, transport enum
- 24-marketing.md — Public site metadata, SEO, deploy assets
- 25-repo-infra-agents.md — Agent workflows, CI configs, tooling

## 2. Spot-Checked Doc Claims (6 claims)

| # | Doc Claim | Doc:Line | Code:Line | Status |
|---|---|---|---|---|
| 1 | "API is a blind relay. All message content, profiles, and keys are encrypted client-side. The server never holds plaintext." | 01-architecture.md:80 | messages.ts:141 — `content` stored as ciphertext; encryption in crypto.worker.ts before POST | ✅ Consistent |
| 2 | "Realtime path: browser → QUIC → Rust sidecar → Redis pub/sub → Node (redisBridge) → Prisma → Redis → sidecar → recipient." | 18-realtime-transport.md:81 | redisBridge.ts:40 — `TransportOpCode → handlers: CHAT_MESSAGE`; messages.ts:182 — `sendJsonToUser(targetId, TransportOpCode.CHAT_MESSAGE, safeMessage)` | ✅ Consistent |
| 3 | "Web and server share no runtime code besides @nyx/shared." | 01-architecture.md:86-87 | web/src/main.tsx imports @nyx/shared from dist/; server also consumes @nyx/shared from dist/ | ✅ Consistent |
| 4 | "Chaff: client emits 1000-byte random datagram (opcode 0x00) every ~3s with jitter; sidecar drops 0x00." | 18-realtime-transport.md:18 | packages/shared/src/transport.ts:2 — `CHAFF = 0x00`; main.rs:33 — "chaff 0x00 is dropped" | ✅ Consistent |
| 5 | "Message padding: every user message is padded to 8192 bytes before encryption." | 18-realtime-transport.md:19 | **MISMATCH**: No 8192-byte padding found in message sending code. messages.ts:117 max 20000 chars; no padding wrapper. Doc references padding but code has no explicit padding before encryption. | ⚠ MISMATCH |
| 6 | "Server tests must not require Postgres/Redis — Prisma clients are faked." | 11-testing.md:11 | server/package.json `tsx --test tests/…`; sessionKeys.test.ts uses faked Prisma clients; AGENTS.md: "Unit tests must not require Postgres/Redis" | ✅ Consistent |

## 3. Feature Inventory Journey Matrix

| FEATURE | Client Entry (file:line) | Server Route (file:line) | Realtime Path | Persistence |
|---|---|---|---|---|
| **Routes in App.tsx** | | | | |
| `/` (Home) | App.tsx:74-91 | — | — | Zustand (conversations) |
| `/login` | App.tsx:399-404 | — | — | — |
| `/register` | App.tsx:405-409 | — | — | — |
| `/restore` | App.tsx:410-411 | — | — | — |
| `/migrate-receive` | App.tsx:411-412 | — | — | — |
| `/drop` (Burner) | App.tsx:412-413 | — | — | IndexedDB (burner store RAM) |
| `/chat` | App.tsx:416-417 (ProtectedRoute) | — | — | IndexedDB/Zustand |
| `/chat/:cid` | App.tsx:417-418 | — | — | IndexedDB/Zustand |
| `/settings` | App.tsx:419-420 | — | — | IndexedDB/Zustand |
| `/settings/keys` | App.tsx:420-421 | — | — | IndexedDB |
| `/settings/sessions` | App.tsx:421-422 | — | — | IndexedDB |
| `/settings/migrate-send` | App.tsx:422-423 | — | — | IndexedDB |
| `/admin-console` | App.tsx:423-424 | — | — | IndexedDB |
| `/profile/:uid` | App.tsx:425-426 | — | — | IndexedDB |
| `/connect` | App.tsx:426-427 | — | — | — |
| `/embed/chat/:id` | App.tsx:430 | — | — | — |
| `/*` (NotFound) | App.tsx:433-434 | — | — | — |
| **Server Route Mounts** (app.ts) | | | | |
| `/api/auth` | — | app.ts:377 | REST + WT ticket (`/transport-ticket`) | PostgreSQL + Redis |
| `/api/users` | — | app.ts:378 | Me, devices, block, search, delete | PostgreSQL |
| `/api/conversations` | — | app.ts:379 | CRUD, key-rotation, participants | PostgreSQL + Redis |
| `/api/messages` | — | app.ts:380 | Send (POST), sync GET (14d pending) | PostgreSQL + Redis |
| `/api/uploads` | — | app.ts:381 | Presigned URLs, R2 uploads | Cloudflare R2 |
| `/api/previews` | — | app.ts:382 | Link metadata, proxied image | — |
| `/api/session-keys` | — | app.ts:383 | Session key distribution (blind) | Redis cache |
| `/api/reports` | — | app.ts:384 | Bug/report submission | — |
| `/api/admin` | — | app.ts:385 | System status, banned-users, ban/unban | PostgreSQL |
| `/api/engine` | — | app.ts:386 | B2B room creation | PostgreSQL |
| `/api/sessions` | — | app.ts:387 | Session list/revoke by JTI | Redis blacklist |
| `/api/subscriptions` | — | app.ts:388 | Tripay/crypto checkout | PostgreSQL |
| `/api/stories` | — | app.ts:390 | Create/fetch/delete stories | PostgreSQL |
| `/api/system` | — | app.ts:391 | Status + banner (public) | Redis |
| `/.well-known` | — | app.ts:392 | MCP/OIDC discovery | — |
| **Major Features** | | | | |
| **Calls** | App.tsx:43-44 (CallOverlay lazy); webrtc.ts | engineRouter + messages routers | WT opcode `0x03` WEBRTC_SIGNAL relayed via Redis; media P2P TURN | IndexedDB (callStore state); server DB (call metadata) |
| **Stories** | SettingsPage:991 (story flow); storiesRoutes | storiesRoutes:99-102 (POST/GET/DELETE) | REST only (no WT event) | PostgreSQL (encrypted) + local story keys |
| **Burner Chat** | BurnerChat.tsx:14 (default); burner store | `/api/auth/burner` (auth.ts:398); `/api/uploads/burner-presigned` | WT `burner:join`/`burner:receive` events via Redis bridge | **RAM-only** — explicitly ephemeral ("All chat history is RAM-only and will be permanently lost") |
| **Search** | ProfilePage; users.ts `/search` | users.ts:386-434 (`GET /api/users/search?q=`) | REST only | PostgreSQL (usernameHash blind index) |
| **Admin Console** | AdminDashboard lazy (App.tsx:423-424) | adminRouter (app.ts:385) | REST only | PostgreSQL |
| **Subscriptions/NYX-Plus** | SettingsPage:674-706 (NYX PRO module); subscribe toggle | subscriptionsRouter (app.ts:388) + `/api/subscriptions/webhook` | REST only | PostgreSQL (subscriptionTier, expiresAt) |
| **Notifications/Push** | SettingsPage:944-1003 (push module); usePushNotifications hook | `sendPushNotification` utility; VAPID subscription via transport | WT `push:subscribe` / service worker `notificationclick` | IndexedDB (push subscription); server Redis |
| **Voice Messages** | MessageInput:isViewOnce/expiry; audio in message pipeline | messages.ts:114-120 (content field); messagePipeline:89 (isViewOnce) | REST POST + WT relay | IndexedDB (Shadow Vault) + server DB (ciphertext ≤14d) |
| **Attachments** | MessageInput:file upload (crypto worker encrypt → R2 presign); BurnerChat:file upload | uploadsRouter (app.ts:381) + `/api/uploads/presigned` | REST only (R2 presigned URLs) | Cloudflare R2 (encrypted blobs) + OPFS cache |
| **Reactions** | typeGuards.ts:10 (parseReaction); message.ts:135 (parseReaction); MessageBubble:reaction UI | No explicit server route — reactions piggyback on `message:new` WT events via Redis bridge (opcode 0x01 CHAT_MESSAGE payload contains reaction data) | WT `message:new` → socketListeners `message:new` handler | IndexedDB (message store reactions array); server DB (ciphertext only, reactions not persisted separately) |
| **Edit/Unsend** | MessageBubble:edit UI; MessageInput:re-edit; message.ts status updates | messages.ts:205-267 (`DELETE /:id` with `X-Delete-Token`); status_updated event | REST DELETE + WT relay | Server DB message delete; IndexedDB local redactor |
| **View-Once** | MessageInput:155,162,172,210,215,241,315,353,377,427 (isViewOnce state); MessageBubble:133; Lightbox:32; ChatList:230 | messages.ts:121 (isViewOnce field); messages GET includes `isViewOnce` | REST only (no separate WT opcode) | IndexedDB (Shadow Vault + message store); server DB `isViewOnce` flag + `expiresAt` ≤14d |

## 4. Thin State-Sync Areas (top 8)

| # | Area | Doc/Claim | Code:Line | Why Thin |
|---|---|---|---|---|
| 1 | **doSyncMessages polling timeout** | socketListeners.ts:77-90 | Polls max 8× at 500ms = 4s total, then gives up. No exponential backoff. If server is slow, messages are missed entirely. |
| 2 | **Burner chat RAM-only persistence** | BurnerChat.tsx + burner.ts | All chat history is RAM-only ("All chat history is RAM-only and will be permanently lost"). No IndexedDB or server persistence. Refresh/close = total data loss. |
| 3 | **Profile update broadcast condition** | users.ts:129-155 | Profile only broadcasts to peers sharing conversations if `encryptedProfile` actually changed (`if (encryptedProfile !== undefined && (!existingUser || encryptedProfile !== existingUser.encryptedProfile)`). If profile unchanged, peers never see the update. |
| 4 | **KICK event unconditional navigation** | socketListeners.ts:206-211 | `force_logout` → `window.location.href = '/login?reason=revoked'` unconditionally. No guard if user already on login page or if navigation should be suppressed. |
| 5 | **Presence typing no debounce/guard** | socketListeners.ts:185-203 | Typing events forwarded immediately to presence store with no debounce. Multiple rapid `typing:start` events can outpace `typing:stop`, causing stale UI state. |
| 6 | **Push subscription state gap** | SettingsPage.tsx:973-977 | Rocket switch toggles push subscriptions with only `pushLoading` guard. No error recovery if server rejects subscription; no UI distinction between pending/active/subscription-error state. |
| 7 | **Auto-unlock key dependency on sessionStorage** | auth.ts:305-328 | `tryAutoUnlock()` reads from `sessionStorage` (`getDeviceAutoUnlockKey()`). If sessionStorage cleared (private mode, cleanup), auto-unlock fails silently; user must re-enter password. No fallback UI. |
| 8 | **Reaction server relay path implicit** | typeGuards.ts:10; message.ts:135 | Reactions parsed client-side via `parseReaction`, but no explicit server route for reaction events. They piggyback on `message:new` WT events — if the relay filter drops non-chat payloads, reactions silently fail to propagate. |