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

import { LOCAL_TIME_BUCKET_MS, openLocalNumber } from '../localAtRest';
import { openOrderInstant } from '../localOrderKey';

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

// ─── Gate docs/30 §30.10 poin (1): inspeksi IndexedDB mentah ────────────────
//
// Gate-nya bukan "kolom X ter-seal" (itu diuji di atas), melainkan properti
// yang bisa dibaca penyerang yang memegang profil browser: apakah pola aktivitas
// (jam per pesan, grup/1:1, presisi waktu) terbaca dari baris MENTAH. Pemindai
// di bawah sengaja menolak granularitas apa pun yang lebih halus dari yang
// sudah diterima desain (bucket 15 menit — paritas server, docs/28 Tier 2 B3).

type RawRow = { table: string; key: unknown; value: unknown };

/** Kolom yang HARUS berupa envelope `ENC1:` (atau kosong) di baris mentah. */
const SEALED_FIELDS = new Set([
  'senderId',
  'sentAt',
  'seq',
  'expiresAt',
  'repliedToId',
  'updatedAt',
  'lastActivity',
  'keyVersion',
  'treeSize',
]);

/** Kolom boolean yang HARUS ter-seal (bukan `true`/`false`). */
const SEALED_FLAGS = new Set(['isGroup', 'isDeletedLocal', 'isViewOnce', 'isPinned', 'isArchived']);

const isSealedValue = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('ENC1:');

/** Rentang angka yang hanya masuk akal sebagai epoch-ms. */
const isEpochMs = (value: number): boolean => value > 1_000_000_000_000 && value < 10_000_000_000_000;

/**
 * Kumpulkan kebocoran aktivitas dari baris MENTAH (bukan dari objek domain).
 * Mengembalikan daftar deskripsi — kosong berarti tidak ada yang terbaca.
 */
function findActivityLeaks(rows: readonly RawRow[]): string[] {
  const leaks: string[] = [];

  const scan = (table: string, key: unknown, path: string, value: unknown): void => {
    const where = `${table}[${String(key)}].${path}`;

    if (typeof value === 'string') {
      const iso = value.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      if (iso) {
        const ms = Date.parse(iso[0]);
        if (!Number.isFinite(ms) || ms % LOCAL_TIME_BUCKET_MS !== 0) {
          leaks.push(`${where} = waktu presisi (${value})`);
        }
      }
      const field = path.split('.').pop() ?? '';
      if (SEALED_FIELDS.has(field) && !isSealedValue(value)) {
        leaks.push(`${where} = plaintext (${JSON.stringify(value).slice(0, 40)})`);
      }
      return;
    }

    if (typeof value === 'number') {
      const field = path.split('.').pop() ?? '';
      if (SEALED_FIELDS.has(field)) {
        leaks.push(`${where} = angka plaintext (${value})`);
      } else if (isEpochMs(value) && value % LOCAL_TIME_BUCKET_MS !== 0) {
        leaks.push(`${where} = epoch-ms presisi (${value})`);
      }
      return;
    }

    if (typeof value === 'boolean') {
      const field = path.split('.').pop() ?? '';
      if (SEALED_FLAGS.has(field)) leaks.push(`${where} = boolean plaintext (${value})`);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(table, key, `${path}[${i}]`, item));
      return;
    }

    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        scan(table, key, path ? `${path}.${childKey}` : childKey, childValue);
      }
    }
  };

  for (const row of rows) scan(row.table, row.key, '', row.value);
  return leaks;
}

/** Dump baris mentah dalam bentuk ter-redaksi (bahan inspeksi manual). */
function redactedDump(rows: readonly RawRow[]): string {
  const shape = (value: unknown): string => {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') {
      const colon = value.indexOf(':');
      return colon > 0 ? `${value.slice(0, colon + 1)}…(len ${value.length})` : `str(${value})`;
    }
    if (typeof value === 'number') {
      return value % LOCAL_TIME_BUCKET_MS === 0 && isEpochMs(value)
        ? `bucket@${new Date(value).toISOString()}`
        : `num(${value})`;
    }
    if (typeof value === 'boolean') return `bool(${value})`;
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${shape(v)}`)
        .join(', ')}}`;
    }
    return typeof value;
  };

  return rows.map((row) => `  ${row.table}[${String(row.key)}] ${shape(row.value)}`).join('\n');
}

async function readAllRawRows(): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  for (const table of dbInstance.tables) {
    for (const value of await table.toArray()) {
      rows.push({ table: table.name, key: (value as { id?: unknown }).id ?? '', value });
    }
  }
  return rows;
}

