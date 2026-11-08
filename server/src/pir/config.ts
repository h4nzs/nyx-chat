// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP5] Konfigurasi proxy PIR dua server.
 *
 * Default MATI: tanpa `PIR_ENABLED=1`, router `/api/pir` tidak dipasang sama
 * sekali. Saat hidup, konfigurasi **wajib** menyebut ≥ 2 server: satu server
 * bukan mode degradasi, itu kebocoran privasi (server tunggal tahu indeks yang
 * ditanya), jadi lebih baik gagal boot.
 */

import { ML_DSA_65_PUBLIC_KEY_BYTES, PIR_SUITE } from '@nyx/shared';
import { parsePirRecordBytes } from './snapshot.js';

export interface PirServer {
  /** Id pendek (`a`, `b`, …) yang juga dipakai kunci manifest. */
  id: string;
  /** Origin sidecar, tanpa path/query/credentials. */
  url: string;
}

export interface PirConfig {
  servers: PirServer[];
  /** id server → kunci publik ML-DSA-65 untuk memverifikasi manifest. */
  manifestKeys: Map<string, Uint8Array>;
  /** Token internal `/admin/rebuild`; hanya dipakai job refresh. */
  adminToken: string | null;
  recordBytes: number;
  /** Direktori artefak shard; per server memakai subdirektori `id`. */
  shardDir: string | null;
  /** id server → berkas kunci ML-DSA-65 (0600) yang menandatangani manifest-nya. */
  signingKeys: Map<string, string>;
}

export const PIR_MIN_SERVERS = 2;
const ID_PATTERN = /^[a-z0-9_-]{1,16}$/;

/** Fitur hidup? Dipakai agar mati = 404, bukan 403. */
export function isPirEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIR_ENABLED === '1';
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function parseServerUrl(raw: unknown, id: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`PIR: URL server ${id} kosong`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PIR: URL server ${id} tidak valid`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`PIR: URL server ${id} harus http(s)`);
  }
  if (isLoopbackHostname(url.hostname) && url.protocol !== 'http:') {
    // Sidecar lokal tidak pernah ber-TLS; https ke loopback hanya menambah
    // error sertifikat tanpa menambah jaminan.
    throw new Error(`PIR: server ${id} loopback harus http:// tanpa TLS`);
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new Error(`PIR: server ${id} non-loopback harus https://`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`PIR: URL server ${id} tidak boleh memuat credentials/path/query/hash`);
  }
  return url.origin;
}

function parseServers(raw: string | undefined): PirServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new Error('PIR: PIR_SERVERS harus JSON array [{ "id": "a", "url": "http://…" }]');
  }
  if (!Array.isArray(parsed) || parsed.length < PIR_MIN_SERVERS) {
    throw new Error(`PIR: PIR_SERVERS minimal ${PIR_MIN_SERVERS} server`);
  }
  const seen = new Set<string>();
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    const id = String(record?.id ?? '');
    if (!ID_PATTERN.test(id)) {
      throw new Error('PIR: id server harus 1..16 karakter [a-z0-9_-]');
    }
    if (seen.has(id)) throw new Error(`PIR: id server ${id} duplikat`);
    seen.add(id);
    return { id, url: parseServerUrl(record?.url, id) };
  });
}

function parseManifestKeys(
  raw: string | undefined,
  servers: PirServer[],
): Map<string, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new Error('PIR: PIR_MANIFEST_KEYS harus JSON object { "a": "<base64url pubkey>" }');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PIR: PIR_MANIFEST_KEYS harus object');
  }
  const keys = new Map<string, Uint8Array>();
  for (const server of servers) {
    const value = (parsed as Record<string, unknown>)[server.id];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`PIR: kunci manifest untuk server ${server.id} tidak ada`);
    }
    const bytes = new Uint8Array(Buffer.from(value.trim(), 'base64url'));
    if (bytes.length !== ML_DSA_65_PUBLIC_KEY_BYTES) {
      throw new Error(
        `PIR: kunci manifest ${server.id} harus ${ML_DSA_65_PUBLIC_KEY_BYTES} byte ML-DSA-65`,
      );
    }
    keys.set(server.id, bytes);
  }
  return keys;
}

function parseSigningKeys(
  raw: string | undefined,
  servers: PirServer[],
): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new Error('PIR: PIR_SIGNING_KEYS harus JSON object { "a": "/path/a.key" }');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PIR: PIR_SIGNING_KEYS harus object');
  }
  const keys = new Map<string, string>();
  for (const server of servers) {
    const value = (parsed as Record<string, unknown>)[server.id];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`PIR: berkas kunci manifest server ${server.id} tidak ada di PIR_SIGNING_KEYS`);
    }
    keys.set(server.id, value.trim());
  }
  return keys;
}

/**
 * Muat konfigurasi dari env. `null` = fitur mati (perilaku default).
 * Melempar bila diaktifkan tetapi tidak memenuhi syarat dua-server.
 */
export function loadPirConfig(env: NodeJS.ProcessEnv = process.env): PirConfig | null {
  if (!isPirEnabled(env)) return null;

  const servers = parseServers(env.PIR_SERVERS);
  const manifestKeys = parseManifestKeys(env.PIR_MANIFEST_KEYS, servers);

  const suite = env.PIR_SUITE?.trim();
  if (suite && suite !== PIR_SUITE) {
    throw new Error(`PIR: PIR_SUITE ${suite} tidak didukung (harus ${PIR_SUITE})`);
  }

  return {
    servers,
    manifestKeys,
    adminToken: env.PIR_ADMIN_TOKEN?.trim() || null,
    recordBytes: parsePirRecordBytes(env.PIR_RECORD_BYTES),
    shardDir: env.PIR_SHARD_DIR?.trim() || null,
    signingKeys: parseSigningKeys(env.PIR_SIGNING_KEYS, servers),
  };
}

/** Server menurut id, atau `null` bila tidak dikonfigurasi. */
export function findPirServer(config: PirConfig, id: string): PirServer | null {
  return config.servers.find((server) => server.id === id) ?? null;
}
