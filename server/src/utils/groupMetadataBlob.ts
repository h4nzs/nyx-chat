// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 4 — METADATA GRUP TANPA IDENTITAS PENULIS]
 *
 * Wrapper metadata grup v2 (`{v:2, kind:'group_metadata', chainId, ct, signature,
 * senderId, senderDeviceKey}`) menyertakan `senderId` = **userId penulis**. Nilai
 * itu tersimpan apa adanya di `Conversation.encryptedMetadata` (dan di content
 * pesan SYSTEM `METADATA_UPDATED`) sehingga dump DB memuat identitas pembuat
 * grup — ditemukan pada audit dump 2026-10-09.
 *
 * Field itu tidak dibutuhkan pembaca: reader v2 (`decryptGroupMetadata`)
 * merutekan lewat `chainId` + `senderDeviceKey` dan memverifikasi tanda tangan
 * HANYA atas byte `ct`. Karena itu:
 *   - klien baru berhenti menulis field tersebut, dan
 *   - server membuangnya dari blob yang disimpan/di-relay (pertahanan terhadap
 *     klien lama yang masih mengirim userId).
 *
 * Blob v1 (jalur legacy rantai, `{header, ciphertext, signature, senderId, …}`)
 * TIDAK disentuh — readernya memang membutuhkan `senderId` untuk resolve kunci.
 */

/** Buang `senderId` dari wrapper metadata v2 (blob non-v2 dikembalikan utuh). */
export function sanitizeGroupMetadataBlob<T extends string | null | undefined>(blob: T): T {
  if (typeof blob !== 'string' || blob.length === 0) return blob
  if (!blob.includes('"senderId"')) return blob

  try {
    const parsed = JSON.parse(blob) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return blob
    if (parsed.v !== 2 || parsed.kind !== 'group_metadata') return blob
    if (!('senderId' in parsed)) return blob

    delete parsed.senderId
    return JSON.stringify(parsed) as T
  } catch {
    // Bukan JSON (blob legacy/ciphertext) — jangan sentuh.
    return blob
  }
}
