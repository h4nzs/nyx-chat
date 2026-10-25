// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createHash } from 'node:crypto'
import { safeEqualStrings } from './validate.js'

// [26.9 RBAC] Admin capability guard ======================================
// Server tidak tahu roster/role (Opaque Mailbox) — role diverifikasi via
// POSSESSION of admin capability token: creator menaruh SHA-256(token) di
// kolom Conversation.adminSecretHash, token asli hanya dimiliki OWNER/ADMIN
// (pairwise-sealed ke device mereka; server hanya relay amplop opaque).
// Header `X-Admin-Token` dibandingkan timing-safe terhadap hash.

/** Normalisasi header Node (string ATAU string[] — req.headers bisa keduanya). */
export function extractHeader(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return (value[0] as string) ?? '';
  return '';
}

/** SHA-256 hex (lowercase, 64-char) dari token — kontrak kolom adminSecretHash. */
export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Verifikasi kepemilikan admin capability token.
 *
 * [2026-10 legacy purge] Dulu hash NULL = BYPASS kompatibilitas untuk grup
 * pra-26.9. Sekarang FAIL-CLOSED: tanpa hash tidak ada operasi admin. Jalur
 * create grup menolak permintaan tanpa `adminSecretHash` (lihat routes/
 * conversations.ts), jadi grup tanpa hash tidak lagi bisa lahir.
 *
 * Token dibandingkan timing-safe terhadap HASH (bukan token mentah) — panjang
 * token tidak pernah bocor ke perbandingan.
 */
export function isAdminTokenValid(adminSecretHash: string | null | undefined, presentedToken: string): boolean {
  if (!adminSecretHash) return false;
  if (!presentedToken) return false;
  return safeEqualStrings(adminSecretHash, hashAdminToken(presentedToken));
}

/**
 * Bentuk minimal klien Prisma untuk guard capability admin.
 * Dipakai `groupAccess.ts` (routes grup) dan test perilaku.
 */
export interface AdminCapabilityDb {
  conversation: {
    findUnique(args: {
      where: { id: string };
      select: { adminSecretHash?: boolean };
    }): Promise<{ adminSecretHash?: string | null } | null>;
  };
}

/**
 * Guard capability admin grup: 404 bila conversation hilang, 403 bila token
 * tidak ada/salah. `ADMIN_AUTH_REQUIRED` adalah kontrak klien.
 */
export async function requireAdminCapability(
  db: AdminCapabilityDb,
  conversationId: string,
  headers: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { adminSecretHash: true },
  });
  if (!conversation) return { ok: false, status: 404, error: 'Not found' };
  if (!isAdminTokenValid(conversation.adminSecretHash, extractHeader(headers['x-admin-token']))) {
    return { ok: false, status: 403, error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token' };
  }
  return { ok: true };
}
