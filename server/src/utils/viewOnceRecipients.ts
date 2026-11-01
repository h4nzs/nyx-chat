// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [PASS-2 residual — view-once: siapa penerima pesan ini?]
 *
 * Sebelum ini skema tidak menyimpan daftar penerima per pesan, sehingga
 * "semua orang sudah membuka" tidak bisa dihitung: baris pesan grup harus
 * bertahan sampai `expiresAt` walau semua penerima sudah membukanya (kalau
 * dihapus pada pembukaan pertama, anggota lain kehilangan pesannya).
 *
 * Sekarang saat kirim (hanya untuk `isViewOnce`) tag penerima dicatat di
 * `MessageViewOnceRecipient`, sejajar dengan `MessageViewOnceOpen`. Saat
 * penerima membuka, server membandingkan dua angka:
 *
 *   count(MessageViewOnceOpen)       >= count(MessageViewOnceRecipient)
 *
 * dan menghapus baris pesan pada saat itu juga — bukan menunggu TTL 14 hari.
 * Penerima yang tidak pernah membuka tidak punya mekanisme tunggu sendiri;
 * baris penerima ikut terhapus bersama pesannya (onDelete: Cascade), dan bila
 * sampai `expiresAt` belum lengkap, message sweeper yang menghapusnya.
 *
 * SIFAT PRIVASI (kenapa ini TIDAK membatalkan sealed sender):
 *  - kolomnya `conversationScopedTag(conversationId, userId)` — HMAC ber-pepper,
 *    bukan userId. Deterministik per (percakapan, user) supaya upsert idempoten,
 *    tetapi berbeda antar percakapan sehingga dump DB tidak bisa mengaitkan
 *    "orang yang sama" lintas chat, dan tanpa pepper tidak bisa dibalik jadi id.
 *  - server SUDAH memegang daftar ini pada saat relay (`targetRecipients` dari
 *    klien + baris keanggotaan), jadi tidak ada pengetahuan baru — yang berubah
 *    hanya bahwa daftar penerima *tidak lagi dibuang* setelah relay.
 *  - daftar dari klien TIDAK dipercaya apa adanya: hanya id yang lolos bukti
 *    peserta server (`filterConversationParticipants`) yang dicatat, dan
 *    pengirim dibuang. Klien yang menghilangkan anggota hanya membuat dirinya
 *    sendiri tidak terkirim pesan (relay memakai daftar yang sama).
 *  - server tidak pernah membaca isi pesan; yang dihitung hanya baris.
 */

import { conversationScopedTag } from './atRestSecrets.js'
import {
  filterConversationParticipants,
  type ConversationParticipantDb,
} from './conversationParticipants.js'

/** Bentuk minimal klien Prisma yang dibutuhkan modul ini (mudah di-fake). */
export interface ViewOnceRecipientDb extends ConversationParticipantDb {
  messageViewOnceRecipient: {
    createMany(args: {
      data: Array<{ messageId: string; recipientTag: string }>
      skipDuplicates?: boolean
    }): Promise<{ count: number }>
    count(args: { where: Record<string, unknown> }): Promise<number>
  }
  messageViewOnceOpen: {
    count(args: { where: Record<string, unknown> }): Promise<number>
  }
  message: {
    delete(args: { where: { id: string } }): Promise<unknown>
  }
}

/**
 * Catat penerima view-once SATU pesan.
 *
 * @returns jumlah tag yang benar-benar dicatat (0 = bukan view-once / tak ada
 *          penerima sah). Kegagalan pemanggil diperlakukan non-fatal: pesan
 *          sudah tersimpan dan relay jangan ikut gagal karena pencatatan ini.
 */
export async function recordViewOnceRecipients(
  db: ViewOnceRecipientDb,
  opts: {
    conversationId: string
    messageId: string
    senderId: string
    recipients: readonly unknown[]
  }
): Promise<number> {
  const { conversationId, messageId, senderId, recipients } = opts
  if (!conversationId || !messageId || recipients.length === 0) return 0

  // Hanya id yang lolos bukti peserta SERVER; pengirim tidak pernah "membuka"
  // pesannya sendiri, jadi membuangnya membuat hitungan bisa selesai.
  const verified = await filterConversationParticipants(
    db,
    conversationId,
    recipients.filter((id) => id !== senderId)
  )
  if (verified.length === 0) return 0

  const data = Array.from(new Set(verified)).map((userId) => ({
    messageId,
    recipientTag: conversationScopedTag(conversationId, userId),
  }))

  await db.messageViewOnceRecipient.createMany({ data, skipDuplicates: true })
  return data.length
}

/**
 * Hapus baris pesan bila SEMUA penerima yang tercatat sudah membuka.
 *
 * @returns `true` kalau baris dihapus. Penerima yang tidak pernah membuka tidak
 *          menahan apa pun selain baris pesan itu sendiri (lihat catatan modul):
 *          `expiresAt` + message sweeper adalah batas akhirnya.
 */
export async function finalizeViewOnceIfAllOpened(
  db: ViewOnceRecipientDb,
  opts: { messageId: string }
): Promise<boolean> {
  const { messageId } = opts
  if (!messageId) return false

  const [recipients, opened] = await Promise.all([
    db.messageViewOnceRecipient.count({ where: { messageId } }),
    db.messageViewOnceOpen.count({ where: { messageId } }),
  ])
  // Tanpa daftar penerima (pesan lama sebelum kolom ini ada) jangan menebak:
  // jalur 1:1 tetap menghapus lewat pemanggilnya, grup menunggu `expiresAt`.
  if (recipients === 0 || opened < recipients) return false

  await db.message.delete({ where: { id: messageId } })
  return true
}
