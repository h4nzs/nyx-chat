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

## 26.7 Open questions (decide during implementation)

1. Pseudonym map growth: full-map rewrite vs append-only log inside metadata v2?
2. Should pseudonyms also replace `deleteSecret` binding for unsend in groups?
3. Delivery token rotation cadence (per group rotation? per re-login?).
4. Ephemeral receipts: per-group toggle vs global setting default?
5. Burner conversations: inherit all three tiers from day one (recommended).
