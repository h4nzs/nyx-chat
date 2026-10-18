// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [UX 2026-10-18] Alasan redirect ke `/login` → teks yang ditampilkan.
 *
 * Server/klien mengarahkan ke sini dengan tiga alasan yang berbeda, dan
 * sebelumnya halaman login tidak membaca query-nya sama sekali — perangkat
 * yang dicabut, di-kick, atau diblokir mendarat di form kosong tanpa penjelasan:
 *
 *   - `reason=revoked`  → sesi dicabut (force_logout / refresh reuse).
 *   - `reason=kicked`   → sidecar menutup koneksi "Logged in on another device".
 *   - `reason=banned`   → `auth:banned`; `msg` memuat alasan dari admin.
 *
 * Dipisah dari `Login.tsx` supaya pemetaannya bisa diuji tanpa merender halaman
 * (halaman itu mengimpor worker kripto & banyak store).
 */

export interface LoginNotice {
  /** Kunci i18n (namespace `auth`, objek `messages`). */
  key: string;
  /** Detail tambahan dari server (mis. alasan ban), bila ada. */
  detail: string | null;
}

export function loginNoticeFromSearch(search: string): LoginNotice | null {
  const params = new URLSearchParams(search);
  const reason = params.get('reason');
  if (reason === 'revoked') return { key: 'auth:messages.session_revoked', detail: null };
  if (reason === 'kicked') return { key: 'auth:messages.session_kicked', detail: null };
  if (reason === 'banned') return { key: 'auth:messages.account_banned', detail: params.get('msg') };
  return null;
}
