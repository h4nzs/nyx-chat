// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B1/B2] Urutan pesan klien.
 *
 * Regresi yang dikunci di sini: pesan pending (belum di-ACK, tanpa `seq`)
 * dulu ikut `seq = 0`, sehingga setiap sort ulang (pesan masuk/sync) membuat
 * bubble "SENDING" melompat ke ATAS riwayat.
 */

import { describe, it, expect } from 'vitest';
import { compareMessagesByOrder, isPendingMessage } from '../messageOrder';

describe('compareMessagesByOrder (B1)', () => {
  it('pesan pending selalu di akhir (paling baru), bukan di atas riwayat', () => {
    const oldest = { seq: 1, createdAt: '2026-10-08T10:00:00.000Z' };
    const newest = { seq: 42, createdAt: '2026-10-08T10:00:00.000Z' };
    const pending = { id: 'temp_123', tempId: 123, optimistic: true, createdAt: '2026-10-08T11:00:00.000Z' };

    const sorted = [pending, oldest, newest].sort(compareMessagesByOrder);
    expect(sorted[2]).toBe(pending);
    expect(sorted[0]).toBe(oldest);
    expect(sorted[1]).toBe(newest);
  });

  it('deteksi pending lewat optimistic, tempId, atau id temp_', () => {
    expect(isPendingMessage({ optimistic: true })).toBe(true);
    expect(isPendingMessage({ tempId: 7 })).toBe(true);
    expect(isPendingMessage({ id: 'temp_7' })).toBe(true);
    expect(isPendingMessage({ id: 'uuid-7', seq: 3 })).toBe(false);
  });

  it('baris legacy (seq 0) tetap di bawah pesan ber-seq', () => {
    const legacy = { id: 'legacy-1', createdAt: '2026-10-08T09:00:00.000Z' };
    const seqed = { id: 'uuid-1', seq: 1, createdAt: '2026-10-08T09:00:00.000Z' };
    expect(compareMessagesByOrder(legacy, seqed)).toBeLessThan(0);
  });

  it('createdAt kasar (bucket sama) tidak jadi penentu utama — seq yang menentukan', () => {
    const a = { seq: 1, createdAt: '2026-10-08T10:00:00.000Z' };
    const b = { seq: 2, createdAt: '2026-10-08T10:00:00.000Z' };
    expect(compareMessagesByOrder(a, b)).toBeLessThan(0);
  });

  it('saat rank sama, sentAt presisi dipakai sebagai tie-break', () => {
    const a = { seq: 5, sentAt: 1_000, createdAt: '2026-10-08T10:00:00.000Z' };
    const b = { seq: 5, sentAt: 2_000, createdAt: '2026-10-08T10:00:00.000Z' };
    expect(compareMessagesByOrder(a, b)).toBeLessThan(0);
  });

  it('dua pesan pending diurutkan berdasarkan sentAt', () => {
    const first = { tempId: 1, optimistic: true, sentAt: 1000 };
    const second = { tempId: 2, optimistic: true, sentAt: 2000 };
    expect(compareMessagesByOrder(first, second)).toBeLessThan(0);
  });
});
