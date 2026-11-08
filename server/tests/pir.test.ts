import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PIR_SUITE, type PirManifest } from '@nyx/shared';
import {
  findPirServer,
  isPirEnabled,
  loadPirConfig,
  type PirConfig,
} from '../src/pir/config.js';
import { loadPirSigningKeyBytes, signPirManifest } from '../src/pir/manifest.js';
import createPirRouter from '../src/routes/pir.js';

const KEY_A = loadPirSigningKeyBytes(new Uint8Array(32).fill(1));
const KEY_B = loadPirSigningKeyBytes(new Uint8Array(32).fill(2));
const DB_ROOT = 'a'.repeat(64);

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

function manifest(overrides: Partial<PirManifest> = {}): PirManifest {
  return {
    suite: PIR_SUITE,
    shard: 1,
    shardCount: 2,
    slotCount: 4096,
    recordBytes: 2048,
    epoch: 3,
    entryCount: 10,
    dbRoot: DB_ROOT,
    operator: 'a',
    keyId: KEY_A.keyId,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<PirConfig> = {}): PirConfig {
  return {
    servers: [
      { id: 'a', url: 'http://127.0.0.1:9470' },
      { id: 'b', url: 'http://127.0.0.1:9471' },
    ],
    manifestKeys: new Map([
      ['a', KEY_A.publicKey],
      ['b', KEY_B.publicKey],
    ]),
    signingKeys: new Map([
      ['a', '/tmp/pir-a.key'],
      ['b', '/tmp/pir-b.key'],
    ]),
    adminToken: 'admin-secret',
    recordBytes: 2048,
    shardDir: null,
    ...overrides,
  };
}

function envFor(config: PirConfig, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const servers = config.servers.map(({ id, url }) => ({ id, url }));
  const keys: Record<string, string> = {};
  for (const [id, key] of config.manifestKeys) {
    keys[id] = Buffer.from(key).toString('base64url');
  }
  return {
    PIR_ENABLED: '1',
    PIR_SERVERS: JSON.stringify(servers),
    PIR_MANIFEST_KEYS: JSON.stringify(keys),
    PIR_SIGNING_KEYS: JSON.stringify(
      Object.fromEntries(config.servers.map(({ id }) => [id, `/tmp/${id}.key`])),
    ),
    ...env,
  };
}

test('PIR config: mati secara default, dan hidup tanpa dua server = gagal boot', () => {
  assert.equal(isPirEnabled({}), false);
  assert.equal(loadPirConfig({}), null);
  assert.throws(() => loadPirConfig({ PIR_ENABLED: '1' }), /PIR_SERVERS/);

  const config = baseConfig();
  const one = { ...config, servers: [config.servers[0]!] };
  assert.throws(() => loadPirConfig(envFor(one)), /minimal 2 server/);
});

test('PIR config: URL sidecar dibatasi (loopback http atau https)', () => {
  const config = baseConfig();
  const ok = loadPirConfig(envFor(config, { PIR_RECORD_BYTES: '4096' }));
  assert.ok(ok);
  assert.equal(ok.recordBytes, 4096);
  assert.equal(ok.adminToken, null);
  assert.deepEqual(
    ok.servers.map((server) => server.url),
    ['http://127.0.0.1:9470', 'http://127.0.0.1:9471'],
  );

  const remote = baseConfig({
    servers: [
      { id: 'a', url: 'https://pir-a.nyx.example' },
      { id: 'b', url: 'https://pir-b.nyx.example' },
    ],
  });
  assert.ok(loadPirConfig(envFor(remote)));

  for (const url of [
    'http://pir-a.nyx.example',
    'https://127.0.0.1:9470',
    'http://127.0.0.1:9470/path',
    'http://user:pass@127.0.0.1:9470',
  ]) {
    const bad = baseConfig({ servers: [{ id: 'a', url }, config.servers[1]!] });
    assert.throws(() => loadPirConfig(envFor(bad)), /PIR:/, url);
  }
});

test('PIR config: kunci manifest wajib untuk setiap server dan harus ML-DSA-65', () => {
  const config = baseConfig();
  const missing = envFor(config);
  const keys = JSON.parse(missing.PIR_MANIFEST_KEYS!) as Record<string, string>;
  delete keys.b;
  missing.PIR_MANIFEST_KEYS = JSON.stringify(keys);
  assert.throws(() => loadPirConfig(missing), /kunci manifest untuk server b tidak ada/);

  const short = envFor(config);
  const shortKeys = JSON.parse(short.PIR_MANIFEST_KEYS!) as Record<string, string>;
  shortKeys.a = Buffer.from(new Uint8Array(32)).toString('base64url');
  short.PIR_MANIFEST_KEYS = JSON.stringify(shortKeys);
  assert.throws(() => loadPirConfig(short), /ML-DSA-65/);

  const noSigning = envFor(config);
  delete noSigning.PIR_SIGNING_KEYS;
  assert.throws(() => loadPirConfig(noSigning), /PIR_SIGNING_KEYS/);

  const badSuite = envFor(config, { PIR_SUITE: 'chalametpir-v1' });
  assert.throws(() => loadPirConfig(badSuite), /PIR_SUITE/);
});

test('PIR config: findPirServer hanya menerima id yang terdaftar', () => {
  const config = baseConfig();
  assert.equal(findPirServer(config, 'b')?.url, 'http://127.0.0.1:9471');
  assert.equal(findPirServer(config, 'z'), null);
});

async function startRouter(
  config: PirConfig,
  fetchImpl: typeof fetch,
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(
    '/api/pir',
    createPirRouter(config, {
      auth: (_req, _res, next) => next(),
      limiters: [],
      fetchImpl,
    }),
  );
  const server = createServer(app);
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}/api/pir`,
    close: () => close(server),
  };
}

test('PIR manifest: diteruskan hanya setelah tanda tangan kunci ter-pin valid', async (t) => {
  const payload = { manifest: manifest(), signature: signPirManifest(manifest(), KEY_A) };
  let upstreamUrl = '';
  const app = await startRouter(baseConfig(), async (input) => {
    upstreamUrl = String(input);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  t.after(app.close);

  const response = await fetch(`${app.base}/a/manifest?shard=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(upstreamUrl, 'http://127.0.0.1:9470/manifest?shard=1');
  const body = (await response.json()) as { manifest: PirManifest; signature: string };
  assert.equal(body.manifest.dbRoot, DB_ROOT);
  assert.equal(body.signature, payload.signature);
});

