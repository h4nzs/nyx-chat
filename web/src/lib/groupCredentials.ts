// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [26.8.1] Client orchestration untuk group membership credentials
 * (blind RSA / RFC 9474 — RSABSSA-SHA384-PSS-Randomized).
 *
 * Alur issuance (saat anggota bergabung / metadata v2 terbuka pertama kali):
 *   1. random message per (conversation, member): 16 byte acak + convId —
 *      TIDAK mengandung identitas.
 *   2. blind message dengan issuer public key (dari /credential-issuer-key).
 *   3. kirim blinded message → server blindSign (server tak tahu isinya).
 *   4. finalize di worker (memakai `inv` yang tak pernah meninggalkan klien).
 *   5. commit serial (SHA-384 prepared message) + conversationId ke server
 *      untuk verifikasi & revocation.
 *
 * Alur presentation (saat sync): kirim header X-Group-Credentials berisi
 * (keyVersion, convId, preparedMsg, signature) — server verifikasi tanpa
 * tahu siapa pemiliknya.
 */

import { authFetch } from '@lib/api';
import { worker_credential_blind, worker_credential_finalize } from '@lib/crypto-worker-proxy';

export interface GroupCredential {
  /** conversation id yang diklaim credential ini. */
  conversationId: string;
  /** Versi issuer key yang menandatangani. */
  keyVersion: number;
  /** Prepared message (base64url) — random, bukan identitas. */
  preparedMsgB64: string;
  /** Signature final dari issuer (base64url). */
  signatureB64: string;
}

// Cache in-memory (per sesi). Credential jarang berubah; kegagalan verifikasi
// di server cukup memicu re-issuance via ensureCredential().
const credCache = new Map<string, GroupCredential>();
let issuerKeyCache: { keyVersion: number; publicJwk: JsonWebKey } | null = null;

async function getIssuerKey(): Promise<{ keyVersion: number; publicJwk: JsonWebKey }> {
  if (issuerKeyCache) return issuerKeyCache;
  const res = await authFetch<{ suite: string; keyVersion: number; publicJwk: JsonWebKey }>(
    '/api/conversations/credential-issuer-key'
  );
  issuerKeyCache = { keyVersion: res.keyVersion, publicJwk: res.publicJwk };
  return issuerKeyCache;
}

function randomMessage(conversationId: string): string {
  // Format: nyx-grp-cred:v1:<convId>:<32-hex random>. convId ikut di-commit ke
  // server (serial↔conversation), random 128-bit membuat message tak bisa
  // di-link ke anggota; server hanya melihat bentuk blind-nya saat issuance.
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return `nyx-grp-cred:v1:${conversationId}:${hex}`;
}

/**
 * Pastikan credential untuk (conversationId) tersedia. Idempoten — cache
 * in-memory; pemanggilan berulang tidak memicu issuance baru.
 */
export async function ensureCredential(conversationId: string): Promise<GroupCredential | null> {
  const cached = credCache.get(conversationId);
  if (cached) return cached;
  try {
    const { keyVersion, publicJwk } = await getIssuerKey();
    const message = randomMessage(conversationId);
    const { preparedMsgB64, blindedMsgB64, inv } = await worker_credential_blind({ publicJwk, message });

    const issueRes = await authFetch<{ blindSig: string; keyVersion: number }>('/api/conversations/credential-issuance', {
      method: 'POST',
      body: JSON.stringify({ conversationId, blindedMsg: blindedMsgB64 }),
    });

    const { signatureB64 } = await worker_credential_finalize({
      publicJwk,
      preparedMsgB64,
      blindSigB64: issueRes.blindSig,
      inv,
    });

    const cred: GroupCredential = { conversationId, keyVersion: issueRes.keyVersion, preparedMsgB64, signatureB64 };
    credCache.set(conversationId, cred);

    // Commit serial untuk verifikasi/revocation server-side (fire-and-forget;
    // kegagalan tidak membatalkan credential — presentasi tetap bisa dicoba).
    // Serial = SHA-384 dari prepared message — SHA-384 tersedia via WebCrypto
    // (server menghitung serial dengan cara yang sama, node:crypto sha384).
    const preparedBytes = Uint8Array.from(atob(preparedMsgB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-384', preparedBytes);
    const serial = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    authFetch('/api/conversations/credential-commit', {
      method: 'POST',
      body: JSON.stringify({ conversationId, keyVersion: cred.keyVersion, serial }),
    }).catch(() => {});

    return cred;
  } catch (e) {
    console.warn('[26.8.1] Credential issuance failed (non-fatal):', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Bangun header X-Group-Credentials untuk sync. best-effort: hanya conversation
 * yang sudah punya credential; sisanya tetap didukung jalur delivery-token.
 */
export async function buildCredentialPresentationHeader(conversationIds: string[]): Promise<string | undefined> {
  const parts: string[] = [];
  for (const convId of conversationIds) {
    const cred = credCache.get(convId);
    if (!cred) continue;
    parts.push(`${cred.keyVersion}:${cred.conversationId}:${cred.preparedMsgB64}:${cred.signatureB64}`);
  }
  return parts.length > 0 ? parts.join('~') : undefined;
}

/** Simpan credential dari persist (mis. metadata v2) tanpa re-issuance. */
export function cacheCredential(cred: GroupCredential): void {
  credCache.set(cred.conversationId, cred);
}

/** Hapus cache credential (mis. keluar grup / kick). */
export function dropCredential(conversationId: string): void {
  credCache.delete(conversationId);
}
