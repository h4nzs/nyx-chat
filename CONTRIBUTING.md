# Contributing to NYX 🏴‍☠️

First off, thank you for considering contributing to NYX! Building a mathematically secure, zero-knowledge messenger is a massive undertaking, and we need elite operatives to audit and improve the fortress.

## ⚖️ Legal Checkpoint: The CLA
Before you start writing code, please note that **NYX operates under a Dual-Licensing model.** To accept your Pull Request, we require you to sign our **Contributor License Agreement (CLA)**. This ensures that you grant us the right to distribute your code commercially, while you still retain ownership of your original work. 

*You do not need to sign anything manually right now. When you open your first Pull Request, a bot (@cla-assistant) will automatically comment on your PR asking you to digitally sign the agreement by clicking a button.*

## 🛑 STRICT RULES OF ENGAGEMENT (MUST READ)

Before you write any code, understand our architectural boundaries:
1. **The Core Crypto is Sacred:** Do **NOT** bump, update, or modify `libsodium-wrappers` or its type definitions. Backward compatibility in the Double Ratchet engine is our absolute highest priority.
2. **Package Manager:** We use `pnpm` exclusively. Do not use `npm` or `yarn`. Do not commit `package-lock.json` or `yarn.lock`.
3. **Strict State:** We use Zustand v5. Do not return objects in selectors without `useShallow`, or you will trigger infinite render loops.
4. **Formatting/Linting:** We use **oxlint** (`pnpm run lint`, config in `.oxlintrc.json`) — our only linter. CI is **blocking on `error`**: rules at `error` level and the `correctness` category must stay at 0 findings. ESLint was removed entirely on 2026-10-15 (configs, devDependencies and directives) because `typescript-eslint` rejects TypeScript 7 — do not reintroduce it. Suppressions use `// oxlint-disable-next-line <rule>` placed on the line directly above the code.

## 🛠️ Development Workflow

1. **Fork the repo** and create your branch from `main`.
2. **Install dependencies:** `pnpm install`
3. **Run local environment:** Setup your `.env` (see README), then start the two dev servers separately — there is **no** root `dev` script: `pnpm --filter nyx-server dev` (Express :4000) and `pnpm --filter nyx-web dev` (Vite :5173). WebTransport needs the Rust sidecar running too (`docs/08`); without it the client falls back to WSS.
4. **Make your changes:** Keep commits atomic and use Conventional Commits (e.g., `feat: add markdown support`, `fix: decrypt worker memory leak`).
5. **Test your code:** `pnpm -r run build`, plus `pnpm -r --if-present run test`, `pnpm run lint` (oxlint), and `node scripts/check-pq-only.mjs`. After editing `packages/shared/src`, rebuild it first (`pnpm --filter @nyx/shared run build`) or typechecks see stale `dist/`.
6. **Issue a PR:** Use the provided Pull Request template.

## 🧾 Third-party attribution & committed artifacts (Signal)

Some subsystems are built around **unmodified Signal code** (AGPL-3.0-only) that is pinned to a commit. Since 2026-10-13 the pinned sources are **vendored inside this repo** (`vendor/signal/`, `server/kt-query/vendor/`), so a clean clone builds everything without any external checkout — the three components, their commits, and everything that actually lives in this repo are listed in **[`NOTICE`](NOTICE)**. Read it before touching `packages/spqr-wasm/` or `server/kt-query/`. The Key Transparency verifier (`packages/keytrans-v2` + `packages/keytrans-wasm-v2`) is NYX's own ML-DSA-65 fork, not vendored Signal code.

Rules that keep this setup working:

1. **Never delete, truncate, or hand-edit** `packages/spqr-wasm/dist/spqr.wasm` or any committed WASM artifact (`keytrans-wasm-v2/dist/keytrans-v2.wasm`, `pir-wasm/dist/pir-client.wasm`). They are committed on purpose and a missing artifact breaks the web build.
2. To regenerate an artifact, run the package's `build.sh` (it builds from `vendor/` by default) and commit the result **together with `packages/wasm-artifacts.json`**. Both builds are path-independent (absolute paths are remapped, toolchain pinned in `rust-toolchain.toml`), so the hash is the same on your machine and in CI.
3. The guards CI runs: `bash scripts/check-wasm-artifacts.sh` (missing / empty / untracked artifact, or a hash that no longer matches the manifest → red build) and the `wasm` job, which **rebuilds both artifacts from `vendor/` and compares the hashes** — i.e. the committed binary is now provably produced by the pinned sources in this repo.
4. When an upstream pin moves, update **`NOTICE` (commit hash + artifact size) and the pins in `docs/30` §30.2 in the same PR**.

## 🕵️ Where We Need Help
- Auditing the Web Worker crypto implementation (`crypto.worker.ts`).
- Memory profiling the React Virtualized lists for massive chat histories.
- E2E testing setups.
