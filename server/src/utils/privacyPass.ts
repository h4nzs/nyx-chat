// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Privacy Pass (RFC 9577/9578, tipe Blind RSA) untuk
 * anti-abuse **anonymous sync**.
 *
 * Kenapa ini ada: sync anonim tidak punya akun untuk di-rate-limit. Bucket per
 * token saja masih membuat server bisa mengorelasikan "token yang sama memanggil
 * berkali-kali"; Privacy Pass memberi bukti "pernah diizinkan" yang tidak bisa
 * dihubungkan ke issuance-nya (unlinkable), sehingga satu token sync tidak
 * menjadi pengenal jangka panjang.
 *
 * Batas kejujuran (ditulis juga di docs/37):
 *  - ini **komposisi protokol** di atas pustaka blind RSA Cloudflare
 *    (`@cloudflare/blindrsa-ts`, RFC 9474). Pustakanya diuji, komposisi wire
 *    format di sini belum diaudit eksternal;
 *  - issuer dan redeemer berada di proses yang sama. Unlinkability issuance ↔
 *    redemption bergantung pada OHTTP + tidak adanya log; tanpa itu, server bisa
 *    mengorelasikan waktu. Jangan mengklaim lebih.
 *
 * Wire token: `base64url(nonce(32) || signature(256))`.
 * Pesan yang ditandatangani mengikat percakapan:
 *   `SHA-384("nyx-pp-v1|" || conversationId || "|" || base64url(nonce))`
 * sehingga token grup A tidak bisa dipakai di grup B.
 */

import { createHash, randomBytes } from 'node:crypto'
import { RSABSSA } from '@cloudflare/blindrsa-ts'

export const PP_SUITE = 'RSABSSA-SHA384-PSS-Deterministic'
export const PP_TOKEN_TTL_SEC = 24 * 60 * 60
export const PP_MAX_ISSUE_PER_REQUEST = 10
/** Batas issuance per member token per jam. */
export const PP_ISSUE_LIMIT = { limit: 30, windowSeconds: 60 * 60 } as const
const NONCE_BYTES = 32
const SIGNATURE_BYTES = 256
const TOKEN_BYTES = NONCE_BYTES + SIGNATURE_BYTES
const PP_DOMAIN = 'nyx-pp-v1'

const suite = RSABSSA.SHA384.PSS.Deterministic()

export interface PpIssuerKeys {
  keyId: string
  publicKey: CryptoKey
  privateKey: CryptoKey
  publicJwk: JsonWebKey
}

let cachedKeys: PpIssuerKeys | null = null

function b64url (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromB64url (value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    return new Uint8Array(Buffer.from(value, 'base64url'))
  } catch {
    return null
  }
}

/** Pesan yang ditandatangani issuer (binding ke percakapan). */
export function ppMessage (conversationId: string, nonce: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash('sha384')
      .update(`${PP_DOMAIN}|${conversationId}|`)
      .update(nonce)
      .digest()
  )
}

export function encodePpToken (nonce: Uint8Array, signature: Uint8Array): string {
  const combined = new Uint8Array(nonce.length + signature.length)
  combined.set(nonce, 0)
  combined.set(signature, nonce.length)
  return b64url(combined)
}

export function decodePpToken (token: unknown): { nonce: Uint8Array; signature: Uint8Array } | null {
  if (typeof token !== 'string') return null
  const raw = fromB64url(token)
  if (!raw || raw.length !== TOKEN_BYTES) return null
  return { nonce: raw.subarray(0, NONCE_BYTES), signature: raw.subarray(NONCE_BYTES) }
}

export function newPpNonce (): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_BYTES))
}

/**
 * Muat kunci issuer dari `PP_ISSUER_PRIVATE_JWK` (JSON JWK, rahasia server).
 *
 * Di production kunci WAJIB diset: kunci ephemeral berarti setiap restart
 * membatalkan semua token yang sudah dipegang klien (sync akan gagal sampai
 * klien meminta token baru). Di dev/test, kunci ephemeral dipakai dengan
 * peringatan supaya `pnpm test` tidak butuh rahasia.
 */
