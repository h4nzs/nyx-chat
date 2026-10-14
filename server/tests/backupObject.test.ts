// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_DEFAULT_URL_TTL,
  BACKUP_FILE_EXTENSION,
  BACKUP_FREE_MAX_BYTES,
  BACKUP_MAX_URL_TTL,
  BACKUP_MIN_URL_TTL,
  BACKUP_OBJECT_PREFIX,
  BACKUP_SUBSCRIBER_MAX_BYTES,
  backupSizeLimit,
  clampBackupUrlTtl,
  deriveBackupObjectKey,
  validateBackupUpload
} from '../src/utils/backupObject.js'

const SECRET = 'unit-test-backup-secret'
const USER = '11111111-2222-3333-4444-555555555555'

test('kunci objek deterministik dan berada di folder privat', () => {
  const a = deriveBackupObjectKey(SECRET, USER)
  const b = deriveBackupObjectKey(SECRET, USER)
  assert.equal(a, b, 'pemanggilan berulang harus identik')
  assert.ok(a.startsWith(BACKUP_OBJECT_PREFIX), 'harus di folder backups/')
  assert.ok(a.endsWith(`.${BACKUP_FILE_EXTENSION}`), 'harus berakhiran .nyxbak')
  assert.match(a, /^backups\/[0-9a-f]{64}\.nyxbak$/, 'isi hanya hex 64 karakter')
})

test('kunci objek tidak membocorkan userId', () => {
  const key = deriveBackupObjectKey(SECRET, USER)
  assert.ok(!key.includes(USER), 'userId tidak boleh muncul di kunci')
  assert.ok(!key.includes('11111111'), 'potongan userId pun tidak boleh muncul')
})

test('user berbeda → kunci berbeda; rahasia berbeda → kunci berbeda', () => {
  const other = deriveBackupObjectKey(SECRET, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.notEqual(deriveBackupObjectKey(SECRET, USER), other)
  assert.notEqual(deriveBackupObjectKey('rahasia-lain', USER), deriveBackupObjectKey(SECRET, USER))
})

test('rahasia/userId kosong ditolak (fail-closed)', () => {
  assert.throws(() => deriveBackupObjectKey('', USER))
  assert.throws(() => deriveBackupObjectKey(SECRET, ''))
})

test('kuota per tier', () => {
  assert.equal(backupSizeLimit('SUBSCRIBER'), BACKUP_SUBSCRIBER_MAX_BYTES)
  assert.equal(backupSizeLimit('FREE'), BACKUP_FREE_MAX_BYTES)
  assert.equal(backupSizeLimit(null), BACKUP_FREE_MAX_BYTES)
  assert.equal(backupSizeLimit('SESUATU'), BACKUP_FREE_MAX_BYTES)
})

test('TTL presigned dijepit ke rentang aman', () => {
  assert.equal(clampBackupUrlTtl(undefined), BACKUP_DEFAULT_URL_TTL)
  assert.equal(clampBackupUrlTtl('bukan-angka'), BACKUP_DEFAULT_URL_TTL)
  assert.equal(clampBackupUrlTtl(1), BACKUP_MIN_URL_TTL)
  assert.equal(clampBackupUrlTtl(99999), BACKUP_MAX_URL_TTL)
  assert.equal(clampBackupUrlTtl('600'), 600)
  assert.equal(clampBackupUrlTtl(480.9), 480)
})

test('validateBackupUpload menerima ukuran dalam kuota', () => {
  const decision = validateBackupUpload(1024, 120, 'FREE')
  assert.equal(decision.ok, true)
  assert.deepEqual(decision, { ok: true, size: 1024, urlTtl: 120 })
})

test('validateBackupUpload menolak ukuran tak sah', () => {
  for (const bad of [undefined, null, 'x', 0, -5, Number.NaN]) {
    const decision = validateBackupUpload(bad, 300, 'FREE')
    assert.equal(decision.ok, false, `size=${String(bad)} harus ditolak`)
    if (!decision.ok) assert.equal(decision.status, 400)
  }
})

test('batas kuota FREE ditegakkan, SUBSCRIBER lebih longgar', () => {
  const overFree = validateBackupUpload(BACKUP_FREE_MAX_BYTES + 1, 300, 'FREE')
  assert.equal(overFree.ok, false)
  if (!overFree.ok) assert.match(overFree.error, /too large/i)

  // Ukuran yang sama di tier SUBSCRIBER masih diterima.
  const asSubscriber = validateBackupUpload(BACKUP_FREE_MAX_BYTES + 1, 300, 'SUBSCRIBER')
  assert.equal(asSubscriber.ok, true)

  const overSubscriber = validateBackupUpload(BACKUP_SUBSCRIBER_MAX_BYTES + 1, 300, 'SUBSCRIBER')
  assert.equal(overSubscriber.ok, false)
})

test('ukuran pecahan dipotong ke bilangan bulat', () => {
  const decision = validateBackupUpload(1234.9, 300, 'FREE')
  assert.equal(decision.ok, true)
  if (decision.ok) assert.equal(decision.size, 1234)
})
