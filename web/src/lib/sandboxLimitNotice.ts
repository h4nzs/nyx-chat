// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Batas akun belum terverifikasi (`SANDBOX_LIMIT*`) adalah **keadaan**, bukan
 * kegagalan sekilas: ia bertahan sampai pengguna memverifikasi akunnya. Toast
 * 5 detik untuk keadaan seperti itu hanya memberi tahu bahwa sesuatu gagal,
 * tanpa jalan keluar — pengguna akan menekan kirim lagi dan melihat toast yang
 * sama.
 *
 * Karena itu jalur ini memunculkan **banner sistem** (komponen `SystemBanner`
 * yang sudah ada) dengan aksi ke halaman verifikasi; toast tetap boleh muncul
 * sekali dari pemanggil sebagai umpan balik langsung, tetapi bannernya yang
 * menjelaskan apa yang harus dilakukan. Banner personal dipertahankan oleh
 * `systemStore.checkStatus` (poll 60 dtk), jadi ia tidak hilang pada poll
 * berikutnya.
 */

import i18n from '../i18n';
import { useSystemStore } from '../store/systemStore';
import { isSandboxLimit } from './apiErrorText';

/** Nilai `alertType` = kunci penyimpanan "dismiss hari ini" di SystemBanner. */
export const SANDBOX_BANNER_ALERT_TYPE = 'sandbox_limit';

/**
 * Tampilkan banner verifikasi bila `error` memang batas sandbox.
 * Mengembalikan `true` bila banner ditampilkan. Tanpa argumen = paksa tampil
 * (untuk jalur yang sudah tahu kodenya, mis. payload realtime).
 */
export function reportSandboxLimit(error?: unknown): boolean {
  if (error !== undefined && !isSandboxLimit(error)) return false;

  useSystemStore.getState().setBanner({
    active: true,
    type: 'warning',
    alertType: SANDBOX_BANNER_ALERT_TYPE,
    message: i18n.t('errors:sandbox_banner_message'),
    actionText: i18n.t('errors:sandbox_banner_action'),
    actionLink: '/settings',
  });
  return true;
}
