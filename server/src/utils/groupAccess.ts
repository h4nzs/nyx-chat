// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4) — sisa "jalur admin grup lain"] Otorisasi operasi grup
 * (tambah/kick anggota, leave, tulis metadata, rotasi kunci, purge).
 *
 * Alasan util ini ada: `docs/29` §5.8 — klaim otorisasi tidak boleh diuji
 * sebagai **regex atas source**. Keputusan tiap jalur grup dulu tersebar inline
 * di `routes/conversations.ts`, jadi hanya bisa "diverifikasi" dengan membaca
 * teks. Sekarang keputusannya di sini dan diuji sebagai **perilaku** dengan
 * klien Prisma palsu (`tests/groupAccess.test.ts`), dengan urutan & kode status
 * yang persis sama dengan yang dilayani route:
 *
 *   - anggota (tambah)       : 404 bila conversation hilang → 403 tanpa X-Group-Token
 *   - kick anggota           : capability admin saja (404 → 403)
 *   - leave                  : 404 → token grup ATAU baris delivery-token sendiri → 403
 *   - tulis metadata details : 403 bila conversation hilang ATAU token salah
 *                              (sengaja TIDAK 404 — kontrak lama, lihat catatan) *   - rotasi kunci           : capability admin saja
 *   - purge grup             : 404 → 400 non-grup → 403 token → capability admin
 *                              → 409 `MEMBERS_REMAIN` selama masih ada anggota
 *
 * Aturan yang dijaga di sini dan mudah rusak saat refactor:
 *   1. **Fail-closed**: tidak ada cabang "gagal → izinkan".
 *   2. **Urutan penting**: anggota masih tersisa diperiksa SEBELUM apa pun
 *      dihapus (409), dan token diperiksa SEBELUM capability admin supaya pesan
 *      error tidak membocorkan keberadaan hash admin.
 *   3. **Tanpa PII**: pencarian baris keanggotaan memakai nilai routing
 *      ter-seal (`routingCandidates`) lewat `findMembership` — userId mentah
 *      tidak pernah dipakai sebagai nilai query.
 */

import { credentialTokenMatches } from './atRestSecrets.js';
import { extractHeader, requireAdminCapability, type AdminCapabilityDb } from './adminCapability.js';
import { findMembership, type MembershipLookup } from './routingIdentity.js';

/** Kontrak hasil: `ok`, atau kode status + pesan yang dipakai route apa adanya. */
export type GroupGate =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Pesan 403 yang jadi kontrak klien (bukan teks bebas). */
export const BLIND_AUTH_REQUIRED = 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token';

/** Pesan 409 purge: grup tidak boleh dihapus selama anggota lain masih ada. */
export const MEMBERS_REMAIN = 'MEMBERS_REMAIN: group still has active members';

/**
 * Klien Prisma minimal yang dibutuhkan: conversation (authSecret, adminSecretHash,
 * isGroup), baris keanggotaan token-first (dipakai `findMembership`), dan
 * hitungan anggota untuk guard purge.
 */
export interface GroupAccessDb {
  conversation: {
    findUnique(args: {
      where: { id: string };
      select: {
        authSecret?: boolean;
        adminSecretHash?: boolean;
        isGroup?: boolean;
        groupTokenExpiresAt?: boolean;
      };
    }): Promise<{
      authSecret?: string | null;
      adminSecretHash?: string | null;
      isGroup?: boolean;
      groupTokenExpiresAt?: Date | null;
    } | null>;
  };
  userHiddenConversation: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id?: boolean };
    }): Promise<{ id?: string } | null>;
    count(args: { where: { conversationId: string } }): Promise<number>;
  };
}

/** Bentuk minimal permintaan (header Express) yang dibutuhkan. */
export interface GroupAccessRequest {
  headers: Record<string, unknown>;
}

function groupToken(headers: Record<string, unknown>): string {
  return extractHeader(headers['x-group-token']);
}

/**
 * Cek token grup (authSecret) — dipakai jalur anggota. `404` bila conversation
 * tidak ada, `403` bila token kosong/salah (blind member auth, tanpa userId).
 */
async function checkGroupToken(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { authSecret: true, groupTokenExpiresAt: true },
  });
  if (!conversation) return { ok: false, status: 404, error: 'Not found' };
  // TTL group token berlaku juga untuk mutasi anggota/metadata, bukan hanya
  // mailbox: token bocor tidak boleh tetap bisa menambah anggota selamanya.
  // `null` = grup lama tanpa TTL (kompatibilitas), bukan fail-open untuk grup baru.
  const expiresAt = conversation.groupTokenExpiresAt
    ? new Date(conversation.groupTokenExpiresAt).getTime()
    : null;
  if (
    !credentialTokenMatches(conversation.authSecret ?? null, groupToken(headers)) ||
    (expiresAt !== null && expiresAt <= Date.now())
  ) {
    return { ok: false, status: 403, error: BLIND_AUTH_REQUIRED };
  }
  return { ok: true };
}

