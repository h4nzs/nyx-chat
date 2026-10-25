// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3 + §37.4 P3] Sync grup anonim.
 *
 * Satu jalur, dua transport:
 *  - **OHTTP POST** (bila `VITE_OHTTP_ENABLED=1`): request masuk amplop, jadi
 *    relay melihat IP tanpa isi dan gateway melihat isi tanpa IP. Sync tidak
 *    memakai cookie/JWT, jadi tidak butuh token carriage (`withToken: false`).
 *  - **Langsung** ke API sebagai fallback (OHTTP mati / gagal) — perilaku lama,
 *    dicatat di metrik klien lewat log, bukan diam-diam.
 *
 * Bukti Privacy Pass ikut di body bila tersedia: satu token = satu sync, dan
 * token yang diterima server dibuang dari stok lokal agar tidak dikirim ulang.
 */

import type { Conversation } from '@nyx/shared';
import { getApiBaseUrl } from '@lib/api';
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_VALUE } from '@lib/clientVersion';
import { ohttpEnabled, ohttpFetch } from '@lib/ohttpClient';
import { consumePrivacyPassProof, dropPrivacyPassTokens, takePrivacyPassProof } from '@lib/privacyPass';

export interface GroupSyncMembership {
  index: number;
  status: 'ok' | 'refresh' | 'stale';
  conversationId: string;
  epoch: number;
  expiresAt: string;
}

export interface GroupSyncResponse {
  conversations: Conversation[];
  memberships: GroupSyncMembership[];
  /** Jumlah token yang tidak dikenali server (bukan daftar token). */
  unknown?: number;
}

export interface GroupSyncOptions {
  /** Grup yang metadata-nya sudah ter-dekripsi — sumber bukti Privacy Pass. */
  conversationId?: string;
}

function parseSyncBody (bytes: Uint8Array): GroupSyncResponse {
  return JSON.parse(new TextDecoder().decode(bytes)) as GroupSyncResponse;
}

/**
 * POST tanpa cookie: fallback langsung tetap anonim (route `/api/groups` tidak
 * memakai sesi/CSRF). Jangan kembali ke `api()` di sini — itu melampirkan
 * cookie akun dan mematahkan klaim anonymous sync saat OHTTP mati.
 */
async function anonymousPost<T> (path: string, body: string): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [CLIENT_VERSION_HEADER]: CLIENT_VERSION_VALUE,
    },
    body,
    credentials: 'omit',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message ?? `HTTP ${response.status}`);
  }
  return parsed as T;
}

/** Perpanjang token anggota yang mendekati/melewati TTL (grace) — tanpa sesi. */
async function refreshDueMemberships (tokens: string[], memberships: GroupSyncMembership[]): Promise<void> {
  const due = memberships.filter((membership) =>
    membership.status === 'refresh' && typeof tokens[membership.index] === 'string'
  );
  await Promise.all(due.map(async (membership) => {
    const token = tokens[membership.index]!;
    await anonymousPost('/api/groups/token/refresh', JSON.stringify({ token })).catch((error) => {
      console.warn('[GroupSync] Refresh token anggota gagal:', error);
    });
  }));
}

export async function syncGroupMemberships (
  tokens: string[],
  options: GroupSyncOptions = {},
): Promise<GroupSyncResponse> {
  const { conversationId } = options;
  const proof = conversationId
    ? await takePrivacyPassProof(conversationId).catch((error) => {
        console.warn('[PP] Bukti Privacy Pass tidak tersedia:', error);
        return undefined;
      })
    : undefined;

  const body = JSON.stringify({ tokens, ...(proof ? { proofs: [proof] } : {}) });

  if (ohttpEnabled()) {
    try {
      const result = await ohttpFetch('/api/groups/sync', {
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body: new TextEncoder().encode(body),
        // Sync tidak memakai identitas akun; jangan minta token OHTTP (itu butuh sesi).
        withToken: false,
      });
      if (result.status >= 200 && result.status < 300) {
        if (conversationId) await consumePrivacyPassProof(conversationId, proof);
        const parsed = parseSyncBody(result.body);
        await refreshDueMemberships(tokens, parsed.memberships ?? []);
        return parsed;
      }
      if (result.status === 403 && conversationId) {
        // Bukti ditolak (mis. issuer berganti setelah restart dev). Buang stok
        // supaya sync berikutnya meminta token baru, lalu jatuh ke jalur langsung
        // agar error yang dilihat pemanggil datang dari API, bukan dari amplop.
        const text = new TextDecoder().decode(result.body);
        if (text.includes('PP_PROOF_REQUIRED')) await dropPrivacyPassTokens(conversationId);
      }
      console.warn(`[OHTTP] Sync dijawab HTTP ${result.status}, memakai jalur langsung`);
    } catch (error) {
      console.warn('[OHTTP] Sync gagal di dalam amplop, memakai jalur langsung:', error);
    }
  }

  const response = await anonymousPost<GroupSyncResponse>('/api/groups/sync', body);
  if (conversationId) await consumePrivacyPassProof(conversationId, proof);
  await refreshDueMemberships(tokens, response.memberships ?? []);
  return response;
}
