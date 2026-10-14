// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/34] Generator fixture verifier Key Transparency.
 *
 * Menjalankan **binary Go `key-transparency-server` yang sesungguhnya**, menulis
 * dua entri NYX ke log lewat test-update service (`return_update_response = true`),
 * lalu menyimpan bukti yang dikembalikan server apa adanya sebagai fixture:
 *
 *   - `config.json`        — kunci publik log (turunan seed di config kt-server) + entri
 *   - `search-v1.pb`       — `UpdateResponse` nyata untuk keyVersion 1
 *   - `search-v2.pb`       — `UpdateResponse` nyata untuk rotasi kunci (keyVersion 2)
 *
 * Fixture inilah yang diverifikasi test klien (`web/src/lib/__tests__/keyTransparency.test.ts`)
 * memakai modul WASM `packages/keytrans-wasm/dist/keytrans.wasm` — jadi gate
 * "interop nyata" diuji tanpa butuh server hidup di CI.
 *
 * Pemakaian:
 *   KT_SERVER_URL=http://127.0.0.1:8081 \
 *   KT_CONFIG_FILE=/tmp/nyx-kt-run/test_config.yaml \
 *   pnpm --filter nyx-server exec tsx scripts/kt-fixtures.ts
 */

import { createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  buildKtLogEntry,
  createGrpcKtTransport,
  encodeKtUpdateRequest,
  summarizeKtUpdateResponse,
} from '../src/utils/keyTransparency.js';

const KT_SERVER_URL = process.env.KT_SERVER_URL ?? 'http://127.0.0.1:8081';
const KT_CONFIG_FILE = process.env.KT_CONFIG_FILE ?? '/tmp/nyx-kt-run/test_config.yaml';
const OUT_DIR = resolve(process.cwd(), '../web/src/lib/__tests__/fixtures/kt');

/** Nilai deterministik supaya fixture bisa direview manusia. */
const USERNAME_HASH = new Uint8Array(32).fill(0x5a);
const IDENTITY_KEY = new Uint8Array(32).fill(0x11);
const ROTATED_IDENTITY_KEY = new Uint8Array(32).fill(0x44);
const PQ_KEY = new Uint8Array(1216).fill(0x22);
const SIGNING_KEY = new Uint8Array(32).fill(0x33);
const UPDATED_AT_DAY = 20_145;

/** Kunci publik ed25519 (32 byte) dari seed 32 byte — PKCS8 minimal + SPKI. */
function ed25519PublicKeyFromSeed(seedHex: string): Uint8Array {
  const seed = Buffer.from(seedHex.trim(), 'hex');
  if (seed.length !== 32) throw new Error(`seed ed25519 harus 32 byte, dapat ${seed.length}`);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPublicKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = key.export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Ambil `signing-key`/`vrf-key` dari YAML config kt-server (blok `api:`). */
function readApiKeys(configPath: string): { signingKey: Uint8Array; vrfKey: Uint8Array } {
  const yaml = readFileSync(configPath, 'utf8');
  const signingSeed = /^\s*signing-key:\s*([0-9a-fA-F]+)\s*$/m.exec(yaml)?.[1];
  const vrfSeed = /^\s*vrf-key:\s*([0-9a-fA-F]+)\s*$/m.exec(yaml)?.[1];
  if (!signingSeed || !vrfSeed) {
    throw new Error(`config KT ${configPath} tidak memuat api.signing-key/api.vrf-key`);
  }
  return { signingKey: ed25519PublicKeyFromSeed(signingSeed), vrfKey: ed25519PublicKeyFromSeed(vrfSeed) };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main(): Promise<void> {
  const { signingKey, vrfKey } = readApiKeys(KT_CONFIG_FILE);
  const transport = createGrpcKtTransport({ endpoint: KT_SERVER_URL, timeoutMs: 10_000 });

  const write = async (identityKey: Uint8Array, keyVersion: number) => {
    const entry = buildKtLogEntry({
      usernameHash: Buffer.from(USERNAME_HASH).toString('base64url'),
      identityKey,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
      keyVersion,
      updatedAtDay: UPDATED_AT_DAY,
    });
    const response = await transport.update(
      encodeKtUpdateRequest({ searchKey: entry.searchKey, value: entry.value, returnUpdateResponse: true })
    );
    const summary = summarizeKtUpdateResponse(response);
    return { entry, response, summary };
  };

  const v1 = await write(IDENTITY_KEY, 1);
  const v2 = await write(ROTATED_IDENTITY_KEY, 2);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'search-v1.pb'), Buffer.from(v1.response));
  writeFileSync(resolve(OUT_DIR, 'search-v2.pb'), Buffer.from(v2.response));
  writeFileSync(
    resolve(OUT_DIR, 'config.json'),
    `${JSON.stringify(
      {
        // Mode 1 = ContactMonitoring (tanpa auditor pihak ketiga), sama dengan
        // deployment NYX saat ini.
        mode: 1,
        signatureKey: hex(signingKey),
        vrfKey: hex(vrfKey),
        searchKey: hex(v1.entry.searchKey),
        entries: [
          { keyVersion: 1, value: hex(v1.entry.value), treeSize: String(v1.summary.treeSize ?? '') },
          { keyVersion: 2, value: hex(v2.entry.value), treeSize: String(v2.summary.treeSize ?? '') },
        ],
        generatedFrom: 'cmd/kt-server (test-update service, return_update_response=true)',
      },
      null,
      2
    )}\n`
  );

  console.log(`v1: tree=${v1.summary.treeSize} vrf=${v1.summary.vrfProofLength}B proof=${v1.summary.hasUpdateProof}`);
  console.log(`v2: tree=${v2.summary.treeSize} vrf=${v2.summary.vrfProofLength}B proof=${v2.summary.hasUpdateProof}`);
  console.log(`fixture ditulis ke ${dirname(resolve(OUT_DIR, 'config.json'))}`);
}

main().catch((error: unknown) => {
  console.error('[kt-fixtures] gagal:', error);
  process.exitCode = 1;
});
