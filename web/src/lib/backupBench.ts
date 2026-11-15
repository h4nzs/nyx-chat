// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 5 / docs/31 §31.6d] Harness benchmark export/import backup.
 *
 * Tujuan: mengubah klaim "format ber-frame muat untuk 10k pesan" menjadi angka
 * yang **diukur** (waktu + puncak memori), bukan asumsi — gate `docs/30` §30.7.
 *
 * Yang diukur adalah lapisan yang bisa diukur konsisten di mana saja:
 * `createFramedBackup` (tabel → frame → arsip AEAD) dan `restoreFramedBackup`
 * (parse + verifikasi + dekode + tulis). Penyimpanan di-inject sebagai store
 * in-memory, jadi harness berjalan tanpa IndexedDB/browser. **Batasannya jujur:
 * waktu I/O IndexedDB nyata tidak termasuk** — angka di sini adalah batas bawah
 * untuk kripto + serialisasi, bukan pengganti profil browser.
 *
 * Fixture deterministik (LCG sederhana, tanpa `Math.random`) supaya hasil dua
 * eksekusi bisa dibandingkan.
 */

import { libsodiumBackupCrypto } from './backupFormat';
import { BACKUP_TABLE_ORDER, libsodiumBackupValueCodec } from './backupPayload';
import { createFramedBackup, formatBackupSize, restoreFramedBackup, type BackupStore } from './backupRestore';

/** Bentuk sodium yang dibutuhkan harness (gabungan kedua adapter). */
export type BenchSodium = Parameters<typeof libsodiumBackupCrypto>[0] & Parameters<typeof libsodiumBackupValueCodec>[0];

export interface BackupFixtureOptions {
  /** Jumlah pesan (dan kunci pesan) — angka yang jadi judul benchmark. */
  messageCount: number;
  conversationCount?: number;
  contactCount?: number;
  /** Ukuran ciphertext at-rest per pesan (byte) sebelum base64. */
  messageBytes?: number;
  /** Jumlah catatan Account/identity tambahan. */
  identityCount?: number;
}

/**
 * Bangun fixture tabel Keychain deterministik. Bentuknya menirukan data nyata:
 * nilai at-rest `ENC1:`, `Uint8Array` untuk kunci, `Date`/ISO untuk waktu.
 */
export function generateBackupFixture(opts: BackupFixtureOptions): Record<string, unknown[]> {
  const {
    messageCount,
    conversationCount = 20,
    contactCount = Math.min(200, messageCount),
    messageBytes = 160,
    identityCount = 50,
  } = opts;

  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
  const messages: unknown[] = [];
  const messageKeys: unknown[] = [];

  for (let i = 0; i < messageCount; i++) {
    messages.push({
      id: `msg_${i}`,
      conversationId: `conv_${i % conversationCount}`,
      content: `ENC1:${syntheticCiphertext(i, messageBytes)}`,
      createdAt: new Date(baseTime + i * 1000).toISOString(),
      senderId: `user_${i % 50}`,
      status: 'read',
      seq: i,
    });
    messageKeys.push({ messageId: `msg_${i}`, key: syntheticBytes(i, 32) });
  }

  const conversations: unknown[] = [];
  for (let i = 0; i < conversationCount; i++) {
    conversations.push({
      id: `conv_${i}`,
      isGroup: i % 3 === 0,
      encryptedMetadata: `ENC1:${syntheticCiphertext(1000 + i, 120)}`,
      participants: `ENC1:${syntheticCiphertext(2000 + i, 256)}`,
      lastMessageAt: new Date(baseTime + messageCount * 1000).toISOString(),
    });
  }

  const contacts: unknown[] = [];
  for (let i = 0; i < contactCount; i++) {
    contacts.push({ userId: `user_${i}`, data: `ENC1:${syntheticCiphertext(3000 + i, 220)}`, updatedAt: baseTime + i });
  }

  const identityKeys: unknown[] = [];
  for (let i = 0; i < identityCount; i++) {
    identityKeys.push({ userId: `user_${i}`, key: syntheticCiphertext(4000 + i, 64) });
  }

  return {
    messages,
    messageKeys,
    conversations,
    contacts,
    identityKeys,
    sessionKeys: [{ storageKey: 'conv_0_s1', conversationId: 'conv_0', sessionId: 's1', key: syntheticBytes(7, 32) }],
    kvStore: [{ key: 'locale', value: 'id' }],
  };
}

