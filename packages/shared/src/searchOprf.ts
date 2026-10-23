// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4a] OPRF untuk blind index pencarian.
 *
 * Klien membutuhkan `SHA-256(domain || OPRF(k, indentifier))` — server tidak
 * boleh belajar identifier maupun index akhir. Konstruksi memakai RFC 9497
 * `ristretto255-SHA512` dari `@noble/curves`; jangan menulis grup/oprf sendiri.
 *
 * Input identifier adalah 32 byte Argon2id(username) yang sudah dihitung klien.
 * Domain input mencegah output OPRF ini dipakai ulang untuk protokol lain.
 */

import { ristretto255_oprf } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const SEARCH_OPRF_SUITE = 'ristretto255-SHA512' as const;

const IDENTIFIER_BYTES = 32;
const OPRF_KEY_INFO = new TextEncoder().encode('nyx:search-index:key:v1');
const OPRF_INPUT_DOMAIN = new TextEncoder().encode('nyx:search-index:input:v1\0');
const OPRF_INDEX_DOMAIN = new TextEncoder().encode('nyx:search-index:index:v1\0');

export type SearchOprfServerKeys = {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
};

export type SearchOprfBlind = {
  /** Input yang sudah didomainkan; simpan di klien, jangan kirim ke server. */
  input: Uint8Array;
  /** Blind scalar rahasia klien. */
  blind: Uint8Array;
  /** Elemen ter-blind yang dikirim ke server. */
  blinded: Uint8Array;
};

function assertBytes(value: Uint8Array, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`${label} harus ${length} byte`);
  }
}

function concatBytes(prefix: Uint8Array, value: Uint8Array): Uint8Array {
  const result = new Uint8Array(prefix.length + value.length);
  result.set(prefix, 0);
  result.set(value, prefix.length);
  return result;
}

/** Kunci server deterministik dari seed 32 byte (jangan simpan seed di DB). */
export function deriveSearchOprfServerKeys(seed: Uint8Array): SearchOprfServerKeys {
  assertBytes(seed, 32, 'seed OPRF');
  const keys = ristretto255_oprf.oprf.deriveKeyPair(seed, OPRF_KEY_INFO);
  return {
    secretKey: new Uint8Array(keys.secretKey),
    publicKey: new Uint8Array(keys.publicKey),
  };
}

/** Langkah klien 1: blind Argon2id(username) 32 byte. */
export function blindSearchIdentifier(identifier: Uint8Array): SearchOprfBlind {
  assertBytes(identifier, IDENTIFIER_BYTES, 'identifier');
  const input = concatBytes(OPRF_INPUT_DOMAIN, identifier);
  const result = ristretto255_oprf.oprf.blind(input);
  return {
    input,
    blind: new Uint8Array(result.blind),
    blinded: new Uint8Array(result.blinded),
  };
}

/** Langkah server: evaluasi elemen ter-blind dengan kunci OPRF. */
export function evaluateSearchOprfBlinded(
  secretKey: Uint8Array,
  blinded: Uint8Array,
): Uint8Array {
  assertBytes(secretKey, IDENTIFIER_BYTES, 'secretKey OPRF');
  assertBytes(blinded, IDENTIFIER_BYTES, 'blinded OPRF');
  return new Uint8Array(ristretto255_oprf.oprf.blindEvaluate(secretKey, blinded));
}

/** Langkah klien 2: unblind lalu turunkan blind index 64-hex. */
export function finalizeSearchOprfIndex(
  input: Uint8Array,
  blind: Uint8Array,
  evaluated: Uint8Array,
): string {
  assertBytes(blind, IDENTIFIER_BYTES, 'blind OPRF');
  assertBytes(evaluated, IDENTIFIER_BYTES, 'evaluated OPRF');
  const output = ristretto255_oprf.oprf.finalize(input, blind, evaluated);
  return bytesToHex(sha256(concatBytes(OPRF_INDEX_DOMAIN, output)));
}
