// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// [26.9 RBAC] Unit test guard admin capability token — possession-based
// authorization untuk mutasi destruktif grup (PUT details, key-rotation,
// purge). Server tidak tahu roster/role; satu-satunya bentuk otorisasi
// kompatibel ZK adalah bukti kepemilikan token yang di-hash di server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { extractHeader, hashAdminToken, isAdminTokenValid } from '../src/utils/adminCapability.js'
import { safeEqualStrings } from '../src/utils/validate.js'

// --- hashAdminToken ---

test('hashAdminToken → SHA-256 hex lowercase 64-char (kontrak kolom adminSecretHash)', () => {
  const token = 'AbC123_-token/base64url+dib64url' // bentuk base64url dari client
  const h = hashAdminToken(token)
  assert.match(h, /^[a-f0-9]{64}$/)
  // Konsisten dengan implementasi client: SHA-256 UTF-8 dari token mentah.
  const expected = createHash('sha256').update(token, 'utf8').digest('hex')
  assert.equal(h, expected)
})

test('hashAdminToken deterministik & sensitif input', () => {
  assert.equal(hashAdminToken('sama'), hashAdminToken('sama'))
  assert.notEqual(hashAdminToken('token-a'), hashAdminToken('token-b'))
  // Beda case = beda hash (hash bukan case-insensitive).
  assert.notEqual(hashAdminToken('Token'), hashAdminToken('token'))
})

test('hashAdminToken dua token berbeda TIDAK pernah tabrakan praktis (sanity 256-bit)', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const h = hashAdminToken(`tok-${i}`)
    assert.ok(!seen.has(h), `collision at i=${i}`)
    seen.add(h)
  }
})

// --- extractHeader (normalisasi req.headers Node) ---

test('extractHeader: string diteruskan apa adanya', () => {
  assert.equal(extractHeader('tok'), 'tok')
  assert.equal(extractHeader(''), '')
})

test('extractHeader: array header diambil elemen pertama (req.headers kembalikan array untuk header duplikat)', () => {
  assert.equal(extractHeader(['tok-a', 'tok-b']), 'tok-a')
  assert.equal(extractHeader([]), '')
})

test('extractHeader: non-string/undefined → string kosong', () => {
  assert.equal(extractHeader(undefined), '')
  assert.equal(extractHeader(null), '')
  assert.equal(extractHeader(123), '')
  assert.equal(extractHeader({ evil: true }), '')
})

// --- isAdminTokenValid ---

test('token valid → true (hash cocok)', () => {
  const token = 'valid-admin-capability-token'
  assert.equal(isAdminTokenValid(hashAdminToken(token), token), true)
})

test('token salah → false', () => {
  const token = 'valid-admin-capability-token'
  assert.equal(isAdminTokenValid(hashAdminToken(token), 'wrong-token'), false)
})

test('token kosong/missing → false saat hash terpasang (fail closed)', () => {
  const hash = hashAdminToken('some-token')
  assert.equal(isAdminTokenValid(hash, ''), false)
  assert.equal(isAdminTokenValid(hash, undefined as unknown as string), false)
})

test('hash NULL/undefined (grup legacy pra-26.9) → BYPASS kompatibilitas', () => {
  assert.equal(isAdminTokenValid(null, ''), true)
  assert.equal(isAdminTokenValid(null, 'whatever'), true)
  assert.equal(isAdminTokenValid(undefined, ''), true)
})

test('perbandingan timing-safe dilakukan pada HASH — panjang token tidak bocor', () => {
  // Token salah yang jauh lebih panjang/pendek dari aslinya tetap ditolak,
  // dan perbandingannya terjadi pada dua string hex 64-char (bukan token).
  const token = 'short'
  const hash = hashAdminToken(token)
  assert.equal(isAdminTokenValid(hash, 'x'.repeat(4096)), false)
  assert.equal(isAdminTokenValid(hash, 'x'), false)
  // Kontrak dasar safeEqualStrings dipertahankan oleh util.
  assert.equal(safeEqualStrings(hash, hash), true)
})

test('hash dipresentasikan sebagai token (salah arah) → false', () => {
  const token = 'real-token'
  // Penyerang mengirim HASH sebagai token: SHA-256(hash) ≠ hash → ditolak.
  assert.equal(isAdminTokenValid(hashAdminToken(token), hashAdminToken(token)), false)
})
