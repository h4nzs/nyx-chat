import { describe, expect, it } from 'vitest';
import {
  PIR_MIN_RECORD_BYTES,
  PIR_RECORD_HEADER_BYTES,
  PIR_RECORD_TAG_BYTES,
  PIR_SLOT_CANDIDATES,
  PirRecordError,
  decodePirRecord,
  encodePirRecord,
  parsePirManifest,
  pirDbRoot,
  pirManifestMessage,
  pirManifestsAgree,
  pirRecordCandidates,
  pirRecordIndexTag,
} from '@nyx/shared';

const RECORD_BYTES = 1024;
const indexA = new Uint8Array(32).fill(7);
const indexB = new Uint8Array(32).fill(9);
const body = new TextEncoder().encode(JSON.stringify({ id: 'u1', v: true }));

function manifest(overrides: Record<string, unknown> = {}) {
  return parsePirManifest({
    suite: 'xor-pir-v1',
    shard: 0,
    shardCount: 1,
    slotCount: 4096,
    recordBytes: 2048,
    epoch: 3,
    entryCount: 2,
    dbRoot: 'a'.repeat(64),
    operator: 'nyx-a',
    keyId: 'b'.repeat(64),
    ...overrides,
  });
}

describe('pir record v2', () => {
  it('roundtrips body and binds ix to the index', () => {
    const record = encodePirRecord({ oprfIndex: indexA, body, recordBytes: RECORD_BYTES });
    expect(record.length).toBe(RECORD_BYTES);
    const decoded = decodePirRecord(record, indexA);
    expect(decoded.status).toBe('ok');
    expect(new TextDecoder().decode((decoded as { body: Uint8Array }).body)).toBe(
      new TextDecoder().decode(body),
    );
  });

  it('reports a slot owned by another index as `other`, not a miss', () => {
    const record = encodePirRecord({ oprfIndex: indexA, body, recordBytes: RECORD_BYTES });
    expect(decodePirRecord(record, indexB)).toEqual({ status: 'other' });
  });

  it('rejects a single flipped payload byte', () => {
    const record = encodePirRecord({ oprfIndex: indexA, body, recordBytes: RECORD_BYTES });
    record[PIR_RECORD_HEADER_BYTES] = record[PIR_RECORD_HEADER_BYTES]! ^ 0x01;
    expect(() => decodePirRecord(record, indexA)).toThrow(PirRecordError);
  });

  it('treats an all-zero slot as a miss, not an error', () => {
    expect(decodePirRecord(new Uint8Array(RECORD_BYTES), indexA)).toEqual({ status: 'miss' });
  });

  it('rejects a body that cannot fit the fixed record', () => {
    const tooBig = new Uint8Array(RECORD_BYTES - PIR_RECORD_HEADER_BYTES - PIR_RECORD_TAG_BYTES + 1);
    expect(() => encodePirRecord({ oprfIndex: indexA, body: tooBig, recordBytes: RECORD_BYTES })).toThrow(
      PirRecordError,
    );
  });

  it('refuses record sizes outside the contract', () => {
    expect(() =>
      encodePirRecord({ oprfIndex: indexA, body, recordBytes: PIR_MIN_RECORD_BYTES - 1 }),
    ).toThrow(PirRecordError);
  });
});

describe('pir slot candidates', () => {
  it('derives three distinct in-range slots deterministically', () => {
    const first = pirRecordCandidates(indexA, 4096);
    expect(first).toHaveLength(PIR_SLOT_CANDIDATES);
    expect(new Set(first).size).toBe(PIR_SLOT_CANDIDATES);
    for (const slot of first) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(4096);
    }
    expect(pirRecordCandidates(indexA, 4096)).toEqual(first);
    expect(pirRecordCandidates(indexB, 4096)).not.toEqual(first);
  });

  it('rejects a slot count that cannot hold three candidates', () => {
    expect(() => pirRecordCandidates(indexA, 2)).toThrow(PirRecordError);
  });
});

describe('pir manifest', () => {
  it('parses a well-formed manifest', () => {
    const value = manifest();
    expect(value.suite).toBe('xor-pir-v1');
    expect(value.slotCount).toBe(4096);
  });

  it('rejects unknown suites and out-of-range fields', () => {
    expect(() => manifest({ suite: 'chalametpir-v1' })).toThrow();
    expect(() => manifest({ shard: 4 })).toThrow();
    expect(() => manifest({ entryCount: 5000, slotCount: 4096 })).toThrow();
    expect(() => manifest({ dbRoot: 'zz' })).toThrow();
  });

  it('agrees across operators but signs the operator field', () => {
    const a = manifest({ operator: 'nyx-a' });
    const b = manifest({ operator: 'nyx-b' });
    expect(pirManifestsAgree(a, b)).toBe(true);
    expect(pirManifestMessage(a)).not.toEqual(pirManifestMessage(b));

    const c = manifest({ operator: 'nyx-b', epoch: 4 });
    expect(pirManifestsAgree(a, c)).toBe(false);
  });

  it('binds dbRoot to slot order and size', () => {
    const slot = new Uint8Array(256).fill(1);
    const other = new Uint8Array(256).fill(2);
    expect(pirDbRoot([slot, other], 256)).toBe(pirDbRoot([slot, other], 256));
    expect(pirDbRoot([slot, other], 256)).not.toBe(pirDbRoot([other, slot], 256));
    expect(() => pirDbRoot([slot], 256)).not.toThrow();
    expect(() => pirDbRoot([new Uint8Array(128)], 256)).toThrow();
  });

  it('index tags are domain-separated from the raw index', () => {
    const tag = pirRecordIndexTag(indexA);
    expect(tag).toHaveLength(32);
    expect(Buffer.from(tag).equals(Buffer.from(indexA))).toBe(false);
  });
});
