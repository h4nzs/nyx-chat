// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 4] Limiter pencarian: per akun, fallback per IP.
 *
 * Yang dikunci:
 *  - akun berbeda → kunci berbeda (satu akun tidak bisa memborong jatah akun
 *    lain lewat IP yang sama, dan NAT/CGNAT tidak membuat akun saling blokir);
 *  - kunci TIDAK memuat userId/IP mentah (snapshot Redis bukan daftar pencari);
 *  - request tanpa `req.user` memakai tag IP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { searchRateKey } from '../src/utils/searchRateKey.js';
import { identityTag } from '../src/utils/redisIdentity.js';
import { clientIpTag } from '../src/utils/clientIp.js';

function fakeRequest(userId?: string, ip = '203.0.113.9'): Request {
  return {
    user: userId ? { id: userId } : undefined,
    headers: { 'cf-connecting-ip': ip },
    ip,
  } as unknown as Request;
}

test('[docs/35 Fase 4] searchRateKey: per akun, memakai HMAC bukan userId mentah', () => {
  const key = searchRateKey(fakeRequest('user-1'));
  assert.equal(key, identityTag('user-1'));
  assert.equal(key.includes('user-1'), false, 'userId mentah tidak boleh muncul di key Redis');
  assert.match(key, /^[a-f0-9]{64}$/);
});

test('[docs/35 Fase 4] searchRateKey: akun berbeda → kunci berbeda walau IP sama', () => {
  const a = searchRateKey(fakeRequest('user-1'));
  const b = searchRateKey(fakeRequest('user-2'));
  assert.notEqual(a, b);
});

test('[docs/35 Fase 4] searchRateKey: tanpa akun → tag IP (bukan alamat mentah)', () => {
  const req = fakeRequest(undefined);
  const key = searchRateKey(req);
  assert.equal(key, clientIpTag(req));
  assert.equal(key.includes('203.0.113.9'), false, 'IP mentah tidak boleh muncul di key Redis');
});
