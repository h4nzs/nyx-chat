# 26 — Group Privacy Blueprint (pseudonyms, pairwise key distribution, blind receipts)

> **Status: PROPOSAL / BLUEPRINT — not yet implemented.** This document is the agreed
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
