# NYX

<p align="center">
  <img src="./web/public/nyx.png" width="250" alt="NYX Logo">
</p>
<h1 align="center">Zero-Knowledge Post-Quantum Hardened Messenger</h1>

<p align="center">
  <a href="https://nyx-app.my.id"><strong>🌐 Access the Official Web Client: nyx-app.my.id</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.6.1-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-AGPLv3-red?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="Typescript">
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Tailwind_v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind">
  <img src="https://img.shields.io/badge/pnpm-F69220?style=for-the-badge&logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/Post--Quantum-Ready-8A2BE2?style=for-the-badge" alt="Post-Quantum Ready">
</p>

> **"Privacy is not a feature. It's the architecture."**

NYX is a radical experiment in **Pure Anonymity** and **Zero-Knowledge Architecture**, now hardened against future quantum computing threats. Unlike traditional messengers, NYX **does not require** a phone number, email address, or any Personally Identifiable Information (PII). It decouples your digital identity from your physical one, operating under a strict "Trust No One" (TNO) model where the server is mathematically incapable of reading your messages or knowing who you are.

---

## 🏴‍☠️ Core Philosophy: Pure Anonymity

1. **No PII Storage:** We do not store emails, phone numbers, IP addresses, or plaintext usernames.
2. **Blind Indexing (Memory-Hard):** Your username is hashed client-side using Argon2id (64MB memory cost). The server only sees a random hash (`usernameHash`) and cannot reverse it, protecting against offline brute-force attacks.
3. **Ghost Profiles:** Your name, bio, and avatar are encrypted locally with a symmetric `ProfileKey`. This key is shared *only* with trusted contacts via secure E2EE payloads. To the server, your profile is an indecipherable blob.
4. **Local-First Sovereignty:** Your chat history lives **exclusively** on your device's IndexedDB. We never sync plaintext history to the cloud.

---

## 🛡️ Security Architecture (Post-Quantum Upgrade)

NYX runs its cryptographic engine entirely inside a dedicated **Web Worker** using WebAssembly, ensuring the main UI thread is never blocked during heavy encryption cycles.

### Strict Post-Quantum Cryptography
To protect against "Harvest Now, Decrypt Later" attacks by future quantum computers, NYX operates in a **Mandatory Post-Quantum Mode** (rejecting classical-only downgrades). It employs a strict cryptographic architecture:

* **Key Exchange (Strict PQX3DH):** Combines classical X25519 with **ML-KEM-768 (Kyber / X-Wing)** for asynchronous key agreement. This establishes the initial quantum-resistant shared secrets between devices.
* **Message Encryption & Distribution:** Universal **Client-Side Fan-Out Sender Key Protocol** (XChaCha20-Poly1305) for all chats. While the message payloads use symmetric ratcheting (which is naturally quantum-resistant), the critical **distribution of these session keys** to group members is secured using the **PQX3DH channels and ML-KEM encapsulation (PQ-Seals)**. The server acts purely as a **Blind Relay**, routing opaque ciphertext blobs without ever seeing plaintext keys.
* **Hardware-Bound Local Vault:** Your master seed and recovery phrases are encrypted locally using **WebAuthn PRF (Biometric Binding)** stretched through an Argon2id KDF (128MB memory cost), ensuring keys cannot be extracted even if the device storage is physically compromised.
* **Primitives:**
  * **Cipher:** XChaCha20-Poly1305 (IETF)
  * **KEM:** ML-KEM-768 (via X-Wing construct)
  * **Hashing:** BLAKE2b (512-bit) & Argon2id
  * **Signatures:** Ed25519

### Trust-Tier System (Anti-Spam)

To prevent bot swarms without collecting phone numbers, we employ a **Proof-of-Humanity** system:

1. **Sandbox Mode (Default):** New accounts are rate-limited and restricted.
2. **VIP Status (Verified):** Unlocked via WebAuthn (Biometrics/FIDO2) or by solving client-side, quantum-resistant **BLAKE2b Proof-of-Work** puzzles.

---

## ⚡ The 2026 Tech Stack

We recently underwent a dependency upgrade to ensure NYX is future-proofed for the next decade.

### Frontend (Client)

* **Framework:** React 19 Ready + Vite 8 (TypeScript)
* **State Management:** Zustand v5 (Strict Mode + Persist middleware)
* **Styling:** Tailwind CSS v4 (Rust-powered Lightning CSS engine)
* **Crypto Engine:** `libsodium-wrappers` (Pinned at v0.8.3+ for Native X-Wing/PQC Support)
* **Storage:** IndexedDB (`dexie`) for "The Unified Shadow Vault"

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

