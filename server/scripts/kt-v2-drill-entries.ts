// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

/**
 * [docs/10 §10.13 · docs/34 §34.6b · docs/39 §39.5] Penulis entri untuk drill
 * pemulihan log Key Transparency **v2**.
 *
 * Melewati **jalur penulis produksi** yang sama dengan `/register`, `/recover`,
 * dan rotasi kunci: `publishKeyTransparencyEntry` (`buildKtLogEntry` +
 * `encodeKtValueV2` + transport gRPC `node:http2` ke `KT_V2_SERVER_URL`). Drill
 * tidak menulis byte protobuf sendiri — kalau penulisnya rusak, drill ikut gagal,
 * dan itu memang tujuannya.
 *
 * Keluaran sengaja mesin-terbaca (`KEY=value`) supaya
 * `scripts/kt-v2-restore-drill.sh` bisa membandingkan keadaan sebelum dan
 * sesudah pemulihan.
 *
 * Pemakaian:
 *   KT_V2_SERVER_URL=http://127.0.0.1:18088 KT_DRILL_ENTRIES=5 \
 *     pnpm --filter nyx-server exec tsx scripts/kt-v2-drill-entries.ts
 */

import { buildKtLogEntry, publishKeyTransparencyEntry } from '../src/utils/keyTransparency.js';

const KT_V2_SERVER_URL = process.env.KT_V2_SERVER_URL ?? 'http://127.0.0.1:18088';
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
/**
 * ML-DSA-65 verification key (1952 byte). Tanpa ini `buildKtLogEntry` melempar
 * `KT_V2_SIGNING_KEY_INVALID` dan entri **tidak ditulis** — persis perilaku
 * produksi untuk perangkat lama, jadi drill harus menyediakan kunci yang sah.
 */
const signingKeyV2 = (index: number) => new Uint8Array(1952).fill(0x55 + shifted(index));
/** Hash berbeda per entri: kalau tidak, penulisan ke-2 dst. jadi rotasi kunci. */
const usernameHash = (index: number) => new Uint8Array(32).fill(0x40 + shifted(index));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main(): Promise<void> {
  if (!Number.isInteger(ENTRY_COUNT) || ENTRY_COUNT < 1) {
    throw new Error(`KT_DRILL_ENTRIES tidak sah: ${process.env.KT_DRILL_ENTRIES}`);
  }
  if (!process.env.KT_V2_SERVER_URL) {
    // Gagal keras, bukan `skipped: DISABLED`: drill yang "lulus" tanpa menulis
    // apa pun adalah drill yang tidak membuktikan apa pun.
    throw new Error('KT_V2_SERVER_URL wajib diisi (drill menulis lewat jalur produksi)');
  }

  let firstHash: string | null = null;
  let firstValueHex: string | null = null;
  let treeSize = 0;

  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const result = await publishKeyTransparencyEntry({
      usernameHash: Buffer.from(usernameHash(index)).toString('base64url'),
      identityKey: identityKey(index),
      pqIdentityKey: pqKey(index),
      signingKey: signingKey(index),
      signingKeyV2: signingKeyV2(index),
      keyVersion: KEY_VERSION,
      updatedAtDay: UPDATED_AT_DAY,
    });
    if (!result.ok) {
      throw new Error(`penulisan entri ${index} gagal: ${result.skipped ?? result.reason ?? 'UNKNOWN'}`);
    }
    if (result.treeSize != null) treeSize = Number(result.treeSize);
    // Yang dilaporkan selalu entri indeks 0 (hash terkecil di batch ini) — drill
    // memakai entri yang sama sebagai pembanding sebelum dan sesudah pemulihan.
    if (index === 0) {
      firstHash = Buffer.from(usernameHash(0)).toString('base64url');
      firstValueHex = hex(buildExpectedValue(index));
    }
    console.log(`DRILL_ENTRY index=${index} treeSize=${result.treeSize ?? '?'}`);
  }

  if (!firstHash || !firstValueHex) throw new Error('tidak ada entri yang tertulis');
  console.log(`DRILL_ENDPOINT=${KT_V2_SERVER_URL}`);
  console.log(`DRILL_FIRST_HASH=${firstHash}`);
  console.log(`DRILL_FIRST_VALUE=${firstValueHex}`);
  console.log(`DRILL_TREE_SIZE=${treeSize}`);
}

/**
 * Nilai log yang diharapkan untuk entri indeks 0. Dihitung ulang dari input yang
 * sama lewat `buildKtLogEntry` (bukan disalin dari respons server): drill harus
 * membandingkan dengan apa yang SEHARUSNYA tertulis.
 */
function buildExpectedValue(index: number): Uint8Array {
  return buildKtLogEntry({
    usernameHash: Buffer.from(usernameHash(index)).toString('base64url'),
    identityKey: identityKey(index),
    pqIdentityKey: pqKey(index),
    signingKey: signingKey(index),
    signingKeyV2: signingKeyV2(index),
    keyVersion: KEY_VERSION,
    updatedAtDay: UPDATED_AT_DAY,
  }).value;
}

main().catch((error: unknown) => {
  console.error('[kt-v2-drill-entries] gagal:', error);
  process.exitCode = 1;
});
