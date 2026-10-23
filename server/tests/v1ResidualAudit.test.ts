// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8 residual] Klasifikasi amplop untuk audit denylist.
 *
 * Audit hanya berguna bila klasifikasinya tidak menebak: amplop v2 yang salah
 * dihitung sebagai v1 akan menahan penghapusan selamanya, dan sebaliknya
 * membuat operator menghapus reader yang masih dipakai. Test ini mengunci
 * bentuk wire yang sudah ada di `pqV2.spec.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEnvelope,
  classifyEnvelope,
  emptyEnvelopeCounts,
  legacyEnvelopeCount,
} from '../src/utils/v1ResidualAudit.js';

const groupEnvelope = (sigV?: unknown) =>
  JSON.stringify({
    header: { n: 0, pn: 0, dh: 'abc' },
    ciphertext: 'AAAA',
    signature: 'BBBB',
    ...(sigV === undefined ? {} : { sigV }),
    senderKeyId: '0123456789abcdef',
  });

test('audit v1: pesan 1:1 dibedakan dari handshakeVersion', () => {
  assert.equal(classifyEnvelope(JSON.stringify({ x3dh: { handshakeVersion: 2 } })), 'direct-v2');
  assert.equal(classifyEnvelope(JSON.stringify({ x3dh: { handshakeVersion: 1 } })), 'direct-v1');
  // Wrapper lama tidak menulis handshakeVersion sama sekali → v1, bukan v2.
  assert.equal(classifyEnvelope(JSON.stringify({ x3dh: { ephemeralKey: 'x' } })), 'direct-v1');
});

test('audit v1: amplop grup memakai sigV, absen berarti v1', () => {
  assert.equal(classifyEnvelope(groupEnvelope(2)), 'group-v2');
  assert.equal(classifyEnvelope(groupEnvelope(1)), 'group-v1');
  assert.equal(classifyEnvelope(groupEnvelope()), 'group-v1');
});

test('audit v1: metadata/JSON rusak masuk other, tidak dianggap aman', () => {
  assert.equal(classifyEnvelope(JSON.stringify({ event: 'group:metadata' })), 'other');
  assert.equal(classifyEnvelope('plain text'), 'other');
  assert.equal(classifyEnvelope('{not json'), 'other');
  assert.equal(classifyEnvelope(null), 'other');
  assert.equal(classifyEnvelope(''), 'other');
  assert.equal(classifyEnvelope('[]'), 'other');
});

test('audit v1: penghitung hanya menjumlahkan amplop legacy', () => {
  const counts = emptyEnvelopeCounts();
  addEnvelope(counts, 'direct-v2');
  addEnvelope(counts, 'direct-v1');
  addEnvelope(counts, 'group-v2');
  addEnvelope(counts, 'group-v1');
  addEnvelope(counts, 'other');

  assert.equal(counts.total, 5);
  assert.equal(counts['direct-v2'], 1);
  assert.equal(counts['group-v2'], 1);
  assert.equal(counts.other, 1);
  assert.equal(legacyEnvelopeCount(counts), 2);
});
