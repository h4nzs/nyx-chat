// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P7] Relay OHTTP proses terpisah — kontrak keamanan.
 *
 * Yang diuji (bukan sekadar "bisa meneruskan"):
 *  1. byte amplop diteruskan apa adanya beserta content-type yang benar;
 *  2. **tidak ada header klien** yang ikut ke gateway (cookie/authorization/
 *     x-forwarded-for/user-agent), karena itulah yang membuat relay berguna;
 *  3. target non-loopback ditolak saat start (bukan open proxy);
 *  4. body kosong = 400, upstream mati/timeout = 502 tanpa detail internal;
 *  5. status & body gateway dikembalikan apa adanya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertLoopbackGateway, createOhttpRelayApp } from '../src/ohttp/relayApp.js';

interface Captured {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string, captured: Captured[]) => Promise<T>
): Promise<T> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withRelay<T>(gatewayTarget: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createOhttpRelayApp({ gatewayTarget, rateLimitPerMinute: 1_000 });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('relay: meneruskan byte amplop apa adanya + TIDAK meneruskan header klien', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'message/ohttp-res' });
      res.end(Buffer.from([0x01, 0x02, 0x03]));
    },
    async (gatewayUrl, captured) => {
      await withRelay(gatewayUrl, async (relayUrl) => {
        const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const response = await fetch(`${relayUrl}/relay`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            // Semua header berikut HARUS hilang di gateway.
            cookie: 'at=rahasia; rt=rahasia',
            authorization: 'Bearer token-palsu',
            'x-forwarded-for': '203.0.113.99',
            'user-agent': 'nyx-test-agent',
          },
          body: payload,
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'message/ohttp-res');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x01, 0x02, 0x03]));

        assert.equal(captured.length, 1);
        const seen = captured[0]!;
        assert.equal(seen.method, 'POST');
        assert.deepEqual(seen.body, payload, 'amplop identik byte-per-byte');
        assert.equal(seen.headers['content-type'], 'message/ohttp-req', 'content-type relay, bukan milik klien');
        for (const forbidden of ['cookie', 'authorization', 'x-forwarded-for']) {
          assert.equal(seen.headers[forbidden], undefined, `header ${forbidden} tidak boleh diteruskan`);
        }
        // `fetch` Node menambahkan user-agent miliknya sendiri (`node`); yang
        // penting UA KLIEN tidak ikut. Meng-assert `undefined` di sini akan
        // menguji runtime, bukan relay.
        assert.notEqual(seen.headers['user-agent'], 'nyx-test-agent', 'UA klien tidak diteruskan');
      });
    }
  );
});

test('relay: status gateway diteruskan (bukan selalu 200)', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'OHTTP_BODY_TOO_LARGE' }));
    },
    async (gatewayUrl) => {
      await withRelay(gatewayUrl, async (relayUrl) => {
        const response = await fetch(`${relayUrl}/relay`, { method: 'POST', body: Buffer.from([1]) });
        assert.equal(response.status, 429);
        assert.match(await response.text(), /OHTTP_BODY_TOO_LARGE/);
      });
    }
  );
});

test('relay: body kosong ditolak sebelum menyentuh gateway', async () => {
  await withServer(
    (_req, res) => res.end('should-not-be-called'),
    async (gatewayUrl, captured) => {
      await withRelay(gatewayUrl, async (relayUrl) => {
        const response = await fetch(`${relayUrl}/relay`, { method: 'POST' });
        assert.equal(response.status, 400);
        assert.equal(captured.length, 0, 'gateway tidak dipanggil untuk body kosong');
      });
    }
  );
});

test('relay: upstream gagal = 502 tanpa membocorkan detail internal', async () => {
  // Port yang tidak ada listener-nya: fetch gagal (bukan timeout, cepat).
  await withRelay('http://127.0.0.1:1', async (relayUrl) => {
    const response = await fetch(`${relayUrl}/relay`, { method: 'POST', body: Buffer.from([1, 2, 3]) });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /OHTTP_UPSTREAM_FAILED/);
    assert.doesNotMatch(text, /127\.0\.0\.1|ECONNREFUSED|port/i, 'detail internal tidak boleh keluar');
  });
});

test('relay: healthz ada dan tidak menyentuh upstream', async () => {
  await withServer(
    (_req, res) => res.end('nope'),
    async (gatewayUrl, captured) => {
      await withRelay(gatewayUrl, async (relayUrl) => {
        const response = await fetch(`${relayUrl}/healthz`);
        assert.equal(response.status, 200);
        const body = (await response.json()) as { ok: boolean; upstream: string };
        assert.equal(body.ok, true);
        assert.match(body.upstream, /127\.0\.0\.1/, 'status menyebut tujuan tanpa rahasia');
        assert.equal(captured.length, 0);
      });
    }
  );
});

test('relay: target non-loopback ditolak saat start (bukan open proxy)', () => {
  assert.throws(() => assertLoopbackGateway('https://example.com/gateway'), /harus loopback/);
  assert.throws(() => assertLoopbackGateway('not-a-url'), /bukan URL/);
  assert.throws(() => createOhttpRelayApp({ gatewayTarget: 'http://10.0.0.5:4000/gw' }), /harus loopback/);
  assert.equal(assertLoopbackGateway('http://127.0.0.1:4000/api/ohttp/gateway').port, '4000');
  assert.equal(assertLoopbackGateway('http://localhost:4101/relay').hostname, 'localhost');
});

test('relay: host Docker dipercaya hanya bila disebut eksplisit', () => {
  // Default: nama service container TIDAK otomatis dipercaya.
  assert.throws(() => assertLoopbackGateway('http://server:4000/api/ohttp/gateway'), /harus loopback/);

  assert.equal(
    assertLoopbackGateway('http://server:4000/api/ohttp/gateway', ['server']).hostname,
    'server'
  );
  // Daftar tepercaya tidak menjadi wildcard: host lain tetap ditolak.
  assert.throws(
    () => assertLoopbackGateway('http://evil.internal:4000/gw', ['server']),
    /harus loopback/
  );
  // Pencocokan nama tidak peka huruf besar/kecil, dan entri kosong diabaikan.
  // `URL` menormalkan hostname ke huruf kecil; pencocokan juga case-insensitive.
  assert.equal(assertLoopbackGateway('http://SERVER:4000/gw', ['  ', 'Server']).hostname, 'server');
});
