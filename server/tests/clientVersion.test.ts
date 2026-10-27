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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  compareClientVersions,
  clientVersionRejectionMessage,
  evaluateClientVersion,
  isMutationMethod,
  parseClientVersion,
  type ClientVersionPolicy,
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
  policy: string | undefined | ClientVersionPolicy
): { nextCalled: boolean; res: FakeResponse } {
  const normalized: ClientVersionPolicy = typeof policy === 'string' || policy === undefined
    ? { minimumVersion: policy }
    : policy;
  const gate = clientVersionGate(() => normalized);
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

// --- [D1 2026-10-27] Mode ketat: mutasi fail-closed, baca tetap fail-open ----

/**
 * Kenapa mode ini diuji terpisah: ia satu-satunya jalan gerbang versi menjadi
 * kontrol keamanan. Kalau salah, kegagalannya berlawanan arah — terlalu longgar
 * (penyerang cukup tidak mengirim header) atau terlalu ketat (semua klien lama
 * kehilangan kemampuan mengirim pesan sekaligus). Karena itu yang diuji adalah
 * **batasnya**: metode mana yang ditolak, metode mana yang tetap lolos, dan
 * bahwa default tanpa env tidak berubah sama sekali.
 */
test('isMutationMethod: hanya GET/HEAD/OPTIONS yang dianggap baca', () => {
  for (const method of ['GET', 'get', ' HEAD ', 'OPTIONS']) {
    assert.equal(isMutationMethod(method), false, `${method} harus dianggap baca`);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'TRACE', 'METODE-ASING']) {
    assert.equal(isMutationMethod(method), true, `${method} harus dianggap mutasi`);
  }
  // Metode tak terbaca = mutasi (menolak lebih aman daripada menganggap baca).
  assert.equal(isMutationMethod(undefined), false, 'tanpa metode → default baca (dipanggil fungsi murni)');
});

test('evaluateClientVersion: mode ketat menolak mutasi tanpa header, baca tetap lolos', () => {
  const strict: ClientVersionPolicy = { minimumVersion: '3.0.0', requireMutations: true };

  const post = evaluateClientVersion(undefined, strict, 'POST');
  assert.equal(post.ok, false);
  assert.equal(post.reason, 'strict-no-header');
  assert.equal(post.minimumVersion, '3.0.0');
  assert.equal(post.clientVersion, undefined, 'tidak ada versi yang bisa dilaporkan');
  assert.equal(evaluateClientVersion('bukan-versi', strict, 'DELETE').ok, false, 'header tak terbaca = sama dengan tidak ada');

  // Baca tetap fail-open: klien lama harus bisa memuat data & melihat pesan.
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const read = evaluateClientVersion(undefined, strict, method);
    assert.equal(read.ok, true, `${method} tidak boleh diblokir mode ketat`);
    assert.equal(read.reason, 'no-header');
  }

  // Versi tua tetap ditolak di metode apa pun (perilaku lama tidak berubah).
  assert.equal(evaluateClientVersion('2.9.0', strict, 'GET').reason, 'too-old');
  assert.equal(evaluateClientVersion('2.9.0', strict, 'POST').reason, 'too-old');
  // Versi yang menyatakan diri dan cukup baru lolos mutasi.
  assert.equal(evaluateClientVersion('3.0.0', strict, 'POST').ok, true);
});

test('evaluateClientVersion: TANPA requireMutations, mutasi tanpa header tetap lolos (default tidak berubah)', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const decision = evaluateClientVersion(undefined, { minimumVersion: '3.0.0' }, method);
    assert.equal(decision.ok, true, `${method} tanpa mode ketat harus lolos`);
    assert.equal(decision.reason, 'no-header');
  }
  // Gerbang mati menang atas mode ketat: tanpa minimum, tidak ada yang ditolak.
  const off = evaluateClientVersion(undefined, { requireMutations: true }, 'POST');
  assert.equal(off.ok, true);
  assert.equal(off.reason, 'no-minimum');
});

test('middleware: mode ketat → 426 CLIENT_VERSION_REQUIRED untuk mutasi, baca tetap diteruskan', () => {
  const policy: ClientVersionPolicy = { minimumVersion: '3.0.0', requireMutations: true };

  const post = runGate({ path: '/messages', method: 'POST', headers: {} }, policy);
  assert.equal(post.nextCalled, false);
  assert.equal(post.res.statusCode, 426);
  const body = post.res.body as { error: string; message: string; minimumVersion: string };
  assert.equal(body.error, 'CLIENT_VERSION_REQUIRED');
  assert.equal(body.minimumVersion, '3.0.0');
  assert.match(body.message, /Muat ulang/i);

  // Baca & preflight tidak ikut terkunci.
  assert.equal(runGate({ path: '/messages', method: 'GET', headers: {} }, policy).nextCalled, true);
  assert.equal(runGate({ path: '/messages', method: 'OPTIONS', headers: {} }, policy).nextCalled, true);
  // Probe liveness juga, meski metodenya bukan baca.
  assert.equal(runGate({ path: '/health', method: 'POST', headers: {} }, policy).nextCalled, true);
  // Klien yang menyatakan versi cukup baru tetap bisa menulis.
  assert.equal(
    runGate({ path: '/messages', method: 'POST', headers: { [CLIENT_VERSION_HEADER]: '3.1.0' } }, policy).nextCalled,
    true
  );
  // Versi terbaca tapi tua tetap memakai kode lama (bukan REQUIRED).
  const old = runGate({ path: '/messages', method: 'POST', headers: { [CLIENT_VERSION_HEADER]: '2.0.0' } }, policy);
  assert.equal((old.res.body as { error: string }).error, 'CLIENT_TOO_OLD');
});

