# Secure Session Key Storage (Master Key Encryption)

## Goal
Enhance security by encrypting session keys at rest using the Master Key (derived from user password). This prevents local attacks (e.g., IDB theft) from exposing message keys without the user's credentials.

## Tasks
- [ ] **Worker Update (`crypto.worker.ts`)**: Add `encryptSessionKey` and `decryptSessionKey` methods. These should use `crypto_secretbox` (or AEAD) with the Master Key (or a derived "Session Storage Key") to wrap/unwrap session keys. -> Verify: Worker compiles.
- [ ] **Proxy Update (`crypto-worker-proxy.ts`)**: Expose the new worker methods to the main thread. -> Verify: TS types are correct.
- [ ] **Store Update (`keychainDb.ts`)**: 
    -   Modify `addSessionKey` to accept the `masterKey` (or derive it internally if passed, but passing seems safer/faster if already cached). 
    -   Wait, passing Master Key to DB layer is risky if it persists. Better: Encrypt *before* calling DB.
    -   **Refined Task**: Modify `keychainDb.ts` to expect *encrypted* blobs for session keys, OR keep it dumb and handle encryption in the Service Layer (`message.ts` / `crypto.ts`).
    -   **Decision**: Keep `keychainDb.ts` dumb (storage only). Move logic to `utils/crypto.ts` or `store/auth.ts` helper.
    -   Let's update `addSessionKey` and `getSessionKey` signatures or creating wrapper functions in `crypto.ts` that handle the encryption/decryption using the cached Master Key from `authStore`.
- [ ] **Implementation (`utils/crypto.ts`)**:
    -   Create `secureStoreSessionKey(convoId, sessionId, key)`: Fetches Master Key from AuthStore -> Encrypts `key` -> Calls `db.addSessionKey`.
    -   Create `secureGetSessionKey(convoId, sessionId)`: Calls `db.getSessionKey` -> Fetches Master Key -> Decrypts.
- [ ] **Refactor Callsites**:
    -   Find all `addSessionKey` usages (e.g., in `ensureAndRatchetSession`). Replace with secure version.
    -   Find all `getSessionKey` usages (e.g., in `decryptMessage`). Replace with secure version.

## Done When
- [ ] Session Keys stored in IndexedDB are ciphertext strings/bytes, not raw Uint8Arrays.
- [ ] User can still read messages after login (keys decrypt successfully).
- [ ] Logging out (clearing Master Key cache) renders the IDB keys useless (until re-login).

## Notes
- **Master Key Availability**: The Master Key is cached in `authStore` (`privateKeysCache.masterSeed`). We need to ensure it's available when messages arrive in the background (Service Worker?). 
- **Wait**, SW doesn't have access to `authStore` memory!
- **Constraint Check**: If we encrypt session keys with Master Key, the **Service Worker** (for Push Decryption) cannot read them because it doesn't know the user's password/Master Key.
- **Impact**: Background notification decryption will BREAK if we do this, unless we also store the Master Key in IDB (which defeats the purpose) or accept that notifications show "Encrypted Message".
- **Decision**: Accept that background decryption might be limited or require the app to be open. OR, use a separate "Background Key" stored in IDB (obfuscated) but that's security theater.
- **Current Architecture**: The app seems to rely on client-side logic for display. SW just shows "New Message".
- **Conclusion**: Proceed. Security at rest > Background convenience.
