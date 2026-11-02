// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit N8-02] Trafik OHTTP berbagi satu bucket rate-limit.
 *
 * Gateway meneruskan request ke API lewat loopback, jadi `req.ip` = `127.0.0.1`
 * untuk SEMUA pengguna OHTTP. Sebelum perbaikan, `generalLimiter` (300/15 menit)
 * memakai satu tag IP bersama: satu klien yang memverifikasi banyak kontak bisa
 * menghabiskannya dan memblokir pengguna OHTTP lain (termasuk group sync & KT).
 *
 * Perbaikan: kunci limiter memakai subjek token OHTTP (JWT ber-`scope: 'ohttp'`)
 * yang sudah bertanda tangan, sehingga satu akun = satu bucket. Token sesi biasa,
 * token rusak, atau request tanpa token tetap memakai tag IP seperti sebelumnya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clientIpTag, clientRateLimitTag, ohttpTokenSubjectTag } from '../src/utils/clientIp.js';
import {
  OHTTP_CLIENT_TAG_HEADER,
  OHTTP_INTERNAL_HEADER,
  classifyOhttpClientTag,
  relayClientTag,
  setOhttpInternalToken,
} from '../src/ohttp/clientTag.js';
import { OHTTP_CLIENT_TAG, incCounter, renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';
import { signOhttpToken } from '../src/utils/ohttpToken.js';
import { signAccessToken } from '../src/utils/jwt.js';

const ip = (address: string) => ({ headers: {}, ip: address }) as never;
const ipWithAuth = (address: string, authorization: string) =>
  ({ headers: { authorization }, ip: address }) as never;

test('dua token OHTTP berbeda (IP loopback sama) → bucket berbeda', () => {
  const tokenA = signOhttpToken({ userId: 'user-a', jti: 'a' });
  const tokenB = signOhttpToken({ userId: 'user-b', jti: 'b' });

  const tagA = clientRateLimitTag(ipWithAuth('127.0.0.1', `Bearer ${tokenA}`));
  const tagB = clientRateLimitTag(ipWithAuth('127.0.0.1', `Bearer ${tokenB}`));

  assert.notEqual(tagA, tagB);
  // Tag adalah HMAC pepper, bukan id mentah (snapshot Redis tidak boleh memuatnya).
  assert.equal(tagA.length, 64);
  assert.ok(!tagA.includes('user-a'));
});

test('token OHTTP yang sama dari IP berbeda tetap satu bucket (per akun)', () => {
  const token = signOhttpToken({ userId: 'user-a', jti: 'a' });
  const fromCf = clientRateLimitTag({
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '203.0.113.7' },
    ip: '127.0.0.1',
  } as never);
  const fromOther = clientRateLimitTag({
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '198.51.100.9' },
    ip: '127.0.0.1',
  } as never);
  assert.equal(fromCf, fromOther);
});

test('token sesi biasa dan token rusak jatuh ke tag IP', () => {
  const sessionToken = signAccessToken({ id: 'user-a', scope: 'session' }, { expiresIn: '5m' });
  assert.equal(ohttpTokenSubjectTag(ipWithAuth('127.0.0.1', `Bearer ${sessionToken}`)), undefined);
  assert.equal(
    clientRateLimitTag(ipWithAuth('127.0.0.1', `Bearer ${sessionToken}`)),
    clientIpTag(ip('127.0.0.1'))
  );

  assert.equal(clientRateLimitTag(ipWithAuth('127.0.0.1', 'Bearer bukan-jwt')), clientIpTag(ip('127.0.0.1')));
  assert.equal(clientRateLimitTag(ip('127.0.0.1')), clientIpTag(ip('127.0.0.1')));
});

test('trafik non-OHTTP tetap dibedakan per IP', () => {
  assert.notEqual(clientRateLimitTag(ip('203.0.113.7')), clientRateLimitTag(ip('198.51.100.9')));
});

// [audit N9-01] Jalur bukti KT sengaja tanpa token (N7-01), jadi subjek token
// OHTTP tidak tersedia dan semua klien berbagi tag `127.0.0.1`. Relay — satu-
// satunya pihak yang melihat alamat klien — kini menandatangani tag per klien.
const INTERNAL = 'i'.repeat(48);

const relayRequest = (tag: string, internal = INTERNAL, address = '127.0.0.1') =>
  ({
    headers: { [OHTTP_INTERNAL_HEADER]: internal, [OHTTP_CLIENT_TAG_HEADER]: tag },
    ip: address,
  }) as never;

