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
 *     nonce = HMAC(pepper, plaintext), envelope `base64url(nonce(24)||ct)` —
 *     format yang sama dengan amplop XChaCha di klien). Untuk nilai yang server
 *     HARUS bisa baca kembali (mis. routing identity / API key tenant): sama-sama
 *     tak terbaca dari dump, tapi tetap reversible untuk lookup & fungsionalitas.
 *
 * Semua fungsi memakai satu pepper (`NYX_AT_REST_PEPPER`). Di production pepper
 * WAJIB diset; di dev ia jatuh ke turunan JWT_SECRET (dengan peringatan) supaya
 * onboarding tidak putus. Jangan pernah menulis pepper ke DB/backup.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'
import { getSodium } from '../lib/sodium.js'

/** Bentuk nilai yang sudah di-hash SHA-256 hex (pola `adminSecretHash`). */
const HEX64_RE = /^[a-f0-9]{64}$/

const SEAL_KEY_INFO = 'NYX_AT_REST_SEAL_V1'
const NONCE_BYTES = 24
const SEAL_KEY_MAX = 32

let cachedPepper: string | null = null
let cachedSealKey: Uint8Array | null = null

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

function deriveKey(info: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', getAtRestPepper()).update(info).digest().subarray(0, SEAL_KEY_MAX))
}

async function getSealKey(): Promise<Uint8Array> {
  if (cachedSealKey) return cachedSealKey
  cachedSealKey = deriveKey(SEAL_KEY_INFO)
  return cachedSealKey
}

/** Nonce deterministik dari plaintext — nilai sama → nonce sama → ciphertext sama. */
function deterministicNonce(plaintext: string): Uint8Array {
  const digest = createHmac('sha256', getAtRestPepper()).update(`${SEAL_KEY_INFO}:nonce:`).update(plaintext).digest()
  return new Uint8Array(digest.subarray(0, NONCE_BYTES))
}

/**
 * Seal deterministik: `base64url(nonce(24)||ciphertext)`. Deterministik supaya
 * kolom tetap bisa di-lookup dengan `where: { kolom: await sealAtRest(nilai) }`.
 */
export async function sealAtRest(plaintext: string): Promise<string> {
  const sodium = await getSodium()
  const key = await getSealKey()
  const nonce = deterministicNonce(plaintext)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    key
  )
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce, 0)
  combined.set(ciphertext, nonce.length)
  return sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
}

/** Buka hasil `sealAtRest`. Mengembalikan null untuk nilai kosong/rusak. */
export async function openAtRest(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null
  try {
    const sodium = await getSodium()
    const key = await getSealKey()
    const raw = sodium.from_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING)
    if (raw.length <= NONCE_BYTES) return null
    const nonce = raw.subarray(0, NONCE_BYTES)
    const ciphertext = raw.subarray(NONCE_BYTES)
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key)
    return sodium.to_string(plaintext)
  } catch {
    return null
  }
}

/**
 * Nilai lookup kanonik kolom sealed: SELALU hasil seal deterministik.
 * [2026-10 legacy purge] Cabang "nilai apa adanya" dibuang — tak ada baris
 * plaintext tersisa, jadi lookup tidak perlu lagi mencocokkan dua bentuk.
 */
export async function sealedLookupCandidates(value: string): Promise<string[]> {
  return [await sealAtRest(value)]
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
  cachedSealKey = null
}
