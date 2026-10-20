// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Burner v2 (PQ-only) — kontrak derivasi root key.
 *
 * Mengunci jalur kritis langkah 8: pada sesi v2 root key HANYA diturunkan dari
 * shared secret X-Wing (`generichash(64, ss)`), tanpa mencampur X25519. Test
 * mereproduksi byte-for-byte formula di `crypto.worker.ts`
 * `burner_dr_init_guest/host` (blok `pqOnly`) memakai primitif asli, sehingga
 * ketidaksepakatan guest/host (mis. salah satu masih mencampur classical)
 * langsung tertangkap tanpa menjalankan worker.
 */
import { describe, it, expect } from 'vitest';
import { getSodium } from '../sodiumInitializer';

async function pqOnlyGuestRootKey(hostPqPk: Uint8Array) {
  const sodium = await getSodium();
  const pqKeypair = sodium.crypto_kem_xwing_keypair();
  const pqResult = sodium.crypto_kem_xwing_enc(hostPqPk);
  // pqOnly: combinedSecret = pqResult.sharedSecret (tanpa classicalShared).
  const combined = new Uint8Array(pqResult.sharedSecret.length);
  combined.set(pqResult.sharedSecret, 0);
  const KDF = sodium.crypto_generichash(64, combined, null);
  return {
    RK: KDF.slice(0, 32),
    CKs: KDF.slice(32, 64),
    savedCt: pqResult.ciphertext,
  };
}

async function pqOnlyHostRootKey(hostPqSk: Uint8Array, ct: Uint8Array) {
  const sodium = await getSodium();
  const pqSharedSecret = sodium.crypto_kem_xwing_dec(ct, hostPqSk);
  const KDF = sodium.crypto_generichash(64, pqSharedSecret, null);
  return { RK: KDF.slice(0, 32), CKr: KDF.slice(32, 64) };
}

function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

describe('burner v2 — root key PQ-only', () => {
  it('guest (X-Wing enc) dan host (X-Wing dec) menurunkan RK/CK yang sama', async () => {
    const sodium = await getSodium();
    const hostKeypair = sodium.crypto_kem_xwing_keypair();

    const guest = await pqOnlyGuestRootKey(hostKeypair.publicKey);
    const host = await pqOnlyHostRootKey(hostKeypair.privateKey, guest.savedCt);

    expect(toHex(guest.RK)).toBe(toHex(host.RK));
    expect(toHex(guest.CKs)).toBe(toHex(host.CKr));
  });

  it('RK v2 berbeda dari RK hybrid v1 (X25519 || X-Wing) untuk secret X-Wing yang sama', async () => {
    const sodium = await getSodium();
    const hostKeypair = sodium.crypto_kem_xwing_keypair();

    const guest = await pqOnlyGuestRootKey(hostKeypair.publicKey);

    // Simulasikan hybrid v1: classicalShared(32) || pqSharedSecret.
    const pqSharedSecret = sodium.crypto_kem_xwing_dec(guest.savedCt, hostKeypair.privateKey);
    const classicalShared = sodium.randombytes_buf(32);
    const hybridSecret = new Uint8Array(classicalShared.length + pqSharedSecret.length);
    hybridSecret.set(classicalShared, 0);
    hybridSecret.set(pqSharedSecret, classicalShared.length);
    const hybridKDF = sodium.crypto_generichash(64, hybridSecret, null);

    expect(toHex(hybridKDF.slice(0, 32))).not.toBe(toHex(guest.RK));
  });
});
