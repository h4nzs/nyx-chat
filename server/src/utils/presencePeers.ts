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

import { routingCandidates, resolveRoutingUser } from './routingIdentity.js'

/** Bentuk minimal klien Prisma yang dibutuhkan (memudahkan injeksi fake di test). */
export interface PresenceMembershipClient {
  userHiddenConversation: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { conversationId?: boolean; userId?: boolean };
      distinct?: ('userId' | 'conversationId')[];
    }): Promise<Array<{ conversationId?: string; userId?: string | null }>>;
  };
  /**
   * [AUDIT PASS 2 residual — presence 1:1] Bukti peserta KEDUA yang dipegang
   * server: baris `SessionKey` per (conversation, device). Percakapan 1:1 dan
   * grup buatan sendiri **tidak punya** baris `UserHiddenConversation`
   * (token-first, hanya penerima bertoken), sehingga presence 1:1 dulu selalu
   * kosong. Session key dibuat saat percakapan dibuat (`initialSession`) untuk
   * SEMUA perangkat peserta, jadi ia adalah daftar kontak yang sudah ada tanpa
   * menulis baris keanggotaan baru (tidak menambah graf di dump).
   */
  sessionKey: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { conversationId?: boolean; device?: { select: { userId?: boolean } } };
    }): Promise<Array<{
      conversationId?: string;
      device?: { userId?: string | null } | null;
    }>>;
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
  // [docs/28 Tier 1.2] kolom userId kini routing identity TER-SEAL → lookup
  // memakai nilai kanonik, dan nilai baris dibuka kembali sebelum dipakai
  // sebagai target broadcast.
  const candidates = await routingCandidates(userId)

  // Dua sumber "percakapan milik saya": baris keanggotaan (token-first, grup
  // yang saya diundang) DAN session key perangkat saya (1:1 + grup buatan
  // sendiri, yang tidak punya baris keanggotaan — residual pass 2).
  const [mine, mySessions] = await Promise.all([
    prisma.userHiddenConversation.findMany({
      where: { userId: { in: candidates } },
      select: { conversationId: true },
    }),
    prisma.sessionKey.findMany({
      where: { device: { userId } },
      select: { conversationId: true },
    }),
  ]);

  const conversationIds = Array.from(new Set(
    [...mine, ...mySessions]
      .map((row) => row.conversationId)
      .filter((id): id is string => typeof id === 'string')
  ));
  if (conversationIds.length === 0) return [];

  const [peers, sessionPeers] = await Promise.all([
    prisma.userHiddenConversation.findMany({
      where: { conversationId: { in: conversationIds }, userId: { not: null, notIn: candidates } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.sessionKey.findMany({
      where: { conversationId: { in: conversationIds }, NOT: { device: { userId } } },
      select: { device: { select: { userId: true } } },
    }),
  ]);

  const resolved = await Promise.all(peers.map((p) => resolveRoutingUser(p.userId)));
  const sessionUserIds = sessionPeers
    .map((row) => row.device?.userId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return dedupePeers(
    conversationIds.map((conversationId) => ({ conversationId })),
    [
      ...resolved.map((peerId) => ({ userId: peerId })),
      ...sessionUserIds.map((peerUserId) => ({ userId: peerUserId })),
    ],
    userId
  );
}
