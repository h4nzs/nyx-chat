// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].
//
// [docs/35 Fase 3] OHTTP: framing Binary HTTP (RFC 9292), key config (RFC 9458
// §3), HPKE round-trip request/response, allowlist, dan gate konfigurasi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OHTTP_AEAD_AES256_GCM,
  OHTTP_KDF_SHA256,
  OHTTP_KEM_P256_SHA256,
  OHTTP_KEY_ID,
  OHTTP_MAX_MESSAGE_BYTES,
  OHTTP_SYNC_MAX_BODY_BYTES,
  OhttpError,
  assertOhttpKeyPair,
  decodeBinaryHttpRequest,
  decodeBinaryHttpResponse,
  decodeOhttpKeyConfigCollection,
  encodeBinaryHttpRequest,
  encodeBinaryHttpResponse,
  encodeOhttpKeyConfigCollection,
  encapsulateOhttpRequest,
  generateOhttpKeyPair,
  isOhttpTargetAllowed,
  sanitizeOhttpForwardHeaders,
  type OhttpRequest,
} from '@nyx/shared';
import jwt from 'jsonwebtoken';
import express from 'express';
import { createServer, type Server } from 'node:http';
import createOhttpRouter from '../src/routes/ohttp.js';
import { loadOhttpConfig, type OhttpConfig } from '../src/ohttp/config.js';
import { handleOhttpGateway } from '../src/ohttp/gateway.js';
import {
  OHTTP_TOKEN_TTL_SEC,
  isOhttpScopeRequestAllowed,
  signOhttpToken,
} from '../src/utils/ohttpToken.js';
import { env } from '../src/config.js';

const sampleRequest: OhttpRequest = {
  method: 'GET',
  scheme: 'https',
  authority: 'nyx-app.my.id',
  path: '/api/users/search?q=abc',
  headers: [
    ['cookie', 'session=secret'],
    ['x-nyx-installation-id', 'install-1'],
  ],
  content: new Uint8Array(),
};

function publicConfigFor(keyId: number, publicKey: Uint8Array) {
  return {
    keyId,
    kemId: OHTTP_KEM_P256_SHA256,
    kdfId: OHTTP_KDF_SHA256,
    aeadId: OHTTP_AEAD_AES256_GCM,
    publicKey,
  };
}

async function makeConfig(keyCount = 1): Promise<OhttpConfig> {
  const keys = [];
  const publicConfigs = [];
  for (let index = 0; index < keyCount; index += 1) {
    const keyPair = await generateOhttpKeyPair();
    const keyId = OHTTP_KEY_ID + index;
    keys.push({ keyId, privateKey: keyPair.privateKey });
    publicConfigs.push(publicConfigFor(keyId, keyPair.publicKey));
  }
  return {
    keys,
    publicConfigs,
    relayTarget: 'http://127.0.0.1:4000/api/ohttp/gateway',
  };
}

test('binary HTTP: request known-length round-trip (method/scheme/authority/path/header)', () => {
  const decoded = decodeBinaryHttpRequest(encodeBinaryHttpRequest(sampleRequest));
  assert.equal(decoded.method, 'GET');
  assert.equal(decoded.scheme, 'https');
  assert.equal(decoded.authority, 'nyx-app.my.id');
  assert.equal(decoded.path, '/api/users/search?q=abc');
  assert.deepEqual(decoded.headers, sampleRequest.headers);
  assert.equal(decoded.content.length, 0);
});

test('binary HTTP: response known-length round-trip', () => {
  const body = new TextEncoder().encode('{"ok":true}');
  const decoded = decodeBinaryHttpResponse(
    encodeBinaryHttpResponse({ status: 200, headers: [['content-type', 'application/json']], content: body }),
  );
  assert.equal(decoded.status, 200);
  assert.deepEqual(decoded.headers, [['content-type', 'application/json']]);
  assert.deepEqual(Array.from(decoded.content), Array.from(body));
});

test('binary HTTP: framing indicator salah ditolak', () => {
  const responseBytes = encodeBinaryHttpResponse({ status: 200, headers: [], content: new Uint8Array() });
  assert.throws(() => decodeBinaryHttpRequest(responseBytes), OhttpError);
  const requestBytes = encodeBinaryHttpRequest(sampleRequest);
  assert.throws(() => decodeBinaryHttpResponse(requestBytes), OhttpError);
});

test('key config: collection round-trip mempertahankan key id + public key', async () => {
  const config = await makeConfig();
  const [decoded] = decodeOhttpKeyConfigCollection(
    encodeOhttpKeyConfigCollection(config.publicConfigs),
  );
  assert.ok(decoded);
  assert.equal(decoded.keyId, OHTTP_KEY_ID);
  assert.equal(decoded.kemId, OHTTP_KEM_P256_SHA256);
  assert.equal(decoded.aeadId, OHTTP_AEAD_AES256_GCM);
  assert.deepEqual(Array.from(decoded.publicKey), Array.from(config.publicConfigs[0]!.publicKey));
});

