// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Pin key config OHTTP harus TAHAN ROTASI tanpa kehilangan
 * sifat fail-closed: kunci yang sudah dipin tidak boleh berubah diam-diam,
 * tapi kunci baru boleh masuk setelah kunci lama pensiun.
 */

import { describe, expect, it } from 'vitest';
import {
  OHTTP_AEAD_AES256_GCM,
  OHTTP_KDF_SHA256,
  OHTTP_KEM_P256_SHA256,
  type OhttpKeyConfig,
} from '@nyx/shared';
import { OhttpPinError, evaluateOhttpConfigPin } from '../ohttpPin';

function keyConfig(keyId: number, fill: number): OhttpKeyConfig {
  return {
    keyId,
    kemId: OHTTP_KEM_P256_SHA256,
    kdfId: OHTTP_KDF_SHA256,
    aeadId: OHTTP_AEAD_AES256_GCM,
    publicKey: new Uint8Array(65).fill(fill),
  };
}

describe('evaluateOhttpConfigPin', () => {
  it('tanpa pin: memilih key id tertinggi dan menulis pin', async () => {
    const decision = await evaluateOhttpConfigPin(
      [keyConfig(1, 1), keyConfig(2, 2)],
      null,
    );
    expect(decision.keyId).toBe(2);
    expect(decision.changed).toBe(true);
    expect(JSON.parse(decision.pinJson)).toEqual({ '2': expect.any(String) });
  });

  it('config identik: pin tidak berubah', async () => {
    const configs = [keyConfig(1, 1), keyConfig(2, 2)];
    const first = await evaluateOhttpConfigPin(configs, null);
    const second = await evaluateOhttpConfigPin(configs, first.pinJson);
    expect(second.keyId).toBe(2);
    expect(second.changed).toBe(false);
    expect(second.pinJson).toBe(first.pinJson);
  });

  it('server menambah kunci baru sementara kunci lama ada: klien TETAP memakai kunci yang dipin', async () => {
    const pinned = await evaluateOhttpConfigPin([keyConfig(1, 1)], null);
    const decision = await evaluateOhttpConfigPin(
      [keyConfig(1, 1), keyConfig(2, 2)],
      pinned.pinJson,
    );
    expect(decision.keyId).toBe(1);
    expect(decision.changed).toBe(false);
  });

  it('public key untuk key id yang dipin berubah: fail-closed', async () => {
    const pinned = await evaluateOhttpConfigPin([keyConfig(1, 1)], null);
    await expect(
      evaluateOhttpConfigPin([keyConfig(1, 9)], pinned.pinJson),
    ).rejects.toThrow(OhttpPinError);
    await expect(
      evaluateOhttpConfigPin([keyConfig(1, 9)], pinned.pinJson),
    ).rejects.toThrow('OHTTP_CONFIG_CHANGED');
  });

  it('rotasi selesai (kunci lama pensiun): kunci baru diadopsi dan pin diganti', async () => {
    const pinned = await evaluateOhttpConfigPin([keyConfig(1, 1)], null);
    const decision = await evaluateOhttpConfigPin([keyConfig(2, 2)], pinned.pinJson);
    expect(decision.keyId).toBe(2);
    expect(decision.changed).toBe(true);
    expect(JSON.parse(decision.pinJson)).toEqual({ '2': expect.any(String) });
  });

  it('collection kosong ditolak', async () => {
    await expect(evaluateOhttpConfigPin([], null)).rejects.toThrow('OHTTP_CONFIG_EMPTY');
  });
});
