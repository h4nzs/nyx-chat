// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Batas ukuran upload (`utils/uploadLimits.ts`).
 *
 * Yang dikunci: angka batas tidak berubah dari sebelumnya, dan `fileSize`
 * WAJIB — karena angka itulah yang dipakai sebagai `ContentLength` yang
 * ditandatangani, satu-satunya cara server (bukan klien) menentukan ukuran.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENCRYPTION_OVERHEAD_BYTES,
  UPLOAD_RETENTION_MAX_SECONDS,
  UPLOAD_URL_TTL_MAX_SECONDS,
  UPLOAD_URL_TTL_MIN_SECONDS,
  buildObjectKey,
  clampFileRetentionSeconds,
  clampUploadUrlTtl,
  isValidObjectKey,
  objectKeyToken,
  resolveUploadPolicy,
  validateUploadSize,
  verifyObjectKeyToken,
} from '../src/utils/uploadLimits.js';

const MB = 1024 * 1024;

test('batas per folder sama dengan kebijakan lama (plus overhead enkripsi)', () => {
  assert.deepEqual(resolveUploadPolicy('avatars', 'FREE'), {
    baseMaxBytes: 5 * MB,
    allowedMaxBytes: 5 * MB + ENCRYPTION_OVERHEAD_BYTES,
  });
  assert.equal(resolveUploadPolicy('groups', null).baseMaxBytes, 5 * MB);
  assert.equal(resolveUploadPolicy('attachments', 'FREE').baseMaxBytes, 100 * MB);
  assert.equal(resolveUploadPolicy('attachments', 'SUBSCRIBER').baseMaxBytes, 500 * MB);
  assert.equal(resolveUploadPolicy('misc', 'FREE').baseMaxBytes, 100 * MB);
  assert.equal(resolveUploadPolicy('burner', 'SUBSCRIBER').baseMaxBytes, 50 * MB);
});

test('fileSize wajib: kosong, nol, negatif, atau bukan angka ditolak', () => {
  const policy = resolveUploadPolicy('attachments', 'FREE');
  for (const raw of [undefined, null, '', 0, -1, 1.5, 'abc', Number.NaN]) {
    const verdict = validateUploadSize(raw, policy);
    assert.equal(verdict.ok, false, String(raw));
    assert.equal(verdict.ok === false && verdict.error, 'FILE_SIZE_REQUIRED', String(raw));
  }
});

test('fileSize dari body berbentuk string tetap diterima (form/JSON longgar)', () => {
  const policy = resolveUploadPolicy('avatars', 'FREE');
  const verdict = validateUploadSize('2048', policy);
  assert.deepEqual(verdict, { ok: true, size: 2048, maxMB: 5 });
});

test('tepat di batas diterima, satu byte lebih ditolak', () => {
  const policy = resolveUploadPolicy('attachments', 'FREE');
  assert.equal(validateUploadSize(policy.allowedMaxBytes, policy).ok, true);

  const over = validateUploadSize(policy.allowedMaxBytes + 1, policy);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.error, 'FILE_TOO_LARGE');
  assert.equal(over.ok === false && over.maxMB, 100);
});

/**
 * Bukti bahwa angkanya benar-benar MENGIKAT, bukan sekadar diperiksa di server:
 * `ContentLength` harus ikut ditandatangani, sehingga R2 sendiri yang menolak
 * body dengan panjang berbeda (klien "mengaku 1 byte lalu PUT 10 GB" gagal di
 * sisi storage, bukan lolos).
 */
test('ukuran yang disetujui ikut ditandatangani di presigned URL', async () => {
  // Kredensial palsu: yang diuji bentuk tanda tangannya, bukan koneksi ke R2.
  process.env.R2_ACCOUNT_ID ||= 'test-account';
  process.env.R2_ACCESS_KEY_ID ||= 'AKIATEST';
  process.env.R2_SECRET_ACCESS_KEY ||= 'test-secret';
  process.env.R2_BUCKET_NAME ||= 'nyx-test';

  const { getPresignedUploadUrl } = await import('../src/utils/r2.js');

  const sized = await getPresignedUploadUrl('attachments/x.bin', 'application/octet-stream', 300, 4096);
  const sizedHeaders = new URL(sized).searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.match(sizedHeaders, /(^|;)content-length(;|$)/, 'content-length ikut ditandatangani');
  assert.match(sizedHeaders, /content-type/, 'content-type tetap ditandatangani');

  // Tanpa angka dari server, batas ukuran tidak ada — karena itu route WAJIB
  // memberi `contentLength` (lihat `validateUploadSize`).
  const unsized = await getPresignedUploadUrl('attachments/x.bin', 'application/octet-stream', 300);
  const unsizedHeaders = new URL(unsized).searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.doesNotMatch(unsizedHeaders, /content-length/, 'presign tanpa batas tidak mengunci ukuran');
});

