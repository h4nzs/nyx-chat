# NYX - Zero-Knowledge Messenger

## Project Overview

NYX is a privacy-first, zero-knowledge messenger designed with a "Trust No One" (TNO) architecture. It decouples digital identity from physical identity, ensuring no Personally Identifiable Information (PII) is stored.

### Key Architectural Concepts
- **Pure Anonymity:** No emails, phone numbers, or plaintext usernames.
- **Blind Indexing & Ghost Profiles:** Profiles and metadata are encrypted client-side using `libsodium` and only shared via Double Ratchet headers.
- **Local-First Sovereign Storage:** Chat history is exclusively stored on the client device using IndexedDB (`dexie`).
- **Cryptography:** The Signal Protocol implementation running in a dedicated Web Worker using WebAssembly. Primitives include XChaCha20-Poly1305, Ed25519, and Argon2id.
- **Anti-Spam:** Trust-tier system including WebAuthn (Biometrics) and client-side proof-of-work.

### Technology Stack
This project is structured as a **pnpm monorepo** containing multiple workspaces:
- **`web` (Frontend):** React 19, Vite 8, TypeScript, Zustand v5, Tailwind CSS v4, `dexie`, and `socket.io-client`.
- **`server` (Backend):** Node.js (Express), TypeScript, Prisma ORM v7 (with PostgreSQL), Socket.IO (with Redis adapter), and Zod.
- **`marketing`:** Static site generated with Astro.
- **`packages/shared`:** Shared TypeScript interfaces, types, and schemas.

## Building and Running

Ensure you have Node.js (v22+), `pnpm`, PostgreSQL, and Redis installed.

### Initial Setup
```bash
# Install dependencies for all workspaces
pnpm install

# Setup Database
cd server
npx prisma db push
pnpm run seed
```

### Development
```bash
# Start frontend (from web/)
cd web && pnpm dev

# Start backend (from server/)
cd server && pnpm dev
```
*(Alternatively, check the root `package.json` for global development scripts if defined.)*

### Testing and Linting
```bash
# Run tests across workspaces
pnpm test

# Run linting across workspaces
pnpm lint
```

## Development Conventions & Rules

1. **Strict Cryptography Constraints:** Do NOT update or touch `libsodium-wrappers`. It is pinned at `v0.8.x` to ensure critical cryptographic backward compatibility.
2. **TypeScript Strictness:** Never use the `any` type under any circumstances. If a type is unknown, use `unknown`. Use safe type guards, Zod schemas, or double casting instead.
3. **Linting:** Enforces ESLint Flat Config. Code must pass `pnpm run build` and `pnpm run lint` with zero warnings (except unused vars error just ignore it).
4. **File Modifications:** ALWAYS use tools like `read_file` to inspect a file fully before making any edits, replacements, or rewrites. Never replace existing code with omission placeholders (e.g., `// ...rest of code`); always write the full output.
5. **Infrastructure:** In production, the backend is designed for a Zero-Inbound Policy using Cloudflare Tunnels (ports 3000 for PWA, 4000 for API/Socket).
