// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Reaksi harus ikut dipersist ke ShadowVault.
 *
 * Gejala yang dilaporkan: reaksi kecil di bubble hilang saat berpindah
 * percakapan dan setelah reload. Penyebabnya `upsertMessages` menulis daftar
 * kolom yang eksplisit dan `reactions` TIDAK ada di daftar itu (juga tidak ada
 * di `DecryptedMessageRecord`), jadi reaksi hanya hidup di memori:
 *   - `loadMessagesForConversation` langkah 1 (baca vault → replace store)
 *     menghapusnya saat percakapan dibuka kembali;
 *   - reload menghapusnya permanen kecuali pesan sinyal reaksi kebetulan
 *     ikut ter-fetch ulang dan masih bisa didekripsi.
 *
 * Kontrak yang dikunci di sini:
 *   1. Round-trip tulis→baca mempertahankan reaksi (id/emoji/userId/isMessage).
 *   2. Baris mentah TER-SEAL (`ENC1:`), bukan emoji/userId plaintext.
 *   3. Update yang TIDAK membawa `reactions` (salinan server, tombstone parsial)
 *      mempertahankan reaksi yang sudah tersimpan — bukan menghapusnya.
 *   4. `reactions: []` eksplisit = keadaan "dibersihkan" (unsend).
 *   5. Envelope rusak tidak membuat baris tak terbaca — reaksi di-drop saja.
 *
 * Semua pesan di sini tombstone (`isDeletedLocal`) sehingga tidak ada
 * pemanggilan crypto selain seal kolom reaksi.
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

const REACTION_USER = 'user-aaaa-1111';

const baseTombstone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId: 'c1',
  content: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  senderId: 'u1',
  isDeletedLocal: true,
  ...extra,
});

const sampleReaction = {
  id: 'react-1',
  emoji: '👍',
  userId: REACTION_USER,
  isMessage: true,
};

beforeEach(() => fakeMessages._rows.clear());

describe('ShadowVault — persistensi reaksi (BUGFIX 2026-10-18)', () => {
  it('menulis reaksi ke record dan mengembalikannya saat dibaca', async () => {
    await shadowVault.upsertMessages([
      baseTombstone('m1', { reactions: [sampleReaction] }) as never,
    ]);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.reactions).toEqual([sampleReaction]);
  });

  it('baris mentah TER-SEAL — emoji & userId tidak plaintext', async () => {
    await shadowVault.upsertMessages([
      baseTombstone('m1', { reactions: [sampleReaction] }) as never,
    ]);

    const raw = String(fakeMessages._rows.get('m1')?.reactions ?? '');
    expect(raw.startsWith('ENC1:')).toBe(true);
    expect(raw).not.toContain('👍');
    // Base64 standar tidak memuat '-' → userId bergaris hubung tidak mungkin
    // muncul verbatim bila benar-benar ter-seal.
    expect(raw).not.toContain(REACTION_USER);
  });

  it('update tanpa `reactions` mempertahankan reaksi yang sudah tersimpan', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { reactions: [sampleReaction] }) as never]);
    const firstRaw = fakeMessages._rows.get('m1')?.reactions;

    // Salinan server / tombstone parsial: tidak membawa field reactions.
    await shadowVault.upsertMessages([baseTombstone('m1') as never]);

    expect(fakeMessages._rows.get('m1')?.reactions).toBe(firstRaw);
    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.reactions).toEqual([sampleReaction]);
  });

  it('`reactions: []` eksplisit = dibersihkan (unsend) → tidak dihidupkan kembali', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { reactions: [sampleReaction] }) as never]);
    await shadowVault.upsertMessages([baseTombstone('m1', { reactions: [] }) as never]);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.reactions).toEqual([]);
  });

  it('envelope rusak hanya menghilangkan reaksi — baris tetap terbaca', async () => {
    fakeMessages._rows.set('m-broken', {
      id: 'm-broken',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:00:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
      reactions: 'ENC1:' + Buffer.from('{bukan json', 'utf8').toString('base64'),
    });
    await shadowVault.normalizeOrderIndex();

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored.find((m) => m.id === 'm-broken')).toBeTruthy();
    expect(restored[0]!.reactions).toBeUndefined();
  });
});
