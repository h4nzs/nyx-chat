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

const PSEUDONYM_BYTES = 16; // 22-char base64url (sender pseudonym)
// [docs/37 §37.3.1] Member token 256-bit (43-char base64url). Server menyimpan
// SHA-256-nya saja; ini menaikkan entropi dari 128-bit (22-char) ke 256-bit.
const MEMBER_TOKEN_BYTES = 32;

// --- [T3b] Delivery tokens (doc 26.2) ---

/** Random per-(group, member) delivery token (base64url of 32 random bytes). */
export async function generateDeliveryToken(): Promise<DeliveryToken> {
  const { getSodium } = await import('./sodiumInitializer');
  const sodium = await getSodium();
  const raw = sodium.randombytes_buf(MEMBER_TOKEN_BYTES);
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

/** Peta token grup ini dari decryptedMetadata v2/v3 (undefined = bukan v2/v3). */
export function getDeliveryTokenMap(conversationId: string): Record<string, string> | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
  return (meta?.v === 2 || meta?.v === 3) ? meta.deliveryTokenMap : undefined;
}

/**
 * Token SAYA untuk percakapan ini — dikirim saat sync agar discovery memakai
 * possession token, bukan join userId. Peta kanonis { userId -> token }.
 */
export function getMyDeliveryToken(conversationId: string): DeliveryToken | undefined {
  const map = getDeliveryTokenMap(conversationId);
  if (!map) return undefined;
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return undefined;
  const token = map[myId];
  return token ? asDeliveryToken(token) : undefined;
}

/**
 * Semua token milik saya lintas grup (untuk header X-Delivery-Tokens saat sync).
 *
 * [BUGFIX 2026-10-11] Dulu filter `meta?.v !== 2` → metadata **v3** (satu-satunya
 * bentuk yang masih ditulis, lihat 2026-10 purge) selalu dilewati, sehingga
 * discovery token-first tidak pernah menerima token grup v3: device baru tanpa
 * id lokal tidak menemukan grupnya sebelum ada pesan relay. Kontrak peta
 * token sama di v2 & v3 (`getDeliveryTokenMap`), jadi filternya disamakan.
 */
export function collectMyDeliveryTokens(): DeliveryToken[] {
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return [];
  const tokens: DeliveryToken[] = [];
  for (const conv of useConversationStore.getState().conversations) {
    const meta = conv.decryptedMetadata as { v?: number; deliveryTokenMap?: Record<string, string> } | undefined;
    if ((meta?.v !== 2 && meta?.v !== 3) || !meta.deliveryTokenMap) continue;
    const token = meta.deliveryTokenMap[myId];
    if (token) tokens.push(asDeliveryToken(token));
  }
  return tokens;
}

/**
 * Blind auth grup (`authSecret`) milik percakapan ini, bila metadata v2/v3
 * sudah ter-dekripsi. Dipakai sebagai bukti keanggotaan saat issuance credential
 * (docs/29 §7.1) — sama seperti X-Group-Token pada mutasi grup lain.
 */
export function getMyGroupToken(conversationId: string): string | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; authSecret?: string } | undefined;
  return (meta?.v === 2 || meta?.v === 3) ? meta.authSecret : undefined;
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
 * Baca peta pseudonym dari decryptedMetadata (bila metadata v2/v3).
 * Return undefined bila metadata bukan v2/v3 (tidak ada peta).
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
 * Roster ber-role grup dari decryptedMetadata v3. Return undefined = bukan v3.
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
 * Boleh saya lakukan aksi admin di grup ini? Hanya OWNER/ADMIN dari roster
 * metadata v3. Grup tanpa roster v3 → bukan admin (fail-closed): server juga
 * mem-gate mutasi destruktif dengan admin capability token.
 */
export function amIGroupAdmin(conversationId: string): boolean {
  const role = getMyGroupRole(conversationId);
  return !!role && roleAtLeast(role, 'ADMIN');
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

/**
 * [docs/28 Tier 4] Pseudonym saya DENGAN satu usaha terakhir: bila peta belum
 * ada di store, coba dekripsi metadata v2/v3 percakapan (yang membawa
 * `pseudonymMap`). Tanpa ini jalur kirim jatuh ke fallback userId → userId asli
 * tersimpan di `Message.senderId` & di wrapper pesan (temuan audit dump
 * 2026-10-09: 6 baris + 2 wrapper).
 *
 * Mengembalikan undefined HANYA bila grup benar-benar pra-v2 (tidak punya peta)
 * atau metadata-nya belum bisa didekripsi.
 */
export async function ensureMyPseudonym(conversationId: string): Promise<Pseudonym | undefined> {
  const direct = await getMyPseudonym(conversationId);
  if (direct) return direct;

  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conv?.encryptedMetadata) return undefined;

  // Hanya wrapper v2/v3 yang membawa peta; blob v1 legacy tidak perlu dicoba
  // (dan dekripsi v1 menyentuh rantai — tidak boleh dipanggil serampangan).
  try {
    const wrapper = JSON.parse(String(conv.encryptedMetadata)) as { v?: number; kind?: string };
    if (wrapper?.v !== 2 || wrapper?.kind !== 'group_metadata') return undefined;
  } catch {
    return undefined;
  }

  try {
    const { decryptGroupMetadata } = await import('@utils/crypto');
    const dec = await decryptGroupMetadata(String(conv.encryptedMetadata), conversationId);
    const map = (dec as { pseudonymMap?: Record<string, string> } | null)?.pseudonymMap;
    const found = findPseudonymInMap(map, useAuthStore.getState().user?.id);
    return found ? asPseudonym(found) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * [docs/28 Tier 4] Identitas pengirim untuk jalur yang TIDAK boleh menyimpan
 * userId asli (isian `Message.senderId`, wrapper pesan grup).
 *
 * SELALU pseudonym grup (v2/v3); undefined bila peta belum tersedia — pemanggil
 * tidak boleh jatuh ke userId. Fallback userId untuk grup v1 sudah dihapus
 * (tidak ada lagi grup v1; lihat docs/28).
 */
export async function resolveSenderIdentityForGroup(conversationId: string): Promise<string | undefined> {
  return ensureMyPseudonym(conversationId);
}

/**
 * [BUGFIX 2026-10-10] Guard pamungkas jalur KIRIM grup: wrapper pesan wajib
 * membawa pseudonym pengirim. `JSON.stringify` membuang field `undefined`,
 * sehingga wrapper tanpa senderId tidak bisa di-route penerima ("Missing
 * senderId for group decryption") dan menyisakan pesan mati tanpa jejak.
 *
 * Gagal keras di pengirim dengan pesan yang bisa ditindaklanjuti jauh lebih
 * baik daripada mengirim wrapper cacat (dan tidak boleh jatuh ke userId —
 * itu kebocoran at-rest, lihat docs/28 Tier 4).
 */
export function requireGroupSenderIdentity(
  senderPseudonym: string | undefined,
  conversationId: string
): string {
  if (!senderPseudonym) {
    throw new Error(
      `Pseudonym pengirim grup tidak tersedia untuk ${conversationId}: metadata grup v2/v3 belum ` +
        'ter-dekripsi atau tidak membawa pseudonymMap. Sinkronkan metadata grup (muat ulang / tunggu ' +
        'catch-up) lalu kirim ulang.'
    );
  }
  return senderPseudonym;
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