test('PIR manifest: tanda tangan salah atau server tak dikenal ditolak', async (t) => {
  const app = await startRouter(
    baseConfig(),
    async () => {
      // Manifest ditandatangani kunci B (keyId-nya cocok), tetapi kunci yang
      // di-pin untuk server `a` adalah A: proxy harus menolak, bukan meneruskan.
      const forged = manifest({ keyId: KEY_B.keyId });
      return new Response(
        JSON.stringify({ manifest: forged, signature: signPirManifest(forged, KEY_B) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  t.after(app.close);

  const forged = await fetch(`${app.base}/a/manifest?shard=1`);
  assert.equal(forged.status, 502);
  assert.deepEqual(await forged.json(), { error: 'PIR_MANIFEST_INVALID' });

  // Manifest shard lain dari server yang sama juga ditolak.
  const otherShard = await startRouter(
    baseConfig(),
    async () =>
      new Response(
        JSON.stringify({
          manifest: manifest({ shard: 0 }),
          signature: signPirManifest(manifest({ shard: 0 }), KEY_A),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  t.after(otherShard.close);
  assert.equal((await fetch(`${otherShard.base}/a/manifest?shard=1`)).status, 502);

  const unknown = await fetch(`${app.base}/z/manifest?shard=1`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'PIR_SERVER_UNKNOWN' });

  const noShard = await fetch(`${app.base}/a/manifest`);
  assert.equal(noShard.status, 400);
  assert.deepEqual(await noShard.json(), { error: 'PIR_SHARD_INVALID' });
});

test('PIR manifest: sidecar 404/500 dan fetch gagal dipetakan tanpa bocor detail', async (t) => {
  const notFound = await startRouter(
    baseConfig(),
    async () => new Response('{}', { status: 404 }),
  );
  t.after(notFound.close);
  const missing = await fetch(`${notFound.base}/b/manifest?shard=9`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'PIR_SHARD_UNKNOWN' });

  const broken = await startRouter(
    baseConfig(),
    async () => new Response('boom', { status: 500 }),
  );
  t.after(broken.close);
  const down = await fetch(`${broken.base}/b/manifest?shard=9`);
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: 'PIR_UNAVAILABLE' });

  const throws = await startRouter(baseConfig(), async () => {
    throw new Error('connection refused');
  });
  t.after(throws.close);
  const failed = await fetch(`${throws.base}/a/manifest?shard=9`);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'PIR_UNAVAILABLE' });
});

test('PIR query: diteruskan opaque ke server yang diminta saja', async (t) => {
  const calls: string[] = [];
  const app = await startRouter(baseConfig(), async (input, init) => {
    calls.push(String(input));
    const sent = Buffer.from(init?.body as Uint8Array);
    return new Response(Buffer.concat([Buffer.from('answer:'), sent]), { status: 200 });
  });
  t.after(app.close);

  const sent = Buffer.from([9, 8, 7, 6]);
  const response = await fetch(`${app.base}/b/query?shard=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: sent,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.concat([Buffer.from('answer:'), sent]),
  );
  assert.deepEqual(calls, ['http://127.0.0.1:9471/query?shard=1']);
});

test('PIR query: body kosong, shard hilang, dan penolakan sidecar dipetakan', async (t) => {
  const app = await startRouter(
    baseConfig(),
    async () => new Response('{"error":"PIR_SHARE_INVALID"}', { status: 400 }),
  );
  t.after(app.close);

  const empty = await fetch(`${app.base}/a/query?shard=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: 'PIR_QUERY_REQUIRED' });

  const noShard = await fetch(`${app.base}/a/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1]),
  });
  assert.equal(noShard.status, 400);
  assert.deepEqual(await noShard.json(), { error: 'PIR_SHARD_INVALID' });

  const invalid = await fetch(`${app.base}/a/query?shard=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1]),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'PIR_QUERY_INVALID' });

  const unknown = await fetch(`${app.base}/z/query?shard=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1]),
  });
  assert.equal(unknown.status, 404);
});
