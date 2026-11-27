// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.4.1] Privacy Pass pengganti Blind RSA: token acak 256-bit yang
 * dibuat **klien**, bukan tanda tangan buta.
 *
 * Alur:
 *  1. Klien membuat token acak dan mengirim komitmen `SHA-256(token)` saat
 *     issuance (bersama group/member token). Server tidak pernah menerima token
 *     mentah pada langkah ini.
 *  2. Server menyimpan `HMAC(pepper, conversationId || commitment)` saja di
 *     Redis, TTL 24 jam. Tidak ada token/komitmen mentah yang persist.
 *  3. Saat sync anonim, klien menyerahkan token. Server menghitung komitmen dan
 *     HMAC yang sama; token hanya sah bila pernah diterbitkan untuk percakapan
 *     itu, lalu ditandai spent dengan `SET NX`.
 *
 * Unlinkability issuance ↔ redemption tetap bergantung pada OHTTP dan tidak
 * adanya log waktu, sama seperti versi Blind RSA sebelumnya. Yang berubah:
 * tidak ada RSA-2048, tidak ada issuer key yang harus stabil, dan server tidak
 * pernah melihat token yang nanti dipakai.
 *
 * Wire token: `base64url(random(32))`.
 */

import { createHash } from 'node:crypto'
import { pepperedIdentifier } from './atRestSecrets.js'

export const PP_SUITE = 'nyx-pp-token-v1'
export const PP_TOKEN_TTL_SEC = 24 * 60 * 60
export const PP_MAX_ISSUE_PER_REQUEST = 10
/** Batas issuance per member token per jam. */
export const PP_ISSUE_LIMIT = { limit: 30, windowSeconds: 60 * 60 } as const
export const PP_TOKEN_BYTES = 32
export const PP_COMMITMENT_BYTES = 32

const B64URL_RE = /^[A-Za-z0-9_-]+$/

function b64url (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromB64url (value: unknown, expectedBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !B64URL_RE.test(value)) return null
  try {
    const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
    return bytes.length === expectedBytes ? bytes : null
  } catch {
    return null
  }
}

/** `SHA-256(token)` — komitmen yang dikirim klien saat issuance. */
export function ppCommitmentForToken (token: unknown): Uint8Array | null {
  const bytes = fromB64url(token, PP_TOKEN_BYTES)
  if (!bytes) return null
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

/** Validasi komitmen yang dikirim klien (32 byte base64url). */
export function decodePpCommitment (commitment: unknown): Uint8Array | null {
  return fromB64url(commitment, PP_COMMITMENT_BYTES)
}

function ppTag (conversationId: string, commitment: Uint8Array): string {
  // Domain + conversation mengikat token ke grup; HMAC pepper membuat dump Redis
  // tidak bisa dipakai untuk menebak komitmen. Tidak ada token mentah di key.
  return pepperedIdentifier(`pp-token:${conversationId}:${b64url(commitment)}`)
}

/**
 * Terbitkan komitmen. Mengembalikan jumlah yang benar-benar baru; pemanggil
 * memperlakukan hasil < jumlah sebagai kegagalan (klien tidak menyimpan token
 * yang tidak terbit).
 */
export interface PpIssueRedis {
  set (key: string, value: string, options: { EX: number; NX: true }): Promise<string | null>
}

export async function ppIssueCommitments (
  redis: PpIssueRedis,
  conversationId: string,
  commitments: readonly string[]
): Promise<number> {
  if (commitments.length === 0 || commitments.length > PP_MAX_ISSUE_PER_REQUEST) {
    throw new Error('PP_INVALID_COMMITMENT_COUNT')
  }

  const seen = new Set<string>()
  let accepted = 0
  for (const value of commitments) {
    const commitment = decodePpCommitment(value)
    if (!commitment) throw new Error('PP_INVALID_COMMITMENT')
    const key = `pp:issued:${ppTag(conversationId, commitment)}`
    if (seen.has(key)) return accepted
    seen.add(key)
    const stored = await redis.set(key, '1', { EX: PP_TOKEN_TTL_SEC, NX: true })
    if (!stored) return accepted
    accepted += 1
  }
  return accepted
}

export type PpRedeemResult = 'ok' | 'spent' | 'invalid'

export interface PpRedeemRedis extends PpIssueRedis {
  get (key: string): Promise<string | null>
}

/**
 * Redemption sekali pakai. Kunci `pp:issued:*` membuktikan token pernah
 * diterbitkan untuk percakapan ini; `pp:spent:*` mencegah replay dengan TTL
 * seumur token. Keduanya hanya HMAC, bukan token/komitmen mentah.
 */
export async function ppRedeemToken (
  redis: PpRedeemRedis,
  conversationId: string,
  token: string
): Promise<PpRedeemResult> {
  const commitment = ppCommitmentForToken(token)
  if (!commitment) return 'invalid'

  const tag = ppTag(conversationId, commitment)
  if (!await redis.get(`pp:issued:${tag}`)) return 'invalid'

  const stored = await redis.set(`pp:spent:${tag}`, '1', { EX: PP_TOKEN_TTL_SEC, NX: true })
  return stored === 'OK' ? 'ok' : 'spent'
}
