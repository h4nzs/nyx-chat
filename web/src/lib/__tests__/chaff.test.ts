// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Chaff visibility-aware: tab background tidak mengirim, mode
 * Maximum lebih rapat, ukuran datagram selalu ≤ 1000 byte (MTU QUIC).
 */

import { describe, expect, it } from 'vitest';
import {
  CHAFF_BASE_INTERVAL_MS,
  CHAFF_MAX_DATAGRAM_BYTES,
  CHAFF_MAXIMUM_INTERVAL_MS,
  resolveChaffProfile,
} from '../chaff';

describe('resolveChaffProfile', () => {
  it('tab background: chaff berhenti', () => {
    const profile = resolveChaffProfile({ visible: false });
    expect(profile.enabled).toBe(false);
  });

  it('tab terlihat: interval default 3 s, datagram ≤ MTU', () => {
    const profile = resolveChaffProfile({ visible: true });
    expect(profile.enabled).toBe(true);
    expect(profile.intervalMs).toBe(CHAFF_BASE_INTERVAL_MS);
    expect(profile.sizeBytes).toBeLessThanOrEqual(CHAFF_MAX_DATAGRAM_BYTES);
  });

  it('mode Maximum: denyut lebih rapat tanpa memperbesar datagram', () => {
    const base = resolveChaffProfile({ visible: true });
    const maximum = resolveChaffProfile({ visible: true, maximum: true });
    expect(maximum.intervalMs).toBe(CHAFF_MAXIMUM_INTERVAL_MS);
    expect(maximum.intervalMs).toBeLessThan(base.intervalMs);
    expect(maximum.sizeBytes).toBe(base.sizeBytes);
    expect(maximum.jitterMs).toBeLessThanOrEqual(base.jitterMs);
  });
});
