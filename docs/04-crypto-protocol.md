# 04 — Crypto Protocol Specification

> ⚠️ **FROZEN.** These formats and primitives are the compatibility contract between devices. Changing them breaks existing users. Any change requires an explicit security review and a migration story.

Most cryptographic code runs in `web/src/workers/crypto.worker.ts` (monolithic by design); the main thread reaches the worker catalogue only via `web/src/lib/crypto-worker-proxy.ts`.

Deliberate exceptions that use libsodium directly on the main thread: the biometric vault (`biometricUnlock.ts` — BLAKE2b + XChaCha20-Poly1305), `contactStore.ts` / `groupPseudonyms.ts` (BLAKE2b and random member tokens), and `backupFormat.ts` (backup KDF). Do not add new main-thread primitives without a documented reason.

## 4.1 Primitives

| Purpose | Primitive |
|---|---|
| Symmetric encryption | XChaCha20-Poly1305 (IETF) |
| Key exchange | PQX3DH — X25519 + **ML-KEM-768 via X-Wing** |
| Hashing / KDF | Argon2id (vault 128MB/4 iter; blind index 64MB/3 iter; panic 19MB/2 iter), BLAKE2b |
| Signatures | Ed25519 (v1 paths, group signing when `signingV2` is absent) + **ML-DSA-65** (`signingV2`, `sigV: 2`) |
| Ratchet | Double Ratchet + PQ-DR; group Sender-Key ratchet |
| Attachment stream | libsodium secretstream (xchacha20poly1305) |

## 4.2 Canonical XChaCha envelope

`base64url( nonce(24) || ciphertext )` — produced by the worker ops `xchacha_seal` / `xchacha_open`.

**These** use this envelope (single implementation, do not fork):
- story payloads (`storyCrypto.ts`), call signaling (`encryptCallSignal`), profile blobs (`encryptProfile` worker op).

Shadow Vault **structural** text (`shadowVaultDb.ts`) is *not* sealed with `xchacha_seal`: it goes through the at-rest `ENC1:` path (§4.8, `encrypt_session_key` keyed by `masterSeed`). The bytes are also XChaCha20-Poly1305 with a 24-byte nonce, but the keying and helper differ — do not treat the two as interchangeable.

Exception: `biometricUnlock` uses a separate `{ciphertext, iv}` ORIGINAL-base64 envelope with a PRF-normalized key — intentional, do not merge.

## 4.3 Key bundle format (`ENCRYPT_DATA` / `DECRYPT_DATA`)

Stored encrypted private-key bundle (IndexedDB `kvStore.nyx_encrypted_keys`):

```
"salt" . "." . JSON({ iv: number[], data: number[] })
```

- `iv` and `data` MUST be plain number arrays produced by `Array.from(...)`. `JSON.stringify` of a `Uint8Array` yields `{"0":…}` and silently breaks decryption. This exact bug has happened twice — leave it.
- `DERIVE_KEY` (Argon2id, vault config) derives the KEK from password + salt.
- The plaintext JSON contains base64url fields: `encryption`, `pqEncryption`, `signing`, `signedPreKey`, `pqSignedPreKey`, `signingV2` (ML-DSA-65 seed/key; optional for pre-PQ bundles, required for v2 handshakes), `masterSeed`.

## 4.4 PQX3DH (X3DH + X-Wing)

