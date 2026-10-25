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
| Message vault | XChaCha envelope derived from identity private key | `web/src/lib/shadowVaultDb.ts` |
| Profile | `encryptProfile` worker op (same canonical envelope) | `crypto.worker.ts` |
| Attachments | libsodium secretstream (header + chunks), key inside the E2EE message | `crypto.worker.ts` |
| Push payloads | `crypto_box_seal` per recipient device | `web/src/store/message.ts` |

## 3.3 Authentication & sessions

- **Registration/login:** Argon2id password hash (server), username blind-indexed with Argon2id **client-side** before leaving the device.
- **Tokens:** short-lived JWT access (15m) + rotating refresh (30d) in `HttpOnly` cookies. Refresh rotation keeps family replay-detection, but replay is classified before acting (`utils/refreshReplay.ts`): a family with no live token left is a plain 401, a direct-successor retry inside `REFRESH_REPLAY_GRACE_MS` (default 2 min) continues the chain, and only otherwise is the whole family revoked (JTIs blacklisted in Redis) with a **device-scoped** `force_logout`.
- **CSRF:** double-submit cookie, server state keyed **per client** via the `x-nyx-installation-id` header. The client MUST send it consistently (same value as `getPersistentInstallationId()`) or mutations fail with 403.
- **Single active device:** enforced server-side per-opcode (`redisBridge.isActiveDeviceAllowed`, 60s cache) and at sidecar AUTH. Migration mode (`is_migrating:<userId>`) temporarily allows two devices.

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
| REST `GET /api/messages/:conversationId` has no membership check | Opaque Mailbox design — the server doesn't know participants; ciphertext-only risk accepted |
| Sidecar caches JWT/device checks at session start | Per-message device validation happens in Node (redisBridge) instead |

## 3.8 Crypto code rules (frozen)

1. Do **not** split `crypto.worker.ts`, `crypto-worker-proxy.ts`, or related crypto files — fix in place.
2. Never change primitives, padding (8KB), or wire/storage formats (see 04-crypto-protocol.md).
3. Keep key material out of React state, localStorage (except documented biometric vault), and logs — `sanitizeErrorLog` scrubs base64/JSON before logging.
