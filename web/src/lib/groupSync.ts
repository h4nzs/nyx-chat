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
import {
  consumePrivacyPassProof,
  dropPrivacyPassTokens,
  ensurePrivacyPassProof,
  takePrivacyPassProof,
} from '@lib/privacyPass';

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
  /** Server hanya memproses 200 token pertama (`MAX_SYNC_TOKENS`). */
  truncated?: boolean;
}

/**
 * [audit F-10] Batas server per request (`server/src/utils/groupSync.ts`).
 * Klien memecah token menjadi batch sebesar ini; jangan kirim semuanya lalu
 * berharap server memproses sisanya.
 */
export const MAX_SYNC_TOKENS = 200;

/**
 * Batch pertama yang dicoba pada sync berikutnya. Bila satu batch gagal (mis.
 * bukti Privacy Pass habis), batch itu didahulukan agar grup di luar 200
 * pertama tidak kelaparan selamanya.
 */
let nextBatchCursor = 0;

function warnIfTruncated (response: GroupSyncResponse): void {
  if (response.truncated) {
    console.warn('[GroupSync] Sebagian token belum tersinkron; batch yang gagal didahulukan pada sync berikutnya.');
  }
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

/** Server menolak karena tidak ada bukti Privacy Pass yang sah. */
function isProofRequired (error: unknown): boolean {
  return error instanceof Error && error.message.includes('PP_PROOF_REQUIRED');
}

/**
 * Satu percobaan sync dengan bukti yang sudah dipilih. Bukti hanya dibuang dari
 * stok lokal kalau server benar-benar menerimanya (2xx).
 */
async function syncOnce (
  tokens: string[],
  conversationId: string | undefined,
  proof: string | undefined,
): Promise<GroupSyncResponse> {
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
        warnIfTruncated(parsed);
        await refreshDueMemberships(tokens, parsed.memberships ?? []);
        return parsed;
      }
      if (result.status === 403 && conversationId) {
        const text = new TextDecoder().decode(result.body);
        if (text.includes('PP_PROOF_REQUIRED')) {
          // Bukti tidak sah/kedaluwarsa. Buang stok lalu lempar supaya pemanggil
          // menerbitkan bukti baru dan mengulang SEKALI (jalur langsung tidak
          // akan menjawab berbeda selama gate `PP_SYNC_REQUIRED=1` menyala).
          await dropPrivacyPassTokens(conversationId);
          throw new Error('PP_PROOF_REQUIRED');
        }
      }
      console.warn(`[OHTTP] Sync dijawab HTTP ${result.status}, memakai jalur langsung`);
    } catch (error) {
      if (isProofRequired(error)) throw error;
      console.warn('[OHTTP] Sync gagal di dalam amplop, memakai jalur langsung:', error);
    }
  }

  const response = await anonymousPost<GroupSyncResponse>('/api/groups/sync', body);
  warnIfTruncated(response);
  if (conversationId) await consumePrivacyPassProof(conversationId, proof);
  await refreshDueMemberships(tokens, response.memberships ?? []);
  return response;
}

async function syncBatch (
  tokens: string[],
  conversationId?: string,
): Promise<GroupSyncResponse> {
  const proof = conversationId
    ? await takePrivacyPassProof(conversationId).catch((error) => {
        console.warn('[PP] Bukti Privacy Pass tidak tersedia:', error);
        return undefined;
      })
    : undefined;

  try {
    return await syncOnce(tokens, conversationId, proof);
  } catch (error) {
    if (!conversationId || !isProofRequired(error)) throw error;

    // [PP aktif] `PP_SYNC_REQUIRED=1`: stok bukti kosong/kedaluwarsa menjawab
    // 403. Terbitkan satu bukti secara sinkron lalu ulangi SEKALI — tanpa ini
    // gate itu mematikan discovery untuk klien yang baru login / perangkat baru.
    await dropPrivacyPassTokens(conversationId);
    const fresh = await ensurePrivacyPassProof(conversationId);
    if (!fresh) throw error;
    return await syncOnce(tokens, conversationId, fresh);
  }
}

export async function syncGroupMemberships (
  tokens: string[],
  options: GroupSyncOptions = {},
): Promise<GroupSyncResponse> {
  if (tokens.length <= MAX_SYNC_TOKENS) return syncBatch(tokens, options.conversationId);

  const totalBatches = Math.ceil(tokens.length / MAX_SYNC_TOKENS);
  const merged: GroupSyncResponse = { conversations: [], memberships: [], unknown: 0, truncated: false };
  const seenConversations = new Set<string>();
  let processed = 0;
  let lastError: unknown = null;

  for (let step = 0; step < totalBatches; step += 1) {
    const batchIndex = (nextBatchCursor + step) % totalBatches;
    const offset = batchIndex * MAX_SYNC_TOKENS;
    const batch = tokens.slice(offset, offset + MAX_SYNC_TOKENS);
    try {
      const response = await syncBatch(batch, options.conversationId);
      for (const conversation of response.conversations ?? []) {
        if (seenConversations.has(conversation.id)) continue;
        seenConversations.add(conversation.id);
        merged.conversations.push(conversation);
      }
      for (const membership of response.memberships ?? []) {
        merged.memberships.push({ ...membership, index: membership.index + offset });
      }
      merged.unknown = (merged.unknown ?? 0) + (response.unknown ?? 0);
      processed += 1;
    } catch (error) {
      nextBatchCursor = batchIndex;
      merged.truncated = true;
      lastError = error;
      console.warn(`[GroupSync] Batch ${batchIndex + 1}/${totalBatches} gagal:`, error);
      break;
    }
  }

  if (processed === totalBatches) nextBatchCursor = 0;
  else if (processed === 0) throw lastError ?? new Error('Group sync gagal');
  else warnIfTruncated(merged);
  merged.memberships.sort((a, b) => a.index - b.index);
  return merged;
}
