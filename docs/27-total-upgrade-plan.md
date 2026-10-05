# 27 — Total Upgrade Plan (post-VPS-closure, ≥8GB RAM / ≥4 cores)

> **Status: MASTER PLAN — supersedes resource assumptions in docs 16 & 26.** The old
> VPS is closed (nyx-app.my.id → Cloudflare 530, verified 2026-09-26). Everything
> here assumes the new target: **≥8GB RAM, ≥4 cores**. This is the single backlog
> for the "rebuild and re-launch" cycle: infrastructure, server, transport, client,
> the privacy tiers of doc 26, and new capabilities. Nothing here touches frozen
> crypto formats (8KB padding, `ENC1:`, XChaCha envelope, tempId scheme).
>
> **Update 2026-09-26:** the doc-26 privacy tiers (27.4) are **fully implemented
> ahead of the infra upgrade** — T1 → T3a → T3b → T2 → T4 all shipped in code
> (verified: server 82/82, web 134/134). Note: T4 was implemented on the current
> era's rate limits (cover yields at 28/min vs the 30/min bucket); revisit 27.2.4
> and the T4 soft cap together after the 27.2 recalibration lands.
>
> **Update 2026-09-27:** prod DB will be reset (no user migration) → the two
> deferred removals executed early: (1) legacy `messages:distribute_keys` path
> deleted — pairwise GROUP_KEY is the only route (26.5 deferred-removal note);
> (2) T3b went **token-first** (`UserHiddenConversation.userId` nullable,
> token required & unique; sync discovery = token possession only). This also
> closes **26.8.1 trigger condition #1** (token-only endpoints). 27.2.4 rate
> limits recalibrated (chat_message 120/min etc.), client cover soft cap
> 28 → 118/min.
>
> **Update 2026-10-05:** the "pairwise GROUP_KEY route" itself was superseded
> by the sender-key v2 rewrite — one distribution path
> (`sendGroupSenderKeyDistribution` → `group:fulfilled_key`), random per-era
> `chainId`, metadata carried by a dedicated per-era `metadataKey` outside the
> chain. See docs/16 §16.7.2–16.7.3 and the CHANGELOG 2026-10-05 entry.

## 27.0 Audit summary — what the 1-core era constrained

| Area | Finding (verified in code) | Consequence of the constraint |
|---|---|---|
| Rate limits | `chat_message 30/min`, `distribute_keys 40/min`, `group_request_key 20/min`, `metadata_updated 20/min`, `presence 30/min`, `ack 60/min` (Redis Lua, atomic) | Tuned to protect a 1-core box; conservative for real usage, blocks T4 cover traffic |
| pm2 | `nyx-api` + `nyx-sidecar`, single instance each (deploy.yml) | No cluster mode, no separate DB/Redis processes on same box |
| Postgres | Local on VPS, low-memory tuned; `messageSweeper` cron every 1 min, `systemSweeper` daily | Sweeper cadence is a CPU compromise → ephemerality is looser than designed |
| Serial relay loops | `handleKeySync` per-recipient `for…of await` (distribute_keys, unsend, migration) | ~10ms per recipient latency, fan-out scales linearly |
| Client RAM window | `MERGE_WINDOW=150`, `MAX_BACKFILL_PAGES=4×250` | Heavy server paging pattern on active groups |
| `BATCH_RECEIPT_MAX` | 100 | Busy-group open = up to 4 batch events |
| Sidecar | No worker-thread tuning found; chaff 1000B/3s | Single-threaded relay under load; chaff covers only the client↔sidecar wire |
| Calls | WebRTC with Cloudflare TURN (credential API, 12h client cache), signaling relayed via `WEBRTC_SIGNAL`/`WEBRTC_ICE` opcodes; STUN fallback google | External dependency: Google STUN + Cloudflare TURN = third parties see call attempts (IP + timing) even though media is E2E-encrypted via DTLS-SRTP |
| Media | R2 presigned URLs, encrypted `application/octet-stream` only, deleteAt enforced | Good design; constrained by R2 free-tier egress & 1-core proxying of any inline flows |
| Stories | 24h TTL, E2EE keys per story (storyKeys vault) | Fine; upload path shares constraints above |
| Noisy-cache gap | Prekey bundle cache (Redis, 1h) has clean hit/miss semantics | Cache-miss signals "first contact A→B" to a logging server |

## 27.1 Phase 0 — Infrastructure rebuild (new VPS)

