// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Penanda AUTO-DELETE.
 *
 * Gejala yang dilaporkan: timer hitung-mundur muncul di SETIAP pesan 1:1
 * walaupun pengirim tidak pernah memilih auto-delete. Penyebabnya `expiresAt`
 * selalu terisi di jalur 1:1 (TTL store-and-forward server 14 hari, lalu
 * disingkat jadi 24 jam begitu pesan di-READ), jadi "ada expiresAt" bukan bukti
 * pesan menghapus diri.
 *
 * Perbaikannya: pengirim menandai pilihannya di dalam ciphertext (`autoDelete`),
 * penerima mengambilnya saat dekripsi, dan vault menyimpannya ter-seal supaya
 * tidak hilang saat berpindah percakapan / reload.
 *
 * Kontrak yang dikunci:
 *   1. `captureAutoDelete` menerima `true` (boolean dari JSON) dan `'true'`
 *      (representasi string), lalu WAJIB menghapus field-nya dari `parsed`
 *      (field tersisa merusak collapse payload teks → bubble JSON mentah).
 *   2. Vault menyimpan penanda TER-SEAL; baris lama tanpa kolom = bukan
 *      auto-delete.
 *   3. Salinan yang tidak membawa penanda (server / tombstone parsial)
 *      mempertahankan nilai lama, bukan menghapusnya.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureAutoDelete } from '../messagePipeline';

describe('captureAutoDelete', () => {
  it('menyalin penanda boolean lalu menghapus field dari parsed', () => {
    const parsed: Record<string, unknown> = { text: 'halo', autoDelete: true };
    const target: { autoDelete?: boolean } = {};
    captureAutoDelete(parsed, target);
    expect(target.autoDelete).toBe(true);
    expect('autoDelete' in parsed).toBe(false);
  });

  it('menerima representasi string "true"', () => {
    const target: { autoDelete?: boolean } = {};
    captureAutoDelete({ autoDelete: 'true' }, target);
    expect(target.autoDelete).toBe(true);
  });

  it('mengabaikan nilai lain tapi tetap menghapus field', () => {
    const parsed: Record<string, unknown> = { autoDelete: false };
    const target: { autoDelete?: boolean } = {};
    captureAutoDelete(parsed, target);
    expect(target.autoDelete).toBeUndefined();
    expect('autoDelete' in parsed).toBe(false);
  });

  it('menjaga collapse payload teks tetap bekerja setelah field dibuang', () => {
    const parsed: Record<string, unknown> = { text: 'halo', autoDelete: true };
    const target: { autoDelete?: boolean } = {};
    delete parsed.profileKey;
    captureAutoDelete(parsed, target);
    expect(Object.keys(parsed).length).toBe(1);
    expect(String(parsed.text)).toBe('halo');
  });
});

// ---------------------------------------------------------------------------
// Persistensi vault
// ---------------------------------------------------------------------------

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

// `vi.hoisted` wajib di sini: file ini juga meng-import `messagePipeline`
// secara statis, sehingga modul di-evaluasi SEBELUM baris `const` di bawah —
// mock factory yang menutup variabel top-level akan meledak seperti
// "Cannot access 'db' before initialization".
const { fakeMessages, db } = vi.hoisted(() => {
  const table = makeMessagesTable();
  return { fakeMessages: table, db: { messages: table } };
});

vi.mock('@lib/db', () => ({ db }));

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

describe('ShadowVault — persistensi penanda auto-delete (BUGFIX 2026-10-18)', () => {
  it('menyimpan penanda ter-seal dan mengembalikannya sebagai true', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { autoDelete: true }) as never]);

    const raw = String(fakeMessages._rows.get('m1')?.autoDelete ?? '');
    expect(raw.startsWith('ENC1:')).toBe(true);
    expect(raw).not.toBe('true');

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.autoDelete).toBe(true);
  });

  it('baris lama tanpa kolom = bukan auto-delete', async () => {
    fakeMessages._rows.set('m-legacy', {
      id: 'm-legacy',
      conversationId: 'c1',
      content: null,
      createdAt: '2026-10-08T09:00:00.000Z',
      senderId: 'u2',
      isDeletedLocal: true,
    });
    await shadowVault.normalizeOrderIndex();

    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    const legacy = restored.find((m) => m.id === 'm-legacy');
    expect(legacy).toBeTruthy();
    expect(legacy!.autoDelete).toBe(false);
  });

  it('update tanpa penanda mempertahankan nilai yang sudah tersimpan', async () => {
    await shadowVault.upsertMessages([baseTombstone('m1', { autoDelete: true }) as never]);
    const firstRaw = fakeMessages._rows.get('m1')?.autoDelete;

    await shadowVault.upsertMessages([baseTombstone('m1') as never]);

    expect(fakeMessages._rows.get('m1')?.autoDelete).toBe(firstRaw);
    const restored = await shadowVault.getMessagesByConversation('c1', 50);
    expect(restored[0]!.autoDelete).toBe(true);
  });
});
