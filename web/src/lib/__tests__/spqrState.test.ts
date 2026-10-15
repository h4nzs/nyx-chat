// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/33 §33.5] State braid SPQR: ter-seal + koalesensi tulis + fail-closed.
 *
 * Yang dikunci: satu tulis per burst (bukan per pesan), nilai tidak pernah
 * tersimpan plaintext, state rusak/terkunci TIDAK pernah dilaporkan sebagai
 * "state kosong" (itu akan memutus rantai ratchet tanpa suara), dan state yang
 * membengkak ditolak sebelum menyentuh disk.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

interface Row {
  key: string;
  value: unknown;
}

const rows = new Map<string, Row>();
let putCount = 0;

vi.mock('@lib/db', () => ({
  db: {
    kvStore: {
      get: async (key: string) => rows.get(key),
      put: async (row: Row) => {
        putCount += 1;
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
  encryptValueAtRest: vi.fn(async (value: string) =>
    'ENC1:' + Buffer.from(value, 'utf8').toString('base64')
  ),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

const {
  SPQR_MAX_STATE_BYTES,
  SPQR_STATE_KEY_PREFIX,
  SPQR_STATE_WRITE_DEBOUNCE_MS,
  SpqrStateError,
  clearSpqrStates,
  deleteSpqrState,
  discardPendingSpqrState,
  flushSpqrState,
  loadSpqrState,
  saveSpqrState,
} = await import('../spqrState');

const SESSION = 'conv-1';
const stateBytes = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

beforeEach(() => {
  vi.useFakeTimers();
  rows.clear();
  putCount = 0;
  discardPendingSpqrState();
});

afterEach(() => {
  discardPendingSpqrState();
  vi.useRealTimers();
});

describe('saveSpqrState / loadSpqrState', () => {
  it('menulis setelah debounce, ter-seal, dan bisa dibaca utuh', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(7), version: 'v2', now: 1000 });
    expect(putCount).toBe(0); // belum ada tulis

    await vi.advanceTimersByTimeAsync(SPQR_STATE_WRITE_DEBOUNCE_MS);
    expect(putCount).toBe(1);

    const row = rows.get(`${SPQR_STATE_KEY_PREFIX}${SESSION}`)!;
    expect(row).toBeDefined();
    expect(String(row.value).startsWith('ENC1:')).toBe(true);
    // State TIDAK plaintext di baris tersimpan.
    expect(String(row.value)).not.toContain('BwcHBwc');

    const loaded = await loadSpqrState(SESSION);
    expect(loaded?.sessionId).toBe(SESSION);
    expect(loaded?.version).toBe('v2');
    expect(loaded?.state).toEqual(stateBytes(7));
  });

  it('beberapa simpan dalam satu jendela = SATU tulis (state terakhir yang menang)', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2' });
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(2), version: 'v2' });
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(3), version: 'v2' });

    await vi.advanceTimersByTimeAsync(SPQR_STATE_WRITE_DEBOUNCE_MS);
    expect(putCount).toBe(1);
    expect((await loadSpqrState(SESSION))?.state).toEqual(stateBytes(3));
  });

  it('flush memaksa tulis sebelum debounce habis', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(9), version: 'v2' });
    await flushSpqrState(SESSION);
    expect(putCount).toBe(1);
    expect((await loadSpqrState(SESSION))?.state).toEqual(stateBytes(9));

    // Timer yang tertunda tidak menulis dua kali.
    await vi.advanceTimersByTimeAsync(SPQR_STATE_WRITE_DEBOUNCE_MS);
    expect(putCount).toBe(1);
  });

  it('state melampaui batas ditolak SEBELUM masuk antrean', async () => {
    await expect(
      saveSpqrState({
        sessionId: SESSION,
        state: new Uint8Array(SPQR_MAX_STATE_BYTES + 1),
        version: 'v2',
      })
    ).rejects.toThrow(SpqrStateError);

    await vi.advanceTimersByTimeAsync(SPQR_STATE_WRITE_DEBOUNCE_MS);
    expect(putCount).toBe(0);
  });

  it('sessionId kosong ditolak (nilai ini jadi bagian kunci baris)', async () => {
    await expect(saveSpqrState({ sessionId: '', state: stateBytes(1), version: 'v2' })).rejects.toThrow(
      SpqrStateError
    );
  });

  it('state rusak / tidak bisa dibuka = undefined, bukan "state kosong"', async () => {
    rows.set(`${SPQR_STATE_KEY_PREFIX}${SESSION}`, { key: 'x', value: 'bukan-ENC1' });
    expect(await loadSpqrState(SESSION)).toBeUndefined();

    rows.set(`${SPQR_STATE_KEY_PREFIX}${SESSION}`, { key: 'x', value: 'ENC1:' + Buffer.from('{"v":"v9","s":"AA=="}').toString('base64') });
    expect(await loadSpqrState(SESSION)).toBeUndefined();

    rows.set(`${SPQR_STATE_KEY_PREFIX}${SESSION}`, { key: 'x', value: 'ENC1:' + Buffer.from('{"v":"v2","s":""}').toString('base64') });
    expect(await loadSpqrState(SESSION)).toBeUndefined();
  });

  it('sesi tanpa state = undefined', async () => {
    expect(await loadSpqrState('belum-ada')).toBeUndefined();
  });
});

describe('hapus state', () => {
  it('deleteSpqrState membatalkan tulis yang tertunda untuk sesi itu', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(4), version: 'v2' });
    await deleteSpqrState(SESSION);
    await vi.advanceTimersByTimeAsync(SPQR_STATE_WRITE_DEBOUNCE_MS);

    expect(putCount).toBe(0);
    expect(await loadSpqrState(SESSION)).toBeUndefined();
  });

  it('clearSpqrStates hanya menghapus baris ber-prefix braid', async () => {
    rows.set('nyx_peer_identity_v1', { key: 'nyx_peer_identity_v1', value: 'ENC1:lain' });
    await saveSpqrState({ sessionId: 'a', state: stateBytes(1), version: 'v2' });
    await saveSpqrState({ sessionId: 'b', state: stateBytes(2), version: 'v2' });
    await flushSpqrState();

    await clearSpqrStates();

    expect(await loadSpqrState('a')).toBeUndefined();
    expect(await loadSpqrState('b')).toBeUndefined();
    expect(rows.has('nyx_peer_identity_v1')).toBe(true);
  });
});
