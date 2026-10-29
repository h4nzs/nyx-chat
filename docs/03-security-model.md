# 03 — Security Model

## 3.1 Threat model

NYX is built on the **"Trust No One" (TNO)** principle. The server is treated as a fully compromised, honest-but-curious observer (and sometimes actively malicious):

| Asset | Attacker can see | Attacker cannot |
|---|---|---|
| Message content | Nothing (XChaCha20-Poly1305 ciphertext, 8KB traffic-cover padded) | Decrypt without end-device keys |
| Identities | Only `usernameHash` (client-side Argon2id blind index) | Reverse the hash |
| Social graph | Conversation IDs, participant *IDs* supplied explicitly by clients (Opaque Mailbox) | Names, avatars, profiles |
| Metadata | Timestamps, sizes, connection times | Who is chatting (beyond explicit routing hints) |

Non-goals (documented decisions): the server does not hide *message timing* against a network observer at scale — chaffing provides idle-period traffic cover, and real messages are sent immediately (see 05-message-pipeline.md).

## 3.2 Layer map

```mermaid
flowchart LR
    subgraph End device
        A[Argon2id KEK 128MB] --> B[Encrypted private keys<br/>ENCRYPT_DATA format]
        B --> C[PQX3DH handshake]
        C --> D[Double Ratchet / PQ-DR / Sender-Key]
        D --> E[XChaCha20-Poly1305 envelope<br/>b64url nonce24||ct]
        E --> F[Traffic-cover padding 8KB]
    end
    F --> G[WebTransport QUIC / REST]
    G --> H[Blind relay: Redis + Prisma]
    H --> G
```

| Layer | Mechanism | Key file |
|---|---|---|
| Key storage at rest | `ENC1:` masterSeed-encrypted envelope (ratchet states, chain keys, skipped keys, story keys) | `web/src/lib/keychainDb.ts`, `shadowVaultDb.ts` |
| Message vault (structural fields) | `ENC1:` masterSeed-encrypted envelope (`sealLocal*`); XChaCha20-Poly1305 under a **different key path** — not the canonical `xchacha_seal` envelope | `web/src/lib/shadowVaultDb.ts`, `localAtRest.ts`, `keychainDb.ts` |
| Profile | `encryptProfile` worker op (same canonical envelope) | `crypto.worker.ts` |
| Attachments | libsodium secretstream (header + chunks), key inside the E2EE message | `crypto.worker.ts` |
| Push payloads | `pq_box_seal_v2` (X-Wing, magic `NYS2`) per recipient device via `sealForDevice`; a device without a PQ key gets **no** payload | `web/src/store/message.ts`, `web/src/lib/pqBoxSeal.ts` |

## 3.3 Authentication & sessions

- **Registration/login:** Argon2id password hash (server), username blind-indexed with Argon2id **client-side** before leaving the device.
- **Tokens:** short-lived JWT access (15m) + rotating refresh (30d) in `HttpOnly` cookies. Refresh rotation keeps family replay-detection, but replay is classified before acting (`utils/refreshReplay.ts`): a family with no live token left is a plain 401, a direct-successor retry inside `REFRESH_REPLAY_GRACE_MS` (default 2 min) continues the chain, and only otherwise is the whole family revoked (JTIs blacklisted in Redis) with a **device-scoped** `force_logout`.
- **CSRF:** double-submit cookie, server state keyed **per client** via the `x-nyx-installation-id` header. The client MUST send it consistently (same value as `getPersistentInstallationId()`) or mutations fail with 403.
- **Single active device:** enforced server-side per-opcode (`redisBridge.isActiveDeviceAllowed`, 60s cache) and at sidecar AUTH. There is **no** temporary two-device window: the `is_migrating` bypass was removed on 2026-10-29 together with the QR vault transfer. A new device gets its history from a `.nyxbak` backup or, after `/link`, from the one-time archive in `docs/40` — never from a live second session.

## 3.4 Hardware binding

Every device row stores `fingerprint` (browser signals, SHA-256) and `installationId` (IndexedDB-anchored). On login:

- Key-carrying login (device has local keys) → device is matched by `deviceId`/public key and updated.
- Key-less login (fresh browser) → matched by `deviceId`; if fingerprint mismatches, the **installationId anchor** is the fallback tolerance; if both mismatch, the login is forced into the recovery flow.

## 3.5 Rate limiting & anti-abuse

