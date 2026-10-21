// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.7 poin 2] Entri log KT untuk perubahan
 * kunci identitas di luar registrasi & pemulihan.
 *
 * Yang diuji adalah kontrak yang membuat jalur rotasi aman **dan** terlihat:
 *
 *   1. **Kepemilikan identifier diverifikasi.** Identifier datang dari klien;
 *      tanpa verifikasi, siapa pun yang login bisa menulis entri ke search key
 *      akun lain (log adalah ruang publik). Uji: identifier milik akun lain →
 *      tidak ada penulisan + metrik `identifier_mismatch` (fail-visible).
 *   2. **Klien lama tidak menulis entri salah.** Tanpa identifier → dilewati
 *      dengan alasan `KT_IDENTIFIER_MISSING` + metrik `no_identifier`, bukan
 *      menulis search key kosong.
 *   3. **Nilai yang ditulis benar.** keyVersion = label rotasi, kunci yang masuk
 *      = material yang di-upload klien, dan hanya material publik.
 *   4. **Bukan rotasi = bukan entri.** `identityKeysChanged` menyaring upload
 *      bundle berulang (auto-heal/login normal) supaya log tidak dibanjiri entri
 *      identik.
 *   5. **Jalur route benar-benar memanggilnya** (guard sumber untuk tiga jalur
 *      yang menimpa `Device.publicKey`).
 *
 * Semua test di sini bebas infra: pembacaan identifier disuntik lewat
 * `lookupStoredIdentifier`, transport KT palsu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  KT_KEY_VERSION_RECOVERY,
  KT_KEY_VERSION_REGISTRATION,
  KT_KEY_VERSION_ROTATION,
  clearKtDedupeForTests,
  decodeKtValue,
} from '../src/utils/keyTransparency.js';
import { identityKeysChanged, publishIdentityKeyChange } from '../src/utils/ktIdentityLog.js';
import { pepperedIdentifier } from '../src/utils/atRestSecrets.js';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

/**
 * ⚠️ Test penulisan **live** hanya jalan dengan opt-in eksplisit.
 *
 * Jangan pernah kembali ke `skip: !process.env.KT_SERVER_URL`: `server/.env`
 * SELALU mengisi variabel itu dan `src/config.ts` memuat dotenv, jadi gate itu
 * membuat `pnpm test` menulis entri sungguhan ke log yang sedang dikonfigurasi.
 * Itu bukan hipotesis — 2026-10-17 dua entri uji ini masuk ke log self-host
 * (`127.0.0.1:8081`, `nyx-kt-query`) saat suite penuh dijalankan, dan log KT
 * bersifat append-only (tidak bisa dihapus).
 */
const KT_LIVE_WRITE =
  process.env.NYX_KT_LIVE_WRITE === '1' && Boolean(process.env.KT_SERVER_URL);

const USERNAME_HASH = new Uint8Array(32).fill(0x5a);
const USERNAME_HASH_B64 = Buffer.from(USERNAME_HASH).toString('base64url');
const IDENTITY_KEY = new Uint8Array(32).fill(0x11);
const SIGNING_KEY = new Uint8Array(32).fill(0x33);
const PQ_KEY = new Uint8Array(1216).fill(0x22);

/** Transport KT palsu: hitung panggilan + kembalikan respons kosong. */
function fakeTransport() {
  const state = { calls: 0, values: [] as Uint8Array[] };
  return {
    state,
    transport: {
      async update(request: Uint8Array) {
        state.calls++;
        // Field 2 = value (lihat encodeKtUpdateRequest).
        state.values.push(request);
        return new Uint8Array(0);
      },
    },
  };
}

