// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.6] Rotasi era: urutan panggilan dan pemulihan kegagalan.
 *
 * Yang dikunci:
 *   1. Bukan admin → tidak ada request sama sekali.
 *   2. Belum jatuh tempo → tidak ada POST /epoch.
 *   3. Jatuh tempo → POST /epoch lalu metadata ditulis ulang dengan token BARU.
 *   4. Rotasi manual melewati kebijakan.
 *   5. Kalau metadata gagal ditulis, percobaan ulang MEMAKAI token yang sama
 *      (tidak merotasi dua kali dan meninggalkan anggota dengan token basi).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const authFetchMock = vi.fn<(path: string, options?: Record<string, unknown>) => Promise<unknown>>();
const adminState = { admin: true, token: 'ADMIN' as string | undefined };
const rotateGroupKeyMock = vi.fn(async () => undefined);

vi.mock('@lib/api', () => ({
  authFetch: (...args: [string, Record<string, unknown>?]) => authFetchMock(...args),
}));

vi.mock('@lib/groupPseudonyms', () => ({
  amIGroupAdmin: () => adminState.admin,
  getMyAdminToken: () => adminState.token,
}));

vi.mock('@utils/crypto', () => ({
  rotateGroupKey: (...args: unknown[]) => rotateGroupKeyMock(...(args as [])),
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

const { maybeRotateGroupEpoch, rotateGroupEpochNow, resetGroupEpochStateForTests } = await import('@lib/groupEpochRotation');

function statusRoute (status: Record<string, unknown>) {
  authFetchMock.mockImplementation(async (path: string, options?: Record<string, unknown>) => {
    if (options?.method === 'POST') return { token: 'NEW_TOKEN', epoch: 4 };
    if (path.endsWith('/epoch')) return status;
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  authFetchMock.mockReset();
  rotateGroupKeyMock.mockReset();
  rotateGroupKeyMock.mockResolvedValue(undefined);
  kv.clear();
  adminState.admin = true;
  adminState.token = 'ADMIN';
  resetGroupEpochStateForTests();
});

describe('maybeRotateGroupEpoch', () => {
  it('bukan admin → tidak ada request', async () => {
    adminState.admin = false;
    expect(await maybeRotateGroupEpoch('conv-1')).toBe('not_admin');
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(rotateGroupKeyMock).not.toHaveBeenCalled();
  });

  it('admin tanpa capability token → tidak ada request', async () => {
    adminState.token = undefined;
    expect(await maybeRotateGroupEpoch('conv-1')).toBe('not_admin');
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('era masih muda → skipped tanpa POST', async () => {
    statusRoute({ epoch: 3, rotatedAt: new Date(NOW - 60_000).toISOString(), createdAt: null, messageSeq: 20 });

    expect(await maybeRotateGroupEpoch('conv-1', { now: NOW })).toBe('skipped');
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock.mock.calls[0]![1]).toMatchObject({ headers: { 'X-Admin-Token': 'ADMIN' } });
    expect(rotateGroupKeyMock).not.toHaveBeenCalled();
  });

  it('jatuh tempo → POST epoch lalu metadata ditulis ulang dengan token baru', async () => {
    statusRoute({ epoch: 3, rotatedAt: new Date(NOW - 48 * 3_600_000).toISOString(), createdAt: null, messageSeq: 120 });

    expect(await maybeRotateGroupEpoch('conv-1', { now: NOW })).toBe('rotated');

    const post = authFetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post?.[0]).toBe('/api/groups/conv-1/epoch');
    expect(rotateGroupKeyMock).toHaveBeenCalledWith('conv-1', 'periodic_rotation', true, 'NEW_TOKEN');

    const stored = JSON.parse(String((kv.get('nyx_group_epoch_state') as Record<string, string>)['conv-1']).slice(5)) as Record<string, unknown>;
    expect(stored).toMatchObject({ epoch: 4, messageSeq: 120 });
    expect(stored.pendingToken).toBeUndefined();
  });

  it('rotasi manual melewati kebijakan', async () => {
    statusRoute({ epoch: 1, rotatedAt: new Date(NOW).toISOString(), createdAt: null, messageSeq: 0 });

    expect(await rotateGroupEpochNow('conv-1')).toBe('rotated');
    expect(rotateGroupKeyMock).toHaveBeenCalledTimes(1);
  });

  it('metadata gagal ditulis → percobaan ulang memakai token yang sama', async () => {
    statusRoute({ epoch: 3, rotatedAt: new Date(NOW - 48 * 3_600_000).toISOString(), createdAt: null, messageSeq: 10 });
    rotateGroupKeyMock.mockRejectedValueOnce(new Error('PUT details 500'));

    expect(await maybeRotateGroupEpoch('conv-1', { now: NOW })).toBe('unavailable');

    const postsAfterFailure = authFetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(postsAfterFailure).toHaveLength(1);

    // Status server sekarang sudah era 4, tetapi klien masih memegang token era
    // baru yang belum tertulis ke metadata: jangan minta token KEDUA.
    statusRoute({ epoch: 4, rotatedAt: new Date(NOW).toISOString(), createdAt: null, messageSeq: 10 });
    expect(await maybeRotateGroupEpoch('conv-1', { now: NOW, force: true })).toBe('rotated');
    const postsAfterRecovery = authFetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(postsAfterRecovery).toHaveLength(1);
    expect(rotateGroupKeyMock).toHaveBeenLastCalledWith('conv-1', 'periodic_rotation', true, 'NEW_TOKEN');
  });

  it('status era tidak terbaca → unavailable, tanpa efek samping', async () => {
    authFetchMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));

    expect(await maybeRotateGroupEpoch('conv-1', { now: NOW })).toBe('unavailable');
    expect(rotateGroupKeyMock).not.toHaveBeenCalled();
  });
});
