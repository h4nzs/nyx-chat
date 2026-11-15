// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP6] Manifest PIR di sisi klien: konfigurasi, pengambilan lewat
 * OHTTP, verifikasi tanda tangan, dan penjaga epoch.
 *
 * Klien tidak mempercayai proxy API maupun sidecar. Yang mengikat jawaban ke
 * database adalah `dbRoot` di manifest yang ditandatangani ML-DSA-65 dengan
 * kunci yang di-pin saat build; semua pemeriksaan di sini fail-closed.
 */

import {
  PIR_MANIFEST_DOMAIN,
  PIR_SUITE,
  mlDsaVerify,
  parsePirManifest,
  pirManifestMessage,
  type PirManifest,
} from '@nyx/shared';
import { ohttpEnabled, ohttpFetch, type OhttpHttpResult } from './ohttpClient';

export type PirErrorCode =
  | 'PIR_DISABLED'
  | 'PIR_REQUIRES_OHTTP'
  | 'PIR_CONFIG_INVALID'
  | 'PIR_REQUIRES_OPRF'
  | 'PIR_INDEX_INVALID'
  | 'PIR_UNAVAILABLE'
  | 'PIR_MANIFEST_INVALID'
  | 'PIR_DESYNC'
  | 'PIR_ROLLBACK'
  | 'PIR_TAMPERED';

export class PirError extends Error {
  constructor(
    readonly code: PirErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PirError';
  }
}

export interface PirClientServer {
  id: string;
  /** Relay OHTTP khusus server ini (dua relay berbeda = salah satu syarat privasi). */
  relayUrl?: string;
  publicKey: Uint8Array;
}

export interface PirClientConfig {
  servers: [PirClientServer, PirClientServer];
}

export interface PirSummary {
  suite: string;
  shardCount: number;
  epoch: number;
}

const SERVER_ID = /^[a-z0-9_-]{1,16}$/;
const EPOCH_PREFIX = 'nyx_pir_epoch:';

