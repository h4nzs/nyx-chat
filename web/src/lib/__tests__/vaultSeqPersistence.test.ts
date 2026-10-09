// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B1 residual] `seq` harus ikut dipersist ke ShadowVault.
 *
 * Kenapa ini penting: kursor paginasi fetch-older ke SERVER memakai
 * `oldestMessage.seq`. Dulu `seq` tidak disimpan lokal, jadi setelah reload ia
 * hilang dan kursor jatuh ke jalur ISO-date legacy — yang bisa mengulang
 * sebagian halaman. Test ini mengunci round-trip tulis→baca.
 *
 * Semua pesan di sini adalah tombstone (`isDeletedLocal`) sehingga tidak ada
 * pemanggilan crypto — fokus test murni pada persistensi `seq`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMessagesTable() {
  const rows = new Map<string, Record<string, unknown>>();

  const queried = () => {
    let filterFn: ((r: Record<string, unknown>) => boolean) | undefined;
    const api: Record<string, unknown> = {
      between: () => api,
      reverse: () => api,
      filter: (fn: (r: Record<string, unknown>) => boolean) => {
        filterFn = fn;
        return api;
      },
      limit: () => api,
      toArray: async () => [...rows.values()].filter((r) => (filterFn ? filterFn(r) : true)),
      primaryKeys: async () => [...rows.keys()],
    };
    return api;
  };

  return {
    _rows: rows,
    get: async (id: string) => rows.get(id),
    bulkPut: async (items: Record<string, unknown>[]) => {
      for (const item of items) rows.set(item.id as string, item);
    },
    bulkDelete: async (ids: string[]) => {
      for (const id of ids) rows.delete(id);
    },
    where: () => {
      const api: Record<string, unknown> = {
        equals: () => queried(),
        between: () => queried(),
      };
      return api;
    },
  };
}

const fakeMessages = makeMessagesTable();
const db = { messages: fakeMessages };

vi.mock('@lib/db', () => ({ db }));

const { shadowVault } = await import('@lib/shadowVaultDb');

const baseTombstone = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId: 'c1',
  content: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  senderId: 'u1',
  isDeletedLocal: true,
  ...extra,
});

beforeEach(() => fakeMessages._rows.clear());

describe('ShadowVault — persistensi seq (B1)', () => {
  it('menulis seq ke record dan mengembalikannya saat dibaca', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { seq: 7 }) as never]);

    expect(fakeMessages._rows.get('m1')?.seq).toBe(7);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe('m1');
    expect(restored[0]!.seq).toBe(7);
  });

  it('mempertahankan seq lama saat update berikutnya tidak membawa seq', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { seq: 7 }) as never]);
    // Update tanpa seq (mis. tombstone dari unsend) → seq lama dipertahankan.
    await shadowVault.upsertMessages([baseTombstone('m1') as never]);

    expect(fakeMessages._rows.get('m1')?.seq).toBe(7);
    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.seq).toBe(7);
  });

  it('seq 0 / tidak ada tetap undefined (baris legacy & pesan pending)', async () => {
    await shadowVault.upsertMessages([
      baseTombstone('legacy', { seq: 0 }) as never,
      baseTombstone('pending') as never,
    ]);

    expect(fakeMessages._rows.get('legacy')?.seq).toBeUndefined();
    expect(fakeMessages._rows.get('pending')?.seq).toBeUndefined();

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    const byId = new Map<string, (typeof restored)[number]>(restored.map((m) => [String(m.id), m]));
    expect(byId.get('legacy')?.seq).toBeUndefined();
    expect(byId.get('pending')?.seq).toBeUndefined();
  });

  it('seq > 0 dari record mentah dipulihkan (jalur baca langsung)', async () => {
    fakeMessages._rows.set('m9', {
      id: 'm9',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:00:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
      seq: 42,
    });

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored.find((m) => m.id === 'm9')?.seq).toBe(42);
  });
});
