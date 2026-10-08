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
 *
 * [docs/28 Tier 0 — D1 KRITIS] Private key issuer TIDAK disimpan di DB lagi.
 * Akar kepercayaan keanggotaan grup dulu ada di kolom DB: siapa pun yang
 * memegang dump bisa menandatangani credential untuk grup mana pun. Sekarang:
 *   - private key: env `GROUP_ISSUER_KEY_PKCS8` (base64 PKCS#8), atau file dev
 *     0600 `server/.nyx-issuer-key` (hanya non-production, dibuat otomatis),
 *   - DB row `CredentialIssuerKey` menyimpan HANYA material publik
 *     (`publicKeyJwk`) per `keyVersion` — dipakai verifikasi presentasi &
 *     dibagikan ke klien. Rotasi = naikkan `GROUP_ISSUER_KEY_VERSION`.
 *   - production tanpa env key = fail-closed (biar tidak diam-diam memakai key
 *     ephemeral yang berbeda antar instance pm2).
 */

import { RSABSSA } from '@cloudflare/blindrsa-ts'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { prisma } from './prisma.js'
import { env } from '../config.js'

export const CREDENTIAL_SUITE = 'RSABSSA-SHA384-PSS-Randomized'
export const ISSUER_KEY_MODULUS = 2048
/** Serial = SHA-384 hex dari prepared message (48 byte → 96 hex). */
export const SERIAL_HEX_LENGTH = 96
/** Nama env yang memuat private key issuer (base64 PKCS#8). */
export const ISSUER_KEY_ENV = 'GROUP_ISSUER_KEY_PKCS8'
/** Nama env versi key yang aktif (default 1). */
export const ISSUER_KEY_VERSION_ENV = 'GROUP_ISSUER_KEY_VERSION'
const DEFAULT_KEY_VERSION = 1
/** File dev (gitignored) — JANGAN dipakai di production. */
const DEV_KEY_FILE = path.resolve(process.cwd(), '.nyx-issuer-key')

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

/** Versi key aktif: env bila ada, kalau tidak → tertinggi di DB, kalau tidak → 1. */
async function resolveKeyVersion(): Promise<number> {
  const raw = (process.env[ISSUER_KEY_VERSION_ENV] || '').trim()
  const parsed = Number.parseInt(raw, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed

  const latest = await prisma.credentialIssuerKey.findFirst({
    orderBy: { keyVersion: 'desc' },
    select: { keyVersion: true },
  })
  return latest?.keyVersion ?? DEFAULT_KEY_VERSION
}

/** Private key dari env, atau file dev. Tidak pernah dari DB. */
function loadIssuerPrivateKeyPkcs8(): string | null {
  const fromEnv = (process.env[ISSUER_KEY_ENV] || '').trim()
  if (fromEnv) return fromEnv

  try {
    if (existsSync(DEV_KEY_FILE)) {
      const raw = readFileSync(DEV_KEY_FILE, 'utf8').trim()
      if (raw.length > 0) return raw
    }
  } catch (e) {
    console.warn(`[Credentials] Gagal membaca ${DEV_KEY_FILE}:`, e)
  }
  return null
}

/** DEV ONLY: buat key sekali lalu simpan 0600 di file — DB tetap bersih. */
async function generateDevIssuerKey(): Promise<string> {
  const kp = await getSuite().generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: ISSUER_KEY_MODULUS,
  })
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64')
  writeFileSync(DEV_KEY_FILE, `${pkcs8}\n`, { mode: 0o600 })
  console.warn(
    `[Credentials] ${ISSUER_KEY_ENV} tidak diset → issuer key DEV baru dibuat di ${DEV_KEY_FILE} (0600). ` +
    'Production: set env, jangan pakai file. Lihat docs/28 Tier 0.1.'
  )
  return pkcs8
}

/** Turunkan public JWK dari PKCS#8 — server hanya butuh privat di memori. */
export function publicJwkFromPkcs8(pkcs8Base64: string): JsonWebKey {
  const privateKey = createPrivateKey({
    key: Buffer.from(pkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey(privateKey)
  return publicKey.export({ format: 'jwk' }) as JsonWebKey
}

/**
 * Pastikan row PUBLIK ada untuk keyVersion ini dan memang pasangan dari private
 * key yang dipakai (kalau tidak, signature tidak akan pernah bisa diverifikasi
 * klien → fail fast, jangan diam-diam salah tanda tangan).
 */
async function ensurePublicKeyRow(keyVersion: number, publicJwk: JsonWebKey): Promise<void> {
  const existing = await prisma.credentialIssuerKey.findUnique({ where: { keyVersion } })
  if (!existing) {
    await prisma.credentialIssuerKey.create({
      data: { keyVersion, publicKeyJwk: JSON.stringify(publicJwk) },
    })
    return
  }

  let stored: JsonWebKey
  try {
    stored = JSON.parse(existing.publicKeyJwk) as JsonWebKey
  } catch {
    throw new Error(`[Credentials] publicKeyJwk untuk keyVersion ${keyVersion} rusak (bukan JSON).`)
  }
  if (stored.n !== publicJwk.n || stored.e !== publicJwk.e) {
    throw new Error(
      `[Credentials] ${ISSUER_KEY_ENV} (keyVersion ${keyVersion}) TIDAK cocok dengan publicKeyJwk di DB. ` +
      'Naikkan GROUP_ISSUER_KEY_VERSION untuk rotasi, atau perbaiki env-nya.'
    )
  }
}

/**
 * Muat issuer key aktif. Private key dari env/file; DB hanya jadi sumber
 * material publik. Production tanpa env key → error (fail-closed).
 */
export async function getActiveIssuerKey(): Promise<IssuerKey> {
  if (cachedKeyPair) return cachedKeyPair

  const keyVersion = await resolveKeyVersion()

  let pkcs8 = loadIssuerPrivateKeyPkcs8()
  if (!pkcs8) {
    if (env.nodeEnv === 'production') {
      throw new Error(
        `[Credentials] ${ISSUER_KEY_ENV} wajib diset di production (private key issuer ` +
        'tidak boleh disimpan di DB — docs/28 D1).'
      )
    }
    pkcs8 = await generateDevIssuerKey()
  }

  const publicJwk = publicJwkFromPkcs8(pkcs8)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(pkcs8, 'base64'),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    false,
    ['sign']
  )
  await ensurePublicKeyRow(keyVersion, publicJwk)

  cachedKeyPair = {
    keyVersion,
    privateKey,
    publicKey: await publicJwkToCryptoKey(publicJwk),
    publicJwk,
  }
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
 * Public JWK untuk keyVersion tertentu: dari cache bila aktif, kalau tidak dari
 * DB (rotasi lama). Tidak pernah membaca private material dari DB.
 */
async function getPublicJwkForVersion(keyVersion: number): Promise<JsonWebKey | null> {
  if (cachedKeyPair && cachedKeyPair.keyVersion === keyVersion) return cachedKeyPair.publicJwk

  const row = await prisma.credentialIssuerKey.findUnique({ where: { keyVersion } })
  if (!row) return null
  try {
    return JSON.parse(row.publicKeyJwk) as JsonWebKey
  } catch {
    return null
  }
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

  const publicJwk = await getPublicJwkForVersion(keyVersion)
  if (!publicJwk) return false

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

/** Hanya untuk test: buang cache issuer key. */
export function clearIssuerKeyCacheForTests(): void {
  cachedKeyPair = null
}
