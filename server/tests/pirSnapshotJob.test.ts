import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPirRefreshConfig,
  refreshPirSnapshot,
  type PirRefreshConfig,
} from '../src/jobs/pirSnapshot.js';
import type { PirRecordSource } from '../src/pir/snapshot.js';

function source(id: string, oprf: string): PirRecordSource {
  return {
    id,
    encryptedProfile: `profile-${id}`,
    isVerified: true,
    hasCompletedOnboarding: true,
    oprfIndex: oprf,
    device: {
      publicKey: Uint8Array.from([1, 2, 3]),
      pqPublicKey: null,
      signingKey: Uint8Array.from([4, 5]),
    },
  };
}

const config: PirRefreshConfig = {
  serviceUrl: 'http://127.0.0.1:9470',
  adminToken: 'admin-secret',
  recordBytes: 256,
  snapshotPath: null,
};

test('PIR refresh config: butuh PIR aktif dan token admin', () => {
  assert.equal(loadPirRefreshConfig({}), null);
  assert.equal(loadPirRefreshConfig({ PIR_ENABLED: '1' }), null);
  assert.deepEqual(
    loadPirRefreshConfig({
      PIR_ENABLED: '1',
      PIR_ADMIN_TOKEN: 'secret',
      PIR_RECORD_BYTES: '4096',
      PIR_SNAPSHOT_PATH: '/tmp/pir.json',
    }),
    {
      serviceUrl: 'http://127.0.0.1:9470',
      adminToken: 'secret',
      recordBytes: 4096,
      snapshotPath: '/tmp/pir.json',
    },
  );
});

test('PIR refresh: bangun snapshot, tulis file atomik, lalu hot-swap sidecar', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nyx-pir-refresh-'));
  try {
    const snapshotPath = path.join(dir, 'snapshot.json');
    let request: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response('{"status":"ok"}', { status: 200 });
    };

    const result = await refreshPirSnapshot(
      { ...config, snapshotPath },
      {
        collect: async () => [source('u1', 'a'.repeat(64)), source('u2', 'b'.repeat(64))],
        fetchImpl,
        now: () => 123456789,
      },
    );

    assert.deepEqual(result, { epoch: 123456789, entries: 2, persisted: true });
    assert.ok(request);
    const sent = request as { url: string; init: RequestInit };
    assert.equal(sent.url, 'http://127.0.0.1:9470/admin/rebuild');
    assert.equal((sent.init.headers as Record<string, string>)['x-nyx-pir-internal'], 'admin-secret');
    assert.equal(sent.init.method, 'POST');

    const onDisk = JSON.parse(await readFile(snapshotPath, 'utf8')) as { epoch: number; entries: unknown[] };
    assert.equal(onDisk.epoch, 123456789);
    assert.equal(onDisk.entries.length, 2);
    assert.deepEqual(JSON.parse(String(sent.init.body)), onDisk);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PIR refresh: sidecar menolak rebuild = job gagal terlihat', async () => {
  await assert.rejects(
    refreshPirSnapshot(config, {
      collect: async () => [source('u1', 'c'.repeat(64))],
      fetchImpl: async () => new Response('{"error":"PIR_EPOCH_STALE"}', { status: 409 }),
      now: () => 7,
    }),
    /PIR refresh HTTP 409/,
  );
});
