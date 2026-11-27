// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.4.1] Privacy Pass pengganti Blind RSA.
 *
 * Klien membuat token acak 256-bit sendiri dan hanya mengirim komitmen
 * `SHA-256(token)` saat issuance. Server menyimpan HMAC komitmen itu (tanpa
 * token mentah), lalu saat sync klien menyerahkan token; server menghitung
 * komitmen yang sama dan menandainya spent. Tidak ada RSA atau issuer key yang
 * harus stabil antar-restart.
 *
 * Batas kejujuran:
 *  - unlinkability issuance ↔ redemption tetap bergantung pada OHTTP + tidak
 *    adanya log waktu; server tetap melihat kapan issuance dan redemption
 *    terjadi jika itu dicatat;
 *  - token disimpan ter-seal saat vault terbuka. Kalau vault terkunci, token
 *    hanya hidup di memori — sync tetap jalan, hanya tanpa bukti.
 *
 * Wire token: `base64url(random(32))`.
 */

import { api } from '@lib/api';
import { getMyDeliveryToken, getMyGroupToken } from '@lib/groupPseudonyms';
import { bytesToBase64Url } from './base64url';

export const PP_SUITE = 'nyx-pp-token-v1';
const TOKEN_BYTES = 32;
/** Server memakai TTL 24 jam; token lebih tua dibuang, bukan dikirim sia-sia. */
const PP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 5;
const MAX_BATCH = 10;
const KV_KEY = 'nyx_pp_tokens';

interface StoredGrant {
  tokens: string[];
  expiresAt: number;
}

const memory = new Map<string, StoredGrant>();
const issuing = new Set<string>();

