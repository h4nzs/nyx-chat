# 16 — Groups

How group conversations are created, how metadata and messages are encrypted, how sender keys are distributed, and how membership changes are handled.

> **✅ Blueprint 26 IMPLEMENTED (2026-09-26).** The group-privacy tiers are
> shipped and supersede parts of this document:
>
> | Tier | What changed | Section |
> |---|---|---|
> | **T1** | Sender pseudonyms — group `senderId` is a per-group random pseudonym (metadata v2 `pseudonymMap`, generation counter); server stores verbatim | replaces 16.4 routing notes |
> | **T3a** | Group `MessageStatus.userId` stores the reader's **pseudonym**, not the account id | new |
> | **T3b** | Blinded membership discovery via per-member **delivery tokens** (`UserHiddenConversation.deliveryToken`, dual-accept sync) | extends 16.5 |
> | **T2** | Sender keys distributed **inside pairwise DR sessions** (`GROUP_KEY` silent control, virtual `<group>:pw:<peer>` conv id); `messages:distribute_keys` is now the legacy fallback | supersedes 16.4 delivery |
> | **T4** | Opt-in application-level **cover traffic** (Poisson scheduler, `COVER` silent type, drop-after-decrypt) | new |
>
> Design rationale, threat model, and residual leaks: **docs/26-group-privacy-blueprint.md** (decisions locked in 26.7). This document remains accurate for the 1:1 sealed-sender path, legacy (v1) groups, and the metadata decryption-once fix (16.3).

## 16.1 Overview

Groups use the **Sender-Key protocol** (client-side fan-out). The server is a blind relay: it never sees group keys, member names, or message content — only opaque conversation records and ciphertext.

**Key files:** `web/src/store/conversation.ts` (group creation + metadata), `web/src/utils/crypto.ts` (`ensureGroupSession`, `encryptGroupMetadata`, `decryptGroupMetadata`), `web/src/lib/keychainDb.ts` (sender-key state at rest), `web/src/store/message.ts` (group send path), `server/src/routes/conversations.ts`, `server/src/routes/messages.ts`.

## 16.2 Creation flow

```mermaid
sequenceDiagram
    participant C as CreateGroupChat
    participant S as conversation store
    participant W as crypto.worker
    participant API as Server
    C->>S: createGroup({ title, userIds })
    S->>API: POST /conversations (isGroup: true)
    API-->>S: { id, authSecret, encryptedMetadata: null }
    S->>W: generate sender key + encrypt metadata
    S->>S: encryptGroupMetadata({title, participants})
    S->>API: PUT /conversations/:id/details (encryptedMetadata, X-Group-Token: authSecret)
    S->>S: distribute sender key to each member (messages:distribute_keys)
```

- `authSecret` is a blind authorization token: the server checks `X-Group-Token` against it for detail/participant mutations, without knowing who the admin is.
- The group creator distributes its sender key to every participant via `messages:distribute_keys` → persisted as SYSTEM messages so offline members receive keys later.

## 16.3 Metadata encryption & the "Unknown Group" problem

- Group metadata (title, participant list) is encrypted with the creator's sender key at ratchet **N=0**.
- **Decryption-once problem:** the sender-key ratchet advances past N=0 as messages are decrypted. Re-decrypting metadata at N=0 later fails, which would show the group as "Unknown" and hide its messages.
- **Fix (persistence):** after the first successful metadata decrypt, the result is persisted to the Shadow Vault (`saveConversation` → `db.conversations.decryptedMetadata`), so subsequent loads reuse the cache instead of re-decrypting. Participant IDs are additionally cached via `saveCachedGroupParticipants`.

## 16.4 Sender-key distribution & rotation

- Each sender maintains its own chain key `{CK, N, skippedKeys}` per conversation (`groupSenderStates`); each recipient maintains a per-sender receiver state (`groupReceiverStates`) — all encrypted at rest with the `ENC1:` envelope.
- **[T2 — implemented]** Distribution rides the pairwise DR session per peer as a silent `GROUP_KEY` control message (virtual `<group>:pw:<peer>` conversation id); the legacy `GROUP_KEY_DISTRIBUTION` / `messages:distribute_keys` path below is the fallback for devices without a pairwise session.
- Control message `GROUP_KEY_DISTRIBUTION` carries per-recipient `encryptedKey` + `senderDeviceKey` (and optionally a DR header) — delivered in-band and processed first by the offline sync path.
- **[T1 — implemented]** Group senders sign/route with a per-group pseudonym (metadata v2); receiver states key off the resolved sender.
- **Rotation** (`forceRotateGroupSenderKey`): triggered on participant add/remove, crypto change, or manual "repair secure session". Rotation also re-encrypts metadata v2 with a fresh pseudonym map (generation+1) — delivery-token maps are inherited, never rotated.

## 16.5 Membership operations

| Op | Client | Server |
|---|---|---|
| Add participant | `addParticipants` | `POST /:id/participants` (X-Group-Token) → broadcast `conversation:new` |
| Remove participant | `removeParticipant` | `DELETE /:id/participants/:userId` → `conversation:participant_removed` |
| Leave | `deleteConversation` (local) | `DELETE /:id/leave` |
| Delete (admin) | `deleteGroup` | `DELETE /:id` → `conversation:deleted` (only creator can delete; 403 otherwise) |

All membership changes force a sender-key rotation so removed members cannot read future messages (PFS for groups).

**[T3b — implemented]** Adds/leaves/kicks also write or delete the member's **delivery token** row (`UserHiddenConversation.deliveryToken`): tokens are issued by the inviter at add-time and revoked (= row deleted) on kick/leave, so kicked members lose discovery access without any identity join. Full design: docs 26.2 / 26.10.

## 16.6 Group info & UI

- `GroupInfoPanel` / `EditGroupInfoModal` show/edit the decrypted metadata; `ParticipantList` renders members from the decrypted participant list (with per-user profile enrichment via `useUserProfile`).
- `AddParticipantModal` picks users and triggers the add flow.

## 16.7 Edge cases & invariants

- **Metadata missing → "Unknown":** now mitigated by persisting decrypted metadata; if it still happens, `repairSecureSession` / a ghost sync re-fetches the group key.
- **Member sends before metadata decrypt:** non-creator members reconstruct the participant list from `getCachedGroupParticipants` (opaque-mailbox fallback) so they can send immediately.
- **Key rotation pending:** `requiresKeyRotation` flag + `fireGhostSync` reconcile state after a metadata/participant mismatch.

## 16.8 Files to know

| File | Role |
|---|---|
| `web/src/store/conversation.ts` | `createGroup`, `addOrUpdateConversation`, `updateConversation`, participant ops |
| `web/src/utils/crypto.ts` | `ensureGroupSession`, `encryptGroupMetadata`, `decryptGroupMetadata`, `forceRotateGroupSenderKey` |
| `web/src/lib/keychainDb.ts` | sender/receiver ratchet state, cached participants, at-rest encryption |
| `web/src/lib/messagePipeline.ts` | `GROUP_KEY_DISTRIBUTION` control handling |
| `server/src/routes/conversations.ts` | group endpoints + blind auth (`X-Group-Token`) |
| `server/src/network/redisBridge.ts` | `messages:distribute_keys`, `group:*` events |

**[Blueprint 26 additions]** `web/src/lib/groupPseudonyms.ts` (pseudonym + delivery-token maps), `web/src/lib/coverTraffic.ts` (Poisson cover scheduler), `web/src/utils/typeGuards.ts` (`GROUP_KEY` / `COVER` silent types), `server/tests/deliveryTokens.test.ts` (T3b contract).
