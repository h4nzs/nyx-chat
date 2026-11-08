// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP2] Builder snapshot per shard untuk `xor-pir-v1`.
 *
 * Tanggung jawab berkas ini murni: dari daftar user ber-`oprfIndex` menjadi
 * artefak per shard (slot, manifest, tanda tangan). Tidak ada Prisma, Redis,
 * atau jaringan di sini supaya bisa diuji tanpa infrastruktur.
 *
 * Dua keputusan yang mengikat:
 *
 *  1. **Shard ditentukan klien**, bukan server: `H(oprfIndex) mod shardCount`.
 *     Karena itu builder memilih `shardCount` sampai setiap shard muat
 *     (kapasitas = `slotCount/2`), lalu mempublikasikannya di manifest.
 *  2. **Penempatan cuckoo 3-pilihan** memakai `pirRecordCandidates()` dari
 *     `@nyx/shared` — fungsi yang sama yang dipakai klien. Builder gagal keras
 *     (bukan stash diam-diam) bila sebuah kunci tidak dapat slot.
 */

import { createHash } from 'node:crypto';
import {
  PIR_MAX_RECORD_BYTES,
  PIR_MIN_RECORD_BYTES,
  PIR_SUITE,
  encodePirRecord,
  pirDbRoot,
  pirRecordCandidates,
  type PirManifest,
} from '@nyx/shared';
import { signPirManifest, type PirSigningKey } from './manifest.js';
import { pirRecordBody, type PirRecordSource } from './snapshot.js';

export const PIR_SLOT_TARGET_DEFAULT = 4096;
/** Beban maksimum per shard; cuckoo 3-pilihan aman di bawah 0.5. */
const MAX_LOAD = 0.5;
const MAX_KICKS_FACTOR = 64;

const PLACEMENT_DOMAIN = new TextEncoder().encode('nyx:pir:placement:v1\0');

export interface PirShardPlan {
  shardCount: number;
  slotCount: number;
}

export interface PirShardArtifact {
  manifest: PirManifest;
  /** Slot record berukuran seragam; slot kosong = nol. */
  slots: Uint8Array[];
  /** Tanda tangan ML-DSA-65 base64url atas `pirManifestMessage(manifest)`. */
  signature: string;
}

export interface PirBuildOptions {
  recordBytes: number;
  epoch: number;
  operator: string;
  signingKey: PirSigningKey;
  slotTarget?: number;
}

export function parsePirSlotTarget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return PIR_SLOT_TARGET_DEFAULT;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error('PIR: PIR_SLOT_TARGET harus bilangan bulat');
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 4) {
    throw new Error('PIR: PIR_SLOT_TARGET minimal 4');
  }
  return nextPowerOfTwo(value);
}

function nextPowerOfTwo(value: number): number {
  let result = 4;
  while (result < value) result *= 2;
  return result;
}

function digestIndex(oprfIndex: Uint8Array): string {
  return Buffer.from(oprfIndex).toString('hex');
}

/** Samakan dengan `pirRecordCandidates`: shard = potongan hash pertama mod N. */
function shardOf(oprfIndex: Uint8Array, shardCount: number): number {
  const digest = createHash('sha256').update(oprfIndex).digest();
  return digest.readUInt32BE(0) % shardCount;
}

function capacity(slotCount: number): number {
  return Math.floor(slotCount * MAX_LOAD);
}

/**
 * Rencana awal: `shardCount` minimal dari kapasitas rata-rata. Builder masih
 * boleh menggandakan `slotCount` satu shard bila distribusi hash membuat shard
 * itu lebih penuh dari rata-rata — `slotCount` dipublikasikan per shard di
 * manifest, jadi klien selalu memakai angka yang benar.
 */
export function planPirShards(entryCount: number, slotTarget = PIR_SLOT_TARGET_DEFAULT): PirShardPlan {
  if (!Number.isSafeInteger(entryCount) || entryCount <= 0) {
    throw new Error('PIR: snapshot kosong; minimal satu user dengan oprfIndex');
  }
  const slotCount = nextPowerOfTwo(slotTarget);
  const perShard = capacity(slotCount);
  let shardCount = Math.max(1, Math.ceil(entryCount / perShard));
  return { shardCount, slotCount };
}

interface Placement {
  slots: (Uint8Array | null)[];
  owner: number[];
  slotOf: number[];
}

/**
 * Cuckoo 3-pilihan dengan eviction. Deterministik: PRNG xorshift ber-seed dari
 * nomor shard, bukan `Math.random` — build yang sama menghasilkan slot yang sama.
 */
function placeKeys(
  keys: Uint8Array[],
  slotTarget: number,
  shard: number,
): { slots: Uint8Array[]; slotOf: number[] } {
  let slotCount = nextPowerOfTwo(slotTarget);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const placed = tryPlace(keys, slotCount, shard);
    if (placed) return { slots: placed.slots, slotOf: placed.slotOf };
    slotCount *= 2;
  }
  throw new Error(`PIR: penempatan shard ${shard} gagal; naikkan PIR_SLOT_TARGET`);
}

