// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40 §40.12 fase 3] Harness benchmark arsip riwayat perangkat hasil link.
 *
 * Tujuan: mengganti kalimat "10k pesan ≈ puluhan MB JSON" menjadi angka yang
 * **diukur** (waktu + puncak memori), bukan asumsi. Pola yang sama dengan
 * `backupBench.ts` — supaya kedua angka sebanding.
 *
 * Yang diukur:
 *   - ekspor: objek domain (fixture) → frame AEAD (`createHistoryArchive`,
 *     marker `history`, chunk 256 KB, scramble) + digest BLAKE2b,
 *   - impor: parse + verifikasi AEAD + penanda → penulis domain.
 *
 * Batasannya jujur: penulis di-inject sebagai no-op, jadi **penyegelan ulang
 * (crypto worker) dan tulis IndexedDB nyata tidak termasuk**. Angka di sini
 * adalah batas bawah untuk serialisasi + arsip; profil perangkat sungguhan
 * tetap perlu diukur di browser (`docs/31` §31.6d memakai alasan yang sama).
 *
 * Fixture deterministik (LCG, tanpa `Math.random`) supaya dua eksekusi bisa
 * dibandingkan.
 */

import { formatBackupSize } from './backupRestore';
import { countsEqual, startMemorySample, type BenchSodium } from './backupBench';
import {
  countHistoryRecords,
  createHistoryArchive,
  type HistoryTables,
} from './linkHistoryExport';
import { importHistoryArchive } from './linkHistoryImport';

/**
 * Fixture objek DOMAIN (bukan baris Dexie) dengan panjang pesan yang menirukan
 * riwayat nyata: teks pendek, sebagian dengan metadata file.
 */
export function generateHistoryFixture(opts: {
  messageCount: number;
  conversationCount?: number;
  contactCount?: number;
  /** Panjang isi pesan (byte). */
  messageBytes?: number;
  /** Fraksi pesan yang membawa `fileMeta` (lampiran). */
  attachmentRate?: number;
}): HistoryTables {
  const {
    messageCount,
    conversationCount = 20,
    contactCount = Math.min(200, messageCount),
    messageBytes = 160,
    attachmentRate = 0.1,
  } = opts;

  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
  const messages = [] as HistoryTables['messages'];
  const conversations = [] as HistoryTables['conversations'];
  const contacts = [] as HistoryTables['contacts'];
  const groupCachedParticipants: HistoryTables['groupCachedParticipants'] = [];

  for (let i = 0; i < conversationCount; i++) {
    const isGroup = i % 3 === 0;
    conversations.push({
      id: `conv_${i}`,
      isGroup,
      participants: Array.from({ length: isGroup ? 5 : 2 }, (_, p) => ({
        id: `user_${(i + p) % 50}`,
      })),
      lastMessageAt: new Date(baseTime + messageCount * 1000).toISOString(),
      unreadCount: 0,
      encryptionMode: 'SENDER_KEY',
      lastMessage: null,
    } as unknown as HistoryTables['conversations'][number]);
    if (isGroup) {
      groupCachedParticipants.push({
        conversationId: `conv_${i}`,
        userIds: Array.from({ length: 5 }, (_, p) => `user_${(i + p) % 50}`),
      });
    }
  }

  for (let i = 0; i < contactCount; i++) {
    contacts.push({
      userId: `user_${i}`,
      conversationId: `conv_${i % conversationCount}`,
      encryptedProfile: null,
      publicKey: syntheticText(i, 44),
      firstSeenAt: baseTime,
      lastSeenAt: baseTime + i,
      blocked: false,
    } as HistoryTables['contacts'][number]);
  }

  for (let i = 0; i < messageCount; i++) {
    const withAttachment = i % Math.max(1, Math.round(1 / attachmentRate)) === 0;
    messages.push({
      id: `msg_${i}`,
      conversationId: `conv_${i % conversationCount}`,
      content: syntheticText(i, messageBytes),
      senderId: `user_${i % 50}`,
      sender: { id: `user_${i % 50}`, name: `User ${i % 50}` },
      createdAt: new Date(baseTime + i * 1000).toISOString(),
      status: 'SENT',
      seq: 1000 + i,
      ...(withAttachment
        ? {
            fileMeta: {
              name: `file_${i}.jpg`,
              size: 128 * 1024,
              mimeType: 'image/jpeg',
              url: `https://files.invalid/${i}`,
            },
          }
        : {}),
    } as HistoryTables['messages'][number]);
  }

  return { contacts, conversations, messages, groupCachedParticipants };
}