/** Byte deterministik (LCG) — nilai kunci palsu, bukan kripto. */
function syntheticBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed * 2654435761 + 1) >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** String ber-alphabet base64url deterministik (panjang ≈ 4/3 × `bytes`). */
function syntheticCiphertext(seed: number, bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const length = Math.ceil((bytes * 4) / 3);
  let state = (seed * 40503 + 17) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out += alphabet[state % 64];
  }
  return out;
}

export interface MemorySample {
  peakHeapBytes: number;
  peakRssBytes: number;
}

export interface BenchmarkPhase {
  /** Waktu dinding (ms) fase ini. */
  ms: number;
  peakHeapBytes: number;
  peakRssBytes: number;
}

export interface BackupBenchmarkResult {
  messageCount: number;
  totalRecords: number;
  archiveBytes: number;
  frameCount: number;
  export: BenchmarkPhase;
  restore: BenchmarkPhase;
  integrity: {
    restoredRecords: number;
    /** true bila jumlah catatan per tabel sama antara sumber dan hasil restore. */
    matches: boolean;
  };
}

export interface BackupBenchmarkOptions {
  messageCount: number;
  /** Instance sodium siap pakai; bila kosong, dimuat dinamis (`libsodium-wrappers`). */
  sodium?: BenchSodium;
  fixture?: Record<string, unknown[]>;
  /** Ambang chunk (byte). Default `BACKUP_CHUNK_BYTES` (256 KB). */
  chunkBytes?: number;
}

/** Batas longgar untuk gate 10k di mesin dev. Angka sebenarnya dilaporkan. */
export const BACKUP_BENCH_BUDGET = {
  exportMs: 30_000,
  restoreMs: 30_000,
  archiveBytes: 256 * 1024 * 1024,
} as const;

/**
 * Ambil sampel `process.memoryUsage()` berkala agar puncak selama fase awet.
 * Diekspor karena harness benchmark lain (arsip riwayat, `linkHistoryBench.ts`)
 * memakai sampler yang sama — dua salinan akan menghasilkan angka yang tidak
 * sebanding.
 */
export function startMemorySample(intervalMs = 10): { stop(): MemorySample } {
  const memUsage = (globalThis as {
    process?: { memoryUsage?: () => { heapUsed: number; rss: number } };
  }).process?.memoryUsage;

  let peakHeapBytes = 0;
  let peakRssBytes = 0;
  const read = () => {
    if (!memUsage) return;
    const usage = memUsage();
    if (usage.heapUsed > peakHeapBytes) peakHeapBytes = usage.heapUsed;
    if (usage.rss > peakRssBytes) peakRssBytes = usage.rss;
  };
  read();

  let timer: ReturnType<typeof setInterval> | undefined;
  if (typeof setInterval === 'function') timer = setInterval(read, intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      read();
      return { peakHeapBytes, peakRssBytes };
    },
  };
}

/** Samakan dua peta jumlah-per-tabel tanpa peduli urutan kunci. */
export function countsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Store in-memory: penyimpanan dipisahkan supaya benchmark tidak butuh IndexedDB. */
function memoryStore(seed: Record<string, unknown[]>): BackupStore & { data: Record<string, unknown[]> } {
  const data: Record<string, unknown[]> = { ...seed };
  return {
    data,
    readTables: async (tables = BACKUP_TABLE_ORDER) => {
      const out: Record<string, unknown[]> = {};
      for (const table of tables) out[table] = data[table] ?? [];
      return out;
    },
    writeTables: async (recordsByTable) => {
      for (const [table, rows] of Object.entries(recordsByTable)) data[table] = rows;
    },
  };
}

