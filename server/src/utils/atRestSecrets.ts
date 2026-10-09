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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
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
 * Kandidat nilai untuk lookup kolom yang sedang dimigrasi:
 * `[ter-pepper, apa adanya]`. Cabang "apa adanya" melayani (a) baris legacy
 * yang masih plaintext/hash-lama, dan (b) klien yang meng-echo nilai yang
 * pernah ia terima dari server (mis. `user.usernameHash` di flow recovery).
 */
export function identifierLookupCandidates(value: string): string[] {
  const peppered = pepperedIdentifier(value)
  return value === peppered ? [peppered] : [peppered, value]
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
 * Dua mode diterima sekaligus (tanpa sniffing format, karena `authSecret`
 * legacy juga 64 hex = sama dengan bentuk hash):
 *  - tersimpan = hash → bandingkan dengan hash(token yang dipresentasikan);
 *  - tersimpan = plaintext legacy → bandingkan langsung.
 */
export function credentialTokenMatches(stored: string | null | undefined, presented: string): boolean {
  if (!stored || !presented) return false
  if (timingSafeEqualStr(stored, hashCredentialToken(presented))) return true
  return timingSafeEqualStr(stored, presented)
}

/** Apakah nilai tersimpan berbentuk hash SHA-256 hex (bukan plaintext legacy)? */
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

/** Buka hasil `sealAtRest`. Mengembalikan null untuk nilai kosong/rusak/legacy. */
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

/** Kandidat lookup kolom sealed: `[sealed, nilai apa adanya (legacy)]`. */
export async function sealedLookupCandidates(value: string): Promise<string[]> {
  return [await sealAtRest(value), value]
}

/**
 * [docs/28 Tier 1.1 — D2] Tag pembaca receipt (READ/DELIVERED) untuk percakapan
 * yang tidak punya pseudonym klien (1:1 & grup v1).
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
