// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [LINK 2026-10-18] Klien untuk pairing perangkat lewat QR.
 *
 * Kontrak server (docs/12-api-reference.md, docs/14-auth-identity.md):
 *   POST /api/auth/link/claim     → { pendingId }
 *   GET  /api/auth/link/status/:id → { state: 'pending'|'approved'|'expired' }
 *   POST /api/auth/link/approve   → { ok, deviceId }        (butuh sesi)
 *   POST /api/auth/link/deny      → { ok }                  (butuh sesi)
 *   POST /api/auth/link/complete  → { deviceId, usernameHash }
 *
 * `complete` sengaja tidak mengembalikan token sesi: klien melanjutkan dengan
 * `useAuthStore.login()` yang sudah ada (verifikasi password + dekripsi kunci),
 * sehingga tidak ada jalur pembuatan sesi kedua.
 */

import { api } from './api';
import { getBrowserFingerprint } from '../utils/fingerprint';

/** Parameter URL tempat token QR dibawa (`/link?t=<token>`). */
export const LINK_TOKEN_QUERY_PARAM = 't';

export type DeviceLinkState = 'pending' | 'approved' | 'expired';

export interface DeviceLinkClaimInput {
  token: string;
  publicKey: string;
  pqPublicKey?: string;
  signingKey: string;
  /** [PQ v2 Fase 1.5 langkah 9] Kunci verifikasi ML-DSA perangkat baru. */
  signingKeyV2?: string;
  encryptedPrivateKey: string;
  deviceName?: string;
}

export interface DeviceLinkClaimResult {
  pendingId: string;
}

export interface DeviceLinkCompletion {
  deviceId: string;
  /** Hash identifier akun — dipakai langsung oleh `useAuthStore.login()`. */
  usernameHash: string;
}

/** QR yang dipindai perangkat baru: URL halaman `/link` + token sekali pakai. */
export function buildDeviceLinkUrl(origin: string, linkingToken: string): string {
  return `${origin.replace(/\/$/, '')}/link?${LINK_TOKEN_QUERY_PARAM}=${encodeURIComponent(linkingToken)}`;
}

/**
 * Ambil token dari hasil scan (URL penuh / path relatif) atau input manual
 * (token mentah). Nilai yang JELAS berupa tautan tetapi tanpa `t=` menghasilkan
 * null — lebih baik "tautan tidak sah" daripada mengirim URL sebagai token lalu
 * ditolak dengan pesan yang membingungkan.
 */
export function parseDeviceLinkToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const looksLikeLink = hasScheme || value.startsWith('/') || value.includes('?');
  if (looksLikeLink) {
    try {
      const url = new URL(value, 'https://nyx.invalid');
      const fromQuery = url.searchParams.get(LINK_TOKEN_QUERY_PARAM);
      const parsed = fromQuery?.trim();
      return parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  return value;
}

/**
 * Daftarkan kunci perangkat baru. Fingerprint/installation dikirim sebagai
 * header PERANGKAT INI supaya server mengikat device row ke hardware yang benar
 * (bukan ke perangkat lama yang menyetujui).
 */
export async function claimDeviceLink(input: DeviceLinkClaimInput): Promise<DeviceLinkClaimResult> {
  const fingerprint = await getBrowserFingerprint();
  return api<DeviceLinkClaimResult>('/api/auth/link/claim', {
    method: 'POST',
    headers: { 'X-Nyx-Fingerprint': fingerprint },
    body: JSON.stringify(input),
  });
}

export async function getDeviceLinkStatus(pendingId: string): Promise<DeviceLinkState> {
  const res = await api<{ state?: DeviceLinkState }>(
    `/api/auth/link/status/${encodeURIComponent(pendingId)}`
  );
  const state = res?.state;
  return state === 'approved' || state === 'expired' ? state : 'pending';
}

export async function approveDeviceLink(pendingId: string): Promise<{ deviceId: string }> {
  return api<{ deviceId: string }>('/api/auth/link/approve', {
    method: 'POST',
    body: JSON.stringify({ pendingId }),
  });
}

export async function denyDeviceLink(pendingId: string): Promise<void> {
  await api('/api/auth/link/deny', {
    method: 'POST',
    body: JSON.stringify({ pendingId }),
  });
}

/**
 * Menyelesaikan tautan. Password dikirim ulang dan diverifikasi server SEBELUM
 * state tautan dibakar — salah ketik password tidak menghabiskan QR.
 */
export async function completeDeviceLink(
  pendingId: string,
  password: string
): Promise<DeviceLinkCompletion> {
  return api<DeviceLinkCompletion>('/api/auth/link/complete', {
    method: 'POST',
    body: JSON.stringify({ pendingId, password }),
  });
}
