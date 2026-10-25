// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Gate bukti Privacy Pass untuk sync anonim.
 *
 * Yang dikunci:
 *   1. Bukti terikat percakapan — bukti grup A tidak mengizinkan sync grup B.
 *   2. Satu bukti = satu sync: berhenti pada `ok` pertama (token lain utuh).
 *   3. `required` fail-closed; tanpa flag, sync tanpa bukti tetap jalan.
 *   4. Jumlah percakapan yang dicoba dibatasi (verifikasi RSA tidak berlipat).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSyncProofs, type SyncProofOutcome } from '../src/utils/syncProofs.js'

type Call = [conversationId: string, token: string]

function fakeRedeem (table: Record<string, Record<string, SyncProofOutcome>>) {
  const calls: Call[] = []
  return {
    calls,
    redeem: async (conversationId: string, token: string): Promise<SyncProofOutcome> => {
      calls.push([conversationId, token])
      return table[token]?.[conversationId] ?? 'invalid'
    },
  }
}

test('bukti hanya sah untuk percakapan yang mengeluarkannya', async () => {
  const { calls, redeem } = fakeRedeem({ 'proof-a': { 'conv-a': 'ok' } })

  const denied = await evaluateSyncProofs({
    proofs: ['proof-a'],
    conversationIds: ['conv-b'],
    required: true,
    redeem,
  })
  assert.deepEqual(denied, { ok: false, accepted: 0 })
  assert.deepEqual(calls, [['conv-b', 'proof-a']])

  const allowed = await evaluateSyncProofs({
    proofs: ['proof-a'],
    conversationIds: ['conv-b', 'conv-a'],
    required: true,
    redeem,
  })
  assert.deepEqual(allowed, { ok: true, accepted: 1 })
})

test('berhenti pada bukti pertama yang sah (satu token = satu sync)', async () => {
  const { calls, redeem } = fakeRedeem({
    'proof-1': { 'conv-a': 'spent' },
    'proof-2': { 'conv-a': 'ok' },
    'proof-3': { 'conv-a': 'ok' },
  })

  const decision = await evaluateSyncProofs({
    proofs: ['proof-1', 'proof-2', 'proof-3'],
    conversationIds: ['conv-a'],
    required: true,
    redeem,
  })

  assert.deepEqual(decision, { ok: true, accepted: 1 })
  assert.deepEqual(calls, [['conv-a', 'proof-1'], ['conv-a', 'proof-2']])
})

test('tanpa bukti: ditolak bila wajib, diloloskan bila tidak', async () => {
  const { redeem } = fakeRedeem({})

  assert.deepEqual(
    await evaluateSyncProofs({ proofs: [], conversationIds: ['conv-a'], required: true, redeem }),
    { ok: false, accepted: 0 },
  )
  assert.deepEqual(
    await evaluateSyncProofs({ proofs: [], conversationIds: ['conv-a'], required: false, redeem }),
    { ok: true, accepted: 0 },
  )
})

test('bukti tidak sah tidak memblokir sync saat tidak wajib', async () => {
  const { redeem } = fakeRedeem({ 'proof-a': { 'conv-a': 'invalid' } })
  assert.deepEqual(
    await evaluateSyncProofs({ proofs: ['proof-a'], conversationIds: ['conv-a'], required: false, redeem }),
    { ok: true, accepted: 0 },
  )
})

test('percakapan yang dicoba dibatasi 10 dan duplikat dibuang', async () => {
  const { calls, redeem } = fakeRedeem({})
  const conversations = Array.from({ length: 15 }, (_, index) => `conv-${index}`)

  await evaluateSyncProofs({
    proofs: ['proof-a'],
    conversationIds: [...conversations, 'conv-0', 'conv-0'],
    required: true,
    redeem,
  })

  assert.equal(calls.length, 10)
  assert.equal(new Set(calls.map(([conversationId]) => conversationId)).size, 10)
})
