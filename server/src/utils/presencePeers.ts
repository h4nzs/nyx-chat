// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0.7 — D14] Presence per-kontak (peer-scoped).
 *
 * Masalah lama: setiap klien yang connect menerima `{ type: 'bulk', userIds }`
 * berisi SELURUH isi `online_users` — artinya **setiap pengguna NYX bisa
 * memanen roster online seluruh platform** tanpa perlu dump apa pun. Itu graph
 * presensi, dan ia merusak janji privasi grup/1:1 yang sudah dikerjakan.
 *
 * Pengganti: presence di-scope ke **peer** — user yang berbagi minimal satu
 * conversation dengan subjek. Penting: daftar peer DITURUNKAN server dari baris
 * keanggotaan yang sudah ia miliki (`UserHiddenConversation`), **bukan** dari
 * deklarasi klien. Jadi kita tidak menukar satu kebocoran (roster global) dengan
 * kebocoran lain (klien harus mengirim daftar kontaknya ke server).
 *
 * Broadcast join/leave juga hanya ke peer yang sedang online — bukan ke semua
 * orang yang online.
 */

/** Bentuk minimal klien Prisma yang dibutuhkan (memudahkan injeksi fake di test). */
export interface PresenceMembershipClient {
  userHiddenConversation: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { conversationId?: boolean; userId?: boolean };
      distinct?: ('userId' | 'conversationId')[];
    }): Promise<Array<{ conversationId?: string; userId?: string | null }>>;
  };
}

/**
 * Murni & sinkron supaya bisa diuji tanpa DB: dari daftar conversation milik
 * subjek + baris keanggotaan, hasilkan daftar userId peer yang unik.
 */
export function dedupePeers(
  mine: Array<{ conversationId: string }>,
  peers: Array<{ userId?: string | null }>,
  selfId: string
): string[] {
  const conversationIds = new Set(mine.map((m) => m.conversationId));
  if (conversationIds.size === 0) return [];

  const result = new Set<string>();
  for (const row of peers) {
    const candidate = row.userId;
    if (typeof candidate !== 'string' || candidate.length === 0) continue; // baris token-only (userId null)
    if (candidate === selfId) continue;
    result.add(candidate);
  }
  return Array.from(result);
}

/** Peer ∩ online — hanya mereka yang boleh menerima sinyal join/leave. */
export function intersectOnline(peers: string[], online: Iterable<string>): string[] {
  const onlineSet = online instanceof Set ? online : new Set(online);
  return peers.filter((peerId) => onlineSet.has(peerId));
}

/**
 * Ambil daftar userId peer dari DB. Dua query (sama pola dengan
 * routes/users.ts broadcast profil): conversation milik subjek → anggota lain.
 */
export async function collectPresencePeers(
  prisma: PresenceMembershipClient,
  userId: string
): Promise<string[]> {
  const mine = await prisma.userHiddenConversation.findMany({
    where: { userId },
    select: { conversationId: true },
  });

  if (mine.length === 0) return [];

  const conversationIds = Array.from(
    new Set(mine.map((m) => m.conversationId).filter((id): id is string => typeof id === 'string'))
  );
  if (conversationIds.length === 0) return [];

  const peers = await prisma.userHiddenConversation.findMany({
    where: { conversationId: { in: conversationIds }, userId: { not: null, notIn: [userId] } },
    select: { userId: true },
    distinct: ['userId'],
  });

  return dedupePeers(
    conversationIds.map((conversationId) => ({ conversationId })),
    peers,
    userId
  );
}