describe('gate docs/30 §30.10 (1) — pola aktivitas tidak terbaca dari IndexedDB', () => {
  // Aktivitas "nyata" buatan: dua percakapan (grup + 1:1) dan pesan tersebar di
  // dua hari, semuanya lewat jalur tulis produksi (bukan `put` mentah).
  const HARI_1 = B0 - 26 * 60 * MIN; // hari sebelumnya
  const freshMessages = [
    {
      id: 'act1',
      conversationId: 'grup-1',
      content: 'halo dunia',
      createdAt: new Date(HARI_1 + 7 * MIN + 321).toISOString(),
      senderId: 'u1',
      sentAt: HARI_1 + 7 * MIN + 321,
      seq: 11,
      isViewOnce: false,
    },
    {
      id: 'act2',
      conversationId: 'grup-1',
      content: 'halo dunia',
      createdAt: new Date(HARI_1 + 46 * MIN + 999).toISOString(),
      senderId: 'u2',
      sentAt: HARI_1 + 46 * MIN + 999,
      seq: 12,
      isDeletedLocal: true,
    },
    {
      id: 'act3',
      conversationId: 'satu-satu',
      content: 'rahasia proyek alpha',
      createdAt: new Date(B0 + 3 * MIN + 7).toISOString(),
      senderId: 'u1',
      sentAt: B0 + 3 * MIN + 7,
      seq: 13,
    },
  ];

  it('pemindai tidak buta: baris mentah yang bocor TERTANGKAP (kontrol negatif)', () => {
    const leaks = findActivityLeaks([
      {
        table: 'messages',
        key: 'bocor',
        value: {
          createdAt: '2026-10-11T10:07:43.512Z',
          orderBucketMs: B0,
          sentAt: B0 + 1234,
          senderId: 'u1',
          seq: 7,
        },
      },
      { table: 'conversations', key: 'grup', value: { isGroup: true } },
      { table: 'pqDrSessionsV2', key: 's1', value: { lastActivity: B0 + 4242 } },
    ]);

    // Waktu presisi, sentAt/seq/senderId plaintext, boolean grup, aktivitas sesi.
    expect(leaks.length).toBeGreaterThanOrEqual(5);
    expect(leaks.some((l) => l.includes('createdAt'))).toBe(true);
    expect(leaks.some((l) => l.includes('sentAt'))).toBe(true);
    expect(leaks.some((l) => l.includes('isGroup'))).toBe(true);
    expect(leaks.some((l) => l.includes('lastActivity'))).toBe(true);
    // …dan bucket yang sudah kasar TIDAK dilaporkan (tidak ada false positive).
    expect(leaks.some((l) => l.includes('orderBucketMs'))).toBe(false);
  });

  it('menulis aktivitas lewat jalur produksi', async () => {
    await shadowVault.saveConversation({
      id: 'grup-1',
      isGroup: true,
      participants: [{ id: 'u1', name: 'A' }],
      lastMessageAt: new Date(B0 + 3 * MIN + 7).toISOString(),
    } as never);
    await shadowVault.saveConversation({
      id: 'satu-satu',
      isGroup: false,
      participants: [{ id: 'u2', name: 'B' }],
      lastMessageAt: new Date(HARI_1).toISOString(),
    } as never);

    await shadowVault.upsertMessages(freshMessages as never);
    await shadowVault.savePqDrSession({
      conversationId: 'grup-1',
      peerDeviceId: 'dev-1',
      version: 1,
      negotiationStatus: 'ESTABLISHED',
      lastActivity: B0 + 11 * MIN + 13,
      state: { Ns: 0 } as never,
    } as never);

    // Migrasi unlock: baris yang belum tersentuh jalur tulis (legacy) ikut ditutup.
    await shadowVault.migrateAtRestSealing();
  });

  it('setelah jalur tulis + migrasi: tidak ada jam/tanggal presisi, tidak ada grup/1:1 terbaca', async () => {
    const rows = await readAllRawRows();
    expect(rows.length).toBeGreaterThan(0);

    const leaks = findActivityLeaks(rows);
    expect(leaks).toEqual([]);

    // Bukti positif (bukan cuma "pemindai bilang bersih"): kolom yang diuji
    // benar-benar ada dan bentuknya seperti yang dijanjikan.
    const rawMessages = rows
      .filter((r) => r.table === 'messages')
      .map((r) => r.value as Record<string, unknown>);
    const act1 = rawMessages.find((m) => m.id === 'act1')!;
    expect(typeof act1.orderBucketMs).toBe('number');
    expect(act1.orderBucketMs).toBe(Math.floor((HARI_1 + 7 * MIN + 321) / BUCKET) * BUCKET);
    expect(act1.createdAt).toBeNull();
    expect(String(act1.sentAt).startsWith('ENC1:')).toBe(true);
    expect(String(act1.senderId).startsWith('ENC1:')).toBe(true);
    expect(String(act1.isViewOnce).startsWith('ENC1:')).toBe(true);

    const rawConvs = rows
      .filter((r) => r.table === 'conversations')
      .map((r) => r.value as Record<string, unknown>);
    for (const conv of rawConvs) {
      expect(typeof conv.isGroup).not.toBe('boolean');
      const bucket = Date.parse(String(conv.lastMessageAt));
      expect(bucket % BUCKET).toBe(0);
    }

    const rawSessions = rows
      .filter((r) => r.table === 'pqDrSessionsV2')
      .map((r) => r.value as Record<string, unknown>);
    expect(rawSessions).toHaveLength(1);
    expect(String(rawSessions[0]!.lastActivity).startsWith('ENC1:')).toBe(true);

    // Presisi tetap dapat dipulihkan pembaca (seal ≠ hilang).
    const page = await shadowVault.getMessagesByConversation('grup-1', 10);
    const act1Read = page.find((m) => m.id === 'act1')!;
    expect(act1Read.sentAt).toBe(HARI_1 + 7 * MIN + 321);
    expect(act1Read.createdAt).toBe(new Date(HARI_1 + 7 * MIN + 321).toISOString());
    expect(act1Read.seq).toBe(11);

    // Dump ter-redaksi: bahan inspeksi manual yang bisa dibaca ulang di CI.
    console.log('inspeksi IndexedDB mentah (redacted):\n' + redactedDump(rows.slice(0, 12)));
  });

  it('sesi PQ-DR terbaru tetap terpilih walau `lastActivity` ter-seal', async () => {
    await shadowVault.savePqDrSession({
      conversationId: 'satu-satu',
      peerDeviceId: 'dev-lama',
      version: 1,
      negotiationStatus: 'ESTABLISHED',
      lastActivity: B0,
      state: { Ns: 1 } as never,
    } as never);
    await shadowVault.savePqDrSession({
      conversationId: 'satu-satu',
      peerDeviceId: 'dev-baru',
      version: 1,
      negotiationStatus: 'ESTABLISHED',
      lastActivity: B0 + 9 * MIN,
      state: { Ns: 2 } as never,
    } as never);

    const chosen = await shadowVault.getPqDrSession('satu-satu');
    expect(chosen?.peerDeviceId).toBe('dev-baru');
    expect(typeof chosen?.lastActivity).toBe('number');
    expect(chosen?.lastActivity).toBe(B0 + 9 * MIN);
  });
});

