import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPirEnabled, loadPirConfig } from '../src/pir/config.js';
import createPirRouter from '../src/routes/pir.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('PIR config: default mati dan hanya menerima loopback http', () => {
  assert.equal(isPirEnabled({}), false);
  assert.equal(loadPirConfig({}), null);
  assert.deepEqual(loadPirConfig({ PIR_ENABLED: '1' }), {
    serviceUrl: 'http://127.0.0.1:9470',
  });
  assert.deepEqual(
    loadPirConfig({ PIR_ENABLED: '1', PIR_SERVICE_URL: 'http://localhost:9999' }),
    { serviceUrl: 'http://localhost:9999' },
  );
  assert.deepEqual(
    loadPirConfig({ PIR_ENABLED: '1', PIR_SERVICE_URL: 'http://[::1]:9999' }),
    { serviceUrl: 'http://[::1]:9999' },
  );
  for (const url of [
    'https://127.0.0.1:9470',
    'http://example.com:9470',
    'http://127.0.0.1:9470/path',
    'http://user:pass@127.0.0.1:9470',
    'http://127.0.0.1:9470?x=1',
  ]) {
    assert.throws(
      () => loadPirConfig({ PIR_ENABLED: '1', PIR_SERVICE_URL: url }),
      /PIR:/,
      url,
    );
  }
});

test('PIR router: params, ETag, query opaque, dan validasi body', async (t) => {
  let queryCalls = 0;
  const sidecar = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/params') {
      if (req.headers['if-none-match'] === '"pir-2"') {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        etag: '"pir-2"',
      });
      res.end(JSON.stringify({ epoch: 2, entryCount: 1, recordBytes: 2048 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/query') {
      queryCalls += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (body.toString() === 'bad') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'PIR_QUERY_INVALID' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat([Buffer.from('response:'), body]));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const sidecarPort = await listen(sidecar);
  t.after(() => close(sidecar));

  const app = express();
  app.use(
    '/api/pir',
    createPirRouter(
      { serviceUrl: `http://127.0.0.1:${sidecarPort}` },
      {
        auth: (_req, _res, next) => next(),
        limiters: [],
      },
    ),
  );
  const appServer = createServer(app);
  const appPort = await listen(appServer);
  t.after(() => close(appServer));
  const base = `http://127.0.0.1:${appPort}/api/pir`;

  const params = await fetch(`${base}/params`);
  assert.equal(params.status, 200);
  assert.equal(params.headers.get('etag'), '"pir-2"');
  assert.equal(params.headers.get('cache-control'), 'private, max-age=60');
  assert.deepEqual(await params.json(), { epoch: 2, entryCount: 1, recordBytes: 2048 });

  const cached = await fetch(`${base}/params`, {
    headers: { 'if-none-match': '"pir-2"' },
  });
  assert.equal(cached.status, 304);

  const sent = Buffer.from([1, 2, 3, 4]);
  const query = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: sent,
  });
  assert.equal(query.status, 200);
  assert.equal(query.headers.get('content-type'), 'application/octet-stream');
  assert.equal(query.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await query.arrayBuffer()), Buffer.concat([Buffer.from('response:'), sent]));

  const empty = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: 'PIR_QUERY_REQUIRED' });

  const invalid = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('bad'),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'PIR_QUERY_INVALID' });
  assert.equal(queryCalls, 2);
});

test('PIR router: sidecar tidak tersedia -> 503 tanpa detail internal', async (t) => {
  const app = express();
  app.use(
    '/api/pir',
    createPirRouter(
      { serviceUrl: 'http://127.0.0.1:9470' },
      {
        auth: (_req, _res, next) => next(),
        limiters: [],
        fetchImpl: async () => {
          throw new Error('connection refused');
        },
      },
    ),
  );
  const appServer = createServer(app);
  const appPort = await listen(appServer);
  t.after(() => close(appServer));

  const response = await fetch(`http://127.0.0.1:${appPort}/api/pir/params`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'PIR_UNAVAILABLE' });
});
