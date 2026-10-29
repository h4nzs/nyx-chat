# NYX

<p align="center">
  <img src="./web/public/nyx.png" width="250" alt="NYX Logo">
</p>
<h1 align="center">Zero-Knowledge Post-Quantum Hardened Messenger</h1>

<p align="center">
  <a href="https://nyx-app.my.id"><strong>🌐 Access the Official Web Client: nyx-app.my.id</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.0-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-AGPLv3-red?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="Typescript">
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Tailwind_v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind">
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/pnpm-F69220?style=for-the-badge&logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/Post--Quantum-Ready-8A2BE2?style=for-the-badge" alt="Post-Quantum Ready">
</p>

> **"Privacy is not a feature. It's the architecture."**

NYX is a radical experiment in **Pure Anonymity** and **Zero-Knowledge Architecture**, hardened against future quantum computing threats. Unlike traditional messengers, NYX **does not require** a phone number, email address, or any Personally Identifiable Information (PII). It decouples your digital identity from your physical one, operating under a strict "Trust No One" (TNO) model: the server is a **blind relay** that is designed to be unable to read your messages, your profile, or your social graph.

NYX treats the server as an honest-but-curious (and sometimes actively malicious) observer, and treats a **stolen database dump** as a first-class threat — see [DB-dump threat model](docs/28-db-dump-threat-model.md).

---

## 🏴‍☠️ Core Philosophy: Pure Anonymity

1. **No PII Storage:** No emails, phone numbers, or plaintext usernames. Raw IP addresses are never written to the database; where abuse limiting needs a network signal, it uses **peppered HMAC tags** (IP, installation, ASN) that cannot be reversed from a dump.
2. **Blind Indexing (Memory-Hard):** Your username is hashed client-side with Argon2id (64 MB memory cost). The server stores only a peppered form of that hash (`HMAC(pepper, usernameHash)`, pepper kept outside the database) and cannot reverse it — a dump alone cannot be used to build a rainbow table.
3. **Ghost Profiles:** Your name, bio, and avatar are encrypted locally with a symmetric `ProfileKey`, shared *only* with trusted contacts through E2EE payloads. To the server, your profile is an opaque blob.
4. **Local-First Sovereignty:** Your chat history lives on your device (IndexedDB "Shadow Vault"). Ciphertext is relayed and kept server-side only briefly (≤ 14 days); plaintext history is never synced to the cloud.
5. **Sealed Metadata:** Sender identity, delivery receipts, hidden-conversation routing, story authors, and block relations are stored as **opaque, domain-separated tags or sealed blobs** rather than user IDs. Redis keys use identity tags instead of real user IDs, and presence is **per-contact and opt-in** (no global "who is online" roster).

---

## 🛡️ Security Architecture

NYX runs its cryptographic engine inside a dedicated **Web Worker** (libsodium + WebAssembly), so the UI thread is never blocked by heavy encryption.

### Strict Post-Quantum Cryptography

To resist "Harvest Now, Decrypt Later" attacks, NYX operates in a **Mandatory Post-Quantum Mode** (classical-only downgrades are rejected):

* **Key Exchange (PQX3DH):** classical X25519 combined with **ML-KEM-768 via the X-Wing construct** for asynchronous key agreement.
* **1:1 Ratchet:** a hybrid Double Ratchet with PQ forward secrecy from the KEM step. A parallel **ratchet v2 built on Signal's SPQR (ML-KEM Braid)** adds **post-compromise security** on top; it is only used **after the peer proves it can read it**, and the v1 path stays frozen and readable. A kill switch stops sending v2 without ever breaking reading of v2 messages.
* **Groups:** client-side fan-out **Sender Key** ratchet (XChaCha20-Poly1305). Sender keys are distributed over per-device PQ-sealed channels (`pq_box_seal`), group metadata is kept out of the chain, and group senders appear under **pseudonyms**. The server only routes opaque blobs.
* **Key Transparency (KT):** public keys are published to a Signal-style KT log. The client verifies **inclusion/consistency proofs in WebAssembly** before pinning a peer's key bundle, runs a **monitor loop** against its own entries, and shares tree heads through **gossip** to detect split-view attacks. An auditor service runs as a separate process (independent *process*, not independent organization — see [docs/34](docs/34-key-transparency-verifier.md)). An ML-DSA-65 log v2 runs alongside as **dual-write**; verification and reads still use v1.
* **Hardware-Bound Local Vault:** master seed and recovery phrase are encrypted locally with **WebAuthn PRF (biometric binding)** stretched through Argon2id (128 MB memory cost). Keys at rest use a versioned `ENC1:` envelope.
* **Traffic cover:** every message is padded to 8 KB, and idle WebTransport connections emit random chaff datagrams.

