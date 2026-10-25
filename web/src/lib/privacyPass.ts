// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Privacy Pass di klien (RFC 9474, Blind RSA).
 *
 * Server menandatangani pesan **ter-blind**, jadi ia tidak bisa menghubungkan
 * token yang diserahkan saat redemption (tanpa akun) kembali ke issuance (yang
 * butuh bukti keanggotaan). Token dipakai sebagai bukti anti-abuse pada sync
 * anonim: satu token = satu sync.
 *
 * Batas kejujuran:
 *  - unlinkability tergantung pada OHTTP + tidak adanya log waktu; tanpa itu
 *    server bisa mengorelasikan jam issuance dan redemption;
 *  - token ini buffered di perangkat (ter-seal saat vault terbuka). Kalau vault
 *    terkunci, token hanya hidup di memori — sync tetap jalan, hanya tanpa bukti.
 *
 * Wire token: `base64url(nonce(32) || signature(256))`,
 * pesan = `SHA-384("nyx-pp-v1|" || conversationId || "|" || nonce)`.
 */

import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { api } from '@lib/api';
import { getMyDeliveryToken, getMyGroupToken } from '@lib/groupPseudonyms';
import { base64UrlToBytes, bytesToBase64Url } from './base64url';

export const PP_SUITE = 'RSABSSA-SHA384-PSS-Deterministic';
const PP_DOMAIN = 'nyx-pp-v1';
const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 256;
/** Server memakai TTL 24 jam; token lebih tua dibuang, bukan dikirim sia-sia. */
const PP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 5;
const MAX_BATCH = 10;
const KV_KEY = 'nyx_pp_tokens';

interface PpIssuer {
  keyId: string;
  publicKey: CryptoKey;
}

interface StoredGrant {
  tokens: string[];
  expiresAt: number;
}

const memory = new Map<string, StoredGrant>();
const issuing = new Set<string>();
let issuerCache: PpIssuer | null = null;

function suite () {
  return RSABSSA.SHA384.PSS.Deterministic();
}

