// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 6 — N6-01] `/logout` harus memutus perangkat itu saja.
 *
 * Dua lapis yang dikunci:
 *   1. perilaku planner: `deviceId` tak diketahui → `null` (tidak ada kick),
 *      karena kick tanpa `deviceId` akan me-logout SEMUA perangkat;
 *   2. pemasangan di handler: `routes/auth.ts` memakai planner dan meneruskan
 *      `kick.deviceId` sebagai argumen device ke `emitEventToUser`/`sendJsonToUser`.
 *      Lapis ini penting karena planner yang benar tetapi tidak dipakai tidak
 *      menutup apa pun.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { planDeviceLogoutKick } from '../src/utils/logoutKick.js'

test('kick /logout membawa deviceId dari token refresh', () => {
  const plan = planDeviceLogoutKick({ userId: 'u1', deviceId: 'dev-1', reason: 'logout' })
  assert.deepEqual(plan, { userId: 'u1', deviceId: 'dev-1', reason: 'logout' })
})

test('deviceId tidak diketahui → TIDAK ada kick (jangan logout semua perangkat)', () => {
  for (const deviceId of [null, undefined, '', '   ']) {
    assert.equal(
      planDeviceLogoutKick({ userId: 'u1', deviceId }),
      null,
      `deviceId=${JSON.stringify(deviceId)} tidak boleh menghasilkan kick`,
    )
  }
})

test('userId kosong → tidak ada kick', () => {
  assert.equal(planDeviceLogoutKick({ deviceId: 'dev-1' }), null)
  assert.equal(planDeviceLogoutKick({ userId: '', deviceId: 'dev-1' }), null)
})

test('/logout memakai planner dan mengirim kick device-scoped', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/routes/auth.ts', import.meta.url)),
    'utf8',
  )
  const start = source.indexOf("router.post('/logout'")
  assert.ok(start >= 0, "handler POST /logout tidak ditemukan di routes/auth.ts")
  const end = source.indexOf('router.get(', start)
  const block = source.slice(start, end > start ? end : undefined)

  assert.match(block, /planDeviceLogoutKick\(/, '/logout harus memakai planner device-scoped')
  assert.match(
    block,
    /emitEventToUser\(\s*kick\.userId,\s*'force_logout',\s*\{ reason: kick\.reason, deviceId: kick\.deviceId \},\s*kick\.deviceId,?\s*\)/,
    'force_logout harus diarahkan ke kick.deviceId',
  )
  assert.match(
    block,
    /sendJsonToUser\(\s*kick\.userId,\s*TransportOpCode\.KICK,\s*\{ reason: 'LOGOUT', deviceId: kick\.deviceId \},\s*false,\s*kick\.deviceId,?\s*\)/,
    'KICK harus diarahkan ke kick.deviceId',
  )
})
