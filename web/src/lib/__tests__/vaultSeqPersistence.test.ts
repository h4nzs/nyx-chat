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

  // [docs/30 WS-F] Query di-scope ke kunci yang diminta — meniru indeks Dexie
  // (`conversationId` dan `[conversationId+orderBucketMs]`). Sebelumnya fake ini
  // mengembalikan SELURUH tabel untuk `equals()` apa pun; itu tidak lagi setara
  // dengan skema sekarang (pembaca berpaginasi berjalan per bucket, sehingga
  // baris yang sama akan ikut terbawa berulang).
  const selected = (selector: string, arg: unknown): Record<string, unknown>[] => {
    const all = [...rows.values()];
    if (selector === '[conversationId+orderBucketMs]') {
      const [convId, bucket] = arg as [string, unknown];
      const owned = all.filter((r) => r.conversationId === convId && typeof r.orderBucketMs === 'number');
      // Perhatikan: `Dexie.minKey`/`maxKey` adalah `-Infinity`/`Infinity`, jadi
      // batas non-finite berarti rentang penuh (dipakai pencarian bucket terbaru),
      // bukan pencocokan bucket.
      if (typeof bucket === 'number' && Number.isFinite(bucket)) {
        return owned.filter((r) => r.orderBucketMs === bucket);
      }
      // Rentang penuh (minKey..maxKey) + `.reverse()` → bucket menurun.
      return owned.sort((a, b) => (b.orderBucketMs as number) - (a.orderBucketMs as number));
    }
    return all.filter((r) => r.conversationId === arg);
  };

  const queried = (list: Record<string, unknown>[]) => {
    let filterFn: ((r: Record<string, unknown>) => boolean) | undefined;
    let limitCount: number | null = null;
    const api: Record<string, unknown> = {
      between: (_lower: unknown, _upper: unknown) => api,
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

// [docs/29 §5.5] `seq` kini disimpan sebagai envelope `ENC1:` (masterSeed-bound).
// Keychain nyata butuh sesi ter-unlock + crypto worker → di-stub dengan bentuk
// yang sama (prefix + base64), supaya kontrak yang diuji tetap round-trip
// tulis→baca dan bentuk baris mentahnya (bukan plaintext angka).
vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

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

    // Kontrak §5.5: baris mentah TER-SEAL, bukan angka plaintext.
    const rawSeq = fakeMessages._rows.get('m1')?.seq;
    expect(typeof rawSeq).toBe('string');
    expect(String(rawSeq).startsWith('ENC1:')).toBe(true);
    expect(String(rawSeq)).not.toContain('7');

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe('m1');
    expect(restored[0]!.seq).toBe(7);
  });

  it('mempertahankan seq lama saat update berikutnya tidak membawa seq', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { seq: 7 }) as never]);
    const firstRaw = fakeMessages._rows.get('m1')?.seq;
    // Update tanpa seq (mis. tombstone dari unsend) → seq lama dipertahankan.
    await shadowVault.upsertMessages([baseTombstone('m1') as never]);

    expect(fakeMessages._rows.get('m1')?.seq).toBe(firstRaw); // tidak ditulis ulang
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

  it('seq > 0 dari record mentah dipulihkan — envelope baru DAN baris lama plaintext', async () => {
    // Baris lama (sebelum docs/29 §5.5): angka plaintext harus tetap terbaca.
    fakeMessages._rows.set('m9', {
      id: 'm9',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:00:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
      seq: 42,
    });
    // Baris baru: envelope ENC1.
    fakeMessages._rows.set('m10', {
      id: 'm10',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:30:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
      seq: 'ENC1:' + Buffer.from('43', 'utf8').toString('base64'),
    });

    // [docs/30 WS-F] Baris yang dimasukkan langsung (bypass writer) belum punya
    // `orderBucketMs`, jadi ia tidak ada di indeks `[conversationId+orderBucketMs]`
    // dan tidak akan pernah muncul di query berpaginasi. Di produksi kolom itu
    // diisi migrasi Dexie v9 saat DB dibuka; di sini jalur perbaikannya dipanggil
    // eksplisit (juga dipakai setelah restore `.nyxbak`).
    await expect(shadowVault.normalizeOrderIndex()).resolves.toBe(2);

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored.find((m) => m.id === 'm9')?.seq).toBe(42);
    expect(restored.find((m) => m.id === 'm10')?.seq).toBe(43);
  });
});
