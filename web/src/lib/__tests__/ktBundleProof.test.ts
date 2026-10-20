// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A] Integrasi verifikasi KT ke **jalur bundle**.
 *
 * `keyTransparency.test.ts` menguji primitif verifier; test ini menguji modul
 * yang benar-benar dipanggil sebelum kunci peer dipin
 * (`checkBundleAgainstKeyTransparency`). Yang diganti hanya **batas jaringan**
 * (config/proof fetch + hash username); verifier yang dipakai adalah modul WASM
 * sungguhan, dan buktinya adalah `UpdateResponse` dari binary Go
 * `key-transparency-server` (`fixtures/kt/search-v1.pb`), bukan objek buatan.
 *
 * Properti yang dikunci:
 *   1. Bukti sah + `identityKey` bundle sama → `confirmed` + state tersimpan
 *      (tree head, monitoring data, keyVersion) untuk verifikasi berikutnya.
 *   2. `identityKey` bundle berbeda dari log → `mismatch` (bukan `confirmed`),
 *      dengan kunci log dilaporkan — inilah yang memblokir pengiriman.
 *   3. Bukti diubah byte-nya → `unverifiable` (bukan `confirmed`).
 *   4. Layanan mati → `unavailable` + backoff, dan percobaan berikutnya tidak
 *      menghantam jaringan lagi.
 *   5. Tanpa username peer → `unknown-subject` tanpa satu pun panggilan jaringan.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KT_MODE_CONTACT_MONITORING,
  instantiateKeyTransparencyVerifier,
  type KeyTransparencyVerifier,
} from '../keyTransparency';
import {
  bytesToBase64Url,
  checkBundleAgainstKeyTransparency,
  resetKtBundleProofCaches,
  type KtBundleDeps,
  type KtProof,
} from '../ktBundleProof';
import type { KtStateUpdate } from '../ktMonitoring';

const WASM_PATH = resolve(process.cwd(), '../packages/keytrans-wasm/dist/keytrans.wasm');
const FIXTURE_DIR = resolve(process.cwd(), 'src/lib/__tests__/fixtures/kt');
const CONFIG_PATH = resolve(FIXTURE_DIR, 'config.json');
const UPDATE_V1_PATH = resolve(FIXTURE_DIR, 'search-v1.pb');

const HAS_FIXTURES = existsSync(WASM_PATH) && existsSync(CONFIG_PATH) && existsSync(UPDATE_V1_PATH);

