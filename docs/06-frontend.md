# 06 — Frontend (Web App)

## 6.1 Tech stack

React 19, Vite 8, TypeScript (strict + `noUncheckedIndexedAccess`), Zustand v5, Tailwind v4, react-router v7, react-i18next, react-virtuoso, libsodium-wrappers (WASM, in a Web Worker), vite-plugin-pwa.

## 6.2 Boot sequence

1. `main.tsx`: `import './zodSetup'` (Zod jitless — must stay first) → i18n init → **wait for i18n `initialized` before rendering** (prevents transient missingKey warnings) → render `<App/>` → `registerServiceWorker()`.
2. `App.tsx`: `bootstrap()` (silent refresh) → routes; global modals are `React.lazy` + render-on-demand via store flags.

## 6.3 State — 21 Zustand stores

| Store | Responsibility |
|---|---|
| `auth.ts` | User, tokens, key unlock (`hasRestoredKeys`, `isUnlocking`), login/register/recover, auto-unlock, panic handling |
| `message.ts` | Message state per conversation, send/receive, optimistic updates, reactions, selection, offline queue |
| `conversation.ts` | Conversation list, participants, metadata, sync |
| `messageInput.ts` | Composer state: staged files, expiring, view-once, reply, edit, link preview |
| `presence.ts` | Online users, typing indicators |
| `connection.ts` | Transport status, my devices, reconnect scheduling |
| `profile.ts` | Decrypted profile cache (keyed `<userId>_<hash32>`) |
| `keychain.ts` | Keychain revision counter (invalidates cached keys) |
| `burner.ts` | Burner chat sessions |
| `story.ts` | Stories state |
| `notification.ts` | Push/notification prefs |
| `settings.ts` | User settings (persisted) |
| `theme.ts` | Theme/accent (persisted) |
| `modal.ts` | Global modal flags (confirm, profile, password prompt, chat info) |
| `callStore.ts` | WebRTC call state |
| `commandPalette.ts` | Command palette |
| `contextMenu.ts` | Right-click menu state |
| `dynamicIsland.ts` | Activity notifications |
| `messageSearch.ts` | Message search |
| `verification.ts` | Safety-number verification status |
| `systemStore.ts` | System status/maintenance banner |

Rules: prefer granular selectors (`useShallow`), never call `set()` in loops (batch instead), and keep `messages` out of Virtuoso `itemContent` deps (reads via latest-value ref).

## 6.4 Rendering hot path

- Message list: `react-virtuoso` + `memo(MessageItem)` / `memo(MessageBubble)` / `memo(MarkdownMessage)`. Row identity via `computeItemKey` (temp vs server id).
- Profile enrichment is O(n+m) via a userId map — don't reintroduce per-message `Object.keys().find()`.
- Decryption happens once per message (worker round-trip), results persist to the Shadow Vault — UI re-renders reuse stored plaintext.

## 6.5 Storage layer

| Store | Purpose |
|---|---|
| `NyxUnifiedDB` (Dexie, `db.ts`) | Messages vault, keychain tables, story keys, offline queue, profile cache |
| OPFS (`opfsStorage.ts`) | Encrypted attachment cache (500MB LRU) |
| `blobCache.ts` (RAM) | Decrypted `blob:` URLs for media rendering |
| `sessionStorage` | Auto-unlock key (session-only — deliberately NOT persisted to IDB) |
| `localStorage` | `user`, `deviceId`, settings, biometric vault (documented trade-off) |

Keychain writes go through a global write queue (`enqueueWrite` in `keychainDb.ts`).

### Lazy-chunk & modal Suspense pattern

**Boundary layout (jangan disatukan lagi).** Pages are `React.lazy` under one `<Suspense fallback={<LoadingScreen/>}>` that wraps ONLY the routes tree. Each global modal (ConfirmModal, UserInfoModal, PasswordPromptModal, ChatInfoModal, DynamicIsland, CommandPalette, ContextMenu, CallOverlay, SystemInitModal) gets its OWN `<Suspense fallback={null}>` boundary (the `ModalSuspense` helper in `App.tsx`).

**Why:** with a single shared boundary, opening any modal whose chunk wasn't loaded yet replaced the ENTIRE app (routes included) with the full-screen LoadingScreen — the user saw a blink "like a DOM refresh" (first right-click → ContextMenu was the visible case). With per-modal boundaries, a suspending modal never disturbs the surrounding app; only that modal is briefly absent.

**Preload (dua lapis):**
- `utils/modalPreload.ts` (`preloadOnIdle`) — warms all 9 modal chunks on idle (`requestIdleCallback`, 3s timeout, sequential queue) so in the normal path Suspense never suspends at all.
- `lib/prefetch.ts` (`prefetchAppChunks`) — warms pages + modal + utility chunks (fileUtils, webrtc, opfsStorage, biometricUnlock, html5-qrcode, dompurify) in staggered batches after login/registration/bootstrap.

Both fail silently on error and degrade to plain on-demand loading. When adding a new global modal: add it to `App.tsx` (lazy import + its own `ModalSuspense` + entry in the `preloadOnIdle` list) and to `lib/prefetch.ts`'s `MODALS`. Never render a global modal inside the routes-level Suspense boundary.

## 6.6 i18n

- Locales: `public/locales/{en,es,id,pt-BR}`, 7 runtime namespaces: `common, auth, errors, chat, settings, modals, admin`.
- Config (`i18n.ts`): `load: 'languageOnly'` (en-US → en), `fallbackLng: 'en'`, `react.useSuspense: false`.
- **Adding a key requires adding it to all four languages** — otherwise the console spams `missingKey`.
- Extra locale files (`help.json`, `landing.json`, `privacy.json`) belong to the marketing site flow and are not loaded by the app.

## 6.7 PWA / Service worker

- `vite-plugin-pwa` (injectManifest) + `web/src/sw.ts` — precache only. **No `/api` runtime caching** (privacy-first, by design).
- Push notifications show generic content; E2EE decryption happens app-side.

## 6.8 Key components worth knowing

- `MessageInput.tsx` — composer with voice recording (anonymization DSP), file staging, expiring/view-once, link preview, silent menu.
- `ChatWindow.tsx` — Virtuoso list, mark-as-read ACK batching, typing protocol, bulk delete.
- `Login.tsx` — password/biometric login, panic password check, recovery-options modal (auto-opens only after login state settles — `isUnlocking` guard).
- `SystemInitModal.tsx` — onboarding chain: Proof of Trust → Recovery phrase → Verify sequence → System init.
- `nukeProtocol.ts` — local wipe (server logout first, then IDB/OPFS/blob/cookies/SW).

## 6.9 Environment (client)

| Var | Purpose |
|---|---|
| `VITE_API_URL` | REST API origin (dev: `http://localhost:4000`) |
| `VITE_TRANSPORT_URL` | WebTransport origin (dev: `http://localhost:33333`) |
| `VITE_TRANSPORT_CERT_HASH` | SHA-256 pin for the sidecar cert (dev) |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |
| `VITE_VAPID_PUBLIC_KEY` | Web Push VAPID |
| `INDEXNOW_API_KEY` | Post-build SEO ping (optional) |

> **Full module catalog:** see [21-frontend-reference.md](21-frontend-reference.md) for the complete inventory of stores, libs, pages, components, workers, hooks, and utils.
