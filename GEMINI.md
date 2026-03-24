# GEMINI.md - NYX Chat Context

> **This file provides the essential context and instructions for the NYX Chat project.**
> It is automatically generated and should be referenced for all development tasks.

---

## 1. Project Overview

**NYX** is a **Zero-Knowledge Messenger** focused on pure anonymity and privacy. It decouples digital identity from physical identity (no phone numbers/emails) and operates on a "Trust No One" (TNO) model.

**Core Philosophy:**
- **Zero-Knowledge:** Server cannot read messages or know who users are.
- **Local-First:** Chat history lives exclusively in IndexedDB on the client.
- **Blind Indexing:** Usernames are hashed client-side; server never sees plaintext.

**Tech Stack:**
- **Monorepo:** Managed with `pnpm` workspaces.
- **Frontend (`web`):** React 19, Vite 8, Tailwind v4, Zustand v5, IDB (IndexedDB).
- **Backend (`server`):** Node.js, Express, Socket.IO, Prisma v7 (PostgreSQL), Redis.
- **Marketing (`marketing`):** Astro 5, React.
- **Crypto:** Libsodium (XChaCha20-Poly1305), Signal Protocol (X3DH, Double Ratchet), Argon2id.

---

## 2. Directory Structure

```text
/
├── packages/
│   └── shared/       # Shared types, schemas (Zod), and constants
├── server/           # Backend API & Socket.IO (Express, Prisma)
├── web/              # Main PWA Client (React, Vite)
├── marketing/        # Landing page & documentation (Astro)
├── scripts/          # Maintenance scripts
├── docker-compose.yml # Local development infrastructure
└── package.json      # Root workspace config
```

---

## 3. Development Workflow

### Prerequisites
- **Node.js:** v22+
- **Package Manager:** `pnpm` (Strictly enforced. Do NOT use npm/yarn)
- **Database:** PostgreSQL
- **Cache:** Redis

### Quick Start

1.  **Install Dependencies:**
    ```bash
    pnpm install
    ```

2.  **Environment Setup:**
    - Configure `.env` in `server/` (see `README.md` for variables).
    - Ensure PostgreSQL and Redis are running (or use `docker-compose up -d postgres redis`).

3.  **Database Initialization:**
    ```bash
    cd server
    npx prisma db push  # Push schema to DB
    pnpm seed           # Optional: Seed data
    ```

4.  **Run Development Servers:**
    - **Full Stack:** Run specific scripts in separate terminals or use a root command if configured (currently manual).
    - **Server:** `cd server && pnpm dev` (Port 4000)
    - **Web:** `cd web && pnpm dev` (Port 5173 - default Vite)
    - **Marketing:** `cd marketing && pnpm dev`

### Build & Test commands

- **Build All:** `pnpm build` (Root)
- **Test All:** `pnpm test` (Root)
- **Lint All:** `pnpm lint` (Root)
- **Server Specific:**
    - `pnpm test` (in `server/`): Runs `tsx --test tests/api.test.ts`
    - `pnpm build`: Compiles TypeScript
- **Web Specific:**
    - `pnpm test` (in `web/`): Runs `vitest`
    - `pnpm build`: `tsc -b && vite build`

---

## 4. Critical Rules & Conventions

### 🛑 Strict Mandates
1.  **Crypto Integrity:** **NEVER** update `libsodium-wrappers`. Backward compatibility is critical.
2.  **Package Manager:** Always use `pnpm`. Never commit `package-lock.json` or `yarn.lock`.
3.  **State Management:** Use `useShallow` with Zustand selectors to prevent infinite re-renders.
4.  **No PII:** Never add features that store personally identifiable information (email, phone, IP) in plaintext.

### 🐛 Testing & Quality
- **Linting:** ESLint v10 (Flat Config) is strictly enforced. Code must pass `pnpm lint` with zero warnings.
- **Testing:**
    - **Backend:** `tsx` native test runner.
    - **Frontend:** `vitest`.
    - **E2E:** Playwright (implied need in CONTRIBUTING.md).

### 📝 Commit Style
- Use **Conventional Commits**:
    - `feat: ...` for new features
    - `fix: ...` for bug fixes
    - `chore: ...` for maintenance
    - `refactor: ...` for code restructuring

---

## 5. Infrastructure (Docker)

The `docker-compose.yml` defines the production-like stack:
- **postgres:** `nyx-db`
- **redis:** `nyx-redis`
- **server:** `nyx-api` (Port 4000)
- **web:** `nyx-web` (Port 3000 - served via Nginx/Node)

---

## 6. Key Configuration Files

- **`server/prisma/schema.prisma`**: Database schema definition.
- **`web/vite.config.ts`**: Frontend build configuration.
- **`marketing/astro.config.mjs`**: Marketing site configuration.
- **`packages/shared/src/schemas.ts`**: Shared Zod validation schemas (API contracts).
