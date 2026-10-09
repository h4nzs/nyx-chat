// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B4] Bucket metadata temporal.
 *
 * Aturan:
 *   1. Bucket = floor deterministik (nilai sama selalu memetakan ke bucket sama).
 *   2. `deviceActivityBucket` = kelipatan 15 menit; `dayBucket` = tengah malam UTC.
 *   3. Skema: User tidak lagi punya `lastActiveAt` presisi (kini `lastActiveDay`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  truncateToBucket,
  deviceActivityBucket,
  dayBucket,
  messageTimeBucket,
  DEVICE_ACTIVITY_BUCKET_MS,
  DAY_BUCKET_MS,
  MESSAGE_TIME_BUCKET_MS,
} from '../src/utils/temporalBucket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSchema = () => readFileSync(path.join(here, '../prisma/schema.prisma'), 'utf8');

function modelBody(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${model} harus ada`);
  return match[1]!;
}

test('B4: truncateToBucket — floor deterministik', () => {
  const t = new Date('2026-10-08T12:34:56.789Z');
  const b = truncateToBucket(t, 60_000);
  assert.equal(b.toISOString(), '2026-10-08T12:34:00.000Z');
  // Deterministik: dua waktu dalam bucket sama → nilai identik.
  assert.equal(
    truncateToBucket(new Date('2026-10-08T12:34:01.000Z'), 60_000).getTime(),
    truncateToBucket(new Date('2026-10-08T12:34:59.999Z'), 60_000).getTime()
  );
});

test('B4: deviceActivityBucket — kelipatan 15 menit & tidak lebih presisi', () => {
  const t = new Date('2026-10-08T12:34:56.789Z');
  const b = deviceActivityBucket(t);
  assert.equal(b.getTime() % DEVICE_ACTIVITY_BUCKET_MS, 0, 'kelipatan bucket');
  assert.equal(b.toISOString(), '2026-10-08T12:30:00.000Z');
  // Tidak boleh membocorkan lebih dari bucket (≤15 menit dari aslinya).
  assert.ok(t.getTime() - b.getTime() < DEVICE_ACTIVITY_BUCKET_MS);
});

test('B4: dayBucket — tengah malam UTC', () => {
  const b = dayBucket(new Date('2026-10-08T23:59:59.999Z'));
  assert.equal(b.toISOString(), '2026-10-08T00:00:00.000Z');
  assert.equal(b.getTime() % DAY_BUCKET_MS, 0);
});

test('B4 skema: User punya lastActiveDay (bucket harian), bukan lastActiveAt presisi', () => {
  const user = modelBody(readSchema(), 'User');
  assert.match(user, /lastActiveDay\s+DateTime/, 'kolom bucket harian ada');
  assert.doesNotMatch(user, /^\s*lastActiveAt\s+\S/m, 'kolom presisi lama dihapus');
  assert.match(user, /@@index\(\[autoDestructDays, lastActiveDay\]\)/, 'index disesuaikan');
});

test('B4 wiring: sweepers & auth memakai kolom/utility bucket', () => {
  const sweeper = readFileSync(path.join(here, '../src/jobs/systemSweeper.ts'), 'utf8');
  assert.match(sweeper, /lastActiveDay/, 'dead man\'s switch memakai bucket harian');
  assert.doesNotMatch(sweeper, /lastActiveAt/, 'tidak lagi menyentuh kolom presisi');

  const auth = readFileSync(path.join(here, '../src/routes/auth.ts'), 'utf8');
  assert.doesNotMatch(auth, /lastActiveAt:\s*new Date\(\)/, 'write device memakai bucket, bukan new Date()');
  assert.match(auth, /lastActiveAt:\s*deviceActivityBucket\(\)/, 'device activity di-bucket');
  assert.match(auth, /lastActiveDay:\s*dayBucket\(\)/, 'user activity di-bucket harian');
});

test('B3: messageTimeBucket — kelipatan 15 menit & expiresAt turunan konsisten', () => {
  const t = new Date('2026-10-08T12:47:33.000Z');
  const b = messageTimeBucket(t);
  assert.equal(b.getTime() % MESSAGE_TIME_BUCKET_MS, 0);
  assert.equal(b.toISOString(), '2026-10-08T12:45:00.000Z');
  // expiresAt diturunkan dari waktu kasar yang SAMA → expiresAt − TTL = createdAt
  // kasar (presisi asli tidak bocor).
  const ttlMs = 14 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(b.getTime() + ttlMs);
  assert.equal(expiresAt.getTime() - ttlMs, b.getTime());
});

test('B3 wiring: jalur pesan memakai messageTimeBucket, bukan new Date() untuk createdAt', () => {
  const wt = readFileSync(path.join(here, '../src/network/realtimeHandlers.ts'), 'utf8');
  assert.match(wt, /createdAt: messageAt/, 'WT memakai createdAt kasar');
  assert.match(wt, /messageTimeBucket\(\)/, 'memakai util bucket');

  const rest = readFileSync(path.join(here, '../src/routes/messages.ts'), 'utf8');
  assert.match(rest, /createdAt: messageAt/, 'REST memakai createdAt kasar');
  assert.match(rest, /lastMessageAt: messageAt/, 'lastMessageAt diturunkan dari waktu kasar');
});

test('B5 skema: SEMUA id NON-time-ordered (uuid, tak ada cuid tersisa)', () => {
  const schema = readSchema();
  const message = modelBody(schema, 'Message');
  assert.match(message, /id\s+String\s+@id\s+@default\(uuid\(\)\)/, 'Message.id uuid');
  // Model yang diminta tuntas: User/Conversation/Device + seluruh model lain.
  // Model dengan PK ber-default (Authenticator/CredentialIssuerKey punya PK eksplisit).
  for (const model of ['User', 'Conversation', 'Device', 'Tenant', 'MessageStatus', 'SessionKey', 'RefreshToken', 'PushSubscription', 'OneTimePreKey', 'UserHiddenConversation', 'BlockedUser']) {
    assert.match(modelBody(schema, model), /@default\(uuid\(\)\)/, `${model}.id uuid`);
  }
  assert.doesNotMatch(schema, /@default\(cuid\(\)\)/, 'tidak boleh ada cuid time-ordered tersisa (D11)');
});

test('B3 skema+wiring: MessageStatus.updatedAt coarse (bukan @updatedAt)', () => {
  const status = modelBody(readSchema(), 'MessageStatus');
  // Cek FIELD-nya (bukan komentar yang menyebut `@updatedAt`).
  assert.doesNotMatch(status, /^\s*updatedAt\s+DateTime\s+@updatedAt/m, '`@updatedAt` dihapus (menimpa dengan waktu presisi)');

  const wt = readFileSync(path.join(here, '../src/network/realtimeHandlers.ts'), 'utf8');
  // Kedua jalur receipt (per-pesan & batch) menulis updatedAt bucket.
  const matches = wt.match(/updatedAt: messageTimeBucket\(\)/g) || [];
  assert.ok(matches.length >= 4, `updatedAt bucket di kedua upsert (create+update), dapat ${matches.length}`);
});

test('B5 wiring: id SYSTEM metadata tidak lagi memakai Date.now()', () => {
  const wt = readFileSync(path.join(here, '../src/network/realtimeHandlers.ts'), 'utf8');
  assert.doesNotMatch(wt, /msg_sys_meta_\$\{Date\.now\(\)\}/, 'id time-ordered lama dihapus');
  assert.match(wt, /sys_meta_\$\{crypto\.randomUUID\(\)\}/, 'id acak (non-time-ordered)');
});
