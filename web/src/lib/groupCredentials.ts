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
 *   3. kirim blinded message + BUKTI KEANGGOTAAN (X-Group-Token authSecret atau
 *      delivery token) → server blindSign (server tak tahu isinya).
 *   4. finalize di worker (memakai `inv` yang tak pernah meninggalkan klien).
 *   5. commit serial (SHA-384 prepared message) + conversationId ke server
 *      untuk verifikasi & revocation (dibatasi tiket issuance, docs/29 §7.1).
 *
 * [docs/29 §7.1] Server menolak issuance tanpa bukti keanggotaan dan memeriksa
 * bahwa pesan yang ditandatangani memang menyebut conversationId-nya (binding
 * konteks, lihat @nyx/shared/credentials). Format pesan TIDAK berubah — sudah
 * menyebut convId sejak awal — yang berubah hanya penegakannya.
 *
 * Alur presentation (saat sync): kirim header X-Group-Credentials berisi
 * (keyVersion, convId, preparedMsg, signature) — server verifikasi tanpa
 * tahu siapa pemiliknya.
 */

import { authFetch } from '@lib/api';
import { db } from '@lib/db';
import { decryptValueAtRest, encryptValueAtRest } from '@lib/keychainDb';
import { worker_credential_blind, worker_credential_finalize } from '@lib/crypto-worker-proxy';
import { getMyDeliveryToken, getMyGroupToken } from '@lib/groupPseudonyms';
import {
  anonymousCredentialsEnabled,
  buyCredentialToken,
  commitAnonymousCredential,
  redeemAnonymousIssuance,
} from '@lib/credentialTokens';
import {
  buildCredentialMessage,
  CREDENTIAL_RANDOM_HEX_LENGTH,
  requireCredentialSuite,
} from '@nyx/shared';

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
let issuerKeyCache: { keyVersion: number; publicJwk: JsonWebKey; suite: string } | null = null;

/** Serial = SHA-384 (hex huruf kecil) dari prepared message — 96 karakter. */
const CREDENTIAL_SERIAL_HEX = /^[0-9a-f]{96}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * [docs/35 §35.6.6 — Fase 5] Validasi bentuk credential sebelum disimpan/dipakai.
 * Baris persist yang rusak (atau ditulis versi lain) harus membuat klien
 * meminta credential baru, bukan mengirim presentasi yang pasti ditolak.
 */
function isGroupCredential(value: unknown): value is GroupCredential {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<GroupCredential>;
  return (
    typeof c.conversationId === 'string' && c.conversationId.length > 0 &&
    typeof c.keyVersion === 'number' && Number.isInteger(c.keyVersion) && c.keyVersion > 0 &&
    typeof c.preparedMsgB64 === 'string' && BASE64URL.test(c.preparedMsgB64) &&
    typeof c.signatureB64 === 'string' && BASE64URL.test(c.signatureB64)
  );
}

/** Tulis credential ter-seal `ENC1:` ke IndexedDB (satu baris per percakapan). */
async function persistCredential(cred: GroupCredential): Promise<void> {
  try {
    const blob = await encryptValueAtRest(JSON.stringify(cred));
    await db.groupCredentials.put({ id: cred.conversationId, blob });
  } catch (e) {
    console.warn('[26.8.1] Gagal menyimpan credential:', e instanceof Error ? e.message : e);
  }
}

