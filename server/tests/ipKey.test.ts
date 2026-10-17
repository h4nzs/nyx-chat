import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ipKeyGenerator } from 'express-rate-limit';
import { cfAwareClientIp, clientIpTag } from '../src/utils/clientIp.js';
import { pepperedIdentifier } from '../src/utils/atRestSecrets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

// Fake request minimal — helper hanya butuh { headers, ip }.
const mkReq = (headers: Record<string, unknown>, ip?: string) =>
  ({ headers, ip }) as unknown as Parameters<typeof cfAwareClientIp>[0];

test('cfAwareClientIp: CF-Connecting-IP menang atas req.ip', () => {
  const req = mkReq({ 'cf-connecting-ip': '1.2.3.4' }, '5.6.7.8');
  assert.equal(cfAwareClientIp(req), '1.2.3.4');
});

test('cfAwareClientIp: fallback ke req.ip saat header tidak ada', () => {
  const req = mkReq({}, '10.0.0.7');
  assert.equal(cfAwareClientIp(req), '10.0.0.7');
});

test('cfAwareClientIp: "unknown" ketika keduanya absen', () => {
  const req = mkReq({});
  assert.equal(cfAwareClientIp(req), 'unknown');
});

test('cfAwareClientIp: header kosong/whitespace diabaikan', () => {
  assert.equal(cfAwareClientIp(mkReq({ 'cf-connecting-ip': '' }, '10.0.0.7')), '10.0.0.7');
  assert.equal(cfAwareClientIp(mkReq({ 'cf-connecting-ip': '   ' }, '10.0.0.7')), '10.0.0.7');
});

test('cfAwareClientIp: header bertipe array diabaikan (bukan string tunggal)', () => {
  const req = mkReq({ 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] }, '10.0.0.7');
  assert.equal(cfAwareClientIp(req), '10.0.0.7');
});

test('cfAwareClientIp: req.ip literal "unknown" diperlakukan sebagai absen', () => {
  const req = mkReq({}, 'unknown');
  assert.equal(cfAwareClientIp(req), 'unknown');
});

// ============================================================================
// [docs/30 §30.12 WS-H] Key Redis tidak boleh memuat alamat klien.
//
// `RedisStore` menulis `rl:<prefix>:<keyGenerator(req)>`, jadi keyGenerator yang
// mengembalikan IP = daftar alamat klien di snapshot Redis (bertentangan dengan
// kriteria audit WS-H "tidak ada IP di DB/Redis").
// ============================================================================

test('clientIpTag: tag HMAC pepper, tanpa alamat klien di dalamnya', () => {
  const req = mkReq({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.7');
  const tag = clientIpTag(req);

  assert.match(tag, /^[a-f0-9]{64}$/, 'HMAC-SHA256 hex');
  assert.ok(!tag.includes('203.0.113.7'), 'alamat CF tidak boleh ada di key');
  assert.ok(!tag.includes('10.0.0.7'), 'fallback req.ip juga tidak');

  // Deterministik → counter rate-limit tetap idempoten per klien; dan nilainya
  // persis HMAC pepper dari alamat yang SUDAH dinormalkan `ipKeyGenerator`
  // (normalisasi IPv6 bawaan library tidak hilang).
  assert.equal(tag, pepperedIdentifier(`clientip:${ipKeyGenerator('203.0.113.7')}`));
  assert.equal(clientIpTag(req), tag);
  assert.notEqual(clientIpTag(mkReq({ 'cf-connecting-ip': '203.0.113.8' })), tag);
});

test('clientIpTag: alamat tidak sah tetap satu tag yang stabil (tanpa lempar)', () => {
  const weird = mkReq({ 'cf-connecting-ip': 'bukan-ip' });
  assert.match(clientIpTag(weird), /^[a-f0-9]{64}$/);
  assert.equal(clientIpTag(weird), clientIpTag(weird));
});

test('wiring limiter: keyGenerator memakai clientIpTag, bukan IP mentah', () => {
  const limiter = read('../src/middleware/rateLimiter.ts');
  assert.match(limiter, /const secureKeyGenerator = \(req: Request\): string => clientIpTag\(req\)/);
  assert.doesNotMatch(limiter, /ipKeyGenerator\(cfAwareClientIp/);

  const app = read('../src/app.ts');
  assert.match(app, /keyGenerator: \(req\) => clientIpTag\(req\)/);
  assert.doesNotMatch(app, /ipKeyGenerator\(cfAwareClientIp/);

  // Satu-satunya tempat `ipKeyGenerator` boleh dipakai adalah di dalam
  // `clientIpTag` — dipakai lagi di luar itu berarti IP bisa bocor ke key baru.
  const clientIp = read('../src/utils/clientIp.ts');
  assert.match(clientIp, /export function clientIpTag\(req[\s\S]*ipKeyGenerator\(cfAwareClientIp\(req\)\)/);
});
