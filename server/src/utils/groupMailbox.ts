// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.2] Mailbox grup — transport kunci yang tidak membentuk graf.
 *
 * Kenyataan hari ini: `group:request_key`/`group:fulfilled_key` merelai
 * requester→fulfiller dan mempersist `targetDeviceKey`, sehingga server bisa
 * merekonstruksi "siapa meminta kunci siapa" (docs/26 §26.4 belum benar).
 *
 * Di sini pengirim TIDAK punya kolom. Item ditulis ke mailbox percakapan dan
 * dibaca oleh siapa pun yang memegang token grup era itu. Untuk item yang
 * memang harus ditujukan (envelope kunci), `tag = HMAC(memberTokenPenerima,
 * "nyx-mailbox-v1")` disimpan sebagai alamat opaque: hanya pemegang token itu
 * yang bisa mengenali item-nya, server tidak bisa membalik tag menjadi
 * identitas.
 *
 * Aturan yang dijaga:
 *  - payload ≤ 8 KB (satu amplop ter-seal), item per post ≤ 32;
 *  - TTL 7 hari (lebih pendek dari retensi pesan — kunci cepat usang);
 *  - pull dibatasi 200 item / 256 KB, cursor komposit `(createdAt, id)`;
 *  - `kind` enum tertutup (bukan string bebas).
 */

export const MAILBOX_KINDS = ['KEY_REQUEST', 'KEY_ENVELOPE', 'META', 'COVER'] as const
export type MailboxKind = typeof MAILBOX_KINDS[number]

export const MAILBOX_MAX_ITEMS_PER_POST = 32
export const MAILBOX_MAX_ITEMS_PER_PULL = 200
export const MAILBOX_MAX_PAYLOAD_BYTES = 8 * 1024
export const MAILBOX_MAX_PULL_BYTES = 256 * 1024
export const MAILBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TAG_RE = /^[A-Za-z0-9_-]{43}$/

export interface MailboxInputItem {
  kind: string
  tag?: string
  payload: string
}

export interface MailboxRow {
  id: string
  conversationId: string
  epoch: number
  kind: string
  tag: string | null
  payload: string
  createdAt: Date
  expiresAt: Date
}

export interface MailboxDb {
  groupMailboxItem: {
    create (args: { data: Record<string, unknown> }): Promise<{ id: string }>
    findMany (args: {
      where: Record<string, unknown>
      orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>
      take?: number
    }): Promise<MailboxRow[]>
    deleteMany (args: { where: Record<string, unknown> }): Promise<{ count: number }>
  }
}

/** Kursor komposit: batch post berbagi `createdAt` yang sama, id jadi tie-break. */
export interface MailboxCursor {
  createdAt: Date
  /** Kosong hanya untuk kursor ISO lama (sebelum cursor komposit). */
  id?: string
}

export function formatMailboxCursor (row: Pick<MailboxRow, 'id' | 'createdAt'>): string {
  return `${new Date(row.createdAt).toISOString()}|${row.id}`
}

/** Terima `ISO|id` baru atau ISO lama; null bila tidak bisa diparse. */
export function parseMailboxCursor (value: string): MailboxCursor | null {
  const separator = value.indexOf('|')
  const rawDate = separator === -1 ? value : value.slice(0, separator)
  const id = separator === -1 ? undefined : value.slice(separator + 1)
  if (separator !== -1 && !id) return null
  const createdAt = new Date(rawDate)
  if (Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id }
}

export type MailboxReject =
  | 'too_many_items'
  | 'unknown_kind'
  | 'bad_tag'
  | 'payload_too_large'
  | 'payload_not_base64url'