/** Pesan yang ditandatangani issuer — harus identik dengan `ppMessage` server. */
export async function ppMessage (conversationId: string, nonce: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(`${PP_DOMAIN}|${conversationId}|`);
  const input = new Uint8Array(prefix.length + nonce.length);
  input.set(prefix, 0);
  input.set(nonce, prefix.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-384', input));
}

export async function loadPpIssuer (): Promise<PpIssuer> {
  if (issuerCache) return issuerCache;
  const issuer = await api<{ suite: string; keyId: string; publicJwk: JsonWebKey }>('/api/groups/pp/issuer');
  if (issuer?.suite !== PP_SUITE) throw new Error('PP_SUITE_MISMATCH');
  if (!issuer.publicJwk?.n || !issuer.publicJwk?.e) throw new Error('PP_ISSUER_MALFORMED');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    issuer.publicJwk,
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
  issuerCache = { keyId: issuer.keyId, publicKey };
  return issuerCache;
}

// --- penyimpanan (ter-seal bila vault terbuka) ---

async function loadStoredGrants (): Promise<Record<string, StoredGrant>> {
  try {
    const [{ db }, { decryptValueAtRest }] = await Promise.all([
      import('@lib/db'),
      import('@lib/keychainDb'),
    ]);
    const row = await db.kvStore.get(KV_KEY);
    const sealed = (row?.value as Record<string, string> | undefined) ?? {};
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
    const [{ db }, { encryptValueAtRest }] = await Promise.all([
      import('@lib/db'),
      import('@lib/keychainDb'),
    ]);
    const row = await db.kvStore.get(KV_KEY);
    const sealed = (row?.value as Record<string, string> | undefined) ?? {};
    if (grant && grant.tokens.length > 0) {
      sealed[conversationId] = await encryptValueAtRest(JSON.stringify(grant));
    } else {
      delete sealed[conversationId];
    }
    await db.kvStore.put({ key: KV_KEY, value: sealed });
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
 * Mengembalikan jumlah token yang benar-benar tersimpan.
 */
export async function issuePrivacyPassTokens (conversationId: string, count = DEFAULT_BATCH): Promise<number> {
  const groupToken = getMyGroupToken(conversationId);
  const memberToken = getMyDeliveryToken(conversationId);
  if (!groupToken || !memberToken) return 0;

  const batch = Math.min(Math.max(1, Math.floor(count)), MAX_BATCH);
  const issuer = await loadPpIssuer();
  const blindSuite = suite();

  const prepared: Array<{ nonce: Uint8Array; msg: Uint8Array; blindedMsg: Uint8Array; inv: Uint8Array }> = [];
  for (let i = 0; i < batch; i += 1) {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const msg = await ppMessage(conversationId, nonce);
    const { blindedMsg, inv } = await blindSuite.blind(issuer.publicKey, msg);
    prepared.push({ nonce, msg, blindedMsg, inv });
  }

  const issued = await api<{ signatures?: string[]; suite?: string; keyId?: string }>('/api/groups/pp/issue', {
    method: 'POST',
    body: JSON.stringify({
      groupToken,
      memberToken,
      blinded: prepared.map((entry) => bytesToBase64Url(entry.blindedMsg)),
    }),
  });
  if (issued?.suite !== PP_SUITE) throw new Error('PP_SUITE_MISMATCH');
  if (issued.keyId !== issuer.keyId) throw new Error('PP_ISSUER_KEY_CHANGED');
  const signatures = issued.signatures ?? [];
  if (signatures.length !== prepared.length) throw new Error('PP_ISSUE_MALFORMED');

  const tokens: string[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    const entry = prepared[i]!;
    const blindSignature = base64UrlToBytes(signatures[i] ?? '');
    if (blindSignature.length !== SIGNATURE_BYTES) throw new Error('PP_SIGNATURE_MALFORMED');
    // `finalize` melempar "invalid signature" bila issuer menandatangani dengan
    // kunci lain; samakan pesannya supaya operator melihat penyebab sebenarnya
    // (issuer berubah / respons dipalsukan), bukan error pustaka.
    let signature: Uint8Array;
    try {
      signature = await blindSuite.finalize(issuer.publicKey, entry.msg, blindSignature, entry.inv);
    } catch {
      throw new Error('PP_TOKEN_UNVERIFIABLE');
    }
    // Token yang tidak lolos verifikasi lokal tidak boleh disimpan — ia hanya
    // akan ditolak server dan menghabiskan jatah sync. `verify` bisa melempar
    // (representative di luar modulus) untuk signature dari kunci lain.
    let valid = false;
    try {
      valid = await blindSuite.verify(issuer.publicKey, signature, entry.msg);
    } catch {
      valid = false;
    }
    if (!valid) throw new Error('PP_TOKEN_UNVERIFIABLE');
    const token = new Uint8Array(entry.nonce.length + signature.length);
    token.set(entry.nonce, 0);
    token.set(signature, entry.nonce.length);
    tokens.push(bytesToBase64Url(token));
  }

  const existing = await readGrant(conversationId);
  const kept = freshTokens(existing);
  await writeGrant(conversationId, {
    tokens: [...kept, ...tokens],
    expiresAt: Date.now() + PP_TOKEN_TTL_MS,
  });
  return tokens.length;
}

// --- redemption ---

/**
 * Ambil satu bukti untuk sync. `undefined` = tidak ada bukti saat ini — sync
 * TETAP dijalankan (server hanya menolak bila `PP_SYNC_REQUIRED=1`).
 *
 * Issuance saat stok kosong sengaja dijalankan **di latar**: blind RSA 2048 di
 * perangkat lambat butuh detik, dan sync tidak boleh menunggu itu. Hasilnya
 * dipakai sync berikutnya (TTL 24 jam).
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
  if (!memory.has(conversationId)) return;
  await writeGrant(conversationId, null);
}

/** Test-only: reset cache modul. */
export function resetPrivacyPassForTests (): void {
  issuerCache = null;
  memory.clear();
  issuing.clear();
}
