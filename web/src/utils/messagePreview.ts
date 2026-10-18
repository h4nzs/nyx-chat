// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Preview baris terakhir di daftar percakapan (`ChatList`).
 *
 * Dua bug nyata yang disatukan di sini:
 *
 *  1. **Preview "belum ada pesan" padahal ada isi.** Beberapa pesan kontrol
 *     memang tidak punya representasi visual (`CALL_INIT`, `GHOST_SYNC`,
 *     `PROFILE_SYNC`, `COVER`, `GROUP_KEY`, `UNSEND`, `reaction_remove`,
 *     `SYSTEM_KEY_REQUEST`, `STORY_KEY`). Sebelumnya:
 *       • `withPreview` hanya mengenali 4 tipe; sisanya jatuh ke cabang
 *         terakhir sehingga payload JSON MENTAH dipakai sebagai preview
 *         (`{"type":"PROFILE_SYNC","profileKey":…}`) — nilai itu bahkan ikut
 *         bocor ke daftar chat;
 *       • pesan-pesan itu tetap disimpan ke vault dan tetap dipakai sebagai
 *         `lastMessage`, jadi `preview` kosong → UI menampilkan
 *         "No messages yet" untuk percakapan yang jelas punya riwayat.
 *     Aturan di modul ini: sebuah pesan hanya boleh menjadi preview bila
 *     benar-benar terlihat (teks terbaca, lampiran, atau view-once).
 *
 *  2. **Preview flaky.** `loadConversations` hanya mengambil SATU baris
 *     terbaru dari vault. Kalau baris terbaru itu kontrol (di atas), preview
 *     runtuh; kalau pesan asli masuk tepat setelah snapshot, hasil sync
 *     menimpanya. `pickPreviewLastMessage` memilih yang terbaru di antara
 *     kandidat yang VALID, sehingga hasilnya tidak lagi bergantung pada jenis
 *     baris terakhir.
 */
import type { Message } from '@nyx/shared';
import { compareMessagesByOrder } from './messageOrder';

/**
 * Tipe payload kontrol di dalam `content` yang TIDAK pernah tampil sebagai
 * bubble/preview. `silent` dan `edit` sengaja tidak ada di sini: keduanya
 * membawa teks yang memang dibaca pengguna.
 */
const HIDDEN_PAYLOAD_TYPES = new Set<string>([
  'STORY_KEY',
  'CALL_INIT',
  'GHOST_SYNC',
  'COVER',
  'GROUP_KEY',
  'PROFILE_SYNC',
  'UNSEND',
  'reaction_remove',
  'SYSTEM_KEY_REQUEST',
]);

/**
 * Turunkan `preview` dari isi pesan. Tidak pernah mengubah input: selalu
 * mengembalikan objek baru saat ada yang diturunkan, `msg` asli bila tidak.
 */
export function withPreview(msg: Message): Message {
  if (msg.content) {
    const contentToParse = msg.content.trim();
    if (contentToParse.startsWith('STORY_KEY:')) {
      return { ...msg, preview: '', isSilent: true };
    }

    // Payload JSON: reaksi, pesan "silent" (tetap terlihat), edit, dan
    // pesan kontrol yang tidak boleh muncul sama sekali.
    if (contentToParse.startsWith('{')) {
      try {
        const payload = JSON.parse(contentToParse) as { type?: string; emoji?: string; text?: string };
        if (payload.type === 'reaction') {
          return { ...msg, preview: `Reacted ${payload.emoji || ''}` };
        }
        if (payload.type === 'silent' && typeof payload.text === 'string') {
          return { ...msg, preview: payload.text, content: payload.text, isSilent: true };
        }
        if (payload.type === 'edit' && typeof payload.text === 'string') {
          return { ...msg, preview: `✎ ${payload.text}`, content: payload.text, isEdited: true };
        }
        if (payload.type && HIDDEN_PAYLOAD_TYPES.has(payload.type)) {
          return { ...msg, preview: '', isSilent: true };
        }
      } catch { /* bukan JSON — teks biasa */ }
    }

    return { ...msg, preview: msg.content };
  }

  if (msg.fileUrl) {
    if (msg.fileType?.startsWith('image/')) return { ...msg, preview: '📷 Image' };
    if (msg.fileType?.startsWith('video/')) return { ...msg, preview: '🎥 Video' };
    return { ...msg, preview: msg.fileName || 'File' };
  }

  return msg;
}

/**
 * Apakah pesan ini pantas menjadi preview daftar chat?
 *
 * `false` untuk nisan (`isDeletedLocal`), pesan kontrol, dan baris tanpa isi.
 * View-once tetap `true`: UI menampilkan label khusus untuknya.
 */
export function isPreviewableMessage(msg: Message | null | undefined): boolean {
  if (!msg) return false;
  if (msg.isDeletedLocal) return false;
  if (msg.isViewOnce) return true;
  const preview = withPreview(msg).preview;
  return typeof preview === 'string' && preview.length > 0;
}

/**
 * Pesan terbaru yang layak dijadikan preview dari sekumpulan kandidat
 * (urutan input tidak harus terurut). `null` = tidak ada yang terlihat —
 * pemanggil boleh menampilkan "belum ada pesan" hanya dalam kasus ini.
 */
export function pickPreviewLastMessage(messages: readonly Message[]): Message | null {
  let best: Message | null = null;
  for (const message of messages) {
    if (!isPreviewableMessage(message)) continue;
    if (!best || compareMessagesByOrder(message, best) > 0) best = message;
  }
  return best ? withPreview(best) : null;
}
