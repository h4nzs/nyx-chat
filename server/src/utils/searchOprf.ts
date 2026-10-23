// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4a] Kunci OPRF server untuk blind index pencarian.
 *
 * Default seed = HMAC(at-rest pepper, info). `NYX_OPRF_SEED` (base64url 32
 * byte) hanya untuk memisahkan kunci bila operator ingin rotasi terpisah.
 * Seed tidak pernah masuk DB; dump DB saja tidak cukup untuk mengevaluasi
 * tebakan identifier.
 */

import { createHmac } from 'node:crypto';
import {
  blindSearchIdentifier,
  deriveSearchOprfServerKeys,
  evaluateSearchOprfBlinded,
  finalizeSearchOprfIndex,
  type SearchOprfServerKeys,
} from '@nyx/shared';
import { getAtRestPepper } from './atRestSecrets.js';

const SEED_INFO = 'NYX_OPRF_SEED_V1';
const SEED_BYTES = 32;

let cached: { source: string; keys: SearchOprfServerKeys } | null = null;

export function isSearchOprfEnabled(): boolean {
  const value = (process.env.PIR_OPRF_ENABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function deriveSeed(): { source: string; seed: Uint8Array } {
  const explicit = (process.env.NYX_OPRF_SEED || '').trim();
  if (explicit) {
    const seed = Buffer.from(explicit, 'base64url');
    if (seed.length !== SEED_BYTES || seed.toString('base64url') !== explicit) {
      throw new Error('NYX_OPRF_SEED harus base64url dari tepat 32 byte');
    }
    return { source: `explicit:${explicit}`, seed: new Uint8Array(seed) };
  }

  const pepper = getAtRestPepper();
  const seed = createHmac('sha256', pepper).update(SEED_INFO).digest();
  return { source: `pepper:${pepper}`, seed: new Uint8Array(seed) };
}

export function getSearchOprfServerKeys(): SearchOprfServerKeys {
  const { source, seed } = deriveSeed();
  if (cached?.source === source) return cached.keys;
  const keys = deriveSearchOprfServerKeys(seed);
  cached = { source, keys };
  return keys;
}

export function evaluateSearchOprf(blinded: Uint8Array): Uint8Array {
  return evaluateSearchOprfBlinded(getSearchOprfServerKeys().secretKey, blinded);
}

/**
 * Hitung index yang sama dengan jalur klien (blind -> evaluate -> finalize)
 * langsung dari Argon2id 32 byte. Dipakai register/login untuk mengisi
 * `User.oprfIndex` tanpa perlu round-trip jaringan tambahan.
 */
export function searchOprfIndexForIdentifier(identifierB64: string): string | null {
  if (!isSearchOprfEnabled()) return null;
  const raw = Buffer.from(identifierB64, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== identifierB64) return null;
  const { input, blind, blinded } = blindSearchIdentifier(new Uint8Array(raw));
  const evaluated = evaluateSearchOprf(blinded);
  return finalizeSearchOprfIndex(input, blind, evaluated);
}
