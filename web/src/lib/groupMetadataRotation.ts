// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Metadata rotasi keanggotaan — helper murni.
 *
 * Kenapa dipisah: sebelumnya `rotateGroupKey` menyusun metadata dengan
 * `...existingMeta`, yang membawa **`pseudonymMap` lama**. `encryptGroupMetadata`
 * hanya membuat peta baru bila `pseudonymMap` tidak ada, jadi peta lama
 * dipertahankan apa adanya — dan anggota yang baru ditambahkan **tidak punya
 * entri pseudonym** di peta itu.
 *
 * Akibatnya (bug "member baru bisa terima, tidak bisa kirim"):
 *   - `getMyPseudonym()` → `findPseudonymInMap(map, myId)` → undefined;
 *   - `ensureMyPseudonym()` mendekripsi blob, tetap tidak menemukan dirinya;
 *   - jalur kirim memanggil `requireGroupSenderIdentity(undefined)` yang
 *     melempar → pesan gagal sebelum `message:send`.
 *
 * Helper ini membuang peta lama (supaya penulis metadata meregenerasi peta
 * untuk roster saat ini), mempertahankan role anggota lama, memberi anggota baru
 * `joinedAtGeneration`, dan menggabungkan delivery token yang baru di-issue
 * saat invite (sebelumnya token itu hanya dikirim ke server, tidak pernah masuk
 * metadata).
 */

import type { GroupMemberEntry } from '@nyx/shared';

export interface RotationSourceMetadata {
  v?: number;
  generation?: number;
  members?: GroupMemberEntry[];
  participants?: string[];
  deliveryTokenMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface RotatedGroupMetadata {
  /** Metadata siap dioper ke `encryptGroupMetadata` (TANPA `pseudonymMap`). */
  metadata: RotationSourceMetadata;
  /** Generation roster hasil rotasi (prev + 1). */
  generation: number;
}

/**
 * Susun metadata v3 untuk rotasi keanggotaan.
 *
 * `generation` yang dikembalikan di `metadata` sengaja **belum** dinaikkan:
 * `encryptGroupMetadata` menaikkannya tepat satu kali saat peta tidak ada.
 * Menyetel prev+1 di sini akan membuat lompatan +2 (bug halus yang sulit
 * terlihat karena hanya memengaruhi `joinedAtGeneration`).
 */
export function buildRotatedGroupMetadata(
  existing: RotationSourceMetadata,
  participantIds: string[],
  deliveryTokens: Record<string, string> = {}
): RotatedGroupMetadata {
  const prevGeneration = existing.generation ?? 0;
  const generation = prevGeneration + 1;

  const prevById = new Map((existing.members ?? []).map((member) => [member.userId, member]));
  const members: GroupMemberEntry[] = participantIds.map((userId) => {
    const prev = prevById.get(userId);
    return prev ?? { userId, role: 'MEMBER' as const, joinedAtGeneration: generation };
  });

  // Peta pseudonym lama TIDAK boleh ikut: ia tidak memuat anggota baru, dan
  // kehadirannya membuat encryptGroupMetadata melewati regenerasi.
  const source: RotationSourceMetadata = { ...existing };
  delete source.pseudonymMap;

  return {
    metadata: {
      ...source,
      participants: participantIds,
      v: 3,
      generation: prevGeneration,
      deliveryTokenMap: { ...(existing.deliveryTokenMap ?? {}), ...deliveryTokens },
      members,
    },
    generation,
  };
}
