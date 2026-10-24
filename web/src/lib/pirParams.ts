import { getApiBaseUrl, getClientInstallationId } from './api';
import { clientVersionHeaders } from './clientVersion';

export const PIR_SUITE = 'chalametpir-v1';
export const PIR_PARAMS_CACHE = 'nyx-pir-v1';
export const PIR_PARAMS_MAX_AGE_MS = 60_000;
export const PIR_MIN_RECORD_BYTES = 256;
export const PIR_MAX_RECORD_BYTES = 16 * 1024;

const CACHE_KEY = 'https://nyx.invalid/__nyx_pir_params__';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class PirError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'PirError';
  }
}

export interface PirParams {
  epoch: number;
  recordBytes: number;
  entryCount: number;
  suite: typeof PIR_SUITE;
  seed: Uint8Array;
  hint: Uint8Array;
  filter: Uint8Array;
  etag: string;
}

interface CachedParams {
  params: PirParams;
  storedAt: number;
}

let memory: CachedParams | null = null;

function decodeBase64Url(value: string, label: string): Uint8Array {
  if (!BASE64URL_RE.test(value)) throw new PirError('PIR_PARAMS_INVALID', `${label} bukan base64url`);
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new PirError('PIR_PARAMS_INVALID', `${label} bukan base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCanonical(value: unknown, label: string, expectedLength?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PirError('PIR_PARAMS_INVALID', `${label} hilang`);
  }
  const bytes = decodeBase64Url(value, label);
  if (encodeBase64Url(bytes) !== value) {
    throw new PirError('PIR_PARAMS_INVALID', `${label} tidak kanonik`);
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new PirError('PIR_PARAMS_INVALID', `${label} panjang salah`);
  }
  return bytes;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PirError('PIR_PARAMS_INVALID', `${label} tidak valid`);
  }
  return value;
}

export function parsePirParams(body: string, etag: string): PirParams {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new PirError('PIR_PARAMS_INVALID', 'params bukan JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PirError('PIR_PARAMS_INVALID', 'params bukan objek');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.suite !== PIR_SUITE) throw new PirError('PIR_PARAMS_INVALID', 'suite tidak didukung');
  const epoch = positiveInteger(obj.epoch, 'epoch');
  const entryCount = positiveInteger(obj.entryCount, 'entryCount');
  const recordBytes = positiveInteger(obj.recordBytes, 'recordBytes');
  if (recordBytes < PIR_MIN_RECORD_BYTES || recordBytes > PIR_MAX_RECORD_BYTES) {
    throw new PirError('PIR_PARAMS_INVALID', 'recordBytes di luar batas');
  }
  return {
    epoch,
    recordBytes,
    entryCount,
    suite: PIR_SUITE,
    seed: decodeCanonical(obj.seed, 'seed', 32),
    hint: decodeCanonical(obj.hint, 'hint'),
    filter: decodeCanonical(obj.filter, 'filter'),
    etag,
  };
}

async function paramsCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(PIR_PARAMS_CACHE);
  } catch {
    return null;
  }
}

async function readCache(): Promise<CachedParams | null> {
  const cache = await paramsCache();
  if (!cache) return null;
  try {
    const response = await cache.match(CACHE_KEY);
    if (!response) return null;
    const params = parsePirParams(await response.text(), response.headers.get('etag') ?? '');
    return { params, storedAt: 0 };
  } catch {
    await cache.delete(CACHE_KEY);
    return null;
  }
}

async function writeCache(body: string, etag: string): Promise<void> {
  const cache = await paramsCache();
  if (!cache) return;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (etag) headers.etag = etag;
  await cache.put(CACHE_KEY, new Response(body, { headers }));
}

export async function getPirParams(options: { force?: boolean } = {}): Promise<PirParams> {
  const force = options.force === true;
  if (!force && memory && Date.now() - memory.storedAt < PIR_PARAMS_MAX_AGE_MS) return memory.params;
  if (!memory) memory = await readCache();

  const cachedEtag = memory?.params.etag;

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/pir/params`, {
      method: 'GET',
      headers: {
        ...clientVersionHeaders(),
        'x-nyx-installation-id': await getClientInstallationId(),
        ...(cachedEtag ? { 'If-None-Match': cachedEtag } : {}),
      },
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new PirError('PIR_PARAMS_UNAVAILABLE', error instanceof Error ? error.message : 'params gagal');
  }

  if (response.status === 304) {
    if (!memory) throw new PirError('PIR_PARAMS_CACHE_MISS', '304 tanpa cache');
    memory.storedAt = Date.now();
    return memory.params;
  }
  if (!response.ok) {
    throw new PirError('PIR_PARAMS_HTTP', `params HTTP ${response.status}`);
  }

  const body = await response.text();
  const etag = response.headers.get('etag') ?? '';
  const params = parsePirParams(body, etag);
  memory = { params, storedAt: Date.now() };
  await writeCache(body, etag);
  return params;
}

export async function clearPirParams(): Promise<void> {
  memory = null;
  const cache = await paramsCache();
  if (cache) await cache.delete(CACHE_KEY);
}

export function _resetPirParamsForTests(): void {
  memory = null;
}
