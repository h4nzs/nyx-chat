// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Resolusi anonymous sync: token di body → baris keanggotaan
 * → percakapan. Modul ini SENGAJA tidak mengenal `userId`: jalur sync tidak
 * boleh menulis atau membaca routing identity, dan tidak boleh memanggil
 * `requireAuth`. Semua pemetaan dilakukan lewat hash token.
 *
 * Dipisah dari route supaya bisa diuji sebagai perilaku dengan klien Prisma
 * palsu (pola `groupAccess.ts`), tanpa Postgres/Redis.
 */

import {
  evaluateMemberToken,
  hashGroupToken,
  type MemberTokenStatus,
} from './groupTokens.js'

/** Kolom percakapan yang dibutuhkan output sync (subset `Conversation`). */
export interface SyncConversationRow {
  id: string
  isGroup?: boolean
  encryptedMetadata?: string | null
  lastMessageAt?: Date | null
  createdAt?: Date
  updatedAt?: Date
  groupEpoch?: number
  groupTokenExpiresAt?: Date | null
}

export interface SyncDb {
  userHiddenConversation: {
    findMany (args: {
      where: { tokenHash: { in: string[] } }
      select?: Record<string, boolean>
    }): Promise<Array<{
      id: string
      conversationId: string
      tokenEpoch: number
      expiresAt: Date
      tokenHash: string
    }>>
  }
  conversation: {
    findMany (args: {
      where: { id: { in: string[] } }
      select?: Record<string, boolean>
    }): Promise<SyncConversationRow[]>
  }
}

export interface SyncMembership {
  /** Indeks token pada array input — tidak pernah mengembalikan hash/token. */
  index: number
  status: MemberTokenStatus
  conversationId: string
  epoch: number
  expiresAt: Date
}

export interface SyncResolution {
  memberships: SyncMembership[]
  conversations: SyncConversationRow[]
  /** Token yang tidak dikenal (miss) — jumlahnya saja yang dipakai metrik. */
  unknown: number
  /** Conversation yang epoch/tokennya basi, untuk log/metrik agregat. */
  stale: number
  /** True = klien mengirim lebih dari `MAX_SYNC_TOKENS`; sisanya TIDAK diproses. */
  truncated: boolean
}

/**
 * [audit F-10] Batas dokumen `docs/37` §37.3.3 (≤200 item). Dulu 500: satu
 * request anonim tanpa sesi bisa memaksa 500 lookup hash + metadata grup, dan
 * responsnya bisa melewati 256 KB yang dijanjikan dokumen. Endpoint yang sama
 * juga bisa dipanggil lewat OHTTP dengan body 64 KB, jadi batas ini yang
 * menjaga biaya per request tetap terukur.
 */
export const MAX_SYNC_TOKENS = 200

/**
 * Petakan token mentah ke percakapan yang masih sah.
 *
 * Konsekuensi privasi yang dijaga di sini:
 *  - tidak ada query yang menyentuh `userHiddenConversation.userId`;
 *  - pencocokan memakai `tokenHash` (unique) — token mentah tidak pernah
 *    menjadi nilai query, jadi tidak muncul di log query Prisma;
 *  - token ganda dalam satu request dicari sekali (satu hash unik), tetapi
 *    setiap indeks asli tetap dilaporkan agar klien me-refresh token yang benar.
 */
export async function resolveSyncMemberships (
  db: SyncDb,
  tokens: readonly string[],
  now: Date = new Date()
): Promise<SyncResolution> {
  const submitted = tokens.slice(0, MAX_SYNC_TOKENS)
  // Pemotongan dilaporkan, bukan disembunyikan: klien yang mengirim 500 token
  // hanya mendapat jawaban untuk 200 pertama dan harus tahu itu.
  const truncated = tokens.length > submitted.length
  if (submitted.length === 0) {
    return { memberships: [], conversations: [], unknown: 0, stale: 0, truncated }
  }

  // `index` harus menunjuk array token ASLI yang dikirim klien (dipakai untuk
  // refresh), bukan array hasil dedup — token duplikat sebelum token lain bisa
  // menggeser indeks dan membuat klien me-refresh token yang salah.
  const hashToIndexes = new Map<string, number[]>()
  submitted.forEach((token, index) => {
    const hash = hashGroupToken(token)
    const list = hashToIndexes.get(hash) ?? []
    list.push(index)
    hashToIndexes.set(hash, list)
  })

  const rows = await db.userHiddenConversation.findMany({
    where: { tokenHash: { in: [...hashToIndexes.keys()] } },
    select: { id: true, conversationId: true, tokenEpoch: true, expiresAt: true, tokenHash: true },
  })

  const conversationIds = [...new Set(rows.map((row) => row.conversationId))]
  const conversations = conversationIds.length === 0
    ? []
    : await db.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: {
        id: true,
        isGroup: true,
        encryptedMetadata: true,
        lastMessageAt: true,
        createdAt: true,
        updatedAt: true,
        groupEpoch: true,
        groupTokenExpiresAt: true,
      },
    })

  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const memberships: SyncMembership[] = []
  const knownHashes = new Set<string>()
  let stale = 0

  for (const row of rows) {
    const conversation = byId.get(row.conversationId)
    if (!conversation) continue
    knownHashes.add(row.tokenHash)
    const status = evaluateMemberToken(row, conversation.groupEpoch ?? 0, now)
    if (status === 'stale') stale += 1
    for (const index of hashToIndexes.get(row.tokenHash) ?? []) {
      memberships.push({
        index,
        status,
        conversationId: row.conversationId,
        epoch: conversation.groupEpoch ?? 0,
        expiresAt: new Date(row.expiresAt),
      })
    }
  }

  memberships.sort((a, b) => a.index - b.index)
  // Metadata hanya untuk keanggotaan yang masih sah. Token stale (dicabut /
  // kedaluwarsa lewat grace) tidak boleh mendapat roster/enkripsi grup.
  const readableConversationIds = new Set(
    memberships
      .filter((membership) => membership.status !== 'stale')
      .map((membership) => membership.conversationId)
  )

  return {
    memberships,
    conversations: conversations.filter((conversation) => readableConversationIds.has(conversation.id)),
    unknown: hashToIndexes.size - knownHashes.size,
    stale,
    truncated,
  }
}
