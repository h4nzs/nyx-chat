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
| [16-groups.md](16-groups.md) | Group creation, metadata E2EE, sender-key distribution, membership, key rotation, admin capability token (RBAC) — **blueprint 26 (T1–T4) implemented, see banner** |
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
| [10-deployment-ops.md](10-deployment-ops.md) | CI/CD, VPS runbook, env vars, post-deploy checklist, semua service prod (KT `nyx-kt-query`, coturn, observability) |
| [11-testing.md](11-testing.md) | Unit tests, E2E, environment limitations |
| [13-troubleshooting.md](13-troubleshooting.md) | Known errors and their fixes |
| [26-group-privacy-blueprint.md](26-group-privacy-blueprint.md) | Group metadata hardening blueprint: sender pseudonyms, pairwise key distribution, blinded membership & receipts — **T1–T4 fully implemented (2026-09-26)** | Design record & residual leaks |
| [27-total-upgrade-plan.md](27-total-upgrade-plan.md) | Master plan post-VPS-closure: infra rebuild, server/client lifting, privacy tiers, calls, media, observability | Run the rebuild-and-relaunch cycle |
| [28-db-dump-threat-model.md](28-db-dump-threat-model.md) | DB-dump threat model: 17 tabel, graph yang bisa direkonstruksi, temuan D1–D14 ber-severity, rencana bertingkat (Tier 0 tanpa perubahan klien → Tier 2 metadata) — **audit selesai; Tier 0–3 + residual landed** (kini catatan ancaman + guardrail) | Harden privasi at-rest server |
| [29-signal-parity-analysis.md](29-signal-parity-analysis.md) | Analisis komparatif NYX vs Signal (source-level, `~/signal`): tabel per domain, celah (KT, multi-device, backup, SPQR), temuan audit §7.1–§7.5, roadmap ROI — **quick wins 1–7 landed (2026-10-11)** | Menyusun prioritas fitur |
| [30-post-parity-implementation-plan.md](30-post-parity-implementation-plan.md) | Rencana implementasi semua item `docs/29` yang belum: KT penuh (B+C), multi-device, backup ber-frame, SPQR, calls/coturn, storage lokal, observability, anti-abuse — dengan pin commit Signal, acceptance gate, dan milestone M0–M8 — **mayoritas item landed; sisa per baris status** | Mengerjakan sisa item pasca-paritas |
| [31-backup-format.md](31-backup-format.md) | Format backup ber-frame: tata letak arsip, KDF dari recovery phrase, padding anti-bocor-ukuran, AAD anti-tamper/reorder/truncate, API + fase lanjutan | Menyentuh backup/restore & pemulihan perangkat |
| [32-key-transparency-kt.md](32-key-transparency-kt.md) | Log Key Transparency: search key `0x75\|\|usernameHash`, nilai log v1 (frozen), transport gRPC tanpa dependensi, titik tulis register/recover, metrik+alert — **penulis + verifier klien + monitor/auditor/gossip landed; log v1 frozen, v2 dual-write** | Mengisi/audit log kunci |
| [33-spqr-wasm.md](33-spqr-wasm.md) | Ratchet SPQR (PQ forward secrecy **dan** post-compromise security): pembungkus WASM tanpa `wasm-bindgen`, ABI, 10 test properti, benchmark terukur — **SELESAI: wire v2 + integrasi + rollback + E2E Chrome landed** | Menyentuh ratchet PQ / kapabilitas `spqr-ratchet` |
| [34-key-transparency-verifier.md](34-key-transparency-verifier.md) | Verifier Key Transparency di klien: modul WASM `libsignal-keytrans` (nol import), **74 test** dengan bukti nyata dari binary Go kt-server, temuan "anchor wajib", residual — **bundle + monitor + auditor + gossip landed** | Memakai/mengembangkan verifikasi log kunci |
| [35-post-quantum-migration-plan.md](35-post-quantum-migration-plan.md) | Rencana migrasi Tier A ke post-quantum: inventaris classical-only, format v2 (bundle, X3DH, sealed box, group, KT value), credential suite, anonymous issuance, discovery/metadata, gate & rollback — **Fase 0–7 landed di kode (default mati, v2 dual-write, baca masih v1); Fase 8 belum** | Men-deploy / menyelesaikan Fase 8 |
| [25-repo-infra-agents.md](25-repo-infra-agents.md) | Root repo files, CI/agent workflows, Docker Compose, agent-skills content, ambient type declarations |

## Quick facts

- **Stack:** pnpm monorepo — React 19 + Vite 8 (web), Express 5 + Prisma 7 + Redis (server), Astro (marketing), Rust `wtransport` (transport sidecar).
- **Repo root conventions:** see [AGENTS.md](../AGENTS.md) — it contains hard-earned operational rules (shared package rebuild order, frozen crypto formats, Zod jitless, lint gate (oxlint) + aturan direktif penekan, prod DB layout).
- **E2EE core files (do not split):** `web/src/workers/crypto.worker.ts`, `web/src/lib/crypto-worker-proxy.ts`, `web/src/lib/messagePipeline.ts`.
