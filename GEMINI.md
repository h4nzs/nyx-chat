# NYX Project Context (GEMINI.md)

## Project Overview
**NYX** is a "Zero-Knowledge Post-Quantum Hardened Messenger". It is a fullstack Node.js monorepo focusing on extreme privacy and security, operating under a strict "Trust No One" (TNO) model. 

### Key Features
- **Pure Anonymity:** No PII collection (no email, phone, IP). Uses blind indexing.
- **Post-Quantum Security:** Implements WebAuthn PRF, ML-KEM-768, XChaCha20-Poly1305, and Argon2id inside a dedicated WebAssembly Web Worker.
- **Local-First:** Chat history is stored entirely client-side using IndexedDB. Server acts as a blind relay.

### Architecture & Tech Stack
The project is structured as a **pnpm workspace** monorepo with the following main directories:
- **`web/`** (Frontend): React 19, Vite 8, Zustand v5, Tailwind CSS v4, Socket.IO Client, `dexie` (IndexedDB).
- **`server/`** (Backend): Node.js (Express), PostgreSQL via Prisma ORM v7, Socket.IO with Redis Adapter, Cloudflare R2 (for binary blobs).
- **`packages/shared/`**: Contains shared types and utilities between web and server.

## Building and Running

### Prerequisites
- Node.js 22+
- `pnpm`
- PostgreSQL & Redis running locally.

### Setup & Commands
```bash
# Install dependencies across the workspace
pnpm install

# Database setup
cd server && npx prisma db push

# Start the development server (runs web and server, but requires shared package to be built first)
pnpm dev

# Build the project
pnpm run build

# Run linter
pnpm run lint

# Run tests
pnpm run test
```

## Development Conventions & Rules
1. **Package Manager:** Exclusively use `pnpm`. Do NOT use `npm` or `yarn`.
2. **Crypto Core is Sacred:** Do **NOT** bump, update, or modify `libsodium-wrappers` or its type definitions. Backward cryptographic compatibility is paramount.
3. **Zustand State:** When using Zustand v5, **do not return objects in selectors without `useShallow`** to prevent infinite render loops.
4. **Linting & Formatting:** The project strictly enforces ESLint v10 (Flat Config). Code must pass `pnpm run lint` with zero warnings before committing (except `unused-var` can be ignored per README).
5. **Commits:** Follow **Conventional Commits** (e.g., `feat: add markdown support`, `fix: memory leak`). Keep commits atomic.
6. **Licensing:** Dual-licensed under AGPL-3.0-or-later and Commercial. Code contributions require signing a CLA.
