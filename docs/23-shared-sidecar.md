# 23 — Shared Package & Rust Sidecar Reference

## 23.1 `packages/shared` (`@nyx/shared`)

Consumed from `dist/` — after editing `packages/shared/src`, run `pnpm --filter @nyx/shared run build` before typechecking web/server (the changes are otherwise invisible).

### `brands.ts`
Branded nominal types (`UserId`, `ConversationId`, `MessageId`, `StoryId`) + cast helpers `asUserId` / `asConversationId` / `asMessageId` / `asStoryId`. Used everywhere to prevent id-type confusion.

### `constants.ts`
- `LIMITS` — per-tier rate/group/upload limits (UNVERIFIED 5 msg/min & 0 groups & no uploads; FREE 15 / 100 members / 100 MB; SUBSCRIBER 50 / 500 / 500 MB; avatar 5 MB).
- `enum SubscriptionTier { FREE, SUBSCRIBER }`.

### `schemas.ts` (271 L)
- **Zod jitless bootstrap:** `globalThis.__zod_globalConfig.jitless = true` (direct mutation — `zod.config()` is tree-shaken). Must stay.
- Branded id schemas, `EncryptionModeEnum` (`SENDER_KEY | PQ_DR | SPQR`), `MinimalUserSchema`, `ParticipantSchema`, `ConversationSchema` (recursive `lastMessage`), `ConversationUiSchema`.
- `MessageSendPayloadSchema` (client send), `IncomingMessageSchema` (safe date preprocessing + `.passthrough()`), `RawServerMessageSchema` (recursive `repliedTo`), `ShadowVaultMessageSchema`, `WebRTCSignalingSchema`, `DistributeKeysPayloadSchema`, `KeyRequest/GroupKeyRequest/KeyFulfillment/PushSubscribe` payload schemas.

### `socket.ts` (191 L)
- `ServerToClientEvents` (~40): message/conversation/user/session/group events, `force_logout`, `auth:banned`, `webrtc:secure_signal`, `migration:*`, `burner:receive/terminated`, `subscription_updated`, …
- `ClientToServerEvents` (~25): presence, `message:send`, session/group keys, push, webrtc, migration, `message:unsend`, `message:view_once_opened`, `burner:*`, …
- Payload interfaces (`TypingPayload`, `MessageSendPayload`, `MarkAsReadPayload`, …).

### `transport.ts` (33 L)
- `enum TransportOpCode`: `CHAFF=0x00, CHAT_MESSAGE=0x01, KEY_SYNC=0x02, WEBRTC_SIGNAL=0x03, WEBRTC_ICE=0x04, PRESENCE=0x05, ACK=0x06, KICK=0x07, HANDSHAKE=0x0A`.
- `BinaryPayload`, `WebRtcSignalPayload`, `TransportWorkerToMain`/`MainToTransportWorker` worker messages.

### `types.ts` (232 L)
`User`, `ProfileUser`, `Message`, `Participant`, `Conversation`/`ConversationUi` (with `decryptedMetadata`), `Story`, `EncryptedPayload`, `AuthJwtPayload`, `DoubleRatchetState`, `ISignedPreKey`, `IOneTimePreKey`, `IPreKeyBundle`, `SystemMessagePayload` + group-key payloads.

### `index.ts` — re-exports everything.

## 23.2 Rust transport sidecar (`server/transport-sidecar/`)

Lib + binaries on `wtransport 0.7` + `rcgen`, `tokio`, `redis`, `jsonwebtoken`, `dashmap`, `serde`, `data-encoding`, `uuid`, `time`, `url`.

| File | Role |
|---|---|
| `src/main.rs` | I/O only: endpoint/TLS, auth, session map, kick, the four reader loops |
| `src/protocol.rs` | **pure** protocol: opcode + HELLO constants, `parse_transport_hello`, `negotiate_capabilities`, `hello_reply_frame/payload`, `classify_inbound`, `parse_inbound_frame`, `reference_forward` |
| `src/fuzz.rs` | deterministic campaign (xorshift64) over framing + HELLO, incl. differential check |
| `src/bin/fuzz-framing.rs` | runner: `NYX_FUZZ_SECONDS` / `NYX_FUZZ_ITERS` / `NYX_FUZZ_SEED`, exit 1 on finding |
| `src/metrics.rs` | `nyx_transport_*` counters/gauges + Prometheus 0.0.4 text exposition on a **loopback** listener (`TRANSPORT_METRICS_ADDR`, default `127.0.0.1:9465`; non-loopback is rejected at startup, `0` = off) |

