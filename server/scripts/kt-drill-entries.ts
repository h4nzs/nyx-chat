// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/10 §10.13 / docs/32 §32.7 / docs/34 §34.6b] Penulis entri untuk drill
 * pemulihan log KT.
 *
 * Melewati **jalur penulis produksi** yang sama dengan `/register` dan
 * `/recover`: `buildKtLogEntry` + `encodeKtUpdateRequest` + transport gRPC
 * `node:http2` di `server/src/utils/keyTransparency.ts`. Drill tidak menulis
 * byte protobuf sendiri — kalau penulisnya yang rusak, drill harus ikut gagal.
 *
 * Keluaran sengaja mesin-terbaca (`KEY=value`) supaya `scripts/kt-restore-drill.sh`
 * bisa membandingkan keadaan sebelum dan sesudah pemulihan.
 *
 * Pemakaian:
 *   KT_SERVER_URL=http://127.0.0.1:18081 KT_DRILL_ENTRIES=5 \
 *     pnpm --filter nyx-server exec tsx scripts/kt-drill-entries.ts
 */

import {
  buildKtLogEntry,
  createGrpcKtTransport,
  encodeKtUpdateRequest,
  summarizeKtUpdateResponse,
} from '../src/utils/keyTransparency.js';

const KT_SERVER_URL = process.env.KT_SERVER_URL ?? 'http://127.0.0.1:18081';
const ENTRY_COUNT = Number.parseInt(process.env.KT_DRILL_ENTRIES ?? '5', 10);
const KEY_VERSION = Number.parseInt(process.env.KT_DRILL_KEY_VERSION ?? '1', 10);
/**
 * Geser indeks identitas/hash. Dipakai drill untuk menulis entri BARU setelah
 * pemulihan tanpa menimpa (merotasi) kunci yang sudah ada — kalau entri lama
 * dirotasi, bukti untuk kunci itu memang berubah dan drill kehilangan pembanding.
 */
const INDEX_OFFSET = Number.parseInt(process.env.KT_DRILL_INDEX_OFFSET ?? '0', 10);
/** Hari Unix `updatedAt` — nilai tetap supaya drill bisa diulang. */
const UPDATED_AT_DAY = 20_145;

const shifted = (index: number) => index + INDEX_OFFSET;

const identityKey = (index: number) => new Uint8Array(32).fill(0x11 + shifted(index));
const pqKey = (index: number) => new Uint8Array(1216).fill(0x22 + shifted(index));
const signingKey = (index: number) => new Uint8Array(32).fill(0x33 + shifted(index));
/** Hash berbeda per entri: kalau tidak, penulisan ke-2 dst. jadi rotasi kunci. */
const usernameHash = (index: number) => new Uint8Array(32).fill(0x40 + shifted(index));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main(): Promise<void> {
  if (!Number.isInteger(ENTRY_COUNT) || ENTRY_COUNT < 1) {
    throw new Error(`KT_DRILL_ENTRIES tidak sah: ${process.env.KT_DRILL_ENTRIES}`);
  }

  const transport = createGrpcKtTransport({ endpoint: KT_SERVER_URL, timeoutMs: 15_000 });
  let firstHash: string | null = null;
  let firstValueHex: string | null = null;
  let treeSize = 0;

  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const entry = buildKtLogEntry({
      usernameHash: Buffer.from(usernameHash(index)).toString('base64url'),
      identityKey: identityKey(index),
      pqIdentityKey: pqKey(index),
      signingKey: signingKey(index),
      keyVersion: KEY_VERSION,
      updatedAtDay: UPDATED_AT_DAY,
    });
    const response = await transport.update(
      encodeKtUpdateRequest({ searchKey: entry.searchKey, value: entry.value, returnUpdateResponse: true })
    );
    const summary = summarizeKtUpdateResponse(response);
    treeSize = Number(summary.treeSize ?? treeSize);
    // Yang dilaporkan selalu entri indeks 0 (hash terkecil di batch ini) — drill
    // memakai entri yang sama sebagai pembanding sebelum dan sesudah pemulihan.
    if (index === 0) {
      firstHash = Buffer.from(usernameHash(0)).toString('base64url');
      firstValueHex = hex(entry.value);
    }
    console.log(`DRILL_ENTRY index=${index} treeSize=${summary.treeSize} valueBytes=${entry.value.length}`);
  }

  if (!firstHash || !firstValueHex) throw new Error('tidak ada entri yang tertulis');
  // Baris keluaran yang dipakai drill.
  console.log(`DRILL_FIRST_HASH=${firstHash}`);
  console.log(`DRILL_FIRST_VALUE=${firstValueHex}`);
  console.log(`DRILL_TREE_SIZE=${treeSize}`);
}

main().catch((error: unknown) => {
  console.error('[kt-drill-entries] gagal:', error);
  process.exitCode = 1;
});
