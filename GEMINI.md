# NYX: Zero-Knowledge Messenger

> **Context:** This is a high-security, zero-knowledge messaging application. Privacy and security are paramount.
> **Architecture:** Monorepo (pnpm workspace) with a React/Vite frontend and Node/Express/Prisma backend.

## 🏗️ Project Structure

- **`web/`**: Frontend application (React 19, Vite 8, Tailwind v4).
  - Uses `libsodium-wrappers` for client-side encryption.
  - State managed by Zustand v5 (Persist + Strict Mode).
  - Uses `indexedDB` for local storage of encrypted data.
- **`server/`**: Backend API & Socket Server (Node.js, Express).
  - Stateless architecture (mostly).
  - Uses Prisma v7 with PostgreSQL.
  - Uses Redis for Socket.IO clustering and caching.
  - Handles blinded authentication (Zero-Knowledge).
- **`packages/shared/`**: Shared types and utilities.

## 🛠️ Development Workflow

### Prerequisite
- **Package Manager:** `pnpm` (Strictly enforced). Do not use `npm` or `yarn`.

### Key Commands

| Action | Command | Context |
| :--- | :--- | :--- |
| **Install** | `pnpm install` | Root |
| **Start Dev (All)** | *Use separate terminals* | |
| **Start Backend** | `cd server && pnpm dev` | Server (Port 4000) |
| **Start Frontend** | `cd web && pnpm dev` | Web (Port 5173/3000) |
| **Database Push** | `cd server && npx prisma db push` | Updates DB schema |
| **Database Seed** | `cd server && pnpm seed` | Seeds initial data |
| **Lint** | `pnpm lint` | Root (Recursive) |
| **Test** | `pnpm test` | Root (Recursive) |
| **Build** | `pnpm build` | Root (Recursive) |

### Infrastructure (Docker)
To spin up the full stack (Postgres, Redis, API, Web):
```bash
docker-compose up -d
```

## 🚨 Critical Rules & Conventions

1.  **Crypto Integrity:** **NEVER** modify or update `libsodium-wrappers` or its types. Backward compatibility is critical.
2.  **State Management (Zustand):** Always use `useShallow` when selecting objects from the store to prevent infinite re-renders.
    ```typescript
    // ✅ Correct
    const { activeChat, sendMessage } = useStore(useShallow(state => ({
      activeChat: state.activeChat,
      sendMessage: state.sendMessage
    })));
    ```
3.  **Linting:** The project enforces ESLint v10 (Flat Config). Code **must** pass `pnpm lint` with zero warnings before completion.
4.  **Database:** Do not manually modify migrations. Use `prisma db push` for dev and proper migrations for prod.
5.  **Security:**
    - No PII in logs.
    - No plaintext user data in the database (everything is hashed or encrypted).
    - API endpoints must be stateless where possible.

## 🧪 Testing Strategy

- **Backend:** `tsx --test` (Native Node Test Runner) in `server/tests/`.
- **Frontend:** `vitest` in `web/`.
- **E2E:** *To be implemented.*

## 📝 Contribution Guidelines

- **Commits:** Use Conventional Commits (e.g., `feat:`, `fix:`, `chore:`).
- **CLA:** All PRs require a CLA signature (handled by bot).
