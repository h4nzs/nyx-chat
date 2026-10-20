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

  it('klien tidak mengiklankan v2 secara default', () => {
    expect(resolvePqV2Enabled({})).toBe(false);
    expect(advertisedPqCapabilities()).toEqual([]);
  });

  it('iklannya hanya lewat env eksplisit', () => {
    expect(resolvePqV2Enabled({ VITE_PQ_V2: '1' })).toBe(true);
    expect(advertisedPqCapabilities(true)).toEqual([CLIENT_CAPABILITIES.PQ_V2]);
  });
});