function tryPlace(
  keys: Uint8Array[],
  slotCount: number,
  shard: number,
): { slots: Uint8Array[]; slotOf: number[] } | null {
  if (keys.length > capacity(slotCount)) return null;
  const placement: Placement = {
    slots: Array.from({ length: slotCount }, () => null),
    owner: Array.from({ length: slotCount }, () => -1),
    slotOf: Array.from({ length: keys.length }, () => -1),
  };
  const random = xorshift(placementSeed(shard));
  const maxKicks = Math.max(256, keys.length * MAX_KICKS_FACTOR);

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    let current = keyIndex;
    let kicks = 0;
    for (;;) {
      const candidates = pirRecordCandidates(keys[current]!, slotCount);
      const free = candidates.find((slot) => placement.slots[slot] === null);
      if (free !== undefined) {
        placement.slots[free] = keys[current]!;
        placement.owner[free] = current;
        placement.slotOf[current] = free;
        break;
      }
      kicks += 1;
      if (kicks > maxKicks) return null;
      const victimSlot = candidates[Math.floor(random() * candidates.length)]!;
      const victim = placement.owner[victimSlot]!;
      placement.slots[victimSlot] = keys[current]!;
      placement.owner[victimSlot] = current;
      placement.slotOf[current] = victimSlot;
      current = victim;
    }
  }

  const slots = placement.slots.map((key) => key ?? new Uint8Array(0));
  return { slots, slotOf: placement.slotOf };
}

function placementSeed(shard: number): number {
  const digest = createHash('sha256').update(PLACEMENT_DOMAIN).update(String(shard)).digest();
  return digest.readUInt32BE(0) || 1;
}

function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function buildPirShards(
  sources: readonly PirRecordSource[],
  options: PirBuildOptions,
): PirShardArtifact[] {
  const { recordBytes, epoch, operator, signingKey } = options;
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error('PIR: epoch harus bilangan bulat positif');
  }
  if (recordBytes < PIR_MIN_RECORD_BYTES || recordBytes > PIR_MAX_RECORD_BYTES) {
    throw new Error(`PIR: recordBytes harus ${PIR_MIN_RECORD_BYTES}..${PIR_MAX_RECORD_BYTES}`);
  }
  if (operator.length === 0 || operator.length > 64) {
    throw new Error('PIR: operator harus 1..64 karakter');
  }

  const entries: { index: Uint8Array; body: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.oprfIndex || !/^[0-9a-f]{64}$/.test(source.oprfIndex)) {
      throw new Error(`PIR: oprfIndex user ${source.id} bukan 32 byte hex huruf kecil`);
    }
    if (seen.has(source.oprfIndex)) {
      throw new Error(`PIR: oprfIndex duplikat untuk user ${source.id}`);
    }
    seen.add(source.oprfIndex);
    entries.push({
      index: new Uint8Array(Buffer.from(source.oprfIndex, 'hex')),
      body: pirRecordBody(source),
    });
  }

  const keyOf = (entry: { index: Uint8Array }) => digestIndex(entry.index);
  entries.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));

  const plan = planPirShards(entries.length, options.slotTarget ?? PIR_SLOT_TARGET_DEFAULT);
  const buckets: (typeof entries)[] = Array.from({ length: plan.shardCount }, () => []);
  for (const entry of entries) {
    buckets[shardOf(entry.index, plan.shardCount)]!.push(entry);
  }

  return buckets.map((bucket, shard) => {
    const keys = bucket.map((entry) => entry.index);
    const placed = placeKeys(keys, plan.slotCount, shard);
    const bySlot = new Map<number, (typeof entries)[number]>();
    placed.slotOf.forEach((slot, index) => bySlot.set(slot, bucket[index]!));
    const slots: Uint8Array[] = placed.slots.map((key, slot) => {
      if (key.length === 0) return new Uint8Array(recordBytes);
      const entry = bySlot.get(slot)!;
      return encodePirRecord({ oprfIndex: entry.index, body: entry.body, recordBytes });
    });
    const manifest: PirManifest = {
      suite: PIR_SUITE,
      shard,
      shardCount: plan.shardCount,
      slotCount: slots.length,
      recordBytes,
      epoch,
      entryCount: bucket.length,
      dbRoot: pirDbRoot(slots, recordBytes),
      operator,
      keyId: signingKey.keyId,
    };
    return { manifest, slots, signature: signPirManifest(manifest, signingKey) };
  });
}

/** Berkas sidecar: slot biner mentah + manifest+tanda tangan sebagai JSON. */
export function serializePirShard(artifact: PirShardArtifact): { bin: Uint8Array; json: string } {
  const bin = new Uint8Array(artifact.slots.length * artifact.manifest.recordBytes);
  artifact.slots.forEach((slot, index) => {
    bin.set(slot, index * artifact.manifest.recordBytes);
  });
  return {
    bin,
    json: JSON.stringify({ manifest: artifact.manifest, signature: artifact.signature }),
  };
}
