// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.5 / D14] Identitas at-rest untuk Redis.
 *
 * Redis persisten (AOF) adalah artefak yang setara dengan dump DB: apa pun yang
 * kita tulis ke sana bisa bocor. Sebelum ini Redis memuat **userId asli** di
 * banyak tempat — `online_users` (SET seluruh roster), `active_device:<userId>`,
 * `cache:keys:*:<userId>`, `rate_limit:*:<userId>`, nilai
 * `linking_token:<t>` = `{userId, deviceId}`, dan member `burner:room:*`.
 *
 * Dua primitif, sesuai apakah nilainya perlu dibaca kembali:
 *
 *  1. `identityTag()` — HMAC(pepper, "redis:"+userId). Satu arah; dipakai untuk
 *     **keanggotaan SET** yang hanya perlu dibandingkan (`online_users`) dan
 *     untuk **sufiks key** (`active_device:*`, `cache:keys:*`, `rate_limit:*`).
 *     Key jadi tidak bisa dipetakan ke user dari dump.
 *
 *  2. `sealIdentity()` / `openIdentity()` — AEAD deterministik (`sealAtRest`).
 *     Dipakai saat nilai HARUS bisa dipulihkan (member `burner:room:*` dipakai
 *     sebagai target kirim). Deterministik → perbandingan & `sRem`
 *     tetap bekerja, tapi dump hanya melihat ciphertext.
 *
 * [2026-10 legacy purge] Toleransi nilai plaintext dibuang — semua member/key
 * Redis kini ter-seal.
 */

import { openAtRest, pepperedIdentifier, sealAtRest } from './atRestSecrets.js'

const TAG_NAMESPACE = 'redis:v1'


/** Tag satu-arah untuk keanggotaan SET / sufiks key. */
export function identityTag(userId: string): string {
  return pepperedIdentifier(`${TAG_NAMESPACE}:${userId}`)
}

/** Key Redis yang namanya mengandung identitas: `<base>:<tag>`. */
export function identityKey(base: string, userId: string): string {
  return `${base}:${identityTag(userId)}`
}

/** Member SET yang harus bisa dipulihkan (routing) → ciphertext deterministik. */
export async function sealIdentity(userId: string): Promise<string> {
  return sealAtRest(userId)
}

/**
 * Buka member ter-seal. Mengembalikan null untuk nilai yang tak bisa dibuka.
 * [2026-10 legacy purge] Dulu ada `openIdentityOrRaw` yang mengembalikan nilai
 * plaintext apa adanya; member Redis sekarang selalu ter-seal.
 */
export async function openIdentity(sealed: string | null | undefined): Promise<string | null> {
  return openAtRest(sealed)
}

/** Buka seluruh member SET, buang yang tak valid. */
export async function openIdentityMembers(members: string[]): Promise<string[]> {
  const resolved = await Promise.all(members.map((m) => openIdentity(m)))
  return resolved.filter((m): m is string => typeof m === 'string' && m.length > 0)
}

/** Bandingkan nilai tersimpan (ter-seal) dengan userId yang dicari. */
export async function identityMatches(stored: string | null | undefined, userId: string): Promise<boolean> {
  if (!stored) return false
  return stored === (await sealIdentity(userId))
}
