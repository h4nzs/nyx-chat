# Migration to XChaCha20-Poly1305

## Goal
Replace the XSalsa20-Poly1305 cipher with XChaCha20-Poly1305 for all new message encryption, accepting that existing messages will become unreadable (Hard Migration).

## Tasks
- [ ] **Worker Update**: Update `crypto.worker.ts` to expose `crypto_secretbox_xchacha20poly1305_easy` and `open_easy`. -> Verify: Worker compiles.
- [ ] **Proxy Update**: Add new methods to `crypto-worker-proxy.ts` interface. -> Verify: TS types are correct.
- [ ] **Logic Swap**: Replace `crypto_secretbox_easy` calls with `xchacha20` in `utils/crypto.ts`. -> Verify: Encrypting a message calls the new function.
- [ ] **Constant Update**: Update nonce length constant if different (XChaCha20 is also 24 bytes, so likely same, but verify). -> Verify: Code uses correct constant.
- [ ] **Cleanup**: Remove XSalsa20 references to ensure clean break. -> Verify: Grep for `crypto_secretbox` returns only XChaCha variants.

## Done When
- [ ] Sending a new message works and is encrypted with XChaCha20.
- [ ] Receiving a new message works and decrypts correctly.
- [ ] Old messages fail to decrypt (expected behavior).