test('key config: rotasi dua slot dipublikasikan dan bisa dipakai keduanya', async () => {
  const config = await makeConfig(2);
  const collection = encodeOhttpKeyConfigCollection(config.publicConfigs);
  const decoded = decodeOhttpKeyConfigCollection(collection);
  assert.deepEqual(decoded.map((item) => item.keyId), [OHTTP_KEY_ID, OHTTP_KEY_ID + 1]);

  for (const publicConfig of decoded) {
    const client = await encapsulateOhttpRequest(publicConfig, sampleRequest);
    const response = await client.openResponse(
      await handleOhttpGateway(config, client.body, async () => ({
        status: 200,
        headers: [],
        content: new Uint8Array(),
      })),
    );
    assert.equal(response.status, 200);
  }
});

test('gateway: key id yang tidak dikenal ditolak sebagai request tidak sah', async () => {
  const config = await makeConfig();
  const staleKey = await generateOhttpKeyPair();
  const client = await encapsulateOhttpRequest(publicConfigFor(OHTTP_KEY_ID + 7, staleKey.publicKey), sampleRequest);
  await assert.rejects(
    () => handleOhttpGateway(config, client.body, async () => ({ status: 200, headers: [], content: new Uint8Array() })),
    /key id tidak dikenal/,
  );
});

test('allowlist: hanya target sempit yang boleh lewat gateway', () => {
  assert.equal(isOhttpTargetAllowed('GET', '/api/users/search'), true);
  assert.equal(isOhttpTargetAllowed('GET', '/api/keys/prekey-bundle/user-1'), true);
  assert.equal(isOhttpTargetAllowed('POST', '/api/users/search'), false);
  assert.equal(isOhttpTargetAllowed('POST', '/api/pir/query'), true);
  assert.equal(isOhttpTargetAllowed('GET', '/api/pir/query'), false);
  assert.equal(isOhttpTargetAllowed('GET', '/api/admin/cleanup'), false);
  assert.equal(isOhttpTargetAllowed('GET', '/api/ohttp/gateway'), false);
  // [docs/37 §37.4 P3] Sync anonim boleh POST, tapi hanya path persisnya.
  assert.equal(isOhttpTargetAllowed('POST', '/api/groups/sync'), true);
  assert.equal(isOhttpTargetAllowed('GET', '/api/groups/sync'), false);
  assert.equal(isOhttpTargetAllowed('POST', '/api/groups/sync/anything'), false);
  assert.equal(isOhttpTargetAllowed('POST', '/api/groups/conv-1/mailbox'), false);
});

test('gateway: body sync di atas 64 KB ditolak 413 terenkripsi', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, {
    ...sampleRequest,
    method: 'POST',
    path: '/api/groups/sync',
    content: new Uint8Array(OHTTP_SYNC_MAX_BODY_BYTES + 1).fill(0x61),
  });
  let dispatched = false;
  const encapsulatedResponse = await handleOhttpGateway(config, client.body, async () => {
    dispatched = true;
    return { status: 200, headers: [], content: new Uint8Array() };
  });
  const response = await client.openResponse(encapsulatedResponse);
  assert.equal(dispatched, false);
  assert.equal(response.status, 413);
  assert.match(new TextDecoder().decode(response.content), /OHTTP_BODY_TOO_LARGE/);
});

test('gateway: header identitas jaringan dibuang sebelum dispatch', () => {
  const filtered = sanitizeOhttpForwardHeaders([
    ['cookie', 'session=secret'],
    ['x-forwarded-for', '203.0.113.9'],
    ['cf-connecting-ip', '203.0.113.9'],
    ['authorization', 'Bearer abc'],
  ]);
  assert.deepEqual(filtered, [
    ['cookie', 'session=secret'],
    ['authorization', 'Bearer abc'],
  ]);
});

