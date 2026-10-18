// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Receipt untuk pesan yang BARU TIBA / ter-sinkron =
 * `DELIVERED`, bukan `READ`.
 *
 * Gejala yang dilaporkan: bubble pesan selalu langsung berubah jadi centang
 * biru (dibaca) padahal penerima tidak sedang membuka percakapannya — apalagi
 * me-render pesannya. Penyebabnya dua jalur "pesan masuk" dulu mengirim
 * receipt READ di luar konteks tampilan:
 *   - `doAddIncomingMessage` (pesan tiba live lewat transport);
 *   - `loadMessagesForConversation` (sync/backfill saat connect untuk SEMUA
 *     percakapan, bukan hanya yang sedang dibuka).
 *
 * Kontrak yang berlaku sekarang (satu arah yang jelas):
 *   - Pesan yang hanya TIBA/Tersinkron → `DELIVERED` (dikirim dari sini);
 *   - Pesan yang benar-benar TERLIHAT di layar percakapan yang terbuka → `READ`
 *     (ChatWindow + IntersectionObserver di MessageItem — satu-satunya jalur
 *     yang boleh mengirim READ, karena hanya di sana "dibaca" itu benar).
 *
 * Efek samping yang penting: receipt READ di jalur 1:1 mempersempit TTL
 * ciphertext server (`expiresAt` = 24 jam setelah READ). Dengan READ sekarang
 * hanya datang dari pesan yang sungguh dilihat, penyempitan TTL itu kembali
 * berarti "sudah dibaca" — bukan "kebetulan baru masuk".
 *
 * Transport-agnostic: `messages:mark_delivered` terdaftar di kedua jalur
 * (WT → KEY_SYNC `handleKeySync`, WSS → `WSS_KEYS_SYNC_EVENTS`), berbeda dari
 * opcode ACK yang di WSS justru jatuh ke handler pending-ACK (`handleAck`).
 */

/** Bentuk minimal pesan yang bisa di-receipt (id + pengirim asli/pseudonym). */
export interface ReceiptableMessage {
  id: string;
  senderId?: string | null;
}

/** Emitter minimal — `transportClient` memenuhinya; tes cukup memakai fake. */
export interface ReceiptEmitter {
  sendEvent(event: string, data?: unknown): void;
}

/** Nama event batch receipt "terkirim" (satu-satunya jalur receipt di sini). */
export const DELIVERY_RECEIPT_EVENT = 'messages:mark_delivered';

/** Batas per event = `BATCH_RECEIPT_MAX` di server (handleMessageStatusBatchUpdate). */
export const RECEIPT_CHUNK_SIZE = 100;

/**
 * Kirim receipt `DELIVERED` untuk pesan yang baru tiba/ter-sinkron.
 *
 * `targets` memetakan messageId → pengirim karena DB 1:1 sealed-sender
 * menyimpan `senderId` NULL — tanpa peta itu server tidak tahu ke siapa
 * notifikasi status harus dikirim. Kembaliannya = jumlah chunk terkirim
 * (0 bila tidak ada yang layak di-receipt), dipakai tes & pemanggil.
 */
export function sendDeliveryReceipts(
  emitter: ReceiptEmitter,
  conversationId: string,
  messages: ReceiptableMessage[],
  readerPseudonym?: string,
): number {
  const unique = new Map<string, string>();
  for (const m of messages) {
    if (!m || typeof m.id !== 'string' || m.id.length === 0) continue;
    if (typeof m.senderId !== 'string' || m.senderId.length === 0) continue;
    unique.set(m.id, m.senderId);
  }
  if (unique.size === 0) return 0;

  const entries = [...unique.entries()];
  let sent = 0;
  for (let i = 0; i < entries.length; i += RECEIPT_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + RECEIPT_CHUNK_SIZE);
    emitter.sendEvent(DELIVERY_RECEIPT_EVENT, {
      conversationId,
      messageIds: chunk.map(([id]) => id),
      targets: Object.fromEntries(chunk),
      readerPseudonym,
    });
    sent++;
  }
  return sent;
}
