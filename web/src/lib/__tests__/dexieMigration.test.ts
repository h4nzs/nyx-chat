// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F] Verifikasi MIGRASI Dexie yang sesungguhnya — IndexedDB nyata
 * (via `fake-indexeddb`), Dexie nyata, pembaca/writer vault nyata; hanya crypto
 * at-rest & worker yang di-stub.
 *
 * Ini menutup celah yang tidak bisa dijangkau test tabel-palsu: apakah upgrade
 * v1→v9 benar-benar mengisi `orderBucketMs` pada baris lama, apakah IndexedDB
 * mengisi indeks `[conversationId+orderBucketMs]` setelah versionchange, apakah
 * range-scan bucket bekerja, dan apakah indeks yang dilepas di v10 benar-benar
 * hilang. Masih BUKAN pengganti E2E browser (UI scroll-back, WebTransport).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Dexie from 'dexie';

// ─── Stub crypto (mirror bentuk nyata: prefix `ENC1:` + base64) ──────────────
vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) =>
    'ENC1:' + Buffer.from(value, 'utf8').toString('base64')
  ),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    crypto_generichash: () => new Uint8Array(32),
    to_base64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  })),
}));
vi.mock('@utils/crypto', () => ({
  getMyEncryptionKeyPair: vi.fn(async () => ({ privateKey: new Uint8Array(32) })),
}));
vi.mock('@lib/crypto-worker-proxy', () => ({
  workerXChaChaSeal: vi.fn(async (_key: string, text: string) =>
    'VAULT:' + Buffer.from(text, 'utf8').toString('base64')
  ),
  workerXChaChaOpen: vi.fn(async (_key: string, encrypted: string) =>
    encrypted.startsWith('VAULT:') ? Buffer.from(encrypted.slice(6), 'base64').toString('utf8') : null
  ),
}));

const MIN = 60 * 1000;
const BUCKET = 15 * MIN;
const B0 = Math.floor(Date.now() / BUCKET) * BUCKET - 6 * BUCKET;
const DB_NAME = 'NyxUnifiedDB';

/** Skema versi 1 apa adanya dari `db.ts` (harus identik agar upgrade cocok). */
const V1_STORES = {
  messages: 'id, conversationId, [conversationId+createdAt], senderId, isDeletedLocal',
  storyKeys: 'storyId',
  offlineQueue: 'tempId, timestamp',
  kvStore: 'key',
  sessionKeys: 'storageKey, conversationId',
  groupKeys: 'conversationId',
  preKeys: 'keyId',
  identityKeys: 'userId',
  ratchetSessions: 'conversationId',
  groupSenderStates: 'conversationId',
  groupReceiverStates: 'id',
  skippedKeys: 'headerKey',
  messageKeys: 'messageId',
  pendingHeaders: 'conversationId',
  groupSkippedKeys: 'key',
};

type LegacyRow = {
  id: string;
  conversationId: string;
  content: string | null;
  createdAt: string;
  senderId: string;
  isDeletedLocal?: boolean;
  isViewOnce?: boolean;
  expiresAt?: string | null;
  seq?: number;
};

const legacyRows: LegacyRow[] = [
  // Dua percakapan, tiga bucket, termasuk dua pesan dalam bucket yang sama.
  { id: 'a1', conversationId: 'c1', content: null, createdAt: new Date(B0).toISOString(), senderId: 'u1', isDeletedLocal: true },
  { id: 'a2', conversationId: 'c1', content: null, createdAt: new Date(B0 + 5 * MIN).toISOString(), senderId: 'u2', isDeletedLocal: true, seq: 7 },
  { id: 'a3', conversationId: 'c1', content: null, createdAt: new Date(B0 + BUCKET).toISOString(), senderId: 'u1', isDeletedLocal: true },
  { id: 'b1', conversationId: 'c2', content: null, createdAt: new Date(B0).toISOString(), senderId: 'u3', isDeletedLocal: true },
];

import { openLocalNumber } from '../localAtRest';

let NyxDatabase: typeof import('../db')['NyxDatabase'];
let shadowVault: typeof import('../shadowVaultDb')['shadowVault'];
let dbInstance: InstanceType<typeof import('../db')['NyxDatabase']>;

