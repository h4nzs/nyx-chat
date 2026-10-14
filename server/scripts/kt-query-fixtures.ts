// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/34] Generator fixture **sisi baca** Key Transparency.
 *
 * Beda dengan `kt-fixtures.ts` (yang menyimpan `UpdateResponse` apa adanya),
 * script ini menempuh jalur produksi yang sesungguhnya:
 *
 *   1. menulis entri NYX lewat penulis log NYX (`buildKtLogEntry` +
 *      `encodeKtUpdateRequest`, gRPC test-update) — protokol yang dipakai
 *      `/register` dan `/recover`;
 *   2. membaca bukti dari HTTP `nyx-kt-query` (`GET /config`, `GET /search`)
 *      — layanan baca NYX, bukan query service upstream (yang menolak nilai
 *      format NYX, docs/32 §32.8);
 *   3. menyimpan byte **apa adanya** sebagai fixture, termasuk framing
 *      `u32 len || FullTreeHead || u32 len || CondensedTreeSearchResponse`.
 *
 * Fixture inilah yang diverifikasi modul WASM di
 * `web/src/lib/__tests__/keyTransparency.test.ts` → membuktikan bahwa bukti yang
 * dihasilkan layanan NYX bisa diverifikasi verifier libsignal yang sebenarnya.
 *
 * Pemakaian (adapter harus sudah jalan sebagai pemilik tunggal basis data):
 *   KT_CONFIG_FILE=/tmp/nyx-kt-query/test_config.yaml \
 *   KT_QUERY_URL=http://127.0.0.1:8085 \
 *   KT_SERVER_URL=http://127.0.0.1:8081 \
 *   pnpm --filter nyx-server exec tsx scripts/kt-query-fixtures.ts
 */

import { createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildKtLogEntry,
  createGrpcKtTransport,
  encodeKtUpdateRequest,
  summarizeKtUpdateResponse,
} from '../src/utils/keyTransparency.js';

const KT_QUERY_URL = process.env.KT_QUERY_URL ?? 'http://127.0.0.1:8085';
const KT_SERVER_URL = process.env.KT_SERVER_URL ?? 'http://127.0.0.1:8081';
const KT_CONFIG_FILE = process.env.KT_CONFIG_FILE ?? '/tmp/nyx-kt-query/test_config.yaml';
const OUT_DIR = resolve(process.cwd(), '../web/src/lib/__tests__/fixtures/kt');

/** Nilai deterministik supaya fixture bisa direview manusia. */
const USERNAME_HASH = new Uint8Array(32).fill(0x5a);
const IDENTITY_KEY = new Uint8Array(32).fill(0x11);
const ROTATED_IDENTITY_KEY = new Uint8Array(32).fill(0x44);
const PQ_KEY = new Uint8Array(1216).fill(0x22);
const SIGNING_KEY = new Uint8Array(32).fill(0x33);
const UPDATED_AT_DAY = 20_145;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * Baca `FullTreeHead.tree_head.tree_size` dari byte mentah. Klien melakukan ini
 * lewat WASM (`StoredTreeHead`), dan nilai inilah yang harus dikirim sebagai
 * `last` pada permintaan berikutnya supaya server menyertakan bukti konsistensi.
 */