test('[N9-01] dua klien relay berbeda (IP loopback sama) → bucket berbeda', () => {
  setOhttpInternalToken(INTERNAL);
  try {
    const tagA = relayClientTag(INTERNAL, '203.0.113.7');
    const tagB = relayClientTag(INTERNAL, '198.51.100.9');
    assert.notEqual(tagA, tagB);

    const bucketA = clientRateLimitTag(relayRequest(tagA));
    const bucketB = clientRateLimitTag(relayRequest(tagB));
    assert.notEqual(bucketA, bucketB);
    // Tag relay bukan IP, dan tag yang masuk Redis sudah di-pepper lagi.
    assert.notEqual(bucketA, clientIpTag(ip('127.0.0.1')));
    assert.equal(bucketA.length, 64);
    assert.ok(!bucketA.includes(tagA));

    // Klien yang sama tetap satu bucket lintas request.
    assert.equal(clientRateLimitTag(relayRequest(tagA)), bucketA);
  } finally {
    setOhttpInternalToken(undefined);
  }
});

test('[N9-01] tag tanpa token internal yang sah TIDAK dipercaya (fallback IP)', () => {
  setOhttpInternalToken(INTERNAL);
  try {
    const tag = relayClientTag(INTERNAL, '203.0.113.7');
    // Tanpa token internal: header tag dari gateway langsung tidak boleh dipakai,
    // kalau tidak penyerang cukup mengarang tag baru untuk bucket tanpa batas.
    assert.equal(
      clientRateLimitTag({ headers: { [OHTTP_CLIENT_TAG_HEADER]: tag }, ip: '127.0.0.1' } as never),
      clientIpTag(ip('127.0.0.1'))
    );
    assert.equal(
      clientRateLimitTag(relayRequest(tag, 'x'.repeat(48))),
      clientIpTag(ip('127.0.0.1'))
    );
  } finally {
    setOhttpInternalToken(undefined);
  }

  // Proses API tanpa token (mode `on` tanpa OHTTP_INTERNAL_TOKEN) juga tidak
  // mempercayai tag apa pun — perilakunya sama seperti sebelum N9-01.
  const tag = relayClientTag(INTERNAL, '203.0.113.7');
  assert.equal(clientRateLimitTag(relayRequest(tag)), clientIpTag(ip('127.0.0.1')));
});

// [audit N9-01] Status tag harus terlihat di Prometheus: relay sengaja tidak
// mencatat apa pun, jadi tanpa metrik ini "token belum diset di salah satu
// proses" hanya tampak sebagai `unavailable` + backoff di klien.
test('[N9-01] metrik nyx_ohttp_client_tag_total membedakan empat keadaan', () => {
  resetMetricsForTests();

  setOhttpInternalToken(undefined);
  assert.equal(classifyOhttpClientTag({ headers: {} } as never), 'no-token');

  setOhttpInternalToken(INTERNAL);
  try {
    assert.equal(classifyOhttpClientTag({ headers: {} } as never), 'untagged');
    assert.equal(
      classifyOhttpClientTag(relayRequest(relayClientTag(INTERNAL, '203.0.113.7'))),
      'tagged'
    );
    // Token yang tidak cocok / tag yang dikarang lewat gateway langsung.
    assert.equal(classifyOhttpClientTag(relayRequest('tag-palsu', 'x'.repeat(48))), 'untrusted');
    incCounter(OHTTP_CLIENT_TAG, { status: 'tagged' });
    incCounter(OHTTP_CLIENT_TAG, { status: 'untagged' });
    incCounter(OHTTP_CLIENT_TAG, { status: 'untrusted' });
  } finally {
    setOhttpInternalToken(undefined);
  }

  // Keadaan operasi yang perlu terlihat: token kosong di proses API.
  incCounter(OHTTP_CLIENT_TAG, { status: classifyOhttpClientTag({ headers: {} } as never) });

  const text = renderMetricsText();
  for (const status of ['tagged', 'untagged', 'untrusted', 'no-token']) {
    assert.match(text, new RegExp(`nyx_ohttp_client_tag_total\\{status="${status}"\\} 1`));
  }
  // Nilai tag relay tidak boleh ikut ter-ekspos.
  assert.ok(!text.includes(relayClientTag(INTERNAL, '203.0.113.7')));
});
