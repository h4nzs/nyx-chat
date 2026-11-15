// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [audit N5-01] Pesan v2 lintas-era: frame braid era X3DH LAMA harus tetap bisa
 * dibuka setelah sesi baru didirikan.
 *
 * Sebelum perbaikan, `spqrState` hanya punya satu baris per percakapan dan baris
 * itu dihapus saat sesi baru lahir — pesan v2 yang masih di jalan (peer offline)
 * menjadi tidak terbaca permanen, sementara jalur v1 menyelamatkannya lewat tiga
 * slot arsip `#archived_0..2`.
 *
 * Yang dibuktikan di sini dengan modul WASM **sungguhan**:
 *   1. State era 2 menolak frame era 1 (bukan kebetulan berhasil).
 *   2. State era 1 yang diarsipkan menghasilkan message key yang SAMA dengan
 *      pengirim era 1.
 *   3. Dekripsi dari arsip tidak mengubah baris aktif (era 2 tetap utuh) —
 *      arsip hanya untuk membaca, tidak pernah dipromosikan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Row {
  key: string;
  value: unknown;
}

const rows = new Map<string, Row>();

vi.mock('@lib/db', () => ({
  db: {
    kvStore: {
      get: async (key: string) => rows.get(key),
      put: async (row: Row) => {
        rows.set(row.key, row);
      },
      delete: async (key: string) => {
        rows.delete(key);
      },
      where: () => ({
        startsWith: (prefix: string) => ({
          delete: async () => {
            for (const key of Array.from(rows.keys())) {
              if (key.startsWith(prefix)) rows.delete(key);
            }
          },
        }),
      }),
    },
  },
}));

vi.mock('@lib/keychainDb', () => ({
  encryptValueAtRest: async (value: string) =>
    'ENC1:' + Buffer.from(value, 'utf8').toString('base64'),
  decryptValueAtRest: async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null,
}));

import {
  SPQR_STATE_ARCHIVE_SLOTS,
  discardPendingSpqrState,
  flushSpqrState,
  loadArchivedSpqrStates,
  loadSpqrState,
  rotateSpqrStateForNewSession,
  saveSpqrState,
} from '../spqrState';
import { initSpqrSession, spqrRecvStep, spqrSendStep } from '../spqrSession';
import { instantiateSpqrRatchet, type SpqrRatchet } from '../spqrRatchet';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);
const SESSION = 'conv-dua-era';

// [audit N5-03] Artefak hilang = tes GAGAL, bukan hijau tanpa berjalan.
if (!HAS_WASM) {
  describe('artefak spqr.wasm (arsip era)', () => {
    it('dist/spqr.wasm harus ada — jalankan build spqr-wasm', () => {
      expect(HAS_WASM).toBe(true);
    });
  });
}

const withSkip = HAS_WASM ? describe : describe.skip;

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

interface Era {
  ratchet: SpqrRatchet;
  alice: Uint8Array;
  bob: Uint8Array;
}

function makeEra(authFill: number, aliceSeed: number, bobSeed: number): Era {
  const ratchet = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), {
    randomBytes: seededRandomBytes(aliceSeed),
  });
  const bobRatchet = instantiateSpqrRatchet(new Uint8Array(readFileSync(WASM_PATH)), {
    randomBytes: seededRandomBytes(bobSeed),
  });
  const authKey = new Uint8Array(32).fill(authFill);
  return {
    ratchet,
    alice: initSpqrSession(ratchet, { authKey, direction: 'A2B' }),
    bob: initSpqrSession(bobRatchet, { authKey, direction: 'B2A' }),
  };
}

beforeEach(() => {
  rows.clear();
  discardPendingSpqrState();
});

afterEach(() => {
  discardPendingSpqrState();
});

