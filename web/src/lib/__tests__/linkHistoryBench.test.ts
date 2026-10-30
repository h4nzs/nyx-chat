/**
 * [docs/40 §40.12 fase 3] Runner harness benchmark arsip riwayat perangkat link.
 *
 * Selalu menjalankan benchmark kecil (200 pesan) sebagai uji integritas +
 * kewarasan harness. Benchmark 10k pesan hanya jalan bila `NYX_BENCH=1`:
 *
 *   NYX_BENCH=1 pnpm --filter nyx-web run bench:linkhistory
 *
 * Angka (waktu + puncak heap/rss) dicetak apa adanya; ambang gate ada di
 * `LINK_HISTORY_BENCH_BUDGET`. Penyegelan ulang + IndexedDB tidak diukur di sini
 * — lihat header `linkHistoryBench.ts`.
 *
 * Database & transport di-stub (sama seperti `linkHistory.test.ts`); yang diukur
 * adalah byte arsip sungguhan (libsodium + frame + AEAD), bukan tiruan.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';

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

import { type BenchSodium } from '../backupBench';
import {
  LINK_HISTORY_BENCH_BUDGET,
  formatLinkHistoryBenchmark,
  generateHistoryFixture,
  runLinkHistoryBenchmark,
} from '../linkHistoryBench';

const BENCH = process.env.NYX_BENCH === '1';
const MESSAGE_COUNT = BENCH ? 10_000 : 200;

beforeAll(async () => {
  await sodium.ready;
});

describe('linkHistoryBench: fixture', () => {
  it('deterministik dan berbentuk objek domain', () => {
    const a = generateHistoryFixture({ messageCount: 5 });
    const b = generateHistoryFixture({ messageCount: 5 });

    expect(JSON.stringify(a.messages)).toEqual(JSON.stringify(b.messages));
    expect(a.messages).toHaveLength(5);
    expect(a.conversations).toHaveLength(20);
    // Cache partisipan hanya untuk percakapan grup (i % 3 === 0).
    expect(a.groupCachedParticipants.length).toBeGreaterThan(0);
    // `seq` dipertahankan: itu kursor paginasi di perangkat baru.
    expect(a.messages[0]!.seq).toBe(1000);
  });
});

describe('linkHistoryBench: laporan', () => {
  it('formatLinkHistoryBenchmark memuat jumlah pesan, ukuran, dan integritas', () => {
    const text = formatLinkHistoryBenchmark({
      messageCount: 10_000,
      totalRecords: 10_300,
      archiveBytes: 4 * 1024 * 1024,
      frameCount: 20,
      export: { ms: 1234, peakHeapBytes: 8 * 1024 * 1024, peakRssBytes: 64 * 1024 * 1024 },
      import: { ms: 2345, peakHeapBytes: 9 * 1024 * 1024, peakRssBytes: 65 * 1024 * 1024 },
      integrity: { importedRecords: 10_300, importedMessages: 10_000, matches: true },
    });

    expect(text).toContain('10,000 pesan');
    expect(text).toContain('10,300 catatan');
    expect(text).toContain('4.00 MB');
    expect(text).toContain('OK');
  });
});

describe('linkHistoryBench: ekspor/impor', () => {
  it(`roundtrip ${MESSAGE_COUNT} pesan (waktu + puncak memori)`, async () => {
    const result = await runLinkHistoryBenchmark({
      messageCount: MESSAGE_COUNT,
      sodium: sodium as unknown as BenchSodium,
    });

    // Selalu cetak supaya angka terlihat di output lokal/CI.
    console.log('\n' + formatLinkHistoryBenchmark(result));

    // Integritas dulu: benchmark cepat tapi kehilangan pesan tidak bermakna.
    expect(result.integrity.matches).toBe(true);
    expect(result.integrity.importedMessages).toBe(MESSAGE_COUNT);
    expect(result.integrity.importedRecords).toBe(result.totalRecords);
    expect(result.archiveBytes).toBeGreaterThan(0);
    expect(result.frameCount).toBeGreaterThan(0);

    // Gate (longgar; mesin berbeda — angka sebenarnya di atas).
    expect(result.export.ms).toBeLessThanOrEqual(LINK_HISTORY_BENCH_BUDGET.exportMs);
    expect(result.import.ms).toBeLessThanOrEqual(LINK_HISTORY_BENCH_BUDGET.importMs);
    expect(result.archiveBytes).toBeLessThanOrEqual(LINK_HISTORY_BENCH_BUDGET.archiveBytes);
  }, BENCH ? 600_000 : 60_000);
});