1. **Provision:** ≥8GB RAM / ≥4 cores; fresh Ubuntu LTS + unattended-upgrades.
2. **Process layout (pm2 cluster):** `nyx-api` ×2–4 cluster instances (Express is
   fine behind Redis-backed sessions since all shared state is already Redis/PG);
   `nyx-sidecar` ×1 per 2 cores (tokio multi-thread runtime); dedicated systemd
   Postgres + Redis (or managed PG if budget allows — but local keeps latency and
   privacy posture).
3. **Postgres re-tune:** `shared_buffers=2GB`, `effective_cache_size=6GB`,
   `work_mem=32MB`, `max_connections=100`; add missing indexes (below) before
   reopening.
4. **Redis:** enable AOF persistence; raise `maxmemory` to 1GB with
   `allkeys-lru` for cache keys (rate-limit keys must use `noeviction` policy —
   keep them in a separate logical DB or key prefix to avoid eviction).
5. **Cloudflare:** keep proxied DNS; consider enabling gRPC/WS hints for
   WebTransport fallback stability; regenerate `VITE_TRANSPORT_CERT_HASH` pin.
6. **Secrets hygiene (carried from earlier backlog):** rotate `JWT_SECRET`,
   `VITE_APP_SECRET` chain, NOWPayments keys, VAPID keys; delete stale
   `TRIPAY_*`/`SENTRY_*` from GH Actions + old VPS `.env` (box is dead — verify
   nothing was left running before wiping).
7. **Backups:** keep the daily pg_dump cron; add a weekly off-site copy (R2
   private bucket, encrypted client-side with a key NOT on the VPS).

## 27.2 Phase 1 — Server correctness & throughput (no behavior change)

1. **Indexes (prisma, additive):**
   - `MessageStatus(conversationId, status)` — batch receipt sweep & unread checks
   - `Message(conversationId, type, expiresAt)` — SYSTEM/key-message fetch already
     filtered by TTL in routes/messages.ts
   - `UserHiddenConversation(conversationId)` — T3b token sync later
   - Verify all with `EXPLAIN ANALYZE` against a seeded DB.
2. **Parallelize relay loops** in `handleKeySync` (distribute_keys, unsend,
   migration): `Promise.all` with a concurrency cap (10). Acceptance: parity tests
   unchanged, latency test for 20-recipient fan-out < 50ms.
3. **Sweeper cadence:** `messageSweeper` every 15s (batched `deleteMany` by
   `expiresAt` cursor, never full scans) — tighter ephemerality for free.
   `systemSweeper` stays daily.
4. **Rate-limit recalibration** (post-verification, not blind raising):
   `chat_message 120/min`, `distribute_keys 120/min`, `group_request_key 60/min`,
   `metadata_updated 60/min`, `ack 240/min`. Keep the atomic Lua shape; keep
   per-opcode buckets; do NOT merge buckets (per-bucket granularity is the
   abuse-control).
   **[implemented 2026-09-27]** chat_message 120, message_ack_delivered 240,
   group_request_key 60, metadata_updated 60 applied in gateway.ts +
   realtimeHandlers.ts (distribute_keys bucket moot — event removed, see
   26.5 note). Client cover soft cap moved 28 → 118/min (margin 2 slots under
   the server bucket; cover still yields to real, 26.10.4).
5. **`BATCH_RECEIPT_MAX` → 250** (with the new index), keep dedupe + TTL logic.
6. **Sidecar:** enable multi-threaded tokio runtime (2–3 workers), raise datagram
   queue depths; add per-user connection pools (round-robin) to decorrelate
   1-connection=1-user; uniform datagram padding option at transport layer.

## 27.3 Phase 2 — Client lifting (same code paths, larger budgets)

1. `MERGE_WINDOW` 150 → 400; `MAX_BACKFILL_PAGES` 4 → 8 (2000 msgs/sync); keep
   cursor pagination contract.
2. Virtualized list window + message cache tuning; keep the Virtuoso ref pattern
   (docs 06) — do not regress the mass-rerender fix.
3. Offline queue: allow larger payload backlog; keep idempotent replay (tempId).
4. Revisit service worker precache limits (5MB→10MB only if real assets need it —
   do not bloat install size).

## 27.4 Phase 3 — Privacy tiers (from doc 26, resequenced)

