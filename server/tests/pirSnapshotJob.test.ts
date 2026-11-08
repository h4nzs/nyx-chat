import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPirRefreshConfig,
  refreshPirSnapshot,
  refreshPirSnapshotIfDirty,
} from '../src/jobs/pirSnapshot.js';
import type { PirConfig } from '../src/pir/config.js';
import {
  PIR_SNAPSHOT_BUILT_KEY,
  PIR_SNAPSHOT_GEN_KEY,
  markPirSnapshotDirty,
  type PirDirtyRedis,
} from '../src/pir/dirty.js';
import { loadPirSigningKeyBytes, type PirSigningKey } from '../src/pir/manifest.js';
import type { PirRecordSource } from '../src/pir/snapshot.js';

const KEY_A = loadPirSigningKeyBytes(new Uint8Array(32).fill(1));
const KEY_B = loadPirSigningKeyBytes(new Uint8Array(32).fill(2));

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

function config(overrides: Partial<PirConfig> = {}): PirConfig {
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
    recordBytes: 256,
    shardDir: null,
    ...overrides,
  };
}

function signingKeys(keys: { a: PirSigningKey; b: PirSigningKey } = { a: KEY_A, b: KEY_B }) {
  return new Map(Object.entries(keys));
}

function envFor(token = 'secret'): NodeJS.ProcessEnv {
  return {
    PIR_ENABLED: '1',
    PIR_SERVERS: JSON.stringify(config().servers),
    PIR_MANIFEST_KEYS: JSON.stringify({
      a: Buffer.from(KEY_A.publicKey).toString('base64url'),
      b: Buffer.from(KEY_B.publicKey).toString('base64url'),
    }),
    PIR_SIGNING_KEYS: JSON.stringify({ a: '/tmp/a.key', b: '/tmp/b.key' }),
    PIR_ADMIN_TOKEN: token,
    PIR_RECORD_BYTES: '256',
    PIR_SHARD_DIR: '/tmp/pir-shards',
  };
}

test('PIR refresh config: mati tanpa PIR aktif, null tanpa token admin', () => {
  assert.equal(loadPirRefreshConfig({}), null);
  assert.equal(loadPirRefreshConfig({ PIR_ENABLED: '1' }), null);
  assert.equal(loadPirRefreshConfig(envFor('')), null);

  const loaded = loadPirRefreshConfig(envFor());
  assert.ok(loaded);
  assert.deepEqual(
    loaded.servers.map((server) => server.url),
    ['http://127.0.0.1:9470', 'http://127.0.0.1:9471'],
  );
  assert.equal(loaded.adminToken, 'secret');
  assert.equal(loaded.recordBytes, 256);
  assert.equal(loaded.shardDir, '/tmp/pir-shards');
});