function treeSizeFromFullTreeHead(framed: Uint8Array): number {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const treeHeadLength = view.getUint32(0, false);
  const fullTreeHead = framed.subarray(4, 4 + treeHeadLength);

  let index = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    while (index < fullTreeHead.length) {
      const byte = fullTreeHead[index++]!;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    throw new Error('protobuf: varint terpotong');
  };

  while (index < fullTreeHead.length) {
    const key = varint();
    const wire = key & 0x07;
    if (wire === 2) {
      const length = varint();
      if (key >> 3 === 1) {
        // TreeHead → field 1 = tree_size (varint)
        const sub = fullTreeHead.subarray(index, index + length);
        const subKey = sub[0]!;
        if (subKey >> 3 !== 1 || (subKey & 0x07) !== 0) {
          throw new Error('tree head tidak diawali tree_size');
        }
        let subIndex = 1;
        let size = 0;
        let shift = 0;
        while (subIndex < sub.length) {
          const byte = sub[subIndex++]!;
          size |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) return size >>> 0;
          shift += 7;
        }
        throw new Error('tree_size terpotong');
      }
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
  throw new Error('FullTreeHead tanpa tree_head');
}

/** Kunci publik ed25519 (32 byte) dari seed 32 byte — dipakai hanya untuk review. */
function ed25519PublicKeyFromSeed(seedHex: string): Uint8Array {
  const seed = Buffer.from(seedHex.trim(), 'hex');
  if (seed.length !== 32) throw new Error(`seed ed25519 harus 32 byte, dapat ${seed.length}`);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPublicKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = key.export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

function readApiKeys(configPath: string): { signingKey: Uint8Array; vrfKey: Uint8Array } {
  const yaml = readFileSync(configPath, 'utf8');
  const signingSeed = /^\s*signing-key:\s*([0-9a-fA-F]+)\s*$/m.exec(yaml)?.[1];
  const vrfSeed = /^\s*vrf-key:\s*([0-9a-fA-F]+)\s*$/m.exec(yaml)?.[1];
  if (!signingSeed || !vrfSeed) {
    throw new Error(`config KT ${configPath} tidak memuat api.signing-key/api.vrf-key`);
  }
  return { signingKey: ed25519PublicKeyFromSeed(signingSeed), vrfKey: ed25519PublicKeyFromSeed(vrfSeed) };
}

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
    return { entry, summary: summarizeKtUpdateResponse(response) };
  };

  const fetchFramed = async (query: string): Promise<Uint8Array> => {
    const response = await fetch(`${KT_QUERY_URL}${query}`);
    if (!response.ok) {
      throw new Error(`GET ${query} → HTTP ${response.status}: ${await response.text()}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  // 1) Kunci publik log — sumber kebenaran untuk `KtConfig` klien.
  const configResponse = await fetch(`${KT_QUERY_URL}/config`);
  if (!configResponse.ok) {
    throw new Error(`GET /config → HTTP ${configResponse.status}`);
  }
  const publicConfig = (await configResponse.json()) as {
    mode: number;
    signatureKey: string;
    vrfKey: string;
    auditorKeys: string[];
    searchKeyPrefix: string;
  };

  const usernameHash = Buffer.from(USERNAME_HASH).toString('base64url');

  // 2) keyVersion 1 → baca bukti (tanpa anchor: ini pencarian pertama klien).
  const v1 = await write(IDENTITY_KEY, 1);
  const queryV1 = await fetchFramed(`/search?hash=${encodeURIComponent(usernameHash)}`);

  // 3) Rotasi kunci (keyVersion 2). Permintaan kedua mengirim ukuran pohon yang
  //    sudah dilihat klien (`last`) — persis yang dilakukan klien: tanpa itu
  //    server tidak menyalakan bukti konsistensi, dan verifikasi dengan anchor
  //    gagal sebagai "Malformed proof" (temuan saat pertama kali menjalankan ini).
  const v2 = await write(ROTATED_IDENTITY_KEY, 2);
  const anchorSize = treeSizeFromFullTreeHead(queryV1);
  const queryV2 = await fetchFramed(
    `/search?hash=${encodeURIComponent(usernameHash)}&last=${anchorSize}`
  );

  // 4) Bukti `distinguished` — anchor yang dipakai klien sebelum mengenal kontak.
  const distinguished = await fetchFramed('/distinguished');

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'query-v1.pb'), Buffer.from(queryV1));
  writeFileSync(resolve(OUT_DIR, 'query-v2.pb'), Buffer.from(queryV2));
  writeFileSync(resolve(OUT_DIR, 'query-distinguished.pb'), Buffer.from(distinguished));
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
        // Ditulis oleh layanan baca NYX (`nyx-kt-query`), bukan query service
        // upstream: nilai log NYX ditolak oleh yang terakhir (docs/32 §32.8).
        query: {
          source: 'server/kt-query (GET /search, GET /distinguished)',
          keyPrefix: publicConfig.searchKeyPrefix,
          mode: publicConfig.mode,
          usernameHash,
        },
        generatedFrom: 'cmd/kt-server test-update protocol → nyx-kt-query read API',
      },
      null,
      2
    )}\n`
  );

  const frameSummary = (bytes: Uint8Array) => `${bytes.length}B (${bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false) : 0}B tree head)`;
  console.log(`v1: tree=${v1.summary.treeSize} vrf=${v1.summary.vrfProofLength}B proof=${v1.summary.hasUpdateProof} query=${frameSummary(queryV1)}`);
  console.log(`v2: tree=${v2.summary.treeSize} query=${frameSummary(queryV2)}`);
  console.log(`distinguished: ${frameSummary(distinguished)}`);
  console.log(`fixture ditulis ke ${OUT_DIR}`);
}

main().catch((error: unknown) => {
  console.error('[kt-query-fixtures] gagal:', error);
  process.exitCode = 1;
});