/** Validasi satu batch post. Mengembalikan daftar item yang sudah dinormalisasi. */
export function validateMailboxItems (
  items: readonly MailboxInputItem[]
): { ok: true; items: Array<{ kind: MailboxKind; tag: string | null; payload: string }> } | { ok: false; reason: MailboxReject } {
  if (items.length === 0 || items.length > MAILBOX_MAX_ITEMS_PER_POST) {
    return { ok: false, reason: 'too_many_items' }
  }

  const normalized: Array<{ kind: MailboxKind; tag: string | null; payload: string }> = []
  for (const item of items) {
    if (!MAILBOX_KINDS.includes(item.kind as MailboxKind)) return { ok: false, reason: 'unknown_kind' }
    if (item.tag !== undefined && !TAG_RE.test(item.tag)) return { ok: false, reason: 'bad_tag' }
    if (!/^[A-Za-z0-9_-]+$/.test(item.payload)) return { ok: false, reason: 'payload_not_base64url' }
    // base64url 4/3 → byte; bandingkan tanpa mengalokasikan buffer besar.
    const bytes = Math.floor((item.payload.length * 3) / 4)
    if (bytes > MAILBOX_MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload_too_large' }
    normalized.push({ kind: item.kind as MailboxKind, tag: item.tag ?? null, payload: item.payload })
  }
  return { ok: true, items: normalized }
}

/**
 * Tulis batch ke mailbox. `epoch` disalin dari percakapan saat penulisan supaya
 * item era lama tidak bisa di-replay ke era baru (pull memfilter epoch).
 */
export async function postMailboxItems (
  db: MailboxDb,
  input: {
    conversationId: string
    epoch: number
    items: ReadonlyArray<{ kind: MailboxKind; tag: string | null; payload: string }>
    now?: Date
  }
): Promise<number> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + MAILBOX_TTL_MS)
  let written = 0

  for (const item of input.items) {
    await db.groupMailboxItem.create({
      data: {
        conversationId: input.conversationId,
        epoch: input.epoch,
        kind: item.kind,
        tag: item.tag,
        payload: item.payload,
        createdAt: now,
        expiresAt,
      },
    })
    written += 1
  }
  return written
}

export interface MailboxPull {
  items: MailboxRow[]
  nextCursor: string | null
  truncated: boolean
}

/**
 * Pull halaman mailbox. `epoch` ikut difilter: item era lama tidak dikirim ke
 * anggota era baru (kick/rotasi), dan item era baru tidak bocor ke token lama
 * karena token lama sudah ditolak di lapisan route.
 */
export async function pullMailboxItems (
  db: MailboxDb,
  input: {
    conversationId: string
    epoch: number
    cursor?: MailboxCursor
    limit?: number
    now?: Date
  }
): Promise<MailboxPull> {
  const now = input.now ?? new Date()
  const limit = Math.min(input.limit ?? MAILBOX_MAX_ITEMS_PER_PULL, MAILBOX_MAX_ITEMS_PER_PULL)

  const items = await db.groupMailboxItem.findMany({
    where: {
      conversationId: input.conversationId,
      epoch: input.epoch,
      expiresAt: { gt: now },
      ...(input.cursor
        ? {
            OR: [
              { createdAt: { gt: input.cursor.createdAt } },
              ...(input.cursor.id
                ? [{ createdAt: input.cursor.createdAt, id: { gt: input.cursor.id } }]
                : []),
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    // Ambil satu lebih untuk tahu ada halaman berikutnya tanpa menebak dari limit.
    take: limit + 1,
  })
  const hasMore = items.length > limit
  const pageRows = hasMore ? items.slice(0, limit) : items

  let bytes = 0
  const accepted: MailboxRow[] = []
  let truncated = false
  for (const item of pageRows) {
    bytes += item.payload.length
    if (bytes > MAILBOX_MAX_PULL_BYTES) {
      truncated = true
      break
    }
    accepted.push(item)
  }

  const last = accepted[accepted.length - 1]
  return {
    items: accepted,
    nextCursor: last
      ? formatMailboxCursor(last)
      : (input.cursor
          ? (input.cursor.id ? formatMailboxCursor({ id: input.cursor.id, createdAt: input.cursor.createdAt }) : input.cursor.createdAt.toISOString())
          : null),
    truncated: truncated || hasMore || accepted.length < pageRows.length,
  }
}

/** GC item kedaluwarsa (dipanggil job pembersihan). */
export async function purgeExpiredMailbox (db: MailboxDb, now: Date = new Date()): Promise<number> {
  const result = await db.groupMailboxItem.deleteMany({ where: { expiresAt: { lte: now } } })
  return result.count
}