- Global/auth/upload/OTP limiters via `express-rate-limit` + RedisStore. Keying IP memakai `cfAwareClientIp()` (`server/src/utils/clientIp.ts`): **`CF-Connecting-IP` didahulukan**, `req.ip` hanya cadangan — edge Cloudflare selalu menimpanya, dan API hanya bisa dijangkau lewat tunnel (Express bind loopback), jadi header itu tidak bisa diisi klien. Alasan lengkap, verifikasi, dan syarat topologinya: `docs/10` §10.10 Step 6 — jangan menukar urutannya tanpa membaca bagian itu (`X-Forwarded-For` di depan bisa dipalsukan).
- Socket-level events use an **atomic Lua INCR+EXPIRE** (`redisBridge.RATE_LIMIT_LUA`) — never a separate INCR then EXPIRE (race = permanent limit).
- Sandbox for unverified users: 3 new chats/day (same atomic pattern).
- PoW: client-side BLAKE2b/Argon2id puzzle (`/api/auth/pow/*`), Turnstile for registration (with 5s timeout on verify).

## 3.6 Panic & wipe

- **Panic password:** a second Argon2id hash stored locally; entering it on the login screen triggers `executeLocalWipe()` — which first calls `POST /api/auth/logout-all` (HttpOnly cookies cannot be cleared client-side), then wipes IndexedDB, OPFS, blob cache, cookies, and service workers.
- **Emergency eject / account deletion:** same wipe path; server-side revocation happens before local wipe.

## 3.7 Deliberate trade-offs (do not "fix" without a decision)

| Item | Trade-off |
|---|---|
| Biometric unlock stores the recovery phrase in localStorage under a WebAuthn-PRF-derived key | Convenience vs blast radius — accepted by maintainer |
| `'wasm-unsafe-eval'` and `'unsafe-inline'` remain in CSP | Required for libsodium WASM and inline scripts; `'unsafe-eval'` was removed |
| REST `GET /api/messages/:conversationId` has no membership check | Opaque Mailbox design — the server doesn't know participants; ciphertext-only risk accepted (§3.7.1 D2) |
| Mailbox `tag` is visible to the server | Needed so a fulfiller can find its own envelope; server can match a presented token to an item, but not to an account (§3.7.1 D3) |
| Sidecar caches JWT/device checks at session start | Per-message device validation happens in Node (redisBridge) instead |

### 3.7.1 Explicit limits of the Opaque Mailbox (D2, D3)

These are the two places where "the server cannot see the social graph" is
deliberately weaker than the headline claim. They are **accepted trade-offs,
not bugs** — treat any change here as a protocol decision, not a refactor.

**D2 — reading pending messages requires authentication, not membership.**
`GET /api/messages/:conversationId` (`server/src/routes/messages.ts:30,46`) runs
`requireAuth` but has **no participant check**: the server holds no membership
list it could consult without rebuilding the graph it is trying not to hold.
Any authenticated caller who knows (or guesses) a conversation CUID can read that
conversation's **pending** rows: ciphertext, timestamps, sizes, and whatever
routing hints the client itself supplied.

What still limits the exposure, and why the risk is accepted:

- content is unreadable without end-device keys (E2EE), and every payload is
  padded to 8 KB so size does not track message length;
- only the store-and-forward window is readable (14 days, enforced on the
  query and by the cleanup job — there is no unbounded history endpoint);
- conversation IDs are CUIDs and no endpoint enumerates them, so "guessing"
  requires the ID to leak from elsewhere;
- receipts/status rows store conversation-scoped tags, not user IDs, so the
  response does not reveal who is in the conversation.

What is explicitly **not** claimed: "only members can fetch a conversation's
messages". Enforcing that needs a membership proof at fetch time (e.g. a
delivery/membership token, `docs/16` §16.5, `docs/37` §37.3) — a product
decision, not a bug fix.

**D3 — a mailbox `tag` links one item to one token, not to a person.**
`GroupMailboxItem.tag = base64url(HMAC-SHA256(memberToken, "nyx-mailbox-v1"))`
(`server/src/utils/groupMailbox.ts`). When a client pulls, the server can
compute that HMAC from the presented token and see which items are addressed to
it — for that pull. It cannot reverse a tag into a user (raw member tokens are
never stored; only their SHA-256 sits in `UserHiddenConversation.tokenHash`), and
it cannot build a requester→fulfiller graph because mailbox rows carry no sender
column. Residual: one token used repeatedly lets the server group the items that
single token read; there is no account link, and post/pull run `anonymous: true`
(no cookie, CSRF, or installation ID). Details: `docs/37` §37.3.2.

## 3.8 Crypto code rules (frozen)

1. Do **not** split `crypto.worker.ts`, `crypto-worker-proxy.ts`, or related crypto files — fix in place.
2. Never change primitives, padding (8KB), or wire/storage formats (see 04-crypto-protocol.md).
3. Keep key material out of React state, localStorage (except documented biometric vault), and logs — `sanitizeErrorLog` scrubs base64/JSON before logging.
