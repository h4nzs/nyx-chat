// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.1 + docs/30 WS-G] Otorisasi issuance credential & capability admin.
 *
 * Diekstrak dari `routes/conversations.ts` supaya keputusannya bisa diuji
 * sebagai **perilaku** dengan klien Prisma palsu (aturan `docs/29` §5.8: klaim
 * otorisasi tidak boleh hanya diuji sebagai regex atas source). Yang diuji di
 * `tests/credentialAuth.test.ts` persis matriks keputusan di sini:
 *
 *   - issuance credential = BUKTI KEANGGOTAAN, bukan "user terautentikasi +
 *     tahu UUID conversation" (temuan HIGH §7.1). Dua bentuk bukti, keduanya
 *     token-first (tanpa join userId — konsisten dengan discovery T3b):
 *       1. `X-Group-Token` = authSecret grup (blind member auth),
 *       2. `X-Delivery-Tokens` / `deliveryToken` (body) = token undangan;
 *          possession = keanggotaan, server hanya mencocokkan baris
 *          (conversationId, deliveryToken) tanpa tahu siapa pemiliknya.
 *   - capability admin = hash `X-Admin-Token` cocok `conversation.adminSecretHash`.
 *
 * Catatan privasi: fungsi ini TIDAK pernah menulis log berisi token, dan
 * pencariannya hanya dengan nilai (bukan identitas) — server tidak bisa
 * memetakan token ke user.
 */

import { isAdminTokenValid, extractHeader } from './adminCapability.js';
import { credentialTokenMatches } from './atRestSecrets.js';

/** [T3b] Bentuk token undangan (opaque, 22 char base64url). */
export const DELIVERY_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Batas jumlah token yang di-query dalam satu permintaan (anti-amplifikasi). */
export const MAX_DELIVERY_TOKENS = 500;

/**
 * Bentuk minimal klien Prisma (metode bergaya `method()`, jadi bivarian →
 * PrismaClient asli tetap assignable lewat cast di call site).
 */
export interface CredentialAuthDb {
  conversation: {
    findUnique(args: {
      where: { id: string };
      select: { authSecret?: boolean; adminSecretHash?: boolean };
    }): Promise<{ authSecret?: string | null; adminSecretHash?: string | null } | null>;
  };
  userHiddenConversation: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id?: boolean };
    }): Promise<{ id?: string } | null>;
  };
}

function headerToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return String(value[0] ?? '');
  return '';
}

/**
 * Apakah pemanggil boleh menerima blind signature untuk `conversationId`?
 *
 * Mengembalikan `false` (→ route menjawab 403) untuk: conversation tidak ada,
 * tanpa token, token grup salah, token undangan tidak terdaftar, atau token
 * berformat tidak sah. Tidak ada jalur "fail-open".
 */
export async function authorizeCredentialIssuance(
  db: CredentialAuthDb,
  conversationId: string,
  headers: Record<string, unknown>,
  bodyToken?: string
): Promise<boolean> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { authSecret: true },
  });
  if (!conversation) return false;

  const groupToken = headerToString(headers['x-group-token']);
  if (credentialTokenMatches(conversation.authSecret, groupToken)) return true;

  const tokens = headerToString(headers['x-delivery-tokens'])
    .split(',')
    .map((t) => t.trim())
    .filter((t) => DELIVERY_TOKEN_RE.test(t));
  if (typeof bodyToken === 'string' && DELIVERY_TOKEN_RE.test(bodyToken)) tokens.push(bodyToken);
  if (tokens.length === 0) return false;

  const row = await db.userHiddenConversation.findFirst({
    where: {
      conversationId,
      deliveryToken: { in: [...new Set(tokens)].slice(0, MAX_DELIVERY_TOKENS) },
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Apakah pemanggil memegang capability admin grup ini?
 *
 * Dipakai sebelum operasi yang mengubah struktur grup (add/kick/rotate).
 * `ADMIN_AUTH_REQUIRED` pada 403 adalah kontrak dengan klien (bukan pesan bebas).
 */
export async function requireAdminCapability(
  db: CredentialAuthDb,
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
