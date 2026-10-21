// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 6] Klien redeem anonim: tanpa cookie, hanya X-Group-Token,
 * dan tidak ada fallback diam-diam saat server menolak.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../api', () => ({ authFetch: mocks.authFetch }));

import {
  anonymousCredentialsEnabled,
  buyCredentialToken,
  commitAnonymousCredential,
  redeemAnonymousIssuance,
} from '../credentialTokens';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('credentialTokens (klien)', () => {
  beforeEach(() => {
    mocks.authFetch.mockReset();
    fetchMock.mockReset();
  });

  it('gate default mati (tidak mengubah perilaku tanpa opt-in)', () => {
    expect(typeof anonymousCredentialsEnabled()).toBe('boolean');
  });

  it('redeem: POST tanpa cookie + X-Group-Token, body hanya token/conv/blinded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ blindSig: 'sig', keyVersion: 1, commitTicket: 'cct1_x' }));

    const res = await redeemAnonymousIssuance('nct1_t', 'conv-1', 'blinded-1', 'group-secret');

    expect(res).toEqual({ blindSig: 'sig', keyVersion: 1, commitTicket: 'cct1_x' });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/credentials/issuance');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['X-Group-Token']).toBe('group-secret');
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'nct1_t',
      conversationId: 'conv-1',
      blindedMsg: 'blinded-1',
    });
  });

  it('commit: menukar ticket single-use dengan serial', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, true, 201));

    await commitAnonymousCredential('cct1_t', 'conv-1', 1, 'a'.repeat(96));

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/credentials/commit');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({
      commitTicket: 'cct1_t',
      conversationId: 'conv-1',
      keyVersion: 1,
      serial: 'a'.repeat(96),
    });
  });

  it('server menolak → throw (tidak ada fallback diam-diam)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'CREDENTIAL_TOKEN_INVALID' }, false, 403));

    await expect(
      redeemAnonymousIssuance('nct1_t', 'conv-1', 'blinded-1', 'group-secret'),
    ).rejects.toThrow(/403/);
  });

  it('buy: lewat sesi (authFetch) dan menolak respons kosong', async () => {
    mocks.authFetch.mockResolvedValueOnce({ tokens: ['nct1_a'] });
    await expect(buyCredentialToken()).resolves.toBe('nct1_a');
    expect(mocks.authFetch).toHaveBeenCalledWith('/api/credentials/tokens', {
      method: 'POST',
      body: JSON.stringify({ count: 1 }),
    });

    mocks.authFetch.mockResolvedValueOnce({ tokens: [] });
    await expect(buyCredentialToken()).rejects.toThrow(/respons kosong/);
  });
});
