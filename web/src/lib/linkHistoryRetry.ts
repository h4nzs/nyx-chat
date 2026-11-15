// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40 §40.8] Percobaan ulang impor arsip riwayat perangkat hasil link.
 *
 * Arsip di server hidup sampai TTL 30 menit. Kalau impor gagal (jaringan putus,
 * tab ditutup di tengah, kuota browser), baris yang sudah masuk tetap ada dan
 * arsipnya belum dikonsumsi — jadi percobaan berikutnya hanya melanjutkan.
 * Supaya pengguna tidak harus tahu itu, kegagalan ditandai di `kvStore` dan:
 *   - satu percobaan otomatis dijalankan saat app start berikutnya
 *     (`autoRetryLinkedHistory`),
 *   - entri manual tersedia di Settings/Sessions (`SessionManagerPage`).
 *
 * Penandanya sengaja hanya **boolean plaintext** (`true`): isinya "ada impor
 * yang belum selesai", tanpa waktu presisi (pola `docs/30` WS-F: ms per
 * kejadian adalah metadata aktivitas), tanpa identitas, kontak, atau isi pesan.
 * Tidak ada data sensitif yang bocor bila perangkat di-dump.
 */

import { db } from './db';
import { receiveLinkedHistory, type HistoryImportProgress } from './linkHistoryImport';

/** Satu baris di `kvStore`; nilai `true` = masih ada impor yang tertunda. */
export const HISTORY_RETRY_KEY = 'nyx_link_history_pending';

export type HistoryRetryOutcome =
  | { status: 'idle' }
  | { status: 'imported'; records: number; messages: number }
  | { status: 'expired' }
  | { status: 'failed'; error: unknown };

/** Tandai bahwa impor riwayat belum selesai (dipanggil saat impor gagal). */
export async function markHistoryImportPending(): Promise<void> {
  try {
    await db.kvStore.put({ key: HISTORY_RETRY_KEY, value: true });
  } catch (error) {
    // Gagal menyimpan penanda tidak boleh menggagalkan alur tautan itu sendiri.
    console.warn('[Link] Gagal menandai impor riwayat yang tertunda:', error);
  }
}

/** Hapus penanda (impor sukses, atau server menyatakan arsipnya sudah tidak ada). */
export async function clearHistoryImportPending(): Promise<void> {
  try {
    await db.kvStore.delete(HISTORY_RETRY_KEY);
  } catch (error) {
    console.warn('[Link] Gagal menghapus penanda impor riwayat:', error);
  }
}

export async function hasPendingHistoryImport(): Promise<boolean> {
  try {
    return (await db.kvStore.get(HISTORY_RETRY_KEY)) !== undefined;
  } catch {
    return false;
  }
}

let inFlight: Promise<HistoryRetryOutcome> | null = null;
let autoAttempted = false;

async function runRetry(opts?: {
  onProgress?: (progress: HistoryImportProgress) => void;
}): Promise<HistoryRetryOutcome> {
  if (!(await hasPendingHistoryImport())) return { status: 'idle' };

  try {
    const result = await receiveLinkedHistory({ onProgress: opts?.onProgress });
    if (result === null) {
      // Server tidak punya arsip lagi (TTL habis / sudah dikonsumsi): tidak ada
      // yang bisa diulang, jadi jangan biarkan penandanya menggantung selamanya.
      await clearHistoryImportPending();
      return { status: 'expired' };
    }
    await clearHistoryImportPending();
    return { status: 'imported', records: result.records, messages: result.messages };
  } catch (error) {
    // Penanda DIPERTAHANKAN: arsip masih bisa diambil ulang selama TTL, dan
    // pengguna bisa mencoba lagi secara manual dari Settings.
    console.warn('[Link] Percobaan ulang impor riwayat gagal:', error);
    return { status: 'failed', error };
  }
}

/**
 * Satu percobaan ulang, dipakai tombol Settings. Panggilan bersamaan berbagi
 * promise yang sama supaya dua klik tidak membuat dua unduhan 10 MB.
 */
export async function retryLinkedHistory(opts?: {
  onProgress?: (progress: HistoryImportProgress) => void;
}): Promise<HistoryRetryOutcome> {
  if (inFlight) return inFlight;
  inFlight = runRetry(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Percobaan otomatis saat app start. Dijaga `autoAttempted` supaya React
 * StrictMode (effect ganda di DEV) tidak menembak dua kali berturut-turut;
 * percobaan manual tetap tersedia setelahnya.
 */
export async function autoRetryLinkedHistory(opts?: {
  onProgress?: (progress: HistoryImportProgress) => void;
}): Promise<HistoryRetryOutcome | null> {
  if (autoAttempted) return null;
  autoAttempted = true;
  return retryLinkedHistory(opts);
}

/** Untuk test: reset state modul (single-flight + auto attempt). */
export function resetLinkHistoryRetryStateForTests(): void {
  inFlight = null;
  autoAttempted = false;
}
