import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodePirRecord,
  mlDsaKeygen,
  pirRecordCandidates,
  PIR_SUITE,
  type PirManifest,
} from '@nyx/shared';
import {
  buildPirShards,
  parsePirSlotTarget,
  planPirShards,
  serializePirShard,
} from '../src/pir/shards.js';
import {
  loadPirSigningKeyBytes,
  pirKeyId,
  verifyPirManifest,
  signPirManifest,
} from '../src/pir/manifest.js';
import type { PirRecordSource } from '../src/pir/snapshot.js';

const KEY = loadPirSigningKeyBytes(new Uint8Array(32).fill(3));

function indexFor(n: number): string {
  return createHash('sha256').update(`user-${n}`).digest('hex');
}

function source(n: number): PirRecordSource {
  return {
    id: `user-${n}`,
    encryptedProfile: null,
    isVerified: n % 2 === 0,
    hasCompletedOnboarding: true,
    oprfIndex: indexFor(n),
    device: null,
  };
}

function build(count: number, overrides: Record<string, unknown> = {}) {
  return buildPirShards(Array.from({ length: count }, (_, n) => source(n)), {
    recordBytes: 256,
    epoch: 7,
    operator: 'nyx-a',
    signingKey: KEY,
    ...overrides,
  });
}

/** Sama dengan `shardOf` di builder; klien wajib menghitungnya identik. */
function shardOf(hex: string, shardCount: number): number {
  const digest = createHash('sha256').update(Buffer.from(hex, 'hex')).digest();
  return digest.readUInt32BE(0) % shardCount;
}

/** Cari slot yang memuat index ini, persis seperti klien (3 kandidat). */
function findSlot(artifact: { slots: Uint8Array[] }, hex: string): Uint8Array | null {
  const index = new Uint8Array(Buffer.from(hex, 'hex'));
  for (const slot of pirRecordCandidates(index, artifact.slots.length)) {
    const record = artifact.slots[slot]!;
    let decoded;
    try {
      decoded = decodePirRecord(record, index);
    } catch {
      continue;
    }
    if (decoded.status === 'ok') return record;
  }
  return null;
}

test('PIR shard: rencana membagi berdasarkan kapasitas 50%', () => {
  assert.deepEqual(planPirShards(1), { shardCount: 1, slotCount: 4096 });
  assert.deepEqual(planPirShards(2048), { shardCount: 1, slotCount: 4096 });
  assert.deepEqual(planPirShards(2049), { shardCount: 2, slotCount: 4096 });
  assert.equal(planPirShards(10, 5).slotCount, 8);
});

test('PIR shard: parsePirSlotTarget membulatkan ke pangkat dua', () => {
  assert.equal(parsePirSlotTarget(undefined), 4096);
  assert.equal(parsePirSlotTarget('1000'), 1024);
  assert.throws(() => parsePirSlotTarget('3'));
  assert.throws(() => parsePirSlotTarget('abc'));
});

test('PIR shard: setiap kunci bisa ditemukan lewat 3 kandidat', () => {
  const artifacts = build(40);
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0]!;
  assert.equal(artifact.manifest.suite, PIR_SUITE);
  assert.equal(artifact.manifest.entryCount, 40);
  assert.equal(artifact.manifest.slotCount, 4096);
  assert.equal(artifact.manifest.keyId, KEY.keyId);
  assert.match(artifact.manifest.dbRoot, /^[0-9a-f]{64}$/);

  for (let n = 0; n < 40; n += 1) {
    const record = findSlot(artifact, indexFor(n));
    assert.ok(record, `user-${n} tidak ditemukan di slot kandidatnya`);
  }
});

test('PIR shard: slot kosong nol dan jumlah record sama dengan entryCount', () => {
  const artifact = build(40)[0]!;
  let filled = 0;
  for (const slot of artifact.slots) {
    if (slot.some((byte) => byte !== 0)) filled += 1;
  }
  assert.equal(filled, artifact.manifest.entryCount);
});

test('PIR shard: manifest bertanda tangan bisa diverifikasi', () => {
  const artifact = build(5)[0]!;
  assert.equal(verifyPirManifest(artifact.manifest, artifact.signature, KEY.publicKey), true);
  const other = mlDsaKeygen(new Uint8Array(32).fill(4));
  assert.equal(verifyPirManifest(artifact.manifest, artifact.signature, other.publicKey), false);
  assert.equal(verifyPirManifest(artifact.manifest, 'AAAA', KEY.publicKey), false);
});

