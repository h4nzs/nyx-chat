// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.1] Token keanggotaan grup: dua jenis, satu sumbu epoch.
 *
 *  - **Group token** (`Conversation.authSecret` = SHA-256 hex): 256-bit opaque,
 *    dipegang semua anggota era itu, dipakai untuk mutasi/metadata (header
 *    `X-Group-Token`) dan (nanti) posting mailbox. Rotasi = epoch naik; token
 *    era lama otomatis mati tanpa harus menghapus baris siapa pun.
 *  - **Member token** (`UserHiddenConversation.tokenHash`): 256-bit, satu per
 *    anggota, dipakai untuk discovery (`POST /api/groups/sync`) dan routing
 *    delivery. Kick/leave menghapus barisnya; itu pencabutan paling langsung.
 *
 * Token mentah tidak pernah persist: yang disimpan hanya SHA-256. Token 256-bit
 * tidak bisa di-brute force, jadi pepper tidak diperlukan (pola `adminSecretHash`).
 *
 * TTL: group token 24 jam (rotasi terjadwal = PCS kasar), member token 7 hari
 * dengan sliding refresh. `TOKEN_REFRESH_GRACE_MS` memberi jendela bagi klien
 * offline untuk pull + refresh, TIDAK untuk post.
 */

import { randomBytes } from 'node:crypto'
import { credentialTokenMatches, hashCredentialToken } from './atRestSecrets.js'

export const MEMBER_TOKEN_BYTES = 32
/** Panjang base64url tanpa padding dari 32 byte. */
export const OPAQUE_TOKEN_LENGTH = 43
export const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const GROUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** Token yang kedaluwarsa ≤ jendela ini masih boleh pull + refresh, tidak boleh post. */
export const TOKEN_REFRESH_GRACE_MS = 24 * 60 * 60 * 1000

export function isOpaqueToken (value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN_RE.test(value)
}

/** SHA-256 hex dari token (kolom DB). */
export function hashGroupToken (token: string): string {
  return hashCredentialToken(token)
}

/** Token acak 256-bit (base64url 43 karakter). */
export function newOpaqueToken (): string {
  return randomBytes(MEMBER_TOKEN_BYTES).toString('base64url')
}

export function memberTokenExpiry (now: Date = new Date()): Date {
  return new Date(now.getTime() + MEMBER_TOKEN_TTL_MS)
}

export function groupTokenExpiry (now: Date = new Date()): Date {
  return new Date(now.getTime() + GROUP_TOKEN_TTL_MS)
}

/** Bandingkan token grup yang dipresentasikan dengan hash tersimpan (timing-safe). */
export function groupTokenMatches (storedHash: string | null | undefined, presented: string): boolean {
  return credentialTokenMatches(storedHash ?? null, presented)
}

export type MemberTokenStatus = 'ok' | 'refresh' | 'stale'

/**
 * Status token anggota terhadap grupnya.
 *
 * `stale` = epoch tidak cocok (kick/rotasi) ATAU kedaluwarsa melewati grace.
 * `refresh` = masih sah untuk pull tetapi TTL sudah lewat (atau tinggal < 25%
 * dari TTL) sehingga klien harus memanggil `/token/refresh`.
 */
export function evaluateMemberToken (
  row: { tokenEpoch: number; expiresAt: Date | string },
  groupEpoch: number,
  now: Date = new Date()
): MemberTokenStatus {
  if (row.tokenEpoch !== groupEpoch) return 'stale'
  const expiresAt = new Date(row.expiresAt).getTime()
  if (expiresAt <= now.getTime() - TOKEN_REFRESH_GRACE_MS) return 'stale'
  const remaining = expiresAt - now.getTime()
  if (remaining <= MEMBER_TOKEN_TTL_MS / 4) return 'refresh'
  return 'ok'
}

// --- Bentuk klien Prisma minimal (bivarian; PrismaClient asli di-cast di call site) ---

export interface GroupTokenConversationRow {
  id: string
  isGroup?: boolean
  authSecret?: string | null
  groupEpoch?: number
  groupTokenExpiresAt?: Date | null
  // [docs/37 §37.3.6] Dipakai `GET /api/groups/:id/epoch` untuk keputusan PCS.
  epochRotatedAt?: Date | null
  createdAt?: Date | null
  messageSeq?: number | null
}

export interface GroupTokenDb {
  conversation: {
    findUnique (args: {
      where: { id: string }
      select?: Record<string, boolean>
    }): Promise<GroupTokenConversationRow | null>
    update (args: {
      where: { id: string }
      data: Record<string, unknown>
      select?: Record<string, boolean>
    }): Promise<GroupTokenConversationRow>
  }
  userHiddenConversation: {
    findUnique (args: {
      where: { tokenHash: string }
      select?: Record<string, boolean>
    }): Promise<{
      id: string
      conversationId: string
      tokenEpoch: number
      expiresAt: Date
    } | null>
    update (args: {
      where: { id: string }
      data: Record<string, unknown>
    }): Promise<unknown>
    updateMany (args: {
      where: { conversationId: string }
      data: Record<string, unknown>
    }): Promise<{ count: number }>
    delete (args: { where: { id: string } }): Promise<unknown>
  }
}

/**
 * Rotasi token grup + naikkan epoch.
 *
 * `groupEpoch` di-increment oleh DB (bukan read-then-write) supaya dua kick
 * bersamaan tidak menghasilkan epoch yang sama. Token baru dikembalikan mentah
 * HANYA ke pemanggil (admin) untuk didistribusikan lewat mailbox; server tidak
 * menyimpannya.
 */
export async function rotateGroupToken (
  db: GroupTokenDb,
  conversationId: string,
  now: Date = new Date()
): Promise<{ token: string; epoch: number; expiresAt: Date }> {
  const token = newOpaqueToken()
  const expiresAt = groupTokenExpiry(now)
  const updated = await db.conversation.update({
    where: { id: conversationId },
    data: {
      authSecret: hashGroupToken(token),
      groupEpoch: { increment: 1 },
      groupTokenExpiresAt: expiresAt,
      epochRotatedAt: now,
    },
    select: { id: true, groupEpoch: true },
  })
  const epoch = updated.groupEpoch ?? 0
  // Member token era baru tetap dipegang anggota yang sama; tanpa update ini
  // setiap rotasi membuat SEMUA baris anggota stale (sync/refresh mati).
  await db.userHiddenConversation.updateMany({
    where: { conversationId },
    data: { tokenEpoch: epoch },
  })
  return { token, epoch, expiresAt }
}

/**
 * Perpanjang TTL member token (sliding). Hanya dipanggil setelah status
 * `ok`/`refresh` — token `stale` tidak boleh dihidupkan kembali.
 */
export async function refreshMemberToken (
  db: GroupTokenDb,
  rowId: string,
  now: Date = new Date()
): Promise<{ expiresAt: Date }> {
  const expiresAt = memberTokenExpiry(now)
  await db.userHiddenConversation.update({ where: { id: rowId }, data: { expiresAt } })
  return { expiresAt }
}