function decodeBase64Url(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PirError('PIR_CONFIG_INVALID', `${label} bukan base64url`);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJsonEnv(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw || raw.trim() === '') {
    throw new PirError('PIR_CONFIG_INVALID', `${label} kosong`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PirError('PIR_CONFIG_INVALID', `${label} bukan JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PirError('PIR_CONFIG_INVALID', `${label} harus JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * `VITE_PIR_MANIFEST_KEYS` = `{ "a": "<base64url pubkey>", "b": "..." }`,
 * `VITE_PIR_RELAYS` = `{ "a": "/api/ohttp/relay-a", "b": "/api/ohttp/relay-b" }`
 * (opsional; tanpa itu kedua request memakai relay default).
 */
export function loadPirClientConfig(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): PirClientConfig {
  const keys = parseJsonEnv(env.VITE_PIR_MANIFEST_KEYS, 'VITE_PIR_MANIFEST_KEYS');
  const relays = env.VITE_PIR_RELAYS?.trim()
    ? parseJsonEnv(env.VITE_PIR_RELAYS, 'VITE_PIR_RELAYS')
    : {};

  const servers = Object.entries(keys).map(([id, value]) => {
    if (!SERVER_ID.test(id)) {
      throw new PirError('PIR_CONFIG_INVALID', `id server ${id} tidak valid`);
    }
    const publicKey = decodeBase64Url(value, `kunci ${id}`);
    const relay = relays[id];
    return {
      id,
      publicKey,
      ...(typeof relay === 'string' && relay.trim() ? { relayUrl: relay.trim() } : {}),
    };
  });

  if (servers.length !== 2) {
    throw new PirError('PIR_CONFIG_INVALID', 'PIR membutuhkan tepat dua kunci manifest');
  }
  return { servers: [servers[0]!, servers[1]!] };
}

let cachedConfig: PirClientConfig | null = null;

export function pirClientConfig(): PirClientConfig {
  cachedConfig ??= loadPirClientConfig();
  return cachedConfig;
}

function manifestUrl(serverId: string, shard?: number): string {
  const base = `/api/pir/${serverId}/manifest`;
  return shard === undefined ? base : `${base}?shard=${shard}`;
}

function ok(result: OhttpHttpResult): boolean {
  return result.status >= 200 && result.status < 300;
}

function decodeJson(result: OhttpHttpResult, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(result.body)) as unknown;
  } catch {
    throw new PirError('PIR_MANIFEST_INVALID', `${label} bukan JSON`);
  }
}

async function pirFetch(path: string, relayUrl: string | undefined): Promise<OhttpHttpResult> {
  if (!ohttpEnabled()) throw new PirError('PIR_REQUIRES_OHTTP');
  return ohttpFetch(path, {
    method: 'GET',
    headers: [['accept', 'application/json']],
    ...(relayUrl ? { relayUrl } : {}),
  });
}

export async function fetchPirSummary(server: PirClientServer): Promise<PirSummary> {
  let response: OhttpHttpResult;
  try {
    response = await pirFetch(manifestUrl(server.id), server.relayUrl);
  } catch (error) {
    if (error instanceof PirError) throw error;
    // Sebab asli ikut dicetak: `OHTTP config: HTTP 404` / `OHTTP_HTTP_503` /
    // worker error adalah tiga kegagalan yang sangat berbeda, dan pesan
    // "tidak terjangkau" saja membuat semuanya tampak sama.
    const cause = error instanceof Error ? error.message : String(error);
    throw new PirError('PIR_UNAVAILABLE', `manifest ringkasan tidak terjangkau: ${cause}`);
  }
  if (!ok(response)) throw new PirError('PIR_UNAVAILABLE', `manifest HTTP ${response.status}`);
  const parsed = decodeJson(response, 'ringkasan');
  if (!parsed || typeof parsed !== 'object') {
    throw new PirError('PIR_MANIFEST_INVALID', 'ringkasan bukan objek');
  }
  const body = parsed as { suite?: unknown; shardCount?: unknown; epoch?: unknown };
  if (
    body.suite !== PIR_SUITE ||
    !Number.isSafeInteger(body.shardCount) ||
    (body.shardCount as number) < 1 ||
    !Number.isSafeInteger(body.epoch) ||
    (body.epoch as number) <= 0
  ) {
    throw new PirError('PIR_MANIFEST_INVALID', 'ringkasan manifest tidak valid');
  }
  return {
    suite: PIR_SUITE,
    shardCount: body.shardCount as number,
    epoch: body.epoch as number,
  };
}

export interface SignedPirManifest {
  manifest: PirManifest;
  signature: string;
}

export async function fetchPirManifest(
  server: PirClientServer,
  shard: number,
): Promise<SignedPirManifest> {
  let response: OhttpHttpResult;
  try {
    response = await pirFetch(manifestUrl(server.id, shard), server.relayUrl);
  } catch (error) {
    if (error instanceof PirError) throw error;
    throw new PirError('PIR_UNAVAILABLE', 'manifest tidak terjangkau');
  }
  if (!ok(response)) throw new PirError('PIR_UNAVAILABLE', `manifest HTTP ${response.status}`);

  const parsedPayload = decodeJson(response, 'manifest');
  if (!parsedPayload || typeof parsedPayload !== 'object') {
    throw new PirError('PIR_MANIFEST_INVALID', 'manifest bukan objek');
  }
  const payload = parsedPayload as { manifest?: unknown; signature?: unknown };
  const manifest = parsePirManifest(payload.manifest);
  if (manifest.shard !== shard) {
    throw new PirError('PIR_MANIFEST_INVALID', 'manifest untuk shard lain');
  }
  const signature = typeof payload.signature === 'string' ? payload.signature : '';
  if (signature === '') {
    throw new PirError('PIR_MANIFEST_INVALID', 'tanda tangan manifest kosong');
  }
  const signatureBytes = decodeBase64Url(signature, 'tanda tangan manifest');
  let valid = false;
  try {
    valid = mlDsaVerify(
      signatureBytes,
      pirManifestMessage(manifest),
      server.publicKey,
      PIR_MANIFEST_DOMAIN,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new PirError('PIR_MANIFEST_INVALID', `tanda tangan ${server.id} tidak valid`);
  return { manifest, signature };
}

/** Epoch tidak boleh turun; disimpan lokal per shard (bukan per server). */
export function checkPirEpoch(manifest: PirManifest): void {
  const key = `${EPOCH_PREFIX}${manifest.shard}`;
  let stored: number | null = null;
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? null;
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    stored = Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    stored = null;
  }
  if (stored !== null && manifest.epoch < stored) {
    throw new PirError('PIR_ROLLBACK', `epoch shard ${manifest.shard} turun`);
  }
  try {
    if (stored === null || manifest.epoch > stored) {
      globalThis.localStorage?.setItem(key, String(manifest.epoch));
    }
  } catch {
    // localStorage penuh/diblokir: tanpa state, pemeriksaan rollback dilewati
    // sampai penulisan berhasil lagi. Kegagalan menyimpan tidak boleh
    // menggagalkan pencarian yang sudah valid.
  }
}

export function _resetPirManifestCacheForTests(): void {
  cachedConfig = null;
}
