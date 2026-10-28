// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/34 §34.6 · docs/38] Panel Privacy Self-Check.
 *
 * Yang dikunci di sini bukan tampilan, melainkan **aturan bukti**: panel tidak
 * boleh menyebut sesuatu "active" hanya karena flag-nya disetel. `configured`
 * adalah status tertinggi untuk lapisan yang belum punya round-trip tersimpan,
 * dan konfigurasi mustahil (PIR tanpa OPRF) harus terbaca `off`, bukan "aktif".
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildPrivacyStatus,
  collectPrivacyStatus,
  type PrivacyLayerStatus,
} from '../privacyStatus';

const byId = (list: PrivacyLayerStatus[], id: PrivacyLayerStatus['id']) =>
  list.find((layer) => layer.id === id)!;

describe('buildPrivacyStatus', () => {
  const base = { ratchetSending: false, ohttp: false, oprf: false, pir: false };

  it('enkripsi pesan selalu aktif (tidak ada saklar)', () => {
    expect(byId(buildPrivacyStatus(base), 'e2ee').state).toBe('active');
  });

  it('ratchet mengikuti kemampuan mengirim v2', () => {
    expect(byId(buildPrivacyStatus(base), 'ratchet').state).toBe('off');
    expect(
      byId(buildPrivacyStatus({ ...base, ratchetSending: true }), 'ratchet').state
    ).toBe('active');
  });

  it('OHTTP paling tinggi "configured" — tidak ada bukti round-trip tersimpan', () => {
    expect(byId(buildPrivacyStatus(base), 'ohttp').state).toBe('off');
    expect(byId(buildPrivacyStatus({ ...base, ohttp: true }), 'ohttp').state).toBe(
      'configured'
    );
  });

  it('PIR tanpa OPRF = konfigurasi mustahil → off (bukan aktif)', () => {
    const layer = byId(buildPrivacyStatus({ ...base, pir: true, oprf: false }), 'search');
    expect(layer.state).toBe('off');
    expect(layer.params).toEqual({ pir: 1, oprf: 0 });
  });

  it('OPRF aktif → search configured, PIR dicatat sebagai angka', () => {
    const layer = byId(buildPrivacyStatus({ ...base, oprf: true, pir: true }), 'search');
    expect(layer.state).toBe('configured');
    expect(layer.params).toEqual({ pir: 1, oprf: 1 });
  });

  it('KT tanpa bukti tersimpan → unknown', () => {
    expect(byId(buildPrivacyStatus(base), 'kt').state).toBe('unknown');
    expect(
      byId(buildPrivacyStatus({ ...base, kt: { monitoredKeys: 0 } }), 'kt').state
    ).toBe('unknown');
  });

  it('KT dengan bukti tersimpan → active, umur dihitung dari verifiedAt', () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    const verifiedAt = now - 3_600_000;
    const layer = byId(
      buildPrivacyStatus({
        ...base,
        kt: { monitoredKeys: 4, treeSize: 12_345, verifiedAt },
        now,
      }),
      'kt'
    );
    expect(layer.state).toBe('active');
    expect(layer.params).toEqual({ keys: 4, treeSize: 12_345, ageMs: 3_600_000 });
  });

  it('umur tidak pernah negatif walau jam perangkat mundur', () => {
    const now = 1_000;
    const layer = byId(
      buildPrivacyStatus({ ...base, kt: { monitoredKeys: 1, verifiedAt: now + 5_000 }, now }),
      'kt'
    );
    expect(layer.params?.ageMs).toBe(0);
  });
});

describe('collectPrivacyStatus', () => {
  it('memakai sumber yang diinjeksi dan meneruskan bukti KT', async () => {
    const ratchetSending = vi.fn(() => true);
    const ohttpEnabled = vi.fn(() => false);
    const oprfEnabled = vi.fn(() => true);
    const pirEnabled = vi.fn(() => false);
    const loadKt = vi.fn(async () => ({ monitoredKeys: 2, treeSize: 7 }));

    const layers = await collectPrivacyStatus({
      ratchetSending,
      ohttpEnabled,
      oprfEnabled,
      pirEnabled,
      loadKt,
      now: () => 42,
    });

    expect(ratchetSending).toHaveBeenCalledOnce();
    expect(loadKt).toHaveBeenCalledOnce();
    expect(byId(layers, 'ratchet').state).toBe('active');
    expect(byId(layers, 'ohttp').state).toBe('off');
    expect(byId(layers, 'search').state).toBe('configured');
    expect(byId(layers, 'kt').params).toEqual({ keys: 2, treeSize: 7 });
  });

  it('tidak melempar saat pembaca KT gagal (mode privat / IndexedDB mati)', async () => {
    const layers = await collectPrivacyStatus({
      ratchetSending: () => false,
      ohttpEnabled: () => false,
      oprfEnabled: () => false,
      pirEnabled: () => false,
      loadKt: async () => {
        throw new Error('IDB_BLOCKED');
      },
      now: () => 0,
    }).catch(() => null);

    // Kegagalan pembaca diteruskan sebagai error dari collector (halaman
    // menampilkan load_failed); yang penting tidak menggantung atau berbohong.
    expect(layers).toBeNull();
  });
});
