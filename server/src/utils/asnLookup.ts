// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Pencarian ASN **lokal** untuk kuota anti-abuse per
 * jaringan.
 *
 * Prinsip yang tidak boleh dilanggar: tidak ada layanan pihak ketiga yang
 * menerima IP pengguna saat runtime, dan IP mentah tidak pernah disimpan. Karena
 * itu tabel prefix→ASN dibaca dari **berkas lokal** yang disediakan operator
 * (`ASN_DB_FILE`, mis. ekspor CSV `GeoLite2-ASN-Blocks-IPv4/6.csv`), diproses di
 * memori proses, dan yang masuk Redis hanya nilai ter-pepper.
 *
 * Format yang diterima (dua kolom pertama; kolom sisa diabaikan):
 *
 *   1.0.0.0/24,13335
 *   1.1.0.0/16,13335
 *   2001:db8::/32,64500
 *
 * Baris kosong/`#`/header (`network,autonomous_system_number,...`) dilewati.
 * Pencocokan = **longest prefix**, jadi tabel boleh memuat prefix tumpang tindih.
 * Bila berkas tidak diset/rusak, seluruh lapisan ASN nonaktif (fail-open) —
 * sama seperti lapisan lain di repo: salah konfigurasi tidak boleh memblokir
 * trafik sah.
 */

import { readFileSync } from 'node:fs'

const IPV4_BITS = 32
const IPV6_BITS = 128

export interface AsnRange {
  family: 4 | 6
  bits: number
  start: bigint
  end: bigint
  asn: string
}

export interface AsnIndex {
  /** `bits → daftar rentang` (urut menaik berdasarkan `start`) untuk tiap famili. */
  groups: { 4: Map<number, AsnRange[]>; 6: Map<number, AsnRange[]> }
  size: number
}

/** IPv4 titik-desimal → bigint. `null` bila bukan IPv4 yang sah. */
function parseIpv4(value: string): bigint | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = (result << 8n) | BigInt(octet)
  }
  return result
}

/** IPv6 (termasuk bentuk `::` dan IPv4 tertanam) → bigint. */
function parseIpv6(value: string): bigint | null {
  const zoneIndex = value.indexOf('%')
  const text = zoneIndex === -1 ? value : value.slice(0, zoneIndex)
  if (!text.includes(':')) return null

  const halves = text.split('::')
  if (halves.length > 2) return null

  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const out: number[] = []
    const pieces = segment.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!
      if (piece.includes('.')) {
        // IPv4 tertanam: hanya boleh di akhir segmen.
        if (i !== pieces.length - 1) return null
        const v4 = parseIpv4(piece)
        if (v4 === null) return null
        out.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      out.push(parseInt(piece, 16))
    }
    return out
  }

  const head = toGroups(halves[0] ?? '')
  const tail = toGroups(halves[1] ?? '')
  if (head === null || tail === null) return null

  let groups: number[]
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length)
    if (missing < 1) return null
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail]
  } else {
    if (head.length !== 8) return null
    groups = head
  }

  let result = 0n
  for (const group of groups) result = (result << 16n) | BigInt(group)
  return result
}

/** IP → `{ family, value }`, atau `null` bila tak bisa diurai. */
export function parseIp(value: string): { family: 4 | 6; value: bigint } | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.includes(':')) {
    const v6 = parseIpv6(trimmed)
    return v6 === null ? null : { family: 6, value: v6 }
  }
  const v4 = parseIpv4(trimmed)
  return v4 === null ? null : { family: 4, value: v4 }
}

/** `1.2.3.0/24` / `2001:db8::/32` → rentang. `null` bila bentuknya salah. */
export function parseAsnPrefix(value: string, asn: string): AsnRange | null {
  const [networkPart, bitsPart] = value.trim().split('/')
  if (!networkPart || bitsPart === undefined) return null
  if (!/^\d{1,3}$/.test(bitsPart)) return null

  const bits = Number(bitsPart)
  const parsed = parseIp(networkPart)
  if (!parsed) return null

  const maxBits = parsed.family === 4 ? IPV4_BITS : IPV6_BITS
  if (bits < 0 || bits > maxBits) return null

  const hostBits = BigInt(maxBits - bits)
  const mask = hostBits === 0n ? (1n << BigInt(maxBits)) - 1n : ((1n << BigInt(maxBits)) - 1n) ^ ((1n << hostBits) - 1n)
  const start = parsed.value & mask
  const end = start | (hostBits === 0n ? 0n : (1n << hostBits) - 1n)

  return { family: parsed.family, bits, start, end, asn }
}

