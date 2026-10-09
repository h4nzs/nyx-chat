// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B2] `captureSentAt` — ambil waktu presisi dari plaintext
 * hasil dekripsi lalu buang field-nya.
 *
 * Yang TIDAK boleh rusak: logika "collapse" payload teks memakai
 * `Object.keys(parsed).length === 1`. Test memastikan field `sentAt` benar-benar
 * dihapus sehingga collapse tetap bekerja (pesan teks tidak jadi JSON mentah).
 */

import { describe, it, expect } from 'vitest';
import { captureSentAt } from '../messagePipeline';

describe('captureSentAt (B2)', () => {
  it('menyalin sentAt numerik ke target lalu menghapus field dari parsed', () => {
    const parsed: Record<string, unknown> = { text: 'halo', sentAt: 1728384000000 };
    const target: { sentAt?: number } = {};
    captureSentAt(parsed, target);
    expect(target.sentAt).toBe(1728384000000);
    expect('sentAt' in parsed).toBe(false);
  });

  it('menormalkan string numerik', () => {
    const target: { sentAt?: number } = {};
    captureSentAt({ sentAt: '1728384000000' }, target);
    expect(target.sentAt).toBe(1728384000000);
  });

  it('mengabaikan nilai tidak valid tapi tetap menghapus field', () => {
    const parsed: Record<string, unknown> = { sentAt: 'abc' };
    const target: { sentAt?: number } = {};
    captureSentAt(parsed, target);
    expect(target.sentAt).toBeUndefined();
    expect('sentAt' in parsed).toBe(false);
  });

  it('aman untuk payload tanpa sentAt', () => {
    const target: { sentAt?: number } = {};
    captureSentAt({ text: 'x' }, target);
    expect(target.sentAt).toBeUndefined();
  });

  it('menjaga collapse payload teks tetap bekerja setelah field dibuang', () => {
    const parsed: Record<string, unknown> = { text: 'halo', profileKey: 'k', sentAt: 1 };
    const target: { sentAt?: number } = {};
    // Simulasi urutan di pipeline: hapus profileKey dulu, lalu sentAt, lalu cek collapse.
    delete parsed.profileKey;
    captureSentAt(parsed, target);
    const innerValue = parsed.text !== undefined ? String(parsed.text) : null;
    expect(innerValue).toBe('halo');
    expect(Object.keys(parsed).length).toBe(1);
    expect(target.sentAt).toBe(1);
  });
});
