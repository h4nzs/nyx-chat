// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.8 / docs/34] Penerus query Key Transparency.
 *
 * Klien NYX **tidak pernah** bicara langsung ke layanan KT: server NYX yang
 * meneruskan, sehingga (a) port KT tetap loopback, (b) permintaan bisa dibatasi
 * lajunya dan diaudit di satu tempat, dan (c) klien tidak perlu tahu alamat
 * internal.
 *
 * Yang diteruskan adalah **byte protobuf apa adanya** dari `nyx-kt-query`
 * (`server/kt-query`, layanan baca NYX). Tidak ada parsing protobuf di sini:
 * framing `u32 BE || payload` dibuka, dua blob dikirim sebagai base64url, dan
 * verifikasi kriptografinya terjadi di klien (WASM `libsignal-keytrans`) —
 * server NYX tidak boleh, dan tidak bisa, "memverifikasi" bukti untuk klien.
 *
 * Kenapa bukan query service upstream (`kt_query.KeyTransparencyQueryService`):
 * layanan itu menuntut entri ACI dan hanya menerima nilai `0x00||aci16`,
 * sedangkan nilai log NYX adalah 1286 byte format NYX v1 — permintaannya dijawab
 * `permission denied`, atau error internal yang menggagalkan seluruh SearchV2
 * (bukti empiris: docs/32 §32.8).
 *
 * Sifat yang dijaga: **fail-visible**. Tanpa `KT_QUERY_URL`, endpoint menjawab
 * 503 `KT_QUERY_DISABLED` (bukan diam-diam TOFU), dan setiap hasil dihitung di
 * `nyx_kt_queries_total{result}`.
 */

import { incCounter, KT_QUERIES } from './metrics.js';

export type KtQueryErrorCode =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'MALFORMED_RESPONSE';

export class KtQueryError extends Error {
  constructor(public readonly code: KtQueryErrorCode, message: string) {
    super(message);
    this.name = 'KtQueryError';
  }
}

