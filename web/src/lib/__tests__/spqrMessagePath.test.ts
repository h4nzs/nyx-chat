// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Bukti bahwa jalur pesan benar-benar memakai braid SPQR v2 —
 * satu-satunya bentuk wire ratchet.
 *
 * Bukti resminya adalah E2E `web/e2e/spqr.spec.ts` (server + 2 klien + amplop
 * nyata), tetapi E2E itu **tidak bisa dijalankan** tanpa Postgres/Redis. Test
 * ini menutup jarak itu dengan dua lapis yang bisa dijalankan di sini:
 *
 *   A. **Perilaku (modul nyata + WASM nyata + AEAD nyata)** — dua klien
 *      mengirim dan membaca pesan lewat braid sungguhan: header `{v:2,b:[…]}`
 *      tanpa `kemPk`/`n`/`pn`, ciphertext `nonce||AEAD` yang sama bentuknya
 *      dengan jalur lama, dan sesi tanpa akar braid **gagal terlihat** (tidak
 *      ada fallback v1).
 *   B. **Guard sumber** — jalur pesan (`utils/crypto.ts`, worker, proxy) memang
 *      memanggil modul itu: header v2 dibangun saat kirim, diparse saat terima,
 *      state braid disimpan/dimuat/diarsipkan, dan tidak ada sisa pemanggilan
 *      negosiasi/ackV/DR v1.
 *
 * Yang **tidak** dimodelkan di sini (dan karena itu tetap bergantung E2E):
 * padding 8 KB traffic-cover (milik worker), sidecar WebTransport, dan
 * Redis/Postgres. Jadi test ini **bukan** pengganti E2E.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sodium from 'libsodium-wrappers';

import { buildSpqrHeader, decodeSpqrFrames, parseSpqrHeader, type SpqrDrHeader } from '../spqrWire';
import { initSpqrSession, spqrRecvStep, spqrSendStep } from '../spqrSession';
import { instantiateSpqrRatchet, type SpqrRatchet } from '../spqrRatchet';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);
const AUTH_KEY = new Uint8Array(32).fill(0x5a);

function seededRandomBytes(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0 || 0x12345678;
  return (length: number) =>
    Uint8Array.from({ length }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state & 0xff;
    });
}

// ---------------------------------------------------------------------------
// Model klien jalur pesan (cermin `utils/crypto.ts`, hanya bagian wire)
// ---------------------------------------------------------------------------

interface WireMessage {
  header: SpqrDrHeader;
  /** nonce(24) || XChaCha20-Poly1305(plaintext). */
  ciphertext: Uint8Array;
  sealedPlaintext: string;
  mk: Uint8Array;
}

interface PathClient {
  name: string;
  ratchet: SpqrRatchet;
  /** State braid per arah (A2B untuk Alice, B2A untuk Bob); `null` = tanpa akar. */
  braidState: Uint8Array | null;
}

function makeClient(
  name: string,
  direction: 'A2B' | 'B2A',
  seed: number,
  options: { withBraidRoot?: boolean } = {}
): PathClient {
  const ratchet = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), {
    randomBytes: seededRandomBytes(seed),
  });
  return {
    name,
    ratchet,
    braidState: options.withBraidRoot === false
      ? null
      : initSpqrSession(ratchet, { authKey: AUTH_KEY, direction }),
  };
}

/** Sisi kirim: payload ter-seal → langkah braid → header wire + AEAD. */
async function sendMessage(client: PathClient, text: string): Promise<WireMessage> {
  const sealedPlaintext = JSON.stringify({ content: text });
  if (!client.braidState) throw new Error('SPQR: sesi ini tidak punya akar braid');

  const step = spqrSendStep(client.ratchet, client.braidState);
  client.braidState = step.state;
  const header = buildSpqrHeader({ frames: step.frames });
  const { ciphertext } = sealWith(step.key, sealedPlaintext);
  return { header, ciphertext, sealedPlaintext, mk: step.key };
}

/** Sisi terima: parse header v2 → langkah braid → buka AEAD. */
function receiveMessage(client: PathClient, message: WireMessage): string {
  const header = parseSpqrHeader(message.header);
  if (!header) throw new Error('test: header bukan v2');
  if (!client.braidState) throw new Error('test: klien tanpa akar braid');
  const step = spqrRecvStep(client.ratchet, {
    state: client.braidState,
    frames: decodeSpqrFrames(header),
  });
  client.braidState = step.state;
  if (!step.key) throw new Error('test: rangkaian frame tanpa message key');
  return openWith(step.key, message.ciphertext);
}

