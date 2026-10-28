// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.7 Fase 7] Jalur bundle terhadap log KT **v2**.
 *
 * `ktBundleProof` memilih ABI verifier dari `GET /api/keys/kt/config`
 * (`abiVersion`), lalu memakai bukti yang sama bentuknya dari layanan v2.
 * Test ini memakai fixture Go v2 sungguhan (`cmd/kt-v2-fixtures`) dan modul
 * WASM v2, bukan verifier tiruan:
 *
 *   1. Bukti v2 sah → `confirmed`, state tersimpan, pin ABI 2 ditulis.
 *   2. Kunci bundle berbeda dari log v2 → `mismatch`.
 *   3. Pin ABI 1 lama boleh naik ke ABI 2 **hanya setelah** bukti v2 sah.
 *   4. Bukti v2 yang ditolak tidak mengganti pin (fail-closed).
 *   5. Downgrade ABI 2 → ABI 1 ditolak (`unverifiable`, tanpa panggilan bukti).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pinStore = vi.hoisted(() => ({ current: undefined as unknown }));

// Pin disimpan di modul terpisah; yang dipalsukan hanya penyimpanannya supaya
// test tidak bergantung pada masterSeed/IndexedDB (modul asli menelan error tulis
// saat vault terkunci, jadi pin tidak akan pernah terlihat).
vi.mock('../ktConfigPin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ktConfigPin')>();
  return {
    ...actual,
    loadKtConfigPin: async () => pinStore.current,
    saveKtConfigPin: async (pin: unknown) => {
      pinStore.current = pin;
    },
    clearKtConfigPin: async () => {
      pinStore.current = undefined;
    },
  };
});

import {
  bytesToBase64Url,
  checkBundleAgainstKeyTransparency,
  resetKtBundleProofCaches,
  type KtBundleDeps,
  type KtProof,
  type KtRemoteConfig,
} from '../ktBundleProof';
import { parseKtConfigPin, type KtConfigPin } from '../ktConfigPin';
import {
  instantiateKeyTransparencyVerifier,
  type KeyTransparencyVerifier,
} from '../keyTransparencyV2';
import type { KtStateUpdate } from '../ktMonitoring';

const WASM_PATH = resolve(process.cwd(), '../packages/keytrans-wasm-v2/dist/keytrans-v2.wasm');
const FIXTURE_DIR = resolve(process.cwd(), '../packages/keytrans-wasm-v2/testdata');
const FIRST_JSON = resolve(FIXTURE_DIR, 'search-first.bin.json');
const FIRST_BIN = resolve(FIXTURE_DIR, 'search-first.bin');

const HAS_FIXTURES = existsSync(WASM_PATH) && existsSync(FIRST_JSON) && existsSync(FIRST_BIN);

vi.setConfig({ testTimeout: 30_000 });

interface FixtureJson {
  mode: number;
  signatureKey: string;
  auditorKeys: string[];
  searchKey: string;
  value: string;
  treeSize: number;
  verifyNowMs: number;
}

