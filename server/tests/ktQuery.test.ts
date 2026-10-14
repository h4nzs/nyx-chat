// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.8] Penerus query Key Transparency.
 *
 * Yang diuji perilakunya (bukan bentuk kode): framing byte dari layanan baca
 * (`nyx-kt-query`) diteruskan apa adanya, setiap kelas kegagalan dipetakan ke
 * kode yang berbeda — kegagalan layanan TIDAK boleh tampak seperti "tidak ada di
 * log" — dan semuanya terhitung di metrik. Sesuai aturan repo: test tidak butuh
 * Postgres/Redis; adapter tiruan adalah server HTTP lokal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  KtQueryError,
  fetchKtDistinguished,
  fetchKtMonitor,
  fetchKtProof,
  fetchKtPublicConfig,
  ktQueryConfigured,
  parseFramedBytes,
} from '../src/utils/ktQuery.js';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(path.join(here, '../src/routes/ktQuery.ts'), 'utf8');
const appSource = readFileSync(path.join(here, '../src/app.ts'), 'utf8');

interface FakeAdapter {
  url: string;
  requests: Array<{ method: string; url: string; body: string }>;
  close: () => Promise<void>;
}

/** Adapter tiruan: menentukan jawaban lewat handler yang diberikan test. */
async function startFakeAdapter(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<FakeAdapter> {
  const requests: FakeAdapter['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      handler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('alamat server tiruan tidak diketahui');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Framing layanan baca: `u32 BE || payload` berurutan. */
function frame(...payloads: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  for (const payload of payloads) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.byteLength, 0);
    parts.push(length, Buffer.from(payload));
  }
  return Buffer.concat(parts);
}

const withAdapter = async (
  t: { after: (fn: () => Promise<void> | void) => void },
  handler: Parameters<typeof startFakeAdapter>[0]
) => {
  const adapter = await startFakeAdapter(handler);
  process.env.KT_QUERY_URL = adapter.url;
  t.after(async () => {
    delete process.env.KT_QUERY_URL;
    await adapter.close();
  });
  return adapter;
};

test('ktQuery: framing dibuka apa adanya dan tidak diubah', async (t) => {
  const treeHead = new Uint8Array([0x0a, 0x02, 0x08, 0x2a]);
  const condensed = new Uint8Array([0x0a, 0x01, 0xff]);
  await withAdapter(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(frame(treeHead, condensed));
  });

  const proof = await fetchKtProof({ hash: 'A'.repeat(43) });
  assert.deepEqual([...proof.fullTreeHead], [...treeHead]);
  assert.deepEqual([...proof.condensed], [...condensed]);
});

test('ktQuery: permintaan memuat hash/anchor, distinguished memakai jalurnya sendiri', async (t) => {
  const adapter = await withAdapter(t, (_req, res) => {
    res.writeHead(200);
    res.end(frame(new Uint8Array([0x01]), new Uint8Array([0x02])));
  });

  await fetchKtProof({ hash: 'A'.repeat(43), last: 64 });
  await fetchKtDistinguished({ distinguished: 7 });

  assert.equal(adapter.requests[0]!.url, `/search?hash=${'A'.repeat(43)}&last=64`);
  assert.equal(adapter.requests[1]!.url, '/distinguished?distinguished=7');
});

test('ktQuery: setiap kelas kegagalan punya kode sendiri (tidak ada "gagal senyap")', async (t) => {
  let status = 404;
  await withAdapter(t, (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"error":"NOT_FOUND"}');
  });

  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'NOT_FOUND'
  );

  status = 400;
  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'INVALID_ARGUMENT'
  );

  status = 500;
  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'UNAVAILABLE'
  );
});

test('ktQuery: tanpa KT_QUERY_URL → DISABLED, bukan TOFU senyap', async () => {
  delete process.env.KT_QUERY_URL;
  assert.equal(ktQueryConfigured(), false);
  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'DISABLED'
  );
});

test('ktQuery: layanan mati dibedakan dari "tidak ada di log"', async (t) => {
  const adapter = await startFakeAdapter((_req, res) => res.end());
  const url = adapter.url;
  await adapter.close();
  process.env.KT_QUERY_URL = url;
  t.after(() => {
    delete process.env.KT_QUERY_URL;
  });

  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'UNAVAILABLE'
  );
});

test('ktQuery: framing rusak ditolak, bukan diteruskan setengah', () => {
  assert.throws(() => parseFramedBytes(new Uint8Array([0x00, 0x00, 0x00])), KtQueryError);
  assert.throws(
    () => parseFramedBytes(new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x01])),
    (error: unknown) => error instanceof KtQueryError && error.code === 'MALFORMED_RESPONSE'
  );
  assert.equal(parseFramedBytes(new Uint8Array(0)).length, 0);
});

