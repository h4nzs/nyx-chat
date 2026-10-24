// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/34 §34.6] Satu-satunya sinyal UI untuk kesehatan Key Transparency.
 *
 * Monitor KT berjalan berkala; kegagalannya tidak boleh hanya jadi console.warn.
 * Banner global dipakai supaya user tahu bahwa verifikasi kunci kontak sedang
 * tidak berjalan, tanpa memblokir chat. KT yang memang dinonaktifkan bukan
 * kegagalan — jangan tampilkan banner untuk konfigurasi itu.
 */

import { useSystemStore } from '../store/systemStore';

export const KT_UNAVAILABLE_ALERT = 'kt_unavailable';
const MESSAGE =
  'Key Transparency is unavailable. New contact keys are not being checked against the public log.';

const isDisabled = (error: unknown): boolean => {
  const details = (error as { details?: { error?: unknown } } | null)?.details;
  return details?.error === 'KT_QUERY_DISABLED';
};

const dismissedToday = (): boolean => {
  try {
    return localStorage.getItem(`nyx_dismissed_${KT_UNAVAILABLE_ALERT}`) === new Date().toDateString();
  } catch {
    return false;
  }
};

/** Tampilkan banner hanya bila KT dikonfigurasi tetapi gagal dipakai. */
export function reportKtUnavailable(error?: unknown): void {
  if (isDisabled(error) || dismissedToday()) return;
  const state = useSystemStore.getState();
  // Banner admin/personal lain tidak boleh ditimpa.
  if (state.banner.active && state.banner.alertType !== KT_UNAVAILABLE_ALERT) return;
  if (state.banner.alertType === KT_UNAVAILABLE_ALERT) return;
  state.setBanner({
    active: true,
    message: MESSAGE,
    type: 'warning',
    alertType: KT_UNAVAILABLE_ALERT,
  });
}

/** Hapus banner hanya bila banner itu milik KT. */
export function reportKtAvailable(): void {
  const state = useSystemStore.getState();
  if (state.banner.alertType !== KT_UNAVAILABLE_ALERT) return;
  state.setBanner({ active: false, message: '', type: 'info' });
}
