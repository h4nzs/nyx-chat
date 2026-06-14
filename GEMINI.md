# NYX Chat Project Context

NYX is a Zero-Knowledge Post-Quantum Hardened Messenger designed for pure anonymity and high-security communication. It operates on a "Trust No One" (TNO) model, ensuring that the server is incapable of reading messages or identifying users.

## 🚀 Project Overview

- **Core Technologies**: React 19, Vite 8, Node.js, Express, Prisma 7, PostgreSQL, Redis, WebTransport (Rust), Libsodium (X-Wing PQC).
- **Architecture**: Monorepo using `pnpm` workspaces.
  - `web/`: React frontend (PWA). Real-time communication is handled by `NyxWebTransportClient` using a **Web Worker** (`transport.worker.ts`).
  - `server/`: Express backend with Prisma ORM.
  - `server/transport-sidecar/`: A **Rust-based WebTransport server** that handles persistent connections and low-latency messaging.
  - `marketing/`: Astro-based marketing website.
  - `packages/shared/`: Shared Zod schemas, types, and constants.
  - `packages/nyx-sdk/`: SDK for interacting with the NYX cryptographic engine.
- **Real-time Pipeline**: 
  - Clients connect via **WebTransport** to the Rust sidecar.
  - The Node.js server and Rust sidecar communicate asynchronously via **Redis Pub/Sub** (`nyx:upstream` and `nyx:downstream`).
- **Key Features**:
  - **Zero PII**: No phone numbers or emails required.
  - **Post-Quantum Security**: ML-KEM-768 (X-Wing) for key exchange.
  - **Local-First**: Chat history is stored only on the device via IndexedDB (`dexie`).
  - **Blind Relay**: The server only routes encrypted blobs without access to keys.
  - **Single-Active-Device**: For maximum security, only one device can be active per account at a time. Multiple device records are maintained solely for hardware verification and new device detection.

## 🛠️ Building and Running

### Prerequisites
- Node.js 24+
- `pnpm`
- PostgreSQL
- Redis
- **Rust toolchain** (for the transport sidecar)

### Setup Commands
1.  **Install Dependencies**:
    ```bash
    pnpm install
    ```
2.  **Build Shared Package**:
    ```bash
    cd packages/shared && pnpm build
    ```
3.  **Sync Database Schema**:
    ```bash
    cd server && npx prisma db push
    ```

### Development
- **Root (Parallel Dev)**: `pnpm dev`
- **Frontend**: `cd web && pnpm dev` (Runs at port 3000)
- **Backend**: `cd server && pnpm dev` (Runs at port 4000)
- **Transport Sidecar**: `cd server/transport-sidecar && cargo run`
- **Marketing**: `cd marketing && pnpm dev`

### Production Build
```bash
pnpm build
```

## 📜 Development Conventions

### Coding Standards
- **Strict Linting**: ESLint v10 (Flat Config) is enforced. Run `pnpm lint` to verify.
- **Type Safety**: TypeScript is used everywhere. Ensure `tsc` passes before committing.
- **ES Modules**: The project uses Native ESM (`"type": "module"`).

### Cryptography Rules
- **libsodium-wrappers**: DO NOT update or modify the crypto engine in `web/` or `server/` without explicit PQC upgrade intent. Backward compatibility is mission-critical.
- **Client-Side Encryption**: All sensitive data must be encrypted client-side before reaching the server.

### Real-time & Networking
- **WebTransport**: The primary transport protocol. Do not fallback to classical WebSockets unless explicitly requested.
- **Binary Protocols**: Messaging often uses binary payloads with custom OpCodes (`TransportOpCode`).

### Testing
- **E2E Testing**: Playwright is used for web client testing. Run `cd web && pnpm test:e2e`.
- **Unit Testing**: Vitest (web) and Jest (server).

## 📂 Key Files
- `server/prisma/schema.prisma`: Database source of truth.
- `server/src/network/redisBridge.ts`: Bridge between Node.js and Rust sidecar.
- `web/src/lib/transportClient.ts`: Client-side WebTransport implementation.
- `web/src/workers/transport.worker.ts`: Low-level WebTransport handling in a worker.
