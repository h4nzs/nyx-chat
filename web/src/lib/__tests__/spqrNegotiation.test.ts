// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Tidak ada lagi negosiasi versi ratchet: braid v2 selalu
 * dikirim, jadi yang tersisa hanya iklan kapabilitas ke relay.
 */

import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '@nyx/shared';

import { SPQR_CAPABILITY, advertisedCapabilities } from '../spqrNegotiation';

describe('spqr — kapabilitas', () => {
  it('memakai konstanta bersama, bukan literal lokal', () => {
    expect(SPQR_CAPABILITY).toBe(CLIENT_CAPABILITIES.SPQR_RATCHET);
  });

  it('selalu mengiklankan kapabilitas (tidak ada saklar)', () => {
    expect(advertisedCapabilities()).toEqual([SPQR_CAPABILITY]);
  });
});
