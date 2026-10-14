// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D] Modul WASM `spqr` — diuji dengan **modul hasil build yang
 * sesungguhnya** (`packages/spqr-wasm/dist/spqr.wasm`), bukan stub.
 *
 * Properti yang dikunci:
 *   1. Modul punya **nol import** (tanpa wasm-bindgen/glue JS) dan mengekspor ABI
 *      yang diharapkan — kalau suatu saat ada import muncul, test gagal.
 *   2. Negosiasi versi: state awal = `NEGOTIATING`, selesai setelah pertukaran.
 *   3. **Kesepakatan message key**: key yang dihasilkan `send` sama dengan yang
 *      diperoleh `recv` di sisi lawan (inti ratchet).
 *   4. **Entropi datang dari host**: dengan sumber entropi tetap, dua instans
 *      menghasilkan pesan identik (modul tidak punya randomness internal).
 *   5. Entropi kurang → `SpqrError(4)`, bukan trap.
 *   6. Input acak (fuzz) tidak merusak instance: setelah puluhan input sampah,
 *      satu pertukaran valid tetap berhasil.
 *   7. **Kehilangan pesan 1..N−1 → pesan berikutnya tetap sepakat** (braid +
 *      erasure coding menyembuhkan), dan **pengiriman keluar urutan** tetap
 *      menghasilkan key yang sama untuk tiap pesan (skipped key).
 *
 * Catatan cakupan: lapisan chunk/erasure ada di `v1::chunked` yang bersifat
 * `pub(crate)` di crate ter-pin, jadi properti kehilangan **hanya** bisa diuji
 * dari ABI publik (`send`/`recv`) — yaitu "pesan hilang, pesan sesudahnya masih
 * bisa dibuka". Inilah bentuk yang diuji di sini (bukan drop per chunk).
 *
 * Bila `dist/spqr.wasm` belum dibangun, seluruh suite di-skip (bukan gagal):
 * `cd packages/spqr-wasm && SPQR_CRATE_PATH=… ./build.sh`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SPQR_ERR_ARGS,
  SPQR_ERR_CRATE,
  SPQR_ERR_ENTROPY,
  SpqrError,
  instantiateSpqrRatchet,
  type SpqrRatchet,
} from '../spqrRatchet';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);

const AUTH_KEY = new Uint8Array(32).fill(0x7c);

/**
 * Sumber entropi deterministik (xorshift32) — hasil test tidak bergantung waktu,
 * dan tiap skenario memakai seed berbeda supaya tidak "kebetulan" lulus.
 */
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

let wasmBytes: Uint8Array<ArrayBuffer>;
let ratchet: SpqrRatchet;

beforeAll(() => {
  wasmBytes = HAS_WASM ? new Uint8Array(readFileSync(WASM_PATH)) : new Uint8Array();
  if (HAS_WASM) ratchet = instantiateSpqrRatchet(wasmBytes);
});

const withSkip = HAS_WASM ? describe : describe.skip;

