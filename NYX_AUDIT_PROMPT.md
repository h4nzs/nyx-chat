# NYX — Full Codebase Audit & Review (Read-Only Phase)

## Role and goal

You are acting as a senior security engineer, staff-level full-stack reviewer, and QA lead performing an end-to-end audit of this repository (NYX: zero-knowledge, post-quantum E2EE messenger; React/Vite/TypeScript client with a crypto Web Worker + WASM, Node/Express server, Rust WebTransport sidecar, PostgreSQL/Prisma, Redis, Cloudflare R2).

I am a solo maintainer preparing for a public release. Before I do slow manual testing, I want you to catch as many real defects, security weaknesses, logic bugs, UX problems, and documentation drift as possible. **Precision matters more than volume**: ten verified findings are worth more than fifty speculative ones.

You are starting in a fresh session. Assume nothing about the code. Everything you report must come from what you actually read or ran.

## Hard rules

1. **Read-only.** Do not modify, refactor, or "quickly fix" any source file, config, schema, or dependency. The only files you may create are report files under `docs/audit/`. Fixing happens in a later, separate phase after I approve.
2. **Evidence or it did not happen.** Every finding must cite exact `file:line` and explain the code path that makes it a problem. Before reporting, trace the call path end to end and look for existing guards (middleware, validation, DB constraints, callers) that would make it a non-issue. If you could not verify, label it `UNVERIFIED` and say what would confirm it.
3. **Calibrate.** Give each finding a severity (Critical / High / Medium / Low / Info) and a confidence (High / Medium / Low). Do not inflate severity. Do not present a hypothesis as a fact.
4. **Respect frozen decisions.** `docs/04-crypto-protocol.md` marks wire/storage formats as frozen, and `libsodium-wrappers` must not be changed except for newer PQC primitives. You may report problems in these areas, but flag any suggested fix that would be a breaking change to formats or keys, and never recommend downgrading to classical-only crypto.
5. **No invented problems.** Do not flag style preferences, hypothetical "best practices" with no concrete impact here, or issues already documented as accepted trade-offs (e.g. single active device, non-blocking ESLint) unless the documentation is wrong or the trade-off is worse than stated.
6. **Be honest about coverage.** At the end, state exactly what you did not review or could not run, and why.

## Phase 0 — Orientation (do this before judging anything)