| Primitive | Choice |
|---|---|
| Symmetric cipher | XChaCha20-Poly1305 (IETF); attachments via libsodium secretstream |
| KEM | ML-KEM-768 (X-Wing) |
| Hashing / KDF | BLAKE2b, Argon2id |
| Signatures | Ed25519 |
| 1:1 ratchet | Double Ratchet (hybrid PQ) · SPQR ML-KEM Braid (v2) |
| Groups | Sender-Key ratchet with PQ-sealed distribution |

The wire/storage formats are **frozen** compatibility contracts — see [Crypto Protocol](docs/04-crypto-protocol.md).

### Trust Tiers & Anti-Abuse (no PII)

To resist bot swarms without phone numbers:

1. **Sandbox (default):** rate-limited and restricted.
2. **Verified:** unlocked via WebAuthn (biometrics/FIDO2) **or** a client-side **Argon2id proof-of-work** puzzle with escalating difficulty.
3. **Subscriber:** paid tier, **crypto-only** (no fiat rail, so no financial paper trail).

Registration is additionally guarded by tiered counters per source, installation, and network (ASN, from a local table — no third-party lookup). Suspicious bursts **require device attestation**, verified against a **pinned root bundle** (`ops/attestation/`), with strict verification on by default.

### Calls & Burner Chats

* **Calls:** WebRTC with self-hosted **coturn** (time-limited HMAC credentials); signaling goes through short-lived **relay tokens** instead of real user IDs.
* **Burner Chats:** anonymous, RAM-only, post-quantum encrypted one-off conversations — a registered host shares a link, a guest joins without an account, and everything vanishes on destroy.

---

## ⚡ Tech Stack

### Frontend (Client) — `web/`

* **Framework:** React 19 + Vite 8 (TypeScript 7, strict)
* **State:** Zustand v5
* **Styling:** Tailwind CSS v4
* **Real-time:** native **WebTransport** in a dedicated Web Worker, with a Socket.IO WebSocket gateway as the second relay path
* **Crypto engine:** `libsodium-wrappers` (X-Wing/PQC support) + Rust-compiled **WASM** modules (`spqr-wasm`, `keytrans-wasm-v2`, `pir-wasm`) loaded lazily
* **Storage:** IndexedDB via `dexie` ("Unified Shadow Vault"), OPFS for encrypted attachment cache
* **PWA & i18n:** service worker (precache only), four languages (`en`, `es`, `id`, `pt-BR`)

### Backend — `server/`

* **API:** Node.js 24 + Express 5 (ESM TypeScript)
* **Transport sidecar:** **Rust** (`wtransport`) handling WebTransport streams, bridged to Node over **Redis pub/sub**
* **Key Transparency service:** **Go** (`server/kt-query`) — sole owner of the KT log database (LevelDB), serving reads and writes, plus a separate auditor binary
* **Database:** PostgreSQL via **Prisma 7** (`@prisma/adapter-pg`)
* **Cache / bridge / rate limits:** Redis (atomic Lua counters)
* **Object storage:** Cloudflare R2 (encrypted blobs only: attachments, optional cloud backup, KT snapshots)
* **Calls:** coturn · **Anti-bot:** Cloudflare Turnstile + PoW + device attestation

### Shared & other packages

| Path | Purpose |
|---|---|
| `packages/shared` | `@nyx/shared` — types, Zod schemas (jitless), opcodes, capability list |
| `packages/spqr-wasm` | WASM wrapper for the `spqr` ratchet crate |
| `packages/keytrans-wasm-v2` | WASM wrapper for the ML-DSA-65 KT verifier (`packages/keytrans-v2`) |
| `tools/dr-oracle` | Go oracle (no libsodium) that cross-checks X3DH/KEM/KDF/AEAD vectors |
| `marketing/` | Astro static site (independent of `web/`) |
| `ops/` | Prometheus rules, Alertmanager→ntfy relay, Grafana dashboard, systemd units, attestation roots |

```
nyx-chat/
├── web/                 # React PWA client + Playwright E2E
├── server/
│   ├── src/             # Express API, Redis bridge, jobs
│   ├── transport-sidecar/   # Rust WebTransport sidecar
│   ├── kt-query/        # Go Key Transparency v2 log + auditor
│   └── prisma/          # schema
├── packages/            # shared, spqr-wasm, keytrans-wasm-v2, pir-wasm
├── vendor/signal/       # vendored Signal sources (unmodified)
├── tools/  scripts/  ops/  docs/  marketing/
```

