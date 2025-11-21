# E2EE Web Architecture – Final Draft

## 1. Overview
This document outlines the final architecture for implementing end-to-end encryption (E2EE) in a web-based messaging application. The goal is to achieve a security model comparable to native apps (WhatsApp, Signal) while adapting to browser limitations.

---

## 2. Core Principles
- **Client-side key generation**: All encryption keys originate and stay in the user's device.
- **Zero-knowledge server**: Server only handles encrypted payloads and metadata required for delivery. It never sees plaintext messages or keys.
- **Secure device linking**: Additional devices must import keys through QR-based transfer or WebAuthn-based verification.
- **Forward secrecy**: Sessions use ephemeral keys and periodic ratcheting (Double Ratchet or simplified per-message ECDH).
- **Encrypted storage**: LocalStorage/IndexedDB stores keys encrypted with a user-derived key.

---

## 3. Key Components

### 3.1 Identity Key Pair (Long Term)
- Generated once per user.
- Used for device trust + initial key exchange.
- Stored locally, encrypted with a password-derived key.
- Synced across devices only via secure QR link.

### 3.2 Signed Prekey & One‑Time Prekeys
- Posted to server for others to initiate secure sessions.
- Rotated periodically.
- Server never sees private components.

### 3.3 Session Keys
- Established through X3DH-like handshake.
- Each conversation maintains a ratchet state.
- Only ephemeral public keys touch the server.

---

## 4. Message Flow

### 4.1 Sending Message
1. User types message.
2. Client loads conversation ratchet state.
3. Derives message key.
4. Encrypts:
   - **Text/Media payload**
   - **Attachment metadata**
5. Uploads encrypted attachment blob if needed.
6. Sends encrypted message JSON to server via WebSocket.

### 4.2 Receiving Message
1. WebSocket receives encrypted payload.
2. Client identifies conversation.
3. Ratchet step executed → derive decrypt key.
4. Payload decrypted and rendered.

---

## 5. Multi‑Device Architecture

### 5.1 Primary Device
Stores master keys (identity + prekeys).

### 5.2 Secondary Devices
Join via:
- **QR Code Link**: Primary device encrypts and shares master keys.
- **WebAuthn Identity Unlock**: Uses hardware token (TPM/Passkey) to unlock encrypted local keystore.
- **Optional password**: Used only for local key encryption, not server authentication.

### 5.3 Device Sync
Devices sync:
- Prekeys
- Ratchet sessions
- Conversation metadata (encrypted)

Server only stores:
- Public identity key
- Prekeys
- Device list
- Encrypted conversation metadata blobs

---

## 6. File/Attachment Encryption
- Each file is encrypted with a random **file key** (AES-GCM).
- File key itself is encrypted with the recipient's session key.
- Browser uploads only encrypted files; server never sees plaintext.

---

## 7. Push Notifications (Optional)
- Web Push is not E2EE by default.
- Payload is limited to metadata or encrypted blob.
- Notification content decrypted only when client opens the app.

---

## 8. Authentication & Security

### 8.1 Login Approaches
- **Passwordless via WebAuthn** (preferred).
- **Classic password** only for encrypt/decrypt keystore.

### 8.2 Token Architecture
- Server issues JWT for WebSocket & REST.
- Tokens never store private keys.

⮕ WebAuthn + QR link eliminates the need for repeating passwords like older E2EE web models.

---

## 9. Limitations of Web Compared to Native
- No access to secure hardware keystore unless using WebAuthn.
- Browsers may clear storage (incognito, storage eviction).
- Background sync limited → may affect ratchet state catch-up.
- Push notifications require service workers with constraints.

---

## 10. Summary
This architecture provides:
- Strong E2EE with forward secrecy
- Multi-device support like WhatsApp Web + Sessions
- Modern authentication via WebAuthn
- Secure attachment handling
- Zero-knowledge message server

This draft is ready for implementation review and further optimization.
