import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPirRefreshConfig,
  refreshPirSnapshot,
  refreshPirSnapshotIfDirty,
  type PirRefreshConfig,
} from '../src/jobs/pirSnapshot.js';
import {
  PIR_SNAPSHOT_BUILT_KEY,
  PIR_SNAPSHOT_GEN_KEY,
  markPirSnapshotDirty,
  type PirDirtyRedis,
} from '../src/pir/dirty.js';
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

/** Redis palsu: cukup `incr`/`get`/`set` seperti yang dipakai penanda generasi. */
class FakeRedis implements PirDirtyRedis {
  store = new Map<string, string>();
  failOnGet = false;

  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  async get(key: string): Promise<string | null> {
    if (this.failOnGet) throw new Error('redis down');
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
}

test('PIR dirty: penanda hanya aktif saat PIR hidup dan tidak pernah melempar', async () => {
  const redis = new FakeRedis();
  assert.equal(await markPirSnapshotDirty('register', { redis, env: {} }), false);
  assert.equal(redis.store.get(PIR_SNAPSHOT_GEN_KEY), undefined, 'fitur mati = nol tulisan Redis');

  assert.equal(await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } }), true);
  assert.equal(await markPirSnapshotDirty('profile', { redis, env: { PIR_ENABLED: '1' } }), true);
  assert.equal(redis.store.get(PIR_SNAPSHOT_GEN_KEY), '2', 'generasi naik per perubahan');

  const broken = new FakeRedis();
  broken.incr = async () => { throw new Error('redis down'); };
  // Registrasi/login TIDAK boleh gagal hanya karena penanda tidak bisa ditulis.
  assert.equal(await markPirSnapshotDirty('register', { redis: broken, env: { PIR_ENABLED: '1' } }), false);
});

test('PIR rebuild interval: bersih tanpa perubahan, sekali rebuild saat generasi naik', async () => {
  const redis = new FakeRedis();
  let builds = 0;
  const fetchImpl: typeof fetch = async () => {
    builds += 1;
    return new Response('{"status":"ok"}', { status: 200 });
  };
  const deps = {
    redis,
    fetchImpl,
    collect: async () => [source('u1', 'a'.repeat(64))],
    now: () => 100,
  };

  // Belum ada penanda sama sekali → tanpa rebuild (cron harian tetap jalan).
  assert.equal((await refreshPirSnapshotIfDirty(config, deps)).status, 'clean');
  assert.equal(builds, 0);

  await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
  const first = await refreshPirSnapshotIfDirty(config, deps);
  assert.equal(first.status, 'rebuilt');
  assert.equal(first.entries, 1);
  assert.equal(builds, 1);
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '1');

  // Generasi yang sudah tercakup tidak membangun ulang.  
  assert.equal((await refreshPirSnapshotIfDirty(config, deps)).status, 'clean');
  assert.equal(builds, 1);
});

test('PIR rebuild interval: perubahan saat rebuild berjalan tidak hilang', async () => {
  const redis = new FakeRedis();
  let builds = 0;
  const fetchImpl: typeof fetch = async () => {
    builds += 1;
    return new Response('{"status":"ok"}', { status: 200 });
  };
  const deps = {
    redis,
    fetchImpl,
    // Pendaftaran baru terjadi tepat saat snapshot sedang dibangun.
    collect: async () => {
      await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
      return [source('u1', 'a'.repeat(64))];
    },
    now: () => 100,
  };

  // Perubahan pertama (generasi 1) memicu rebuild; `collect` menambah generasi
  // ke 2 saat build berjalan.
  await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
  assert.equal((await refreshPirSnapshotIfDirty(config, deps)).status, 'rebuilt');
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '1');
  assert.equal(redis.store.get(PIR_SNAPSHOT_GEN_KEY), '2');

  // Tick berikutnya melihat generasi 2 > 1 → rebuild lagi (tidak ada yang terlewat).
  assert.equal((await refreshPirSnapshotIfDirty(config, deps)).status, 'rebuilt');
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '2');
  assert.equal(builds, 2);
});

test('PIR rebuild interval: Redis tidak terbaca = lewati, bukan rebuild buta', async () => {
  const redis = new FakeRedis();
  redis.failOnGet = true;
  let builds = 0;
  const result = await refreshPirSnapshotIfDirty(config, {
    redis,
    fetchImpl: async () => { builds += 1; return new Response('ok', { status: 200 }); },
    collect: async () => [source('u1', 'a'.repeat(64))],
  });
  assert.equal(result.status, 'unknown');
  assert.equal(builds, 0);
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
