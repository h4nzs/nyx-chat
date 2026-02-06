**MISSION:** PHASE 1 - CRYPTO QUARANTINE (LAZY LOADING)
**TARGET FILE:** `web/src/store/auth.ts`
**GOAL:** Increase "Time to Interactive" on the Landing Page by decoupling `libsodium` and `crypto-worker` from the initial bundle.

**CURRENT STATUS:**
The file `store/auth.ts` statically imports heavy dependencies (`@lib/sodiumInitializer`, `@lib/crypto-worker-proxy`). This causes the entire crypto engine to load immediately when the app starts, even for unauthenticated users visiting the Landing Page.

**TASK INSTRUCTIONS:**

1.  **Remove Static Imports:**
    Remove the top-level imports for:
    - `@lib/sodiumInitializer` (`getSodium`)
    - `@lib/crypto-worker-proxy` (All imports)
    - `@lib/fileUtils` (`compressImage`) - Optional, but good practice.
    - `@lib/r2` (`uploadToR2`) - Optional.

2.  **Implement Dynamic Imports (Code Splitting):**
    Refactor the following actions to load these dependencies ONLY when executed:
    - `setupAndUploadPreKeyBundle` -> Import `getSodium` inside.
    - `login` -> Import `retrievePrivateKeys` inside.
    - `registerAndGeneratePhrase` -> Import `registerAndGenerateKeys` and `retrievePrivateKeys` inside.
    - `tryAutoUnlock` -> Import `retrievePrivateKeys` inside.
    - `updateAvatar` -> Import `compressImage` and `uploadToR2` inside.
    - getters like `getEncryptionKeyPair` -> Import `getSodium` inside.

3.  **Refactor `bootstrap` Logic (CRITICAL):**
    - The `bootstrap` function runs on app load.
    - **Logic Change:** DO NOT load crypto libraries immediately.
    - ONLY if a valid `accessToken` is found (user is logged in), THEN trigger the dynamic import of crypto libraries to prepare the session.
    - If no user is found (Landing Page visitor), the crypto libraries must remains unloaded.

4.  **Add Loading State:**
    - Add a new state property: `isInitializingCrypto: boolean` (default `false`).
    - Set this to `true` while the dynamic imports are resolving during `login` or `bootstrap`.
    - This allows the UI to show a spinner instead of freezing.

**EXAMPLE PATTERN:**

*Before:*
```typescript
import { heavyFunction } from "heavy-lib";
// ...
login: async () => {
  heavyFunction();
}

```

*After:*

```typescript
// No import at top
// ...
login: async () => {
  set({ isInitializingCrypto: true }); // UI Feedback
  try {
    const { heavyFunction } = await import("heavy-lib"); // Browser downloads chunk here
    heavyFunction();
  } finally {
    set({ isInitializingCrypto: false });
  }
}

```

**CONSTRAINTS:**

* **NO Logic Changes:** Do not change how encryption works (Argon2, X3DH, etc). Only change *when* the code is loaded.
* **Type Safety:** Ensure TypeScript types for the imported modules are preserved.
* **Error Handling:** If the network fails to download the chunk, `login` should throw a clear error ("Failed to load security module. Please check your connection.").

**EXECUTION:**
Refactor `web/src/store/auth.ts` now applying these rules.

```