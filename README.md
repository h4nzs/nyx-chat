# NYX: The Zero-Knowledge Messenger

![Version](https://img.shields.io/badge/version-1.2.0--alpha-blue?style=for-the-badge)
![License](https://img.shields.io/badge/License-AGPLv3-red?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Tailwind](https://img.shields.io/badge/Tailwind_v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?style=for-the-badge&logo=pnpm&logoColor=white)

> **"Privacy is not a feature. It's the architecture."**

NYX is a radical experiment in **Pure Anonymity** and **Zero-Knowledge Architecture**. Unlike traditional messengers, NYX **does not require** a phone number, email address, or any Personally Identifiable Information (PII). It decouples your digital identity from your physical one, operating under a strict "Trust No One" (TNO) model where the server is mathematically incapable of reading your messages or knowing who you are.

---

## 🏴‍☠️ Core Philosophy: Pure Anonymity

1. **No PII Storage:** We do not store emails, phone numbers, IP addresses, or plaintext usernames.
2. **Blind Indexing:** Your username is hashed client-side (Argon2id). The server only sees a random hash (`usernameHash`) and cannot reverse it.
3. **Ghost Profiles:** Your name, bio, and avatar are encrypted locally with a symmetric `ProfileKey`. This key is shared *only* with trusted contacts via the Double Ratchet header. To the server, your profile is an indecipherable blob.
4. **Local-First Sovereignty:** Your chat history lives **exclusively** on your device's IndexedDB. We never sync plaintext history to the cloud.

---

## 🛡️ Security Architecture

### Cryptography (The Signal Protocol Implementation)

NYX runs its cryptographic engine entirely inside a dedicated **Web Worker** using WebAssembly, ensuring the main UI thread is never blocked during heavy encryption cycles.

* **Key Exchange:** X3DH (Extended Triple Diffie-Hellman) for asynchronous key agreement.
* **Message Encryption:** Double Ratchet Algorithm for Perfect Forward Secrecy (PFS) and Post-Compromise Security (PCS).
* **Primitives:**
* **Cipher:** XChaCha20-Poly1305 (IETF) via `libsodium`.
* **Hashing:** SHA-256 & BLAKE2b.
* **KDF:** HKDF (HMAC-based Key Derivation Function).
* **Signatures:** Ed25519.



### Trust-Tier System (Anti-Spam)

To prevent bot swarms without collecting phone numbers, we employ a **Proof-of-Humanity** system:

1. **Sandbox Mode (Default):** New accounts are rate-limited and restricted.
2. **VIP Status (Verified):** Unlocked via WebAuthn (Biometrics/FIDO2) or solving client-side cryptographic puzzles (Proof-of-Work).

---

## ⚡ The 2026 Tech Stack (Total Overhaul)

We recently underwent a nuclear dependency upgrade to ensure NYX is future-proofed for the next decade.

### Frontend (Client)

* **Framework:** React 19 Ready + Vite 7 (TypeScript)
* **State Management:** Zustand v5 (Strict Mode + Persist middleware)
* **Styling:** Tailwind CSS v4 (Rust-powered Lightning CSS engine)
* **Crypto Engine:** `libsodium-wrappers` (Pinned at v0.8.x for backward compatibility)
* **Storage:** IndexedDB (`idb-keyval`) for "The Shadow Vault"

### Backend (Server)

* **Runtime:** Node.js (Express)
* **Database:** PostgreSQL via **Prisma ORM v7** (Rust-free, Native ESM with `@prisma/adapter-pg`)
* **Real-time:** Socket.IO v4.8+ (Redis Adapter for clustering)
* **Object Storage:** Cloudflare R2 (Encrypted binary blobs only)

---

## 🚀 Deployment & Infrastructure

NYX is designed for high-security, zero-trust deployments.

**Zero-Inbound Policy:** Our production reference architecture completely disables inbound firewall ports (except SSH). All traffic is securely routed through **Cloudflare Tunnels** directly to localhost ports (3000 for PWA, 4000 for API/Socket).

### Local Development Quick Start

*Prerequisites: Node.js 20+, `pnpm`, PostgreSQL, Redis.*

```bash
git clone https://github.com/your-username/nyx-chat.git
cd nyx-chat
pnpm install # Installs dependencies for the workspace

```

**Environment Variables (`server/.env`):**

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/nyx_db"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="super-long-random-string-min-32-chars"
# Cloudflare R2 Config...

```

**Run Development:**

```bash
cd server && npx prisma db push
pnpm dev # (Assuming you set up a root script, or run individually in /web and /server)

```

---

## 💾 The "NYX Vault" & Device Migration

Because we don't sync history to the cloud, YOU own your data:

1. **Vault Export:** Export an encrypted `.nyxvault` file containing your keys and metadata.
2. **Device Migration Tunnel:** Moving to a new phone? NYX opens a direct, E2EE WebSocket tunnel between your old and new device to transfer your history via QR code. The server acts only as a blind relay.

---

## 🤝 Contributing

NYX is an open-source fortress, and we welcome operatives to inspect the walls.

* **Strict Rule:** Do NOT update or touch `libsodium-wrappers`. Cryptographic backward compatibility is our highest priority.
* **Linting:** We strictly enforce ESLint v10 (Flat Config). Ensure `pnpm run build` passes with zero warnings before opening a PR.

Please check the `CONTRIBUTING.md` and use the provided PR templates.

---

## ⚖️ License & Commercial Use

NYX is licensed under the **GNU AGPLv3 License**.

**What this means:** You are free to use, modify, and distribute this software. However, if you modify NYX and run it as a public service (SaaS), you **must** release your modified source code to your users under the same AGPLv3 license.

**Dual Licensing:** If you are a corporation looking to use NYX's engine in a closed-source, proprietary, or commercial product without triggering the AGPLv3 copyleft provisions, you must obtain a commercial license. Contact the repository owner for enterprise licensing.
