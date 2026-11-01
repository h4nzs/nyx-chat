// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 3 — N3-01] Gerbang tulis `SessionKey` (blind relay kunci sesi).
 *
 * `POST /api/session-keys/:conversationId/ratchet` dulu hanya memeriksa bahwa
 * percakapannya ADA, lalu menulis baris `SessionKey` untuk `deviceId` apa pun.
 * Itu berbahaya justru karena pass 2 memakai `SessionKey` sebagai **bukti
 * peserta** (`utils/conversationParticipants.ts`, `presencePeers.ts`): siapa pun
 * yang terautentikasi bisa mencetak keanggotaan untuk dirinya sendiri, lalu
 * memakai bukti palsu itu untuk menghapus view-once 1:1 orang lain, mengirim
 * `typing` ke id sembarang, dan menyubscribe presence korban.
 *
 * Aturan yang ditegakkan di sini (urutan: bentuk → pembaca → perangkat):
 *
 *   1. `keys` dibatasi (`MAX_RELAY_KEYS`) dan tiap entri divalidasi bentuknya —
 *      tanpa cap, satu request bisa menulis baris tak terbatas.
 *   2. Pemanggil HARUS sudah terbukti peserta lewat bukti yang **tidak bisa
 *      ditulisnya sendiri untuk percakapan itu**: baris keanggotaan (server
 *      yang menulis, kunci token) atau receipt bertag opaque. `SessionKey`
 *      sengaja TIDAK dipakai sebagai bukti di sini — itu bukti yang sedang
 *      ditulis (sirkular, persis celah yang ditutup).
 *   3. Setiap `deviceId` harus perangkat nyata, dan bila bukan milik pemanggil,
 *      pemiliknya juga harus peserta terbukti. Tanpa ini, peserta sah masih bisa
 *      menyuntikkan perangkat orang lain ke percakapannya (kebocoran presence).
 *
 * Fail-closed: tanpa bukti → 403, bukan "diam-diam diterima".
 */

import { conversationScopedTag } from './atRestSecrets.js'
import {
  filterConversationMembers,
  type ConversationMembershipLookup,
} from './routingIdentity.js'
import type { ClientSessionKeyPayload } from './sessionKeys.js'

/** Sama dengan cap penerima pesan: satu ratchet tidak boleh mengirim lebih. */
export const MAX_RELAY_KEYS = 500
/** Cap yang sama untuk `initialKeysPerDevice` saat pembuatan percakapan (N4-01). */
export const MAX_INITIAL_SESSION_KEYS = MAX_RELAY_KEYS
/** base64 STANDAR: jalur pembuatan mendekode dengan `Buffer.from(x, 'base64')`. */
const BASE64_STANDARD = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_SESSION_ID = 128
const MAX_DEVICE_ID = 128
/** Kunci sesi ter-seal per perangkat; 8 KB jauh di atas ukuran nyata. */
const MAX_KEY_B64 = 8192
const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface SessionKeyRelayGuardDb extends ConversationMembershipLookup {
  messageStatus: {
    findMany(args: {
      where: Record<string, unknown>
      select: { userId?: boolean }
    }): Promise<Array<{ userId?: string }>>
  }
  device: {
    findMany(args: {
      where: Record<string, unknown>
      select: { id?: boolean; userId?: boolean }
    }): Promise<Array<{ id: string; userId?: string | null }>>
  }
  sessionKey: {
    findMany(args: {
      where: Record<string, unknown>
      select: { deviceId?: boolean; device?: { select: { userId?: boolean } } }
    }): Promise<Array<{
      deviceId?: string
      device?: { userId?: string | null } | null
    }>>
  }
}

export type RelayDecision =
  | { ok: true; keys: ClientSessionKeyPayload[] }
  | { ok: false; status: number; error: string }

export interface InitialSessionEntry {
  deviceId: string
  encryptedKey: string
  initiatorCiphertexts: string | null
}