test('batas burner 50 MB dilaporkan untuk pesan error', () => {
  const policy = resolveUploadPolicy('burner', null);
  const verdict = validateUploadSize(60 * MB, policy);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.maxMB, 50);
});

// ============================================================================
// [AUDIT 2026-10-31 — F-06] TTL URL & retensi objek di-clamp.
// ============================================================================

test('urlTtl di-clamp ke [60 s, 15 mnt]', () => {
  assert.equal(clampUploadUrlTtl(1), UPLOAD_URL_TTL_MIN_SECONDS);
  assert.equal(clampUploadUrlTtl(31_536_000), UPLOAD_URL_TTL_MAX_SECONDS);
  assert.equal(clampUploadUrlTtl('120'), 120);
  assert.equal(clampUploadUrlTtl(undefined), 300, 'default tetap 5 menit');
  assert.equal(clampUploadUrlTtl('abc'), 300);
  assert.equal(clampUploadUrlTtl(Number.NaN), 300);
});

test('fileRetention dibatasi 30 hari dan nilai tak masuk akal jadi 0', () => {
  assert.equal(clampFileRetentionSeconds(60), 60);
  assert.equal(clampFileRetentionSeconds(365 * 24 * 60 * 60), UPLOAD_RETENTION_MAX_SECONDS);
  assert.equal(clampFileRetentionSeconds(0), 0);
  assert.equal(clampFileRetentionSeconds(-5), 0);
  assert.equal(clampFileRetentionSeconds('nope'), 0);
  assert.equal(clampFileRetentionSeconds(undefined), 0);
});

// ============================================================================
// [AUDIT 2026-10-31 — F-08] Key objek R2 harus utuh & milik pemanggil.
// ============================================================================

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const KEY = 'attachments/0f8fad5b-d9cb-469f-a165-70867728950e';
const SECRET = 'test-r2-key-secret';

test('[T2] key upload acak: tanpa userId dan tanpa ekstensi', () => {
  const key = buildObjectKey('attachments', USER);
  assert.equal(key, `attachments/${USER}`);
  // UUID murni: tidak ada titik (ekstensi) dan tidak ada userId lain selain uuid itu.
  assert.doesNotMatch(key.split('/')[1]!, /[.]/);
  const random = buildObjectKey('attachments');
  assert.match(random, /^attachments\/[0-9a-f-]{36}$/);
  assert.equal(isValidObjectKey(random), true);
});

test('bentuk key: folder dikenal + uuid, tanpa traversal/segmen liar/ekstensi', () => {
  assert.equal(isValidObjectKey(KEY), true);
  assert.equal(isValidObjectKey('burner/0f8fad5b-d9cb-469f-a165-70867728950e'), true);
  assert.equal(isValidObjectKey(`avatars/${USER}-abc.jpg`), false, 'format lama ber-ekstensi ditolak');
  assert.equal(isValidObjectKey('secrets/0f8fad5b-d9cb-469f-a165-70867728950e'), false);
  assert.equal(isValidObjectKey('attachments/../0f8fad5b-d9cb-469f-a165-70867728950e'), false);
  assert.equal(isValidObjectKey('attachments/x/0f8fad5b-d9cb-469f-a165-70867728950e'), false);
  assert.equal(isValidObjectKey('attachments/'), false);
  assert.equal(isValidObjectKey(42), false);
});

test('[T2] token HMAC: hanya pasangan (userId, key) penerbitnya yang lolos', () => {
  const token = objectKeyToken(USER, KEY, SECRET);
  assert.equal(verifyObjectKeyToken(USER, KEY, token, SECRET), true);
  assert.equal(verifyObjectKeyToken(OTHER, KEY, token, SECRET), false, 'user lain ditolak');
  assert.equal(verifyObjectKeyToken(USER, `${KEY}0`, token, SECRET), false, 'key lain ditolak');
  assert.equal(verifyObjectKeyToken(USER, KEY, undefined, SECRET), false, 'tanpa token ditolak');
  assert.equal(verifyObjectKeyToken(USER, KEY, 'x'.repeat(token.length), SECRET), false);
  assert.equal(verifyObjectKeyToken(USER, KEY, token, 'secret-lain'), false);
});
