// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 4] Padding query pencarian: panjang path harus SERAGAM untuk
 * hash 43-char (klien) dan 64-hex (hash-ID lama), supaya bentuk identifier
 * tidak terbaca dari panjang URL oleh relay/edge log.
 */

import { describe, expect, it } from 'vitest';
import { SEARCH_QUERY_SLOT_CHARS, paddedSearchPath } from '../userSearch';

const HASH_43 = 'A'.repeat(43);
const HASH_64 = 'a'.repeat(64);

describe('paddedSearchPath', () => {
  it('menjaga q apa adanya (ter-encode)', () => {
    expect(paddedSearchPath(HASH_43, () => 0.5)).toContain(`q=${HASH_43}`);
    expect(paddedSearchPath(HASH_64, () => 0.5)).toContain(`q=${HASH_64}`);
  });

  it('panjang sama untuk hash 43-char dan 64-hex', () => {
    const a = paddedSearchPath(HASH_43, () => 0.25);
    const b = paddedSearchPath(HASH_64, () => 0.75);
    expect(a.length).toBe(b.length);
  });

  it('pad mengisi sisa slot sampai 64 karakter dan selalu base64url', () => {
    const pad = paddedSearchPath(HASH_43, () => 0.5).split('&pad=')[1] ?? '';
    expect(pad).toHaveLength(SEARCH_QUERY_SLOT_CHARS - HASH_43.length);
    expect(pad).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash 64-hex tidak butuh padding tambahan (slot sudah penuh)', () => {
    const pad = paddedSearchPath(HASH_64, () => 0.5).split('&pad=')[1] ?? '';
    expect(pad).toBe('');
  });

  it('padding berbeda tiap panggilan (tidak deterministik)', () => {
    const a = paddedSearchPath(HASH_43, () => 0.1).split('&pad=')[1];
    const b = paddedSearchPath(HASH_43, () => 0.9).split('&pad=')[1];
    expect(a).not.toBe(b);
  });
});