test('config: default mati, dan miskonfigurasi saat hidup gagal keras', async () => {
  assert.equal(loadOhttpConfig({}), null);
  assert.throws(
    () => loadOhttpConfig({ OHTTP_ENABLED: '1' }),
    /OHTTP_PRIVATE_KEY wajib diisi/,
  );
  const keyPair = await generateOhttpKeyPair();
  const config = loadOhttpConfig({
    OHTTP_ENABLED: '1',
    OHTTP_PRIVATE_KEY: Buffer.from(keyPair.privateKey).toString('base64url'),
    OHTTP_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64url'),
  });
  assert.ok(config);
  assert.equal(config.keys.length, 1);
  await assertOhttpKeyPair(config.keys[0]!.privateKey, config.publicConfigs[0]!.publicKey);

  // Slot rotasi setengah terisi = boot gagal (klien baru tidak akan bisa dibuka).
  assert.throws(
    () => loadOhttpConfig({
      OHTTP_ENABLED: '1',
      OHTTP_PRIVATE_KEY: Buffer.from(keyPair.privateKey).toString('base64url'),
      OHTTP_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64url'),
      OHTTP_NEXT_PRIVATE_KEY: Buffer.from(keyPair.privateKey).toString('base64url'),
    }),
    /harus diisi bersama/,
  );

  const next = await generateOhttpKeyPair();
  const rotated = loadOhttpConfig({
    OHTTP_ENABLED: '1',
    OHTTP_PRIVATE_KEY: Buffer.from(keyPair.privateKey).toString('base64url'),
    OHTTP_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64url'),
    OHTTP_NEXT_PRIVATE_KEY: Buffer.from(next.privateKey).toString('base64url'),
    OHTTP_NEXT_PUBLIC_KEY: Buffer.from(next.publicKey).toString('base64url'),
  });
  assert.ok(rotated);
  assert.deepEqual(rotated.publicConfigs.map((item) => item.keyId), [OHTTP_KEY_ID, OHTTP_KEY_ID + 1]);
});

test('gateway: request terenkripsi dibuka, di-dispatch, dan response bisa dibuka klien', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, sampleRequest);
  assert.ok(client.body.length > 0);
  assert.ok(client.body.length <= OHTTP_MAX_MESSAGE_BYTES);

  let seenPath = '';
  const encapsulatedResponse = await handleOhttpGateway(config, client.body, async (request) => {
    seenPath = request.path;
    assert.equal(request.method, 'GET');
    return {
      status: 200,
      headers: [['content-type', 'application/json']],
      content: new TextEncoder().encode('{"users":[]}'),
    };
  });

  const response = await client.openResponse(encapsulatedResponse);
  assert.equal(seenPath, '/api/users/search?q=abc');
  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(response.content), '{"users":[]}');
});

test('gateway: target di luar allowlist dijawab 403 terenkripsi dan dispatch tidak dipanggil', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, {
    ...sampleRequest,
    path: '/api/admin/cleanup',
  });
  let dispatched = false;
  const encapsulatedResponse = await handleOhttpGateway(config, client.body, async () => {
    dispatched = true;
    return { status: 200, headers: [], content: new Uint8Array() };
  });
  const response = await client.openResponse(encapsulatedResponse);
  assert.equal(dispatched, false);
  assert.equal(response.status, 403);
  assert.match(new TextDecoder().decode(response.content), /OHTTP_TARGET_NOT_ALLOWED/);
});

test('gateway: amplop yang diubah ditolak (fail-closed)', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, sampleRequest);
  const tampered = client.body.slice();
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(
    () => handleOhttpGateway(config, tampered, async () => ({ status: 200, headers: [], content: new Uint8Array() })),
    OhttpError,
  );
});

test('token carriage: umur pendek, scope ohttp, hanya untuk target allowlist GET', () => {
  const token = signOhttpToken({ userId: 'user-1', deviceId: 'dev-1', jti: 'jti-1' });
  const payload = jwt.verify(token, env.jwtSecret) as Record<string, unknown>;
  assert.equal(payload.scope, 'ohttp');
  assert.equal(payload.aud, 'ohttp');
  assert.equal(payload.id, 'user-1');
  assert.equal(payload.jti, 'jti-1');
  assert.equal(
    Number(payload.exp) - Number(payload.iat),
    OHTTP_TOKEN_TTL_SEC,
  );

  // Allowlist: pencarian/prekey (GET) + PIR & sync grup (POST) — pasangan
  // method+path yang menentukan, bukan method saja.
  assert.equal(isOhttpScopeRequestAllowed('GET', '/api/users/search?q=abc'), true);
  assert.equal(isOhttpScopeRequestAllowed('GET', '/api/keys/prekey-bundle/u1'), true);
  assert.equal(isOhttpScopeRequestAllowed('POST', '/api/users/search'), false);
  assert.equal(isOhttpScopeRequestAllowed('GET', '/api/messages'), false);
  assert.equal(isOhttpScopeRequestAllowed('GET', '/api/admin/cleanup'), false);
  assert.equal(isOhttpScopeRequestAllowed('POST', '/api/groups/sync'), true);
  assert.equal(isOhttpScopeRequestAllowed('POST', '/api/groups/sync/other'), false);
});

