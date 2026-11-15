// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.6] Seam endpoint object storage.
//
// Jalur sukses R2 (presign → PUT → HEAD → GET) tidak bisa diuji tanpa akun
// Cloudflare, jadi klien S3 harus bisa diarahkan ke MinIO lewat `R2_ENDPOINT`.
// Yang dikunci di sini adalah kontrak kecilnya: default produksi tetap R2,
// endpoint eksplisit menang, dan trailing slash dibuang (dengan
// `forcePathStyle: true`, `http://host/` + `/bucket` menghasilkan `//bucket`
// yang ditolak MinIO maupun R2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  resolveR2Endpoint,
  putR2Object,
  headR2Object,
  getPresignedDownloadUrl,
  getPresignedUploadUrl,
  deleteR2File
} from '../src/utils/r2.js';

test('tanpa R2_ENDPOINT: endpoint Cloudflare R2 dari account id', () => {
  assert.equal(
    resolveR2Endpoint({ r2Endpoint: '', r2AccountId: 'abc123' }),
    'https://abc123.r2.cloudflarestorage.com'
  );
});

test('R2_ENDPOINT eksplisit menang (MinIO)', () => {
  assert.equal(
    resolveR2Endpoint({ r2Endpoint: 'http://127.0.0.1:9000', r2AccountId: 'abc123' }),
    'http://127.0.0.1:9000'
  );
});

test('trailing slash dibuang supaya path-style tidak menghasilkan //bucket', () => {
  assert.equal(
    resolveR2Endpoint({ r2Endpoint: 'http://minio:9000///', r2AccountId: '' }),
    'http://minio:9000'
  );
});

test('spasi di sekitar nilai tidak ikut jadi endpoint', () => {
  assert.equal(
    resolveR2Endpoint({ r2Endpoint: '  http://minio:9000  ', r2AccountId: '' }),
    'http://minio:9000'
  );
});

// [docs/41 §6.6] Jalur sukses yang sesungguhnya, opt-in: presign → PUT → HEAD →
// GET → DELETE terhadap endpoint S3-compatible nyata (MinIO, rclone). Butuh `NYX_R2_SMOKE=1` plus
// `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
// di environment (dibaca saat modul `r2.ts` dimuat, jadi harus dari proses
// induk — bukan di-set di dalam test). Tanpa itu tes di-skip dengan alasan,
// bukan gagal, supaya `pnpm test` biasa tidak butuh MinIO.
const minioSmoke = process.env.NYX_R2_SMOKE === '1';

test('S3-compatible (MinIO/rclone): presign PUT/GET, HEAD, dan DELETE benar-benar bekerja', {
  skip: minioSmoke ? false : 'set NYX_R2_SMOKE=1 + R2_ENDPOINT/kredensial untuk menjalankan'
}, async () => {
  const key = `smoke/${randomUUID()}.txt`;
  const presignedKey = `smoke/${randomUUID()}-presigned.txt`;
  const body = 'nyx-r2-smoke';
  const contentType = 'text/plain';

  // MinIO tidak punya bucket default; R2 punya. Buat hanya bila diminta, supaya
  // menjalankan smoke terhadap akun R2 sungguhan tidak mencoba CreateBucket
  // (ditolak) — jalur itu cukup memakai bucket yang sudah ada.
  if (process.env.NYX_R2_SMOKE_CREATE_BUCKET === '1') {
    const { CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const { s3Client } = await import('../src/utils/r2.js');
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }));
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    }
  }

  try {
    await putR2Object(key, new TextEncoder().encode(body), contentType);
    assert.deepEqual(await headR2Object(key), { contentLength: body.length });

    const download = await fetch(await getPresignedDownloadUrl(key));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), body);

    // Presigned PUT mengikat content-length + content-type di signature.
    const uploadUrl = await getPresignedUploadUrl(presignedKey, contentType, 300, body.length);
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(await headR2Object(presignedKey), { contentLength: body.length });

    const uploaded = await fetch(await getPresignedDownloadUrl(presignedKey));
    assert.equal(await uploaded.text(), body);
  } finally {
    await deleteR2File(key);
    await deleteR2File(presignedKey);
  }

  assert.equal(await headR2Object(key), null);
  assert.equal(await headR2Object(presignedKey), null);
});