test('PIR refresh: build per server, tulis berkas, lalu hot-swap kedua sidecar', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nyx-pir-refresh-'));
  try {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('{"status":"ok"}', { status: 200 });
    };

    const result = await refreshPirSnapshot(
      config({ shardDir: dir }),
      {
        collect: async () => [source('u1', 'a'.repeat(64)), source('u2', 'b'.repeat(64))],
        fetchImpl,
        now: () => 123456789,
        signingKeys: signingKeys(),
      },
    );

    assert.deepEqual(result, { epoch: 123456789, entries: 2, shards: 1, persisted: true });
    assert.deepEqual(
      requests.map((request) => request.url),
      ['http://127.0.0.1:9470/admin/rebuild', 'http://127.0.0.1:9471/admin/rebuild'],
    );

    const [a, b] = requests as [
      { body: { manifest: Record<string, unknown>; signature: string; slots: string } },
      { body: { manifest: Record<string, unknown>; signature: string; slots: string } },
    ];
    assert.equal(a.body.manifest.operator, 'a');
    assert.equal(b.body.manifest.operator, 'b');
    assert.equal(a.body.manifest.dbRoot, b.body.manifest.dbRoot);
    assert.equal(a.body.manifest.slotCount, 4096);
    assert.notEqual(a.body.signature, b.body.signature);
    assert.equal(
      Buffer.from(a.body.slots, 'base64url').length,
      4096 * 256,
      'slot biner harus slotCount*recordBytes',
    );

    for (const role of ['a', 'b']) {
      const bin = path.join(dir, role, 'shard-0.bin');
      const json = path.join(dir, role, 'shard-0.json');
      assert.equal((await stat(bin)).size, 4096 * 256);
      const stored = JSON.parse(await readFile(json, 'utf8')) as {
        manifest: { operator: string; epoch: number };
        signature: string;
      };
      assert.equal(stored.manifest.operator, role);
      assert.equal(stored.manifest.epoch, 123456789);
      assert.ok(stored.signature.length > 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PIR refresh: rebuild tanpa token admin ditolak sebelum menyentuh sidecar', async () => {
  await assert.rejects(
    refreshPirSnapshot(config({ adminToken: null }), {
      collect: async () => [source('u1', 'a'.repeat(64))],
      fetchImpl: async () => {
        throw new Error('tidak boleh dipanggil');
      },
      signingKeys: signingKeys(),
    }),
    /PIR_ADMIN_TOKEN/,
  );
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
  const deps = {
    redis,
    fetchImpl: async () => {
      builds += 1;
      return new Response('{"status":"ok"}', { status: 200 });
    },
    collect: async () => [source('u1', 'a'.repeat(64))],
    now: () => 100,
    signingKeys: signingKeys(),
  };

  // Belum ada penanda sama sekali → tanpa rebuild (cron harian tetap jalan).
  assert.equal((await refreshPirSnapshotIfDirty(config(), deps)).status, 'clean');
  assert.equal(builds, 0);

  await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
  const first = await refreshPirSnapshotIfDirty(config(), deps);
  assert.equal(first.status, 'rebuilt');
  assert.equal(first.entries, 1);
  assert.equal(builds, 2, 'satu rebuild = satu request per server');
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '1');

  // Generasi yang sudah tercakup tidak membangun ulang.
  assert.equal((await refreshPirSnapshotIfDirty(config(), deps)).status, 'clean');
  assert.equal(builds, 2);
});

test('PIR rebuild interval: perubahan saat rebuild berjalan tidak hilang', async () => {
  const redis = new FakeRedis();
  let builds = 0;
  const deps = {
    redis,
    fetchImpl: async () => {
      builds += 1;
      return new Response('{"status":"ok"}', { status: 200 });
    },
    // Pendaftaran baru terjadi tepat saat shard sedang dibangun.
    collect: async () => {
      await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
      return [source('u1', 'a'.repeat(64))];
    },
    now: () => 100,
    signingKeys: signingKeys(),
  };

  // Perubahan pertama (generasi 1) memicu rebuild; `collect` menambah generasi
  // ke 2 saat build berjalan.
  await markPirSnapshotDirty('register', { redis, env: { PIR_ENABLED: '1' } });
  assert.equal((await refreshPirSnapshotIfDirty(config(), deps)).status, 'rebuilt');
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '1');
  assert.equal(redis.store.get(PIR_SNAPSHOT_GEN_KEY), '2');

  // Tick berikutnya melihat generasi 2 > 1 → rebuild lagi (tidak ada yang terlewat).
  assert.equal((await refreshPirSnapshotIfDirty(config(), deps)).status, 'rebuilt');
  assert.equal(redis.store.get(PIR_SNAPSHOT_BUILT_KEY), '2');
  assert.equal(builds, 4);
});

test('PIR rebuild interval: Redis tidak terbaca = lewati, bukan rebuild buta', async () => {
  const redis = new FakeRedis();
  redis.failOnGet = true;
  let builds = 0;
  const result = await refreshPirSnapshotIfDirty(config(), {
    redis,
    fetchImpl: async () => {
      builds += 1;
      return new Response('ok', { status: 200 });
    },
    collect: async () => [source('u1', 'a'.repeat(64))],
    signingKeys: signingKeys(),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(builds, 0);
});

test('PIR refresh: sidecar menolak rebuild = job gagal terlihat', async () => {
  await assert.rejects(
    refreshPirSnapshot(config(), {
      collect: async () => [source('u1', 'c'.repeat(64))],
      fetchImpl: async () => new Response('{"error":"PIR_EPOCH_STALE"}', { status: 409 }),
      now: () => 7,
      signingKeys: signingKeys(),
    }),
    /menolak shard 0 HTTP 409/,
  );
});
