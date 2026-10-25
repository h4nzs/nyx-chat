// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P6] Re-seal kolom at-rest dari format legacy ke `ENC2:`.
 *
 * Kenapa perlu job: menaikkan key ring TIDAK mengubah baris lama. Baris lama
 * tetap terbaca (kunci id `0` selalu dimuat), tetapi tetap terikat ke pepper
 * yang ingin dipensiunkan. Job ini memindahkannya ke kunci aktif — satu nilai
 * per baris, idempoten, dan bisa dihentikan kapan saja tanpa kehilangan data.
 *
 * Pemakaian (dari `server/`):
 *
 *   # 1. dry-run — hitung saja, tidak menulis apa pun (default)
 *   pnpm exec tsx scripts/reseal-at-rest.ts
 *
 *   # 2. terapkan
 *   pnpm exec tsx scripts/reseal-at-rest.ts --apply
 *
 *   # 3. verifikasi: jalankan dry-run lagi → semua langkah harus melaporkan
 *   #    "sudah kunci aktif" dan 0 tulisan.
 *
 * Prasyarat:
 *  - `NYX_AT_REST_KEYRING` (atau `NYX_AT_REST_KEYRING_FILE`) berisi key ring
 *    dengan id aktif ≠ `0`, dan `NYX_AT_REST_PEPPER` masih tersedia (dibutuhkan
 *    untuk membuka baris lama). Tanpa itu script berhenti, bukan menulis.
 *
 * Batas jujur: blind index (`pepperedIdentifier`, `Device.installationTag`)
 * TIDAK ikut di-reindex. HMAC satu arah dan nilai mentahnya tidak disimpan
 * server, jadi re-index hanya mungkin dari plaintext klien — lihat
 * docs/37 §37.4 P6. Jangan menjalankan job ini sambil berharap kolom itu berubah.
 */

import * as dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { prisma } from '../src/lib/prisma.js'
import {
  AT_REST_ENVELOPE_V2,
  LEGACY_SEAL_KEY_ID,
  atRestStatus,
  openAtRest,
  sealAtRest,
  sealedKeyId,
} from '../src/utils/atRestSecrets.js'
import { openSystemContentDeviceKeys, sealSystemContentDeviceKeys } from '../src/utils/senderIdentity.js'

const PAGE_SIZE = 500
const apply = process.argv.includes('--apply')

interface ResealRow {
  id: string
  [column: string]: unknown
}

interface ResealDelegate {
  findMany(args: {
    take: number
    skip?: number
    cursor?: { id: string }
    orderBy: { id: 'asc' }
    select: Record<string, boolean>
  }): Promise<ResealRow[]>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
}

type Target = {
  model: string
  column: string
  /** `content` = kolom JSON SYSTEM dengan device id ter-seal di dalamnya. */
  nested?: boolean
}

/**
 * Kolom yang ditulis lewat `sealAtRest`. Daftar ini sengaja eksplisit: job yang
 * menebak-nebak kolom akan melewatkan satu kolom, dan kolom yang terlewat tidak
 * menimbulkan error — hanya kegagalan baca setelah pepper lama dibuang.
 */
const TARGETS: Target[] = [
  { model: 'tenant', column: 'apiKey' },
  { model: 'device', column: 'nameSealed' },
  { model: 'pushSubscription', column: 'endpointSealed' },
  { model: 'message', column: 'senderId' },
  { model: 'message', column: 'sessionId' },
  { model: 'message', column: 'repliedToId' },
  { model: 'message', column: 'content', nested: true },
  { model: 'userHiddenConversation', column: 'userId' },
  { model: 'story', column: 'authorTag' },
  { model: 'blockedUser', column: 'blockerTag' },
  { model: 'blockedUser', column: 'blockedTag' },
]

interface Stats {
  scanned: number
  alreadyActive: number
  legacy: number
  updated: number
  unreadable: number
  skippedNotSealed: number
}

function newStats (): Stats {
  return { scanned: 0, alreadyActive: 0, legacy: 0, updated: 0, unreadable: 0, skippedNotSealed: 0 }
}

/** Re-seal satu nilai. `next` kosong = tidak ada perubahan (bukan nilai ter-seal). */
async function resealValue (
  value: unknown,
  activeId: string
): Promise<{ next?: string; unreadable?: boolean; alreadyActive?: boolean; notSealed?: boolean }> {
  if (typeof value !== 'string' || value.length === 0) return { notSealed: true };

  // Bentuk ENC2 yang rusak (mis. prefiks tanpa id) tidak boleh dilewati diam-diam
  // sebagai "bukan sealed": itu tanda kerusakan data yang harus terlihat.
  if (value.startsWith(`${AT_REST_ENVELOPE_V2}:`) && sealedKeyId(value) === null) {
    return { unreadable: true }
  }
  const keyId = sealedKeyId(value)
  if (keyId === null) return { notSealed: true }
  if (keyId === activeId) return { alreadyActive: true }

  const plaintext = await openAtRest(value)
  if (plaintext === null) {
    // ENC2 tanpa kunci di ring = kerusakan yang harus terlihat. Format legacy
    // tidak punya penanda, jadi nilai yang gagal dibuka di sana tidak bisa
    // dibedakan dari pseudonym base64url → dilewati, bukan dilaporkan rusak.
    return keyId === LEGACY_SEAL_KEY_ID ? { notSealed: true } : { unreadable: true }
  }
  return { next: await sealAtRest(plaintext) }
}

