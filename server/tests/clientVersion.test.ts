/**
 * [R2 2026-10-15] Uji gerbang versi klien minimum.
 *
 * Kenapa ini penting diuji: gerbang yang salah bisa **mematikan** basis pengguna
 * yang sudah ada (menolak klien yang sah), sedangkan gerbang yang terlalu lunak
 * membiarkan klien tua kehilangan kunci grup tanpa pesan — dua kegagalan yang
 * berlawanan arah. Karena itu yang diuji bukan hanya "versi tua ditolak", tetapi
 * juga dua kelonggaran yang disengaja: tanpa `MIN_CLIENT_VERSION` (mati) dan
 * tanpa header (lolos, karena klien prapenanda-versi tidak mengirimnya).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  compareClientVersions,
  clientVersionRejectionMessage,
  evaluateClientVersion,
  parseClientVersion,
} from '../src/utils/clientVersion.js';
import { CLIENT_VERSION_HEADER, clientVersionGate } from '../src/middleware/clientVersion.js';

test('parseClientVersion: bentuk yang lazim diurai, yang tidak masuk akal ditolak', () => {
  assert.equal(parseClientVersion('3.0.0')?.normalized, '3.0.0');
  assert.equal(parseClientVersion(' v3.0.0 ')?.normalized, '3.0.0');
  assert.equal(parseClientVersion('web/3.1.2')?.normalized, '3.1.2');
  assert.equal(parseClientVersion('3.1.2+build.7')?.normalized, '3.1.2');
  assert.equal(parseClientVersion('3.1.2-beta.1')?.normalized, '3.1.2');
  // Bagian yang hilang = 0 (klien yang hanya menyebut "3" tetap bisa diputuskan).
  assert.equal(parseClientVersion('3')?.normalized, '3.0.0');
  assert.equal(parseClientVersion('3.1')?.normalized, '3.1.0');

  // Bukan versi → null (jangan diterjemahkan menjadi "paling tua").
  for (const bad of ['', '   ', 'nyx', 'latest', 'v', '..', '3.0.0.0.0', 'x'.repeat(80)]) {
    assert.equal(parseClientVersion(bad), null, `"${bad}" harus null`);
  }
  assert.equal(parseClientVersion(undefined), null);
  assert.equal(parseClientVersion(null), null);
});

test('compareClientVersions: urutan numerik, bukan leksikografis', () => {
  assert.equal(compareClientVersions('3.0.0', '3.0.0'), 0);
  assert.equal(compareClientVersions('3.0.0', '3.0.1'), -1);
  assert.equal(compareClientVersions('3.1.0', '3.0.9'), 1);
  // Jebakan klasik "10 < 9" bila dibandingkan sebagai string.
  assert.equal(compareClientVersions('3.10.0', '3.9.0'), 1);
  assert.equal(compareClientVersions('4.0.0', '3.99.99'), 1);
  assert.equal(compareClientVersions('3.0', '3.0.0'), 0);
  assert.equal(compareClientVersions('bukan-versi', '3.0.0'), null);
});

test('evaluateClientVersion: gerbang MATI bila minimum tidak diset / tidak masuk akal', () => {
  for (const minimumVersion of [undefined, '', '   ', 'latest']) {
    for (const header of [undefined, '0.0.1', '3.0.0']) {
      const decision = evaluateClientVersion(header, { minimumVersion });
      assert.equal(decision.ok, true);
      assert.equal(decision.reason, 'no-minimum');
    }
  }
});

test('evaluateClientVersion: klien tanpa header versi LOLOS (transisi dari klien lama)', () => {
  for (const header of [undefined, '', 'bukan-versi', 42 as unknown]) {
    const decision = evaluateClientVersion(header, { minimumVersion: '3.0.0' });
    assert.equal(decision.ok, true);
    assert.equal(decision.reason, 'no-header');
    assert.equal(decision.minimumVersion, '3.0.0');
  }
});

test('evaluateClientVersion: klien di bawah minimum DITOLAK, minimum ke atas LOLOS', () => {
  const policy = { minimumVersion: '3.1.0' };

  const old = evaluateClientVersion('3.0.0', policy);
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'too-old');
  assert.equal(old.clientVersion, '3.0.0');
  assert.equal(old.minimumVersion, '3.1.0');

  assert.equal(evaluateClientVersion('web/3.1.0', policy).ok, true);
  assert.equal(evaluateClientVersion('3.2.0', policy).reason, 'ok');
  // Versi minimum itu sendiri harus lolos (batasnya inklusif).
  assert.equal(evaluateClientVersion('3.1', policy).ok, true);
  // Prarilis dari versi minimum tetap = versi minimum.
  assert.equal(evaluateClientVersion('3.1.0-rc.1', policy).ok, true);
});

test('clientVersionRejectionMessage: menyebut versi aktual + minimum, dan langkah yang bisa dilakukan', () => {
  const message = clientVersionRejectionMessage({
    ok: false,
    reason: 'too-old',
    clientVersion: '3.0.0',
    minimumVersion: '3.1.0',
  });
  assert.match(message, /3\.0\.0/);
  assert.match(message, /3\.1\.0/);
  assert.match(message, /Muat ulang/i);
});

// --- Middleware: pemasangan ke Express -------------------------------------

interface FakeResponse {
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
}

function makeRes(): FakeResponse {
  const res: FakeResponse = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function runGate(
  req: { path: string; method?: string; originalUrl?: string; headers: Record<string, unknown> },
  minimumVersion: string | undefined
): { nextCalled: boolean; res: FakeResponse } {
  const gate = clientVersionGate(() => ({ minimumVersion }));
  const res = makeRes();
  let nextCalled = false;
  gate(
    { ...req, method: req.method ?? 'GET', originalUrl: req.originalUrl ?? req.path } as never,
    res as never,
    () => { nextCalled = true; }
  );
  return { nextCalled, res };
}

test('middleware: klien terlalu tua → 426 CLIENT_TOO_OLD (bukan 403) dan tidak meneruskan', () => {
  const { nextCalled, res } = runGate(
    { path: '/messages', headers: { [CLIENT_VERSION_HEADER]: '2.9.0' } },
    '3.0.0'
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 426);
  const body = res.body as { error: string; minimumVersion: string; clientVersion: string };
  assert.equal(body.error, 'CLIENT_TOO_OLD');
  assert.equal(body.minimumVersion, '3.0.0');
  assert.equal(body.clientVersion, '2.9.0');
});

test('middleware: klien cukup baru / tanpa header / tanpa minimum → diteruskan', () => {
  assert.equal(runGate({ path: '/messages', headers: { [CLIENT_VERSION_HEADER]: '3.0.0' } }, '3.0.0').nextCalled, true);
  assert.equal(runGate({ path: '/messages', headers: {} }, '3.0.0').nextCalled, true);
  assert.equal(runGate({ path: '/messages', headers: { [CLIENT_VERSION_HEADER]: '1.0.0' } }, undefined).nextCalled, true);
});

test('middleware: /health tidak pernah digerbang (probe harus tetap bisa memanggil)', () => {
  const { nextCalled, res } = runGate({ path: '/health', headers: {} }, '99.0.0');
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
  // Endpoint admin/cleanup dipanggil alat ops (curl) tanpa header versi → lolos
  // lewat jalur `no-header`, jadi operasi pemeliharaan tidak ikut terkunci.
  assert.equal(runGate({ path: '/admin/cleanup', method: 'POST', headers: {} }, '99.0.0').nextCalled, true);
});

/**
 * Uji lewat HTTP sungguhan (Express + loopback, tanpa supertest).
 *
 * Kenapa perlu, padahal fungsi murninya sudah diuji: satu-satunya cara
 * membuktikan `req.path` di dalam middleware benar-benar `/health` (bukan
 * `/api/health`) dan bahwa klien menerima **426 + JSON** apa adanya adalah
 * mengirim permintaan nyata melalui router Express. Salah di sini berarti
 * gerbangnya bisa memblokir probe liveness atau membalas tanpa kode yang bisa
 * ditangani klien.
 */
