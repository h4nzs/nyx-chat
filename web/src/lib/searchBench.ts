// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F §30.10 poin 4] Harness benchmark indeks pencarian in-memory.
 *
 * Gate `docs/30` §30.10 menuntut angka, bukan asumsi: "pencarian < 100ms untuk
 * 10k pesan" + biaya membangun indeks dan memorinya. Harness ini mengukur
 * lapisan yang bisa diukur konsisten di mana saja (tanpa browser/IndexedDB):
 * pembangunan indeks dari plaintext, pemilihan kandidat (termasuk pengurutan
 * token yang malas), dan puncak memori.
 *
 * **Batasannya jujur:** waktu dekripsi XChaCha per baris dan I/O IndexedDB tidak
 * termasuk — yang diukur adalah bagian yang menggantikan O(n) dekripsi tiap
 * ketikan, yaitu pemilihan kandidat. Fixture deterministik (LCG, tanpa
 * `Math.random`) supaya dua eksekusi bisa dibandingkan.
 */

import { MessageSearchIndex } from './searchIndex';

export interface SearchFixtureOptions {
  /** Jumlah pesan (angka yang jadi judul benchmark). */
  messageCount: number;
  conversationCount?: number;
  /** Terma langka yang hanya muncul di sebagian kecil pesan (query selektif). */
  rareTerm?: string;
}

export interface SearchFixtureMessage {
  id: string;
  conversationId: string;
  text: string;
}

const WORDS = [
  'harga', 'proyek', 'jadwal', 'besok', 'laporan', 'kantor', 'keluarga', 'jalan',
  'kirim', 'terima', 'kunci', 'rahasia', 'grup', 'panggilan', 'berkas', 'foto',
  'catatan', 'rencana', 'sekolah', 'pasar', 'makan', 'siang', 'malam', 'pagi',
];

/** PRNG deterministik sederhana (sama semangatnya dengan fixture backup). */
function makeRng(seed = 0x2f6e2b1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0xffffffff;
  };
}

/** Bangun pesan sintetis deterministik; ~1% pesan memuat `rareTerm`. */
export function generateSearchFixture(opts: SearchFixtureOptions): SearchFixtureMessage[] {
  const { messageCount, conversationCount = 20, rareTerm = 'needle' } = opts;
  const rng = makeRng();
  const messages: SearchFixtureMessage[] = [];

  for (let i = 0; i < messageCount; i++) {
    const wordCount = 6 + Math.floor(rng() * 12);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      words.push(WORDS[Math.floor(rng() * WORDS.length)] ?? 'kata');
    }
    // 97 (koprima dengan `conversationCount` default 20) supaya terma langka
    // tersebar merata ke banyak percakapan — bukan menumpuk di satu percakapan.
    if (i % 97 === 0) words.splice(Math.floor(rng() * words.length), 0, rareTerm);
    messages.push({
      id: `msg_${i}`,
      conversationId: `conv_${i % conversationCount}`,
      text: words.join(' '),
    });
  }
  return messages;
}

export interface SearchBenchPhase {
  ms: number;
  peakHeapBytes: number;
  peakRssBytes: number;
}

export interface SearchBenchResult {
  messageCount: number;
  conversationCount: number;
  indexedTokens: number;
  build: SearchBenchPhase;
  /** Pencarian pertama (termasuk pengurutan token yang malas). */
  coldSearch: SearchBenchPhase;
  /** Rata-rata pencarian berikutnya (20 iterasi, query umum + selektif). */
  warmSearch: SearchBenchPhase;
  warmSearchMsPerQuery: number;
  selectiveCandidates: number;
  commonCandidates: number;
}

export interface SearchBenchOptions extends SearchFixtureOptions {
  /** Iterasi pencarian hangat. Default 20. */
  warmIterations?: number;
  /** Query umum (banyak kandidat) — menguji batas kandidat. */
  commonQuery?: string;
  fixture?: SearchFixtureMessage[];
}

/** Ambang longgar untuk gate 10k di mesin dev. Angka sebenarnya dilaporkan. */
export const SEARCH_BENCH_BUDGET = {
  buildMs: 5_000,
  searchMs: 100,
  /** Puncak heap untuk indeks 10k pesan (batas kasar, bukan target). */
  peakHeapBytes: 512 * 1024 * 1024,
} as const;

/** Ambil sampel `process.memoryUsage()` berkala agar puncak selama fase awet. */
function startMemorySample(intervalMs = 10): { stop(): { peakHeapBytes: number; peakRssBytes: number } } {
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

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function runSearchBenchmark(opts: SearchBenchOptions): SearchBenchResult {
  const {
    messageCount,
    conversationCount = 20,
    rareTerm = 'needle',
    warmIterations = 20,
    commonQuery = 'kirim',
    fixture,
  } = opts;

  const messages = fixture ?? generateSearchFixture({ messageCount, conversationCount, rareTerm });
  const index = new MessageSearchIndex();
  const primaryConversation = messages.find((m) => m.text.includes(rareTerm))?.conversationId
    ?? messages[0]?.conversationId
    ?? 'conv_0';

  // ── Fase 1: bangun indeks ────────────────────────────────────────────────
  const buildSample = startMemorySample();
  const buildStart = nowMs();
  for (const message of messages) index.add(message.id, message.conversationId, message.text);
  const buildMs = nowMs() - buildStart;
  const buildMemory = buildSample.stop();

  // ── Fase 2: pencarian pertama (token sorting malas termasuk di sini) ─────
  const coldSample = startMemorySample();
  const coldStart = nowMs();
  const selectiveCandidates = index.candidates(primaryConversation, rareTerm).length;
  const coldMs = nowMs() - coldStart;
  const coldMemory = coldSample.stop();

  // ── Fase 3: pencarian hangat (query selektif + umum bergantian) ──────────
  let commonCandidates = 0;
  const warmSample = startMemorySample();
  const warmStart = nowMs();
  for (let i = 0; i < warmIterations; i++) {
    const query = i % 2 === 0 ? rareTerm : commonQuery;
    const found = index.candidates(primaryConversation, query);
    if (i % 2 === 1) commonCandidates = found.length;
  }
  const warmMs = nowMs() - warmStart;
  const warmMemory = warmSample.stop();

  return {
    messageCount: messages.length,
    conversationCount,
    indexedTokens: index.size,
    build: { ms: buildMs, ...buildMemory },
    coldSearch: { ms: coldMs, ...coldMemory },
    warmSearch: { ms: warmMs, ...warmMemory },
    warmSearchMsPerQuery: warmMs / Math.max(1, warmIterations),
    selectiveCandidates,
    commonCandidates,
  };
}

/** Ringkasan satu baris per fase; angka dicetak apa adanya (bukan dibulatkan ke target). */
export function formatSearchBenchmark(result: SearchBenchResult): string {
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return [
    `search-index bench — ${result.messageCount} pesan / ${result.conversationCount} percakapan`,
    `  build       : ${result.build.ms.toFixed(1)} ms (puncak heap ${mb(result.build.peakHeapBytes)} MB)`,
    `  cari (dingin): ${result.coldSearch.ms.toFixed(1)} ms — kandidat selektif ${result.selectiveCandidates}`,
    `  cari (hangat): ${result.warmSearchMsPerQuery.toFixed(2)} ms/query — kandidat umum ${result.commonCandidates}`,
    `  memori cari : puncak heap ${mb(result.warmSearch.peakHeapBytes)} MB / rss ${mb(result.warmSearch.peakRssBytes)} MB`,
  ].join('\n');
}
