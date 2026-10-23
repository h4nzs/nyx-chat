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

interface X3dhV2Vector {
  name: string;
  note: string;
  aliceSigningV2PublicKey: string;
  bob: {
    identityKey: KeyPairJson;
    pqIdentityKey: KeyPairJson;
    pqSignedPreKey: KeyPairJson;
    otpkPq?: KeyPairJson;
  };
  initiatorCiphertexts: string;
  sessionKey: string;
}

const x3dhV2Vectors = vectors.x3dhV2 as unknown as X3dhV2Vector[];

async function recipientV2SessionKey(vector: X3dhV2Vector, overrides?: { blob?: Uint8Array; signingKeyV2?: Uint8Array }) {
  const payload: Record<string, unknown> = {
    myIdentityKey: b64uToBytes(vector.bob.identityKey.publicKey),
    myPqIdentityKey: {
      publicKey: b64uToBytes(vector.bob.pqIdentityKey.publicKey),
      privateKey: b64uToBytes(vector.bob.pqIdentityKey.privateKey),
    },
    myPqSignedPreKey: {
      publicKey: b64uToBytes(vector.bob.pqSignedPreKey.publicKey),
      privateKey: b64uToBytes(vector.bob.pqSignedPreKey.privateKey),
    },
    theirSigningKeyV2: overrides?.signingKeyV2 ?? b64uToBytes(vector.aliceSigningV2PublicKey),
    initiatorCiphertexts: overrides?.blob ?? b64uToBytes(vector.initiatorCiphertexts),
  };
  if (vector.bob.otpkPq) {
    payload.myPqOneTimePreKey = b64uToBytes(vector.bob.otpkPq.privateKey);
  }
  return callWorker<Uint8Array>('x3dh_v2_recipient', payload);
}

describe('oracle lintas-implementasi — X3DH v2 (X-Wing murni + ML-DSA-65)', () => {
  it('vektor memuat dua kasus (dengan & tanpa One-Time Pre-Key)', () => {
    expect(x3dhV2Vectors.map((v) => v.name)).toEqual(['x3dh-v2-plain', 'x3dh-v2-with-otpk']);
  });

  for (const vector of x3dhV2Vectors) {
    it(`${vector.name}: sessionKey + tanda tangan oracle diterima NYX`, async () => {
      const nyx = await recipientV2SessionKey(vector);
      expect(nyx.length).toBe(32);
      expect(toHex(nyx)).toBe(toHex(b64uToBytes(vector.sessionKey)));
    });
  }

  it('kontrol negatif: kunci verifikasi ML-DSA lain → tanda tangan ditolak', async () => {
    const [plain, withOtpk] = [x3dhV2Vectors[0]!, x3dhV2Vectors[1]!];
    await expect(
      recipientV2SessionKey(plain, { signingKeyV2: b64uToBytes(withOtpk.aliceSigningV2PublicKey) })
    ).rejects.toThrow(/tanda tangan inisiator/i);
  });

  it('kontrol negatif: ciphertext diubah → tanda tangan transkrip ditolak', async () => {
    const vector = x3dhV2Vectors[0]!;
    const blob = b64uToBytes(vector.initiatorCiphertexts);
    // Header v2 = 4 byte; byte pertama ctId berada tepat setelah header.
    blob[4] = blob[4]! ^ 0x01;
    await expect(recipientV2SessionKey(vector, { blob })).rejects.toThrow(/tanda tangan inisiator/i);
  });

  it('blob ber-OTPK tanpa kunci OTPK lokal → GAGAL keras', async () => {
    const vector = x3dhV2Vectors[1]!;
    const { otpkPq: _otpkPq, ...bobWithoutOtpk } = vector.bob;
    await expect(recipientV2SessionKey({ ...vector, bob: bobWithoutOtpk })).rejects.toThrow(/OTPK/i);
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
