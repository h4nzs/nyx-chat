# NYX - Gemini AI Context

This file provides context for Gemini AI assistants working on the NYX project.

## Project Overview

**NYX** is a Zero-Knowledge, Post-Quantum Hardened Messenger. It is designed with pure anonymity in mind, requiring no PII (email, phone number, etc.). 

**Core Features:**
- **Zero-Knowledge Architecture:** The server cannot read messages or user profiles.
- **Post-Quantum Cryptography:** Hybrid key exchange using X25519 + ML-KEM-768 (X-Wing construct) and XChaCha20-Poly1305 + HMAC-SHA256 for messages.
- **Local-First Sovereignty:** Chat history is stored exclusively on the client (IndexedDB) and never synced to the cloud in plaintext.
- **Memory-Hard Hashing:** Uses Argon2id for local vault encryption and server blind indexing.

## Repository Structure

The project is structured as a **pnpm monorepo** with the following main workspaces:

- `web/`: The main client PWA (React 19, Vite 8, Zustand v5, Tailwind CSS v4, Web Worker-based crypto engine).
- `server/`: The Node.js Express backend and Socket.IO real-time server (Prisma v7, PostgreSQL, Redis).
- `marketing/`: The public-facing landing page and documentation site (Astro, React, Tailwind CSS v4).
- `packages/shared/`: Shared TypeScript types, Zod schemas, and Socket event definitions.

## Tech Stack Summary

- **Frontend (`web/`):** React, TypeScript, Vite, Zustand, Tailwind CSS, `libsodium-wrappers`, Playwright for E2E.
- **Backend (`server/`):** Node.js, Express, Socket.IO, Prisma ORM, PostgreSQL, Redis, Jest for testing.
- **Marketing (`marketing/`):** Astro, React.
- **Package Manager:** `pnpm`.

## Development Workflows

### Prerequisites
- Node.js 22+
- `pnpm`
- PostgreSQL
- Redis

### Setup & Initialization
1. Install dependencies from the root directory:
   ```bash
   pnpm install
   ```
2. Configure environment variables in `server/.env` (reference `.env.example` if available).
3. Push the database schema:
   ```bash
   cd server
   npx prisma db push
   ```

### Running the Services Locally

**Backend Server:**
```bash
cd server
pnpm dev # Runs development server via tsx watch
```

**Web Client:**
```bash
cd web
pnpm dev # Starts Vite development server
```

**Marketing Site:**
```bash
cd marketing
pnpm dev # Starts Astro development server
```

### Global Commands (From Root)
- `pnpm build`: Builds all workspaces.
- `pnpm lint`: Lints all workspaces using ESLint v10.
- `pnpm test`: Runs tests across all workspaces.

## Development Conventions & Rules

1. **Cryptography Stability:** **DO NOT** update, modify, or bump the `libsodium-wrappers` dependency unless specifically instructed to do so for newer PQC primitives. Cryptographic backward compatibility is the highest priority.
2. **Strict Linting:** The project enforces strict linting with ESLint v10 (Flat Config). Code must pass `pnpm lint` with zero warnings before being merged or considered complete.
3. **Shared Types:** Any interfaces, data models, or validation schemas (Zod) that cross the client/server boundary must be defined inside `packages/shared/` to ensure end-to-end type safety.
4. **Database Changes:** The backend uses Prisma ORM. Modify `server/prisma/schema.prisma` for database changes, and apply them using `npx prisma db push` during local development.
5. **No PII:** When designing new features or database models, ensure absolutely no personally identifiable information (PII) is collected, transmitted, or stored in plaintext.