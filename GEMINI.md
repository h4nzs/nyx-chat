# NYX Chat Lite - Developer Context

## Project Overview

NYX Chat Lite is a secure, zero-knowledge messaging application designed with a "Privacy First" architecture. It operates on a **Pure Anonymity** model, decoupling digital identity from physical identity by removing dependencies on email and phone numbers.

**Core Philosophy:**
*   **Zero-Knowledge:** The server cannot read messages or view user profiles.
*   **Pure Anonymity:** No PII storage. Usernames are hashed (Blind Indexing).
*   **Local-First:** Chat history and private keys are stored exclusively on the user's device (IndexedDB).
*   **Trust-Tier System:** Anti-spam mechanism using "Sandbox" (unverified) and "VIP" (Verified via WebAuthn/PoW) tiers.

## Tech Stack

**Monorepo Structure (pnpm workspaces):**
*   `server/`: Backend API and WebSocket server.
*   `web/`: Frontend React application.

**Frontend (`web`):**
*   **Framework:** React 18 + Vite
*   **Language:** TypeScript
*   **State Management:** Zustand
*   **Styling:** Tailwind CSS (Custom "Industrial Neumorphism" design system)
*   **Cryptography:** `libsodium-wrappers` + Web Crypto API (running in a dedicated Web Worker)
*   **Storage:** IndexedDB (`idb`, `idb-keyval`) for "The Vault" (Keys & Messages)
*   **PWA:** Vite PWA plugin

**Backend (`server`):**
*   **Runtime:** Node.js (Express)
*   **Language:** TypeScript
*   **Database:** PostgreSQL (via Prisma ORM)
*   **Real-time:** Socket.IO (with Redis Adapter)
*   **Caching/Queue:** Redis (Rate limiting, Presence, PoW Challenges)
*   **Storage:** Cloudflare R2 (Encrypted binary blobs only) using AWS SDK v3
*   **Auth:** WebAuthn (`@simplewebauthn/server`), Argon2id hashing

## Key Architecture Concepts

1.  **Blind Indexing:** Usernames are hashed client-side (Argon2id) before being sent to the server. The server stores `usernameHash` and performs exact-match lookups.
2.  **Profile Encryption:** User profiles (Name, Bio, Avatar) are encrypted client-side with a symmetric `ProfileKey`. This key is shared via the Double Ratchet header in messages. The server stores only `encryptedProfile`.
3.  **Double Ratchet E2EE:** Implementation of the Signal Protocol (X3DH + Double Ratchet) for message encryption.
4.  **Device Migration Tunnel:** Direct WebSocket tunnel for transferring data between devices via QR code (Zero-Knowledge migration).
5.  **WebAuthn PRF:** Uses the PRF extension to allow biometric unlocking of the local key vault.

## Build and Run

**Prerequisites:**
*   Node.js v18+
*   pnpm
*   PostgreSQL
*   Redis

**Root Commands:**
*   `pnpm install`: Install dependencies for all workspaces.
*   `pnpm run build`: Build both server and web projects.
*   `pnpm run test`: Run tests for both projects.
*   `./start-dev.sh`: Helper script to start both frontend and backend in development mode.

**Server Commands (`cd server`):**
*   `pnpm run dev`: Start development server (`tsx watch`).
*   `pnpm run build`: Build TypeScript to `dist/`.
*   `pnpm run start`: Run production server.
*   `npx prisma migrate dev`: Run database migrations.
*   `npx prisma studio`: Open Prisma Studio.

**Web Commands (`cd web`):**
*   `pnpm run dev`: Start Vite development server.
*   `pnpm run build`: Build for production.
*   `pnpm run test`: Run Vitest tests.

## Development Conventions

*   **Security:**
    *   **NEVER** log sensitive data (keys, plaintext messages) to the console.
    *   Use `sodium.memzero()` to wipe sensitive data from memory in `crypto.worker.ts`.
    *   Respect the strict Content Security Policy (CSP).
*   **Code Style:**
    *   Follow TypeScript best practices (strict types).
    *   Use `eslint` and `prettier` (configured in `package.json`).
*   **State Management:**
    *   Use specific Zustand stores (e.g., `useAuthStore`, `useMessageStore`) rather than a monolithic store.
*   **Cryptography:**
    *   All heavy crypto operations **MUST** be performed in the Web Worker (`crypto.worker.ts`) via the proxy (`crypto-worker-proxy.ts`) to avoid blocking the main thread.
