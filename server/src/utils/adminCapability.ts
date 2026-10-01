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
 * - Hash NULL (grup legacy pra-26.9) = BYPASS kompatibilitas — tidak bisa
 *   di-rotate retroaktif tanpa creator online; grup baru selalu terisi.
 * - Hash terpasang → token wajib cocok (timing-safe terhadap HASH, bukan
 *   token mentah — panjang token tidak pernah bocor ke perbandingan).
 */
export function isAdminTokenValid(adminSecretHash: string | null | undefined, presentedToken: string): boolean {
  if (!adminSecretHash) return true; // legacy group: compat bypass
  if (!presentedToken) return false;
  return safeEqualStrings(adminSecretHash, hashAdminToken(presentedToken));
}
