# NYX: The Zero-Knowledge Messenger

> **"Privacy is not a feature. It's the architecture."**

![NYX Banner](https://nyx-app.my.id/assets/nyx.png)

NYX is a radical experiment in **Pure Anonymity** and **Zero-Knowledge Architecture**. Unlike Signal or Telegram, NYX **does not require** a phone number or email address. It decouples your digital identity from your physical one, operating under a strict "Trust No One" (TNO) model where the server is mathematically incapable of reading your messages or knowing who you are.

---

## 🏴☠️ Core Philosophy: Pure Anonymity

1.  **No PII Storage:** We do not store emails, phone numbers, IP addresses (hashed), or even usernames in plaintext.
2.  **Blind Indexing:** Your username is hashed client-side (Argon2id). The server only sees a random hash (`usernameHash`) and cannot reverse it to find your real handle.
3.  **Profile Encryption:** Your name, bio, and avatar are encrypted locally with a symmetric `ProfileKey`. This key is shared *only* with friends via the Double Ratchet header. To the server, your profile is just a blob of ciphertext.
4.  **Local-First Sovereignty:** Your chat history lives **exclusively** on your device (IndexedDB). We provide a "Vault" export feature for backups, but we never sync plaintext history to the cloud.

---

## 🛡️ Security Architecture

### Cryptography (The Signal Protocol Implementation)
*   **Key Exchange:** X3DH (Extended Triple Diffie-Hellman) for asynchronous key agreement.
*   **Message Encryption:** Double Ratchet Algorithm for Perfect Forward Secrecy (PFS) and Post-Compromise Security (PCS).
*   **Primitives:**
    *   **Cipher:** XChaCha20-Poly1305 (IETF) via `libsodium`.
    *   **Hashing:** SHA-256 & BLAKE2b.
    *   **KDF:** HKDF (HMAC-based Key Derivation Function).
    *   **Signatures:** Ed25519.

### Trust-Tier System (Anti-Spam)
To prevent bot spam without collecting phone numbers, we use a **Proof-of-Humanity** system:
1.  **Sandbox Mode (Default):** New accounts are rate-limited (5 msgs/min, no groups).
2.  **VIP Status (Verified):** Unlocked via:
    *   **Biometric (WebAuthn):** Instant verification via Fingerprint/FaceID.
    *   **Proof of Work (PoW):** Solve a client-side cryptographic puzzle (SHA-256 mining) to prove computational cost.

---

## ⚡ Tech Stack

### Frontend (Client)
*   **Framework:** React 18 + Vite (TypeScript)
*   **State:** Zustand (with Persist middleware)
*   **Crypto:** `libsodium-wrappers` + Web Crypto API (running in a dedicated **Web Worker**)
*   **Storage:** IndexedDB (`idb-keyval`) for "The Vault" (Keys & Messages)
*   **UI:** Tailwind CSS v3 (Industrial Neumorphism Design)

### Backend (Server)
*   **Runtime:** Node.js (Express)
*   **Database:** PostgreSQL (via Prisma ORM)
*   **Real-time:** Socket.IO (with Redis Adapter for clustering)
*   **Caching/Queue:** Redis (Rate limiting, Presence, PoW Challenges)
*   **Object Storage:** Cloudflare R2 (Encrypted binary blobs only)

---

## 🚀 Getting Started

### Prerequisites
*   Node.js v18+
*   pnpm (Preferred)
*   PostgreSQL
*   Redis

### 1. Clone & Install
```bash
git clone https://github.com/your-username/nyx-chat.git
cd nyx-chat
./start-dev.sh # Installs dependencies for both server & web
```

### 2. Environment Setup
Create a `.env` file in the `server/` directory:

```env
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/nyx_db"
REDIS_URL="redis://localhost:6379"

# Security Secrets (Generate strong random strings!)
JWT_SECRET="super-long-random-string-min-32-chars"
COOKIE_SECRET="another-super-long-random-string"

# Cloudflare R2 (For encrypted attachment storage)
R2_ACCOUNT_ID="your-cf-account-id"
R2_ACCESS_KEY_ID="your-r2-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret"
R2_BUCKET_NAME="nyx-uploads"
R2_PUBLIC_DOMAIN="https://pub-r2.yourdomain.com"

# Cloudflare Turnstile (Optional - Anti-bot)
TURNSTILE_SECRET_KEY="your-turnstile-secret"

# App Config
PORT=4000
CORS_ORIGIN="http://localhost:5173"
NODE_ENV="development"
```

### 3. Database Migration
```bash
cd server
npx prisma migrate dev --name init
```

### 4. Run Development
```bash
# In root directory
./start-dev.sh
```
*   Frontend: `http://localhost:5173`
*   Backend: `http://localhost:4000`

---

## 💾 The "NYX Vault" & Migration

Since there is no cloud history sync, NYX provides tools for you to manage your own data:

1.  **Export Vault:** In *Settings*, you can export a `.nyxvault` file. This contains your encrypted keys and conversation metadata.
2.  **Device Migration Tunnel:** Moving to a new phone? Use the **Transfer to New Device** feature. It opens a direct, encrypted WebSocket tunnel between your old and new device to transfer your entire history via QR code, without ever storing it on our servers.

---

## 🤝 Contributing

We welcome contributions, especially in:
*   **Crypto Analysis:** Audit our `crypto.worker.ts` implementation.
*   **Performance:** Optimization of the React render cycle for large chat lists.
*   **Accessibility:** Improvements to screen reader support.

Please follow the `conventional-commits` format for PRs.

---

## 📄 License

MIT License. Built for the community, owned by no one.
