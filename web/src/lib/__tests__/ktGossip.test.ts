// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 tahap C / docs/34 §34.5] Gossip tree head KT.
 *
 * Yang dikunci di sini:
 *   1. Bentuk field di payload ter-seal (`ktG`) dan pembacaannya yang defensive —
 *      payload datang dari peer, jadi bentuk aneh apa pun harus berarti "tidak
 *      ada gossip", bukan melempar di tengah jalur dekripsi.
 *   2. Aturan verdict: satu `treeSize` hanya punya satu root → ukuran sama +
 *      root beda adalah `split-view`, dan hanya itu yang dilaporkan.
 *   3. Head peer + jangkar disimpan **ter-seal** (`ENC1:`) dan bertahan antar
 *      pemuatan (batch pesan setelah reload tidak kehilangan jangkar).
 *   4. Fail-open: adapter produksi tanpa tabel/`db` tidak menggagalkan jalur pesan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  blob: string;
}

const rows = new Map<string, Row>();
let tableAvailable = true;

vi.mock('@lib/db', () => ({
  db: {
    get ktGossip() {
      if (!tableAvailable) return undefined;
      return {
        get: async (key: string) => rows.get(key),
        put: async (row: Row) => {
          rows.set(row.id, row);
        },
      };
    },
  },
}));

vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

const {
  KT_GOSSIP_FIELD,
  KT_GOSSIP_ROW_ID,
  createKtGossip,
  evaluateGossipHead,
  extractTreeHeadField,
  getLocalAnchor,
  ktGossip,
  loadStoredAnchor,
  parseHeadAnchor,
  recordPeerTreeHead,
  resetKtGossipForTests,
  resetLocalAnchorForTests,
  setLocalAnchor,
  storeAnchor,
  treeHeadField,
} = await import('../ktGossip');

const ROOT_A = 'aa'.repeat(32);
const ROOT_B = 'bb'.repeat(32);

interface MemoryStorage {
  value: string | undefined;
  writes: number;
}

function memoryStorage(): { storage: { read: () => Promise<string | undefined>; write: (value: string) => Promise<void> }; state: MemoryStorage } {
  const state: MemoryStorage = { value: undefined, writes: 0 };
  return {
    state,
    storage: {
      read: async () => state.value,
      write: async (value: string) => {
        state.writes += 1;
        state.value = value;
      },
    },
  };
}

beforeEach(() => {
  rows.clear();
  tableAvailable = true;
  resetKtGossipForTests();
});

describe('field gossip di payload ter-seal', () => {
  it('round-trip lewat payload pesan yang sebenarnya (kontrak dengan crypto.ts)', () => {
    // Bentuk payload jalur kirim v1: konten + identitas + ackV + ktG.
    const payload = JSON.stringify({
      content: 'hai',
      senderId: 'u1',
      senderDeviceKey: 'k',
      ackKem: 'kem',
      ackV: 2,
      ...treeHeadField({ root: ROOT_A, treeSize: 42 }),
    });

    expect(extractTreeHeadField(payload)).toEqual({ root: ROOT_A, treeSize: 42 });
    // Field lama tidak rusak oleh penambahan `ktG`.
    expect(JSON.parse(payload)).toMatchObject({ content: 'hai', senderId: 'u1', ackV: 2 });
  });

  it('tanpa jangkar → tidak ada field sama sekali (klien baru tidak berubah)', () => {
    expect(treeHeadField(null)).toEqual({});
    expect(treeHeadField(undefined)).toEqual({});
    // Jangkar tidak sah juga tidak dikirim (bukan dikirim apa adanya).
    expect(treeHeadField({ root: ROOT_A.toUpperCase(), treeSize: 1 })).toEqual({});
    expect(treeHeadField({ root: ROOT_A, treeSize: 0 })).toEqual({});
    expect(JSON.parse(JSON.stringify({ content: 'x', ...treeHeadField(null) }))).toEqual({ content: 'x' });
  });

  it('pembacaan defensive: payload peer yang aneh berarti "tidak ada gossip"', () => {
    const cases = [
      'bukan json',
      '',
      'null',
      '[]',
      JSON.stringify({ content: 'x' }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: null }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: 'aa'.repeat(32) }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A } }), // tanpa treeSize
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A.toUpperCase(), s: 5 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: 'aa', s: 5 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A, s: 0 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A, s: -3 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A, s: 1.5 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A, s: 2_000_000_000 } }),
      JSON.stringify({ [KT_GOSSIP_FIELD]: { r: ROOT_A, s: '5' } }),
    ];
    for (const value of cases) expect(extractTreeHeadField(value)).toBeUndefined();
  });

  it('parseHeadAnchor menolak bentuk yang tidak mungkin jadi tree head', () => {
    expect(parseHeadAnchor({ r: ROOT_A, s: 7 })).toEqual({ root: ROOT_A, treeSize: 7 });
    expect(parseHeadAnchor(null)).toBeUndefined();
    expect(parseHeadAnchor({ r: ROOT_A, s: 7, extra: 1 })).toEqual({ root: ROOT_A, treeSize: 7 });
  });
});

