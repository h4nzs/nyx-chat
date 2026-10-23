// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 4a] Klien OPRF untuk blind index pencarian.
 *
 * Klien hanya mengirim elemen ter-blind. Server mengembalikan evaluasi OPRF;
 * index akhir 64-hex dihitung lokal dan dipakai sebagai `q` pencarian. Tidak
 * ada fallback ke pencarian legacy saat gate aktif: kegagalan OPRF = gagal.
 */

import {
  SEARCH_OPRF_SUITE,
  blindSearchIdentifier,
  finalizeSearchOprfIndex,
} from '@nyx/shared';
import { api } from './api';

const RAW_IDENTIFIER_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function oprfSearchEnabled(): boolean {
  const value = (import.meta.env.VITE_PIR_OPRF_ENABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** 43-char base64url = Argon2id mentah dari `hashUsername`; 64-hex legacy tidak. */
export function isRawIdentifierHash(value: string): boolean {
  return RAW_IDENTIFIER_RE.test(value);
}

function decodeBase64Url(value: string, label: string): Uint8Array {
  if (!BASE64URL_RE.test(value)) throw new Error(`${label} bukan base64url`);
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hitung index OPRF 64-hex dari Argon2id 43-char; melempar bila server menolak. */
export async function oprfSearchIndex(identifierHash: string): Promise<string> {
  const identifier = decodeBase64Url(identifierHash, 'identifier');
  if (identifier.length !== 32 || encodeBase64Url(identifier) !== identifierHash) {
    throw new Error('identifier harus base64url dari 32 byte');
  }

  const { input, blind, blinded } = blindSearchIdentifier(identifier);
  const response = await api<{ suite?: unknown; evaluated?: unknown }>('/api/users/search/oprf', {
    method: 'POST',
    body: JSON.stringify({ blinded: encodeBase64Url(blinded) }),
  });

  if (response.suite !== SEARCH_OPRF_SUITE || typeof response.evaluated !== 'string') {
    throw new Error('respons OPRF tidak valid');
  }
  const evaluated = decodeBase64Url(response.evaluated, 'evaluated');
  if (evaluated.length !== 32) throw new Error('evaluated OPRF harus 32 byte');
  return finalizeSearchOprfIndex(input, blind, evaluated);
}
