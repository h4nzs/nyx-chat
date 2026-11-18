// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Bentuk wire braid v2 — satu-satunya bentuk ratchet.
 *
 * Yang dikunci di sini adalah hal-hal yang, kalau salah, membuat pesan tidak
 * bisa dibuka tanpa pesan error yang jelas:
 *   1. Header tanpa `v: 2` TIDAK pernah dikenali sebagai v2 (tidak ada jalur
 *      v1 yang bisa disalahartikan).
 *   2. Frame braid bolak-balik utuh (base64url → byte → base64url).
 *   3. Batas parse ditegakkan (jumlah frame, panjang frame, karakter) karena
 *      header datang dari jaringan.
 */
import { describe, expect, it } from 'vitest';

import {
  SPQR_MAX_FRAME_B64_CHARS,
  SPQR_MAX_FRAMES_PER_MESSAGE,
  SPQR_RATCHET_WIRE_VERSION,
  buildSpqrHeader,
  decodeSpqrFrames,
  isSpqrHeader,
  parseSpqrHeader,
} from '../spqrWire';

const FRAME = Uint8Array.from([1, 2, 3, 250, 251, 252]);
const FRAME_B64 = 'AQID-vv8';

/** Header v1 beku — tidak boleh punya `v` (`docs/04`). */
const V1_HEADER = { kemPk: 'AAAA', ct: 'BBBB', n: 0, pn: 0 };

describe('header v2', () => {
  it('build → parse → decode round-trip utuh (termasuk byte non-ASCII)', () => {
    const header = buildSpqrHeader({ frames: [FRAME, FRAME] });
    expect(header.v).toBe(SPQR_RATCHET_WIRE_VERSION);

    // Melewati JSON seperti yang dilakukan amplop pesan.
    const wire = JSON.parse(JSON.stringify(header)) as unknown;
    const parsed = parseSpqrHeader(wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.b).toEqual([FRAME_B64, FRAME_B64]);
    expect(decodeSpqrFrames(parsed!)).toEqual([FRAME, FRAME]);
  });

  it('header v1 TIDAK pernah dikenali sebagai v2 (dan sebaliknya)', () => {
    expect(isSpqrHeader(V1_HEADER)).toBe(false);
    expect(parseSpqrHeader(V1_HEADER)).toBeNull();
    expect(isSpqrHeader({ v: SPQR_RATCHET_WIRE_VERSION, b: [FRAME_B64] })).toBe(true);
    expect(isSpqrHeader(null)).toBe(false);
    expect(isSpqrHeader('v:2')).toBe(false);
    expect(isSpqrHeader({ v: 1, b: [FRAME_B64] })).toBe(false);
    expect(isSpqrHeader({ v: '2', b: [FRAME_B64] })).toBe(false);
  });

  it('menolak header v2 yang cacat (payload jaringan)', () => {
    const bad: unknown[] = [
      { v: 2 },
      { v: 2, b: [] },
      { v: 2, b: 'framebukanarray' },
      { v: 2, b: [''] },
      { v: 2, b: [null] },
      { v: 2, b: [123] },
      { v: 2, b: ['punya spasi'] },
      { v: 2, b: ['plus+slash/'] },
      { v: 2, b: ['a'.repeat(SPQR_MAX_FRAME_B64_CHARS + 1)] },
      { v: 2, b: Array(SPQR_MAX_FRAMES_PER_MESSAGE + 1).fill(FRAME_B64) },
    ];
    for (const value of bad) {
      expect(parseSpqrHeader(value), JSON.stringify(value).slice(0, 40)).toBeNull();
    }
  });

  it('bidang tambahan yang tidak dikenal diabaikan (forward-compatible)', () => {
    const parsed = parseSpqrHeader({ v: 2, b: [FRAME_B64], n: 7, pn: 3, future: { x: 1 } });
    expect(parsed).toEqual({ v: 2, b: [FRAME_B64] });
  });

  it('pengirim tidak pernah menghasilkan header tanpa frame', () => {
    expect(() => buildSpqrHeader({ frames: [] })).toThrow(/tidak ada frame/);
    expect(() => buildSpqrHeader({ frames: [new Uint8Array()] })).toThrow(/frame kosong/);
    expect(() =>
      buildSpqrHeader({ frames: Array(SPQR_MAX_FRAMES_PER_MESSAGE + 1).fill(FRAME) })
    ).toThrow(/terlalu banyak frame/);
  });
});