/**
 * UTF-8 → `Uint8Array` realm lingkungan test.
 *
 * Di jsdom, `TextEncoder` dan `sodium.from_string` menghasilkan Uint8Array dari
 * realm lain — libsodium (node realm) menolaknya dengan "unsupported input type
 * for message". `Uint8Array.from(...)` menyalinnya ke realm yang diterima, jadi
 * kripto yang diuji tetap kripto sungguhan, bukan mock.
 */
function utf8(text: string): Uint8Array {
  return Uint8Array.from(new TextEncoder().encode(text));
}

function sealWith(key: Uint8Array, plaintext: string): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = sodium.randombytes_buf(24);
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8(plaintext),
    null,
    null,
    nonce,
    key
  );
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return { ciphertext: combined, nonce };
}

function openWith(key: Uint8Array, ciphertext: Uint8Array): string {
  const nonce = ciphertext.slice(0, 24);
  const body = ciphertext.slice(24);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, key);
  if (!plain) throw new Error('test: AEAD gagal dibuka');
  return sodium.to_string(plain);
}

// [AUDIT PASS 5 — N5-03] Artefak WASM yang hilang tidak boleh membuat suite ini
// hijau tanpa berjalan: `describe.skip` tetap dipakai untuk sisa suite, tetapi
// ketiadaannya kini menjadi tes yang GAGAL (dulu seluruh tes dilewati diam-diam).
const withSkip = HAS_WASM ? describe : describe.skip;
if (!HAS_WASM) {
  describe('artefak spqr.wasm', () => {
    it('packages/spqr-wasm/dist/spqr.wasm wajib ada — suite kripto v2 tidak boleh di-skip diam-diam', () => {
      expect(HAS_WASM).toBe(true);
    });
  });
}

beforeAll(async () => {
  await sodium.ready;
});

// ---------------------------------------------------------------------------
// A. Perilaku: wire v2 → braid → AEAD, dua arah
// ---------------------------------------------------------------------------

withSkip('jalur pesan SPQR v2: wire + braid (modul & WASM nyata)', () => {
  it('dua arah memakai header v2 dan bisa saling membuka', async () => {
    const alice = makeClient('alice', 'A2B', 0xa11ce);
    const bob = makeClient('bob', 'B2A', 0xb0b);

    const a1 = await sendMessage(alice, 'halo');
    const header = parseSpqrHeader(a1.header);
    expect(header).not.toBeNull();
    expect(header!.v).toBe(2);
    expect(header!.b.length).toBeGreaterThan(0);
    // Header v2 = frame braid, TANPA material KEM/counter jalur lama.
    expect('kemPk' in a1.header).toBe(false);
    expect('n' in a1.header).toBe(false);
    expect('pn' in a1.header).toBe(false);

    const bobRead = receiveMessage(bob, a1);
    expect(JSON.parse(bobRead)).toMatchObject({ content: 'halo' });

    const b1 = await sendMessage(bob, 'balasan');
    expect(receiveMessage(alice, b1)).toBe(b1.sealedPlaintext);
    const a2 = await sendMessage(alice, 'ketiga');
    expect(JSON.parse(receiveMessage(bob, a2))).toMatchObject({ content: 'ketiga' });

    // Bentuk ciphertext sama seperti jalur lama: nonce 24 byte di depan, lalu AEAD.
    expect(a1.ciphertext.length).toBe(24 + utf8(a1.sealedPlaintext).length + 16);
  });

  it('sesi tanpa akar braid gagal terlihat, bukan fallback v1', async () => {
    const legacy = makeClient('legacy', 'A2B', 0xfeed, { withBraidRoot: false });
    expect(legacy.braidState).toBeNull();
    await expect(sendMessage(legacy, 'sesi lama')).rejects.toThrow(/akar braid/);
  });
});

// ---------------------------------------------------------------------------
// B. Guard sumber: jalur pesan benar-benar memanggil modul ini
// ---------------------------------------------------------------------------

