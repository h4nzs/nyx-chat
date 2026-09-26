# 26 — Group Privacy Blueprint (pseudonyms, pairwise key distribution, blind receipts)

> **Status: ✅ IMPLEMENTED (T1–T4, 2026-09-26) — retained as the design record.**
> All four tiers shipped: T1 pseudonyms (`e4778071`-era commits), T3a blind
> receipts, T3b delivery tokens, T2 pairwise key delivery, T4 cover traffic.
> Deviations from this text are minor: fallbacks retained (see 26.5.3), and the
> removal of `messages:distribute_keys` is deferred per the migration note.
> Implementation notes live in docs/16-groups.md and CHANGELOG.md.
>
> **Original status: PROPOSAL / BLUEPRINT.** This document is the agreed
> design direction for closing the group-metadata gap between NYX's 1:1 path (sealed
> sender) and its group path. Nothing in here changes frozen crypto formats; where a
> schema or wire payload changes, the change is additive and versioned.
>
> Motivating audits (Sept 2026): group metadata leak table in this session's audit,
> sender-key distribution audit (`crypto.ts` / `crypto.worker.ts`), and the industry
> comparison (Signal Groups V1/V2, WhatsApp, Session, MLS RFC 9420).

## 26.1 What the server knows today (the gap)

| Data | 1:1 path | Group path (today) |
|---|---|---|
| Message content | E2EE ✅ | E2EE ✅ (sender key + 8KB padding) |
| Sender of each message | `senderId = NULL` (sealed) ✅ | `senderId = real userId` ❌ |
| Who is in the conversation | `UserHiddenConversation` (userId↔convId) ⚠️ | Same ❌ |
| Key-distribution graph | n/a | `distribute_keys` SYSTEM messages persist sender→target per device ❌ |
| Read receipts | `MessageStatus(userId, READ)` ⚠️ | Same ❌ |
| Group title / member list / roles | n/a | Encrypted metadata ✅ |

The crypto core (Sender Keys with symmetric chain ratchet, PQ-mandatory sealing,
per-message Ed25519 signatures, 25-msg/1h rotation) is **correct and at parity with
Signal/WhatsApp** — see doc 16. The gap is exclusively in *who* fields, not *what*.

## 26.2 Design pillar: three independent upgrades

Each tier is independently shippable and does not break the others. Ordering below is
by (impact ÷ effort), not dependency.

### Tier 1 — Group sender pseudonyms (seal the sender column)

**Goal:** `Message.senderId` for groups stops being a userId. Server stores an opaque
per-group pseudonym that cannot be linked to any account or across groups.

**Mechanism:**

- The group **creator** generates one 16-byte random pseudonym per member (including
  self) at creation time. The mapping `pseudonym → userId` lives **only inside
  `encryptedMetadata`** (already E2EE, already persisted to Shadow Vault on decrypt —
  doc 16.3).
- All group control planes switch to pseudonyms:
  - `Message.senderId` for group messages = sender's pseudonym.
  - `GROUP_KEY_DISTRIBUTION` payload: `senderId` = sender's pseudonym.
  - `group:request_key` / `group:fulfilled_key`: routed by pseudonym.
  - `MessageStatus.userId` = reader's pseudonym (see Tier 3).
- Receivers resolve pseudonym → profile locally (name/avatar come from decrypted
  metadata). **UX unchanged.**

**Why it works with today's crypto:** receiver states are already keyed by
`(conversationId, senderId, senderDeviceKey)` — swapping the key from userId to
pseudonym is a key-rename, not a protocol change. Per-message signatures still
prevent spoofing: only the holder of the signing key bound to that pseudonym can
authenticate as it. No DH ratchet is introduced (and none should be — see doc 26.6
myth-clarification).

**Pseudonym rotation:** rotate all members' pseudonyms on every full key rotation
(the 25-msg/1h cycle) by appending the new mapping to `encryptedMetadata` and
re-distributing. Old and new pseudonyms are unlinkable to the server → message history
before/after a rotation cannot be stitched by the server.

**Migration (versioned, additive):**

- `MinimalConversationSchema` gains optional `pseudonymMapVersion: number` (metadata
  format v2). Old clients keep working: they receive the map inside metadata they can
  already decrypt; messages from unknown pseudonyms resolve to a "member" placeholder
  until metadata v2 is processed.
- Server change is one line: stop asserting/normalizing `senderId` for group messages;
  store what the client sends (already the case — it stores `userId` only because the
  client sends it).