Order per 26.9: **T1 (pseudonyms) → T3a (pseudonym receipts) → T3b (delivery
tokens) → T2 (pairwise key delivery)** — decisions 26.7 are locked; T2 last
because parallel sealing (27.2.2) makes its UX smooth and token schema (T3b) is
final by then. T4 cover traffic after T2 (needs the rate-limit headroom of 27.2.4
and benefits from parallel infrastructure).

## 27.5 Phase 4 — Calls (voice/video): the honest privacy gap

**Today:** media is DTLS-SRTP E2E (good), but **signaling relay is identity-bound**
(`WEBRTC_SIGNAL` routes `to: userId`) and the ICE stack leaks:
- Cloudflare TURN sees both endpoints' IPs per call (and STUN fallback leaks to
  Google entirely — including when TURN is configured, because the fallback list
  is appended).
- Call attempts (ring/accept/reject timing) are visible server-side per user.

**Upgrade plan:**
1. **STUN hygiene (now):** drop Google STUN from fallback lists; use
   self-hosted coturn (new VPS) as STUN+TURN, or Cloudflare TURN only.
2. **Self-hosted coturn (new VPS):** long-term credential mechanism; TURN
   credentials minted by `keys.ts` turn route stay, but point at own server —
   removes the Cloudflare third party from the media path. Bandwidth: TURN relay
   is CPU/network heavy — this is *the* new-spek justification for calls.
3. **P2P-first ICE policy:** `iceTransportPolicy: 'all'` with host/srflx
   candidates preferred; TURN only as fallback (reduces self-hosted TURN load).
4. **Signaling blinding (pairs with T1):** call signaling uses pseudonym +
   pairwise-session routing (same mechanism as T2 group keys) instead of
   `to: userId` — call attempts become unlinkable to accounts server-side.
5. **Group calls:** current architecture is 1:1 only (callStore is single-peer).
   With new capacity, SFU-style multi-party is possible but is a large project —
   record as explicit non-goal until 1:1 call blinding ships.

## 27.6 Phase 5 — Media & stories

1. Keep R2 + presigned URLs (already the right privacy shape: server never sees
   plaintext media; deleteAt enforced).
2. Raise per-file limits modestly (5MB → 25MB voice note/video note) — padded,
   encrypted, same pipeline.
3. Add R2 lifecycle audit: verify `deleteAt` objects actually expire (R2
   lifecycle rule), otherwise the 24h story promise is only client-enforced.
4. Avatar/preview pipeline: `secureLinkPreview.ts` exists — verify no outbound
   fetch happens server-side for user-supplied URLs without SSRF guards (audit
   item; cheap to check with a test).

## 27.7 Phase 6 — Reliability & observability (privateness-compatible)

1. **Metrics without telemetry:** self-hosted Prometheus + Grafana on the new box
   (or a second cheap box); count *events*, never identities: message volumes,
   transport mode distribution, error rates, sweep latencies. No user IDs in
   labels.
2. **Alerting:** disk, RAM, Redis eviction of rate-limit keys, sweeper lag,
   sidecar cert expiry.
3. **Load test before reopening:** k6/artillery script that simulates 500
   concurrent users, 20 msgs/s aggregate, group fan-out storms — must hold
   p95 < 200ms for relay operations.
4. **Game-day runbook:** update docs/10 with the new topology + rollback steps;
   rehearse deploy on the new box before announcing.

## 27.8 Explicit non-goals (unchanged from 26.3/26.8)

ZKGroup credentials (until token-only endpoints exist), MLS (until PQ suites are
RFC + OpenMLS production, est. 2027–2028), onion routing/mixnets, multi-party
SFU calls (until 1:1 call blinding ships).

## 27.9 Execution order & acceptance

| Phase | Blocker for | Acceptance gate |
|---|---|---|
| 0 Infra | everything | deploy.yml green on new box; backups verified |
| 1 Server | T2/T4, client lifting | parity tests green; load test p95<200ms |
| 2 Client | launch UX | full vitest+playwright suite; manual matrix |
| 3 Privacy tiers | relaunch promise | tier-by-tier with per-tier tests (26.5) |
| 4 Calls | privacy parity with 1:1 messages | coturn self-hosted; signaling blinded |
| 5 Media | UX polish | R2 lifecycle verified; SSRF tests |
| 6 Observability | ops maturity | alerts firing in a game-day drill |

Reopen the service to users only after Phase 1–3 acceptance. The relaunch story
writes itself: same NYX, now with group metadata at Signal-V2-or-better posture,
self-hosted call infrastructure, and cover traffic as an opt-in — no other
small-team messenger ships all three.
