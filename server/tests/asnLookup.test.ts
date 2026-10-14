// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Tabel prefix→ASN lokal (tanpa layanan pihak ketiga).
 *
 * Properti yang dikunci:
 *   1. Parser toleran terhadap header CSV GeoLite2, kutip, komentar, dan baris
 *      rusak — baris rusak dilewati, tidak pernah menghasilkan rentang sampah.
 *   2. Pencocokan memakai **longest prefix** (tabel boleh tumpang tindih).
 *   3. Batas rentang benar (host bits di-mask), sehingga IP di luar prefix tidak
 *      ikut tertarik.
 *   4. IPv4 dan IPv6 sama-sama didukung; IP tidak sah → `null` (lapisan ASN
 *      dilewati, bukan salah klasifikasi).
 *   5. Berkas tidak ada/kosong → `null` (fail-open).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  asnIndexFromEnv,
  buildAsnIndex,
  clearAsnCacheForTests,
  loadAsnIndex,
  lookupAsn,
  parseAsnPrefix,
  parseAsnTable,
  parseIp,
} from '../src/utils/asnLookup.js';

const FIXTURE = `
# tabel uji
network,autonomous_system_number,autonomous_system_organization
1.0.0.0/8,100,"Operator Delapan"
1.0.0.0/24,200,"Operator Dua Ratus"
1.1.0.0/16,13335,"Cloudflare"
203.0.113.0/24,64500,"Test Net"
2001:db8::/32,64501,"Test Net v6"
baris-rusak-tanpa-koma
9.9.9.9/33,999,"Prefix Tidak Sah"
10.0.0.0/8,bukan-angka,"Header palsu"

`;

test('parseAsnTable: header/kutip/komentar/baris rusak dilewati', () => {
  const ranges = parseAsnTable(FIXTURE);
  // 4 IPv4 + 1 IPv6; header, komentar, baris tanpa koma, prefix /33, dan ASN
  // non-angka semuanya dibuang.
  assert.equal(ranges.length, 5);
  assert.deepEqual(
    ranges.map((r) => r.asn).sort(),
    ['100', '13335', '200', '64500', '64501']
  );
  assert.equal(parseAsnTable('').length, 0);
});

test('parseAsnPrefix: host bits di-mask', () => {
  const v4 = parseAsnPrefix('1.1.2.3/16', '7');
  assert.ok(v4);
  assert.equal(v4!.family, 4);
  assert.equal(v4!.bits, 16);
  assert.deepEqual([v4!.start, v4!.end], [parseIp('1.1.0.0')!.value, parseIp('1.1.255.255')!.value]);

  const v6 = parseAsnPrefix('2001:db8::1/32', '7');
  assert.ok(v6);
  assert.equal(v6!.family, 6);
  assert.deepEqual([v6!.start, v6!.end], [parseIp('2001:db8::')!.value, parseIp('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff')!.value]);

  assert.equal(parseAsnPrefix('1.1.1.0', '1'), null); // tanpa /bits
  assert.equal(parseAsnPrefix('1.1.1.0/33', '1'), null);
  assert.equal(parseAsnPrefix('bukan-ip/24', '1'), null);
  assert.equal(parseAsnPrefix('2001:db8::/129', '1'), null);
});

test('lookupAsn: longest prefix menang', () => {
  const index = buildAsnIndex(parseAsnTable(FIXTURE));

  assert.equal(lookupAsn(index, '1.0.0.5'), '200');
  assert.equal(lookupAsn(index, '1.0.0.255'), '200');
  assert.equal(lookupAsn(index, '1.0.1.5'), '100');
  assert.equal(lookupAsn(index, '1.1.200.7'), '13335');
  assert.equal(lookupAsn(index, '1.2.3.4'), '100', 'di luar /24 dan /16 hanya lapisan /8 yang cocok');
  assert.equal(lookupAsn(index, '203.0.113.55'), '64500');
  assert.equal(lookupAsn(index, '2001:db8:1::5'), '64501');

  // Di luar semua prefix → null (lapisan ASN dilewati).
  assert.equal(lookupAsn(index, '8.8.8.8'), null);
  assert.equal(lookupAsn(index, '2001:db9::1'), null);
  assert.equal(lookupAsn(null, '1.0.0.5'), null);
});

test('lookupAsn: IP tidak sah → null (bukan salah klasifikasi)', () => {
  const index = buildAsnIndex(parseAsnTable(FIXTURE));
  for (const bad of ['', 'banana', '999.1.1.1', '1.2.3', '1.2.3.4.5', '::gg', '1.2.3.4:80', 'unknown']) {
    assert.equal(lookupAsn(index, bad), null, `"${bad}" harus null`);
    assert.equal(parseIp(bad), null);
  }
});

test('lookupAsn: tumpang tindih pada panjang prefix yang sama tetap cocok', () => {
  const index = buildAsnIndex([
    { family: 4, bits: 24, start: parseIp('10.0.0.0')!.value, end: parseIp('10.0.0.255')!.value, asn: '1' },
    { family: 4, bits: 24, start: parseIp('10.0.1.0')!.value, end: parseIp('10.0.1.255')!.value, asn: '2' },
  ]);
  assert.equal(lookupAsn(index, '10.0.1.42'), '2');
  assert.equal(lookupAsn(index, '10.0.0.42'), '1');
});

test('loadAsnIndex: berkas hilang → null, berkas sah → indeks', () => {
  assert.equal(loadAsnIndex(undefined), null);
  assert.equal(loadAsnIndex('/tidak/ada/berkas-asn.csv'), null);

  const dir = mkdtempSync(join(tmpdir(), 'nyx-asn-'));
  try {
    const empty = join(dir, 'kosong.csv');
    writeFileSync(empty, '# hanya komentar\n');
    assert.equal(loadAsnIndex(empty), null, 'tabel kosong = lapisan nonaktif');

    const file = join(dir, 'asn.csv');
    writeFileSync(file, '198.51.100.0/24,64496\n');
    const index = loadAsnIndex(file);
    assert.ok(index);
    assert.equal(lookupAsn(index, '198.51.100.9'), '64496');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asnIndexFromEnv: cache mengikuti ASN_DB_FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-asn-env-'));
  const previous = process.env.ASN_DB_FILE;
  try {
    const file = join(dir, 'asn.csv');
    writeFileSync(file, '192.0.2.0/24,64511\n');

    clearAsnCacheForTests();
    process.env.ASN_DB_FILE = file;
    assert.equal(lookupAsn(asnIndexFromEnv(), '192.0.2.7'), '64511');

    // Cache: panggilan kedua memakai indeks yang sama (tidak membaca ulang).
    const first = asnIndexFromEnv();
    assert.equal(asnIndexFromEnv(), first);

    // Path berubah → cache dibuang.
    process.env.ASN_DB_FILE = join(dir, 'tidak-ada.csv');
    assert.equal(asnIndexFromEnv(), null);

    delete process.env.ASN_DB_FILE;
    clearAsnCacheForTests();
    assert.equal(asnIndexFromEnv(), null);
  } finally {
    if (previous === undefined) delete process.env.ASN_DB_FILE;
    else process.env.ASN_DB_FILE = previous;
    clearAsnCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
