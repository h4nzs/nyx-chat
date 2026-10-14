# 08 — WebTransport Sidecar (Rust)

## 8.1 Overview

`server/transport-sidecar/` — a Rust binary built on `wtransport` that terminates WebTransport (HTTP/3) sessions and bridges them to Node via Redis pub/sub. The Express API does **not** expose WebTransport; the sidecar binds its own port (`TRANSPORT_PORT`, default 33333, UDP).

## 8.2 Build & run

```bash
cd server/transport-sidecar
cargo build --release

JWT_SECRET=<server JWT secret> \
REDIS_URL=redis://127.0.0.1:6379 \
TRANSPORT_PORT=33333 \
./target/release/transport-sidecar
```

Optional env: `PROD_CERT_PATH` / `PROD_KEY_PATH` (CA-signed cert in prod; self-signed generated otherwise).

## 8.3 Session lifecycle

1. Client opens the connection, then the **first bidirectional stream** carries the AUTH frame: `[0x00][len u32 BE][JSON {token, identity:{fingerprint, installationId}}]`.
2. The sidecar validates the JWT (HS256, exp) and verifies device identity fields.
3. Sessions are stored in a `DashMap` keyed `"userId:deviceId:uuid"`. **One user = one device**: opening a new session for the same user kicks the previous session (`SESSION_REVOKED` KICK).
4. Per-message device revalidation (against Redis `active_device:`) is done on the **Node side** (`redisBridge.isActiveDeviceAllowed`) — the sidecar checks only at session start.

## 8.4 Frame protocol

```
[ op_code: u8 ][ length: u32 big-endian ][ payload ]
```

- **Uni-streams** (client→server): event frames. Chaff (`0x00`) is dropped.
- **Datagrams**: small frames (e.g. chaff, ICE). Opcode `0x00` ignored.
- **Server→client**: sidecar reads `nyx:downstream` messages and writes frames to the target session's uni-stream or datagram (`is_datagram` flag).

The decision logic for all four reader paths is now a **pure function** in
`src/protocol.rs` (`classify_inbound`, `parse_inbound_frame`, `parse_transport_hello`)
exporting `InboundFrame`/`InboundHeader`; `src/main.rs` only does I/O. Ordering
that must not change: CHAFF first (cheapest, no allocation) → hard payload limit
→ HELLO/message. `cargo test` covers every outcome plus a deterministic fuzz
campaign (`src/fuzz.rs`, runner `src/bin/fuzz-framing.rs`, docs/11 §11.1c).

## 8.5 Redis envelope

Upstream (sidecar → Node): publish to `nyx:upstream:<op_code>`:

```json
{ "user_id": "…", "device_id": "…", "op_code": 1, "payload": "<base64url>", "is_datagram": false }
```

Downstream (Node → sidecar): identical shape on channel `nyx:downstream`.

## 8.6 Hardcoded opcodes (keep in sync!)

The sidecar hardcodes magic numbers for CHAFF/AUTH (`0x00`), ACK (`0x06`), KICK (`0x07`), HANDSHAKE (`0x0A`) and dispatch. The canonical source is `packages/shared/src/transport.ts` — update both when adding opcodes.

## 8.7 Certificate pinning (dev)

- Local runs generate a self-signed cert and print its SHA-256 hash in the startup banner.
- Copy the printed hash into `web/.env` as `VITE_TRANSPORT_CERT_HASH`; the browser pins it via `serverCertificateHashes` (only in dev — prod relies on CA trust through `rt.nyx-app.my.id`).
- Regenerating the cert requires updating the hash in `web/.env` (and the `e2e-chrome` CI job does this automatically by parsing the banner).

## 8.8 Deployment

- Runs under pm2 as `nyx-sidecar` (`--cwd /root/nyx-app/server`), rebuilt by CI on every deploy (`cargo build --release`), binary shipped in the deploy zip.
- The sidecar only needs `JWT_SECRET` + `REDIS_URL` + `TRANSPORT_PORT`; prod `.env` supplies them.

## 8.9 Fuzz & tests

```bash
cd server/transport-sidecar
cargo test                                        # 17 tests incl. 20k-iteration campaign
NYX_FUZZ_SECONDS=3600 cargo run --release --bin fuzz-framing   # gate ≥1 jam
```

Targets: frame classification/buffer parsing (incl. `length = u32::MAX`, chaff
with an incomplete payload, empty payload), HELLO parsing limits, and a
**differential** check against a second, independently written reference
implementation (`reference_forward`). Findings print `TEMUAN: …` with the seed +
input and exit non-zero, so the long run can be a nightly gate.

## 8.10 Known limitations

- No sequence numbers across reconnects (ordering relies on `createdAt` in the UI).
- If the sidecar is down, realtime stops (no socket.io fallback) — clients retry with exponential backoff.
- Session registry is in-memory; a sidecar restart forces all clients to reconnect.