async function resealTarget (target: Target, activeId: string): Promise<Stats> {
  const stats = newStats()
  const delegate = (prisma as unknown as Record<string, ResealDelegate>)[target.model]
  if (!delegate) throw new Error(`model Prisma tidak dikenal: ${target.model}`)

  let cursor: string | undefined
  for (;;) {
    const rows = await delegate.findMany({
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, [target.column]: true },
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1]!.id

    for (const row of rows) {
      const value = row[target.column]
      stats.scanned += 1

      if (target.nested) {
        if (typeof value !== 'string' || !value.includes('"')) {
          stats.skippedNotSealed += 1
          continue
        }
        // Buka (kalau ter-seal) lalu seal ulang dengan kunci aktif. Untuk baris
        // yang masih plaintext, langkah seal inilah yang menutupnya.
        const opened = await openSystemContentDeviceKeys(value)
        const resealed = await sealSystemContentDeviceKeys(opened)
        if (resealed === value) {
          if (opened !== value) stats.alreadyActive += 1
          else stats.skippedNotSealed += 1
          continue
        }
        stats.legacy += 1
        if (apply) {
          await delegate.update({ where: { id: row.id }, data: { [target.column]: resealed } })
          stats.updated += 1
        }
        continue
      }

      const result = await resealValue(value, activeId)
      if (result.unreadable) {
        stats.unreadable += 1
        console.warn(`  ! ${target.model}.${target.column} ${row.id}: nilai tidak bisa dibuka (kunci tidak ada di ring?)`)
        continue
      }
      if (result.next === undefined) {
        if (result.alreadyActive) stats.alreadyActive += 1
        else if (result.notSealed) stats.skippedNotSealed += 1
        continue
      }
      stats.legacy += 1
      if (apply) {
        await delegate.update({ where: { id: row.id }, data: { [target.column]: result.next } })
        stats.updated += 1
      }
    }

    console.log(
      `  ${target.model}.${target.column}: ${stats.scanned} dipindai, ` +
        `${stats.legacy} legacy, ${stats.updated} ditulis, ${stats.unreadable} tak terbaca`
    )
    if (rows.length < PAGE_SIZE) break
  }
  return stats
}

function sanitizedDbHost (): string {
  const url = process.env.DATABASE_URL ?? ''
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(DATABASE_URL tidak valid)'
  }
}

async function main (): Promise<number> {
  let status: ReturnType<typeof atRestStatus>
  try {
    status = atRestStatus()
  } catch (error) {
    console.error(`[reseal] key ring tidak bisa dimuat: ${error instanceof Error ? error.message : 'UNKNOWN'}`)
    return 1
  }

  if (status.activeKeyId === LEGACY_SEAL_KEY_ID) {
    console.error(
      '[reseal] Tidak ada key ring aktif: semua tulisan masih memakai kunci legacy id 0. ' +
        'Set NYX_AT_REST_KEYRING (id aktif ≠ 0) lebih dulu — docs/10 §10.13.'
    )
    return 1
  }

  console.log(`[reseal] target DB : ${sanitizedDbHost()}`)
  console.log(`[reseal] kunci aktif: ${status.activeKeyId} (${status.keyCount} kunci, custody ${status.custody.provider})`)
  console.log(`[reseal] mode       : ${apply ? 'APPLY (menulis)' : 'dry-run (tidak menulis; pakai --apply)'}`)

  const totals = newStats()
  for (const target of TARGETS) {
    if (target.nested) {
      // Pesan SYSTEM saja — kolom content lain adalah ciphertext/pesan biasa.
      console.log(`  ${target.model}.${target.column}: memindai field device di dalam content SYSTEM`)
    }
    const stats = await resealTarget(target, status.activeKeyId)
    totals.scanned += stats.scanned
    totals.alreadyActive += stats.alreadyActive
    totals.legacy += stats.legacy
    totals.updated += stats.updated
    totals.unreadable += stats.unreadable
    totals.skippedNotSealed += stats.skippedNotSealed
  }

  console.log(
    `[reseal] selesai: ${totals.scanned} dipindai, ${totals.legacy} nilai legacy, ` +
      `${totals.updated} ditulis, ${totals.alreadyActive} sudah kunci aktif, ` +
      `${totals.unreadable} tak terbaca, ${totals.skippedNotSealed} bukan nilai ter-seal`
  )
  if (totals.unreadable > 0) {
    console.warn(
      '[reseal] Ada nilai yang tidak bisa dibuka. JANGAN hapus kunci lama/pepper sampai ' +
        'angka ini 0 dan dry-run ulang melaporkan 0 legacy.'
    )
  }
  return totals.unreadable > 0 ? 2 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error('[reseal] gagal:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect().catch(() => {})
  })
