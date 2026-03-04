# Contributing to NYX 🏴‍☠️

First off, thank you for considering contributing to NYX! Building a mathematically secure, zero-knowledge messenger is a massive undertaking, and we need elite operatives to audit and improve the fortress.

## 🛑 STRICT RULES OF ENGAGEMENT (MUST READ)

Before you write any code, understand our architectural boundaries:
1. **The Core Crypto is Sacred:** Do **NOT** bump, update, or modify `libsodium-wrappers` or its type definitions. Backward compatibility in the Double Ratchet engine is our absolute highest priority.
2. **Package Manager:** We use `pnpm` exclusively. Do not use `npm` or `yarn`. Do not commit `package-lock.json` or `yarn.lock`.
3. **Strict State:** We use Zustand v5. Do not return objects in selectors without `useShallow`, or you will trigger infinite render loops.
4. **Formatting:** We use ESLint v10 (Flat Config). Your code must pass `pnpm run lint` without any warnings.

## 🛠️ Development Workflow

1. **Fork the repo** and create your branch from `main`.
2. **Install dependencies:** `pnpm install`
3. **Run local environment:** Setup your `.env` (see README) and run `pnpm dev`.
4. **Make your changes:** Keep commits atomic and use Conventional Commits (e.g., `feat: add markdown support`, `fix: decrypt worker memory leak`).
5. **Test your code:** Ensure building works (`pnpm run build` in both `/web` and `/server`).
6. **Issue a PR:** Use the provided Pull Request template.

## 🕵️ Where We Need Help
- Auditing the Web Worker crypto implementation (`crypto.worker.ts`).
- Memory profiling the React Virtualized lists for massive chat histories.
- E2E testing setups.
