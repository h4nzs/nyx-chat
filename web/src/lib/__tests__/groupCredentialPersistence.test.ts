// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.6 — Fase 5] Regresi credential keanggotaan grup.
 *
 * Acceptance yang dikunci di sini:
 *   - credential bertahan lintas reload (baris IndexedDB ter-seal `ENC1:`),
 *     jadi reload tidak memicu issuance ulang — pola issuance itu sendiri sinyal;
 *   - commit di-await: kegagalan commit TIDAK menghasilkan credential "sukses"
 *     (tidak di-cache, tidak dipersist);
 *   - serial divalidasi berformat hex SHA-384 sebelum dikirim;
 *   - leave/kick mencabut serial kita (header X-Group-Token) dan membuang baris.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id: string; blob: string };

const { rows, credStore, authCalls, mocks } = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  return {
    rows,
    authCalls: [] as { path: string; init?: RequestInit }[],
    mocks: { failCommit: false, failRevoke: false },
    credStore: {
      get: async (id: string) => rows.get(id),
      put: async (row: Row) => { rows.set(row.id, row); },
      delete: async (id: string) => { rows.delete(id); },
    },
  };
});

vi.mock('../db', () => ({
  db: {
    groupCredentials: credStore,
    isOpen: () => true,
    close: () => {},
  },
  VaultEntry: {},
}));

// Penyegelan at-rest disimulasikan reversibel dengan prefix yang sama (`ENC1:`)
// supaya test bisa membuktikan credential TIDAK disimpan plaintext.
vi.mock('../keychainDb', () => ({
  encryptValueAtRest: async (value: string) => `ENC1:${btoa(value)}`,
  decryptValueAtRest: async (value: string) => (value.startsWith('ENC1:') ? atob(value.slice(5)) : null),
}));

vi.mock('@lib/groupPseudonyms', () => ({
  getMyGroupToken: () => 'group-token-abc',
  getMyDeliveryToken: () => 42,
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
  worker_credential_blind: vi.fn(async (payload: { message: string }) => ({
    preparedMsgB64: btoa(payload.message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    blindedMsgB64: 'blinded-b64',
    inv: 'inv-b64',
  })),
  worker_credential_finalize: vi.fn(async () => ({ signatureB64: 'final-sig-b64' })),
}));

vi.mock('@lib/api', () => ({
  authFetch: vi.fn(async (path: string, init?: RequestInit) => {
    authCalls.push({ path, init });
    if (path === '/api/conversations/credential-issuer-key') {
      return { suite: 'RSABSSA-SHA384-PSS-Randomized', keyVersion: 1, publicJwk: {} };
    }
    if (path === '/api/conversations/credential-issuance') {
      return { blindSig: 'blind-sig-b64', keyVersion: 1 };
    }
    if (path.endsWith('/credential-commit')) {
      if (mocks.failCommit) throw new Error('commit ditolak server');
      return { ok: true };
    }
    if (path.endsWith('/credential-revoke')) {
      if (mocks.failRevoke) throw new Error('revoke ditolak server');
      return { ok: true };
    }
    throw new Error(`authFetch tak terduga: ${path}`);
  }),
}));

// jsdom tidak selalu menyediakan WebCrypto `subtle`; serial dihitung dari sini.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: { digest: async () => new Uint8Array(48).fill(7).buffer },
    configurable: true,
  });
}

const CONV = 'c0ffee00-1111-4333-8444-555555555555';

import {
  ensureCredential,
  buildCredentialPresentationHeader,
  revokeMyCredential,
  resetCredentialCachesForTests,
} from '../groupCredentials';

function commitCalls() {
  return authCalls.filter(c => c.path.endsWith('/credential-commit'));
}

beforeEach(() => {
  rows.clear();
  authCalls.length = 0;
  mocks.failCommit = false;
  mocks.failRevoke = false;
  // "Reload": cache in-memory kosong, IndexedDB tetap berisi.
  resetCredentialCachesForTests();
});

describe('groupCredentials — persistensi & commit (Fase 5)', () => {
  it('issuance sukses: credential dipersist ter-seal dan commit di-await', async () => {
    const cred = await ensureCredential(CONV);

    expect(cred).not.toBeNull();
    expect(cred!.conversationId).toBe(CONV);
    expect(commitCalls()).toHaveLength(1);

    const row = rows.get(CONV);
    expect(row).toBeDefined();
    expect(row!.blob.startsWith('ENC1:')).toBe(true);
    expect(row!.blob).not.toContain(CONV);

    // Serial terkirim berformat hex SHA-384 (96 karakter).
    const body = JSON.parse(String(commitCalls()[0]!.init?.body)) as { serial: string };
    expect(body.serial).toMatch(/^[0-9a-f]{96}$/);
  });

  it('commit gagal: tidak ada credential "sukses" dan tidak ada baris tersimpan', async () => {
    mocks.failCommit = true;
    const cred = await ensureCredential(CONV);

    expect(cred).toBeNull();
    expect(rows.has(CONV)).toBe(false);
  });

  it('reload memuat credential dari IndexedDB tanpa issuance ulang', async () => {
    const issued = await ensureCredential(CONV);
    expect(issued).not.toBeNull();
    expect(authCalls.filter(c => c.path.endsWith('/credential-issuance'))).toHaveLength(1);

    resetCredentialCachesForTests(); // reload
    const loaded = await ensureCredential(CONV);

    expect(loaded).toEqual(issued);
    expect(authCalls.filter(c => c.path.endsWith('/credential-issuance'))).toHaveLength(1);
    expect(commitCalls()).toHaveLength(1);
  });

  it('presentasi memakai credential tersimpan setelah reload', async () => {
    await ensureCredential(CONV);

    resetCredentialCachesForTests(); // reload
    const header = await buildCredentialPresentationHeader([CONV, 'no-credential-conv']);
    expect(header).toBeDefined();
    expect(header!).toContain(`1:${CONV}:`);
    expect(header!.split('~')).toHaveLength(1);
  });

  it('leave mencabut serial kita lalu membuang baris', async () => {
    await ensureCredential(CONV);

    await revokeMyCredential(CONV, 'group-token-abc');

    const revoke = authCalls.find(c => c.path.endsWith('/credential-revoke'));
    expect(revoke).toBeDefined();
    expect(revoke!.path).toContain(CONV);
    const revokeHeaders = (revoke!.init?.headers ?? {}) as Record<string, string>;
    expect(revokeHeaders['X-Group-Token']).toBe('group-token-abc');
    const body = JSON.parse(String(revoke!.init?.body)) as { serials: string[] };
    expect(body.serials).toHaveLength(1);
    expect(body.serials[0]).toMatch(/^[0-9a-f]{96}$/);

    expect(rows.has(CONV)).toBe(false);
  });

  it('revoke gagal tetap membuang credential lokal (kita kehilangan akses)', async () => {
    mocks.failRevoke = true;
    await ensureCredential(CONV);

    await revokeMyCredential(CONV, 'group-token-abc');

    expect(rows.has(CONV)).toBe(false);
  });
});