test('PIR shard: tanda tangan menolak manifest yang diubah', () => {
  const artifact = build(5)[0]!;
  const tampered: PirManifest = { ...artifact.manifest, epoch: artifact.manifest.epoch + 1 };
  assert.equal(verifyPirManifest(tampered, artifact.signature, KEY.publicKey), false);
});

test('PIR shard: build deterministik', () => {
  const first = build(30)[0]!;
  const second = build(30)[0]!;
  assert.equal(first.manifest.dbRoot, second.manifest.dbRoot);
  assert.deepEqual(
    first.slots.map((slot) => Buffer.from(slot).toString('hex')),
    second.slots.map((slot) => Buffer.from(slot).toString('hex')),
  );
});

test('PIR shard: multi-shard konsisten dengan shardOf klien', () => {
  const artifacts = build(20, { slotTarget: 4 });
  assert.ok(artifacts.length > 1, 'slotTarget kecil harus memaksa banyak shard');
  const shardCount = artifacts[0]!.manifest.shardCount;
  assert.equal(artifacts.length, shardCount);

  for (const artifact of artifacts) {
    assert.equal(artifact.manifest.shardCount, shardCount);
    assert.ok(artifact.manifest.entryCount <= artifact.slots.length / 2);
  }
  for (let n = 0; n < 20; n += 1) {
    const shard = shardOf(indexFor(n), shardCount);
    const artifact = artifacts.find((item) => item.manifest.shard === shard);
    assert.ok(artifact, `user-${n} menunjuk shard ${shard} yang tidak ada`);
    assert.ok(findSlot(artifact, indexFor(n)), `user-${n} tidak ditemukan di shard ${shard}`);
  }
});

test('PIR shard: record tidak bisa dipalsukan setelah build', () => {
  const artifact = build(5)[0]!;
  const index = new Uint8Array(Buffer.from(indexFor(2), 'hex'));
  const slot = pirRecordCandidates(index, artifact.slots.length)[0]!;
  const record = new Uint8Array(artifact.slots[slot]!);
  // Timpa ix dengan milik user lain: harus ditolak, bukan dianggap "miss".
  record.set(Buffer.from(indexFor(3), 'hex').subarray(0, 32), 1);
  assert.throws(() => decodePirRecord(record, index));
});

test('PIR shard: masukan cacat ditolak', () => {
  assert.throws(() => buildPirShards([source(1), source(1)], {
    recordBytes: 256,
    epoch: 1,
    operator: 'nyx-a',
    signingKey: KEY,
  }));
  assert.throws(() => buildPirShards([{ ...source(1), oprfIndex: 'zz' }], {
    recordBytes: 256,
    epoch: 1,
    operator: 'nyx-a',
    signingKey: KEY,
  }));
  assert.throws(() => buildPirShards([], {
    recordBytes: 256,
    epoch: 1,
    operator: 'nyx-a',
    signingKey: KEY,
  }));
  assert.throws(() => build(2, { recordBytes: 128 }));
  assert.throws(() => build(2, { epoch: 0 }));
  assert.throws(() => build(2, { operator: 'x'.repeat(65) }));
});

test('PIR shard: serialisasi biner sesuai ukuran manifest', () => {
  const artifact = build(10)[0]!;
  const { bin, json } = serializePirShard(artifact);
  assert.equal(bin.length, artifact.manifest.slotCount * artifact.manifest.recordBytes);
  const parsed = JSON.parse(json) as { manifest: PirManifest; signature: string };
  assert.equal(parsed.manifest.dbRoot, artifact.manifest.dbRoot);
  assert.equal(verifyPirManifest(parsed.manifest, parsed.signature, KEY.publicKey), true);
});

test('PIR manifest: kunci penanda tangan divalidasi', () => {
  assert.equal(KEY.keyId, pirKeyId(KEY.publicKey));
  assert.throws(() => loadPirSigningKeyBytes(new Uint8Array(31)));
  const artifact = build(2)[0]!;
  const other = loadPirSigningKeyBytes(new Uint8Array(32).fill(5));
  assert.throws(() => signPirManifest(artifact.manifest, other));
});
