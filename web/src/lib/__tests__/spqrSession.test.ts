// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D poin 2 / docs/33 §33.7 poin 1] Orkestrasi langkah ratchet
 * v2 di atas modul WASM hasil build **sungguhan**.
 *
 * Yang dikunci:
 *   1. Kesepakatan message key lewat API langkah (`spqrSendStep`/`spqrRecvStep`)
 *      — bentuk yang benar-benar dipakai jalur pesan, bukan `send`/`recv` mentah.
 *   2. **Satu pesan pengguna = satu pesan wire** walau state machine crate
 *      melewati keadaan tanpa key: frame dikumpulkan, dan penerima mendapatkan
 *      key dari frame terakhir.
 *   3. **Fail-closed**: sisi yang belum menerima apa pun tidak pernah
 *      "menghasilkan" pesan tanpa key; ia melempar `SpqrSessionError` sehingga
 *      pemanggil jatuh ke jalur v1 (bukan mengirim pesan yang tak bisa dibuka).
 *   4. Pesan hilang/keluar urutan tetap membuka pesan berikutnya (braid).
 *   5. Entropi dari host: sumber tetap → frame & key identik, jadi modul tidak
 *      punya RNG sendiri (klaim yang sama dengan `spqrRatchet.test`).
 *
 * Bila `dist/spqr.wasm` belum dibangun, suite di-skip (bukan gagal).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SPQR_MAX_STEPS_PER_MESSAGE, SpqrSessionError, initSpqrSession, spqrRecvStep, spqrSendStep } from '../spqrSession';
import { instantiateSpqrRatchet, type SpqrRatchet, type SpqrVersionStatus } from '../spqrRatchet';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);
const AUTH_KEY = new Uint8Array(32).fill(0x33);

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

function freshPair(seed = 0x5eed): { alice: SpqrRatchet; bob: SpqrRatchet; a: Uint8Array; b: Uint8Array } {
  const alice = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), {
    randomBytes: seededRandomBytes(seed),
  });
  const bob = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), {
    randomBytes: seededRandomBytes(seed ^ 0xffff),
  });
  return {
    alice,
    bob,
    a: initSpqrSession(alice, { authKey: AUTH_KEY, direction: 'A2B' }),
    b: initSpqrSession(bob, { authKey: AUTH_KEY, direction: 'B2A' }),
  };
}

const withSkip = HAS_WASM ? describe : describe.skip;

withSkip('initSpqrSession', () => {
  it('state awal deterministik: akar sama + peran sama → state sama', () => {
    const first = freshPair(0xa11ce);
    const second = freshPair(0xa11ce);
    expect(first.a).toEqual(second.a);
    expect(first.b).toEqual(second.b);

    // Peran berbeda → arah braid berbeda (state tidak identik).
    expect(first.a).not.toEqual(first.b);
  });

  it('authKey kosong ditolak (tidak ada sesi tanpa akar)', () => {
    const { alice } = freshPair();
    expect(() => initSpqrSession(alice, { authKey: new Uint8Array(), direction: 'A2B' })).toThrow(
      SpqrSessionError
    );
  });
});