describe('evaluateGossipHead', () => {
  it('ukuran sama + root sama = consistent', () => {
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 10 }, { root: ROOT_A, treeSize: 10 })).toBe('consistent');
  });

  it('ukuran sama + root beda = split-view (satu pohon, satu root per ukuran)', () => {
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 10 }, { root: ROOT_B, treeSize: 10 })).toBe('split-view');
  });

  it('ukuran berbeda = informasi saja, bukan tuduhan', () => {
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 10 }, { root: ROOT_B, treeSize: 11 })).toBe('peer-ahead');
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 10 }, { root: ROOT_B, treeSize: 9 })).toBe('peer-stale');
  });

  it('tanpa jangkar lokal (atau head peer tidak sah) tidak menyimpulkan apa pun', () => {
    expect(evaluateGossipHead(null, { root: ROOT_A, treeSize: 1 })).toBe('no-anchor');
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 1 }, null)).toBe('no-anchor');
    expect(evaluateGossipHead({ root: ROOT_A, treeSize: 1 }, { root: 'zz', treeSize: 1 })).toBe('no-anchor');
  });
});

describe('createKtGossip', () => {
  it('mencatat head peer dan membandingkannya dengan jangkar lokal', async () => {
    const { storage } = memoryStorage();
    const store = createKtGossip({ storage });
    setLocalAnchor({ root: ROOT_A, treeSize: 10 });

    expect(await store.recordPeerHead('conv-1', { r: ROOT_A, s: 10 })).toBe('consistent');
    expect(await store.recordPeerHead('conv-1', { r: ROOT_B, s: 10 })).toBe('split-view');
    expect(await store.list()).toEqual([
      { peerId: 'conv-1', head: { root: ROOT_B, treeSize: 10 }, at: expect.any(Number), verdict: 'split-view' },
    ]);
    expect(await store.splitViews()).toHaveLength(1);
  });

  it('head yang tidak berubah tidak ditulis ulang (pesan beruntun tidak menulis DB)', async () => {
    const { storage, state } = memoryStorage();
    const store = createKtGossip({ storage });
    setLocalAnchor({ root: ROOT_A, treeSize: 10 });

    await store.recordPeerHead('conv-1', { r: ROOT_A, s: 10 });
    expect(state.writes).toBe(1);
    await store.recordPeerHead('conv-1', { r: ROOT_A, s: 10 });
    await store.recordPeerHead('conv-1', { r: ROOT_A, s: 10 });
    expect(state.writes).toBe(1);

    // Naik ke head berikutnya → satu tulisan lagi.
    await store.recordPeerHead('conv-1', { r: ROOT_B, s: 11 });
    expect(state.writes).toBe(2);
  });

  it('melaporkan split-view ke pendengar, sekali per perubahan', async () => {
    const { storage } = memoryStorage();
    const onSplitView = vi.fn();
    const store = createKtGossip({ storage, onSplitView });
    setLocalAnchor({ root: ROOT_A, treeSize: 10 });

    await store.recordPeerHead('conv-1', { r: ROOT_B, s: 10 });
    expect(onSplitView).toHaveBeenCalledTimes(1);

    const record = onSplitView.mock.calls[0]![0] as { peerId: string; verdict: string };
    expect(record).toMatchObject({ peerId: 'conv-1', verdict: 'split-view' });

    // Head sama dikirim lagi → tidak dilaporkan ulang (dedup).
    await store.recordPeerHead('conv-1', { r: ROOT_B, s: 10 });
    expect(onSplitView).toHaveBeenCalledTimes(1);
  });

  it('head yang tidak sah tidak masuk penyimpanan', async () => {
    const { storage, state } = memoryStorage();
    const store = createKtGossip({ storage });
    expect(await store.recordPeerHead('conv-1', { r: 'bukan-hex', s: 1 })).toBe('no-anchor');
    expect(await store.recordPeerHead('conv-1', null)).toBe('no-anchor');
    expect(state.writes).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('membatasi jumlah peer yang disimpan (peer lama dibuang)', async () => {
    const { storage, state } = memoryStorage();
    const store = createKtGossip({ storage, maxPeers: 2, now: () => 1 });
    setLocalAnchor({ root: ROOT_A, treeSize: 1 });

    await store.recordPeerHead('conv-1', { r: ROOT_A, s: 1 });
    await store.recordPeerHead('conv-2', { r: ROOT_A, s: 1 });
    await store.recordPeerHead('conv-3', { r: ROOT_A, s: 1 });

    const keys = (await store.list()).map((record) => record.peerId);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('conv-3');
    expect(keys).not.toContain('conv-1');
    // Blob tetap JSON tunggal (satu baris, bukan satu baris per peer).
    expect(Object.keys(JSON.parse(state.value!))).toEqual(['a', 'p']);
  });

  it('forget/clear bekerja, dan baris rusak tidak melempar', async () => {
    const { storage, state } = memoryStorage();
    const store = createKtGossip({ storage });
    setLocalAnchor({ root: ROOT_A, treeSize: 10 });
    await store.recordPeerHead('conv-1', { r: ROOT_A, s: 10 });
    await store.recordPeerHead('conv-2', { r: ROOT_A, s: 10 });

    await store.forget('conv-1');
    expect((await store.list()).map((record) => record.peerId)).toEqual(['conv-2']);

    await store.clear();
    expect(await store.list()).toEqual([]);

    state.value = 'bukan json';
    expect(await store.list()).toEqual([]);
    expect(await store.recordPeerHead('conv-3', { r: ROOT_A, s: 10 })).toBe('consistent');
  });

  it('jangkar bertahan antar-instance (reload tidak menghapus jangkar)', async () => {
    const { storage, state } = memoryStorage();
    const first = createKtGossip({ storage });
    await first.setAnchor({ root: ROOT_A, treeSize: 10 });
    expect(state.value).toBeDefined();

    resetLocalAnchorForTests();
    expect(getLocalAnchor()).toBeNull();

    const second = createKtGossip({ storage });
    expect(await second.loadAnchor()).toEqual({ root: ROOT_A, treeSize: 10 });
    expect(getLocalAnchor()).toEqual({ root: ROOT_A, treeSize: 10 });
    // Head peer juga bertahan.
    await second.recordPeerHead('conv-1', { r: ROOT_B, s: 10 });
    expect(await second.splitViews()).toHaveLength(1);
  });
});

describe('adapter produksi (Dexie ktGossip, ter-seal)', () => {
  it('menyimpan satu baris ter-seal dan memuat jangkarnya kembali', async () => {
    await storeAnchor({ root: ROOT_A, treeSize: 42 });

    const row = rows.get(KT_GOSSIP_ROW_ID)!;
    expect(row).toBeDefined();
    expect(row.blob.startsWith('ENC1:')).toBe(true);
    expect(row.blob).not.toContain(ROOT_A); // root tidak plaintext di IndexedDB

    resetLocalAnchorForTests();
    expect(await loadStoredAnchor()).toEqual({ root: ROOT_A, treeSize: 42 });
  });

  it('recordPeerTreeHead mencatat verdict dan tetap fail-open tanpa tabel', async () => {
    await storeAnchor({ root: ROOT_A, treeSize: 10 });
    expect(await recordPeerTreeHead('conv-1', { r: ROOT_B, s: 10 })).toBe('split-view');
    expect(await ktGossip().splitViews()).toHaveLength(1);

    tableAvailable = false;
    resetKtGossipForTests();
    await expect(recordPeerTreeHead('conv-2', { r: ROOT_A, s: 10 })).resolves.toBe('no-anchor');
    await expect(storeAnchor({ root: ROOT_A, treeSize: 11 })).resolves.toBeUndefined();
    // Cache RAM tetap terbarui walau persistensi gagal.
    expect(getLocalAnchor()).toEqual({ root: ROOT_A, treeSize: 11 });
  });
});