export type InitialSessionDecision =
  | { ok: true; entries: InitialSessionEntry[] }
  | { ok: false; status: number; error: string }

function isBase64Standard(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && BASE64_STANDARD.test(value)
}

function isBase64Url(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && BASE64URL.test(value)
}

/** Normalisasi + validasi bentuk payload klien. */
function normalizeKeys(keys: unknown): ClientSessionKeyPayload[] | { error: string } {
  if (!Array.isArray(keys)) return { error: 'keys must be an array' }
  if (keys.length === 0) return { error: 'keys must not be empty' }
  if (keys.length > MAX_RELAY_KEYS) return { error: `too many keys (max ${MAX_RELAY_KEYS})` }

  const byDevice = new Map<string, ClientSessionKeyPayload>()
  for (const raw of keys) {
    if (!raw || typeof raw !== 'object') return { error: 'invalid key entry' }
    const entry = raw as Record<string, unknown>
    if (typeof entry.deviceId !== 'string' || entry.deviceId.length === 0 || entry.deviceId.length > MAX_DEVICE_ID) {
      return { error: 'invalid deviceId' }
    }
    if (!isBase64Url(entry.encryptedKey, MAX_KEY_B64)) {
      return { error: 'invalid encryptedKey' }
    }
    if (entry.initiatorCiphertexts !== undefined && entry.initiatorCiphertexts !== null
        && !isBase64Url(entry.initiatorCiphertexts, MAX_KEY_B64)) {
      return { error: 'invalid initiatorCiphertexts' }
    }
    // Duplikat deviceId dalam satu request = percobaan menulis dua kali untuk
    // perangkat yang sama; entri pertama menang (deterministik).
    if (byDevice.has(entry.deviceId)) continue
    byDevice.set(entry.deviceId, {
      deviceId: entry.deviceId,
      encryptedKey: entry.encryptedKey,
      ...(typeof entry.initiatorCiphertexts === 'string'
        ? { initiatorCiphertexts: entry.initiatorCiphertexts }
        : {}),
      ...(entry.isInitiator === true ? { isInitiator: true } : {}),
    })
  }
  return Array.from(byDevice.values())
}

/**
 * Peserta terbukti untuk sekumpulan id — keanggotaan (baris bertoken, ditulis
 * server) ATAU receipt bertag opaque di percakapan ini. Tidak memakai
 * `SessionKey` (lihat catatan modul).
 */
async function provenParticipants(
  db: SessionKeyRelayGuardDb,
  conversationId: string,
  userIds: string[]
): Promise<Set<string>> {
  const wanted = Array.from(new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0)))
  if (wanted.length === 0) return new Set()

  const members = new Set(
    await filterConversationMembers(db, conversationId, wanted).catch(() => [] as string[])
  )

  // [PASS-3 N3-01] Bukti ketiga: perangkat pemanggil sudah punya baris
  // `SessionKey` yang DITULIS SERVER saat percakapan dibuat. Baris bertanda itu
  // tidak bisa dibuat lewat endpoint ratchet (lihat aturan "enrolled" di bawah),
  // jadi ini anchor bootstrap yang sah untuk 1:1 yang tidak punya roster.
  const bootstrapOwners = await db.sessionKey.findMany({
    where: { conversationId, issuedByServer: true },
    select: { device: { select: { userId: true } } },
  }).catch(() => [] as Array<{ device?: { userId?: string | null } | null }>)
  for (const row of bootstrapOwners) {
    const owner = row.device?.userId
    if (typeof owner === 'string' && wanted.includes(owner)) members.add(owner)
  }

  const remaining = wanted.filter((id) => !members.has(id))
  if (remaining.length === 0) return members

  const receipts = await db.messageStatus.findMany({
    where: {
      userId: { in: remaining.map((id) => conversationScopedTag(conversationId, id)) },
      message: { conversationId },
    },
    select: { userId: true },
  }).catch(() => [] as Array<{ userId?: string }>)

  const tags = new Set(receipts.map((row) => row.userId).filter((tag): tag is string => typeof tag === 'string'))
  for (const userId of remaining) {
    if (tags.has(conversationScopedTag(conversationId, userId))) members.add(userId)
  }
  return members
}

