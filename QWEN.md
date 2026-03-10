# NYX Chat - Project Context

## Project Overview

**NYX** is a zero-knowledge, end-to-end encrypted (E2EE) messenger built on a **Trust No One (TNO)** architecture. The application implements the **Signal Protocol** (Double Ratchet + X3DH) entirely client-side using WebAssembly (`libsodium-wrappers`), ensuring the server never has access to plaintext messages, user profiles, or cryptographic keys.

### Core Philosophy
- **No PII Storage**: No phone numbers, emails, or plaintext usernames stored server-side
- **Blind Indexing**: Usernames hashed client-side with Argon2id before transmission
- **Local-First**: Chat history stored exclusively in IndexedDB ("The Shadow Vault")
- **Ghost Profiles**: User profiles encrypted client-side with symmetric keys exchanged via Double Ratchet

## Tech Stack (2026)

### Monorepo Structure
```
chat-lite/
├── web/          # React 19 + Vite 7 frontend
├── server/       # Node.js + Express backend
├── scripts/      # Build automation scripts
└── docker-compose.yml
```

### Frontend (`/web`)
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19.x | UI framework |
| Vite | 7.x | Build tool |
| TypeScript | 5.5.x | Type safety |
| Zustand | 5.x | State management (with Persist middleware) |
| Tailwind CSS | 4.x | Styling (Lightning CSS engine) |
| libsodium-wrappers | 0.8.2 | Cryptography (Web Worker) |
| Socket.IO Client | 4.8.x | Real-time communication |
| Dexie / idb-keyval | 4.x / 6.x | IndexedDB abstraction |
| React Virtualized | 9.x | Chat list virtualization |

### Backend (`/server`)
| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 20+ | Runtime |
| Express | 5.x | HTTP server |
| Prisma ORM | 7.x | Database (PostgreSQL) |
| Socket.IO | 4.8.x | WebSocket server |
| Redis | 5.x | Caching + rate limiting |
| Argon2 | 0.44.x | Password hashing |
| libsodium-wrappers | 0.8.2 | Server-side crypto operations |
| Cloudflare R2 | - | Encrypted blob storage |

## Building and Running

### Prerequisites
- Node.js 20+
- pnpm (package manager)
- PostgreSQL 15+
- Redis

### Installation
```bash
git clone https://github.com/h4nzs/nyx-chat.git
cd nyx-chat
pnpm install
```

### Environment Setup (`server/.env`)
```env
DATABASE_URL="postgresql://user:pass@localhost:5432/nyx_db"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="<min-32-chars-random-string>"
CLIENT_URL="http://localhost:5173"
CORS_ORIGIN="http://localhost:5173"
# Cloudflare R2 configuration...
```

### Development
```bash
# Initialize database
cd server && npx prisma db push

# Run development servers (from root)
pnpm dev  # Or run individually in /web and /server
```

### Production Build
```bash
pnpm run build    # Builds both web and server
pnpm run lint     # ESLint validation
pnpm run test     # Run test suites
```

### Docker Deployment
```bash
docker-compose up -d
```

## Architecture Highlights

### Cryptography Engine
- **Web Worker Isolation**: All crypto operations run in `crypto.worker.ts` to avoid blocking the main thread
- **Double Ratchet**: Provides Perfect Forward Secrecy (PFS) and Post-Compromise Security (PCS)
- **XChaCha20-Poly1305**: Primary cipher for message encryption
- **HKDF**: Key derivation function
- **Ed25519**: Digital signatures

### Trust-Tier System (Anti-Spam)
1. **Sandbox Mode** (default): Rate-limited (5 msg/min), no group creation, limited search
2. **VIP Status**: Unlocked via WebAuthn (biometrics) or Proof-of-Work puzzles

### Data Flow
```
Client (Web Worker) → E2EE Encryption → Socket.IO → Server (blind relay) → Recipient
                         ↓
                  IndexedDB (local history)
```

## Development Conventions

### Strict Rules
1. **Crypto Immutability**: Do NOT update `libsodium-wrappers` - backward compatibility is critical
2. **Package Manager**: Use `pnpm` exclusively (no npm/yarn)
3. **State Management**: Use `useShallow` with Zustand selectors to prevent infinite renders
4. **Linting**: ESLint v10 (Flat Config) - must pass with zero warnings

### Code Style
- TypeScript strict mode enabled
- Conventional Commits format (`feat:`, `fix:`, `chore:`)
- Atomic commits preferred

### Testing Practices
- Frontend: Vitest + React Testing Library (jsdom environment)
- Backend: tsx + native test runner
- E2E testing: In progress

## Key Directories

### `/web/src`
| Directory | Purpose |
|-----------|---------|
| `components/` | React UI components |
| `hooks/` | Custom React hooks |
| `lib/` | Utility libraries |
| `pages/` | Route components |
| `store/` | Zustand stores |
| `workers/` | Web Workers (crypto) |
| `types/` | TypeScript definitions |

### `/server/src`
| Directory | Purpose |
|-----------|---------|
| `routes/` | API endpoints |
| `middleware/` | Auth, rate limiting, CORS |
| `lib/` | Crypto utilities |
| `jobs/` | Background tasks (node-cron) |
| `socket.ts` | WebSocket handlers |

## Security Features

### Zero-Knowledge Architecture
- Server stores only encrypted blobs
- Profile keys exchanged via Double Ratchet header
- No plaintext metadata stored

### Anti-Surveillance
- **Privacy Cloak**: UI blur toggle for shoulder-surfing protection
- **Voice Anonymizer**: Real-time audio distortion before encryption
- **Silent Drop**: Messages without notification triggers

### Trust Boundaries
- CLA required for contributors (dual-licensing: AGPL-3.0 + Commercial)
- WebAuthn PRF for biometric vault decryption
- Device migration via direct E2EE WebSocket tunnel

## License

**AGPL-3.0** - Network use requires open-sourcing modifications. Commercial licenses available for closed-source SaaS deployments.

## Related Documentation
- `README.md` - User-facing documentation
- `CONTRIBUTING.md` - Contribution guidelines + CLA info
- `CHANGELOG.md` - Version history (latest: 2.4.5)
- `COMMERCIAL.md` - Commercial licensing details
- `SECURITY.md` - Security policy and reporting
