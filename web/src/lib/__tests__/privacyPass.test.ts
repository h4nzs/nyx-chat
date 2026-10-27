// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Privacy Pass sisi klien.
 *
 * Issuer di test memakai kunci RSA asli (bukan stub): blind → sign → finalize →
 * verifikasi dijalankan utuh, jadi yang diuji adalah flow RFC 9474 yang sama
 * dengan server, bukan sekadar pemanggilan API.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '@lib/base64url';

const apiMock = vi.fn<(path: string, options?: { method?: string; body?: string }) => Promise<unknown>>();

vi.mock('@lib/api', () => ({
  api: (...args: [string, { method?: string; body?: string }?]) => apiMock(...args),
}));

const groupTokens = { group: 'GROUP_TOKEN' as string | undefined, member: 'MEMBER_TOKEN' as string | undefined };

vi.mock('@lib/groupPseudonyms', () => ({
  getMyGroupToken: () => groupTokens.group,
  getMyDeliveryToken: () => groupTokens.member,
}));

const kv = new Map<string, unknown>();

vi.mock('@lib/db', () => ({
  db: {
    kvStore: {
      get: async (key: string) => (kv.has(key) ? { key, value: kv.get(key) } : undefined),
      put: async (row: { key: string; value: unknown }) => {
        kv.set(row.key, row.value);
      },
    },
  },
}));

vi.mock('@lib/keychainDb', () => ({
  encryptValueAtRest: async (value: string) => `ENC1:${value}`,
  decryptValueAtRest: async (value: string) => (value.startsWith('ENC1:') ? value.slice(5) : null),
}));

const {
  PP_SUITE,
  consumePrivacyPassProof,
  dropPrivacyPassTokens,
  ensurePrivacyPassProof,
  issuePrivacyPassTokens,
  loadPpIssuer,
  ppMessage,
  resetPrivacyPassForTests,
  takePrivacyPassProof,
} = await import('@lib/privacyPass');

const suite = RSABSSA.SHA384.PSS.Deterministic();
const keyPair = await RSABSSA.SHA384.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;

const base64url = (value: Uint8Array) => bytesToBase64Url(value);
const bytes = (value: string) => base64UrlToBytes(value);

/** Issuer palsu: perilaku server `pp/issue` (blindSign per pesan). */
async function issueRoute (body: { blinded?: string[] }) {
  const signatures = [];
  for (const blinded of body.blinded ?? []) {
    signatures.push(base64url(await suite.blindSign(keyPair.privateKey, bytes(blinded))));
  }
  return { signatures, suite: PP_SUITE, keyId: 'test-key' };
}

