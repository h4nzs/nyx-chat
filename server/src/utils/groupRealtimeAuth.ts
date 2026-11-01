// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-31 — F-02] Otorisasi tulis baris SYSTEM lewat jalur realtime.
 *
 * `group:fulfilled_key` dan `metadata:updated` menerima `conversationId` dari
 * payload lalu langsung menulis baris `type: 'SYSTEM'`. Jalur REST untuk mutasi
 * grup sudah dijaga token grup + admin capability (`utils/groupAccess.ts`),
 * tetapi jalur realtime tidak melewati gate itu — user terautentikasi mana pun
 * yang mengetahui satu `conversationId` bisa menyisipkan amplop `GROUP_KEY` /
 * `METADATA_UPDATED` ke riwayat grup orang lain (polusi riwayat, kerja kripto
 * paksa, muka DoS).
 *
 * Gate di sini memakai bukti yang SUDAH dipegang server, bukan deklarasi klien:
 *
 *  - **Anggota**: baris `UserHiddenConversation` (userId ter-seal) untuk
 *    conversation itu. Ini yang dimiliki anggota biasa.
 *  - **Admin capability**: `Conversation.adminSecretHash` (SHA-256) versus token
 *    yang dikirim di payload. Ini yang dimiliki PEMBUAT grup — ia belum punya
 *    baris keanggotaan saat distribusi kunci pertama (baris hanya dibuat untuk
 *    anggota yang mengirim delivery token), jadi tanpa cabang ini createGroup
 *    akan gagal.
 *
 * Ancaman yang ditutup: penyerang tanpa baris keanggotaan dan tanpa token admin
 * tidak bisa menulis apa pun ke `conversationId` yang ia ketahui. Residual yang
 * dicatat: anggota/admin sah tetap bisa menulis (memang haknya), dan siapa pun
 * yang memiliki admin token bisa — token itu memang capability admin.
 */

import { isAdminTokenValid } from './adminCapability.js';
import {
  filterConversationMembers,
  findMembership,
  type ConversationMembershipLookup,
  type MembershipLookup,
} from './routingIdentity.js';

/** Batas target `metadata:updated` yang akan diperiksa/dinotifikasi. */
export const MAX_METADATA_TARGETS = 200;

export interface GroupRealtimeAuthDb {
  conversation: {
    findUnique(args: {
      where: { id: string };
      select: { id?: boolean; isGroup?: boolean; adminSecretHash?: boolean; groupEpoch?: boolean };
    }): Promise<{
      id?: string;
      isGroup?: boolean;
      adminSecretHash?: string | null;
      groupEpoch?: number;
    } | null>;
  };
  // Dua metode dari dua helper berbeda; dideklarasikan eksplisit karena
  // `extends` dua interface yang sama-sama punya properti ini tidak valid.
  userHiddenConversation: MembershipLookup['userHiddenConversation']
    & ConversationMembershipLookup['userHiddenConversation'];
}

export type GroupSystemWriteDecision =
  | { ok: true; allowedTargets: string[] }
  | { ok: false; reason: 'not_found' | 'not_group' | 'unauthorized' };

/**
 * Putuskan apakah `userId` boleh menulis baris SYSTEM ke `conversationId`.
 *
 * `allowedTargets` = irisan `targetRecipients` dengan anggota yang benar-benar
 * punya baris keanggotaan; hanya itu yang boleh menerima `conversation:updated`
 * (mencegah fan-out ke id sembarang).
 */
export async function authorizeGroupSystemWrite(
  db: GroupRealtimeAuthDb,
  input: {
    userId: string;
    conversationId: string;
    /** Token capability admin dari payload (opsional; hanya jalur bootstrap). */
    adminCapabilityToken?: unknown;
    /** Target notifikasi dari payload (disaring, tidak dipercaya apa adanya). */
    targetRecipients?: unknown;
  }
): Promise<GroupSystemWriteDecision> {
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { id: true, isGroup: true, adminSecretHash: true, groupEpoch: true },
  });
  if (!conversation) return { ok: false, reason: 'not_found' };
  // Event-event ini hanya bermakna untuk grup; menolak 1:1 menutup penyalahgunaan
  // termudah (percakapan 1:1 tidak menyimpan roster sehingga tidak ada gate lain).
  if (conversation.isGroup !== true) return { ok: false, reason: 'not_group' };

  // [AUDIT PASS 2 — N-03] Baris keanggotaan yang tokennya basi (epoch tidak
  // cocok / kedaluwarsa melewati grace) diperlakukan sebagai bukan anggota:
  // gate tulis SYSTEM konsisten dengan `/api/groups/*`, dan kick/rotasi tidak
  // menyisakan jendela tulis selama baris lama belum di-GC.
  const isMember = await findMembership(
    db,
    { userId: input.userId, conversationId: input.conversationId },
    { requireFresh: true, groupEpoch: conversation.groupEpoch ?? 0 }
  );
  const token = typeof input.adminCapabilityToken === 'string' ? input.adminCapabilityToken : '';
  const isAdmin = isAdminTokenValid(conversation.adminSecretHash ?? null, token);

  if (!isMember && !isAdmin) return { ok: false, reason: 'unauthorized' };

  const rawTargets = Array.isArray(input.targetRecipients)
    ? input.targetRecipients.slice(0, MAX_METADATA_TARGETS)
    : [];
  const allowedTargets = await filterConversationMembers(
    db,
    input.conversationId,
    rawTargets
  );

  return { ok: true, allowedTargets };
}
