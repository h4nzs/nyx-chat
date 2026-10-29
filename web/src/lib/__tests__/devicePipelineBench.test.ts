/**
 * [docs/35 §35.11 residual] Runner "jalur nyata": pipeline worker + IndexedDB.
 *
 * Crypto worker di-stub — Vite `?worker` tidak bisa dijalankan di jsdom — jadi
 * yang diuji di sini adalah pembukuan harness (persentil, batas concurrency,
 * round-trip cocok) dan IndexedDB sungguhan lewat `fake-indexeddb` + Dexie
 * nyata: baris ditulis, dibaca kembali, lalu database bench dihapus.
 */
import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it, vi } from 'vitest';

const inflight = { current: 0, peak: 0 };

vi.mock('@lib/crypto-worker-proxy', () => ({
  workerXChaChaSeal: vi.fn(async (key: string, plaintext: string) => {
    inflight.current += 1;
    inflight.peak = Math.max(inflight.peak, inflight.current);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inflight.current -= 1;
    return `SEAL:${key.length}:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }),
  workerXChaChaOpen: vi.fn(async (_key: string, sealed: string) => {
    if (!sealed.startsWith('SEAL:')) throw new Error('stub: envelope tidak dikenal');
    const rest = sealed.slice('SEAL:'.length);
    const separator = rest.indexOf(':');
    if (separator < 0) throw new Error('stub: format salah');
    return Buffer.from(rest.slice(separator + 1), 'base64').toString('utf8');
  }),
}));

import {
  IDB_BENCH_DB,
  IDB_RATCHET_STATE_BYTES,
  PIPELINE_CONCURRENCY,
  PIPELINE_COVER_BYTES,
  PIPELINE_MESSAGE_BYTES,
  runIndexedDbBench,
  runRealPathBench,
  runWorkerPipelineBench,
} from '../devicePipelineBench';

async function benchDbRowCount(): Promise<number> {
  const db = new Dexie(IDB_BENCH_DB);
  db.version(1).stores({ messageKeys: 'messageId', ratchetSessions: 'conversationId' });
  await db.open();
  try {
    return await db.table('messageKeys').count();
  } finally {
    db.close();
    await Dexie.delete(IDB_BENCH_DB);
  }
}

describe('runWorkerPipelineBench', () => {
  it('mengukur seal+open untuk 256 B dan payload traffic-cover 8 KB', async () => {
    const result = await runWorkerPipelineBench({ messages: 6, concurrency: 3 });

    expect(result.messages).toBe(6);
    expect(result.concurrency).toBe(3);
    expect(result.runs.map((run) => run.payloadBytes)).toEqual([
      PIPELINE_MESSAGE_BYTES,
      PIPELINE_COVER_BYTES,
    ]);

    for (const run of result.runs) {
      // Envelope base64url selalu lebih panjang dari plaintext-nya.
      expect(run.ciphertextBytes).toBeGreaterThan(run.payloadBytes);
      for (const timing of [run.encrypt, run.decrypt]) {
        expect(timing.meanMs).toBeGreaterThanOrEqual(0);
        expect(timing.p50Ms).toBeGreaterThanOrEqual(0);
        expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.p50Ms);
      }
    }

    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.operationsPerSecond).toBeGreaterThan(0);
  });

  it('menjaga jumlah permintaan in-flight sesuai concurrency', async () => {
    inflight.current = 0;
    inflight.peak = 0;

    await runWorkerPipelineBench({ messages: 8, concurrency: PIPELINE_CONCURRENCY });

    expect(inflight.peak).toBeGreaterThan(1);
    expect(inflight.peak).toBeLessThanOrEqual(PIPELINE_CONCURRENCY);
  });

  it('tidak pernah memakai lebih banyak lane daripada jumlah pesan', async () => {
    const result = await runWorkerPipelineBench({ messages: 2, concurrency: 8 });
    expect(result.concurrency).toBe(2);
  });
});

describe('runIndexedDbBench', () => {
  it('menulis, membaca, dan menghapus baris lalu membuang database bench', async () => {
    const result = await runIndexedDbBench({ messages: 5 });

    expect(result.messages).toBe(5);
    expect(result.stateBytes).toBe(IDB_RATCHET_STATE_BYTES);
    for (const timing of [result.write, result.read, result.ratchetWrite, result.delete]) {
      expect(timing.p50Ms).toBeGreaterThanOrEqual(0);
      expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.p50Ms);
    }

    // `databases()` tidak ada di semua browser; kalau tersedia hasilnya harus
    // true, dan apa pun hasilnya barisnya harus benar-benar hilang.
    expect(result.deleted).not.toBe(false);
    expect(await benchDbRowCount()).toBe(0);
  });
});

describe('runRealPathBench', () => {
  it('menggabungkan pipeline dan IndexedDB dalam satu laporan', async () => {
    const { pipeline, indexedDb } = await runRealPathBench({ messages: 3 });

    expect(pipeline.messages).toBe(3);
    expect(pipeline.runs).toHaveLength(2);
    expect(indexedDb.messages).toBe(3);
    expect(await benchDbRowCount()).toBe(0);
  });
});
