// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Test klien OHTTP: pinning key config dan guard target
 * sebelum enkripsi. Worker tidak dijalankan di sini (butuh Worker + HPKE nyata);
 * yang dikunci adalah keputusan keamanan sisi klien:
 *   1. kunci yang sudah dipin tidak boleh berubah → `OHTTP_CONFIG_CHANGED`,
 *   2. request ke target di luar allowlist / cross-origin ditolak sebelum
 *      worker dibuat, jadi tidak ada byte yang sempat dikirim,
 *   3. fitur mati (default) menolak semua request tanpa menyentuh jaringan.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OHTTP_AEAD_AES256_GCM,
  OHTTP_KDF_SHA256,
  OHTTP_KEM_P256_SHA256,
  encodeOhttpKeyConfigCollection,
} from '@nyx/shared';
import { OHTTP_CONFIG_PIN_KEY, OhttpPinError } from '../ohttpPin';
import {
  _resetOhttpClientForTests,
  loadOhttpConfig,
  ohttpFetch,
} from '../ohttpClient';

function collectionBytes(keyId = 1, fill = 1): Uint8Array {
  return encodeOhttpKeyConfigCollection([
    {
      keyId,
      kemId: OHTTP_KEM_P256_SHA256,
      kdfId: OHTTP_KDF_SHA256,
      aeadId: OHTTP_AEAD_AES256_GCM,
      publicKey: new Uint8Array(65).fill(fill),
    },
  ]);
}

function mockConfigResponse(bytes: Uint8Array) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch;
}

describe('ohttpClient', () => {
  beforeEach(() => {
    _resetOhttpClientForTests();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetOhttpClientForTests();
  });

  it('memilih key id tertinggi dan mem-pin public key-nya', async () => {
    const bytes = collectionBytes(1, 3);
    const fetchMock = mockConfigResponse(bytes);
    vi.stubGlobal('fetch', fetchMock);

    const config = await loadOhttpConfig();

    expect(config.keyId).toBe(1);
    expect(config.configB64).toBeTruthy();
    const pin = JSON.parse(localStorage.getItem(OHTTP_CONFIG_PIN_KEY) ?? '{}');
    expect(pin['1']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('menolak config yang kuncinya berubah dan tidak mengadopsinya (fail-closed)', async () => {
    const fetchMock = mockConfigResponse(collectionBytes(1, 9));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(OHTTP_CONFIG_PIN_KEY, JSON.stringify({ '1': 'pin-lama' }));

    await expect(loadOhttpConfig()).rejects.toThrow(OhttpPinError);
    await expect(loadOhttpConfig()).rejects.toThrow('OHTTP_CONFIG_CHANGED');
    // Pin lama TIDAK ditimpa, dan config baru tidak masuk cache.
    expect(JSON.parse(localStorage.getItem(OHTTP_CONFIG_PIN_KEY) ?? '{}')).toEqual({
      '1': 'pin-lama',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('menerima config yang sama dengan pin tersimpan', async () => {
    const bytes = collectionBytes(1, 7);
    vi.stubGlobal('fetch', mockConfigResponse(bytes));
    await loadOhttpConfig();
    const pinned = localStorage.getItem(OHTTP_CONFIG_PIN_KEY);

    _resetOhttpClientForTests();
    vi.stubGlobal('fetch', mockConfigResponse(bytes));

    const config = await loadOhttpConfig();
    expect(config.keyId).toBe(1);
    expect(localStorage.getItem(OHTTP_CONFIG_PIN_KEY)).toBe(pinned);
  });

  it('menolak target di luar allowlist sebelum worker/fetch dibuat', async () => {
    vi.stubEnv('VITE_OHTTP_ENABLED', '1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(ohttpFetch('/api/messages')).rejects.toThrow('OHTTP_TARGET_NOT_ALLOWED');
    await expect(ohttpFetch('https://evil.example/api/users/search')).rejects.toThrow(
      'OHTTP_CROSS_ORIGIN',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('menolak semua request saat fitur mati (default)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(ohttpFetch('/api/users/search?q=a')).rejects.toThrow('OHTTP_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
