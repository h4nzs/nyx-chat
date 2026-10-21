// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.7 Fase 7] Verifier Key Transparency v2 (WASM) terhadap fixture
 * yang dihasilkan log Go v2 (`server/kt-query/cmd/kt-v2-fixtures`).
 *
 * Ini pasangan JS dari oracle Rust (`packages/keytrans-v2/tests/v2_fixtures.rs`):
 * bukti yang sama harus diterima oleh modul WASM yang benar-benar dikirim ke
 * browser. Kunci yang salah dan bukti yang dimodifikasi harus ditolak.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  KT_MODE_THIRD_PARTY_AUDITING,
  instantiateKeyTransparencyVerifier,
  type KeyTransparencyVerifier,
  type KtConfig,
} from '../keyTransparencyV2';

const WASM_PATH = resolve(process.cwd(), '../packages/keytrans-wasm-v2/dist/keytrans-v2.wasm');
const FIXTURE_DIR = resolve(process.cwd(), '../packages/keytrans-wasm-v2/testdata');

interface Fixture {
  config: KtConfig;
  searchKey: Uint8Array;
  value: Uint8Array;
  condensedResponse: Uint8Array;
  fullTreeHead: Uint8Array;
  now: Date;
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

function loadFixture(name: string): Fixture {
  const raw = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, `${name}.bin`)));
  const json = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.bin.json`), 'utf8')) as {
    mode: number;
    signatureKey: string;
    auditorKeys: string[];
    searchKey: string;
    value: string;
    verifyNowMs: number;
  };

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headLength = view.getUint32(0, false);
  const fullTreeHead = raw.subarray(4, 4 + headLength);
  const offset = 4 + headLength;
  const condensedLength = view.getUint32(offset, false);
  const condensedResponse = raw.subarray(offset + 4, offset + 4 + condensedLength);

  return {
    config: {
      mode: json.mode as KtConfig['mode'],
      signatureKey: fromHex(json.signatureKey),
      auditorKeys: json.auditorKeys.map(fromHex),
    },
    searchKey: fromHex(json.searchKey),
    value: fromHex(json.value),
    condensedResponse,
    fullTreeHead,
    now: new Date(json.verifyNowMs),
  };
}

const HAS_WASM = existsSync(WASM_PATH);
const HAS_FIXTURES = existsSync(resolve(FIXTURE_DIR, 'search-first.bin'));
const withSkip = HAS_WASM && HAS_FIXTURES ? describe : describe.skip;

let verifier: KeyTransparencyVerifier;

withSkip('Key Transparency v2 (WASM)', () => {
  beforeAll(async () => {
    verifier = await instantiateKeyTransparencyVerifier(
      new Uint8Array(readFileSync(WASM_PATH))
    );
  });

  it('verifies a search proof produced by the Go v2 log', () => {
    const fixture = loadFixture('search-first');
    const result = verifier.verifySearch({
      config: fixture.config,
      searchKey: fixture.searchKey,
      condensedResponse: fixture.condensedResponse,
      fullTreeHead: fixture.fullTreeHead,
      now: fixture.now,
    });
    expect(result.value).toEqual(fixture.value);
    expect(result.treeHead.length).toBeGreaterThan(0);
  });

  it('verifies a consistency proof against the stored anchor', () => {
    const first = loadFixture('search-first');
    const anchored = loadFixture('search-anchored');

    const firstResult = verifier.verifySearch({
      config: first.config,
      searchKey: first.searchKey,
      condensedResponse: first.condensedResponse,
      fullTreeHead: first.fullTreeHead,
      now: first.now,
    });

    const result = verifier.verifySearch({
      config: anchored.config,
      searchKey: anchored.searchKey,
      condensedResponse: anchored.condensedResponse,
      fullTreeHead: anchored.fullTreeHead,
      context: { lastTreeHead: firstResult.treeHead },
      now: anchored.now,
    });
    expect(result.value).toEqual(anchored.value);
  });

  it('verifies the third-party auditor head', () => {
    const fixture = loadFixture('search-audited');
    expect(fixture.config.mode).toBe(KT_MODE_THIRD_PARTY_AUDITING);
    const result = verifier.verifySearch({
      config: fixture.config,
      searchKey: fixture.searchKey,
      condensedResponse: fixture.condensedResponse,
      fullTreeHead: fixture.fullTreeHead,
      now: fixture.now,
    });
    expect(result.value).toEqual(fixture.value);
  });

  it('rejects a wrong log key', () => {
    const fixture = loadFixture('search-audited');
    const wrongKey = fixture.config.signatureKey.slice();
    wrongKey[0]! ^= 0xff;
    expect(() =>
      verifier.verifySearch({
        config: { ...fixture.config, signatureKey: wrongKey },
        searchKey: fixture.searchKey,
        condensedResponse: fixture.condensedResponse,
        fullTreeHead: fixture.fullTreeHead,
        now: fixture.now,
      })
    ).toThrow();
  });
});
