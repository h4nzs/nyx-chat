// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { CLIENT_CAPABILITIES } from '@nyx/shared';

export const PQ_V2_CAPABILITY: string = CLIENT_CAPABILITIES.PQ_V2;

/**
 * [PQ-only 2026-10-23] Gerbang `VITE_PQ_V2` dihapus: jalur v1/hybrid sudah
 * tidak ada di kode, jadi build apa pun berjalan sebagai PQ v2. Fungsi ini
 * dipertahankan (bukan konstanta) agar pemanggil lama yang masih bercabang
 * tidak perlu diubah sekaligus.
 */
export function resolvePqV2Enabled(_env?: { VITE_PQ_V2?: string }): boolean {
  return true;
}

export function advertisedPqCapabilities(enabled: boolean = resolvePqV2Enabled()): string[] {
  return enabled ? [PQ_V2_CAPABILITY] : [];
}
