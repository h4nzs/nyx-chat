// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { powRateKey, resolvePowIdentity } from '../src/utils/powIdentity.js'
import { pepperedIdentifier } from '../src/utils/atRestSecrets.js'

test('prioritas userId di depan (tidak bisa dipalsukan klien)', () => {
  const id = resolvePowIdentity({ userId: 'u1', instId: 'inst-rotated', fingerprint: 'fp', ip: '1.2.3.4' })
  assert.deepEqual(id, { primaryId: 'u1', prefix: 'pow:user' })
})

test('fallback instId saat userId kosong', () => {
  const id = resolvePowIdentity({ userId: undefined, instId: 'inst-1', fingerprint: 'fp', ip: '1.2.3.4' })
  assert.deepEqual(id, { primaryId: 'inst-1', prefix: 'pow:inst' })
})

test('fallback fingerprint lalu ip', () => {
  assert.deepEqual(
    resolvePowIdentity({ fingerprint: 'fp', ip: '1.2.3.4' }),
    { primaryId: 'fp', prefix: 'pow:fp' }
  )
  assert.deepEqual(
    resolvePowIdentity({ ip: '1.2.3.4' }),
    { primaryId: '1.2.3.4', prefix: 'pow:ip' }
  )
})

test('header bertipe array (bentuk express req.headers) → nilai valid pertama', () => {
  assert.deepEqual(
    resolvePowIdentity({ instId: ['', 'inst-a'] }),
    { primaryId: 'inst-a', prefix: 'pow:inst' }
  )
  assert.deepEqual(
    resolvePowIdentity({ fingerprint: ['fp-x'] }),
    { primaryId: 'fp-x', prefix: 'pow:fp' }
  )
})

test('semua identitas kosong → null (route melempar 400)', () => {
  assert.equal(resolvePowIdentity({}), null)
  assert.equal(resolvePowIdentity({ userId: '', instId: [], fingerprint: [], ip: '' }), null)
})

// ============================================================================
// [docs/30 §30.12 WS-H] Key counter Redis = HMAC pepper, BUKAN hash tanpa kunci.
// ============================================================================

test('powRateKey: HMAC pepper (IP berentropi rendah tidak bisa dienumerasi)', () => {
  const ipIdentity = { prefix: 'pow:ip', primaryId: '203.0.113.7' } as const
  const key = powRateKey(ipIdentity)

  assert.equal(key, pepperedIdentifier('pow:ip:203.0.113.7'))
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.ok(!key.includes('203.0.113.7'), 'alamat klien tidak boleh ada di key')
  // Bentuk lama: blake2b TANPA kunci dipotong 16 hex → ruang IPv4 (2^32) bisa
  // dienumerasi dari snapshot Redis dan dicocokkan dengan hash-nya.
  assert.doesNotMatch(key, /^[a-f0-9]{16}$/, 'bukan pemotongan hash tanpa kunci')

  // Deterministik → counter tetap idempoten; identitas berbeda → key berbeda.
  assert.equal(powRateKey(ipIdentity), key)
  assert.notEqual(powRateKey({ prefix: 'pow:ip', primaryId: '203.0.113.8' }), key)
  // Domain-separated: prefix ikut masuk HMAC, jadi identitas sama dengan prefix
  // berbeda tidak pernah bertabrakan counter.
  assert.notEqual(powRateKey({ prefix: 'pow:inst', primaryId: '203.0.113.7' }), key)
})

test('wiring /pow/challenge memakai powRateKey (bukan hash tanpa kunci)', () => {
  const src = readFileSync(new URL('../src/routes/auth.ts', import.meta.url), 'utf8')
  assert.match(src, /const rateKey = powRateKey\(identity\)/)
  assert.doesNotMatch(src, /stableHash/)
})