withSkip('spqr wasm: modul & ABI', () => {
  it('modul tanpa import dan mengekspor seluruh ABI', () => {
    const module = new WebAssembly.Module(wasmBytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);

    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    for (const expected of [
      'memory',
      'spqr_in_ptr',
      'spqr_out_ptr',
      'spqr_out_len',
      'spqr_seed_entropy',
      'spqr_empty_state',
      'spqr_current_version',
      'spqr_initial_state',
      'spqr_send',
      'spqr_recv',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('state kosong & state awal berbeda', () => {
    const empty = ratchet.emptyState();
    const initial = ratchet.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    expect(empty.length).toBeGreaterThanOrEqual(0);
    expect(initial.length).toBeGreaterThan(empty.length);
  });

  it('negosiasi versi selesai setelah pertukaran pertama', () => {
    const sender = instantiateSpqrRatchet(wasmBytes);
    const receiver = instantiateSpqrRatchet(wasmBytes);

    let senderState = sender.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    let receiverState = receiver.initialState({ authKey: AUTH_KEY, direction: 'B2A' });

    expect(sender.currentVersion(senderState)).toBe('NEGOTIATING');
    expect(receiver.currentVersion(receiverState)).toBe('NEGOTIATING');

    const sent = sender.send(senderState);
    senderState = sent.state;
    const received = receiver.recv(receiverState, sent.msg);
    receiverState = received.state;

    expect(receiver.currentVersion(receiverState)).toBe('V1');
  });
});

withSkip('spqr wasm: ratchet', () => {
  it('send/recv: kesepakatan message key dan state yang maju', () => {
    const alice = instantiateSpqrRatchet(wasmBytes);
    const bob = instantiateSpqrRatchet(wasmBytes);

    let aliceState = alice.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    let bobState = bob.initialState({ authKey: AUTH_KEY, direction: 'B2A' });

    const aliceInit = aliceState;
    const first = alice.send(aliceState);
    aliceState = first.state;
    expect(first.msg.length).toBeGreaterThan(0);
    expect(first.state).not.toEqual(aliceInit);

    const firstRecv = bob.recv(bobState, first.msg);
    bobState = firstRecv.state;
    expect(first.key).not.toBeNull();
    expect(firstRecv.key).toEqual(first.key);

    // Arah sebaliknya: Bob mengirim, Alice menerima.
    const second = bob.send(bobState);
    bobState = second.state;
    const secondRecv = alice.recv(aliceState, second.msg);
    aliceState = secondRecv.state;
    expect(second.key).not.toBeNull();
    expect(secondRecv.key).toEqual(second.key);

    // Pesan berbeda → key berbeda (chain berjalan).
    const third = alice.send(aliceState);
    expect(third.key).not.toEqual(first.key);
  });

  it('entropi dari host: sumber tetap → pesan deterministik', () => {
    const fixed = new Uint8Array(128).fill(0x5a);
    const a = instantiateSpqrRatchet(wasmBytes, { randomBytes: () => fixed });
    const b = instantiateSpqrRatchet(wasmBytes, { randomBytes: () => fixed });

    const stateA = a.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    const stateB = b.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    expect(stateA).toEqual(stateB);

    const sendA = a.send(stateA);
    const sendB = b.send(stateB);
    expect(sendA.msg).toEqual(sendB.msg);
    expect(sendA.state).toEqual(sendB.state);
  });

  it('entropi kurang → SpqrError(4), bukan trap', () => {
    const stingy = instantiateSpqrRatchet(wasmBytes, {
      entropyBytes: 64,
      randomBytes: () => new Uint8Array(8),
    });
    const state = stingy.initialState({ authKey: AUTH_KEY, direction: 'A2B' });

    expect(() => stingy.send(state)).toThrow(SpqrError);
    try {
      stingy.send(state);
      throw new Error('seharusnya melempar');
    } catch (error) {
      expect((error as SpqrError).code).toBe(SPQR_ERR_ENTROPY);
    }
  });

  it('kehilangan 1..N−1 pesan: pesan berikutnya tetap sepakat & ratchet menyembuhkan', () => {
    const N = 8;

    for (let drop = 1; drop < N; drop++) {
      const alice = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0x51ed0000 + drop) });
      const bob = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0x9b0b0000 + drop) });

      let aliceState = alice.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
      let bobState = bob.initialState({ authKey: AUTH_KEY, direction: 'B2A' });

      const first = alice.send(aliceState);
      aliceState = first.state;
      bobState = bob.recv(bobState, first.msg).state;

      // `drop` pesan hilang di jaringan: state Alice tetap maju, Bob tidak pernah
      // melihatnya. Pesan ke-(drop+1) HARUS masih bisa dibuka Bob.
      for (let i = 0; i < drop; i++) aliceState = alice.send(aliceState).state;
      const survivor = alice.send(aliceState);
      aliceState = survivor.state;
      const survivorRecv = bob.recv(bobState, survivor.msg);
      bobState = survivorRecv.state;

      expect(survivor.key).not.toBeNull();
      expect(survivorRecv.key).toEqual(survivor.key);

      // Penyembuhan: arah balik tetap sinkron setelah kehilangan itu.
      const reply = bob.send(bobState);
      bobState = reply.state;
      const replyRecv = alice.recv(aliceState, reply.msg);
      aliceState = replyRecv.state;
      expect(reply.key).not.toBeNull();
      expect(replyRecv.key).toEqual(reply.key);
    }
  });

  it('pengiriman keluar urutan: key tiap pesan tetap sama (skipped key)', () => {
    const alice = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0x00c0ffee) });
    const bob = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0xfeedface) });

    let aliceState = alice.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    let bobState = bob.initialState({ authKey: AUTH_KEY, direction: 'B2A' });

    const first = alice.send(aliceState);
    aliceState = first.state;
    bobState = bob.recv(bobState, first.msg).state;

    const sent: Array<{ msg: Uint8Array; key: Uint8Array | null }> = [];
    for (let i = 0; i < 5; i++) {
      const step = alice.send(aliceState);
      aliceState = step.state;
      sent.push({ msg: step.msg, key: step.key });
    }

    // Bob menerima urutan 4, 0, 2, 1, 3 — key setiap pesan tetap harus cocok.
    for (const index of [4, 0, 2, 1, 3]) {
      const message = sent[index]!;
      const received = bob.recv(bobState, message.msg);
      bobState = received.state;
      expect(message.key).not.toBeNull();
      expect(received.key).toEqual(message.key);
    }
  });

  it('kehilangan dua arah bergantian: state tetap sinkron', () => {
    const alice = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0x1a2b3c4d) });
    const bob = instantiateSpqrRatchet(wasmBytes, { randomBytes: seededRandomBytes(0x4d3c2b1a) });

    let aliceState = alice.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    let bobState = bob.initialState({ authKey: AUTH_KEY, direction: 'B2A' });

    const first = alice.send(aliceState);
    aliceState = first.state;
    bobState = bob.recv(bobState, first.msg).state;

    // Alice mengirim 3 (hanya ke-3 sampai), lalu Bob membalas 2 (hanya ke-2 sampai).
    for (let i = 0; i < 2; i++) aliceState = alice.send(aliceState).state;
    const aMsg = alice.send(aliceState);
    aliceState = aMsg.state;
    const aRecv = bob.recv(bobState, aMsg.msg);
    bobState = aRecv.state;
    expect(aRecv.key).toEqual(aMsg.key);

    bobState = bob.send(bobState).state;
    const bMsg = bob.send(bobState);
    bobState = bMsg.state;
    const bRecv = alice.recv(aliceState, bMsg.msg);
    aliceState = bRecv.state;
    expect(bRecv.key).toEqual(bMsg.key);

    // Setelah kehilangan bergantian, pertukaran normal kembali sepakat.
    const normal = alice.send(aliceState);
    aliceState = normal.state;
    const normalRecv = bob.recv(bobState, normal.msg);
    bobState = normalRecv.state;
    expect(normalRecv.key).toEqual(normal.key);
  });

  it('input acak tidak merusak instance (fuzz + instance tetap bisa dipakai)', () => {
    const victim = instantiateSpqrRatchet(wasmBytes);
    let failures = 0;

    // PRNG deterministik: hasil test tidak bergantung pada waktu.
    let seed = 0x12345678;
    const nextByte = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    };
    const randomBytesOf = (length: number) => Uint8Array.from({ length }, nextByte);

    for (let i = 0; i < 64; i++) {
      const size = 1 + nextByte();
      const junk = randomBytesOf(size);
      try {
        const result = victim.recv(junk, junk);
        expect(result.state.length).toBeGreaterThanOrEqual(0);
      } catch (error) {
        const spqrError = error as SpqrError;
        expect(spqrError).toBeInstanceOf(SpqrError);
        expect([SPQR_ERR_CRATE, SPQR_ERR_ARGS]).toContain(spqrError.code);
        failures++;
      }

      try {
        victim.currentVersion(junk);
      } catch (error) {
        expect((error as SpqrError).code).toBe(SPQR_ERR_CRATE);
      }
    }

    expect(failures).toBeGreaterThan(0);

    // Instance masih sehat: satu pertukaran penuh sesudahnya tetap berhasil.
    const peer = instantiateSpqrRatchet(wasmBytes);
    const state = victim.initialState({ authKey: AUTH_KEY, direction: 'A2B' });
    const peerState = peer.initialState({ authKey: AUTH_KEY, direction: 'B2A' });
    const sent = victim.send(state);
    const received = peer.recv(peerState, sent.msg);
    expect(received.key).toEqual(sent.key);
  });
});