/** Teks deterministik (LCG) — isi palsu, bukan kripto. */
function syntheticText(seed: number, bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,';
  let state = (seed * 40503 + 17) >>> 0;
  let out = '';
  for (let i = 0; i < bytes; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

export interface LinkHistoryBenchPhase {
  ms: number;
  peakHeapBytes: number;
  peakRssBytes: number;
}

export interface LinkHistoryBenchmarkResult {
  messageCount: number;
  totalRecords: number;
  archiveBytes: number;
  frameCount: number;
  export: LinkHistoryBenchPhase;
  import: LinkHistoryBenchPhase;
  integrity: {
    importedRecords: number;
    importedMessages: number;
    /** true bila jumlah catatan per tabel sama antara fixture dan hasil impor. */
    matches: boolean;
  };
}

/**
 * Batas longgar untuk gate 10k di mesin dev/CI. Angka sebenarnya dilaporkan,
 * bukan disembunyikan oleh ambang.
 */
export const LINK_HISTORY_BENCH_BUDGET = {
  exportMs: 30_000,
  importMs: 30_000,
  archiveBytes: 256 * 1024 * 1024,
} as const;

async function loadSodium(): Promise<BenchSodium> {
  const mod = (await import('libsodium-wrappers')) as unknown as { default?: unknown };
  const sodium = (mod.default ?? mod) as { ready: Promise<void> };
  await sodium.ready;
  return sodium as unknown as BenchSodium;
}

/**
 * Jalankan benchmark: bangun arsip riwayat dari fixture, lalu impor kembali.
 * Integritas diverifikasi lebih dulu — benchmark cepat yang kehilangan pesan
 * tidak bermakna.
 */
export async function runLinkHistoryBenchmark(opts: {
  messageCount: number;
  sodium?: BenchSodium;
  fixture?: HistoryTables;
  batchSize?: number;
}): Promise<LinkHistoryBenchmarkResult> {
  const sodium = opts.sodium ?? (await loadSodium());
  const tables = opts.fixture ?? generateHistoryFixture({ messageCount: opts.messageCount });
  const totalRecords = countHistoryRecords(tables);
  const key = sodium.randombytes_buf(32);
  const salt = sodium.randombytes_buf(16);

  const exportSample = startMemorySample();
  const exportStart = nowMs();
  const archive = await createHistoryArchive({ key, tables, salt });
  const exportMs = nowMs() - exportStart;
  const exportMem = exportSample.stop();

  const written: Record<string, number> = {};
  let importedMessages = 0;
  const counted = (table: string, rows: number) => {
    written[table] = (written[table] ?? 0) + rows;
  };

  const importSample = startMemorySample();
  const importStart = nowMs();
  const report = await importHistoryArchive({
    bytes: archive.bytes,
    key,
    batchSize: opts.batchSize,
    writers: {
      contacts: async (rows) => counted('contacts', rows.length),
      conversations: async (rows) => counted('conversations', rows.length),
      groupCachedParticipants: async (rows) => counted('groupCachedParticipants', rows.length),
      messages: async (rows) => {
        counted('messages', rows.length);
        importedMessages += rows.length;
      },
    },
  });
  const importMs = nowMs() - importStart;
  const importMem = importSample.stop();

  return {
    messageCount: opts.messageCount,
    totalRecords,
    archiveBytes: archive.size,
    frameCount: archive.frameCount,
    export: { ms: exportMs, ...exportMem },
    import: { ms: importMs, ...importMem },
    integrity: {
      importedRecords: report.records,
      importedMessages,
      // Frame di-scramble, jadi perbandingan yang sah adalah jumlah per tabel
      // (tanpa peduli urutan kunci) — sama seperti `backupBench`.
      matches: countsEqual(written, archive.tables),
    },
  };
}

/** Laporan siap-cetak (dipakai test/CLI). */
export function formatLinkHistoryBenchmark(result: LinkHistoryBenchmarkResult): string {
  const num = (n: number) => n.toLocaleString('en-US');
  return [
    `Arsip riwayat benchmark — ${num(result.messageCount)} pesan (${num(result.totalRecords)} catatan)`,
    `  arsip      : ${formatBackupSize(result.archiveBytes)} · ${num(result.frameCount)} frame`,
    `  ekspor     : ${result.export.ms.toFixed(0)} ms · puncak heap ${formatBackupSize(result.export.peakHeapBytes)} · rss ${formatBackupSize(result.export.peakRssBytes)}`,
    `  impor      : ${result.import.ms.toFixed(0)} ms · puncak heap ${formatBackupSize(result.import.peakHeapBytes)} · rss ${formatBackupSize(result.import.peakRssBytes)}`,
    `  integritas : ${result.integrity.matches ? 'OK' : 'GAGAL'} (${num(result.integrity.importedRecords)} catatan, ${num(result.integrity.importedMessages)} pesan)`,
  ].join('\n');
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
