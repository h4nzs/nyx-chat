// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// Unit test INVARIANT 2: idempotent receive — replay distribusi era sama
// TIDAK boleh dianggap era baru (bug rewind 2026-10-02). Pola acuan:
// libsignal process_sender_key_distribution_message (sender_keys.rs).

import { describe, it, expect } from 'vitest';
import { isSameEraDistribution } from '../groupEra';

describe('isSameEraDistribution', () => {
  const ERA_A_INITIAL = 'eraA-initial-key';
  const ERA_A_CURRENT = 'eraA-current-key';
  const ERA_B_INITIAL = 'eraB-initial-key';

  it('state baru (null) → bukan replay (era pertama harus disimpan)', () => {
    expect(isSameEraDistribution(null, ERA_A_INITIAL, 0)).toBe(false);
  });

  it('BUG 2026-10-02: replay envelope (initialCK, N=0) pada state yang sudah maju TIDAK dianggap era baru', () => {
    // State penerima sudah maju: CK posisi terkini, N=5, anchor era A.
    const state = { CK: ERA_A_CURRENT, N: 5, eraCK: ERA_A_INITIAL };
    // Envelope fulfillment tersisten di server → diproses ulang tiap reload.
    expect(isSameEraDistribution(state, ERA_A_INITIAL, 0)).toBe(true);
  });

  it('era baru (anchor berbeda) → BUKAN replay', () => {
    const state = { CK: ERA_A_CURRENT, N: 5, eraCK: ERA_A_INITIAL };
    expect(isSameEraDistribution(state, ERA_B_INITIAL, 0)).toBe(false);
  });

  it('legacy tanpa anchor: replay N=0 pada state maju = replay era sama', () => {
    const state = { CK: ERA_A_CURRENT, N: 5 };
    expect(isSameEraDistribution(state, ERA_A_INITIAL, 0)).toBe(true);
  });

  it('legacy tanpa anchor: envelope N>0 dengan state lebih rendah = era/maju baru (bukan replay)', () => {
    const state = { CK: ERA_A_CURRENT, N: 2 };
    expect(isSameEraDistribution(state, 'whatever', 5)).toBe(false);
  });

  it('legacy tanpa anchor: envelope N>0 dengan state ≥ envelope = replay', () => {
    const state = { CK: ERA_A_CURRENT, N: 5 };
    expect(isSameEraDistribution(state, 'whatever', 3)).toBe(true);
  });

  it('anchor cocok pada N>0 identik = replay', () => {
    const state = { CK: ERA_A_CURRENT, N: 5, eraCK: ERA_A_INITIAL };
    expect(isSameEraDistribution(state, ERA_A_INITIAL, 5)).toBe(true);
  });
});
