/**
 * Seam sementara untuk tes jsdom yang belum punya Worker/OPFS.
 *
 * Produksi tetap SQLite-only: kegagalan membuka SQLite dilempar. Hanya di
 * Vitest (`MODE=test`) modul boleh memakai adapter Dexie lama setelah open
 * gagal, supaya tes yang menyuntik `db` tetap menguji logika store.
 *
 * shortcut: fallback khusus tes, ganti dengan injeksi store saat tes punya
 * fake SQLite; sampai itu ada, jalur ini tidak boleh dipakai di build/dev.
 */
export function useDexieTestFallback(): boolean {
  return import.meta.env.MODE === 'test';
}