- **Rollout order:** ship metadata v2 → clients begin sending pseudonyms for NEW
  groups → existing groups migrate lazily (next metadata re-encrypt writes v2 with
  pseudonyms). No DB migration needed; `senderId` column already accepts any string.

**Residual leak:** message *volume/timing per pseudonym* still observable, but no
longer joinable to accounts or across groups. Timing analysis (DenIM paper) remains
a fundamental limit for all designs incl. Signal V2 — accepted, documented.

### Tier 2 — Sender-key distribution via pairwise sessions (kill the key graph)

**Goal:** the server never again sees a sender→target key-delivery graph, and sender
keys gain transport forward secrecy.

**Today:** `ensureGroupSession` seals the sender key with `pq_box_seal` to each
member's **static** device keys, then the server relays per-target envelopes and
persists them as 7-day SYSTEM messages. If a device's static private key is
compromised *later*, stored envelopes can be re-opened (defeats the FS the 1:1
Double Ratchet already provides).

**Change:** deliver the sealed sender key **inside the existing pairwise 1:1 session**
(pairwise session NYX already establishes — full Double Ratchet with PQ X3DH):

```
ensureGroupSession:
  for each member-device:
    1. ensure pairwise DR session with that device (ensureSpqrSessionWithPeer — exists)
    2. inner = pq_box_seal(senderKey, devicePq, deviceIdentity)   ← unchanged inner seal
    3. send via pairwise DR as a control message (GROUP_KEY_DISTRIBUTION)
```

- The server now relays pairwise ciphertexts it cannot correlate as "key material"
  (same look as any message). **`messages:distribute_keys` handler becomes dead code**
  → remove after migration (parity test + `KNOWN_WT_ONLY` guard updated).
- Offline catch-up still works: pairwise control messages are store-and-forward
  messages like any other (TTL 14d default instead of the special 7d key-message TTL).
- `group:request_key` recovery: fulfiller re-seals to the requester's current device
  keys and answers over their pairwise session — no separate event type needed.
- Rotation re-runs the same path; no new primitives.

**PQ note:** inner PQ seal is kept (defense in depth), so we *add* DR transport FS
without giving up the post-quantum layer. This yields **FS + PQ in transit**, which
neither Signal (no PQ) nor today's NYX (PQ but no FS transit) has alone.

**Migration:** clients prefer pairwise delivery when the target device has an
established pairwise session, else fall back to `distribute_keys` (interop with
non-upgraded clients). Feature-flag per conversation version.

### Tier 3 — Blinded membership & receipts (hide the roster)

**Goal:** the server stops learning `userId ↔ conversationId`, and read receipts stop
storing raw userIds.

**Membership (delivery tokens):**

- Replace `UserHiddenConversation` rows (raw userId) with per-(group,member)
  **delivery tokens**: `token = randombytes_buf(16)` generated at invite time.
- Tokens are handed to members **inside pairwise sessions** at invite/re-join (same
  channel as Tier 2), and pushed to `encryptedMetadata` backups.
- Server stores `(conversationId, token, createdAt)`; sync/discovery endpoints
  authenticate via token possession instead of userId joins. Sending a group message
  references the group id (already opaque) — the sender's *membership* is attested by
  holding a valid token, checked server-side without identity.
- Creator/admin authorization stays on `authSecret` (unchanged).

**Read receipts (pseudonym-scoped):**

- With Tier 1 in place, group `MessageStatus.userId` stores the reader's *pseudonym* —
  the raw-userId leak disappears for free. This is the first shippable step.
- Optional hardening (flagged per group): **ephemeral receipts** — receipts are sent
  pairwise to the original sender only and never persisted server-side. Trade-off:
  read-count visibility disappears when the sender was offline during the reads.
  Ship as an opt-in toggle ("maximum privacy mode" per group), default off.

**Migration:** `UserHiddenConversation` gains a nullable `token` column (additive);
dual-accept during transition (userId rows still honored), new writes token-only;
backfill job creates tokens for existing memberships and pushes them pairwise on next
online. Token revocation = delete row (kicked member's token dies; pseudonym rotation
makes their receiver state useless for new messages).

## 26.3 What we explicitly do NOT build (and why)

- **ZKGroup-style anonymous credentials:** massive crypto surface (BBS+/pairings),
  and the crnkovic.dev critique applies verbatim to a single-VPS NYX: every group op
  still arrives over an authenticated transport, so "who + which group + when" is
  already in transport logs. Credential math does not fix log analysis. Tiers 1–3
  clean the *stored* data (dump-resistance) without the crypto burden.
