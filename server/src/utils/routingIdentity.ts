// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.2 — D2 lanjutan] Routing identity untuk `UserHiddenConversation`.
 *
 * Kolom `UserHiddenConversation.userId` menyimpan **userId asli** setiap anggota
 * yang mengirim delivery token. Server memang hanya memakainya untuk routing
 * (push, sweeper, broadcast profil, kick/leave) — bukan untuk discovery — tetapi
 * di dalam DUMP ia adalah daftar keanggotaan: siapa ada di grup mana, kapan.
 *
 * Perbaikan: nilainya di-**seal** (AEAD deterministik dengan kunci dari
 * `NYX_AT_REST_PEPPER`). Konsekuensi:
 *   - server tetap bisa membacanya kembali (routing jalan seperti sebelumnya),
 *   - dump DB saja tidak membuka keanggotaan (butuh pepper),
 *   - deterministik → lookup/upsert tetap bisa memakai indeks `[userId, conversationId]`,
 *   - berbeda antar nilai → tidak ada hash yang bisa dibalik/dienumerasi.
 *
 * Semua penulisan wajib lewat `upsertMembership`/`deleteMembership` di file ini
 * supaya sealing konsisten.
 */

import { openAtRest, sealAtRest } from './atRestSecrets.js'

/** Nilai kanonik untuk kolom routing (deterministik). */
export function routingIdentity(userId: string): Promise<string> {
  return sealAtRest(userId)
}

/**
 * Nilai lookup kanonik (selalu ter-seal).
 * [2026-10 legacy purge] Cabang "apa adanya" untuk baris plaintext dibuang.
 */
export async function routingCandidates(userId: string): Promise<string[]> {
  return [await sealAtRest(userId)]
}

/**
 * Terima nilai ter-seal dan kembalikan userId asli. Null bila kosong/rusak.
 * [2026-10 legacy purge] Fallback plaintext dibuang.
 */
export async function resolveRoutingUser(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null
  return openAtRest(stored)
}

/**
 * Bentuk minimal klien Prisma (metode bergaya `method()`, jadi bivarian →
 * PrismaClient asli tetap assignable lewat cast di call site).
 */
export interface MembershipPrisma extends MembershipLookup {
  userHiddenConversation: MembershipLookup['userHiddenConversation'] & {
    update(args: { where: { id: string }; data: { deliveryToken: string } }): Promise<unknown>;
    create(args: {
      data: { userId: string; conversationId: string; deliveryToken: string };
    }): Promise<unknown>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

/**
 * Bagian minimal yang dibutuhkan pembacaan keanggotaan (tanpa tulis).
 * Dipisah supaya jalur otorisasi (`utils/groupAccess.ts`) bisa memakai helper
 * yang sama tanpa harus menerima kontrak tulis — satu implementasi pencarian
 * nilai routing ter-seal untuk semua pemanggil.
 */
export interface MembershipLookup {
  userHiddenConversation: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id?: boolean };
    }): Promise<{ id?: string } | null>;
  };
}

/**
 * Upsert baris keanggotaan (conversation + delivery token) untuk seorang user.
 *
 * Memakai findFirst + nilai kanonik (bukan upsert compound-unique) supaya baris
 * yang sudah ada ter-upgrade di tempat, bukan bikin duplikat — `deliveryToken`
 * unik, jadi duplikat akan gagal tanpa jejak yang jelas.
 */
export async function upsertMembership(
  prisma: MembershipPrisma,
  input: { userId: string; conversationId: string; deliveryToken: string }
): Promise<void> {
  const candidates = await routingCandidates(input.userId)
  const existing = await prisma.userHiddenConversation.findFirst({
    where: { conversationId: input.conversationId, userId: { in: candidates } },
    select: { id: true },
  })

  if (existing?.id) {
    await prisma.userHiddenConversation.update({
      where: { id: existing.id },
      data: { deliveryToken: input.deliveryToken },
    })
    return
  }

  await prisma.userHiddenConversation.create({
    data: {
      userId: candidates[0]!,
      conversationId: input.conversationId,
      deliveryToken: input.deliveryToken,
    },
  })
}

/** Cek kepemilikan baris keanggotaan (leave tanpa group token). */
export async function findMembership(
  prisma: MembershipLookup,
  input: { userId: string; conversationId: string }
): Promise<boolean> {
  const candidates = await routingCandidates(input.userId)
  const row = await prisma.userHiddenConversation.findFirst({
    where: { userId: { in: candidates }, conversationId: input.conversationId },
    select: { id: true },
  })
  return row !== null
}

/**
 * [docs/28 D8] Tag penulis `Story` — aliasi yang sama dengan routingIdentity
 * supaya niatnya terbaca di call site (seal deterministik, bisa dibalik server).
 */
export const storyAuthorTag = routingIdentity

/** [docs/28 D9] Tag identitas untuk kolom `blockerTag`/`blockedTag`. */
export const blockedUserTag = routingIdentity

/**
 * [docs/28 D2/D8/D9] Pembersihan eksplisit milik user pada tabel yang TIDAK
 * punya FK ke User (UserHiddenConversation, Story, BlockedUser). Dipakai saat
 * akun dihapus / dead man's switch — dulu bergantung pada `onDelete: Cascade`,
 * yang kini tidak ada (nilai kolomnya ter-seal, jadi FK tidak mungkin dipenuhi).
 */
export interface SealedOwnedRowsPrisma {
  userHiddenConversation: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  story: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  blockedUser: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
}

export async function purgeSealedUserRows(
  prisma: SealedOwnedRowsPrisma,
  userId: string
): Promise<void> {
  const tag = await routingIdentity(userId)
  // Keanggotaan grup user (baris token-first), nilai kanonik ter-seal.
  const membership = await routingCandidates(userId)
  await prisma.userHiddenConversation.deleteMany({ where: { userId: { in: membership } } })
  await prisma.story.deleteMany({ where: { authorTag: tag } })
  await prisma.blockedUser.deleteMany({ where: { OR: [{ blockerTag: tag }, { blockedTag: tag }] } })
}

/** Revocation (kick/leave): hapus baris keanggotaan user pada conversation. */
export async function deleteMembership(
  prisma: MembershipPrisma,
  input: { userId: string; conversationId: string }
): Promise<number> {
  const candidates = await routingCandidates(input.userId)
  const result = await prisma.userHiddenConversation.deleteMany({
    where: { userId: { in: candidates }, conversationId: input.conversationId },
  })
  return result.count
}
