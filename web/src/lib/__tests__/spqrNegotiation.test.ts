// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/33 §33.7 poin 2–3] Negosiasi versi ratchet SPQR.
 *
 * Yang dikunci: v2 tidak pernah dipakai tanpa kapabilitas kedua sisi, sesi yang
 * sudah berdiri **tidak** berubah versi karena kabar kapabilitas belakangan,
 * kill switch (build-time & runtime) hanya menghentikan pengiriman/iklan — bukan
 * membaca — dan rollback tidak pernah menghapus state versi lama.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '@nyx/shared';
import {
  SPQR_CAPABILITY,
  SPQR_INTEGRATION_ENABLED,
  SPQR_RUNTIME_KILL_SWITCH_KEY,
  advertisedCapabilities,
  planRatchetRollback,
  resolveOutboundRatchetVersion,
  resolveRatchetVersion,
  resolveSpqrCapabilityOverride,
  resolveSpqrIntegrationEnabled,
  resolveSpqrRuntimeKillSwitch,
  spqrSendingEnabled,
} from '../spqrNegotiation';

afterEach(() => {
  localStorage.removeItem(SPQR_RUNTIME_KILL_SWITCH_KEY);
});

describe('advertisedCapabilities', () => {
  it('default: menyala — jalur v2 sudah punya implementasinya', () => {
    expect(SPQR_INTEGRATION_ENABLED).toBe(true);
    expect(advertisedCapabilities()).toEqual([SPQR_CAPABILITY]);
  });

  it('kill switch VITE_SPQR_FORCE_V1 mematikan iklan', () => {
    expect(resolveSpqrIntegrationEnabled({ VITE_SPQR_FORCE_V1: '1' })).toBe(false);
    expect(resolveSpqrIntegrationEnabled({})).toBe(true);
    expect(advertisedCapabilities(false)).toEqual([]);
  });

  it('override kapabilitas uji/E2E hanya dihormati di build DEV', () => {
    expect(resolveSpqrCapabilityOverride({ DEV: true, VITE_SPQR_FORCE_V2: '1' })).toBe(true);
    expect(resolveSpqrCapabilityOverride({ DEV: false, VITE_SPQR_FORCE_V2: '1' })).toBe(false);
    expect(resolveSpqrCapabilityOverride({ DEV: true })).toBe(false);
  });

  it('menyala = kapabilitas dari @nyx/shared (bukan literal lokal)', () => {
    expect(advertisedCapabilities(true)).toEqual([CLIENT_CAPABILITIES.SPQR_RATCHET]);
    expect(SPQR_CAPABILITY).toBe(CLIENT_CAPABILITIES.SPQR_RATCHET);
  });
});

describe('resolveRatchetVersion', () => {
  it('saklar lokal mati → v1 walau peer mampu', () => {
    expect(
      resolveRatchetVersion({
        negotiatedCapabilities: [SPQR_CAPABILITY],
        integrationEnabled: false,
      })
    ).toEqual({ version: 'v1', reason: 'local-disabled' });
  });

  it('peer legacy (tanpa kapabilitas) → v1, bukan paksa v2', () => {
    expect(
      resolveRatchetVersion({ negotiatedCapabilities: ['hello-v1'], integrationEnabled: true })
    ).toEqual({ version: 'v1', reason: 'peer-legacy' });
    expect(resolveRatchetVersion({ integrationEnabled: true })).toEqual({
      version: 'v1',
      reason: 'peer-legacy',
    });
  });

  it('kedua sisi mampu → v2', () => {
    expect(
      resolveRatchetVersion({
        negotiatedCapabilities: [CLIENT_CAPABILITIES.HELLO_V1, SPQR_CAPABILITY],
        integrationEnabled: true,
      })
    ).toEqual({ version: 'v2', reason: 'both-capable' });
  });

  it('sesi yang sudah berdiri mempertahankan versinya (anti-downgrade)', () => {
    // Kapabilitas hilang dari kabar terakhir (mis. hello ulang dari sidecar lama)
    // tetap TIDAK menurunkan sesi v2 yang sedang berjalan.
    expect(
      resolveRatchetVersion({
        currentVersion: 'v2',
        negotiatedCapabilities: [],
        integrationEnabled: true,
      })
    ).toEqual({ version: 'v2', reason: 'established' });

    // Dan sebaliknya: sesi v1 tidak dinaikkan hanya karena peer kini mengiklankan.
    expect(
      resolveRatchetVersion({
        currentVersion: 'v1',
        negotiatedCapabilities: [SPQR_CAPABILITY],
        integrationEnabled: true,
      })
    ).toEqual({ version: 'v1', reason: 'established' });
  });

  it('idempoten: masukan sama → keputusan sama', () => {
    const input = { negotiatedCapabilities: [SPQR_CAPABILITY], integrationEnabled: true };
    expect(resolveRatchetVersion(input)).toEqual(resolveRatchetVersion(input));
  });
});

describe('planRatchetRollback', () => {
  it('v2 → v1 mempertahankan state v2 (pesan lama tetap terbaca)', () => {
    expect(planRatchetRollback('v2')).toEqual({ version: 'v1', preservedVersion: 'v2' });
  });

  it('dari v1 tidak ada yang perlu dipertahankan', () => {
    expect(planRatchetRollback('v1')).toEqual({ version: 'v1', preservedVersion: null });
    expect(planRatchetRollback()).toEqual({ version: 'v1', preservedVersion: 'v2' });
  });
});

