// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.5 / D14] Presence lazy/opt-in — langganan per-kontak.
 *
 * Sebelumnya klien menerima snapshot peer begitu connect (dan tiap join/leave
 * di-fan-out ke semua peer yang online). Dua masalah:
 *   1. Sinyal presensi tetap datang **tanpa diminta** — klien yang tidak sedang
 *      menampilkan chat pun menerima aktivitas orang lain.
 *   2. Fan-out berbasis daftar peer: biaya & kebocoran tumbuh dengan ukuran
 *      graph, bukan dengan apa yang benar-benar dilihat pengguna.
 *
 * Sekarang: klien **meminta** presence untuk kontak yang sedang ia tampilkan
 * (`presence:subscribe`), server memvalidasi bahwa peminta memang peer dari
 * target (lihat realtimeHandlers — daftar peer diturunkan server dari
 * `UserHiddenConversation`, bukan dari deklarasi klien), lalu hanya mengirim
 * join/leave ke klien yang berlangganan.
 *
 * Registry hidup **hanya di memori**: tidak ada userId yang masuk Redis/DB,
 * otomatis hilang saat proses mati atau saat koneksi ditutup
 * (`clearPresenceSubscriptions`). Tidak ada artefak untuk di-dump.
 */

/** Batas langganan per klien — mencegah satu klien menahan ribuan entri. */
export const MAX_PRESENCE_SUBSCRIPTIONS = 1000;

/** subscriber (klien) → peer yang ia langgani. */
const subscriptions = new Map<string, Set<string>>();
/** peer → klien yang berlangganan dirinya (indeks balik untuk fan-out). */
const watchers = new Map<string, Set<string>>();

function normalize(ids: Iterable<string>, selfId: string): string[] {
  const result = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && id !== selfId) result.add(id);
  }
  return Array.from(result);
}

/**
 * Ganti seluruh langganan `subscriberId` dengan `peerIds` (idempoten — klien
 * boleh memanggil ulang tiap navigasi/refresh). Mengembalikan daftar peer yang
 * akhirnya disimpan.
 */
export function subscribePresence(subscriberId: string, peerIds: Iterable<string>): string[] {
  const next = normalize(peerIds, subscriberId).slice(0, MAX_PRESENCE_SUBSCRIPTIONS);
  clearPresenceSubscriptions(subscriberId);

  if (next.length > 0) {
    subscriptions.set(subscriberId, new Set(next));
    for (const peerId of next) {
      let set = watchers.get(peerId);
      if (!set) {
        set = new Set<string>();
        watchers.set(peerId, set);
      }
      set.add(subscriberId);
    }
  }
  return next;
}

/** Buang semua langganan klien (dipakai saat disconnect/force-logout). */
export function clearPresenceSubscriptions(subscriberId: string): void {
  const current = subscriptions.get(subscriberId);
  if (!current) return;
  subscriptions.delete(subscriberId);
  for (const peerId of current) {
    const set = watchers.get(peerId);
    if (!set) continue;
    set.delete(subscriberId);
    if (set.size === 0) watchers.delete(peerId);
  }
}

/** Apakah `subscriberId` sedang berlangganan `peerId`? */
export function isWatchingPresence(subscriberId: string, peerId: string): boolean {
  return subscriptions.get(subscriberId)?.has(peerId) ?? false;
}

/** Daftar klien yang berlangganan `peerId`. */
export function presenceWatchersOf(peerId: string): string[] {
  const set = watchers.get(peerId);
  return set ? Array.from(set) : [];
}

/** Hook test: kosongkan seluruh registry. */
export function clearAllPresenceSubscriptions(): void {
  subscriptions.clear();
  watchers.clear();
}

/**
 * Fan-out ke klien yang berlangganan `peerId` saja. `sender` disuntikkan
 * pemanggil (menghindari impor sirkular dengan redisBridge) dan dipanggil per
 * target. Selalu best-effort: satu target gagal tidak menghentikan sisanya.
 */
export async function notifyPresenceWatchers(
  peerId: string,
  send: (targetUserId: string) => Promise<unknown>
): Promise<number> {
  const targets = presenceWatchersOf(peerId);
  let sent = 0;
  for (const target of targets) {
    try {
      await send(target);
      sent += 1;
    } catch {
      // best-effort: presence bukan jalur kritis
    }
  }
  return sent;
}
