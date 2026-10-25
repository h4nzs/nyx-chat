// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Index keanggotaan room burner/migration.
 *
 * Dulu `handleDisconnect` mencari room user dengan dua `SCAN` seluruh keyspace
 * (`burner:room:*`, `migration:room:*`) — biayanya tumbuh linear terhadap jumlah
 * room, dan biaya itu muncul tepat saat banyak koneksi putus bersamaan (jam
 * sibuk / deploy). Sekarang tiap join mencatat room-nya di set milik user
 * (`room:member:<tag>`), jadi pembersihan cukup membaca set itu.
 *
 * Member di set room tetap disimpan TER-SEAL (`sealIdentity`) seperti sebelumnya;
 * index-nya memakai TAG (`identityTag`), konsisten dengan aturan "Redis tidak
 * memuat userId asli". TTL index mencegah sisa entri bila user tidak pernah
 * disconnect (mis. proses mati) — nilai room yang sudah tiada hanya membuat
 * `SREM` no-op.
 */

export type RoomKind = 'burner' | 'migration';

const ROOM_INDEX_TTL_SECONDS = 24 * 60 * 60;

/** Irisan klien Redis yang dipakai (cukup untuk fake di test). */
export interface RoomRedisClient {
  sAdd(key: string, member: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Key set anggota room — dipakai juga oleh broadcast/destroy di handlers. */
export function roomKey (kind: RoomKind, roomId: string): string {
  return `${kind}:room:${roomId}`;
}

/** Key set room yang diikuti satu user (di-key TAG, bukan userId). */
export function roomIndexKey (memberTag: string): string {
  return `room:member:${memberTag}`;
}

export interface JoinRoomArgs {
  kind: RoomKind;
  roomId: string;
  /** Nilai ter-seal untuk set anggota room (sama dengan yang dibaca broadcast). */
  sealedMember: string;
  /** TAG user untuk index per-user. */
  memberTag: string;
}

/** Catat user sebagai anggota room (idempoten — SADD aman dipanggil ulang). */
export async function joinRoom (client: RoomRedisClient, args: JoinRoomArgs): Promise<void> {
  await client.sAdd(roomKey(args.kind, args.roomId), args.sealedMember);
  const index = roomIndexKey(args.memberTag);
  await client.sAdd(index, `${args.kind}:${args.roomId}`);
  await client.expire(index, ROOM_INDEX_TTL_SECONDS).catch(() => {});
}

/**
 * Keluarkan user dari SEMUA room yang tercatat di index-nya, lalu hapus index.
 * Mengembalikan jumlah keanggotaan yang benar-benar dihapus (0 = tidak ikut room
 * mana pun). Best-effort: pemanggil (`handleDisconnect`) yang menangani error.
 */
export async function leaveAllRooms (
  client: RoomRedisClient,
  args: { sealedMember: string; memberTag: string }
): Promise<number> {
  const index = roomIndexKey(args.memberTag);
  const entries = await client.sMembers(index);
  if (entries.length === 0) return 0;

  let removed = 0;
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const kind = entry.slice(0, separator);
    if (kind !== 'burner' && kind !== 'migration') continue;
    const roomId = entry.slice(separator + 1);
    if (!roomId) continue;
    removed += await client.sRem(roomKey(kind, roomId), args.sealedMember);
  }

  await client.del(index);
  return removed;
}
