// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.3] Gerbang bucket temporal.
 *
 * DoD bagian ini bukan "kolom yang saya ingat sudah dipotong", melainkan
 * **enumerasi field**: setiap kolom DateTime pada model yang dipetakan harus
 * dipotong, didaftar sebagai pengecualian beralasan, atau tinggal di model yang
 * waktunya diturunkan di route (`Message`, `Story`). Model/kolom baru yang
 * menambah presisi waktu karenanya membuat tes ini gagal, bukan lolos diam-diam.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  bucketTemporalArgs,
  DERIVED_TIME_MODELS,
  TEMPORAL_BUCKETS,
  TEMPORAL_EXCEPTIONS,
} from '../src/lib/temporalBuckets.js';
import { DAY_BUCKET_MS, DEVICE_ACTIVITY_BUCKET_MS } from '../src/utils/temporalBucket.js';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

/** `model X { ... }` → peta nama model → daftar field DateTime. */
function dateTimeFieldsByModel(schema: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const fields = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('DateTime') && !line.startsWith('//'))
      .map((line) => line.split(/\s+/)[0].replace(/\?$/, ''));
    result.set(name, fields);
  }
  return result;
}

describe('peta bucket temporal vs schema.prisma', () => {
  const schemaFields = dateTimeFieldsByModel(SCHEMA);

  it('setiap field yang dipetakan benar-benar kolom DateTime', () => {
    for (const [model, fields] of Object.entries(TEMPORAL_BUCKETS)) {
      const actual = schemaFields.get(model);
      assert.ok(actual, `model ${model} tidak ada di schema.prisma`);
      for (const { field } of fields) {
        assert.ok(
          actual.includes(field),
          `${model}.${field} dipetakan untuk di-bucket tetapi bukan kolom DateTime`,
        );
      }
    }
  });

  it('tidak ada kolom DateTime yang lolos tanpa keputusan (enumerasi field)', () => {
    const unclassified: string[] = [];
    for (const [model, fields] of schemaFields) {
      if ((DERIVED_TIME_MODELS as readonly string[]).includes(model)) continue;
      const mapped = new Set((TEMPORAL_BUCKETS[model] ?? []).map((entry) => entry.field));
      const exceptions = TEMPORAL_EXCEPTIONS[model] ?? {};
      for (const field of fields) {
        if (mapped.has(field)) continue;
        if (exceptions[field]) continue;
        unclassified.push(`${model}.${field}`);
      }
    }
    assert.deepEqual(
      unclassified,
      [],
      `kolom waktu belum diputuskan: ${unclassified.join(', ')} — potong lewat TEMPORAL_BUCKETS atau daftarkan di TEMPORAL_EXCEPTIONS dengan alasan`,
    );
  });

  it('model turunan waktu tidak di-bucket ganda', () => {
    for (const model of DERIVED_TIME_MODELS) {
      assert.equal(
        TEMPORAL_BUCKETS[model],
        undefined,
        `${model} menurunkan expiresAt di route; memotongnya di sini memisahkan TTL dari createdAt`,
      );
    }
  });

  it('setiap pengecualian punya alasan tertulis', () => {
    for (const [model, entries] of Object.entries(TEMPORAL_EXCEPTIONS)) {
      for (const [field, reason] of Object.entries(entries)) {
        assert.ok(reason.length > 20, `${model}.${field} butuh alasan yang bisa dibaca`);
      }
    }
  });
});

describe('bucketTemporalArgs', () => {
  const NOW = new Date('2026-11-17T10:07:33.123Z');
  const bucketed = new Date('2026-11-17T10:00:00.000Z');

  it('create mengisi createdAt/updatedAt dengan waktu terpotong', () => {
    const args = bucketTemporalArgs('User', 'create', { data: { usernameHash: 'h' } }, NOW) as {
      data: Record<string, Date>;
    };
    assert.deepEqual(args.data.createdAt, bucketed);
    assert.deepEqual(args.data.updatedAt, bucketed);
    // Field non-waktu tidak boleh tersentuh.
    assert.equal(args.data.usernameHash, 'h');
  });

  it('nilai yang dikirim pemanggil ikut dipotong, bukan dibiarkan', () => {
    const explicit = new Date('2026-11-17T10:14:59.999Z');
    const args = bucketTemporalArgs('Device', 'create', { data: { lastActiveAt: explicit } }, NOW) as {
      data: Record<string, Date>;
    };
    assert.deepEqual(args.data.lastActiveAt, bucketed);
  });

  it('update menyetel ulang updatedAt (pengganti @updatedAt)', () => {
    const args = bucketTemporalArgs('Conversation', 'update', { data: { messageSeq: 3 } }, NOW) as {
      data: Record<string, Date>;
    };
    assert.deepEqual(args.data.updatedAt, bucketed);
  });

  it('expiresAt yang tidak disebut pemanggil tidak diisi sendiri', () => {
    const args = bucketTemporalArgs('GroupMailboxItem', 'create', { data: { expiresAt: new Date('2026-11-24T10:07:33.000Z') } }, NOW) as {
      data: Record<string, Date>;
    };
    assert.deepEqual(args.data.expiresAt, new Date('2026-11-24T10:00:00.000Z'));

    const empty = bucketTemporalArgs('GroupMailboxItem', 'create', { data: {} }, NOW) as {
      data: Record<string, unknown>;
    };
    assert.equal(empty.data.expiresAt, undefined);
  });

  it('langganan dipotong harian, bukan 15 menit', () => {
    const args = bucketTemporalArgs('User', 'update', { data: { subscriptionExpiresAt: NOW } }, NOW) as {
      data: Record<string, Date>;
    };
    const value = args.data.subscriptionExpiresAt as Date;
    assert.equal(value.getTime() % DAY_BUCKET_MS, 0);
    assert.equal(args.data.updatedAt.getTime() % DEVICE_ACTIVITY_BUCKET_MS, 0);
  });

  it('createMany memotong setiap baris array', () => {
    const args = bucketTemporalArgs('PushSubscription', 'createMany', { data: [{ endpoint: 'a' }, { endpoint: 'b' }] }, NOW) as {
      data: Array<Record<string, Date>>;
    };
    assert.equal(args.data.length, 2);
    for (const row of args.data) assert.deepEqual(row.createdAt, bucketed);
  });

  it('upsert mengisi create dan update dengan mode masing-masing', () => {
    const args = bucketTemporalArgs(
      'RefreshToken',
      'upsert',
      { where: { jti: 'j' }, create: { jti: 'j' }, update: { revokedAt: NOW } },
      NOW,
    ) as { create: Record<string, Date>; update: Record<string, Date> };

    assert.deepEqual(args.create.createdAt, bucketed);
    assert.deepEqual(args.create.lastUsedAt, bucketed);
    assert.deepEqual(args.update.revokedAt, bucketed);
    // `lastUsedAt` ikut disetel ulang pada update (TOUCHED), bukan dibiarkan.
    assert.deepEqual(args.update.lastUsedAt, bucketed);
  });

  it('model tak dipetakan dan operasi baca tidak diubah', () => {
    const read = { where: { id: 'x' } };
    assert.equal(bucketTemporalArgs('User', 'findMany', read, NOW), read);
    const other = { data: { v: 1 } };
    assert.equal(bucketTemporalArgs('Authenticator', 'create', other, NOW), other);
  });
});
