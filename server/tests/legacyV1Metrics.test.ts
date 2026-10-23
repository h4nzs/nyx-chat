// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8 residual] Counter pemakaian jalur v1.
 *
 * Audit DB tidak melihat recovery v1, pre-key bundle v1, dan device-link v1
 * karena jalur itu tidak meninggalkan baris yang bisa dibedakan. Counter ini
 * satu-satunya sinyalnya — jadi labelnya harus tetap enum pendek dan tidak
 * boleh menerima identitas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_V1_USAGE,
  incCounter,
  renderMetricsText,
  resetMetricsForTests,
} from '../src/utils/metrics.js';

test('metrik v1: setiap jalur dihitung terpisah', () => {
  resetMetricsForTests();
  incCounter(LEGACY_V1_USAGE, { path: 'recovery-signature' });
  incCounter(LEGACY_V1_USAGE, { path: 'recovery-signature' });
  incCounter(LEGACY_V1_USAGE, { path: 'prekey-bundle' });
  incCounter(LEGACY_V1_USAGE, { path: 'device-link' });

  const text = renderMetricsText();
  assert.match(text, /nyx_legacy_v1_usage_total\{path="recovery-signature"\} 2/);
  assert.match(text, /nyx_legacy_v1_usage_total\{path="prekey-bundle"\} 1/);
  assert.match(text, /nyx_legacy_v1_usage_total\{path="device-link"\} 1/);
});

test('metrik v1: nilai label kepanjangan/berbentuk identitas ditolak', () => {
  resetMetricsForTests();
  // >24 karakter: bukan enum, dan ruang untuk menempelkan identifier.
  incCounter(LEGACY_V1_USAGE, { path: 'x'.repeat(30) });
  // UUID adalah bentuk identitas yang dilarang di label mana pun.
  incCounter(LEGACY_V1_USAGE, { path: '123e4567-e89b-12d3-a456-426614174000' });

  const text = renderMetricsText();
  assert.equal(/nyx_legacy_v1_usage_total\{/.test(text), false);
  // Penolakan tetap terlihat (bukan senyap).
  assert.match(text, /nyx_metrics_rejected_total\{reason="label_value"\} 2/);
});
