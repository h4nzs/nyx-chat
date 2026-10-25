// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 TIER 0 — AT-REST SECRETS]
 *
 * Satu tempat untuk semua nilai yang historically disimpan plaintext/hash-tanpa-kunci
 * di DB NYX. Tujuannya satu: **dump database saja tidak cukup** untuk membacanya
 * (adversary A1 di docs/28-db-dump-threat-model.md).
 *
 * Tiga primitif, sesuai kebutuhan tiap nilai:
 *
 *  1. `pepperedIdentifier()` — HMAC-SHA256(pepper, nilai) untuk nilai yang hanya
 *     perlu di-*bandingkan* (blind index username, IP, fingerprint perangkat).
 *     Inputnya berentropi rendah (IP/fingerprint/username manusia), jadi hash
 *     TANPA kunci = bisa dienumerasi. Pepper hidup di env, bukan di DB.
 *
 *  2. `hashCredentialToken()` — SHA-256 hex dari token acak ≥128-bit yang dipegang
 *     klien (authSecret grup, deleteSecret pesan). Pola ini sudah dipakai repo
 *     untuk `adminSecretHash`: token aslinya tidak pernah persist di server.
 *     Token 256-bit tidak bisa di-brute force, jadi pepper tidak dibutuhkan.
 *
 *  3. `sealAtRest()` / `openAtRest()` — AEAD deterministik (XChaCha20-Poly1305,
 *     nonce = HMAC(kunci seal, plaintext)). Untuk nilai yang server HARUS bisa
 *     baca kembali (mis. routing identity / API key tenant): sama-sama tak
 *     terbaca dari dump, tapi tetap reversible untuk lookup & fungsionalitas.
 *
 * [docs/37 §37.4 P6] Envelope seal sekarang **ber-versi**:
 *
 *   - legacy (tanpa prefiks) = kunci id `0`, diturunkan dari `NYX_AT_REST_PEPPER`.
 *     Semua baris lama berbentuk ini dan **selalu tetap terbaca** — rotasi tidak
 *     boleh membuat data hilang.
 *   - baru = `ENC2:<keyId>:<base64url(nonce||ct)>`, kunci dari key ring
 *     (`NYX_AT_REST_KEYRING` atau file custody-nya, lihat `utils/keyCustody.ts`).
 *
 * Karena kunci berbeda menghasilkan ciphertext berbeda, setiap pencarian nilai
 * ter-seal WAJIB memakai `sealedLookupCandidates()` (kandidat kunci aktif +
 * legacy), bukan `sealAtRest()` tunggal. Setelah re-seal selesai hanya kandidat
 * aktif yang cocok, jadi daftar itu tetap benar.
 *
 * Pepper (`NYX_AT_REST_PEPPER`) tetap wajib di production untuk: kunci legacy
 * id `0` (membaca baris lama) dan seluruh blind index HMAC. Di dev ia jatuh ke
 * turunan JWT_SECRET (dengan peringatan) supaya onboarding tidak putus. Jangan
 * pernah menulis pepper/keyring ke DB/backup.
 *
 * Batas jujur: rotasi **blind index** (`pepperedIdentifier`) tidak ada di sini.
 * HMAC satu arah + nilai mentah tidak disimpan server, jadi kolom itu tidak bisa
 * di-reindex tanpa plaintext dari klien (lihat docs/37 §37.4 P6).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'
import { getSodium } from '../lib/sodium.js'
import { readCustodySecret, type KeyCustodyProvider } from './keyCustody.js'

/** Bentuk nilai yang sudah di-hash SHA-256 hex (pola `adminSecretHash`). */
const HEX64_RE = /^[a-f0-9]{64}$/

const SEAL_KEY_INFO = 'NYX_AT_REST_SEAL_V1'
const SEAL_KEY_INFO_V2 = 'NYX_AT_REST_SEAL_V2'
const NONCE_BYTES = 24
const SEAL_KEY_MAX = 32

