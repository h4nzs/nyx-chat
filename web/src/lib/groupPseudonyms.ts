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
import type { Pseudonym, DeliveryToken, GroupMemberEntry, GroupRole } from '@nyx/shared';
import { asPseudonym, asDeliveryToken, parseGroupMembers, roleAtLeast } from '@nyx/shared';
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
 * ORIENTASI KANONIS: { userId -> token } — sama dengan kontrak server
 * (deliveryTokens/targetDeliveryTokens diindeks by userId).
 */
export async function generateDeliveryTokenMap(participantIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const seen = new Set<string>();
  for (const uid of participantIds) {
    let token = await generateDeliveryToken();
    while (seen.has(token)) token = await generateDeliveryToken();
    seen.add(token);
    map[uid] = token;
  }
  return map;
}

/** Peta token grup ini dari decryptedMetadata v2/v3 (undefined = legacy). */
export function getDeliveryTokenMap(conversationId: string): Record<string, string> | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
  return (meta?.v === 2 || meta?.v === 3) ? meta.deliveryTokenMap : undefined;
}

/**
 * Token SAYA untuk percakapan ini — dikirim saat sync agar discovery memakai
 * possession token, bukan join userId (jalur legacy tetap jalan transitional).
 * Peta kanonis { userId -> token }.
 */
export function getMyDeliveryToken(conversationId: string): DeliveryToken | undefined {
  const map = getDeliveryTokenMap(conversationId);
  if (!map) return undefined;
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return undefined;
  const token = map[myId];
  return token ? asDeliveryToken(token) : undefined;
}

/** Semua token milik saya lintas grup (untuk header X-Delivery-Tokens saat sync). */
export function collectMyDeliveryTokens(): DeliveryToken[] {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return [];
  const tokens: DeliveryToken[] = [];
  for (const conv of useConversationStore.getState().conversations) {
    const meta = conv.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
    if (meta?.v !== 2 || !meta.deliveryTokenMap) continue;
    const token = meta.deliveryTokenMap[myId];
    if (token) tokens.push(asDeliveryToken(token));
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
  return (meta?.v === 2 || meta?.v === 3) ? meta.pseudonymMap : undefined;
}

// --- [26.9 RBAC] Admin capability token (server-side admin guard) ---

/**
 * Admin capability token: rahasia acak yang HANYA dimiliki OWNER/ADMIN.
 * Server menyimpan SHA-256(token); kepemilikan token = bukti role admin
 * tanpa server tahu roster. Token asli tidak pernah dikirim ke server dalam
 * bentuk mentah saat provisioning — hanya hash-nya (createGroup).
 */
export async function generateAdminCapabilityToken(): Promise<string> {
  const { getSodium } = await import('./sodiumInitializer');
  const sodium = await getSodium();
  return sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** SHA-256 hex dari admin capability token — kontrak kolom Conversation.adminSecretHash. */
export async function hashAdminCapabilityToken(token: string): Promise<string> {
  const subtle = crypto.subtle;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Admin capability token SAYA untuk grup ini (undefined = bukan admin / belum ter-distribusi). */
export function getMyAdminToken(conversationId: string): string | undefined {
  return useConversationStore.getState().conversations
    .find(c => c.id === conversationId)?.adminToken;
}

/**
 * Simpan admin capability token: mirror di store (akses sinkron saat guard UI)
 * + persist di kvStore terenkripsi at-rest (masterSeed-bound) agar tok hidup
 * setelah reload. Fire-and-forget — pemanggil tidak perlu menunggu.
 */
export function storeMyAdminToken(conversationId: string, token: string): void {
  useConversationStore.getState().updateConversation(conversationId, { adminToken: token } as never);
  void (async () => {
    try {
      const { encryptValueAtRest } = await import('./keychainDb');
      const { db } = await import('./db');
      const KV_KEY = 'nyx_group_admin_tokens';
      const item = await db.kvStore.get(KV_KEY);
      const existing = ((item?.value as Record<string, string> | undefined) || {});
      existing[conversationId] = await encryptValueAtRest(token);
      await db.kvStore.put({ key: KV_KEY, value: existing });
    } catch (e) {
      console.warn('[RBAC] Failed to persist admin token:', e);
    }
  })();
}

/** Muat admin token dari kvStore ke store (panggil saat loadConversations / unlock). */
export async function hydrateMyAdminTokens(): Promise<void> {
  try {
    const { decryptValueAtRest } = await import('./keychainDb');
    const { db } = await import('./db');
    const item = await db.kvStore.get('nyx_group_admin_tokens');
    const existing = ((item?.value as Record<string, string> | undefined) || {});
    const convStore = useConversationStore.getState();
    for (const [convId, enc] of Object.entries(existing)) {
      if (!convStore.conversations.some(c => c.id === convId)) continue; // grup sudah tidak ada
      if (convStore.conversations.find(c => c.id === convId)?.adminToken) continue;
      const plain = enc ? await decryptValueAtRest(enc) : null;
      if (plain) convStore.updateConversation(convId, { adminToken: plain } as never);
    }
  } catch (e) {
    console.warn('[RBAC] Failed to hydrate admin tokens:', e);
  }
}

// --- [T4 ROSTER v3] Role & membership helpers (baca dari metadata) ---

/**
 * Roster ber-role grup dari decryptedMetadata v3. Return undefined = bukan
 * v3 (grup v1/v2 lawas → UI pakai fallback role lama dari participants).
 */
export function getGroupMembers(conversationId: string): GroupMemberEntry[] | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; members?: unknown } | undefined;
  return meta?.v === 3 ? parseGroupMembers(meta.members) : undefined;
}

/** Role saya di grup ini dari roster metadata (undefined = bukan v3 / bukan anggota). */
export function getMyGroupRole(conversationId: string): GroupRole | undefined {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return undefined;
  return getGroupMembers(conversationId)?.find(m => m.userId === myId)?.role;
}

/**
 * Boleh saya lakukan aksi admin di grup ini? OWNER/ADMIN boleh; fallback:
 * grup v1/v2 tanpa roster → role lama dari participants store (kompat).
 */
export function amIGroupAdmin(conversationId: string): boolean {
  const role = getMyGroupRole(conversationId);
  if (role) return roleAtLeast(role, 'ADMIN');
  // Fallback legacy (grup lawas tanpa roster v3).
  const myId = useAuthStore.getState().user?.id;
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const legacyRole = conv?.participants.find(p => p.id === myId)?.role as string | undefined;
  return legacyRole === 'ADMIN' || legacyRole === 'OWNER';
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

/**
 * [T2 FIX #10 2026-09-29] Cari pseudonym SAYA dari peta eksplisit yang baru
 * di-generate (createGroup — peta belum masuk store saat distribusi kunci
 * pertama jalan). Peta berorientasi pseudo→uid, jadi lookup-nya REVERSE via
 * Object.entries — DULU dipanggil sebagai map[myId] yang selalu undefined
 * (fallback myId bocorkan userId ke server pada GROUP_KEY/METADATA_UPDATED
 * pertama; terlihat di audit DB lokal 2026-09-29).
 */
export function findPseudonymInMap(map: Record<string, string> | undefined, userId: string | undefined): string | undefined {
  if (!map || !userId) return undefined;
  const found = Object.entries(map).find(([, uid]) => uid === userId);
  return found?.[0];
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