/**
 * Tambah anggota (`POST /:id/participants`).
 *
 * Opaque Mailbox: server hanya menyiarkan niat; keanggotaan dibuktikan dengan
 * X-Group-Token (possession = anggota), jadi tidak ada join userId di sini.
 */
export function authorizeMemberMutation(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  return checkGroupToken(db, conversationId, headers);
}

/**
 * Kick anggota (`DELETE /:id/participants/:userId`).
 *
 * Hanya capability admin, bukan X-Group-Token bersama: kick harus mencabut
 * akses, bukan sekadar membuktikan keanggotaan. Token grup lama tetap valid
 * untuk anggota lain; route kick merotasinya terpisah.
 */
export function authorizeMemberRemoval(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  return requireAdminCapability(db as unknown as AdminCapabilityDb, conversationId, headers);
}

/**
 * Leave (`DELETE /:id/leave`).
 *
 * Token grup menang bila ada; kalau tidak, anggota tetap boleh mencabut
 * keanggotaannya sendiri lewat baris delivery-token miliknya — kebutuhan nyata
 * (metadata belum ter-decrypt ⇒ authSecret belum ada di klien) dan aman:
 * requireAuth sudah mengaitkan akun, dan baris (userId↔conversationId) sudah
 * ada di server, jadi tidak ada informasi baru yang bocor.
 */
export async function authorizeMemberLeave(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>,
  userId: string
): Promise<GroupGate> {
  const tokenGate = await checkGroupToken(db, conversationId, headers);
  if (tokenGate.ok) return tokenGate;
  // Conversation hilang → tetap 404 (jangan pernah lolos lewat jalur kedua).
  if (tokenGate.status === 404) return tokenGate;

  const ownsDeliveryToken = await findMembership(
    db as unknown as MembershipLookup,
    { userId, conversationId }
  );
  if (!ownsDeliveryToken) return tokenGate;

  return { ok: true };
}

/**
 * Tulis metadata grup (`PUT /:id/details`).
 *
 * CATATAN SEMANTIK LAMA: di sini conversation yang tidak ada juga dijawab 403
 * (bukan 404) — tidak diubah supaya kontrak klien tidak bergeser; yang diuji
 * adalah "tidak ada jalur izin" dan urutan token → admin.
 */
export async function authorizeDetailsWrite(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  const tokenGate = await checkGroupToken(db, conversationId, headers);
  // Legacy: conversation hilang pun dijawab 403 (bukan 404) di jalur ini.
  if (tokenGate.ok) return requireAdminCapability(db as unknown as AdminCapabilityDb, conversationId, headers);
  return { ok: false, status: 403, error: BLIND_AUTH_REQUIRED };
}

/** Rotasi kunci aktif (`POST /:id/key-rotation`) — operasi admin saja. */
export function authorizeKeyRotation(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  return requireAdminCapability(db as unknown as AdminCapabilityDb, conversationId, headers);
}

/**
 * Purge grup permanen (`DELETE /:id/group`).
 *
 * Urutan yang dikunci test: 404 → 400 (non-grup) → 403 token → capability admin
 * → 409 `MEMBERS_REMAIN`. Hitungan anggota dilakukan SETELAH gate admin, dan
 * `ok` di sini berarti "pemanggil boleh menghapus" — bukan "sudah dihapus".
 */
export async function authorizeGroupPurge(
  db: GroupAccessDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<GroupGate> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { authSecret: true, isGroup: true },
  });
  if (!conversation) return { ok: false, status: 404, error: 'Not found' };
  if (!conversation.isGroup) return { ok: false, status: 400, error: 'Not a group' };
  if (!credentialTokenMatches(conversation.authSecret ?? null, groupToken(headers))) {
    return { ok: false, status: 403, error: BLIND_AUTH_REQUIRED };
  }

  const adminGate = await requireAdminCapability(db as unknown as AdminCapabilityDb, conversationId, headers);
  if (!adminGate.ok) return adminGate;

  const remainingMembers = await db.userHiddenConversation.count({ where: { conversationId } });
  if (remainingMembers > 0) {
    return { ok: false, status: 409, error: MEMBERS_REMAIN };
  }
  return { ok: true };
}
