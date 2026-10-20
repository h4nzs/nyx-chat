// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { CLIENT_CAPABILITIES } from '@nyx/shared';

export const PQ_V2_CAPABILITY: string = CLIENT_CAPABILITIES.PQ_V2;

export function resolvePqV2Enabled(
  env: { VITE_PQ_V2?: string } = import.meta.env as { VITE_PQ_V2?: string }
): boolean {
  return env.VITE_PQ_V2 === '1';
}

export function advertisedPqCapabilities(enabled: boolean = resolvePqV2Enabled()): string[] {
  return enabled ? [PQ_V2_CAPABILITY] : [];
}
