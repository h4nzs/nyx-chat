# GEMINI.md - NYX Context & Instructions

> **"Privacy is not a feature. It's the architecture."**

This file provides the essential context and instructions for working on the **NYX** project (Zero-Knowledge Messenger). It is a monorepo containing a Node.js/Express backend and a React/Vite frontend.

## 1. Project Overview

NYX is a privacy-first, zero-knowledge messaging application. It operates on a "Trust No One" (TNO) model where the server is mathematically incapable of reading messages or knowing user identities.

### Core Philosophy
- **Zero-Knowledge:** No PII storage (no emails, phone numbers, or IP logs).
- **Local-First:** Chat history exists *only* on the client (IndexedDB).
- **End-to-End Encryption:** Signal Protocol implementation (Double Ratchet, X3DH) via `libsodium`.
- **Blind Indexing:** Usernames are hashed; the server never sees the plaintext.

## 2. Architecture & Tech Stack

**Monorepo Structure (pnpm workspaces):**
- `server/`: Node.js Backend
- `web/`: React PWA Frontend

### Frontend (`web/`)
- **Framework:** React 19 + Vite 8
- **Language:** TypeScript 5.5+
- **State:** Zustand v5 (Strict Mode + Persist)
- **Styling:** Tailwind CSS v4
- **Crypto:** `libsodium-wrappers` (Pinned v0.8.x - **DO NOT UPDATE**)
- **Storage:** IndexedDB (`idb-keyval`, `dexie`)
- **PWA:** Vite Plugin PWA + Workbox

### Backend (`server/`)
- **Runtime:** Node.js (Express 5)
- **Database:** PostgreSQL (via Prisma v7)
- **Real-time:** Socket.IO v4.8 (Redis Adapter)
- **Storage:** Cloudflare R2
- **Validation:** Zod

### Infrastructure
- **Docker:** `docker-compose.yml` orchestrates Postgres, Redis, API, and Web services.
- **Tunnels:** Cloudflare Tunnels for zero-inbound production deployment.

## 3. Development Workflow

### Prerequisites
- Node.js 20+
- pnpm
- Docker (for local DB/Redis)

### Key Commands

| Action | Command | Context |
| :--- | :--- | :--- |
| **Install Dependencies** | `pnpm install` | Root |
| **Start Dev (Server)** | `pnpm --filter nyx-server dev` | Root or `server/` |
| **Start Dev (Web)** | `pnpm --filter nyx-web dev` | Root or `web/` |
| **Database Push** | `npx prisma db push` | `server/` |
| **Database Seed** | `pnpm seed` | `server/` |
| **Run Tests** | `pnpm test` | Root (Recursive) |
| **Lint** | `pnpm lint` | Root (Recursive) |
| **Build** | `pnpm build` | Root (Recursive) |

**Note:** `nyx-server` uses `tsx` for running TypeScript directly in dev/test. `nyx-web` uses `vite` and `vitest`.

## 4. Coding Conventions & Rules

### 🔒 Security & Crypto
- **NEVER** touch `libsodium-wrappers` version or implementation details without explicit instruction. Backward compatibility is critical.
- **NEVER** log sensitive data (keys, plaintext messages, tokens).
- **Blind Indexing:** Always respect the hashed-username architecture. The server should never handle plaintext usernames.

### 🎨 Frontend
- **Tailwind v4:** Use the new v4 engine features.
- **Zustand:** Use strict mode and handle persistence carefully for encryption keys.
- **Web Workers:** Heavy crypto operations MUST run in Web Workers (check `web/src/workers/`).

### ⚙️ Backend
- **Prisma:** Use the standard ESM-compatible Prisma Client.
- **Express:** Ensure all routes are protected by appropriate middleware (`auth`, `rateLimiter`).
- **Socket.IO:** Ensure events are properly typed and handled via the Redis adapter for clustering support.

### 🧪 Testing
- **Frontend:** Vitest with JSDOM.
- **Backend:** Native Node.js test runner via `tsx --test`.

### 🧹 Code Quality
- **Linting:** Strict ESLint 10 (Flat Config). Code MUST pass `pnpm lint` before submission.
- **Formatting:** Prettier (implied).

## 5. Documentation Map
- **`README.md`**: High-level philosophy and quick start.
- **`server/prisma/schema.prisma`**: Database schema.
- **`web/vite.config.ts`**: Frontend build config.
- **`server/src/index.ts`**: Backend entry point.