export async function loadPpIssuerKeys (envPrivateJwk?: string): Promise<PpIssuerKeys> {
  if (cachedKeys) return cachedKeys

  const raw = (envPrivateJwk ?? process.env.PP_ISSUER_PRIVATE_JWK ?? '').trim()
  if (raw) {
    const jwk = JSON.parse(raw) as JsonWebKey
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-PSS', hash: 'SHA-384' },
      true,
      ['sign']
    )
    // WebCrypto menolak import bila `key_ops` JWK tidak sesuai usage yang
    // diminta; JWK hasil exportKey berisi `key_ops: ['sign']`. Kunci publik
    // dibangun ulang HANYA dari parameter publik.
    const publicJwk: JsonWebKey = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'PS384', ext: true }
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'RSA-PSS', hash: 'SHA-384' },
      true,
      ['verify']
    )
    const keyId = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex').slice(0, 16)
    cachedKeys = { keyId, publicKey, privateKey, publicJwk }
    return cachedKeys
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PP_ISSUER_PRIVATE_JWK wajib diset di production: token Privacy Pass ' +
        'harus bertahan lintas restart (docs/37 §37.3.3).'
    )
  }
  console.warn('[privacyPass] PP_ISSUER_PRIVATE_JWK tidak diset — memakai kunci ephemeral (dev).')
  const pair = await RSABSSA.SHA384.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) })
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  const keyId = createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex').slice(0, 16)
  cachedKeys = { keyId, publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk }
  return cachedKeys
}

/** Untuk test: buang cache kunci. */
export function clearPpKeyCacheForTests (): void {
  cachedKeys = null
}

/** Tanda tangani N pesan ter-blind (issuance). Input/output base64url. */
export async function ppBlindSign (blindedMessages: readonly string[]): Promise<string[]> {
  const keys = await loadPpIssuerKeys()
  const out: string[] = []
  for (const blinded of blindedMessages) {
    const bytes = fromB64url(blinded)
    if (!bytes || bytes.length !== SIGNATURE_BYTES) throw new Error('PP_INVALID_BLINDED_MESSAGE')
    const signature = await suite.blindSign(keys.privateKey, bytes)
    out.push(b64url(signature))
  }
  return out
}

/**
 * Verifikasi token untuk percakapan tertentu (tanpa efek samping).
 * `false` untuk bentuk rusak, signature salah, atau binding grup tidak cocok.
 */
export async function ppVerifyToken (conversationId: string, token: unknown): Promise<boolean> {
  const decoded = decodePpToken(token)
  if (!decoded) return false
  const keys = await loadPpIssuerKeys()
  try {
    return await suite.verify(
      keys.publicKey,
      decoded.signature,
      ppMessage(conversationId, decoded.nonce)
    )
  } catch {
    return false
  }
}

export type PpRedeemResult = 'ok' | 'spent' | 'invalid'

/**
 * Bagian klien Redis yang dipakai redemption: **hanya** `SET` dengan opsi.
 *
 * Sengaja bukan `Pick<RedisClientType,'set'>`: tanda tangan node-redis punya
 * banyak overload, sehingga pemanggil (dan fake Redis di test) harus memakai
 * cast. Bentuk di bawah adalah satu-satunya overload yang benar — objek
 * `{ EX, NX }` — dan itulah yang dipaksakan ke pemanggil.
 */
export interface PpRedeemRedis {
  set (key: string, value: string, options: { EX: number; NX: true }): Promise<string | null>
}

/**
 * Redemption sekali pakai. Kunci double-spend = SHA-256(token) di Redis dengan
 * TTL = umur token — tidak menyimpan token mentah dan tidak menyebut percakapan
 * di key (agar tidak menjadi graf).
 *
 * [audit F-01] Sebelum ini argumen dikirim posisional (`'EX', ttl, 'NX'`),
 * bentuk yang **diabaikan** node-redis 6: SET berjalan tanpa NX dan tanpa TTL,
 * jadi token bisa di-replay selamanya dan key `pp:spent:*` tumbuh tanpa batas.
 * Opsi harus berupa objek `{ EX, NX: true }`.
 */
export async function ppRedeemToken (
  redis: PpRedeemRedis,
  conversationId: string,
  token: string
): Promise<PpRedeemResult> {
  if (!await ppVerifyToken(conversationId, token)) return 'invalid'

  const spentKey = `pp:spent:${createHash('sha256').update(token).digest('hex')}`
  const stored = await redis.set(spentKey, '1', { EX: PP_TOKEN_TTL_SEC, NX: true })
  return stored === 'OK' ? 'ok' : 'spent'
}
