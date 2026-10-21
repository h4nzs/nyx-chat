// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Klien OHTTP.
 *
 * Default MATI (`VITE_OHTTP_ENABLED=1` untuk menyalakan). Saat hidup:
 *   1. ambil `application/ohttp-keys` dari `/api/ohttp/config`,
 *   2. pin digest per key id (lihat `ohttpPin.ts`) — berubah tanpa rotasi
 *      eksplisit = fail-closed,
 *   3. minta token OHTTP berumur pendek (`POST /api/auth/ohttp-token`) dan
 *      letakkan di DALAM amplop sebagai `authorization: Bearer …`,
 *   4. kirim request lewat worker → relay → gateway.
 *
 * Kenapa token, bukan cookie: cookie sesi `HttpOnly` tidak bisa dibaca JS
 * sehingga tidak mungkin masuk amplop. Token hanya berlaku untuk allowlist
 * OHTTP (GET search/prekey), umur 120 detik, dan tidak bisa dipakai untuk
 * mutasi — batas itu ditegakkan `requireAuth` di server, bukan di klien.
 */

import { decodeOhttpKeyConfigCollection, isOhttpTargetAllowed } from '@nyx/shared';
import { authFetch } from '@lib/api';
import { clientVersionHeaders } from './clientVersion';
import { evaluateOhttpConfigPin, OHTTP_CONFIG_PIN_KEY } from './ohttpPin';

export interface OhttpHttpResult {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export interface OhttpKeyMaterial {
  configB64: string;
  keyId: number;
}

interface WorkerSuccess {
  id: number;
  ok: true;
  status: number;
  headers: [string, string][];
  bodyB64: string;
}

interface WorkerFailure {
  id: number;
  ok: false;
  error: string;
}

interface OhttpTokenResponse {
  token: string;
  expiresInSeconds: number;
}

/** Token disegarkan lebih awal agar request tidak pernah memakai token kedaluwarsa. */
const TOKEN_REFRESH_SKEW_MS = 20_000;

export function ohttpEnabled(): boolean {
  return import.meta.env.VITE_OHTTP_ENABLED === '1';
}

function relayUrl(): string {
  const configured = import.meta.env.VITE_OHTTP_RELAY_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return `${window.location.origin}/api/ohttp/relay`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

let cachedConfig: OhttpKeyMaterial | null = null;

/**
 * Ambil collection key config, evaluasi pin rotasi, lalu simpan pin baru bila
 * memang berubah. Config dipakai sampai halaman di-reload (key id yang dipin
 * tidak berubah dalam satu sesi).
 */
export async function loadOhttpConfig(): Promise<OhttpKeyMaterial> {
  if (cachedConfig) return cachedConfig;
  // Jalur REST langsung (bukan `api()`): header versi wajib ikut, kalau tidak
  // gerbang `MIN_CLIENT_VERSION` di server menolak key config.
  const response = await fetch('/api/ohttp/config', {
    credentials: 'include',
    headers: clientVersionHeaders(),
  });
  if (!response.ok) throw new Error(`OHTTP config: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const configs = decodeOhttpKeyConfigCollection(bytes);
  const decision = await evaluateOhttpConfigPin(configs, localStorage.getItem(OHTTP_CONFIG_PIN_KEY));
  if (decision.changed) localStorage.setItem(OHTTP_CONFIG_PIN_KEY, decision.pinJson);
  cachedConfig = { configB64: bytesToBase64(bytes), keyId: decision.keyId };
  return cachedConfig;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Token bearer berumur pendek untuk carriage di dalam amplop OHTTP. Diambil
 * lewat `authFetch` (cookie + CSRF otomatis); tidak pernah disimpan di
 * `localStorage` dan tidak pernah dikirim di luar amplop.
 */
export async function getOhttpToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return cachedToken.token;
  }
  const issued = await authFetch<OhttpTokenResponse>('/api/auth/ohttp-token', { method: 'POST' });
  if (!issued?.token || typeof issued.expiresInSeconds !== 'number') {
    throw new Error('OHTTP_TOKEN_INVALID');
  }
  cachedToken = {
    token: issued.token,
    expiresAt: Date.now() + issued.expiresInSeconds * 1000,
  };
  return cachedToken.token;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: OhttpHttpResult) => void; reject: (error: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/ohttp.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerSuccess | WorkerFailure>) => {
    const message = event.data;
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.ok) {
      slot.resolve({
        status: message.status,
        headers: message.headers,
        body: base64ToBytes(message.bodyB64),
      });
    } else {
      slot.reject(new Error(message.error));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'OHTTP worker error');
    for (const slot of pending.values()) slot.reject(error);
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * Kirim satu request melalui OHTTP. URL boleh relatif (di-resolve terhadap
 * origin saat ini). Target di luar allowlist ditolak di klien sebelum enkripsi —
 * gateway juga menolaknya, jadi ini hanya gagal-cepat, bukan kontrol keamanan.
 */
export async function ohttpFetch(
  input: string,
  init: { method?: string; headers?: [string, string][]; body?: Uint8Array; withToken?: boolean } = {},
): Promise<OhttpHttpResult> {
  if (!ohttpEnabled()) throw new Error('OHTTP_DISABLED');
  const url = new URL(input, window.location.origin);
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.origin !== window.location.origin) throw new Error('OHTTP_CROSS_ORIGIN');
  if (!isOhttpTargetAllowed(method, url.pathname)) throw new Error('OHTTP_TARGET_NOT_ALLOWED');

  const headers: [string, string][] = [...(init.headers ?? [])];
  if (init.withToken !== false && !headers.some(([name]) => name.toLowerCase() === 'authorization')) {
    headers.push(['authorization', `Bearer ${await getOhttpToken()}`]);
  }

  const config = await loadOhttpConfig();
  const id = nextId++;
  const request = {
    id,
    configB64: config.configB64,
    keyId: config.keyId,
    relayUrl: relayUrl(),
    method,
    url: url.toString(),
    headers,
    bodyB64: init.body ? bytesToBase64(init.body) : undefined,
  };

  return new Promise<OhttpHttpResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(request);
  });
}

/** Decode JSON dari body hasil OHTTP (dipakai hook pencarian). */
export async function ohttpJson<T>(input: string): Promise<T> {
  const result = await ohttpFetch(input);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`OHTTP_HTTP_${result.status}`);
  }
  return JSON.parse(new TextDecoder().decode(result.body)) as T;
}

/** Test-only: buang cache config/worker/pin. */
export function _resetOhttpClientForTests(): void {
  cachedConfig = null;
  cachedToken = null;
  worker?.terminate();
  worker = null;
  pending.clear();
  nextId = 1;
}
