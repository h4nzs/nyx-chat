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
  resolveUploadPolicy,
  validateUploadSize,
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