/** Prefiks envelope seal ber-versi (docs/37 §37.4 P6). */
export const AT_REST_ENVELOPE_V2 = 'ENC2'
export const AT_REST_KEYRING_ENV = 'NYX_AT_REST_KEYRING'
export const AT_REST_KEYRING_FILE_ENV = 'NYX_AT_REST_KEYRING_FILE'
/** Id kunci legacy: diturunkan dari pepper, tanpa prefiks envelope. */
export const LEGACY_SEAL_KEY_ID = '0'
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/

let cachedPepper: string | null = null
let cachedKeyring: AtRestKeyring | null = null
/** Key id yang sudah diperingatkan (cegah spam log pada jalur baca panas). */
const warnedUnknownKeyIds = new Set<string>()

function warnUnknownKeyId (keyId: string): void {
  if (warnedUnknownKeyIds.has(keyId)) return
  warnedUnknownKeyIds.add(keyId)
  console.warn(
    `[atRestSecrets] Ada nilai ter-seal dengan kunci "${keyId}" yang tidak ada di key ring — ` +
      'nilai itu TIDAK bisa dibaca. Tambahkan kunci tersebut ke NYX_AT_REST_KEYRING ' +
      '(jangan menjalankan tanpa key ring setelah re-seal; docs/10 §10.17).'
  )
}

export interface AtRestSealKey {
  id: string
  /** Kunci AEAD XChaCha20-Poly1305 (32 byte). */
  key: Uint8Array
  /** Kunci HMAC untuk nonce deterministik per kunci. */
  nonceKey: Buffer
}

export interface AtRestKeyring {
  activeId: string
  keys: Map<string, AtRestSealKey>
  custody: { provider: KeyCustodyProvider; source: string | null }
}

/** Pepper tunggal untuk semua derivasi at-rest. */
export function getAtRestPepper(): string {
  if (cachedPepper !== null) return cachedPepper

  const explicit = (process.env.NYX_AT_REST_PEPPER || '').trim()
  if (explicit) {
    cachedPepper = explicit
    return cachedPepper
  }

  if (env.nodeEnv === 'production') {
    throw new Error(
      'NYX_AT_REST_PEPPER wajib diset di production: hash identifier & seal at-rest ' +
      'harus memakai key yang tidak ikut ter-dump (lihat docs/28 §28.5 Tier 0).'
    )
  }

  console.warn(
    '[atRestSecrets] NYX_AT_REST_PEPPER tidak diset — memakai fallback dev turunan ' +
    'JWT_SECRET. Set NYX_AT_REST_PEPPER di .env sebelum production.'
  )
  cachedPepper = `dev-pepper:${env.jwtSecret}`
  return cachedPepper
}

/**
 * Blind index deterministik — nilai sama → hash sama (wajib untuk lookup
 * `where: { kolom: nilai }`), tapi tak bisa dibalik tanpa pepper.
 */
export function pepperedIdentifier(value: string): string {
  return createHmac('sha256', getAtRestPepper()).update(value).digest('hex')
}

/**
 * [docs/28 §R5] Prefiks shareId publik. Sengaja berbeda dari bentuk hash
 * (43 base64url / 64 hex) supaya route pencarian bisa memilih kolom lookup
 * tanpa menebak, dan supaya tautan baru tidak pernah membawa blind index.
 */
export const SHARE_ID_PREFIX = 's1_'
export const SHARE_ID_BODY_LENGTH = 43
const SHARE_ID_RE = /^[A-Za-z0-9_-]{43}$/

