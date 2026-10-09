// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.5 / D14] Hook langganan presence per-kontak.
 *
 * Server tidak lagi mendorong snapshot peer saat connect; klien yang menampilkan
 * kontak wajib meminta statusnya. Hook ini:
 *   - menyatukan id (dedupe + urut) supaya tidak memicu permintaan berulang,
 *   - mengirim permintaan saat terhubung (dan tiap 60 detik sebagai pengaman
 *     bila transport sempat terputus tanpa perubahan status store),
 *   - mengirim ulang saat koneksi baru terbentuk (`status` berubah).
 *
 * Id yang tidak dikenal server (bukan peer) diabaikan server — jadi hook ini
 * aman dipanggil dengan daftar apa pun yang sedang tampil di UI.
 */

import { useEffect, useMemo } from 'react';
import { requestPresence } from '@lib/presenceSubscribe';
import { useConnectionStore } from '@store/connection';

/** Interval refresh pengaman (ms). Server membatasi 60 permintaan/menit. */
const REFRESH_INTERVAL_MS = 60_000;

export function usePresenceSubscription(userIds: Array<string | undefined | null>): void {
  const status = useConnectionStore((s) => s.status);

  // Kunci stabil: perubahan urutan/duplikat tidak memicu pengiriman ulang.
  const key = useMemo(
    () =>
      Array.from(
        new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
      )
        .sort()
        .join(','),
    [userIds]
  );

  useEffect(() => {
    if (status !== 'connected') return;
    const ids = key ? key.split(',') : [];
    requestPresence(ids);
    const timer = setInterval(() => requestPresence(ids), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [key, status]);
}