async function tokenCommitment (token: Uint8Array): Promise<Uint8Array> {
  const input = token.buffer.slice(token.byteOffset, token.byteOffset + token.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return new Uint8Array(digest);
}

// --- penyimpanan (ter-seal bila vault terbuka) ---

async function loadStoredGrants (): Promise<Record<string, StoredGrant>> {
  try {
    const [{ getKvStore }, { decryptValueAtRest }] = await Promise.all([
      import('@lib/storage/appKv'),
      import('@lib/keychainDb'),
    ]);
    const sealed = (await (await getKvStore()).get<Record<string, string>>(KV_KEY)) ?? {};
    const grants: Record<string, StoredGrant> = {};
    for (const [conversationId, value] of Object.entries(sealed)) {
      const plain = await decryptValueAtRest(value);
      if (!plain) continue;
      const parsed = JSON.parse(plain) as StoredGrant;
      if (Array.isArray(parsed.tokens) && typeof parsed.expiresAt === 'number') grants[conversationId] = parsed;
    }
    return grants;
  } catch {
    return {};
  }
}

async function saveStoredGrant (conversationId: string, grant: StoredGrant | null): Promise<void> {
  try {
    const [{ getKvStore }, { encryptValueAtRest }] = await Promise.all([
      import('@lib/storage/appKv'),
      import('@lib/keychainDb'),
    ]);
    const sealed = (await (await getKvStore()).get<Record<string, string>>(KV_KEY)) ?? {};
    if (grant && grant.tokens.length > 0) {
      sealed[conversationId] = await encryptValueAtRest(JSON.stringify(grant));
    } else {
      delete sealed[conversationId];
    }
    await (await getKvStore()).put({ key: KV_KEY, value: sealed });
  } catch {
    // Vault terkunci / DB belum siap: token tetap di memori untuk sesi ini.
  }
}

function freshTokens (grant: StoredGrant | undefined): string[] {
  if (!grant || grant.expiresAt <= Date.now()) return [];
  return grant.tokens;
}

async function readGrant (conversationId: string): Promise<StoredGrant | undefined> {
  if (!memory.has(conversationId)) {
    const stored = await loadStoredGrants();
    if (stored[conversationId]) memory.set(conversationId, stored[conversationId]!);
  }
  return memory.get(conversationId);
}

async function writeGrant (conversationId: string, grant: StoredGrant | null): Promise<void> {
  if (grant && grant.tokens.length > 0) memory.set(conversationId, grant);
  else memory.delete(conversationId);
  await saveStoredGrant(conversationId, grant);
}

// --- issuance ---

/**
 * Minta `count` token baru untuk satu grup. Butuh group token (era berjalan)
 * dan member token (bukti keanggotaan); tanpa keduanya tidak ada yang dikirim.
 * Hanya komitmen yang dikirim — token mentah tidak pernah meninggalkan klien.
 */
async function issueOnce (conversationId: string, count: number): Promise<number> {
  const groupToken = getMyGroupToken(conversationId);
  const memberToken = getMyDeliveryToken(conversationId);
  if (!groupToken || !memberToken) return 0;

  const batch = Math.min(Math.max(1, Math.floor(count)), MAX_BATCH);
  const tokens = Array.from({ length: batch }, () => crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const commitments = await Promise.all(tokens.map(tokenCommitment));

  const issued = await api<{ suite?: string; accepted?: number }>('/api/groups/pp/issue', {
    method: 'POST',
    body: JSON.stringify({
      groupToken,
      memberToken,
      commitments: commitments.map((commitment) => bytesToBase64Url(commitment)),
    }),
  });
  if (issued?.suite !== PP_SUITE) throw new Error('PP_SUITE_MISMATCH');
  if (issued.accepted !== batch) throw new Error('PP_ISSUE_MALFORMED');

  const existing = await readGrant(conversationId);
  const kept = freshTokens(existing);
  const encoded = tokens.map((token) => bytesToBase64Url(token));
  await writeGrant(conversationId, {
    tokens: [...kept, ...encoded],
    expiresAt: Date.now() + PP_TOKEN_TTL_MS,
  });
  return encoded.length;
}

/** Minta token baru; kegagalan tidak menyimpan token setengah jadi. */
export async function issuePrivacyPassTokens (conversationId: string, count = DEFAULT_BATCH): Promise<number> {
  return await issueOnce(conversationId, count);
}

// --- redemption ---

/**
 * Ambil satu bukti untuk sync. `undefined` = tidak ada bukti saat ini — sync
 * TETAP dijalankan (server hanya menolak bila `PP_SYNC_REQUIRED=1`).
 *
 * Issuance saat stok kosong tetap dijalankan **di latar** supaya sync tidak
 * menunggu request jaringan; hasilnya dipakai sync berikutnya (TTL 24 jam).
 * Jalur yang **butuh** bukti sekarang (server menjawab `PP_PROOF_REQUIRED`)
 * memakai `ensurePrivacyPassProof`.
 */
export async function takePrivacyPassProof (conversationId: string): Promise<string | undefined> {
  const tokens = freshTokens(await readGrant(conversationId));
  if (tokens.length > 0) return tokens[0];

  if (!issuing.has(conversationId)) {
    issuing.add(conversationId);
    void issuePrivacyPassTokens(conversationId)
      .catch((error) => console.warn('[PP] Issuance latar gagal:', error))
      .finally(() => issuing.delete(conversationId));
  }
  return undefined;
}

/**
 * Terbitkan bukti **secara sinkron** — dipakai saat server menolak sync karena
 * `PP_PROOF_REQUIRED` (mis. `PP_SYNC_REQUIRED=1` baru dinyalakan, stok kosong,
 * atau perangkat baru login). Tanpa jalur ini, menyalakan gate itu mematikan
 * discovery grup sampai issuance latar kebetulan selesai.
 */
export async function ensurePrivacyPassProof (conversationId: string): Promise<string | undefined> {
  const existing = freshTokens(await readGrant(conversationId));
  if (existing.length > 0) return existing[0];

  try {
    await issuePrivacyPassTokens(conversationId);
  } catch (error) {
    console.warn('[PP] Issuance sinkron gagal:', error);
    return undefined;
  }
  return freshTokens(await readGrant(conversationId))[0];
}

/**
 * Buang bukti yang sudah diterima server. Server menghabiskan token (single
 * use), jadi menyimpannya lagi hanya membuat percobaan berikutnya ditolak.
 */
export async function consumePrivacyPassProof (conversationId: string, proof: string | undefined): Promise<void> {
  if (!proof) return;
  const grant = await readGrant(conversationId);
  const remaining = freshTokens(grant).filter((token) => token !== proof);
  if (remaining.length === grant?.tokens.length && grant) return;
  await writeGrant(conversationId, {
    tokens: remaining,
    expiresAt: grant?.expiresAt && grant.expiresAt > Date.now()
      ? grant.expiresAt
      : Date.now() + PP_TOKEN_TTL_MS,
  });
}

/** Buang seluruh stok grup (mis. server bilang token tidak sah / era berubah). */
export async function dropPrivacyPassTokens (conversationId: string): Promise<void> {
  await writeGrant(conversationId, null);
}

/** Test-only: reset cache modul. */
export function resetPrivacyPassForTests (): void {
  memory.clear();
  issuing.clear();
}
