import type { MessageRow } from './types';

/**
 * [docs/43 §43.10.2] Perilaku saat storage penuh.
 *
 * Menulis pesan yang gagal karena kuota tidak boleh menghilangkan pesan baru
 * atau menggantung antrean. Kebijakan yang dipilih: hapus pesan **tertua**
 * dalam batch kecil, sisakan 500 pesan terbaru, lalu ulangi tulisan. Batas
 * "sisakan 500" mencegah kuota penuh menghapus seluruh riwayat hanya karena
 * satu tulisan gagal.
 */
export const STORAGE_PRUNE_KEEP_NEWEST = 500;
export const STORAGE_PRUNE_BATCH = 250;

const STORAGE_FULL_PATTERN = /SQLITE_FULL|database or disk is full|disk is full|quota.*exceed/i;

export function isStorageFullError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STORAGE_FULL_PATTERN.test(message);
}

function timestampOf(row: MessageRow): number {
  if (typeof row.orderBucketMs === 'number' && Number.isFinite(row.orderBucketMs)) {
    return row.orderBucketMs;
  }
  const created = row.createdAt;
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  if (typeof created === 'string') {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Baris tertua yang boleh dihapus, tanpa menyentuh 500 baris terbaru.
 * Urutan memakai bucket/createdAt; id hanya tie-breaker agar deterministik.
 */
export function selectOldestMessages(
  rows: MessageRow[],
  count = STORAGE_PRUNE_BATCH,
  keepNewest = STORAGE_PRUNE_KEEP_NEWEST,
): MessageRow[] {
  if (count <= 0) return [];
  const sorted = [...rows].sort((left, right) => {
    const byTime = timestampOf(left) - timestampOf(right);
    if (byTime !== 0) return byTime;
    return left.id.localeCompare(right.id);
  });
  const removable = Math.max(0, sorted.length - Math.max(0, keepNewest));
  return sorted.slice(0, Math.min(count, removable));
}
