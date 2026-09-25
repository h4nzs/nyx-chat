# NYX Documentation

Comprehensive documentation for the NYX codebase and application — a zero-knowledge, post-quantum hardened messenger.

> ⚠️ **Maintainer note:** The crypto/protocol documents (`03-security-model.md`, `04-crypto-protocol.md`, `05-message-pipeline.md`, `08-webtransport-sidecar.md`) describe **frozen formats and primitives**. Never change them without an explicit security review.

## Navigation

### Core concepts

| Document | Content | Read this if you… |
|---|---|---|
| [01-architecture.md](01-architecture.md) | System overview, monorepo layout, request/data flows, diagrams | Are new to the codebase |
| [02-getting-started.md](02-getting-started.md) | Dev environment setup, daily commands, gotchas | Are setting up a machine |
| [03-security-model.md](03-security-model.md) | Threat model, E2EE guarantees, session/device binding | Touch auth, keys, or storage |
| [04-crypto-protocol.md](04-crypto-protocol.md) | Crypto spec: PQX3DH, ratchets, envelopes, at-rest formats, all 45 worker ops | Touch any crypto code |
| [05-message-pipeline.md](05-message-pipeline.md) | End-to-end send/receive flow, transport framing, Redis bridge | Debug messaging/realtime |

### Feature guides (end-to-end)

| Document | Content |
|---|---|
| [14-auth-identity.md](14-auth-identity.md) | Registration, password & biometric login, refresh, recovery, devices, ghost profiles, safety numbers, vault export/migration |
| [15-messaging.md](15-messaging.md) | Send/receive pipeline, statuses, reactions/edit/unsend, view-once, silent, expiry, voice, offline/reconnect |
| [16-groups.md](16-groups.md) | Group creation, metadata E2EE, sender-key distribution, membership, key rotation |
| [17-burner.md](17-burner.md) | Burner chats: link, anonymous guest, PQ-DR, file sharing, destroy |
| [18-realtime-transport.md](18-realtime-transport.md) | WebTransport worker, Rust sidecar, Redis bridge, presence/typing, calls, push, reconnect |
| [19-media-stories.md](19-media-stories.md) | Attachment encryption/upload/cache, stories, media tools |
| [20-subscriptions-b2b.md](20-subscriptions-b2b.md) | Trust tiers, crypto-only payments (NOWPayments), B2B engine/embed, reports, admin |

### Reference (module catalog)

| Document | Content |
|---|---|
| [06-frontend.md](06-frontend.md) | Web app overview: stores, rendering, i18n, PWA |
| [21-frontend-reference.md](21-frontend-reference.md) | Full `web/src` inventory: stores, libs, pages, components, workers, hooks, utils |
| [07-backend.md](07-backend.md) | Express overview: middleware, jobs, Redis keys |
| [22-backend-reference.md](22-backend-reference.md) | Full `server/src` inventory: routes, middleware, bridge, utils, jobs |
| [23-shared-sidecar.md](23-shared-sidecar.md) | `packages/shared` (brands/schemas/opcodes/events) + Rust sidecar detail |
| [24-marketing.md](24-marketing.md) | Marketing site: pages, components, i18n, design tokens |
| [12-api-reference.md](12-api-reference.md) | Complete REST endpoint catalog |

### Operations

| Document | Content |
|---|---|
| [08-webtransport-sidecar.md](08-webtransport-sidecar.md) | Rust sidecar, protocol framing, opcodes, deployment |
| [09-database.md](09-database.md) | Prisma schema, indexes, backup, migration |
| [10-deployment-ops.md](10-deployment-ops.md) | CI/CD, VPS runbook, env vars, post-deploy checklist |
| [11-testing.md](11-testing.md) | Unit tests, E2E, environment limitations |
| [13-troubleshooting.md](13-troubleshooting.md) | Known errors and their fixes |
| [25-repo-infra-agents.md](25-repo-infra-agents.md) | Root repo files, CI/agent workflows, Docker Compose, agent-skills content, ambient type declarations |

## Quick facts

- **Stack:** pnpm monorepo — React 19 + Vite 8 (web), Express 5 + Prisma 7 + Redis (server), Astro (marketing), Rust `wtransport` (transport sidecar).
- **Repo root conventions:** see [AGENTS.md](../AGENTS.md) — it contains hard-earned operational rules (shared package rebuild order, frozen crypto formats, Zod jitless, ESLint status, prod DB layout).
- **E2EE core files (do not split):** `web/src/workers/crypto.worker.ts`, `web/src/lib/crypto-worker-proxy.ts`, `web/src/lib/messagePipeline.ts`.
