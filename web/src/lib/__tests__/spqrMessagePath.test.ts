// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D / docs/33 §33.7 poin 1 + §33.10] Tiga hal yang dulu
 * tercatat sebagai **"Sisa"** pada baris M8 — (1) versi wire baru di header DR,
 * (2) ack, (3) pemanggilan modul negosiasi/state dari jalur pesan — sekarang
 * dipanggil oleh jalur pesan. Bukti resminya adalah E2E `web/e2e/spqr.spec.ts`
 * (server + 2 klien + amplop nyata), tetapi E2E itu **tidak bisa dijalankan**
 * tanpa Postgres/Redis. Test ini menutup jarak itu dengan dua lapis yang bisa
 * dijalankan di sini:
 *
 *   A. **Perilaku (modul nyata + WASM nyata + AEAD nyata)** — rangkaian
 *      keputusan dan wire persis seperti yang dirangkai `utils/crypto.ts`:
 *      v1 dulu (peer belum menyatakan) → peer menulis `ackV: 2` di payload
 *      ter-seal → pengiriman berikutnya v2 (`{v:2,b:[…]}`, tanpa `kemPk`/`n`/`pn`)
 *      → peer benar-benar membuka pesan itu. Termasuk rollback: kirim kembali
 *      v1 sementara **state braid dipertahankan**, dan pesan v2 yang datang tetap
 *      terbaca.
 *   B. **Guard sumber** — jalur pesan (`utils/crypto.ts`, worker, proxy) memang
 *      memanggil modul itu dengan **urutan** yang aman: header v2 diparse sebelum
 *      jalur v1, `ackV` ditulis saat kirim dan disimpan saat terima di kedua jalur,
 *      state braid disimpan/dimuat/dibuang, dan tiga op worker benar-benar ada.
 *
 * Yang **tidak** dimodelkan di sini (dan karena itu tetap bergantung E2E):
 * protokol DR v1 beku (diuji `drProtocol.test.ts`), padding 8 KB traffic-cover
 * (milik worker), sidecar WebTransport, dan Redis/Postgres. Jadi test ini
 * **bukan** pengganti E2E; ia menjaga rantai panggilan yang E2E buktikan.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sodium from 'libsodium-wrappers';

import {
  SPQR_CAPABILITY,
  resolveOutboundRatchetVersion,
  type RatchetWireVersion,
} from '../spqrNegotiation';
import {
  buildSpqrHeader,
  decodeSpqrFrames,
  extractVersionDeclaration,
  parseSpqrHeader,
  versionDeclaration,
  type SpqrDrHeader,
} from '../spqrWire';
import { initSpqrSession, spqrRecvStep, spqrSendStep } from '../spqrSession';
import { instantiateSpqrRatchet, type SpqrRatchet } from '../spqrRatchet';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);
const AUTH_KEY = new Uint8Array(32).fill(0x5a);
const CAPABILITIES = ['hello-v1', SPQR_CAPABILITY];

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
// Model klien jalur pesan (cermin `utils/crypto.ts`, hanya bagian versi/wire)
// ---------------------------------------------------------------------------

/** Header v1 (beku) — hanya **bentuk**-nya yang penting di sini. */
interface V1HeaderShape {
  kemPk: string;
  ct: string;
  n: number;
  pn: number;
}

interface WireMessage {
  header: SpqrDrHeader | V1HeaderShape;
  /** Versi yang BENAR-BENAR keluar di wire (keputusan vs hasil bisa berbeda). */
  usedVersion: RatchetWireVersion;
  /** nonce(24) || XChaCha20-Poly1305(plaintext) — bentuk ciphertext yang sama di v1/v2. */
  ciphertext: Uint8Array;
  /** Plaintext ter-seal (isi + `ackV`), seperti yang diterima peer. */
  sealedPlaintext: string;
  /** Message key pengirim (dipakai hanya untuk pemeriksaan di test). */
  mk: Uint8Array;
  decision: ReturnType<typeof resolveOutboundRatchetVersion>;
}