/**
 * [AUDIT PASS 4 — N4-01] Validasi `initialSession` pada pembuatan percakapan.
 *
 * Jalur ini SATU-SATUNYA yang boleh menulis baris `SessionKey.issuedByServer`
 * (anchor bukti peserta), tetapi pass 3 hanya menutup endpoint ratchet — endpoint
 * pembuatan menulis `deviceId` apa pun tanpa cek pemilik, tanpa cap, dan tanpa
 * validasi bentuk. Siapa pun yang punya akun bisa "mendaftarkan" perangkat nyata
 * milik orang lain ke percakapan yang ia buat (tanpa notifikasi), dan korban lalu
 * muncul di presence penyerang, bisa dikirimi `typing`, serta menjadi peserta
 * terbukti untuk penulisan ratchet.
 *
 * Aturan yang dipakai = aturan guard ratchet: cap 500, `deviceId` ≤128,
 * `encryptedKey` base64 ≤8 KB, duplikat digabung, dan **setiap perangkat harus
 * milik `userIds` atau pemanggil**. Bila tidak ada satu pun perangkat sah → 400
 * (jangan menulis baris kosong).
 */
export async function authorizeInitialSessionKeys(
  db: SessionKeyRelayGuardDb,
  input: {
    allowedUserIds: string[]
    initialKeysPerDevice: Record<string, unknown>
    initiatorCiphertextsPerDevice?: Record<string, unknown>
  }
): Promise<InitialSessionDecision> {
  const allowed = new Set(input.allowedUserIds.filter((id) => typeof id === 'string' && id.length > 0))
  const entriesByDevice = new Map<string, InitialSessionEntry>()

  const deviceIds: string[] = []
  for (const [deviceId, encryptedKey] of Object.entries(input.initialKeysPerDevice)) {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID) {
      return { ok: false, status: 400, error: 'INVALID_DEVICE_ID: deviceId must be 1-128 chars' }
    }
    if (!isBase64Standard(encryptedKey, MAX_KEY_B64)) {
      return { ok: false, status: 400, error: 'INVALID_ENCRYPTED_KEY: expected base64 up to 8 KB' }
    }
    const cipher = input.initiatorCiphertextsPerDevice?.[deviceId]
    if (cipher !== undefined && cipher !== null && !isBase64Standard(cipher, MAX_KEY_B64)) {
      return { ok: false, status: 400, error: 'INVALID_INITIATOR_CIPHERTEXT: expected base64 up to 8 KB' }
    }
    if (entriesByDevice.size >= MAX_INITIAL_SESSION_KEYS && !entriesByDevice.has(deviceId)) {
      return { ok: false, status: 400, error: `too many initial keys (max ${MAX_INITIAL_SESSION_KEYS})` }
    }
    deviceIds.push(deviceId)
    entriesByDevice.set(deviceId, {
      deviceId,
      encryptedKey,
      initiatorCiphertexts: typeof cipher === 'string' ? cipher : null,
    })
  }

  if (deviceIds.length === 0) {
    return { ok: false, status: 400, error: 'INITIAL_SESSION_EMPTY: no device keys provided' }
  }

  const devices = await db.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, userId: true },
  }).catch(() => [] as Array<{ id: string; userId?: string | null }>)
  const ownerByDevice = new Map(devices.map((device) => [device.id, device.userId ?? null]))

  const entries: InitialSessionEntry[] = []
  for (const entry of entriesByDevice.values()) {
    const owner = ownerByDevice.get(entry.deviceId)
    if (owner === undefined) {
      return { ok: false, status: 403, error: 'SESSION_KEY_UNKNOWN_DEVICE: device not found' }
    }
    if (owner === null || !allowed.has(owner)) {
      return { ok: false, status: 403, error: 'SESSION_KEY_FOREIGN_DEVICE: device owner is not in this conversation' }
    }
    entries.push(entry)
  }

  return { ok: true, entries }
}

