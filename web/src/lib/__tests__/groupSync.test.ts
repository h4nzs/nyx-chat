// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P3] Sync grup: OHTTP POST bila aktif, jalur langsung bila
 * tidak/gagal. Yang dikunci:
 *   1. Bukti Privacy Pass ikut di body dan dibuang setelah sukses.
 *   2. OHTTP dipakai tanpa token carriage (sync tidak punya sesi).
 *   3. Kegagalan di dalam amplop jatuh ke jalur langsung, bukan error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();
const ohttpMock = vi.fn<(path: string, init?: Record<string, unknown>) => Promise<{ status: number; headers: [string, string][]; body: Uint8Array }>>();
const ohttpState = { enabled: false };
const consumed: string[] = [];

vi.mock('@lib/api', () => ({
  getApiBaseUrl: () => 'https://api.test',
}));

vi.mock('@lib/ohttpClient', () => ({
  ohttpEnabled: () => ohttpState.enabled,
  ohttpFetch: (...args: [string, Record<string, unknown>?]) => ohttpMock(...args),
}));

vi.mock('@lib/privacyPass', () => ({
  takePrivacyPassProof: async () => 'PROOF-1',
  // [PP aktif] Hanya dipanggil saat server menjawab 403 PP_PROOF_REQUIRED.
  ensurePrivacyPassProof: async () => 'PROOF-2',
  consumePrivacyPassProof: async (_conversationId: string, proof: string | undefined) => {
    if (proof) consumed.push(proof);
  },
  dropPrivacyPassTokens: async () => {},
}));

const { syncGroupMemberships } = await import('@lib/groupSync');

const envelope = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jsonResponse = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
}) as Response;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  ohttpMock.mockReset();
  ohttpState.enabled = false;
  consumed.length = 0;
});

describe('syncGroupMemberships', () => {
  it('langsung ke API saat OHTTP mati — tanpa cookie, bukti ikut dan dibuang', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], memberships: [] }));

    await syncGroupMemberships(['TOK-1'], { conversationId: 'conv-1' });

    expect(ohttpMock).not.toHaveBeenCalled();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/groups/sync');
    expect(options?.method).toBe('POST');
    expect(options?.credentials).toBe('omit');
    expect(JSON.parse(options?.body as string)).toEqual({ tokens: ['TOK-1'], proofs: ['PROOF-1'] });
    expect(consumed).toEqual(['PROOF-1']);
  });

  it('memakai OHTTP POST tanpa token carriage saat aktif', async () => {
    ohttpState.enabled = true;
    ohttpMock.mockResolvedValue({
      status: 200,
      headers: [['content-type', 'application/json']],
      body: envelope({ conversations: [], memberships: [], unknown: 1 }),
    });

    const result = await syncGroupMemberships(['TOK-1'], { conversationId: 'conv-1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.unknown).toBe(1);
    const [path, init] = ohttpMock.mock.calls[0]!;
    expect(path).toBe('/api/groups/sync');
    expect(init?.method).toBe('POST');
    expect(init?.withToken).toBe(false);
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"tokens":["TOK-1"],"proofs":["PROOF-1"]}');
    expect(consumed).toEqual(['PROOF-1']);
  });

  it('kegagalan di amplop jatuh ke jalur langsung', async () => {
    ohttpState.enabled = true;
    ohttpMock.mockRejectedValue(new Error('relay down'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], memberships: [] }));

    await syncGroupMemberships(['TOK-1'], { conversationId: 'conv-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consumed).toEqual(['PROOF-1']);
  });

  it('tanpa bukti tetap mengirim sync (server yang memutuskan wajib/tidak)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], memberships: [] }));

    await syncGroupMemberships(['TOK-1']);

    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ tokens: ['TOK-1'] });
    expect(consumed).toEqual([]);
  });

  it('status refresh memperpanjang token anggota tanpa cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        conversations: [],
        memberships: [{ index: 0, status: 'refresh', conversationId: 'conv-1', epoch: 1, expiresAt: '2026-11-01T00:00:00Z' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ expiresAt: '2026-11-01T00:00:00Z', epoch: 1 }));

    await syncGroupMemberships(['TOK-1']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://api.test/api/groups/token/refresh');
    expect(init?.credentials).toBe('omit');
    expect(JSON.parse(init?.body as string)).toEqual({ token: 'TOK-1' });
  });

  it('403 PP_PROOF_REQUIRED → terbitkan bukti baru lalu ulangi SEKALI', async () => {
    // [PP hidup] `PP_SYNC_REQUIRED=1` + stok bukti kosong: tanpa retry ini,
    // discovery grup mati sampai issuance latar kebetulan selesai.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'PP_PROOF_REQUIRED' }, 403))
      .mockResolvedValueOnce(jsonResponse({ conversations: [], memberships: [] }));

    await syncGroupMemberships(['TOK-1'], { conversationId: 'conv-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)).toEqual({
      tokens: ['TOK-1'],
      proofs: ['PROOF-2'],
    });
    expect(consumed).toEqual(['PROOF-2']);
  });

  it('403 kedua kalinya tetap dilempar (tidak ada loop)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'PP_PROOF_REQUIRED' }, 403))
      .mockResolvedValueOnce(jsonResponse({ error: 'PP_PROOF_REQUIRED' }, 403));

    await expect(syncGroupMemberships(['TOK-1'], { conversationId: 'conv-1' }))
      .rejects.toThrow('PP_PROOF_REQUIRED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumed).toEqual([]);
  });

  it('memecah >200 token jadi batch dan menggeser indeks membership', async () => {
    const tokens = Array.from({ length: 201 }, (_, i) => `TOK-${i}`);
    const bodies: string[][] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { tokens: string[] };
      bodies.push(body.tokens);
      return jsonResponse({
        conversations: [{ id: `conv-${body.tokens[0]}` }],
        memberships: body.tokens.map((_, index) => ({
          index,
          status: 'ok',
          conversationId: `conv-${body.tokens[index]}`,
          epoch: 0,
          expiresAt: '2026-11-01T00:00:00Z',
        })),
      });
    });

    const result = await syncGroupMemberships(tokens);

    expect(bodies.map((batch) => batch.length)).toEqual([200, 1]);
    expect(result.conversations).toHaveLength(2);
    expect(result.memberships[200]?.index).toBe(200);
    expect(result.truncated).toBe(false);
  });

  it('mengembalikan batch yang berhasil bila batch berikutnya gagal', async () => {
    const tokens = Array.from({ length: 201 }, (_, i) => `TOK-${i}`);
    fetchMock
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { tokens: string[] };
        return jsonResponse({
          conversations: [{ id: 'conv-first' }],
          memberships: [{ index: 0, status: 'ok', conversationId: 'conv-first', epoch: 0, expiresAt: '2026-11-01T00:00:00Z' }],
          tokens: body.tokens.length,
        });
      })
      .mockRejectedValueOnce(new Error('PP_PROOF_REQUIRED'));

    const result = await syncGroupMemberships(tokens);

    expect(result.conversations.map((conversation) => conversation.id)).toEqual(['conv-first']);
    expect(result.memberships).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