/**
 * Urai isi berkas tabel. Toleran terhadap header CSV GeoLite2 dan kutip:
 * kolom ke-2 harus berupa angka ASN, kalau tidak baris dianggap header/komentar.
 */
export function parseAsnTable(text: string): AsnRange[] {
  const ranges: AsnRange[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const fields = line.split(',').map((field) => field.trim().replace(/^"|"$/g, ''))
    const network = fields[0]
    const asn = fields[1]
    if (!network || !asn || !/^\d+$/.test(asn)) continue

    const range = parseAsnPrefix(network, asn)
    if (range) ranges.push(range)
  }
  return ranges
}

/** Bangun indeks pencarian (kelompokkan per famili + panjang prefix). */
export function buildAsnIndex(ranges: AsnRange[]): AsnIndex {
  const groups: AsnIndex['groups'] = { 4: new Map(), 6: new Map() }
  for (const range of ranges) {
    const byBits = groups[range.family]
    const list = byBits.get(range.bits)
    if (list) list.push(range)
    else byBits.set(range.bits, [range])
  }
  for (const byBits of [groups[4], groups[6]]) {
    for (const list of byBits.values()) list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  }
  return { groups, size: ranges.length }
}

/** Rentang terakhir dengan `start <= value` (binary search). */
function findContaining(range: AsnRange[], value: bigint): AsnRange | null {
  let low = 0
  let high = range.length - 1
  let candidate: AsnRange | null = null
  while (low <= high) {
    const mid = (low + high) >> 1
    const entry = range[mid]!
    if (entry.start <= value) {
      candidate = entry
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return candidate && value <= candidate.end ? candidate : null
}

/**
 * ASN untuk sebuah IP, memakai **longest prefix** (prefix terpanjang menang).
 * `null` = tidak ada di tabel (atau IP tidak sah) → lapisan ASN dilewati.
 */
export function lookupAsn(index: AsnIndex | null, ip: string): string | null {
  if (!index) return null
  const parsed = parseIp(ip)
  if (!parsed) return null

  const byBits = index.groups[parsed.family]
  const lengths = [...byBits.keys()].sort((a, b) => b - a)
  for (const bits of lengths) {
    const hit = findContaining(byBits.get(bits)!, parsed.value)
    if (hit) return hit.asn
  }
  return null
}

/** Berkas tabel dari env (`ASN_DB_FILE`); `null` bila tidak diset/tidak ada. */
export function loadAsnIndex(filePath: string | undefined = process.env.ASN_DB_FILE): AsnIndex | null {
  if (!filePath) return null
  try {
    const index = buildAsnIndex(parseAsnTable(readFileSync(filePath, 'utf8')))
    return index.size > 0 ? index : null
  } catch (e) {
    console.warn(`[ASN] Tabel ASN tidak bisa dibaca (${filePath}) — lapisan kuota per-ASN nonaktif:`, e)
    return null
  }
}

let cachedIndex: AsnIndex | null | undefined
let cachedPath: string | undefined

/** Versi berkas env (di-cache; `undefined` berarti belum pernah dimuat). */
export function asnIndexFromEnv(): AsnIndex | null {
  const filePath = process.env.ASN_DB_FILE
  if (cachedIndex !== undefined && cachedPath === filePath) return cachedIndex
  cachedPath = filePath
  cachedIndex = loadAsnIndex(filePath)
  return cachedIndex
}

/** Hook test: buang cache tabel. */
export function clearAsnCacheForTests(): void {
  cachedIndex = undefined
  cachedPath = undefined
}