describe('resolveOutboundRatchetVersion', () => {
  const capable = { negotiatedCapabilities: [SPQR_CAPABILITY], integrationEnabled: true };

  it('peer belum menyatakan mampu → v1 (klien lama tidak pernah dikirimi v2)', () => {
    expect(resolveOutboundRatchetVersion({ ...capable, peerDeclaredVersion: null })).toEqual({
      version: 'v1',
      reason: 'peer-legacy',
    });
    expect(resolveOutboundRatchetVersion({ ...capable, peerDeclaredVersion: 'v1' })).toEqual({
      version: 'v1',
      reason: 'peer-legacy',
    });
  });

  it('peer menyatakan mampu + relay mengiklankan kapabilitas → v2', () => {
    expect(resolveOutboundRatchetVersion({ ...capable, peerDeclaredVersion: 'v2' })).toEqual({
      version: 'v2',
      reason: 'both-capable',
    });
  });

  it('relay tidak mengiklankan kapabilitas → tetap v1 walau peer mampu', () => {
    expect(
      resolveOutboundRatchetVersion({
        peerDeclaredVersion: 'v2',
        negotiatedCapabilities: ['hello-v1'],
        integrationEnabled: true,
      })
    ).toEqual({ version: 'v1', reason: 'peer-legacy' });
  });

  it('sesi yang sudah v2 tetap v2 walau kapabilitas relay hilang (sticky anti-downgrade)', () => {
    expect(
      resolveOutboundRatchetVersion({
        currentOutbound: 'v2',
        peerDeclaredVersion: 'v2',
        negotiatedCapabilities: [],
        integrationEnabled: true,
      })
    ).toEqual({ version: 'v2', reason: 'established' });
  });

  it('deklarasi peer hilang → rollback eksplisit dengan state braid dipertahankan', () => {
    expect(
      resolveOutboundRatchetVersion({
        currentOutbound: 'v2',
        peerDeclaredVersion: null,
        ...capable,
      })
    ).toEqual({ version: 'v1', reason: 'rollback', preservedVersion: 'v2' });
  });

  it('kill switch: v1 dan state braid dipertahankan', () => {
    expect(
      resolveOutboundRatchetVersion({
        currentOutbound: 'v2',
        peerDeclaredVersion: 'v2',
        integrationEnabled: false,
      })
    ).toEqual({ version: 'v1', reason: 'local-disabled', preservedVersion: 'v2' });
    expect(
      resolveOutboundRatchetVersion({ peerDeclaredVersion: 'v2', integrationEnabled: false })
    ).toEqual({ version: 'v1', reason: 'local-disabled' });
  });

  it('idempoten: masukan sama → keputusan sama', () => {
    const input = { ...capable, peerDeclaredVersion: 'v2' as const };
    expect(resolveOutboundRatchetVersion(input)).toEqual(resolveOutboundRatchetVersion(input));
  });
});

// [docs/33 §33.8 / §33.10] Rollback operator dengan dua klien nyata tidak bisa
// diuji lewat `VITE_SPQR_FORCE_V1` (env build-time = sama untuk semua klien),
// jadi ada kill switch runtime khusus DEV. Yang dikunci di sini: ia hanya hidup
// di DEV, dibaca **per keputusan** (rollback berlaku tanpa reload), dan
// konsekuensinya persis seperti rollback: kirim v1 + state braid dipertahankan.
describe('kill switch runtime (DEV-only)', () => {
  const storageWith = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });

  it('hanya dihormati di build DEV dan hanya untuk nilai "1"', () => {
    expect(resolveSpqrRuntimeKillSwitch({ DEV: true }, storageWith('1'))).toBe(true);
    expect(resolveSpqrRuntimeKillSwitch({ DEV: false }, storageWith('1'))).toBe(false);
    expect(resolveSpqrRuntimeKillSwitch({}, storageWith('1'))).toBe(false);
    expect(resolveSpqrRuntimeKillSwitch({ DEV: true }, null)).toBe(false);
    expect(resolveSpqrRuntimeKillSwitch({ DEV: true }, storageWith(null))).toBe(false);
    expect(resolveSpqrRuntimeKillSwitch({ DEV: true }, storageWith('0'))).toBe(false);
  });

  it('dibaca ulang tiap panggilan — rollback berlaku pada pengiriman berikutnya', () => {
    expect(spqrSendingEnabled()).toBe(true);
    localStorage.setItem(SPQR_RUNTIME_KILL_SWITCH_KEY, '1');
    expect(spqrSendingEnabled()).toBe(false);
    localStorage.removeItem(SPQR_RUNTIME_KILL_SWITCH_KEY);
    expect(spqrSendingEnabled()).toBe(true);
  });

  it('saklar menyala → iklan mati + pengiriman v1, state braid dipertahankan', () => {
    localStorage.setItem(SPQR_RUNTIME_KILL_SWITCH_KEY, '1');

    expect(advertisedCapabilities()).toEqual([]);
    expect(
      resolveOutboundRatchetVersion({ currentOutbound: 'v2', peerDeclaredVersion: 'v2' })
    ).toEqual({ version: 'v1', reason: 'local-disabled', preservedVersion: 'v2' });
    expect(resolveOutboundRatchetVersion({ peerDeclaredVersion: 'v2' })).toEqual({
      version: 'v1',
      reason: 'local-disabled',
    });
    expect(
      resolveRatchetVersion({ negotiatedCapabilities: [SPQR_CAPABILITY] })
    ).toEqual({ version: 'v1', reason: 'local-disabled' });
  });
});
