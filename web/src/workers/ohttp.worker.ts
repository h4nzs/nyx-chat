// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Worker klien OHTTP.
 *
 * HPKE + Binary HTTP berjalan di sini, bukan di main thread, supaya enkripsi
 * request tidak memblokir UI dan supaya URL/metode/header target tidak pernah
 * melewati `fetch` main thread. Worker hanya berbicara dengan relay lewat satu
 * POST opaque (`message/ohttp-req` → `message/ohttp-res`).
 */

/// <reference lib="webworker" />

import { decodeOhttpKeyConfigCollection, encapsulateOhttpRequest } from '@nyx/shared';
import { clientVersionHeaders } from '../lib/clientVersion';

interface OhttpWorkerRequest {
  id: number;
  /** `application/ohttp-keys` (base64) dari `/api/ohttp/config`. */
  configB64: string;
  /** Key id yang sudah divalidasi pin klien — worker tidak memilih sendiri. */
  keyId: number;
  relayUrl: string;
  method: string;
  /** URL absolut target (origin + path + query). */
  url: string;
  headers: [string, string][];
  bodyB64?: string;
}

interface OhttpWorkerSuccess {
  id: number;
  ok: true;
  status: number;
  headers: [string, string][];
  bodyB64: string;
}

interface OhttpWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

ctx.onmessage = async (event: MessageEvent<OhttpWorkerRequest>) => {
  const message = event.data;
  try {
    const config = decodeOhttpKeyConfigCollection(base64ToBytes(message.configB64))
      .find((item) => item.keyId === message.keyId);
    if (!config) {
      throw new Error('OHTTP_CONFIG_KEY_MISSING');
    }
    const target = new URL(message.url);
    const sealed = await encapsulateOhttpRequest(config, {
      method: message.method,
      scheme: target.protocol.replace(':', ''),
      authority: target.host,
      path: `${target.pathname}${target.search}`,
      headers: message.headers,
      content: message.bodyB64 ? base64ToBytes(message.bodyB64) : new Uint8Array(),
    });

    const relayResponse = await fetch(message.relayUrl, {
      method: 'POST',
      // Relay adalah route `/api/*` — gerbang versi klien berlaku juga di sini.
      headers: { 'content-type': 'message/ohttp-req', ...clientVersionHeaders() },
      // Salinan ke ArrayBuffer baru: BodyInit menolak Uint8Array<ArrayBufferLike>.
      body: new Uint8Array(sealed.body).buffer,
    });
    if (!relayResponse.ok) {
      throw new Error(`OHTTP relay: HTTP ${relayResponse.status}`);
    }
    const opened = await sealed.openResponse(new Uint8Array(await relayResponse.arrayBuffer()));
    const success: OhttpWorkerSuccess = {
      id: message.id,
      ok: true,
      status: opened.status,
      headers: opened.headers.map(([name, value]) => [name, value] as [string, string]),
      bodyB64: bytesToBase64(opened.content),
    };
    ctx.postMessage(success);
  } catch (error) {
    const failure: OhttpWorkerFailure = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : 'OHTTP_FAILED',
    };
    ctx.postMessage(failure);
  }
};