/** Endpoint layanan baca NYX; tanpa nilai berarti fitur nonaktif (fail-visible). */
export function ktQueryBaseUrl(): string | null {
  const value = process.env.KT_QUERY_URL?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

export function ktQueryConfigured(): boolean {
  return ktQueryBaseUrl() !== null;
}

export interface KtProof {
  /** `transparency.FullTreeHead` — byte mentah. */
  fullTreeHead: Uint8Array;
  /** `kt_query.CondensedTreeSearchResponse` — byte mentah. */
  condensed: Uint8Array;
}

export interface KtSearchInput {
  /** usernameHash 32 byte, base64url (bentuk yang dikirim klien NYX). */
  hash?: string;
  /** Search key mentah base64url (mis. `distinguished`); dipakai untuk pengujian. */
  key?: string;
  /** Ukuran pohon terakhir yang sudah dipercaya klien (bukti konsistensi). */
  last?: number;
  distinguished?: number;
}

const timeoutMs = () => {
  const parsed = Number(process.env.KT_QUERY_TIMEOUT_MS ?? '5000');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
};

function record(result: 'ok' | 'not_found' | 'error' | 'disabled'): void {
  incCounter(KT_QUERIES, { result });
}

async function request(path: string, init?: RequestInit): Promise<Uint8Array> {
  const base = ktQueryBaseUrl();
  if (base === null) {
    record('disabled');
    throw new KtQueryError(
      'DISABLED',
      'KT_QUERY_URL tidak diatur — verifikasi kunci tidak tersedia'
    );
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error) {
    record('error');
    throw new KtQueryError('UNAVAILABLE', `layanan baca KT tidak terjangkau: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      record('not_found');
      throw new KtQueryError('NOT_FOUND', body || 'search key tidak ada di log KT');
    }
    if (response.status === 400) {
      record('error');
      throw new KtQueryError('INVALID_ARGUMENT', body || 'permintaan KT tidak sah');
    }
    record('error');
    throw new KtQueryError('UNAVAILABLE', `layanan baca KT menjawab HTTP ${response.status}: ${body}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** Buka framing `u32 BE || payload` berurutan. */
export function parseFramedBytes(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      throw new KtQueryError('MALFORMED_RESPONSE', 'frame KT terpotong (panjang)');
    }
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > bytes.byteLength) {
      throw new KtQueryError('MALFORMED_RESPONSE', 'frame KT terpotong (payload)');
    }
    out.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}

function proofFromFrames(bytes: Uint8Array): KtProof {
  const frames = parseFramedBytes(bytes);
  if (frames.length !== 2) {
    throw new KtQueryError('MALFORMED_RESPONSE', `frame KT berjumlah ${frames.length}, diharapkan 2`);
  }
  record('ok');
  return { fullTreeHead: frames[0]!, condensed: frames[1]! };
}

function searchQuery(input: KtSearchInput): string {
  const params = new URLSearchParams();
  if (input.hash !== undefined && input.key !== undefined) {
    throw new KtQueryError('INVALID_ARGUMENT', 'hash dan key tidak boleh bersamaan');
  }
  if (input.hash !== undefined) params.set('hash', input.hash);
  if (input.key !== undefined) params.set('key', input.key);
  if (input.last !== undefined) params.set('last', String(input.last));
  if (input.distinguished !== undefined) params.set('distinguished', String(input.distinguished));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Bukti untuk satu usernameHash (atau search key mentah). */
export async function fetchKtProof(input: KtSearchInput): Promise<KtProof> {
  return proofFromFrames(await request(`/search${searchQuery(input)}`));
}

/** Anchor: bukti kunci `distinguished` — dipakai sebelum klien mengenal kontak. */
export async function fetchKtDistinguished(input: { last?: number; distinguished?: number } = {}): Promise<KtProof> {
  return proofFromFrames(await request(`/distinguished${searchQuery(input)}`));
}

/**
 * Bukti monitor. Permintaan dibangun klien (dari monitoring data tersimpan);
 * yang dikembalikan hanya `transparency.MonitorResponse` — `verify_monitor`
 * membutuhkan permintaan dan jawaban, dan keduanya dimiliki klien.
 */
export async function fetchKtMonitor(monitorRequest: Uint8Array): Promise<Uint8Array> {
  const bytes = await request('/monitor', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(monitorRequest),
  });
  if (bytes.byteLength === 0) {
    throw new KtQueryError('MALFORMED_RESPONSE', 'monitor response kosong');
  }
  record('ok');
  return bytes;
}

export interface KtPublicConfig {
  mode: number;
  /** ML-DSA-65 (v2, 1952 byte → 3904 hex) atau Ed25519 (v1, 64 hex). */
  signatureKey: string;
  /** Hanya v1 (EC-VRF). Log v2 tidak memakai VRF. */
  vrfKey?: string;
  auditorKeys: string[];
  searchKeyPrefix: string;
  distinguishedKey: string;
  valueFormat: string;
  /** 2 = nilai `nyx-kt-value-v2` + tanda tangan ML-DSA; absen = v1. */
  abiVersion?: number;
}

/** Kunci publik log: klien membandingkan ini dengan yang diharapkan sebelum percaya. */
export async function fetchKtPublicConfig(): Promise<KtPublicConfig> {
  const bytes = await request('/config');
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as KtPublicConfig;
  } catch {
    throw new KtQueryError('MALFORMED_RESPONSE', 'config KT bukan JSON');
  }
}

/**
 * Tree head NYX sebagai JSON kecil — jangkar **gossip** antar-klien
 * (`web/src/lib/ktGossip.ts`).
 *
 * Kenapa tidak diambil dari bukti protobuf: root di dalam `FullTreeHead` harus
 * dihitung klien dari proof (itulah inti KT), dan mem-parsing protobuf di JS
 * dilarang (`docs/34` §34.2). Untuk gossip, yang dibutuhkan hanya angka yang
 * bisa dibandingkan; kalau angka itu tidak cocok dengan bukti yang diverifikasi,
 * verifikasi bukti itu sendiri yang gagal — jadi tidak ada jalur kepercayaan baru.
 */
export interface KtHead {
  treeSize: number;
  timestamp: number;
  /** Root 32 byte sebagai hex (64 karakter). */
  root: string;
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

export async function fetchKtHead(): Promise<KtHead> {
  const bytes = await request('/head');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new KtQueryError('MALFORMED_RESPONSE', 'head KT bukan JSON');
  }
  const head = parsed as Partial<KtHead> | null;
  if (
    !head ||
    typeof head.treeSize !== 'number' ||
    !Number.isInteger(head.treeSize) ||
    head.treeSize <= 0 ||
    typeof head.timestamp !== 'number' ||
    typeof head.root !== 'string' ||
    !HEX_32_BYTES.test(head.root)
  ) {
    throw new KtQueryError('MALFORMED_RESPONSE', 'head KT tidak lengkap/tidak sah');
  }
  return { treeSize: head.treeSize, timestamp: head.timestamp, root: head.root };
}