beforeAll(async () => {
  // 1. Bangun DB "klien lama": versi 1, hanya punya indeks plaintext lama.
  const legacy = new Dexie(DB_NAME);
  legacy.version(1).stores(V1_STORES);
  await legacy.table('messages').bulkPut(legacyRows);
  legacy.close();

  // 2. Buka lewat skema aplikasi → Dexie menjalankan upgrade v2..v10.
  ({ NyxDatabase } = await import('../db'));
  ({ shadowVault } = await import('../shadowVaultDb'));
  dbInstance = new NyxDatabase();
  await dbInstance.open();
});

afterAll(async () => {
  try {
    dbInstance?.close();
  } catch {
    /* sudah tertutup */
  }
  await Dexie.delete(DB_NAME);
});

describe('Dexie v9 — migrasi bucket pada baris lama', () => {
  it('mengisi orderBucketMs untuk SEMUA baris lama yang tidak punya bucket', async () => {
    const rows = await dbInstance.messages.toArray();
    expect(rows).toHaveLength(legacyRows.length);
    for (const row of rows) {
      const expected = new Date(String(row.createdAt)).getTime();
      expect(typeof row.orderBucketMs).toBe('number');
      expect(row.orderBucketMs).toBe(Math.floor(expected / BUCKET) * BUCKET);
    }
  });

  it('lapis presisi baris lama TIDAK disentuh saat upgrade (masterSeed belum ada)', async () => {
    const row = await dbInstance.messages.get('a2');
    expect(row?.createdAtSealed).toBeUndefined();
    // `seq` juga masih plaintext — di-seal barusan saat baris ditulis ulang.
    expect(row?.seq).toBe(7);
  });

  it('indeks [conversationId+orderBucketMs] benar-benar terisi dan bisa di-range-scan', async () => {
    const rows = await dbInstance.messages
      .where('[conversationId+orderBucketMs]')
      .equals(['c1', B0])
      .toArray();
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);

    // Pencarian bucket terbaru (halaman pertama) lewat range + reverse + limit.
    const newest = await dbInstance.messages
      .where('[conversationId+orderBucketMs]')
      .between(['c1', Dexie.minKey], ['c1', Dexie.maxKey])
      .reverse()
      .limit(1)
      .toArray();
    expect(newest).toHaveLength(1);
    expect(newest[0]!.orderBucketMs).toBe(B0 + BUCKET);
  });
});

describe('Dexie v10 — indeks kolom struktur dilepas', () => {
  it('messages tidak lagi diindeks pada senderId / isDeletedLocal', () => {
    // Dexie menyimpan keyPath indeks gabungan sebagai array, indeks tunggal
    // sebagai string — dinormalkan dulu supaya asersinya eksplisit.
    const indexed = dbInstance.messages.schema.indexes.map((index) =>
      Array.isArray(index.keyPath) ? index.keyPath.join('+') : String(index.keyPath)
    );
    expect(indexed).toContain('conversationId+orderBucketMs');
    expect(indexed).not.toContain('senderId');
    expect(indexed).not.toContain('isDeletedLocal');
  });

  it('conversations tidak lagi diindeks pada isGroup', () => {
    const indexed = dbInstance.conversations.schema.indexes.map((index) =>
      Array.isArray(index.keyPath) ? index.keyPath.join('+') : String(index.keyPath)
    );
    expect(indexed).not.toContain('isGroup');
  });
});