---

## 🚀 Local Development Quick Start

*Prerequisites: Node.js 24, `pnpm` 11.4.0 (pinned via `packageManager`), PostgreSQL 16+, Redis 6+. Rust (stable) is only needed for the WebTransport sidecar; Go only for the KT service and oracle.*

```bash
git clone https://github.com/h4nzs/nyx-chat.git
cd nyx-chat
pnpm install --frozen-lockfile

# 1. Build the shared package FIRST (web/server consume it from dist/)
pnpm --filter @nyx/shared run build

# 2. Generate the Prisma client and create the schema
cd server
npx prisma generate
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma db push
cd ..

# 3. Environment files (templates contain every variable, with comments)
cp .env.example server/.env     # server vars: DATABASE_URL, REDIS_URL, JWT_SECRET, ...
cp .env.example web/.env        # web vars: VITE_API_URL, VITE_TRANSPORT_*, ...
```

Minimum `server/.env`:

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/nyx_app"
REDIS_URL="redis://127.0.0.1:6379"
JWT_SECRET="random-string-min-32-chars"
CSRF_SECRET="independent-random-string"
NODE_ENV=development
```

Run the stack (there is no single root `dev` script — use one terminal per process):

```bash
pnpm --filter nyx-server dev      # API        → http://localhost:4000
pnpm --filter nyx-web dev         # Web app    → http://localhost:5173

# Optional, required for WebTransport realtime:
cd server/transport-sidecar && cargo build --release
JWT_SECRET=<same as server> REDIS_URL=redis://127.0.0.1:6379 TRANSPORT_PORT=33333 \
  ./target/release/transport-sidecar
