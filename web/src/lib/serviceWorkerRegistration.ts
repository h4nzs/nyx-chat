import { Workbox } from 'workbox-window';
import { useConversationStore } from '@store/conversation';

/**
 * [R2 2026-10-15] Paksa pembaruan service worker.
 *
 * Kenapa perlu: `sw.ts` memakai `skipWaiting()` + `clientsClaim()`, jadi service
 * worker BARU langsung mengambil alih — tetapi halaman yang sedang berjalan
 * tetap mengeksekusi bundel LAMA sampai dimuat ulang. Pada aplikasi ini itu bukan
 * kosmetik: klien yang masih memegang bundel pra-3.0.0 terus menolak envelope
 * grup v2 dan pengguna kehilangan pesan grup tanpa gejala. Jadi setelah SW baru
 * mengambil alih, halaman memuat ulang dirinya.
 *
 * Penanda `sessionStorage` (bukan `localStorage`, dan bukan variabel modul)
 * mencegah reload berantai: satu deploy = satu reload per tab, dan reload itu
 * sendiri tidak memicu reload berikutnya. Penanda dibaca lewat helper yang
 * menelan pengecualian (mode privasi ketat): kalau tidak bisa dibaca, kita
 * TIDAK reload — menahan diri lebih baik daripada berisiko loop.
 */
export const SW_RELOAD_MARKER = 'nyx:sw-reloaded';

export interface ServiceWorkerUpdateEffects {
  /** `event.isUpdate` dari Workbox. */
  isUpdate: boolean;
  /** Apakah tab ini sudah pernah memuat ulang karena pembaruan SW. */
  alreadyReloaded: boolean;
  /** Sinkronkan data setelah SW baru mengambil alih (mis. re-fetch percakapan). */
  resync: () => void;
  /** Muat ulang halaman (disuntik supaya bisa diuji tanpa DOM). */
  reload: () => void;
  /** Tandai bahwa reload sudah terjadi. */
  markReloaded: () => void;
}

/** @returns true bila halaman dimuat ulang. */
export function handleServiceWorkerUpdate(effects: ServiceWorkerUpdateEffects): boolean {
  if (!effects.isUpdate) return false;

  // Selalu resync: data yang di-cache SW berubah walau kita tidak reload.
  effects.resync();

  if (effects.alreadyReloaded) return false;

  effects.markReloaded();
  effects.reload();
  return true;
}

export function readReloadMarker(): boolean {
  try {
    return sessionStorage.getItem(SW_RELOAD_MARKER) === '1';
  } catch {
    // Tidak bisa membaca penanda → perlakukan sebagai "sudah pernah" agar tidak
    // ada risiko reload berulang.
    return true;
  }
}

export function writeReloadMarker(): void {
  try {
    sessionStorage.setItem(SW_RELOAD_MARKER, '1');
  } catch {
    /* diabaikan — lihat readReloadMarker */
  }
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    const wb = new Workbox('/sw.js');

    wb.addEventListener('activated', (event) => {
      // This event is fired when the new service worker has taken control.
      // It's a good time to reload data if a new SW has taken over.
      handleServiceWorkerUpdate({
        // `isUpdate` opsional di tipe Workbox — perlakukan hanya `true` sebagai update.
        isUpdate: event.isUpdate === true,
        alreadyReloaded: readReloadMarker(),
        // Use the store action to re-fetch conversations
        resync: () => useConversationStore.getState().resyncState(),
        reload: () => window.location.reload(),
        markReloaded: writeReloadMarker,
      });
    });

    // Register the service worker.
    wb.register();
  }
}