/** Extract `value` dari protobuf UpdateRequest: field 2, length-delimited. */
function valueFromRequest(request: Uint8Array): Uint8Array {
  const getVarint = (offset: number): { value: number; next: number } => {
    let value = 0;
    let shift = 0;
    let index = offset;
    for (;;) {
      const byte = request[index++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return { value, next: index };
      shift += 7;
    }
  };
  let offset = 0;
  while (offset < request.length) {
    const key = getVarint(offset);
    const field = key.value >> 3;
    const wire = key.value & 0x7;
    offset = key.next;
    if (wire === 2) {
      const len = getVarint(offset);
      const payload = request.subarray(len.next, len.next + len.value);
      if (field === 2) return payload;
      offset = len.next + len.value;
    } else if (wire === 0) {
      offset = getVarint(offset).next;
    } else {
      throw new Error(`wire type ${wire} tidak didukung di test`);
    }
  }
  throw new Error('field value (2) tidak ditemukan');
}

const metricCount = (result: string): number => {
  const line = renderMetricsText()
    .split('\n')
    .find((l) => l.startsWith('nyx_kt_writes_total{') && l.includes(`result="${result}"`));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
};

test('label keyVersion: tiga alur berbeda, bukan angka yang sama di semua tempat', () => {
  assert.deepEqual(
    [KT_KEY_VERSION_REGISTRATION, KT_KEY_VERSION_RECOVERY, KT_KEY_VERSION_ROTATION],
    [1, 2, 3]
  );
});

test('rotasi: identifier milik akun lain ditolak + fail-visible (identifier_mismatch)', async () => {
  resetMetricsForTests();
  clearKtDedupeForTests();
  const { state, transport } = fakeTransport();

  const result = await publishIdentityKeyChange(
    {
      userId: 'user-a',
      usernameHash: USERNAME_HASH_B64,
      identityKey: IDENTITY_KEY,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
    },
    {
      transport,
      lookupStoredIdentifier: async () => 'hash-milik-akun-lain',
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'KT_IDENTIFIER_MISMATCH');
  assert.equal(state.calls, 0, 'tidak ada penulisan ke log');
  assert.equal(metricCount('identifier_mismatch'), 1, 'kejadiannya terlihat di metrik');
});

test('rotasi: identifier cocok → entri keyVersion rotasi, material publik saja', async () => {
  resetMetricsForTests();
  clearKtDedupeForTests();
  const { state, transport } = fakeTransport();

  const result = await publishIdentityKeyChange(
    {
      userId: 'user-a',
      usernameHash: USERNAME_HASH_B64,
      identityKey: IDENTITY_KEY,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
    },
    {
      transport,
      // Bentuk yang disimpan DB = ter-pepper (HMAC). [docs/35 Fase 4 — R5]
      // Kandidat lookup tidak lagi memuat nilai mentah, jadi fake ini WAJIB
      // mengembalikan bentuk tersimpan yang sebenarnya.
      lookupStoredIdentifier: async () => pepperedIdentifier(USERNAME_HASH_B64),
    }
  );

  assert.equal(result.ok, true, `penulisan gagal: ${result.reason ?? 'unknown'}`);
  assert.equal(state.calls, 1);

  const value = decodeKtValue(valueFromRequest(state.values[0]!));
  assert.equal(value.keyVersion, KT_KEY_VERSION_ROTATION, 'label rotasi, bukan 1/2');
  assert.deepEqual([...value.identityKey], [...IDENTITY_KEY]);
  assert.deepEqual([...value.pqIdentityKey], [...PQ_KEY]);
  assert.deepEqual([...value.signingKey], [...SIGNING_KEY]);
  assert.ok(value.updatedAtDay > 20_000, 'bucket harian (bukan 0 dan bukan epoch detik)');
  assert.equal(metricCount('ok'), 1);
});

test('rotasi: tanpa identifier (klien lama) dilewati dengan alasan yang bisa dibedakan', async () => {
  resetMetricsForTests();
  clearKtDedupeForTests();
  const { state, transport } = fakeTransport();

  const result = await publishIdentityKeyChange(
    { userId: 'user-a', identityKey: IDENTITY_KEY, pqIdentityKey: PQ_KEY, signingKey: SIGNING_KEY },
    { transport, lookupStoredIdentifier: async () => pepperedIdentifier(USERNAME_HASH_B64) }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'KT_IDENTIFIER_MISSING');
  assert.equal(state.calls, 0);
  assert.equal(metricCount('no_identifier'), 1);
});

test('rotasi: kunci wajib tidak lengkap → invalid (tidak menulis nilai yang salah)', async () => {
  resetMetricsForTests();
  clearKtDedupeForTests();
  const { state, transport } = fakeTransport();

  const result = await publishIdentityKeyChange(
    { userId: 'user-a', usernameHash: USERNAME_HASH_B64, identityKey: IDENTITY_KEY, signingKey: null },
    { transport, lookupStoredIdentifier: async () => USERNAME_HASH_B64 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'IDENTITY_KEYS_MISSING');
  assert.equal(state.calls, 0);
  assert.equal(metricCount('invalid'), 1);
});

test('rotasi: tanpa KT_SERVER_URL/KT_V2_SERVER_URL dan tanpa transport → no-op (bukan error)', async () => {
  clearKtDedupeForTests();
  const saved = process.env.KT_SERVER_URL;
  const savedV2 = process.env.KT_V2_SERVER_URL;
  delete process.env.KT_SERVER_URL;
  delete process.env.KT_V2_SERVER_URL;
  try {
    const result = await publishIdentityKeyChange({
      userId: 'user-a',
      usernameHash: USERNAME_HASH_B64,
      identityKey: IDENTITY_KEY,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
    });
    assert.deepEqual(result, { ok: false, skipped: 'DISABLED' });
  } finally {
    if (saved !== undefined) process.env.KT_SERVER_URL = saved;
    if (savedV2 !== undefined) process.env.KT_V2_SERVER_URL = savedV2;
  }
});

test('identityKeysChanged: upload ulang yang sama bukan rotasi', () => {
  const before = { publicKey: IDENTITY_KEY, signingKey: SIGNING_KEY };
  assert.equal(
    identityKeysChanged(before, { identityKey: IDENTITY_KEY, signingKey: SIGNING_KEY }),
    false,
    'material identik → tidak ada entri log'
  );
  assert.equal(
    identityKeysChanged(before, { identityKey: new Uint8Array(32).fill(0x44), signingKey: SIGNING_KEY }),
    true,
    'kunci identitas berubah'
  );
  assert.equal(
    identityKeysChanged(before, { identityKey: IDENTITY_KEY, signingKey: new Uint8Array(32).fill(0x44) }),
    true,
    'kunci tanda tangan berubah'
  );
  assert.equal(
    identityKeysChanged(null, { identityKey: IDENTITY_KEY, signingKey: SIGNING_KEY }),
    true,
    'belum ada identitas tercatat → entri pertama'
  );
});

/**
 * Jalur hidup (opt-in): entri rotasi benar-benar masuk ke binary Go
 * `key-transparency-server`. Ini yang membuktikan "tercatat" bukan sekadar
 * "fungsi dipanggil": framing gRPC + nilai v1 + search key harus diterima
 * server upstream apa adanya.
 */
test('live: entri rotasi masuk ke binary KT (opt-in NYX_KT_LIVE_WRITE=1)', { skip: !KT_LIVE_WRITE }, async () => {
  clearKtDedupeForTests();
  // Search key acak per jalan (32 byte) supaya tiap run menambah entri baru.
  const hash = new Uint8Array(32);
  for (let i = 0; i < hash.length; i++) hash[i] = (i * 13 + (Date.now() % 251)) & 0xff;
  const usernameHash = Buffer.from(hash).toString('base64url');
  const rotated = new Uint8Array(32).fill(0x77);

  const result = await publishIdentityKeyChange(
    {
      userId: 'user-a',
      usernameHash,
      identityKey: rotated,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
    },
    { lookupStoredIdentifier: async () => pepperedIdentifier(usernameHash) }
  );

  assert.equal(result.ok, true, `penulisan rotasi gagal: ${result.reason ?? 'unknown'}`);
  assert.ok(result.treeSize !== null && result.treeSize >= 1n, 'ukuran pohon bertambah');
});

/**
 * Guard sumber: tiga jalur yang menimpa `Device.publicKey` harus memanggil
 * penulis rotasi (bukan hanya mencatat niat di dokumen), dan panggilannya
 * fire-and-forget (`void`) supaya log tidak menahan respons.
 */
/**
 * Guard: tidak ada test penulisan live yang boleh ikut jalan hanya karena
 * `KT_SERVER_URL` ada. Gate-nya harus opt-in eksplisit (`NYX_KT_LIVE_WRITE`),
 * kalau tidak `pnpm test` akan menulis ke log yang dikonfigurasi di `.env`.
 */
test('guard: penulisan live hanya dengan opt-in eksplisit', () => {
  for (const file of ['ktIdentityLog.test.ts', 'keyTransparency.test.ts'] as const) {
    const source = read(file);
    assert.match(source, /skip: !KT_LIVE_WRITE/, `${file}: gate = opt-in eksplisit`);
    assert.doesNotMatch(
      source,
      /\{ skip: !process\.env\.KT_SERVER_URL \}/,
      `${file}: jangan gate hanya dari KT_SERVER_URL (server/.env mengisinya)`
    );
  }
});

test('wiring: tiga jalur rotasi memanggil penulis log (fire-and-forget)', () => {
  const routes: Array<[string, string]> = [
    ['../src/routes/auth.ts', 'login (re-sync kunci lokal)'],
    ['../src/routes/keys.ts', 'POST /keys/prekey-bundle'],
    ['../src/routes/users.ts', 'PUT /users/me/keys'],
  ];

  for (const [file, label] of routes) {
    const source = read(file);
    assert.match(source, /publishIdentityKeyChange\(/, `${file}: ${label} harus menulis entri log`);
    assert.match(source, /void publishIdentityKeyChange\(/, `${file}: ${label} harus fire-and-forget`);
    assert.match(source, /identityKeysChanged\(/, `${file}: ${label} harus menyaring upload ulang`);
    assert.doesNotMatch(
      source,
      /await publishIdentityKeyChange\(/,
      `${file}: ${label} tidak boleh menahan respons`
    );
  }
});
