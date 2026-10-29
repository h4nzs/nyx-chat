/**
 * [docs/40] Arsip riwayat perangkat hasil link.
 *
 * Yang dikunci di sini:
 *   1. Arsip membawa objek DOMAIN (kontak + percakapan hasil pembaca yang
 *      mendekripsi), bukan baris Dexie — itulah yang membuat riwayat bisa
 *      dibaca identitas baru.
 *   2. Setiap chunk membawa penanda `k: 'history'` sehingga arsip ini TIDAK
 *      mungkin direstore sebagai `.nyxbak` (dan sebaliknya).
 *   3. Impor menulis lewat penulis yang disuntik (produksi: penulis domain yang
 *      menyegel ulang dengan kunci identitas baru).
 *
 * Database & transport di-stub; kripto arsip NYATA (libsodium + AEAD + frame)
 * supaya yang diuji adalah byte sungguhan, bukan tiruan.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ContactRecord, Conversation } from '@nyx/shared';

vi.mock('../contactStore', () => ({
  getAllContacts: async () => [
    {
      userId: 'peer-a',
      conversationId: 'conv-a',
      encryptedProfile: null,
      publicKey: 'pk-a',
      firstSeenAt: 1,
      lastSeenAt: 2,
      blocked: false,
    },
  ],
  saveContactRecord: vi.fn(),
  pushContactBundle: vi.fn(),
}));

// [docs/40 §40.7] Pesan dibaca lewat `decodeMessageRecord` (yang diuji terpisah
// di `linkHistoryMessages.test.ts`); di sini mock-nya hanya perlu bentuk
// `Message` yang sah, termasuk `seq` yang harus bertahan.
const HISTORY_MESSAGES = Array.from({ length: 5 }, (_, i) => ({
  id: `msg-${i}`,
  conversationId: 'conv-a',
  content: `pesan ${i}`,
  senderId: 'peer-a',
  sender: { id: 'peer-a', name: 'Peer' },
  createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  status: 'SENT',
  seq: 100 + i,
}));

vi.mock('../shadowVaultDb', () => ({
  shadowVault: {
    getAllConversations: async () => [
      {
        id: 'conv-a',
        isGroup: false,
        participants: [{ id: 'peer-a' }],
        lastMessageAt: null,
        unreadCount: 0,
        encryptionMode: 'SENDER_KEY',
        lastMessage: null,
      },
    ],
    getMessagesForExport: async () => HISTORY_MESSAGES,
    saveConversation: vi.fn(),
    upsertMessages: vi.fn(),
  },
}));

// Transport tidak dipakai di tes ini; `digestArchive` dibuat nyata agar ukuran
// hash yang diuji sama dengan produksi.
vi.mock('../linkHistoryClient', async () => {
  const mod = await import('libsodium-wrappers');
  const sodium = (mod as unknown as { default?: typeof mod }).default ?? mod;
  await sodium.ready;
  return {
    digestArchive: async (bytes: Uint8Array) =>
      sodium.to_hex(sodium.crypto_generichash(32, bytes)),
    generateArchiveKey: async () => sodium.randombytes_buf(32),
    // [docs/40 §40.7 langkah 8] Kuota dibaca sebelum unggah; default "cukup".
    getHistoryLimits: vi.fn(async () => ({ maxBytes: 500 * 1024 * 1024, verified: true })),
    markHistoryReady: vi.fn(),
    presignHistoryUpload: vi.fn(),
    sealArchiveKey: vi.fn(),
    uploadHistoryArchive: vi.fn(async () => {}),
    abortHistoryUpload: vi.fn(async () => {}),
    getHistoryStatus: vi.fn(),
    requestHistoryDownload: vi.fn(),
    fetchHistoryArchive: vi.fn(),
    openArchiveKey: vi.fn(),
    consumeHistoryArchive: vi.fn(),
  };
});

import {
  libsodiumBackupCrypto,
  parseBackupArchive,
  type BackupCryptoBackend,
} from '../backupFormat';
import {
  libsodiumBackupValueCodec,
  readBackupChunk,
  type BackupValueCodec,
} from '../backupPayload';
import { createFramedBackup, restoreFramedBackup, type BackupStore } from '../backupRestore';
import { getSodium } from '../sodiumInitializer';
import {
  HISTORY_MARKER,
  HistoryArchiveTooLargeError,
  countHistoryRecords,
  createHistoryArchive,
  parseHistoryTooLarge,
  readHistoryTables,
  sendHistoryArchive,
} from '../linkHistoryExport';
import { importHistoryArchive } from '../linkHistoryImport';
import {
  abortHistoryUpload,
  getHistoryLimits,
  presignHistoryUpload,
  uploadHistoryArchive,
} from '../linkHistoryClient';

async function adapters(): Promise<{ crypto: BackupCryptoBackend; codec: BackupValueCodec }> {
  const sodium = await getSodium();
  return {
    crypto: libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]),
    codec: libsodiumBackupValueCodec(
      sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]
    ),
  };
}

function memoryStore(tables: Record<string, unknown[]>): BackupStore {
  return {
    readTables: async () => tables,
    writeTables: async () => {
      throw new Error('writeTables tidak boleh dipanggil di tes ini');
    },
  };
}

describe('arsip riwayat: ekspor', () => {
  it('membaca objek domain, bukan baris Dexie', async () => {
    const tables = await readHistoryTables();
    expect(tables.contacts).toHaveLength(1);
    expect(tables.contacts[0]!.userId).toBe('peer-a');
    expect(tables.conversations).toHaveLength(1);
    expect(tables.conversations[0]!.id).toBe('conv-a');
    expect(tables.messages).toHaveLength(5);
    expect(tables.messages[0]!.seq).toBe(100);
    expect(countHistoryRecords(tables)).toBe(7);
  });

  it('setiap chunk membawa penanda history dan tabel yang diharapkan', async () => {
    const sodium = await getSodium();
    const { crypto, codec } = await adapters();
    const key = sodium.randombytes_buf(32);
    const tables = await readHistoryTables();

    const report = await createHistoryArchive({ key, tables });
    expect(report.records).toBe(7);
    expect(report.size).toBeGreaterThan(0);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);

    const { frames } = parseBackupArchive(report.bytes, key, crypto);
    const chunks = frames.map((frame) => readBackupChunk(frame, codec));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.k).toBe(HISTORY_MARKER);
    }
    expect([...new Set(chunks.map((c) => c.table))].sort()).toEqual([
      'contacts',
      'conversations',
      'messages',
    ]);
  });
});

describe('arsip riwayat: impor', () => {
  it('mengembalikan catatan per tabel lewat penulis yang disuntik', async () => {
    const sodium = await getSodium();
    const key = sodium.randombytes_buf(32);
    const tables = await readHistoryTables();
    const archive = await createHistoryArchive({ key, tables });

    const written: {
      contacts: ContactRecord[];
      conversations: Conversation[];
      messages: { id: string; seq?: number }[];
    } = { contacts: [], conversations: [], messages: [] };
    const report = await importHistoryArchive({
      bytes: archive.bytes,
      key,
      writers: {
        contacts: async (rows) => {
          written.contacts.push(...rows);
        },
        conversations: async (rows) => {
          written.conversations.push(...rows);
        },
        messages: async (rows) => {
          written.messages.push(...rows);
        },
      },
    });

    expect(report.records).toBe(7);
    expect(report.messages).toBe(5);
    expect(report.tables).toEqual({ contacts: 1, conversations: 1, messages: 5 });
    expect(written.contacts[0]!.userId).toBe('peer-a');
    expect(written.conversations[0]!.id).toBe('conv-a');
    // `seq` ikut supaya kursor paginasi server tetap presisi.
    expect(written.messages.map((m) => m.seq)).toEqual([100, 101, 102, 103, 104]);
  });

  it('menulis pesan per batch dan melaporkan progres', async () => {
    const sodium = await getSodium();
    const key = sodium.randombytes_buf(32);
    const tables = await readHistoryTables();
    const archive = await createHistoryArchive({ key, tables });

    const batches: number[] = [];
    const progress: { frame: number; totalFrames: number; messages: number }[] = [];
    const report = await importHistoryArchive({
      bytes: archive.bytes,
      key,
      batchSize: 2,
      writers: {
        contacts: async () => {},
        conversations: async () => {},
        messages: async (rows) => {
          batches.push(rows.length);
        },
      },
      onProgress: (p) => progress.push(p),
    });

    expect(batches).toEqual([2, 2, 1]);
    expect(report.messages).toBe(5);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.totalFrames === progress[0]!.totalFrames)).toBe(true);
    expect(progress[progress.length - 1]!.messages).toBe(5);
  });

  it('menolak arsip tanpa penanda (.nyxbak biasa)', async () => {
    const { crypto, codec } = await adapters();
    const sodium = await getSodium();
    const key = sodium.randombytes_buf(32);

    const plain = await createFramedBackup({
      store: memoryStore({ contacts: [{ userId: 'peer-a' }] }),
      key,
      crypto,
      codec,
      tables: ['contacts'],
    });

    await expect(importHistoryArchive({ bytes: plain.bytes, key })).rejects.toThrow(
      'HISTORY_MARKER_MISSING'
    );
  });

  it('menolak tabel di luar proyeksi riwayat walau penandanya benar', async () => {
    const { crypto, codec } = await adapters();
    const sodium = await getSodium();
    const key = sodium.randombytes_buf(32);

    const foreign = await createFramedBackup({
      store: memoryStore({ kvStore: [{ key: 'theme', value: 'dark' }] }),
      key,
      crypto,
      codec,
      tables: ['kvStore'],
      marker: HISTORY_MARKER,
    });

    await expect(importHistoryArchive({ bytes: foreign.bytes, key })).rejects.toThrow(
      /HISTORY_TABLE_UNKNOWN:kvStore/
    );
  });
});

describe('arsip riwayat: kuota', () => {
  it('membatalkan unggah sebelum presign bila arsip melebihi kuota', async () => {
    vi.mocked(getHistoryLimits).mockResolvedValueOnce({ maxBytes: 64, verified: false });

    await expect(
      sendHistoryArchive({ deviceId: 'device-quota', pqPublicKeyB64: 'pk' })
    ).rejects.toThrow(/^HISTORY_TOO_LARGE:/);

    // Intent dibersihkan supaya perangkat baru tidak menunggu 60 detik, dan
    // tidak ada byte yang dikirim ke R2.
    expect(abortHistoryUpload).toHaveBeenCalledWith('device-quota');
    expect(presignHistoryUpload).not.toHaveBeenCalled();
    expect(uploadHistoryArchive).not.toHaveBeenCalled();
  });

  it('parseHistoryTooLarge hanya mengenali error kuota dan mengembalikan angkanya', () => {
    expect(parseHistoryTooLarge(new HistoryArchiveTooLargeError(640 * 1024 * 1024, 500 * 1024 * 1024))).toEqual({
      size: 640 * 1024 * 1024,
      limit: 500 * 1024 * 1024,
    });
    expect(parseHistoryTooLarge(new Error('offline'))).toBeNull();
    expect(parseHistoryTooLarge(null)).toBeNull();
  });
});

describe('pagar dua arah: arsip riwayat ≠ .nyxbak', () => {
  it('restore .nyxbak menolak arsip riwayat sebelum menulis apa pun', async () => {
    const { crypto, codec } = await adapters();
    const sodium = await getSodium();
    const key = sodium.randombytes_buf(32);
    const tables = await readHistoryTables();
    const archive = await createHistoryArchive({ key, tables });

    const writeTables = vi.fn(async () => {});
    await expect(
      restoreFramedBackup({
        store: { readTables: async () => ({}), writeTables },
        bytes: archive.bytes,
        key,
        crypto,
        codec,
      })
    ).rejects.toThrow(/arsip riwayat perangkat/);
    expect(writeTables).not.toHaveBeenCalled();
  });
});