async function loadSodium(): Promise<BenchSodium> {
  const mod = (await import('libsodium-wrappers')) as unknown as { default?: unknown };
  const sodium = (mod.default ?? mod) as { ready: Promise<void> };
  await sodium.ready;
  return sodium as unknown as BenchSodium;
}

/**
 * Jalankan benchmark: bangun arsip dari fixture 10k pesan, lalu pulihkan.
 * Integritas diverifikasi (jumlah catatan per tabel harus sama) — benchmark yang
 * "cepat" tapi kehilangan data tidak berarti apa-apa.
 */
export async function runBackupBenchmark(opts: BackupBenchmarkOptions): Promise<BackupBenchmarkResult> {
  const sodium = opts.sodium ?? (await loadSodium());
  const crypto = libsodiumBackupCrypto(sodium);
  const codec = libsodiumBackupValueCodec(sodium);
  const records = opts.fixture ?? generateBackupFixture({ messageCount: opts.messageCount });

  let totalRecords = 0;
  for (const rows of Object.values(records)) totalRecords += rows.length;

  const key = sodium.randombytes_buf(32);
  const salt = sodium.randombytes_buf(16);
  const source = memoryStore(records);

  const exportSample = startMemorySample();
  const exportStart = nowMs();
  const created = await createFramedBackup({
    store: source,
    key,
    crypto,
    codec,
    salt,
    chunkBytes: opts.chunkBytes,
  });
  const exportMs = nowMs() - exportStart;
  const exportMem = exportSample.stop();

  // Sink terpisah supaya puncak memori restore tidak tercampur state sumber.
  const sink = memoryStore({});

  const restoreSample = startMemorySample();
  const restoreStart = nowMs();
  const restored = await restoreFramedBackup({
    store: sink,
    bytes: created.bytes,
    key,
    crypto,
    codec,
  });
  const restoreMs = nowMs() - restoreStart;
  const restoreMem = restoreSample.stop();

  return {
    messageCount: opts.messageCount,
    totalRecords,
    archiveBytes: created.size,
    frameCount: created.frameCount,
    export: { ms: exportMs, ...exportMem },
    restore: { ms: restoreMs, ...restoreMem },
    integrity: {
      restoredRecords: restored.records,
      // Perbandingan jumlah-per-tabel yang TIDAK bergantung urutan kunci:
      // `createFramedBackup` men-scramble urutan frame (default), jadi urutan
      // tabel di laporan restore sengaja berbeda dari urutan fixture.
      matches: countsEqual(restored.tables, created.tables),
    },
  };
}

/** Laporan siap-cetak (dipakai test/CLI). */
export function formatBackupBenchmark(result: BackupBenchmarkResult): string {
  const num = (n: number) => n.toLocaleString('en-US');
  return [
    `Backup benchmark — ${num(result.messageCount)} pesan (${num(result.totalRecords)} catatan)`,
    `  arsip      : ${formatBackupSize(result.archiveBytes)} · ${num(result.frameCount)} frame`,
    `  export     : ${result.export.ms.toFixed(0)} ms · puncak heap ${formatBackupSize(result.export.peakHeapBytes)} · rss ${formatBackupSize(result.export.peakRssBytes)}`,
    `  restore    : ${result.restore.ms.toFixed(0)} ms · puncak heap ${formatBackupSize(result.restore.peakHeapBytes)} · rss ${formatBackupSize(result.restore.peakRssBytes)}`,
    `  integritas : ${result.integrity.matches ? 'OK' : 'GAGAL'} (${num(result.integrity.restoredRecords)} catatan)`,
  ].join('\n');
}