/** Muat credential tersimpan. Baris rusak/absen → `null`. */
async function loadPersistedCredential(conversationId: string): Promise<GroupCredential | null> {
  try {
    const row = await db.groupCredentials.get(conversationId);
    if (!row) return null;
    const plain = await decryptValueAtRest(row.blob);
    if (!plain) return null;
    const parsed: unknown = JSON.parse(plain);
    if (!isGroupCredential(parsed) || parsed.conversationId !== conversationId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Hitung serial commit (hex) dari prepared message. */
async function computeSerial(preparedMsgB64: string): Promise<string> {
  const preparedBytes = Uint8Array.from(atob(preparedMsgB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-384', preparedBytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getIssuerKey(): Promise<{ keyVersion: number; publicJwk: JsonWebKey; suite: string }> {
  if (issuerKeyCache) return issuerKeyCache;
  const res = await authFetch<{ suite: string; keyVersion: number; publicJwk: JsonWebKey }>(
    '/api/conversations/credential-issuer-key'
  );
  // [docs/35 §35.6.6 — Fase 5] Fail-closed: suite yang tidak didukung menggagalkan
  // issuance, bukan diam-diam memakai parameter v1 untuk suite asing.
  const suite = requireCredentialSuite(res.suite).id;
  issuerKeyCache = { keyVersion: res.keyVersion, publicJwk: res.publicJwk, suite };
  return issuerKeyCache;
}

function randomMessage(conversationId: string): string {
  // Format dibagi dengan server lewat @nyx/shared (docs/29 §7.1):
  // `nyx-grp-cred:v1:<convId>:<32-hex random>`. convId ikut di-commit ke server
  // (serial↔conversation) DAN ikut ditandatangani issuer, sehingga server bisa
  // memverifikasi binding konteks saat presentasi; random 128-bit membuat
  // message tak bisa di-link ke anggota (server hanya melihat bentuk blind-nya).
  const arr = new Uint8Array(CREDENTIAL_RANDOM_HEX_LENGTH / 2);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return buildCredentialMessage(conversationId, hex);
}

/**
 * [docs/29 §7.1] Bukti keanggotaan untuk issuance/commit credential.
 *
 * Server menolak issuance tanpa bukti (dulu endpoint menandatangani blinded
 * message apa pun untuk user terautentikasi mana pun). Dua bentuk bukti yang
 * bisa dikirim klien, keduanya sudah dimiliki anggota sah:
 *   - `X-Group-Token` = authSecret grup dari encrypted metadata (blind member
 *     auth, pola yang sama dengan mutasi grup lain),
 *   - `X-Delivery-Tokens` = token undangan milik saya untuk percakapan ini.
 * Bila keduanya belum tersedia (metadata belum ter-dekripsi) header tidak
 * dikirim dan issuance ditunda — sync tetap jalan lewat jalur id lokal.
 */
function buildIssuanceHeaders(conversationId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const groupToken = getMyGroupToken(conversationId);
    if (groupToken) headers['X-Group-Token'] = groupToken;
    const deliveryToken = getMyDeliveryToken(conversationId);
    if (deliveryToken) headers['X-Delivery-Tokens'] = String(deliveryToken);
  } catch {
    // Store belum siap → kirim tanpa header; server akan menolak dan
    // ensureCredential() dipanggil lagi pada sync berikutnya.
  }
  return headers;
}

/**
 * Pastikan credential untuk (conversationId) tersedia. Idempoten — cache
 * in-memory, lalu baris IndexedDB (bertahan lintas reload); pemanggilan
 * berulang tidak memicu issuance baru.
 */
export async function ensureCredential(conversationId: string): Promise<GroupCredential | null> {
  const cached = credCache.get(conversationId);
  if (cached) return cached;

  // [docs/35 §35.6.6 — Fase 5] Muat dari persist dulu: reload tidak boleh
  // memicu issuance ulang (pola issuance itu sendiri adalah sinyal).
  const persisted = await loadPersistedCredential(conversationId);
  if (persisted) {
    credCache.set(conversationId, persisted);
    return persisted;
  }

  try {
    const { publicJwk, suite } = await getIssuerKey();
    const message = randomMessage(conversationId);
    const { preparedMsgB64, blindedMsgB64, inv } = await worker_credential_blind({ publicJwk, message, suite });

    // [docs/35 Fase 6] Jalur anonim (gate `VITE_ANON_CREDENTIALS=1`): hanya
    // authSecret grup yang dikirim — delivery token sengaja tidak dipakai karena
    // pseudonimnya stabil per anggota. Tanpa gate/group token → jalur lama.
    const groupToken = getMyGroupToken(conversationId);
    let issueRes: { blindSig: string; keyVersion: number };
    let commitTicket: string | null = null;
    if (anonymousCredentialsEnabled() && groupToken) {
      const token = await buyCredentialToken();
      const anon = await redeemAnonymousIssuance(token, conversationId, blindedMsgB64, groupToken);
      issueRes = anon;
      commitTicket = anon.commitTicket;
    } else {
      const proofHeaders = buildIssuanceHeaders(conversationId);
      issueRes = await authFetch<{ blindSig: string; keyVersion: number }>('/api/conversations/credential-issuance', {
        method: 'POST',
        headers: Object.keys(proofHeaders).length > 0 ? proofHeaders : undefined,
        body: JSON.stringify({ conversationId, blindedMsg: blindedMsgB64 }),
      });
    }

    const { signatureB64 } = await worker_credential_finalize({
      publicJwk,
      preparedMsgB64,
      blindSigB64: issueRes.blindSig,
      inv,
      suite,
    });

    const cred: GroupCredential = { conversationId, keyVersion: issueRes.keyVersion, preparedMsgB64, signatureB64 };

    // Commit serial untuk verifikasi/revocation server-side. [docs/35 §35.6.6 —
    // Fase 5] DUA perubahan dari perilaku lama: serial divalidasi bentuknya
    // (hex SHA-384) dan commit DI-AWAIT — credential tidak dianggap berhasil
    // bila commit gagal, supaya server tidak pernah melihat presentasi yang
    // tidak pernah ia catat (acceptance: "commit failure tidak menghasilkan
    // credential sukses").
    const serial = await computeSerial(preparedMsgB64);
    if (!CREDENTIAL_SERIAL_HEX.test(serial)) {
      throw new Error('serial credential tidak berformat hex SHA-384');
    }
    if (commitTicket) {
      // Ticket single-use: sudah terikat conversation di server.
      await commitAnonymousCredential(commitTicket, conversationId, cred.keyVersion, serial);
    } else {
      const commitHeaders = buildIssuanceHeaders(conversationId);
      await authFetch('/api/conversations/credential-commit', {
        method: 'POST',
        headers: Object.keys(commitHeaders).length > 0 ? commitHeaders : undefined,
        body: JSON.stringify({ conversationId, keyVersion: cred.keyVersion, serial }),
      });
    }

    await persistCredential(cred);
    credCache.set(conversationId, cred);
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
    // [docs/35 §35.6.6 — Fase 5] Fallback ke baris tersimpan: sync sering jalan
    // sebelum ensureCredential(), dan setelah reload cache in-memory kosong.
    let cred = credCache.get(convId);
    if (!cred) {
      const persisted = await loadPersistedCredential(convId);
      if (persisted) {
        credCache.set(convId, persisted);
        cred = persisted;
      }
    }
    if (!cred) continue;
    parts.push(`${cred.keyVersion}:${cred.conversationId}:${cred.preparedMsgB64}:${cred.signatureB64}`);
  }
  return parts.length > 0 ? parts.join('~') : undefined;
}

/** Simpan credential dari persist (mis. metadata v2) tanpa re-issuance. */
export function cacheCredential(cred: GroupCredential): void {
  if (!isGroupCredential(cred)) {
    console.warn('[26.8.1] Credential dari persist tidak valid — diabaikan');
    return;
  }
  credCache.set(cred.conversationId, cred);
  // Bertahan lintas reload (best-effort; cache in-memory tetap terpakai).
  void persistCredential(cred);
}

/** Reset cache in-memory (dipakai test; meniru kondisi setelah reload). */
export function resetCredentialCachesForTests(): void {
  credCache.clear();
  issuerKeyCache = null;
}

/** Hapus credential (mis. keluar grup / kick) dari cache DAN IndexedDB. */
export function dropCredential(conversationId: string): void {
  credCache.delete(conversationId);
  void db.groupCredentials.delete(conversationId).catch(() => {
    // Baris ikut terhapus bersama IndexedDB saat wipe.
  });
}

/**
 * [docs/35 §35.6.6 — Fase 5] Revoke credential MILIK SENDIRI saat keluar grup.
 *
 * Serial credential bersifat anonim (terikat percakapan, bukan identitas), jadi
 * satu-satunya pihak yang tahu serial kita adalah kita sendiri — revocation
 * anggota yang di-kick butuh serial itu dari sisi anggota (belum ada jalur
 * distribusi serial antar-anggota). Yang bisa dilakukan sekarang dengan benar:
 * saat kita keluar (atau grup di-purge), beri tahu server agar serial kita
 * dicabut, lalu buang credential lokal — supaya credential lama tidak bisa
 * dipakai lagi setelah kita meninggalkan grup.
 *
 * Best-effort: kegagalan revoke tidak menggagalkan leave; credential lokal tetap
 * dibuang karena kita memang kehilangan hak akses.
 */
export async function revokeMyCredential(conversationId: string, groupToken?: string): Promise<void> {
  try {
    let cred = credCache.get(conversationId);
    if (!cred) cred = (await loadPersistedCredential(conversationId)) ?? undefined;
    if (cred) {
      const serial = await computeSerial(cred.preparedMsgB64);
      if (CREDENTIAL_SERIAL_HEX.test(serial)) {
        await authFetch(`/api/conversations/${conversationId}/credential-revoke`, {
          method: 'POST',
          headers: groupToken ? { 'X-Group-Token': groupToken } : undefined,
          body: JSON.stringify({ serials: [serial] }),
        });
      }
    }
  } catch (e) {
    console.warn('[26.8.1] Credential revoke gagal (non-fatal):', e instanceof Error ? e.message : e);
  } finally {
    dropCredential(conversationId);
  }
}
