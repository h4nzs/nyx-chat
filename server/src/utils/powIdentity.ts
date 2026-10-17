// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Identitas rate-state PoW (VIP gate).
 *
 * Prioritas: userId → installation ID → fingerprint → IP.
 * userId wajib di depan: route PoW adalah requireAuth sehingga selalu
 * tersedia dan tidak bisa dipalsukan. Sebelumnya instId (header klien
 * `x-nyx-installation-id`) diprioritaskan — attacker bisa merotasinya
 * per-request agar counter selalu == 1 dan difficulty terkunci di minimum.
 */

import { pepperedIdentifier } from './atRestSecrets.js';

export interface PowIdentityInput {
  userId?: string;
  instId?: string | string[];
  fingerprint?: string | string[];
  ip?: string | null;
}

export interface PowIdentity {
  primaryId: string;
  prefix: 'pow:user' | 'pow:inst' | 'pow:fp' | 'pow:ip';
}

/**
 * [docs/30 §30.12 WS-H] Key counter redis untuk identitas PoW.
 *
 * Sebelumnya key-nya `blake2b(primaryId)` **tanpa kunci**, dipotong 16 hex.
 * Untuk identitas berentropi rendah itu bukan perlindungan: ruang IPv4 hanya
 * 2^32, jadi siapa pun yang memegang snapshot Redis bisa mengenumerasi seluruh
 * ruang alamat dan mencocokkan hash-nya — tepat kelas kesalahan yang sudah
 * dihindari di blind index lain (`utils/atRestSecrets.ts`: "hash TANPA kunci =
 * bisa dienumerasi"). Kini HMAC pepper dengan domain terpisah, jadi key tetap
 * deterministik (counter idempoten) tetapi tidak bisa dibalik tanpa pepper.
 */
export function powRateKey(identity: Pick<PowIdentity, 'prefix' | 'primaryId'>): string {
  return pepperedIdentifier(`${identity.prefix}:${identity.primaryId}`);
}

const firstValue = (v?: string | string[] | null): string | undefined => {
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === 'string' && x.length > 0);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

export const resolvePowIdentity = ({ userId, instId, fingerprint, ip }: PowIdentityInput): PowIdentity | null => {
  const uid = firstValue(userId);
  if (uid) return { primaryId: uid, prefix: 'pow:user' };

  const iid = firstValue(instId);
  if (iid) return { primaryId: iid, prefix: 'pow:inst' };

  const fp = firstValue(fingerprint);
  if (fp) return { primaryId: fp, prefix: 'pow:fp' };

  const ipAddr = firstValue(ip);
  if (ipAddr) return { primaryId: ipAddr, prefix: 'pow:ip' };

  return null;
};
