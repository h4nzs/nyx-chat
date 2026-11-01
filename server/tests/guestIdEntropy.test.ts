// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 6 — N6-02] Id guest Burner harus cukup entropi.
 *
 * `guest_<8 hex>` = 32 bit. Id itu adalah `sub` JWT sekaligus kunci routing
 * relay, dan guest tidak punya baris User/Device sehingga tidak ada uniqueness
 * check di DB. Tabrakan = dua guest berbagi kanal relay (isi tetap E2EE,
 * metadata tidak). Tes ini menjaga agar potongan 8 karakter tidak kembali.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../src/routes/auth.ts', import.meta.url)),
  'utf8',
)

test('tidak ada id guest/perangkat yang dipotong jadi 32 bit', () => {
  assert.doesNotMatch(
    source,
    /randomUUID\(\)\.substring\(\s*0\s*,\s*8\s*\)/,
    'id guest tidak boleh dipotong ke 8 karakter hex',
  )
})

test('guestId & guestDeviceId memakai UUID penuh', () => {
  assert.match(source, /const guestId = `guest_\$\{crypto\.randomUUID\(\)\}`/)
  assert.match(source, /const guestDeviceId = `burner_\$\{crypto\.randomUUID\(\)\}`/)
})
