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
  OHTTP_KT_SEARCH_MAX_BODY_BYTES,
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
import { createOhttpRelayApp } from '../src/ohttp/relayApp.js';
import { loadOhttpConfig, type OhttpConfig } from '../src/ohttp/config.js';
import { handleOhttpGateway } from '../src/ohttp/gateway.js';
import {
  OHTTP_CLIENT_TAG_HEADER,
  OHTTP_INTERNAL_HEADER,
  invalidTrustedProxyReason,
  ohttpClientAddress,
  setOhttpInternalToken,
} from '../src/ohttp/clientTag.js';
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
  // [audit N7-01] Search KT lewat POST berbody, bukan GET ber-query.
  assert.equal(isOhttpTargetAllowed('POST', '/api/keys/kt/search'), true);
  assert.equal(isOhttpTargetAllowed('GET', '/api/keys/kt/search'), false);
  assert.equal(isOhttpTargetAllowed('POST', '/api/keys/kt/search/anything'), false);
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

test('gateway: body search KT di atas 4 KB ditolak 413 terenkripsi', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, {
    ...sampleRequest,
    method: 'POST',
    path: '/api/keys/kt/search',
    content: new Uint8Array(OHTTP_KT_SEARCH_MAX_BODY_BYTES + 1).fill(0x61),
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

test('config: token internal token-off deterministik lintas worker (F-06)', async () => {
  const keyPair = await generateOhttpKeyPair();
  const base = {
    OHTTP_ENABLED: '1',
    OHTTP_PRIVATE_KEY: Buffer.from(keyPair.privateKey).toString('base64url'),
    OHTTP_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64url'),
    OHTTP_TOKEN_MODE: 'off',
    JWT_SECRET: 'jwt-secret-yang-sama-di-semua-worker',
  };

  // Dua "proses" dengan env identik harus menghasilkan token identik; kalau
  // tidak, relay di worker A ditolak gateway di worker B (403 acak).
  const a = loadOhttpConfig(base);
  const b = loadOhttpConfig(base);
  assert.ok(a?.internalToken);
  assert.equal(a!.internalToken, b!.internalToken);

  // Env eksplisit menang (dipakai saat relay berjalan sebagai proses sendiri).
  const explicit = loadOhttpConfig({ ...base, OHTTP_INTERNAL_TOKEN: 'e'.repeat(32) });
  assert.equal(explicit!.internalToken, 'e'.repeat(32));

  // Tanpa rahasia bersama: boot gagal, bukan token acak per proses.
  assert.throws(
    () => loadOhttpConfig({ ...base, JWT_SECRET: '' }),
    /OHTTP_INTERNAL_TOKEN atau JWT_SECRET/,
  );
  assert.throws(
    () => loadOhttpConfig({ ...base, OHTTP_INTERNAL_TOKEN: 'pendek' }),
    /minimal 32 karakter/,
  );

  // Mode `on` tidak memakai token internal sama sekali.
  const on = loadOhttpConfig({ ...base, OHTTP_TOKEN_MODE: 'on' });
  assert.equal(on!.internalToken, undefined);
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

// [audit N9-01] Tag klien berasal dari relay (satu-satunya pihak yang melihat
// alamat klien) dan menentukan bucket rate limit di API. Karena itu tag hanya
// diteruskan bersama token internal yang sah, dan klaim dengan nama header yang
// sama dari DALAM amplop selalu dibuang.
test('gateway: tag klien relay diteruskan, klaim dari dalam amplop dibuang', async () => {
  const config: OhttpConfig = {
    ...(await makeConfig()),
    internalToken: 'internal-secret',
  };
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, {
    ...sampleRequest,
    headers: [
      [OHTTP_INTERNAL_HEADER, 'internal-palsu'],
      [OHTTP_CLIENT_TAG_HEADER, 'tag-palsu-dari-amplop'],
    ],
  });

  let received: OhttpRequest | null = null;
  await handleOhttpGateway(
    config,
    client.body,
    async (request) => {
      received = request;
      return { status: 200, headers: [], content: new Uint8Array() };
    },
    undefined,
    { clientTag: 'tag-dari-relay' },
  );

  const headers = (received as OhttpRequest).headers;
  const matching = (name: string) => headers.filter(([key]) => key.toLowerCase() === name);
  assert.deepEqual(matching(OHTTP_CLIENT_TAG_HEADER), [
    [OHTTP_CLIENT_TAG_HEADER, 'tag-dari-relay'],
  ]);
  assert.deepEqual(matching(OHTTP_INTERNAL_HEADER), [
    [OHTTP_INTERNAL_HEADER, 'internal-secret'],
  ]);
});

test('gateway: tag klien tidak diteruskan bila relay tidak menandatanganinya', async () => {
  const config = await makeConfig();
  const client = await encapsulateOhttpRequest(config.publicConfigs[0]!, {
    ...sampleRequest,
    headers: [
      [OHTTP_CLIENT_TAG_HEADER, 'tag-palsu'],
      [OHTTP_INTERNAL_HEADER, 'internal-palsu'],
    ],
  });

  let received: OhttpRequest | null = null;
  await handleOhttpGateway(config, client.body, async (request) => {
    received = request;
    return { status: 200, headers: [], content: new Uint8Array() };
  });

  const names = (received as OhttpRequest).headers.map(([key]) => key.toLowerCase());
  assert.ok(!names.includes(OHTTP_CLIENT_TAG_HEADER));
  assert.ok(!names.includes(OHTTP_INTERNAL_HEADER));
});

// ---------------------------------------------------------------------------
// [audit N10-02] Dua limiter 120/menit lain di jalur OHTTP masih satu bucket
// global: gateway dipanggil relay lewat loopback (`req.ip` = 127.0.0.1) dan
// relay dipanggil nginx (`req.ip` = alamat nginx). Probe pass 10: 429 pertama
// di request #121 meski 140 klien berbeda. Tes di bawah menjalankan router ASLI
// dengan `express-rate-limit` sungguhan — bukan membaca konfigurasinya.
// ---------------------------------------------------------------------------

/** Kirim `count` request ke gateway, kembalikan status tiap request. */
async function postGateway(
  base: string,
  headers: Record<string, string>,
  count: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${base}/api/ohttp/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req', ...headers },
      body: Buffer.from([1]),
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  return statuses;
}

test('limiter gateway: bucket per tag relay, bukan satu loopback', async () => {
  const secret = 'internal-limiter-secret';
  setOhttpInternalToken(secret);
  const config: OhttpConfig = { ...(await makeConfig()), internalToken: secret };
  const app = express();
  app.use('/api/ohttp', createOhttpRouter(config, {
    dispatch: async () => ({ status: 200, headers: [], content: new Uint8Array() }),
  }));
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app).listen(0, '127.0.0.1', () => resolve(instance as unknown as Server));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const signed = (tag: string) => ({
    [OHTTP_INTERNAL_HEADER]: secret,
    [OHTTP_CLIENT_TAG_HEADER]: tag,
  });

  try {
    // 140 request bergantian antara DUA tag sah: masing-masing 70, jauh di bawah
    // 120. Kalau limiter masih memakai `req.ip` loopback, request #121 kena 429.
    const tagA = `tag-a-${'a'.repeat(20)}`;
    const tagB = `tag-b-${'b'.repeat(20)}`;
    const mixed: number[] = [];
    for (let index = 0; index < 140; index += 1) {
      const [status] = await postGateway(base, signed(index % 2 === 0 ? tagA : tagB), 1);
      mixed.push(status!);
    }
    assert.deepEqual(
      mixed.filter((status) => status === 429),
      [],
      'limiter gateway masih memakai satu bucket bersama',
    );

    // Kontrol: batas tetap berlaku per tag tunggal (120/menit).
    const single = await postGateway(base, signed(`tag-c-${'c'.repeat(20)}`), 121);
    assert.equal(single.filter((status) => status === 429).length, 1);
    assert.equal(single[120], 429);
  } finally {
    setOhttpInternalToken(undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('limiter relay: 140 klien berbeda tidak kena 429, satu klien tetap dibatasi', async () => {
  const stub = express();
  stub.post('/relay', express.raw({ type: () => true }), (_req, res) => {
    res.type('message/ohttp-res').send(Buffer.alloc(0));
  });
  const stubServer: Server = await new Promise((resolve) => {
    const instance = createServer(stub).listen(0, '127.0.0.1', () => resolve(instance as unknown as Server));
  });
  const stubAddress = stubServer.address();
  assert.ok(stubAddress && typeof stubAddress === 'object');

  const relay = createOhttpRelayApp({
    gatewayTarget: `http://127.0.0.1:${stubAddress.port}/relay`,
    internalToken: 'internal-limiter-secret',
  });
  const relayServer: Server = await new Promise((resolve) => {
    const instance = createServer(relay).listen(0, '127.0.0.1', () => resolve(instance as unknown as Server));
  });
  const relayAddress = relayServer.address();
  assert.ok(relayAddress && typeof relayAddress === 'object');
  const base = `http://127.0.0.1:${relayAddress.port}`;

  const send = async (clientIp: string): Promise<number> => {
    const response = await fetch(`${base}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req', 'cf-connecting-ip': clientIp },
      body: Buffer.from([1]),
    });
    await response.arrayBuffer();
    return response.status;
  };

  try {
    // 140 alamat klien berbeda (dari loopback, yaitu proxy tepercaya): tiap
    // alamat bucket-nya sendiri → tidak boleh ada 429 sama sekali.
    const distinct: number[] = [];
    for (let index = 0; index < 140; index += 1) {
      distinct.push(await send(`10.0.${Math.floor(index / 256)}.${index % 256}`));
    }
    assert.deepEqual(distinct.filter((status) => status === 429), []);

    // Kontrol: satu klien mengirim 121 request → 429 di request terakhir.
    const single: number[] = [];
    for (let index = 0; index < 121; index += 1) single.push(await send('203.0.113.77'));
    assert.equal(single.filter((status) => status === 429).length, 1);
    assert.equal(single[120], 429);
  } finally {
    await new Promise<void>((resolve) => relayServer.close(() => resolve()));
    await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  }
});

// [audit N10-03] Header identitas hanya dipercaya bila hop langsung adalah
// proxy tepercaya; kalau tidak, relay meneruskan tag pilihan klien dan bucket
// API bisa dikarang.
test('alamat relay: CF-Connecting-IP diabaikan bila hop bukan proxy tepercaya', () => {
  const addressOf = (peer: string, options?: { trustedProxies: readonly string[] }) =>
    ohttpClientAddress(
      {
        headers: { 'cf-connecting-ip': '203.0.113.9' },
        ip: peer,
        socket: { remoteAddress: peer },
      } as never,
      options,
    );

  // Klien langsung (bukan proxy) mengarang header → alamat soket yang dipakai.
  assert.equal(addressOf('198.51.100.20'), '198.51.100.20');
  // nginx loopback boleh meneruskan hasil restorasi real_ip.
  assert.equal(addressOf('::ffff:127.0.0.1'), '203.0.113.9');
  // Jaringan container hanya dipercaya bila dicantumkan eksplisit.
  assert.equal(addressOf('172.18.0.5', { trustedProxies: ['172.16.0.0/12'] }), '203.0.113.9');
  assert.equal(addressOf('172.18.0.5', { trustedProxies: ['10.0.0.0/8'] }), '172.18.0.5');
  // [audit N11-05] CIDR IPv6 juga berlaku. Sebelumnya entri ini diabaikan
  // diam-diam → nginx tidak dipercaya dan semua klien berbagi satu tag.
  assert.equal(addressOf('fd00::5', { trustedProxies: ['fd00::/8'] }), '203.0.113.9');
  assert.equal(addressOf('fd00::5', { trustedProxies: ['fd00:1::/32'] }), 'fd00::5');
  // Prefix di luar rentang keluarga alamatnya tidak pernah cocok.
  assert.equal(addressOf('fd00::5', { trustedProxies: ['fd00::/129'] }), 'fd00::5');
  // [audit N12-01] Garis miring tanpa angka BUKAN `/0`. Dulu `Number('')`
  // adalah 0 sehingga entri ini menjadi "percaya semua hop" — header klien
  // dipakai untuk alamat apa pun. Sekarang entri cacat tidak cocok sama sekali.
  assert.equal(addressOf('203.0.113.9', { trustedProxies: ['10.0.0.0/'] }), '203.0.113.9');
  assert.equal(addressOf('fd00::5', { trustedProxies: ['fd00::/'] }), 'fd00::5');
  // Garis miring ganda dulu dieksekusi sebagai `/8` (split mengambil dua bagian).
  assert.equal(addressOf('172.18.0.5', { trustedProxies: ['172.16.0.0/8/8'] }), '172.18.0.5');
  // `/0` yang ditulis eksplisit tetap dihormati: itu keputusan operator, bukan
  // salah-setel yang tidak terlihat.
  assert.equal(addressOf('172.18.0.5', { trustedProxies: ['0.0.0.0/0'] }), '203.0.113.9');
});

// [audit N11-05] Entri yang salah bentuk harus terlihat saat start, bukan
// berubah menjadi satu bucket tanpa gejala.
test('OHTTP_TRUSTED_PROXIES: entri tidak sah dilaporkan, bukan diabaikan diam-diam', () => {
  assert.equal(invalidTrustedProxyReason('172.16.0.0/12'), null);
  assert.equal(invalidTrustedProxyReason('fd00::/8'), null);
  assert.equal(invalidTrustedProxyReason('::1'), null);
  assert.match(invalidTrustedProxyReason('fd00::/129') ?? '', /IPv6/);
  assert.match(invalidTrustedProxyReason('172.16.0.0/33') ?? '', /IPv4/);
  assert.equal(invalidTrustedProxyReason('nginx.internal'), 'bukan alamat IP');
  // [audit N12-01] Bentuk cacat yang dulu lolos tanpa peringatan.
  assert.match(invalidTrustedProxyReason('10.0.0.0/') ?? '', /prefix kosong/);
  assert.match(invalidTrustedProxyReason('fd00::/') ?? '', /prefix kosong/);
  assert.match(invalidTrustedProxyReason('10.0.0.0/8/8') ?? '', /garis miring/);
  assert.match(invalidTrustedProxyReason('10.0.0.0/eight') ?? '', /bukan angka/);
  // `/0` eksplisit tetap sah; nilainya memang "percaya semua hop".
  assert.equal(invalidTrustedProxyReason('0.0.0.0/0'), null);
});
