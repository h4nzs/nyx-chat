// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [26.8.1] Group membership credentials — blind RSA (RFC 9474 / RSABSSA).
 *
 * Menggantikan lookup `deliveryToken` saat SYNC dengan verifikasi credential:
 *   - Klien membuat random message per (conversation, member) — 128-bit random,
 *     BUKAN identitas — lalu blind dan minta server menandatangani buta.
 *   - Server TIDAK bisa mengaitkan blinded message dengan conversation/anggota;
 *     yang ia simpan hanya serial (hash dari prepared message) untuk dedupe.
 *   - Saat sync, klien mempresentasikan (preparedMsg, signature); server
 *     verifikasi tanda tangan + cek serial terdaftar untuk conversation tsb.
 *   - Revocation (kick/leave) = hapus row serial → credential mati tanpa
 *     server mengetahui pemiliknya.
 *
 * Suite: RSABSSA-SHA384-PSS-Randomized (RFC 9474 §5, rekomendasi utama).
 */

import { RSABSSA } from '@cloudflare/blindrsa-ts'
import { createHash } from 'node:crypto'
import { prisma } from './prisma.js'

export const CREDENTIAL_SUITE = 'RSABSSA-SHA384-PSS-Randomized'
export const ISSUER_KEY_MODULUS = 2048
/** Serial = SHA-384 hex dari prepared message (48 byte → 96 hex). */
export const SERIAL_HEX_LENGTH = 96

type Suite = ReturnType<typeof RSABSSA.SHA384.PSS.Randomized>
type GeneratedKeyPair = Awaited<ReturnType<Suite['generateKey']>>

let cachedSuite: Suite | null = null
interface IssuerKey {
  keyVersion: number
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: JsonWebKey
}
let cachedKeyPair: IssuerKey | null = null

export function getSuite(): Suite {
  if (!cachedSuite) cachedSuite = RSABSSA.SHA384.PSS.Randomized()
  return cachedSuite
}

function publicJwkToCryptoKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['verify'])
}

/**
 * Muat (atau buat) issuer key aktif. Key disimpan di DB agar semua instance
 * pm2 cluster menandatangani dengan key yang sama. keyVersion = urutan
 * rotasi; klien membawa keyVersion saat mempresentasikan.
 */
export async function getActiveIssuerKey(): Promise<IssuerKey> {
  if (cachedKeyPair) return cachedKeyPair

  const rows = await prisma.credentialIssuerKey.findMany({ orderBy: { keyVersion: 'desc' }, take: 1 })
  let row = rows[0]

  if (!row) {
    const kp = await getSuite().generateKey({
      publicExponent: Uint8Array.from([1, 0, 1]),
      modulusLength: ISSUER_KEY_MODULUS,
    })
    const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
    const privateKeyPkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64')
    row = await prisma.credentialIssuerKey.create({
      data: { keyVersion: 1, publicKeyJwk: JSON.stringify(publicJwk), privateKeyPkcs8 },
    })
  }

  const publicJwk = JSON.parse(row.publicKeyJwk) as JsonWebKey
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(row.privateKeyPkcs8, 'base64'),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    false,
    ['sign']
  )
  const publicKey = await publicJwkToCryptoKey(publicJwk)

  cachedKeyPair = { keyVersion: row.keyVersion, privateKey, publicKey, publicJwk }
  return cachedKeyPair
}

/** Public key (JWK) untuk klien — dibagikan bebas. */
export async function getIssuerPublicJwk(): Promise<{ keyVersion: number; publicJwk: JsonWebKey }> {
  const { keyVersion, publicJwk } = await getActiveIssuerKey()
  return { keyVersion, publicJwk }
}

/** Serial deterministik dari prepared message (untuk dedupe & revocation). */
export function serialOf(preparedMsg: Uint8Array): string {
  return createHash('sha384').update(preparedMsg).digest('hex')
}

/**
 * Tanda tangani blinded message. Server TIDAK tahu isi aslinya.
 * Rate limit & quota ditekan di route (bukan di sini).
 */
export async function blindSign(blindedMsg: Uint8Array): Promise<{ blindSig: Uint8Array; keyVersion: number }> {
  const { privateKey, keyVersion } = await getActiveIssuerKey()
  const blindSig = await getSuite().blindSign(privateKey, blindedMsg)
  return { blindSig: new Uint8Array(blindSig), keyVersion }
}

export type IssuedCredentialRow = { serial: string; conversationId: string }

/**
 * Catat serial credential yang diterbitkan (dedupe + keanggotaan anonim).
 * Dipanggil dengan conversationId yang DIBAWA KLIEN saat issuance — server
 * mengaitkan serial↔conversation untuk verifikasi presentasi, tapi serial
 * dibangun dari random message sehingga tidak bisa di-link ke siapa pun.
 */
export async function recordIssuedCredential(serial: string, conversationId: string, keyVersion: number): Promise<void> {
  await prisma.groupCredential.upsert({
    where: { serial },
    update: {},
    create: { serial, conversationId, keyVersion },
  })
}

export async function isSerialIssued(serial: string): Promise<boolean> {
  const row = await prisma.groupCredential.findUnique({ where: { serial }, select: { id: true } })
  return row !== null
}

/**
 * Verifikasi presentasi credential: tanda tangan valid (issuer key versi
 * `keyVersion`) DAN serial terdaftar untuk conversationId. Tidak ada lookup
 * identitas — kepemilikan (msg, sig) = bukti keanggotaan.
 */
export async function verifyPresentation(
  conversationId: string,
  keyVersion: number,
  preparedMsg: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const serial = serialOf(preparedMsg)
  const registered = await prisma.groupCredential.findUnique({
    where: { serial },
    select: { conversationId: true, keyVersion: true },
  })
  if (!registered || registered.conversationId !== conversationId) return false
  if (registered.keyVersion !== keyVersion) return false

  const rows = await prisma.credentialIssuerKey.findMany({ where: { keyVersion }, take: 1 })
  const keyRow = rows[0]
  if (!keyRow) return false

  const publicJwk = JSON.parse(keyRow.publicKeyJwk) as JsonWebKey
  const publicKey = await publicJwkToCryptoKey(publicJwk)
  try {
    return await getSuite().verify(publicKey, signature, preparedMsg)
  } catch {
    return false
  }
}

/** Revocation: hapus serial → credential mati (kick/leave memanggil ini). */
export async function revokeCredentialsFor(conversationId: string, serials: string[]): Promise<void> {
  if (serials.length === 0) return
  await prisma.groupCredential.deleteMany({ where: { conversationId, serial: { in: serials } } })
}
