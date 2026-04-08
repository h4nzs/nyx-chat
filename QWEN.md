# NYX Chat - Project Context

## Project Overview

**NYX** is a zero-knowledge, end-to-end encrypted (E2EE) messenger built on a monorepo architecture. It emphasizes pure anonymity — no phone numbers, emails, or PII are required. The project implements the Signal Protocol (X3DH + Double Ratchet) for message encryption, with all cryptographic operations running inside a dedicated Web Worker using `libsodium-wrappers`.

### Core Philosophy
- **No PII Storage**: No emails, phone numbers, IP addresses, or plaintext usernames stored
- **Blind Indexing**: Usernames hashed client-side with Argon2id
- **Ghost Profiles**: Profile data encrypted locally with symmetric keys
- **Local-First**: Chat history stored exclusively in IndexedDB on the user's device

## Architecture

This is a **pnpm monorepo** with the following workspace packages:

| Package | Path | Description |
|---------|------|-------------|
| `nyx-web` | `/web` | React 19 frontend (Vite 8, Tailwind CSS v4, Zustand v5) |
| `nyx-server` | `/server` | Express 5 backend (TypeScript, Socket.IO, Prisma ORM v7) |
| `@nyx/shared` | `/packages/shared` | Shared types and schemas (Zod) |
| `marketing` | `/marketing` | Marketing/landing site |

### Key Directories
```text
nyx-chat/
├── web/                  # Frontend (React + Vite + TypeScript)
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── pages/        # Route pages
│   │   ├── store/        # Zustand state stores
│   │   ├── workers/      # Web Workers (crypto engine)
│   │   ├── hooks/        # Custom React hooks
│   │   ├── lib/          # Utility libraries
│   │   ├── schemas/      # Validation schemas
│   │   └── types/        # TypeScript types
│   └── public/           # Static assets
├── server/               # Backend (Express + TypeScript)
│   ├── src/
│   │   ├── routes/       # API endpoints
│   │   ├── middleware/   # Express middleware
│   │   ├── lib/          # Utility libraries
│   │   ├── jobs/         # Background jobs/cron
│   │   └── utils/        # Helper functions
│   └── prisma/           # Database schema & migrations
├── packages/shared/      # Shared code between web and server
├── marketing/            # Marketing site
└── scripts/              # Root-level scripts
```

## Tech Stack

### Frontend (`/web`)
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite 8
- **Styling**: Tailwind CSS v4
- **State Management**: Zustand v5 (with persist middleware)
- **Routing**: React Router v7
- **Real-time**: Socket.IO Client v4.8+
- **Storage**: IndexedDB via Dexie
- **Crypto**: libsodium-wrappers (Web Worker)
- **Testing**: Vitest + Testing Library (jsdom)
- **PWA**: vite-plugin-pwa with Workbox

### Backend (`/server`)
- **Runtime**: Node.js with Express 5
- **Database**: PostgreSQL via Prisma ORM v7 (`@prisma/adapter-pg`)
- **Cache/Real-time**: Redis + Socket.IO Redis Adapter
- **Auth**: WebAuthn (SimpleWebAuthn), JWT, Argon2
- **Storage**: Cloudflare R2 (AWS SDK S3 client)
- **Validation**: Zod v4
- **Testing**: Jest

### Infrastructure
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Cloudflare Tunnels (zero-inbound policy)
- **CI/CD**: GitHub Actions (`.github/`)

## Building & Running

### Prerequisites
- Node.js 22+
- pnpm
- PostgreSQL
- Redis

### Setup
```bash
# Clone and install
git clone https://github.com/h4nzs/nyx-chat.git
cd nyx-chat
pnpm install

# Setup database (in server/)
cd server && npx prisma db push

# Run development servers
pnpm dev  # Runs both web/ and server/ in dev mode
```

### Key Commands
```bash
# Build all packages
pnpm run build

# Run tests across all packages
pnpm run test

# Lint all packages
pnpm run lint

# Bump version (patch/minor)
pnpm run bump:patch
pnpm run bump:minor

# Run individual package commands
cd web && pnpm dev       # Frontend dev server
cd server && pnpm dev    # Backend dev server (tsx watch)
cd server && pnpm seed   # Seed database
```

### Docker Compose
```bash
docker-compose up -d   # Start all services
```

## Development Conventions

### Strict Rules
1. **Crypto is sacred**: Never update `libsodium-wrappers` — backward compatibility is critical
2. **Package manager**: Use `pnpm` only — no npm or yarn
3. **Zustand selectors**: Always use `useShallow` to prevent infinite render loops
4. **Linting**: ESLint v10 (Flat Config) — must pass with zero warnings
5. **Commits**: Use Conventional Commits format

### Testing
- Frontend: Vitest with jsdom environment (`/web/src/tests/`)
- Backend: Jest (`/server/tests/`)
- E2E testing is an area where contributions are welcome

### Security
- Report vulnerabilities to `admin@nyx-app.my.id` (not public issues)
- See `SECURITY.md` for the coordinated disclosure protocol
- Scope includes: Double Ratchet implementation, E2EE bypasses, WebAuthn, blind indexing, socket events

## License

**AGPL-3.0-or-later** with commercial dual-license available. Network use (SaaS) requires open-sourcing your entire project. See `COMMERCIAL.md` for enterprise licensing.

## Key Files Reference

| File | Purpose |
|------|---------|
| `package.json` | Root workspace config, scripts, pnpm overrides |
| `pnpm-workspace.yaml` | Workspace package definitions |
| `docker-compose.yml` | Local Docker setup (PostgreSQL, Redis, server, web) |
| `server/prisma/` | Database schema and migrations |
| `web/src/workers/` | Crypto Web Workers |
| `web/src/store/` | Zustand state management |
| `server/src/socket.ts` | Socket.IO server implementation |
| `SECURITY.md` | Vulnerability disclosure process |
| `CONTRIBUTING.md` | Contribution guidelines and CLA info |
