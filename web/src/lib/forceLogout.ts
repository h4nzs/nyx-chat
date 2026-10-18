// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Apakah `force_logout` dari server berlaku untuk device ini?
 *
 * Server dulu mengirim event `force_logout` tanpa `deviceId` ke SEMUA socket
 * milik user. Akibatnya mencabut satu sesi (atau reuse-detection di satu tab)
 * me-logout perangkat lain yang sesinya masih sah — terlihat sebagai "logout
 * sendiri" + `/login?reason=revoked` meski tidak ada yang mencurigakan.
 *
 * Aturan:
 *   - Event tanpa `deviceId` (server lama) → diterapkan (perilaku lama).
 *   - Device lokal tidak diketahui → diterapkan (jangan pernah MENAHAN logout
 *     yang mungkin sah karena localStorage rusak).
 *   - Selain itu harus persis sama.
 */
export function isForceLogoutForThisDevice(
  eventDeviceId: string | undefined | null,
  localDeviceId: string | null | undefined
): boolean {
  if (!eventDeviceId) return true;
  if (!localDeviceId) return true;
  return eventDeviceId === localDeviceId;
}

/**
 * [PARITY 2026-10-18] Aksi yang harus diambil klien untuk sebuah payload KICK
 * (opcode `0x07`).
 *
 * Mengapa tidak inline di `transportClient`: sebelumnya jalur WT menerima KICK
 * hanya sebagai penutupan koneksi ("Kicked by server"), sedangkan jalur WSS
 * menerimanya sebagai event `force_logout` dengan payload utuh — dua perilaku
 * berbeda untuk hal yang sama. Pemetaannya kini satu fungsi murni (bisa diuji
 * tanpa transport) yang dipakai klien untuk kedua jalur:
 *
 *  - `ignore`       → payload menyebut device LAIN (jangan logout perangkat yang
 *                     sesinya masih sah — bug yang sama dengan `deviceId` di
 *                     `force_logout`).
 *  - `auth_banned`  → payload TANPA `deviceId` tapi membawa `reason`: aksi level
 *                     akun (akun dihapus / ban admin) → halaman banned.
 *  - `force_logout` → kick per-device (revoke sesi, kick device, hardware
 *                     mismatch) ATAU payload tanpa informasi apa pun → logout +
 *                     `/login?reason=revoked` (server memang menutup sesi).
 */
export type KickDisposition =
  | { action: 'ignore'; deviceId?: string }
  | { action: 'auth_banned'; reason: string }
  | { action: 'force_logout'; payload: Record<string, unknown> };

export function classifyKickPayload(
  payload: Record<string, unknown> | null | undefined,
  localDeviceId: string | null | undefined
): KickDisposition {
  const json = payload ?? {};
  const eventDeviceId = typeof json.deviceId === 'string' ? json.deviceId : undefined;
  if (!isForceLogoutForThisDevice(eventDeviceId, localDeviceId)) {
    return { action: 'ignore', deviceId: eventDeviceId };
  }
  if (!eventDeviceId && typeof json.reason === 'string') {
    return { action: 'auth_banned', reason: json.reason };
  }
  return { action: 'force_logout', payload: json };
}
