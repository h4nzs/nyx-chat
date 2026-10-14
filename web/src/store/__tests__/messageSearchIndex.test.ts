// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F §30.10 poin 3] Test perilaku store pencarian setelah indeks
 * in-memory dipasang.
 *
 * Yang dikunci: (a) hasil pencarian identik dengan pencarian substring lama,
 * (b) baris yang tidak berubah TIDAK didekripsi ulang di pencarian berikutnya
 * (inilah yang menghapus O(n) XChaCha-open per ketikan), (c) tombstone/unsend
 * ikut keluar dari hasil.
 *
 * Dexie + crypto di-stub (konvensi repo: tanpa Postgres/Redis/IndexedDB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = {
  id: string;
  conversationId: string;
  content: string | null;
  createdAt?: string | null;
  createdAtSealed?: string | null;
  orderBucketMs?: number | null;
  isDeletedLocal?: boolean | string;
  isViewOnce?: boolean | string;
  senderId?: string;
};

const rows = new Map<string, Row>();
const decryptCalls: string[] = [];

vi.mock('@lib/shadowVaultDb', () => ({
  shadowVault: {
    messages: {
      where: () => ({
        equals: (conversationId: string) => ({
          toArray: async () => [...rows.values()].filter((r) => r.conversationId === conversationId),
        }),
      }),
      bulkGet: async (ids: string[]) => ids.map((id) => rows.get(id)),
    },
  },
  decryptVaultText: vi.fn(async (encrypted: string) => {
    decryptCalls.push(encrypted);
    return encrypted.startsWith('PLAIN:') ? encrypted.slice(6) : null;
  }),
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    to_hex: () => 'token',
    randombytes_buf: () => new Uint8Array(16),
  })),
}));

const { useMessageSearchStore, resetSearchIndexForTests } = await import('../messageSearch');

const message = (id: string, text: string | null, extra: Partial<Row> = {}): Row => ({
  id,
  conversationId: 'c1',
  content: text === null ? null : `PLAIN:${text}`,
  createdAt: '2026-09-01T10:00:00.000Z',
  orderBucketMs: 1791000000000,
  ...extra,
});

const search = (query: string) => useMessageSearchStore.getState().searchMessages(query, 'c1');

beforeEach(() => {
  rows.clear();
  decryptCalls.length = 0;
  resetSearchIndexForTests();
  useMessageSearchStore.setState({ searchResults: [], searchQuery: '', currentSearchToken: null });
});

describe('messageSearch + indeks in-memory', () => {
  it('mengembalikan hasil yang sama seperti pencarian substring lama', async () => {
    rows.set('m1', message('m1', 'Hello world from Alice'));
    rows.set('m2', message('m2', 'unrelated'));
    rows.set('m3', message('m3', 'WORLD traveler'));

    await search('wor');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1', 'm3']);

    await search('o wor');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1']);

    // Hasil diurutkan lama→baru seperti sebelumnya.
    await search('world');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('tidak mendekripsi ulang baris yang tidak berubah pada pencarian berikutnya', async () => {
    rows.set('m1', message('m1', 'rahasia proyek alpha'));
    rows.set('m2', message('m2', 'rahasia proyek beta'));

    await search('alpha');
    const afterFirst = decryptCalls.length;
    expect(afterFirst).toBe(2); // dua baris didekripsi sekali untuk membangun indeks

    await search('beta');
    expect(decryptCalls.length - afterFirst).toBe(0); // indeks dipakai ulang

    await search('alpha');
    expect(decryptCalls.length - afterFirst).toBe(0);
  });

  it('mendekripsi HANYA baris baru setelah pesan ditambahkan', async () => {
    rows.set('m1', message('m1', 'rahasia proyek alpha'));
    await search('alpha');
    const baseline = decryptCalls.length;

    rows.set('m2', message('m2', 'rahasia proyek gamma'));
    await search('gamma');
    // Hanya baris baru yang didekripsi untuk indeks; baris lama tetap di cache.
    expect(decryptCalls.length - baseline).toBe(1);
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m2']);
  });

  it('tombstone/unsend keluar dari hasil, termasuk yang diubah setelah terindeks', async () => {
    rows.set('m1', message('m1', 'pesan terhapus'));
    await search('terhapus');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1']);

    // Unsend local: content dikosongkan + tombstone (sidik jari berubah).
    rows.set('m1', message('m1', null, { isDeletedLocal: true }));
    await search('terhapus');
    expect(useMessageSearchStore.getState().searchResults).toEqual([]);
  });

  it('pesan view-once tidak diindeks (sesuai perilaku lama)', async () => {
    rows.set('m1', message('m1', 'sekali lihat', { isViewOnce: true }));
    rows.set('m2', message('m2', 'sekali lihat juga'));
    await search('sekali');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m2']);
  });

  it('query tanpa token (mis. tanda baca) jatuh ke pemindaian penuh seperti dulu', async () => {
    rows.set('m1', message('m1', 'penting!!!'));
    rows.set('m2', message('m2', 'biasa'));
    await search('!!!');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1']);
  });

  it('baris yang dihapus dari vault hilang dari indeks', async () => {
    rows.set('m1', message('m1', 'akan dihapus'));
    rows.set('m2', message('m2', 'tetap ada'));
    await search('dihapus');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m1']);

    rows.delete('m1');
    await search('dihapus');
    expect(useMessageSearchStore.getState().searchResults).toEqual([]);
    await search('tetap');
    expect(useMessageSearchStore.getState().searchResults.map((m) => m.id)).toEqual(['m2']);
  });
});