- Read `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and all of `docs/` (architecture, security model, crypto protocol, message pipeline, backend, sidecar, database, API reference).
- Map the monorepo: `web/`, `server/`, `packages/shared`, the Rust sidecar, `scripts/`, CI in `.github/`.
- Write a short mental model into `docs/audit/00-orientation.md`: components, trust boundaries (what runs on client, server, sidecar, Cloudflare, R2), what the server is supposed to be unable to learn, and the list of features you will audit. **Treat docs as claims to verify, not as truth.**

## Phase 1 — Automated baseline

Run what exists and record exact commands and results (do not fix failures, just report them):

- Install, `pnpm run build` for all packages, `npx tsc --noEmit` in each TS package.
- Existing unit and E2E tests; note failures, flaky tests, skipped tests, and which critical areas have no tests.
- ESLint output (even though non-blocking): extract only the findings that indicate real bugs (unhandled promises, unused results of crypto calls, misuse of `any` at trust boundaries, etc.).
- Dependency audit (`pnpm audit`), `cargo clippy` and `cargo audit` for the sidecar if available.
- Search for secrets, hard-coded keys, default credentials, debug flags, leftover `console.log` of sensitive values, TODO/FIXME/HACK notes in security-relevant code.

If a tool cannot run in your environment, say so and continue with static review.

## Phase 2 — Claims audit (README and docs versus code)

Build a table of every security and privacy claim made in the README and `docs/` and verify each against the code. Include at least:

- Server never receives plaintext messages, keys, profile data, or usernames; blind relay behavior.
- No IP addresses, emails, phone numbers, or plaintext usernames stored (check DB schema, logs, Redis, error reporting, rate-limit keys, WebSocket/WebTransport metadata).
- Argon2id username hashing and local profile-key encryption are actually done client-side as described.
- Mandatory post-quantum mode: classical-only downgrade is truly rejected on both client and server, including by a malicious peer or server.
- PQX3DH, X-Wing/ML-KEM usage, PQ-Seals for group key distribution, sender-key fan-out: implemented as documented, including key derivation inputs, nonce handling, and authentication of the handshake (signature verification, identity binding, replay protection).
- Hardware-bound vault (WebAuthn PRF + Argon2id) and `.nyxvault` export/import.
- Expiring messages, single-active-device enforcement, trust tiers (sandbox/VIP, PoW, WebAuthn).
- Terminology: the repo description mentions "Signal Protocol SPQR" and a `pqdr` topic. Determine what is actually implemented (double ratchet? sparse PQ ratchet? symmetric ratchet only?) and say whether the wording over- or under-states it.

Mark each claim: `VERIFIED`, `PARTIALLY TRUE (explain)`, `FALSE`, or `CANNOT VERIFY`.

## Phase 3 — Security review by layer

For each layer, think like an attacker with a specific capability, then check whether the code stops them.

**Attacker models to apply:** (a) malicious or compromised server/DB/Redis/R2 operator, (b) malicious authenticated user, (c) unauthenticated network attacker, (d) malicious contact or group member, (e) attacker with physical or stolen-device access, (f) XSS in the client.

**Crypto and the worker**
- Nonce/IV generation and reuse, key separation, KDF contexts, misuse of libsodium APIs, ignored return values, non-constant-time comparisons, missing zeroization of secrets, secrets leaking to the main thread, logs, IndexedDB in plaintext, or `postMessage` payloads.
- Ratchet and sender-key state: out-of-order, duplicate, and replayed messages; state desync after failure; key rotation on member removal; forward secrecy and post-compromise properties versus what is claimed.
- Handshake: identity-key verification, prekey exhaustion, one-time prekey reuse, signature coverage, downgrade and unknown-key-share possibilities.
- Randomness sources and entropy of recovery phrases and master seed.

**Auth, sessions, devices**
- JWT handling (secret strength enforcement, algorithm pinning, expiry, refresh rotation and reuse detection, revocation), cookie flags, CSRF.
- Device binding and single-device policy: can an old device keep reading or sending? Race conditions during migration.
- Account creation, recovery, and enumeration resistance.

**Server and API**
- For every REST route, WebSocket/WebTransport event, and Redis channel: authentication, **authorization** (membership/ownership checks, IDOR), input validation, size limits, rate limiting, and error messages that leak information. Produce an endpoint-by-endpoint checklist.
- Group operations: add/remove member, role escalation, who can fetch which keys and blobs.
- File/attachment flow with R2: presigned URL scope and expiry, content-type and size enforcement, path/key predictability, orphaned blob handling.
- Prisma queries: injection through raw queries, mass assignment, unbounded queries, missing indexes that enable DoS.
- Rust sidecar and the Redis bridge: authentication between Node and the sidecar, message framing and length limits, panic or unwrap on untrusted input, backpressure, resource exhaustion, what happens if Redis is unavailable or poisoned.

**Client and web**
- XSS sinks (`dangerouslySetInnerHTML`, markdown/link rendering, user-controlled URLs, file names, profile fields after decryption), CSP and security headers, service worker caching of sensitive data, PWA offline behavior, third-party scripts and SRI.
- Trust-the-server-served-JS problem: document what protections exist and what does not.
- Deep links, `postMessage` handlers, clipboard/share handling, notification contents leaking plaintext.

**Privacy and metadata**
- What a server operator can learn (social graph, timing, sizes, device info). Compare against the README wording and list any gap.

## Phase 4 — Functional correctness and robustness

Trace each feature end to end (UI action → store → worker → transport → server → recipient → decryption → render), reading the real code at each hop:

- Registration, login, logout, recovery, vault export/import, device migration.
- 1:1 chat: first message (session init), subsequent messages, offline recipient, reconnect, ordering, duplicates, delivery/read states.
- Groups: create, add/remove, key redistribution, large groups, concurrent changes.
- Attachments and media; expiring messages; deletion semantics (local vs remote).
- Voice/video (WebRTC) signaling if present.
- Trust tier flows (PoW puzzle, WebAuthn verification).
- Failure paths: network drop mid-send, worker crash, IndexedDB quota/corruption/version migration, clock skew, Redis/DB outage, partial writes, retries without idempotency.
- Concurrency: race conditions between tabs, between ratchet advance and persistence, stale Zustand state, unhandled promise rejections, memory leaks (listeners, workers, object URLs).

## Phase 5 — UI/UX and accessibility review (from code and, if possible, running the app)

- Every screen and state: loading, empty, error, offline, permission denied, expired session. Flag missing or misleading states and dead ends.
- Forms: validation, error copy, disabled states, double-submit.
- Dangerous actions: confirmation and clarity (logout without vault backup, account loss, device replacement).
- i18n: missing keys, hard-coded strings, layout breaks from long strings, RTL assumptions.
- Responsive/mobile/PWA behavior, keyboard navigation, focus management, ARIA, contrast, touch targets, reduced motion.
- Security UX: do users get understandable warnings for key changes, unverified contacts, and backup responsibility?

If you can run the app and a browser/E2E tool, exercise the main flows and record what happened. If not, say so and rely on code reading.

## Phase 6 — Tests and docs gap analysis

- Which security-critical and high-risk paths have no tests? Propose a prioritized list of tests to add (do not write them yet), starting with crypto invariants, authorization checks, and handshake/downgrade rejection.
- List places where docs and code disagree, with file references.

## How to work (important for quality)

- Work in the phases above, in order. **Write findings to disk incrementally** (`docs/audit/01-baseline.md`, `02-claims.md`, `03-security.md`, `04-functional.md`, `05-uiux.md`, `06-tests-docs.md`) so nothing is lost if your context fills up. At the start of each phase, re-read your previous notes rather than relying on memory.
- If your environment supports sub-agents, you may parallelize by area (crypto/worker, server/API, sidecar, client UI). Sub-agent results are leads, not facts: **personally re-verify every High and Critical finding** against the code before including it.
- Prefer reading actual code paths over grepping for keywords alone. Grep to find candidates, then read the surrounding logic.
- When uncertain whether something is a bug, state the assumption you would need confirmed and ask me at the end rather than guessing.
- Do not stop after the first problems you find in an area. Complete each phase.

## Final deliverable: `docs/audit/AUDIT_REPORT.md`

Write the report in **Indonesian** (keep technical terms, identifiers, and code in English). Structure:

1. **Executive summary**: overall assessment, the top 5 risks, and release-readiness opinion, in plain language.
2. **Scope and coverage**: what was reviewed, what was run, what was not, and limitations.
3. **Findings table**, sorted by severity, with columns: ID, severity, confidence, area, title, `file:line`.
4. **Detailed findings**: for each, description, attack or failure scenario, why existing guards do not prevent it, evidence, impact, recommended fix (flag breaking changes to frozen formats), and a suggested test that would catch it.
5. **Claims audit table** from Phase 2.
6. **Verified-OK list**: important areas you checked and found sound, so I know what does not need attention.
7. **Manual test checklist**: a prioritized, step-by-step list of the things static review could not confirm (device/browser-specific behavior, real WebAuthn, WebTransport on real networks, PWA install/offline, push notifications, multi-device migration, load), written so I can run it quickly.
8. **Recommended fix order**: grouped into batches (e.g. "must fix before public release", "should fix", "nice to have"), with dependencies between fixes.

When finished, give me a brief chat summary and **stop**. Do not begin fixing anything until I review the report and tell you which findings to address.