/** 32 byte acak → `s1_<base64url>` (46 karakter). */
export function generateShareId(): string {
  return `${SHARE_ID_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isShareId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.startsWith(SHARE_ID_PREFIX) &&
    trimmed.length === SHARE_ID_PREFIX.length + SHARE_ID_BODY_LENGTH &&
    SHARE_ID_RE.test(trimmed.slice(SHARE_ID_PREFIX.length))
}

/**
 * Apakah `value` berbentuk identifier yang boleh di-lookup?
 *
 * Tiga bentuk yang sah:
 *  - 43 karakter base64url = Argon2id(username) yang dihitung klien;
 *  - 64 hex = blind index ter-pepper yang PERNAH diterbitkan server
 *    (echo pada link berbagi profil / hash-ID);
 *  - `s1_<43 base64url>` = shareId acak (docs/28 §R5) — lookup ke kolom
 *    `User.shareId`, BUKAN ke `usernameHash`.
 *
 * [docs/35 Fase 4 — R5] Nilai mentah (username/email/IP apa pun) TIDAK sah:
 * kalau server mau memetakan nilai mentah ke baris, pemegang dump cukup
 * menebak lewat API hidup dan server yang menghitungkan HMAC-nya. Batas ini
 * yang menutup R5.
 */
export function isSearchableIdentifier(value: string): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (isShareId(trimmed)) return true
  return (trimmed.length === 43 && /^[A-Za-z0-9_-]+$/.test(trimmed)) || HEX64_RE.test(trimmed.toLowerCase())
}

/**
 * Nilai lookup kanonik untuk kolom identifier — HANYA bentuk hash.
 *
 * - 43-char (hash klien) → `[HMAC_pepper(value)]` (satu-satunya kandidat).
 * - 64-hex → `[value]` karena itu SUDAH nilai tersimpan yang di-echo server
 *   (link berbagi profil). Menghitung HMAC atas hash itu tidak akan pernah
 *   cocok dan hanya menambah satu query.
 *
 * [docs/35 Fase 4 — R5] Tidak ada lagi kandidat `value` mentah. Sebelumnya
 * fungsi ini mengembalikan `[ter-pepper, nilai kiriman]`, sehingga pencarian
 * dengan username plaintext bisa mencocokkan baris yang menyimpan nilai
 * tersebut — persis oracle yang ingin ditutup. Baris legacy pra-pepper sudah
 * tidak ada (lihat `credentialTokenMatches`), jadi tak ada yang hilang.
 *
 * [docs/28 §R5] Jangan panggil fungsi ini dengan shareId (`s1_…`): route
 * pencarian mem-branch ke kolom `User.shareId` lebih dulu.
 */
export function identifierLookupCandidates(value: string): string[] {
  const trimmed = value.trim()
  if (HEX64_RE.test(trimmed.toLowerCase())) return [trimmed.toLowerCase()]
  return [pepperedIdentifier(trimmed)]
}

/** SHA-256 hex dari token yang dipegang klien (`adminSecretHash` pattern). */
export function hashCredentialToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Cocokkan token yang dipresentasikan klien dengan nilai tersimpan.
 *
 * [2026-10 legacy purge] Nilai tersimpan WAJIB hash SHA-256; cabang plaintext
 * (baris pra-hash) dibuang — tidak ada lagi baris seperti itu di DB.
 */
export function credentialTokenMatches(stored: string | null | undefined, presented: string): boolean {
  if (!stored || !presented) return false
  return timingSafeEqualStr(stored, hashCredentialToken(presented))
}

/** Apakah nilai tersimpan berbentuk hash SHA-256 hex? */
export function isHashedToken(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && HEX64_RE.test(stored)
}

/** Kunci legacy id `0` — turunan pepper, persis seperti sebelum P6. */
function legacySealKey(pepper: string): AtRestSealKey {
  const key = new Uint8Array(
    createHmac('sha256', pepper).update(SEAL_KEY_INFO).digest().subarray(0, SEAL_KEY_MAX)
  )
  return { id: LEGACY_SEAL_KEY_ID, key, nonceKey: Buffer.from(pepper, 'utf8') }
}

/** Kunci dari materi key ring (string rahasia, bukan pepper). */
function sealKeyFromMaterial(id: string, material: string): AtRestSealKey {
  const seed = Buffer.from(material, 'utf8')
  const key = new Uint8Array(
    createHmac('sha256', seed).update(SEAL_KEY_INFO_V2).digest().subarray(0, SEAL_KEY_MAX)
  )
  const nonceKey = createHmac('sha256', seed).update(`${SEAL_KEY_INFO_V2}:nonce`).digest()
  return { id, key, nonceKey }
}

/**
 * Parse `NYX_AT_REST_KEYRING`:
 * `{"active":"<id>","keys":{"<id>":"<materi rahasia ≥16 char>"}}`.
 *
 * Id `0` dicadangkan untuk kunci legacy pepper — operator tidak boleh menimpanya,
 * karena itu akan membuat baris lama tak terbaca tanpa jejak yang jelas.
 */
function parseKeyring(raw: string): { activeId: string; keys: Map<string, AtRestSealKey> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('bukan JSON yang valid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('harus objek JSON {"active","keys"}')
  }

  const obj = parsed as Record<string, unknown>
  const activeId = typeof obj.active === 'string' ? obj.active.trim() : ''
  if (!KEY_ID_RE.test(activeId)) throw new Error('field "active" wajib berupa id 1–16 karakter [A-Za-z0-9_-]')
  if (activeId === LEGACY_SEAL_KEY_ID) throw new Error('id "0" dicadangkan untuk kunci legacy pepper')

  const keysRaw = obj.keys
  if (!keysRaw || typeof keysRaw !== 'object' || Array.isArray(keysRaw)) {
    throw new Error('field "keys" wajib objek id → materi')
  }

  const keys = new Map<string, AtRestSealKey>()
  for (const [id, material] of Object.entries(keysRaw as Record<string, unknown>)) {
    if (!KEY_ID_RE.test(id)) throw new Error(`id kunci "${id}" tidak valid`)
    if (id === LEGACY_SEAL_KEY_ID) throw new Error('id "0" dicadangkan untuk kunci legacy pepper')
    if (typeof material !== 'string' || material.trim().length < 16) {
      throw new Error(`materi kunci "${id}" harus string ≥16 karakter`)
    }
    keys.set(id, sealKeyFromMaterial(id, material.trim()))
  }

  if (!keys.has(activeId)) throw new Error(`kunci aktif "${activeId}" tidak ada di "keys"`)
  return { activeId, keys }
}

/**
 * Key ring aktif. Tanpa key ring → hanya kunci legacy `0`, yaitu perilaku
 * sebelum P6 (semua tulisan tetap terbaca oleh build lama = rollback aman).
 *
 * Key ring yang **ada tapi tidak valid** melempar, bukan jatuh diam-diam ke
 * legacy: operator yang mengira rotasi aktif padahal semua tulisan masih format
 * lama adalah kegagalan yang tak terlihat. Kunci legacy selalu ikut dimuat
 * supaya baris pra-rotasi tetap terbaca dan lookup ganda tetap bekerja.
 */
export function getAtRestKeyring(): AtRestKeyring {
  if (cachedKeyring) return cachedKeyring

  const legacy = legacySealKey(getAtRestPepper())
  const custody = readCustodySecret({ envVar: AT_REST_KEYRING_ENV, fileVar: AT_REST_KEYRING_FILE_ENV })

  if (!custody.material) {
    cachedKeyring = {
      activeId: LEGACY_SEAL_KEY_ID,
      keys: new Map([[LEGACY_SEAL_KEY_ID, legacy]]),
      custody: { provider: 'none', source: null },
    }
    return cachedKeyring
  }

  let parsed: { activeId: string; keys: Map<string, AtRestSealKey> }
  try {
    parsed = parseKeyring(custody.material)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN'
    throw new Error(`[atRestSecrets] ${AT_REST_KEYRING_ENV} tidak valid: ${reason}`)
  }
  parsed.keys.set(LEGACY_SEAL_KEY_ID, legacy)
  cachedKeyring = {
    ...parsed,
    custody: { provider: custody.provider, source: custody.source },
  }
  return cachedKeyring
}

/** Status untuk `/api/admin/system-status` — id & jumlah kunci, tanpa nilai. */
export function atRestStatus(): {
  envelope: string
  activeKeyId: string
  keyCount: number
  legacyReadable: boolean
  custody: { provider: KeyCustodyProvider; source: string | null }
} {
  const ring = getAtRestKeyring()
  return {
    envelope: ring.activeId === LEGACY_SEAL_KEY_ID ? 'legacy-b64url' : `${AT_REST_ENVELOPE_V2}:<keyId>:<payload>`,
    activeKeyId: ring.activeId,
    keyCount: ring.keys.size, // termasuk kunci legacy yang selalu dimuat
    legacyReadable: ring.keys.has(LEGACY_SEAL_KEY_ID),
    custody: ring.custody,
  }
}

/** Nonce deterministik dari plaintext — nilai sama + kunci sama → ciphertext sama. */
function deterministicNonce(sealKey: AtRestSealKey, plaintext: string): Uint8Array {
  const info = sealKey.id === LEGACY_SEAL_KEY_ID
    ? `${SEAL_KEY_INFO}:nonce:`
    : `${SEAL_KEY_INFO_V2}:nonce:${sealKey.id}:`
  const digest = createHmac('sha256', sealKey.nonceKey).update(info).update(plaintext).digest()
  return new Uint8Array(digest.subarray(0, NONCE_BYTES))
}

/** Body envelope: `base64url(nonce(24)||ciphertext)`. */
async function sealWith(sealKey: AtRestSealKey, plaintext: string): Promise<string> {
  const sodium = await getSodium()
  const nonce = deterministicNonce(sealKey, plaintext)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    sealKey.key
  )
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce, 0)
  combined.set(ciphertext, nonce.length)
  return sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
}

/**
 * Seal deterministik dengan kunci aktif.
 *
 * Tanpa key ring hasilnya identik dengan format lama (`base64url(nonce||ct)`),
 * jadi deploy build ini sendirian tidak mengubah satu byte pun di DB.
 */
/** Envelope lengkap untuk sebuah kunci: legacy tanpa prefiks, selain itu `ENC2:<id>:`. */
async function sealEnvelope(sealKey: AtRestSealKey, plaintext: string): Promise<string> {
  const body = await sealWith(sealKey, plaintext)
  return sealKey.id === LEGACY_SEAL_KEY_ID
    ? body
    : `${AT_REST_ENVELOPE_V2}:${sealKey.id}:${body}`
}

export async function sealAtRest(plaintext: string): Promise<string> {
  const ring = getAtRestKeyring()
  const sealKey = ring.keys.get(ring.activeId)
  if (!sealKey) throw new Error(`[atRestSecrets] kunci aktif "${ring.activeId}" hilang dari key ring`)
  return sealEnvelope(sealKey, plaintext)
}

/**
 * Id kunci sebuah nilai ter-seal: `null` bila bukan envelope yang bisa dibaca,
 * `'0'` untuk format legacy (tanpa prefiks).
 */
export function sealedKeyId(sealed: string | null | undefined): string | null {
  if (!sealed) return null
  if (!sealed.startsWith(`${AT_REST_ENVELOPE_V2}:`)) return LEGACY_SEAL_KEY_ID
  const parts = sealed.split(':')
  if (parts.length !== 3) return null
  const id = parts[1] ?? ''
  return KEY_ID_RE.test(id) ? id : null
}

/**
 * Buka hasil `sealAtRest` format lama maupun `ENC2:`.
 * Mengembalikan null untuk nilai kosong/rusak/**kunci tidak dikenal** — kegagalan
 * baca key id yang hilang harus terlihat (nilai null), bukan diam-diam plaintext.
 */
export async function openAtRest(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null
  try {
    const keyId = sealedKeyId(sealed)
    if (!keyId) return null
    const sealKey = getAtRestKeyring().keys.get(keyId)
    if (!sealKey) {
      warnUnknownKeyId(keyId)
      return null
    }

    const body = sealed.startsWith(`${AT_REST_ENVELOPE_V2}:`)
      ? sealed.split(':')[2] ?? ''
      : sealed
    if (!body) return null

    const sodium = await getSodium()
    const raw = sodium.from_base64(body, sodium.base64_variants.URLSAFE_NO_PADDING)
    if (raw.length <= NONCE_BYTES) return null
    const nonce = raw.subarray(0, NONCE_BYTES)
    const ciphertext = raw.subarray(NONCE_BYTES)
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, sealKey.key)
    return sodium.to_string(plaintext)
  } catch {
    return null
  }
}

/**
 * Nilai lookup kanonik kolom sealed: kunci aktif DULU, lalu semua kunci lain
 * di key ring (termasuk legacy `0`).
 *
 * [docs/37 §37.4 P6] Rotasi key ring bisa meninggalkan baris di beberapa era.
 * Kandidat harus mencakup SETIAP kunci yang masih dipertahankan, bukan hanya
 * aktif + legacy — kalau tidak, baris era sebelumnya tetap bisa dibuka
 * `openAtRest` tetapi tidak pernah ditemukan lookup.
 */
export async function sealedLookupCandidates(value: string): Promise<string[]> {
  const ring = getAtRestKeyring()
  const active = ring.keys.get(ring.activeId)
  if (!active) throw new Error(`[atRestSecrets] kunci aktif "${ring.activeId}" hilang dari key ring`)

  const ordered = [active, ...[...ring.keys.values()].filter((key) => key.id !== active.id)]
  const candidates = await Promise.all(ordered.map((key) => sealEnvelope(key, value)))
  return [...new Set(candidates)]
}

/**
 * [docs/28 Tier 1.1 — D2] Tag pembaca receipt (READ/DELIVERED) untuk percakapan
 * 1:1 yang tidak punya pseudonym klien.
 *
 * Sebelumnya `MessageStatus.userId` menyimpan **userId asli** di jalur ini —
 * jadi dump DB masih merekonstruksi edge "A↔B" meski `Message.senderId` sudah
 * di-NULL-kan (sealed sender). Sekarang kolom itu diisi tag opaque:
 *   - deterministik per (conversation, user) → upsert/guard idempoten,
 *   - berbeda antar percakapan → tidak bisa mengkorelasikan user lintas chat,
 *   - tak bisa dibalik tanpa pepper → dump saja tidak bisa menyebut "siapa".
 */
export function conversationScopedTag(conversationId: string, userId: string): string {
  return pepperedIdentifier(`receipt:${conversationId}:${userId}`)
}

/**
 * [docs/28 Tier 1.5] Tag anchor instalasi perangkat (`Device.installationTag`).
 *
 * Nilai mentahnya random & persisten di IndexedDB — jadi ia mengidentifikasi
 * browser yang sama lintas akun/sesi (dan ikut di-hash di TS di klien sebagai
 * query param). Yang dibutuhkan server hanya *perbandingan* (binding perangkat),
 * sehingga tag satu arah sudah cukup: dump tanpa pepper tidak bisa memakainya
 * untuk mengorelasikan perangkat. Domain-separated (`install:`) supaya tag tidak
 * pernah sama dengan blind index lain.
 */
export function deviceInstallationTag(raw: string): string {
  return pepperedIdentifier(`install:${raw}`)
}

/** Hanya untuk test: buang cache pepper/key supaya env baru terbaca. */
export function clearAtRestSecretCacheForTests(): void {
  cachedPepper = null
  cachedKeyring = null
  warnedUnknownKeyIds.clear()
}
