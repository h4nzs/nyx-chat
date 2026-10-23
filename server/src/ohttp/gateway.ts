// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 3] Gateway OHTTP (RFC 9458 §4.3–4.4).
 *
 * Tanggung jawab gateway: membuka Encapsulated Request, menolak target di luar
 * allowlist, meneruskan request ke API lewat loopback (tanpa header identitas
 * jaringan), lalu membungkus response. Gateway TIDAK mencatat isi request dan
 * TIDAK meneruskan IP klien — relay yang melihat IP, gateway yang melihat isi.
 */

import {
  OhttpError,
  decapsulateOhttpRequest,
  isOhttpTargetAllowed,
  sanitizeOhttpForwardHeaders,
  type OhttpAllowRule,
  type OhttpHeader,
  type OhttpRequest,
  type OhttpResponse,
} from '@nyx/shared';
import type { OhttpConfig } from './config.js';

export type OhttpDispatcher = (request: OhttpRequest) => Promise<OhttpResponse>;

const encoder = new TextEncoder();

/** Header response yang tidak boleh diteruskan apa adanya. */
const DROP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function jsonResponse(status: number, payload: Record<string, unknown>): OhttpResponse {
  return {
    status,
    headers: [['content-type', 'application/json']],
    content: encoder.encode(JSON.stringify(payload)),
  };
}

/**
 * Dispatcher default: panggil API di loopback. Base URL tidak pernah berasal
 * dari input klien; path sudah dibatasi allowlist sebelum fungsi ini dipanggil.
 */
export function createLoopbackDispatcher(baseUrl: string): OhttpDispatcher {
  const base = baseUrl.replace(/\/$/, '');
  return async (request) => {
    const headers = new Headers();
    for (const [name, value] of sanitizeOhttpForwardHeaders(request.headers as OhttpHeader[])) {
      headers.set(name, value);
    }
    const response = await fetch(`${base}${request.path}`, {
      method: request.method,
      headers,
      // Salinan ke ArrayBuffer baru: `fetch` menolak Uint8Array<ArrayBufferLike>.
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : new Uint8Array(request.content).buffer,
    });
    const responseHeaders: OhttpHeader[] = [];
    response.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.push([name, value]);
    });
    return {
      status: response.status,
      headers: responseHeaders,
      content: new Uint8Array(await response.arrayBuffer()),
    };
  };
}

/**
 * Proses satu Encapsulated Request → Encapsulated Response.
 * Semua kegagalan SETELAH dekripsi dibalas sebagai Binary HTTP response
 * terenkripsi (klien bisa membacanya), bukan error HTTP polos di luar amplop.
 */
export async function handleOhttpGateway(
  config: OhttpConfig,
  encapsulatedRequest: Uint8Array,
  dispatch: OhttpDispatcher,
  allowlist?: readonly OhttpAllowRule[],
  options: { injectedAuthorization?: string } = {},
): Promise<Uint8Array> {
  // Rotasi: key id ada di byte pertama amplop, jadi gateway tidak menebak.
  // Kunci yang tidak dikenal = amplop dari klien yang salah konfigurasi /
  // sudah kedaluwarsa; tolak sebagai request tidak sah (bukan 500).
  const keyId = encapsulatedRequest[0];
  const slot = config.keys.find((key) => key.keyId === keyId);
  if (!slot) throw new OhttpError('ohttp: key id tidak dikenal');

  const sealed = await decapsulateOhttpRequest({
    keyId: slot.keyId,
    privateKey: slot.privateKey,
    encapsulatedRequest,
  });

  if (!isOhttpTargetAllowed(sealed.request.method, sealed.request.path, allowlist)) {
    return sealed.sealResponse(jsonResponse(403, { error: 'OHTTP_TARGET_NOT_ALLOWED' }));
  }

  // Sanitasi DI SINI, bukan hanya di dispatcher default: gateway adalah batas
  // kepercayaan, jadi dispatcher apa pun (termasuk test/driver lain) menerima
  // request yang sudah bebas header identitas jaringan.
  const sanitizedHeaders = sanitizeOhttpForwardHeaders(sealed.request.headers).filter(
    ([name]) => name.toLowerCase() !== 'x-nyx-ohttp-internal',
  );
  let forwardHeaders = sanitizedHeaders;
  if (options.injectedAuthorization) {
    // Token di-inject oleh relay tepercaya; header auth/cookie dari dalam amplop
    // tidak pernah boleh menang atas identitas yang sudah diverifikasi relay.
    forwardHeaders = sanitizedHeaders.filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'authorization' && lower !== 'cookie';
    });
    forwardHeaders.push(['authorization', options.injectedAuthorization]);
  }
  const request: OhttpRequest = {
    ...sealed.request,
    headers: forwardHeaders,
  };

  let response: OhttpResponse;
  try {
    response = await dispatch(request);
  } catch {
    response = jsonResponse(502, { error: 'OHTTP_UPSTREAM_FAILED' });
  }
  return sealed.sealResponse(response);
}
