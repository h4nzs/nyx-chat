// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP5] Builder artefak per shard + pengiriman ke setiap server.
 *
 * Manifest tiap server ditandatangani dengan kunci **server itu** dan memakai
 * `operator` = id server, sehingga A dan B berbeda hanya pada dua hal itu —
 * persis yang dibandingkan klien (`pirManifestsAgree`). `dbRoot` harus identik
 * antar-server; kalau tidak, berarti penempatan cuckoo tidak deterministik dan
 * build dibatalkan sebelum satu byte pun dikirim.
 *
 * Tanpa Prisma/Redis: pengumpulan user disuntikkan lewat `deps.collect`.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PirConfig, PirServer } from './config.js';
import { loadPirSigningKey, type PirSigningKey } from './manifest.js';
import type { PirRecordSource } from './snapshot.js';
import { buildPirShards, serializePirShard, type PirShardArtifact } from './shards.js';

const REBUILD_TIMEOUT_MS = 60 * 60_000;

export interface PirRebuildDeps {
  collect: () => Promise<PirRecordSource[]>;
  /** Kunci per server; default dibaca dari `PIR_SIGNING_KEYS`. */
  signingKeys?: Map<string, PirSigningKey>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PirRebuildResult {
  epoch: number;
  entries: number;
  shards: number;
  persisted: boolean;
}

async function loadSigningKeys(config: PirConfig): Promise<Map<string, PirSigningKey>> {
  const keys = new Map<string, PirSigningKey>();
  for (const server of config.servers) {
    const file = config.signingKeys.get(server.id);
    if (!file) {
      throw new Error(`PIR: PIR_SIGNING_KEYS tidak memuat berkas kunci untuk server ${server.id}`);
    }
    keys.set(server.id, await loadPirSigningKey(file));
  }
  return keys;
}

async function writeShardFiles(dir: string, artifacts: PirShardArtifact[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const artifact of artifacts) {
    const { bin, json } = serializePirShard(artifact);
    const base = path.join(dir, `shard-${artifact.manifest.shard}`);
    for (const [target, data] of [
      [`${base}.bin`, bin],
      [`${base}.json`, Buffer.from(json, 'utf8')],
    ] as const) {
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, target);
    }
  }
}

async function pushShards(
  server: PirServer,
  artifacts: PirShardArtifact[],
  adminToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  for (const artifact of artifacts) {
    const { bin, json } = serializePirShard(artifact);
    const payload = JSON.parse(json) as { manifest: unknown; signature: string };
    const body = JSON.stringify({
      manifest: payload.manifest,
      signature: payload.signature,
      slots: Buffer.from(bin).toString('base64url'),
    });
    const response = await fetchImpl(`${server.url}/admin/rebuild`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nyx-pir-internal': adminToken,
      },
      body,
      signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `PIR: server ${server.id} menolak shard ${artifact.manifest.shard} ` +
          `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
  }
}

export async function rebuildPirShards(
  config: PirConfig,
  deps: PirRebuildDeps,
): Promise<PirRebuildResult> {
  if (!config.adminToken) {
    throw new Error('PIR: PIR_ADMIN_TOKEN kosong; rebuild tidak bisa dikirim ke sidecar');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const keys = deps.signingKeys ?? (await loadSigningKeys(config));
  const sources = await deps.collect();
  const epoch = (deps.now ?? Date.now)();

  let reference: string[] | null = null;
  let shards = 0;
  for (const server of config.servers) {
    const signingKey = keys.get(server.id);
    if (!signingKey) {
      throw new Error(`PIR: kunci penanda tangan server ${server.id} tidak tersedia`);
    }
    const artifacts = buildPirShards(sources, {
      recordBytes: config.recordBytes,
      epoch,
      operator: server.id,
      signingKey,
    });
    const roots = artifacts.map((artifact) => artifact.manifest.dbRoot);
    const expectedRoots = reference;
    if (expectedRoots === null) {
      reference = roots;
    } else if (
      roots.length !== expectedRoots.length ||
      roots.some((root, index) => root !== expectedRoots[index])
    ) {
      throw new Error('PIR: dbRoot antar-server berbeda; build dibatalkan sebelum dikirim');
    }
    shards = artifacts.length;

    if (config.shardDir) {
      await writeShardFiles(path.join(path.resolve(config.shardDir), server.id), artifacts);
    }
    await pushShards(server, artifacts, config.adminToken, fetchImpl);
  }

  return {
    epoch,
    entries: sources.length,
    shards,
    persisted: Boolean(config.shardDir),
  };
}
