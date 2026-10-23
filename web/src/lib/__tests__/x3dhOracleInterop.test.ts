// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// [docs/30 WS-G(6)] INTEROP dua arah: NYX → oracle.
//
// `x3dhOracleVectors.test.ts` membuktikan arah oracle → NYX (vektor tetap).
// Berkas ini menutup arah sebaliknya, yang tidak bisa diuji dengan vektor statis
// karena NYX membangkitkan kunci efemeral & nonce secara acak:
//
//   1. NYX (`x3dh_initiator`) meng-encaps ke kunci publik Bob → oracle menghitung
//      ulang sessionKey sisi penerima dari blob NYX dan mencocokkannya.
//   2. NYX (`dr_init_alice` + `dr_ratchet_encrypt`) membuat ciphertext AEAD →
//      oracle menurunkan RK/CKs dari ct KEM NYX, menurunkan message key, MEMBUKA
//      ciphertext NYX, lalu mengembalikan ciphertext buatan oracle dengan kunci
//      yang sama → NYX membukanya. Dua implementasi berbeda harus saling paham.
//
// Test di-skip dengan pesan jelas bila toolchain Go tidak tersedia (CI utama
// aslinya menjalankannya di job `dr-oracle`).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import vectors from './fixtures/x3dhOracleVectors.json';
import { trimPaddedPlaintext } from '../drProtocol';
import { b64uToBytes, bytesToB64u, callWorker, toHex } from './helpers/workerHarness';

// Vitest dijalankan dari `web/` (lihat `pnpm --filter nyx-web test`), jadi oracle
// berada satu tingkat di atas. Bisa di-override lewat env untuk pemanggilan lain.
const ORACLE_DIR = process.env.NYX_DR_ORACLE_DIR ?? path.resolve(process.cwd(), '../tools/dr-oracle');

interface OracleReply {
  ok: boolean;
  sessionKey?: string;
  expected?: string;
  error?: string;
  ciphertextBack?: string;
  plaintext?: string;
}

// Deteksi toolchain di scope modul: `describe.skipIf` dievaluasi saat koleksi,
// jadi nilai yang diisi di `beforeAll` sudah terlambat (test akan selalu skip).
const goAvailable = ((): boolean => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    console.warn('[interop] toolchain Go tidak tersedia —', (error as Error).message);
    return false;
  }
})();

function runOracle(mode: '-recipient' | '-ratchet', request: unknown): OracleReply {
  const stdout = execFileSync('go', ['run', '.', mode], {
    cwd: ORACLE_DIR,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as OracleReply;
}

/** Sama seperti runOracle, tetapi mengembalikan balasan meski exit code != 0. */
function runOracleExpectingFailure(mode: '-recipient' | '-ratchet', request: unknown): OracleReply {
  try {
    return runOracle(mode, request);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    return JSON.parse(stdout) as OracleReply;
  }
}

const vector = (vectors.x3dh as unknown as Record<string, unknown>[])[1]!; // ber-OTPK: jalur terpanjang
const aliceSigningPublicKey = vector.aliceSigningPublicKey as string;
const aliceSigningPrivateKey = vector.aliceSigningPrivateKey as string;
const bob = vector.bob as Record<string, { publicKey: string; privateKey: string }>;
const bobSigningPublicKey = vector.bobSigningPublicKey as string;
const signedPreKeySignature = vector.signedPreKeySignature as string;
const pqSignedPreKeySignature = vector.pqSignedPreKeySignature as string;

const recipientFields = {
  identityKey: bob.identityKey!,
  signedPreKey: bob.signedPreKey!,
  pqIdentityKey: bob.pqIdentityKey!,
  pqSignedPreKey: bob.pqSignedPreKey!,
  otpkClassical: bob.otpkClassical!,
  otpkPq: bob.otpkPq!,
  // Perhatikan: JSON kunci OTPK ada DI DALAM objek `bob` (itu memang tempatnya
  // di vektor), bukan di root.
  myOneTimePreKeyJson: bob.myOneTimePreKeyJson as unknown as string,
};

/**
 * Plaintext dikirim sebagai byte, bukan string. Alasannya SPECIFIK LINGKUNGAN
 * TEST: di vitest+jsdom, `new TextEncoder().encode()` menghasilkan Uint8Array
 * dari realm yang berbeda dari realm libsodium, sehingga `sodium.memzero()`
 * (yang memeriksa `instanceof Uint8Array`) menolak membersihkannya dan worker
 * melempar sebelum hasil dikirim. Di browser/Worker realm-nya satu (jalur ini
 * juga dipakai E2E chat), jadi ini artefak harness — bukan perilaku produksi.
 */
const plaintextBytes = (text: string) => new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));

