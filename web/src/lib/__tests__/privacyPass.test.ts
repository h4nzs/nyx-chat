// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.4.1] Privacy Pass sisi klien: token acak 256-bit, komitmen
 * `SHA-256(token)` yang dikirim ke server, dan redemption sekali pakai.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@lib/storage/sqliteMessages', () => ({
  openSqliteKvStore: async () => ({
    get: async (key: string) => kv.get(key),
    put: async (row: { key: string; value: unknown }) => {
      kv.set(row.key, row.value);
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
    deleteByPrefix: async (prefix: string) => {
      for (const key of kv.keys()) if (key.startsWith(prefix)) kv.delete(key);
    },
    clear: async () => kv.clear(),
    keys: async () => [...kv.keys()],
  }),
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
  resetPrivacyPassForTests,
  takePrivacyPassProof,
} = await import('@lib/privacyPass');

interface IssueBody {
  commitments?: string[];
  tokens?: string[];
}

function installIssue (accepted: (body: IssueBody) => number = (body) => body.commitments?.length ?? 0, suite = PP_SUITE) {
  apiMock.mockImplementation(async (path: string, options?: { body?: string }) => {
    if (path !== '/api/groups/pp/issue') throw new Error(`unexpected path ${path}`);
    const body = JSON.parse(options?.body ?? '{}') as IssueBody;
    return { suite, accepted: accepted(body) };
  });
}

function lastIssueBody (): IssueBody {
  const call = apiMock.mock.calls.at(-1);
  return JSON.parse(call?.[1]?.body ?? '{}') as IssueBody;
}

function storedTokens (conversationId = 'conv-1'): string[] {
  const stored = kv.get('nyx_pp_tokens') as Record<string, string> | undefined;
  const value = stored?.[conversationId];
  if (!value) return [];
  return (JSON.parse(String(value).slice(5)) as { tokens: string[] }).tokens;
}

beforeEach(() => {
  apiMock.mockReset();
  kv.clear();
  groupTokens.group = 'GROUP_TOKEN';
  groupTokens.member = 'MEMBER_TOKEN';
  resetPrivacyPassForTests();
  installIssue();
});

describe('issuance', () => {
  it('mengirim komitmen, bukan token, lalu menyimpan token 256-bit', async () => {
    expect(await issuePrivacyPassTokens('conv-1', 3)).toBe(3);

    const body = lastIssueBody();
    expect(body.commitments).toHaveLength(3);
    expect(body.tokens).toBeUndefined();
    for (const commitment of body.commitments ?? []) expect(commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokens = storedTokens();
    expect(tokens).toHaveLength(3);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.commitments).not.toContain(token);
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

  it('menolak suite lain dan tidak menyimpan token', async () => {
    installIssue(undefined, 'RSABSSA-SHA384-PSS-Deterministic');
    await expect(issuePrivacyPassTokens('conv-1', 1)).rejects.toThrow('PP_SUITE_MISMATCH');
    expect(storedTokens()).toEqual([]);
  });

  it('menolak issuance parsial dan tidak menyimpan token setengah jadi', async () => {
    installIssue(() => 1);
    await expect(issuePrivacyPassTokens('conv-1', 3)).rejects.toThrow('PP_ISSUE_MALFORMED');
    expect(storedTokens()).toEqual([]);
  });
});

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

    await vi.waitFor(async () => {
      expect(apiMock.mock.calls.map(([path]) => path)).toEqual(['/api/groups/pp/issue']);
      expect(await takePrivacyPassProof('conv-1')).toBeTypeOf('string');
    }, { timeout: 10_000, interval: 100 });
  });

  it('drop menghapus seluruh stok grup', async () => {
    await issuePrivacyPassTokens('conv-1', 2);
    await dropPrivacyPassTokens('conv-1');
    expect(storedTokens()).toEqual([]);
  });

  it('issuance yang gagal tidak melempar ke pemanggil sync', async () => {
    apiMock.mockRejectedValue(new Error('network'));
    expect(await takePrivacyPassProof('conv-1')).toBeUndefined();
  });

  it('ensurePrivacyPassProof menerbitkan secara sinkron saat stok kosong', async () => {
    const proof = await ensurePrivacyPassProof('conv-1');
    expect(proof).toBeTypeOf('string');

    const callsAfterIssue = apiMock.mock.calls.length;
    const again = await ensurePrivacyPassProof('conv-1');
    expect(again).toBe(proof);
    expect(apiMock.mock.calls.length).toBe(callsAfterIssue);
  });
});
