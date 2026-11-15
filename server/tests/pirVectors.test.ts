// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP8] Vektor lintas-implementasi XOR-PIR.
 *
 * Fixture `fixtures/pirVectors.json` dihitung sekali dari kontrak
 * `packages/shared/src/pir.ts`; `server/pir-sidecar/src/pir.rs` membaca fixture
 * YANG SAMA dan harus menghasilkan `answerQ1Sha256`/`answerQ2Sha256` identik.
 * Kalau salah satu implementasi bergeser urutan bit, XOR, atau padding, salah
 * satu sisi gagal — itu tujuan vektornya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  decodePirRecord,
  encodePirRecord,
  pirDbRoot,
  pirRecordCandidates,
  pirShareToggle,
  pirXor,
} from '@nyx/shared';

interface PirVectorFixture {
  suite: string;
  slotCount: number;
  recordBytes: number;
  oprfIndexHex: string;
  shareHex: string;
  q2Hex: string;
  candidates: number[];
  answerQ1Sha256: string;
  answerQ2Sha256: string;
  recordSha256: string;
  dbRoot: string;
  bodyBase64url: string;
  tamperedRecordSha256: string;
}

const fixture: PirVectorFixture = JSON.parse(
  readFileSync(new URL('./fixtures/pirVectors.json', import.meta.url), 'utf8'),
);

const hexToBytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Salinan independen dari `pir.rs::answer` (LSB-first, bit di luar S diabaikan). */
function answer(slots: Uint8Array, slotCount: number, recordBytes: number, share: Uint8Array): Uint8Array {
  const out = new Uint8Array(recordBytes);
  for (let slot = 0; slot < slotCount; slot += 1) {
    if ((share[slot >> 3]! >> (slot & 7)) & 1) {
      const offset = slot * recordBytes;
      for (let b = 0; b < recordBytes; b += 1) out[b]! ^= slots[offset + b]!;
    }
  }
  return out;
}

function buildSlots(): Uint8Array {
  const { slotCount, recordBytes, oprfIndexHex, bodyBase64url, candidates } = fixture;
  const encoded = encodePirRecord({
    oprfIndex: hexToBytes(oprfIndexHex),
    body: new Uint8Array(Buffer.from(bodyBase64url, 'base64url')),
    recordBytes,
  });
  const slots = new Uint8Array(slotCount * recordBytes);
  for (let slot = 0; slot < slotCount; slot += 1) {
    const offset = slot * recordBytes;
    for (let b = 0; b < recordBytes; b += 1) slots[offset + b] = (slot * 31 + b * 7) & 0xff;
  }
  slots.set(encoded, candidates[0]! * recordBytes);
  return slots;
}

test('vektor XOR-PIR menghasilkan jawaban dan record yang sama dengan fixture', () => {
  const { slotCount, recordBytes, shareHex, q2Hex, candidates } = fixture;
  const slots = buildSlots();

  const a1 = answer(slots, slotCount, recordBytes, hexToBytes(shareHex));
  const a2 = answer(slots, slotCount, recordBytes, hexToBytes(q2Hex));
  assert.equal(sha256(a1), fixture.answerQ1Sha256, 'jawaban share pertama bergeser');
  assert.equal(sha256(a2), fixture.answerQ2Sha256, 'jawaban share kedua bergeser');

  const record = pirXor(a1, a2);
  assert.equal(sha256(record), fixture.recordSha256);
  assert.equal(
    Buffer.compare(Buffer.from(record), Buffer.from(encodePirRecord({
      oprfIndex: hexToBytes(fixture.oprfIndexHex),
      body: new Uint8Array(Buffer.from(fixture.bodyBase64url, 'base64url')),
      recordBytes,
    }))),
    0,
    'XOR dua share harus mengembalikan record yang di-encode',
  );
});

test('q2 = q1 XOR e_i hanya pada slot kandidat pertama', () => {
  const q1 = Uint8Array.from(hexToBytes(fixture.shareHex));
  const q2 = Uint8Array.from(hexToBytes(fixture.q2Hex));
  pirShareToggle(q1, fixture.candidates[0]!);
  assert.deepEqual(Buffer.from(q1), Buffer.from(q2));
});

test('record yang dipulihkan lolos decode, versi/body/candidates cocok', () => {
  const slots = buildSlots();
  const a1 = answer(slots, fixture.slotCount, fixture.recordBytes, hexToBytes(fixture.shareHex));
  const a2 = answer(slots, fixture.slotCount, fixture.recordBytes, hexToBytes(fixture.q2Hex));
  const decoded = decodePirRecord(pirXor(a1, a2), hexToBytes(fixture.oprfIndexHex));
  assert.equal(decoded.status, 'ok');
  if (decoded.status === 'ok') {
    assert.equal(
      Buffer.from(decoded.body).toString('base64url'),
      fixture.bodyBase64url,
      'body record berubah',
    );
  }

  const candidates = pirRecordCandidates(hexToBytes(fixture.oprfIndexHex), fixture.slotCount);
  assert.deepEqual(candidates, fixture.candidates);
  assert.equal(new Set(candidates).size, 3);
});

test('satu byte rusak ditolak sebagai tamper, bukan "tidak ditemukan"', () => {
  const slots = buildSlots();
  const a1 = answer(slots, fixture.slotCount, fixture.recordBytes, hexToBytes(fixture.shareHex));
  const a2 = answer(slots, fixture.slotCount, fixture.recordBytes, hexToBytes(fixture.q2Hex));
  const record = pirXor(a1, a2);
  record[40]! ^= 0x01;
  assert.equal(sha256(record), fixture.tamperedRecordSha256, 'pola tamper fixture bergeser');
  assert.throws(() => decodePirRecord(record, hexToBytes(fixture.oprfIndexHex)), /checksum/i);
});

test('dbRoot fixture dapat dihitung ulang dari slot', () => {
  const slots = buildSlots();
  const arrays: Uint8Array[] = [];
  for (let slot = 0; slot < fixture.slotCount; slot += 1) {
    arrays.push(slots.subarray(slot * fixture.recordBytes, (slot + 1) * fixture.recordBytes));
  }
  assert.equal(pirDbRoot(arrays, fixture.recordBytes), fixture.dbRoot);
});
