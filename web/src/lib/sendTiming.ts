// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Jitter + batching kirim nyata pada mode "Maximum".
 *
 * Masalah: cover traffic menyamarkan VOLUME, tetapi pola kirim tetap membocorkan
 * percakapan. Kalau setiap pesan keluar tepat saat tombol ditekan, burst
 * ketukan (mis. 5 pesan dalam 1,2 detik) membentuk sidik jari timing yang khas
 * per user. Maximum menambahkan jeda acak 200–800 ms yang sekaligus
 * menggabungkan pesan-pesan yang jatuh di jendela yang sama.
 *
 * Urutan TIDAK berubah: semua penunggu satu jendela dilepas sekaligus dalam
 * urutan pendaftaran (setTimeout dengan deadline sama = FIFO), jadi pesan kedua
 * tidak bisa mendahului pesan pertama.
 *
 * Yang TIDAK di-jitter: cover (punya proses Poisson sendiri), pesan silent
 * (receipt/sinkronisasi kunci — menahannya memperlambat pipeline kripto), dan
 * percakapan yang bukan Maximum.
 */

export const MAXIMUM_SEND_JITTER_MIN_MS = 200;
export const MAXIMUM_SEND_JITTER_MAX_MS = 800;

/** Jeda satu jendela kirim: [200, 800] ms. */
export function planSendDelay(rng: () => number = Math.random): number {
  const unit = Math.min(1, Math.max(0, rng()));
  return Math.round(
    MAXIMUM_SEND_JITTER_MIN_MS + unit * (MAXIMUM_SEND_JITTER_MAX_MS - MAXIMUM_SEND_JITTER_MIN_MS),
  );
}

interface WindowState {
  waiters: (() => void)[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Gate per percakapan: kiriman pertama membuka jendela acak, kiriman berikutnya
 * yang datang sebelum jendela tutup ikut menunggu dan dilepas bersama.
 */
export class MaximumSendGate {
  private windows = new Map<string, WindowState>();

  /** Menunggu jendela kirim untuk percakapan ini. */
  delay(conversationId: string, rng: () => number = Math.random): Promise<void> {
    return new Promise((resolve) => {
      const existing = this.windows.get(conversationId);
      if (existing) {
        existing.waiters.push(resolve);
        return;
      }
      const state: WindowState = {
        waiters: [resolve],
        timer: setTimeout(() => {
          this.windows.delete(conversationId);
          for (const waiter of state.waiters) waiter();
        }, planSendDelay(rng)),
      };
      this.windows.set(conversationId, state);
    });
  }

  /** Jumlah kiriman yang sedang menunggu (test/diagnostik). */
  pending(conversationId: string): number {
    return this.windows.get(conversationId)?.waiters.length ?? 0;
  }

  /** Lepas semua penunggu sekarang (mis. tab akan ditutup / test cleanup). */
  flushAll(): void {
    for (const [conversationId, state] of Array.from(this.windows.entries())) {
      clearTimeout(state.timer);
      this.windows.delete(conversationId);
      for (const waiter of state.waiters) waiter();
    }
  }
}

const gate = new MaximumSendGate();

/** Apakah percakapan ini memakai mode Maximum (client-local)? */
export function isMaximumSendConversation(
  conversationId: string,
  maximumGroups: readonly string[],
): boolean {
  return conversationId.startsWith('burner_') || maximumGroups.includes(conversationId);
}

/**
 * Titik integrasi store: menunggu jendela bila percakapan Maximum dan pesan
 * bukan silent. Tidak pernah melempar — kegagalan mode privasi tidak boleh
 * menggagalkan pengiriman pesan user.
 */
export async function applyMaximumSendDelay(
  conversationId: string,
  options: { silent?: boolean; maximumGroups?: readonly string[] } = {},
): Promise<void> {
  if (options.silent) return;
  try {
    const groups = options.maximumGroups ?? await loadMaximumGroups();
    if (!isMaximumSendConversation(conversationId, groups)) return;
    await gate.delay(conversationId);
  } catch {
    // Gagal membaca settings = kirim tanpa jitter (fungsional > sempurna).
  }
}

async function loadMaximumGroups(): Promise<readonly string[]> {
  const { useSettingsStore } = await import('@store/settings');
  const state = useSettingsStore.getState();
  if (!state.coverTrafficMasterEnabled) return [];
  return state.coverTrafficMaximumGroups;
}

/** Test-only: lepas semua jendela aktif. */
export function _resetSendTimingForTests(): void {
  gate.flushAll();
}
