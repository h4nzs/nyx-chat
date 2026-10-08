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
 * supaya sealing + kompatibilitas baris legacy (nilai plaintext lama) konsisten.
 */

import { openAtRest, sealAtRest } from './atRestSecrets.js'

/** Nilai kanonik untuk kolom routing (deterministik). */
export function routingIdentity(userId: string): Promise<string> {
  return sealAtRest(userId)
}

/** Kandidat lookup: `[ter-seal, apa adanya]` — cabang kedua untuk baris legacy. */
export async function routingCandidates(userId: string): Promise<string[]> {
  return [await sealAtRest(userId), userId]
}

/**
 * Terima nilai ter-seal (baris baru) ATAU plaintext (baris legacy) dan
 * kembalikan userId asli. Null bila kosong.
 */
export async function resolveRoutingUser(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null
  const opened = await openAtRest(stored)
  return opened ?? stored
}

/**
 * Bentuk minimal klien Prisma (metode bergaya `method()`, jadi bivarian →
 * PrismaClient asli tetap assignable lewat cast di call site).
 */
export interface MembershipPrisma {
  userHiddenConversation: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id?: boolean };
    }): Promise<{ id?: string } | null>;
    update(args: { where: { id: string }; data: { deliveryToken: string } }): Promise<unknown>;
    create(args: {
      data: { userId: string; conversationId: string; deliveryToken: string };
    }): Promise<unknown>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

/**
 * Upsert baris keanggotaan (conversation + delivery token) untuk seorang user.
 *
 * Memakai findFirst + kandidat (bukan upsert compound-unique) supaya baris
 * LEGACY yang masih plaintext ikut ter-upgrade, bukan bikin duplikat —
 * `deliveryToken` unik, jadi duplikat akan gagal tanpa jejak yang jelas.
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
  prisma: MembershipPrisma,
  input: { userId: string; conversationId: string }
): Promise<boolean> {
  const candidates = await routingCandidates(input.userId)
  const row = await prisma.userHiddenConversation.findFirst({
    where: { userId: { in: candidates }, conversationId: input.conversationId },
    select: { id: true },
  })
  return row !== null
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