- Initiator (`x3dh_v2_initiator`): requires `pqIdentityKey`, `signedPreKey.pqKey`, `signedPreKey.pqSignature` **presence**, and `signingKeyV2`. It does **not verify** `pqSignature` — the v2 path deliberately ignores it; authentication moved into the handshake signature below. It runs `crypto_kem_xwing_enc` against the PQ identity / signed pre-key / optional one-time pre-key, derives `sessionKey` via BLAKE2b, signs the handshake transcript with ML-DSA-65 (`PQ_V2_DOMAINS.HANDSHAKE`), and outputs serialized `initiatorCiphertexts` (ephemeral pk ‖ ct_id ‖ ct_spk ‖ ct_otpk? ‖ signature).
- Recipient (`x3dh_v2_recipient` / `x3dh_v2_recipient_regenerate`): reverses it and **verifies the ML-DSA-65 transcript signature against the initiator's `signingKeyV2` before deriving or using any state**. OTPK private keys are stored in the JSON array format (`classical`/`pq` fields) from `generate_otpk_batch`.
- The resulting shared secret seeds the Double Ratchet / PQ-DR via `dr_init_alice` / `dr_init_bob`.
- A bundle without `signingKeyV2` is rejected by the client (“Post-Quantum Handshake Mandatory”); the legacy `x3dh_*` worker ops no longer exist.

## 4.5 Double Ratchet (1:1)