// ─── Gate docs/30 §30.10 poin (2): urutan pesan setelah reload & wipe ───────

describe('gate docs/30 §30.10 (2) — urutan tetap benar setelah reload & wipe', () => {
  const CONV = 'c1';

  it('urutan halaman identik setelah koneksi ditutup dan DB dibuka ulang', async () => {
    const before = (await shadowVault.getMessagesByConversation(CONV, 50)).map((m) => m.id);
    expect(before.length).toBeGreaterThan(1);

    dbInstance.close();
    dbInstance = new NyxDatabase();
    await dbInstance.open();

    const after = (await shadowVault.getMessagesByConversation(CONV, 50)).map((m) => m.id);
    expect(after).toEqual(before);
  });

  it('wipe (DB dihapus) + restore baris mentah arsip → indeks diperbaiki, urutan & presisi utuh', async () => {
    const archived = (await shadowVault.getMessagesByConversation(CONV, 50)).map((m) => ({ id: m.id, createdAt: m.createdAt }));
    expect(archived.length).toBeGreaterThan(1);

    // Arsip SQL snapshots: baris diambil APA ADANYA, lalu ditulis sebagai bentuk
    // klien pra-v9 (createdAt plaintext, tanpa bucket) — persis seperti restore
    // `.nyxbak`/impor JSON yang sudah ada.
    const snapshot = await dbInstance.messages.toArray();
    const legacyShape: Record<string, unknown>[] = [];
    for (const row of snapshot) {
      const instant = await openOrderInstant(row);
      legacyShape.push({
        id: row.id,
        conversationId: row.conversationId,
        content: row.content,
        senderId: row.senderId,
        isDeletedLocal: row.isDeletedLocal,
        isViewOnce: row.isViewOnce,
        seq: row.seq,
        sentAt: row.sentAt,
        createdAt: instant !== null ? new Date(instant).toISOString() : null,
      });
    }

    // Wipe: DB dihapus seluruhnya (profil bersih), lalu dibuka lagi kosong.
    dbInstance.close();
    await Dexie.delete(DB_NAME);
    dbInstance = new NyxDatabase();
    await dbInstance.open();

    // Restore menulis baris arsip mentah — tanpa bucket, jadi belum terlihat…
    await dbInstance.messages.bulkPut(legacyShape as never);
    await expect(shadowVault.getMessagesByConversation(CONV, 10)).resolves.toHaveLength(0);

    // …sampai perbaikan indeks berjalan (jalur restore yang sama dengan produksi).
    expect(await shadowVault.normalizeOrderIndex()).toBeGreaterThan(0);
    const restored = await shadowVault.getMessagesByConversation(CONV, 50);
    expect(restored.map((m) => m.id)).toEqual(archived.map((m) => m.id));
    for (const expected of archived) {
      expect(restored.find((m) => m.id === expected.id)?.createdAt).toBe(expected.createdAt);
    }
  });
});
