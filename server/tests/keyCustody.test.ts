// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P6] Custody kunci at-rest — kontrak provider env/file.
 *
 * Yang dikunci di sini: urutan sumber (env menang atas file), file yang hilang
 * tidak melempar (pemanggil yang memutuskan fatal/tidak), dan status untuk
 * admin tidak pernah memuat materi rahasia.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { custodyStatus, readCustodySecret } from '../src/utils/keyCustody.js';

const ENV_VAR = 'NYX_TEST_CUSTODY_SECRET';
const FILE_VAR = 'NYX_TEST_CUSTODY_FILE';

function withCustodyEnv<T>(env: string | undefined, file: string | undefined, fn: () => T): T {
  const prevEnv = process.env[ENV_VAR];
  const prevFile = process.env[FILE_VAR];
  if (env === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = env;
  if (file === undefined) delete process.env[FILE_VAR];
  else process.env[FILE_VAR] = file;
  try {
    return fn();
  } finally {
    if (prevEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnv;
    if (prevFile === undefined) delete process.env[FILE_VAR];
    else process.env[FILE_VAR] = prevFile;
  }
}

const opts = { envVar: ENV_VAR, fileVar: FILE_VAR };

test('custody: env dipakai lebih dulu, lalu file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nyx-custody-'));
  const file = path.join(dir, 'keyring.json');
  writeFileSync(file, '{"active":"k1"}', { mode: 0o600 });

  try {
    const fromEnv = withCustodyEnv('  {"active":"env"}  ', file, () => readCustodySecret(opts));
    assert.equal(fromEnv.provider, 'env');
    assert.equal(fromEnv.source, ENV_VAR);
    assert.equal(fromEnv.material, '{"active":"env"}', 'materi di-trim');

    const fromFile = withCustodyEnv(undefined, file, () => readCustodySecret(opts));
    assert.equal(fromFile.provider, 'file');
    assert.equal(fromFile.source, file, 'sumber dilaporkan sebagai path (bukan rahasia)');
    assert.equal(fromFile.material, '{"active":"k1"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custody: tidak dikonfigurasi / file hilang = "none" tanpa melempar', () => {
  const none = withCustodyEnv(undefined, undefined, () => readCustodySecret(opts));
  assert.deepEqual(none, { material: null, provider: 'none', source: null });

  const missing = withCustodyEnv(undefined, '/tmp/nyx-custody-tidak-ada.json', () => readCustodySecret(opts));
  assert.equal(missing.provider, 'none');
  assert.equal(missing.material, null);

  const emptyEnv = withCustodyEnv('   ', undefined, () => readCustodySecret(opts));
  assert.equal(emptyEnv.provider, 'none', 'env kosong tidak dianggap terkonfigurasi');
});

test('custody: file kosong tidak dianggap terkonfigurasi', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nyx-custody-'));
  const file = path.join(dir, 'kosong.json');
  writeFileSync(file, '\n  \n', { mode: 0o600 });
  try {
    const read = withCustodyEnv(undefined, file, () => readCustodySecret(opts));
    assert.equal(read.provider, 'none');
    assert.equal(read.material, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custody: status hanya menyebut ada/tidak + sumber, bukan materinya', () => {
  const status = withCustodyEnv('materi-super-rahasia-1234', undefined, () => custodyStatus(opts));
  assert.deepEqual(status, { provider: 'env', configured: true, source: ENV_VAR });
  assert.doesNotMatch(JSON.stringify(status), /materi-super-rahasia/, 'nilai rahasia tidak pernah keluar');
});
