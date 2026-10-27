// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-07] Kunci job cron: satu pemegang, TTL selalu ada, pelepasan
 * compare-and-delete, dan fail-closed saat Redis tidak bisa dihubungi.
 *
 * Fake Redis di sini **hanya** mengenal `SET key value { NX, EX }` dan
 * `EVAL` compare-and-delete — bentuk posisional (`'EX', ttl, 'NX'`) gagal di
 * sini, sama seperti di server nyata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithJobLock, type JobLockRedis } from '../src/utils/jobLock.js';

function fakeRedis () {
  const store = new Map<string, string>();
  const released: string[] = [];
  const redis: JobLockRedis = {
    async set (key, value, options) {
      assert.equal(typeof options, 'object', 'SET wajib memakai objek opsi');
      assert.equal(options.NX, true, 'NX wajib: dua worker tidak boleh menjalankan job yang sama');
      assert.ok(Number.isInteger(options.EX) && options.EX > 0, 'EX wajib: kunci mati dipegang selamanya');
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval (script, { keys, arguments: args }) {
      assert.match(script, /redis\.call\('get'/, 'pelepasan harus compare-and-delete');
      const key = keys[0]!;
      const token = args[0]!;
      if (store.get(key) !== token) return 0;
      store.delete(key);
      released.push(key);
      return 1;
    },
  };
  return { redis, store, released };
}

test('job lock: worker pertama menjalankan, worker kedua dilewati', async () => {
  const { redis } = fakeRedis();
  let runs = 0;

  const first = await runWithJobLock('message-sweeper', 120, async () => { runs += 1; }, { redis, log: () => {} });
  assert.equal(first, 'ran');

  // Pemegang kedua mencoba SELAGI kunci masih ada (job pertama belum selesai):
  // simulasikan dengan kunci yang dipegang token lain.
  const held = fakeRedis();
  await held.redis.set('job:message-sweeper', 'token-lain', { NX: true, EX: 120 });
  const second = await runWithJobLock('message-sweeper', 120, async () => { runs += 1; }, { redis: held.redis, log: () => {} });
  assert.equal(second, 'busy', 'worker lain harus busy, bukan menjalankan job');
  assert.equal(runs, 1, 'job hanya berjalan satu kali');
});

test('job lock: kunci dilepas setelah selesai sehingga run berikutnya bisa jalan', async () => {
  const { redis, store, released } = fakeRedis();

  assert.equal(await runWithJobLock('system-sweeper', 3600, async () => {}, { redis }), 'ran');
  assert.equal(store.size, 0, 'kunci tidak tertinggal setelah job selesai');
  assert.deepEqual(released, ['job:system-sweeper']);

  assert.equal(await runWithJobLock('system-sweeper', 3600, async () => {}, { redis }), 'ran');
});

test('job lock: pelepasan tidak menghapus kunci milik worker lain', async () => {
  const { redis, store } = fakeRedis();
  store.set('job:kt-snapshot', 'token-worker-lain');

  // Kunci dipegang worker lain → job ini tidak jalan dan tidak menyentuh kuncinya.
  const outcome = await runWithJobLock('kt-snapshot', 3600, async () => {
    assert.fail('job tidak boleh berjalan tanpa kunci');
  }, { redis });
  assert.equal(outcome, 'busy');
  assert.equal(store.get('job:kt-snapshot'), 'token-worker-lain');
});

test('job lock: Redis tidak tersedia = job dilewati (fail-closed), bukan dijalankan semua worker', async () => {
  const logs: string[] = [];
  const redis: JobLockRedis = {
    async set () { throw new Error('redis down'); },
    async eval () { return 0; },
  };

  const outcome = await runWithJobLock('pir-snapshot', 7200, async () => {
    assert.fail('job tidak boleh berjalan saat kunci tidak bisa diambil');
  }, { redis, log: (message) => logs.push(message) });

  assert.equal(outcome, 'unavailable');
  assert.match(logs[0]!, /dilewati.*redis down/);
});

test('job lock: kunci tetap dilepas walau job melempar', async () => {
  const { redis, store } = fakeRedis();

  await assert.rejects(
    () => runWithJobLock('message-sweeper', 120, async () => { throw new Error('job gagal'); }, { redis }),
    /job gagal/
  );
  assert.equal(store.size, 0, 'kegagalan job tidak boleh menahan kunci sampai TTL');
});
