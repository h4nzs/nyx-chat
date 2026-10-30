/**
 * [docs/40 §40.13 poin 2] Paginasi "muat pesan lama" SETELAH impor arsip riwayat.
 *
 * Pertanyaan yang dikunci di sini: perangkat baru mulai dari pesan tertua hasil
 * impor, lalu meminta halaman berikutnya ke server dengan `?before=<seq>`. Bila
 * kursor memakai pesan TERBARU (atau `createdAt` yang sudah dikasar ke bucket),
 * halaman berikutnya menduplikasi pesan atau melompati sebagian riwayat.
 *
 * Alur nyata yang direproduksi:
 *   1. perangkat lama → `createHistoryArchive` (kunci acak) → byte,
 *   2. perangkat baru → `importHistoryArchive` → baris `Message` hasil tulis,
 *   3. `olderPageCursor` memilih kursor dari pesan tertua hasil impor,
 *   4. halaman server diambil berulang sampai `hasMore=false`.
 *
 * Halaman server di sini menirukan kontrak `server/src/routes/messages.ts`
 * (filter `seq < before`, `orderBy seq desc`, ambil `take + 1` untuk `hasMore`,
 * `nextCursor` = seq pesan tertua di halaman). Kalau kontrak server berubah,
 * test ini harus ikut berubah — nilainya adalah menjaga invariant klien:
 * **tidak ada duplikat, tidak ada lompatan**.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../contactStore', () => ({
  getAllContacts: async () => [],
  saveContactRecord: vi.fn(),
  pushContactBundle: vi.fn(),
}));
vi.mock('../keychainDb', () => ({
  listCachedGroupParticipants: async () => [],
  saveCachedGroupParticipants: vi.fn(),
}));
vi.mock('../shadowVaultDb', () => ({
  shadowVault: {
    getAllConversations: async () => [],
    getMessagesForExport: async () => [],
    saveConversation: vi.fn(),
    upsertMessages: vi.fn(),
  },
}));
vi.mock('../linkHistoryClient', async () => {
  const mod = await import('libsodium-wrappers');
  const lib = (mod as unknown as { default?: typeof mod }).default ?? mod;
  await lib.ready;
  return {
    digestArchive: async (bytes: Uint8Array) => lib.to_hex(lib.crypto_generichash(32, bytes)),
    generateArchiveKey: async () => lib.randombytes_buf(32),
    getHistoryLimits: vi.fn(async () => ({ maxBytes: 500 * 1024 * 1024, verified: true })),
    markHistoryReady: vi.fn(),
    presignHistoryUpload: vi.fn(),
    sealArchiveKey: vi.fn(),
    uploadHistoryArchive: vi.fn(),
    abortHistoryUpload: vi.fn(),
    getHistoryStatus: vi.fn(),
    requestHistoryDownload: vi.fn(),
    fetchHistoryArchive: vi.fn(),
    openArchiveKey: vi.fn(),
    consumeHistoryArchive: vi.fn(),
  };
});

import { getSodium } from '../sodiumInitializer';
import { createHistoryArchive, type HistoryTables } from '../linkHistoryExport';
import { importHistoryArchive } from '../linkHistoryImport';
import { compareMessagesByOrder, olderPageCursor } from '@utils/messageOrder';
import type { Message } from '@store/conversation';

const CONV = 'conv-paging';
const IMPORTED_FROM = 900;
const IMPORTED_TO = 909;

/** Riwayat perangkat lama: 10 pesan terakhir yang tersimpan di arsip. */
function historyTables(): HistoryTables {
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  return {
    contacts: [],
    conversations: [],
    groupCachedParticipants: [],
    messages: Array.from({ length: IMPORTED_TO - IMPORTED_FROM + 1 }, (_, i) => ({
      id: `msg-${IMPORTED_FROM + i}`,
      conversationId: CONV,
      content: `lama ${IMPORTED_FROM + i}`,
      senderId: 'peer-a',
      sender: { id: 'peer-a', name: 'Peer A' },
      createdAt: new Date(base + (IMPORTED_FROM + i) * 1000).toISOString(),
      status: 'SENT',
      seq: IMPORTED_FROM + i,
    })) as Message[],
  };
}

