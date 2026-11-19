// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.3] Sinkronisasi antar-tab untuk cermin SQLite.
 *
 * Dua tab berbagi satu database OPFS. Tanpa kanal ini, tab yang tidak melakukan
 * penulisan baru tahu isinya setelah reload: pratinjau percakapan tetap yang
 * lama, dan pesan yang sudah dihapus di tab lain masih terlihat di panel chat.
 *
 * Payload hanya id lokal (`conversationId`, atau `null` bila cakupannya tidak
 * diketahui — mis. hapus berdasarkan id pesan). BroadcastChannel tidak melewati
 * server, jadi tidak ada metadata yang keluar dari perangkat; nama kanal tetap
 * dan tidak memuat identifier apa pun.
 */

const CHANNEL_NAME = 'nyx-db';

export interface DbBroadcastEvent {
  type: 'messages-changed';
  /** `null` = cakupan tidak diketahui; penerima menyegarkan percakapan terbuka. */
  conversationId: string | null;
}

let channel: BroadcastChannel | null = null;

/** `null` bila lingkungan tidak punya BroadcastChannel (SSR, sebagian test). */
function channelOrNull(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function post(event: DbBroadcastEvent): void {
  try {
    channelOrNull()?.postMessage(event);
  } catch {
    // Kanal hanya optimisasi tampilan; kegagalannya tidak boleh menggagalkan
    // penulisan data yang sudah berhasil.
  }
}

/**
 * Dipanggil SETELAH cermin SQLite sukses ditulis, supaya tab lain tidak
 * menyegarkan sesuatu yang sebenarnya gagal ditulis.
 */
export function broadcastMessagesChanged(conversationId: string | null): void {
  post({ type: 'messages-changed', conversationId });
}

/** Bentuk pesan diperiksa ketat walau kanal hanya menerima konteks yang sama. */
function isEvent(value: unknown): value is DbBroadcastEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; conversationId?: unknown };
  if (candidate.type !== 'messages-changed') return false;
  return candidate.conversationId === null || typeof candidate.conversationId === 'string';
}

export function onDbBroadcast(handler: (event: DbBroadcastEvent) => void): () => void {
  const next = channelOrNull();
  if (!next) return () => {};
  const listener = (message: MessageEvent) => {
    if (isEvent(message.data)) handler(message.data);
  };
  next.addEventListener('message', listener);
  return () => next.removeEventListener('message', listener);
}

/** Test-only: lepas kanal supaya tidak bocor antar-tes. */
export function resetDbBroadcastForTests(): void {
  channel?.close();
  channel = null;
}
