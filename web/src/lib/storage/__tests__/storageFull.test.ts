import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../types';
import {
  STORAGE_PRUNE_BATCH,
  STORAGE_PRUNE_KEEP_NEWEST,
  isStorageFullError,
  selectOldestMessages,
} from '../storageFull';

function row(id: string, orderBucketMs?: number): MessageRow {
  return { id, conversationId: 'c1', ...(orderBucketMs === undefined ? {} : { orderBucketMs }) };
}

describe('isStorageFullError', () => {
  it('mengenali pesan SQLite dan kuota browser', () => {
    expect(isStorageFullError(new Error('database or disk is full'))).toBe(true);
    expect(isStorageFullError(new Error('SQLITE_FULL: database or disk is full'))).toBe(true);
    expect(isStorageFullError(new Error('The quota has been exceeded.'))).toBe(true);
  });

  it('tidak menganggap error lain sebagai storage penuh', () => {
    expect(isStorageFullError(new Error('SQLITE_BUSY'))).toBe(false);
    expect(isStorageFullError('network failed')).toBe(false);
  });
});

describe('selectOldestMessages', () => {
  it('memilih yang tertua dan menyisakan 500 pesan terbaru', () => {
    const rows = Array.from({ length: STORAGE_PRUNE_KEEP_NEWEST + 5 }, (_, index) =>
      row(`m-${String(index).padStart(4, '0')}`, index),
    );

    expect(selectOldestMessages(rows)).toHaveLength(5);
    expect(selectOldestMessages(rows).map((item) => item.id)).toEqual([
      'm-0000',
      'm-0001',
      'm-0002',
      'm-0003',
      'm-0004',
    ]);
  });

  it('membatasi jumlah yang dihapus per batch', () => {
    const rows = Array.from({ length: STORAGE_PRUNE_KEEP_NEWEST + 1_000 }, (_, index) =>
      row(`m-${String(index).padStart(4, '0')}`, index),
    );

    const selected = selectOldestMessages(rows);
    expect(selected).toHaveLength(STORAGE_PRUNE_BATCH);
    expect(selected[0]?.id).toBe('m-0000');
  });

  it('tidak memilih apa pun bila total belum melewati batas aman', () => {
    const rows = Array.from({ length: STORAGE_PRUNE_KEEP_NEWEST }, (_, index) =>
      row(`m-${index}`, index),
    );
    expect(selectOldestMessages(rows)).toEqual([]);
  });

  it('memakai createdAt dan menempatkan baris tanpa waktu sebagai tertua', () => {
    const rows = [
      row('without-time'),
      { ...row('newer'), createdAt: '2026-11-26T10:00:00.000Z' },
      { ...row('older'), createdAt: '2026-11-25T10:00:00.000Z' },
    ];
    // keepNewest 0 supaya semua baris bisa dibandingkan tanpa 500 baris dummy.
    expect(selectOldestMessages(rows, 10, 0).map((item) => item.id)).toEqual([
      'without-time',
      'older',
      'newer',
    ]);
  });
});