withSkip('arsip era braid SPQR (dua sesi X3DH)', () => {
  it('frame era lama ditolak state aktif, tetapi terbuka dari arsip era', async () => {
    // Era 1: pengirim menyiapkan pesan; penerima BELUM sempat membukanya.
    const era1 = makeEra(0x11, 0xa1, 0xb1);
    const send1 = spqrSendStep(era1.ratchet, era1.alice);

    await saveSpqrState({ sessionId: SESSION, state: era1.bob, version: 'v2' });
    await flushSpqrState(SESSION);

    // Sesi baru lahir (X3DH baru): state era 1 diarsipkan, bukan dihapus.
    await rotateSpqrStateForNewSession(SESSION);

    const era2 = makeEra(0x22, 0xa2, 0xb2);
    await saveSpqrState({ sessionId: SESSION, state: era2.bob, version: 'v2' });
    await flushSpqrState(SESSION);

    const active = await loadSpqrState(SESSION);
    expect(active?.state).toEqual(era2.bob);

    // 1. Era aktif tidak bisa membuka pesan era lama: braid memang masih
    //    menghasilkan *sebuah* key dari frame asing (bukan jaminan otentikasi),
    //    tetapi key itu TIDAK PERNAH sama dengan key pengirim — dan pada jalur
    //    nyata (`worker_spqr_ratchet_decrypt`) AEAD dengan key salah melempar,
    //    sehingga state tidak tersimpan.
    let wrongEraKey: Uint8Array | null = null;
    try {
      wrongEraKey = spqrRecvStep(era1.ratchet, { state: active!.state, frames: send1.frames }).key;
    } catch {
      wrongEraKey = null;
    }
    if (wrongEraKey) {
      expect(Array.from(wrongEraKey)).not.toEqual(Array.from(send1.key));
    } else {
      expect(wrongEraKey).toBeNull();
    }

    // 2. Arsip era 1 membuka pesan itu dengan key yang sama dengan pengirim.
    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.state).toEqual(era1.bob);

    const recv1 = spqrRecvStep(era1.ratchet, { state: archived[0]!.state, frames: send1.frames });
    expect(recv1.key).not.toBeNull();
    expect(Array.from(recv1.key!)).toEqual(Array.from(send1.key));

    // 3. Membaca dari arsip tidak memajukan/menimpa era aktif.
    expect((await loadSpqrState(SESSION))?.state).toEqual(era2.bob);
  });

  it('arsip dibatasi FIFO: hanya tiga era terakhir, terbaru lebih dulu', async () => {
    const states: Uint8Array[] = [];
    for (let era = 0; era <= SPQR_STATE_ARCHIVE_SLOTS; era++) {
      const state = new Uint8Array(64).fill(era);
      states.push(state);
      await saveSpqrState({ sessionId: SESSION, state, version: 'v2' });
      await flushSpqrState(SESSION);
      await rotateSpqrStateForNewSession(SESSION);
    }

    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(SPQR_STATE_ARCHIVE_SLOTS);
    // Era tertua (0) dibuang; urutan = terbaru dulu.
    expect(archived.map((record) => record.state[0])).toEqual([
      SPQR_STATE_ARCHIVE_SLOTS,
      SPQR_STATE_ARCHIVE_SLOTS - 1,
      SPQR_STATE_ARCHIVE_SLOTS - 2,
    ]);
    expect(archived[0]?.state).toEqual(states[SPQR_STATE_ARCHIVE_SLOTS]);
  });

  // [audit N11-01/N11-02] Sesi baru bisa lahir tanpa satu pun pesan v2.
  // Era seperti itu harus DITANDAI `advanced: false` secara eksplisit; default
  // konservatif mengarsipkan, jadi lupa menandai hanya kehilangan slot, bukan
  // era (kelas bug N5-01).
  it('era baru tanpa lalu lintas tidak menggeser arsip (advanced: false)', async () => {
    const era1 = makeEra(0x11, 0xa1, 0xb1);
    await saveSpqrState({ sessionId: SESSION, state: era1.bob, version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    const era2 = makeEra(0x22, 0xa2, 0xb2);
    await saveSpqrState({ sessionId: SESSION, state: era2.bob, version: 'v2', advanced: false });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.state).toEqual(era1.bob);
  });
});