describe('guard sumber jalur pesan (utils/crypto.ts + worker + proxy)', () => {
  const cryptoSource = readFileSync(resolve(process.cwd(), 'src/utils/crypto.ts'), 'utf8');
  const workerSource = readFileSync(resolve(process.cwd(), 'src/workers/crypto.worker.ts'), 'utf8');
  const proxySource = readFileSync(resolve(process.cwd(), 'src/lib/crypto-worker-proxy.ts'), 'utf8');

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it('modul wire/state benar-benar diimpor jalur pesan', () => {
    expect(cryptoSource).toContain("from '@lib/spqrWire'");
    expect(cryptoSource).toContain("from '@lib/spqrState'");
    expect(cryptoSource).toContain('encryptSpqrMessage({');
    expect(cryptoSource).toContain('decryptSpqrMessage({');
  });

  it('satu-satunya bentuk wire: header v2 dibangun saat kirim dan diparse saat terima', () => {
    expect(cryptoSource).toContain('const header = buildSpqrHeader({ frames: result.frames });');
    expect(cryptoSource).toContain('const frames = decodeSpqrFrames(input.header);');

    const parseIndex = cryptoSource.indexOf('const spqrHeader = parseSpqrHeader(payload.dr);');
    expect(parseIndex).toBeGreaterThan(-1);
    expect(cryptoSource).toContain("header: spqrHeader,\n          actualCipher,");
    // Jalur DR v1 tidak dibaca lagi: tidak ada op decrypt v1 di jalur pesan,
    // dan bentuk lama dilaporkan sebagai error yang terlihat.
    expect(cryptoSource).not.toContain('worker_dr_ratchet_decrypt({');
    expect(cryptoSource).not.toContain('worker_dr_ratchet_encrypt({');
    expect(cryptoSource).toContain("header ratchet bukan v2 (format lama)");
  });

  it('tidak ada sisa negosiasi versi / ackV / kill switch', () => {
    expect(cryptoSource).not.toContain('versionDeclaration');
    expect(cryptoSource).not.toContain('extractVersionDeclaration');
    expect(cryptoSource).not.toContain('resolveOutboundRatchetVersion');
    expect(cryptoSource).not.toContain('spqrSendingEnabled');
    expect(cryptoSource).not.toContain('SPQR_CAPABILITY_OVERRIDE');
    expect(cryptoSource).not.toContain('peerAckRatchetVersion');
    expect(cryptoSource).not.toContain('ratchetVersion');
  });

  it('state braid: lahir malas, disimpan/dimuat, diarsipkan saat sesi baru, di-flush', () => {
    expect(occurrences(cryptoSource, 'await saveSpqrState({')).toBeGreaterThanOrEqual(2); // kirim + terima
    expect(cryptoSource).toContain('(await loadSpqrState(input.conversationId))?.state');
    // [audit N5-01] Sesi baru mengarsipkan era braid (bukan menghapusnya) supaya
    // pesan v2 yang tertunda tetap bisa dibuka.
    expect(cryptoSource).toContain('await rotateSpqrStateForNewSession(conversationId);');
    expect(cryptoSource).toContain('void flushSpqrState().catch(() => {});');
    expect(cryptoSource).toContain("'spqr: sesi ini tidak punya akar braid'");
  });

  it('op worker + proxy ada, dan memakai padding/AEAD yang sama', () => {
    expect(workerSource).toContain("case 'spqr_ratchet_init':");
    expect(workerSource).toContain("case 'spqr_ratchet_encrypt':");
    expect(workerSource).toContain("case 'spqr_ratchet_decrypt':");
    expect(workerSource).toContain('spqrSendStep(ratchet, stateBytes)');
    expect(workerSource).toContain('spqrRecvStep(ratchet, { state: stateBytes, frames: frameBytes })');
    // Bentuk ciphertext = jalur lama (8 KB traffic cover + nonce + XChaCha20-Poly1305).
    expect(workerSource).toContain('padBuffer(plaintextBytes, PADDING_BLOCK_SIZE - FINAL_OVERHEAD)');
    expect(workerSource).toContain('unpadBuffer(decrypted, PADDING_BLOCK_SIZE - FINAL_OVERHEAD)');

    expect(proxySource).toContain('export function worker_spqr_ratchet_init(');
    expect(proxySource).toContain('export function worker_spqr_ratchet_encrypt(');
    expect(proxySource).toContain('export function worker_spqr_ratchet_decrypt(');
  });
});