- State: `DoubleRatchetState` (serialized b64 fields). Stored **encrypted at rest** via `storeRatchetStateSecurely` (masterSeed → `encrypt_session_key` worker op).
- Message key (`mk`) is stored separately under the message id (or `temp_<id>`), also encrypted (`storeMessageKeySecurely`).
- `dr_ratchet_encrypt` returns `{ state, header, ciphertext, mk }`; `dr_ratchet_decrypt` returns `{ state, plaintext, skippedKeys, mk }`.
- Out-of-order messages: skipped keys are stored in state (`skippedKeys` map) encrypted at rest.
- **Own-message decryption:** self messages first try the stored `mk` with `crypto_secretbox_xchacha20poly1305_open_easy`; failure falls back to the DR path (multi-device). If an own message ultimately fails, it is marked `waiting_for_key` (retryable) — never an error bubble.
- **x3dh-until-confirmed (2026-10-05):** the initiator attaches the `x3dh` handshake to **every** message until the first incoming reply decrypts under the current session (`peerSessionConfirmed` in the DR state, maintained client-side — see `web/src/lib/drProtocol.ts`). A lost/expired first message no longer wedges the conversation: the peer can derive from any later message (derivation is deterministic, so re-derive re-syncs to the same chain). The sealed payload also carries `ackKem` (the sender's current `KEMr`), authenticated by the AEAD; the peer records it as `peerAckedKem` and **omits the 1120-byte KEM `ct`** from subsequent headers once the ack matches its current chain. A new chain whose header lacks `ct` is rejected **before any state mutation** (`Missing ratchet key material`) and falls into the archived-session fallback. Recovery for a receiver that lost its state mid-conversation remains `PROTOCOL_RESET` (the confirmed sender no longer re-sends the handshake).

### 4.5.1 Ratchet v2 (braid SPQR) — jalur versi paralel (2026-10-14)

Jalur **v1 di atas tetap beku dan tetap satu-satunya default**. v2 hidup
berdampingan (`docs/33` §33.10) dan hanya dipakai bila **peer membuktikan** bisa
membacanya:

- **Deployment gate (transport):** relay mengiklankan `spqr-ratchet` di
  `SERVER_CAPABILITIES`, klien mengiklankannya juga, dan keduanya bertemu lewat
  negosiasi — **di kedua transport**: sidecar WebTransport lewat HELLO bidi,
  gateway WSS lewat balasan event `capabilities` atas
  `handshake.auth.capabilities` (`server/src/utils/transportCapability.ts`).
  Ini hanya berarti "deployment ini melewatkan frame v2", bukan jaminan tentang
  peer — dan karena kedua relay memakai `SERVER_CAPABILITIES` yang sama, perilaku
  pesan tidak berubah hanya karena transport jatuh ke WSS.
- **Bukti peer (in-band, otentikasi AEAD):** payload ter-seal membawa `ackV: 2`
  (= "versi ratchet yang bisa SAYA buka"). Pengirim baru memakai v2 setelah
  melihat `ackV: 2` dari peer. Klien lama tidak pernah menerima header v2.
- **Apa yang "beku" — dan apa yang tidak (nuansa penting).** Yang beku adalah
  **header wire** v1 (`{ kemPk, ct, n, pn }`) dan primitifnya: klien lama tetap
  membacanya apa adanya. Yang **tidak** beku adalah **isi payload ter-seal**:
  jalur v1 sekarang membawa field tambahan (`ackV`, `ktG`, `ackKem`) yang hanya
  diabaikan klien lama — aditif dan tidak terlihat server. Konsekuensinya:
  payload mendekati batas blok padding 8 KiB bisa naik ke blok berikutnya, jadi
  ukuran paket per pesan boleh berubah tanpa perubahan protokol. Yang dilarang
  tetap sama: mengubah header v1, primitif, atau padding.
- **Header (versi baru, bukan tambalan):**
  - v1: `{ kemPk, ct, n, pn }` — tanpa penanda versi (§4.5).
  - v2: `{ v: 2, b: [frame…] }` — `b` = satu atau lebih frame braid (base64url,
    ≤16 frame, ≤4096 karakter/frame). Tidak ada `kemPk`/`ct` 1120 byte; tidak
    ada `n`/`pn` karena urutan & pesan hilang ditangani braid.
- **Message key** lahir dari `spqr_send`/`spqr_recv` (ML-KEM Braid + erasure
  coding) alih-alih langkah DH+KEM. Sisa jalur **identik v1**: padding 8 KB,
  nonce 24 byte, XChaCha20-Poly1305 → ciphertext di wire sama bentuknya,
  termasuk pemakaian ulang MK (pesan duplikat) lewat MK cache.
- **State berdampingan:** state DR v1 tidak pernah ditimpa (jalur rollback),
  state braid disimpan per sesi di baris `kvStore` terpisah
  (`nyx_spqr_state_v1:*`, ter-seal `ENC1:`) dengan tulis di-koalesensi 250 ms.
  Akar braid = rahasia X3DH (`sk`) yang sama di kedua sisi; disimpan di baris
  state DR sebagai `spqrAuthKey`/`spqrDirection` (juga ter-seal).
- **Rollback:** peer berhenti menyatakan v2 (atau kill switch operator
  `VITE_SPQR_FORCE_V1=1`, dan di build DEV kill switch runtime
  `localStorage['nyx_spqr_force_v1']`) → pengiriman kembali ke v1, state braid
  **dipertahankan** sehingga pesan v2 yang sudah lewat tetap terbaca.
  **Saklar hanya menghentikan kirim + iklan — bukan jalur baca**: menolak membaca
  v2 yang sudah terkirim akan mengubah tindakan operator menjadi kehilangan
  pesan. Bukti dua klien: `web/e2e/spqr.spec.ts` (test "kill switch satu klien").
- **Anti-downgrade arah masuk:** header v2 **tidak pernah** dibaca sebagai v1
  (dan sebaliknya). Tanpa akar braid (sesi yang didirikan sebagai v1) → error
  terlihat, bukan kegagalan diam-diam.

## 4.6 Group sender-key ratchet (v2, libsignal model)

- **Sender state** `{ CK, N, initialCK, chainId, metadataKey, ... }` per conversation; **receiver state** one per `(conversation, senderDeviceKey)` carrying `{CK, N, eraCK, chainId, metadataKey, skippedKeys, signingKey}` — both live in IndexedDB `groupSenderStates` / `groupReceiverStates`, **encrypted at rest** (`ENC1:` prefix in `keychainDb.ts`). Era changes archive the old receiver state (max 5, `#era_<chainId>` ids).
- **Era identity:** `chainId` is a RANDOM 64-bit value minted with each era (`group_init_sender_key` returns `{senderKeyB64, chainIdB64, metadataKeyB64}`) — not derived from the chain key. The `metadataKey` (256-bit) takes group metadata **out of the chain**: metadata v2 = `{v:2, kind:'group_metadata', sigV, chainId, ct (XChaCha), signature, senderDeviceKey, senderKeyId?}` — `sigV: 2` selects ML-DSA-65 (default `1` = Ed25519) and `senderKeyId` appears only when the sender has a v2 signing key (**`senderId` dihapus 2026-10-09**, docs/28 Tier 4: field itu memuat userId penulis dan tidak pernah dipakai reader — routing lewat `chainId`, verifikasi tanda tangan hanya atas byte `ct`; blob v1 — yang dulu membawa `senderId` — tidak lagi ditulis/dibaca, 2026-10).
- `group_ratchet_encrypt` / `group_ratchet_decrypt` / `group_decrypt_skipped` handle the ratchet (skipped message keys live **inside the receiver record**, `sender_message_keys` style). Distribution goes through the single `sendGroupSenderKeyDistribution` path. Wire shapes (`packages/shared/src/groupEnvelope.ts`): **v2** `[0x02][chainId(8)][u32 iter][CK(32)][metadataKey(32)]` = 77 B; **v3** = v2 + `senderKeyId(8)` = 85 B (interim, still accepted); **v4** = v3 + `signingKeyV2(1952)` = 2037 B. The sender writes **v4 when it has `signingV2`**, otherwise **v2**; `senderKeyId` is derived from the ML-DSA public key (`BLAKE2b-256("NYX-PQ-GROUP-V4" ‖ signingKeyV2)[:8]`). v4 carries the verification key inside the envelope so the recipient does not need a bundle lookup before group metadata is decryptable. Every shape is sealed per device via `pq_box_seal_v2`, relayed by `group:fulfilled_key` (client-side fan-out; server is blind). A v3/v4 `senderKeyId` must match the sender's `signingKeyV2`; a mismatch drops the envelope. **v1 (36 B) and v0 (32 B) envelopes are no longer readable** — `handleGroupKeyDistribution` accepts only the v2/v3/v4 shapes and any other length/version byte is dropped **with a warning + a system message + toast in the UI** ([2026-10 legacy purge], `docs/30`; see `docs/29` §5.5). Clients that predate v2 therefore cannot join a new era and their users see it, instead of silently losing group messages. Two mechanisms keep that from staying invisible: a new service worker **forces one page reload per tab per session** (the page otherwise keeps running the old bundle), and the server can refuse too-old clients outright with `426 CLIENT_TOO_OLD` when the operator sets `MIN_CLIENT_VERSION` (`docs/10` §10.14, `docs/12`).

## 4.7 Burner protocol (PQ-DR)

- Guest/host handshake (`burner_dr_init_guest` / `burner_dr_init_host`) then `burner_dr_encrypt` / `burner_dr_decrypt`. Room keys are exchanged via the `burner:*` socket events; rooms can be terminated by the host (`burner:terminated:<roomId>` Redis flag).

## 4.8 At-rest encryption (`ENC1:`)

IndexedDB keychain values are wrapped: `"ENC1:" + base64url(worker_encrypt_session_key(bytes, masterSeed))`.

- Applied to: group chain keys, group skipped keys, story keys, 1:1 braid (v2) state rows `nyx_spqr_state_v1:*` (and 1:1 ratchet/session/message keys use the same primitive via their own helpers).
- Legacy plaintext values are still readable; `migrateKeychainAtRestEncryption()` (triggered on unlock via `saveDeviceAutoUnlockKey`) rewrites them.
- `decryptValueAtRest` returns the value unchanged when it lacks the prefix (legacy), `null` when decryption fails.
- **Fail-closed on write** ([audit D7, 2026-10-27]): `encryptValueAtRest` **throws** `AtRestSealUnavailableError` when `masterSeed` is unavailable, and lets worker errors propagate; it never returns the plaintext. Callers must skip the write (or let the error abort that row) — the `sealLocal*` helpers in `localAtRest.ts` inherit this, so a locked vault means the structural field is **absent**, not plaintext. Rows written before this change (and legacy plaintext imported from older builds) remain readable; the migration on unlock seals them when the vault is open. `saveKtIdentifier` and `upsertContact` skip their write with a warning instead of downgrading.

## 4.9 Attachment encryption

- `file_encrypt`: secretstream — output = `header || chunk(1MB)…` with `TAG_FINAL` on the last chunk. Output size = `header + sourceLength + numChunks × ABYTES`; the worker allocates once and streams (no full-file accumulation).
- `file_decrypt` reverses it. Keys are random 32-byte values delivered inside the E2EE message metadata.

## 4.10 Traffic cover

- Every user message is padded to **8192 bytes** before encryption (`PADDING_BLOCK_SIZE`) to defeat size analysis — jalur v2 memakai padding yang sama (hanya penghasil message key yang berbeda). Field payload baru yang aditif (`ackV`/`ktG`/`ackKem`, §4.5.1) ikut masuk ke blok yang sudah dipad ini, bukan ke header wire.
- Idle WebTransport connections emit 1000-byte random datagrams every ~3s (`CHAFF` opcode 0x00 — ignored by the sidecar). Real frames are never delayed by chaff.

## 4.11 Worker operation catalog (50 ops)

| Op | Purpose |
|---|---|
| `DERIVE_KEY` | Argon2id KEK from password + salt |
| `ENCRYPT_DATA` / `DECRYPT_DATA` | Private-key bundle wrap/unwrap |
| `registerAndGenerateKeys` / `retrievePrivateKeys` / `restoreFromPhrase` / `recoverAccountWithSignature` / `getRecoveryPhrase` / `reEncryptBundleFromMasterKey` | Identity lifecycle (BIP39 phrase → keys; mints `signingV2`) |
| `ml_dsa_keygen` / `ml_dsa_get_public_key` / `ml_dsa_sign` / `ml_dsa_verify` | ML-DSA-65 primitives (PQ v2 signatures) |
| `generateSafetyNumber` | Safety-number fingerprint |
| `hashUsername` | Blind index (Argon2id 64MB) |
| `minePoW` | Proof-of-work puzzle |
| `crypto_secretbox_xchacha20poly1305_easy/_open_easy` | Raw AEAD primitive |
| `xchacha_seal/_open` | **Canonical envelope** (§4.2) |
| `pq_box_seal_v2/_open` | X-Wing hybrid sealing |
| `x3dh_v2_initiator` / `x3dh_v2_recipient` / `x3dh_v2_recipient_regenerate` | PQX3DH v2 handshake (§4.4) |
| `dr_init_alice` / `dr_init_bob` / `dr_ratchet_encrypt` / `dr_ratchet_decrypt` | Double Ratchet (v1, beku) |
| `spqr_ratchet_init` / `spqr_ratchet_encrypt` / `spqr_ratchet_decrypt` | Ratchet v2 (braid SPQR, §4.5.1) |
| `group_init_sender_key` / `group_ratchet_encrypt` / `group_ratchet_decrypt` / `group_decrypt_skipped` | Group ratchet |
| `burner_dr_init_guest` / `burner_dr_init_host` / `burner_dr_encrypt` / `burner_dr_decrypt` | Burner PQ-DR |
| `file_encrypt` / `file_decrypt` | Attachments |
| `encryptProfile` / `decryptProfile` / `generateProfileKey` | Profile blobs |
| `encrypt_session_key` / `decrypt_session_key` | At-rest key wrapping |
| `generate_otpk_batch` | One-time prekeys |
| `generate_random_key` | Random 32B keys |
| `panic_hash` | Panic-password hash |

## 4.12 Worker proxy contract

- Requests: `{ id: uuid, type, payload }` via `postMessage`; payloads use typed arrays and **transferables** where safe (responses always transfer top-level buffers). `ENCRYPT_DATA` is the exception: its frozen bundle JSON carries `number[]` by design (§4.3).
- Responses: `{ id, success, result | error }`. Pending requests have timeouts (120s default; 600s file ops; 300s PoW) — a hung worker rejects instead of hanging the caller.
