// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 4 — IDENTITAS PENGIRIM AT-REST]
 *
 * `Message.senderId` dipakai server untuk routing internal (notifikasi receipt,
 * unsend, view-once, catch-up). Sampai audit dump 2026-10-09, jalur fallback
 * menyimpan **userId asli** ketika klien tidak mengirim `senderPseudonym`
 * (grup v1, atau peta pseudonym belum siap) — 6 baris nyata terbaca di dump.
 *
 * Aturan sekarang:
 *   1. Pseudonym kiriman klien dipakai apa adanya HANYA bila bentuknya masuk
 *      akal (bukan userId pengirim, bukan UUID) — klien lama yang mengirim
 *      userId mentah otomatis jatuh ke aturan 2.
 *   2. Selain itu nilainya di-**seal** (`sealAtRest`, AEAD deterministik) →
 *      dump tidak memuat identitas, tetapi server tetap bisa membukanya untuk
 *      routing (pola yang sama dengan `UserHiddenConversation.userId`, docs/28 1.2).
 *
 * Pembaca WAJIB memakai `openSenderId` / `openMessageForClient` sebelum
 * membandingkan dengan userId atau mengirim nilai ke klien.
 *
 * Catatan grup v1: klien lawas memang **tidak punya** konsep pseudonym. Jalur
 * itu sekarang menyimpan userId TER-SEAL, sehingga perilaku (nama pengirim,
 * routing) tidak berubah, sementara dump DB bersih.
 */

import { openAtRest, sealAtRest } from './atRestSecrets.js'

/** Bentuk UUID — di jalur lama, nilai ini berarti userId asli, bukan pseudonym. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Apakah nilai kiriman klien boleh dipakai apa adanya sebagai pseudonym?
 * Menolak: bukan string, kosong, terlalu panjang, userId pengirim sendiri, dan
 * bentuk UUID (jalur lama = userId asli).
 */
export function isUsableSenderPseudonym(value: unknown, userId: string): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 128) return false
  if (trimmed === userId) return false
  return !UUID_RE.test(trimmed)
}

/** Nilai yang disimpan di kolom `Message.senderId` (null untuk 1:1 sealed sender). */
export async function senderIdForStorage(input: {
  isGroup: boolean
  userId: string
  senderPseudonym?: unknown
}): Promise<string | null> {
  if (!input.isGroup) return null
  if (isUsableSenderPseudonym(input.senderPseudonym, input.userId)) {
    return input.senderPseudonym.trim()
  }
  return sealAtRest(input.userId)
}

/** Buka `Message.senderId` tersimpan (baris legacy plaintext ikut terbaca). */
export async function openSenderId(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null
  return (await openAtRest(stored)) ?? stored
}

/**
 * Field di dalam `content` pesan SYSTEM yang menyebut **Device.id** dan karena
 * itu tidak boleh terbaca dari dump. `senderDeviceKey`/`senderSigningKey` TIDAK
 * termasuk: keduanya kunci publik (memang dibagikan ke anggota grup).
 */
const SYSTEM_DEVICE_FIELDS = ['targetDeviceKey'] as const

async function transformSystemContent(
  content: string,
  transform: (value: string) => Promise<string>
): Promise<string> {
  let touched = false
  for (const field of SYSTEM_DEVICE_FIELDS) {
    if (!content.includes(`"${field}"`)) continue
    touched = true
    break
  }
  if (!touched) return content

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    let changed = false
    for (const field of SYSTEM_DEVICE_FIELDS) {
      const value = parsed[field]
      if (typeof value !== 'string' || value.length === 0) continue
      const next = await transform(value)
      if (next !== value) {
        parsed[field] = next
        changed = true
      }
    }
    return changed ? JSON.stringify(parsed) : content
  } catch {
    // Bukan JSON (mis. ciphertext E2EE) — jangan sentuh.
    return content
  }
}

/** Seal device id di content pesan SYSTEM sebelum disimpan. */
export async function sealSystemContentDeviceKeys(content: string): Promise<string> {
  return transformSystemContent(content, (value) => sealAtRest(value))
}

/** Buka device id ter-seal di content pesan SYSTEM (untuk relay ke klien). */
export async function openSystemContentDeviceKeys(content: string): Promise<string> {
  return transformSystemContent(content, async (value) => (await openAtRest(value)) ?? value)
}

/** Field baris pesan yang disimpan ter-seal dan harus dibuka sebelum dikirim. */
export interface SealedMessageFields {
  senderId?: string | null
  sessionId?: string | null
  content?: string | null
}

/**
 * Siapkan baris pesan untuk dikirim ke klien: buka `senderId`, `sessionId`, dan
 * device id di content SYSTEM. Nilai yang tidak ter-seal (pseudonym, baris
 * legacy) dikembalikan apa adanya, jadi perilaku klien tidak berubah.
 */
export async function openMessageForClient<T extends SealedMessageFields>(msg: T): Promise<T> {
  const senderId = typeof msg.senderId === 'string'
    ? (await openAtRest(msg.senderId)) ?? msg.senderId
    : msg.senderId
  const sessionId = typeof msg.sessionId === 'string'
    ? (await openAtRest(msg.sessionId)) ?? msg.sessionId
    : msg.sessionId
  const content = typeof msg.content === 'string'
    ? await openSystemContentDeviceKeys(msg.content)
    : msg.content

  if (senderId === msg.senderId && sessionId === msg.sessionId && content === msg.content) return msg
  return { ...msg, senderId, sessionId, content }
}
