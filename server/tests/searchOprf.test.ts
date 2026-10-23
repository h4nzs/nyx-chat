// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].
//
// [docs/35 Fase 4a] OPRF ristretto255-SHA512: blind/evaluate/finalize dan
// penurunan blind index 64-hex. Tidak ada kripto grup buatan sendiri.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_OPRF_SUITE,
  blindSearchIdentifier,
  deriveSearchOprfServerKeys,
  evaluateSearchOprfBlinded,
  finalizeSearchOprfIndex,
} from '@nyx/shared';
import {
  evaluateSearchOprf,
  isSearchOprfEnabled,
  searchOprfIndexForIdentifier,
} from '../src/utils/searchOprf.js';

function identifier(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

test('oprf: kunci server deterministik dari seed dan berbeda untuk seed lain', () => {
  const a = deriveSearchOprfServerKeys(identifier(7));
  const b = deriveSearchOprfServerKeys(identifier(7));
  const c = deriveSearchOprfServerKeys(identifier(8));
  assert.deepEqual(a.secretKey, b.secretKey);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.notDeepEqual(a.secretKey, c.secretKey);
  assert.equal(a.secretKey.length, 32);
  assert.equal(a.publicKey.length, 32);
});

test('oprf: blind -> evaluate -> finalize menghasilkan index 64-hex yang stabil', () => {
  const input = identifier(1);
  const first = blindSearchIdentifier(input);
  const second = blindSearchIdentifier(input);
  assert.equal(first.blinded.length, 32);
  assert.equal(second.blinded.length, 32);
  assert.notDeepEqual(first.blinded, second.blinded, 'blind baru harus berbeda');

  const firstIndex = finalizeSearchOprfIndex(
    first.input,
    first.blind,
    evaluateSearchOprf(first.blinded),
  );
  const secondIndex = finalizeSearchOprfIndex(
    second.input,
    second.blind,
    evaluateSearchOprf(second.blinded),
  );

  assert.match(firstIndex, /^[a-f0-9]{64}$/);
  assert.equal(firstIndex, secondIndex);
  assert.equal(SEARCH_OPRF_SUITE, 'ristretto255-SHA512');
});

test('oprf: identifier berbeda menghasilkan index berbeda', () => {
  const one = blindSearchIdentifier(identifier(1));
  const two = blindSearchIdentifier(identifier(2));
  const oneIndex = finalizeSearchOprfIndex(one.input, one.blind, evaluateSearchOprf(one.blinded));
  const twoIndex = finalizeSearchOprfIndex(two.input, two.blind, evaluateSearchOprf(two.blinded));
  assert.notEqual(oneIndex, twoIndex);
});

test('oprf: panjang elemen yang salah ditolak', () => {
  assert.throws(() => blindSearchIdentifier(new Uint8Array(31)));
  assert.throws(() => evaluateSearchOprfBlinded(identifier(1), new Uint8Array(31)));
  assert.throws(() => evaluateSearchOprf(new Uint8Array(31)));
});

test('oprf: gate PIR_OPRF_ENABLED hanya menerima 1/true', () => {
  const previous = process.env.PIR_OPRF_ENABLED;
  try {
    process.env.PIR_OPRF_ENABLED = '1';
    assert.equal(isSearchOprfEnabled(), true);
    process.env.PIR_OPRF_ENABLED = 'true';
    assert.equal(isSearchOprfEnabled(), true);
    process.env.PIR_OPRF_ENABLED = 'on';
    assert.equal(isSearchOprfEnabled(), false);
    delete process.env.PIR_OPRF_ENABLED;
    assert.equal(isSearchOprfEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.PIR_OPRF_ENABLED;
    else process.env.PIR_OPRF_ENABLED = previous;
  }
});

test('oprf: index server-side sama dengan blind/evaluate/finalize klien', () => {
  const previous = process.env.PIR_OPRF_ENABLED;
  try {
    process.env.PIR_OPRF_ENABLED = '1';
    const raw = identifier(9);
    const encoded = Buffer.from(raw).toString('base64url');
    const client = blindSearchIdentifier(raw);
    const expected = finalizeSearchOprfIndex(
      client.input,
      client.blind,
      evaluateSearchOprf(client.blinded),
    );

    assert.equal(searchOprfIndexForIdentifier(encoded), expected);
    assert.equal(searchOprfIndexForIdentifier('bukan-base64url'), null);
    assert.equal(searchOprfIndexForIdentifier(Buffer.from([1, 2, 3]).toString('base64url')), null);
  } finally {
    if (previous === undefined) delete process.env.PIR_OPRF_ENABLED;
    else process.env.PIR_OPRF_ENABLED = previous;
  }
});

test('oprf: helper index tidak menghitung saat gate mati', () => {
  const previous = process.env.PIR_OPRF_ENABLED;
  try {
    delete process.env.PIR_OPRF_ENABLED;
    const encoded = Buffer.from(identifier(9)).toString('base64url');
    assert.equal(searchOprfIndexForIdentifier(encoded), null);
  } finally {
    if (previous !== undefined) process.env.PIR_OPRF_ENABLED = previous;
  }
});
