# 11 — Testing

## 11.1 Unit tests

| Package | Runner | Command | Count |
|---|---|---|---|
| server | `node:test` via `tsx` (Jest config is dead — ignore it) | `pnpm --filter nyx-server run test` | 22 |
| web | Vitest (jsdom) | `pnpm --filter nyx-web run test` | 35 |
| everything | — | `pnpm -r --if-present run test` | 57 |

Server tests are listed explicitly in `server/package.json` (`tsx --test tests/…`). They must **not** require Postgres/Redis — Prisma clients are faked (see `tests/sessionKeys.test.ts`).

Web test files live in `src/lib/__tests__/` (biometric/auto-unlock, cover traffic, group metadata/roster/pseudonyms, pairwise key delivery, refresh lock/retry, shadow-vault delete, socket sync/listeners, transport mode/queue, burner file data), `src/store/__tests__/` (connection, send watchdog, silent refresh, participant sync, unread count), `src/utils/__tests__/` (date, sanitize, tempId, typeGuards, url), and `src/components/__tests__/passwordPromptBiometric.test.tsx`.

Covered areas: password hashing, `safeEqualStrings`, JWT, `toRawServerMessage` (incl. a regression guard that `ciphertext` is never emitted), session-key blind relay, type guards, sanitize (XSS + secret redaction), URL helpers, date formatting.

```bash
# Single test file
cd server && pnpm exec tsx --test tests/mappers.test.ts
cd web && npx vitest run src/utils/__tests__/sanitize.test.ts
```

## 11.2 E2E (Playwright)

```bash
cd web
pnpm exec playwright test --project=chromium
pnpm exec playwright test e2e/auth.spec.ts --project=chromium   # single spec
```

**Prerequisites (local):**
- Postgres + Redis running.
- API dev: `pnpm --filter nyx-server dev`.
- Web dev: `pnpm --filter nyx-web dev`.
- WebTransport specs additionally need the Rust sidecar (they **auto-skip** when `WebTransport` is undefined — e.g. headless Chromium without QUIC).

**Important quirks:**
- `workers: 1` (serial) — the suite is flaky in parallel against one local server.
- `e2e/global.setup.ts` wipes the local DB + Redis (`server/scripts/reset-test-env.ts`). Never run against a valuable database.
- Registration helpers walk the full onboarding modal chain (Proof of Trust → Recovery → Secure Phrase → Verify Sequence ×2 close → System Init). Helpers are duplicated per spec file — that's the repo convention; update all copies together.
- Slow assertions use `expect.poll` / generous timeouts (crypto registration takes 15–60s).

## 11.3 CI matrix

| Job | Browser | Transport |
|---|---|---|
| `e2e` | Playwright chromium (headless shell) | transport specs skipped |
| `e2e-chrome` | Google Chrome via apt (`channel: 'chrome'`) | **sidecar built + running**, cert hash parsed from its banner → transport + chat specs run fully |

## 11.4 What is NOT covered (known gaps)

- No browser-level test for WebRTC calls.
- No test for the biometric (WebAuthn) login path (needs a real authenticator).
- Payment webhooks are only unit-tested indirectly (HMAC compare helper).
- Crypto worker internals are exercised through E2E flows, not unit tests (worker is monolithic by design).

## 11.5 Writing new E2E specs

1. Copy the `registerUser` helper from an existing spec.
2. Add the `WebTransport` guard at test start if the flow needs realtime:

```ts
const supported = await page.evaluate(() => typeof WebTransport !== 'undefined');
test.skip(!supported, 'WebTransport tidak tersedia di environment ini');
```

3. Keep selectors role/text-based (repo convention) and avoid `waitForTimeout` except where unavoidable.