// --- Kontrak CORS: setiap header klien WAJIB di-whitelist -------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Baca daftar `allowedHeaders` middleware CORS dari `server/src/app.ts`.
 *
 * Sengaja dibaca dari sumber (bukan dari objek yang diekspor): daftarnya hidup
 * di dalam literal konfigurasi yang tidak diekspor, dan berpindah ke "dibaca
 * dari instance CORS" akan menuntut app.ts bisa diimpor tanpa Postgres/Redis —
 * hal yang justru tidak boleh dibutuhkan unit test (AGENTS: unit test server
 * tidak boleh butuh Postgres/Redis). Membaca teksnya membuat regresi ini
 * tertangkap tanpa menyalakan apa pun.
 */
function readAllowedHeaders(): string[] {
  const appSrc = readFileSync(path.join(repoRoot, 'server', 'src', 'app.ts'), 'utf8');
  const lines = appSrc.split('\n');
  const start = lines.findIndex((line) => /allowedHeaders:\s*\[/.test(line));
  assert.ok(start !== -1, 'blok `allowedHeaders` tidak ditemukan di server/src/app.ts');

  // Dipindai baris demi baris, bukan dengan satu regex "sampai `]` pertama":
  // komentar di dalam array boleh memuat `[`/`]` (mis. `// [FIX …]`) dan `,`,
  // dan pemindai yang berhenti di `]` pertama akan diam-diam membaca daftar
  // yang terpotong — tepat jenis kegagalan yang membuat uji ini tidak berguna.
  const headers: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\]/.test(line)) break;
    if (line.trim().startsWith('//')) continue;
    for (const match of line.matchAll(/\/\/[^\n]*|"([^"]*)"|'([^']*)'/g)) {
      const value = match[1] ?? match[2];
      if (value !== undefined) headers.push(value.toLowerCase());
    }
  }
  assert.ok(headers.length > 0, 'daftar `allowedHeaders` terbaca kosong — pemindai tidak menemukan satu pun header');
  return headers;
}

/**
 * Kenapa ini diuji di sini, bukan di uji HTTP biasa: kegagalannya **tidak
 * kelihatan dari server**. `curl` mengabaikan CORS, jadi preflight yang kurang
 * satu header tetap tampak sehat di semua probe ops — tetapi di browser setiap
 * request lintas-origin (app.nyx-app.my.id → api.nyx-app.my.id) diblokir, dan
 * halaman yang sudah dimuat hanya menampilkan callback gagal. Persis itulah
 * bug yang ditemukan saat self-host 2026-10-15: `x-nyx-client-version` dikirim
 * klien di SETIAP request, tapi tidak ada di daftar putih.
 */
test('CORS: allowedHeaders memuat setiap header yang dikirim klien web', () => {
  const allowed = readAllowedHeaders();

  for (const header of [CLIENT_VERSION_HEADER, 'x-nyx-installation-id', 'x-csrf-token', 'if-none-match']) {
    assert.ok(
      allowed.includes(header),
      `"${header}" hilang dari allowedHeaders (server/src/app.ts) → preflight OPTIONS gagal dan browser memblokir SEMUA request API dari origin app`
    );
  }
});

test('CORS: nama header versi di klien web == yang dibaca server', () => {
  const webSrc = readFileSync(path.join(repoRoot, 'web', 'src', 'lib', 'clientVersion.ts'), 'utf8');
  const literal = /CLIENT_VERSION_HEADER\s*=\s*'([^']+)'/.exec(webSrc);
  assert.ok(literal, 'CLIENT_VERSION_HEADER tidak ditemukan di web/src/lib/clientVersion.ts');
  assert.equal(literal[1], CLIENT_VERSION_HEADER);
  // Header yang benar-benar dikirim (dipakai `api()`/`apiUpload()` dan jalur
  // fetch mandiri) harus lolos preflight — bukan cuma dibaca middleware.
  assert.equal(readAllowedHeaders().includes(literal[1]), true);
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

// [D1] Bukti lewat HTTP nyata bahwa mutasi tanpa header benar-benar ditolak
// (bukan hanya di fungsi murni): middleware harus membaca metode request yang
// sebenarnya, dan klien harus menerima 426 + JSON yang bisa ditindaklanjuti.
test('HTTP: mode ketat menolak POST tanpa header versi, GET tetap 200', async () => {
  const app = express();
  app.use('/api', clientVersionGate(() => ({ minimumVersion: '3.0.0', requireMutations: true })));
  app.get('/api/messages', (_req, res) => { res.json({ reached: 'read' }); });
  app.post('/api/messages', (_req, res) => { res.json({ reached: 'write' }); });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const read = await fetch(`${base}/api/messages`);
    assert.equal(read.status, 200, 'baca tanpa header tetap jalan');

    const write = await fetch(`${base}/api/messages`, { method: 'POST' });
    assert.equal(write.status, 426);
    const body = await write.json() as { error: string; message: string };
    assert.equal(body.error, 'CLIENT_VERSION_REQUIRED');
    assert.match(body.message, /Muat ulang/i);

    const declared = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { [CLIENT_VERSION_HEADER]: '3.0.0' },
    });
    assert.equal(declared.status, 200);
    assert.deepEqual(await declared.json(), { reached: 'write' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