test('HTTP: gerbang bekerja lewat Express (426 + JSON), /health tetap lolos', async () => {
  const app = express();
  app.use('/api', clientVersionGate(() => ({ minimumVersion: '3.0.0' })));
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/api/messages', (_req, res) => { res.json({ reached: true }); });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const tooOld = await fetch(`${base}/api/messages`, { headers: { [CLIENT_VERSION_HEADER]: '2.0.0' } });
    assert.equal(tooOld.status, 426);
    const body = await tooOld.json() as { error: string; minimumVersion: string; message: string };
    assert.equal(body.error, 'CLIENT_TOO_OLD');
    assert.equal(body.minimumVersion, '3.0.0');
    assert.match(body.message, /Muat ulang/i);

    const fresh = await fetch(`${base}/api/messages`, { headers: { [CLIENT_VERSION_HEADER]: '3.0.0' } });
    assert.equal(fresh.status, 200);
    assert.deepEqual(await fresh.json(), { reached: true });

    // Tanpa header versi (klien pra-3.0.0 / curl ops) → lolos.
    const noHeader = await fetch(`${base}/api/messages`);
    assert.equal(noHeader.status, 200);

    // Probe liveness tidak boleh ikut terkunci, apa pun versinya.
    const health = await fetch(`${base}/api/health`, { headers: { [CLIENT_VERSION_HEADER]: '0.0.1' } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