*Prerequisites: Node.js 22+, `pnpm`, PostgreSQL, Redis.*

```bash
git clone [https://github.com/h4nzs/nyx-chat.git](https://github.com/h4nzs/nyx-chat.git)
cd nyx-chat
pnpm install # Installs dependencies for the workspace
````

**Environment Variables (`server/.env`):**

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/nyx_db"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="super-long-random-string-min-32-chars"
# Cloudflare R2 Config...
# And more, see (.env.example)
```

**Run Development:**

```bash
cd server && npx prisma db push
pnpm dev # (Assuming you set up a root script, or run individually in /web and /server but dont forget to build the shared package first in ./packages/shared to avoid any error when setting up for the first time)
```

---

## 💾 The "Shadow Vault" & Multi-Device Sync

Because we don't sync history to the cloud, YOU own your data:

1.  **Vault Export:** Export an encrypted `.nyxvault` file containing your keys and metadata.
2.  **Post-Quantum History Sync:** Moving to a new phone or linking a web client? NYX encrypts your IndexedDB history with a symmetric key and distributes the key via the PQ-Sender Key protocol to your other devices. The server acts only as a blind relay for the encrypted blob.

---

## 🤝 Contributing

NYX is an open-source fortress, and we welcome operatives to inspect the walls.

  * **Strict Rule:** Do NOT update or touch `libsodium-wrappers` unless upgrading specifically for newer PQC primitives. Cryptographic backward compatibility is our highest priority.
  * **Linting:** We strictly enforce ESLint v10 (Flat Config). Ensure `pnpm run build` passes with zero warnings before opening a PR (except unused-var can be ignored).

Please check the `CONTRIBUTING.md` and use the provided PR templates.

---

## 👨‍💻 Author

**Han**
*Creator & Lead Architect of NYX*

  - 🐙 GitHub: [@h4nzs](https://github.com/h4nzs)
  - 🌐 Website: [portfolio](https://h4nzs.github.io/portofolio)

## ✨ Contributors

NYX wouldn't be the fortress it is today without the support and code from our open-source community. Thank you to everyone who has helped build and secure this project!

<a href="https://github.com/h4nzs/nyx-chat/graphs/contributors">
<img src="https://contrib.rocks/image?repo=h4nzs/nyx-chat" alt="NYX Contributors"/>
</a>

> **Want to join the ranks?** Check out the [Contributing Guide](CONTRIBUTING.md) to get started\!

---

## ⚖️ License & Commercial Use

NYX is distributed under the **[AGPL-3.0 License](LICENSE)**.

This guarantees that NYX remains free and open-source for the community. However, network use (SaaS) of this software requires you to open-source your entire project.

**What this means:** You are free to use, modify, and distribute this software. However, if you modify NYX and run it as a public service (SaaS), you **must** release your modified source code to your users under the same AGPLv3 license.

**🏢 Building a Closed-Source SaaS?**
If you are a corporation, startup, or enterprise looking to integrate NYX into a proprietary product without the AGPL-3.0 obligations, you must acquire a Commercial License.
👉 **[Read the Commercial Licensing Guide here](COMMERCIAL.md)**.

---

## 🌙 Branding & Anti-Impersonation Policy

While the term "NYX" may be used broadly in various contexts, the **specific visual identity, custom logos, and the direct reputation of this specific repository** are the intellectual property of the core maintainer.

The AGPL-3.0 license grants you the freedom to use, modify, and distribute the source code. However, it **does not** grant you the right to impersonate this official project.

If you fork this repository to create your own SaaS, enterprise tool, or public deployment, you must:

1.  **Change the visual identity:** Replace all official logos, icons, and specific graphic assets found in `web/public/`.
2.  **Prevent confusion:** Clearly state that your deployment is a modified fork and is *not* affiliated with or officially endorsed by the original NYX Command repository.

---

<div align="center">

<pre>
███╗   ██╗██╗   ██╗██╗  ██╗
████╗  ██║╚██╗ ██╔╝╚██╗██╔╝
██╔██╗ ██║ ╚████╔╝  ╚███╔╝
██║╚██╗██║  ╚██╔╝   ██╔██╗
██║ ╚████║   ██║   ██╔╝ ██╗
╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝
</pre>

**ZERO-KNOWLEDGE POST-QUANTUM MESSENGER** *License: AGPL-3.0 (Commercial Dual-License Available)*

</div>