test('ktQuery: frame berjumlah ganjil (bukan 2) ditolak', async (t) => {
  await withAdapter(t, (_req, res) => {
    res.writeHead(200);
    res.end(frame(new Uint8Array([0x01]))); // hanya tree head
  });
  await assert.rejects(
    () => fetchKtProof({ hash: 'A'.repeat(43) }),
    (error: unknown) => error instanceof KtQueryError && error.code === 'MALFORMED_RESPONSE'
  );
});

test('ktQuery: monitor mengirim body biner dan mengembalikan respons apa adanya', async (t) => {
  const requestBytes = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
  const responseBytes = new Uint8Array([0x0a, 0x03, 0x08, 0x02, 0x01]);
  const adapter = await withAdapter(t, (_req, res) => {
    res.writeHead(200);
    res.end(Buffer.from(responseBytes));
  });

  const result = await fetchKtMonitor(requestBytes);
  assert.deepEqual([...result], [...responseBytes]);
  assert.equal(adapter.requests[0]!.method, 'POST');
  assert.equal(adapter.requests[0]!.url, '/monitor');
  assert.deepEqual([...Buffer.from(adapter.requests[0]!.body, 'latin1')], [...requestBytes]);
});

test('ktQuery: monitor kosong ditolak (tidak dipakai sebagai bukti)', async (t) => {
  await withAdapter(t, (_req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(0));
  });
  await assert.rejects(
    () => fetchKtMonitor(new Uint8Array([0x0a, 0x00])),
    (error: unknown) => error instanceof KtQueryError && error.code === 'MALFORMED_RESPONSE'
  );
});

test('ktQuery: config publik dibaca sebagai JSON; non-JSON ditolak', async (t) => {
  let body = JSON.stringify({ mode: 1, signatureKey: '00'.repeat(32), vrfKey: '11'.repeat(32) });
  await withAdapter(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });

  const config = await fetchKtPublicConfig();
  assert.equal(config.mode, 1);
  assert.equal(config.signatureKey, '00'.repeat(32));

  body = 'bukan json';
  await assert.rejects(
    () => fetchKtPublicConfig(),
    (error: unknown) => error instanceof KtQueryError && error.code === 'MALFORMED_RESPONSE'
  );
});

test('ktQuery: hasil terhitung di metrik, termasuk saat nonaktif', async (t) => {
  resetMetricsForTests();
  await withAdapter(t, (_req, res) => {
    res.writeHead(200);
    res.end(frame(new Uint8Array([0x01]), new Uint8Array([0x02])));
  });
  await fetchKtProof({ hash: 'A'.repeat(43) });

  delete process.env.KT_QUERY_URL;
  await assert.rejects(() => fetchKtProof({ hash: 'A'.repeat(43) }));

  const text = renderMetricsText();
  assert.match(text, /nyx_kt_queries_total\{result="ok"\} 1/);
  assert.match(text, /nyx_kt_queries_total\{result="disabled"\} 1/);
});

test('ktQuery: proxy mengikat auth + limiter dan memetakan kode error yang terlihat', () => {
  assert.match(routerSource, /requireAuth/, 'endpoint KT wajib terautentikasi');
  assert.match(routerSource, /generalLimiter/, 'endpoint KT dibatasi lajunya');
  assert.match(routerSource, /KT_QUERY_DISABLED/, 'tanpa KT_QUERY_URL = 503 terlihat');
  assert.match(routerSource, /KT_NOT_FOUND/, 'tidak ada di log = 404 terpisah dari kegagalan layanan');
  assert.match(routerSource, /KT_UNAVAILABLE/, 'kegagalan layanan = error yang terlihat');
  // Tidak ada parser protobuf di JS: parser ada di WASM, server hanya meneruskan
  // byte apa adanya (base64url keluar-masuk).
  assert.doesNotMatch(
    routerSource,
    /protobufjs|google-protobuf|@bufbuild\/protobuf/,
    'server tidak boleh menafsirkan bukti dengan parser protobuf'
  );
});

test('ktQuery: router di-mount SEBELUM router keys yang lebih umum', () => {
  const ktMount = appSource.indexOf('app.use("/api/keys/kt", ktQueryRouter)');
  const keysMount = appSource.indexOf('app.use("/api/keys", keysRouter)');
  assert.ok(ktMount > 0, 'router KT terdaftar di app.ts');
  assert.ok(keysMount > 0, 'router keys terdaftar di app.ts');
  assert.ok(
    ktMount < keysMount,
    'router KT harus lebih dulu: kalau tidak, `/api/keys/kt/...` diperiksa router keys dulu'
  );
});
