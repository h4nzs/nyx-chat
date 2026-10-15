// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// [docs/30 WS-G(6)] VEKTOR LINTAS-IMPLEMENTASI: X3DH + kdfChain NYX vs oracle.
//
// Sampai sekarang setiap test kripto NYX membandingkan implementasi NYX dengan
// implementasi NYX (libsodium yang sama) — dua salinan yang sama-sama salah akan
// sama-sama setuju. Test ini membandingkannya dengan implementasi yang **tidak
// memakai libsodium sama sekali** (`tools/dr-oracle`, Go: cloudflare/circl +
// golang.org/x/crypto) pada primitif yang sama:
//
//   X25519 · konversi Ed25519→X25519 (+kebalikannya) · X-Wing (ML-KEM-768+X25519)
//   · BLAKE2b keyed (crypto_generichash) · urutan & panjang rahasia X3DH
//
// Vektor ada di `fixtures/x3dhOracleVectors.json`. Regenerasi:
//   cd tools/dr-oracle && go run . -write      # lalu `go run . -check` = gate drift
//
// Yang diuji adalah **worker yang sebenarnya** (`crypto.worker.ts`) lewat
// harness, bukan salinan logika di test.

import { describe, expect, it } from 'vitest';
import vectors from './fixtures/x3dhOracleVectors.json';
import { kdfChain } from '../../workers/crypto.worker';
import { b64uToBytes, callWorker, toHex } from './helpers/workerHarness';

interface KeyPairJson {
  publicKey: string;
  privateKey: string;
}

interface X3dhVector {
  name: string;
  note: string;
  aliceSigningPublicKey: string;
  bob: {
    identityKey: KeyPairJson;
    signedPreKey: KeyPairJson;
    pqIdentityKey: KeyPairJson;
    pqSignedPreKey: KeyPairJson;
    myOneTimePreKeyJson?: string;
  };
  initiatorCiphertexts: string;
  sessionKey: string;
}

const x3dhVectors = vectors.x3dh as unknown as X3dhVector[];

async function recipientSessionKey(vector: X3dhVector, blobOverride?: Uint8Array) {
  const payload: Record<string, unknown> = {
    myIdentityKey: {
      publicKey: b64uToBytes(vector.bob.identityKey.publicKey),
      privateKey: b64uToBytes(vector.bob.identityKey.privateKey),
    },
    mySignedPreKey: {
      publicKey: b64uToBytes(vector.bob.signedPreKey.publicKey),
      privateKey: b64uToBytes(vector.bob.signedPreKey.privateKey),
    },
    myPqIdentityKey: {
      publicKey: b64uToBytes(vector.bob.pqIdentityKey.publicKey),
      privateKey: b64uToBytes(vector.bob.pqIdentityKey.privateKey),
    },
    myPqSignedPreKey: {
      publicKey: b64uToBytes(vector.bob.pqSignedPreKey.publicKey),
      privateKey: b64uToBytes(vector.bob.pqSignedPreKey.privateKey),
    },
    theirSigningKey: b64uToBytes(vector.aliceSigningPublicKey),
    initiatorCiphertexts: blobOverride ?? b64uToBytes(vector.initiatorCiphertexts),
  };
  if (vector.bob.myOneTimePreKeyJson) {
    // Worker membungkus kunci OTPK perangkat sebagai teks JSON.
    payload.myOneTimePreKey = {
      privateKey: new TextEncoder().encode(vector.bob.myOneTimePreKeyJson),
    };
  }
  return callWorker<Uint8Array>('x3dh_recipient', payload);
}

describe('oracle lintas-implementasi — X3DH sisi penerima', () => {
  it('vektor memuat dua kasus (dengan & tanpa One-Time Pre-Key)', () => {
    expect(x3dhVectors.map((v) => v.name)).toEqual(['x3dh-plain', 'x3dh-with-otpk']);
  });

  for (const vector of x3dhVectors) {
    it(`${vector.name}: sessionKey NYX == sessionKey oracle`, async () => {
      const nyx = await recipientSessionKey(vector);
      expect(nyx.length).toBe(32);
      expect(toHex(nyx)).toBe(toHex(b64uToBytes(vector.sessionKey)));
    });
  }

  it('kontrol negatif: byte kunci efemeral diubah → sessionKey BERBEDA', async () => {
    const vector = x3dhVectors[0]!;
    const blob = b64uToBytes(vector.initiatorCiphertexts);
    // Byte ke-4 = byte pertama kunci efemeral (header 4 byte di depannya).
    blob[4] = blob[4]! ^ 0x01;
    const nyx = await recipientSessionKey(vector, blob);
    expect(toHex(nyx)).not.toBe(toHex(b64uToBytes(vector.sessionKey)));
  });

  it('kontrol negatif: kunci penerima milik vektor lain → sessionKey BERBEDA', async () => {
    const [plain, withOtpk] = [x3dhVectors[0]!, x3dhVectors[1]!];
    // Pakai blob vektor pertama tetapi kunci Bob vektor kedua (tanpa OTPK).
    const nyx = await recipientSessionKey({ ...plain, bob: withOtpk.bob }, undefined);
    expect(toHex(nyx)).not.toBe(toHex(b64uToBytes(plain.sessionKey)));
  });

  it('blob ber-OTPK tanpa kunci OTPK lokal → GAGAL keras (bukan kunci yang salah)', async () => {
    const vector = x3dhVectors[1]!;
    await expect(recipientSessionKey({ ...vector, bob: { ...vector.bob, myOneTimePreKeyJson: undefined } })).rejects.toThrow(
      /One-Time Pre-Key/i
    );
  });
});

describe('oracle lintas-implementasi — kdfChain (BLAKE2b keyed)', () => {
  const chainVectors = vectors.kdfChain as unknown as { chainKey: string; messageKey: string; newChainKey: string }[];

  it('vektor memuat rantai 4 langkah', () => {
    expect(chainVectors.length).toBe(4);
  });

  it('setiap langkah cocok dengan oracle (messageKey + chainKey berikutnya)', async () => {
    for (const [index, vector] of chainVectors.entries()) {
      const [nextChainKey, messageKey] = await kdfChain(b64uToBytes(vector.chainKey));
      expect(toHex(messageKey), `messageKey langkah ${index}`).toBe(toHex(b64uToBytes(vector.messageKey)));
      expect(toHex(nextChainKey), `chainKey langkah ${index}`).toBe(toHex(b64uToBytes(vector.newChainKey)));
    }
  });

  it('rantai benar-benar berlanjut (langkah ke-2 memakai keluaran langkah ke-1)', async () => {
    const [first, second] = chainVectors;
    const [nextChainKey] = await kdfChain(b64uToBytes(first!.chainKey));
    expect(toHex(nextChainKey)).toBe(first!.newChainKey === second!.chainKey ? toHex(b64uToBytes(second!.chainKey)) : toHex(nextChainKey));
    expect(second!.chainKey).toBe(first!.newChainKey);
  });
});