function installIssuer (overrides: { suite?: string; keyId?: string } = {}) {
  apiMock.mockImplementation(async (path: string, options?: { body?: string }) => {
    if (path === '/api/groups/pp/issuer') {
      return {
        suite: overrides.suite ?? PP_SUITE,
        keyId: overrides.keyId ?? 'test-key',
        publicJwk,
      };
    }
    if (path === '/api/groups/pp/issue') {
      return issueRoute(JSON.parse(options?.body ?? '{}') as { blinded?: string[] });
    }
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  apiMock.mockReset();
  kv.clear();
  groupTokens.group = 'GROUP_TOKEN';
  groupTokens.member = 'MEMBER_TOKEN';
  resetPrivacyPassForTests();
  installIssuer();
});

describe('issuance', () => {
  it('menghasilkan token yang lolos verifikasi issuer untuk percakapan ini', async () => {
    expect(await issuePrivacyPassTokens('conv-1', 3)).toBe(3);

    const stored = kv.get('nyx_pp_tokens') as Record<string, string>;
    const plain = JSON.parse(String(stored['conv-1']).slice(5)) as { tokens: string[]; expiresAt: number };
    expect(plain.tokens).toHaveLength(3);
    expect(plain.expiresAt).toBeGreaterThan(Date.now());

    const issuer = await loadPpIssuer();
    for (const token of plain.tokens) {
      const raw = bytes(token);
      expect(raw.length).toBe(32 + 256);
      const nonce = raw.subarray(0, 32);
      const signature = raw.subarray(32);
      const message = await ppMessage('conv-1', nonce);
      expect(await suite.verify(issuer.publicKey, signature, message)).toBe(true);
    }
  });

  it('tidak mengirim apa pun tanpa group token atau member token', async () => {
    groupTokens.group = undefined;
    expect(await issuePrivacyPassTokens('conv-1')).toBe(0);
    groupTokens.group = 'GROUP_TOKEN';
    groupTokens.member = undefined;
    expect(await issuePrivacyPassTokens('conv-1')).toBe(0);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('menolak issuer dengan suite lain (fail-closed, tanpa token)', async () => {
    installIssuer({ suite: 'RSABSSA-SHA384-PSS-Randomized' });
    await expect(issuePrivacyPassTokens('conv-1', 1)).rejects.toThrow('PP_SUITE_MISMATCH');
    expect(kv.has('nyx_pp_tokens')).toBe(false);
  });

  it('token yang tidak bisa diverifikasi tidak disimpan', async () => {
    apiMock.mockImplementation(async (path: string, options?: { body?: string }) => {
      if (path === '/api/groups/pp/issuer') return { suite: PP_SUITE, keyId: 'test-key', publicJwk };
      if (path === '/api/groups/pp/issue') {
        const body = JSON.parse(options?.body ?? '{}') as { blinded?: string[] };
        // Signature dari kunci lain: klien harus menolaknya sebelum menyimpan.
        const other = await RSABSSA.SHA384.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
        return {
          signatures: await Promise.all((body.blinded ?? []).map(async (blinded) => base64url(await suite.blindSign(other.privateKey, bytes(blinded))))),
          suite: PP_SUITE,
          keyId: 'test-key',
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(issuePrivacyPassTokens('conv-1', 1)).rejects.toThrow('PP_TOKEN_UNVERIFIABLE');
    expect(kv.has('nyx_pp_tokens')).toBe(false);
  });
  // Blind RSA 2048 di JS butuh detik per token; batas 5 detik default terlalu
  // ketat saat seluruh suite berjalan paralel.
}, 40_000);

describe('redemption', () => {
  it('mengambil satu bukti, dan membuangnya setelah diterima server', async () => {
    await issuePrivacyPassTokens('conv-1', 2);

    const first = await takePrivacyPassProof('conv-1');
    expect(first).toBeTypeOf('string');
    await consumePrivacyPassProof('conv-1', first);

    const second = await takePrivacyPassProof('conv-1');
    expect(second).toBeTypeOf('string');
    expect(second).not.toBe(first);
  });

  it('stok kosong: sync tidak menunggu, issuance jalan di latar', async () => {
    expect(await takePrivacyPassProof('conv-1')).toBeUndefined();

    // Issuance latar selesai → bukti tersedia untuk sync berikutnya.
    await vi.waitFor(async () => {
      expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
        '/api/groups/pp/issuer',
        '/api/groups/pp/issue',
      ]);
      expect(await takePrivacyPassProof('conv-1')).toBeTypeOf('string');
    }, { timeout: 30_000, interval: 250 });
  }, 40_000);

  it('drop menghapus seluruh stok grup', async () => {
    await issuePrivacyPassTokens('conv-1', 2);
    await dropPrivacyPassTokens('conv-1');
    expect((kv.get('nyx_pp_tokens') as Record<string, string> | undefined)?.['conv-1']).toBeUndefined();
  });

  it('issuance yang gagal tidak melempar ke pemanggil sync', async () => {
    apiMock.mockRejectedValue(new Error('network'));
    expect(await takePrivacyPassProof('conv-1')).toBeUndefined();
  });

  it('ensurePrivacyPassProof menerbitkan secara sinkron saat stok kosong', async () => {
    // [PP hidup] Dipakai jalur retry setelah 403 PP_PROOF_REQUIRED.
    const proof = await ensurePrivacyPassProof('conv-1');
    expect(proof).toBeTypeOf('string');

    // Panggilan berikutnya memakai stok yang sudah ada (tidak menagih issuer lagi).
    const callsAfterIssue = apiMock.mock.calls.length;
    const again = await ensurePrivacyPassProof('conv-1');
    expect(again).toBe(proof);
    expect(apiMock.mock.calls.length).toBe(callsAfterIssue);
  });

  it('issuer yang dirotasi: cache dimuat ulang sekali, bukan gagal permanen', async () => {
    // Skenario operator: `PP_ISSUER_PRIVATE_JWK` diganti, klien masih memegang
    // kunci lama di cache. Tanpa penanganan ini setiap issuance gagal
    // PP_ISSUER_KEY_CHANGED sampai halaman di-reload.
    const rotated = await RSABSSA.SHA384.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
    const rotatedJwk = (await crypto.subtle.exportKey('jwk', rotated.publicKey)) as JsonWebKey;
    let issuerReads = 0;

    apiMock.mockImplementation(async (path: string, options?: { body?: string }) => {
      if (path === '/api/groups/pp/issuer') {
        issuerReads += 1;
        return issuerReads === 1
          ? { suite: PP_SUITE, keyId: 'old-key', publicJwk }
          : { suite: PP_SUITE, keyId: 'rotated-key', publicJwk: rotatedJwk };
      }
      if (path === '/api/groups/pp/issue') {
        const body = JSON.parse(options?.body ?? '{}') as { blinded?: string[] };
        const signatures = await Promise.all(
          (body.blinded ?? []).map(async (blinded) => base64url(await suite.blindSign(rotated.privateKey, bytes(blinded)))),
        );
        // Server menandatangani dengan kunci baru → keyId berbeda dari cache.
        return { signatures, suite: PP_SUITE, keyId: 'rotated-key' };
      }
      throw new Error(`unexpected path ${path}`);
    });

    expect(await issuePrivacyPassTokens('conv-1', 1)).toBe(1);

    const stored = kv.get('nyx_pp_tokens') as Record<string, string>;
    const plain = JSON.parse(String(stored['conv-1']).slice(5)) as { tokens: string[] };
    const raw = bytes(plain.tokens[0]!);
    expect(await suite.verify(rotated.publicKey, raw.subarray(32), await ppMessage('conv-1', raw.subarray(0, 32)))).toBe(true);
    expect(issuerReads).toBe(2);
  });
}, 40_000);
