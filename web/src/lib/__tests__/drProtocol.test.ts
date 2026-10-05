// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// web/src/lib/__tests__/drProtocol.test.ts
//
// Unit test helper pure protokol DR 1:1 (lihat ../drProtocol.ts).

import { describe, expect, it } from 'vitest';
import {
  shouldIncludeHandshake,
  getHandshakePayload,
  shouldOmitRatchetCt,
  extractPeerAck,
  attachClientProtocolFields,
} from '../drProtocol';

const HS = {
  initiatorSigningKey: 'sig-key-b64',
  initiatorCiphertexts: 'cts-b64',
  otpkId: 7,
};

describe('drProtocol — x3dh-until-confirmed', () => {
  it('baru establish → wajib bawa handshake', () => {
    expect(shouldIncludeHandshake({}, true)).toBe(true);
  });

  it('state awal dengan salinan handshake → bawa', () => {
    expect(shouldIncludeHandshake({ pendingHandshake: HS }, false)).toBe(true);
    expect(getHandshakePayload({ pendingHandshake: HS })).toEqual(HS);
  });

  it('peer terkonfirmasi → berhenti membawa handshake', () => {
    const state = { pendingHandshake: HS, peerSessionConfirmed: true };
    expect(shouldIncludeHandshake(state, false)).toBe(false);
    expect(getHandshakePayload(state)).toBeNull();
  });

  it('tanpa salinan handshake (sisi penerima/bob) → tidak membawa x3dh', () => {
    expect(shouldIncludeHandshake({}, false)).toBe(false);
    expect(getHandshakePayload({})).toBeNull();
  });

  it('flag confirmed hilang tapi salinan ada → tetap bawa (aman, self-terminating)', () => {
    expect(getHandshakePayload({ pendingHandshake: HS })).toEqual(HS);
  });
});

describe('drProtocol — omit-ct dengan ack', () => {
  const CURRENT = 'kem-pk-current-b64';

  it('tanpa ack → ct tetap dikirim', () => {
    expect(shouldOmitRatchetCt(undefined, CURRENT)).toBe(false);
    expect(shouldOmitRatchetCt(null, CURRENT)).toBe(false);
    expect(shouldOmitRatchetCt('', CURRENT)).toBe(false);
  });

  it('ack ≠ chain saat ini → ct tetap dikirim', () => {
    expect(shouldOmitRatchetCt('kem-pk-lama', CURRENT)).toBe(false);
  });

  it('ack = chain saat ini → ct dihilangkan', () => {
    expect(shouldOmitRatchetCt(CURRENT, CURRENT)).toBe(true);
  });

  it('currentKemPk tidak tersedia → tidak pernah omit', () => {
    expect(shouldOmitRatchetCt(CURRENT, undefined)).toBe(false);
    expect(shouldOmitRatchetCt(CURRENT, null)).toBe(false);
  });

  it('extractPeerAck membaca ack dari payload terenkripsi', () => {
    const payload = JSON.stringify({
      content: 'halo',
      senderId: 'u1',
      ackKem: CURRENT,
    });
    expect(extractPeerAck(payload)).toBe(CURRENT);
  });

  it('extractPeerAck toleran pada payload tanpa ack / bukan JSON', () => {
    expect(extractPeerAck(JSON.stringify({ content: 'x' }))).toBeNull();
    expect(extractPeerAck('bukan json')).toBeNull();
    expect(extractPeerAck(JSON.stringify({ ackKem: 42 }))).toBeNull();
    expect(extractPeerAck(JSON.stringify({ ackKem: '' }))).toBeNull();
  });
});

describe('drProtocol — attachClientProtocolFields', () => {
  it('bidang klien tidak ter-strip saat state worker di-persist ulang', () => {
    const workerState = {
      KEMs: { publicKey: 'pk', privateKey: 'sk' },
      RK: 'rk',
      Ns: 3,
    };
    const previous = {
      pendingHandshake: HS,
      peerAckedKem: 'acked-b64',
      peerSessionConfirmed: false,
    };
    const merged = attachClientProtocolFields(workerState, previous, {});
    expect(merged.pendingHandshake).toEqual(HS);
    expect(merged.peerAckedKem).toBe('acked-b64');
    expect(merged.peerSessionConfirmed).toBe(false);
    // field worker tetap utuh
    expect((merged as unknown as Record<string, unknown>).Ns).toBe(3);
  });

  it('patch menang atas nilai previous (mis. confirm saat decrypt sukses)', () => {
    const merged = attachClientProtocolFields(
      { Ns: 4 },
      { pendingHandshake: HS, peerSessionConfirmed: false },
      { peerSessionConfirmed: true }
    );
    expect(merged.peerSessionConfirmed).toBe(true);
    expect(merged.pendingHandshake).toEqual(HS);
  });

  it('clear ack (patch undefined vs null) — patch null menghapus ack', () => {
    const merged = attachClientProtocolFields(
      { Ns: 1 },
      { peerAckedKem: 'old' },
      { peerAckedKem: null }
    );
    expect(merged.peerAckedKem).toBeNull();
  });
});
