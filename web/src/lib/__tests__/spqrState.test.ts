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
  SPQR_STATE_ARCHIVE_SLOTS,
  SPQR_STATE_KEY_PREFIX,
  SPQR_STATE_WRITE_DEBOUNCE_MS,
  SpqrStateError,
  clearSpqrStates,
  deleteSpqrState,
  discardPendingSpqrState,
  flushSpqrState,
  loadArchivedSpqrStates,
  loadSpqrState,
  rotateSpqrStateForNewSession,
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
    // [audit N10-04 → N11-02] Penanda kemajuan ikut tersimpan; default =
    // sudah maju (konservatif: era tidak dibuang diam-diam).
    expect(loaded?.advanced).toBe(true);
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

// [audit N5-01] Jalur v1 punya tiga slot arsip era; jalur v2 dulu menghapus
// satu-satunya barisnya saat sesi baru lahir, sehingga pesan v2 yang tertunda
// melewati rotasi sesi tidak pernah bisa dibuka. Tes ini mengunci perilaku
// arsip: era lama TETAP ada, FIFO, ter-seal, dan tidak pernah menjadi aktif.
describe('arsip era braid (N5-01)', () => {
  it('rotate memindahkan state aktif ke arsip dan mengosongkan baris aktif', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);

    await rotateSpqrStateForNewSession(SESSION);

    expect(await loadSpqrState(SESSION)).toBeUndefined();
    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.state).toEqual(stateBytes(1));
    expect(archived[0]?.version).toBe('v2');
  });

  it('rotate men-flush tulis yang masih menunggu debounce', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(5), version: 'v2', advanced: true });
    // Belum ada flush: kalau rotate tidak mem-flush, arsip akan kosong/tertinggal.
    await rotateSpqrStateForNewSession(SESSION);

    expect((await loadArchivedSpqrStates(SESSION))[0]?.state).toEqual(stateBytes(5));
  });

  it('FIFO: era terbaru di slot 0 dan jumlah arsip dibatasi', async () => {
    for (let era = 0; era <= SPQR_STATE_ARCHIVE_SLOTS; era++) {
      await saveSpqrState({ sessionId: SESSION, state: stateBytes(era), version: 'v2', advanced: true });
      await flushSpqrState(SESSION);
      await rotateSpqrStateForNewSession(SESSION);
    }

    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(SPQR_STATE_ARCHIVE_SLOTS);
    expect(archived.map((record) => record.state[0])).toEqual([
      SPQR_STATE_ARCHIVE_SLOTS,
      SPQR_STATE_ARCHIVE_SLOTS - 1,
      SPQR_STATE_ARCHIVE_SLOTS - 2,
    ]);
  });

  it('arsip ter-seal dan tidak memuat state plaintext', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(7), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    const row = rows.get(`${SPQR_STATE_KEY_PREFIX}${SESSION}#era_0`);
    expect(row).toBeDefined();
    expect(String(row!.value).startsWith('ENC1:')).toBe(true);
    expect(String(row!.value)).not.toContain(Buffer.from(stateBytes(7)).toString('base64').slice(0, 12));
  });

  it('rotate tanpa state aktif tidak membuat arsip kosong', async () => {
    await rotateSpqrStateForNewSession('sesi-baru');
    expect(await loadArchivedSpqrStates('sesi-baru')).toEqual([]);
  });

  it('clearSpqrStates ikut menghapus arsip era', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(3), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);
    expect(await loadArchivedSpqrStates(SESSION)).toHaveLength(1);

    await clearSpqrStates();

    expect(await loadArchivedSpqrStates(SESSION)).toEqual([]);
    expect(await loadSpqrState(SESSION)).toBeUndefined();
  });

  // [audit N9-03 → N10-04] Sesi X3DH baru bisa lahir berulang tanpa satu pun
  // pesan v2 di antaranya, dan rotasi seperti itu tidak boleh menggeser arsip.
  // Perbandingan byte saja tidak cukup: state awal era baru SELALU berbeda
  // (`authKey` berbeda), jadi penandanya adalah "era ini pernah maju".
  it('rotate era baru tanpa lalu lintas tidak menggeser arsip', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    // Era baru: state awal BERBEDA dari slot 0, tetapi belum ada pesan v2.
    // [audit N11-02] Status "belum maju" harus eksplisit; default konservatif.
    await saveSpqrState({
      sessionId: SESSION,
      state: stateBytes(2),
      version: 'v2',
      advanced: false,
    });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.state).toEqual(stateBytes(1));
    expect(await loadSpqrState(SESSION)).toBeUndefined();
  });

  it('rotate setelah era maju tetap menggeser arsip', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    await saveSpqrState({ sessionId: SESSION, state: stateBytes(2), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    const archived = await loadArchivedSpqrStates(SESSION);
    expect(archived.map((record) => record.state[0])).toEqual([2, 1]);
    expect(archived.every((record) => record.advanced)).toBe(true);
  });

  // [audit N11-02] Default konservatif: pemanggil baru yang lupa menandai
  // TIDAK boleh membuang era lama. Hanya `advanced: false` eksplisit yang
  // menandai era belum maju.
  it('simpan tanpa penanda dianggap maju: era lama tetap diarsipkan', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2' });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    expect((await loadArchivedSpqrStates(SESSION)).map((record) => record.state[0])).toEqual([1]);
  });

  it('penanda false eksplisit menang atas default konservatif', async () => {
    await saveSpqrState({ sessionId: SESSION, state: stateBytes(1), version: 'v2', advanced: true });
    await flushSpqrState(SESSION);
    await rotateSpqrStateForNewSession(SESSION);

    await saveSpqrState({
      sessionId: SESSION,
      state: stateBytes(2),
      version: 'v2',
      advanced: false,
    });
    await flushSpqrState(SESSION);
    expect((await loadSpqrState(SESSION))?.advanced).toBe(false);
    await rotateSpqrStateForNewSession(SESSION);

    expect((await loadArchivedSpqrStates(SESSION)).map((record) => record.state[0])).toEqual([1]);
  });
});
