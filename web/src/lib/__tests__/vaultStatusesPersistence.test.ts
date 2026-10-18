// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Status baca (`Message.statuses`) harus ikut dipersist ke
 * ShadowVault.
 *
 * Gejala yang dilaporkan: centang biru/abu di bubble pengirim hilang setelah
 * berpindah percakapan dan setelah reload. Penyebabnya sama dengan reaksi:
 * `upsertMessages` menulis daftar kolom eksplisit dan `statuses` tidak ada di
 * daftar itu, jadi peta receipt hanya hidup di memori:
 *   - langkah "baca vault → replace store" pada `loadMessagesForConversation`
 *     menghapusnya begitu percakapan dibuka kembali;
 *   - reload menghapusnya permanen (pesan sinyal receipt tidak ikut ter-fetch
 *     ulang).
 *
 * Kontrak yang dikunci di sini:
 *   1. Round-trip tulis→baca mempertahankan status (status/userId/messageId).
 *   2. Baris mentah TER-SEAL (`ENC1:`), bukan userId plaintext.
 *   3. Update yang TIDAK membawa `statuses` (salinan server, tombstone parsial)
 *      mempertahankan status yang sudah tersimpan.
 *   4. `statuses: []` eksplisit = keadaan "tidak ada receipt" (dibersihkan).
 *   5. Envelope rusak hanya menghilangkan status — baris tetap terbaca.
 *
 * Semua pesan di sini tombstone (`isDeletedLocal`) sehingga tidak ada
 * pemanggilan crypto selain seal kolom status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMessagesTable() {
  const rows = new Map<string, Record<string, unknown>>();

  const selected = (selector: string, arg: unknown): Record<string, unknown>[] => {
    const all = [...rows.values()];
    if (selector === '[conversationId+orderBucketMs]') {
      const [convId, bucket] = arg as [string, unknown];
      const owned = all.filter((r) => r.conversationId === convId && typeof r.orderBucketMs === 'number');
      if (typeof bucket === 'number' && Number.isFinite(bucket)) {
        return owned.filter((r) => r.orderBucketMs === bucket);
      }
      return owned.sort((a, b) => (b.orderBucketMs as number) - (a.orderBucketMs as number));
    }
    return all.filter((r) => r.conversationId === arg);
  };

  const queried = (list: Record<string, unknown>[]) => {
    let filterFn: ((r: Record<string, unknown>) => boolean) | undefined;
    let limitCount: number | null = null;
    const api: Record<string, unknown> = {
      between: () => api,
      reverse: () => api,
      filter: (fn: (r: Record<string, unknown>) => boolean) => {
        filterFn = fn;
        return api;
      },
      limit: (n: number) => {
        limitCount = n;
        return api;
      },
      toArray: async () => {
        const out = list.filter((r) => (filterFn ? filterFn(r) : true));
        return limitCount === null ? out : out.slice(0, limitCount);
      },
      primaryKeys: async () => list.map((r) => r.id),
    };
    return api;
  };

  return {
    _rows: rows,
    toArray: async () => [...rows.values()],
    get: async (id: string) => rows.get(id),
    bulkPut: async (items: Record<string, unknown>[]) => {
      for (const item of items) rows.set(item.id as string, item);
    },
    bulkDelete: async (ids: string[]) => {
      for (const id of ids) rows.delete(id);
    },
    where: (selector: string) => ({
      equals: (arg: unknown) => queried(selected(selector, arg)),
      between: (lower: unknown, upper: unknown) => queried(selected(selector, lower)),
    }),
  };
}

const fakeMessages = makeMessagesTable();
const db = { messages: fakeMessages };

vi.mock('@lib/db', () => ({ db }));

vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

const { shadowVault } = await import('@lib/shadowVaultDb');

const READER_ID = 'reader-aaaa-1111';

const baseTombstone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId: 'c1',
  content: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  senderId: 'u1',
  isDeletedLocal: true,
  ...extra,
});

const sampleStatus = {
  id: 'st-1',
  status: 'DELIVERED',
  userId: READER_ID,
  messageId: 'm1',
  updatedAt: '2026-10-08T10:00:05.000Z',
};

beforeEach(() => fakeMessages._rows.clear());

describe('ShadowVault — persistensi status baca (BUGFIX 2026-10-18)', () => {
  it('menulis status ke record dan mengembalikannya saat dibaca', async () => {
    await shadowVault.upsertMessages([
      baseTombstone('m1', { statuses: [sampleStatus] }) as never,
    ]);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.statuses).toEqual([sampleStatus]);
  });

  it('baris mentah TER-SEAL — userId tidak plaintext', async () => {
    await shadowVault.upsertMessages([
      baseTombstone('m1', { statuses: [sampleStatus] }) as never,
    ]);

    const raw = String(fakeMessages._rows.get('m1')?.statuses ?? '');
    expect(raw.startsWith('ENC1:')).toBe(true);
    // Base64 standar tidak memuat '-' → userId bergaris hubung tidak mungkin
    // muncul verbatim bila benar-benar ter-seal.
    expect(raw).not.toContain(READER_ID);
    expect(raw).not.toContain('DELIVERED');
  });

  it('update tanpa `statuses` mempertahankan status yang sudah tersimpan', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { statuses: [sampleStatus] }) as never]);
    const firstRaw = fakeMessages._rows.get('m1')?.statuses;

    // Salinan server / tombstone parsial: tidak membawa field statuses.
    await shadowVault.upsertMessages([baseTombstone('m1') as never]);

    expect(fakeMessages._rows.get('m1')?.statuses).toBe(firstRaw);
    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.statuses).toEqual([sampleStatus]);
  });

  it('`statuses: []` eksplisit = tidak ada receipt (dibersihkan)', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { statuses: [sampleStatus] }) as never]);
    await shadowVault.upsertMessages([baseTombstone('m1', { statuses: [] }) as never]);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.statuses).toEqual([]);
  });

  it('entri rusak hanya di-drop — baris tetap terbaca', async () => {
    fakeMessages._rows.set('m-broken', {
      id: 'm-broken',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:00:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
      statuses: 'ENC1:' + Buffer.from(JSON.stringify([{ status: 'READ' }, null, { userId: 'u9' }]), 'utf8').toString('base64'),
    });
    await shadowVault.normalizeOrderIndex();

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    const broken = restored.find((m) => m.id === 'm-broken');
    expect(broken).toBeTruthy();
    // Entri tanpa userId/status valid dibuang; tidak ada yang tersisa.
    expect(broken!.statuses).toEqual([]);
  });
});