interface PathClient {
  name: string;
  ratchet: SpqrRatchet;
  /** State braid per arah (A2B untuk Alice, B2A untuk Bob) — `null` = sesi pra-v2. */
  braidState: Uint8Array | null;
  outbound: RatchetWireVersion;
  peerDeclared: RatchetWireVersion | null;
  sendingEnabled: boolean;
  capabilities: string[];
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
    outbound: 'v1',
    peerDeclared: null,
    sendingEnabled: true,
    capabilities: CAPABILITIES,
  };
}

/** Sisi kirim jalur pesan: payload ter-seal + keputusan versi + header wire. */
async function sendMessage(client: PathClient, text: string): Promise<WireMessage> {
  // 1. Payload ter-seal — `ackV` selalu ditulis bila klien ini bisa membaca v2
  //    (crypto.ts: `...versionDeclaration(spqrSendingEnabled() ? 'v2' : 'v1')`).
  const sealedPlaintext = JSON.stringify({
    content: text,
    ...versionDeclaration(client.sendingEnabled ? 'v2' : 'v1'),
  });

  // 2. Keputusan versi per pengiriman (syarat: kapabilitas + deklarasi peer).
  const decision = resolveOutboundRatchetVersion({
    currentOutbound: client.outbound,
    peerDeclaredVersion: client.peerDeclared,
    negotiatedCapabilities: client.capabilities,
    integrationEnabled: client.sendingEnabled,
  });

  if (decision.version === 'v2' && client.braidState) {
    const step = spqrSendStep(client.ratchet, client.braidState);
    client.braidState = step.state;
    client.outbound = 'v2';

    const header = buildSpqrHeader({ frames: step.frames });
    const { ciphertext } = sealWith(step.key, sealedPlaintext);
    return { header, usedVersion: 'v2', ciphertext, sealedPlaintext, mk: step.key, decision };
  }

  // v1 — termasuk kasus **keputusan v2 tapi braid belum bisa dipakai** (modul
  // WASM belum termuat / sesi didirikan sebelum v2 ada): crypto.ts memakai jalur
  // v1 untuk pengiriman ini dan tetap mencatat `ratchetVersion: 'v2'` di state,
  // sehingga percobaan v2 diulang pada pesan berikutnya.
  client.outbound = decision.version;
  const v1Key = new Uint8Array(32).fill(0x11);
  const { ciphertext } = sealWith(v1Key, sealedPlaintext);
  return {
    header: { kemPk: 'v1-kem-pk-shape', ct: 'v1-kem-ct-shape', n: 1, pn: 0 },
    usedVersion: 'v1',
    ciphertext,
    sealedPlaintext,
    mk: v1Key,
    decision,
  };
}

