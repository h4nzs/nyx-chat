// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP6] Klien XOR-PIR dua server.
 *
 * Alur satu pencarian:
 *   1. ringkasan manifest A dan B → `shardCount` harus sama;
 *   2. `shard = pirShardFor(oprfIndex, shardCount)`;
 *   3. manifest shard dari A dan B → verifikasi tanda tangan + harus identik
 *      selain `operator` (`PIR_DESYNC`), epoch tidak boleh turun
 *      (`PIR_ROLLBACK`);
 *   4. tiga slot kandidat; tiap slot dikirim sebagai dua share ke dua server
 *      lewat dua relay OHTTP; jawabannya di-XOR;
 *   5. record dibaca dengan `decodePirRecord`: `ix` cocok = hit, slot milik
 *      kunci lain dilewati, checksum/versi salah = `PIR_TAMPERED`.
 *
 * Tidak ada WASM dan tidak ada fallback ke `/api/users/search`: satu server
 * yang gagal membuat seluruh pencarian gagal, karena jawaban satu server tidak
 * berarti apa pun sendiri.
 */

import {
  decodePirRecord,
  pirManifestsAgree,
  pirRecordCandidates,
  pirShardFor,
  pirShareLen,
  pirShareToggle,
  pirXor,
  type PirManifest,
} from '@nyx/shared';
import { ohttpEnabled, ohttpFetch, type OhttpHttpResult } from './ohttpClient';
import {
  PirError,
  checkPirEpoch,
  fetchPirManifest,
  fetchPirSummary,
  pirClientConfig,
  type PirClientServer,
} from './pirManifest';
import type { UserSearchHit } from './userSearch';

export { PirError };

const INDEX_HEX = /^[0-9a-f]{64}$/;

/** PIR hidup hanya bila build menyalakannya DAN OHTTP tersedia (fail-closed). */
export function pirEnabled(): boolean {
  return import.meta.env.VITE_PIR_ENABLED === '1' && ohttpEnabled();
}

function toIndex(oprfIndexHex: string): Uint8Array {
  if (!INDEX_HEX.test(oprfIndexHex)) {
    throw new PirError('PIR_INDEX_INVALID', 'oprfIndex harus 32 byte hex huruf kecil');
  }
  const bytes = new Uint8Array(32);
  for (let offset = 0; offset < 32; offset += 1) {
    bytes[offset] = Number.parseInt(oprfIndexHex.slice(offset * 2, offset * 2 + 2), 16);
  }
  return bytes;
}

function randomShare(slotCount: number): Uint8Array {
  const share = new Uint8Array(pirShareLen(slotCount));
  globalThis.crypto.getRandomValues(share);
  return share;
}

async function postShare(
  server: PirClientServer,
  shard: number,
  share: Uint8Array,
): Promise<Uint8Array> {
  if (!ohttpEnabled()) throw new PirError('PIR_REQUIRES_OHTTP');
  let response: OhttpHttpResult;
  try {
    response = await ohttpFetch(`/api/pir/${server.id}/query?shard=${shard}`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/octet-stream'],
        ['accept', 'application/octet-stream'],
      ],
      body: share,
      ...(server.relayUrl ? { relayUrl: server.relayUrl } : {}),
    });
  } catch (error) {
    if (error instanceof PirError) throw error;
    throw new PirError('PIR_UNAVAILABLE', `query ${server.id} gagal`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PirError('PIR_UNAVAILABLE', `query ${server.id} HTTP ${response.status}`);
  }
  return response.body;
}

function toHit(body: Uint8Array): UserSearchHit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new PirError('PIR_TAMPERED', 'record bukan JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PirError('PIR_TAMPERED', 'record bukan objek');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') {
    throw new PirError('PIR_TAMPERED', 'record tanpa id');
  }
  const hit: UserSearchHit = { id: record.id };
  if (typeof record.encryptedProfile === 'string' || record.encryptedProfile === null) {
    hit.encryptedProfile = record.encryptedProfile;
  }
  if (typeof record.isVerified === 'boolean') hit.isVerified = record.isVerified;
  if (typeof record.publicKey === 'string') hit.publicKey = record.publicKey;
  return hit;
}

async function pairedManifests(
  shardCount: number,
  index: Uint8Array,
): Promise<PirManifest> {
  const config = pirClientConfig();
  const [first, second] = config.servers;
  const shard = pirShardFor(index, shardCount);
  const [a, b] = await Promise.all([
    fetchPirManifest(first, shard),
    fetchPirManifest(second, shard),
  ]);
  // Rebuild bisa terjadi di antara ringkasan dan manifest; shard yang dihitung
  // dari ringkasan lama lalu tidak sah. Gagal tertutup, jangan menebak.
  if (a.manifest.shardCount !== shardCount || b.manifest.shardCount !== shardCount) {
    throw new PirError('PIR_DESYNC', 'shardCount berubah antar-request');
  }
  if (!pirManifestsAgree(a.manifest, b.manifest)) {
    throw new PirError('PIR_DESYNC', `manifest shard ${shard} berbeda antar-server`);
  }
  checkPirEpoch(a.manifest);
  return a.manifest;
}

/**
 * Cari satu `oprfIndex`; `null` = tidak ada (ketiga slot kosong/milik kunci
 * lain). Kegagalan integritas melempar `PirError`, tidak pernah `null`.
 */
export async function pirSearch(oprfIndexHex: string): Promise<UserSearchHit | null> {
  if (!pirEnabled()) throw new PirError('PIR_DISABLED');
  const index = toIndex(oprfIndexHex);
  const config = pirClientConfig();
  const [first, second] = config.servers;

  const [summaryA, summaryB] = await Promise.all([
    fetchPirSummary(first),
    fetchPirSummary(second),
  ]);
  if (summaryA.shardCount !== summaryB.shardCount || summaryA.epoch !== summaryB.epoch) {
    throw new PirError('PIR_DESYNC', 'ringkasan manifest berbeda antar-server');
  }

  const manifest = await pairedManifests(summaryA.shardCount, index);
  const candidates = pirRecordCandidates(index, manifest.slotCount);

  for (const slot of candidates) {
    const q1 = randomShare(manifest.slotCount);
    const q2 = q1.slice();
    pirShareToggle(q2, slot);
    const [a1, a2] = await Promise.all([
      postShare(first, manifest.shard, q1),
      postShare(second, manifest.shard, q2),
    ]);
    if (a1.length !== manifest.recordBytes || a2.length !== manifest.recordBytes) {
      throw new PirError('PIR_TAMPERED', 'panjang jawaban tidak sesuai manifest');
    }
    let decoded;
    try {
      decoded = decodePirRecord(pirXor(a1, a2), index);
    } catch {
      throw new PirError('PIR_TAMPERED', 'record gagal diverifikasi');
    }
    if (decoded.status === 'ok') return toHit(decoded.body);
  }
  return null;
}