type Paged = { items: { id: string; seq: number }[]; hasMore: boolean; nextCursor: string | null };

/**
 * Cermin query `GET /api/messages/:conversationId?before=<seq>&limit=<n>`.
 * `all` sudah termasuk baris yang diimpor (server menyimpan riwayat akun yang
 * sama — itu alasan `seq` tetap valid setelah link).
 */
function takePage(all: { id: string; seq: number }[], before: string | null, limit: number): Paged {
  const beforeSeq = before && /^\d+$/.test(before) ? Number(before) : Number.POSITIVE_INFINITY;
  const descending = all
    .filter((m) => m.seq < beforeSeq)
    .sort((a, b) => b.seq - a.seq);
  const page = descending.slice(0, limit);
  const hasMore = descending.length > limit;
  return {
    items: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]!.seq) : null,
  };
}

async function importBackToVault(): Promise<Message[]> {
  const sodium = await getSodium();
  const key = sodium.randombytes_buf(32);
  const archive = await createHistoryArchive({ key, tables: historyTables() });

  const imported: Message[] = [];
  await importHistoryArchive({
    bytes: archive.bytes,
    key,
    writers: {
      contacts: async () => {},
      conversations: async () => {},
      groupCachedParticipants: async () => {},
      messages: async (rows) => {
        imported.push(...rows);
      },
    },
  });
  // Urutan yang dipakai vault & UI (oldest → newest).
  return imported.sort(compareMessagesByOrder);
}

describe('paginasi setelah impor arsip riwayat', () => {
  it('kursor = seq pesan TERTUA hasil impor, bukan pesan terbaru', async () => {
    const local = await importBackToVault();

    expect(local).toHaveLength(IMPORTED_TO - IMPORTED_FROM + 1);
    expect(local[0]!.id).toBe(`msg-${IMPORTED_FROM}`);
    expect(olderPageCursor(local[0])).toBe(String(IMPORTED_FROM));
    // Regresi yang dijaga: memakai pesan terbaru mengunduh ulang seluruh
    // halaman impor dan menyisipkan duplikat.
    expect(olderPageCursor(local[local.length - 1])).not.toBe(String(IMPORTED_FROM));
  });

  it('halaman berikutnya menyambung tanpa duplikat dan tanpa lompatan', async () => {
    const local = await importBackToVault();
    const importedIds = new Set(local.map((m) => String(m.id)));

    // Server punya 60 pesan lebih lama (seq 840..899) di bawah riwayat impor.
    const serverRows = Array.from({ length: 60 }, (_, i) => ({
      id: `msg-${840 + i}`,
      seq: 840 + i,
    }));

    const seen: number[] = [];
    const fetchedIds = new Set<string>();
    let cursor = olderPageCursor(local[0]);
    let pages = 0;

    while (cursor && pages < 10) {
      const page = takePage(serverRows, cursor, 10);
      for (const item of page.items) {
        // Tidak ada baris server yang menduplikasi pesan hasil impor.
        expect(importedIds.has(String(item.id))).toBe(false);
        expect(fetchedIds.has(item.id)).toBe(false);
        fetchedIds.add(item.id);
        seen.push(item.seq);
      }
      pages += 1;
      // `nextCursor` null pada halaman terakhir — itulah kondisi berhenti.
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    // Enam halaman × 10 pesan, berhenti karena server tidak punya stok lagi.
    expect(pages).toBe(6);
    expect(cursor).toBeNull();

    // Tanpa lompatan: gabungan impor + hasil paginasi = 840..909 berurutan.
    const all = [...new Set([...local.map((m) => m.seq!), ...seen])].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 70 }, (_, i) => 840 + i));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('baris legacy tanpa seq memakai createdAt; tanpa keduanya tidak ada kursor', () => {
    expect(
      olderPageCursor({ createdAt: '2026-09-30T10:00:00.000Z' })
    ).toBe('2026-09-30T10:00:00.000Z');
    expect(
      olderPageCursor({ createdAt: new Date('2026-09-30T10:00:00.000Z') })
    ).toBe('2026-09-30T10:00:00.000Z');
    expect(olderPageCursor({ seq: 0 })).toBeNull();
    expect(olderPageCursor(undefined)).toBeNull();
  });
});