/**
 * Putuskan apakah pemanggil boleh menulis baris `SessionKey` untuk percakapan
 * ini, dan untuk perangkat mana.
 */
export async function authorizeSessionKeyRelay(
  db: SessionKeyRelayGuardDb,
  input: { conversationId: string; callerId: string; sessionId: unknown; keys: unknown }
): Promise<RelayDecision> {
  const { conversationId, callerId } = input
  if (!conversationId) return { ok: false, status: 400, error: 'conversationId required' }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.length > MAX_SESSION_ID) {
    return { ok: false, status: 400, error: 'invalid sessionId' }
  }

  const normalized = normalizeKeys(input.keys)
  if (!Array.isArray(normalized)) {
    return { ok: false, status: 400, error: normalized.error }
  }

  // (2) Pemanggil harus sudah peserta terbukti — bukti yang tidak ia tulis sendiri.
  const callerProven = await provenParticipants(db, conversationId, [callerId])
  if (!callerProven.has(callerId)) {
    return { ok: false, status: 403, error: 'SESSION_KEY_NOT_PARTICIPANT: caller has no proof of membership in this conversation' }
  }

  // (3) Semua perangkat harus nyata; perangkat orang lain hanya bila pemiliknya
  // juga peserta terbukti. Tanpa ini, peserta sah bisa menarik perangkat orang
  // asing ke percakapannya (baris itu membuat korban muncul di presence-nya).
  const deviceIds = normalized.map((key) => key.deviceId)
  const devices = await db.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, userId: true },
  }).catch(() => [] as Array<{ id: string; userId?: string | null }>)
  const ownerByDevice = new Map(devices.map((device) => [device.id, device.userId ?? null]))

  const unknownDevice = deviceIds.find((id) => !ownerByDevice.has(id))
  if (unknownDevice !== undefined) {
    return { ok: false, status: 403, error: 'SESSION_KEY_UNKNOWN_DEVICE: device not found' }
  }

  // Perangkat yang sudah terdaftar di percakapan ini (baris apa pun: hasil
  // pembuatan maupun ratchet sebelumnya). Penulisan HANYA boleh berupa rotasi
  // untuk perangkat itu atau perangkat pemanggil sendiri — ratchet tidak boleh
  // menjadi jalur pendaftaran perangkat/user baru.
  const enrolledRows = await db.sessionKey.findMany({
    where: { conversationId, deviceId: { in: deviceIds } },
    select: { deviceId: true },
  }).catch(() => [] as Array<{ deviceId?: string }>)
  const enrolled = new Set(
    enrolledRows.map((row) => row.deviceId).filter((id): id is string => typeof id === 'string')
  )
  const notEnrolled = normalized.find((key) => ownerByDevice.get(key.deviceId) !== callerId && !enrolled.has(key.deviceId))
  if (notEnrolled) {
    return { ok: false, status: 403, error: 'SESSION_KEY_NOT_ENROLLED: device was never part of this conversation' }
  }

  const peerIds = Array.from(new Set(
    normalized
      .map((key) => ownerByDevice.get(key.deviceId) ?? '')
      .filter((owner): owner is string => owner.length > 0 && owner !== callerId)
  ))
  if (peerIds.length > 0) {
    const peerProven = await provenParticipants(db, conversationId, [...peerIds, callerId])
    const unprovenPeer = peerIds.find((id) => !peerProven.has(id))
    if (unprovenPeer !== undefined) {
      return { ok: false, status: 403, error: 'SESSION_KEY_UNKNOWN_PEER: target device owner is not a proven participant' }
    }
  }

  return { ok: true, keys: normalized }
}
