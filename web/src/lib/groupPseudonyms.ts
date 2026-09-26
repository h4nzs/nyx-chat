// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T1] Group sender pseudonyms — doc 26.2 / 26.7 (blueprint).
 *
 * Peta `pseudonym -> userId` HIDUP HANYA di dalam encrypted metadata (v2).
 * Server melihat `senderId` pseudonym acak yang tidak bisa di-link ke akun
 * maupun antar grup. Generation naik pada tiap full key/membership rotation
 * sehingga pesan pra/pasca rotasi tidak bisa di-stitch oleh server.
 *
 * Di-extract sebagai module ringan (pola `groupMetadata.ts`) agar bisa
 * diuji unit tanpa memuat graph crypto worker yang berat.
 */
import type { Pseudonym } from '@nyx/shared';
import { asPseudonym } from '@nyx/shared';
import { useAuthStore } from '@store/auth';
import { useConversationStore } from '@store/conversation';

const PSEUDONYM_BYTES = 16; // 22-char base64url

/** Random per-group sender pseudonym (base64url of 16 random bytes). */
export async function generateGroupPseudonym(): Promise<Pseudonym> {
  const { getSodium } = await import('./sodiumInitializer');
  const sodium = await getSodium();
  const raw = sodium.randombytes_buf(PSEUDONYM_BYTES);
  try {
    return asPseudonym(sodium.to_base64(raw, sodium.base64_variants.URLSAFE_NO_PADDING));
  } finally {
    sodium.memzero(raw);
  }
}

/**
 * Bangun peta pseudonym lengkap untuk seluruh anggota (full rewrite per
 * rotasi — keputusan 26.7.1). Dipanggil creator saat createGroup dan setiap
 * kali metadata v2 di-encrypt ulang (rotasi kunci/keanggotaan).
 */
export async function generatePseudonymMap(participantIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const seen = new Set<string>();
  for (const uid of participantIds) {
    // (Sangat tidak mungkin) collision guard — regenerasi bila tabrakan.
    let pseudo = await generateGroupPseudonym();
    while (seen.has(pseudo)) pseudo = await generateGroupPseudonym();
    seen.add(pseudo);
    map[pseudo] = uid;
  }
  return map;
}

/**
 * Baca peta pseudonym dari decryptedMetadata (bila metadata v2).
 * Return undefined untuk metadata v1 (grup lawas — jalur userId lama tetap jalan).
 */
export function getPseudonymMap(conversationId: string): Record<string, string> | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; pseudonymMap?: Record<string, string> } | undefined;
  return meta?.v === 2 ? meta.pseudonymMap : undefined;
}

/**
 * Pseudonym SAYA untuk percakapan ini. Fallback: undefined → caller harus
 * memakai jalur lama (metadata v1) atau menunggu metadata v2 ter-decrypt.
 */
export async function getMyPseudonym(conversationId: string): Promise<Pseudonym | undefined> {
  const map = getPseudonymMap(conversationId);
  if (!map) return undefined;
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return undefined;
  const found = Object.entries(map).find(([, uid]) => uid === myId);
  return found ? asPseudonym(found[0]) : undefined;
}

/** Resolve pseudonym -> userId (untuk penerima). Bukan anggota peta → undefined. */
export function resolvePseudonymToUserId(conversationId: string, pseudonym: string): string | undefined {
  return getPseudonymMap(conversationId)?.[pseudonym];
}
