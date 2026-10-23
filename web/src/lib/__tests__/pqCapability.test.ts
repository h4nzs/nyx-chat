// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, it, expect } from 'vitest';
import { CLIENT_CAPABILITIES, SERVER_CAPABILITIES } from '@nyx/shared';
import { PQ_V2_CAPABILITY, advertisedPqCapabilities, resolvePqV2Enabled } from '../pqCapability';

describe('kapabilitas pq-v2', () => {
  it('nama kapabilitas dari @nyx/shared', () => {
    expect(PQ_V2_CAPABILITY).toBe(CLIENT_CAPABILITIES.PQ_V2);
    expect(SERVER_CAPABILITIES).toContain(CLIENT_CAPABILITIES.PQ_V2);
  });

  it('PQ-only: v2 selalu aktif dan selalu diiklankan', () => {
    // [PQ-only 2026-10-23] Jalur v1 dihapus; gerbang env tidak lagi mematikan
    // v2. Test ini mengunci bahwa tidak ada build yang jatuh ke v1 diam-diam.
    expect(resolvePqV2Enabled({})).toBe(true);
    expect(resolvePqV2Enabled({ VITE_PQ_V2: '0' })).toBe(true);
    expect(advertisedPqCapabilities()).toEqual([CLIENT_CAPABILITIES.PQ_V2]);
    expect(advertisedPqCapabilities(false)).toEqual([]);
  });
});
