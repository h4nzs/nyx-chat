/**
 * [docs/40 §40.8] Penanda + percobaan ulang impor riwayat hasil link.
 *
 * Yang dikunci di sini adalah kebijakan yang mudah salah:
 *   - tanpa penanda, tidak ada unduhan sama sekali (app start tidak membayar),
 *   - sukses / arsip kedaluwarsa menghapus penanda,
 *   - gagal MEMPERTAHANKAN penanda (arsip masih hidup sampai TTL 30 menit),
 *   - dua klik/panggilan bersamaan hanya mengunduh sekali.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = vi.hoisted(() => new Map<string, unknown>());
const receive = vi.hoisted(() => vi.fn());

vi.mock('@lib/db', () => ({
  db: {
    kvStore: {
      get: async (key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
      put: async (row: { key: string; value: unknown }) => {
        kv.set(row.key, row.value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
  },
}));

vi.mock('../linkHistoryImport', () => ({
  receiveLinkedHistory: receive,
}));

import {
  HISTORY_RETRY_KEY,
  autoRetryLinkedHistory,
  clearHistoryImportPending,
  hasPendingHistoryImport,
  markHistoryImportPending,
  resetLinkHistoryRetryStateForTests,
  retryLinkedHistory,
} from '../linkHistoryRetry';

beforeEach(() => {
  kv.clear();
  receive.mockReset();
  resetLinkHistoryRetryStateForTests();
});

describe('penanda impor riwayat', () => {
  it('mark → pending, clear → tidak pending', async () => {
    await markHistoryImportPending();
    // Boolean, bukan timestamp: waktu presisi per kejadian = metadata aktivitas.
    expect(kv.get(HISTORY_RETRY_KEY)).toBe(true);
    expect(await hasPendingHistoryImport()).toBe(true);

    await clearHistoryImportPending();
    expect(await hasPendingHistoryImport()).toBe(false);
  });
});

describe('retryLinkedHistory', () => {
  it('tidak menyentuh server bila tidak ada penanda', async () => {
    const outcome = await retryLinkedHistory();
    expect(outcome).toEqual({ status: 'idle' });
    expect(receive).not.toHaveBeenCalled();
  });

  it('impor sukses menghapus penanda dan meneruskan progres', async () => {
    await markHistoryImportPending();
    const onProgress = vi.fn();
    receive.mockResolvedValue({ records: 7, messages: 5, size: 2048 });

    const outcome = await retryLinkedHistory({ onProgress });

    expect(outcome).toEqual({ status: 'imported', records: 7, messages: 5 });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]![0]).toEqual({ onProgress });
    expect(await hasPendingHistoryImport()).toBe(false);
  });

  it('server tanpa arsip (null) dianggap selesai — penanda dibersihkan', async () => {
    await markHistoryImportPending();
    receive.mockResolvedValue(null);

    const outcome = await retryLinkedHistory();

    expect(outcome).toEqual({ status: 'expired' });
    expect(await hasPendingHistoryImport()).toBe(false);
  });

  it('kegagalan mempertahankan penanda supaya bisa dicoba lagi', async () => {
    await markHistoryImportPending();
    const error = new Error('offline');
    receive.mockRejectedValue(error);

    const outcome = await retryLinkedHistory();

    expect(outcome).toEqual({ status: 'failed', error });
    expect(await hasPendingHistoryImport()).toBe(true);
  });

  it('dua percobaan bersamaan hanya mengunduh sekali', async () => {
    await markHistoryImportPending();
    let release: (value: unknown) => void = () => {};
    receive.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const first = retryLinkedHistory();
    const second = retryLinkedHistory();
    release({ records: 1, messages: 1, size: 10 });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(receive).toHaveBeenCalledTimes(1);
  });
});

describe('autoRetryLinkedHistory', () => {
  it('hanya mencoba sekali per app start', async () => {
    await markHistoryImportPending();
    receive.mockRejectedValue(new Error('offline'));

    const first = await autoRetryLinkedHistory();
    const second = await autoRetryLinkedHistory();

    expect(first?.status).toBe('failed');
    expect(second).toBeNull();
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