# It prints a cert hash — put it in web/.env as VITE_TRANSPORT_CERT_HASH.
```

Details, gotchas, and the full environment table: [Getting Started](docs/02-getting-started.md) and [Deployment & Ops](docs/10-deployment-ops.md).

---

## 🧪 Quality Gates

| Gate | Command |
|---|---|
| Build everything | `pnpm -r run build` |
| Unit tests (server: `node:test`, web: `vitest`) | `pnpm -r --if-present run test` |
| Typecheck | `npx tsc --noEmit` (per package) |
| Lint (**oxlint**, blocking on `error`) | `pnpm run lint` |
| E2E (Playwright, needs the stack running) | `pnpm --filter nyx-web exec playwright test --project=chromium` |
| Sidecar tests + parser fuzzing | `cd server/transport-sidecar && cargo test` |
| KT service tests | `server/kt-query/build.sh test` |
| Cross-implementation crypto vectors | `cd tools/dr-oracle && go run . -check` |
| Prometheus alert drill | `scripts/drill-alerts.sh` |

CI (`.github/workflows/ci.yml`) also runs `pnpm audit --prod`, WASM artifact reproducibility checks, and a Chrome E2E job with the real sidecar and coturn. See [Testing](docs/11-testing.md).

---

## 🏗️ Deployment & Infrastructure

NYX is designed for high-security, zero-trust deployments.

**Zero-Inbound Policy:** the production reference architecture disables inbound firewall ports (except SSH). Traffic is routed through **Cloudflare Tunnels** to localhost ports (3000 for the PWA, 4000 for API/Socket).

* **Processes:** `nyx-api` and `nyx-sidecar` under PM2; `nyx-kt-query-v2` (and `nyx-kt-auditor-v2`) under **systemd** — the KT database is single-process, never run it twice or under PM2. Push to `main` triggers `deploy.yml` (build, ship, `prisma db push`, restart).
* **Observability without telemetry:** four **loopback-only** Prometheus exporters (API `:9464`, sidecar `:9465`, KT log v2 `:9468`, KT auditor v2 `:9469`). Metrics are event counts only — identity-shaped label values are rejected — with alert rules, an Alertmanager→ntfy relay, and a Grafana dashboard under `ops/`.
* **Version gate:** the server can refuse clients that are too old (`MIN_CLIENT_VERSION` → `426 CLIENT_TOO_OLD`).
* **Schema changes:** new columns require `prisma db push` to have run **before** new clients roll out.

> **📦 Ops note — R2 lifecycle:** expiring messages are swept server-side, but their encrypted blobs are blind (the server cannot read `r2Key`). Configure a Cloudflare R2 **lifecycle rule** (e.g. delete objects older than 30 days) so orphaned encrypted blobs don't accumulate.

Upgrading from 2.x? 3.0.0 contains breaking changes (legacy data purge, new DB columns, rebuilt WASM artifacts) — read the top of [`CHANGELOG.md`](CHANGELOG.md) first.

---

## 💾 The "Shadow Vault", Backup & Device Migration

Because history isn't synced to the cloud, YOU own your data. For maximum security, **NYX supports only one active device per account at a time** — a deliberate security property, not a limitation to be "fixed".

1. **Encrypted Backup (`.nyxbak`) — the only backup format:** a framed, padded, tamper-evident archive (per-frame AEAD, size-hiding padding, key derived from your recovery phrase) that can be saved manually or, optionally, stored in R2 as an opaque object. It is the restore path for a **replacement device**. The old plaintext JSON "vault" (`.nyxvault`) was removed on 2026-10-29 — it dumped session keys in the clear. Format: [Backup Format](docs/31-backup-format.md).
2. **Single-Device Policy:** an account may have several device records (so a known or new device can be recognised), but only one device can be logged in and active.
3. **Secure Migration:** moving to a new device uses your `.nyxbak` backup (file or R2 copy) or a direct QR transfer, plus post-quantum protocols; the server acts only as a blind relay.
4. **Panic & wipe:** a panic password (or account deletion) revokes all sessions server-side first, then wipes IndexedDB, OPFS, caches, cookies, and service workers.

---

## ⚖️ Known Trade-offs & Honest Scope

NYX documents what it does **not** hide. Highlights (full list in [Security Model](docs/03-security-model.md) and [docs/28](docs/28-db-dump-threat-model.md) §28.11):

* Message **timing** is not hidden from a network-level observer; chaffing covers idle periods only.
* The KT auditor is a separate *process* run by the project, not an independent organization.
* Biometric unlock keeps the recovery phrase in `localStorage` under a WebAuthn-PRF-derived key (convenience vs blast radius, accepted by the maintainer).
* The CSP keeps `'wasm-unsafe-eval'` (libsodium/WASM) and `'unsafe-inline'`; `'unsafe-eval'` is removed.
* Multi-device is **not planned**; MLS and native push clients are deferred.

---

## 🤝 Contributing

NYX is an open-source fortress, and we welcome operatives to inspect the walls.

  * **Crypto is frozen:** do **not** touch `libsodium-wrappers` unless upgrading specifically for newer PQC primitives, do **not** split `crypto.worker.ts` / `crypto-worker-proxy.ts`, and never change primitives, padding, or the formats in [`docs/04`](docs/04-crypto-protocol.md). Backward compatibility is the highest priority.
  * **Vendored Signal code is read-only:** `vendor/signal/` and `server/kt-query/vendor/` are copied **unmodified** — change behavior by moving the pin (`scripts/vendor-signal.sh`), never by patching.
  * **Linting:** `pnpm run lint` runs **oxlint** per package — the repo's only linter. The CI lint job is **blocking on `error`**: every rule at `error` level (the bug/security classes) and the whole `correctness` category must stay at **0 findings**. ESLint was removed completely on 2026-10-15 — don't reintroduce it. Ensure `pnpm run build` and `npx tsc --noEmit` pass cleanly before opening a PR (see [`AGENTS.md`](AGENTS.md) for the operational rules).
  * **i18n:** every new key must exist in all four locales (`en`, `es`, `id`, `pt-BR`).

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) (including the CLA) and use the provided PR templates. Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).

---

## 📚 Documentation

Full technical documentation lives in [`docs/`](docs/README.md).

**Core**

| Document | Topic |
|---|---|
| [Architecture](docs/01-architecture.md) | System overview, monorepo layout, data flows |
| [Getting Started](docs/02-getting-started.md) | Dev setup, commands, toolchain quirks |
| [Security Model](docs/03-security-model.md) | Threat model, session/device binding, trade-offs |
| [Crypto Protocol](docs/04-crypto-protocol.md) | **Frozen** formats, ratchets, worker op catalog |
| [Message Pipeline](docs/05-message-pipeline.md) | Send/receive flow, transport framing, Redis bridge |

**Feature guides**

| Document | Topic |
|---|---|
| [Auth & Identity](docs/14-auth-identity.md) | Registration, login, recovery, devices, ghost profiles, vault export |
| [Messaging](docs/15-messaging.md) | Statuses, reactions, view-once, expiry, offline/reconnect |
| [Groups](docs/16-groups.md) | Metadata E2EE, sender keys, membership, admin capability |
| [Burner Chats](docs/17-burner.md) | Anonymous RAM-only PQ conversations |
| [Realtime Transport](docs/18-realtime-transport.md) | WebTransport, sidecar, Redis bridge, presence, calls |
| [Media & Stories](docs/19-media-stories.md) | Attachment encryption, stories |
| [Subscriptions & B2B](docs/20-subscriptions-b2b.md) | Trust tiers, crypto payments, engine/embed |

**Privacy, Signal-parity & advanced crypto**

| Document | Topic |
|---|---|
| [Group Privacy Blueprint](docs/26-group-privacy-blueprint.md) | Pseudonyms, pairwise key distribution, blinded membership |
| [Total Upgrade Plan](docs/27-total-upgrade-plan.md) | Infra rebuild, privacy tiers, calls, observability |
| [DB-Dump Threat Model](docs/28-db-dump-threat-model.md) | What a stolen database reveals, and how each finding was closed |
| [Signal Parity Analysis](docs/29-signal-parity-analysis.md) | NYX vs Signal, source-level |
| [Post-Parity Plan](docs/30-post-parity-implementation-plan.md) | Workstreams, pinned Signal commits, acceptance gates |
| [Backup Format](docs/31-backup-format.md) | Framed `.nyxbak` archive spec |
| [Key Transparency](docs/32-key-transparency-kt.md) | KT log writer, read service, snapshots |
| [SPQR WASM](docs/33-spqr-wasm.md) | PQ ratchet v2, ABI, negotiation, rollback |
| [KT Verifier](docs/34-key-transparency-verifier.md) | Client-side verification, monitor, auditor, gossip |
| [PQ Migration Plan](docs/35-post-quantum-migration-plan.md) | Tier A post-quantum migration: inventory, v2 formats, credentials, discovery, KT, rollout |

**Reference & operations**

| Document | Topic |
|---|---|
| [Frontend](docs/06-frontend.md) · [Frontend Reference](docs/21-frontend-reference.md) | Stores, rendering, i18n, PWA, full inventory |
| [Backend](docs/07-backend.md) · [Backend Reference](docs/22-backend-reference.md) | Routes, middleware, jobs, Redis inventory |
| [WebTransport Sidecar](docs/08-webtransport-sidecar.md) · [Shared & Sidecar](docs/23-shared-sidecar.md) | Rust sidecar protocol, `@nyx/shared` |
| [Database](docs/09-database.md) | Schema, indexes, backup, migrations |
| [Deployment & Ops](docs/10-deployment-ops.md) | CI/CD, VPS runbook, env vars, observability, KT service |
| [Testing](docs/11-testing.md) | Unit + E2E guides and quirks |
| [API Reference](docs/12-api-reference.md) | REST endpoint catalog |
| [Troubleshooting](docs/13-troubleshooting.md) | Known errors and fixes |
| [Marketing Site](docs/24-marketing.md) · [Repo Infra & Agents](docs/25-repo-infra-agents.md) | Astro site, root files, CI/agent workflows |

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

### 🧾 Third-party attribution (Signal)

Parts of NYX are built around **unmodified code from Signal Messenger, LLC** (all AGPL-3.0-only). Each project is pinned to a commit and **vendored into this repository** (`vendor/signal/` for Rust, `server/kt-query/vendor/` for Go), so a fresh clone builds without any checkout outside the repo — what lives here are the pinned sources, our thin wrappers, and the compiled WASM artifacts. See `NOTICE` and `docs/30` §30.2.

| Component in this repo | Upstream project | Why it is here |
|---|---|---|
| `packages/spqr-wasm/` (crate `spqr` v1.6.0) | SparsePostQuantumRatchet | Post-quantum ratchet (ML-KEM braid) for wire v2 |
| `server/kt-query/` | key-transparency-server | KT v2 log service (read/write) + auditor beside the API |

Licenses, the exact **pinned commits**, how each artifact is built, byte sizes, and the redistribution obligations are documented in **[`NOTICE`](NOTICE)** — keep that file together with `LICENSE` in any redistribution.

---

## 🌙 Branding & Anti-Impersonation Policy

While the term "NYX" may be used broadly in various contexts, the **specific visual identity, custom logos, and the direct reputation of this specific repository** are the intellectual property of the core maintainer.

The AGPL-3.0 license grants you the freedom to use, modify, and distribute the source code. However, it **does not** grant you the right to impersonate this official project.

If you fork this repository to create your own SaaS, enterprise tool, or public deployment, you must:

1.  **Change the visual identity:** Replace all official logos, icons, and specific graphic assets found in `web/public/` and `marketing/public` or `marketing/src/assets`.
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