describe('pembaca vault di atas IndexedDB nyata', () => {
  it('halaman pertama = pesan terbaru, urut lama→baru (baris legacy plaintext)', async () => {
    const page = await shadowVault.getMessagesByConversation('c1', 2);
    expect(page.map((m) => m.id)).toEqual(['a2', 'a3']);
  });

  it('fetch-older dengan kursor tidak melewatkan bucket batas', async () => {
    const page = await shadowVault.getMessagesByConversation(
      'c1',
      2,
      new Date(B0 + 5 * MIN).toISOString()
    );
    expect(page.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('menulis pesan baru → kolom struktur ter-seal, indeks bucket terisi', async () => {
    const freshAt = B0 + 2 * BUCKET + 3 * MIN;
    await shadowVault.upsertMessages([
      {
        id: 'fresh1',
        conversationId: 'c1',
        content: 'halo',
        createdAt: new Date(freshAt).toISOString(),
        senderId: 'u9',
        isDeletedLocal: false,
      } as never,
    ]);

    const raw = await dbInstance.messages.get('fresh1');
    expect(typeof raw?.orderBucketMs).toBe('number');
    expect(String(raw?.senderId).startsWith('ENC1:')).toBe(true);
    expect(raw?.createdAt).toBeNull(); // plaintext dilepas setelah ter-seal
    expect(String(raw?.content).startsWith('VAULT:')).toBe(true);

    // Muncul di halaman pertama meski bucket-nya beda dari bucket `now`
    // (regresi: halaman pertama tidak boleh mulai dari `now`).
    const page = await shadowVault.getMessagesByConversation('c1', 1);
    expect(page.map((m) => m.id)).toEqual(['fresh1']);
    expect(page[0]!.senderId).toBe('u9');
    expect(page[0]!.content).toBe('halo');
    expect(page[0]!.createdAt).toBe(new Date(freshAt).toISOString());
  });

  it('migrateAtRestSealing menyegel baris lama di IndexedDB nyata (idempoten)', async () => {
    const first = await shadowVault.migrateAtRestSealing();
    expect(first).toBeGreaterThanOrEqual(legacyRows.length);

    const sealed = (v: unknown) => typeof v === 'string' && v.startsWith('ENC1:');
    const a2 = await dbInstance.messages.get('a2');
    expect(sealed(a2?.senderId)).toBe(true);
    expect(sealed(a2?.isDeletedLocal)).toBe(true);
    expect(sealed(a2?.seq)).toBe(true);
    expect(sealed(a2?.createdAtSealed)).toBe(true);
    expect(a2?.orderBucketMs).toBe(B0);

    // Jalan kedua: tidak ada yang perlu ditulis ulang lagi.
    await expect(shadowVault.migrateAtRestSealing()).resolves.toBe(0);

    // Dan barisnya tetap terbaca normal bagi pembaca vault.
    const page = await shadowVault.getMessagesByConversation('c1', 10);
    const a2Read = page.find((m) => m.id === 'a2');
    expect(a2Read?.senderId).toBe('u2');
    expect(a2Read?.isDeletedLocal).toBe(true);
    expect(a2Read?.seq).toBe(7);
  });

  it('migrateAtRestSealing menyegel kolom waktu contacts/profileCache (IndexedDB nyata, idempoten)', async () => {
    const legacyAt = B0 + 7 * MIN;
    await dbInstance.contacts.put({
      userId: 'peer-legacy-time' as never,
      data: 'ENC1:' + Buffer.from(JSON.stringify({ userId: 'peer-legacy-time' }), 'utf8').toString('base64'),
      updatedAt: legacyAt,
    });
    await dbInstance.profileCache.put({
      id: 'peer-cache' as never,
      name: 'Cache',
      avatarUrl: null,
      description: null,
      encryptedHash: 'ep',
      updatedAt: legacyAt,
    });

    await expect(shadowVault.migrateAtRestSealing()).resolves.toBeGreaterThan(0);

    const sealed = (v: unknown) => typeof v === 'string' && v.startsWith('ENC1:');
    const contact = await dbInstance.contacts.get('peer-legacy-time' as never);
    expect(sealed(contact?.updatedAt)).toBe(true);
    expect(String(contact?.updatedAt)).not.toContain(String(legacyAt));
    const profile = await dbInstance.profileCache.get('peer-cache' as never);
    expect(sealed(profile?.updatedAt)).toBe(true);

    // Nilai presisi tetap bisa dibaca (dipakai fallback firstSeenAt/lastSeenAt).
    expect(await openLocalNumber(contact?.updatedAt)).toBe(legacyAt);

    // Idempoten: jalan kedua tidak menulis ulang apa pun.
    await expect(shadowVault.migrateAtRestSealing()).resolves.toBe(0);
  });

  it('normalizeOrderIndex memperbaiki baris masuk-mentah (restore) di IndexedDB nyata', async () => {
    await dbInstance.messages.put({
      id: 'restored1',
      conversationId: 'c3',
      content: null,
      createdAt: new Date(B0).toISOString(),
      senderId: 'u_old',
      isDeletedLocal: true,
    } as never);

    // Sebelum perbaikan: baris tidak ada di indeks bucket → tak terlihat.
    await expect(shadowVault.getMessagesByConversation('c3', 10)).resolves.toHaveLength(0);

    await expect(shadowVault.normalizeOrderIndex()).resolves.toBeGreaterThan(0);
    const page = await shadowVault.getMessagesByConversation('c3', 10);
    expect(page.map((m) => m.id)).toEqual(['restored1']);
    expect(page[0]!.isDeletedLocal).toBe(true);
  });
});
