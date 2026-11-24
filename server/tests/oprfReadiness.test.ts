// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.15.4 langkah 2] Verdict kesiapan PIR sebelum dinyalakan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oprfReadinessVerdict } from '../src/utils/oprfReadiness.js';

test('oprf readiness: semua akun terindeks dan gate hidup → siap', () => {
  const verdict = oprfReadinessVerdict(
    { total: 10, indexed: 10, malformed: 0 },
    { requireReady: true, oprfEnabled: true }
  );
  assert.equal(verdict.ready, true);
  assert.equal(verdict.code, 0);
  assert.equal(verdict.missing, 0);
  assert.match(verdict.lines.join('\n'), /aman menyalakan PIR/);
});

test('oprf readiness: akun lama tanpa index tidak siap, tapi exit 0 tanpa --require-ready', () => {
  const counts = { total: 10, indexed: 7, malformed: 0 };
  const relaxed = oprfReadinessVerdict(counts, { requireReady: false, oprfEnabled: true });
  assert.equal(relaxed.ready, false);
  assert.equal(relaxed.missing, 3);
  assert.equal(relaxed.code, 0);
  assert.match(relaxed.lines.join('\n'), /terisi saat login berikutnya/);

  const strict = oprfReadinessVerdict(counts, { requireReady: true, oprfEnabled: true });
  assert.equal(strict.code, 1);
});

test('oprf readiness: gate OPRF mati selalu tidak siap', () => {
  const verdict = oprfReadinessVerdict(
    { total: 5, indexed: 5, malformed: 0 },
    { requireReady: true, oprfEnabled: false }
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.lines.join('\n'), /PIR_OPRF_ENABLED/);
});

test('oprf readiness: index cacat dihitung tidak usable dan disebut 64-hex', () => {
  const verdict = oprfReadinessVerdict(
    { total: 4, indexed: 4, malformed: 2 },
    { requireReady: true, oprfEnabled: true }
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.usable, 2);
  assert.equal(verdict.code, 1);
  assert.match(verdict.lines.join('\n'), /32 byte hex/);
});

test('oprf readiness: database kosong tidak siap (snapshot PIR menolak kosong)', () => {
  const verdict = oprfReadinessVerdict(
    { total: 0, indexed: 0, malformed: 0 },
    { requireReady: true, oprfEnabled: true }
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.lines.join('\n'), /Belum ada user/);
});