withSkip('spqrSendStep / spqrRecvStep', () => {
  it('satu pertukaran: key sepakat, frame non-kosong, state maju', () => {
    const { alice, bob, a, b } = freshPair();

    const sent = spqrSendStep(alice, a);
    expect(sent.key.length).toBeGreaterThan(0);
    expect(sent.frames.length).toBeGreaterThan(0);
    expect(sent.frames.every((frame) => frame.length > 0)).toBe(true);
    expect(sent.state).not.toEqual(a);

    const received = spqrRecvStep(bob, { state: b, frames: sent.frames });
    expect(received.key).toEqual(sent.key);
    expect(received.state).not.toEqual(b);

    // Arah balik.
    const reply = spqrSendStep(bob, received.state);
    const replyRecv = spqrRecvStep(alice, { state: sent.state, frames: reply.frames });
    expect(replyRecv.key).toEqual(reply.key);

    // Key berubah tiap pesan (chain berjalan).
    const next = spqrSendStep(alice, replyRecv.state);
    expect(next.key).not.toEqual(sent.key);
  });

  it('kedua peran bisa memulai sendiri (epoch-0 key dari akar braid)', () => {
    // Perilaku crate ter-pin: pesan pertama kedua arah langsung membawa key
    // (`A2B` 37 B, `B2A` 4 B frame) — jadi tidak ada "sisi yang menunggu" yang
    // membuat percakapan macet pada pertukaran pertama.
    const { alice, bob, a, b } = freshPair();
    const fromAlice = spqrSendStep(alice, a);
    const fromBob = spqrSendStep(bob, b);
    expect(fromAlice.key.length).toBeGreaterThan(0);
    expect(fromBob.key.length).toBeGreaterThan(0);
    expect(fromAlice.key).not.toEqual(fromBob.key);
    // Silang: masing-masing bisa membuka pesan pertama pihak lain.
    expect(spqrRecvStep(bob, { state: b, frames: fromAlice.frames }).key).toEqual(fromAlice.key);
    expect(spqrRecvStep(alice, { state: a, frames: fromBob.frames }).key).toEqual(fromBob.key);
  });

  it('urutan nyata jalur pesan: peer (B2A) yang mengirim v2 pertama', () => {
    // Skenario yang benar-benar terjadi saat upgrade: deklarasi `ackV` datang
    // di pesan v1, jadi bisa saja penerima (B2A) yang mengirim pesan v2
    // pertama — braid kedua sisi sama-sama masih di state awal.
    const { alice, bob, a, b } = freshPair(0x8f2a);

    const fromBob = spqrSendStep(bob, b);
    const aliceRecv = spqrRecvStep(alice, { state: a, frames: fromBob.frames });
    expect(aliceRecv.key).toEqual(fromBob.key);

    const fromAlice = spqrSendStep(alice, aliceRecv.state);
    const bobRecv = spqrRecvStep(bob, { state: fromBob.state, frames: fromAlice.frames });
    expect(bobRecv.key).toEqual(fromAlice.key);

    // Balasan berikutnya tetap sepakat (rantai tidak rusak oleh urutan itu).
    const again = spqrSendStep(bob, bobRecv.state);
    expect(spqrRecvStep(alice, { state: fromAlice.state, frames: again.frames }).key).toEqual(again.key);
  });

  it('pesan hilang (1..N−1) & keluar urutan tetap bisa dibuka', () => {
    const { alice, bob, a, b } = freshPair(0x10a);

    const first = spqrSendStep(alice, a);
    const bobAfterFirst = spqrRecvStep(bob, { state: b, frames: first.frames });
    expect(bobAfterFirst.key).toEqual(first.key);

    // Alice mengirim 4 pesan, tiga di antaranya hilang.
    let aliceState = first.state;
    const survivors: { frames: Uint8Array[]; key: Uint8Array }[] = [];
    for (let i = 0; i < 4; i++) {
      const sent = spqrSendStep(alice, aliceState);
      aliceState = sent.state;
      survivors.push({ frames: sent.frames, key: sent.key });
    }

    // Hanya pesan terakhir yang sampai — ia tetap harus terbuka.
    const last = survivors[3]!;
    const received = spqrRecvStep(bob, { state: bobAfterFirst.state, frames: last.frames });
    expect(received.key).toEqual(last.key);

    // Keluar urutan: pesan yang datang terlambat tetap membuka dengan key-nya
    // sendiri (skipped key hidup di state braid, bukan peta klien).
    const outOfOrder = spqrRecvStep(bob, { state: bobAfterFirst.state, frames: survivors[1]!.frames });
    expect(outOfOrder.key).toEqual(survivors[1]!.key);
  });

  it('entropi dari host: sumber tetap → frame & key identik', () => {
    const fixed = new Uint8Array(128).fill(0x11);
    const a1 = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), { randomBytes: () => fixed });
    const a2 = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), { randomBytes: () => fixed });

    const s1 = spqrSendStep(a1, initSpqrSession(a1, { authKey: AUTH_KEY, direction: 'A2B' }));
    const s2 = spqrSendStep(a2, initSpqrSession(a2, { authKey: AUTH_KEY, direction: 'A2B' }));

    expect(s1.frames).toEqual(s2.frames);
    expect(s1.key).toEqual(s2.key);
    expect(s1.state).toEqual(s2.state);
  });

  it('frame yang diulang ditolak crate (duplikat harus dicegah SEBELUM ratchet)', () => {
    // Konsekuensi desain yang penting: jalur pesan wajib mengecek MK cache per
    // messageId lebih dulu (`utils/crypto.ts`), karena menerapkan frame yang
    // sama dua kali bukan "sukses tanpa isi" melainkan error dari crate.
    const { alice, bob, a, b } = freshPair(0xfeed);
    const sent = spqrSendStep(alice, a);
    const first = spqrRecvStep(bob, { state: b, frames: sent.frames });
    expect(first.key).toEqual(sent.key);
    expect(() => spqrRecvStep(bob, { state: first.state, frames: sent.frames })).toThrow();
  });

  it('input tidak sah ditolak sebelum menyentuh state', () => {
    const { bob, b } = freshPair();
    expect(() => spqrRecvStep(bob, { state: b, frames: [] })).toThrow(/tidak ada frame/);
    expect(() =>
      spqrRecvStep(bob, { state: b, frames: Array(20).fill(new Uint8Array([1, 2, 3])) })
    ).toThrow(/terlalu banyak frame/);
  });
});