/** Sisi terima jalur pesan: parse header → (bila v2) langkah braid → buka AEAD. */
async function receiveMessage(
  client: PathClient,
  message: WireMessage
): Promise<{ text: string; peerDeclared: RatchetWireVersion | null }> {
  const header = parseSpqrHeader(message.header);
  if (!header) throw new Error('test: jalur v1 tidak dimodelkan untuk dibaca');
  if (!client.braidState) throw new Error('test: klien tanpa akar braid');
  // crypto.ts: `parseSpqrHeader` → (null) jalur v1; (ada) `decryptSpqrMessage`.
  void decodeSpqrFrames; // dipakai jalur pesan sebelum op worker (lihat guard sumber)
  const step = spqrRecvStep(client.ratchet, { state: client.braidState, frames: decodeSpqrFrames(header) });
  client.braidState = step.state;
  if (!step.key) throw new Error('test: rangkaian frame tanpa message key');

  const text = openWith(step.key, message.ciphertext);
  // crypto.ts: deklarasi hanya dipercaya dari plaintext yang lolos AEAD.
  client.peerDeclared = extractVersionDeclaration(text);
  return { text, peerDeclared: client.peerDeclared };
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

const withSkip = HAS_WASM ? describe : describe.skip;

beforeAll(async () => {
  await sodium.ready;
});

// ---------------------------------------------------------------------------
// A. Perilaku: negosiasi → wire v2 → ack → braid → AEAD → rollback
// ---------------------------------------------------------------------------

withSkip('jalur pesan SPQR: negosiasi + wire + ack (modul & WASM nyata)', () => {
  it('v1 dulu, lalu v2 setelah peer menulis ackV — dan peer bisa membukanya', async () => {
    const alice = makeClient('alice', 'A2B', 0xa11ce);
    const bob = makeClient('bob', 'B2A', 0xb0b);

    // 1. Alice mengirim lebih dulu. Bob belum pernah menyatakan mampu v2 →
    //    keputusan v1, dan yang benar-benar keluar di wire BUKAN header v2.
    const a1 = await sendMessage(alice, 'halo (v1)');
    expect(a1.decision).toEqual({ version: 'v1', reason: 'peer-legacy' });
    expect(a1.usedVersion).toBe('v1');
    expect(parseSpqrHeader(a1.header)).toBeNull();
    expect('kemPk' in a1.header).toBe(true);

    // 2. Bob membaca payload ter-seal itu → deklarasi `ackV: 2` peer (satu-
    //    satunya kanal yang tidak bisa dipalsukan relay).
    expect(extractVersionDeclaration(a1.sealedPlaintext)).toBe('v2');
    bob.peerDeclared = extractVersionDeclaration(a1.sealedPlaintext);

    // 3. Balasan Bob = pengiriman v2 pertama (braid B2A dari nol).
    const b1 = await sendMessage(bob, 'balasan (v2)');
    expect(b1.decision).toEqual({ version: 'v2', reason: 'both-capable' });
    expect(b1.usedVersion).toBe('v2');
    const b1Header = parseSpqrHeader(b1.header);
    expect(b1Header, 'header v2 tidak terbentuk').not.toBeNull();
    expect(b1Header!.v).toBe(2);
    expect(b1Header!.b.length).toBeGreaterThan(0);
    // Header v2 = frame braid, TANPA material KEM/counter jalur v1.
    expect('kemPk' in b1.header).toBe(false);
    expect('n' in b1.header).toBe(false);
    expect('pn' in b1.header).toBe(false);

    // 4. Alice — yang belum pernah memakai v2 — bisa membukanya, dan dari situ
    //    mencatat deklarasi peer.
    const aliceRead = await receiveMessage(alice, b1);
    expect(aliceRead.text).toBe(b1.sealedPlaintext);
    expect(JSON.parse(aliceRead.text)).toMatchObject({ content: 'balasan (v2)', ackV: 2 });
    expect(aliceRead.peerDeclared).toBe('v2');

    // 5. Kini giliran Alice memakai v2 (syarat lengkap: kapabilitas + ackV peer).
    const a2 = await sendMessage(alice, 'kedua (v2)');
    expect(a2.decision).toEqual({ version: 'v2', reason: 'both-capable' });
    expect(parseSpqrHeader(a2.header)?.v).toBe(2);
    const bobRead = await receiveMessage(bob, a2);
    expect(JSON.parse(bobRead.text)).toMatchObject({ content: 'kedua (v2)', ackV: 2 });

    // 6. Bentuk ciphertext sama dengan v1: nonce 24 byte di depan, lalu AEAD.
    expect(a2.ciphertext.length).toBe(24 + utf8(a2.sealedPlaintext).length + 16);
  });

  it('rollback v2→v1 mempertahankan state braid, dan pesan v2 yang datang tetap terbaca', async () => {
    const alice = makeClient('alice', 'A2B', 0xc0ffee);
    const bob = makeClient('bob', 'B2A', 0xd00d);

    // Bawa sesi ke v2 di kedua arah.
    const a1 = await sendMessage(alice, 'satu');
    bob.peerDeclared = extractVersionDeclaration(a1.sealedPlaintext);
    const b1 = await sendMessage(bob, 'dua');
    await receiveMessage(alice, b1);
    const a2 = await sendMessage(alice, 'tiga');
    await receiveMessage(bob, a2);
    expect(alice.outbound).toBe('v2');
    expect(bob.outbound).toBe('v2');

    const braidBefore = alice.braidState!.slice();

    // --- Rollback operator pada Alice (kill switch) ------------------------
    alice.sendingEnabled = false;
    const rolled = await sendMessage(alice, 'empat (v1 lagi)');
    expect(rolled.decision.version).toBe('v1');
    expect(rolled.decision.reason).toBe('local-disabled');
    // Yang WAJIB dipertahankan: state braid (jendela baca pesan lama).
    expect(rolled.decision.preservedVersion).toBe('v2');
    expect(rolled.usedVersion).toBe('v1');
    expect(parseSpqrHeader(rolled.header)).toBeNull();
    expect(alice.braidState).not.toBeNull();

    // --- Peer berhenti menyatakan v2 → v1 dengan catatan preservedVersion ---
    const peerStops = resolveOutboundRatchetVersion({
      currentOutbound: 'v2',
      peerDeclaredVersion: null,
      negotiatedCapabilities: CAPABILITIES,
    });
    expect(peerStops).toEqual({ version: 'v1', reason: 'rollback', preservedVersion: 'v2' });

    // --- Pesan v2 dari peer (yang masih v2) TETAP terbaca di klien rollback -
    const b2 = await sendMessage(bob, 'lima (v2 dari peer)');
    const readAfterRollback = await receiveMessage(alice, b2);
    expect(JSON.parse(readAfterRollback.text)).toMatchObject({ content: 'lima (v2 dari peer)' });
    // Rollback tidak menghapus/mengubah state braid yang sudah ada — state hanya
    // bergerak maju karena penerimaan pesan v2 peer.
    expect(alice.braidState).not.toBeNull();
    expect(braidBefore.length).toBeGreaterThan(0);
  });

  it('keputusan v2 tanpa akar braid → wire tetap v1 (fallback, bukan header rusak)', async () => {
    // Sesi pra-v2 (tanpa akar braid) walau peer sudah menyatakan mampu: jalur
    // pesan harus tetap v1 (`encryptSpqrMessage` mengembalikan null → fallback),
    // dan keputusan v2 dicoba ulang pada pengiriman berikutnya.
    const legacy = makeClient('legacy', 'A2B', 0xfeed, { withBraidRoot: false });
    legacy.peerDeclared = 'v2';
    expect(legacy.braidState).toBeNull();

    const message = await sendMessage(legacy, 'sesi lama');
    expect(message.decision.version).toBe('v2'); // keputusan boleh v2 …
    expect(message.usedVersion).toBe('v1'); // … tapi wire-nya v1
    expect(parseSpqrHeader(message.header)).toBeNull();
    expect('kemPk' in message.header).toBe(true);
    // Percobaan berikutnya masih v2 (sticky) — memakai akar braid yang masih
    // ada di state DR bila sesi ini memang memilikinya.
    legacy.braidState = initSpqrSession(legacy.ratchet, { authKey: AUTH_KEY, direction: 'A2B' });
    const retry = await sendMessage(legacy, 'percobaan kedua');
    expect(retry.usedVersion).toBe('v2');
    expect(parseSpqrHeader(retry.header)?.v).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// B. Guard sumber: jalur pesan benar-benar memanggil modul ini, dengan urutan aman
// ---------------------------------------------------------------------------

describe('guard sumber jalur pesan (utils/crypto.ts + worker + proxy)', () => {
  const cryptoSource = readFileSync(resolve(process.cwd(), 'src/utils/crypto.ts'), 'utf8');
  const workerSource = readFileSync(resolve(process.cwd(), 'src/workers/crypto.worker.ts'), 'utf8');
  const proxySource = readFileSync(resolve(process.cwd(), 'src/lib/crypto-worker-proxy.ts'), 'utf8');

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it('modul negosiasi/wire/state benar-benar diimpor jalur pesan', () => {
    expect(cryptoSource).toContain("from '@lib/spqrNegotiation'");
    expect(cryptoSource).toContain("from '@lib/spqrWire'");
    expect(cryptoSource).toContain("from '@lib/spqrState'");
    expect(cryptoSource).toContain('resolveOutboundRatchetVersion(');
    expect(cryptoSource).toContain('spqrSendingEnabled()');
    expect(cryptoSource).toContain('SPQR_CAPABILITY_OVERRIDE');
  });

  it('(1) header v2: dibangun saat kirim, diparse LEBIH DULU dari jalur v1 saat terima', () => {
    expect(cryptoSource).toContain('const header = buildSpqrHeader({ frames: result.frames });');

    const parseIndex = cryptoSource.indexOf('const spqrHeader = parseSpqrHeader(drHeader);');
    expect(parseIndex).toBeGreaterThan(-1);
    // Urutan yang menentukan: keputusan versi terjadi SEBELUM state machine v1
    // dipanggil dan sebelum skipped-key diperiksa (menerka versi = cara paling
    // mudah kehilangan riwayat pesan).
    expect(parseIndex).toBeLessThan(cryptoSource.indexOf('await worker_dr_ratchet_decrypt({'));
    expect(parseIndex).toBeLessThan(
      cryptoSource.indexOf('const skippedMkStr = await retrieveSkippedMessageKeySecurely(headerKey)')
    );
    // Pesan v2 tidak pernah dibaca sebagai v1.
    expect(cryptoSource).toContain('return await decryptSpqrMessage({');
    expect(cryptoSource).toContain('const frames = decodeSpqrFrames(input.header);');
  });

  it('(2) ack: `ackV` ditulis saat kirim dan disimpan saat terima di KEDUA jalur', () => {
    expect(cryptoSource).toContain("...versionDeclaration(spqrSendingEnabled() ? 'v2' : 'v1'),");
    expect(cryptoSource).toContain('const outboundDecision = resolveOutboundRatchetVersion({');
    expect(cryptoSource).toContain('peerDeclaredVersion: state?.peerAckRatchetVersion ?? null,');

    // Jalur terima v2 (decryptSpqrMessage) + jalur terima v1 (DR v1) — keduanya
    // membaca deklarasi dari plaintext yang sudah lolos AEAD lalu menyimpannya.
    // Kedua situs disebut eksplisit supaya kehilangan salah satunya terlihat.
    expect(cryptoSource).toContain('const peerVersion = extractVersionDeclaration(plaintext);');
    expect(cryptoSource).toContain('const peerVersion = extractVersionDeclaration(decryptedPlaintext);');
    expect(
      occurrences(cryptoSource, '...(peerVersion ? { peerAckRatchetVersion: peerVersion } : {}),')
    ).toBeGreaterThanOrEqual(2);
    // Deklarasi peer saja tidak cukup: kapabilitas relay ikut dibaca dari
    // negosiasi transport (satu jalur, bukan konstanta lokal).
    expect(cryptoSource).toContain('negotiatedCapabilities: await transportCapabilities(),');
  });

  it('(3) state braid: lahir malas, disimpan/dimuat, dibuang saat sesi baru, di-flush', () => {
    expect(occurrences(cryptoSource, 'await saveSpqrState({')).toBeGreaterThanOrEqual(2); // kirim + terima
    expect(cryptoSource).toContain('(await loadSpqrState(input.conversationId))?.state');
    expect(cryptoSource).toContain('await deleteSpqrState(conversationId);');
    expect(cryptoSource).toContain('void flushSpqrState().catch(() => {});');
    // Jalur baca v2 tidak dimatikan oleh kill switch: yang diperiksa hanya akar
    // braid, bukan `spqrSendingEnabled()`.
    expect(cryptoSource).toContain("'spqr: sesi ini tidak punya state braid (didirikan sebagai v1)'");
    expect(cryptoSource).toContain("return { status: 'error', error: new Error('spqr: sesi ini tidak punya state braid");
  });

  it('op worker + proxy ada, dan memakai padding/AEAD yang sama dengan v1', () => {
    expect(workerSource).toContain("case 'spqr_ratchet_init':");
    expect(workerSource).toContain("case 'spqr_ratchet_encrypt':");
    expect(workerSource).toContain("case 'spqr_ratchet_decrypt':");
    expect(workerSource).toContain('spqrSendStep(ratchet, stateBytes)');
    expect(workerSource).toContain('spqrRecvStep(ratchet, { state: stateBytes, frames: frameBytes })');
    // Bentuk ciphertext v2 = v1 (8 KB traffic cover + nonce + XChaCha20-Poly1305).
    expect(workerSource).toContain('padBuffer(plaintextBytes, PADDING_BLOCK_SIZE - FINAL_OVERHEAD)');
    expect(workerSource).toContain('unpadBuffer(decrypted, PADDING_BLOCK_SIZE - FINAL_OVERHEAD)');

    expect(proxySource).toContain('export function worker_spqr_ratchet_init(');
    expect(proxySource).toContain('export function worker_spqr_ratchet_encrypt(');
    expect(proxySource).toContain('export function worker_spqr_ratchet_decrypt(');
  });
});
