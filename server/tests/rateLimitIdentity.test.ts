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