test('relay nyata: klien → relay → gateway → dispatch → response terbuka', async () => {
  const config = await makeConfig();
  let received: OhttpRequest | null = null;
  const app = express();
  app.use('/api/ohttp', createOhttpRouter(config, {
    dispatch: async (request) => {
      received = request;
      return {
        status: 200,
        headers: [['content-type', 'application/json']],
        content: new TextEncoder().encode('{"users":[]}'),
      };
    },
  }));

  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app).listen(0, '127.0.0.1', () => resolve(instance as unknown as Server));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  // Relay menuju gateway yang sama lewat loopback (topologi produksi).
  (config as { relayTarget: string }).relayTarget = `${base}/api/ohttp/gateway`;

  try {
    // 1. Key config diambil dari jalur publik (bentuk collection).
    const configResponse = await fetch(`${base}/api/ohttp/config`);
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get('content-type')?.includes('application/ohttp-keys'), true);
    const published = decodeOhttpKeyConfigCollection(
      new Uint8Array(await configResponse.arrayBuffer()),
    );
    assert.equal(published[0]?.keyId, OHTTP_KEY_ID);

    // 2. Request dienkapsulasi, dikirim ke RELAY (bukan gateway langsung).
    const client = await encapsulateOhttpRequest(published[0]!, {
      ...sampleRequest,
      headers: [
        ['authorization', 'Bearer scoped-token'],
        ['x-forwarded-for', '203.0.113.9'],
      ],
    });
    const relayResponse = await fetch(`${base}/api/ohttp/relay`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req' },
      body: Buffer.from(client.body),
    });
    assert.equal(relayResponse.status, 200);
    assert.equal(
      relayResponse.headers.get('content-type')?.includes('message/ohttp-res'),
      true,
    );

    // 3. Klien membuka response; header jaringan tidak pernah sampai dispatch.
    const opened = await client.openResponse(new Uint8Array(await relayResponse.arrayBuffer()));
    assert.equal(opened.status, 200);
    assert.equal(new TextDecoder().decode(opened.content), '{"users":[]}');
    assert.ok(received);
    const forwardedHeaders = (received as OhttpRequest).headers.map(([name]) => name.toLowerCase());
    assert.deepEqual(forwardedHeaders, ['authorization']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('relay token-off: guard auth, token dicetak server, cookie klien tidak diteruskan', async () => {
  const config: OhttpConfig = {
    ...(await makeConfig()),
    tokenMode: 'off',
    internalToken: 'internal-secret',
  };
  let received: OhttpRequest | null = null;
  const app = express();
  app.use('/api/ohttp', createOhttpRouter(config, {
    relayGuards: [
      (req, _res, next) => {
        req.user = { id: 'user-1' };
        req.deviceId = 'dev-1';
        next();
      },
    ],
    dispatch: async (request) => {
      received = request;
      return {
        status: 200,
        headers: [['content-type', 'application/json']],
        content: new TextEncoder().encode('{"users":[]}'),
      };
    },
  }));

  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app).listen(0, '127.0.0.1', () => resolve(instance as unknown as Server));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  (config as { relayTarget: string }).relayTarget = `${base}/api/ohttp/gateway`;

  try {
    const configResponse = await fetch(`${base}/api/ohttp/config`);
    const published = decodeOhttpKeyConfigCollection(
      new Uint8Array(await configResponse.arrayBuffer()),
    );
    const client = await encapsulateOhttpRequest(published[0]!, {
      ...sampleRequest,
      headers: [
        ['authorization', 'Bearer client-forged'],
        ['cookie', 'session=secret'],
      ],
    });

    const relayResponse = await fetch(`${base}/api/ohttp/relay`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req' },
      body: Buffer.from(client.body),
    });
    assert.equal(relayResponse.status, 200);
    const opened = await client.openResponse(new Uint8Array(await relayResponse.arrayBuffer()));
    assert.equal(opened.status, 200);

    assert.ok(received);
    const forwarded = (received as OhttpRequest).headers;
    assert.deepEqual(forwarded.map(([name]) => name.toLowerCase()), ['authorization']);
    const authorization = forwarded.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    assert.match(authorization ?? '', /^Bearer /);
    const payload = jwt.verify(authorization!.slice('Bearer '.length), env.jwtSecret) as Record<string, unknown>;
    assert.equal(payload.id, 'user-1');
    assert.equal(payload.deviceId, 'dev-1');
    assert.equal(payload.scope, 'ohttp');

    const direct = await fetch(`${base}/api/ohttp/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req' },
      body: Buffer.from(client.body),
    });
    assert.equal(direct.status, 403);
    assert.match(await direct.text(), /OHTTP_GATEWAY_FORBIDDEN/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