### Startup
1. **TLS cert**: prod → `PROD_CERT_PATH`/`PROD_KEY_PATH`; dev → persistent self-signed DER (`transport_cert.der`/`transport_key.der`), SAN localhost/127.0.0.1, 10-day validity. Prints the **SHA-256 cert hash** → paste into `web/.env` as `VITE_TRANSPORT_CERT_HASH`.
2. Bind `0.0.0.0:TRANSPORT_PORT` (default 33333, UDP).
3. Subscribe `nyx:downstream` (reconnect loop 3 s); frames `[op|len(4 BE)|payload]`; `0x07` KICK → `conn.close(1000, "Kicked by server")`; route by `user:device:` prefix or broadcast `user:`.

### Auth (two paths)
1. **URL ticket** `?ticket=` (HS256 JWT, 15 s exp).
2. **Bidi AUTH frame** `[0x00][len][token]` (≤4096 bytes) → verify JWT → `id|sub` + `deviceId`.

### `handle_connection`
- **Single active device:** scan `user:` sessions in the `DashMap<String, Arc<Connection>>` → kick old ("Logged in on another device"); insert `{user}:{device}:{uuid}`.
- Three reader loops: **bidi** (drop `0x00` chaff; max 32 KB; `0x0A` → ACK `[0x06,0,0,0,0]`; `0x0B` HELLO → capability reply, never forwarded), **uni-stream**, **datagram** — each publishes to `nyx:upstream:<opcode>` via `protocol::parse_inbound_frame` (chaff/HELLO/truncated are never forwarded).
- On `conn.closed()`: remove session + publish opcode `99` (disconnect) for Node cleanup.

### Hardcoded opcodes (must stay in sync with `packages/shared/src/transport.ts`)
`0x00` (chaff/ignore), `0x0A` (handshake + ACK), `0x07` (KICK), `99` (disconnect). All other opcodes are passed through opaquely.

### Metrics (`src/metrics.rs`, scrape job `nyx-sidecar`)
Why it exists: a sidecar that cannot be reached is **invisible** — clients silently
fall back to WSS (`web/src/lib/transportMode.ts`), so there is no error anywhere to
notice, only worse latency. `METRIC_DEFS` declares every `nyx_transport_*` family
up front (`docs/30` WS-G(6)); label values come from fixed enums (`ConnectionOutcome`,
`AuthMethod`, `AuthFailure`, `RejectReason`, `Path`, `DownstreamOutcome`,
`Direction`), so unlike the TS exporter there is no free-form label to validate —
identity-shaped values cannot get in by construction. A useful side effect: the
renderer walks the full enum lists, so every label child exists (at 0) from the
first scrape — `increase()` stays meaningful across restarts, which is exactly what
`prom-client` on the API side cannot promise.

`reason="chaff"` on `nyx_transport_rejected_frames_total` counts opcode `0x00`
(traffic cover) and is deliberately excluded from the malformed-frame alert:
chaff is normal and often far noisier than real traffic.

`HISTOGRAM_DEFS` carries the one histogram: `nyx_transport_ingress_seconds`, from
a complete client frame being received to Redis accepting it on
`nyx:upstream:<opcode>`. It is the only ingress hop the sidecar actually owns —
the work Node does (rate limit, device check, DB, fan-out) happens *after* it, and
the WSS path measures that same span separately as `nyx_wss_ingress_seconds`
(`server/src/utils/transportLatency.ts`). The two are compared by an alert, so the
bucket boundaries must stay identical on both sides (`INGRESS_BUCKETS` here ↔
`WSS_INGRESS_SECONDS` in `metrics.ts`); two histograms with different buckets
yield p95 values that cannot be compared, and nothing errors when that happens.
Unlike `prom-client` on the TS side, every bucket is rendered at 0 from process
start (`_count` = 0), so `rate(..._count[5m])` is a real **0** rather than a
gap — `histogram_quantile` over zero observations is still NaN, which is what
"no samples yet" honestly means.

A third transport rule watches **usage** instead of latency: `NyxTransportUnused`
fires when `nyx_transport_active_sessions` was above zero within the last hour but
stayed at zero for the last 15 minutes while the sidecar itself is still `up` and
the WSS path is still serving. Abandoning the fast path produces no error at all —
clients fall back exactly as designed, so handshake, auth and frame checks all stay
silent, and without this rule the only trace is the dashboard nobody is watching.
The one-hour lookback is what keeps it quiet on deployments that never used
WebTransport in the first place: "always zero" is not a degradation.

## 23.3 Files to know

| File | Role |
|---|---|
| `packages/shared/src/transport.ts` | `TransportOpCode` (canonical opcode source) |
| `packages/shared/src/socket.ts` | event maps |
| `packages/shared/src/schemas.ts` | Zod validation + jitless |
| `packages/shared/src/brands.ts` | branded id types |
| `server/transport-sidecar/src/main.rs` | QUIC termination, session map, kick, chaff |
| `server/transport-sidecar/src/protocol.rs` | pure frame/HELLO decisions (unit + fuzz tested) |
| `server/transport-sidecar/src/fuzz.rs` + `src/bin/fuzz-framing.rs` | deterministic fuzz campaign + long-run runner |
