// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(2)] Token relay untuk signaling panggilan.
 *
 * Sebelum ini `WEBRTC_SIGNAL`/`WEBRTC_ICE` dirutekan dengan `to: userId` dan
 * diteruskan sebagai `{ from: userId }`, sehingga setiap percobaan panggilan
 * meninggalkan **identifier jangka panjang** di paket relay, log, dan payload
 * `nyx:downstream` yang memetakan siapa memanggil siapa — padahal server hanya
 * perlu mengantarkannya.
 *
 * Sekarang kedua sisi memakai **alamat relay buram**:
 *
 *   - token = 24 byte acak (`base64url`, 32 karakter), bukan turunan userId,
 *     jadi tidak bisa dienumerasi dan tidak menghubungkan dua panggilan berbeda;
 *   - server menyimpan peta `token → sesi aktif` di Redis dengan TTL, dan
 *     identitasnya tetap **ter-seal** (`sealIdentity`) — snapshot Redis/AOF
 *     tidak memuat userId mentah (aturan `docs/28`);
 *   - relay fail-closed: token tak dikenal tidak diteruskan (bukan jatuh ke
 *     perlakuan "anggap userId").
 *
 * Token bukan pengganti autentikasi: endpoint penerbitnya tetap `requireAuth`,
 * dan pengirim tetap diverifikasi sesi aktif sebelum opcode apa pun diproses.
 */

import crypto from 'crypto'
// Bentuk token tinggal di `@nyx/shared` supaya server dan klien tidak bisa
// menyimpang (skema Zod klien memakai pola yang sama).
import { CALL_RELAY_TOKEN_PATTERN } from '@nyx/shared'
import { identityTag, openIdentity, sealIdentity } from './redisIdentity.js'

/** TTL peta token → sesi (detik). Sesi dianggap berumur satu hari kerja. */
export const CALL_RELAY_TOKEN_TTL_SECONDS = 12 * 60 * 60

/** Entropi token (byte) — 24 byte = 192 bit, jauh di luar jangkauan enumerasi. */
export const CALL_RELAY_TOKEN_BYTES = 24

const TOKEN_NAMESPACE = 'callrelay'

/**
 * Bentuk token kanonik. Sengaja ketat (`base64url` 32 karakter) supaya nilai
 * lain — termasuk userId yang dikirim klien lama — ditolak sebelum menyentuh
 * Redis, bukan diperlakukan sebagai token yang kebetulan tidak ditemukan.
 */
export { CALL_RELAY_TOKEN_PATTERN }

export const isCallRelayToken = (value: unknown): value is string =>
  typeof value === 'string' && CALL_RELAY_TOKEN_PATTERN.test(value)

/** Token acak baru. */
export const newCallRelayToken = (): string =>
  crypto.randomBytes(CALL_RELAY_TOKEN_BYTES).toString('base64url')

/** Key peta `token → sesi aktif`. */
export const callRelayTokenKey = (token: string): string => `${TOKEN_NAMESPACE}:tok:${token}`

/** Key peta balik `user → token terakhir` (sufiks ter-tag, bukan userId). */
export const callRelayUserKey = (userId: string): string => `${TOKEN_NAMESPACE}:user:${identityTag(userId)}`

/** Bentuk Redis minimal yang dibutuhkan (memudahkan injeksi di unit test). */
export interface CallRelayRedis {
  get(key: string): Promise<string | null>
  setEx(key: string, seconds: number, value: string): Promise<unknown>
}

export interface CallRelaySession {
  userId: string
  /** `null` bila perangkat aktif belum diketahui → relay ke semua perangkat user. */
  deviceId: string | null
}

/** Terbitkan token baru untuk sesi ini dan jadikan token aktif user. */
export async function issueCallRelayToken(
  redis: CallRelayRedis,
  input: CallRelaySession
): Promise<string> {
  const token = newCallRelayToken()
  const record = JSON.stringify({
    identity: await sealIdentity(input.userId),
    deviceId: input.deviceId,
  })
  await redis.setEx(callRelayTokenKey(token), CALL_RELAY_TOKEN_TTL_SECONDS, record)
  await redis.setEx(callRelayUserKey(input.userId), CALL_RELAY_TOKEN_TTL_SECONDS, token)
  return token
}

/** Token aktif user saat ini, atau `null` bila belum ada / sudah kedaluwarsa. */
export async function currentCallRelayToken(
  redis: CallRelayRedis,
  userId: string
): Promise<string | null> {
  const token = await redis.get(callRelayUserKey(userId))
  return isCallRelayToken(token) ? token : null
}

/** Token aktif user; diterbitkan bila belum ada (idempoten per TTL). */
export async function ensureCallRelayToken(
  redis: CallRelayRedis,
  input: CallRelaySession
): Promise<string> {
  const existing = await currentCallRelayToken(redis, input.userId)
  if (existing) return existing
  return issueCallRelayToken(redis, input)
}

/**
 * Buka token menjadi sesi tujuan. `null` untuk token berbentuk salah, tidak
 * dikenal, atau record rusak — pemanggil wajib memperlakukan ini sebagai
 * penolakan (fail-closed), bukan mengirim ulang paket.
 */
export async function resolveCallRelayToken(
  redis: CallRelayRedis,
  token: unknown
): Promise<CallRelaySession | null> {
  if (!isCallRelayToken(token)) return null
  const raw = await redis.get(callRelayTokenKey(token))
  if (!raw) return null

  let parsed: { identity?: unknown; deviceId?: unknown }
  try {
    parsed = JSON.parse(raw) as { identity?: unknown; deviceId?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.identity !== 'string') return null

  const userId = await openIdentity(parsed.identity)
  if (!userId) return null

  return {
    userId,
    deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : null,
  }
}

/**
 * Envelope yang benar-benar dikirim ke peer. Bentuk akhirnya **tidak pernah**
 * memuat userId pengirim — test mengunci properti ini secara langsung atas
 * nilai balik fungsi (bukan atas teks sumber).
 */
export function buildCallRelayEnvelope(
  fromToken: string,
  input: { type: unknown; payload: unknown }
): { from: string; type: unknown; payload: unknown } {
  return { from: fromToken, type: input.type, payload: input.payload }
}

export interface CallRelayDecision {
  target: CallRelaySession
  envelope: { from: string; type: unknown; payload: unknown }
}

/**
 * Seluruh keputusan satu langkah relay — dipisah dari transport supaya bisa
 * diuji perilakunya (token mana yang diterima, apa yang keluar ke peer) tanpa
 * Redis/WebTransport nyata. Dipakai apa adanya oleh `redisBridge`.
 *
 * `null` = tolak. Pemanggil **wajib** memperlakukannya sebagai drop
 * (fail-closed): token tak dikenal tidak pernah jatuh ke perlakuan userId.
 */
export async function relayCallSignal(
  redis: CallRelayRedis,
  input: {
    fromUserId: string
    fromDeviceId: string | null
    payload: { to?: unknown; type?: unknown; payload?: unknown } | null | undefined
  }
): Promise<CallRelayDecision | null> {
  const target = await resolveCallRelayToken(redis, input.payload?.to)
  if (!target) return null

  const fromToken = await ensureCallRelayToken(redis, {
    userId: input.fromUserId,
    deviceId: input.fromDeviceId,
  })
  return {
    target,
    envelope: buildCallRelayEnvelope(fromToken, {
      type: input.payload?.type,
      payload: input.payload?.payload,
    }),
  }
}
