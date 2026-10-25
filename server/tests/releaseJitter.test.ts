// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P8] Jitter rilis pesan grup.
 *
 * Yang dikunci:
 *  - default MATI (tanpa env, tidak ada delay sama sekali);
 *  - hanya grup — pesan 1:1 tidak pernah ditunda;
 *  - delay selalu di dalam `[0, max]` walau `random()` mengembalikan 1;
 *  - nilai env kotor (negatif/NaN/raksasa) di-clip, bukan membuat relay diam;
 *  - metrik mencatat delay yang BENAR-BENAR dipakai (0 juga dicatat — tanpa itu
 *    histogram kosong terlihat sama dengan fitur yang mati).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MAX_JITTER_MS,
  applyGroupReleaseJitter,
  groupReleaseJitterMs,
} from '../src/utils/releaseJitter.js';

function env(ms: string | undefined): NodeJS.ProcessEnv {
  return ms === undefined ? {} : { GROUP_RELEASE_JITTER_MS: ms };
}

test('policy: default mati, nilai kotor tidak menyalakan fitur', () => {
  assert.equal(groupReleaseJitterMs(env(undefined)), 0, 'tanpa env = mati');
  assert.equal(groupReleaseJitterMs(env('')), 0);
  assert.equal(groupReleaseJitterMs(env('0')), 0);
  assert.equal(groupReleaseJitterMs(env('negatif')), 0);
  assert.equal(groupReleaseJitterMs(env('-500')), 0);
  assert.equal(groupReleaseJitterMs(env('NaN')), 0);
});

test('policy: nilai sah dipakai, nilai berlebih di-clip ke batas keras', () => {
  assert.equal(groupReleaseJitterMs(env('250')), 250);
  assert.equal(groupReleaseJitterMs(env(' 40 ')), 40);
  assert.equal(groupReleaseJitterMs(env('60000')), MAX_JITTER_MS, 'env salah tidak boleh menahan pesan semenit');
  assert.equal(groupReleaseJitterMs(env('12.9')), 12, 'pecahan dipotong');
});

test('jitter: 1:1 tidak pernah ditunda dan metrik tidak disentuh', async () => {
  const observed: number[] = [];
  const delay = await applyGroupReleaseJitter(false, {
    env: env('500'),
    random: () => 0.99,
    observe: (ms) => observed.push(ms),
    sleep: async () => {
      throw new Error('sleep tidak boleh dipanggil untuk 1:1');
    },
  });
  assert.equal(delay, 0);
  assert.deepEqual(observed, [], 'tanpa kerja tidak ada observasi palsu');
});

test('jitter: grup ditunda di dalam batas dan dicatat', async () => {
  const slept: number[] = [];
  const observed: number[] = [];
  const delay = await applyGroupReleaseJitter(true, {
    env: env('250'),
    random: () => 0.5,
    observe: (ms) => observed.push(ms),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(delay, 125, 'floor(0.5 * (250 + 1)) = 125');
  assert.deepEqual(slept, [delay], 'tidur tepat selama delay');
  assert.deepEqual(observed, [delay], 'metrik = delay yang dipakai');
  assert.ok(delay >= 0 && delay <= 250);
});

test('jitter: random()=1 tidak menghasilkan max+1', async () => {
  const delay = await applyGroupReleaseJitter(true, {
    env: env('100'),
    random: () => 1,
    observe: () => {},
    sleep: async () => {},
  });
  assert.equal(delay, 100, 'batas atas benar-benar batas');
});

test('jitter: delay 0 tetap diobservasi (fitur hidup, kebetulan tanpa tunggu)', async () => {
  const observed: number[] = [];
  let slept = false;
  const delay = await applyGroupReleaseJitter(true, {
    env: env('100'),
    random: () => 0,
    observe: (ms) => observed.push(ms),
    sleep: async () => {
      slept = true;
    },
  });
  assert.equal(delay, 0);
  assert.equal(slept, false, 'tidak memanggil sleep untuk 0 ms');
  assert.deepEqual(observed, [0], 'fitur yang hidup harus terlihat di histogram');
});

test('wiring: jitter dipanggil di kedua jalur kirim, hanya untuk grup, setelah ACK/respons', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

  const wt = read('../src/network/realtimeHandlers.ts');
  const ackIndex = wt.indexOf('if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true, msg: safeMessage });');
  const jitterIndex = wt.indexOf('await applyGroupReleaseJitter(true);');
  assert.ok(ackIndex > 0 && jitterIndex > ackIndex, 'WT: jitter setelah ACK sukses (pengirim tidak menunggu)');
  assert.match(
    wt,
    /conversation\.isGroup === true && Array\.isArray\(targetRecipients\)/,
    'WT: hanya grup yang dijitter'
  );

  const rest = read('../src/routes/messages.ts');
  const responseIndex = rest.indexOf('res.status(201).json(safeMessage)');
  const restJitter = rest.indexOf('await applyGroupReleaseJitter(conversation.isGroup === true)');
  assert.ok(responseIndex > 0 && restJitter > responseIndex, 'REST: jitter setelah respons 201');
  assert.match(rest, /select: \{ id: true, isGroup: true, groupEpoch: true \}/, 'REST: isGroup dibaca (bukan ditebak)');

  // Helper hanya menerima `isGroup` (bukan pesan), jadi ia secara struktural
  // tidak bisa mengubah isi/padding — dijaga oleh signature-nya, bukan regex.
  const helper = read('../src/utils/releaseJitter.ts');
  assert.match(
    helper,
    /export async function applyGroupReleaseJitter\(\s*isGroup: boolean/,
    'helper hanya menerima flag grup, tanpa akses ke isi pesan'
  );
});

test('jitter: fitur mati = tidak ada delay & tidak ada observasi', async () => {
  const observed: number[] = [];
  const delay = await applyGroupReleaseJitter(true, {
    env: env(undefined),
    random: () => 0.9,
    observe: (ms) => observed.push(ms),
    sleep: async () => {
      throw new Error('sleep tidak boleh dipanggil saat fitur mati');
    },
  });
  assert.equal(delay, 0);
  assert.deepEqual(observed, []);
});
