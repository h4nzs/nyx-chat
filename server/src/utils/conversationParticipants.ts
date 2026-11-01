// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 2 — REG-2/N-01/N-02] Bukti "orang ini peserta percakapan ITU",
 * diturunkan server, per percakapan.
 *
 * Percakapan 1:1 di NYX tidak punya roster apa pun di server: `Conversation`
 * tidak menyimpan peserta, `Message.senderId` NULL (sealed sender), dan baris
 * `UserHiddenConversation` hanya ditulis untuk penerima yang mengirim delivery
 * token — padahal klien TIDAK mengirim `targetDeliveryTokens` untuk 1:1
 * (`web/src/store/message.ts` hanya mengisinya untuk grup). Gate F-05/F-11 yang
 * memakai daftar peer global (`collectPresencePeers`) karena itu selalu kosong
 * untuk 1:1 dan untuk pembuat grup: typing mati dan pemulihan session key 1:1
 * ditolak dengan hening.
 *
 * Bukti yang BENAR-BENAR dipegang server per percakapan, berurutan dari yang
 * paling murah:
 *
 *   1. baris keanggotaan `UserHiddenConversation` (userId ter-seal) — anggota
 *      grup era token-first, juga penerima pesan grup yang membawa token;
 *   2. receipt `MessageStatus` — kolom `userId`-nya tag opaque turunan server
 *      (`conversationScopedTag(conversationId, userId)`), jadi server bisa
 *      memeriksa keanggotaan tanpa menyimpan userId:
 *      `where: { userId: tag, message: { conversationId } }`;
 *   3. `SessionKey` milik perangkat user itu pada percakapan tersebut
 *      (`where: { conversationId, device: { userId } }`) — ini yang membuat
 *      pemulihan kunci 1:1 bekerja walau penerima belum pernah mengirim receipt
 *      (kasus "B mengirim pesan pertama, A belum bisa dekripsi").
 *
 * Tidak satu pun berasal dari deklarasi klien, dan semuanya ter-scope ke
 * `conversationId` — sehingga event realtime tidak bisa dipakai menyemprot id
 * sembarang atau percakapan lain (N-02).
 *
 * CATATAN batas jujur: ini bukti keanggotaan, bukan bukti "pesan ini dikirim ke
 * dia". Untuk pesan view-once di grup, peserta lain tetap bisa memicu
 * penghapusan lebih awal (skema tidak menyimpan penerima per pesan) — residual
 * yang sama seperti sebelum audit, kini dibatasi ke baris `isViewOnce`.
 */

import { conversationScopedTag } from './atRestSecrets.js'
import {
  filterConversationMembers,
  type ConversationMembershipLookup,
} from './routingIdentity.js'

/** Bentuk minimal klien Prisma untuk satu pencarian kepemilikan baris. */
export interface ParticipantRowLookup {
  findFirst(args: {
    where: Record<string, unknown>
    select: { id?: boolean }
  }): Promise<{ id?: string } | null>
}

export interface ConversationParticipantDb extends ConversationMembershipLookup {
  messageStatus: ParticipantRowLookup
  sessionKey: ParticipantRowLookup
}

/**
 * Batas pemeriksaan per-kandidat (2 query tiap kandidat). Target yang sudah
 * lolos lewat baris keanggotaan tidak terkena batas ini; sisanya hampir selalu
 * 1 id (typing 1:1, `requesterId` pada fulfill_response).
 */
export const MAX_PARTICIPANT_FALLBACK_CHECKS = 8

function isCandidate(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 64
}

/**
 * Bukti keanggotaan untuk SATU user pada SATU percakapan.
 * Dipakai langsung oleh gate yang hanya punya satu kandidat
 * (`session:fulfill_response`, penerima `message:view_once_opened`).
 */
export async function isConversationParticipant(
  db: ConversationParticipantDb,
  conversationId: string,
  userId: unknown
): Promise<boolean> {
  if (!isCandidate(userId) || !conversationId) return false

  // 1. Baris keanggotaan (sealed userId, kandidat key ring).
  const membership = await filterConversationMembers(db, conversationId, [userId]).catch(() => [] as string[])
  if (membership.length > 0) return true

  // 2. Receipt milik user ini di percakapan tersebut (tag opaque server).
  const tag = conversationScopedTag(conversationId, userId)
  const receipt = await db.messageStatus
    .findFirst({ where: { userId: tag, message: { conversationId } }, select: { id: true } })
    .catch(() => null)
  if (receipt !== null) return true

  // 3. Session key perangkat user ini pada percakapan tersebut.
  const sessionKey = await db.sessionKey
    .findFirst({ where: { conversationId, device: { userId } }, select: { id: true } })
    .catch(() => null)
  return sessionKey !== null
}

/**
 * Saring daftar target ke peserta percakapan yang disebut payload.
 * Satu query untuk semua target yang punya baris keanggotaan, lalu fallback
 * per-kandidat (dibatasi `MAX_PARTICIPANT_FALLBACK_CHECKS`) untuk sisanya.
 */
export async function filterConversationParticipants(
  db: ConversationParticipantDb,
  conversationId: string,
  userIds: unknown[]
): Promise<string[]> {
  const wanted = Array.from(new Set(userIds.filter(isCandidate)))
  if (wanted.length === 0 || !conversationId) return []

  const members = new Set(
    await filterConversationMembers(db, conversationId, wanted).catch(() => [] as string[])
  )
  const remaining = wanted
    .filter((userId) => !members.has(userId))
    .slice(0, MAX_PARTICIPANT_FALLBACK_CHECKS)

  const fallback = new Set<string>()
  await Promise.all(remaining.map(async (userId) => {
    if (await isConversationParticipant(db, conversationId, userId).catch(() => false)) {
      fallback.add(userId)
    }
  }))

  return wanted.filter((userId) => members.has(userId) || fallback.has(userId))
}
