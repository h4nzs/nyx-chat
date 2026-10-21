// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.7 — Fase 6] Klien untuk issuance credential anonim.
 *
 * Gate `VITE_ANON_CREDENTIALS=1` (default mati). Saat hidup:
 *   1. `POST /api/credentials/tokens` (sesi + CSRF) membeli satu token;
 *   2. `POST /api/credentials/issuance` (tanpa cookie, hanya X-Group-Token)
 *      menukar token dengan blind signature + commitTicket;
 *   3. `POST /api/credentials/commit` menukar ticket dengan baris serial.
 *
 * **Tidak ada fallback diam-diam** ke jalur lama: kalau gate hidup dan bank
 * token gagal, issuance gagal (credential null) — penurunan privasi tidak boleh
 * terjadi tanpa terlihat. Token tidak dipersist; batch kecil dibeli saat butuh.
 */

const ANON_CREDENTIALS_ENABLED = import.meta.env.VITE_ANON_CREDENTIALS === '1';

export function anonymousCredentialsEnabled(): boolean {
  return ANON_CREDENTIALS_ENABLED;
}

export interface AnonymousIssuance {
  blindSig: string;
  keyVersion: number;
  commitTicket: string;
}

async function postAnonymous<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    // Tanpa cookie/sesi: ini inti dari "anonim". CSRF tidak relevan (tidak ada
    // sesi yang bisa dipalsukan); token bearer ada di body.
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anonymous credential ${path}: ${res.status} ${detail.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

/** Beli satu token single-use (terautentikasi; kuota harian per user). */
export async function buyCredentialToken(): Promise<string> {
  const { authFetch } = await import('./api');
  const res = await authFetch<{ tokens: string[] }>('/api/credentials/tokens', {
    method: 'POST',
    body: JSON.stringify({ count: 1 }),
  });
  const token = res.tokens?.[0];
  if (!token) throw new Error('credential token bank: respons kosong');
  return token;
}

/** Tukar token dengan blind signature; tanpa identitas pemanggil. */
export async function redeemAnonymousIssuance(
  token: string,
  conversationId: string,
  blindedMsg: string,
  groupToken: string,
): Promise<AnonymousIssuance> {
  return postAnonymous<AnonymousIssuance>(
    '/api/credentials/issuance',
    { token, conversationId, blindedMsg },
    { 'X-Group-Token': groupToken },
  );
}

/** Tukar commitTicket dengan baris serial (single-use, terikat conversation). */
export async function commitAnonymousCredential(
  commitTicket: string,
  conversationId: string,
  keyVersion: number,
  serial: string,
): Promise<void> {
  await postAnonymous<{ ok: true }>('/api/credentials/commit', {
    commitTicket,
    conversationId,
    keyVersion,
    serial,
  });
}
