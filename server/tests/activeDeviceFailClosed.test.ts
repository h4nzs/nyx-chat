// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-31 — F-04] Single-active-device harus FAIL-CLOSED saat Redis
 * tidak terbaca, dan kegagalan baca tidak boleh masuk cache 60 detik.
 *
 * Sebelumnya `redisClient.get(...).catch(() => null)` menyamakan "Redis error"
 * dengan "tidak ada perangkat aktif" → `true`, lalu menyimpan `null` di cache
 * sehingga perangkat yang sudah di-kick tetap lolos setelah Redis pulih.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLocalActiveDeviceCache,
  isActiveDeviceAllowedWith,
} from '../src/network/redisBridge.js';

let seq = 0;
function freshUser (): string {
  seq += 1;
  return `user-fail-closed-${seq}`;
}

test('pembacaan perangkat aktif gagal → tolak (fail-closed)', async () => {
  const userId = freshUser();
  clearLocalActiveDeviceCache();

  const allowed = await isActiveDeviceAllowedWith(async () => {
    throw new Error('redis down');
  }, userId, 'device-lama');

  assert.equal(allowed, false, 'kegagalan baca bukan izin');
});

test('kegagalan baca TIDAK di-cache: pembacaan berikutnya memakai nilai asli', async () => {
  const userId = freshUser();
  clearLocalActiveDeviceCache();

  await isActiveDeviceAllowedWith(async () => {
    throw new Error('redis down');
  }, userId, 'device-lama');

  // Redis pulih dan menyatakan perangkat lain yang aktif.
  const allowed = await isActiveDeviceAllowedWith(async () => 'device-baru', userId, 'device-lama');
  assert.equal(allowed, false, 'nilai error tidak boleh bertahan sebagai izin');

  // Device yang benar tetap boleh.
  const activeAllowed = await isActiveDeviceAllowedWith(async () => 'device-baru', userId, 'device-baru');
  assert.equal(activeAllowed, true);
});

test('tidak ada perangkat aktif (null yang benar-benar terbaca) tetap diloloskan', async () => {
  const userId = freshUser();
  clearLocalActiveDeviceCache();

  const allowed = await isActiveDeviceAllowedWith(async () => null, userId, 'device-apa-saja');
  assert.equal(allowed, true, 'akun tanpa baris active_device tidak punya batasan untuk dilanggar');
});

test('cache 60 detik tetap bekerja untuk hasil yang berhasil dibaca', async () => {
  const userId = freshUser();
  clearLocalActiveDeviceCache();
  let reads = 0;

  const read = async () => {
    reads += 1;
    return 'device-baru';
  };

  assert.equal(await isActiveDeviceAllowedWith(read, userId, 'device-baru'), true);
  assert.equal(await isActiveDeviceAllowedWith(read, userId, 'device-lama'), false);
  assert.equal(reads, 1, 'pembacaan kedua memakai cache, bukan Redis');
});