interface Fixture {
  json: FixtureJson;
  value: Uint8Array;
  proof: KtProof;
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

function loadFixture(name: string): Fixture {
  const json = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.bin.json`), 'utf8')) as FixtureJson;
  const raw = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, `${name}.bin`)));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headLength = view.getUint32(0, false);
  const fullTreeHead = raw.subarray(4, 4 + headLength);
  const offset = 4 + headLength;
  const condensedLength = view.getUint32(offset, false);
  const condensed = raw.subarray(offset + 4, offset + 4 + condensedLength);
  return {
    json,
    value: fromHex(json.value),
    proof: { fullTreeHead, condensed },
  };
}

const configOf = (json: FixtureJson): KtRemoteConfig => ({
  abiVersion: 2,
  mode: json.mode,
  signatureKey: json.signatureKey,
  auditorKeys: json.auditorKeys,
  valueFormat: 'nyx-kt-value-v2',
});

/** Pin ABI 1 sintetis (Ed25519 32 B + ECVRF 32 B). */
const LEGACY_PIN: KtConfigPin = parseKtConfigPin({
  abiVersion: 1,
  mode: 1,
  signatureKey: 'e'.repeat(64),
  vrfKey: 'f'.repeat(64),
})!;

const withSkip = HAS_FIXTURES ? describe : describe.skip;

withSkip('ktBundleProof v2: verifikasi bundle terhadap log ML-DSA', () => {
  let verifier: KeyTransparencyVerifier;
  let fixture: Fixture;

  beforeAll(() => {
    verifier = instantiateKeyTransparencyVerifier(new Uint8Array(readFileSync(WASM_PATH)));
    fixture = loadFixture('search-first');
  });

  beforeEach(() => {
    resetKtBundleProofCaches();
    pinStore.current = undefined;
  });

  function makeDeps(overrides: Partial<KtBundleDeps> = {}) {
    const saved: KtStateUpdate[] = [];
    const fetchProof = vi.fn(async () => fixture.proof);
    const deps: KtBundleDeps = {
      verifier,
      // `0xa1 × 32` adalah usernameHash fixture; search key log = 0x75 || hash.
      hashUsername: async () => bytesToBase64Url(new Uint8Array(32).fill(0xa1)),
      fetchConfig: async () => configOf(fixture.json),
      fetchProof,
      fetchAnchor: async () => {
        throw new Error('anchor tidak diuji di sini');
      },
      fetchHead: async () => ({ root: 'ab'.repeat(32), treeSize: 64 }),
      loadStates: async () => [],
      saveState: async (state) => {
        saved.push(state);
      },
      log: () => {},
      ...overrides,
    };
    return { deps, saved, fetchProof };
  }

  const logIdentityKey = (): string => bytesToBase64Url(fixture.value.slice(2, 34));

  it('bukti v2 sah → confirmed, state tersimpan, pin ABI 2 ditulis', async () => {
    const { deps, saved } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        now: fixture.json.verifyNowMs,
      },
      deps
    );

    expect(verdict.status).toBe('confirmed');
    expect(verdict.keyVersion).toBe(2);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.treeSize).toBeGreaterThan(0);

    const pin = pinStore.current as KtConfigPin;
    expect(pin.abiVersion).toBe(2);
    expect(pin.signatureKey).toBe(fixture.json.signatureKey);
    expect(pin.vrfKey).toBeUndefined();
  });

  it('kunci bundle berbeda dari log v2 → mismatch', async () => {
    const { deps } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: bytesToBase64Url(new Uint8Array(32).fill(0x99)),
        now: fixture.json.verifyNowMs,
      },
      deps
    );

    expect(verdict.status).toBe('mismatch');
    expect(verdict.logIdentityKey).toBe('02'.repeat(32));
    expect(verdict.keyVersion).toBe(2);
  });

  it('config ABI 1 (layanan baca v1) ditolak sebagai unavailable, bukan diverifikasi', async () => {
    const { deps } = makeDeps({
      // Bentuk config yang dilayani `nyx-kt-query` v1: Ed25519 + VRF, tanpa
      // `abiVersion` dan `valueFormat`.
      fetchConfig: async () => ({ mode: 1, signatureKey: 'e'.repeat(64), vrfKey: 'f'.repeat(64) }),
    });

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        now: fixture.json.verifyNowMs,
      },
      deps
    );

    expect(verdict.status).toBe('unavailable');
    expect(verdict.reason).toContain('sudah dipensiunkan');
    // Config lama tidak boleh menghasilkan pin apa pun.
    expect(pinStore.current).toBeUndefined();
  });

  it('pin ABI 1 lama naik ke ABI 2 setelah bukti v2 sah', async () => {
    pinStore.current = LEGACY_PIN;
    const { deps } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        now: fixture.json.verifyNowMs,
      },
      deps
    );

    expect(verdict.status).toBe('confirmed');
    const pin = pinStore.current as KtConfigPin;
    expect(pin.abiVersion).toBe(2);
    expect(pin.signatureKey).toBe(fixture.json.signatureKey);
  });

  it('bukti v2 yang ditolak tidak mengganti pin ABI 1 (fail-closed)', async () => {
    pinStore.current = LEGACY_PIN;
    const { deps } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        // Di luar jendela timestamp (±24 jam) → verifier menolak tree head,
        // walau kunci log sendiri sah. Pin lama tidak boleh tergantikan.
        now: fixture.json.verifyNowMs + 2 * 24 * 60 * 60 * 1000,
      },
      deps
    );

    expect(verdict.status).toBe('unverifiable');
    expect((pinStore.current as KtConfigPin).abiVersion).toBe(1);
  });

  it('downgrade ABI 2 → ABI 1 ditolak tanpa mengambil bukti', async () => {
    const first = makeDeps();
    await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        now: fixture.json.verifyNowMs,
      },
      first.deps
    );
    expect((pinStore.current as KtConfigPin).abiVersion).toBe(2);

    resetKtBundleProofCaches();
    const { deps, fetchProof } = makeDeps({
      fetchConfig: async () => ({
        mode: 1,
        signatureKey: 'e'.repeat(64),
        vrfKey: 'f'.repeat(64),
        valueFormat: 'nyx-kt-value-v1',
      }),
    });

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: logIdentityKey(),
        now: fixture.json.verifyNowMs,
      },
      deps
    );

    expect(verdict.status).toBe('unverifiable');
    expect(fetchProof).not.toHaveBeenCalled();
    expect((pinStore.current as KtConfigPin).abiVersion).toBe(2);
  });
});