// ---------------------------------------------------------------------------
// Perilaku loop langkah — diuji dengan ratchet palsu yang bisa diskrip.
// ---------------------------------------------------------------------------
//
// Crate ter-pin hampir selalu menghasilkan key pada langkah pertama, jadi jalur
// "beberapa frame tanpa key" tidak bisa dipicu dari modul sungguhan. Yang bisa
// diuji deterministik adalah logikanya: frame dikumpulkan sampai key ada, dan
// rangkaian yang tidak pernah menghasilkan key GAGAL (tidak ada pesan tanpa key
// yang lolos ke wire).

type ScriptedStep = { msg: Uint8Array; key: Uint8Array | null };

function scriptedRatchet(sendSteps: ScriptedStep[], recvKeys: (Uint8Array | null)[] = []): {
  ratchet: SpqrRatchet;
  sentStates: number;
  recvCalls: number;
} {
  let sendIndex = 0;
  const state = { sentStates: 0, recvCalls: 0 };
  const ratchet: SpqrRatchet = {
    entropyBytes: 32,
    emptyState: () => new Uint8Array([0]),
    currentVersion: (): SpqrVersionStatus => 'V1',
    initialState: () => new Uint8Array([1, 2, 3]),
    send: (current) => {
      const step = sendSteps[Math.min(sendIndex, sendSteps.length - 1)]!;
      sendIndex++; state.sentStates++;
      const next = new Uint8Array(current.length + 1);
      next.set(current);
      next[current.length] = sendIndex;
      return { state: next, msg: step.msg, key: step.key };
    },
    recv: (current) => {
      const key = recvKeys[state.recvCalls] ?? null;
      state.recvCalls++;
      const next = new Uint8Array(current.length + 1);
      next.set(current);
      next[current.length] = 0x7f;
      return { state: next, key };
    },
  };
  return { ratchet, get sentStates() { return state.sentStates; }, get recvCalls() { return state.recvCalls; } };
}

describe('loop langkah (ratchet palsu)', () => {
  it('mengumpulkan frame tanpa key lalu berhenti saat key muncul', () => {
    const script = scriptedRatchet([
      { msg: new Uint8Array([0xa1]), key: null },
      { msg: new Uint8Array(), key: null },
      { msg: new Uint8Array([0xa2, 0xa3]), key: new Uint8Array([9, 9]) },
    ]);
    const result = spqrSendStep(script.ratchet, new Uint8Array([5]));
    expect(result.frames).toEqual([new Uint8Array([0xa1]), new Uint8Array([0xa2, 0xa3])]);
    expect(result.key).toEqual(new Uint8Array([9, 9]));
    expect(script.sentStates).toBe(3);
  });

  it('rangkaian tanpa key sama sekali → SpqrSessionError (fail-closed)', () => {
    const script = scriptedRatchet([{ msg: new Uint8Array([0xb1]), key: null }]);
    expect(() => spqrSendStep(script.ratchet, new Uint8Array([5]))).toThrow(SpqrSessionError);
    expect(script.sentStates).toBe(SPQR_MAX_STEPS_PER_MESSAGE);
  });

  it('pesan penerima memakai key TERAKHIR yang dihasilkan', () => {
    const script = scriptedRatchet(
      [{ msg: new Uint8Array([1]), key: null }],
      [new Uint8Array([1, 1]), null, new Uint8Array([2, 2])]
    );
    const result = spqrRecvStep(script.ratchet, {
      state: new Uint8Array([0]),
      frames: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
    });
    expect(result.key).toEqual(new Uint8Array([2, 2]));
    expect(script.recvCalls).toBe(3);
  });

  it('rangkaian frame tanpa key → key null (pemanggil menunggu, bukan sukses kosong)', () => {
    const script = scriptedRatchet([], [null, null]);
    const result = spqrRecvStep(script.ratchet, {
      state: new Uint8Array([0]),
      frames: [new Uint8Array([1]), new Uint8Array([2])],
    });
    expect(result.key).toBeNull();
  });
});

beforeAll(() => {
  if (!HAS_WASM) {
    console.warn('[spqrSession.test] dist/spqr.wasm tidak ada — suite di-skip.');
  }
});