describe.skipIf(!goAvailable)('interop NYX → oracle (Go: circl + x/crypto)', () => {
  it('ratchet + AEAD dua arah: oracle membuka ciphertext NYX, NYX membuka ciphertext oracle', async () => {
    const sessionKey = b64uToBytes((vector.sessionKey as string));
    const plaintext = 'interop-nyx-frozen-ratchet-v1';
    const plaintextInput = plaintextBytes(plaintext);

    // 1. NYX: inisialisasi DR (Alice) dari rahasia X3DH.
    const initialState = await callWorker<Record<string, unknown>>('dr_init_alice', {
      sk: sessionKey,
      theirPqSignedPreKeyPublic: b64uToBytes(bob.pqSignedPreKey!.publicKey),
    });
    const ckSPreStepState = initialState.CKs as string;
    const savedCt = initialState.savedCt as string;

    // 2. NYX: enkripsi satu pesan (rantai + AEAD + traffic-cover padding).
    const encrypted = await callWorker<{
      state: Record<string, unknown>;
      header: { n: number };
      ciphertext: Uint8Array;
      mk: Uint8Array;
    }>('dr_ratchet_encrypt', { serializedState: initialState, plaintext: plaintextInput });

    // 3. Oracle: turunkan RK/CKs dari ct KEM NYX, turunkan mk, buka ciphertext.
    const reply = runOracle('-ratchet', {
      sk: bytesToB64u(sessionKey),
      bobPqSpkPrivateKey: bob.pqSignedPreKey!.privateKey,
      savedCt,
      ckS: ckSPreStepState,
      messageKey: bytesToB64u(encrypted.mk),
      ciphertext: bytesToB64u(encrypted.ciphertext),
      plaintext,
    });
    expect(reply.error ?? null).toBe(null);
    expect(reply.ok).toBe(true);
    expect(reply.plaintext).toBe(plaintext);
    expect(reply.ciphertextBack).toBeTruthy();

    // 4. NYX: buka ciphertext buatan oracle dengan mk yang sama.
    const back = b64uToBytes(reply.ciphertextBack as string);
    const openedByNyx = await callWorker<Uint8Array>('crypto_secretbox_xchacha20poly1305_open_easy', {
      ciphertext: back.slice(24),
      nonce: back.slice(0, 24),
      key: encrypted.mk,
    });
    expect(new TextDecoder().decode(trimPaddedPlaintext(openedByNyx))).toBe(plaintext);
  }, 60000);

  it('kontrol negatif: message key salah → oracle TIDAK bisa membuka ciphertext NYX', async () => {
    const sessionKey = b64uToBytes((vector.sessionKey as string));
    const initialState = await callWorker<Record<string, unknown>>('dr_init_alice', {
      sk: sessionKey,
      theirPqSignedPreKeyPublic: b64uToBytes(bob.pqSignedPreKey!.publicKey),
    });
    const encrypted = await callWorker<{ ciphertext: Uint8Array; mk: Uint8Array }>('dr_ratchet_encrypt', {
      serializedState: initialState,
      plaintext: plaintextBytes('kontrol-negatif'),
    });
    const wrongKey = new Uint8Array(encrypted.mk);
    wrongKey[31] = wrongKey[31]! ^ 0x01;

    const reply = runOracleExpectingFailure('-ratchet', {
      sk: bytesToB64u(sessionKey),
      bobPqSpkPrivateKey: bob.pqSignedPreKey!.privateKey,
      savedCt: initialState.savedCt as string,
      ckS: initialState.CKs as string,
      messageKey: bytesToB64u(wrongKey),
      ciphertext: bytesToB64u(encrypted.ciphertext),
      plaintext: 'kontrol-negatif',
    });
    expect(reply.ok).toBe(false);

    // Bukti bahwa nilai yang diuji benar-benar berbeda (bukan sekadar error lain).
    expect(toHex(wrongKey)).not.toBe(toHex(encrypted.mk));
  }, 60000);
});
