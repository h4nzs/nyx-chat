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
import type { Pseudonym, DeliveryToken } from '@nyx/shared';
import { asPseudonym, asDeliveryToken } from '@nyx/shared';
import { useAuthStore } from '@store/auth';
import { useConversationStore } from '@store/conversation';
import { useSettingsStore } from '@store/settings';
import { isBurnerConversation } from '@lib/coverTraffic';

const PSEUDONYM_BYTES = 16; // 22-char base64url

// --- [T3b] Delivery tokens (doc 26.2) ---

/** Random per-(group, member) delivery token (base64url of 16 random bytes). */
export async function generateDeliveryToken(): Promise<DeliveryToken> {
  const { getSodium } = await import('./sodiumInitializer');
  const sodium = await getSodium();
  const raw = sodium.randombytes_buf(PSEUDONYM_BYTES);
  try {
    return asDeliveryToken(sodium.to_base64(raw, sodium.base64_variants.URLSAFE_NO_PADDING));
  } finally {
    sodium.memzero(raw);
  }
}

/**
 * Bangun peta token lengkap untuk seluruh anggota (creator-issued, full-rewrite
 * per rotasi — pola sama dengan pseudonymMap, keputusan 26.7.1).
 */
export async function generateDeliveryTokenMap(participantIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const seen = new Set<string>();
  for (const uid of participantIds) {
    let token = await generateDeliveryToken();
    while (seen.has(token)) token = await generateDeliveryToken();
    seen.add(token);
    map[token] = uid;
  }
  return map;
}

/** Peta token grup ini dari decryptedMetadata v2 (undefined = legacy). */
export function getDeliveryTokenMap(conversationId: string): Record<string, string> | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
  return meta?.v === 2 ? meta.deliveryTokenMap : undefined;
}

/**
 * Token SAYA untuk percakapan ini — dikirim saat sync agar discovery memakai
 * possession token, bukan join userId (jalur legacy tetap jalan transitional).
 */
export function getMyDeliveryToken(conversationId: string): DeliveryToken | undefined {
  const map = getDeliveryTokenMap(conversationId);
  if (!map) return undefined;
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return undefined;
  const found = Object.entries(map).find(([, uid]) => uid === myId);
  return found ? asDeliveryToken(found[0]) : undefined;
}

/** Semua token milik saya lintas grup (untuk header X-Delivery-Tokens saat sync). */
export function collectMyDeliveryTokens(): DeliveryToken[] {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return [];
  const tokens: DeliveryToken[] = [];
  for (const conv of useConversationStore.getState().conversations) {
    const meta = conv.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
    if (meta?.v !== 2 || !meta.deliveryTokenMap) continue;
    const found = Object.entries(meta.deliveryTokenMap).find(([, uid]) => uid === myId);
    if (found) tokens.push(asDeliveryToken(found[0]));
  }
  return tokens;
}

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
 * [T3b] Lihat juga helper deliveryToken di bawah — pola akses identik.
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

// --- [26.10.5] Bundle Maximum: ephemeral + jittered receipts ---

/**
 * Burner default ephemeral (26.10.7); grup reguler opt-in via settings store
 * (client-local — server tidak boleh tahu pengaturan privasi percakapan).
 */
export function isEphemeralReceipts(conversationId: string): boolean {
  if (isBurnerConversation(conversationId)) return true;
  return useSettingsStore.getState().ephemeralReceiptsGroups.includes(conversationId);
}

/**
 * Jittered release (26.10.5): tunda pengiriman receipt dengan delay acak
 * [0, maxDelayMs]. Menyamarkan korelasi "waktu baca vs waktu buka chat" —
 * server tidak bisa membedakan baca-benar dari baca-yang-di-jitter.
 * Resolve via callback setelah delay; `true` = tetap kirim (masih memenuhi
 * kontrak caller), `false` = batalkan (mis. percakapan berpindah).
 */
export function scheduleEphemeralReceipt(
  conversationId: string,
  maxDelayMs: number,
  send: () => void,
): void {
  const delay = Math.floor(Math.random() * Math.max(0, maxDelayMs));
  if (delay === 0) {
    send();
    return;
  }
  setTimeout(send, delay);
}

/** Delay jitter maksimum untuk receipt — kecil, jangan merusak UX 'Read'. */
export const RECEIPT_JITTER_MAX_MS = 45_000; // 0–45 detik
