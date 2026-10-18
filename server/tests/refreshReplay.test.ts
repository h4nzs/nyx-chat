// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi bug 2026-10-18: logout sendiri saat idle + `/login?reason=revoked`
 * di perangkat yang sama.
 *
 * Yang dikunci terhadap util klasifikasi:
 *   1. Family tanpa token hidup → `session_ended` (401 biasa; BUKAN alarm
 *      hijack, karena tidak ada sesi hidup yang perlu dilindungi).
 *   2. Token yang merupakan pendahulu LANGSUNG dari tip yang masih segar →
 *      `benign` (retry setelah respons rotasi hilang / tab freeze).
 *   3. Di luar jendela toleransi → `reuse`.
 *   4. Penerus bukan langsung (token sudah lama ditinggalkan) → `reuse`,
 *      walaupun tip masih segar.
 *   5. Env `REFRESH_REPLAY_GRACE_MS` tidak boleh membuka jendela tak terbatas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REFRESH_REPLAY_GRACE_MS,
  MAX_REFRESH_REPLAY_GRACE_MS,
  classifyRefreshReplay,
  refreshReplayGraceMs,
  sessionEndedError,
  type LiveRefreshTip,
} from '../src/utils/refreshReplay.js';

const NOW = 1_800_000_000_000;

function tip(overrides: Partial<LiveRefreshTip> = {}): LiveRefreshTip {
  return {
    id: 'tip-id',
    replacesId: 'presented-id',
    createdAt: new Date(NOW - 1_000),
    ...overrides,
  };
}

test('family tanpa token hidup → session_ended, bukan alarm hijack', () => {
  assert.equal(
    classifyRefreshReplay({ presentedId: 'presented-id', tip: null, now: NOW }),
    'session_ended',
  );
  const err = sessionEndedError();
  assert.equal(err.status, 401);
  assert.match(err.message, /Session has ended/);
});

test('retry setelah respons rotasi hilang (pendahulu langsung, masih segar) → benign', () => {
  // Skenario nyata: POST /refresh timeout 30 s, klien mengulang dengan rt lama
  // sementara server sudah membuat tip-nya.
  assert.equal(
    classifyRefreshReplay({ presentedId: 'presented-id', tip: tip(), now: NOW }),
    'benign',
  );
});

test('di luar jendela toleransi → reuse', () => {
  const stale = tip({ createdAt: new Date(NOW - DEFAULT_REFRESH_REPLAY_GRACE_MS - 1) });
  assert.equal(
    classifyRefreshReplay({ presentedId: 'presented-id', tip: stale, now: NOW }),
    'reuse',
  );
});

test('tip bukan penerus langsung → tetap reuse walau baru dibuat', () => {
  // Token dari beberapa rotasi lalu (bukan pendahulu langsung) tidak boleh
  // dianggap retry — ini pola replay token lama.
  assert.equal(
    classifyRefreshReplay({
      presentedId: 'presented-id',
      tip: tip({ replacesId: 'some-other-token' }),
      now: NOW,
    }),
    'reuse',
  );
  assert.equal(
    classifyRefreshReplay({ presentedId: 'presented-id', tip: tip({ replacesId: null }), now: NOW }),
    'reuse',
  );
});

test('tip dengan createdAt di masa depan tidak dianggap benign (clock skew)', () => {
  assert.equal(
    classifyRefreshReplay({
      presentedId: 'presented-id',
      tip: tip({ createdAt: new Date(NOW + 5_000) }),
      now: NOW,
    }),
    'reuse',
  );
});

test('grace dari env: default saat kosong/invalid, di-clamp ke maksimum', () => {
  assert.equal(refreshReplayGraceMs({}), DEFAULT_REFRESH_REPLAY_GRACE_MS);
  assert.equal(refreshReplayGraceMs({ REFRESH_REPLAY_GRACE_MS: '' }), DEFAULT_REFRESH_REPLAY_GRACE_MS);
  assert.equal(refreshReplayGraceMs({ REFRESH_REPLAY_GRACE_MS: 'abc' }), DEFAULT_REFRESH_REPLAY_GRACE_MS);
  assert.equal(refreshReplayGraceMs({ REFRESH_REPLAY_GRACE_MS: '-5' }), DEFAULT_REFRESH_REPLAY_GRACE_MS);
  assert.equal(refreshReplayGraceMs({ REFRESH_REPLAY_GRACE_MS: '60000' }), 60_000);
  assert.equal(
    refreshReplayGraceMs({ REFRESH_REPLAY_GRACE_MS: String(MAX_REFRESH_REPLAY_GRACE_MS * 10) }),
    MAX_REFRESH_REPLAY_GRACE_MS,
  );
});