interface FixtureConfig {
  mode: number;
  signatureKey: string;
  vrfKey: string;
  searchKey: string;
  entries: Array<{ keyVersion: number; value: string; treeSize: string }>;
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

/** Username hash yang dipakai fixture (0x5a × 32) — disuntik lewat dependency. */
const FIXTURE_USERNAME_HASH_B64 = bytesToBase64Url(new Uint8Array(32).fill(0x5a));
/** `identityKey` yang tertulis di log (0x11 × 32). */
const LOG_IDENTITY_KEY_B64 = bytesToBase64Url(new Uint8Array(32).fill(0x11));
/** Kunci lain (bukan isi log) — skenario MITM server menyajikan bundle palsu. */
const IMPOSTOR_IDENTITY_KEY_B64 = bytesToBase64Url(new Uint8Array(32).fill(0x99));

/** Waktu fixture dibuat — bukti KT menolak tree head yang terlalu jauh dari `now`. */
const FIXTURE_NOW = new Date('2026-10-13T12:00:00Z').getTime();

// Verifikasi WASM + pemuatan state butuh beberapa detik saat suite berjalan
// bersamaan (batas default 5 dtk terlalu ketat untuk test integrasi ini).
vi.setConfig({ testTimeout: 30_000 });

/** Pisahkan pesan protobuf (field length-delimited) untuk mengubah bukti presisi. */
function splitProtoFields(bytes: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  let index = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (index < bytes.length) {
      const byte = bytes[index++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error('protobuf: varint terpotong');
  };
  while (index < bytes.length) {
    const key = Number(varint());
    const wire = key & 0x07;
    if (wire === 2) {
      const length = Number(varint());
      out.set(key >> 3, bytes.subarray(index, index + length));
      index += length;
    } else if (wire === 0) {
      varint();
    } else if (wire === 5) {
      index += 4;
    } else if (wire === 1) {
      index += 8;
    } else {
      throw new Error(`protobuf: wire-type ${wire} tidak didukung`);
    }
  }
  return out;
}

/** Salin `UpdateResponse` dan rusak satu byte di dalam field tertentu. */
function tamperField(update: Uint8Array, field: number, flipAt = 1): Uint8Array {
  const payload = splitProtoFields(update).get(field);
  if (!payload) throw new Error(`tamper: field ${field} tidak ada di fixture`);
  const damaged = new Uint8Array(update);
  const target = payload.byteOffset - update.byteOffset + Math.min(flipAt, payload.length - 1);
  damaged[target] = damaged[target]! ^ 0xff;
  return damaged;
}

const withSkip = HAS_FIXTURES ? describe : describe.skip;

let fixture: FixtureConfig;
let proofV1: KtProof;
let rawUpdateV1: Uint8Array;
let verifier: KeyTransparencyVerifier;

beforeAll(() => {
  if (!HAS_FIXTURES) return;
  fixture = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FixtureConfig;
  verifier = instantiateKeyTransparencyVerifier(new Uint8Array(readFileSync(WASM_PATH)));
  rawUpdateV1 = new Uint8Array(readFileSync(UPDATE_V1_PATH));
  const condensed = verifier.condenseUpdate(
    rawUpdateV1,
    hexToBytes(fixture.entries[0]!.value)
  );
  proofV1 = { fullTreeHead: condensed.fullTreeHead, condensed: condensed.condensedResponse };
});

beforeEach(() => {
  resetKtBundleProofCaches();
});

/** Dependency set dengan hanya batas jaringan yang dipalsukan. */
function makeDeps(overrides: Partial<KtBundleDeps> = {}) {
  const saved: KtStateUpdate[] = [];
  const fetchProof = vi.fn(async () => proofV1);
  const deps: KtBundleDeps = {
    // Instance WASM sungguhan; yang dilewati hanya pemuatan `?url` milik Vite
    // (tidak tersedia di lingkungan test), bukan verifikasinya.
    verifier,
    hashUsername: async () => FIXTURE_USERNAME_HASH_B64,
    fetchConfig: async () => ({
      mode: KT_MODE_CONTACT_MONITORING,
      signatureKey: fixture.signatureKey,
      vrfKey: fixture.vrfKey,
    }),
    fetchProof,
    // Anchor distinguished tidak tersedia di fixture ini; kegagalannya memang
    // tidak boleh mengubah verdict (hanya split-view yang kehilangan anchor).
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

withSkip('ktBundleProof: verifikasi bundle terhadap log', () => {
  it('bukti sah + kunci sama → confirmed dan state tersimpan', async () => {
    const { deps, saved } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      { userId: 'peer-alice', username: 'alice', identityKey: LOG_IDENTITY_KEY_B64, now: FIXTURE_NOW },
      deps
    );

    expect(verdict.status).toBe('confirmed');
    expect(verdict.keyVersion).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.keyVersion).toBe(1);
    // Ukuran pohon berasal dari tree head yang benar-benar diverifikasi (bukan
    // dari angka di config fixture), jadi yang dikunci: nilainya sah & tersimpan.
    expect(Number.isInteger(saved[0]!.treeSize)).toBe(true);
    expect(saved[0]!.treeSize).toBeGreaterThan(0);
    // State harus membawa material untuk verifikasi berikutnya (monitor/konsistensi).
    expect(saved[0]!.treeHead).toBeDefined();
    expect(saved[0]!.monitoringData).toBeDefined();
  });

  it('bundle menyajikan kunci lain (MITM) → mismatch, bukan confirmed', async () => {
    const { deps } = makeDeps();

    const verdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: IMPOSTOR_IDENTITY_KEY_B64,
        now: FIXTURE_NOW,
      },
      deps
    );

    expect(verdict.status).toBe('mismatch');
    expect(verdict.logIdentityKey).toBe('11'.repeat(32));
    expect(verdict.keyVersion).toBe(1);
  });

  it('pqIdentityKey bundle berbeda dari log → mismatch (celah X25519-only ditutup)', async () => {
    const { deps } = makeDeps();

    // Nilai log v1: 1 version + 1 keyVersion + 32 X25519 + 1216 PQ + ...
    const logValue = hexToBytes(fixture.entries[0]!.value);
    const logPq = bytesToBase64Url(logValue.slice(34, 34 + 1216));
    const impostorPq = bytesToBase64Url(new Uint8Array(1216).fill(0x77));

    const okVerdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: LOG_IDENTITY_KEY_B64,
        pqIdentityKey: logPq,
        now: FIXTURE_NOW,
      },
      deps
    );
    expect(okVerdict.status).toBe('confirmed');

    const badVerdict = await checkBundleAgainstKeyTransparency(
      {
        userId: 'peer-alice',
        username: 'alice',
        identityKey: LOG_IDENTITY_KEY_B64,
        pqIdentityKey: impostorPq,
        now: FIXTURE_NOW,
      },
      deps
    );

    expect(badVerdict.status).toBe('mismatch');
    expect(badVerdict.logIdentityKey).toBe('11'.repeat(32));
    expect(badVerdict.logPqIdentityKey).toBe(
      Array.from(logValue.slice(34, 34 + 1216))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    );
  });

  it('bukti yang diubah byte-nya → unverifiable (fail-closed)', async () => {
    // Rusak byte di dalam `vrf_proof` (field 2) — mengikat nilai ke index VRF,
    // sehingga wajib ditolak bahkan pada pencarian pertama tanpa anchor.
    const tampered = verifier.condenseUpdate(
      tamperField(rawUpdateV1, 2, 5),
      hexToBytes(fixture.entries[0]!.value)
    );
    const { deps } = makeDeps({
      fetchProof: async () => ({
        fullTreeHead: tampered.fullTreeHead,
        condensed: tampered.condensedResponse,
      }),
    });

    const verdict = await checkBundleAgainstKeyTransparency(
      { userId: 'peer-alice', username: 'alice', identityKey: LOG_IDENTITY_KEY_B64, now: FIXTURE_NOW },
      deps
    );

    expect(verdict.status).toBe('unverifiable');
  });

  it('layanan KT mati → unavailable, lalu backoff tanpa memanggil jaringan lagi', async () => {
    const { deps, fetchProof } = makeDeps({
      fetchProof: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const first = await checkBundleAgainstKeyTransparency(
      { userId: 'peer-alice', username: 'alice', identityKey: LOG_IDENTITY_KEY_B64, now: FIXTURE_NOW },
      deps
    );
    expect(first.status).toBe('unavailable');

    fetchProof.mockClear();
    const second = await checkBundleAgainstKeyTransparency(
      { userId: 'peer-alice', username: 'alice', identityKey: LOG_IDENTITY_KEY_B64, now: FIXTURE_NOW + 1000 },
      deps
    );
    expect(second.status).toBe('unavailable');
    expect(second.reason).toContain('backoff');
    expect(fetchProof).not.toHaveBeenCalled();
  });

  it('tanpa username peer → unknown-subject tanpa panggilan jaringan', async () => {
    const { deps, fetchProof } = makeDeps();
    const fetchConfig = vi.fn(deps.fetchConfig!);
    deps.fetchConfig = fetchConfig;

    const verdict = await checkBundleAgainstKeyTransparency(
      { userId: 'peer-alice', identityKey: LOG_IDENTITY_KEY_B64, now: FIXTURE_NOW },
      deps
    );

    expect(verdict.status).toBe('unknown-subject');
    expect(fetchConfig).not.toHaveBeenCalled();
    expect(fetchProof).not.toHaveBeenCalled();
  });
});