- **Full MLS / tree-KEM:** real PCS for groups is attractive long-term, but it is a
  protocol rewrite (doc 16's model is discarded). Revisit after Tiers 1–3 prove out.
- **Onion routing / mix networks (Session-style):** requires a distributed node
  network; out of scope for single-server NYX. Timing correlation is accepted and
  documented as the remaining fundamental leak (same as Signal V2).

## 26.4 Server-visible surface after all tiers

| Data | After |
|---|---|
| Who sent each group message | Random per-group pseudonym (unlinkable) |
| Who is in a group | Possession of an opaque token (no identity binding) |
| Key distribution graph | Gone — indistinguishable from message traffic |
| Read receipts | Pseudonym-scoped (or ephemeral, opt-in) |
| Group content / title / members-in-clear | Never (unchanged) |
| Timing / volume per pseudonym | Observable — documented fundamental limit |

Dump-the-database adversary learns: N opaque conversations, N pseudonymous senders,
no joinable identity graph. That is the stated ambition: **extreme privacy is
achievable by anyone** — NYX would exceed WhatsApp group metadata and match/exceed
Signal V2's *stored*-data posture without Signal's credential machinery.

## 26.5 Implementation sequencing

1. **T1 (pseudonyms):** metadata v2 + sender/receiver state key rename + parity tests
   for `handleKeySync` cases (`messages:mark_*`, `distribute_keys`, `request/fulfilled`)
   accepting pseudonyms. Web + server, no frozen-format touch.
2. **T3a (pseudonym receipts):** piggybacks on T1 — `MessageStatus.userId` becomes
   pseudonym; `message:status_updated` routing via pairwise or opaque relay.
3. **T2 (pairwise key delivery):** biggest but self-contained; behind conversation
   version flag; remove `distribute_keys` after both sides ship (gateway parity test
   is the enforcement point).
4. **T3b (delivery tokens):** schema additive column + sync endpoint change + invite
   UX (token push via pairwise). Do last — it touches auth flows the most.
5. Each step ships with: unit tests, `gatewayParity` updates, CHANGELOG entry, and a
   migration note in doc 16 (mark 26 sections "implemented" as they land).

## 26.6 Ratchet myth-clarification (recorded from the audit)

- NYX group path = **symmetric chain ratchet only** (`kdfChain`: `mk=H(0x01,CK)`,
  `CK'=H(0x02,CK)`) — identical structure and constants to Signal's Sender Keys.
  No DH ratchet per message in groups, in NYX *or* Signal; the "Signal groups behave
  like DR per message" claim is a common mix-up with the 1:1 path.
- Full Double Ratchet (with DH/PCS) exists in NYX **1:1 only** — and Tier 2 deliberately
  reuses it as the *transport* for group keys, which is exactly how Signal moves
  Sender Keys between members.

## 26.8 Upgrade paths — when ZKGroup / MLS become the right call

Researched 2026-09-26. Neither is built today (rationale in 26.3), but both have
concrete entry points; the T1–T3 design deliberately leaves their slots free.

### 26.8.1 ZKGroup-style anonymous credentials

**What closes:** the last gap T3 cannot — the *presentation moment*. Delivery tokens
are clean at rest, but if presented over the account-authenticated session, the server
can correlate `user ↔ token` at runtime/log level. Blind credentials prove membership
without identifying the presenter, even then.

**Trigger conditions (all three):**

1. Group endpoints accept **token-only auth** (no account session) — the endpoint
   isolation work from T3 is the prerequisite, not a rewrite.
2. Transport-level correlation is treated as a threat worth closing (multi-homed
   delivery, or acceptance of single-VPS timing logs as out of scope).
3. Budget for a pairing-free scheme first: blind RSA or CL signatures before BBS+ —
   the token slot in T3 is exactly the credential slot, so the upgrade is a swap of
   the token's *issuance protocol*, not an architecture change.

**Concretely:** T3 tokens are the enabler. Upgrade path = re-issue tokens as blind
signatures via an issuance sub-protocol, keep verification semantics identical.

### 26.8.2 MLS with post-quantum ciphersuites

**State of the draft (checked 2026-09-26):** `draft-ietf-mls-pq-ciphersuites-06`
(Mahy & Barnes, updated 2026-07-21, expires 2027-01-22) — nine suites registered:
ML-KEM-768+X25519 hybrid, ML-KEM-768/P-256, ML-KEM-1024+P-384, pure ML-KEM variants,
some with ML-DSA signatures. WG state: **"Waiting for WG Chair Go-Ahead" + "Revised
I-D Needed"** — i.e. content is mature (rev 6) but not yet at WGLC, no AD assigned.

**Ecosystem:** OpenMLS has active PQ research integrated (eprint 2026/034 benchmarks
an amortized PQ combiner on ML-KEM/ML-DSA in OpenMLS) but no production PQ release
yet; MLS itself is already shipping at scale (GSMA RCS Universal Profile).

**Realistic timeline for NYX:**

| Milestone | Estimate |
|---|---|
| Draft → RFC (WGLC + IESG) | 2027 ("revised needed" state can slip) |
| OpenMLS PQ suites production-grade | 2027, months after RFC |
| Sound evaluation point for NYX | 2027–2028 |

**Why migration will be cheap when the time comes:** the draft's flagship suite
(`MLS_128_MLKEM768X25519_*`) uses the same primitives NYX already runs (ML-KEM-768 +
X25519, ChaCha20-Poly1305 option present) — only the group key-management architecture
(tree-KEM replacing sender-key distribution) changes, not the crypto primitives.

**Trigger conditions (all three):**

1. PQ-MLS is an RFC **and** OpenMLS (or equivalent) ships PQ suites production-grade.
2. NYX group sizes/frequency genuinely need O(log n) ops or real inter-rotation PCS
   (today's 25-msg/1h rotation already bounds chain-compromise exposure sharply).
3. Willingness to accept **non-PQ or PQ-MLS without** the metadata tiers — note MLS
   contributes nothing to sender anonymity, membership blinding, or key-graph removal
   (26.3); T1–T3 and MLS solve disjoint problems.

### 26.8.3 Decision record

- **Now (2026):** implement T1–T3. They close the stored-data metadata gap with additive,
  versioned changes and zero frozen-format churn.
- **2027+:** if 26.8.2 triggers fire, evaluate PQ-MLS as the *key-management layer*
  underneath T1 pseudonyms/T3 tokens — the identity/routing tiers remain necessary
  regardless (MLS never hides membership from the DS by itself).
- **Later:** if 26.8.1 triggers fire, upgrade T3 tokens to blind credentials in place.
  Never build credentials before endpoint isolation — credential math does not fix
  transport-log correlation.

## 26.9 Resource-scaling appendix (post-VPS-upgrade)

Written under the assumption that the VPS constraint (1 core / ~1GB RAM) will be
lifted. Principle: **a resource upgrade buys margin for privacy features, not bloat** —
rate limits, validation strictness, and consistent load patterns stay (predictable
load is itself a privacy property; relaxing it amplifies traffic signatures).

### 26.9.1 Blueprint resequencing

- **New order: T1 → T3a → T3b → T2** (was T1 → T3a → T2 → T3b). Rationale: token schema
  should be final before server-side caching/batching work lands (avoid migrating data
  twice); T2's parallel per-device sealing benefits most from extra CPU.

### 26.9.2 New capabilities unlocked (privacy features first)

1. **Cover traffic (proposed T4):** silent dummy store-and-forward messages with
   jittered per-conversation intervals, dropped client-side. The padding (8KB) already
   hides message *size*; cover traffic attacks the remaining fundamental leak —
   *timing correlation* between senders and recipients (the same leak Signal V2
   accepts, see 26.8.1). Cost: low CPU, modest bandwidth. This becomes NYX's
   differentiator if shipped.
2. **Batched/jittered release:** server holds outgoing messages for a random
   200–800ms window (per-group "maximum privacy mode" opt-in) to decorrelate
   sender→recipient timing.
3. **Parallel key fan-out (T2 enabler):** per-device pq_box_seal under
   `p-limit`-style concurrency instead of serial awaits — 20-member distribution
   drops from ~200ms to ~20ms.
4. **Noisy prekey-bundle cache:** prefetch bundles for likely contacts (co-members of
   shared groups) so cache-miss no longer signals first-contact. Trade: more compute
   per request for less access-pattern leakage — affordable only post-upgrade.
5. **Tighter ephemerality:** sweeper can run more frequently with shorter windows —
   the 24h READ grace and 14d default TTL become tunable downward without sweep
   cost dominating.
6. **Sidecar anonymity helpers (Rust, no frozen-format touch):** per-user connection
   pools (round-robin, breaking 1-connection=1-user correlation) and uniform datagram
   padding at the transport layer.

### 26.9.3 Codebase changes (now-deliberate compromises to revisit)

| Area | Today (1-core) | Post-upgrade | Privacy impact |
|---|---|---|---|
| `handleKeySync` relay loops | Serial `for…of await` | `Promise.all` with concurrency cap 10–20 | Faster T2 fan-out |
| `messageSweeper` cadence | Sparse (CPU-bound) | Frequent, short windows | Tighter ephemerality |
| `BATCH_RECEIPT_MAX` | 100 | 250–500 | 1 event per busy-group open |
| Message RAM window / backfill (`MERGE_WINDOW=150`, 4×250) | Deliberate VPS mercy | Raise both, fewer server paging fallbacks | Less server-visible paging pattern |
| Postgres tuning | Low-memory profile | Larger `shared_buffers`, parallel queries, composite index on `MessageStatus` (batch receipts), `UserHiddenConversation` (T3b sync) | Cheaper blinded sync |
| Redis usage | Per-op round trips | In-memory rate-limit shards in sidecar; noisy caches (26.9.2.4) | Smaller access-trace footprint |

### 26.9.4 Non-negotiables

- Frozen formats stay frozen (8KB padding, `ENC1:`, XChaCha envelope, tempId scheme).
- Rate limits and payload validation do **not** loosen with capacity — predictable,
  uniform load is a privacy feature; easing it increases DoS surface and makes
  traffic analysis easier, not harder.
- Any new batching/jitter/cover-traffic feature must be **opt-in per group** first
  (maximum-privacy mode), measured for battery/latency, then default-on only with
  evidence it does not hurt UX.

## 26.10 Cover traffic (T4) — detailed design

### 26.10.1 Layering: what exists vs what T4 adds

The codebase already has **wire-level chaff** (`transport.worker.ts`: opcode
`0x00`, 1000-byte datagrams every 3s ± 500ms jitter; the sidecar drops them at the
edge — `main.rs` `if op_code == 0x00 { return; }`). That hides *frame timing* on the
client↔sidecar link. It cannot hide:

- **server-side logs**: which conversation received a real app-layer message, when,
  from which authenticated connection;
- **recipient-side correlation**: a burst of deliveries to members of group G.

T4 = **application-level cover messages** that traverse the *full* pipeline (sidecar →
redisBridge → Postgres store-and-forward → recipient delivery → client decrypt) and
are then dropped client-side. To every layer below the recipient's crypto worker they
are indistinguishable from real messages.

### 26.10.2 Message shape — bit-for-bit identical metadata

The cardinal rule: **cover messages must be produced by the same `sendMessage`
pipeline** as real ones, differing *only* in the encrypted payload:

| Field | Real message | Cover message |
|---|---|---|
| opCode / envelope / 8KB padding | same | same |
| `tempId` (53-bit scheme) | yes | yes (full pipeline → server dedupe works) |
| `deleteSecret` | yes | yes (so unsend metadata shape matches) |
| TTL | client-set (24h groups) | **identical distribution** — a distinct TTL would be a tag |
| `isSilent` | false (normal) | true — reuses existing silent infra: no push payload, no unread increment, no Dynamic Island |
| encrypted content | user text | `{ type: 'COVER', ts }` inside the existing `parseSilent` family |

Client drop rule mirrors `GHOST_SYNC`: after decrypt, `silentPayload.type === 'COVER'`
→ return `null` (no bubble, no vault persistence, no conversation preview update).
Cover messages **advance the sender-key chain** — by design: chain index N no longer
maps to real message count, and skipped-key machinery already handles the resulting
gaps. (T1 interplay: cover senders use pseudonyms like everyone else.)

### 26.10.3 Scheduling — Poisson, per member, per group

- Each member runs an independent **Poisson scheduler** per opted-in conversation:
  next cover sent at `Δ = -ln(U) / λ` (uniform sampling), clamped to
  `[10s, 15min]`. Superposition of independent Poisson processes is Poisson — real
  sends hide in cover traffic *without any coordination* between members.
- λ default: **one cover message / 2 min / conversation** (while the client is
  connected). Only fires while `document.visibilityState === 'visible'` or the app
  holds a WT connection — background-throttled tabs must not correlate cover with
  user attention anyway.
- **Do not suppress** cover right after a real send (a human-noticeable silence or
  burst pattern is itself a signal); Poisson independence is the feature.
- Only **connected** members emit. Cover traffic cannot be faked for offline users
  without a server-side generator — explicitly rejected: the server must never be
  the source of traffic patterns (it would know exactly which messages are cover).

### 26.10.4 Budget (server + client)

Per group with M active members at λ=0.5/min, 8KB padded envelope:

- Bandwidth: `M × 0.5 × 8KB ≈ M × 4KB/min` per direction (20-member group ≈ 80KB/min
  ≈ 1.3KB/s — negligible on the upgraded VPS, impossible on 1-core: this is why T4
  is gated on 26.9).
- DB writes: `M × 0.5/min` rows, swept by TTL like any message.
- Battery/bandwidth UX estimate at defaults: ≈ 11.5MB/day per opted-in group per
  member — shown honestly in the UI (26.10.5).
- **Rate-limit interplay (critical):** cover messages consume the same
  `message_send` rate-limit bucket as real sends. The scheduler must back off when
  real sends + pending covers approach the bucket (cover yields to real, never the
  reverse). A user who hits the limit by chatting simply stops emitting cover —
  their real traffic already dominates the distribution at that moment anyway.

### 26.10.5 Opt-in UX

- Per-group setting: **Privacy level — Standard / Maximum** (aligned with the Q4
  decision's per-group toggle pattern). Maximum = cover traffic + ephemeral receipts
  + (later) batched/jittered release, bundled as one switch with a plain-language
  explainer: "Your device sends encrypted filler messages so real activity is harder
  to single out. Uses ~X MB/day here."
- Show the honest per-group data estimate before enabling; no silent data burn.
- Burner groups: **Maximum by default** (per Q5 — burners inherit everything from
  day one, no fallback paths).
- The toggle is **client-local state** (like the metadata cache): the server must not
  learn which conversations run cover traffic — that would tag exactly the messages
  we most want to protect. Members who opted in simply emit cover; membership in the
  "cover set" is not a queryable fact server-side.
- Global settings gain only a master kill-switch ("never send cover traffic"),
  not per-group enumeration.

### 26.10.6 Residual leaks (documented honestly)

1. **Volume bursts:** a real-message burst raises total volume above the cover
   baseline; a long-running observer can see *that* something happened (not who or
   what). Mitigation path: adaptive λ that raises cover rate after detecting own
   real sends — planned, measured, never defaults.
2. **Participation correlation:** cover traffic confirms a member is online; it does
   not confirm group membership beyond what T3 leaves (tokens). Combined with T3b,
   the server-side join `user ↔ cover-emitting conversation` still exists via the
   authenticated connection — same accepted limit as 26.8.1, closed only by
   token-only endpoints later.
3. **Endpoint diversity:** all members' cover converges on one VPS IP — protects
   against DB dumps and passive wire taps on member links, not against the server
   operator itself.

### 26.10.7 Rollout

1. Ship behind the same conversation-version flag as T1/T3 (client gauges: cover
   messages from non-upgraded peers are already safe — they decrypt-drop).
2. Instrument (client-side, privacy-preserving counts only): cover/real ratio,
   dropped-vs-decrypted, bandwidth used. Compare against estimates before widening.
3. Default-on only for burner groups first; then opt-in Maximum mode; never silent
   global rollout.

1. **Pseudonym map format: full rewrite + generation counter.** Metadata is already
   fully re-encrypted at every rotation (key changes), so an append-only log saves
   nothing and only grows the blob. Receivers care about the latest map only.
2. **Group unsend authorization: deleteSecret-only.** After T1, `msg.senderId` holds a
   pseudonym so the server-side `isSender` branch is dead code; `deleteSecret` (already
   a random 64-hex client token, blind-compared via `safeEqualStrings`) becomes the
   sole proof. Server: drop the `isSender` branch for group messages; REST
   `X-Delete-Token` path is already consistent.
3. **Delivery-token rotation: revocation-driven + optional 30-day refresh.** Tokens are
   routing/membership proofs, not message secrets; coupling them to the 25-msg/1h key
   rotation would punish offline members. Kick/leave kills the token immediately.
4. **Read receipts: persistent (pseudonym-scoped) ON by default, per-group ephemeral
   toggle; burner groups default ephemeral.** Balances offline read-count UX with a
   maximum-privacy option.
5. **Burner conversations inherit all tiers from day one** — shared conversation
   infrastructure makes this near-zero extra cost, and burners get NO fallback path to
   legacy userId rows (pseudonym + token only, always).
